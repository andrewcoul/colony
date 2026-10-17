import crypto from "node:crypto";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { accessCheck, tailnetOnly, type CloudflareAccess, type Owner } from "./access.js";

/** An owner record kept in memory, as settings.json keeps it. */
const owner = (allowed: string[] = [], login: string | null = null): Owner & { current: () => string | null } => {
  let recorded = login;
  return { allowed, login: () => recorded, claim: (next) => { recorded = next; }, current: () => recorded };
};
const app = (who: Owner, cloudflare?: CloudflareAccess) => new Hono().use(tailnetOnly(who, cloudflare)).get("/", (c) => c.text("ok"));
const status = async (who: Owner, headers: Record<string, string> = {}, cloudflare?: CloudflareAccess) =>
  (await app(who, cloudflare).request("/", { headers })).status;

// A stand-in Cloudflare Access team: its signing key, served by a fake JWKS fetch.
const team = "team.cloudflareaccess.com";
const aud = "colony-aud";
const signer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const cloudflare = (fetches: string[] = []): CloudflareAccess => ({
  teamDomain: team, aud, emails: ["Me@Example.com"],
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

test("Cloudflare requests are refused when Colony has no Cloudflare Access settings", async () => {
  expect(await status(owner(), { "Cf-Connecting-Ip": "203.0.113.7" })).toBe(403);
  expect(await status(owner(), { "Cf-Ray": "8abc-LHR" })).toBe(403);
  expect(await status(owner(), tunnel(jwt({})))).toBe(403);
  expect(await status(owner(), tunnel(jwt({})), { ...cloudflare(), aud: "" })).toBe(403);
});

test("a valid Cloudflare Access sign-in for an allowed email gets in", async () => {
  const fetches: string[] = [];
  const cf = cloudflare(fetches);
  // The raw check WebSocket upgrades use.
  const check = accessCheck(owner(), cf);
  const lookup = (headers: Record<string, string>) => (name: string) => headers[name];
  expect(await check(lookup(tunnel(jwt({ email: "ME@example.com", aud }))))).toBeNull();
  expect(await check(lookup({ "Cf-Connecting-Ip": "203.0.113.7", Cookie: `a=b; CF_Authorization=${jwt({})}` }))).toBeNull();
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
  expect(await status(fresh, tunnel(jwt({}), { "Tailscale-User-Login": "guest@example.com" }), cloudflare())).toBe(200);
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
