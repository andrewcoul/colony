import { z } from "zod";
import { isImage, readChatFileText, workspaceFolder } from "../chatFiles.js";
import type { ColonyTool, ToolContext } from "./tools.js";

/*
 * Tools for a topic's Doc, for asking the user with tappable answers, and for the files in a chat.
 * Kept apart from tools.ts (which spreads these into the core set) and typed against it only.
 */

const define = <I, O>(spec: ColonyTool<I, O>) => spec;
const quote = (text: string, max = 40) => `“${text.length > max ? text.slice(0, max - 1) + "…" : text}”`;

/** Docs belong to topics: a Bot's own chat moves too much for a document to stay current. */
function topicOf(ctx: ToolContext) {
  const chat = ctx.store.getChat(ctx.chatId);
  if (chat?.kind !== "topic") throw new Error("Docs live in topics. If this deserves one, suggest a topic with topic_create first.");
  return chat;
}

const DOC_FORMAT = [
  "The Doc is Markdown (GFM tables and task lists work), plus three fenced blocks the app draws specially:",
  "A row of big numbers, one line each as label | value | small print:",
  "```colony-stats\nTotal so far | ≈ €1,017 | 4,453 zł\nPieces | 7 | + MOPPE, TBD\n```",
  "Cards for products or options (every field but name is optional):",
  "```colony-items\n- name: STOCKHOLM 2025\n  tag: Marija\n  detail: Oak and leather seat · 56×50×74 cm\n  price: 4 × 799 zł = 3,196 zł · ≈ €730\n  link: https://…\n  image: https://…\n```",
  "A muted line saying where the facts came from:",
  "```colony-note\nIKEA PL prices as of 13 Oct · €1 ≈ 4.38 zł · stock not checked\n```",
].join("\n");

