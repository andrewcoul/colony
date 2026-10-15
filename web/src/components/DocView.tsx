import { useEffect, useMemo, useRef, useState } from "react";
import { animate, AnimatePresence, m } from "motion/react";
import { ExternalLink, Package } from "lucide-react";
import { imageUrl } from "../lib/api";
import { isWebUrl, openExternal } from "../lib/links";
import { snappy, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { MarkdownView } from "./MarkdownView";

/*
 * A topic's Doc: Markdown, plus three fenced blocks a Bot can write (see docTools.ts on the server):
 *   ```colony-stats   label | value | small print       a row of big numbers
 *   ```colony-items   - name: … / tag / detail / price / link / image     cards for products or options
 *   ```colony-note    a muted line saying where the facts came from
 * Anything that doesn't parse shows as plain Markdown, so a Doc always reads fine as a file.
 */

type Stat = { label: string; value: string; small: string };
type Item = { name: string; tag?: string; detail?: string; price?: string; link?: string; image?: string };
type Block =
  | { kind: "markdown"; text: string }
  | { kind: "stats"; stats: Stat[] }
  | { kind: "items"; items: Item[] }
  | { kind: "note"; text: string };

const FENCE = /```colony-(stats|items|note)[ \t]*\n([\s\S]*?)```/g;

export function parseDoc(body: string): Block[] {
  const blocks: Block[] = [];
  let last = 0;
  for (const match of body.matchAll(FENCE)) {
    if (match.index > last) blocks.push({ kind: "markdown", text: body.slice(last, match.index) });
    const [whole, kind, inner] = match;
    const parsed = kind === "stats" ? parseStats(inner) : kind === "items" ? parseItems(inner) : { kind: "note" as const, text: inner.trim() };
    blocks.push(parsed ?? { kind: "markdown", text: whole });
    last = match.index + whole.length;
  }
  if (last < body.length) blocks.push({ kind: "markdown", text: body.slice(last) });
  return blocks.filter((block) => block.kind !== "markdown" || block.text.trim());
}

function parseStats(text: string): Block | null {
  const stats = text.split("\n").map((line) => line.split("|").map((cell) => cell.trim())).filter((cells) => cells[0])
    .map(([label, value = "", small = ""]) => ({ label, value, small }));
  return stats.length ? { kind: "stats", stats } : null;
}

function parseItems(text: string): Block | null {
  const items: Item[] = [];
  for (const line of text.split("\n")) {
    const start = /^\s*-\s+name:\s*(.+)$/.exec(line);
    const field = /^\s+(tag|detail|price|link|image):\s*(.+)$/.exec(line);
    if (start) items.push({ name: start[1].trim() });
    else if (field && items.length) items[items.length - 1][field[1] as keyof Item] = field[2].trim();
  }
  return items.length ? { kind: "items", items } : null;
}

/** "≈ €1,017" → counts the 1,017 up from its last value when it changes; other text stays as is. */
function CountUp({ value }: { value: string }) {
  const match = /^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(value);
  const target = match ? Number(match[2].replace(/,/g, "")) : NaN;
  const decimals = match?.[2].split(".")[1]?.length ?? 0;
  const shown = useRef(target);
  const [display, setDisplay] = useState(target);
  useEffect(() => {
    if (!Number.isFinite(target) || target === shown.current) return;
    const controls = animate(shown.current, target, { duration: 0.7, ease: "easeOut", onUpdate: (latest) => setDisplay(latest) });
    shown.current = target;
    return () => controls.stop();
  }, [target]);
  if (!match || !Number.isFinite(target)) return <>{value}</>;
  const formatted = display.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <>{match[1]}{formatted}{match[3]}</>;
}

function Stats({ stats }: { stats: Stat[] }) {
  return (
    <div className="flex gap-2.5">
      {stats.map((stat, index) => (
        <div key={stat.label} className={cn("flex min-w-0 flex-col gap-1 rounded-[14px] px-4 py-3.5", index === 0 ? "flex-[1.6] bg-peach text-[#1a140f]" : "flex-1 border border-rule")}>
          <span className={cn("text-meta", index === 0 ? "text-[#5a3a26]" : "text-muted")}>{stat.label}</span>
          <span className="truncate text-[28px] leading-[32px] font-semibold tracking-tight"><CountUp value={stat.value} /></span>
          {stat.small && <span className={cn("truncate text-label", index === 0 ? "text-[#5a3a26]" : "text-muted")}>{stat.small}</span>}
        </div>
      ))}
    </div>
  );
}

/** Product or option cards. Ones that are new or changed since you last looked flash softly. */
function Items({ items, changed }: { items: Item[]; changed: Set<string> }) {
  return (
    <div className="flex flex-col">
      {items.map((item, index) => (
        <m.div key={item.name} layout="position" transition={soft}
          initial={false}
          animate={changed.has(item.name) ? { backgroundColor: ["rgb(255 179 138 / 0.22)", "rgb(255 179 138 / 0)"] } : {}}
          className={cn("-mx-2 flex gap-3.5 rounded-xl px-2 py-3", index < items.length - 1 && "border-b border-rule")}>
          {item.image && isWebUrl(item.image)
            ? <img src={imageUrl(item.image)} alt="" loading="lazy" className="size-14 shrink-0 rounded-[10px] bg-raised object-cover" />
            : <span className="flex size-14 shrink-0 items-center justify-center rounded-[10px] bg-raised text-muted"><Package size={22} /></span>}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <strong className="truncate text-sm">{item.name}</strong>
              {item.tag && <span className="shrink-0 rounded-full bg-raised px-2 py-px text-[11px] text-soft">{item.tag}</span>}
              {item.link && isWebUrl(item.link) && (
                <button type="button" aria-label={`Open ${item.name}`} onClick={() => void openExternal(item.link!)} className="ml-auto shrink-0 text-muted hover:text-ink"><ExternalLink size={13} /></button>
              )}
            </span>
            {item.detail && <span className="text-label text-muted">{item.detail}</span>}
            {item.price && <span className="text-label text-soft">{item.price}</span>}
          </div>
        </m.div>
      ))}
    </div>
  );
}

/** Renders a Doc's body. `previous` is the body you saw before, so changes can be shown. */
export function DocBody({ body, previous }: { body: string; previous?: string }) {
  const blocks = useMemo(() => parseDoc(body), [body]);
  const changed = useMemo(() => {
    if (previous === undefined || previous === body) return new Set<string>();
    const before = new Map(parseDoc(previous).flatMap((block) => (block.kind === "items" ? block.items : [])).map((item) => [item.name, JSON.stringify(item)]));
    const after = blocks.flatMap((block) => (block.kind === "items" ? block.items : []));
    return new Set(after.filter((item) => before.get(item.name) !== JSON.stringify(item)).map((item) => item.name));
  }, [blocks, body, previous]);
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, index) => {
        if (block.kind === "stats") return <Stats key={index} stats={block.stats} />;
        if (block.kind === "items") return <Items key={index} items={block.items} changed={changed} />;
        if (block.kind === "note") return <p key={index} className="m-0 text-meta text-muted">{block.text}</p>;
        return <MarkdownView key={index} text={block.text} images="proxied" />;
      })}
    </div>
  );
}

/** The version number rolls when a new version arrives. */
export function VersionNumber({ version }: { version: number }) {
  return (
    <span className="relative inline-flex h-[1.3em] overflow-hidden align-bottom tabular-nums">
      <AnimatePresence initial={false} mode="popLayout">
        <m.span key={version} initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "-100%" }} transition={snappy}>{version}</m.span>
      </AnimatePresence>
    </span>
  );
}
