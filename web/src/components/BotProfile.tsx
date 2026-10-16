import { useEffect, useState } from "react";
import { BookOpen, Brain, ChevronLeft, Plus, Shuffle, Trash2, User, X } from "lucide-react";
import type { Bot } from "@shared/types";
import { api, type BotMemory } from "../lib/api";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { MarkdownView } from "./MarkdownView";
import { BotAccess } from "./BotAccess";
import { DesktopToggle } from "./DesktopToggle";
import { ModelPicker } from "./ModelPicker";
import { SidePanel } from "./SidePanel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const fieldClass = "w-full rounded-lg border border-rule bg-ground px-3.5 text-sm text-ink outline-none placeholder:text-muted focus:border-muted";

/** Who a Bot is and what it knows: persona, memory, what it knows about you, and its skills. */
export function BotProfile({ bot, phone, onClose, onError }: { bot: Bot; phone: boolean; onClose: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [soul, setSoul] = useState<string | null>(null);
  const [savedSoul, setSavedSoul] = useState("");
  const [memory, setMemory] = useState<BotMemory | null>(null);
  const [skill, setSkill] = useState<{ slug: string; name: string; content: string } | null>(null);

  useEffect(() => {
    setName(bot.name); setTitle(bot.title);
  }, [bot.name, bot.title]);
  useEffect(() => {
    void api.soul(bot.id).then(({ content }) => { setSoul(content); setSavedSoul(content); }).catch(() => onError("Couldn't load the persona."));
    void api.memory(bot.id).then(setMemory).catch(() => onError("Couldn't load memory."));
  }, [bot.id, onError]);

  const update = (patch: Parameters<typeof api.updateBot>[1]) =>
    void api.updateBot(bot.id, patch).catch((failure) => onError(failure instanceof Error ? failure.message : "Couldn't save that."));
  const run = (action: Promise<BotMemory>) =>
    void action.then(setMemory).catch((failure) => onError(failure instanceof Error ? failure.message : "Couldn't update memory."));

  if (skill) {
    return (
      <SidePanel label={`${bot.name}'s skill`} phone={phone}>
        <div className="flex items-center gap-2.5">
          <Button size="icon-sm" aria-label="Back to profile" className="-ml-1" onClick={() => setSkill(null)}><ChevronLeft size={17} /></Button>
          <strong className="min-w-0 flex-1 truncate text-sm">{skill.name}</strong>
          <Button size="icon-sm" aria-label="Delete skill" className="text-danger hover:text-danger" onClick={() => {
            if (!confirm(`Delete the skill "${skill.name}"?`)) return;
            void api.deleteSkill(bot.id, skill.slug).then(() => api.memory(bot.id)).then((next) => { setMemory(next); setSkill(null); });
          }}><Trash2 size={15} /></Button>
          <Button size="icon-sm" aria-label="Close" onClick={onClose}><X size={16} /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto"><MarkdownView text={skill.content.replace(/^---[\s\S]*?---\s*/, "")} /></div>
      </SidePanel>
    );
  }

  return (
    <SidePanel label={`${bot.name}'s profile`} phone={phone}>
      <div className="flex items-center gap-2.5">
        <strong className="min-w-0 flex-1 truncate text-sm">Profile</strong>
        <Button size="icon-sm" aria-label="Close" onClick={onClose}><X size={16} /></Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-2 [scrollbar-width:thin]">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Face seed={bot.faceSeed} state={bot.presence} size={64} title={bot.name} />
            <Button size="icon-sm" aria-label="New face" className="absolute -right-2 -bottom-2 size-7 rounded-full bg-raised"
              onClick={() => update({ faceSeed: `${bot.name}-${Math.random().toString(36).slice(2, 7)}` })}><Shuffle size={13} /></Button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Input aria-label="Name" value={name} maxLength={40} className="h-9"
              onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name.trim() !== bot.name) update({ name: name.trim() }); else setName(bot.name); }} />
            <Input aria-label="Title" value={title} maxLength={60} placeholder="Title" className="h-9"
              onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (title.trim() !== bot.title) update({ title: title.trim() }); }} />
          </div>
        </div>

        <div className="flex flex-col border-y border-rule">
          <ModelPicker value={bot.model} onChange={(model) => update({ model })} desktopOnly={bot.desktop} />
          <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
            <span className="flex flex-col gap-0.5"><span className="text-sm">Own computer</span><span className="text-meta text-muted">Terminal, files and a browser in Docker</span></span>
            <input type="checkbox" checked={bot.computer} onChange={(e) => update({ computer: e.target.checked })} className="sr-only" />
            <span className={cn("flex h-6 w-10 shrink-0 items-center rounded-full p-[3px] transition-colors", bot.computer ? "justify-end bg-ink" : "justify-start bg-raised")}>
              <span className={cn("size-[18px] rounded-full", bot.computer ? "bg-on-ink" : "bg-muted")} />
            </span>
          </label>
          <DesktopToggle computer={bot.computer} desktop={bot.desktop} model={bot.model} onChange={(patch) => update(patch)} />
        </div>

        <BotAccess bot={bot} onError={onError} />

        <section className="flex flex-col gap-2">
          <h3 className="m-0 flex items-center gap-2 text-label font-semibold"><User size={14} className="text-muted" />Persona <span className="font-normal text-muted">SOUL.md</span></h3>
          <textarea value={soul ?? ""} onChange={(e) => setSoul(e.target.value)} rows={7} disabled={soul === null} maxLength={20_000}
            aria-label="Persona" className={cn(fieldClass, "resize-y py-3 font-mono text-[13px] leading-relaxed")} />
          {soul !== null && soul !== savedSoul && (
            <div className="flex gap-2">
              <Button variant="primary" size="pill" onClick={() => void api.saveSoul(bot.id, soul).then(() => setSavedSoul(soul)).catch(() => onError("Couldn't save the persona."))}>Save persona</Button>
              <Button variant="ghost" size="pill" onClick={() => setSoul(savedSoul)}>Discard</Button>
            </div>
          )}
        </section>

        <MemoryList
          icon={<Brain size={14} className="text-muted" />} title="Memory" file="MEMORY.md"
          hint={`${bot.name}'s own notes. ${bot.name} curates these as you work together.`}
          entries={memory?.memory} usage={memory?.usage.memory}
          onAdd={(entry) => run(api.addMemory(bot.id, "memory", entry))}
          onRemove={(entry) => run(api.removeMemory(bot.id, "memory", entry))}
        />
        <MemoryList
          icon={<User size={14} className="text-muted" />} title="About you" file="USER.md"
          hint="Shared with every Bot."
          entries={memory?.user} usage={memory?.usage.user}
          onAdd={(entry) => run(api.addMemory(bot.id, "user", entry))}
          onRemove={(entry) => run(api.removeMemory(bot.id, "user", entry))}
        />

        <section className="flex flex-col gap-2">
          <h3 className="m-0 flex items-center gap-2 text-label font-semibold"><BookOpen size={14} className="text-muted" />Skills</h3>
          {memory?.skills.length === 0 && <p className="m-0 text-meta text-muted">No skills yet. {bot.name} saves one after working out a task worth repeating.</p>}
          {memory?.skills.map((item) => (
            <button key={item.slug} type="button" className="flex flex-col gap-0.5 rounded-xl border border-rule px-3.5 py-2.5 text-left hover:bg-hover"
              onClick={() => void api.skill(bot.id, item.slug).then(({ content }) => setSkill({ slug: item.slug, name: item.name, content }))}>
              <span className="text-sm font-medium">{item.name}</span>
              {item.description && <span className="line-clamp-2 text-meta text-muted">{item.description}</span>}
            </button>
          ))}
        </section>

      </div>
    </SidePanel>
  );
}

