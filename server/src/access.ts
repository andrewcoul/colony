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
  const allowed = new Set(allowedUsers.map((user) => user.trim().toLowerCase()).filter(Boolean));
  return async (c, next) => {
    if (c.req.header("Tailscale-Funnel-Request")) {
      return c.text("Colony is private to your tailnet. Use `tailscale serve`, not `tailscale funnel`.", 403);
    }
    const login = c.req.header("Tailscale-User-Login")?.toLowerCase();
    if (allowed.size && login && !allowed.has(login)) {
      return c.text(`${login} isn't allowed to use this Colony.`, 403);
    }
    await next();
  };
}
