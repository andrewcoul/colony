import type { Duplex } from "node:stream";
import { upgradeIdentity, type HeaderLookup, type Resolver } from "./access.js";
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

/** Whether `url` is one of the upgrades Colony takes at all (whoever asks). */
export const isUpgradePath = (url: string) =>
  /^\/api\/nodes\/connect(\?|$)/.test(url) || /^\/api\/chats\/[\w-]+\/call(\?|$)/.test(url) || /^\/api\/bots\/[\w-]+\/screen\/[^?#]*(\?[^#]*)?$/.test(url);

export type UpgradeRefusal = { status: 401 | 403 | 404; error: string };

/**
 * Decides an upgrade: what it's for, and whose; or why not. 404 for paths Colony doesn't take,
 * 401 through the website without a sign-in, 403 when refused, turned off, or not theirs.
 */
export async function decideUpgrade(resolve: Resolver, header: HeaderLookup, origins: readonly string[], store: Store, url: string): Promise<{ person: Person; upgrade: Upgrade } | UpgradeRefusal> {
  if (!isUpgradePath(url)) return { status: 404, error: "Not found." };
  const identity = await upgradeIdentity(resolve, header, origins);
  if ("status" in identity) return identity;
  // Only the admin lends PCs, and only a chat's or a Bot's owner calls it or watches it.
  const upgrade = authorizeUpgrade(store, identity.person, url);
  return upgrade ? { person: identity.person, upgrade } : { status: 403, error: "That isn't yours." };
}

const REASONS = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" } as const;

/**
 * Answers a refused upgrade with a real HTTP response before closing, so a proxy in front (the
 * colony-site Worker) passes on 401 or 403 instead of a broken connection ("Colony is offline").
 */
export function refuseUpgrade(socket: Duplex, { status, error }: UpgradeRefusal) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error });
  socket.end([
    `HTTP/1.1 ${status} ${REASONS[status]}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "", body,
  ].join("\r\n"));
}

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
