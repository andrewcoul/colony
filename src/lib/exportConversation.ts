import type { ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/** Downloads every message in a conversation as JSON. */
export async function exportConversation(convex: ConvexReactClient, conversation: Doc<"conversations">) {
  const messages: { role: string; content: string; order: number; stepOrder: number }[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error("Export is too large");
    const data: FunctionReturnType<typeof api.chat.messages> = await convex.query(api.chat.messages, {
      conversationId: conversation._id, threadId: conversation.threadId,
      paginationOpts: { cursor, numItems: PAGE_SIZE }, streamArgs: undefined,
    });
    messages.push(...data.page.map((m) => ({ role: m.role, content: m.text, order: m.order, stepOrder: m.stepOrder })));
    if (data.isDone) break;
    cursor = data.continueCursor;
  }
  messages.sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);
  const body = {
    title: conversation.title,
    exportedAt: new Date().toISOString(),
    messages: messages.filter((m) => m.content).map(({ role, content }) => ({ role, content })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "colony-" + conversation._id + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
