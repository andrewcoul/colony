import crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { People, Person, Refusal } from "./people.js";

/**
 * Who's asking. Every request (HTTP and WebSocket upgrades alike) resolves to a person, or is
 * refused. Identity sources are asked in turn; the first that recognizes the request decides:
 * - Cloudflare: requests that came in through the Cloudflare Tunnel (Cloudflare sets
 *   `Cf-Connecting-Ip` at its edge) must first carry a valid token from the origin's Cloudflare
 *   Access app: the colony-site Worker's service token (COLONY_CF_ACCESS_SERVICE_CLIENT_ID), or a
 *   person that app let in. Without Access settings they're refused. Then they need a web sign-in
 *   (a session cookie): that account's person, the admin for COLONY_ADMIN_EMAILS. With no sign-in,
 *   the answer is 401. Tailscale headers on them are ignored: anyone could send those through the tunnel.
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

/**
 * What a source makes of a request it recognizes: refused, the admin, a verified email, or a request
 * it let through that must now show a web sign-in (`session`).
 */
export type Claim = { kind: "refused"; reason: string } | { kind: "admin" } | { kind: "email"; email: string } | { kind: "session"; token: AccessToken };

/** Whose origin Access token a tunnel request carried: the colony-site Worker's service token, or a person's. */
export type AccessToken = "service" | "person";

/** One way of knowing who's asking. `claim` resolves to null for requests that aren't its kind. */
export type IdentitySource = { name: string; claim: (header: HeaderLookup) => Promise<Claim | null> };

/**
 * A request's identity: a person (and which source said so), or why it's refused. `status` 401: it
 * needs a web sign-in (it's otherwise allowed); `via` says where a refused request came in.
 */
export type Identity = ({ person: Person; via: string } | (Refusal & { status?: 401 | 403; via?: string })) & { token?: AccessToken };

export type Resolver = (header: HeaderLookup) => Promise<Identity>;

/** Who's signed in on the web on a request: a person, "disabled", or nobody (see webauth.ts). */
export type WebSession = (header: HeaderLookup) => Promise<Person | "disabled" | null>;

/**
 * Resolves requests with these sources, in order: verified emails to people (made on first use),
 * and requests that need a web sign-in to whoever `webSession` says is signed in.
 */
