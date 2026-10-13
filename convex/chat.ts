import {
  abortStream, createThread, listMessages, listStreams, listUIMessages, saveMessage,
  syncStreams, vPaginationResult, vStreamArgs, vStreamMessagesReturnValue,
} from "@convex-dev/agent";
import { DAY, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedConversation, requireModelAccess, requireUser } from "./access";
import { limits, modelConfig, resolveModel } from "./config";

const conversationValidator = v.object({
  _id: v.id("conversations"), _creationTime: v.number(), userId: v.id("users"),
  threadId: v.string(), title: v.string(), updatedAt: v.number(), generating: v.boolean(),
  generationId: v.optional(v.string()), stopRequested: v.optional(v.boolean()),
  error: v.optional(v.string()),
  webSearch: v.optional(v.boolean()), searchQuery: v.optional(v.string()),
  model: v.optional(v.string()), think: v.optional(v.boolean()),
});

// AI SDK parts have provider-specific payloads; the enclosing message is validated.
const uiMessageValidator = v.object({
  id: v.string(), key: v.string(), order: v.number(), stepOrder: v.number(),
  role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
  text: v.string(), parts: v.array(v.any()), _creationTime: v.number(),
  status: v.union(v.literal("pending"), v.literal("success"), v.literal("failed"), v.literal("streaming")),
  agentName: v.optional(v.string()), userId: v.optional(v.string()), metadata: v.optional(v.any()),
});

const limiter = new RateLimiter(components.rateLimiter, {
  messages: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  daily: { kind: "fixed window", rate: 100, period: DAY },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: vPaginationResult(conversationValidator),
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUser(ctx);
    return ctx.db.query("conversations")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
      .order("desc").paginate(paginationOpts);
  },
});

export const get = query({
  args: { conversationId: v.id("conversations") },
  returns: v.union(v.null(), conversationValidator),
  handler: async (ctx, { conversationId }) => {
    const userId = await requireUser(ctx);
    const conversation = await ctx.db.get(conversationId);
    return conversation?.userId === userId ? conversation : null;
  },
});

export const messages = query({
  args: { conversationId: v.id("conversations"), threadId: v.string(), paginationOpts: paginationOptsValidator, streamArgs: vStreamArgs },
  returns: v.object({
    ...vPaginationResult(uiMessageValidator).fields,
    streams: vStreamMessagesReturnValue.fields.streams,
  }),
  handler: async (ctx, args) => {
    const conversation = await ownedConversation(ctx, args.conversationId);
    if (conversation.threadId !== args.threadId) throw new ConvexError("Conversation unavailable.");
    const paginated = await listUIMessages(ctx, components.agent, args);
    const streams = await syncStreams(ctx, components.agent, args);
    return { ...paginated, streams };
  },
});

const replyOptions = {
  webSearch: v.optional(v.boolean()),
  think: v.optional(v.boolean()),
  model: v.optional(v.string()),
};

async function checkCanReply(ctx: MutationCtx, userId: Id<"users">, conversation: Doc<"conversations"> | null) {
  if (!modelConfig().configured) throw new ConvexError("Configure the model in the backend first.");
  if (conversation?.generating) throw new ConvexError("Wait for this reply to finish, or stop it first.");
  await limiter.limit(ctx, "messages", { key: userId, throws: true });
  await limiter.limit(ctx, "daily", { key: userId, throws: true });
}

