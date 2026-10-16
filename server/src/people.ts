import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import * as settings from "./settings.js";
import type { Chat, EphemeralEvent, Person, ServerEvent } from "./shared/types.js";
import type { Store } from "./store.js";

/*
 * The family: everyone on the tailnet shares one Colony, known by their Tailscale login (no
 * Colony accounts). Requests without a login (this PC, or a plain tailnet address) are the
 * host's: the person who runs Colony. Everyone has their own Bots; a Bot's chat, memory and
 * routines are its owner's alone. Topics are shared on purpose, with some people or everyone.
 * The host looks after what's shared (the server, shared models, updates), not other people.
 */

export const HOST_ID = "owner";
const COLORS = ["#7CC4FA", "#7EE2B8", "#FFB38A", "#C5A6FF", "#FF8A9A", "#FFE07A"];

/** How a person signs their messages: the host is "user" (as before the family), others "person:<id>". */
export const authorOf = (person: Pick<Person, "id">) => (person.id === HOST_ID ? "user" : `person:${person.id}`);
export const isHuman = (author: string) => author === "user" || author.startsWith("person:");
export const personIdOf = (author: string) => (author === "user" ? HOST_ID : author.startsWith("person:") ? author.slice(7) : null);
export const isHost = (person: Pick<Person, "id">) => person.id === HOST_ID;

/** "marija.k@example.com" → "Marija". */
const nameFromLogin = (login: string) => {
  const first = login.split("@")[0].split(/[._+-]/)[0] || login;
  return first.charAt(0).toUpperCase() + first.slice(1);
};

/** Who's asking, from their Tailscale login (none: the host). A new login is family straight away. */
export function identify(store: Store, login: string | undefined): Person {
  const host = store.getPerson(HOST_ID)!;
  if (!login) return host;
  const known = store.personByLogin(login);
  if (known) return known;
  // The first login seen is the host's own (their phone, through tailscale serve).
  if (!host.login) return store.updatePerson(HOST_ID, { login, ...(host.name === "You" ? { name: nameFromLogin(login) } : {}) })!;
  const used = new Set(store.listPeople().map((person) => person.color));
  return store.addPerson({ login, name: nameFromLogin(login), color: COLORS.find((color) => !used.has(color)) ?? COLORS[store.listPeople().length % COLORS.length], role: "family" });
}

/** Whether someone can see a chat: their own Bots' chats, topics they own, and topics shared with them. */
export function canSee(person: Pick<Person, "id">, chat: Chat) {
  if (chat.ownerId === person.id) return true;
  return chat.kind === "topic" && (chat.everyone || chat.peopleIds.includes(person.id));
}

/** Whether someone can see a Bot: their own, and other people's Bots in topics they can see. */
export function canSeeBot(store: Store, person: Pick<Person, "id">, botId: string) {
  const bot = store.getBot(botId);
  if (!bot) return false;
  if (bot.ownerId === person.id) return true;
  return store.listChats().some((chat) => chat.kind === "topic" && chat.memberIds.includes(botId) && canSee(person, chat));
}

/** Everyone who can see a chat. */
export function peopleIn(store: Store, chat: Chat) {
  return store.listPeople().filter((person) => canSee(person, chat));
}

/** A topic with more than its owner in it: people's messages carry their names in the prompt. */
export const isShared = (chat: Chat) => chat.kind === "topic" && (chat.everyone || chat.peopleIds.length > 0);

type Rule = [string, RegExp, (store: Store, person: Person, id: string) => string | null];
const NOT_YOURS = "That isn't yours.";
const HIDDEN = "That isn't shared with you.";

// A Bot that doesn't exist falls through to the route, which says so (404).
const ownBot = (store: Store, person: Person, botId: string) => { const bot = store.getBot(botId); return !bot || bot.ownerId === person.id ? null : NOT_YOURS; };
const visibleChat = (store: Store, person: Person, chatId: string) => {
  const chat = store.getChat(chatId);
  return chat && canSee(person, chat) ? null : HIDDEN;
};
const ownChat = (store: Store, person: Person, chatId: string) => (store.getChat(chatId)?.ownerId === person.id ? null : NOT_YOURS);
const anyone = () => null;

/**
 * What each request may touch. The first matching rule decides; anything not listed is the
 * host's (the server itself: updates, shared settings).
 */
