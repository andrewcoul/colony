import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { api, type ModelSignInStart, type SignInId } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

const LABELS: Record<SignInId, { start: string; open: string; waiting: string }> = {
  chatgpt: { start: "Sign in with ChatGPT", open: "Open ChatGPT sign-in", waiting: "Waiting for you to finish with OpenAI…" },
  opencode: { start: "Sign in to OpenCode", open: "Open OpenCode", waiting: "Waiting for you to approve in OpenCode…" },
};

/**
 * Signs in to ChatGPT (OpenAI's own page, which hands back to this PC) or OpenCode (a code you
 * approve in its console from any device). Leaving the screen cancels a sign-in in progress.
 */
export function ModelSignIn({ id, onDone }: { id: SignInId; onDone: () => void }) {
  const [started, setStarted] = useState<ModelSignInStart | null>(null);
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labels = LABELS[id];

  useEffect(() => {
    if (!started) return;
    let stopped = false;
    const timer = setInterval(() => {
      void api.modelSignInStatus(started.id).then((next) => {
        if (stopped || next.status === "pending") return;
        clearInterval(timer);
        if (next.status === "done") onDone();
        else { setError(next.error ?? "The sign-in didn't finish."); setStarted(null); }
      }).catch(() => {});
    }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [started, onDone]);
  // Cancels a sign-in left unfinished (and frees ChatGPT's callback port on the PC).
  useEffect(() => () => { if (started) void api.cancelModelSignIn(started.id).catch(() => {}); }, [started]);

  async function start() {
    setBusy(true); setError(""); setPasted("");
    try { setStarted(await api.startModelSignIn(id)); } catch (failure) { setError(message(failure, "Couldn't start the sign-in.")); }
    finally { setBusy(false); }
  }

  async function finish() {
    if (!started) return;
    setBusy(true); setError("");
    try { await api.finishModelSignIn(started.id, pasted.trim()); } catch (failure) { setError(message(failure, "That didn't work.")); }
    finally { setBusy(false); }
  }

  if (started?.kind === "browser") {
    return (
      <div className="flex flex-col">
        <a href={started.url} target="_blank" rel="noreferrer" className="mb-3 inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-on-ink hover:opacity-90">
          {labels.open}<ExternalLink size={14} />
        </a>
        <p className="m-0 mb-2 flex items-center gap-2 text-label text-muted"><Loader2 size={14} className="animate-spin" />{labels.waiting}</p>
        <p className="m-0 mb-2 text-label leading-relaxed text-soft">
          On a phone or another computer, OpenAI ends on a page that won't load (its address starts with <span className="font-mono text-[12px]">http://127.0.0.1:1455</span>). That's expected: copy that page's whole address and paste it here.
        </p>
        <div className="flex gap-1.5">
          <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:1455/auth/callback?code=…" aria-label="Address OpenAI sent you to" autoCapitalize="off" spellCheck={false} className="h-9 font-mono text-[12px]" />
          <Button variant="outline" size="pill" disabled={!pasted.trim() || busy} onClick={() => void finish()}>Finish</Button>
        </div>
        {error && <p role="alert" className="m-0 mt-2 text-label text-danger">{error}</p>}
      </div>
    );
  }

  if (started?.kind === "code") {
    return (
      <div className="flex flex-col">
        <p className="m-0 mb-2 text-label text-soft">Open OpenCode on any device, sign in, pick the workspace with your subscription, and approve this code:</p>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(started.userCode).then(() => setCopied(true)); }}
          className="mb-3 flex items-center justify-center gap-2 rounded-xl border border-rule py-3 font-mono text-xl tracking-widest hover:bg-hover">
          {started.userCode}{copied ? <Check size={16} className="text-mint" /> : <Copy size={16} className="text-muted" />}
        </button>
        <a href={started.verificationUri} target="_blank" rel="noreferrer" className="mb-3 inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-on-ink hover:opacity-90">
          {labels.open}<ExternalLink size={14} />
        </a>
        <p className="m-0 flex items-center gap-2 text-label text-muted"><Loader2 size={14} className="animate-spin" />{labels.waiting}</p>
        {error && <p role="alert" className="m-0 mt-2 text-label text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Button variant="primary" disabled={busy} onClick={() => void start()}>{busy ? <Loader2 size={15} className="animate-spin" /> : null}{labels.start}</Button>
      {error && <p role="alert" className="m-0 mt-2 text-label text-danger">{error}</p>}
    </div>
  );
}
