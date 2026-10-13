import { v } from "convex/values";

export const searchResult = v.object({
  title: v.string(), url: v.string(), description: v.string(),
});

export const searchStatus = v.union(
  v.literal("pending"), v.literal("running"), v.literal("complete"),
  v.literal("failed"), v.literal("cancelled"),
);
