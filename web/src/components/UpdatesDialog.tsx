import { useState } from "react";
import { Download, Loader2, Monitor, RefreshCw, Server } from "lucide-react";
import { desktopApp, type DesktopUpdate } from "../lib/desktop";
import { checkNow, updateServer, useUpdates, WEB_VERSION } from "../lib/updates";
import type { SystemInfo } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

const RELEASES = "https://github.com/andrewcoul/colony/releases/latest";

const ago = (time: number) => {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(time).toLocaleDateString();
};

function Progress({ value }: { value: number | null }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-raised">
      <div className={value === null ? "h-full w-1/3 animate-pulse rounded-full bg-ink/60" : "h-full rounded-full bg-ink transition-[width]"}
        style={value === null ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

function Card({ icon, title, version, children }: { icon: React.ReactNode; title: string; version: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-rule p-4">
      <div className="flex items-center gap-2.5">
        <span className="text-muted">{icon}</span>
        <strong className="flex-1 text-sm font-medium">{title}</strong>
        <span className="font-mono text-meta text-muted">{version}</span>
      </div>
      {children}
    </section>
  );
}

function ServerStatus({ system, waitingFor }: { system: SystemInfo; waitingFor: string | null }) {
  const [busy, setBusy] = useState<{ message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const { update, latest } = system;

  async function start(force: boolean) {
    setStarting(true); setBusy(null);
    const result = await updateServer(force);
    setStarting(false);
    if (result) setBusy(result);
  }

  if (waitingFor) {
    const label = update.status === "downloading" ? `Downloading ${waitingFor}${update.progress !== null ? ` · ${Math.round(update.progress * 100)}%` : ""}`
      : update.status === "installing" ? `Installing ${waitingFor}` : `Restarting into ${waitingFor}`;
    return (
      <div className="flex flex-col gap-2">
        <span className="text-label text-soft">{label}…</span>
        <Progress value={update.status === "downloading" ? update.progress : null} />
        <span className="text-meta text-muted">Colony reloads by itself when it's back, usually within a minute.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {system.failed && (
        <p role="alert" className="m-0 text-label text-danger">
          Version {system.failed.version} didn't start, so Colony went back to {system.version}. {system.failed.reason}
        </p>
      )}
      {system.available && latest ? (
        <>
          <span className="text-label text-soft">Version {latest.version} is out.</span>
          {latest.notes.trim() && (
            <details className="text-meta text-muted">
              <summary className="cursor-pointer select-none">What's new</summary>
              <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-ground p-3 [scrollbar-width:thin]">{latest.notes.trim()}</div>
            </details>
          )}
          {system.managed ? (
            busy ? (
              <div className="flex flex-col gap-2 rounded-lg border border-lemon/30 bg-lemon/8 p-3">
                <span className="text-label text-soft">{busy.message}</span>
                <div className="flex gap-2">
                  <Button variant="primary" size="pill" disabled={starting} onClick={() => void start(true)}>Update anyway</Button>
                  <Button variant="ghost" size="pill" onClick={() => setBusy(null)}>Not now</Button>
                </div>
              </div>
            ) : (
              <Button variant="primary" disabled={starting} onClick={() => void start(false)}>
                {starting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}Update server
              </Button>
            )
          ) : (
            <span className="text-meta leading-relaxed text-muted">
              This Colony runs from source, so update it there: <span className="font-mono">git pull</span>, <span className="font-mono">npm ci</span>, <span className="font-mono">npm run build</span>, then restart it. Installed servers update with one tap.
            </span>
          )}
        </>
      ) : (
        <span className="text-label text-soft">{latest ? "Up to date." : "No releases yet."}</span>
      )}
      {update.status === "failed" && update.error && <p role="alert" className="m-0 text-label text-danger">{update.error}</p>}
      {system.updated && !system.failed && (
        <span className="text-meta text-muted">Updated{system.updated.from ? ` from ${system.updated.from}` : ""} {ago(Date.parse(system.updated.at))}.</span>
      )}
    </div>
  );
}

const desktopText = (state: DesktopUpdate | null) => {
  switch (state?.status) {
    case "unsupported": return "Running from source; it doesn't update itself.";
    case "checking": return "Checking for updates…";
    case "downloading": return `Downloading ${state.version ?? "the update"}${state.progress !== null ? ` · ${Math.round(state.progress * 100)}%` : ""}…`;
    case "ready": return `Version ${state.version} is ready.`;
    case "error": return `Couldn't check for updates: ${state.error}`;
    case "current": return "Up to date.";
    default: return "Checks for updates every hour.";
  }
};

/** Versions of the server and this desktop app, and updating them. */
export function UpdatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const updates = useUpdates();
  const { system, desktop, waitingFor, error } = updates;
  const [checking, setChecking] = useState(false);
  const stale = system && system.version !== WEB_VERSION && !waitingFor;
  const phone = /Android|iPhone|iPad/i.test(navigator.userAgent);

  async function check() {
    setChecking(true);
    await checkNow();
    setChecking(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Updates">
      <div className="mt-2 flex flex-col gap-3">
        {stale && (
          <div className="flex items-center gap-3 rounded-xl border border-lemon/30 bg-lemon/8 p-3.5">
            <span className="flex-1 text-label text-soft">Colony was updated to {system.version}. Reload to use it.</span>
            <Button variant="primary" size="pill" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        )}

        <Card icon={<Server size={16} />} title="Colony server" version={system?.version ?? WEB_VERSION}>
          {system ? <ServerStatus system={system} waitingFor={waitingFor} /> : <span className="text-label text-muted">This server can't report updates.</span>}
        </Card>

        {desktopApp ? (
          <Card icon={<Monitor size={16} />} title="Colony for desktop" version={desktopApp.version}>
            <span className={desktop?.status === "error" ? "text-label text-danger" : "text-label text-soft"}>{desktopText(desktop)}</span>
            {desktop?.status === "downloading" && <Progress value={desktop.progress} />}
            <div className="flex gap-2">
              {desktop?.status === "ready" && (
                <Button variant="primary" size="pill" onClick={() => void desktopApp!.installUpdate()}><RefreshCw size={14} />Restart to update</Button>
              )}
              <Button variant="outline" size="pill" onClick={() => void desktopApp!.changeServer()}>Change server</Button>
            </div>
          </Card>
        ) : !phone && (
          <p className="m-0 text-meta leading-relaxed text-muted">
            Prefer a window of its own? <a href={RELEASES} target="_blank" rel="noreferrer" className="text-soft underline underline-offset-2">Get Colony for Windows</a>. It updates itself.
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-meta text-muted">{system?.checkedAt ? `Checked ${ago(system.checkedAt)}` : ""}</span>
          <Button variant="outline" size="pill" disabled={checking || Boolean(waitingFor)} onClick={() => void check()}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Check for updates
          </Button>
        </div>
        {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
