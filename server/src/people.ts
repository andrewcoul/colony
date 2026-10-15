import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Chat, EphemeralEvent, Person, ServerEvent } from "./shared/types.js";
import type { Store } from "./store.js";

/*
 * People: a household shares one Colony without accounts. Behind `tailscale serve` each request
 * carries the person's Tailscale login; requests without one (this PC, or a plain tailnet
 * address) are the owner's. The first login seen is the owner's; any other login waits until
 * the owner adds it. Members see and post in the topics shared with them, and nothing else:
 * Settings, accounts, Bots' own chats and approvals stay the owner's.
 */

export const OWNER_ID = "owner";
const COLORS = ["#7CC4FA", "#7EE2B8", "#FFB38A", "#C5A6FF", "#FF8A9A", "#FFE07A"];

/** How a person signs their messages: the owner is "user" (as before people), others "person:<id>". */
export const authorOf = (person: Person) => (person.role === "owner" ? "user" : `person:${person.id}`);
export const isHuman = (author: string) => author === "user" || author.startsWith("person:");
export const personIdOf = (author: string) => (author === "user" ? OWNER_ID : author.startsWith("person:") ? author.slice(7) : null);

/** "marija.k@example.com" → "Marija". */
const nameFromLogin = (login: string) => {
  const first = login.split("@")[0].split(/[._+-]/)[0] || login;
  return first.charAt(0).toUpperCase() + first.slice(1);
};

/** Who's asking, from their Tailscale login (none: the owner). */
export function identify(store: Store, login: string | undefined): Person {
  const owner = store.getPerson(OWNER_ID)!;
  if (!login) return owner;
  const known = store.personByLogin(login);
  if (known) return known;
  if (!owner.login) return store.updatePerson(OWNER_ID, { login, ...(owner.name === "You" ? { name: nameFromLogin(login) } : {}) })!;
  const used = new Set(store.listPeople().map((person) => person.color));
  return store.addPerson({ login, name: nameFromLogin(login), color: COLORS.find((color) => !used.has(color)) ?? COLORS[store.listPeople().length % COLORS.length], role: "pending" });
}

/** Whether someone can see a chat: the owner sees all; members, the topics shared with them. */
export function canSee(person: Person, chat: Chat) {
  if (person.role === "owner") return true;
  if (person.role !== "member") return false;
  return chat.kind === "topic" && (chat.everyone || chat.peopleIds.includes(person.id));
}

/** The people (owner first) in a chat. */
export function peopleIn(store: Store, chat: Chat) {
  return store.listPeople().filter((person) => canSee(person, chat));
}

/** A topic only some of the household can see has people in it worth naming in the prompt. */
export const isShared = (chat: Chat) => chat.kind === "topic" && (chat.everyone || chat.peopleIds.length > 0);

/**
 * What a member may call. Anything not listed is the owner's. `chat`/`message`/`file` name the
 * path part that must point at something they can see.
 */
const MEMBER_ROUTES: [string, RegExp, ("chat" | "message" | "file")?][] = [
  ["GET", /^\/(state|events|me|img|push\/key|system)$/],
  ["POST", /^\/(push\/subscribe|push\/unsubscribe|push\/status|push\/test|focus)$/],
  ["GET", /^\/chats\/([\w-]+)\/(messages|artifact|artifact\/versions\/\d+|files)$/, "chat"],
  ["POST", /^\/chats\/([\w-]+)\/(messages|read|files|stop)$/, "chat"],
  ["GET", /^\/files\/([\w-]+)$/, "file"],
  ["POST", /^\/messages\/([\w-]+)\/steer$/, "message"],
  ["DELETE", /^\/messages\/([\w-]+)$/, "message"],
];

/** Null if a member may make this request, otherwise why not. */
export function memberRefusal(store: Store, person: Person, method: string, route: string): string | null {
  for (const [verb, pattern, kind] of MEMBER_ROUTES) {
    const match = verb === method ? pattern.exec(route) : null;
    if (!match) continue;
    if (!kind) return null;
    const id = match[1];
    const chatId = kind === "chat" ? id : kind === "file" ? store.getFile(id)?.chatId : store.getMessage(id)?.chatId;
    const chat = chatId ? store.getChat(chatId) : null;
    if (!chat || !canSee(person, chat)) return "That topic isn't shared with you.";
    // Steering or deleting: only your own messages.
    if (kind === "message" && store.getMessage(id)?.author !== authorOf(person)) return "That's someone else's message.";
    return null;
  }
  return "Only the owner can do that.";
}

/** An event as a member should see it (null: not for them). */
export function eventFor(person: Person, event: ServerEvent | EphemeralEvent, store: Store): ServerEvent | EphemeralEvent | null {
  if (person.role === "owner") return event;
  if (person.role !== "member") return null;
  const visible = (chatId: string) => { const chat = store.getChat(chatId); return Boolean(chat && canSee(person, chat)); };
  switch (event.type) {
    case "chat.upserted": return canSee(person, event.chat) ? event : { type: "chat.deleted", chatId: event.chat.id };
    case "message.upserted": return visible(event.message.chatId) ? event : null;
    case "message.deleted": case "message.delta": case "file.deleted": return visible(event.chatId) ? event : null;
    case "artifact.upserted": return visible(event.artifact.chatId) ? event : null;
    case "file.upserted": return visible(event.file.chatId) ? event : null;
    case "people.updated": return { ...event, people: event.people.filter((item) => item.role === "owner" || item.role === "member") };
    case "chat.deleted": case "bot.upserted": case "bot.deleted": case "bot.presence": case "folder.upserted": case "folder.deleted": return event;
    default: return null;
  }
}

// ---------- What Bots know about each person ----------
const aboutFile = (personId: string) => (personId === OWNER_ID ? path.join(config.dataDir, "USER.md") : path.join(config.dataDir, "people", personId, "USER.md"));
const householdFile = () => path.join(config.dataDir, "HOUSEHOLD.md");
const readText = (file: string) => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; } };
const writeText = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text.trim() ? `${text.trim()}\n` : ""); };

/** A person's USER.md (the owner's is the USER.md every Bot already knows). */
export const readAbout = (personId: string) => readText(aboutFile(personId));
export const writeAbout = (personId: string, text: string) => writeText(aboutFile(personId), text);
/** HOUSEHOLD.md: what every Bot should know about the household as a whole. */
export const readHousehold = () => readText(householdFile());
export const writeHousehold = (text: string) => writeText(householdFile(), text);
