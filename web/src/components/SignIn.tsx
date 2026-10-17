import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { WifiOff } from "lucide-react";
import { auth, type AuthStatus } from "../lib/auth";
import { LogoMark } from "./Logo";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

/*
 * Signing in through Colony's website (the tailnet and the Colony PC never see these): email and
 * password; "forgot password" and "email me a code" only when Colony can send email. Sign-up is only
 * from an invite link, for the invited email.
 */

const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);
const home = () => { location.href = "/"; };

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <LogoMark size={44} mood="alive" />
          <h1 className="m-0 text-xl font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function useStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  useEffect(() => { void auth.status().then(setStatus); }, []);
  return status;
}

/** Sign in: password, or a code by email. */
export function SignInPage() {
  const status = useStatus();
  const [mode, setMode] = useState<"password" | "code" | "forgot">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (task: () => Promise<unknown>, fallback: string, after?: () => void) => async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true); setError(""); setNote("");
    try { await task(); after?.(); } catch (failure) { setError(message(failure, fallback)); } finally { setBusy(false); }
  };
  if (status && !status.webSignIn) {
    return <Frame title="Colony"><p className="m-0 text-center text-label text-muted">Signing in on the web isn't set up on this Colony yet. Ask the person who runs it.</p></Frame>;
  }
  return (
    <Frame title={mode === "forgot" ? "Reset your password" : "Sign in to Colony"}>
      {mode === "password" && (
        <form onSubmit={run(() => auth.signIn(email.trim(), password), "Couldn't sign in.", home)}>
          <Field label="Email" htmlFor="signin-email"><Input id="signin-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password" htmlFor="signin-password"><Input id="signin-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button variant="primary" className="mt-1 w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
        </form>
      )}
      {mode === "code" && (
        <form onSubmit={codeSent ? run(() => auth.signInWithCode(email.trim(), code.trim()), "That code didn't work.", home) : run(() => auth.sendCode(email.trim()), "Couldn't send a code.", () => { setCodeSent(true); setNote("If that email has an account, a code is on its way."); })}>
          <Field label="Email" htmlFor="code-email"><Input id="code-email" type="email" autoComplete="username" required value={email} disabled={codeSent} onChange={(e) => setEmail(e.target.value)} /></Field>
          {codeSent && <Field label="Code from the email" htmlFor="code-otp"><Input id="code-otp" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>}
          <Button variant="primary" className="mt-1 w-full" disabled={busy}>{codeSent ? "Sign in" : "Email me a code"}</Button>
        </form>
      )}
      {mode === "forgot" && (
        <form onSubmit={run(() => auth.requestReset(email.trim()), "Couldn't send the email.", () => setNote("If that email has an account, a link to reset its password is on its way."))}>
          <Field label="Email" htmlFor="forgot-email"><Input id="forgot-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button variant="primary" className="mt-1 w-full" disabled={busy}>Email me a link</Button>
        </form>
      )}
      {note && <p className="m-0 mt-3 text-center text-label text-muted">{note}</p>}
      {error && <p role="alert" className="m-0 mt-3 text-center text-label text-danger">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-label text-muted">
        {mode !== "password" && <button type="button" className="hover:text-ink" onClick={() => { setMode("password"); setError(""); setNote(""); }}>Sign in with a password</button>}
        {status?.email && mode !== "code" && <button type="button" className="hover:text-ink" onClick={() => { setMode("code"); setCodeSent(false); setError(""); setNote(""); }}>Email me a code</button>}
        {status?.email && mode !== "forgot" && <button type="button" className="hover:text-ink" onClick={() => { setMode("forgot"); setError(""); setNote(""); }}>Forgot your password?</button>}
      </div>
      <p className="m-0 mt-6 text-center text-meta text-muted">Colony is invite-only. New here? Use the link in your invite email.</p>
    </Frame>
  );
}

/** Sign up from an invite link: the invited email, locked, and a new password. */
export function SignUpPage({ invite }: { invite: string }) {
  const [checked, setChecked] = useState<{ valid: true; email: string } | { valid: false; error: string } | null>(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void auth.checkInvite(invite).then(setChecked); }, [invite]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!checked?.valid) return;
    if (password !== again) { setError("Those passwords don't match."); return; }
    setBusy(true); setError("");
    try { await auth.signUp(checked.email, password, invite); home(); } catch (failure) { setError(message(failure, "Couldn't create your account.")); } finally { setBusy(false); }
  }
  return (
    <Frame title="Join Colony">
      {!checked ? <p className="m-0 text-center text-label text-muted">Checking your invite…</p> : !checked.valid ? (
        <>
          <p role="alert" className="m-0 text-center text-label text-danger">{checked.error}</p>
          <Button variant="outline" className="mt-5 w-full" onClick={home}>Sign in instead</Button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <Field label="Email" htmlFor="signup-email"><Input id="signup-email" type="email" value={checked.email} readOnly disabled /></Field>
          <Field label="Choose a password" htmlFor="signup-password"><Input id="signup-password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Once more" htmlFor="signup-again"><Input id="signup-again" type="password" autoComplete="new-password" minLength={10} required value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
          <span className="mb-3 block text-meta text-muted">At least 10 characters.</span>
          {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
          <Button variant="primary" className="w-full" disabled={busy}>{busy ? "Creating your account…" : "Create my account"}</Button>
        </form>
      )}
    </Frame>
  );
}

/** A new password, from the link in a reset email. */
export function ResetPage({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try { await auth.resetPassword(token, password); setDone(true); } catch (failure) { setError(message(failure, "Couldn't reset it. Ask for a new link.")); }
  }
  return (
    <Frame title="Choose a new password">
      {done ? <Button variant="primary" className="w-full" onClick={home}>Sign in</Button> : (
        <form onSubmit={(event) => void submit(event)}>
          <Field label="New password" htmlFor="reset-password"><Input id="reset-password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
          <Button variant="primary" className="w-full">Save it</Button>
        </form>
      )}
    </Frame>
  );
}

/** The website can't reach the PC: Colony comes back by itself when it can. */
export function OfflineScreen() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <WifiOff size={28} className="text-muted" />
      <h1 className="m-0 text-lg font-semibold">Colony is offline</h1>
      <p className="m-0 max-w-sm text-label leading-relaxed text-muted">Your PC isn't reachable right now. Your Bots and chats are safe on it; Colony reconnects by itself once it's back.</p>
      <Button variant="outline" size="pill" onClick={() => location.reload()}>Try again</Button>
    </main>
  );
}

/** Signs out of the website (only shown there). */
export async function signOut() {
  await auth.signOut().catch(() => {});
  location.href = "/";
}
