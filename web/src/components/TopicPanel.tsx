import { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ChevronDown, Download, FileText, History, Maximize2, Trash2, Upload, X } from "lucide-react";
import type { ArtifactVersion, Bot, Chat, ChatFile } from "@shared/types";
import { api, fileUrl } from "../lib/api";
import { shortTime } from "../lib/dates";
import { changesOnly, diffLines } from "../lib/diff";
import { loadArtifact, loadFiles, useLive, useMyId } from "../lib/live";
import { fade, snappy, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { DocBody, VersionNumber } from "./DocView";
import { Routines } from "./RoutinesPanel";
import { SidePanel } from "./SidePanel";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type TopicTab = "doc" | "files" | "schedule";

/** A topic's side panel: its Doc, its Files, and what's scheduled in it. */
export function TopicPanel({ chat, bots, tab, onTab, phone, onClose, onError }: {
  chat: Chat;
  bots: Bot[];
  tab: TopicTab;
  onTab: (tab: TopicTab) => void;
  phone: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const files = useLive((s) => s.files[chat.id]);
  const routineCount = useLive((s) => Object.values(s.routines).filter((routine) => routine.chatId === chat.id).length);
  useEffect(() => { if (!files) void loadFiles(chat.id).catch(() => {}); }, [chat.id, files]);
  // Routines here belong to one of your own Bots in the topic (the lead, if it's yours).
  const myId = useMyId();
  const myBots = bots.filter((bot) => bot.ownerId === myId);
  const lead = myBots.find((bot) => bot.id === chat.coordinatorId) ?? myBots[0];
  // You schedule work for your own Bots in this topic.
  const owner = myBots.length > 0;
  const tabs: { id: TopicTab; label: string; count?: number }[] = [
    { id: "doc", label: "Doc" },
    { id: "files", label: "Files", count: files?.length },
    ...(owner ? [{ id: "schedule" as const, label: "Schedule", count: routineCount }] : []),
  ];
  return (
    <SidePanel label={`${chat.title}: ${tab}`} phone={phone}>
      <div className="-mx-4 -mt-1 flex items-center gap-1 border-b border-rule px-4" role="tablist">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => onTab(item.id)}
            className={cn("relative flex items-center gap-1.5 px-2.5 pt-1.5 pb-3 text-sm", tab === item.id ? "font-medium text-ink" : "text-muted hover:text-soft")}>
            {item.label}
            {item.count ? <span className="rounded-full bg-raised px-1.5 text-meta text-muted tabular-nums">{item.count}</span> : null}
            {tab === item.id && <m.span layoutId={`topic-tab-${chat.id}`} className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-ink" transition={snappy} />}
          </button>
        ))}
        <span className="flex-1" />
        <Button size="icon-sm" aria-label="Close" className="mb-1.5" onClick={onClose}><X size={16} /></Button>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={tab} className="flex min-h-0 flex-1 flex-col gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
          {tab === "doc" && <DocTab chat={chat} bots={bots} onError={onError} />}
          {tab === "files" && <FilesTab chat={chat} files={files} onError={onError} />}
          {tab === "schedule" && (lead
            ? <div className="flex min-h-0 flex-1 flex-col gap-3"><Routines bot={lead} chatId={chat.id} onError={onError} /></div>
            : <p className="m-0 text-label text-muted">Add a Bot to this topic to schedule work in it.</p>)}
        </m.div>
      </AnimatePresence>
    </SidePanel>
  );
}

