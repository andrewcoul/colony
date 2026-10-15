import { useEffect, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { MessageSquare, Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import type { Bot, Presence } from "@shared/types";
import { api } from "../lib/api";
import { endCall, nextSpeed, setCallMuted, setCallSpeed, startCall, type CallSnapshot } from "../lib/call";
import { useLive, type RingingCall } from "../lib/live";
import { bouncy, fade, snappy, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { Button } from "./ui/button";

const STATUS: Record<CallSnapshot["status"], string> = {
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking…",
  speaking: "Talking",
  ended: "Call ended",
  failed: "Call failed",
};

/** The Bot the call is with: the one that rang, or the one who leads the chat. */
export function useCallBot(call: CallSnapshot | null): Bot | undefined {
  return useLive((s) => {
    const chat = call ? s.chats[call.chatId] : undefined;
    const id = call?.botId ?? chat?.coordinatorId ?? chat?.memberIds[0];
    return id ? s.bots[id] : undefined;
  });
}

const facePresence = (call: CallSnapshot, bot?: Bot): Presence =>
  call.status === "speaking" ? "working" : call.status === "thinking" ? (bot?.presence === "working" ? "working" : "thinking") : "idle";

/** What's happening, in a few words (with what the Bot's doing if it's using tools). */
function statusLine(call: CallSnapshot, bot?: Bot) {
  if (call.muted && call.status === "listening") return "Muted";
  if (call.status === "thinking" && bot?.presence === "working" && bot.activity) return bot.activity;
  return STATUS[call.status];
}

function useDuration(startedAt: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Five bars that follow a level. */
function Level({ level, className }: { level: number; className?: string }) {
  return (
    <span className={cn("flex h-4 items-center gap-[3px]", className)} aria-hidden>
      {[0.5, 0.8, 1, 0.8, 0.5].map((weight, index) => (
        <m.span key={index} className="w-[3px] rounded-full bg-current" animate={{ height: 4 + Math.min(1, level * weight * 1.6) * 12 }} transition={snappy} />
      ))}
    </span>
  );
}

function Controls({ call, compact, onMinimize }: { call: CallSnapshot; compact?: boolean; onMinimize?: () => void }) {
  const live = call.status !== "failed" && call.status !== "ended";
  const size = compact ? "icon" : "default";
  return (
    <div className={cn("flex items-center", compact ? "gap-1" : "gap-4")}>
      {live && (
        <Button variant="toggle" size={size} aria-pressed={call.muted} aria-label={call.muted ? "Unmute" : "Mute"} onClick={() => setCallMuted(!call.muted)}
          className={cn(!compact && "size-14 rounded-full p-0", call.muted && "text-danger")}>
          {call.muted ? <MicOff size={compact ? 16 : 22} /> : <Mic size={compact ? 16 : 22} />}
        </Button>
      )}
      {live && (
        <Button variant="toggle" size={compact ? "pill" : "default"} aria-label={`Voice speed ${call.speed}×`} onClick={() => setCallSpeed(nextSpeed(call.speed))}
          className={cn("tabular-nums", compact ? "px-2.5" : "h-14 min-w-14 rounded-full px-0 text-[15px]")}>
          {call.speed}×
        </Button>
      )}
      {onMinimize && (
        <Button variant="toggle" size={size} aria-label="Show the chat" onClick={onMinimize} className={cn(!compact && "size-14 rounded-full p-0")}>
          <MessageSquare size={compact ? 16 : 22} />
        </Button>
      )}
      <Button variant="danger" size={size} aria-label={live ? "End call" : "Close"} onClick={endCall} className={cn(!compact && "size-14 rounded-full p-0")}>
        <PhoneOff size={compact ? 16 : 22} />
      </Button>
    </div>
  );
}

/** 5a: the call on a phone, full screen. */
export function CallScreen({ call, onMinimize }: { call: CallSnapshot; onMinimize: () => void }) {
  const bot = useCallBot(call);
  const duration = useDuration(call.startedAt);
  const caption = call.status === "speaking" ? call.saying : call.heard;
  return (
    <m.div className="fixed inset-0 z-40 flex flex-col items-center bg-ground px-6 pt-[max(env(safe-area-inset-top),24px)] pb-[max(env(safe-area-inset-bottom),28px)]"
      initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }} transition={soft}>
      <p className="m-0 text-meta text-muted tabular-nums">{call.status === "failed" ? "" : duration}</p>
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <div className="relative grid place-items-center">
          {/* The Bot's voice pushes a soft ring out from its face. */}
          <m.span className="absolute size-44 rounded-full bg-sky/15" animate={{ scale: 1 + call.botLevel * 0.35, opacity: call.status === "speaking" ? 1 : 0.4 }} transition={snappy} />
          {bot && <Face seed={bot.faceSeed} state={facePresence(call, bot)} size={128} title={bot.name} className="relative" />}
        </div>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <strong className="text-2xl font-semibold tracking-tight">{bot?.name ?? "Call"}</strong>
          <span className={cn("flex items-center gap-2 text-label", call.status === "failed" ? "text-danger" : "text-muted")}>
            {call.status === "hearing" && <Level level={call.level} className="text-ink" />}
            {statusLine(call, bot)}
          </span>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {(call.error || caption) && (
            <m.p key={call.error ?? caption} className={cn("m-0 max-w-sm text-center text-[15px] leading-relaxed", call.error ? "text-danger" : call.status === "speaking" ? "text-ink" : "text-soft")}
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fade}>
              {call.error ?? (call.status === "speaking" ? caption : `“${caption}”`)}
            </m.p>
          )}
        </AnimatePresence>
      </div>
      <Controls call={call} onMinimize={onMinimize} />
    </m.div>
  );
}

/** 5c: the call bar above a chat (desktop, or a phone with the call minimized). The chat below is the transcript. */
export function CallBar({ call, here, onExpand, onOpenChat }: { call: CallSnapshot; here: boolean; onExpand?: () => void; onOpenChat: (chatId: string) => void }) {
  const bot = useCallBot(call);
  const duration = useDuration(call.startedAt);
  return (
    <m.div className="flex shrink-0 items-center gap-3 overflow-hidden border-b border-rule bg-surface px-4 py-2 sm:px-5"
      initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={soft}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onExpand ?? (here ? undefined : () => onOpenChat(call.chatId))}
        aria-label={here ? undefined : `Open the chat with ${bot?.name ?? "the Bot"}`}>
        <span className="relative grid place-items-center">
          <m.span className="absolute size-9 rounded-full bg-sky/20" animate={{ scale: 1 + call.botLevel * 0.5 }} transition={snappy} />
          {bot && <Face seed={bot.faceSeed} state={facePresence(call, bot)} size={30} title={bot.name} className="relative" />}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-label">
            <strong className="truncate">{here ? "On a call" : `On a call with ${bot?.name ?? "a Bot"}`}</strong>
            <span className="text-meta text-muted tabular-nums">{duration}</span>
          </span>
          <span className={cn("flex items-center gap-1.5 truncate text-meta", call.error || call.status === "failed" ? "text-danger" : "text-muted")}>
            {call.status === "hearing" ? <Level level={call.level} className="text-ink" /> : call.status === "speaking" ? <Level level={call.botLevel} className="text-sky" /> : null}
            <span className="truncate">{call.error ?? statusLine(call, bot)}</span>
          </span>
        </span>
      </button>
      <Controls call={call} compact />
    </m.div>
  );
}

