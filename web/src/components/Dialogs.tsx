import { useEffect, useState } from "react";
import { Shuffle } from "lucide-react";
import type { Bot } from "@shared/types";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/input";

/** Starting points for common roles; everything stays editable before you create the Bot. */
const TEMPLATES = [
  {
    role: "Chief of staff", name: "Morgan", computer: false,
    description: "Runs the team for me. Turns what I ask into tasks, hands each one to the teammate whose role fits, follows up, and reports back with one short summary. Sends me a morning briefing of what's in flight and what needs me. Asks me only when a decision is truly mine.",
  },
  {
    role: "Researcher", name: "Riley", computer: false,
    description: "Answers questions by searching and reading the web, compares sources, and cites every claim with a link. Says plainly when the evidence is thin or conflicting.",
  },
  {
    role: "Engineer", name: "Sam", computer: true,
    description: "Writes, runs and tests code on their own computer. Keeps changes small, verifies they work before reporting, and explains what changed and why.",
  },
  {
    role: "Writer", name: "Quinn", computer: false,
    description: "Drafts and edits in my voice: emails, posts, docs. Keeps it short and plain, and offers one alternative when the tone could go either way. Never sends anything without asking.",
  },
  {
    role: "Web operator", name: "Ava", computer: true,
    description: "Gets things done on websites with their own browser: fills forms, checks dashboards, collects information. Hands the browser to me for logins and payments.",
  },
] as const;

export function CreateBotDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (bot: Bot) => void;
}) {
  const models = useLive((s) => s.models);
  const defaultModel = useLive((s) => s.defaultModel);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [computer, setComputer] = useState(true);
  const [faceSeed, setFaceSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(""); setTitle(""); setDescription(""); setModel(defaultModel); setComputer(true); setFaceSeed(null); setError("");
  }, [open, defaultModel]);

  const seed = faceSeed ?? (name || "new bot");

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const bot = await api.createBot({ name: name.trim(), title: title.trim(), description: description.trim(), model, computer, faceSeed: faceSeed ?? undefined });
      onOpenChange(false);
      onCreated(bot);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't create the Bot.");
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New Bot">
      <form onSubmit={create} className="flex flex-col">
        <div className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" role="group" aria-label="Start from a role">
          {TEMPLATES.map((template) => (
            <button key={template.role} type="button"
              aria-pressed={title === template.role}
              onClick={() => { setName(template.name); setTitle(template.role); setDescription(template.description); setComputer(template.computer); setFaceSeed(null); }}
              className={cn("shrink-0 rounded-full border px-3 py-1.5 text-meta", title === template.role ? "border-transparent bg-ink text-on-ink" : "border-rule text-soft hover:bg-hover hover:text-ink")}>
              {template.role}
            </button>
          ))}
        </div>
        <div className="mb-5 flex items-center gap-4">
          <Face seed={seed} size={72} title="Face preview" />
          <div className="flex flex-col gap-2">
            <span className="text-label text-muted">{faceSeed ? "Face locked" : "Face follows the name"}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="pill" onClick={() => setFaceSeed(`${name}-${Math.random().toString(36).slice(2, 7)}`)}><Shuffle size={14} />Shuffle</Button>
              {faceSeed && <Button variant="ghost" size="pill" onClick={() => setFaceSeed(null)}>Reset</Button>}
            </div>
          </div>
        </div>
        <Field label="Name" htmlFor="bot-name"><Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus placeholder="Luke" /></Field>
        <Field label="Title" htmlFor="bot-title"><Input id="bot-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="Inbox manager" /></Field>
        <Field label={`What does ${name.trim() || "this Bot"} do?`} htmlFor="bot-description">
          <textarea id="bot-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3}
            placeholder="Keep my inbox near zero. Draft replies in my voice, flag anything from clients, and never send without asking."
            className="w-full resize-y rounded-lg border border-rule bg-ground px-3.5 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-muted focus:border-muted" />
        </Field>
        <div className="mb-4 flex flex-col border-t border-rule">
          {models.length > 1 && (
            <label className="flex items-center justify-between gap-4 border-b border-rule py-3 text-sm">
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)} className="max-w-[60%] truncate rounded-md bg-raised px-2 py-1 text-label text-ink outline-none">
                {models.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          )}
          <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
            <span className="flex flex-col gap-0.5"><span className="text-sm">Own computer</span><span className="text-meta text-muted">Terminal, files and a browser in Docker</span></span>
            <input type="checkbox" checked={computer} onChange={(e) => setComputer(e.target.checked)} className="peer sr-only" />
            <span className={cn("flex h-6 w-10 items-center rounded-full p-[3px] transition-colors", computer ? "justify-end bg-ink" : "justify-start bg-raised")}>
              <span className={cn("size-[18px] rounded-full", computer ? "bg-on-ink" : "bg-muted")} />
            </span>
          </label>
        </div>
        {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : `Create ${name.trim() || "Bot"}`}</Button>
      </form>
    </Dialog>
  );
}

export function NewGroupDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (chatId: string) => void;
}) {
  const botMap = useLive((s) => s.bots);
  const bots = Object.values(botMap).sort((a, b) => a.name.localeCompare(b.name));
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [coordinatorId, setCoordinatorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (open) { setTitle(""); setMembers([]); setCoordinatorId(""); setError(""); } }, [open]);

  const toggle = (id: string) => setMembers((current) => {
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, 6);
    if (!next.includes(coordinatorId)) setCoordinatorId(next[0] ?? "");
    return next;
  });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const chat = await api.createGroup({ title: title.trim(), memberIds: members, coordinatorId: coordinatorId || undefined });
      onOpenChange(false);
      onCreated(chat.id);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't create the group."); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New group" description="Bots in a group share one conversation and can hand work to each other.">
      <form onSubmit={create} className="flex flex-col">
        <Field label="Name" htmlFor="group-title"><Input id="group-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} required placeholder="Website launch" /></Field>
        <span className="mb-1.5 text-label text-muted">Members (2–6)</span>
        <div className="mb-4 flex max-h-64 flex-col overflow-y-auto">
          {bots.length < 2 && <p className="m-0 py-2 text-label text-muted">Create at least two Bots first.</p>}
          {bots.map((bot) => {
            const selected = members.includes(bot.id);
            return (
              <div key={bot.id} className="flex items-center gap-3 rounded-lg px-1 py-2">
                <button type="button" onClick={() => toggle(bot.id)} aria-pressed={selected} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <Face seed={bot.faceSeed} size={30} className={cn(!selected && "opacity-50")} />
                  <span className={cn("truncate text-sm", selected ? "text-ink" : "text-muted")}>{bot.name}</span>
                </button>
                {selected && (
                  <button type="button" onClick={() => setCoordinatorId(bot.id)}
                    className={cn("rounded-full px-2.5 py-1 text-meta", coordinatorId === bot.id ? "bg-ink text-on-ink" : "text-muted hover:text-ink")}>
                    {coordinatorId === bot.id ? "Coordinator" : "Make coordinator"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !title.trim() || members.length < 2}>Create group</Button>
      </form>
    </Dialog>
  );
}
