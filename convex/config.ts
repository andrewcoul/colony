import type { Doc } from "./_generated/dataModel";

/** Model settings come from Convex environment variables; the key never leaves the backend. */
export function modelConfig() {
  const defaultModel = process.env.AI_MODEL?.trim() || "";
  // AI_MODELS optionally adds more choices to the composer's model picker.
  const extra = (process.env.AI_MODELS || "").split(",").map((id) => id.trim()).filter(Boolean);
  const models = [...new Set([defaultModel, ...extra].filter(Boolean))];
  return {
    configured: Boolean(process.env.AI_API_KEY && defaultModel && process.env.AI_BASE_URL),
    defaultModel,
    models,
    provider: process.env.AI_PROVIDER_NAME || "OpenAI-compatible API",
  };
}

/** Picks the requested model if it is allowed, otherwise the default. */
export function resolveModel(requested: string | undefined) {
  const { defaultModel, models } = modelConfig();
  return requested && models.includes(requested) ? requested : defaultModel;
}

export function hasModelAccess(user: Doc<"users"> | null) {
  const owner = process.env.COLONY_OWNER_EMAIL?.trim().toLowerCase();
  return Boolean(user?.workspaceAccess && (!owner || user.email?.toLowerCase() === owner));
}

export const limits = {
  promptChars: 16_000,
  maxOutputTokens: 4096,
  contextMessages: 40,
  replyTimeoutMs: 120_000,
  generationExpiryMs: 180_000,
} as const;
