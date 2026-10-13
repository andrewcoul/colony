import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { cn } from "../lib/utils";
import { LogoMark } from "./Logo";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

type Flow = "signIn" | "signUp";

/** Full-screen gate shown while signed out. */
export function SignInScreen() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <main className="flex h-dvh items-center justify-center overflow-y-auto bg-ground p-4">
      <form
        className="flex w-[400px] max-w-full flex-col gap-5 rounded-[20px] border border-rule bg-surface p-7"
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true); setError("");
          try { await signIn("password", new FormData(event.currentTarget)); }
          catch {
            setError(flow === "signIn"
              ? "Couldn't sign in. Check your email and password."
              : "Couldn't create the account. Check the workspace code, or sign in if you already have an account.");
          } finally { setPending(false); }
        }}
      >
        <div className="flex flex-col items-center gap-3.5 pt-2 pb-1 text-center">
          <LogoMark size={36} strokeWidth={1.6} />
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">{flow === "signIn" ? "Sign in to Colony" : "Create your account"}</h1>
          <p className="m-0 text-label text-muted">Your private, self-hosted Grok-style assistant.</p>
        </div>

        <div role="tablist" aria-label="Account" className="flex rounded-full bg-raised p-[3px]">
          {(["signIn", "signUp"] as const).map((option) => (
            <button
              key={option} type="button" role="tab" aria-selected={flow === option}
              onClick={() => { setFlow(option); setError(""); }}
              className={cn("h-8 flex-1 rounded-full text-label", flow === option ? "bg-ground font-medium text-ink" : "text-muted hover:text-ink")}
            >{option === "signIn" ? "Sign in" : "Create account"}</button>
          ))}
        </div>

        <div>
          <input type="hidden" name="flow" value={flow} />
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" name="password" type="password" minLength={8} required
              autoComplete={flow === "signUp" ? "new-password" : "current-password"} placeholder="At least 8 characters" />
          </Field>
          {flow === "signUp" && (
            <Field label="Workspace code" htmlFor="workspace-code">
              <Input id="workspace-code" name="workspaceCode" type="password" autoComplete="off" required placeholder="From .colony-setup.local" />
            </Field>
          )}
          {error && <p role="alert" className="m-0 mb-1 text-label leading-normal text-danger">{error}</p>}
        </div>

        <div className="flex flex-col gap-3">
          <Button type="submit" variant="primary" disabled={pending} className="w-full">{pending ? "One moment…" : "Continue"}</Button>
          <p className="m-0 text-center text-meta text-muted">Password reset isn't available yet — use a password manager.</p>
        </div>
      </form>
    </main>
  );
}
