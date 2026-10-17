import crypto from "node:crypto";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { clientAddress, localOnly, publicOrigin, requirePerson, resolver, standardSources, upgradeIdentity, type AccessEnv, type CloudflareAccess, type IdentitySource, type Owner, type WebSession } from "./access.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { People, type Person } from "./people.js";
import { Store } from "./store.js";

/** An owner record kept in memory, as settings.json keeps it. */
const owner = (allowed: string[] = [], login: string | null = null): Owner & { current: () => string | null } => {
  let recorded = login;
  return { allowed, login: () => recorded, claim: (next) => { recorded = next; }, current: () => recorded };
};
/** A fresh Colony's people: the admin, and members made as they sign in. */
const directory = (adminEmails: string[] = []) => {
  const db = openDb(":memory:");
  const store = new Store(db, new EventLog(db));
  return { db, store, people: new People(store, { adminEmails }) };
};
const SITE = "https://colony.example";
const ORIGINS = [SITE, "https://colony-site.example.workers.dev"];
/** Web sessions as cookies: "session=<person id>" is that person (or "disabled"). */
const sessions = (people: Record<string, Person | "disabled">): WebSession => async (header) => {
  const id = /(?:^|;\s*)session=([^;]+)/.exec(header("Cookie") ?? "")?.[1];
  return id ? people[id] ?? null : null;
};
const app = (who: Owner, cloudflare?: CloudflareAccess, people = directory().people, before: IdentitySource[] = [], webSession?: WebSession) =>
  new Hono<AccessEnv>()
    .use(requirePerson(resolver(standardSources(who, cloudflare, before), people, webSession), { origins: ORIGINS, isPublic: (path) => path === "/public" }))
    .get("/", (c) => c.json(c.get("person")))
    .post("/", (c) => c.json(c.get("person")))
    .get("/public", (c) => c.json({ person: c.get("person") ?? null }));
const ask = async (who: Owner, headers: Record<string, string> = {}, cloudflare?: CloudflareAccess, people?: People, before?: IdentitySource[], webSession?: WebSession, init: RequestInit = {}) => {
  const response = await app(who, cloudflare, people, before, webSession).request("/", { headers, ...init });
  return { status: response.status, person: response.status === 200 ? await response.json() as { id: string; role: string; login: string | null } : null };
};
const status = async (who: Owner, headers: Record<string, string> = {}, cloudflare?: CloudflareAccess) => (await ask(who, headers, cloudflare)).status;

// A stand-in Cloudflare Access team for the origin app: its signing key, served by a fake JWKS fetch.
const team = "team.cloudflareaccess.com";
const aud = "colony-origin-aud";
const SERVICE = "0123abcd.access";
const signer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const cloudflare = (fetches: string[] = []): CloudflareAccess => ({
  teamDomain: team, aud, serviceClientId: SERVICE,
  keys: async (url) => { fetches.push(url); return [{ ...signer.publicKey.export({ format: "jwk" }), kid: "k1" }]; },
});
const jwt = (claims: Record<string, unknown>, { key = signer.privateKey, kid = "k1" } = {}) => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${part({ alg: "RS256", kid })}.${part({ aud: [aud], iss: `https://${team}`, email: "me@example.com", iat: now, nbf: now, exp: now + 600, ...claims })}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
};
/** The colony-site Worker's service token, as Access signs it: no email, its client id as common_name. */
const serviceJwt = (claims: Record<string, unknown> = {}) => jwt({ email: undefined, common_name: SERVICE, type: "app", ...claims });
/** Headers as cloudflared delivers a tunnel request. */
const tunnel = (token?: string, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { "Cf-Connecting-Ip": "203.0.113.7", "Cf-Ray": "8abc-LHR", ...extra };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return headers;
};
const lookup = (headers: Record<string, string>) => (name: string) => headers[name];
const member = (id = "m1"): Person => ({ id, role: "member", name: "Ana", login: "ana@example.com", color: "#fff", disabled: false, createdAt: 1 });

