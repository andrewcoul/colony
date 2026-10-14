import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, KeyRound, Loader2, Mail, Plus, Trash2 } from "lucide-react";
import type { Account, AccountKind } from "@shared/types";
import { api, type AccountsView, type SignInStatus } from "../lib/api";
import { useLive } from "../lib/live";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

export const KIND_NAMES: Record<AccountKind, string> = { google: "Gmail", microsoft: "Outlook", onepassword: "1Password" };

export function AccountIcon({ kind, className }: { kind: AccountKind; className?: string }) {
  return kind === "onepassword" ? <KeyRound size={16} className={className} /> : <Mail size={16} className={className} />;
}

/** The connected accounts, on the main Settings screen. */
export function AccountsList({ onConnect }: { onConnect: (kind: AccountKind | null) => void }) {
  const accounts = useLive((s) => s.accounts);
  const [error, setError] = useState("");

  async function remove(account: Account) {
    if (!confirm(`Disconnect ${account.label} (${account.email})? Bots lose access to it, and routines watching it are deleted.`)) return;
    setError("");
    try { await api.removeAccount(account.id); } catch (failure) { setError(message(failure, "Couldn't disconnect it.")); }
  }

  return (
    <>
      <span className="mt-6 mb-1.5 text-label text-muted">Accounts</span>
      <div className="mb-3 flex flex-col gap-2">
        {accounts.length === 0 && (
          <p className="m-0 rounded-xl border border-dashed border-rule p-4 text-label text-muted">
            Connect Gmail, Outlook or 1Password, then choose in each Bot's profile what it may do with them.
          </p>
        )}
        {accounts.map((account) => (
          <div key={account.id} className="flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3">
            <AccountIcon kind={account.kind} className="shrink-0 text-muted" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="truncate text-sm font-medium">{account.label}</strong>
              <span className="truncate text-meta text-muted">
                {account.email}
                {account.status === "needs_reauth" && <span className="text-coral"> · needs reconnecting</span>}
              </span>
            </span>
            {account.status === "needs_reauth" && <Button variant="outline" size="pill" onClick={() => onConnect(account.kind)}>Reconnect</Button>}
            <Button size="icon-sm" aria-label={`Disconnect ${account.label} ${account.email}`} onClick={() => void remove(account)}><Trash2 size={15} /></Button>
          </div>
        ))}
      </div>
      <Button variant="outline" onClick={() => onConnect(null)}><Plus size={15} />Connect account</Button>
      <p className="m-0 mt-3 text-meta leading-relaxed text-muted">Sign-ins stay on this PC. Bots never see a password; sending mail, inviting people and using a login for the first time always ask you.</p>
      {error && <p role="alert" className="m-0 mt-3 text-label text-danger">{error}</p>}
    </>
  );
}

/** Step-by-step connecting of one account. */
export function ConnectAccount({ kind: initial, onBack }: { kind: AccountKind | null; onBack: () => void }) {
  const [kind, setKind] = useState<AccountKind | null>(initial);
  const [view, setView] = useState<AccountsView | null>(null);

  useEffect(() => { void api.accounts().then(setView).catch(() => setView(null)); }, []);

  return (
    <div className="flex flex-col">
      <button type="button" onClick={kind && !initial ? () => setKind(null) : onBack} className="mb-4 flex items-center gap-1 self-start text-label text-muted hover:text-ink">
        <ChevronLeft size={15} />{kind && !initial ? "Pick another" : "Settings"}
      </button>
      {!kind && (
        <div className="flex flex-col gap-2">
          {([
            ["google", "Gmail", "Mail and Google Calendar"],
            ["microsoft", "Outlook", "Outlook.com or Microsoft 365 mail and calendar"],
            ["onepassword", "1Password", "Sign Bots in to websites without showing them passwords"],
          ] as const).map(([value, name, hint]) => (
            <button key={value} type="button" onClick={() => setKind(value)}
              className="flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3 text-left hover:bg-hover">
              <AccountIcon kind={value} className="shrink-0 text-muted" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5"><strong className="text-sm font-medium">{name}</strong><span className="text-meta text-muted">{hint}</span></span>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </button>
          ))}
        </div>
      )}
      {kind === "google" && <ConnectGoogle saved={view?.apps.google?.clientId ?? null} onDone={onBack} />}
      {kind === "microsoft" && <ConnectMicrosoft saved={view?.apps.microsoft?.clientId ?? null} onDone={onBack} />}
      {kind === "onepassword" && <ConnectOnePassword onDone={onBack} />}
    </div>
  );
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="m-0 mb-4 flex list-decimal flex-col gap-1.5 pl-5 text-label leading-relaxed text-soft marker:text-muted">{children}</ol>;
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink underline decoration-rule underline-offset-2 hover:decoration-ink">{children}<ExternalLink size={11} /></a>;
}

