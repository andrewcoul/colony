import { createModels, createProvider, type Api, type Model, type Models, type MutableModels, type ProviderStreams, type StreamOptions, type Usage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { config } from "../../config.js";
import { listProviders, onProvidersChanged, providerById, type ModelTarget, type Provider } from "../../settings.js";
import type { TokenUsage } from "../../spending.js";
import { VERSION } from "../../version.js";

/**
 * Colony's providers as pi-ai providers: one per provider in Settings, with its own key, read
 * from Settings on every request. The pi runtime asks for models through this.
 */
export type ModelSource = {
  readonly models: Models;
  /** The pi model a Bot's resolved model is. */
  ref(target: ModelTarget): ModelRef;
};

export const providerIdOf = (provider: Pick<Provider, "id">) => `colony:${provider.id}`;

/** What pi-ai's bundled catalog knows about a model id: context window, output limit, reasoning, images. */
let catalog: Map<string, Model<Api>[]> | null = null;
function known(modelId: string, api: Api): Model<Api> | null {
  if (!catalog) {
    catalog = new Map();
    for (const provider of getBuiltinProviders()) {
      for (const model of getBuiltinModels(provider) as Model<Api>[]) {
        const key = model.id.toLowerCase();
        catalog.set(key, [...(catalog.get(key) ?? []), model]);
      }
    }
  }
  const id = modelId.toLowerCase();
  const matches = catalog.get(id) ?? catalog.get(id.split("/").pop()!) ?? [];
  return matches.find((model) => model.api === api) ?? matches[0] ?? null;
}

/** Anthropic's SDK adds /v1 itself; Colony's provider addresses include it. */
const baseUrlOf = (provider: Provider) => (provider.protocol === "anthropic" ? provider.baseURL.replace(/\/v1\/?$/, "") : provider.baseURL);

/** The pi model for one of a provider's models. Colony keeps its own prices, so pi's cost stays zero. */
export function modelFor(provider: Provider, id: string): Model<Api> {
  const api: Api = provider.protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
  const base = known(id, api);
  // Photos and screenshots reach models that can see: Claude, ones that passed the desktop check, or the catalog says so.
  const sees = provider.desktop.includes(id) || (provider.protocol === "anthropic" && /claude/i.test(id)) || Boolean(base?.input.includes("image"));
  return {
    id,
    name: base?.name ?? id,
    api,
    provider: providerIdOf(provider),
    baseUrl: baseUrlOf(provider),
    input: sees ? ["text", "image"] : ["text"],
    reasoning: base?.reasoning ?? false,
    contextWindow: base?.contextWindow ?? 128_000,
    maxTokens: base ? Math.min(base.maxTokens, 32_000) : config.limits.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(base?.thinkingLevelMap ? { thinkingLevelMap: base.thinkingLevelMap } : {}),
    ...(base?.inputLimits ? { inputLimits: base.inputLimits } : {}),
    ...(base?.api === api && base.compat ? { compat: base.compat } : {}),
  } as Model<Api>;
}

/** OpenCode routes a conversation by this header and refuses requests without it. */
function withSessionHeader(streams: ProviderStreams): ProviderStreams {
  const add = <T extends StreamOptions>(options?: T): T | undefined =>
    options?.sessionId ? { ...options, headers: { ...options.headers, "x-opencode-session": options.sessionId } } : options;
  return {
    ...streams,
    stream: (model, context, options) => streams.stream(model, context, add(options)),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, add(options)),
  };
}

function piProvider(provider: Provider) {
  const streams = provider.protocol === "anthropic" ? anthropicMessagesApi() : openAICompletionsApi();
  const opencode = (() => { try { return new URL(provider.baseURL).hostname.endsWith("opencode.ai"); } catch { return false; } })();
  return createProvider({
    id: providerIdOf(provider),
    name: provider.name,
    baseUrl: baseUrlOf(provider),
    headers: { "User-Agent": `colony/${VERSION}` },
    auth: {
      apiKey: {
        name: `${provider.name} key`,
        // Read on every request, so a changed key applies at once. Local servers need no key, but
        // OpenAI-style clients insist on one.
        resolve: async () => {
          const key = providerById(provider.id)?.apiKey || (provider.protocol === "openai" ? "not-needed" : "");
          return { auth: key ? { apiKey: key } : {}, source: "Colony settings" };
        },
      },
    },
    models: provider.models.map((id) => modelFor(provider, id)),
    api: opencode ? withSessionHeader(streams) : streams,
  });
}

/** The providers in Settings, kept in step with it. */
export class ColonyModels implements ModelSource {
  readonly models: MutableModels = createModels();
  private stop: () => void;

  constructor() {
    this.sync();
    this.stop = onProvidersChanged(() => this.sync());
  }

  private sync() {
    const current = new Set<string>();
    for (const provider of listProviders()) {
      this.models.setProvider(piProvider(provider));
      current.add(providerIdOf(provider));
    }
    for (const provider of this.models.getProviders()) if (!current.has(provider.id)) this.models.deleteProvider(provider.id);
  }

  ref(target: ModelTarget): ModelRef {
    return { provider: providerIdOf(target.provider), modelId: target.model };
  }

  close() {
    this.stop();
  }
}

/** One response's tokens as Colony counts them: input includes what was read from and written to the cache. */
export const tokensOf = (usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): TokenUsage => ({
  input: usage.input + usage.cacheRead + usage.cacheWrite,
  cached: usage.cacheRead,
  output: usage.output,
});
