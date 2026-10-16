import { useEffect, useState } from "react";
import { Shuffle } from "lucide-react";
import { TOPIC_ICONS, type Bot, type Chat, type TopicIcon } from "@shared/types";
import { api } from "../lib/api";
import { useLive, useMyId } from "../lib/live";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { PersonAvatar } from "./People";
import { DesktopToggle } from "./DesktopToggle";
import { ModelPicker } from "./ModelPicker";
import { TopicTile } from "./TopicIcon";
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
  const defaultModel = useLive((s) => s.defaultModel);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [computer, setComputer] = useState(true);
  const [desktop, setDesktop] = useState(false);
  const [faceSeed, setFaceSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(""); setTitle(""); setDescription(""); setModel(defaultModel); setComputer(true); setDesktop(false); setFaceSeed(null); setError("");
  }, [open, defaultModel]);

  const seed = faceSeed ?? (name || "new bot");

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const bot = await api.createBot({ name: name.trim(), title: title.trim(), description: description.trim(), model, computer, desktop: computer && desktop, faceSeed: faceSeed ?? undefined });
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
          <ModelPicker value={model} onChange={setModel} desktopOnly={computer && desktop} />
          <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
            <span className="flex flex-col gap-0.5"><span className="text-sm">Own computer</span><span className="text-meta text-muted">Terminal, files and a browser in Docker</span></span>
            <input type="checkbox" checked={computer} onChange={(e) => { setComputer(e.target.checked); if (!e.target.checked) setDesktop(false); }} className="peer sr-only" />
            <span className={cn("flex h-6 w-10 items-center rounded-full p-[3px] transition-colors", computer ? "justify-end bg-ink" : "justify-start bg-raised")}>
              <span className={cn("size-[18px] rounded-full", computer ? "bg-on-ink" : "bg-muted")} />
            </span>
          </label>
          <DesktopToggle computer={computer} desktop={computer && desktop} model={model} onChange={(patch) => { setDesktop(patch.desktop); if (patch.model) setModel(patch.model); }} />
        </div>
        {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : `Create ${name.trim() || "Bot"}`}</Button>
      </form>
    </Dialog>
  );
}

