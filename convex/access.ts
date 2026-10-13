import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { hasModelAccess } from "./config";

export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Sign in to continue.");
  return userId;
}

export async function ownedConversation(
  ctx: QueryCtx | MutationCtx,
  id: Id<"conversations">,
) {
  const userId = await requireUser(ctx);
  const conversation = await ctx.db.get(id);
  if (!conversation || conversation.userId !== userId) {
    throw new ConvexError("Conversation unavailable.");
  }
  return conversation;
}

export async function requireModelAccess(ctx: QueryCtx | MutationCtx) {
  const userId = await requireUser(ctx);
  if (!hasModelAccess(await ctx.db.get(userId))) {
    throw new ConvexError("Model access is restricted to invited workspace accounts.");
  }
  return userId;
}
