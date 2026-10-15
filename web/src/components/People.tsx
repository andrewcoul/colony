import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, Trash2, UserPlus, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { Person } from "@shared/types";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { pop, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { CROWN } from "./Logo";
import { TopicTile } from "./TopicIcon";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const COLORS = ["#7CC4FA", "#7EE2B8", "#FFB38A", "#C5A6FF", "#FF8A9A", "#FFE07A"];

/** A person's dot: their initial on their color. The owner (the King) wears the crown. */
export function PersonAvatar({ person, size = 28, className }: { person: Pick<Person, "name" | "color" | "role">; size?: number; className?: string }) {
  const crown = person.role === "owner";
  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }} title={person.name}>
      <span className="grid size-full place-items-center rounded-full font-semibold text-[#141414]" style={{ background: person.color, fontSize: size * 0.44 }}>
        {person.name.trim().charAt(0).toUpperCase() || "?"}
      </span>
      {crown && (
        <svg viewBox="11.5 1.5 17 10" aria-hidden className="absolute" style={{ width: size * 0.62, top: -size * 0.3, left: size * 0.19, transform: "rotate(-10deg)" }}>
          <path d={CROWN} fill="#0F0F0F" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" paintOrder="stroke" />
        </svg>
      )}
    </span>
  );
}

/** A note Bots keep about someone (USER.md) or the household (HOUSEHOLD.md), saved when you leave the box. */
function Notes({ load, save, placeholder, label }: { load: () => Promise<{ text: string }>; save: (text: string) => Promise<void>; placeholder: string; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { void load().then((value) => setText(value.text)).catch(() => setText("")); }, [load]);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-meta text-muted">{label}{saved && <m.span variants={pop} initial="hidden" animate="shown" className="text-mint"><Check size={12} /></m.span>}</span>
      <textarea value={text ?? ""} disabled={text === null} placeholder={placeholder} rows={3}
        onChange={(event) => { setText(event.target.value); setSaved(false); }}
        onBlur={() => void save(text ?? "").then(() => setSaved(true))}
        className="w-full resize-y rounded-lg border border-rule bg-ground px-3 py-2 text-label leading-relaxed text-ink outline-none placeholder:text-muted focus:border-muted" />
    </label>
  );
}

function PersonCard({ person, onError }: { person: Person; onError: (message: string) => void }) {
  const chats = useLive((s) => s.chats);
  const [open, setOpen] = useState(false);
  const owner = person.role === "owner";
  const topics = useMemo(() => Object.values(chats).filter((chat) => chat.kind === "topic" && !chat.archivedAt).sort((a, b) => a.title.localeCompare(b.title)), [chats]);
  const shared = topics.filter((chat) => chat.everyone || chat.peopleIds.includes(person.id));
  const fail = (failure: unknown) => onError(failure instanceof Error ? failure.message : "Couldn't save that.");
  const update = (patch: Partial<Pick<Person, "name" | "color">>) => void api.updatePerson(person.id, patch).catch(fail);
  const loadAbout = useMemo(() => () => api.personAbout(person.id), [person.id]);

  return (
    <m.div layout transition={soft} className="flex flex-col rounded-xl border border-rule">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-3 px-3.5 py-3 text-left" aria-expanded={open}>
        <PersonAvatar person={person} size={30} />
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm font-medium">{person.name}{owner && <span className="ml-1.5 font-normal text-muted">· runs Colony</span>}</strong>
          <span className="truncate text-meta text-muted">
            {person.login ?? "This PC"} · {owner ? "everything" : shared.length ? `${shared.length} topic${shared.length === 1 ? "" : "s"}` : "no topics yet"}
          </span>
        </span>
        <ChevronDown size={16} className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={soft} className="overflow-hidden">
            <div className="flex flex-col gap-3 border-t border-rule px-3.5 py-3">
              <div className="flex items-center gap-2">
                <Input aria-label="Name" defaultValue={person.name} className="h-9 flex-1"
                  onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== person.name) update({ name }); }} />
                <div className="flex gap-1" role="radiogroup" aria-label="Color">
                  {COLORS.map((color) => (
                    <button key={color} type="button" role="radio" aria-checked={person.color === color} aria-label={color} onClick={() => update({ color })}
                      className={cn("size-6 rounded-full ring-offset-2 ring-offset-raised", person.color === color && "ring-2 ring-ink")} style={{ background: color }} />
                  ))}
                </div>
              </div>
              <Notes key={person.id} label={owner ? "What Bots know about you (USER.md)" : `What Bots know about ${person.name} (their USER.md)`}
                placeholder={owner ? "Bots keep this up to date as they learn about you." : `e.g. Vegetarian. Prefers window seats. Works Tuesdays.`}
                load={loadAbout} save={(text) => api.setPersonAbout(person.id, text)} />
              {!owner && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-meta text-muted">Topics {person.name} can see and post in</span>
                  {topics.length === 0 && <span className="text-meta text-muted">No topics yet.</span>}
                  <div className="flex flex-col">
                    {topics.map((chat) => {
                      const on = chat.everyone || chat.peopleIds.includes(person.id);
                      return (
                        <label key={chat.id} className={cn("flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-sm hover:bg-hover", chat.everyone && "opacity-70")}>
                          <TopicTile icon={chat.icon} size={24} />
                          <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                          {chat.everyone && <span className="text-meta text-muted">Everyone</span>}
                          <input type="checkbox" checked={on} disabled={chat.everyone} className="size-4 accent-[var(--ink)]"
                            onChange={(event) => void api.shareTopic(chat.id, { peopleIds: event.target.checked ? [...chat.peopleIds, person.id] : chat.peopleIds.filter((id) => id !== person.id) }).catch(fail)} />
                        </label>
                      );
                    })}
                  </div>
                  <Button variant="ghost" size="pill" className="self-start text-danger hover:text-danger"
                    onClick={() => { if (confirm(`Remove ${person.name}? They lose access to every topic; their messages stay.`)) void api.removePerson(person.id).catch(fail); }}>
                    <Trash2 size={14} />Remove {person.name}
                  </Button>
                </div>
              )}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}

