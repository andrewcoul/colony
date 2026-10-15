import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { config } from "./config.js";
import type { Db } from "./db.js";
import type { EventLog } from "./events.js";
import { plainText, type Store } from "./store.js";
import type { Message } from "./shared/types.js";

export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };
/** `path` overrides where a tap opens (default: the chat). */
type Notification = { title: string; body: string; chatId: string | null; tag: string; path?: string };

/** Only notify about replies that finished recently (not old messages touched later). */
const FRESH_MS = 30 * 60_000;

/**
 * Web Push to your devices. Keys are generated on first start and kept in data/push.json.
 * Bots notify when they finish a reply or need an approval, unless you're looking at that chat.
 */
export class PushService {
  readonly publicKey: string;
  private focus = new Map<string, { chatId: string | null; visible: boolean }>();
  private streams = new Map<string, number>();
  private notified = new Set<string>();

  constructor(private db: Db, private store: Store, events: EventLog, private send = webpush.sendNotification.bind(webpush)) {
    const file = path.join(config.dataDir, "push.json");
    let keys: { publicKey: string; privateKey: string };
    try {
      keys = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      keys = webpush.generateVAPIDKeys();
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    }
    this.publicKey = keys.publicKey;
    // Push services want a contact; Apple rejects localhost addresses.
    webpush.setVapidDetails(process.env.COLONY_PUSH_CONTACT ?? "mailto:colony@users.noreply.github.com", keys.publicKey, keys.privateKey);
    events.subscribe(({ event }) => {
      if (event.type === "message.upserted") this.onMessage(event.message);
      else if (event.type === "approval.upserted" && event.approval.status === "pending") {
        const bot = this.store.getBot(event.approval.botId);
        // A browser takeover opens straight into that Bot's browser.
        const path = event.approval.tool === "browser_takeover" ? `${bot?.chatId}/browser` : undefined;
        if (bot) void this.notify({ title: `${bot.name} needs you`, body: event.approval.summary, chatId: event.approval.chatId, tag: `approval-${event.approval.id}`, path });
      }
    });
  }

  subscribe(subscription: PushSubscriptionInput) {
    this.db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now());
  }

  unsubscribe(endpoint: string) {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  isSubscribed(endpoint: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint));
  }

  /** Which chat each open app window is showing, so we don't buzz the phone for what's on screen. */
  setFocus(clientId: string, chatId: string | null, visible: boolean) {
    this.focus.set(clientId, { chatId, visible });
  }

  /** Counts a window's open event streams; its focus is forgotten when the last one closes. */
  attachClient(clientId: string) {
    this.streams.set(clientId, (this.streams.get(clientId) ?? 0) + 1);
    return () => {
      const left = (this.streams.get(clientId) ?? 1) - 1;
      if (left > 0) return void this.streams.set(clientId, left);
      this.streams.delete(clientId);
      this.focus.delete(clientId);
    };
  }

  watching(chatId: string) {
    return [...this.focus.values()].some((client) => client.visible && client.chatId === chatId);
  }

  private onMessage(message: Message) {
    if (message.status !== "done" && message.status !== "failed") return;
    if (this.notified.has(message.id) || Date.now() - message.createdAt > FRESH_MS) return;
    const bot = this.store.getBot(message.author);
    const chat = this.store.getChat(message.chatId);
    if (!bot || !chat || chat.kind === "thread") return; // Bot-to-Bot chatter isn't news; the asker's reply is.
    this.notified.add(message.id);
    if (this.notified.size > 500) this.notified.delete(this.notified.values().next().value!);
    const routine = message.cards.find((card) => card.type === "routine" && card.action === "ran");
    const where = routine?.type === "routine" ? routine.title : chat.kind === "topic" ? chat.title : null;
    const body = plainText(message.text).slice(0, 180) || message.error || "Finished.";
    void this.notify({ title: where ? `${bot.name} · ${where}` : bot.name, body, chatId: chat.id, tag: chat.id });
  }

  async notify(notification: Notification, { force = false } = {}) {
    if (!force && notification.chatId && this.watching(notification.chatId)) return 0;
    const rows = this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as { endpoint: string; p256dh: string; auth: string }[];
    const payload = JSON.stringify({ title: notification.title, body: notification.body, tag: notification.tag, url: notification.path || notification.chatId ? `/#/chat/${notification.path ?? notification.chatId}` : "/" });
    let delivered = 0;
    await Promise.all(rows.map(async (row) => {
      try {
        await this.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, { TTL: 24 * 60 * 60, urgency: "high" });
        delivered++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) this.unsubscribe(row.endpoint); // The device unsubscribed or the app was removed.
        else console.warn("[colony] push failed:", status ?? (error instanceof Error ? error.message : error));
      }
    }));
    return delivered;
  }
}
