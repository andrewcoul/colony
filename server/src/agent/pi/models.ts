import path from "node:path";
import { createModels, createProvider, type Api, type Model, type Models, type MutableModels, type Provider as PiProvider, type OAuthAuth, type ProviderStreams, type Usage } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { config } from "../../config.js";
import { FileCredentialStore } from "../../credentials.js";
import { listProviders, onProvidersChanged, setSignedIn, type ModelTarget, type Provider, type SignInId } from "../../settings.js";
import type { TokenUsage } from "../../spending.js";
import { VERSION } from "../../version.js";
import { builtins } from "./catalog.js";
import { opencodeConsoleOAuth } from "./opencode.js";

/**
 * Colony's providers as pi-ai providers: ChatGPT and OpenCode Zen and Go are pi-ai's own,
 * narrowed to the models you picked and signed in with your subscriptions (tokens in
 * data/credentials.json, refreshed as they expire). The pi runtime asks for models through this.
 */
export type ModelSource = {
  readonly models: Models;
  /** The pi model a Bot's resolved model is. */
  ref(target: ModelTarget): ModelRef;
};

/** The pi provider each sign-in is stored under (OpenCode Go borrows OpenCode Zen's). */
export const SIGN_IN_PROVIDER: Record<SignInId, string> = { chatgpt: "openai", opencode: "opencode" };

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

/**
 * A picked model as Colony runs it. Colony keeps its own prices, so pi's cost stays zero; output
 * is capped so one reply can't run away; models that passed the desktop check get screenshots.
 */
function colonyModel(base: Model<Api>, provider: Provider): Model<Api> {
  const sees = base.input.includes("image") || provider.desktop.includes(base.id);
  return {
    ...base,
    provider: provider.id,
    input: sees ? ["text", "image"] : ["text"],
    maxTokens: Math.min(base.maxTokens, 32_000),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** The dev server: a keyless OpenAI-compatible endpoint, borrowing what the catalog knows of each model. */
export function devModel(provider: Provider, id: string): Model<Api> {
  const base = known(id, "openai-completions");
  return {
    id,
    name: base?.name ?? id,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: provider.baseURL ?? config.dev.baseURL,
    input: provider.desktop.includes(id) || base?.input.includes("image") ? ["text", "image"] : ["text"],
    reasoning: base?.reasoning ?? false,
    contextWindow: base?.contextWindow ?? 128_000,
    maxTokens: base ? Math.min(base.maxTokens, 32_000) : config.limits.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(base?.thinkingLevelMap ? { thinkingLevelMap: base.thinkingLevelMap } : {}),
  } as Model<Api>;
}

/**
 * Hands each request to the built-in provider, which picks the API by the model's `api` (and,
 * for OpenCode, adds the per-conversation session header it routes by).
 */
const through = (builtin: PiProvider): ProviderStreams => ({
  stream: (model, context, options) => builtin.stream(model, context, options),
  streamSimple: (model, context, options) => builtin.streamSimple(model, context, options),
});

/** The providers in Settings, kept in step with it, signed in with your subscriptions. */
export class ColonyModels implements ModelSource {
  readonly models: MutableModels;
  readonly credentials: FileCredentialStore;
  private opencodeOAuth: OAuthAuth;
  private stops: (() => void)[];

  constructor(options: { credentials?: FileCredentialStore; fetch?: typeof fetch } = {}) {
    this.credentials = options.credentials ?? new FileCredentialStore(path.join(config.dataDir, "credentials.json"));
    this.models = createModels({ credentials: this.credentials });
    this.opencodeOAuth = opencodeConsoleOAuth(options.fetch);
    this.sync();
    this.signIns();
    this.stops = [onProvidersChanged(() => this.sync()), this.credentials.onChange(() => this.signIns())];
  }

  /** Tells Settings which sign-ins are done. */
  private signIns() {
    for (const [signIn, providerId] of Object.entries(SIGN_IN_PROVIDER) as [SignInId, string][]) {
      setSignedIn(signIn, this.credentials.has(providerId) ? this.credentials.detail(providerId) : false);
    }
  }

  private piProvider(provider: Provider): PiProvider {
    const headers = { "User-Agent": `colony/${VERSION}` };
    if (provider.id === "dev") {
      return createProvider({
        id: provider.id, name: provider.name, baseUrl: provider.baseURL, headers,
        // OpenAI-style clients insist on a key; local servers ignore it.
        auth: { apiKey: { name: "No key", resolve: async () => ({ auth: { apiKey: "not-needed" }, source: "Dev server" }) } },
        models: provider.models.map((id) => devModel(provider, id)),
        api: openAICompletionsApi(),
      });
    }
    const builtin = builtins[provider.id];
    const byId = new Map(builtin.getModels().map((model) => [model.id, model as Model<Api>]));
    const models = provider.models.flatMap((id) => { const base = byId.get(id); return base ? [colonyModel(base, provider)] : []; });
    if (provider.id === "openai") {
      // Only the ChatGPT sign-in: no OPENAI_API_KEY from the environment.
      return createProvider({ id: provider.id, name: provider.name, baseUrl: builtin.baseUrl, headers, auth: { oauth: builtin.auth.oauth! }, models, api: through(builtin) });
    }
    if (provider.id === "opencode") {
      return createProvider({ id: provider.id, name: provider.name, headers, auth: { oauth: this.opencodeOAuth }, models, api: through(builtin) });
    }
    // OpenCode Go uses the same console sign-in as Zen.
    return createProvider({
      id: provider.id, name: provider.name, headers,
      auth: {
        apiKey: {
          name: "OpenCode sign-in",
          check: async () => (this.credentials.has("opencode") ? { type: "oauth", source: "OpenCode sign-in" } : undefined),
          resolve: async () => {
            const result = await this.models.getAuth("opencode");
            return result ? { auth: result.auth, source: "OpenCode sign-in" } : undefined;
          },
        },
      },
      models,
      api: through(builtin),
    });
  }

  private sync() {
    const current = new Set<string>();
    for (const provider of listProviders()) {
      this.models.setProvider(this.piProvider(provider));
      current.add(provider.id);
    }
    for (const provider of this.models.getProviders()) if (!current.has(provider.id)) this.models.deleteProvider(provider.id);
  }

  ref(target: ModelTarget): ModelRef {
    return { provider: target.provider.id, modelId: target.model };
  }

  close() {
    for (const stop of this.stops) stop();
  }
}

/** One response's tokens as Colony counts them: input includes what was read from and written to the cache. */
export const tokensOf = (usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): TokenUsage => ({
  input: usage.input + usage.cacheRead + usage.cacheWrite,
  cached: usage.cacheRead,
  output: usage.output,
});