/** Settings › People: who's in the household, what each can see, and logins waiting to be let in. */
export function PeopleSettings({ onBack }: { onBack: () => void }) {
  const people = useLive((s) => s.people);
  const [error, setError] = useState("");
  const pending = people.filter((person) => person.role === "pending");
  const household = people.filter((person) => person.role === "owner" || person.role === "member");
  const ignored = people.filter((person) => person.role === "ignored");
  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : "Couldn't save that.");

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="-mt-1 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>
      <p className="m-0 text-label leading-relaxed text-soft">
        Everyone on your tailnet is known by their Tailscale login; there are no Colony accounts. People see only the topics you share with them, and Bots answer them there.
        Settings, accounts, approvals and Bots' own chats stay yours.
      </p>

      <AnimatePresence initial={false}>
        {pending.map((person) => (
          <m.div key={person.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={soft}
            className="flex items-center gap-3 rounded-xl border border-lemon/30 bg-lemon/8 px-3.5 py-3">
            <PersonAvatar person={person} size={30} />
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="text-sm font-medium">New person waiting</strong>
              <span className="truncate text-meta text-soft">{person.login} opened Colony</span>
            </span>
            <Button variant="ghost" size="icon" aria-label={`Ignore ${person.login}`} onClick={() => void api.updatePerson(person.id, { role: "ignored" }).catch(fail)}><X size={16} /></Button>
            <Button variant="primary" size="pill" onClick={() => void api.updatePerson(person.id, { role: "member" }).catch(fail)}><UserPlus size={14} />Add</Button>
          </m.div>
        ))}
      </AnimatePresence>

      <div className="flex flex-col gap-2">
        {household.map((person) => <PersonCard key={person.id} person={person} onError={setError} />)}
        {household.length === 1 && (
          <p className="m-0 text-meta leading-relaxed text-muted">
            To add someone, share your tailnet with them (or have them sign in on a shared device) and open Colony; they'll show up here to add.
          </p>
        )}
      </div>

      <Notes label="What every Bot knows about the household (HOUSEHOLD.md)" placeholder="e.g. Two adults and a dog. Groceries on Saturdays. The car is shared."
        load={api.household} save={api.setHousehold} />

      {ignored.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-meta text-muted">Ignored logins</span>
          {ignored.map((person) => (
            <div key={person.id} className="flex items-center gap-2 text-label text-muted">
              <span className="min-w-0 flex-1 truncate">{person.login}</span>
              <Button variant="ghost" size="pill" onClick={() => void api.updatePerson(person.id, { role: "member" }).catch(fail)}>Add after all</Button>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
    </div>
  );
}
