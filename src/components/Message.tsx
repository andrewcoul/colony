import { useState } from "react";
import { useSmoothText, type UIMessage } from "@convex-dev/agent/react";
import { Check, ChevronRight, Copy, Globe, Lightbulb, Pencil, RefreshCw } from "lucide-react";
import { hostname, isWebUrl, openExternal } from "../lib/links";
import { cn } from "../lib/utils";
import { useCopy } from "../hooks/useCopy";
import { MarkdownView } from "./MarkdownView";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

type Source = { title: string; url: string };
type Part = UIMessage["parts"][number];

function reasoningOf(parts: Part[]) {
  return parts.filter((part) => part.type === "reasoning").map((part) => ("text" in part ? String(part.text) : "")).join("\n\n").trim();
}

/** Web search tool calls and the sources they returned, deduplicated by URL. */
function searchesOf(parts: Part[]) {
  const queries: string[] = [];
  const sources = new Map<string, Source>();
  let pending = false;
  for (const part of parts) {
    if (part.type !== "tool-webSearch") continue;
    const call = part as { state?: string; input?: { query?: string }; output?: { results?: Source[] } };
    if (call.input?.query) queries.push(call.input.query);
    if (call.state !== "output-available" && call.state !== "output-error") pending = true;
    for (const result of call.output?.results || []) {
      if (isWebUrl(result.url) && !sources.has(result.url)) sources.set(result.url, { title: result.title, url: result.url });
    }
  }
  return { queries, sources: [...sources.values()], pending };
}

export function UserTurn({ message, onEdit }: { message: UIMessage; onEdit: (text: string) => void }) {
  const { copied, copy } = useCopy();
  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="max-w-[78%] rounded-[22px] bg-raised px-[18px] py-3 text-body leading-6 [overflow-wrap:anywhere] whitespace-pre-wrap max-sm:max-w-[90%]">
        {message.text}
      </div>
      <div className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip label={copied ? "Copied" : "Copy"}>
          <Button size="icon-sm" aria-label="Copy message" onClick={() => void copy(message.text)}>{copied ? <Check size={15} /> : <Copy size={15} />}</Button>
        </Tooltip>
        <Tooltip label="Edit in composer">
          <Button size="icon-sm" aria-label="Edit message" onClick={() => onEdit(message.text)}><Pencil size={15} /></Button>
        </Tooltip>
      </div>
    </div>
  );
}

export function AssistantTurn({ message, latest, canRegenerate, onRegenerate, onError }: {
  message: UIMessage;
  latest: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onError: (message: string) => void;
}) {
  const streaming = message.status === "streaming";
  const [text] = useSmoothText(message.text, { startStreaming: streaming });
  const { copied, copy } = useCopy(() => onError("Couldn't copy this reply."));
  const reasoning = reasoningOf(message.parts);
  const search = searchesOf(message.parts);
  const failed = message.status === "failed";

  return (
    <div className="group flex min-w-0 flex-col gap-3.5">
      {reasoning && <Reasoning text={reasoning} active={streaming && !text} />}
      {search.queries.length > 0 && <SearchActivity queries={search.queries} count={search.sources.length} active={search.pending && streaming} />}
      {text ? <MarkdownView text={text} />
        : failed ? <p className="m-0 text-label text-muted">Reply interrupted.</p>
        : !reasoning && !search.queries.length ? <TypingDots /> : null}
      {search.sources.length > 0 && !streaming && <Sources sources={search.sources} onError={onError} />}
      {text && !streaming && (
        <div className={cn("-ml-1.5 flex items-center gap-0.5 transition-opacity", latest ? "opacity-100" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100")}>
          <Tooltip label={copied ? "Copied" : "Copy"}>
            <Button size="icon-sm" aria-label="Copy reply" onClick={() => void copy(message.text)}>{copied ? <Check size={16} /> : <Copy size={16} />}</Button>
          </Tooltip>
          {latest && canRegenerate && (
            <Tooltip label="Regenerate">
              <Button size="icon-sm" aria-label="Regenerate reply" onClick={onRegenerate}><RefreshCw size={16} /></Button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-2 self-start text-label text-muted hover:text-ink">
        <Lightbulb size={15} />
        <span className={cn(active && "shimmer-text")}>{active ? "Thinking" : "Thoughts"}</span>
        <ChevronRight size={14} className={cn("transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="max-h-80 overflow-y-auto border-l-2 border-rule py-0.5 pl-3.5 text-label leading-[22px] whitespace-pre-wrap text-muted">{text}</div>}
    </div>
  );
}

function SearchActivity({ queries, count, active }: { queries: string[]; count: number; active: boolean }) {
  const [open, setOpen] = useState(false);
  const label = active ? "Searching the web" : `Searched the web · ${count} ${count === 1 ? "source" : "sources"}`;
  return (
    <div className="flex flex-col gap-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-2 self-start text-label text-muted hover:text-ink">
        <Globe size={15} />
        <span className={cn(active && "shimmer-text")}>{label}</span>
        <ChevronRight size={14} className={cn("transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col gap-1 border-l-2 border-rule py-0.5 pl-3.5 text-label text-muted">
          {queries.map((query, index) => <li key={index}>“{query}”</li>)}
        </ul>
      )}
    </div>
  );
}

function Sources({ sources, onError }: { sources: Source[]; onError: (message: string) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
      {sources.map((source, index) => (
        <button
          key={source.url} type="button" title={source.url}
          onClick={() => void openExternal(source.url).catch(() => onError("Couldn't open this link."))}
          className="flex w-[200px] shrink-0 flex-col gap-1 rounded-xl border border-rule bg-surface px-3 py-2.5 text-left hover:border-muted"
        >
          <small className="truncate text-meta text-muted">{index + 1} · {hostname(source.url)}</small>
          <span className="truncate text-label">{source.title}</span>
        </button>
      ))}
    </div>
  );
}

export function TypingDots() {
  return (
    <div className="inline-flex gap-1 py-2" role="status" aria-label="Colony is replying">
      {[0, 150, 300].map((delay) => <i key={delay} className="size-1.5 animate-blink rounded-full bg-muted" style={{ animationDelay: delay + "ms" }} />)}
    </div>
  );
}
