import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireModelAccess } from "./access";
import { searchResult, searchStatus } from "./searchTypes";
import { isPublicWebUrl } from "./urlPolicy";

export const pending = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("searches"), query: v.string() })),
  handler: async (ctx) => {
    const userId = await requireModelAccess(ctx);
    const jobs = await ctx.db.query("searches").withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "pending")).take(5);
    return jobs.map(({ _id, query }) => ({ _id, query }));
  },
});

export const claim = mutation({
  args: { searchId: v.id("searches"), workerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await requireModelAccess(ctx);
    const job = await ctx.db.get(args.searchId);
    if (!job || job.userId !== userId) throw new ConvexError("Search unavailable.");
    if (job.status !== "pending") return false;
    const conversation = await ctx.db.get(job.conversationId);
    if (!conversation?.generating || conversation.stopRequested || conversation.generationId !== job.generationId) {
      await ctx.db.patch(job._id, { status: "cancelled" }); return false;
    }
    await ctx.db.patch(job._id, { status: "running", workerId: args.workerId });
    return true;
  },
});

export const complete = mutation({
  args: { searchId: v.id("searches"), workerId: v.string(), results: v.optional(v.array(searchResult)), failed: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireModelAccess(ctx);
    const job = await ctx.db.get(args.searchId);
    if (!job) return null;
    if (job.userId !== userId || job.workerId !== args.workerId) throw new ConvexError("Search unavailable.");
    if (job.status !== "running") return null;
    const conversation = await ctx.db.get(job.conversationId);
    if (!conversation?.generating || conversation.stopRequested || conversation.generationId !== job.generationId) {
      await ctx.db.patch(job._id, { status: "cancelled" }); return null;
    }
    const results = (args.results || []).slice(0, 5).filter((item) => isPublicWebUrl(item.url)).map((item) => ({
      title: item.title.slice(0, 300), url: item.url.slice(0, 2000), description: item.description.slice(0, 1500),
    }));
    await ctx.db.patch(job._id, { status: args.failed ? "failed" : "complete", results });
    await ctx.db.patch(conversation._id, { searchQuery: undefined });
    return null;
  },
});

export const begin = internalMutation({
  args: { conversationId: v.id("conversations"), generationId: v.string(), query: v.string() },
  returns: v.id("searches"),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation?.generating || !conversation.webSearch || conversation.stopRequested || conversation.generationId !== args.generationId) throw new ConvexError("This search was cancelled.");
    if (!args.query.trim() || args.query.length > 4000) throw new ConvexError("Invalid search query.");
    const previous = await ctx.db.query("searches").withIndex("by_conversationId_and_generationId", (q) => q.eq("conversationId", args.conversationId).eq("generationId", args.generationId)).take(3);
    if (previous.length >= 3) throw new ConvexError("Search limit reached for this reply.");
    const id = await ctx.db.insert("searches", { ...args, userId: conversation.userId, status: "pending" });
    await ctx.db.patch(conversation._id, { searchQuery: args.query });
    await ctx.scheduler.runAfter(300000, internal.search.cleanup, { searchId: id });
    return id;
  },
});

export const result = internalQuery({
  args: { searchId: v.id("searches") },
  returns: v.union(v.null(), v.object({ status: searchStatus, results: v.optional(v.array(searchResult)) })),
  handler: async (ctx, { searchId }) => {
    const job = await ctx.db.get(searchId);
    if (!job) return null;
    return { status: job.status, ...(job.results ? { results: job.results } : {}) };
  },
});

export const cancel = internalMutation({
  args: { conversationId: v.id("conversations"), generationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query("searches").withIndex("by_conversationId_and_generationId", (q) => q.eq("conversationId", args.conversationId).eq("generationId", args.generationId)).take(3);
    for (const job of jobs) if (job.status === "pending" || job.status === "running") await ctx.db.patch(job._id, { status: "cancelled" });
    return null;
  },
});

/** Called when the model stops waiting, so a late worker result is discarded. */
export const expire = internalMutation({
  args: { searchId: v.id("searches") },
  returns: v.null(),
  handler: async (ctx, { searchId }) => {
    const job = await ctx.db.get(searchId);
    if (!job || (job.status !== "pending" && job.status !== "running")) return null;
    await ctx.db.patch(searchId, { status: "failed" });
    const conversation = await ctx.db.get(job.conversationId);
    if (conversation?.generationId === job.generationId) await ctx.db.patch(conversation._id, { searchQuery: undefined });
    return null;
  },
});

export const cleanup = internalMutation({
  args: { searchId: v.id("searches") }, returns: v.null(),
  handler: async (ctx, { searchId }) => { if (await ctx.db.get(searchId)) await ctx.db.delete(searchId); return null; },
});
