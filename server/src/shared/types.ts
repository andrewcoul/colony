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
  /** Who it belongs to: whoever made it (or was given it). Only they see its chat, memory and routines. */
  ownerId: string;
  createdAt: number;
};

/** Icons a topic can wear (the web app maps each to a drawing). */
export const TOPIC_ICONS = [
  "chat", "cart", "home", "hammer", "receipt", "plane", "heart", "calendar", "briefcase", "book", "sparkles", "users",
  "globe", "wallet", "car", "gift", "utensils", "dumbbell", "baby", "graduation", "music", "camera", "code", "leaf", "paw",
] as const;
export type TopicIcon = (typeof TOPIC_ICONS)[number];

export type Chat = {
  id: string;
  /**
   * "bot" is a Bot's own chat. A "topic" is an ongoing piece of life or work (a trip, a renovation,
   * a launch) with its own history, filed in a folder, with one Bot or several.
   * "thread" is a private conversation between two Bots, opened from a handoff card.
   */
  kind: "bot" | "topic" | "thread";
  title: string;
  /** Bot ids; a bot chat has exactly one. */
  memberIds: string[];
  /** In a topic with several Bots, the one that answers messages with no @mention. */
  coordinatorId: string | null;
  /** Topics: what it wears in the sidebar, where it's filed, and what it's about (given to its Bots). */
  icon: TopicIcon | null;
  folderId: string | null;
  brief: string;
  /** Archived topics drop to the bottom of the list. */
  archivedAt: number | null;
  lastPreview: string | null;
  lastAuthor: string | null;
  updatedAt: number;
  unread: number;
  /** Who it belongs to: a Bot's owner for its chat, whoever started a topic. */
  ownerId: string;
  /** Topics: the people (besides its owner) who can see and post in it, or everyone. */
  peopleIds: string[];
  everyone: boolean;
};

/**
 * Someone in the family, known by their Tailscale login (no Colony accounts). The host runs
 * Colony on their PC and looks after what's shared; everyone else is family. Each person's
 * Bots are their own.
 */
export type PersonRole = "host" | "family";
export type Person = { id: string; login: string | null; name: string; color: string; role: PersonRole; createdAt: number };

/** interrupted: Colony restarted while the step was running (see the run's restart marker). */
export type StepStatus = "running" | "done" | "error" | "waiting" | "denied" | "interrupted";

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

/** A folder topics are filed in. */
/** A person's own way of filing their topics. */
export type Folder = { id: string; title: string; position: number; ownerId: string; createdAt: number };

/** A topic a Bot suggested starting; nothing exists until you tap Create. */
export type TopicProposal = { title: string; icon: TopicIcon; brief: string; memberIds: string[]; folderId: string | null };

/**
 * A topic's living document (shown as "Doc"): Markdown the Bot keeps up to date, versioned.
 * Special fenced blocks render as stats, item cards and notes (see the web app's DocView).
 */
export type Artifact = {
  id: string;
  chatId: string;
  title: string;
  /** Free text the Bot sets, e.g. "Draft", "Almost final", "Booked". */
  status: string;
  body: string;
  version: number;
  /** What changed in this version, in a few words. */
  note: string;
  /** "user" or a Bot id. */
  updatedBy: string;
  updatedAt: number;
};
export type ArtifactVersion = Omit<Artifact, "id" | "chatId" | "updatedAt"> & { createdAt: number };

/** A file added to a chat: uploaded by you, or written there by a Bot. */
export type ChatFile = { id: string; chatId: string; name: string; mime: string; size: number; addedBy: string; createdAt: number };
/** A file sent with a message. */
export type Attachment = { id: string; name: string; mime: string; size: number };

/** A question a Bot asks with tappable answers. Questions without options are answered by typing. */
export type AskQuestion = { label: string; options: string[] };

export type Card =
  | { type: "approval"; approvalId: string }
  | { type: "artifact"; title: string; version: number; note: string }
  | { type: "ask"; questions: AskQuestion[] }
  | { type: "topic"; proposalId: string; proposal: TopicProposal; chatId: string | null; dismissed: boolean }
  | { type: "routine"; routineId: string; action: "created" | "updated" | "ran"; title: string }
  /** Messages this reply exchanged with other Bots, one thread per Bot. */
  | { type: "handoff"; threads: { botId: string; chatId: string; count: number }[] };

export type MessageStatus = "streaming" | "done" | "failed" | "stopped";

/**
 * How a message sent while a Bot was working reached it.
 * steer: added to the running turn at the next step. queued: waits for the turn to finish.
 */
export type Delivery = "steer" | "queued";

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
  /** Set when the message arrived while a Bot was working (see Delivery). */
  delivery: Delivery | null;
  /** For a steer: how many steps the Bot had taken when it picked the message up. */
  steeredAt: number | null;
  /** Files sent with the message. */
  attachments: Attachment[];
  /** "voice": said on a call (yours transcribed, a Bot's spoken). */
  via: "voice" | null;
  createdAt: number;
};

/** When a routine runs, in the PC's local time. Days are 0 (Sunday) to 6; empty means every day. */
export type Schedule =
  | { type: "daily"; time: string; days: number[] }
  | { type: "interval"; minutes: number }
  | { type: "once"; at: number }
  /** Runs when new mail arrives in a connected account's inbox (optionally only matching mail). */
  | { type: "mail"; accountId: string; from?: string; subject?: string };

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
  /** Null: a shared model (the host's key); otherwise the person whose key it is. */
  ownerId: string | null;
  ref: string;
  providerId: string;
  providerName: string;
  model: string;
  /** Can read screenshots and point accurately enough to drive a desktop. */
  desktop: boolean;
};

