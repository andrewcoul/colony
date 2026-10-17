import crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { People, Person, Refusal } from "./people.js";

/**
 * Who's asking. Every request (HTTP and WebSocket upgrades alike) resolves to a person, or is
 * refused. Identity sources are asked in turn; the first that recognizes the request decides:
 * - Cloudflare Access: requests that came in through a Cloudflare Tunnel (Cloudflare sets
 *   `Cf-Connecting-Ip` at its edge) must carry a Cloudflare Access token for an allowed email.
 *   Without Access settings they're refused. Tailscale headers on them are ignored: anyone could
 *   send those through the tunnel. The email is the admin (COLONY_ADMIN_EMAILS) or a member,
 *   made on first sign-in.
 * - Tailscale Funnel (the public internet): refused. tailscaled marks these requests with
 *   `Tailscale-Funnel-Request: ?1` and strips any copy a client sends.
 * - Tailscale serve (`Tailscale-User-Login`): the admin's own login (one in COLONY_ALLOWED_USERS,
 *   or the owner login Colony recorded; with neither set, the first login seen is recorded) is the
 *   admin. Any other tailnet login is refused.
 * - Requests made directly on this PC carry no identity and are the admin's (the server listens on
 *   127.0.0.1 unless COLONY_HOST says otherwise).
 * More sources (a Worker that signs who it let in) go in front of these.
 */

export type HeaderLookup = (name: string) => string | undefined;

/** What a source makes of a request it recognizes: refused, the admin, or a verified email. */
export type Claim = { kind: "refused"; reason: string } | { kind: "admin" } | { kind: "email"; email: string };

/** One way of knowing who's asking. `claim` resolves to null for requests that aren't its kind. */
export type IdentitySource = { name: string; claim: (header: HeaderLookup) => Promise<Claim | null> };

/** A request's identity: a person (and which source said so), or why it's refused. */
export type Identity = { person: Person; via: string } | Refusal;

export type Resolver = (header: HeaderLookup) => Promise<Identity>;

/** Resolves requests with these sources, in order, mapping verified emails to people. */
export function resolver(sources: IdentitySource[], people: Pick<People, "admin" | "byEmail">): Resolver {
  return async (header) => {
    for (const source of sources) {
      const claim = await source.claim(header);
      if (!claim) continue;
      if (claim.kind === "refused") return { refused: claim.reason };
      if (claim.kind === "admin") return { person: people.admin(), via: source.name };
      const person = people.byEmail(claim.email);
      return "refused" in person ? person : { person, via: source.name };
    }
    return { refused: "Colony couldn't tell who you are." };
  };
}

/** The admin's tailnet login, as settings.json keeps it. */
export type Owner = { allowed: readonly string[]; login: () => string | null; claim: (login: string) => void };

type Jwk = crypto.webcrypto.JsonWebKey & { kid?: string };
/**
 * Cloudflare Access in front of a Cloudflare Tunnel. `emails`: who may sign in through it.
 * `keys` replaces fetching the team's signing keys (tests).
 */
export type CloudflareAccess = { teamDomain: string; aud: string; emails: readonly string[]; keys?: (url: string) => Promise<Jwk[]> };

/** The sources Colony uses, most specific first. `before`: more sources, asked before these. */
export function standardSources(owner: Owner, cloudflare?: CloudflareAccess, before: IdentitySource[] = []): IdentitySource[] {
  return [...before, cloudflareSource(cloudflare), funnelSource, tailnetSource(owner), localSource];
}

