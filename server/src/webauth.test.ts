import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

/*
 * Web sign-in, Colony's side: invite-only sign-up (the rules the sign-in service's hooks run),
 * who each account is, turning members off and removing them, invite links by email (Resend, faked
 * here: nothing reaches the network), and requests through the website before anyone signs in.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-webauth-"));
process.env.COLONY_DATA_DIR = dataDir;

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { createApi } = await import("./api.js");
const { resolver, standardSources } = await import("./access.js");
const { People } = await import("./people.js");
const { Invites } = await import("./invites.js");
const { Mailer, mailerFromEnv, resendTransport, DEFAULT_FROM } = await import("./mailer.js");
const { SignUpRefused, WebAccounts } = await import("./webauth.js");
const settings = await import("./settings.js");
settings.loadSettings();
type Runner = import("./agent/runner.js").Runner;
type MailTransport = import("./mailer.js").MailTransport;
type WebSessions = import("./webauth.js").WebSessions;

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const ADMIN_EMAIL = "boss@example.com";
const SITE = "https://colony.example";
const WORKER = "https://colony-site.example.workers.dev";
const DAY = 24 * 60 * 60_000;

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
/** A request as the colony-site Worker forwards it through the tunnel, signed in as `email` (or nobody). */
const throughSite = (email?: string, extra: Record<string, string> = {}) => ({
  "Cf-Connecting-Ip": "203.0.113.7", "Cf-Ray": "8abc-LHR", "Cf-Access-Jwt-Assertion": serviceJwt(),
  "X-Forwarded-Host": "colony-site.example.workers.dev", "X-Forwarded-Proto": "https", Origin: WORKER,
  ...(email ? { Cookie: `session=${email}` } : {}), ...extra,
});

/** A stand-in sign-in service: accounts by email, sessions as "session=<email>" cookies. */
function fakeSessions() {
  const accounts = new Set<string>();
  const revoked: string[] = [];
  const deleted: string[] = [];
  const admins: { email: string; password: string }[] = [];
  const sessions: WebSessions = {
    emailFor: async (header) => { const email = /(?:^|;\s*)session=([^;]+)/.exec(header("Cookie") ?? "")?.[1]; return email && (accounts.has(email) || admins.some((admin) => admin.email === email)) ? email : null; },
    revoke: async (email) => { revoked.push(email); },
    deleteAccount: async (email) => { deleted.push(email); accounts.delete(email); },
    setUpAdmin: async (email, password) => { admins.push({ email, password }); },
  };
  return { sessions, accounts, revoked, deleted, admins };
}

function setup({ mail = true } = {}) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const people = new People(store, { adminEmails: [ADMIN_EMAIL] });
  const invites = new Invites(db, 7);
  const sent: Parameters<MailTransport>[0][] = [];
  const mailer = new Mailer(mail ? async (message) => { sent.push(message); } : null);
  const fake = fakeSessions();
  const accounts = new WebAccounts(store, people, invites, fake.sessions);
  const runner = {
    isRunning: () => false, stop: () => {}, deliver: () => false, steerNow: () => false, unqueue: () => false, isBotRunning: () => false, stopBot: () => {}, resumeAll: () => {},
    start: (chatId: string, botId: string) => store.createMessage({ chatId, author: botId, text: "ok" }).id,
  } satisfies Runner;
  const owner = { allowed: [], login: () => null, claim: () => {} };
  const access = resolver(standardSources(owner, cloudflare), people, (header) => accounts.personFor(header));
  const api = createApi({ store, events, gate: new ApprovalGate(store), runner, access, web: { accounts, invites, mailer, origins: [SITE, WORKER] } });
  const call = async (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await api.request(url, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  /** Signs up through the sign-in service's hooks, as it runs them. */
  const signUp = (email: string, invite?: string) => {
    accounts.beforeSignUp(email, invite);
    fake.accounts.add(email.toLowerCase());
    return accounts.afterSignUp(email, invite!);
  };
  return { db, store, people, invites, sent, mailer, accounts, fake, call, signUp };
}

describe("invites", () => {
  test("a link works once, for its email, until it expires; only its hash is kept", () => {
    const { db, invites } = setup();
    const now = Date.UTC(2026, 9, 17);
    const { invite, token } = invites.create("Ana@Example.com", now);
    expect(invite).toMatchObject({ email: "ana@example.com", status: "pending", expiresAt: now + 7 * DAY });
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(db.prepare("SELECT * FROM invites").all())).not.toContain(token);
    expect(invites.check(token, undefined, now)).toMatchObject({ invite: { id: invite.id } });
    expect(invites.check(token, "someone@example.com", now)).toEqual({ problem: "This invite is for a different email address." });
    expect(invites.check(token, undefined, now + 7 * DAY + 1)).toEqual({ problem: "This invite has expired. Ask for a new one." });
    expect(invites.list(now + 8 * DAY)[0].status).toBe("expired");
    expect(invites.consume(token, "ana@example.com", "p1", now)).toMatchObject({ invite: { status: "used", personId: "p1" } });
    expect(invites.consume(token, "ana@example.com", "p2", now)).toEqual({ problem: "This invite has already been used. Sign in instead." });
    expect(invites.check("not-a-token")).toEqual({ problem: "This invite link isn't valid. Ask for a new one." });
  });

  test("resending makes a new link (the old one dies, the expiry starts over); revoking ends it", () => {
    const { invites } = setup();
    const now = Date.UTC(2026, 9, 17);
    const first = invites.create("bo@example.com", now);
    const second = invites.resend(first.invite.id, now + 3 * DAY);
    expect(second.token).not.toBe(first.token);
    expect(invites.check(first.token)).toEqual({ problem: "This invite link isn't valid. Ask for a new one." });
    expect(invites.check(second.token, undefined, now + 3 * DAY)).toMatchObject({ invite: { expiresAt: now + 10 * DAY } });
    // An expired invite can be resent too.
    expect(invites.resend(first.invite.id, now + 30 * DAY).invite.status).toBe("pending");
    expect(invites.revoke(first.invite.id)).toBe(true);
    expect(invites.list()[0].status).toBe("revoked");
    expect(() => invites.resend(first.invite.id)).toThrow(/withdrawn/);
    // Inviting the same email again replaces a pending invite.
    const again = invites.create("cy@example.com");
    const newer = invites.create("cy@example.com");
    expect(invites.check(again.token)).toEqual({ problem: "This invite was withdrawn. Ask for a new one." });
    expect(invites.check(newer.token)).toHaveProperty("invite");
  });
});

