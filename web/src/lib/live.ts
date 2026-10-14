import { useSyncExternalStore } from "react";
import type { Approval, Bot, Chat, EphemeralEvent, Message, ModelOption, Routine, ServerEvent } from "@shared/types";
import { api } from "./api";

export type LiveState = {
  ready: boolean;
  connected: boolean;
  bots: Record<string, Bot>;
  chats: Record<string, Chat>;
  /** Pending approvals from the snapshot, plus any seen (resolved or not) since. */
  approvals: Record<string, Approval>;
  routines: Record<string, Routine>;
  /** Loaded transcripts, keyed by chat id. Chats load on first open. */
  messages: Record<string, Message[]>;
  models: ModelOption[];
  defaultModel: string;
  configured: boolean;
  error: string | null;
};

let state: LiveState = {
  ready: false, connected: false, bots: {}, chats: {}, approvals: {}, routines: {}, messages: {}, models: [], defaultModel: "", configured: true, error: null,
};
const listeners = new Set<() => void>();
let seq = 0;
let source: EventSource | null = null;

function set(next: Partial<LiveState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map((item) => [item.id, item]));
const without = <T>(record: Record<string, T>, key: string) => { const next = { ...record }; delete next[key]; return next; };

function upsertMessage(list: Message[], message: Message) {
  const index = list.findIndex((item) => item.id === message.id);
  if (index >= 0) return list.map((item, i) => (i === index ? message : item));
  return [...list, message].sort((a, b) => a.createdAt - b.createdAt);
}

function apply(event: ServerEvent) {
  switch (event.type) {
    case "bot.upserted": return set({ bots: { ...state.bots, [event.bot.id]: event.bot } });
    case "bot.deleted": return set({ bots: without(state.bots, event.botId) });
    case "bot.presence": {
      const bot = state.bots[event.botId];
      return bot && set({ bots: { ...state.bots, [bot.id]: { ...bot, presence: event.presence, activity: event.activity } } });
    }
    case "chat.upserted": return set({ chats: { ...state.chats, [event.chat.id]: event.chat } });
    case "chat.deleted": return set({ chats: without(state.chats, event.chatId), messages: without(state.messages, event.chatId) });
    case "message.upserted": {
      const list = state.messages[event.message.chatId];
      return list && set({ messages: { ...state.messages, [event.message.chatId]: upsertMessage(list, event.message) } });
    }
    case "approval.upserted":
      return set({ approvals: { ...state.approvals, [event.approval.id]: event.approval } });
    case "routine.upserted": return set({ routines: { ...state.routines, [event.routine.id]: event.routine } });
    case "routine.deleted": return set({ routines: without(state.routines, event.routineId) });
    case "settings.updated": return set({ models: event.models, defaultModel: event.defaultModel, configured: event.configured });
  }
}

type ComputerOutput = Extract<EphemeralEvent, { type: "computer.output" }>;
const outputListeners = new Set<(event: ComputerOutput) => void>();

/** Live terminal output from Bots' computers (not stored; the panel fetches the log on open). */
export function onComputerOutput(listener: (event: ComputerOutput) => void) {
  outputListeners.add(listener);
  return () => { outputListeners.delete(listener); };
}

function applyEphemeral(event: EphemeralEvent) {
  if (event.type === "computer.output") { for (const listener of outputListeners) listener(event); return; }
  applyDelta(event);
}

function applyDelta(event: Extract<EphemeralEvent, { type: "message.delta" }>) {
  const list = state.messages[event.chatId];
  if (!list) return;
  set({ messages: { ...state.messages, [event.chatId]: list.map((message) => message.id === event.messageId
    ? { ...message, text: message.text + event.text, reasoning: message.reasoning + (event.reasoning ?? "") }
    : message) } });
}

async function loadState() {
  const snapshot = await api.state();
  seq = snapshot.seq;
  set({
    ready: true, error: null,
    bots: byId(snapshot.bots), chats: byId(snapshot.chats), approvals: byId(snapshot.approvals), routines: byId(snapshot.routines),
    models: snapshot.models, defaultModel: snapshot.defaultModel, configured: snapshot.configured,
  });
}

/** Refetches open transcripts: streamed text isn't replayed, so resync after any gap. */
async function refreshLoadedChats() {
  await Promise.all(Object.keys(state.messages).map(loadMessages));
}

/** Server pings every 15s; silence beyond this means the stream is dead (e.g. a proxy kept a stale socket). */
const STALE_MS = 35_000;
let lastBeat = Date.now();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15_000);
}

function connect() {
  clearTimeout(retryTimer);
  source?.close();
  lastBeat = Date.now();
  const current = new EventSource(`/api/events?since=${seq}&client=${clientId}`);
  source = current;
  const beat = () => { lastBeat = Date.now(); };
  current.addEventListener("ready", () => {
    beat();
    retryDelay = 1000;
    set({ connected: true });
    sendFocus();
    // Streamed text isn't replayed, so resync open transcripts after any (re)connect.
    if (state.ready) void refreshLoadedChats();
  });
  current.addEventListener("ping", beat);
  current.onerror = () => {
    set({ connected: false });
    // Browsers give up for good after an error response (a 502 while the server restarts); retry ourselves.
    if (current.readyState === EventSource.CLOSED && source === current) scheduleReconnect();
  };
  current.addEventListener("event", (message) => {
    beat();
    const event = message as MessageEvent<string>;
    if (event.lastEventId) seq = Number(event.lastEventId);
    apply(JSON.parse(event.data) as ServerEvent);
  });
  current.addEventListener("ephemeral", (message) => { beat(); applyEphemeral(JSON.parse((message as MessageEvent<string>).data) as EphemeralEvent); });
  current.addEventListener("reset", () => { void loadState().then(refreshLoadedChats).then(connect); });
}

export async function startLive() {
  try {
    await loadState();
    connect();
    // Phones suspend background tabs; reconnect and resync when Colony comes back.
    document.addEventListener("visibilitychange", () => {
      sendFocus();
      if (document.visibilityState === "visible" && (!source || source.readyState !== EventSource.OPEN || Date.now() - lastBeat > STALE_MS)) connect();
    });
    setInterval(() => { if (Date.now() - lastBeat > STALE_MS) connect(); }, 5000);
  } catch (error) {
    set({ error: error instanceof Error ? error.message : "Couldn't reach the Colony server." });
    setTimeout(startLive, 3000);
  }
}

/** Identifies this window to the server, which skips notifications for the chat on screen. */
const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let focusedChat: string | null = null;

function sendFocus() {
  void api.focus({ clientId, chatId: focusedChat, visible: document.visibilityState === "visible" }).catch(() => {});
}

export function setFocusedChat(chatId: string | null) {
  if (chatId === focusedChat) return;
  focusedChat = chatId;
  sendFocus();
}

export async function loadMessages(chatId: string) {
  const messages = await api.messages(chatId);
  set({ messages: { ...state.messages, [chatId]: messages } });
}

export async function loadOlder(chatId: string) {
  const current = state.messages[chatId] ?? [];
  if (!current.length) return false;
  const older = await api.messages(chatId, current[0].createdAt);
  set({ messages: { ...state.messages, [chatId]: [...older, ...state.messages[chatId] ?? []] } });
  return older.length > 0;
}

export function useLive<T>(select: (state: LiveState) => T): T {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => select(state),
  );
}