/** New topic, or edit one: name, icon, its Bots, what it's about, and where it's filed. */
export function TopicDialog({ open, onOpenChange, onSaved, topic, defaultBotId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (chatId: string) => void;
  /** Editing this topic; otherwise a new one. */
  topic?: Chat;
  /** A new topic starts with this Bot in it (e.g. made from that Bot's chat). */
  defaultBotId?: string;
}) {
  const botMap = useLive((s) => s.bots);
  const folderMap = useLive((s) => s.folders);
  const me = useLive((s) => s.me?.id ?? "owner");
  // You bring your own Bots; other people's already in the topic stay as they are.
  const bots = Object.values(botMap).filter((bot) => bot.ownerId === me).sort((a, b) => a.name.localeCompare(b.name));
  const others = (topic?.memberIds ?? []).map((id) => botMap[id]).filter((bot) => bot && bot.ownerId !== me);
  const limited = Boolean(topic && topic.ownerId !== me);
  const folders = Object.values(folderMap).sort((a, b) => a.position - b.position);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<TopicIcon>("chat");
  const [allIcons, setAllIcons] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [coordinatorId, setCoordinatorId] = useState("");
  const [brief, setBrief] = useState("");
  const [folderId, setFolderId] = useState<string>("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Who else in the household sees it.
  const myId = useMyId();
  const people = useLive((s) => s.people).filter((person) => person.id !== myId);
  const [peopleIds, setPeopleIds] = useState<string[]>([]);
  const [everyone, setEveryone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(topic?.title ?? ""); setIcon(topic?.icon ?? "chat"); setBrief(topic?.brief ?? ""); setFolderId(topic?.folderId ?? "");
    const start = topic?.memberIds ?? (defaultBotId ? [defaultBotId] : bots.length === 1 ? [bots[0].id] : []);
    setMembers(start); setCoordinatorId(topic?.coordinatorId ?? start[0] ?? ""); setNewFolder(null); setAllIcons(false); setError("");
    setPeopleIds(topic?.peopleIds ?? []); setEveryone(topic?.everyone ?? false);
    // Only when the dialog opens: later edits to the Bot list shouldn't reset what you've typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, topic?.id]);

  const toggle = (id: string) => setMembers((current) => {
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, 6);
    if (!next.includes(coordinatorId)) setCoordinatorId(next[0] ?? "");
    return next;
  });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const folder = newFolder?.trim() ? (await api.createFolder(newFolder.trim())).id : folderId || null;
      const input = { title: title.trim(), icon, brief: brief.trim(), folderId: folder, memberIds: members, coordinatorId: coordinatorId || undefined };
      // Someone else's topic: only your Bots change.
      let chat = limited ? await api.updateTopic(topic!.id, { memberIds: members }) : topic ? await api.updateTopic(topic.id, input) : await api.createTopic(input);
      if (!limited && people.length && (everyone !== chat.everyone || peopleIds.join() !== chat.peopleIds.join())) chat = await api.shareTopic(chat.id, { peopleIds, everyone });
      onOpenChange(false);
      onSaved(chat.id);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save the topic."); }
    finally { setBusy(false); }
  }

  const shown = allIcons ? TOPIC_ICONS : TOPIC_ICONS.slice(0, 11);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={limited ? "Your Bots in this topic" : topic ? "Edit topic" : "New topic"}
      description={limited ? `Bring your own Bots into ${topic!.title}, or take them out.` : topic ? undefined : "A topic is its own conversation for one ongoing thing: a trip, a renovation, a launch."}>
      <form onSubmit={save} className="flex flex-col">
        {!limited && <>
        <Field label="Name" htmlFor="topic-title"><Input id="topic-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} required autoFocus placeholder="Hallway renovation" /></Field>

        <span className="mb-1.5 text-label text-muted">Icon</span>
        <div className="mb-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icon">
          {shown.map((key) => (
            <button key={key} type="button" role="radio" aria-checked={icon === key} aria-label={key} onClick={() => setIcon(key)}
              className={cn("rounded-[11px] outline-offset-1", icon === key && "ring-[1.5px] ring-ink")}>
              <TopicTile icon={key} size={38} active={icon === key} />
            </button>
          ))}
          {!allIcons && (
            <button type="button" onClick={() => setAllIcons(true)} className="flex size-[38px] items-center justify-center rounded-[11px] bg-raised text-meta text-muted hover:text-ink">
              +{TOPIC_ICONS.length - shown.length}
            </button>
          )}
        </div>

        </>}
        <span className="mb-1.5 text-label text-muted">{others.length ? "Your Bots" : "Bots"}</span>
        <div className="mb-1.5 flex flex-wrap gap-2">
          {bots.length === 0 && <p className="m-0 py-1 text-label text-muted">Create a Bot first.</p>}
          {bots.map((bot) => {
            const selected = members.includes(bot.id);
            return (
              <button key={bot.id} type="button" onClick={() => toggle(bot.id)} aria-pressed={selected}
                className={cn("flex h-9 items-center gap-2 rounded-full border pr-3 pl-1.5 text-sm transition-colors",
                  selected ? "border-muted/60 bg-raised text-ink" : "border-dashed border-rule text-muted hover:text-ink")}>
                <Face seed={bot.faceSeed} size={24} title={bot.name} className={cn(!selected && "opacity-50")} />{bot.name}
              </button>
            );
          })}
        </div>
        <p className="m-0 mb-4 text-meta text-muted">
          {members.length > 1 ? "Several Bots work on it together and can hand work to each other." : "Add more Bots and they work on it together."}
        </p>
        {others.length > 0 && (
          <span className="mb-3 flex flex-wrap items-center gap-1.5 text-meta text-muted">
            Also here:{others.map((bot) => <span key={bot!.id} className="flex items-center gap-1.5 rounded-full bg-raised py-0.5 pr-2.5 pl-1 text-label text-soft"><Face seed={bot!.faceSeed} size={18} />{bot!.name}</span>)}
          </span>
        )}
        {members.length > 1 && !limited && (
          <label className="mb-4 flex items-center justify-between gap-3 text-sm">
            <span className="text-soft">Answers unless you @mention another</span>
            <select value={coordinatorId} onChange={(e) => setCoordinatorId(e.target.value)} className="rounded-lg border border-rule bg-ground px-2.5 py-1.5 text-sm text-ink outline-none">
              {members.map((id) => <option key={id} value={id}>{botMap[id]?.name}</option>)}
            </select>
          </label>
        )}

        {!limited && <>
        <Field label="What's it about? Optional" htmlFor="topic-brief">
          <textarea id="topic-brief" value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={2000} rows={3}
            placeholder="Repaint, new lights and a built-in wardrobe. Budget about 25,000 zł, done before Christmas."
            className="w-full resize-y rounded-lg border border-rule bg-ground px-3.5 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-muted focus:border-muted" />
        </Field>

        {people.length > 0 && (
          <div className="mb-4 flex flex-col gap-2 border-t border-rule pt-3 text-sm">
            <span className="flex items-center justify-between gap-3">
              <span>Shared with</span>
              <label className="flex items-center gap-2 text-label text-soft">
                <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} className="size-4 accent-[var(--ink)]" />Everyone
              </label>
            </span>
            {!everyone && (
              <div className="flex flex-wrap gap-2">
                {people.map((person) => {
                  const selected = peopleIds.includes(person.id);
                  return (
                    <button key={person.id} type="button" aria-pressed={selected}
                      onClick={() => setPeopleIds((current) => (selected ? current.filter((id) => id !== person.id) : [...current, person.id]))}
                      className={cn("flex h-9 items-center gap-2 rounded-full border pr-3 pl-1.5 text-sm transition-colors",
                        selected ? "border-muted/60 bg-raised text-ink" : "border-dashed border-rule text-muted hover:text-ink")}>
                      <PersonAvatar person={person} size={24} className={cn(!selected && "opacity-50")} />{person.name}
                    </button>
                  );
                })}
              </div>
            )}
            <span className="text-meta text-muted">{everyone ? "Everyone you've added can see and post here." : peopleIds.length ? "They can see and post here, and its Bots answer them." : "Only you, for now."}</span>
          </div>
        )}

        <div className="mb-4 flex items-center justify-between gap-3 border-t border-rule pt-3 text-sm">
          <span>Folder</span>
          {newFolder === null ? (
            <select value={folderId} onChange={(e) => (e.target.value === "+new" ? setNewFolder("") : setFolderId(e.target.value))}
              className="rounded-lg border border-rule bg-ground px-2.5 py-1.5 text-sm text-ink outline-none">
              <option value="">No folder</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.title}</option>)}
              <option value="+new">New folder…</option>
            </select>
          ) : (
            <Input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} maxLength={40} autoFocus placeholder="Home" className="max-w-44" />
          )}
        </div>
        </>}
        {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !title.trim() || members.length < 1}>{topic ? "Save" : "Create topic"}</Button>
      </form>
    </Dialog>
  );
}
