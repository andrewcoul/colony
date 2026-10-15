import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { workspaceDir } from "./files.js";
import type { Chat, ChatFile } from "./shared/types.js";

/*
 * Files people and Bots add to a chat (a topic's Files tab, a photo attached to a message):
 *   data/chats/<chatId>/files/<fileId>        the bytes; the name, type and size are in the database
 * Bots with a computer also get a copy in /workspace/topics/<topic-slug>/, so their tools can open it.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const chatFilesDir = (chatId: string) => path.join(config.dataDir, "chats", chatId, "files");
export const chatFilePath = (file: Pick<ChatFile, "chatId" | "id">) => path.join(chatFilesDir(file.chatId), file.id);

/** A file name that's safe on every OS and inside a Bot's computer. */
export function safeName(name: string) {
  const cleaned = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-").replace(/^\.+/, "").trim().slice(0, 120);
  return cleaned || "file";
}

export const topicSlug = (title: string) => title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "topic";

/** Where a Bot's computer sees this chat's files: /workspace/topics/<slug>/ (a Bot's own chat uses "chat"). */
export const workspaceFolder = (chat: Chat) => path.join("topics", chat.kind === "topic" ? topicSlug(chat.title) : "chat");

export function writeChatFile(file: ChatFile, bytes: Uint8Array) {
  fs.mkdirSync(chatFilesDir(file.chatId), { recursive: true });
  fs.writeFileSync(chatFilePath(file), bytes);
}

/** Copies a chat file into each of these Bots' workspaces, so their computer can open it. */
export function shareWithComputers(file: ChatFile, chat: Chat, botIds: string[]) {
  for (const botId of botIds) {
    try {
      const folder = path.join(workspaceDir(botId), workspaceFolder(chat));
      fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(chatFilePath(file), path.join(folder, file.name));
    } catch (error) {
      console.warn(`[colony] Couldn't copy ${file.name} to a Bot's workspace:`, error instanceof Error ? error.message : error);
    }
  }
}

export function removeChatFile(file: ChatFile) {
  fs.rmSync(chatFilePath(file), { force: true });
}

export function removeChatFolder(chatId: string) {
  fs.rmSync(path.join(config.dataDir, "chats", chatId), { recursive: true, force: true });
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|x-sh|sql|markdown))/;
const TEXT_EXTENSIONS = /\.(txt|md|csv|tsv|json|ya?ml|xml|html?|css|js|ts|tsx|py|sh|ini|toml|log|sql)$/i;
export const isText = (file: Pick<ChatFile, "mime" | "name">) => TEXT_TYPES.test(file.mime) || TEXT_EXTENSIONS.test(file.name);
export const isImage = (file: Pick<ChatFile, "mime">) => /^image\/(png|jpe?g|gif|webp)$/.test(file.mime);
export const isPdf = (file: Pick<ChatFile, "mime" | "name">) => file.mime === "application/pdf" || /\.pdf$/i.test(file.name);

/** A file's text for a Bot to read: plain text as is, PDFs extracted. Null when it isn't readable as text. */
export async function readChatFileText(file: ChatFile, maxChars = 60_000): Promise<string | null> {
  const bytes = fs.readFileSync(chatFilePath(file));
  let text: string;
  if (isPdf(file)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    text = (await extractText(pdf, { mergePages: true })).text;
  } else if (isText(file)) {
    text = bytes.toString("utf8");
  } else {
    return null;
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[…cut: the file is ${text.length.toLocaleString("en-US")} characters]` : text;
}