// ---------- The rules every request passes ----------

test("Cloudflare requests are refused when Colony has no Cloudflare Access settings", async () => {
  expect(await status(owner(), { "Cf-Connecting-Ip": "203.0.113.7" })).toBe(403);
  expect(await status(owner(), { "Cf-Ray": "8abc-LHR" })).toBe(403);
  expect(await status(owner(), tunnel(serviceJwt()))).toBe(403);
  expect(await status(owner(), tunnel(serviceJwt()), { ...cloudflare(), aud: "" })).toBe(403);
});

test("without a valid origin token, a Cloudflare request is refused before anything else (even with a session)", async () => {
  const cf = cloudflare();
  const now = Math.floor(Date.now() / 1000);
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const good = serviceJwt();
  const signedIn = sessions({ m1: member() });
  for (const token of [
    undefined,
    "not-a-jwt",
    serviceJwt({}).replace(/\.[^.]+$/, ".AAAA"),
    jwt({}, { key: other }),
    jwt({}, { kid: "unknown" }),
    jwt({ exp: now - 600 }),
    jwt({ nbf: now + 600 }),
    jwt({ exp: undefined }),
    jwt({ aud: ["the-site-app-aud"] }),
    jwt({ iss: "https://other.cloudflareaccess.com" }),
    // No email, and not the Worker's service token.
    jwt({ email: undefined }),
    serviceJwt({ common_name: "someone-elses.access" }),
    `${good.split(".")[0]}.${Buffer.from(JSON.stringify({ aud: [aud], iss: `https://${team}`, common_name: SERVICE, exp: now + 600 })).toString("base64url")}.${good.split(".")[2]}`,
  ]) {
    const response = await ask(owner(), tunnel(token, { Cookie: "session=m1" }), cf, undefined, [], signedIn);
    expect(response.status).toBe(403);
  }
});

test("with the origin token but no web sign-in: 401 (except public paths); with a sign-in, that person", async () => {
  const fetches: string[] = [];
  const cf = cloudflare(fetches);
  const { people } = directory();
  const ana = member();
  const web = sessions({ m1: ana, gone: "disabled" });
  // The Worker's service token, then nobody signed in.
  expect((await ask(owner(), tunnel(serviceJwt()), cf, people, [], web)).status).toBe(401);
  const unauthenticated = await app(owner(), cf, people, [], web).request("/", { headers: tunnel(serviceJwt()) });
  expect(await unauthenticated.json()).toMatchObject({ signIn: true });
  // A public path (signing in) is let through, with nobody in it.
  const open = await app(owner(), cf, people, [], web).request("/public", { headers: tunnel(serviceJwt()) });
  expect(open.status).toBe(200);
  expect(await open.json()).toEqual({ person: null });
  // Signed in: that person. Turned off: refused.
  expect(await ask(owner(), tunnel(serviceJwt(), { Cookie: "session=m1" }), cf, people, [], web)).toMatchObject({ status: 200, person: { id: "m1", role: "member" } });
  expect((await ask(owner(), tunnel(serviceJwt(), { Cookie: "session=gone" }), cf, people, [], web)).status).toBe(403);
  // A person the origin app let in (an email token) also needs a web sign-in.
  expect((await ask(owner(), tunnel(jwt({})), cf, people, [], web)).status).toBe(401);
  expect((await ask(owner(), tunnel(jwt({}), { Cookie: "session=m1" }), cf, people, [], web)).person).toMatchObject({ id: "m1" });
  // Via the CF_Authorization cookie too; keys are fetched once and kept.
  expect((await ask(owner(), { "Cf-Connecting-Ip": "203.0.113.7", Cookie: `a=b; CF_Authorization=${serviceJwt()}; session=m1` }, cf, people, [], web)).status).toBe(200);
  const once: string[] = [];
  const resolve = resolver(standardSources(owner(), cloudflare(once)), people, web);
  for (let index = 0; index < 3; index++) expect(await resolve(lookup(tunnel(serviceJwt(), { Cookie: "session=m1" })))).toMatchObject({ person: { id: "m1" }, via: "cloudflare" });
  expect(once).toEqual([`https://${team}/cdn-cgi/access/certs`]);
  expect(fetches.length).toBeGreaterThan(0);
  // No sign-in service at all: still 401, never anyone.
  expect((await ask(owner(), tunnel(serviceJwt(), { Cookie: "session=m1" }), cf, people)).status).toBe(401);
});

