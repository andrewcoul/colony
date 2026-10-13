import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { EventLog } from "./events.js";
import type { Approval, ApprovalStatus, Bot, Card, Chat, Message, MessageStatus, Presence, Step } from "./shared/types.js";

type Row = Record<string, unknown>;

const toBot = (row: Row): Bot => ({
  id: row.id as string,
  name: row.name as string,
  title: row.title as string,
  description: row.description as string,
  faceSeed: row.face_seed as string,
  model: row.model as string,
  computer: Boolean(row.computer),
  presence: row.presence as Presence,
  activity: (row.activity as string | null) ?? null,
  chatId: row.chat_id as string,
  createdAt: row.created_at as number,
});

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
  createdAt: row.created_at as number,
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
  status: row.status as ApprovalStatus,
  createdAt: row.created_at as number,
  resolvedAt: (row.resolved_at as number | null) ?? null,
});

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

/** All persistent state. Every mutation emits the matching event. */
export class Store {
  constructor(private db: Db, private events: EventLog) {}

  // ---------- Bots ----------
  listBots(): Bot[] {
    return (this.db.prepare("SELECT * FROM bots ORDER BY created_at").all() as Row[]).map(toBot);
  }

  getBot(id: string): Bot | null {
    const row = this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as Row | undefined;
    return row ? toBot(row) : null;
  }