describe("sign-up is invite-only", () => {
  test("refused without an invite, with someone else's, with a used one, and for an admin email", () => {
    const { invites, accounts, signUp } = setup();
    const { token } = invites.create("ana@example.com");
    expect(() => accounts.beforeSignUp("ana@example.com", undefined)).toThrow(SignUpRefused);
    expect(() => accounts.beforeSignUp("ana@example.com", undefined)).toThrow("Colony is invite-only.");
    expect(() => accounts.beforeSignUp("mallory@example.com", token)).toThrow("This invite is for a different email address.");
    expect(() => accounts.beforeSignUp(ADMIN_EMAIL, invites.create(ADMIN_EMAIL).token)).toThrow(/admin/);
    signUp("ana@example.com", token);
    expect(() => signUp("ana@example.com", token)).toThrow("already been used");
  });

  test("an invited email becomes a member with the members' defaults, and the invite is used up", () => {
    const { store, invites, signUp, accounts } = setup();
    const { invite, token } = invites.create("Ana@Example.com");
    const person = signUp("ana@example.com", token);
    expect(person).toMatchObject({ role: "member", login: "ana@example.com", disabled: false });
    expect(store.getPerson(person.id)).not.toBeNull();
    expect(invites.get(invite.id)).toMatchObject({ status: "used", personId: person.id });
    expect(settings.defaultModelFor(person)).toBe("opencode-go-members::muse-spark-1.3-contributor");
    expect(settings.spendCapOf(person.id)).toEqual({ cap: settings.memberPolicy().defaultCap, own: false });
    expect(() => accounts.afterSignUp("ana@example.com", token)).toThrow();
  });

  test("who each signed-in account is: members, the admin by email, nobody else", async () => {
    const { db, invites, signUp, accounts, fake } = setup();
    const ana = signUp("ana@example.com", invites.create("ana@example.com").token);
    const cookie = (email: string) => (name: string) => (name === "Cookie" ? `session=${email}` : undefined);
    expect(await accounts.personFor(cookie("ana@example.com"))).toMatchObject({ id: ana.id });
    await fake.sessions.setUpAdmin(ADMIN_EMAIL, "pw");
    expect(await accounts.personFor(cookie(ADMIN_EMAIL))).toMatchObject({ id: "owner", role: "admin" });
    expect(await accounts.personFor(cookie("nobody@example.com"))).toBeNull();
    // The admin's tailnet login isn't an admin email: an account for it is nobody.
    db.prepare("UPDATE people SET login = 'me@example.com' WHERE id = 'owner'").run();
    fake.accounts.add("me@example.com");
    expect(await accounts.personFor(cookie("me@example.com"))).toBeNull();
  });
});