test("through Cloudflare, changes must come from Colony's own pages (Origin); reading needn't", async () => {
  const cf = cloudflare();
  const web = sessions({ m1: member() });
  const post = (headers: Record<string, string>) => ask(owner(), tunnel(serviceJwt(), { Cookie: "session=m1", ...headers }), cf, undefined, [], web, { method: "POST" });
  expect((await post({})).status).toBe(403);
  expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
  expect((await post({ Origin: "null" })).status).toBe(403);
  expect((await post({ Origin: SITE })).status).toBe(200);
  expect((await post({ Origin: "https://colony-site.example.workers.dev" })).status).toBe(200);
  expect((await ask(owner(), tunnel(serviceJwt(), { Cookie: "session=m1" }), cf, undefined, [], web)).status).toBe(200);
  // On this PC and the tailnet, nothing changes.
  expect((await ask(owner(), {}, cf, undefined, [], web, { method: "POST" })).status).toBe(200);
  expect((await ask(owner(["me@example.com"]), { "Tailscale-User-Login": "me@example.com" }, cf, undefined, [], web, { method: "POST" })).status).toBe(200);
});

test("WebSocket upgrades through Cloudflare need the origin token, a web sign-in and Colony's own Origin", async () => {
  const cf = cloudflare();
  const { people } = directory();
  const resolve = resolver(standardSources(owner(), cf), people, sessions({ m1: member(), gone: "disabled" }));
  // No origin token: refused (403). A token but no sign-in: 401. Turned off, or not Colony's Origin: 403.
  expect(await upgradeIdentity(resolve, lookup(tunnel(undefined, { Cookie: "session=m1", Origin: SITE })), ORIGINS)).toMatchObject({ status: 403 });
  expect(await upgradeIdentity(resolve, lookup(tunnel(serviceJwt(), { Origin: SITE })), ORIGINS)).toMatchObject({ status: 401, error: "Sign in to Colony." });
  expect(await upgradeIdentity(resolve, lookup(tunnel(serviceJwt(), { Cookie: "session=gone", Origin: SITE })), ORIGINS)).toMatchObject({ status: 403 });
  expect(await upgradeIdentity(resolve, lookup(tunnel(serviceJwt(), { Cookie: "session=m1" })), ORIGINS)).toMatchObject({ status: 403 });
  expect(await upgradeIdentity(resolve, lookup(tunnel(serviceJwt(), { Cookie: "session=m1", Origin: "https://evil.example" })), ORIGINS)).toMatchObject({ status: 403 });
  expect(await upgradeIdentity(resolve, lookup(tunnel(serviceJwt(), { Cookie: "session=m1", Origin: SITE })), ORIGINS)).toMatchObject({ person: { id: "m1" } });
  // This PC: the admin, as before.
  expect(await upgradeIdentity(resolve, lookup({}), ORIGINS)).toMatchObject({ person: { id: "owner" } });
});