/** Requests through a Cloudflare Tunnel: a valid Access token for an allowed email, or refused. */
export function cloudflareSource(cloudflare?: CloudflareAccess): IdentitySource {
  const verify = cloudflare?.teamDomain && cloudflare.aud ? accessVerifier(cloudflare) : null;
  return {
    name: "cloudflare",
    claim: async (header) => {
      if (!header("Cf-Connecting-Ip") && !header("Cf-Ray") && !header("Cf-Access-Jwt-Assertion")) return null;
      if (!verify) return { kind: "refused", reason: "Colony isn't set up for Cloudflare Access. Set COLONY_CF_ACCESS_TEAM_DOMAIN and COLONY_CF_ACCESS_AUD." };
      const token = header("Cf-Access-Jwt-Assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(header("Cookie") ?? "")?.[1];
      if (!token) return { kind: "refused", reason: "Sign in through Cloudflare Access to use this Colony." };
      const checked = await verify(token);
      return "refused" in checked ? { kind: "refused", reason: checked.refused } : { kind: "email", email: checked.email };
    },
  };
}

/** Tailscale Funnel is the public internet: always refused. */
export const funnelSource: IdentitySource = {
  name: "funnel",
  claim: async (header) => (header("Tailscale-Funnel-Request") ? { kind: "refused", reason: "Colony is private to your tailnet. Use `tailscale serve`, not `tailscale funnel`." } : null),
};

/** `tailscale serve` traffic: the admin's own tailnet login, or refused. */
export function tailnetSource(owner: Owner): IdentitySource {
  const allowed = new Set(owner.allowed.map((user) => user.trim().toLowerCase()).filter(Boolean));
  return {
    name: "tailnet",
    claim: async (header) => {
      const login = header("Tailscale-User-Login")?.trim().toLowerCase();
      if (!login) return null;
      if (allowed.has(login)) return { kind: "admin" };
      if (allowed.size) return { kind: "refused", reason: `${login} isn't allowed to use this Colony.` };
      const known = owner.login()?.toLowerCase();
      if (!known) { owner.claim(login); return { kind: "admin" }; }
      return login === known ? { kind: "admin" } : { kind: "refused", reason: `${login} isn't allowed to use this Colony. It belongs to ${known}.` };
    },
  };
}

/** No identity at all: a request made on this PC, which is the admin's. */
export const localSource: IdentitySource = { name: "local", claim: async () => ({ kind: "admin" }) };

/**
 * With no sign-ins set up: requests made on this PC are the admin's, and any request that
 * claims an identity is refused, since nothing here could check it.
 */
export function localOnly(people: Pick<People, "admin" | "byEmail">): Resolver {
  const unchecked: IdentitySource = {
    name: "unchecked",
    claim: async (header) => (header("Tailscale-User-Login") ? { kind: "refused", reason: "Colony isn't set up for tailnet sign-ins here." } : null),
  };
  return resolver([cloudflareSource(), funnelSource, unchecked, localSource], people);
}

/** What Hono routes behind `requirePerson` can read: who's asking. */
export type AccessEnv = { Variables: { person: Person } };

/** Resolves who's asking (once per request) and refuses anyone it can't name. */
export function requirePerson(resolve: Resolver): MiddlewareHandler<AccessEnv> {
  return async (c, next) => {
    if (!c.get("person")) {
      const identity = await resolve((name) => c.req.header(name));
      if ("refused" in identity) return c.json({ error: identity.refused }, 403);
      c.set("person", identity.person);
    }
    await next();
  };
}

/** Checks a Cloudflare Access token (an RS256 JWT signed by the team's keys): resolves to its allowed email, or why it's refused. */
function accessVerifier(cloudflare: CloudflareAccess) {
  const issuer = `https://${cloudflare.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  const emails = new Set(cloudflare.emails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const fetchKeys = cloudflare.keys ?? (async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return ((await response.json()) as { keys: Jwk[] }).keys;
  });
  let keys = new Map<string, crypto.KeyObject>();
  let loading: Promise<void> | null = null;
  let fetchedAt = 0;
  // Fetch again for a key we haven't seen (Cloudflare rotates them), but not more than every 10s.
  const key = async (kid: string) => {
    if (!keys.has(kid) && !loading && Date.now() - fetchedAt > 10_000) {
      fetchedAt = Date.now();
      loading = fetchKeys(`${issuer}/cdn-cgi/access/certs`).then((list) => {
        keys = new Map(list.filter((jwk) => jwk.kty === "RSA" && jwk.kid).map((jwk) => [jwk.kid!, crypto.createPublicKey({ key: jwk, format: "jwk" })]));
      }).finally(() => { loading = null; });
    }
    if (!keys.has(kid) && loading) await loading;
    return keys.get(kid);
  };
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  return async (token: string): Promise<{ email: string } | Refusal> => {
    const refused = { refused: "Your Cloudflare Access sign-in isn't valid. Sign in again." };
    try {
      const [head, body, signature, ...rest] = token.split(".");
      if (!head || !body || !signature || rest.length) return refused;
      const { alg, kid } = json(head);
      if (alg !== "RS256" || typeof kid !== "string") return refused;
      const publicKey = await key(kid);
      if (!publicKey || !crypto.verify("RSA-SHA256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, "base64url"))) return refused;
      const { aud, iss, exp, nbf, email } = json(body);
      const now = Date.now() / 1000;
      const skew = 60;
      if (!(Array.isArray(aud) ? aud : [aud]).includes(cloudflare.aud) || iss !== issuer) return refused;
      if (typeof exp !== "number" || exp + skew < now) return refused;
      if (nbf !== undefined && (typeof nbf !== "number" || nbf - skew > now)) return refused;
      const login = typeof email === "string" ? email.trim().toLowerCase() : "";
      if (!login) return refused;
      return emails.has(login) ? { email: login } : { refused: `${login} isn't allowed to use this Colony.` };
    } catch (error) {
      console.log(`[colony] Couldn't check a Cloudflare Access sign-in: ${error}`);
      return refused;
    }
  };
}