const RULES: Rule[] = [
  ["GET", /^\/(state|events|me|family|img|system|push\/key|household)$/, anyone],
  ["POST", /^\/(push\/subscribe|push\/unsubscribe|push\/status|push\/test|focus|bots|topics|folders)$/, anyone],
  ["PUT", /^\/household$/, anyone],
  // Models: everyone has their own providers and default; shared ones are the host's (checked in the routes).
  ["GET", /^\/settings$/, anyone],
  // Accounts: your own (checked in the routes).
  ["*", /^\/accounts(?:\/.*)?$/, anyone],
  ["*", /^\/settings\/(providers|providers\/check|default-model|providers\/[\w-]+|providers\/[\w-]+\/desktop-check|voice|voice\/try)$/, anyone],
  // You, and nobody else, edit your name, color and what Bots know about you.
  ["*", /^\/people\/([\w-]+)(?:\/about)?$/, (_store, person, id) => (id === person.id ? null : NOT_YOURS)],
  ["*", /^\/bots\/([\w-]+)(?:\/.*)?$/, ownBot],
  ["*", /^\/routines\/([\w-]+)(?:\/.*)?$/, (store, person, id) => { const routine = store.getRoutine(id); return routine ? ownBot(store, person, routine.botId) : NOT_YOURS; }],
  ["*", /^\/folders\/([\w-]+)$/, (store, person, id) => (store.getFolder(id)?.ownerId === person.id ? null : NOT_YOURS)],
  ["DELETE", /^\/chats\/([\w-]+)$/, ownChat],
  // Editing a topic: its owner, or anyone in it adding or removing their own Bots (checked in the route).
  ["*", /^\/chats\/([\w-]+)(?:\/.*)?$/, visibleChat],
  ["GET", /^\/files\/([\w-]+)$/, (store, person, id) => { const file = store.getFile(id); return file ? visibleChat(store, person, file.chatId) : HIDDEN; }],
  ["DELETE", /^\/files\/([\w-]+)$/, (store, person, id) => {
    const file = store.getFile(id);
    if (!file || visibleChat(store, person, file.chatId)) return HIDDEN;
    return file.addedBy === authorOf(person) || store.getChat(file.chatId)?.ownerId === person.id ? null : NOT_YOURS;
  }],
  // Steering or deleting: only your own messages.
  ["*", /^\/messages\/([\w-]+)\/(?:steer)$/, (store, person, id) => (store.getMessage(id)?.author === authorOf(person) ? null : NOT_YOURS)],
  ["DELETE", /^\/messages\/([\w-]+)$/, (store, person, id) => (store.getMessage(id)?.author === authorOf(person) ? null : NOT_YOURS)],
  // A topic a Bot suggested: its owner creates it.
  ["POST", /^\/messages\/([\w-]+)\/topics\/[\w-]+$/, (store, person, id) => { const message = store.getMessage(id); return message ? ownBot(store, person, message.author) : NOT_YOURS; }],
  ["POST", /^\/approvals\/([\w-]+)$/, (store, person, id) => (store.getApproval(id)?.approverId === person.id ? null : "Only the person it's waiting for can answer that.")],
  ["POST", /^\/calls\/([\w-]+)\/decline$/, anyone],
  // Your own PCs.
  ["DELETE", /^\/nodes\/([\w-]+)$/, (store, person, id) => (store.listNodes().find((node) => node.id === id)?.personId === person.id ? null : NOT_YOURS)],
];

/** Null if this person may make this request, otherwise why not. */
export function refusal(store: Store, person: Person, method: string, route: string): string | null {
  for (const [verb, pattern, check] of RULES) {
    if (verb !== "*" && verb !== method) continue;
    const match = pattern.exec(route);
    if (match) return check(store, person, match[1] ?? "");
  }
  return isHost(person) ? null : "Only the person who runs this Colony can do that.";
}

/** An event as this person should see it (null: not for them). */
export function eventFor(person: Person, event: ServerEvent | EphemeralEvent, store: Store): ServerEvent | EphemeralEvent | null {
  const visible = (chatId: string) => { const chat = store.getChat(chatId); return Boolean(chat && canSee(person, chat)); };
  switch (event.type) {
    case "chat.upserted": return canSee(person, event.chat) ? event : { type: "chat.deleted", chatId: event.chat.id };
    case "message.upserted": return visible(event.message.chatId) ? event : null;
    case "message.deleted": case "message.delta": case "file.deleted": return visible(event.chatId) ? event : null;
    case "artifact.upserted": return visible(event.artifact.chatId) ? event : null;
    case "file.upserted": return visible(event.file.chatId) ? event : null;
    case "approval.upserted": return visible(event.approval.chatId) ? event : null;
    case "bot.upserted": return canSeeBot(store, person, event.bot.id) ? event : { type: "bot.deleted", botId: event.bot.id };
    case "bot.presence": return canSeeBot(store, person, event.botId) ? event : null;
    case "routine.upserted": return store.getBot(event.routine.botId)?.ownerId === person.id || (event.routine.chatId && visible(event.routine.chatId)) ? event : null;
    case "folder.upserted": return event.folder.ownerId === person.id ? event : null;
    case "settings.updated": return { ...event, models: settings.modelOptions(person.id), defaultModel: settings.defaultModel(person.id), configured: settings.modelConfigured(person.id) };
    case "accounts.updated": return { ...event, accounts: event.accounts.filter((account) => account.personId === person.id), access: event.access.filter((grant) => store.getBot(grant.botId)?.ownerId === person.id) };
    case "computer.output": return store.getBot(event.botId)?.ownerId === person.id ? event : null;
    case "call.ringing": return store.getBot(event.botId)?.ownerId === person.id ? event : null;
    default: return event;
  }
}

// ---------- What Bots know about each person ----------
const aboutFile = (personId: string) => (personId === HOST_ID ? path.join(config.dataDir, "USER.md") : path.join(config.dataDir, "people", personId, "USER.md"));
const householdFile = () => path.join(config.dataDir, "HOUSEHOLD.md");
const readText = (file: string) => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; } };
const writeText = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text.trim() ? `${text.trim()}\n` : ""); };

/** A person's USER.md (the host's is the USER.md Bots already knew). */
export const readAbout = (personId: string) => readText(aboutFile(personId));
export const writeAbout = (personId: string, text: string) => writeText(aboutFile(personId), text);
/** HOUSEHOLD.md: what every Bot should know about the household as a whole. */
export const readHousehold = () => readText(householdFile());
export const writeHousehold = (text: string) => writeText(householdFile(), text);
