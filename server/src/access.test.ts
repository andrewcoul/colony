import crypto from "node:crypto";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { localOnly, requirePerson, resolver, standardSources, type AccessEnv, type CloudflareAccess, type IdentitySource, type Owner } from "./access.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { People } from "./people.js";
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
const app = (who: Owner, cloudflare?: CloudflareAccess, people = directory().people, before: IdentitySource[] = []) =>
  new Hono<AccessEnv>().use(requirePerson(resolver(standardSources(who, cloudflare, before), people))).get("/", (c) => c.json(c.get("person")));
const ask = async (who: Owner, headers: Record<string, string> = {}, cloudflare?: CloudflareAccess, people?: People, before?: IdentitySource[]) => {
  const response = await app(who, cloudflare, people, before).request("/", { headers });
  return { status: response.status, person: response.status === 200 ? await response.json() as { id: string; role: string; login: string | null } : null };
};
const status = async (who: Owner, headers: Record<string, string> = {}, cloudflare?: CloudflareAccess) => (await ask(who, headers, cloudflare)).status;

// A stand-in Cloudflare Access team: its signing key, served by a fake JWKS fetch.
const team = "team.cloudflareaccess.com";
const aud = "colony-aud";
const signer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const cloudflare = (fetches: string[] = [], emails = ["Me@Example.com"]): CloudflareAccess => ({
  teamDomain: team, aud, emails,
  keys: async (url) => { fetches.push(url); return [{ ...signer.publicKey.export({ format: "jwk" }), kid: "k1" }]; },
});
const jwt = (claims: Record<string, unknown>, { key = signer.privateKey, kid = "k1" } = {}) => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${part({ alg: "RS256", kid })}.${part({ aud: [aud], iss: `https://${team}`, email: "me@example.com", iat: now, nbf: now, exp: now + 600, ...claims })}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
};
/** Headers as cloudflared delivers a tunnel request. */
const tunnel = (token?: string, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { "Cf-Connecting-Ip": "203.0.113.7", "Cf-Ray": "8abc-LHR", ...extra };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return headers;
};
const lookup = (headers: Record<string, string>) => (name: string) => headers[name];

// ---------- The rules every request passes (unchanged by accounts) ----------

test("Cloudflare requests are refused when Colony has no Cloudflare Access settings", async () => {
  expect(await status(owner(), { "Cf-Connecting-Ip": "203.0.113.7" })).toBe(403);
  expect(await status(owner(), { "Cf-Ray": "8abc-LHR" })).toBe(403);
  expect(await status(owner(), tunnel(jwt({})))).toBe(403);
  expect(await status(owner(), tunnel(jwt({})), { ...cloudflare(), aud: "" })).toBe(403);
});

test("a valid Cloudflare Access sign-in for an allowed email gets in", async () => {
  const fetches: string[] = [];
  const cf = cloudflare(fetches);
  // The raw resolver WebSocket upgrades use.
  const resolve = resolver(standardSources(owner(), cf), directory().people);
  expect(await resolve(lookup(tunnel(jwt({ email: "ME@example.com", aud }))))).toMatchObject({ via: "cloudflare" });
  expect(await resolve(lookup({ "Cf-Connecting-Ip": "203.0.113.7", Cookie: `a=b; CF_Authorization=${jwt({})}` }))).toMatchObject({ via: "cloudflare" });
  expect(fetches).toEqual([`https://${team}/cdn-cgi/access/certs`]); // Keys are kept.
  expect(await status(owner(), tunnel(jwt({})), cf)).toBe(200);
});

test("missing, forged, expired or mismatched Cloudflare Access tokens are refused", async () => {
  const cf = cloudflare();
  const now = Math.floor(Date.now() / 1000);
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const good = jwt({});
  for (const token of [
    undefined,
    "not-a-jwt",
    jwt({}, { key: other }),
    jwt({}, { kid: "unknown" }),
    jwt({ exp: now - 600 }),
    jwt({ nbf: now + 600 }),
    jwt({ exp: undefined }),
    jwt({ aud: ["someone-else"] }),
    jwt({ iss: "https://other.cloudflareaccess.com" }),
    jwt({ email: undefined }),
    `${good.split(".")[0]}.${Buffer.from(JSON.stringify({ aud: [aud], iss: `https://${team}`, email: "me@example.com", exp: now + 600 })).toString("base64url")}.${good.split(".")[2]}`,
  ]) expect(await status(owner(), tunnel(token), cf)).toBe(403);
});

test("a Cloudflare Access sign-in for another email is refused", async () => {
  expect(await status(owner(), tunnel(jwt({ email: "guest@example.com" })), cloudflare())).toBe(403);
});