describe("people and their web accounts", () => {
  test("turning a member off ends their sessions and refuses them; removing keeps their data unless asked", async () => {
    const { store, invites, signUp, accounts, fake, call } = setup();
    const ana = signUp("ana@example.com", invites.create("ana@example.com").token);
    const bot = store.createBot({ name: "Ana's", title: "", description: "", model: "", computer: false, ownerId: ana.id });
    expect((await call("GET", "/state", throughSite("ana@example.com"))).status).toBe(200);

    expect((await call("PUT", `/people/${ana.id}`, {}, { disabled: true })).json).toMatchObject({ disabled: true });
    expect(fake.revoked).toEqual(["ana@example.com"]);
    expect(await accounts.personFor((name) => (name === "Cookie" ? "session=ana@example.com" : undefined))).toBe("disabled");
    expect((await call("GET", "/state", throughSite("ana@example.com"))).status).toBe(403);
    // Turned off, they can't sign up again with a new invite either.
    expect(() => accounts.beforeSignUp("ana@example.com", invites.create("ana@example.com").token)).toThrow(/turned off/);
    await call("PUT", `/people/${ana.id}`, {}, { disabled: false });
    expect((await call("GET", "/state", throughSite("ana@example.com"))).status).toBe(200);

    // Removing: the account goes, they're turned off, their Bots stay.
    const removed = await call("DELETE", `/people/${ana.id}`);
    expect(removed.status).toBe(200);
    expect(fake.deleted).toEqual(["ana@example.com"]);
    expect(store.getPerson(ana.id)).toMatchObject({ disabled: true });
    expect(store.getBot(bot.id)).not.toBeNull();
    // Removing their data too: confirmed with ?data=delete.
    expect((await call("DELETE", `/people/${ana.id}?data=delete`)).status).toBe(204);
    expect(store.getPerson(ana.id)).toBeNull();
    expect(store.getBot(bot.id)).toBeNull();
  });

  test("the admin sets up their own web sign-in from the tailnet or this PC, for an admin email only", async () => {
    const { call, fake } = setup();
    expect((await call("POST", "/web-signin/admin", {}, { email: "Boss@Example.com", password: "a long password" })).status).toBe(204);
    expect(fake.admins).toEqual([{ email: ADMIN_EMAIL, password: "a long password" }]);
    expect((await call("POST", "/web-signin/admin", {}, { email: "ana@example.com", password: "a long password" })).status).toBe(400);
    expect((await call("POST", "/web-signin/admin", {}, { email: ADMIN_EMAIL, password: "short" })).status).toBe(400);
    expect((await call("GET", "/web-signin")).json).toMatchObject({ enabled: true, email: true, adminEmails: [ADMIN_EMAIL] });
  });
});