/** Polls a sign-in until it finishes; leaving the screen cancels it. */
function useSignIn() {
  const [id, setId] = useState<string | null>(null);
  const [status, setStatus] = useState<SignInStatus | null>(null);
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    const timer = setInterval(() => {
      void api.signInStatus(id).then((next) => {
        if (stopped) return;
        setStatus(next);
        if (next.status !== "pending") clearInterval(timer);
      }).catch(() => {});
    }, 2000);
    return () => { stopped = true; clearInterval(timer); void api.cancelSignIn(id).catch(() => {}); };
  }, [id]);
  return { id, status, setStatus, start: (next: string) => { setStatus({ status: "pending" }); setId(next); } };
}

function Connected({ account, onDone }: { account?: { label: string; email: string }; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 flex items-center gap-2 text-sm text-mint"><Check size={16} />{account ? `${account.label} ${account.email} is connected.` : "Connected."}</p>
      <p className="m-0 text-label text-muted">Now open a Bot's profile and choose what it may do with it, under Access.</p>
      <Button variant="primary" onClick={onDone}>Done</Button>
    </div>
  );
}

function ConnectGoogle({ saved, onDone }: { saved: string | null; onDone: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signIn = useSignIn();

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const started = await api.startGoogle(clientId.trim() ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined } : {});
      setUrl(started.url);
      signIn.start(started.id);
    } catch (failure) { setError(message(failure, "Couldn't start the sign-in.")); }
    finally { setBusy(false); }
  }

  async function finish() {
    if (!signIn.id) return;
    setBusy(true); setError("");
    try { signIn.setStatus(await api.finishGoogle(signIn.id, pasted)); } catch (failure) { setError(message(failure, "That didn't work.")); }
    finally { setBusy(false); }
  }

  if (signIn.status?.status === "done") return <Connected account={signIn.status.account} onDone={onDone} />;

  if (url && signIn.status?.status === "pending") {
    return (
      <div className="flex flex-col">
        <a href={url} target="_blank" rel="noreferrer" className="mb-4 inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-on-ink hover:opacity-90">
          Open Google sign-in<ExternalLink size={14} />
        </a>
        <p className="m-0 mb-2 flex items-center gap-2 text-label text-muted"><Loader2 size={14} className="animate-spin" />Waiting for you to finish in Google…</p>
        <p className="m-0 mb-3 text-label leading-relaxed text-soft">
          On a phone or another computer, Google ends on a page that won't load (its address starts with <span className="font-mono text-[12px]">http://127.0.0.1</span>). That's expected: copy that page's whole address and paste it here.
        </p>
        <div className="flex gap-1.5">
          <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:…/?state=…&code=…" aria-label="Address Google sent you to" autoCapitalize="off" spellCheck={false} className="h-9 font-mono text-[12px]" />
          <Button variant="outline" size="pill" disabled={!pasted.trim() || busy} onClick={() => void finish()}>Finish</Button>
        </div>
        {error && <p role="alert" className="m-0 mt-3 text-label text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={start} className="flex flex-col">
      <h3 className="m-0 mb-2 text-sm font-semibold">Connect Gmail</h3>
      <p className="m-0 mb-3 text-label leading-relaxed text-muted">Google requires your own sign-in app for Gmail. It takes about five minutes, once.</p>
      <Steps>
        <li>In <Link href="https://console.cloud.google.com/projectcreate">Google Cloud</Link>, create a project, then enable the <Link href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Gmail API</Link> and the <Link href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Calendar API</Link>.</li>
        <li>Set up the <Link href="https://console.cloud.google.com/auth/overview">consent screen</Link> as External, then under Audience press <strong>Publish app</strong>. Left in Testing, Google signs Colony out every 7 days.</li>
        <li>Under <Link href="https://console.cloud.google.com/auth/clients">Clients</Link>, create a client of type <strong>Desktop app</strong> and paste its ID and secret here.</li>
        <li>When Google warns the app isn't verified, choose Advanced → Go to (your app). It's yours, so that's fine.</li>
      </Steps>
      <Field label="Client ID" htmlFor="google-client"><Input id="google-client" value={clientId} onChange={(e) => setClientId(e.target.value)} autoCapitalize="off" spellCheck={false} placeholder={saved ? `Saved: ${saved.slice(0, 24)}… · leave blank to reuse` : "…apps.googleusercontent.com"} /></Field>
      <Field label="Client secret" htmlFor="google-secret"><Input id="google-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} placeholder={saved ? "Leave blank to reuse the saved one" : "GOCSPX-…"} /></Field>
      {signIn.status?.status === "error" && <p role="alert" className="m-0 mb-3 text-label text-danger">{signIn.status.error}</p>}
      {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy || (!saved && (!clientId.trim() || !clientSecret.trim()))}>{busy ? <Loader2 size={15} className="animate-spin" /> : null}Continue to Google</Button>
    </form>
  );
}

function ConnectMicrosoft({ saved, onDone }: { saved: string | null; onDone: () => void }) {
  const [clientId, setClientId] = useState("");
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signIn = useSignIn();

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const started = await api.startMicrosoft(clientId.trim() ? { clientId: clientId.trim() } : {});
      setCode(started);
      signIn.start(started.id);
    } catch (failure) { setError(message(failure, "Couldn't start the sign-in.")); }
    finally { setBusy(false); }
  }

  if (signIn.status?.status === "done") return <Connected account={signIn.status.account} onDone={onDone} />;

  if (code && signIn.status?.status === "pending") {
    return (
      <div className="flex flex-col items-start">
        <p className="m-0 mb-3 text-label text-soft">Open <Link href={code.verificationUri}>{code.verificationUri.replace(/^https?:\/\//, "")}</Link> on any device, sign in, and enter this code:</p>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(code.userCode).then(() => setCopied(true)); }}
          className="mb-4 flex items-center gap-3 rounded-xl border border-rule px-4 py-3 font-mono text-2xl tracking-[0.2em] hover:bg-hover" aria-label="Copy code">
          {code.userCode}{copied ? <Check size={16} className="text-mint" /> : <Copy size={16} className="text-muted" />}
        </button>
        <p className="m-0 flex items-center gap-2 text-label text-muted"><Loader2 size={14} className="animate-spin" />Waiting for Microsoft…</p>
      </div>
    );
  }

  return (
    <form onSubmit={start} className="flex flex-col">
      <h3 className="m-0 mb-2 text-sm font-semibold">Connect Outlook</h3>
      <p className="m-0 mb-3 text-label leading-relaxed text-muted">Microsoft needs a sign-in app registered once (about five minutes).</p>
      <Steps>
        <li>In <Link href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">App registrations</Link>, choose New registration. For account types pick <strong>any organizational directory and personal Microsoft accounts</strong>. Leave the redirect URI empty.</li>
        <li>Under Authentication, turn on <strong>Allow public client flows</strong> and save.</li>
        <li>Copy the <strong>Application (client) ID</strong> from Overview and paste it here.</li>
      </Steps>
      <Field label="Application (client) ID" htmlFor="ms-client"><Input id="ms-client" value={clientId} onChange={(e) => setClientId(e.target.value)} autoCapitalize="off" spellCheck={false} placeholder={saved ? `Saved: ${saved} · leave blank to reuse` : "00000000-0000-0000-0000-000000000000"} /></Field>
      <p className="m-0 mb-3 text-meta text-muted">Work accounts: if your organisation blocks new apps, an admin has to approve it first.</p>
      {signIn.status?.status === "error" && <p role="alert" className="m-0 mb-3 text-label text-danger">{signIn.status.error}</p>}
      {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy || (!saved && !clientId.trim())}>{busy ? <Loader2 size={15} className="animate-spin" /> : null}Get a sign-in code</Button>
    </form>
  );
}

function ConnectOnePassword({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"token" | "desktop">("token");
  const [token, setToken] = useState("");
  const [desktopAccount, setDesktopAccount] = useState("");
  const [connected, setConnected] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { setConnected(await api.connectOnePassword(mode === "token" ? { token: token.trim() } : { desktopAccount: desktopAccount.trim() })); }
    catch (failure) { setError(message(failure, "Couldn't connect.")); }
    finally { setBusy(false); }
  }

  if (connected) return <Connected account={{ label: "1Password", email: `(${connected.email})` }} onDone={onDone} />;

  return (
    <form onSubmit={connect} className="flex flex-col">
      <h3 className="m-0 mb-2 text-sm font-semibold">Connect 1Password</h3>
      <div className="mb-3 flex rounded-full bg-raised p-[3px]" role="radiogroup" aria-label="How to connect">
        {([["token", "Service account"], ["desktop", "1Password app on this PC"]] as const).map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => setMode(value)}
            className={cn("h-8 flex-1 rounded-full text-meta", mode === value ? "bg-ground text-ink" : "text-muted hover:text-ink")}>{label}</button>
        ))}
      </div>
      {mode === "token" ? (
        <>
          <Steps>
            <li>Make a vault just for your Bots (e.g. “Colony”) and put in it only the logins they may use.</li>
            <li>Create a <Link href="https://developer.1password.com/docs/service-accounts/get-started/">service account</Link> with read access to that vault (add write access to let Bots save new logins).</li>
            <li>Paste its token here. Service accounts can't see your private vaults.</li>
          </Steps>
          <Field label="Service account token" htmlFor="op-token"><Input id="op-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="ops_…" /></Field>
        </>
      ) : (
        <>
          <Steps>
            <li>In the 1Password app on this PC, open Settings → Developer and turn on <strong>Integrate with other apps</strong>.</li>
            <li>Type your account's name as it appears at the top of 1Password's sidebar.</li>
            <li>1Password asks you to approve Colony, and Bots can only use it while 1Password is unlocked, so routines that run while you're away may not be able to sign in.</li>
          </Steps>
          <Field label="1Password account name" htmlFor="op-account"><Input id="op-account" value={desktopAccount} onChange={(e) => setDesktopAccount(e.target.value)} placeholder="My Family" /></Field>
        </>
      )}
      {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy || (mode === "token" ? !token.trim() : !desktopAccount.trim())}>{busy ? <Loader2 size={15} className="animate-spin" /> : null}Connect</Button>
    </form>
  );
}