test("rate limits count the visitor the Worker names only on the Worker's own requests", async () => {
  const cf = cloudflare();
  const resolve = resolver(standardSources(owner(), cf), directory().people, sessions({}));
  const worker = "198.18.0.1";
  const headers = (token: string) => tunnel(token, { "Cf-Connecting-Ip": worker, "X-Colony-Client-Ip": "203.0.113.50" });
  // The Worker's service token: the visitor's address it passed.
  const service = await resolve(lookup(headers(serviceJwt())));
  expect(service.token).toBe("service");
  expect(clientAddress(lookup(headers(serviceJwt())), service.via, service.token)).toBe("203.0.113.50");
  // A person's token (straight to the origin app, not through the Worker): anyone could send that header.
  const person = await resolve(lookup(headers(jwt({}))));
  expect(person.token).toBe("person");
  expect(clientAddress(lookup(headers(jwt({}))), person.via, person.token)).toBe(worker);
  // The Worker named nobody: Cloudflare's address.
  expect(clientAddress(lookup(tunnel(serviceJwt(), { "Cf-Connecting-Ip": worker })), "cloudflare", "service")).toBe(worker);
  // The tailnet and this PC: one local address, whatever the headers say.
  expect(clientAddress(lookup({ "X-Colony-Client-Ip": "203.0.113.50", "Cf-Connecting-Ip": worker }), "local", undefined)).toBe("127.0.0.1");
  expect(clientAddress(lookup({}), "tailnet", undefined)).toBe("127.0.0.1");
  // A token with both an email and the service id is a person's.
  expect((await resolve(lookup(tunnel(jwt({ common_name: SERVICE }))))).token).toBe("person");
});

test("forwarded hosts count only on requests verified through the origin app, and only Colony's own", () => {
  const forwarded = { "X-Forwarded-Host": "colony-site.example.workers.dev", "X-Forwarded-Proto": "https" };
  expect(publicOrigin(lookup(forwarded), "cloudflare", ORIGINS)).toBe("https://colony-site.example.workers.dev");
  // Not through Cloudflare (anyone on the tailnet could send it): ignored.
  expect(publicOrigin(lookup(forwarded), "tailnet", ORIGINS)).toBe(SITE);
  expect(publicOrigin(lookup(forwarded), undefined, ORIGINS)).toBe(SITE);
  // Through Cloudflare but not one of Colony's: ignored.
  expect(publicOrigin(lookup({ "X-Forwarded-Host": "evil.example" }), "cloudflare", ORIGINS)).toBe(SITE);
  expect(publicOrigin(lookup({ "X-Forwarded-Host": "colony.example", "X-Forwarded-Proto": "http" }), "cloudflare", ORIGINS)).toBe(SITE);
  expect(publicOrigin(lookup({ Origin: "https://colony-site.example.workers.dev" }), "local", ORIGINS)).toBe("https://colony-site.example.workers.dev");
  expect(publicOrigin(lookup({}), "local", [])).toBeNull();
});

test("Tailscale headers on Cloudflare requests are ignored, and claim nothing", async () => {
  const fresh = owner();
  const cf = cloudflare();
  expect(await status(owner(["guest@example.com"]), tunnel(undefined, { "Tailscale-User-Login": "guest@example.com" }), cf)).toBe(403);
  // A good origin token plus the admin's tailnet login is still not the admin: it needs a web sign-in.
  expect((await ask(fresh, tunnel(serviceJwt(), { "Tailscale-User-Login": "me@example.com" }), cf, undefined, [], sessions({}))).status).toBe(401);
  expect(await status(fresh, tunnel(undefined, { "Tailscale-User-Login": "guest@example.com" }))).toBe(403);
  expect(fresh.current()).toBeNull();
});

test("tailnet and local requests are unchanged when Cloudflare Access is set", async () => {
  const who = owner();
  expect(await status(who, {}, cloudflare())).toBe(200);
  expect(await status(who, { "Tailscale-Funnel-Request": "?1" }, cloudflare())).toBe(403);
  expect(await status(who, { "Tailscale-User-Login": "me@example.com" }, cloudflare())).toBe(200);
  expect(who.current()).toBe("me@example.com");
  expect(await status(who, { "Tailscale-User-Login": "guest@example.com" }, cloudflare())).toBe(403);
});