function DocTab({ chat, bots, onError }: { chat: Chat; bots: Bot[]; onError: (message: string) => void }) {
  const artifact = useLive((s) => s.artifacts[chat.id]);
  const [history, setHistory] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => { if (artifact === undefined) void loadArtifact(chat.id).catch(() => onError("Couldn't load the Doc.")); }, [chat.id, artifact, onError]);
  // What you last saw, so a new version can show what changed.
  const seen = useRef<{ version: number; body: string } | null>(null);
  const previous = artifact && seen.current && seen.current.version !== artifact.version ? seen.current.body : undefined;
  useEffect(() => { if (artifact) seen.current = { version: artifact.version, body: artifact.body }; }, [artifact]);

  if (artifact === undefined) return <p className="m-0 text-label text-muted">Loading…</p>;
  if (artifact === null) {
    const name = bots.length === 1 ? bots[0].name : "Your Bots";
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-rule p-4 text-label leading-relaxed text-muted">
        <span className="text-soft">No Doc yet.</span>
        {name} keep{bots.length === 1 ? "s" : ""} one here when the topic needs it: a list, a plan, a budget. Ask for one, or it'll start when it's useful.
      </div>
    );
  }
  const author = artifact.updatedBy === "user" ? "You" : bots.find((bot) => bot.id === artifact.updatedBy)?.name ?? "A Bot";
  const exportDoc = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`# ${artifact.title}\n\n${artifact.body}`], { type: "text/markdown" }));
    link.download = `${artifact.title.replace(/[^\w\- ]+/g, "").trim() || "doc"}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setHistory(!history)} aria-expanded={history} className="flex items-center gap-1.5 text-label text-muted hover:text-ink">
          {history ? <History size={14} /> : null}
          {history ? "History" : <>Version <VersionNumber version={artifact.version} /> · {shortTime(artifact.updatedAt)} · {author}</>}
          <m.span animate={{ rotate: history ? 180 : 0 }} transition={snappy} className="flex"><ChevronDown size={13} /></m.span>
        </button>
        <span className="flex items-center gap-1">
          <Button size="icon-sm" aria-label="Download as Markdown" onClick={exportDoc}><Download size={15} /></Button>
          <Button size="icon-sm" aria-label="Full screen" onClick={() => setFull(true)}><Maximize2 size={15} /></Button>
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <h2 className="m-0 truncate text-[24px] leading-tight font-semibold tracking-tight">{artifact.title}</h2>
        <AnimatePresence initial={false} mode="popLayout">
          {artifact.status && (
            <m.span key={artifact.status} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={snappy}
              className="shrink-0 rounded-full bg-peach px-2.5 py-0.5 text-meta font-medium text-[#1a140f]">{artifact.status}</m.span>
          )}
        </AnimatePresence>
      </div>
      <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-width:thin]">
        <AnimatePresence initial={false} mode="wait">
          {history
            ? <m.div key="history" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={soft}>
                <DocHistory chatId={chat.id} current={artifact.version} bots={bots} onRestored={() => setHistory(false)} onError={onError} />
              </m.div>
            : <m.div key="doc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}><DocBody body={artifact.body} previous={previous} /></m.div>}
        </AnimatePresence>
      </div>
      <Dialog open={full} onOpenChange={setFull} title={artifact.title} wide>
        <div className="max-h-[75vh] overflow-y-auto pr-1"><DocBody body={artifact.body} /></div>
      </Dialog>
    </>
  );
}

/** Every version with its note; pick one to see what it changed, and restore it as a new version. */
function DocHistory({ chatId, current, bots, onRestored, onError }: { chatId: string; current: number; bots: Bot[]; onRestored: () => void; onError: (message: string) => void }) {
  const [versions, setVersions] = useState<Omit<ArtifactVersion, "body">[] | null>(null);
  const [picked, setPicked] = useState(current);
  const [bodies, setBodies] = useState<Record<number, string>>({});
  useEffect(() => { void api.artifact(chatId).then((result) => setVersions(result.versions)).catch(() => onError("Couldn't load the history.")); }, [chatId, current, onError]);
  useEffect(() => {
    for (const version of [picked, picked - 1]) {
      if (version >= 1 && bodies[version] === undefined) void api.artifactVersion(chatId, version).then((item) => setBodies((all) => ({ ...all, [version]: item.body }))).catch(() => {});
    }
  }, [chatId, picked, bodies]);
  const name = (id: string) => (id === "user" ? "You" : bots.find((bot) => bot.id === id)?.name ?? "A Bot");
  const lines = bodies[picked] !== undefined ? changesOnly(diffLines(picked > 1 ? bodies[picked - 1] ?? "" : "", bodies[picked])) : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col rounded-[14px] border border-rule bg-surface p-1.5">
        {!versions && <span className="p-2 text-label text-muted">Loading…</span>}
        {versions?.slice(0, 30).map((version) => (
          <button key={version.version} type="button" onClick={() => setPicked(version.version)}
            className={cn("flex gap-3 rounded-[10px] p-2.5 text-left", picked === version.version ? "bg-raised" : "hover:bg-hover")}>
            <span className={cn("w-7 shrink-0 font-mono text-meta leading-[18px]", picked === version.version ? "text-ink" : "text-muted")}>v{version.version}</span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={cn("truncate text-label", picked === version.version ? "font-medium text-ink" : "text-soft")}>{version.note || "No note"}</span>
              <span className="text-meta text-muted">{name(version.updatedBy)} · {shortTime(version.createdAt)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-label font-medium text-soft">Changes in v{picked}</span>
        {picked !== current && (
          <Button variant="outline" size="pill" onClick={() => void api.restoreArtifact(chatId, picked).then(onRestored).catch(() => onError("Couldn't restore that version."))}>
            Restore v{picked}
          </Button>
        )}
      </div>
      <div className="flex flex-col overflow-hidden rounded-xl border border-rule font-mono text-meta leading-[18px]">
        {!lines && <span className="p-3 text-muted">Loading…</span>}
        {lines?.length === 0 && <span className="p-3 text-muted">No changes.</span>}
        {lines?.map((line, index) => line.kind === "gap"
          ? <span key={index} className="px-3 py-1.5 text-muted">… {line.count} unchanged line{line.count === 1 ? "" : "s"}</span>
          : <span key={index} className={cn("px-3 py-1 whitespace-pre-wrap [overflow-wrap:anywhere]",
              line.kind === "added" ? "bg-mint/10 text-mint" : line.kind === "removed" ? "bg-coral/10 text-coral" : "text-muted")}>
              {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}{line.text}
            </span>)}
      </div>
    </div>
  );
}

const readableSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function FilesTab({ chat, files, onError }: { chat: Chat; files: ChatFile[] | undefined; onError: (message: string) => void }) {
  const bots = useLive((s) => s.bots);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  async function upload(list: FileList | null) {
    for (const file of Array.from(list ?? [])) {
      setUploading((count) => count + 1);
      try { await api.uploadFile(chat.id, file); }
      catch (failure) { onError(failure instanceof Error ? failure.message : "Couldn't upload that."); }
      finally { setUploading((count) => count - 1); }
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}>
      <div className="flex items-center justify-between">
        <span className="text-label font-medium text-soft">In this topic</span>
        <Button variant="outline" size="pill" disabled={uploading > 0} onClick={() => picker.current?.click()}><Upload size={14} />{uploading ? "Uploading…" : "Upload"}</Button>
        <input ref={picker} type="file" multiple hidden onChange={(event) => { void upload(event.target.files); event.target.value = ""; }} />
      </div>
      <div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 [scrollbar-width:thin]">
        {!files && <p className="m-0 text-label text-muted">Loading…</p>}
        {files?.length === 0 && (
          <p className="m-0 rounded-xl border border-dashed border-rule p-4 text-label leading-relaxed text-muted">
            No files yet. Drop them here, attach them to a message, or upload. Every Bot in this topic can read them.
          </p>
        )}
        <AnimatePresence initial={false}>
          {files?.map((file) => (
            <m.div key={file.id} layout="position" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={soft}
              className="group flex items-center gap-3 border-b border-rule py-2.5 last:border-0">
              <a href={fileUrl(file.id)} target="_blank" rel="noopener noreferrer" className="flex min-w-0 flex-1 items-center gap-3">
                {file.mime.startsWith("image/")
                  ? <img src={fileUrl(file.id)} alt="" className="size-10 shrink-0 rounded-lg bg-raised object-cover" />
                  : <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                      {file.mime === "application/pdf" ? <FileText size={18} /> : <span className="font-mono text-[10px] uppercase">{file.name.split(".").pop()?.slice(0, 4)}</span>}
                    </span>}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm">{file.name}</span>
                  <span className="text-meta text-muted">{file.addedBy === "user" ? "You" : bots[file.addedBy]?.name ?? "A Bot"} · {shortTime(file.createdAt)} · {readableSize(file.size)}</span>
                </span>
              </a>
              <Button size="icon-sm" aria-label={`Delete ${file.name}`} className="opacity-0 group-hover:opacity-100 max-sm:opacity-100"
                onClick={() => { if (confirm(`Delete ${file.name}?`)) void api.deleteFile(file.id).catch(() => onError("Couldn't delete it.")); }}>
                <Trash2 size={14} />
              </Button>
            </m.div>
          ))}
        </AnimatePresence>
      </div>
      <span className="text-meta text-muted">Every Bot in this topic can read these. Bots with a computer also find them in /workspace/topics/.</span>
    </div>
  );
}