  createBot(input: { name: string; title: string; description: string; model: string; computer: boolean; faceSeed?: string }): Bot {
    const id = newId();
    const chat = this.createChat({ kind: "bot", title: input.name, memberIds: [id], coordinatorId: id });
    this.db.prepare(`INSERT INTO bots (id, name, title, description, face_seed, model, computer, chat_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name, input.title, input.description, input.faceSeed || input.name, input.model, input.computer ? 1 : 0, chat.id, Date.now(),
    );
    const bot = this.getBot(id)!;
    this.events.emit({ type: "bot.upserted", bot });
    return bot;
  }

  updateBot(id: string, patch: Partial<Pick<Bot, "name" | "title" | "description" | "faceSeed" | "model" | "computer">>): Bot | null {
    const bot = this.getBot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch };
    this.db.prepare("UPDATE bots SET name = ?, title = ?, description = ?, face_seed = ?, model = ?, computer = ? WHERE id = ?")
      .run(next.name, next.title, next.description, next.faceSeed, next.model, next.computer ? 1 : 0, id);
    if (patch.name && patch.name !== bot.name) this.renameChat(bot.chatId, patch.name);
    const updated = this.getBot(id)!;
    this.events.emit({ type: "bot.upserted", bot: updated });
    return updated;
  }

  deleteBot(id: string) {
    const bot = this.getBot(id);
    if (!bot) return;
    this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
    this.deleteChat(bot.chatId);
    for (const row of this.db.prepare("SELECT chat_id FROM chat_members WHERE bot_id = ?").all(id) as Row[]) {
      this.db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND bot_id = ?").run(row.chat_id as string, id);
      const chat = this.getChat(row.chat_id as string);
      if (chat) this.events.emit({ type: "chat.upserted", chat });
    }
    this.events.emit({ type: "bot.deleted", botId: id });
  }

  setPresence(id: string, presence: Presence, activity: string | null = null) {
    const bot = this.getBot(id);
    if (!bot || (bot.presence === presence && bot.activity === activity)) return;
    this.db.prepare("UPDATE bots SET presence = ?, activity = ? WHERE id = ?").run(presence, activity, id);
    this.events.emit({ type: "bot.presence", botId: id, presence, activity });
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
      lastPreview: (row.last_preview as string | null) ?? null,
      lastAuthor: (row.last_author as string | null) ?? null,
      updatedAt: row.updated_at as number,
      unread: row.unread as number,
    };
  }

  listChats(): Chat[] {
    return (this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all() as Row[]).map((row) => this.toChat(row));
  }

  getChat(id: string): Chat | null {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toChat(row) : null;
  }

  createChat(input: { kind: Chat["kind"]; title: string; memberIds: string[]; coordinatorId: string | null }): Chat {
    const id = newId();
    this.db.prepare("INSERT INTO chats (id, kind, title, coordinator_id, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.kind, input.title, input.coordinatorId, Date.now());
    for (const botId of input.memberIds) this.db.prepare("INSERT INTO chat_members (chat_id, bot_id) VALUES (?, ?)").run(id, botId);
    const chat = this.getChat(id)!;
    this.events.emit({ type: "chat.upserted", chat });
    return chat;
  }

  private renameChat(id: string, title: string) {
    this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, id);
    const chat = this.getChat(id);
    if (chat) this.events.emit({ type: "chat.upserted", chat });
  }

  updateGroup(id: string, patch: { title?: string; memberIds?: string[]; coordinatorId?: string | null }) {
    const chat = this.getChat(id);
    if (!chat || chat.kind !== "group") return null;
    if (patch.title !== undefined) this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(patch.title, id);
    if (patch.coordinatorId !== undefined) this.db.prepare("UPDATE chats SET coordinator_id = ? WHERE id = ?").run(patch.coordinatorId, id);
    if (patch.memberIds) {
      this.db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(id);
      for (const botId of patch.memberIds) this.db.prepare("INSERT INTO chat_members (chat_id, bot_id) VALUES (?, ?)").run(id, botId);
    }
    const updated = this.getChat(id)!;
    this.events.emit({ type: "chat.upserted", chat: updated });
    return updated;
  }

  deleteChat(id: string) {
    this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(id);
    this.db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(id);
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    this.events.emit({ type: "chat.deleted", chatId: id });
  }

  markRead(id: string) {
    this.db.prepare("UPDATE chats SET unread = 0 WHERE id = ?").run(id);
    const chat = this.getChat(id);
    if (chat) this.events.emit({ type: "chat.upserted", chat });
  }

  private touchChat(message: Message) {
    const preview = plainText(message.text).slice(0, 140);
    if (!preview) return;
    const fromBot = message.author !== "user" && message.author !== "system";
    this.db.prepare(`UPDATE chats SET last_preview = ?, last_author = ?, updated_at = ?, unread = unread + ? WHERE id = ?`)
      .run(preview, message.author, Date.now(), fromBot && message.status !== "streaming" ? 1 : 0, message.chatId);
    const chat = this.getChat(message.chatId);
    if (chat) this.events.emit({ type: "chat.upserted", chat });
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

  createMessage(input: { chatId: string; author: string; text?: string; status?: MessageStatus; cards?: Card[] }): Message {
    const id = newId();
    // Strictly increasing timestamps keep ordering stable within the same millisecond.
    const last = this.db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE chat_id = ?").get(input.chatId) as { t: number | null };
    const createdAt = Math.max(Date.now(), (last.t ?? 0) + 1);
    this.db.prepare(`INSERT INTO messages (id, chat_id, author, text, cards, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.chatId, input.author, input.text ?? "", JSON.stringify(input.cards ?? []), input.status ?? "done", createdAt);
    const message = this.getMessage(id)!;
    this.events.emit({ type: "message.upserted", message });
    if (message.status !== "streaming") this.touchChat(message);
    return message;
  }

  updateMessage(id: string, patch: Partial<Pick<Message, "text" | "reasoning" | "steps" | "cards" | "status" | "error">>, options: { emit?: boolean } = {}) {
    const message = this.getMessage(id);
    if (!message) return null;
    const next = { ...message, ...patch };
    this.db.prepare(`UPDATE messages SET text = ?, reasoning = ?, steps = ?, cards = ?, status = ?, error = ? WHERE id = ?`)
      .run(next.text, next.reasoning, JSON.stringify(next.steps), JSON.stringify(next.cards), next.status, next.error, id);
    if (options.emit !== false) this.events.emit({ type: "message.upserted", message: next });
    if (message.status === "streaming" && next.status !== "streaming") this.touchChat(next);
    return next;
  }

  // ---------- Approvals ----------
  createApproval(input: Omit<Approval, "id" | "status" | "createdAt" | "resolvedAt">): Approval {
    const id = newId();
    this.db.prepare(`INSERT INTO approvals (id, bot_id, chat_id, message_id, tool, summary, detail, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, input.botId, input.chatId, input.messageId, input.tool, input.summary, input.detail, input.reason, Date.now());
    const approval = this.getApproval(id)!;
    this.events.emit({ type: "approval.upserted", approval });
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

  resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | null {
    const approval = this.getApproval(id);
    if (!approval || approval.status !== "pending") return approval;
    this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?").run(status, Date.now(), id);
    const resolved = this.getApproval(id)!;
    this.events.emit({ type: "approval.upserted", approval: resolved });
    return resolved;
  }

  /** On startup nothing is running, so leftover pending/streaming state is stale. */
  recoverAfterRestart() {
    for (const approval of this.listApprovals("pending")) this.resolveApproval(approval.id, "expired");
    for (const row of this.db.prepare("SELECT id FROM messages WHERE status = 'streaming'").all() as Row[]) {
      this.updateMessage(row.id as string, { status: "stopped", error: "Colony restarted while this reply was running." });
    }
    for (const bot of this.listBots()) this.setPresence(bot.id, "idle");
  }
}
