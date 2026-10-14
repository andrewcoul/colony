import type { MiddlewareHandler } from "hono";

/**
 * Colony has no login: your tailnet is the boundary. This keeps it that way.
 * - Requests that came in through Tailscale Funnel (the public internet) are refused.
 *   tailscaled marks them with `Tailscale-Funnel-Request: ?1` and strips any copy a client sends.
 * - With COLONY_ALLOWED_USERS set, tailnet requests must come from one of those logins
 *   (Tailscale adds `Tailscale-User-Login` on `tailscale serve` traffic). Requests made
 *   directly on this PC carry no identity and stay allowed.
 */
export function tailnetOnly(allowedUsers: string[]): MiddlewareHandler {
  const check = accessCheck(allowedUsers);
  return async (c, next) => {
    const refusal = check((name) => c.req.header(name));
    if (refusal) return c.text(refusal, 403);
    await next();
  };
}

/** The same rules for raw requests (WebSocket upgrades): returns why a request is refused, or null. */
export function accessCheck(allowedUsers: string[]) {
  const allowed = new Set(allowedUsers.map((user) => user.trim().toLowerCase()).filter(Boolean));
  return (header: (name: string) => string | undefined) => {
    if (header("Tailscale-Funnel-Request")) return "Colony is private to your tailnet. Use `tailscale serve`, not `tailscale funnel`.";
    const login = header("Tailscale-User-Login")?.toLowerCase();
    if (allowed.size && login && !allowed.has(login)) return `${login} isn't allowed to use this Colony.`;
    return null;
  };
}
