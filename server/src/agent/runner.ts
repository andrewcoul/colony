import type { RunCheckpoint } from "../store.js";
import type { Card, Message } from "../shared/types.js";
import type { ColonyTool } from "./tools.js";

/**
 * What the rest of Colony asks of an agent runtime. Two implement it: the AI SDK one
 * (agent/run.ts, per-step checkpoints) and pi durable (agent/pi/runner.ts, one persistent
 * conversation per Bot per chat). COLONY_RUNTIME picks one.
 */
export interface Runner {
  isRunning(chatId: string, botId?: string): boolean;
  /** Stops every Bot working in this chat. */
  stop(chatId: string): void;
  /**
   * Hands a user message to a Bot that's already working in this chat. "steer" reaches the
   * running turn before its next step; "queue" waits until the turn ends. False when the Bot
   * isn't working, so the caller starts a turn instead.
   */
  deliver(chatId: string, botId: string, messageId: string, mode: "steer" | "queue"): boolean;
  /** "Steer now" on a queued message. */
  steerNow(messageId: string): boolean;
  /** Takes a queued message back before the Bot sees it. */
  unqueue(messageId: string): boolean;
  isBotRunning(botId: string): boolean;
  stopBot(botId: string): void;
  /** Starts a turn and returns the reply message id at once. */
  start(chatId: string, botId: string, options?: StartOptions): string;
  /** Picks up turns that were running when Colony stopped. */
  resumeAll(checkpoints: RunCheckpoint[]): void;
  /** Persistent conversations only: summarise the older part of a Bot's conversation now. */
  compact?(chatId: string, botId: string): Promise<void>;
  /** Persistent conversations only: the Bot starts this chat from a clean slate (its memory stays). */
  startFresh?(chatId: string, botId: string): Promise<void>;
  /** Persistent conversations only: a new topic that carries a Bot's conversation up to this reply. */
  branch?(messageId: string, topic: { title: string; folderId: string | null }): Promise<string>;
}

export type StartOptions = {
  /** Extra user-turn text that is sent to the model but not shown in the chat. */
  hiddenPrompt?: string;
  /** Cards the reply starts with, e.g. the routine that triggered it. */
  cards?: Card[];
  /** How many Bots deep this turn is (another Bot asking = 1). */
  depth?: number;
  /** Called with the finished reply (used by groups and routines). */
  onFinish?: (message: Message) => void;
  /** Pick the turn back up from this checkpoint (after a restart) instead of starting fresh. */
  resume?: RunCheckpoint;
};

/**
 * What may happen to a tool call a restart cut off.
 * - safe: it only reads, so it simply runs again.
 * - gated: it asks you before acting. It runs again (asking again) unless it was already
 *   approved and acting, in which case the model is told to check what happened.
 * - unsafe: anything else. It doesn't run again; the model is told it may or may not have happened.
 */
export type Replay = "safe" | "gated" | "unsafe";

const SAFE = new Set([
  "web_search", "web_read", "skill_read", "topic_list", "artifact_read", "chat_files",
  "read_file", "list_files", "browser_read",
  "mail_search", "mail_read", "calendar_list", "vault_list",
  "desktop_screenshot",
]);
const GATED = new Set(["shell", "mail_send", "calendar_invite", "calendar_respond", "vault_save"]);

export const replayOf = (name: string, spec?: Pick<ColonyTool, "replay">): Replay =>
  spec?.replay ?? (SAFE.has(name) ? "safe" : GATED.has(name) ? "gated" : "unsafe");