test("Tailscale headers on Cloudflare requests are ignored, and claim nothing", async () => {
  const who = owner(["guest@example.com"]);
  expect(await status(who, tunnel(undefined, { "Tailscale-User-Login": "guest@example.com" }), cloudflare())).toBe(403);
  const fresh = owner();
  // The admin's tailnet login on a tunnel request doesn't make it the admin's: the Access email decides.
  const signedIn = await ask(fresh, tunnel(jwt({}), { "Tailscale-User-Login": "guest@example.com" }), cloudflare());
  expect(signedIn).toMatchObject({ status: 200, person: { role: "member", login: "me@example.com" } });
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

// ---------- Who each request is ----------

test("a Cloudflare Access email that isn't the admin's becomes a member on first sign-in, and stays that member", async () => {
  const { store, people } = directory(["boss@example.com"]);
  const cf = cloudflare([], ["Ana@Example.com", "boss@example.com"]);
  const first = await ask(owner(), tunnel(jwt({ email: "ANA@example.com" })), cf, people);
  expect(first).toMatchObject({ status: 200, person: { role: "member", login: "ana@example.com" } });
  expect(first.person!.id).not.toBe("owner");
  const again = await ask(owner(), tunnel(jwt({ email: "ana@example.com" })), cf, people);
  expect(again.person!.id).toBe(first.person!.id);
  expect(store.listPeople().map((person) => [person.role, person.login])).toEqual([["admin", null], ["member", "ana@example.com"]]);
  expect(store.getPerson(first.person!.id)).toMatchObject({ name: "Ana", role: "member" });
});

test("the admin's email (COLONY_ADMIN_EMAILS) signs in as the admin; nothing else ever does", async () => {
  const { store, people } = directory(["Boss@Example.com"]);
  const cf = cloudflare([], ["boss@example.com", "ana@example.com"]);
  expect(await ask(owner(), tunnel(jwt({ email: "boss@example.com" })), cf, people)).toMatchObject({ status: 200, person: { id: "owner", role: "admin" } });
  // No admin emails set: the same sign-in is just a member.
  expect(await ask(owner(), tunnel(jwt({ email: "boss@example.com" })), cf, directory().people)).toMatchObject({ status: 200, person: { role: "member" } });
  // A member's email never reaches the admin, and nobody is added as one.
  const ana = await ask(owner(), tunnel(jwt({ email: "ana@example.com" })), cf, people);
  expect(ana.person).toMatchObject({ role: "member" });
  expect(store.listPeople().filter((person) => person.role === "admin").map((person) => person.id)).toEqual(["owner"]);
});

test("an email that's the admin's recorded login can't sign in as a member (or as the admin, unless listed)", async () => {
  const { db, store, people } = directory();
  db.prepare("UPDATE people SET login = 'me@example.com' WHERE id = 'owner'").run();
  const refused = await ask(owner(), tunnel(jwt({ email: "me@example.com" })), cloudflare(), people);
  expect(refused.status).toBe(403);
  expect(store.listPeople()).toHaveLength(1);
});

test("requests on this PC and the admin's tailnet login are the admin; other tailnet logins are refused", async () => {
  const { people } = directory();
  expect(await ask(owner(), {}, undefined, people)).toMatchObject({ status: 200, person: { id: "owner", role: "admin" } });
  expect(await ask(owner(["me@example.com"]), { "Tailscale-User-Login": "me@example.com" }, undefined, people)).toMatchObject({ status: 200, person: { id: "owner" } });
  expect(await ask(owner([], "me@example.com"), { "Tailscale-User-Login": "me@example.com" }, undefined, people)).toMatchObject({ status: 200, person: { id: "owner" } });
  expect((await ask(owner([], "me@example.com"), { "Tailscale-User-Login": "ana@example.com" }, undefined, people)).status).toBe(403);
  expect((await ask(owner(["me@example.com"]), { "Tailscale-User-Login": "ana@example.com" }, undefined, people)).status).toBe(403);
});

test("more identity sources plug in ahead of the standard ones (a Worker that signs who it let in)", async () => {
  const { people } = directory();
  const worker: IdentitySource = {
    name: "worker",
    claim: async (header) => {
      const signed = header("X-Test-Worker");
      if (!signed) return null;
      return signed === "bad" ? { kind: "refused", reason: "Bad signature." } : { kind: "email", email: signed };
    },
  };
  expect(await ask(owner(), { "X-Test-Worker": "ana@example.com" }, undefined, people, [worker])).toMatchObject({ status: 200, person: { role: "member", login: "ana@example.com" } });
  expect((await ask(owner(), { "X-Test-Worker": "bad" }, undefined, people, [worker])).status).toBe(403);
  // Requests it doesn't recognize go on to the standard sources.
  expect(await ask(owner(), {}, undefined, people, [worker])).toMatchObject({ status: 200, person: { id: "owner" } });
});

test("without sign-ins set up, only requests on this PC get in", async () => {
  const resolve = localOnly(directory().people);
  expect(await resolve(lookup({}))).toMatchObject({ person: { id: "owner" } });
  expect(await resolve(lookup({ "Tailscale-User-Login": "me@example.com" }))).toHaveProperty("refused");
  expect(await resolve(lookup(tunnel(jwt({}))))).toHaveProperty("refused");
  expect(await resolve(lookup({ "Tailscale-Funnel-Request": "?1" }))).toHaveProperty("refused");
});