/** Marks the conversation as generating and schedules the reply plus its watchdog. */
async function startGeneration(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  promptMessageId: string,
  options: { webSearch?: boolean; think?: boolean; model?: string },
) {
  // A fresh id per attempt, so a regenerate never matches callbacks from the reply it replaces.
  const generationId = promptMessageId + ":" + crypto.randomUUID();
  await ctx.db.patch(conversation._id, {
    generating: true, generationId, stopRequested: false, error: undefined, updatedAt: Date.now(),
    webSearch: options.webSearch ?? false, think: options.think ?? false,
    model: resolveModel(options.model), searchQuery: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.generate.reply, { conversationId: conversation._id, generationId, promptMessageId });
  await ctx.scheduler.runAfter(limits.generationExpiryMs, internal.chat.expire, { conversationId: conversation._id, generationId });
}

export const send = mutation({
  args: { conversationId: v.optional(v.id("conversations")), prompt: v.string(), ...replyOptions },
  returns: v.id("conversations"),
  handler: async (ctx, { conversationId, prompt: rawPrompt, ...options }) => {
    const userId = await requireModelAccess(ctx);
    const prompt = rawPrompt.trim();
    if (!prompt || prompt.length > limits.promptChars) throw new ConvexError("Use between 1 and 16,000 characters.");
    let conversation = conversationId ? await ownedConversation(ctx, conversationId) : null;
    await checkCanReply(ctx, userId, conversation);
    if (!conversation) {
      const title = prompt.replace(/\s+/g, " ").slice(0, 64);
      const threadId = await createThread(ctx, components.agent, { userId, title });
      const id = await ctx.db.insert("conversations", { userId, threadId, title, updatedAt: Date.now(), generating: false });
      conversation = (await ctx.db.get(id))!;
    }
    const { messageId } = await saveMessage(ctx, components.agent, { threadId: conversation.threadId, userId, prompt });
    await startGeneration(ctx, conversation, messageId, options);
    return conversation._id;
  },
});

/** Replaces the latest reply with a new one for the same prompt. */
export const regenerate = mutation({
  args: { conversationId: v.id("conversations"), ...replyOptions },
  returns: v.null(),
  handler: async (ctx, { conversationId, ...options }) => {
    const userId = await requireModelAccess(ctx);
    const conversation = await ownedConversation(ctx, conversationId);
    await checkCanReply(ctx, userId, conversation);
    const recent = await listMessages(ctx, components.agent, {
      threadId: conversation.threadId, paginationOpts: { cursor: null, numItems: 50 },
    });
    const prompt = recent.page.find((message) => message.message?.role === "user");
    if (!prompt) throw new ConvexError("There is no message to regenerate.");
    for (let batch = 0; batch < 10; batch++) {
      const { isDone } = await ctx.runMutation(components.agent.messages.deleteByOrder, {
        threadId: conversation.threadId,
        startOrder: prompt.order, startStepOrder: prompt.stepOrder + 1,
        endOrder: prompt.order + 1,
      });
      if (isDone) break;
    }
    await startGeneration(ctx, conversation, prompt._id, options);
    return null;
  },
});

export const stop = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const conversation = await ownedConversation(ctx, conversationId);
    if (!conversation.generating) return null;
    await ctx.db.patch(conversationId, { stopRequested: true });
    await ctx.runMutation(internal.search.cancel, { conversationId, generationId: conversation.generationId! });
    const streams = await listStreams(ctx, components.agent, { threadId: conversation.threadId });
    for (const stream of streams) {
      await abortStream(ctx, components.agent, { streamId: stream.streamId, reason: "Stopped by user" });
    }
    return null;
  },
});

export const rename = mutation({
  args: { conversationId: v.id("conversations"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { conversationId, title }) => {
    await ownedConversation(ctx, conversationId);
    if (!title.trim() || title.length > 100) throw new ConvexError("Use a title of 1–100 characters.");
    await ctx.db.patch(conversationId, { title: title.trim() });
    return null;
  },
});

export const remove = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const conversation = await ownedConversation(ctx, conversationId);
    if (conversation.generating) throw new ConvexError("Stop the reply before deleting this conversation.");
    await ctx.runMutation(components.agent.threads.deleteAllForThreadIdAsync, { threadId: conversation.threadId });
    await ctx.db.delete(conversationId);
    return null;
  },
});

export const generation = internalQuery({
  args: { conversationId: v.id("conversations"), generationId: v.string() },
  returns: v.union(v.null(), conversationValidator),
  handler: async (ctx, { conversationId, generationId }) => {
    const conversation = await ctx.db.get(conversationId);
    return conversation?.generationId === generationId && conversation.generating ? conversation : null;
  },
});

export const finish = internalMutation({
  args: { conversationId: v.id("conversations"), generationId: v.string(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { conversationId, generationId, error }) => {
    const conversation = await ctx.db.get(conversationId);
    if (conversation?.generationId === generationId && conversation.generating) {
      await ctx.db.patch(conversationId, { generating: false, generationId: undefined, stopRequested: false,
        error: conversation.stopRequested ? undefined : error, updatedAt: Date.now(), searchQuery: undefined });
      await ctx.runMutation(internal.search.cancel, { conversationId, generationId });
    }
    return null;
  },
});

export const expire = internalMutation({
  args: { conversationId: v.id("conversations"), generationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation?.generating || conversation.generationId !== args.generationId) return null;
    for (const stream of await listStreams(ctx, components.agent, { threadId: conversation.threadId })) {
      await abortStream(ctx, components.agent, { streamId: stream.streamId, reason: "Reply timed out" });
    }
    await ctx.runMutation(internal.search.cancel, args);
    await ctx.db.patch(conversation._id, { generating: false, generationId: undefined, stopRequested: false, searchQuery: undefined, error: "The reply timed out. Please try again." });
    return null;
  },
});
