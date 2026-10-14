import { useState } from "react";
import { CalendarClock, Check, ChevronDown, CircleAlert, Clock, Copy, Loader2, Repeat, ShieldCheck, X } from "lucide-react";
import { describeSchedule } from "@shared/schedule";
import type { Approval, Bot, Card, Message, Step } from "@shared/types";
import { upcoming } from "../lib/dates";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { cn } from "../lib/utils";
import { useCopy } from "../hooks/useCopy";
import { Face } from "./Face";
import { MarkdownView } from "./MarkdownView";
import { Button } from "./ui/button";

type ItemProps = { message: Message; bot: Bot | undefined; showAuthor: boolean; onOpenRoutines?: () => void };

export function MessageItem({ message, bot, showAuthor, onOpenRoutines }: ItemProps) {
  if (message.author === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-[22px] bg-raised px-[18px] py-3 text-body leading-6 [overflow-wrap:anywhere] whitespace-pre-wrap max-sm:max-w-[88%]">
          {message.text}
        </div>
      </div>
    );
  }
  if (message.author === "system") {
    return <p className="m-0 text-center text-meta text-muted">{message.text}</p>;
  }
  return <BotMessage message={message} bot={bot} showAuthor={showAuthor} onOpenRoutines={onOpenRoutines} />;
}

function BotMessage({ message, bot, showAuthor, onOpenRoutines }: ItemProps) {
  const streaming = message.status === "streaming";
  const ran = message.cards.find((card) => card.type === "routine" && card.action === "ran");
  const { copied, copy } = useCopy();
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
      {message.cards.map((card, index) => <CardView key={index} card={card} onOpenRoutines={onOpenRoutines} />)}
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
  const failed = steps.filter((step) => step.status === "error").length;
  const denied = steps.filter((step) => step.status === "denied").length;
  const problems = [failed && `${failed} didn't work`, denied && `${denied} denied`].filter(Boolean).join(" · ");
  const summary = live
    ? `Working · ${steps.length} step${steps.length === 1 ? "" : "s"}`
    : `${steps.length} step${steps.length === 1 ? "" : "s"}${problems ? ` · ${problems}` : " done"} · ${elapsed(steps)}`;
  return (
    <div className="rounded-xl border border-rule bg-surface">
      <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-label">
        {live ? <Loader2 size={15} className="animate-spin text-mint" />
          : problems ? <CircleAlert size={15} className={denied && !failed ? "text-lemon" : "text-coral"} />
          : <Check size={15} className="text-mint" strokeWidth={2.4} />}
        <span className={cn("flex-1", live ? "font-medium text-ink" : "text-soft")}>{summary}</span>
        <ChevronDown size={15} className={cn("text-muted transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <ol className="m-0 flex list-none flex-col gap-1.5 px-3.5 pb-3 pl-3.5 text-label">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2.5">
              <StepIcon status={step.status} />
              <span className={cn("min-w-0 flex-1 truncate", step.status === "running" ? "text-ink" : "text-soft")}>{step.title}</span>
              {step.detail && <span className="shrink-0 truncate text-meta text-muted max-sm:max-w-28">{step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: Step["status"] }) {
  const size = 14;
  if (status === "running") return <Loader2 size={size} className="shrink-0 animate-spin text-mint" />;
  if (status === "waiting") return <Clock size={size} className="shrink-0 text-lemon" />;
  if (status === "error") return <CircleAlert size={size} className="shrink-0 text-coral" />;
  if (status === "denied") return <X size={size} className="shrink-0 text-coral" />;
  return <Check size={size} className="shrink-0 text-mint" strokeWidth={2.4} />;
}

function CardView({ card, onOpenRoutines }: { card: Card; onOpenRoutines?: () => void }) {
  if (card.type === "approval") return <ApprovalCard approvalId={card.approvalId} />;
  if (card.type === "routine" && card.action !== "ran") return <RoutineCard card={card} onOpen={onOpenRoutines} />;
  return null; // Handoff cards arrive with bot-to-bot messaging.
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

function ApprovalCard({ approvalId }: { approvalId: string }) {
  const approval: Approval | undefined = useLive((s) => s.approvals[approvalId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!approval) return <p className="m-0 text-meta text-muted">Approval resolved.</p>;
  const pending = approval.status === "pending";

  async function decide(approve: boolean) {
    setBusy(true); setError("");
    try { await api.decide(approvalId, approve); } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't send that."); }
    finally { setBusy(false); }
  }

  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border p-4", pending ? "border-lemon/35 bg-lemon/7" : "border-rule bg-surface")}>
      <span className={cn("flex items-center gap-2 text-label font-semibold", pending ? "text-lemon" : "text-soft")}>
        <ShieldCheck size={16} />{approval.summary}
      </span>
      <pre className="m-0 overflow-x-auto rounded-lg bg-surface px-3 py-2.5 font-mono text-[13px] leading-5 whitespace-pre-wrap text-ink">{approval.detail}</pre>
      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="pill" className="px-4" disabled={busy} onClick={() => void decide(true)}>Approve</Button>
          <Button variant="outline" size="pill" className="px-4" disabled={busy} onClick={() => void decide(false)}>Deny</Button>
          {approval.reason && <span className="ml-auto text-meta text-muted">{approval.reason}</span>}
        </div>
      ) : (
        <span className="text-meta text-muted">{{ approved: "Approved", denied: "Denied", expired: "Expired" }[approval.status as "approved"]}</span>
      )}
      {error && <span className="text-meta text-danger">{error}</span>}
    </div>
  );
}
