import type { AgentRunner } from "./agent/run.js";
import { authorOf, isShared, peopleIn } from "./people.js";
import type { Attachment, Chat, Message } from "./shared/types.js";
import type { Store } from "./store.js";

const mentions = (text: string, name: string) => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

/**
 * Bots named with @Name in a message to a topic with several Bots; otherwise the one who leads it.
 * A message @-addressed only to people in the topic is between them: no Bot answers.
 */
export function addressedBots(text: string, memberIds: string[], store: Store, coordinatorId: string | null, people: string[] = []) {
  const members = memberIds.map((id) => store.getBot(id)).filter((bot) => bot !== null);
  const mentioned = members.filter((bot) => mentions(text, bot.name));
  if (mentioned.length) return mentioned.map((bot) => bot.id);
  // "@Marija …" is for Marija, unless a Bot is named in it too ("Luke, can you check?").
  const named = (name: string) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  if (people.some((name) => mentions(text, name))) return members.filter((bot) => named(bot.name)).map((bot) => bot.id);
  return coordinatorId && memberIds.includes(coordinatorId) ? [coordinatorId] : memberIds.slice(0, 1);
}

/**
 * Posts a person's message to a chat and gets the right Bots on it: a Bot that's already working
 * gets it at its next step (steer) or after it finishes (queue); the others start a turn.
 * Typed messages and spoken ones (calls) both come through here.
 */
export function sendUserMessage(store: Store, runner: AgentRunner, chat: Chat, input: {
  text: string;
  mode?: "steer" | "queue";
  attachments?: Attachment[];
  via?: Message["via"];
  /** Who wrote it: "user" (the owner) or "person:<id>". */
  author?: string;
}) {
  const author = input.author ?? "user";
  const message = store.createMessage({ chatId: chat.id, author, text: input.text, attachments: input.attachments, via: input.via ?? null });
  // A Bot's own chat, or a topic with one Bot, goes to that Bot; with several, @mentions pick.
  // In a shared topic, a message for another person (@Name) is left to them.
  const people = isShared(chat) ? peopleIn(store, chat).filter((person) => authorOf(person) !== author).map((person) => person.name) : [];
  const targets = chat.memberIds.length <= 1 && !people.length ? chat.memberIds : addressedBots(input.text, chat.memberIds, store, chat.coordinatorId, people);
  const started: string[] = [];
  for (const botId of targets) {
    if (runner.deliver(chat.id, botId, message.id, input.mode ?? "steer")) continue;
    started.push(runner.start(chat.id, botId));
  }
  store.markRead(chat.id);
  return { message: store.getMessage(message.id) ?? message, replies: started };
}
