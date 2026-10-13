import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUser } from "./access";
import { hasModelAccess, modelConfig } from "./config";

export const status = query({
  args: {},
  returns: v.object({
    model: v.string(),
    models: v.array(v.string()),
    provider: v.string(),
    configured: v.boolean(),
    ownerConfigured: v.boolean(),
    canGenerate: v.boolean(),
    email: v.string(),
  }),
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    const config = modelConfig();
    return {
      model: config.defaultModel || "Choose a model",
      models: config.models,
      provider: config.provider,
      configured: config.configured,
      ownerConfigured: Boolean(process.env.COLONY_OWNER_EMAIL?.trim()),
      canGenerate: config.configured && hasModelAccess(user),
      email: user?.email || "",
    };
  },
});