/** 5b: a Bot ringing you. */
export function IncomingCall({ ring, onAnswered, onDeclined }: { ring: RingingCall; onAnswered: (chatId: string) => void; onDeclined: () => void }) {
  const bot = useLive((s) => s.bots[ring.botId]);
  // Ring on the device too: a short repeating chirp, where the browser allows sound.
  useEffect(() => {
    let context: AudioContext | null = null;
    try { context = new AudioContext(); } catch { return; }
    const chirp = () => {
      if (!context || context.state !== "running") return;
      for (const [offset, pitch] of [[0, 880], [0.18, 1175]] as const) {
        const tone = context.createOscillator();
        const gain = context.createGain();
        tone.frequency.value = pitch;
        gain.gain.setValueAtTime(0.0001, context.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.16);
        tone.connect(gain).connect(context.destination);
        tone.start(context.currentTime + offset);
        tone.stop(context.currentTime + offset + 0.18);
      }
    };
    void context.resume().then(chirp, () => {});
    const timer = setInterval(chirp, 1800);
    navigator.vibrate?.([300, 200, 300]);
    return () => { clearInterval(timer); void context?.close(); };
  }, []);
  const answer = () => { startCall(ring.chatId, ring.callId); onAnswered(ring.chatId); };
  const decline = () => { onDeclined(); void api.declineCall(ring.callId).catch(() => {}); };
  // Stops ringing on its own after 45 s (the server posts the reason in the chat).
  useEffect(() => { const timer = setTimeout(onDeclined, 45_000); return () => clearTimeout(timer); }, [onDeclined]);
  return (
    <m.div role="alertdialog" aria-label={`${bot?.name ?? "A Bot"} is calling`}
      className="fixed inset-x-3 top-[max(env(safe-area-inset-top),12px)] z-50 mx-auto flex max-w-md flex-col gap-4 rounded-3xl bg-raised p-5 shadow-pop sm:inset-x-auto sm:right-5 sm:w-[380px]"
      initial={{ opacity: 0, y: -24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -24, scale: 0.96 }} transition={bouncy}>
      <div className="flex items-center gap-4">
        <span className="relative grid place-items-center">
          <m.span className="absolute size-16 rounded-full bg-mint/25" animate={{ scale: [1, 1.25, 1], opacity: [0.9, 0.3, 0.9] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }} />
          {bot && <Face seed={bot.faceSeed} state="waiting" size={52} title={bot.name} className="relative" />}
        </span>
        <div className="flex min-w-0 flex-col">
          <strong className="text-[17px]">{bot?.name ?? "A Bot"} is calling</strong>
          {ring.reason && <span className="text-label leading-snug text-soft">{ring.reason}</span>}
        </div>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" className="flex-1 text-danger" onClick={decline}><PhoneOff size={16} />Decline</Button>
        <Button variant="primary" className="flex-1 bg-mint text-[#0b2a1d]" onClick={answer}><Phone size={16} />Answer</Button>
      </div>
      <p className="m-0 text-center text-meta text-muted">Not answering leaves the message in the chat.</p>
    </m.div>
  );
}
