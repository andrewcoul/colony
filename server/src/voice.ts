import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { Runner } from "./agent/runner.js";
import type { ToolRegistry } from "./agent/tools.js";
import type { EventLog } from "./events.js";
import { sendUserMessage } from "./send.js";
import { voiceEndpoint, voiceSettings } from "./settings.js";
import type { Store } from "./store.js";

/*
 * Voice calls with a Bot, in the Colony app (no phone network: Colony stays on your tailnet).
 * The app sends each thing you say as a short WAV clip; it's transcribed and posted as your
 * message, so the Bot answers the normal way (talking while it works steers it). Its reply is
 * spoken sentence by sentence as it streams. Transcription and speech use OpenAI-compatible
 * /audio endpoints (OpenAI with an API key, or local Whisper and Kokoro servers).
 */

function provider() {
  const found = voiceEndpoint();
  if (!found) throw new Error("Voice isn't set up. Turn it on in Settings → Voice.");
  return found;
}

export async function transcribe(audio: Uint8Array, mime = "audio/wav"): Promise<string> {
  const target = provider();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), mime === "audio/wav" ? "speech.wav" : "speech.webm");
  form.append("model", voiceSettings().transcribeModel);
  const response = await fetch(`${target.baseURL}/audio/transcriptions`, {
    method: "POST", body: form, headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : undefined, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Transcription failed (${response.status}).`);
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}

export async function speak(text: string, voice: string): Promise<ArrayBuffer> {
  const target = provider();
  const response = await fetch(`${target.baseURL}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}) },
    body: JSON.stringify({ model: voiceSettings().speechModel, voice, input: text, response_format: "mp3" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Speech failed (${response.status}).`);
  return response.arrayBuffer();
}

/** Markdown read aloud: no code, no link targets, no symbols a voice would spell out. */
export function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ x]\]\s*)?/gm, "")
    .replace(/[*_~>|#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits streaming text into sentences as soon as each one is complete. */
export class SentenceSplitter {
  private buffer = "";
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const match = /^([\s\S]{12,}?[.!?…:;])(\s+|\n)|^([\s\S]*?\S[\s\S]*?)\n\n/.exec(this.buffer);
      if (!match) break;
      const sentence = (match[1] ?? match[3]).trim();
      this.buffer = this.buffer.slice(match[0].length);
      if (sentence) out.push(sentence);
    }
    return out;
  }
  flush() {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}

const inQuietHours = ({ quietFrom, quietTo }: { quietFrom: string; quietTo: string }, now = new Date()) => {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [fromH, fromM] = quietFrom.split(":").map(Number);
  const [toH, toM] = quietTo.split(":").map(Number);
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
};

type Ring = { id: string; botId: string; chatId: string; reason: string; timer: ReturnType<typeof setTimeout> };

/** Rings, answers, and the calls in progress. */
export class Calls {
  private rings = new Map<string, Ring>();
  private lastRing = new Map<string, number>();
  private sockets = new WebSocketServer({ noServer: true });
  /** Sends a push notification (set by index.ts). */
  notify: (input: { title: string; body: string; chatId: string; tag: string; path: string }) => void = () => {};

  constructor(private store: Store, private events: EventLog, private runner: Runner) {}

  /**
   * A Bot rings you. Not during quiet hours, not more than every 30 minutes per Bot, and not
   * if you've turned calls off. Unanswered after 45 s, the reason is posted in the chat instead.
   */
  ring(botId: string, chatId: string, reason: string, now = Date.now()): { ringing: boolean; why?: string } {
    const settings = voiceSettings();
    if (!settings.allowCalls) return { ringing: false, why: "The user has turned calls from Bots off." };
    if (!voiceEndpoint()) return { ringing: false, why: "Voice isn't set up, so calls can't happen." };
    if (inQuietHours(settings, new Date(now))) return { ringing: false, why: `It's the user's quiet hours (${settings.quietFrom}–${settings.quietTo}).` };
    if (now - (this.lastRing.get(botId) ?? 0) < 30 * 60_000) return { ringing: false, why: "You called less than 30 minutes ago." };
    this.lastRing.set(botId, now);
    const id = crypto.randomUUID();
    const bot = this.store.getBot(botId);
    const timer = setTimeout(() => this.miss(id), 45_000);
    timer.unref?.();
    this.rings.set(id, { id, botId, chatId, reason, timer });
    this.events.broadcast({ type: "call.ringing", callId: id, botId, chatId, reason });
    this.notify({ title: `${bot?.name ?? "A Bot"} is calling`, body: reason, chatId, tag: `call-${id}`, path: `${chatId}?call=${id}` });
    return { ringing: true };
  }

  /** Not answered (or declined): the reason goes in the chat as the Bot's message. */
  miss(callId: string) {
    const ring = this.rings.get(callId);
    if (!ring) return;
    clearTimeout(ring.timer);
    this.rings.delete(callId);
    this.events.broadcast({ type: "call.ended", callId });
    this.store.createMessage({ chatId: ring.chatId, author: ring.botId, text: `I tried to call you: ${ring.reason}` });
  }

  /** Handles the call socket: /api/chats/<id>/call (?answer=<ringing call id> to pick up). */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? "", "http://colony");
    const chatId = /^\/api\/chats\/([\w-]+)\/call$/.exec(url.pathname)?.[1];
    const chat = chatId ? this.store.getChat(chatId) : null;
    if (!chat || chat.kind === "thread") { socket.destroy(); return; }
    // The Bot that rang you, or the chat's lead.
    const ring = url.searchParams.get("answer") ? this.rings.get(url.searchParams.get("answer")!) : undefined;
    const botId = ring && chat.memberIds.includes(ring.botId) ? ring.botId : chat.memberIds.includes(chat.coordinatorId ?? "") ? chat.coordinatorId! : chat.memberIds[0];
    if (!botId) { socket.destroy(); return; }
    if (ring?.botId === botId) {
      clearTimeout(ring.timer);
      this.rings.delete(ring.id);
      this.events.broadcast({ type: "call.ended", callId: ring.id });
    }
    this.sockets.handleUpgrade(request, socket, head, (ws) => this.call(ws, chat.id, botId, ring?.botId === botId ? ring.reason : undefined));
  }

  private call(ws: WebSocket, chatId: string, botId: string, opening?: string) {
    const settings = voiceSettings();
    const voice = settings.botVoices[botId] ?? settings.voice;
    const send = (data: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data)); };
    const splitters = new Map<string, SentenceSplitter>();
    // Replies you talked over aren't read out any further (the text still lands in the chat).
    const hushed = new Set<string>();
    let speaking = Promise.resolve();
    let generation = 0;

    const say = (text: string, messageId: string | null) => {
      const words = speakable(text);
      if (!words) return;
      const mine = generation;
      // Fetch speech right away, but play in order.
      const audio = speak(words, voice).catch((error) => { send({ type: "error", message: error instanceof Error ? error.message : "Speech failed." }); return null; });
      speaking = speaking.then(async () => {
        const bytes = await audio;
        if (!bytes || mine !== generation || (messageId && hushed.has(messageId)) || ws.readyState !== ws.OPEN) return;
        send({ type: "say", text: words, messageId });
        ws.send(Buffer.from(bytes));
      });
    };

    const unsubscribe = this.events.subscribe(({ event }) => {
      if (event.type === "message.delta" && event.chatId === chatId && event.text && !hushed.has(event.messageId)) {
        const author = this.store.getMessage(event.messageId)?.author;
        if (author !== botId) return;
        let splitter = splitters.get(event.messageId);
        if (!splitter) { splitter = new SentenceSplitter(); splitters.set(event.messageId, splitter); send({ type: "state", state: "speaking" }); }
        for (const sentence of splitter.push(event.text)) say(sentence, event.messageId);
      }
      if (event.type === "message.upserted" && event.message.chatId === chatId && event.message.author === botId && event.message.status !== "streaming") {
        const splitter = splitters.get(event.message.id);
        if (splitter) for (const sentence of splitter.flush()) say(sentence, event.message.id);
        splitters.delete(event.message.id);
        if (event.message.status === "failed") send({ type: "error", message: event.message.error ?? "The reply didn't finish." });
      }
      if (event.type === "bot.presence" && event.botId === botId) send({ type: "presence", presence: event.presence });
    });

    send({ type: "ready", botId, voice });
    if (opening) {
      // The Bot rang you: it opens with why, which also goes in the chat.
      this.store.createMessage({ chatId, author: botId, text: opening, via: "voice" });
      say(opening, null);
    }

    ws.on("message", (data, binary) => {
      if (!binary) {
        try {
          const control = JSON.parse(String(data)) as { type?: string };
          // You started talking over the Bot: stop reading out what it's saying now.
          if (control.type === "interrupt") {
            generation++;
            for (const id of splitters.keys()) hushed.add(id);
            speaking = Promise.resolve();
          }
        } catch { /* not ours */ }
        return;
      }
      const clip = new Uint8Array(data as Buffer);
      if (clip.byteLength < 2000) return; // a click, not words
      send({ type: "state", state: "thinking" });
      void transcribe(clip).then((text) => {
        if (!text) { send({ type: "state", state: "listening" }); return; }
        send({ type: "heard", text });
        const current = this.store.getChat(chatId);
        if (current) sendUserMessage(this.store, this.runner, current, { text, via: "voice" });
      }).catch((error) => send({ type: "error", message: error instanceof Error ? error.message : "Couldn't hear that." }));
    });
    ws.on("close", () => unsubscribe());
  }
}

/** call_user: a Bot rings you when something needs you now. */
export const callTools = (calls: Calls): ToolRegistry => ({
  call_user: {
    description: "Ring the user in the Colony app to talk it through by voice. Only for something that needs them now and is easier said than written (an urgent decision, something time-sensitive going wrong). Never for routine updates. It won't ring during their quiet hours or more than once every 30 minutes; if they don't pick up, your reason is posted in this chat. After calling, end your turn: when they answer, what they say arrives as their messages.",
    inputSchema: z.object({
      reason: z.string().trim().min(1).max(300).describe("What you'll open the call with, one or two sentences, e.g. \"Your flight just got cancelled. I've found two options and need you to pick one.\""),
    }),
    describe: () => "Rang the user",
    summarize: (output: { ringing: boolean; why?: string }) => output.ringing ? "Ringing" : "Didn't ring",
    execute: async ({ reason }: { reason: string }, ctx) => {
      const result = calls.ring(ctx.botId, ctx.chatId, reason);
      return result.ringing
        ? { ringing: true, note: "Their app is ringing. End your turn now; if they don't answer within 45 seconds, your reason is posted here for them." }
        : { ringing: false, why: result.why, note: "Say it in the chat instead." };
    },
  },
});
