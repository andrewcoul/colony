import crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Colony has no login: your tailnet is the boundary, and Colony is yours alone. This keeps it that way.
 * - Requests that came in through Tailscale Funnel (the public internet) are refused.
 *   tailscaled marks them with `Tailscale-Funnel-Request: ?1` and strips any copy a client sends.
 * - Requests that came in through a Cloudflare Tunnel (Cloudflare sets `Cf-Connecting-Ip` at its
 *   edge) must carry a Cloudflare Access token for an allowed email. Without Access settings
 *   they're refused. Tailscale headers on them are ignored: anyone could send those through the tunnel.
 * - Tailnet requests (Tailscale adds `Tailscale-User-Login` on `tailscale serve` traffic) must come
 *   from you: a login in COLONY_ALLOWED_USERS, or the owner login Colony recorded. With neither set,
 *   the first login seen is recorded as yours.
 * - Requests made directly on this PC carry no identity and stay allowed (the server listens on
 *   127.0.0.1 unless COLONY_HOST says otherwise).
 */
export type Owner = { allowed: string[]; login: () => string | null; claim: (login: string) => void };

type Jwk = crypto.JsonWebKey & { kid?: string };
/** Cloudflare Access in front of a Cloudflare Tunnel. `keys` replaces fetching the team's signing keys (tests). */
export type CloudflareAccess = { teamDomain: string; aud: string; emails: string[]; keys?: (url: string) => Promise<Jwk[]> };

export function tailnetOnly(owner: Owner, cloudflare?: CloudflareAccess): MiddlewareHandler {
  const check = accessCheck(owner, cloudflare);
  return async (c, next) => {
    const refusal = await check((name) => c.req.header(name));
    if (refusal) return c.text(refusal, 403);
    await next();
  };
}

/** The same rules for raw requests (WebSocket upgrades): resolves to why a request is refused, or null. */
export function accessCheck(owner: Owner, cloudflare?: CloudflareAccess) {
  const allowed = new Set(owner.allowed.map((user) => user.trim().toLowerCase()).filter(Boolean));
  const verify = cloudflare?.teamDomain && cloudflare.aud ? accessVerifier(cloudflare) : null;
  return async (header: (name: string) => string | undefined): Promise<string | null> => {
    if (header("Cf-Connecting-Ip") || header("Cf-Ray") || header("Cf-Access-Jwt-Assertion")) {
      if (!verify) return "Colony isn't set up for Cloudflare Access. Set COLONY_CF_ACCESS_TEAM_DOMAIN and COLONY_CF_ACCESS_AUD.";
      const token = header("Cf-Access-Jwt-Assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(header("Cookie") ?? "")?.[1];
      return token ? verify(token) : "Sign in through Cloudflare Access to use this Colony.";
    }
    if (header("Tailscale-Funnel-Request")) return "Colony is private to your tailnet. Use `tailscale serve`, not `tailscale funnel`.";
    const login = header("Tailscale-User-Login")?.trim().toLowerCase();
    if (!login || allowed.has(login)) return null;
    if (allowed.size) return `${login} isn't allowed to use this Colony.`;
    const known = owner.login()?.toLowerCase();
    if (!known) { owner.claim(login); return null; }
    return login === known ? null : `${login} isn't allowed to use this Colony. It belongs to ${known}.`;
  };
}

/** Checks a Cloudflare Access token (an RS256 JWT signed by the team's keys): resolves to why it's refused, or null. */
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
  return async (token: string): Promise<string | null> => {
    const refused = "Your Cloudflare Access sign-in isn't valid. Sign in again.";
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
      return emails.has(login) ? null : `${login} isn't allowed to use this Colony.`;
    } catch (error) {
      console.log(`[colony] Couldn't check a Cloudflare Access sign-in: ${error}`);
      return refused;
    }
  };
}
