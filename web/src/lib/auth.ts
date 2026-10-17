/*
 * Web sign-in (through Colony's website): Colony's sign-in service is mounted at /api/auth/*.
 * People on the tailnet or on the Colony PC never see any of this.
 */

/** What the website needs before anyone signs in. `via` "cloudflare": you came through the website. */
export type AuthStatus = { webSignIn: boolean; email: boolean; signedIn: boolean; via: string | null };

export const UNREACHABLE = "Couldn't reach Colony. Check your connection, then try again.";

/** Better Auth's failures are `{ message, code }`; Colony's own are `{ error }`. */
function failureText(data: unknown, status: number) {
  const body = (data && typeof data === "object" ? data : {}) as { message?: unknown; error?: unknown; code?: unknown };
  const text = [body.message, body.error].find((item): item is string => typeof item === "string" && item.trim() !== "");
  if (text) return text;
  if (typeof body.code === "string" && body.code) return `That didn't work (${body.code.toLowerCase().replaceAll("_", " ")}).`;
  return status === 429 ? "Too many tries. Wait a minute, then try again." : `That didn't work (${status}).`;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  } catch { throw new Error(UNREACHABLE); }
  const data = await response.json().catch(() => null) as T | null;
  if (!response.ok) throw new Error(failureText(data, response.status));
  // Every sign-in route answers JSON: anything else (a proxy's HTML page, say) didn't reach it.
  if (data === null) throw new Error(`Colony sent back something unexpected (${response.status}). Try again.`);
  return data;
}

export const auth = {
  status: async (): Promise<AuthStatus> => {
    const response = await fetch("/api/auth-status");
    return response.ok ? response.json() : { webSignIn: false, email: false, signedIn: false, via: null };
  },
  /** Whether an invite link works, and for which email. */
  checkInvite: async (token: string): Promise<{ valid: true; email: string } | { valid: false; error: string }> => {
    const response = await fetch(`/api/invites/check?invite=${encodeURIComponent(token)}`).catch(() => null);
    if (!response) return { valid: false, error: UNREACHABLE };
    const data = await response.json().catch(() => null);
    return data ?? { valid: false, error: "Couldn't check this invite." };
  },
  signIn: (email: string, password: string) => post("/sign-in/email", { email, password }),
  /** Sign-up is invite-only: the server checks the invite, and that it's for this email. */
  signUp: (email: string, password: string, invite: string) => post("/sign-up/email", { email, password, name: email.split("@")[0], invite }),
  signOut: () => post("/sign-out", {}),
  requestReset: (email: string) => post("/request-password-reset", { email, redirectTo: `${location.origin}/reset` }),
  resetPassword: (token: string, newPassword: string) => post("/reset-password", { token, newPassword }),
  sendCode: (email: string) => post("/email-otp/send-verification-otp", { email, type: "sign-in" }),
  signInWithCode: (email: string, otp: string) => post("/sign-in/email-otp", { email, otp }),
};