export function resolver(sources: IdentitySource[], people: Pick<People, "admin" | "byEmail">, webSession?: WebSession): Resolver {
  return async (header) => {
    for (const source of sources) {
      const claim = await source.claim(header);
      if (!claim) continue;
      if (claim.kind === "refused") return { refused: claim.reason, via: source.name };
      if (claim.kind === "admin") return { person: people.admin(), via: source.name };
      if (claim.kind === "session") {
        const token = claim.token;
        const person = webSession ? await webSession(header) : null;
        if (person === "disabled") return { refused: "Your account on this Colony is turned off. Ask the person who runs it.", status: 403, via: source.name, token };
        if (!person) return { refused: webSession ? "Sign in to Colony." : "Web sign-in isn't set up on this Colony yet.", status: 401, via: source.name, token };
        return { person, via: source.name, token };
      }
      const person = people.byEmail(claim.email);
      return "refused" in person ? { ...person, via: source.name } : { person, via: source.name };
    }
    return { refused: "Colony couldn't tell who you are." };
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Whether an Origin header names one of Colony's own web origins. */
export function sameOrigin(origin: string | undefined, origins: readonly string[]) {
  if (!origin) return false;
  try { return origins.includes(new URL(origin).origin); } catch { return false; }
}

/**
 * The web origin a request is on, for links in emails: the forwarded host when the request is
 * verified as coming through the origin's Access app (`via` cloudflare) and the host is one of
 * Colony's origins; else its Origin header if it's one of them; else the first. Null with none set.
 */
export function publicOrigin(header: HeaderLookup, via: string | undefined, origins: readonly string[]): string | null {
  if (!origins.length) return null;
  const host = header("X-Forwarded-Host")?.trim();
  if (via === "cloudflare" && host) {
    const forwarded = `${(header("X-Forwarded-Proto") ?? "https").trim().toLowerCase()}://${host.toLowerCase()}`;
    if (origins.includes(forwarded)) return forwarded;
  }
  const origin = header("Origin");
  if (origin && sameOrigin(origin, origins)) return new URL(origin).origin;
  return origins[0];
}

/**
 * Who a WebSocket upgrade is from, or why it's refused: 401 through Cloudflare without a web sign-in,
 * 403 for anything else refused, and for upgrades from Cloudflare that don't come from Colony's own pages.
 */
export async function upgradeIdentity(resolve: Resolver, header: HeaderLookup, origins: readonly string[]): Promise<{ person: Person } | { status: 401 | 403; error: string }> {
  const identity = await resolve(header);
  if ("refused" in identity) return { status: identity.status === 401 ? 401 : 403, error: identity.refused };
  if (identity.via === "cloudflare" && !sameOrigin(header("Origin"), origins)) return { status: 403, error: "Colony only takes connections from its own pages." };
  return { person: identity.person };
}

/**
 * The client address sign-in rate limits count by. Through the tunnel, Cloudflare's Cf-Connecting-Ip
 * is the colony-site Worker's own address, so the Worker passes the visitor's as X-Colony-Client-Ip:
 * that counts only on requests verified as carrying the Worker's service token. Otherwise
 * Cf-Connecting-Ip; on the tailnet or this PC, 127.0.0.1.
 */
export function clientAddress(header: HeaderLookup, via: string | undefined, token: AccessToken | undefined) {
  if (via !== "cloudflare") return "127.0.0.1";
  const forwarded = token === "service" ? header("X-Colony-Client-Ip")?.trim() : undefined;
  return forwarded || header("Cf-Connecting-Ip")?.trim() || "";
}

/** The admin's tailnet login, as settings.json keeps it. */
export type Owner = { allowed: readonly string[]; login: () => string | null; claim: (login: string) => void };

type Jwk = crypto.webcrypto.JsonWebKey & { kid?: string };
/**
 * The Cloudflare Access app in front of the tunnel (the origin app). `serviceClientId`: the service
 * token the colony-site Worker signs in with (its tokens carry it as `common_name`, and no email).
 * `keys` replaces fetching the team's signing keys (tests).
 */
export type CloudflareAccess = { teamDomain: string; aud: string; serviceClientId?: string; keys?: (url: string) => Promise<Jwk[]> };

/** The sources Colony uses, most specific first. `before`: more sources, asked before these. */
export function standardSources(owner: Owner, cloudflare?: CloudflareAccess, before: IdentitySource[] = []): IdentitySource[] {
  return [...before, cloudflareSource(cloudflare), funnelSource, tailnetSource(owner), localSource];
}

/** Requests through the Cloudflare Tunnel: a valid token from the origin's Access app (then a web sign-in), or refused. */
export function cloudflareSource(cloudflare?: CloudflareAccess): IdentitySource {
  const verify = cloudflare?.teamDomain && cloudflare.aud ? accessVerifier(cloudflare) : null;
  return {
    name: "cloudflare",
    claim: async (header) => {
      if (!header("Cf-Connecting-Ip") && !header("Cf-Ray") && !header("Cf-Access-Jwt-Assertion")) return null;
      if (!verify) return { kind: "refused", reason: "Colony isn't set up for Cloudflare Access. Set COLONY_CF_ACCESS_TEAM_DOMAIN and COLONY_CF_ACCESS_AUD." };
      const token = header("Cf-Access-Jwt-Assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(header("Cookie") ?? "")?.[1];
      if (!token) return { kind: "refused", reason: "This request didn't come through Colony's website." };
      const checked = await verify(token);
      return "refused" in checked ? { kind: "refused", reason: checked.refused } : { kind: "session", token: checked.token };
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

/**
 * What Hono routes behind `requirePerson` can read: who's asking (unset on a public route with no
 * one signed in), and where the request came in ("cloudflare", "tailnet", "local"…).
 */
export type AccessEnv = { Variables: { person: Person; via: string; token: AccessToken } };

/**
 * Resolves who's asking (once per request) and refuses anyone it can't name. Through Cloudflare:
 * a request that changes something must come from one of Colony's own web pages (its Origin is in
 * `origins`), and one with no web sign-in gets 401, except on `isPublic` paths (signing in itself).
 */
export function requirePerson(resolve: Resolver, options: { isPublic?: (path: string) => boolean; origins?: readonly string[] } = {}): MiddlewareHandler<AccessEnv> {
  return async (c, next) => {
    if (!c.get("person")) {
      const header = (name: string) => c.req.header(name);
      const identity = await resolve(header);
      if ("refused" in identity && identity.status !== 401) return c.json({ error: identity.refused }, 403);
      if (identity.via === "cloudflare" && !SAFE_METHODS.has(c.req.method) && !sameOrigin(header("Origin"), options.origins ?? [])) {
        return c.json({ error: "Colony only takes changes from its own pages." }, 403);
      }
      if (identity.via) c.set("via", identity.via);
      if (identity.token) c.set("token", identity.token);
      if ("refused" in identity) {
        if (options.isPublic?.(c.req.path)) return next();
        return c.json({ error: identity.refused, signIn: true }, 401);
      }
      c.set("person", identity.person);
    }
    await next();
  };
}

/**
 * Checks a token from the origin's Access app (an RS256 JWT signed by the team's keys, for its AUD):
 * one for a person the app let in (it has an email), or for the Worker's service token (its
 * `common_name` is the service client id). Resolves to whose token it is, or why it's refused.
 */
function accessVerifier(cloudflare: CloudflareAccess) {
  const issuer = `https://${cloudflare.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  const service = cloudflare.serviceClientId?.trim() ?? "";
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
  return async (token: string): Promise<{ token: AccessToken } | Refusal> => {
    const refused = { refused: "This request's Cloudflare Access token isn't valid." };
    try {
      const [head, body, signature, ...rest] = token.split(".");
      if (!head || !body || !signature || rest.length) return refused;
      const { alg, kid } = json(head);
      if (alg !== "RS256" || typeof kid !== "string") return refused;
      const publicKey = await key(kid);
      if (!publicKey || !crypto.verify("RSA-SHA256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, "base64url"))) return refused;
      const { aud, iss, exp, nbf, email, common_name: commonName } = json(body);
      const now = Date.now() / 1000;
      const skew = 60;
      if (!(Array.isArray(aud) ? aud : [aud]).includes(cloudflare.aud) || iss !== issuer) return refused;
      if (typeof exp !== "number" || exp + skew < now) return refused;
      if (nbf !== undefined && (typeof nbf !== "number" || nbf - skew > now)) return refused;
      if (service && commonName === service && !(typeof email === "string" && email.trim())) return { token: "service" };
      if (typeof email === "string" && email.trim()) return { token: "person" };
      return refused;
    } catch (error) {
      console.log(`[colony] Couldn't check a Cloudflare Access sign-in: ${error}`);
      return refused;
    }
  };
}
