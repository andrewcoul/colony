import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, File, Folder, Power, RefreshCw, X } from "lucide-react";
import type { Bot } from "@shared/types";
import { api, type FileEntry } from "../lib/api";
import { onComputerOutput } from "../lib/live";
import { cn } from "../lib/utils";
import { BrowserView } from "./BrowserView";
import { SidePanel } from "./SidePanel";
import { Button } from "./ui/button";

const MAX_TERMINAL = 200_000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const clean = (text: string) => text.replace(ANSI, "").replace(/\r(?!\n)/g, "");

const STATE_LABEL = { off: "Off", starting: "Starting…", on: "On", error: "Couldn't start" } as const;

export type ComputerTab = "terminal" | "browser" | "files";

/** The Bot's own computer: a live terminal, its browser, and its /workspace files. */
export function ComputerPanel({ bot, phone, tab, onTab, onClose }: {
  bot: Bot;
  phone: boolean;
  tab: ComputerTab;
  onTab: (tab: ComputerTab) => void;
  onClose: () => void;
}) {
  const setTab = onTab;
  return (
    <SidePanel label={`${bot.name}'s computer`} phone={phone}>
      <div className="flex items-center gap-2.5">
        <span className={cn("size-2 rounded-full", bot.computerState === "on" ? "bg-lilac" : bot.computerState === "error" ? "bg-coral" : "bg-muted")} />
        <strong className="min-w-0 flex-1 truncate text-sm">{bot.name}'s computer</strong>
        <span className="text-meta text-muted">{STATE_LABEL[bot.computerState]}</span>
        {bot.computerState === "on" && (
          <Button size="icon-sm" aria-label="Turn computer off" onClick={() => void api.stopComputer(bot.id)}><Power size={15} /></Button>
        )}
        <Button size="icon-sm" aria-label="Close" onClick={onClose}><X size={16} /></Button>
      </div>
      <div className="flex rounded-full bg-raised p-[3px]" role="tablist">
        {(["terminal", "browser", "files"] as const).map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}
            className={cn("h-7 flex-1 rounded-full text-meta capitalize", tab === name ? "bg-ground text-ink" : "text-muted hover:text-ink")}>
            {name}
          </button>
        ))}
      </div>
      {tab === "terminal" ? <Terminal bot={bot} /> : tab === "browser" ? <BrowserView bot={bot} phone={phone} /> : <Files botId={bot.id} />}
      <span className="truncate text-meta text-muted">Docker · colony-{bot.id.slice(0, 8)} · /workspace persists</span>
    </SidePanel>
  );
}

function Terminal({ bot }: { bot: Bot }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let alive = true;
    void api.terminal(bot.id).then(({ text: log }) => { if (alive) setText(clean(log).slice(-MAX_TERMINAL)); }).catch(() => {});
    const off = onComputerOutput((event) => {
      if (event.botId === bot.id) setText((current) => (current + clean(event.text)).slice(-MAX_TERMINAL));
    });
    return () => { alive = false; off(); };
  }, [bot.id]);

  useLayoutEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-rule bg-[linear-gradient(160deg,#1b1630_0%,#0b0b0f_70%)]">
      <div className="flex h-7 shrink-0 items-center gap-1.5 bg-white/4 px-3">
        <i className="size-2.5 rounded-full bg-coral" /><i className="size-2.5 rounded-full bg-lemon" /><i className="size-2.5 rounded-full bg-mint" />
        <span className="flex-1 text-center font-mono text-[11px] text-muted">{bot.name.toLowerCase()}@colony /workspace</span>
      </div>
      <pre
        ref={box}
        onScroll={(event) => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="m-0 min-h-0 flex-1 overflow-auto px-3.5 py-3 font-mono text-[12px] leading-[19px] whitespace-pre-wrap text-[#d8d8d8] [overflow-wrap:anywhere]"
      >
        {text || <span className="text-muted">Nothing has run yet. Commands {bot.name} runs appear here live.</span>}
      </pre>
    </div>
  );
}

function Files({ botId }: { botId: string }) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");

  const load = (path: string) => {
    setError("");
    setEntries(null);
    api.files(botId, path).then(setEntries).catch((failure) => setError(failure instanceof Error ? failure.message : "Couldn't list files."));
  };
  useEffect(() => { load(dir); }, [botId, dir]);

  if (open) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" aria-label="Back to files" onClick={() => setOpen(null)}><ChevronLeft size={16} /></Button>
          <span className="truncate font-mono text-meta text-soft">{open.path}</span>
        </div>
        <pre className="m-0 min-h-0 flex-1 overflow-auto rounded-xl border border-rule bg-code px-3.5 py-3 font-mono text-[12px] leading-[19px] text-ink">
          {open.content}{open.truncated && "\n… (truncated)"}
        </pre>
      </div>
    );
  }

  const crumbs = dir.split("/").filter(Boolean);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1 text-meta">
        <button type="button" className="font-mono text-soft hover:text-ink" onClick={() => setDir("")}>/workspace</button>
        {crumbs.map((part, index) => (
          <button key={index} type="button" className="font-mono text-soft hover:text-ink" onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}>/{part}</button>
        ))}
        <Button size="icon-sm" className="ml-auto" aria-label="Refresh" onClick={() => load(dir)}><RefreshCw size={14} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-rule">
        {error && <p className="m-0 p-3 text-label text-danger">{error}</p>}
        {!entries && !error && <p className="m-0 p-3 text-label text-muted">Loading…</p>}
        {entries?.length === 0 && <p className="m-0 p-3 text-label text-muted">Empty.</p>}
        {entries?.map((entry) => (
          <button key={entry.path} type="button"
            onClick={() => entry.type === "dir"
              ? setDir(entry.path.replace(/^\/workspace\/?/, ""))
              : void api.file(botId, entry.path).then(setOpen).catch((failure) => setError(failure instanceof Error ? failure.message : "Couldn't open file."))}
            className="flex w-full items-center gap-2.5 border-b border-rule px-3 py-2 text-left text-label last:border-b-0 hover:bg-hover">
            {entry.type === "dir" ? <Folder size={15} className="shrink-0 text-lilac" /> : <File size={15} className="shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.type === "file" && <span className="shrink-0 text-meta text-muted">{entry.size < 1024 ? `${entry.size} B` : `${Math.round(entry.size / 102.4) / 10} KB`}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
