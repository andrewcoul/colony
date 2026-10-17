import { isAdmin, type Person } from "./people.js";
import type { Store } from "./store.js";

/*
 * WebSocket upgrades. Hono doesn't route these, so index.ts sends every upgrade (after access.ts
 * names who's asking) through `authorizeUpgrade`, which says what it's for, or null to close it.
 */

/** What an allowed upgrade is for. */
export type Upgrade =
  /** The desktop app lending a PC to the admin's Bots. */
  | { kind: "nodes" }
  /** A voice call with one of your Bots, in one of your chats. */
  | { kind: "call"; chatId: string }
  /** Watching one of your Bots' screens: `path` and `query` go on to its desktop. */
  | { kind: "screen"; botId: string; path: string; query: string };

/** Every upgrade path, and who may open it (the isolation tests check each one). */
export const UPGRADES = [
  { kind: "nodes", path: "/api/nodes/connect", policy: "admin" },
  { kind: "call", path: "/api/chats/:id/call", policy: "chat" },
  { kind: "screen", path: "/api/bots/:id/screen/*", policy: "bot" },
] as const satisfies readonly { kind: Upgrade["kind"]; path: string; policy: string }[];

/** What this person's upgrade to `url` is for, or null when it isn't theirs to open. */
export function authorizeUpgrade(store: Store, person: Person, url: string): Upgrade | null {
  if (/^\/api\/nodes\/connect(\?|$)/.test(url)) return isAdmin(person) ? { kind: "nodes" } : null;
  const call = /^\/api\/chats\/([\w-]+)\/call(\?|$)/.exec(url);
  if (call) return store.getChat(call[1])?.ownerId === person.id ? { kind: "call", chatId: call[1] } : null;
  const screen = /^\/api\/bots\/([\w-]+)\/screen(\/[^?#]*)(\?[^#]*)?$/.exec(url);
  if (screen) {
    const bot = store.getBot(screen[1]);
    return bot?.computer && bot.ownerId === person.id ? { kind: "screen", botId: bot.id, path: screen[2], query: screen[3] ?? "" } : null;
  }
  return null;
}
