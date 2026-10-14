// Types shared by the server and the web app (the web app imports these type-only).

export type Presence = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";

export type ComputerState = "off" | "starting" | "on" | "error";

export type Bot = {
  id: string;
  name: string;
  title: string;
  description: string;
  /** Seed for the generated face; defaults to the name. */
  faceSeed: string;
  /** "<provider id>::<model id>", picked from the providers in Settings. */
  model: string;
  /** Whether the Bot has its own Docker computer. */
  computer: boolean;
  /** Whether the Bot drives its computer's desktop (screen, mouse, keyboard). Needs a model that can. */
  desktop: boolean;
  computerState: ComputerState;
  presence: Presence;
  /** Short description of what the Bot is doing right now, shown on hover. */
  activity: string | null;
  chatId: string;
  createdAt: number;
};

export type Chat = {
  id: string;
  /** "thread" is a private conversation between two Bots, opened from a handoff card. */
  kind: "bot" | "group" | "thread";
  title: string;
  /** Bot ids; a bot chat has exactly one. */
  memberIds: string[];
  /** In a group, the Bot that answers messages with no @mention. */
  coordinatorId: string | null;
  lastPreview: string | null;
  lastAuthor: string | null;
  updatedAt: number;
  unread: number;
};

export type StepStatus = "running" | "done" | "error" | "waiting" | "denied";

export type Step = {
  id: string;
  tool: string;
  /** Human-readable action, e.g. `Searched the web “tauri opener”`. */
  title: string;
  /** Short result, e.g. `5 results` or `212 passed`. */
  detail?: string;
  status: StepStatus;
  startedAt: number;
  endedAt?: number;
};

export type Card =
  | { type: "approval"; approvalId: string }
  | { type: "routine"; routineId: string; action: "created" | "updated" | "ran"; title: string }
  /** Messages this reply exchanged with other Bots, one thread per Bot. */
  | { type: "handoff"; threads: { botId: string; chatId: string; count: number }[] };

export type MessageStatus = "streaming" | "done" | "failed" | "stopped";

export type Message = {
  id: string;
  chatId: string;
  /** "user", "system", or a Bot id. */
  author: string;
  text: string;
  reasoning: string;
  steps: Step[];
  cards: Card[];
  status: MessageStatus;
  error: string | null;
  createdAt: number;
};

/** When a routine runs, in the PC's local time. Days are 0 (Sunday) to 6; empty means every day. */
export type Schedule =
  | { type: "daily"; time: string; days: number[] }
  | { type: "interval"; minutes: number }
  | { type: "once"; at: number };

export type Routine = {
  id: string;
  botId: string;
  /** Where results land: the Bot's own chat or a group it belongs to. */
  chatId: string;
  title: string;
  /** The standing instruction the Bot follows each time. */
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: "done" | "failed" | "stopped" | null;
  createdAt: number;
};

/** A model a Bot can use: which provider, and which of its models. */
export type ModelOption = {
  ref: string;
  providerId: string;
  providerName: string;
  model: string;
  /** Can read screenshots and point accurately enough to drive a desktop. */
  desktop: boolean;
};

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type Approval = {
  id: string;
  botId: string;
  chatId: string;
  messageId: string;
  tool: string;
  /** One-line question, e.g. "Kenny wants to push and open a PR". */
  summary: string;
  /** Exact command, recipient, or payload to show verbatim. */
  detail: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
};

export type AppState = {
  bots: Bot[];
  chats: Chat[];
  /** Pending approvals plus the most recent resolved ones. */
  approvals: Approval[];
  routines: Routine[];
  /** Every model across every provider in Settings. */
  models: ModelOption[];
  defaultModel: string;
  /** Whether a model connection is set up (Settings shows a prompt when it isn't). */
  configured: boolean;
  /** Latest event sequence number; subscribe to /api/events from here. */
  seq: number;
};

export type ServerEvent =
  | { type: "bot.upserted"; bot: Bot }
  | { type: "bot.deleted"; botId: string }
  | { type: "bot.presence"; botId: string; presence: Presence; activity: string | null }
  | { type: "chat.upserted"; chat: Chat }
  | { type: "chat.deleted"; chatId: string }
  | { type: "message.upserted"; message: Message }
  | { type: "approval.upserted"; approval: Approval }
  | { type: "settings.updated"; models: ModelOption[]; defaultModel: string; configured: boolean }
  | { type: "routine.upserted"; routine: Routine }
  | { type: "routine.deleted"; routineId: string };

/** Not persisted: streamed text and terminal output. Clients refetch on reconnect. */
export type EphemeralEvent =
  | { type: "message.delta"; messageId: string; chatId: string; text: string; reasoning?: string }
  | { type: "computer.output"; botId: string; text: string };
