import { useEffect, useState } from "react";
import { CalendarClock, ChevronLeft, MoreHorizontal, Play, Plus, Trash2, X } from "lucide-react";
import { describeSchedule } from "@shared/schedule";
import type { Bot, Routine, Schedule } from "@shared/types";
import { api } from "../lib/api";
import { upcoming } from "../lib/dates";
import { useLive } from "../lib/live";
import { cn } from "../lib/utils";
import { SidePanel } from "./SidePanel";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";

/** A Bot's routines: standing work it does on a schedule. */
export function RoutinesPanel({ bot, phone, onClose, onError }: { bot: Bot; phone: boolean; onClose: () => void; onError: (message: string) => void }) {
  const all = useLive((s) => s.routines);
  const chats = useLive((s) => s.chats);
  const routines = Object.values(all).filter((routine) => routine.botId === bot.id).sort((a, b) => a.createdAt - b.createdAt);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const current = editing && editing !== "new" ? all[editing.id] : null;

  // A routine deleted elsewhere closes its editor.
  useEffect(() => { if (editing && editing !== "new" && !current) setEditing(null); }, [editing, current]);

  const run = (routine: Routine) => void api.runRoutine(routine.id).catch((failure) => onError(failure instanceof Error ? failure.message : "Couldn't run it."));

  return (
    <SidePanel label={`${bot.name}'s routines`} phone={phone}>
      <div className="flex items-center gap-2.5">
        {editing ? (
          <Button size="icon-sm" aria-label="Back to routines" className="-ml-1" onClick={() => setEditing(null)}><ChevronLeft size={17} /></Button>
        ) : <CalendarClock size={16} className="text-sky" />}
        <strong className="min-w-0 flex-1 truncate text-sm">{editing === "new" ? "New routine" : current ? current.title : `${bot.name}'s routines`}</strong>
        {!editing && <Button variant="outline" size="pill" onClick={() => setEditing("new")}><Plus size={14} />New</Button>}
        <Button size="icon-sm" aria-label="Close" onClick={onClose}><X size={16} /></Button>
      </div>

      {editing ? (
        <RoutineEditor key={current?.id ?? "new"} bot={bot} routine={current} onDone={() => setEditing(null)} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {routines.length === 0 && (
            <p className="m-0 rounded-xl border border-dashed border-rule p-4 text-label leading-relaxed text-muted">
              No routines yet. Ask {bot.name} in chat ("every weekday at 8, brief me on…") or add one here. Results post to the chat and ping your phone.
            </p>
          )}
          {routines.map((routine) => (
            <div key={routine.id} className="flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3">
              <button type="button" onClick={() => setEditing(routine)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                <span className={cn("truncate text-sm font-medium", !routine.enabled && "text-soft")}>{routine.title}</span>
                <span className="truncate text-meta text-muted">
                  {routine.enabled ? describeSchedule(routine.schedule) : "Paused"}
                  {routine.enabled && routine.nextRunAt && ` · next ${upcoming(routine.nextRunAt)}`}
                </span>
                {(routine.lastStatus === "failed" || routine.chatId !== bot.chatId) && (
                  <span className="truncate text-meta text-muted">
                    {routine.lastStatus === "failed" && <span className="text-coral">Last run didn't finish</span>}
                    {routine.lastStatus === "failed" && routine.chatId !== bot.chatId && " · "}
                    {routine.chatId !== bot.chatId && `Posts to ${chats[routine.chatId]?.title ?? "a group"}`}
                  </span>
                )}
              </button>
              <Toggle checked={routine.enabled} label={routine.enabled ? "Pause" : "Resume"}
                onChange={(enabled) => void api.updateRoutine(routine.id, { enabled }).catch(() => onError("Couldn't update the routine."))} />
              <MenuRoot>
                <MenuTrigger><Button size="icon-sm" aria-label={`${routine.title} options`}><MoreHorizontal size={16} /></Button></MenuTrigger>
                <MenuContent>
                  <MenuItem onClick={() => run(routine)}><Play size={15} />Run now</MenuItem>
                  <MenuItem onClick={() => setEditing(routine)}><CalendarClock size={15} />Edit</MenuItem>
                  <MenuItem className="text-danger" onClick={() => { if (confirm(`Delete the routine "${routine.title}"?`)) void api.deleteRoutine(routine.id); }}><Trash2 size={15} />Delete</MenuItem>
                </MenuContent>
              </MenuRoot>
            </div>
          ))}
        </div>
      )}
      <span className="text-meta text-muted">Runs on your PC while Colony is running · local time</span>
    </SidePanel>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cn("flex h-6 w-10 shrink-0 items-center rounded-full p-[3px] transition-colors", checked ? "justify-end bg-sky" : "justify-start bg-raised")}>
      <span className={cn("size-[18px] rounded-full", checked ? "bg-ground" : "bg-muted")} />
    </button>
  );
}

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const INTERVALS = [30, 60, 120, 180, 240, 360, 480, 720];
const pad = (value: number) => String(value).padStart(2, "0");
const localInput = (time: number) => { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function RoutineEditor({ bot, routine, onDone }: { bot: Bot; routine: Routine | null; onDone: () => void }) {
  const initial: Schedule = routine?.schedule ?? { type: "daily", time: "08:00", days: [] };
  const [title, setTitle] = useState(routine?.title ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [type, setType] = useState<Schedule["type"]>(initial.type);
  const [time, setTime] = useState(initial.type === "daily" ? initial.time : "08:00");
  const [days, setDays] = useState<number[]>(initial.type === "daily" ? initial.days : []);
  const [minutes, setMinutes] = useState(initial.type === "interval" ? initial.minutes : 60);
  const [at, setAt] = useState(initial.type === "once" ? localInput(initial.at) : localInput(Date.now() + 60 * 60_000));
  // Mailboxes this Bot can read, for routines that run when mail arrives.
  const accounts = useLive((s) => s.accounts);
  const access = useLive((s) => s.access);
  const mailboxes = accounts.filter((account) => account.kind !== "onepassword"
    && access.some((item) => item.botId === bot.id && item.accountId === account.id && item.mail !== "none"));
  const [accountId, setAccountId] = useState(initial.type === "mail" ? initial.accountId : mailboxes[0]?.id ?? "");
  const [from, setFrom] = useState(initial.type === "mail" ? initial.from ?? "" : "");
  const [subject, setSubject] = useState(initial.type === "mail" ? initial.subject ?? "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const invalidOnce = type === "once" && Number.isNaN(new Date(at).getTime());
  const schedule: Schedule = type === "daily" ? { type, time, days }
    : type === "interval" ? { type, minutes }
    : type === "mail" ? { type, accountId, ...(from.trim() ? { from: from.trim() } : {}), ...(subject.trim() ? { subject: subject.trim() } : {}) }
    : { type, at: new Date(at).getTime() };
  // No days selected means every day, so start from all seven; keep at least one.
  const toggleDay = (day: number) => setDays((current) => {
    const selected = current.length ? current : [0, 1, 2, 3, 4, 5, 6];
    const next = selected.includes(day) ? selected.filter((item) => item !== day) : [...selected, day].sort();
    return next.length === 7 ? [] : next.length ? next : selected;
  });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const input = { title: title.trim(), prompt: prompt.trim(), schedule };
      if (routine) await api.updateRoutine(routine.id, input);
      else await api.createRoutine(bot.id, input);
      onDone();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save the routine."); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Field label="Name" htmlFor="routine-title"><Input id="routine-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required placeholder="Morning briefing" autoFocus={!routine} /></Field>
      <Field label={`What should ${bot.name} do each time?`} htmlFor="routine-prompt">
        <textarea id="routine-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} rows={4} required
          placeholder="Check overnight news about our competitors and summarise anything that matters in five bullets."
          className="w-full resize-y rounded-lg border border-rule bg-ground px-3.5 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-muted focus:border-muted" />
      </Field>

      <span className="mb-1.5 text-label text-muted">When</span>
      <div className="mb-3 flex rounded-full bg-raised p-[3px]" role="radiogroup" aria-label="Schedule type">
        {([["daily", "Daily"], ["interval", "Repeat"], ["once", "Once"], ...(mailboxes.length || initial.type === "mail" ? [["mail", "New mail"]] as const : [])] as const).map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={type === value} onClick={() => setType(value)}
            className={cn("h-7 flex-1 rounded-full text-meta", type === value ? "bg-ground text-ink" : "text-muted hover:text-ink")}>{label}</button>
        ))}
      </div>
      {type === "daily" && (
        <div className="mb-3.5 flex flex-col gap-3">
          <Input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} required className="w-36 [color-scheme:dark]" />
          <div className="flex gap-1.5">
            {DAYS.map((label, day) => {
              const on = days.length === 0 || days.includes(day);
              return (
                <button key={day} type="button" aria-pressed={on} aria-label={DAY_LABELS[day]} onClick={() => toggleDay(day)}
                  className={cn("size-9 rounded-full text-meta font-medium", on ? "bg-sky/16 text-sky" : "bg-raised text-muted")}>{label}</button>
              );
            })}
          </div>
        </div>
      )}
      {type === "interval" && (
        <select aria-label="Repeat every" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}
          className="mb-3.5 h-[42px] w-48 rounded-lg border border-rule bg-ground px-3 text-sm text-ink outline-none">
          {INTERVALS.map((value) => <option key={value} value={value}>{describeSchedule({ type: "interval", minutes: value })}</option>)}
        </select>
      )}
      {type === "once" && (
        <Input type="datetime-local" aria-label="Date and time" value={at} onChange={(e) => setAt(e.target.value)} required className="mb-3.5 w-60 [color-scheme:dark]" />
      )}
      {type === "mail" && (
        <div className="mb-3.5 flex flex-col gap-2">
          <select aria-label="Mailbox" value={accountId} onChange={(e) => setAccountId(e.target.value)}
            className="h-[42px] w-full rounded-lg border border-rule bg-ground px-3 text-sm text-ink outline-none">
            {mailboxes.length === 0 && <option value={accountId}>No mailbox {bot.name} can read</option>}
            {mailboxes.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.email}</option>)}
          </select>
          <Input aria-label="Only mail from" value={from} onChange={(e) => setFrom(e.target.value)} maxLength={200} placeholder="Only from… (optional, e.g. @bank.com)" />
          <Input aria-label="Only mail about" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Subject contains… (optional)" />
          <span className="text-meta text-muted">Checked every couple of minutes; mail arriving close together goes into one run, at most every 10 minutes.</span>
        </div>
      )}
      <p className="m-0 mb-4 text-meta text-muted">{invalidOnce ? "Pick a date and time" : describeSchedule(schedule)}</p>

      {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
      <div className="mt-auto flex gap-2">
        <Button type="submit" variant="primary" className="flex-1" disabled={busy || !title.trim() || !prompt.trim() || (type === "mail" && !mailboxes.some((account) => account.id === accountId))}>{busy ? "Saving…" : routine ? "Save" : "Create routine"}</Button>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
