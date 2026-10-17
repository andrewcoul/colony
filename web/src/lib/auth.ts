/*
 * Web sign-in (through Colony's website): Colony's sign-in service is mounted at /api/auth/*.
 * People on the tailnet or on the Colony PC never see any of this.
 */

/** What the website needs before anyone signs in. `via` "cloudflare": you came through the website. */
export type AuthStatus = { webSignIn: boolean; email: boolean; signedIn: boolean; via: string | null };

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const data = await response.json().catch(() => null) as ({ message?: string; error?: string } & T) | null;
  if (!response.ok) throw new Error(data?.message || data?.error || (response.status === 429 ? "Too many tries. Wait a minute, then try again." : `That didn't work (${response.status}).`));
  return data as T;
}

export const auth = {
  status: async (): Promise<AuthStatus> => {
    const response = await fetch("/api/auth-status");
    return response.ok ? response.json() : { webSignIn: false, email: false, signedIn: false, via: null };
  },
  /** Whether an invite link works, and for which email. */
  checkInvite: async (token: string): Promise<{ valid: true; email: string } | { valid: false; error: string }> => {
    const response = await fetch(`/api/invites/check?invite=${encodeURIComponent(token)}`);
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
