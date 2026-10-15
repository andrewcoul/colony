import { useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { CalendarClock, Check, ChevronDown, ChevronRight, CircleAlert, CircleDashed, Clock, Copy, CornerDownRight, Globe, Hand, Loader2, Repeat, RotateCcw, ShieldCheck, X } from "lucide-react";
import { describeSchedule } from "@shared/schedule";
import type { Approval, Bot, Card, Message, Step } from "@shared/types";
import { upcoming } from "../lib/dates";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { pop, snappy, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { useCopy } from "../hooks/useCopy";
import { Face } from "./Face";
import { MarkdownView } from "./MarkdownView";
import { Button } from "./ui/button";

type ItemProps = {
  message: Message;
  bot: Bot | undefined;
  showAuthor: boolean;
  /** Who a message of yours goes to, for "Queued · sends when Kenny finishes". */
  recipient?: string;
  onOpenRoutines?: () => void;
  onOpenChat?: (chatId: string) => void;
  onOpenBrowser?: (botId: string) => void;
};

export function MessageItem({ message, bot, showAuthor, recipient, onOpenRoutines, onOpenChat, onOpenBrowser }: ItemProps) {
  if (message.author === "user") return <UserMessage message={message} recipient={recipient ?? "the Bot"} />;
  if (message.author === "system") {
    return <p className="m-0 text-center text-meta text-muted">{message.text}</p>;
  }
  return <BotMessage message={message} bot={bot} showAuthor={showAuthor} onOpenRoutines={onOpenRoutines} onOpenChat={onOpenChat} onOpenBrowser={onOpenBrowser} />;
}

/** Your message. One sent while a Bot worked shows whether it steered the turn or is waiting for it. */
function UserMessage({ message, recipient }: { message: Message; recipient: string }) {
  const queued = message.delivery === "queued";
  const steered = message.delivery === "steer" && message.steeredAt !== null;
  const steering = message.delivery === "steer" && message.steeredAt === null;
  const [busy, setBusy] = useState(false);
  const act = (action: () => Promise<void>) => { setBusy(true); void action().catch(() => {}).finally(() => setBusy(false)); };
  return (
    <div className="flex flex-col items-end gap-1.5">
      <m.div
        className={cn("max-w-[80%] rounded-[22px] border px-[18px] py-3 text-body leading-6 [overflow-wrap:anywhere] whitespace-pre-wrap max-sm:max-w-[88%]",
          queued ? "border-dashed border-muted/50 bg-transparent text-soft" : "bg-raised",
          steered || steering ? "border-mint/45" : !queued && "border-transparent")}
        // When the Bot picks the message up, its outline pulses once.
        initial={false}
        animate={steered ? { boxShadow: ["0 0 0 0 rgb(126 226 184 / 0.5)", "0 0 0 9px rgb(126 226 184 / 0)"] } : { boxShadow: "0 0 0 0 rgb(126 226 184 / 0)" }}
        transition={{ duration: 0.7, ease: "easeOut" }}
      >
        {message.text}
      </m.div>
      <AnimatePresence mode="wait" initial={false}>
        {queued && (
          <m.span key="queued" className="flex flex-wrap items-center justify-end gap-x-1.5 pr-1.5 text-meta text-muted"
            initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={soft}>
            <Clock size={12} />Queued · sends when {recipient} finishes ·
            <button type="button" disabled={busy} className="text-soft hover:text-ink" onClick={() => act(() => api.steerNow(message.id))}>Steer now</button>·
            <button type="button" disabled={busy} className="text-soft hover:text-ink" onClick={() => act(() => api.unqueue(message.id))}>Cancel</button>
          </m.span>
        )}
        {(steered || steering) && (
          <m.span key="steer" className={cn("flex items-center gap-1.5 pr-1.5 text-meta", steered ? "text-mint" : "text-muted")}
            initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} transition={soft}>
            <CornerDownRight size={12} />
            {steered
              ? `Steered · ${recipient} picked this up ${message.steeredAt ? `after step ${message.steeredAt}` : "straight away"}`
              : `Steering · ${recipient} reads this at the next step`}
          </m.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function BotMessage({ message, bot, showAuthor, onOpenRoutines, onOpenChat, onOpenBrowser }: Omit<ItemProps, "recipient">) {
  const streaming = message.status === "streaming";
  const ran = message.cards.find((card) => card.type === "routine" && card.action === "ran");
  const { copied, copy } = useCopy();
  // Cards already on the reply when it appeared don't animate; ones added while it runs pop in.
  const cardsAtMount = useRef(message.cards.length);
  const body = (
    <div className="group flex min-w-0 flex-1 flex-col gap-3">
      {showAuthor && bot && <span className="text-label font-semibold" style={{ color: "var(--soft)" }}>{bot.name}</span>}
      {ran?.type === "routine" && (
        <button type="button" onClick={onOpenRoutines} disabled={!onOpenRoutines}
          className="-mb-1 flex items-center gap-1.5 self-start text-meta text-sky enabled:hover:underline">
          <Repeat size={13} />Routine · {ran.title}
        </button>
      )}
      {message.steps.length > 0 && <StepLog steps={message.steps} live={streaming} />}
      {message.text && <MarkdownView text={message.text} />}
      {!message.text && streaming && message.steps.length === 0 && <Typing />}
      {message.cards.map((card, index) => (
        <m.div key={index} className="flex flex-col" variants={pop} initial={index >= cardsAtMount.current ? "hidden" : false} animate="shown">
          <CardView card={card} author={bot} onOpenRoutines={onOpenRoutines} onOpenChat={onOpenChat} onOpenBrowser={onOpenBrowser} />
        </m.div>
      ))}
      {message.status === "failed" && message.error && (
        <p className="m-0 flex items-center gap-2 rounded-xl bg-danger-wash px-3.5 py-2.5 text-label text-danger"><CircleAlert size={15} />{message.error}</p>
      )}
      {message.status === "stopped" && <p className="m-0 text-meta text-muted">{message.error ?? "Stopped."}</p>}
      {message.text && !streaming && (
        <div className="-ml-1.5 flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
          <Button size="icon-sm" aria-label={copied ? "Copied" : "Copy reply"} onClick={() => void copy(message.text)}>{copied ? <Check size={15} /> : <Copy size={15} />}</Button>
        </div>
      )}
    </div>
  );
  if (!showAuthor || !bot) return body;
  return (
    <div className="flex gap-3">
      <Face seed={bot.faceSeed} state={streaming ? bot.presence : "idle"} size={30} title={bot.name} className="mt-0.5" />
      {body}
    </div>
  );
}

function Typing() {
  return (
    <div className="inline-flex gap-1 py-2" role="status" aria-label="Replying">
      {[0, 150, 300].map((delay) => <i key={delay} className="size-1.5 animate-blink rounded-full bg-muted" style={{ animationDelay: `${delay}ms` }} />)}
    </div>
  );
}

const elapsed = (steps: Step[]) => {
  const start = Math.min(...steps.map((step) => step.startedAt));
  const end = Math.max(...steps.map((step) => step.endedAt ?? Date.now()));
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The "how much do I need to know" log: expanded while working, one line when done. */
function StepLog({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  const RESTART = "colony.restart";
  const work = steps.filter((step) => step.tool !== RESTART);
  // Steps that were already done when the log appeared don't animate; new ones rise in as they start.
  const stepsAtMount = useRef(new Set(steps.map((step) => step.id)));
  const failed = work.filter((step) => step.status === "error").length;
  const denied = work.filter((step) => step.status === "denied").length;
  const problems = [failed && `${failed} didn't work`, denied && `${denied} denied`].filter(Boolean).join(" · ");
  const summary = live
    ? `Working · ${work.length} step${work.length === 1 ? "" : "s"}`
    : `${work.length} step${work.length === 1 ? "" : "s"}${problems ? ` · ${problems}` : " done"} · ${elapsed(work.length ? work : steps)}`;
  return (
    <div className="rounded-xl border border-rule bg-surface">
      <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-label">
        <Swap id={live ? "live" : problems ? "problems" : "done"}>
          {live ? <Loader2 size={15} className="animate-spin text-mint" />
            : problems ? <CircleAlert size={15} className={denied && !failed ? "text-lemon" : "text-coral"} />
            : <Check size={15} className="text-mint" strokeWidth={2.4} />}
        </Swap>
        <span className={cn("flex-1", live ? "font-medium text-ink" : "text-soft")}>{summary}</span>
        <ChevronDown size={15} className={cn("text-muted transition-transform", expanded && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <m.div key="steps" className="overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }} transition={soft}>
            <ol className="m-0 flex list-none flex-col gap-1.5 px-3.5 pb-3 pl-3.5 text-label">
              {steps.map((step) => step.tool === RESTART ? (
                // Where Colony restarted and the turn picked back up.
                <m.li key={step.id} className="flex items-center gap-2.5 py-0.5 text-sky" transition={soft}
                  initial={stepsAtMount.current.has(step.id) ? false : { opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
                  <RotateCcw size={14} className="shrink-0" />
                  <span className="shrink-0">{step.title}</span>
                  <m.span className="h-px flex-1 origin-left bg-rule" initial={stepsAtMount.current.has(step.id) ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ ...soft, delay: 0.1 }} />
                </m.li>
              ) : (
                <m.li key={step.id} className="flex items-center gap-2.5" transition={soft}
                  initial={stepsAtMount.current.has(step.id) ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                  <Swap id={step.status}><StepIcon status={step.status} /></Swap>
                  <span className={cn("min-w-0 flex-1 truncate", step.status === "running" ? "text-ink" : "text-soft")}>{step.title}</span>
                  {step.detail && <span className="shrink-0 truncate text-meta text-muted max-sm:max-w-28">{step.detail}</span>}
                </m.li>
              ))}
            </ol>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** An icon that pops when it changes (a spinner turning into a check), but not when it first appears. */
function Swap({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      <m.span key={id} className="flex shrink-0" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={snappy}>
        {children}
      </m.span>
    </AnimatePresence>
  );
}

function StepIcon({ status }: { status: Step["status"] }) {
  const size = 14;
  if (status === "running") return <Loader2 size={size} className="shrink-0 animate-spin text-mint" />;
  if (status === "waiting") return <Clock size={size} className="shrink-0 text-lemon" />;
  if (status === "error") return <CircleAlert size={size} className="shrink-0 text-coral" />;
  if (status === "denied") return <X size={size} className="shrink-0 text-coral" />;
  if (status === "interrupted") return <CircleDashed size={size} className="shrink-0 text-sky" />;
  return <Check size={size} className="shrink-0 text-mint" strokeWidth={2.4} />;
}

function CardView({ card, author, onOpenRoutines, onOpenChat, onOpenBrowser }: {
  card: Card;
  author: Bot | undefined;
  onOpenRoutines?: () => void;
  onOpenChat?: (chatId: string) => void;
  onOpenBrowser?: (botId: string) => void;
}) {
  if (card.type === "approval") return <ApprovalCard approvalId={card.approvalId} onOpenBrowser={onOpenBrowser} />;
  if (card.type === "routine" && card.action !== "ran") return <RoutineCard card={card} onOpen={onOpenRoutines} />;
  if (card.type === "handoff") return <HandoffCard card={card} author={author} onOpenChat={onOpenChat} />;
  return null;
}

const listNames = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** "6 messages with Tyler and Jenny": the Bots this reply talked to, each thread one tap away. */
function HandoffCard({ card, author, onOpenChat }: { card: Extract<Card, { type: "handoff" }>; author: Bot | undefined; onOpenChat?: (chatId: string) => void }) {
  const bots = useLive((s) => s.bots);
  const chats = useLive((s) => s.chats);
  const [open, setOpen] = useState(false);
  const total = card.threads.reduce((sum, thread) => sum + thread.count, 0);
  const names = card.threads.map((thread) => bots[thread.botId]?.name ?? "a deleted Bot");
  const single = card.threads.length === 1 ? card.threads[0] : null;
  const go = (chatId: string) => { if (chats[chatId]) onOpenChat?.(chatId); };
  return (
    <div className="flex flex-col self-start rounded-xl border border-rule bg-surface max-sm:self-stretch">
      <button type="button" aria-expanded={single ? undefined : open}
        onClick={() => (single ? go(single.chatId) : setOpen(!open))}
        disabled={Boolean(single && !chats[single.chatId])}
        className="flex items-center gap-3 rounded-xl py-2.5 pr-3.5 pl-3 text-left enabled:hover:bg-hover">
        <span className="flex shrink-0">
          {[author, ...card.threads.map((thread) => bots[thread.botId])].filter(Boolean).slice(0, 4).map((bot, index) => (
            <Face key={bot!.id} seed={bot!.faceSeed} size={24} title={bot!.name} className={cn(index > 0 && "-ml-1")} />
          ))}
        </span>
        <span className="min-w-0 flex-1 text-label text-soft">
          {total} message{total === 1 ? "" : "s"} with <strong className="font-medium text-ink">{listNames(names)}</strong>
        </span>
        {single ? <ChevronRight size={15} className="text-muted" /> : <ChevronDown size={15} className={cn("text-muted transition-transform", open && "rotate-180")} />}
      </button>
      {open && !single && (
        <div className="flex flex-col border-t border-rule p-1.5">
          {card.threads.map((thread) => {
            const bot = bots[thread.botId];
            return (
              <button key={thread.chatId} type="button" onClick={() => go(thread.chatId)} disabled={!chats[thread.chatId]}
                className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left text-label enabled:hover:bg-hover">
                {bot && <Face seed={bot.faceSeed} size={22} title={bot.name} />}
                <span className="flex-1 truncate">{bot?.name ?? "A deleted Bot"}</span>
                <span className="text-meta text-muted">{thread.count} message{thread.count === 1 ? "" : "s"}</span>
                <ChevronRight size={14} className="text-muted" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "Created routine · Morning briefing · Every day at 8:00 AM", live from the routine itself. */
function RoutineCard({ card, onOpen }: { card: Extract<Card, { type: "routine" }>; onOpen?: () => void }) {
  const routine = useLive((s) => s.routines[card.routineId]);
  const detail = !routine ? "Deleted"
    : !routine.enabled ? "Paused"
    : `${describeSchedule(routine.schedule)}${routine.nextRunAt ? ` · next ${upcoming(routine.nextRunAt)}` : ""}`;
  return (
    <button type="button" onClick={onOpen} disabled={!onOpen || !routine}
      className="flex items-center gap-3 self-start rounded-xl border border-rule bg-surface py-3 pr-4 pl-3.5 text-left enabled:hover:bg-hover max-sm:self-stretch">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky/14 text-sky"><CalendarClock size={17} /></span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-meta text-muted">{card.action === "created" ? "Created routine" : "Updated routine"}</span>
        <strong className="truncate text-sm">{routine?.title ?? card.title}</strong>
        <span className="truncate text-meta text-soft">{detail}</span>
      </span>
    </button>
  );
}

function ApprovalCard({ approvalId, onOpenBrowser }: { approvalId: string; onOpenBrowser?: (botId: string) => void }) {
  const approval: Approval | undefined = useLive((s) => s.approvals[approvalId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  if (!approval) return <p className="m-0 text-meta text-muted">Approval resolved.</p>;
  const pending = approval.status === "pending";
  const takeover = approval.tool === "browser_takeover";

  async function decide(approve: boolean) {
    setBusy(true); setError("");
    try { await api.decide(approvalId, approve); } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't send that."); }
    finally { setBusy(false); }
  }

  const words = takeover ? { approved: "Handed back", denied: "Cancelled", expired: "Expired" } : { approved: "Approved", denied: "Denied", expired: "Expired" };

  // While it's waiting, the full card; once decided it shrinks to a one-line chip so finished
  // approvals don't crowd the transcript. Tap the chip to see what was asked.
  return (
    <AnimatePresence mode="wait" initial={false}>
      {pending ? (
        <m.div key="card" className="flex flex-col gap-3 rounded-xl border border-lemon/35 bg-lemon/7 p-4"
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }} style={{ originX: 0 }}>
          <span className="flex items-center gap-2 text-label font-semibold text-lemon">
            {takeover ? <Hand size={16} /> : <ShieldCheck size={16} />}{approval.summary}
          </span>
          {takeover
            ? <p className="m-0 text-label leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{approval.detail}</p>
            : <pre className="m-0 overflow-x-auto rounded-lg bg-surface px-3 py-2.5 font-mono text-[13px] leading-5 whitespace-pre-wrap text-ink">{approval.detail}</pre>}
          <div className="flex flex-wrap items-center gap-2">
            {takeover && onOpenBrowser && (
              <Button variant="primary" size="pill" className="px-4" onClick={() => onOpenBrowser(approval.botId)}><Globe size={14} />Open browser</Button>
            )}
            <Button variant={takeover ? "outline" : "primary"} size="pill" className="px-4" disabled={busy} onClick={() => void decide(true)}>{takeover ? "I'm done" : "Approve"}</Button>
            <Button variant="outline" size="pill" className="px-4" disabled={busy} onClick={() => void decide(false)}>{takeover ? "Cancel" : "Deny"}</Button>
            {approval.reason && <span className="ml-auto text-meta text-muted">{approval.reason}</span>}
          </div>
          {error && <span className="text-meta text-danger">{error}</span>}
        </m.div>
      ) : (
        <m.div key="chip" className="flex flex-col items-start gap-2" initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }}
          transition={snappy} style={{ originX: 0 }}>
          <button type="button" onClick={() => setShowDetail(!showDetail)} aria-expanded={showDetail}
            className={cn("flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-meta",
              approval.status === "approved" ? "border-mint/25 bg-mint/8 text-mint" : approval.status === "denied" ? "border-coral/25 bg-coral/8 text-coral" : "border-rule text-muted")}>
            {approval.status === "approved" ? <Check size={13} strokeWidth={2.4} /> : approval.status === "denied" ? <X size={13} /> : <Clock size={13} />}
            <span className="truncate">{words[approval.status as "approved"]} · {approval.summary}</span>
          </button>
          <AnimatePresence initial={false}>
            {showDetail && (
              <m.pre key="detail" className="m-0 max-w-full overflow-hidden rounded-lg bg-surface px-3 py-2.5 font-mono text-[13px] leading-5 whitespace-pre-wrap text-soft"
                initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={soft}>
                {approval.detail}
              </m.pre>
            )}
          </AnimatePresence>
        </m.div>
      )}
    </AnimatePresence>
  );
}