/** A connected outside account: a mailbox and calendar, or a 1Password account. */
export type AccountKind = "google" | "microsoft" | "onepassword";

/** What devices see of a connected account. Tokens never leave the server. */
export type Account = {
  id: string;
  kind: AccountKind;
  /** e.g. "Gmail", "Outlook", "1Password". */
  label: string;
  /** The mailbox address, or the 1Password account and vaults it reaches. */
  email: string;
  /** "needs_reauth" when its sign-in stopped working and you need to reconnect it. */
  status: "ok" | "needs_reauth";
  /** Who connected it: only their Bots can use it, and only they approve what it sends. */
  personId: string;
  createdAt: number;
};

export type MailAccess = "none" | "read" | "draft" | "send";
export type CalendarAccess = "none" | "read" | "write";
export type VaultAccess = "none" | "use" | "save";

/** What one Bot may do with one account. Bots get nothing until you grant it. */
export type Access = { botId: string; accountId: string; mail: MailAccess; calendar: CalendarAccess; vault: VaultAccess };

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
  /** Who must answer: the Bot's owner, or whoever owns the account or PC it would act on. */
  approverId: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
};
/** What a tool asks for; the approver defaults to the Bot's owner. */
export type ApprovalRequest = Omit<Approval, "id" | "status" | "createdAt" | "resolvedAt" | "approverId"> & { approverId?: string };

/** What a PC lets Bots do, switched on in its desktop app (and enforced there). */
export type PcCapability = "browser" | "screen" | "shell" | "files" | "fullDisk";
/**
 * Someone's own PC, lent to Bots through the Colony desktop app.
 * `online`: its desktop app is connected now.
 */
/** A model's price in US dollars per million tokens: in, out, and cached in (falls back to in). */
export type Price = { input: number; output: number; cached?: number };

/** Your spending: this month by Bot, split into your own keys and shared ones, and the last 30 days. Dollars. */
export type Spending = {
  month: string;
  own: number;
  shared: number;
  /** The host's monthly limit on your use of shared keys, if they set one. */
  limit: number | null;
  hostName: string;
  bots: { botId: string; name: string; own: number; shared: number; tokens: number }[];
  days: { date: string; own: number; shared: number }[];
  /** Models used this month that have no price, so their tokens count but cost nothing here. */
  unpriced: string[];
};

/** The host's view of shared keys this month: by person, then by Bot, with each person's limit. */
export type SharedSpending = {
  month: string;
  total: number;
  people: { personId: string; cost: number; limit: number | null; bots: { botId: string; name: string; cost: number }[] }[];
};

export type PcNode = { id: string; name: string; platform: string; capabilities: PcCapability[]; online: boolean; lastSeen: number; personId: string };

export type AppState = {
  bots: Bot[];
  chats: Chat[];
  folders: Folder[];
  /** Pending approvals plus the most recent resolved ones. */
  approvals: Approval[];
  routines: Routine[];
  /** Every model across every provider in Settings. */
  models: ModelOption[];
  defaultModel: string;
  /** Whether a model connection is set up (Settings shows a prompt when it isn't). */
  configured: boolean;
  accounts: Account[];
  /** Every Bot's access to every account it has been given. */
  access: Access[];
  /** PCs lent through the desktop app: any family Bot may use them, within each PC's switches. */
  nodes: PcNode[];
  /** The household, and who's asking. */
  people: Person[];
  me: Person;
  /** Latest event sequence number; subscribe to /api/events from here. */
  seq: number;
};

export type ServerEvent =
  | { type: "bot.upserted"; bot: Bot }
  | { type: "bot.deleted"; botId: string }
  | { type: "bot.presence"; botId: string; presence: Presence; activity: string | null }
  | { type: "chat.upserted"; chat: Chat }
  | { type: "chat.deleted"; chatId: string }
  | { type: "artifact.upserted"; artifact: Artifact }
  | { type: "file.upserted"; file: ChatFile }
  | { type: "file.deleted"; chatId: string; fileId: string }
  | { type: "folder.upserted"; folder: Folder }
  | { type: "folder.deleted"; folderId: string }
  | { type: "message.upserted"; message: Message }
  | { type: "message.deleted"; chatId: string; messageId: string }
  | { type: "approval.upserted"; approval: Approval }
  | { type: "settings.updated"; models: ModelOption[]; defaultModel: string; configured: boolean }
  | { type: "routine.upserted"; routine: Routine }
  | { type: "routine.deleted"; routineId: string }
  | { type: "accounts.updated"; accounts: Account[]; access: Access[] }
  | { type: "nodes.updated"; nodes: PcNode[] }
  | { type: "people.updated"; people: Person[] };

/** Not persisted: streamed text and terminal output. Clients refetch on reconnect. */
export type EphemeralEvent =
  | { type: "message.delta"; messageId: string; chatId: string; text: string; reasoning?: string }
  | { type: "computer.output"; botId: string; text: string }
  /** A Bot is calling you (see call_user); ringing stops with call.ended. */
  | { type: "call.ringing"; callId: string; botId: string; chatId: string; reason: string }
  | { type: "call.ended"; callId: string };
