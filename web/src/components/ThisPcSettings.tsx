import { useEffect, useState } from "react";
import { ChevronLeft, FolderOpen, Globe, HardDrive, Monitor, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { desktopApp, type NodeSettings, type NodeView } from "../lib/desktop";
import { useLive } from "../lib/live";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const STATUS: Record<NodeView["status"], [string, string]> = {
  off: ["Not lent to Bots", "bg-muted"],
  connecting: ["Connecting…", "bg-lemon"],
  connected: ["Connected to Colony", "bg-mint"],
  offline: ["Can't reach Colony · retrying", "bg-coral"],
};

function Switch({ icon, title, detail, checked, disabled, onChange, children }: {
  icon: ReactNode; title: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children?: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-2 px-3.5 py-3", disabled && "opacity-50")}>
      <label className="flex items-center gap-3">
        <span className="shrink-0 text-muted">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm">{title}</span>
          <span className="text-meta text-muted">{detail}</span>
        </span>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="size-4 shrink-0 accent-[var(--ink)]" />
      </label>
      {children}
    </div>
  );
}

/** Settings › This PC (only in the desktop app): lend this computer to Bots, and what they may do on it. */
export function ThisPcSettings({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<NodeView | null>(null);
  const nodes = useLive((s) => s.nodes);
  useEffect(() => {
    if (!desktopApp?.node) return;
    void desktopApp.node.get().then(setView);
    return desktopApp.node.onChange(setView);
  }, []);
  if (!desktopApp?.node) return null;
  if (!view) return <p className="text-label text-muted">Loading…</p>;
  const { settings } = view;
  const set = (patch: Partial<NodeSettings>) => void desktopApp!.node!.set(patch).then(setView);
  const lent = settings.enabled;
  const here = nodes.find((node) => node.id === settings.id);
  const [label, dot] = STATUS[view.status];
  const folder = settings.shellFolder ?? view.home;

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="-mt-1 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>
      <p className="m-0 text-label leading-relaxed text-soft">
        Let Bots use this computer, not just their own: your browser logins, your screen, your terminal, your files.
        These switches are enforced here on this PC, and anything a Bot does on it asks you first.
      </p>

      <div className="flex flex-col divide-y divide-rule rounded-xl border border-rule">
        <Switch icon={<Monitor size={16} />} title="Lend this PC to your Bots" detail={lent ? label : "Off. Bots can't see or use this PC."} checked={lent} onChange={(enabled) => set({ enabled })}>
          {lent && (
            <div className="flex items-center gap-2 pl-7">
              <span className={cn("size-2 shrink-0 rounded-full", dot)} />
              <Input aria-label="This PC's name" defaultValue={settings.name} className="h-9 flex-1"
                onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== settings.name) set({ name }); }} />
            </div>
          )}
        </Switch>
      </div>

      <div className={cn("flex flex-col divide-y divide-rule rounded-xl border border-rule", !lent && "pointer-events-none opacity-50")}>
        <Switch icon={<Globe size={16} />} title="Browser windows" detail="Bots open and use their own windows here, signed in where you sign them in. Asks once per task." checked={settings.browser} disabled={!lent} onChange={(browser) => set({ browser })} />
        <Switch icon={<Monitor size={16} />} title="See the screen" detail="A Bot can take a screenshot. Asks every time." checked={settings.screen} disabled={!lent} onChange={(screen) => set({ screen })} />
        <Switch icon={<SquareTerminal size={16} />} title="Terminal" detail="Runs commands in your shell. Asks every time." checked={settings.shell} disabled={!lent} onChange={(shell) => set({ shell })}>
          {settings.shell && (
            <div className="flex items-center gap-2 pl-7 text-meta text-muted">
              <span className="min-w-0 flex-1 truncate font-mono" title={folder}>{folder}</span>
              <Button variant="outline" size="pill" onClick={() => void desktopApp!.node!.pickFolder().then(setView)}><FolderOpen size={14} />Change</Button>
            </div>
          )}
        </Switch>
        <Switch icon={<HardDrive size={16} />} title="Files" detail="Read files in your home folder without asking; writing asks every time." checked={settings.files} disabled={!lent} onChange={(files) => set({ files, ...(files ? {} : { fullDisk: false }) })}>
          {settings.files && (
            <label className="flex items-center gap-2 pl-7 text-meta text-muted">
              <input type="checkbox" checked={settings.fullDisk} onChange={(event) => set({ fullDisk: event.target.checked })} className="size-3.5 accent-[var(--ink)]" />
              Beyond the home folder (the whole disk)
            </label>
          )}
        </Switch>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-label text-muted">Who can use {here?.name ?? settings.name}</span>
        <p className="m-0 text-meta leading-relaxed text-muted">
          Any of your Bots, within the switches above. You approve anything that acts on it: the browser once per task, the screen, terminal and file writes every time.
          While a Bot is using it, a pill shows which Bot it is and lets you stop it.
        </p>
      </div>
    </div>
  );
}
