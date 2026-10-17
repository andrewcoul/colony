import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { EventLog } from "./events.js";
import { nextRun } from "./shared/schedule.js";
import type { Approval, ApprovalRequest, ApprovalStatus, Artifact, ArtifactVersion, Attachment, Bot, Card, Chat, ChatFile, ComputerState, Delivery, Folder, Message, MessageStatus, PcCapability, PcNode, Presence, Role, Routine, Schedule, Step, TopicIcon } from "./shared/types.js";
import { removeChatFolder } from "./chatFiles.js";
import type { Person } from "./people.js";

type Row = Record<string, unknown>;

/** The admin's id ("owner": everything from before accounts is theirs). */
const ADMIN = "owner";
/** The audience of an event about something that's gone: nobody (null would be everyone). */
const NOBODY = "";

const toBot = (row: Row): Bot => ({
  id: row.id as string,
  name: row.name as string,
  title: row.title as string,
  description: row.description as string,
  faceSeed: row.face_seed as string,
  model: row.model as string,
  computer: Boolean(row.computer),
  desktop: Boolean(row.desktop),
  computerState: (row.computer_state as ComputerState) ?? "off",
  presence: row.presence as Presence,
  activity: (row.activity as string | null) ?? null,
  chatId: row.chat_id as string,
  ownerId: (row.owner_id as string | undefined) ?? ADMIN,
  createdAt: row.created_at as number,
});

const toPerson = (row: Row): Person => ({
  id: row.id as string,
  // Only the owner is ever the admin, whatever an old row says.
  role: (row.id === ADMIN ? "admin" : "member") satisfies Role,
  name: row.name as string,
  login: (row.login as string | null) ?? null,
  color: row.color as string,
  // The admin is never turned off.
  disabled: row.id !== ADMIN && Boolean(row.disabled_at),
  createdAt: row.created_at as number,
});

/** One model call's usage. `costMicros` null: the model has no price. */
export type UsageRow = {
  id: string; at: number; botId: string; providerId: string; model: string;
  inputTokens: number; outputTokens: number; cachedTokens: number; costMicros: number | null;
};

/** A turn's checkpoint: what the model will be sent at its next step, so a restart can resume it. */
export type RunCheckpoint = {
  /** The turn's first reply message. */
  id: string;
  chatId: string;
  botId: string;
  /** The reply being written now (a steered turn moves to a new one). */
  messageId: string;
  /** Steps in earlier parts of a steered reply. */
  stepsBefore: number;
  /** JSON ModelMessage[]: the conversation as of the next model step. */
  messages: string;
  options: { hiddenPrompt?: string; depth?: number };
  startedAt: number;
  updatedAt: number;
};

const toMessage = (row: Row): Message => ({
  id: row.id as string,
  chatId: row.chat_id as string,
  author: row.author as string,
  text: row.text as string,
  reasoning: row.reasoning as string,
  steps: JSON.parse(row.steps as string) as Step[],
  cards: JSON.parse(row.cards as string) as Card[],
  status: row.status as MessageStatus,
  error: (row.error as string | null) ?? null,
  delivery: (row.delivery as Delivery | null) ?? null,
  steeredAt: (row.steered_at as number | null) ?? null,
  attachments: JSON.parse((row.attachments as string | null) ?? "[]") as Attachment[],
  via: (row.via as Message["via"]) ?? null,
  createdAt: row.created_at as number,
});

const toArtifact = (row: Row): Artifact => ({
  id: row.id as string, chatId: row.chat_id as string, title: row.title as string, status: row.status as string, body: row.body as string,
  version: row.version as number, note: row.note as string, updatedBy: row.updated_by as string, updatedAt: row.updated_at as number,
});

const toFile = (row: Row): ChatFile => ({
  id: row.id as string, chatId: row.chat_id as string, name: row.name as string, mime: row.mime as string, size: row.size as number,
  addedBy: row.added_by as string, createdAt: row.created_at as number,
});

const toApproval = (row: Row): Approval => ({
  id: row.id as string,
  botId: row.bot_id as string,
  chatId: row.chat_id as string,
  messageId: row.message_id as string,
  tool: row.tool as string,
  summary: row.summary as string,
  detail: row.detail as string,
  reason: row.reason as string,
  approverId: (row.approver_id as string | undefined) ?? ADMIN,
  status: row.status as ApprovalStatus,
  createdAt: row.created_at as number,
  resolvedAt: (row.resolved_at as number | null) ?? null,
});

const toRoutine = (row: Row): Routine => ({
  id: row.id as string,
  botId: row.bot_id as string,
  chatId: row.chat_id as string,
  title: row.title as string,
  prompt: row.prompt as string,
  schedule: JSON.parse(row.schedule as string) as Schedule,
  enabled: Boolean(row.enabled),
  nextRunAt: (row.next_run_at as number | null) ?? null,
  lastRunAt: (row.last_run_at as number | null) ?? null,
  lastStatus: (row.last_status as Routine["lastStatus"]) ?? null,
  createdAt: row.created_at as number,
});

