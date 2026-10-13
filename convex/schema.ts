import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { searchResult, searchStatus } from "./searchTypes";

export default defineSchema({
  ...authTables,
  users: defineTable({
    ...authTables.users.validator.fields,
    workspaceAccess: v.optional(v.boolean()),
  }).index("email", ["email"]).index("phone", ["phone"]),
  conversations: defineTable({
    userId: v.id("users"),
    threadId: v.string(),
    title: v.string(),
    updatedAt: v.number(),
    generating: v.boolean(),
    generationId: v.optional(v.string()),
    stopRequested: v.optional(v.boolean()),
    error: v.optional(v.string()),
    webSearch: v.optional(v.boolean()),
    searchQuery: v.optional(v.string()),
    model: v.optional(v.string()),
    think: v.optional(v.boolean()),
  }).index("by_userId_and_updatedAt", ["userId", "updatedAt"]),
  searches: defineTable({
    userId: v.id("users"), conversationId: v.id("conversations"), generationId: v.string(),
    query: v.string(), status: searchStatus, workerId: v.optional(v.string()),
    results: v.optional(v.array(searchResult)),
  }).index("by_userId_and_status", ["userId", "status"])
    .index("by_conversationId_and_generationId", ["conversationId", "generationId"]),
});
