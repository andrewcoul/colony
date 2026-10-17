import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterAll, describe, expect, test } from "vitest";

/*
 * Web sign-in with the real Better Auth, in-process: invite-only sign-up, sessions through the
 * Cloudflare path (with a test origin token), the admin's own sign-in, turned-off members, rate
 * limits, and resets and codes by email (a fake transport: nothing reaches the network).
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-betterauth-"));
process.env.COLONY_DATA_DIR = dataDir;

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { createApi } = await import("./api.js");
const { resolver, standardSources } = await import("./access.js");
const { People } = await import("./people.js");
const { Invites } = await import("./invites.js");
const { Mailer } = await import("./mailer.js");
const { WebAccounts, webSignInProblem } = await import("./webauth.js");
const { startWebAuth } = await import("./betterAuth.js");
const settings = await import("./settings.js");
settings.loadSettings();
type Runner = import("./agent/runner.js").Runner;
type Sent = Parameters<import("./mailer.js").MailTransport>[0];

const stops: (() => void)[] = [];
afterAll(() => { for (const stop of stops) stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const ADMIN_EMAIL = "boss@example.com";
const SITE = "https://colony.example";
const SECRET = "a-test-secret-that-is-long-enough-0123456789";

// The origin Access app, faked: its key, and the Worker's service token.
const team = "team.cloudflareaccess.com";
const aud = "origin-aud";
const SERVICE = "svc.access";
const signer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const cloudflare = { teamDomain: team, aud, serviceClientId: SERVICE, keys: async () => [{ ...signer.publicKey.export({ format: "jwk" }), kid: "k1" }] };
const serviceJwt = () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${part({ alg: "RS256", kid: "k1" })}.${part({ aud: [aud], iss: `https://${team}`, common_name: SERVICE, iat: now, exp: now + 600 })}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), signer.privateKey).toString("base64url")}`;
};

let nextIp = 10;
async function setup({ mail = false } = {}) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const people = new People(store, { adminEmails: [ADMIN_EMAIL] });
  const invites = new Invites(db, 7);
  const sent: Sent[] = [];
  const mailer = new Mailer(mail ? async (message) => { sent.push(message); } : null);
  const accounts = new WebAccounts(store, people, invites);
  const file = path.join(dataDir, `auth-${crypto.randomUUID()}.db`);
  const auth = await startWebAuth({ file, secret: SECRET, origins: [SITE], mailer, accounts });
  stops.push(auth.close);
  accounts.attach(auth.sessions);
  const runner = {
    isRunning: () => false, stop: () => {}, deliver: () => false, steerNow: () => false, unqueue: () => false, isBotRunning: () => false, stopBot: () => {}, resumeAll: () => {},
    start: (chatId: string, botId: string) => store.createMessage({ chatId, author: botId, text: "ok" }).id,
  } satisfies Runner;
  const access = resolver(standardSources({ allowed: [], login: () => null, claim: () => {} }, cloudflare), people, (header) => accounts.personFor(header));
  const app = new Hono().route("/api", createApi({ store, events, gate: new ApprovalGate(store), runner, access, web: { accounts, invites, mailer, origins: [SITE], auth } }));
  // Each setup is one client, from its own address (rate limits count per address).
  const ip = `203.0.113.${nextIp++}`;
  let cookies = new Map<string, string>();
  /** A request as the colony-site Worker forwards it, with this client's cookies; cookies set come back to the jar. */
  const site = async (method: string, url: string, body?: unknown, { jar = true, extra = {} as Record<string, string> } = {}) => {
    const headers: Record<string, string> = {
      "Cf-Connecting-Ip": ip, "Cf-Ray": "8abc-LHR", "Cf-Access-Jwt-Assertion": serviceJwt(), Origin: SITE,
      "X-Forwarded-Host": "colony.example", "X-Forwarded-Proto": "https", ...extra,
    };
    if (jar && cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await app.request(`http://colony-origin.example${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value) cookies.set(name, value); else cookies.delete(name);
    }
    const text = await response.text();
    return { status: response.status, setCookies, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  /** A request made on the Colony PC itself (the admin). */
  const local = async (method: string, url: string, body?: unknown) => {
    const response = await app.request(`http://127.0.0.1:8787${url}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  const forget = () => { cookies = new Map(); };
  /** An invite the admin made from this PC, and its token. */
  const invite = async (email: string) => {
    const created = await local("POST", "/api/invites", { email });
    return { id: created.json.invite.id as string, token: new URL(created.json.link ?? `${SITE}/?invite=${/invite=([\w-]+)/.exec(sent.at(-1)!.text)![1]}`).searchParams.get("invite")! };
  };
  return { db, store, people, invites, sent, accounts, auth, file, site, local, forget, invite };
}

const users = (file: string) => {
  const db = new DatabaseSync(file);
  try { return (db.prepare("SELECT email, role FROM user ORDER BY email").all() as { email: string; role: string }[]).map((row) => [row.email, row.role]); } finally { db.close(); }
};

describe("Better Auth", () => {
  test("runs its migrations into data/auth.db (readable only by Colony), its own database", async () => {
    const { file } = await setup();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(file);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    db.close();
    expect(tables).toEqual(expect.arrayContaining(["user", "session", "account", "verification"]));
    // Starting again on the same file migrates nothing twice.
    const again = await startWebAuth({ file, secret: SECRET, origins: [SITE], mailer: new Mailer(null), accounts: new WebAccounts(new Store(openDb(":memory:"), new EventLog(openDb(":memory:"))), new People(new Store(openDb(":memory:"), new EventLog(openDb(":memory:"))), { adminEmails: [] }), new Invites(openDb(":memory:"), 7)) });
    again.close();
  });

  test("web sign-in needs a long BETTER_AUTH_SECRET and Colony's web origins", () => {
    expect(webSignInProblem({}, [SITE])).toBe("Web sign-in is off: set BETTER_AUTH_SECRET to turn it on.");
    expect(webSignInProblem({ BETTER_AUTH_SECRET: "short" }, [SITE])).toMatch(/too short/);
    expect(webSignInProblem({ BETTER_AUTH_SECRET: SECRET }, [])).toMatch(/COLONY_PUBLIC_ORIGINS/);
    expect(webSignInProblem({ BETTER_AUTH_SECRET: SECRET }, [SITE])).toBeNull();
  });

  test("an invited email signs up, gets a member and a session cookie, and uses /api through the website", async () => {
    const { site, invite, store, invites, file } = await setup();
    expect((await site("GET", "/api/state")).status).toBe(401);
    const { id, token } = await invite("Ana@Example.com");
    const signedUp = await site("POST", "/api/auth/sign-up/email", { email: "ana@example.com", password: "correct horse battery", name: "Ana", invite: token });
    expect(signedUp.status).toBe(200);
    // The session cookie: Secure, HttpOnly, SameSite=Lax, and host-only (no Domain).
    const session = signedUp.setCookies.find((line) => line.startsWith("__Secure-better-auth.session_token="))!;
    expect(session).toBeTruthy();
    expect(session).toMatch(/; HttpOnly/i);
    expect(session).toMatch(/; Secure/i);
    expect(session).toMatch(/; SameSite=Lax/i);
    expect(session).toMatch(/; Path=\//i);
    expect(session).not.toMatch(/; Domain=/i);
    const state = await site("GET", "/api/state");
    expect(state.status).toBe(200);
    expect(state.json.me).toMatchObject({ role: "member", login: "ana@example.com" });
    expect(invites.get(id)).toMatchObject({ status: "used", personId: state.json.me.id });
    expect(store.getPerson(state.json.me.id)).toMatchObject({ role: "member" });
    expect(users(file)).toEqual([["ana@example.com", "member"]]);
    // Signing out ends it.
    expect((await site("POST", "/api/auth/sign-out", {})).status).toBe(200);
    expect((await site("GET", "/api/state")).status).toBe(401);
    // And signing in again works.
    expect((await site("POST", "/api/auth/sign-in/email", { email: "ana@example.com", password: "correct horse battery" })).status).toBe(200);
    expect((await site("GET", "/api/state")).json.me.login).toBe("ana@example.com");
  });

  test("sign-up is refused without an invite, with someone else's, with a used one, and with a withdrawn one", async () => {
    const { site, invite, local, forget, file, store } = await setup();
    // Each try from its own address, so the sign-up rate limit doesn't decide these.
    const signUp = (email: string, invite?: string) => site("POST", "/api/auth/sign-up/email", { email, password: "correct horse battery", name: "x", ...(invite ? { invite } : {}) },
      { jar: false, extra: { "Cf-Connecting-Ip": `198.51.100.${nextIp++}` } });
    const none = await signUp("mallory@example.com");
    expect(none.status).toBe(403);
    expect(none.json.message).toMatch(/invite-only/);
    const anas = await invite("ana@example.com");
    expect((await signUp("mallory@example.com", anas.token)).json.message).toBe("This invite is for a different email address.");
    expect((await signUp("mallory@example.com", "made-up-token")).status).toBe(403);
    // Used: Ana signs up, her account is removed, and the same link doesn't work again.
    expect((await signUp("ana@example.com", anas.token)).status).toBe(200);
    const ana = store.personByLogin("ana@example.com")!;
    await local("DELETE", `/api/people/${ana.id}`);
    forget();
    expect((await signUp("ana@example.com", anas.token)).json.message).toMatch(/already been used|turned off/);
    // Withdrawn.
    const bos = await invite("bo@example.com");
    await local("DELETE", `/api/invites/${bos.id}`);
    expect((await signUp("bo@example.com", bos.token)).json.message).toBe("This invite was withdrawn. Ask for a new one.");
    // Nobody got in.
    expect(users(file)).toEqual([]);
    expect(store.personByLogin("mallory@example.com")).toBeNull();
    expect(store.personByLogin("bo@example.com")).toBeNull();
  });

  test("an admin email can't sign up from the web, even with an invite made for it", async () => {
    const { site, invites, file } = await setup();
    const { token } = invites.create(ADMIN_EMAIL);
    const response = await site("POST", "/api/auth/sign-up/email", { email: ADMIN_EMAIL, password: "correct horse battery", name: "x", invite: token });
    expect(response.status).toBe(403);
    expect(response.json.message).toMatch(/admin/);
    expect(users(file)).toEqual([]);
  });

  test("the admin sets up web sign-in from this PC, then signs in on the web as the admin", async () => {
    const { site, local, file } = await setup();
    // Members (and anyone through the website) can't.
    expect((await site("POST", "/api/web-signin/admin", { email: ADMIN_EMAIL, password: "a long admin password" })).status).toBe(401);
    expect((await local("POST", "/api/web-signin/admin", { email: ADMIN_EMAIL, password: "a long admin password" })).status).toBe(204);
    expect(users(file)).toEqual([[ADMIN_EMAIL, "admin"]]);
    expect((await site("POST", "/api/auth/sign-in/email", { email: ADMIN_EMAIL, password: "a long admin password" })).status).toBe(200);
    expect((await site("GET", "/api/state")).json.me).toMatchObject({ id: "owner", role: "admin" });
    // Setting it up again changes the password and ends the old sessions.
    expect((await local("POST", "/api/web-signin/admin", { email: ADMIN_EMAIL, password: "another long password" })).status).toBe(204);
    expect((await site("GET", "/api/state")).status).toBe(401);
    expect((await site("POST", "/api/auth/sign-in/email", { email: ADMIN_EMAIL, password: "a long admin password" })).status).toBe(401);
    expect((await site("POST", "/api/auth/sign-in/email", { email: ADMIN_EMAIL, password: "another long password" })).status).toBe(200);
  });

  test("a turned-off member's session stops working, and they can't sign in again until turned back on", async () => {
    const { site, invite, local, store } = await setup();
    const { token } = await invite("ana@example.com");
    await site("POST", "/api/auth/sign-up/email", { email: "ana@example.com", password: "correct horse battery", name: "Ana", invite: token });
    expect((await site("GET", "/api/state")).status).toBe(200);
    const ana = store.personByLogin("ana@example.com")!;
    await local("PUT", `/api/people/${ana.id}`, { disabled: true });
    expect([401, 403]).toContain((await site("GET", "/api/state")).status);
    const again = await site("POST", "/api/auth/sign-in/email", { email: "ana@example.com", password: "correct horse battery" });
    expect(again.status).toBe(403);
    expect(again.json.message).toMatch(/turned off/);
    await local("PUT", `/api/people/${ana.id}`, { disabled: false });
    expect((await site("POST", "/api/auth/sign-in/email", { email: "ana@example.com", password: "correct horse battery" })).status).toBe(200);
    expect((await site("GET", "/api/state")).status).toBe(200);
  });

  test("signing in is rate limited per client", async () => {
    const { site } = await setup();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) statuses.push((await site("POST", "/api/auth/sign-in/email", { email: "nobody@example.com", password: "wrong password!" })).status);
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(5);
  });

  test("changes to sign-in need Colony's own Origin, and the origin token comes first", async () => {
    const { site } = await setup();
    expect((await site("POST", "/api/auth/sign-in/email", { email: "a@example.com", password: "x" }, { extra: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await site("POST", "/api/auth/sign-in/email", { email: "a@example.com", password: "x" }, { extra: { "Cf-Access-Jwt-Assertion": "forged" } })).status).toBe(403);
  });

  test("without email set up, there's no password reset and no sign-in code", async () => {
    const { site, sent } = await setup({ mail: false });
    expect((await site("POST", "/api/auth/request-password-reset", { email: "ana@example.com", redirectTo: `${SITE}/reset` })).status).toBeGreaterThanOrEqual(400);
    expect((await site("POST", "/api/auth/email-otp/send-verification-otp", { email: "ana@example.com", type: "sign-in" })).status).toBe(404);
    expect((await site("GET", "/api/auth-status")).json).toMatchObject({ webSignIn: true, email: false });
    expect(sent).toEqual([]);
  });

  test("with email set up, a reset link and a sign-in code go out by the mailer, and both work", async () => {
    const { site, invite, sent, forget } = await setup({ mail: true });
    const { token } = await invite("ana@example.com");
    await site("POST", "/api/auth/sign-up/email", { email: "ana@example.com", password: "correct horse battery", name: "Ana", invite: token });
    forget();
    // A reset: the link is on the site, and sets a new password.
    expect((await site("POST", "/api/auth/request-password-reset", { email: "ana@example.com", redirectTo: `${SITE}/reset` })).status).toBe(200);
    const reset = sent.find((mail) => mail.subject === "Reset your Colony password")!;
    expect(reset.to).toBe("ana@example.com");
    const link = /https:\/\/\S+/.exec(reset.text)![0];
    expect(link).toMatch(/^https:\/\/colony\.example\/reset\?token=/);
    const resetToken = new URL(link).searchParams.get("token")!;
    expect((await site("POST", "/api/auth/reset-password", { token: resetToken, newPassword: "a brand new password" })).status).toBe(200);
    expect((await site("POST", "/api/auth/sign-in/email", { email: "ana@example.com", password: "a brand new password" })).status).toBe(200);
    forget();
    // A sign-in code.
    expect((await site("POST", "/api/auth/email-otp/send-verification-otp", { email: "ana@example.com", type: "sign-in" })).status).toBe(200);
    const mail = sent.find((item) => item.subject.startsWith("Your Colony sign-in code"))!;
    const code = /code is (\d+)/.exec(mail.text)![1];
    expect((await site("POST", "/api/auth/sign-in/email-otp", { email: "ana@example.com", otp: code })).status).toBe(200);
    expect((await site("GET", "/api/state")).json.me.login).toBe("ana@example.com");
    // A code never makes an account.
    await site("POST", "/api/auth/email-otp/send-verification-otp", { email: "stranger@example.com", type: "sign-in" });
    const strangers = sent.filter((item) => item.to === "stranger@example.com");
    if (strangers.length) {
      const otp = /code is (\d+)/.exec(strangers[0].text)![1];
      expect((await site("POST", "/api/auth/sign-in/email-otp", { email: "stranger@example.com", otp })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await site("GET", "/api/auth-status")).json).toMatchObject({ email: true });
  });
});