export type RoutinePatch = Partial<Pick<Routine, "title" | "prompt" | "schedule" | "enabled" | "chatId" | "nextRunAt" | "lastRunAt" | "lastStatus">>;

export const newId = () => randomUUID();

/** Markdown → one plain line for roster previews. */
export function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * All persistent state. Every mutation emits the matching event, addressed to the person whose
 * thing it is (see EventLog): a Bot's and a chat's owner, an approval's approver.
 */
export class Store {
  constructor(private db: Db, private events: EventLog) {}

  /** Whose chat this is (nobody's once it's gone). */
  private chatOwner(chatId: string): string {
    return (this.db.prepare("SELECT owner_id FROM chats WHERE id = ?").get(chatId) as Row | undefined)?.owner_id as string | undefined ?? NOBODY;
  }

  private botOwner(botId: string): string {
    return (this.db.prepare("SELECT owner_id FROM bots WHERE id = ?").get(botId) as Row | undefined)?.owner_id as string | undefined ?? NOBODY;
  }

  // ---------- People ----------
  /** The admin first, then members in the order they joined. */
  listPeople(): Person[] {
    return (this.db.prepare("SELECT * FROM people ORDER BY id <> 'owner', created_at").all() as Row[]).map(toPerson);
  }

  getPerson(id: string): Person | null {
    const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id) as Row | undefined;
    return row ? toPerson(row) : null;
  }

  personByLogin(login: string): Person | null {
    const row = this.db.prepare("SELECT * FROM people WHERE lower(login) = lower(?)").get(login) as Row | undefined;
    return row ? toPerson(row) : null;
  }

  /** A new member. Nobody is ever added as the admin: there is one, from the start. */
  addPerson(input: { login: string; name: string; color: string; role: "member" }): Person {
    const id = newId();
    this.db.prepare("INSERT INTO people (id, login, name, color, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)")
      .run(id, input.login.toLowerCase(), input.name, input.color, Date.now());
    return this.getPerson(id)!;
  }

  /** Turns a member off (they can't sign in and their Bots don't run) or back on. Never the admin. */
  setPersonDisabled(id: string, disabled: boolean) {
    if (id === ADMIN) throw new Error("The admin can't be turned off.");
    this.db.prepare("UPDATE people SET disabled_at = ? WHERE id = ?").run(disabled ? Date.now() : null, id);
    return this.getPerson(id);
  }

  /**
   * Removes a member and everything of theirs: Bots (with their chats, routines and approvals),
   * topics, folders, devices, spending and events. Nothing of anyone else's. Returns the ids of
   * the Bots removed, so their folders and computers can go too. Never the admin.
   */
  removePerson(id: string): string[] {
    if (id === ADMIN) throw new Error("The admin can't be removed.");
    if (!this.getPerson(id)) return [];
    const bots = this.listBots(id).map((bot) => bot.id);
    for (const botId of bots) this.deleteBot(botId);
    for (const chat of this.listChats(id)) this.deleteChat(chat.id);
    for (const folder of this.listFolders(id)) this.deleteFolder(folder.id);
    this.db.prepare("DELETE FROM approvals WHERE approver_id = ?").run(id);
    this.db.prepare("DELETE FROM push_subscriptions WHERE person_id = ?").run(id);
    this.db.prepare("DELETE FROM usage WHERE owner_id = ?").run(id);
    this.db.prepare("DELETE FROM events WHERE person_id = ?").run(id);
    this.db.prepare("DELETE FROM people WHERE id = ?").run(id);
    return bots;
  }

  // ---------- Bots ----------
  /** Every Bot, or one person's. */
  listBots(ownerId?: string): Bot[] {
    const rows = ownerId
      ? this.db.prepare("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at").all(ownerId)
      : this.db.prepare("SELECT * FROM bots ORDER BY created_at").all();
    return (rows as Row[]).map(toBot);
  }

  getBot(id: string): Bot | null {
    const row = this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as Row | undefined;
    return row ? toBot(row) : null;
  }

  createBot(input: { name: string; title: string; description: string; model: string; computer: boolean; desktop?: boolean; faceSeed?: string; ownerId: string }): Bot {
    const id = newId();
    const chat = this.createChat({ kind: "bot", title: input.name, memberIds: [id], coordinatorId: id, ownerId: input.ownerId });
    this.db.prepare(`INSERT INTO bots (id, name, title, description, face_seed, model, computer, desktop, chat_id, owner_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name, input.title, input.description, input.faceSeed || input.name, input.model, input.computer ? 1 : 0,
      input.computer && input.desktop ? 1 : 0, chat.id, input.ownerId, Date.now(),
    );
    const bot = this.getBot(id)!;
    this.events.emit({ type: "bot.upserted", bot }, bot.ownerId);
    return bot;
  }

  updateBot(id: string, patch: Partial<Pick<Bot, "name" | "title" | "description" | "faceSeed" | "model" | "computer" | "desktop">>): Bot | null {
    const bot = this.getBot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch };
    // The desktop lives on the computer: no computer, no desktop.
    if (!next.computer) next.desktop = false;
    this.db.prepare("UPDATE bots SET name = ?, title = ?, description = ?, face_seed = ?, model = ?, computer = ?, desktop = ? WHERE id = ?")
      .run(next.name, next.title, next.description, next.faceSeed, next.model, next.computer ? 1 : 0, next.desktop ? 1 : 0, id);
    if (patch.name && patch.name !== bot.name) this.renameChat(bot.chatId, patch.name);
    const updated = this.getBot(id)!;
    this.events.emit({ type: "bot.upserted", bot: updated }, updated.ownerId);
    return updated;
  }

  deleteBot(id: string) {
    const bot = this.getBot(id);
    if (!bot) return;
    this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
    for (const routine of this.listRoutines(id)) this.deleteRoutine(routine.id);
    this.deleteChat(bot.chatId);
    for (const row of this.db.prepare("SELECT chat_id FROM chat_members WHERE bot_id = ?").all(id) as Row[]) {
      const chat = this.getChat(row.chat_id as string);
      // A thread can't outlive either Bot; topics just lose a member, and one left with no Bots is archived.
      if (chat?.kind === "thread") { this.deleteChat(chat.id); continue; }
      this.db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND bot_id = ?").run(row.chat_id as string, id);
      if (chat && chat.memberIds.length <= 1) this.db.prepare("UPDATE chats SET archived_at = COALESCE(archived_at, ?) WHERE id = ?").run(Date.now(), chat.id);
      if (chat?.coordinatorId === id) this.db.prepare("UPDATE chats SET coordinator_id = (SELECT bot_id FROM chat_members WHERE chat_id = ? LIMIT 1) WHERE id = ?").run(chat.id, chat.id);
      const updated = this.getChat(row.chat_id as string);
      if (updated) this.events.emit({ type: "chat.upserted", chat: updated }, updated.ownerId);
    }
    this.events.emit({ type: "bot.deleted", botId: id }, bot.ownerId);
  }

  setPresence(id: string, presence: Presence, activity: string | null = null) {
    const bot = this.getBot(id);
    if (!bot || (bot.presence === presence && bot.activity === activity)) return;
    this.db.prepare("UPDATE bots SET presence = ?, activity = ? WHERE id = ?").run(presence, activity, id);
    this.events.emit({ type: "bot.presence", botId: id, presence, activity }, bot.ownerId);
  }

  setComputerState(id: string, state: ComputerState) {
    const bot = this.getBot(id);
    if (!bot || bot.computerState === state) return;
    this.db.prepare("UPDATE bots SET computer_state = ? WHERE id = ?").run(state, id);
    this.events.emit({ type: "bot.upserted", bot: { ...bot, computerState: state } }, bot.ownerId);
  }

  // ---------- Chats ----------
  private members(chatId: string) {
    return (this.db.prepare("SELECT bot_id FROM chat_members WHERE chat_id = ? ORDER BY rowid").all(chatId) as Row[]).map((row) => row.bot_id as string);
  }

  private toChat(row: Row): Chat {
    return {
      id: row.id as string,
      kind: row.kind as Chat["kind"],
      title: row.title as string,
      memberIds: this.members(row.id as string),
      coordinatorId: (row.coordinator_id as string | null) ?? null,
      icon: (row.icon as TopicIcon | null) ?? null,
      folderId: (row.folder_id as string | null) ?? null,
      brief: (row.brief as string | null) ?? "",
      archivedAt: (row.archived_at as number | null) ?? null,
      lastPreview: (row.last_preview as string | null) ?? null,
      lastAuthor: (row.last_author as string | null) ?? null,
      updatedAt: row.updated_at as number,
      unread: row.unread as number,
      ownerId: (row.owner_id as string | undefined) ?? ADMIN,
    };
  }

  /** Every chat, or one person's. */
  listChats(ownerId?: string): Chat[] {
    const rows = ownerId
      ? this.db.prepare("SELECT * FROM chats WHERE owner_id = ? ORDER BY updated_at DESC").all(ownerId)
      : this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all();
    return (rows as Row[]).map((row) => this.toChat(row));
  }

  getChat(id: string): Chat | null {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toChat(row) : null;
  }

  /**
   * A new chat, owned by `ownerId`. Its Bots must all be theirs: there are no shared topics.
   * (A Bot's own chat is made before the Bot, so its one member isn't in the table yet.)
   */
  createChat(input: { kind: Chat["kind"]; title: string; memberIds: string[]; coordinatorId: string | null; icon?: TopicIcon; folderId?: string | null; brief?: string; ownerId: string }): Chat {
    if (input.kind !== "bot") this.assertTheirs(input.ownerId, input.memberIds, input.folderId);
    const id = newId();
    this.db.prepare("INSERT INTO chats (id, kind, title, coordinator_id, icon, folder_id, brief, owner_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.kind, input.title, input.coordinatorId, input.icon ?? null, input.folderId ?? null, input.brief ?? "", input.ownerId, Date.now());
    for (const botId of input.memberIds) this.db.prepare("INSERT INTO chat_members (chat_id, bot_id) VALUES (?, ?)").run(id, botId);
    const chat = this.getChat(id)!;
    this.events.emit({ type: "chat.upserted", chat }, chat.ownerId);
    return chat;
  }

  /** The last line of defence against sharing: a chat's Bots and folder are its owner's. */
  private assertTheirs(ownerId: string, botIds: string[], folderId?: string | null) {
    if (botIds.some((botId) => this.botOwner(botId) !== ownerId)) throw new Error("A chat can only have its owner's own Bots in it.");
    if (folderId && this.getFolder(folderId)?.ownerId !== ownerId) throw new Error("That folder doesn't exist.");
  }

  /** The private thread between two Bots, if they've talked before. */
  findThread(a: string, b: string): Chat | null {
    const row = this.db.prepare(`SELECT c.* FROM chats c
      JOIN chat_members x ON x.chat_id = c.id AND x.bot_id = ?
      JOIN chat_members y ON y.chat_id = c.id AND y.bot_id = ?
      WHERE c.kind = 'thread' LIMIT 1`).get(a, b) as Row | undefined;
    return row ? this.toChat(row) : null;
  }

  private renameChat(id: string, title: string) {
    this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, id);
    const chat = this.getChat(id);
    if (chat) this.events.emit({ type: "chat.upserted", chat }, chat.ownerId);
  }

  updateTopic(id: string, patch: { title?: string; icon?: TopicIcon; brief?: string; folderId?: string | null; archived?: boolean; memberIds?: string[]; coordinatorId?: string | null }) {
    const chat = this.getChat(id);
    if (!chat || chat.kind !== "topic") return null;
    this.assertTheirs(chat.ownerId, patch.memberIds ?? [], patch.folderId);
    if (patch.title !== undefined) this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(patch.title, id);
    if (patch.icon !== undefined) this.db.prepare("UPDATE chats SET icon = ? WHERE id = ?").run(patch.icon, id);
    if (patch.brief !== undefined) this.db.prepare("UPDATE chats SET brief = ? WHERE id = ?").run(patch.brief, id);
    if (patch.folderId !== undefined) this.db.prepare("UPDATE chats SET folder_id = ? WHERE id = ?").run(patch.folderId, id);
    if (patch.archived !== undefined) this.db.prepare("UPDATE chats SET archived_at = ? WHERE id = ?").run(patch.archived ? Date.now() : null, id);
    if (patch.coordinatorId !== undefined) this.db.prepare("UPDATE chats SET coordinator_id = ? WHERE id = ?").run(patch.coordinatorId, id);
    if (patch.memberIds) {
      this.db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(id);
      for (const botId of patch.memberIds) this.db.prepare("INSERT INTO chat_members (chat_id, bot_id) VALUES (?, ?)").run(id, botId);
    }
    const updated = this.getChat(id)!;
    this.events.emit({ type: "chat.upserted", chat: updated }, updated.ownerId);
    return updated;
  }

  // ---------- A chat's Doc ----------
  getArtifact(chatId: string): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE chat_id = ?").get(chatId) as Row | undefined;
    return row ? toArtifact(row) : null;
  }

  /** Writes a new version of the chat's Doc (creating it on first write) and keeps the old one in its history. */
  saveArtifact(chatId: string, input: { title?: string; status?: string; body: string; note: string; by: string }): Artifact {
    const current = this.getArtifact(chatId);
    const now = Date.now();
    const next: Artifact = {
      id: current?.id ?? newId(), chatId,
      title: input.title ?? current?.title ?? "Doc", status: input.status ?? current?.status ?? "",
      body: input.body, version: (current?.version ?? 0) + 1, note: input.note, updatedBy: input.by, updatedAt: now,
    };
    this.db.prepare(`INSERT INTO artifacts (id, chat_id, title, status, body, version, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, status = excluded.status, body = excluded.body, version = excluded.version,
        note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(next.id, chatId, next.title, next.status, next.body, next.version, next.note, next.updatedBy, now);
    this.db.prepare(`INSERT INTO artifact_versions (artifact_id, version, title, status, body, note, updated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(next.id, next.version, next.title, next.status, next.body, next.note, next.updatedBy, now);
    this.events.emit({ type: "artifact.upserted", artifact: next }, this.chatOwner(chatId));
    return next;
  }

  /** Every version of a Doc, newest first. */
  listArtifactVersions(artifactId: string): ArtifactVersion[] {
    return (this.db.prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC").all(artifactId) as Row[]).map((row) => ({
      title: row.title as string, status: row.status as string, body: row.body as string, version: row.version as number,
      note: row.note as string, updatedBy: row.updated_by as string, createdAt: row.created_at as number,
    }));
  }

  // ---------- Chat files ----------
  addFile(input: Omit<ChatFile, "id" | "createdAt">): ChatFile {
    const file: ChatFile = { ...input, id: newId(), createdAt: Date.now() };
    this.db.prepare("INSERT INTO chat_files (id, chat_id, name, mime, size, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(file.id, file.chatId, file.name, file.mime, file.size, file.addedBy, file.createdAt);
    this.events.emit({ type: "file.upserted", file }, this.chatOwner(file.chatId));
    return file;
  }

  listFiles(chatId: string): ChatFile[] {
    return (this.db.prepare("SELECT * FROM chat_files WHERE chat_id = ? ORDER BY created_at DESC").all(chatId) as Row[]).map(toFile);
  }

  getFile(id: string): ChatFile | null {
    const row = this.db.prepare("SELECT * FROM chat_files WHERE id = ?").get(id) as Row | undefined;
    return row ? toFile(row) : null;
  }

  deleteFile(id: string) {
    const file = this.getFile(id);
    if (!file) return null;
    this.db.prepare("DELETE FROM chat_files WHERE id = ?").run(id);
    this.events.emit({ type: "file.deleted", chatId: file.chatId, fileId: id }, this.chatOwner(file.chatId));
    return file;
  }

  // ---------- Spending ----------
  /** One model call's usage, counted against the owner of the Bot that made it. */
  recordUsage(entry: Omit<UsageRow, "id" | "at">, at = Date.now()) {
    this.db.prepare(`INSERT INTO usage (id, at, bot_id, owner_id, provider_id, model, input_tokens, output_tokens, cached_tokens, cost_micros)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId(), at, entry.botId, this.botOwner(entry.botId), entry.providerId, entry.model, entry.inputTokens, entry.outputTokens, entry.cachedTokens, entry.costMicros);
  }

  /** One person's usage since a time, oldest first. */
  listUsage(since: number, ownerId: string): UsageRow[] {
    return (this.db.prepare("SELECT * FROM usage WHERE at >= ? AND owner_id = ? ORDER BY at").all(since, ownerId) as Row[]).map((row) => ({
      id: row.id as string, at: row.at as number, botId: row.bot_id as string, providerId: row.provider_id as string,
      model: row.model as string, inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number, cachedTokens: row.cached_tokens as number, costMicros: (row.cost_micros as number | null) ?? null,
    }));
  }

  // ---------- PCs (nodes) ----------
  /** The admin's PCs (lending a PC is the admin's), most recently seen first. `online` is filled in by the node hub. */
  listNodes(): Omit<PcNode, "online">[] {
    return (this.db.prepare("SELECT * FROM nodes WHERE person_id = 'owner' ORDER BY last_seen DESC").all() as Row[]).map((row) => ({
      id: row.id as string, name: row.name as string, platform: row.platform as string,
      capabilities: JSON.parse(row.capabilities as string) as PcCapability[], lastSeen: row.last_seen as number,
    }));
  }

  saveNode(node: { id: string; name: string; platform: string; capabilities: PcCapability[] }) {
    this.db.prepare(`INSERT INTO nodes (id, name, platform, capabilities, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, platform = excluded.platform, capabilities = excluded.capabilities, last_seen = excluded.last_seen`)
      .run(node.id, node.name, node.platform, JSON.stringify(node.capabilities), Date.now());
  }

  deleteNode(id: string) {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  }

  // ---------- Folders ----------
  /** Every folder, or one person's. */
  listFolders(ownerId?: string): Folder[] {
    const rows = ownerId
      ? this.db.prepare("SELECT * FROM folders WHERE owner_id = ? ORDER BY position, created_at").all(ownerId)
      : this.db.prepare("SELECT * FROM folders ORDER BY position, created_at").all();
    return (rows as Row[]).map((row) => ({
      id: row.id as string, title: row.title as string, position: row.position as number, ownerId: (row.owner_id as string | undefined) ?? ADMIN, createdAt: row.created_at as number,
    }));
  }

  getFolder(id: string): Folder | null {
    return this.listFolders().find((folder) => folder.id === id) ?? null;
  }

  createFolder(title: string, ownerId: string): Folder {
    const id = newId();
    const position = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM folders WHERE owner_id = ?").get(ownerId) as { next: number }).next;
    this.db.prepare("INSERT INTO folders (id, title, position, owner_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, title, position, ownerId, Date.now());
    const folder = this.getFolder(id)!;
    this.events.emit({ type: "folder.upserted", folder }, folder.ownerId);
    return folder;
  }

  updateFolder(id: string, patch: { title?: string; position?: number }) {
    if (!this.getFolder(id)) return null;
    if (patch.title !== undefined) this.db.prepare("UPDATE folders SET title = ? WHERE id = ?").run(patch.title, id);
    if (patch.position !== undefined) this.db.prepare("UPDATE folders SET position = ? WHERE id = ?").run(patch.position, id);
    const folder = this.getFolder(id)!;
    this.events.emit({ type: "folder.upserted", folder }, folder.ownerId);
    return folder;
  }

  /** Topics in a deleted folder stay; they just aren't filed any more. */
  deleteFolder(id: string) {
    const folder = this.getFolder(id);
    if (!folder) return;
    const filed = this.db.prepare("SELECT id FROM chats WHERE folder_id = ?").all(id) as Row[];
    this.db.prepare("UPDATE chats SET folder_id = NULL WHERE folder_id = ?").run(id);
    this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    for (const row of filed) { const chat = this.getChat(row.id as string); if (chat) this.events.emit({ type: "chat.upserted", chat }, chat.ownerId); }
    this.events.emit({ type: "folder.deleted", folderId: id }, folder.ownerId);
  }

  deleteChat(id: string) {
    const ownerId = this.chatOwner(id);
    // Routines that posted to a deleted topic fall back to their Bot's own chat.
    for (const row of this.db.prepare("SELECT id, bot_id FROM routines WHERE chat_id = ?").all(id) as Row[]) {
      const bot = this.getBot(row.bot_id as string);
      if (bot && bot.chatId !== id) this.updateRoutine(row.id as string, { chatId: bot.chatId });
      else this.deleteRoutine(row.id as string);
    }
    this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(id);
    this.db.prepare("DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE chat_id = ?)").run(id);
    this.db.prepare("DELETE FROM artifacts WHERE chat_id = ?").run(id);
    this.db.prepare("DELETE FROM chat_files WHERE chat_id = ?").run(id);
    removeChatFolder(id);
    this.db.prepare("DELETE FROM conversations WHERE chat_id = ?").run(id);
    this.db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(id);
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    this.events.emit({ type: "chat.deleted", chatId: id }, ownerId);
  }

  markRead(id: string) {
    this.db.prepare("UPDATE chats SET unread = 0 WHERE id = ?").run(id);
    const chat = this.getChat(id);
    if (chat) this.events.emit({ type: "chat.upserted", chat }, chat.ownerId);
  }

  private touchChat(message: Message) {
    const preview = plainText(message.text).slice(0, 140);
    if (!preview) return;
    const fromBot = message.author !== "user" && message.author !== "system";
    const thread = this.getChat(message.chatId)?.kind === "thread";
    this.db.prepare(`UPDATE chats SET last_preview = ?, last_author = ?, updated_at = ?, unread = unread + ? WHERE id = ?`)
      .run(preview, message.author, Date.now(), fromBot && !thread && message.status !== "streaming" ? 1 : 0, message.chatId);
    const chat = this.getChat(message.chatId);
    if (chat) this.events.emit({ type: "chat.upserted", chat }, chat.ownerId);
  }

  // ---------- Messages ----------
  listMessages(chatId: string, options: { before?: number; limit?: number } = {}): Message[] {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
      .all(chatId, options.before ?? Number.MAX_SAFE_INTEGER, options.limit ?? 50) as Row[];
    return rows.map(toMessage).reverse();
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  createMessage(input: { chatId: string; author: string; text?: string; status?: MessageStatus; cards?: Card[]; delivery?: Delivery; attachments?: Attachment[]; via?: Message["via"] }): Message {
    const id = newId();
    // Strictly increasing timestamps keep ordering stable within the same millisecond.
    const last = this.db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE chat_id = ?").get(input.chatId) as { t: number | null };
    const createdAt = Math.max(Date.now(), (last.t ?? 0) + 1);
    this.db.prepare(`INSERT INTO messages (id, chat_id, author, text, cards, status, delivery, attachments, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.chatId, input.author, input.text ?? "", JSON.stringify(input.cards ?? []), input.status ?? "done", input.delivery ?? null, JSON.stringify(input.attachments ?? []), input.via ?? null, createdAt);
    const message = this.getMessage(id)!;
    this.events.emit({ type: "message.upserted", message }, this.chatOwner(message.chatId));
    if (message.status !== "streaming") this.touchChat(message);
    return message;
  }

  updateMessage(id: string, patch: Partial<Pick<Message, "text" | "reasoning" | "steps" | "cards" | "status" | "error" | "delivery" | "steeredAt">>, options: { emit?: boolean } = {}) {
    const message = this.getMessage(id);
    if (!message) return null;
    const next = { ...message, ...patch };
    this.db.prepare(`UPDATE messages SET text = ?, reasoning = ?, steps = ?, cards = ?, status = ?, error = ?, delivery = ?, steered_at = ? WHERE id = ?`)
      .run(next.text, next.reasoning, JSON.stringify(next.steps), JSON.stringify(next.cards), next.status, next.error, next.delivery, next.steeredAt, id);
    if (options.emit !== false) this.events.emit({ type: "message.upserted", message: next }, this.chatOwner(next.chatId));
    if (message.status === "streaming" && next.status !== "streaming") this.touchChat(next);
    return next;
  }

  /** Only used for a queued message the user takes back before the Bot sees it. */
  deleteMessage(id: string) {
    const message = this.getMessage(id);
    if (!message) return;
    this.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    this.events.emit({ type: "message.deleted", chatId: message.chatId, messageId: id }, this.chatOwner(message.chatId));
  }

  appendCard(messageId: string, card: Card) {
    const message = this.getMessage(messageId);
    if (message) this.updateMessage(messageId, { cards: [...message.cards, card] });
  }

  /** Adds messages exchanged with another Bot to the reply's single handoff card. */
  recordHandoff(messageId: string, thread: { botId: string; chatId: string }, count: number) {
    const message = this.getMessage(messageId);
    if (!message) return;
    const existing = message.cards.find((card) => card.type === "handoff");
    const threads = existing?.type === "handoff" ? existing.threads.map((item) => ({ ...item })) : [];
    const entry = threads.find((item) => item.chatId === thread.chatId);
    if (entry) entry.count += count;
    else threads.push({ ...thread, count });
    const card: Card = { type: "handoff", threads };
    this.updateMessage(messageId, { cards: existing ? message.cards.map((item) => (item === existing ? card : item)) : [...message.cards, card] });
  }

  // ---------- Routines ----------
  listRoutines(botId?: string): Routine[] {
    const rows = botId
      ? this.db.prepare("SELECT * FROM routines WHERE bot_id = ? ORDER BY created_at").all(botId)
      : this.db.prepare("SELECT * FROM routines ORDER BY created_at").all();
    return (rows as Row[]).map(toRoutine);
  }

  /** The routines of one person's Bots. */
  routinesOf(ownerId: string): Routine[] {
    return (this.db.prepare("SELECT r.* FROM routines r JOIN bots b ON b.id = r.bot_id WHERE b.owner_id = ? ORDER BY r.created_at").all(ownerId) as Row[]).map(toRoutine);
  }

  getRoutine(id: string): Routine | null {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as Row | undefined;
    return row ? toRoutine(row) : null;
  }

  dueRoutines(now: number): Routine[] {
    return (this.db.prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at").all(now) as Row[]).map(toRoutine);
  }

  createRoutine(input: { botId: string; chatId: string; title: string; prompt: string; schedule: Schedule }): Routine {
    const id = newId();
    const now = Date.now();
    this.db.prepare(`INSERT INTO routines (id, bot_id, chat_id, title, prompt, schedule, enabled, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, input.botId, input.chatId, input.title, input.prompt, JSON.stringify(input.schedule), nextRun(input.schedule, now), now);
    const routine = this.getRoutine(id)!;
    this.events.emit({ type: "routine.upserted", routine }, this.botOwner(routine.botId));
    return routine;
  }

  /** Changing the schedule or re-enabling recomputes the next run unless one is given. */
  updateRoutine(id: string, patch: RoutinePatch): Routine | null {
    const routine = this.getRoutine(id);
    if (!routine) return null;
    const next = { ...routine, ...patch };
    if (patch.nextRunAt === undefined && (patch.schedule || (patch.enabled && !routine.enabled))) next.nextRunAt = nextRun(next.schedule, Date.now());
    this.db.prepare(`UPDATE routines SET chat_id = ?, title = ?, prompt = ?, schedule = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_status = ? WHERE id = ?`)
      .run(next.chatId, next.title, next.prompt, JSON.stringify(next.schedule), next.enabled ? 1 : 0, next.nextRunAt, next.lastRunAt, next.lastStatus, id);
    const updated = this.getRoutine(id)!;
    this.events.emit({ type: "routine.upserted", routine: updated }, this.botOwner(updated.botId));
    return updated;
  }

  deleteRoutine(id: string) {
    const routine = this.getRoutine(id);
    if (!routine) return;
    this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
    // The Bot may already be gone (deleteBot removes its routines after it).
    const ownerId = this.botOwner(routine.botId);
    this.events.emit({ type: "routine.deleted", routineId: id }, ownerId === NOBODY ? this.chatOwner(routine.chatId) : ownerId);
  }

  // ---------- Approvals ----------
  /** Asks the owner of the Bot that wants to act: only they can answer. */
  createApproval(input: ApprovalRequest): Approval {
    const id = newId();
    const approverId = this.botOwner(input.botId);
    if (approverId === NOBODY) throw new Error("That Bot no longer exists.");
    this.db.prepare(`INSERT INTO approvals (id, bot_id, chat_id, message_id, tool, summary, detail, reason, approver_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, input.botId, input.chatId, input.messageId, input.tool, input.summary, input.detail, input.reason, approverId, Date.now());
    const approval = this.getApproval(id)!;
    this.events.emit({ type: "approval.upserted", approval }, approval.approverId);
    return approval;
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  listApprovals(status?: ApprovalStatus): Approval[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at").all(status)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200").all();
    return (rows as Row[]).map(toApproval);
  }

  /** The approvals waiting for (or recently answered by) one person, newest first. */
  approvalsFor(approverId: string): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE approver_id = ? ORDER BY created_at DESC LIMIT 200").all(approverId) as Row[]).map(toApproval);
  }

  resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | null {
    const approval = this.getApproval(id);
    if (!approval || approval.status !== "pending") return approval;
    this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?").run(status, Date.now(), id);
    const resolved = this.getApproval(id)!;
    this.events.emit({ type: "approval.upserted", approval: resolved }, resolved.approverId);
    return resolved;
  }

  /**
   * On startup nothing is running yet. Turns with a recent checkpoint are kept to be resumed
   * (with their pending approvals); every other leftover streaming reply, approval and checkpoint
   * is stale. Returns the runs to resume.
   */
  recoverAfterRestart(maxAgeMs: number, now = Date.now()): RunCheckpoint[] {
    const resumable = this.listRuns().filter((run) => {
      const message = this.getMessage(run.messageId);
      return now - run.updatedAt < maxAgeMs && message?.status === "streaming" && this.getBot(run.botId) && this.getChat(run.chatId);
    });
    const keep = new Set(resumable.map((run) => run.messageId));
    for (const run of this.listRuns()) if (!resumable.includes(run)) this.deleteRun(run.id);
    for (const approval of this.listApprovals("pending")) if (!keep.has(approval.messageId)) this.resolveApproval(approval.id, "expired");
    for (const row of this.db.prepare("SELECT id FROM messages WHERE status = 'streaming'").all() as Row[]) {
      if (!keep.has(row.id as string)) this.updateMessage(row.id as string, { status: "stopped", error: "Colony restarted while this reply was running." });
    }
    for (const bot of this.listBots()) this.setPresence(bot.id, "idle");
    return resumable;
  }

  // ---------- Run checkpoints (durable runs) ----------
  saveRun(run: RunCheckpoint) {
    this.db.prepare(`INSERT INTO runs (id, chat_id, bot_id, message_id, steps_before, messages, options, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET message_id = excluded.message_id, steps_before = excluded.steps_before, messages = excluded.messages, updated_at = excluded.updated_at`)
      .run(run.id, run.chatId, run.botId, run.messageId, run.stepsBefore, run.messages, JSON.stringify(run.options), run.startedAt, run.updatedAt);
  }

  listRuns(): RunCheckpoint[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at").all() as Row[]).map((row) => ({
      id: row.id as string,
      chatId: row.chat_id as string,
      botId: row.bot_id as string,
      messageId: row.message_id as string,
      stepsBefore: row.steps_before as number,
      messages: row.messages as string,
      options: JSON.parse(row.options as string) as RunCheckpoint["options"],
      startedAt: row.started_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  deleteRun(id: string) {
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  }

  // ---------- Persistent conversations (pi durable) ----------
  /** The conversation a Bot keeps in a chat, if it has one. */
  conversationOf(chatId: string, botId: string): { conversationId: string; createdAt: number } | null {
    const row = this.db.prepare("SELECT conversation_id, created_at FROM conversations WHERE chat_id = ? AND bot_id = ?").get(chatId, botId) as Row | undefined;
    return row ? { conversationId: row.conversation_id as string, createdAt: row.created_at as number } : null;
  }

  /** Which chat and Bot a conversation belongs to. */
  conversationOwner(conversationId: string): { chatId: string; botId: string } | null {
    const row = this.db.prepare("SELECT chat_id, bot_id FROM conversations WHERE conversation_id = ?").get(conversationId) as Row | undefined;
    return row ? { chatId: row.chat_id as string, botId: row.bot_id as string } : null;
  }

  /** Links (or relinks: "start fresh", a branch) a Bot's conversation in a chat. */
  linkConversation(chatId: string, botId: string, conversationId: string, createdAt = Date.now()) {
    this.db.prepare(`INSERT INTO conversations (chat_id, bot_id, conversation_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id, bot_id) DO UPDATE SET conversation_id = excluded.conversation_id, created_at = excluded.created_at`).run(chatId, botId, conversationId, createdAt);
  }

  /** Chat messages a conversation has already taken in, of these. */
  seenBy(conversationId: string, messageIds: string[]): Set<string> {
    if (!messageIds.length) return new Set();
    const rows = this.db.prepare(`SELECT message_id FROM conversation_seen WHERE conversation_id = ? AND message_id IN (${messageIds.map(() => "?").join(",")})`)
      .all(conversationId, ...messageIds) as Row[];
    return new Set(rows.map((row) => row.message_id as string));
  }

  markSeen(conversationId: string, messageIds: string[]) {
    for (const id of messageIds) this.db.prepare("INSERT OR IGNORE INTO conversation_seen (conversation_id, message_id) VALUES (?, ?)").run(conversationId, id);
  }

  /** Where a Bot's reply ended in its conversation (a branch starts there). */
  setMessageEntry(messageId: string, conversationId: string, entryId: string) {
    this.db.prepare(`INSERT INTO message_entries (message_id, conversation_id, entry_id) VALUES (?, ?, ?)
      ON CONFLICT (message_id) DO UPDATE SET conversation_id = excluded.conversation_id, entry_id = excluded.entry_id`).run(messageId, conversationId, entryId);
  }

  messageEntry(messageId: string): { conversationId: string; entryId: string } | null {
    const row = this.db.prepare("SELECT conversation_id, entry_id FROM message_entries WHERE message_id = ?").get(messageId) as Row | undefined;
    return row ? { conversationId: row.conversation_id as string, entryId: row.entry_id as string } : null;
  }

  // ---------- Mail waiting to trigger a routine ----------
  pendingTriggers(): Map<string, unknown[]> {
    const rows = this.db.prepare("SELECT routine_id, mail FROM pending_triggers").all() as Row[];
    return new Map(rows.map((row) => [row.routine_id as string, JSON.parse(row.mail as string) as unknown[]]));
  }

  setPendingTrigger(routineId: string, mail: unknown[] | null) {
    if (!mail?.length) this.db.prepare("DELETE FROM pending_triggers WHERE routine_id = ?").run(routineId);
    else this.db.prepare(`INSERT INTO pending_triggers (routine_id, mail, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (routine_id) DO UPDATE SET mail = excluded.mail, updated_at = excluded.updated_at`).run(routineId, JSON.stringify(mail), Date.now());
  }
}

