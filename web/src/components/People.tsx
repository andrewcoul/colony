import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { Person } from "@shared/types";
import { api } from "../lib/api";
import { HOST_ID, useLive, useMyId } from "../lib/live";
import { pop, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { CROWN } from "./Logo";
import { Input } from "./ui/input";

const COLORS = ["#7CC4FA", "#7EE2B8", "#FFB38A", "#C5A6FF", "#FF8A9A", "#FFE07A"];

/** A person's dot: their initial on their color. The host wears the crown. */
export function PersonAvatar({ person, size = 28, className }: { person: Pick<Person, "id" | "name" | "color">; size?: number; className?: string }) {
  const crown = person.id === HOST_ID;
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

/** Your own row: name, color, and what Bots know about you. */
function You({ person, onError }: { person: Person; onError: (message: string) => void }) {
  const loadAbout = useMemo(() => () => api.personAbout(person.id), [person.id]);
  const update = (patch: Partial<Pick<Person, "name" | "color">>) => void api.updatePerson(person.id, patch).catch((failure) => onError(failure instanceof Error ? failure.message : "Couldn't save that."));
  return (
    <div className="flex flex-col gap-3 border-t border-rule px-4 py-3">
      <div className="flex items-center gap-2">
        <Input aria-label="Your name" defaultValue={person.name} className="h-9 flex-1"
          onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== person.name) update({ name }); }} />
        <div className="flex gap-1" role="radiogroup" aria-label="Your color">
          {COLORS.map((color) => (
            <button key={color} type="button" role="radio" aria-checked={person.color === color} aria-label={color} onClick={() => update({ color })}
              className={cn("size-6 rounded-full ring-offset-2 ring-offset-raised", person.color === color && "ring-2 ring-ink")} style={{ background: color }} />
          ))}
        </div>
      </div>
      <Notes key={person.id} label="What your Bots know about you (USER.md)" placeholder="e.g. Vegetarian. Prefers window seats. Works Tuesdays."
        load={loadAbout} save={(text) => api.setPersonAbout(person.id, text)} />
    </div>
  );
}

/** Settings › Family: who's here and how many Bots each has. Nobody manages anyone else. */
export function FamilySettings({ onBack }: { onBack: () => void }) {
  const myId = useMyId();
  const people = useLive((s) => s.people);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.family().then((rows) => setCounts(Object.fromEntries(rows.map((row) => [row.person.id, row.bots])))).catch(() => {}); }, [people]);
  const ordered = [...people].sort((a, b) => Number(b.id === HOST_ID) - Number(a.id === HOST_ID) || a.createdAt - b.createdAt);

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="-mt-1 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>
      <p className="m-0 text-label leading-relaxed text-soft">
        Everyone on the tailnet is family: they can make their own Bots and share topics with each other. Each person's Bots, chats and keys are theirs alone.
      </p>

      <div className="flex flex-col rounded-xl border border-rule">
        {ordered.map((person, index) => {
          const you = person.id === myId;
          const bots = counts[person.id] ?? 0;
          return (
            <m.div key={person.id} layout transition={soft} className={cn(index > 0 && "border-t border-rule")}>
              <button type="button" disabled={!you} onClick={() => setOpen(!open)} aria-expanded={you ? open : undefined}
                className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left disabled:cursor-default">
                <PersonAvatar person={person} size={32} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-baseline gap-2">
                    <strong className="text-[15px] font-semibold">{person.name}</strong>
                    <span className="truncate text-meta text-muted">
                      {[person.id === HOST_ID ? "runs this Colony" : null, you ? "you" : null, person.login].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="text-label text-soft">{bots} Bot{bots === 1 ? "" : "s"}</span>
                </span>
                {you && <ChevronDown size={16} className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} />}
              </button>
              <AnimatePresence initial={false}>
                {you && open && (
                  <m.div key="you" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={soft} className="overflow-hidden">
                    <You person={person} onError={setError} />
                  </m.div>
                )}
              </AnimatePresence>
            </m.div>
          );
        })}
      </div>

      <Notes label="What every Bot knows about the household (HOUSEHOLD.md)" placeholder="e.g. Two adults and a dog. Groceries on Saturdays. The car is shared."
        load={api.household} save={api.setHousehold} />

      <p className="m-0 text-meta leading-relaxed text-muted">
        Nobody manages anyone else's Bots, accounts or PC. To keep someone out of Colony entirely, change who's on the tailnet in Tailscale.
        Everything is stored on the PC Colony runs on, so it's private in the app, not from that computer.
      </p>
      {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
    </div>
  );
}