test("Funnel traffic is refused; requests made on this PC are allowed", async () => {
  expect(await status(owner(), { "Tailscale-Funnel-Request": "?1" })).toBe(403);
  expect(await status(owner())).toBe(200);
});

test("the first tailnet login is recorded as yours, and other logins are refused", async () => {
  const who = owner();
  expect(await status(who, { "Tailscale-User-Login": "Me@Example.com" })).toBe(200);
  expect(who.current()).toBe("me@example.com");
  expect(await status(who, { "Tailscale-User-Login": "me@example.com" })).toBe(200);
  expect(await status(who, { "Tailscale-User-Login": "guest@example.com" })).toBe(403);
  expect(await status(who)).toBe(200); // Direct on this PC.
});

test("a recorded owner login keeps everyone else out", async () => {
  const who = owner([], "me@example.com");
  expect(await status(who, { "Tailscale-User-Login": "marija@example.com" })).toBe(403);
  expect(who.current()).toBe("me@example.com");
});

test("COLONY_ALLOWED_USERS decides which tailnet logins get in", async () => {
  const who = owner(["Me@Example.com", "me@work.example"]);
  expect(await status(who, { "Tailscale-User-Login": "me@example.com" })).toBe(200);
  expect(await status(who, { "Tailscale-User-Login": "me@work.example" })).toBe(200);
  expect(await status(who, { "Tailscale-User-Login": "guest@example.com" })).toBe(403);
  expect(who.current()).toBeNull(); // Nothing is claimed while the list decides.
});

test("requests on this PC and the admin's tailnet login are the admin; other tailnet logins are refused", async () => {
  const { people } = directory();
  expect(await ask(owner(), {}, undefined, people)).toMatchObject({ status: 200, person: { id: "owner", role: "admin" } });
  expect(await ask(owner(["me@example.com"]), { "Tailscale-User-Login": "me@example.com" }, undefined, people)).toMatchObject({ status: 200, person: { id: "owner" } });
  expect(await ask(owner([], "me@example.com"), { "Tailscale-User-Login": "me@example.com" }, undefined, people)).toMatchObject({ status: 200, person: { id: "owner" } });
  expect((await ask(owner([], "me@example.com"), { "Tailscale-User-Login": "ana@example.com" }, undefined, people)).status).toBe(403);
  expect((await ask(owner(["me@example.com"]), { "Tailscale-User-Login": "ana@example.com" }, undefined, people)).status).toBe(403);
});

test("more identity sources plug in ahead of the standard ones", async () => {
  const { people } = directory();
  const signed: IdentitySource = {
    name: "signed",
    claim: async (header) => {
      const value = header("X-Test-Signed");
      if (!value) return null;
      return value === "bad" ? { kind: "refused", reason: "Bad signature." } : { kind: "email", email: value };
    },
  };
  expect(await ask(owner(), { "X-Test-Signed": "ana@example.com" }, undefined, people, [signed])).toMatchObject({ status: 200, person: { role: "member", login: "ana@example.com" } });
  expect((await ask(owner(), { "X-Test-Signed": "bad" }, undefined, people, [signed])).status).toBe(403);
  // Requests it doesn't recognize go on to the standard sources.
  expect(await ask(owner(), {}, undefined, people, [signed])).toMatchObject({ status: 200, person: { id: "owner" } });
});

test("without sign-ins set up, only requests on this PC get in", async () => {
  const resolve = localOnly(directory().people);
  expect(await resolve(lookup({}))).toMatchObject({ person: { id: "owner" } });
  expect(await resolve(lookup({ "Tailscale-User-Login": "me@example.com" }))).toHaveProperty("refused");
  expect(await resolve(lookup(tunnel(serviceJwt())))).toHaveProperty("refused");
  expect(await resolve(lookup({ "Tailscale-Funnel-Request": "?1" }))).toHaveProperty("refused");
});
