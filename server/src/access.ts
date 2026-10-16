import type { MiddlewareHandler } from "hono";

/**
 * Colony has no login: your tailnet is the boundary, and Colony is yours alone. This keeps it that way.
 * - Requests that came in through Tailscale Funnel (the public internet) are refused.
 *   tailscaled marks them with `Tailscale-Funnel-Request: ?1` and strips any copy a client sends.
 * - Tailnet requests (Tailscale adds `Tailscale-User-Login` on `tailscale serve` traffic) must come
 *   from you: a login in COLONY_ALLOWED_USERS, or the owner login Colony recorded. With neither set,
 *   the first login seen is recorded as yours.
 * - Requests made directly on this PC carry no identity and stay allowed (the server listens on
 *   127.0.0.1 unless COLONY_HOST says otherwise).
 */
export type Owner = { allowed: string[]; login: () => string | null; claim: (login: string) => void };

export function tailnetOnly(owner: Owner): MiddlewareHandler {
  const check = accessCheck(owner);
  return async (c, next) => {
    const refusal = check((name) => c.req.header(name));
    if (refusal) return c.text(refusal, 403);
    await next();
  };
}

/** The same rules for raw requests (WebSocket upgrades): returns why a request is refused, or null. */
export function accessCheck(owner: Owner) {
  const allowed = new Set(owner.allowed.map((user) => user.trim().toLowerCase()).filter(Boolean));
  return (header: (name: string) => string | undefined) => {
    if (header("Tailscale-Funnel-Request")) return "Colony is private to your tailnet. Use `tailscale serve`, not `tailscale funnel`.";
    const login = header("Tailscale-User-Login")?.trim().toLowerCase();
    if (!login || allowed.has(login)) return null;
    if (allowed.size) return `${login} isn't allowed to use this Colony.`;
    const known = owner.login()?.toLowerCase();
    if (!known) { owner.claim(login); return null; }
    return login === known ? null : `${login} isn't allowed to use this Colony. It belongs to ${known}.`;
  };
}