function MemoryList({ icon, title, file, hint, entries, usage, onAdd, onRemove }: {
  icon: React.ReactNode;
  title: string;
  file: string;
  hint: string;
  entries: string[] | undefined;
  usage: { used: number; budget: number } | undefined;
  onAdd: (entry: string) => void;
  onRemove: (entry: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const share = usage ? Math.min(1, usage.used / usage.budget) : 0;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 flex items-center gap-2 text-label font-semibold">
        {icon}{title} <span className="font-normal text-muted">{file}</span>
        {usage && <span className="ml-auto text-meta font-normal text-muted tabular-nums">{(usage.used / 1000).toFixed(1)}k / {usage.budget / 1000}k</span>}
      </h3>
      {usage && (
        <span className="h-1 overflow-hidden rounded-full bg-raised">
          <span className={cn("block h-full rounded-full", share > 0.9 ? "bg-coral" : "bg-mint")} style={{ width: `${share * 100}%` }} />
        </span>
      )}
      <p className="m-0 text-meta text-muted">{hint}</p>
      {entries?.length === 0 && <p className="m-0 text-meta text-muted">Nothing yet.</p>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {entries?.map((entry) => (
          <li key={entry} className="group flex items-start gap-2 rounded-lg px-1 py-1 text-label leading-snug hover:bg-hover">
            <span className="mt-2 size-1 shrink-0 rounded-full bg-muted" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{entry}</span>
            <button type="button" aria-label={`Forget "${entry}"`} onClick={() => onRemove(entry)}
              className="shrink-0 rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:text-danger max-sm:opacity-100"><X size={14} /></button>
          </li>
        ))}
      </ul>
      <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { onAdd(draft.trim()); setDraft(""); } }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} placeholder="Add a note…" aria-label={`Add to ${title}`}
          className={cn(fieldClass, "h-9 min-w-0 flex-1")} />
        <Button type="submit" variant="outline" size="icon" className="size-9" aria-label="Add" disabled={!draft.trim()}><Plus size={15} /></Button>
      </form>
    </section>
  );
}