describe("invite emails", () => {
  test("go through Resend's API with the key, from Colony's address, with the invite link", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const transport = resendTransport("re_test_KEY_123", async (url, init) => { requests.push({ url: String(url), init: init! }); return Response.json({ id: "e1" }); });
    await new Mailer(transport).send({ to: "ana@example.com", subject: "Hi", text: "Body" });
    expect(requests[0].url).toBe("https://api.resend.com/emails");
    expect(requests[0].init.method).toBe("POST");
    expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer re_test_KEY_123");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ from: DEFAULT_FROM, to: ["ana@example.com"], subject: "Hi", text: "Body" });
    expect(mailerFromEnv({}).enabled).toBe(false);
    expect(mailerFromEnv({ RESEND_API_KEY: "re_x", COLONY_MAIL_FROM: "Me <me@example.com>" }).from).toBe("Me <me@example.com>");
    expect(mailerFromEnv({ RESEND_API_KEY: "re_x" }).from).toBe("Colony <colony@auth.werdna.xyz>");
  });

  test("Resend's errors never carry the key", async () => {
    const transport = resendTransport("re_secret_KEY", async () => Response.json({ message: "API key re_secret_KEY is invalid" }, { status: 401 }));
    const failure = await new Mailer(transport).send({ to: "a@example.com", subject: "s", text: "t" }).catch((error: Error) => error);
    expect(String(failure)).toMatch(/Resend didn't send it \(401/);
    expect(String(failure)).not.toContain("re_secret_KEY");
    const thrown = resendTransport("re_secret_KEY", async () => { throw new Error("connect ECONNREFUSED re_secret_KEY"); });
    expect(String(await new Mailer(thrown).send({ to: "a@example.com", subject: "s", text: "t" }).catch((error: Error) => error))).not.toContain("re_secret_KEY");
  });

  test("inviting emails the link on the site the admin is on; the token isn't in the answer", async () => {
    const { call, sent, invites, accounts, fake } = setup();
    await fake.sessions.setUpAdmin(ADMIN_EMAIL, "pw");
    const logs: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args.join(" ")); });
    const created = await call("POST", "/invites", throughSite(ADMIN_EMAIL), { email: "Ana@Example.com" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ emailed: true, invite: { email: "ana@example.com", status: "pending" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ana@example.com", from: DEFAULT_FROM, subject: "You're invited to Colony" });
    const link = /https:\/\/\S+/.exec(sent[0].text)![0];
    expect(link).toMatch(/^https:\/\/colony-site\.example\.workers\.dev\/signup\?invite=[\w-]+$/);
    const token = new URL(link).searchParams.get("invite")!;
    expect(created.text).not.toContain(token);
    expect((await call("GET", `/invites/check?invite=${token}`, throughSite())).json).toEqual({ valid: true, email: "ana@example.com", expiresAt: expect.any(Number) });
    // Resent: a new link; the old one stops working.
    const resent = await call("POST", `/invites/${created.json.invite.id}/resend`, throughSite(ADMIN_EMAIL));
    expect(resent.status).toBe(200);
    const fresh = new URL(/https:\/\/\S+/.exec(sent[1].text)![0]).searchParams.get("invite")!;
    expect(fresh).not.toBe(token);
    expect((await call("GET", `/invites/check?invite=${token}`, throughSite())).json).toMatchObject({ valid: false });
    // Revoked: dead too.
    expect((await call("DELETE", `/invites/${created.json.invite.id}`, throughSite(ADMIN_EMAIL))).status).toBe(204);
    expect((await call("GET", `/invites/check?invite=${fresh}`, throughSite())).json).toEqual({ valid: false, error: "This invite was withdrawn. Ask for a new one." });
    expect(() => accounts.beforeSignUp("ana@example.com", fresh)).toThrow(SignUpRefused);
    expect(invites.list()[0].status).toBe("revoked");
    // An admin email isn't invited: it's set up from Settings.
    expect((await call("POST", "/invites", {}, { email: ADMIN_EMAIL })).status).toBe(400);
    expect(logs.join("\n")).not.toContain(token);
  });

  test("with no email set up, inviting hands back the link to copy (on the first web origin from this PC)", async () => {
    const { call, sent } = setup({ mail: false });
    const created = await call("POST", "/invites", {}, { email: "bo@example.com" });
    expect(created.json).toMatchObject({ emailed: false, link: expect.stringMatching(/^https:\/\/colony\.example\/signup\?invite=[\w-]+$/) });
    expect(sent).toEqual([]);
    expect((await call("GET", "/auth-status")).json).toMatchObject({ email: false });
  });
});

describe("through the website before signing in", () => {
  test("only signing-in routes answer; everything else is 401, and changes need Colony's own Origin", async () => {
    const { call, invites } = setup();
    const status = await call("GET", "/auth-status", throughSite());
    expect(status.json).toEqual({ webSignIn: true, email: true, signedIn: false, via: "cloudflare" });
    const { token } = invites.create("ana@example.com");
    expect((await call("GET", `/invites/check?invite=${token}`, throughSite())).json).toMatchObject({ valid: true, email: "ana@example.com" });
    expect((await call("GET", "/state", throughSite())).json).toMatchObject({ signIn: true });
    expect((await call("GET", "/state", throughSite())).status).toBe(401);
    expect((await call("POST", "/bots", throughSite(), { name: "x" })).status).toBe(401);
    expect((await call("GET", "/invites", throughSite())).status).toBe(401);
    // A change without Colony's Origin is refused before anything else.
    expect((await call("POST", "/bots", throughSite(undefined, { Origin: "https://evil.example" }), { name: "x" })).status).toBe(403);
    // Without the origin token at all: refused, even for public routes.
    expect((await call("GET", "/auth-status", { "Cf-Connecting-Ip": "203.0.113.7" })).status).toBe(403);
  });

  test("signed in, a member reaches their own things and none of the admin's", async () => {
    const { call, invites, signUp } = setup();
    signUp("ana@example.com", invites.create("ana@example.com").token);
    expect((await call("GET", "/state", throughSite("ana@example.com"))).json.me).toMatchObject({ role: "member", login: "ana@example.com" });
    expect((await call("POST", "/bots", throughSite("ana@example.com"), { name: "Mine" })).status).toBe(201);
    expect((await call("GET", "/invites", throughSite("ana@example.com"))).status).toBe(403);
    expect((await call("GET", "/auth-status", throughSite("ana@example.com"))).json).toMatchObject({ signedIn: true });
  });
});