export const docTools = {
  artifact_read: define({
    description: "Read this topic's Doc: the living document you keep beside the chat (a plan, a list, a budget). Read it before changing it.",
    inputSchema: z.object({}),
    describe: () => "Read the Doc",
    summarize: (output: { version?: number }) => (output.version ? `v${output.version}` : "empty"),
    execute: async (_input, ctx) => {
      const doc = ctx.store.getArtifact(topicOf(ctx).id);
      return doc ? { title: doc.title, status: doc.status, version: doc.version, body: doc.body } : { empty: true, note: "No Doc yet. Write one with artifact_write when the topic needs one." };
    },
  }),

  artifact_write: define({
    description: `Write this topic's Doc, replacing it with a new version (old versions stay in its history). Keep it the current, tidy state of the topic, not a log. Use artifact_edit for small changes. ${DOC_FORMAT}`,
    inputSchema: z.object({
      body: z.string().min(1).max(60_000),
      note: z.string().trim().min(1).max(120).describe("What changed, in a few words, e.g. \"added photos and sizes\"."),
      title: z.string().trim().min(1).max(60).optional().describe("Short title, e.g. \"IKEA trip\". Defaults to the current one."),
      status: z.string().trim().max(30).optional().describe("A word or two the user sees as a badge, e.g. \"Draft\", \"Almost final\", \"Booked\"."),
    }),
    describe: ({ note }) => `Updated the Doc: ${note}`,
    summarize: (output: { version: number }) => `v${output.version}`,
    execute: async ({ body, note, title, status }, ctx) => {
      const chat = topicOf(ctx);
      const doc = ctx.store.saveArtifact(chat.id, { body, note, title: title ?? (ctx.store.getArtifact(chat.id) ? undefined : chat.title), status, by: ctx.botId });
      ctx.store.appendCard(ctx.messageId, { type: "artifact", title: doc.title, version: doc.version, note });
      return { version: doc.version };
    },
  }),

  artifact_edit: define({
    description: "Change part of this topic's Doc: replace one exact piece of text with another, as a new version. Read the Doc first so `find` matches exactly once.",
    inputSchema: z.object({
      find: z.string().min(1).max(10_000),
      replace: z.string().max(20_000),
      note: z.string().trim().min(1).max(120).describe("What changed, in a few words."),
      status: z.string().trim().max(30).optional(),
    }),
    describe: ({ note }) => `Updated the Doc: ${note}`,
    summarize: (output: { version: number }) => `v${output.version}`,
    execute: async ({ find, replace, note, status }, ctx) => {
      const chat = topicOf(ctx);
      const doc = ctx.store.getArtifact(chat.id);
      if (!doc) throw new Error("There's no Doc yet; write one with artifact_write.");
      const count = doc.body.split(find).length - 1;
      if (count !== 1) throw new Error(count ? `That text appears ${count} times; include more of it so it matches once.` : "That text isn't in the Doc. Read it again and copy the exact text.");
      const next = ctx.store.saveArtifact(chat.id, { body: doc.body.replace(find, () => replace), note, status, by: ctx.botId });
      ctx.store.appendCard(ctx.messageId, { type: "artifact", title: next.title, version: next.version, note });
      return { version: next.version };
    },
  }),

  ask: define({
    description: "Ask the user one or more short questions as tappable chips under your reply, when you need answers to carry on. Give options when there are a few likely answers (each becomes a button); leave them out for open questions. Still write the questions in your reply text too.",
    inputSchema: z.object({
      questions: z.array(z.object({
        label: z.string().trim().min(1).max(60).describe("The question, short, e.g. \"KALLAX: carry or deliver?\"."),
        options: z.array(z.string().trim().min(1).max(40)).max(4).optional(),
      })).min(1).max(4),
    }),
    describe: ({ questions }) => `Asked ${questions.length === 1 ? quote(questions[0].label) : `${questions.length} questions`}`,
    execute: async ({ questions }, ctx) => {
      ctx.store.appendCard(ctx.messageId, { type: "ask", questions: questions.map((question) => ({ label: question.label, options: question.options ?? [] })) });
      return { shown: true, note: "The user sees the chips under your reply; stop here and wait for the answer." };
    },
  }),

  chat_files: define({
    description: "The files in this chat: ones the user attached or uploaded, and ones added here. list shows them; read returns a file's text (plain text and PDFs). Photos you can see arrive with the user's message instead.",
    inputSchema: z.object({
      action: z.enum(["list", "read"]),
      name: z.string().trim().max(200).optional().describe("For read: the file's name (as listed)."),
    }),
    describe: ({ action, name }) => (action === "list" ? "Checked the files" : `Read ${quote(name ?? "a file")}`),
    summarize: (output: { count?: number; chars?: number }) => (output.count !== undefined ? `${output.count} file${output.count === 1 ? "" : "s"}` : output.chars !== undefined ? `${output.chars.toLocaleString("en-US")} chars` : undefined),
    execute: async ({ action, name }, ctx) => {
      const chat = ctx.store.getChat(ctx.chatId);
      const files = ctx.store.listFiles(ctx.chatId);
      const computer = ctx.store.getBot(ctx.botId)?.computer && chat ? `/workspace/${workspaceFolder(chat).replace(/\\/g, "/")}/` : null;
      if (action === "list") {
        return { count: files.length, files: files.map((file) => ({ name: file.name, type: file.mime, size: file.size, added: new Date(file.createdAt).toString() })), ...(computer ? { onYourComputer: computer } : {}) };
      }
      const file = files.find((item) => item.name === name) ?? files.find((item) => name && item.name.toLowerCase() === name.toLowerCase());
      if (!file) throw new Error("No file by that name here; list them first.");
      if (isImage(file)) return { image: file.name, note: computer ? `It's a photo. Open ${computer}${file.name} on your computer to look at it.` : "It's a photo; you can't read it as text." };
      const text = await readChatFileText(file);
      if (text === null) return { file: file.name, note: computer ? `It isn't text. It's on your computer at ${computer}${file.name}.` : "It isn't a text or PDF file, so it can't be read here." };
      return { file: file.name, chars: text.length, text };
    },
  }),
} satisfies Record<string, ColonyTool>;
