import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { builtInPrice } from "./prices.js";
import type { ModelOption, Price } from "./shared/types.js";

/**
 * The API a provider speaks: OpenAI-compatible chat completions (most providers), or
 * Anthropic's Messages API (Claude, directly or through gateways that expose it).
 */
export type Protocol = "openai" | "anthropic";

/**
 * One provider: its address, API format, key, the models you've picked from it, and which of
 * those can drive a desktop (read a screenshot and point accurately).
 */
/**
 * A model provider and its key. `ownerId` null: shared (the host's, usable by everyone's Bots);
 * otherwise one person's own, usable only by their Bots.
 */
export type Provider = {
  id: string; name: string; baseURL: string; protocol: Protocol; apiKey: string; models: string[]; desktop: string[]; ownerId: string | null;
  /** Prices set by hand; models without one use the built-in table, or have no price. */
  prices?: Record<string, Price>;
};
export type ProviderInput = { name: string; baseURL: string; protocol?: Protocol; apiKey?: string; models: string[]; desktop?: string[]; prices?: Record<string, Price | null> };

/** Claude models on Anthropic's API can drive a desktop; others are marked by the desktop check (or by hand). */
const defaultDesktop = (protocol: Protocol, models: string[]) => (protocol === "anthropic" ? models.filter((model) => /claude/i.test(model)) : []);
export type ModelTarget = { provider: Provider; model: string; ref: string };

/** What devices see. Keys never leave the server. `prices`: each model's price, set or built in. */
export type ProviderView = Omit<Provider, "apiKey" | "prices"> & { keySet: boolean; keyHint: string | null; prices: Record<string, Price> };
/**
 * Voice: one provider's OpenAI-compatible /audio endpoints transcribe what you say and speak
 * replies (OpenAI itself, or local servers like faster-whisper-server and Kokoro).
 * Quiet hours are local time; Bots never ring you inside them.
 */
export type VoiceSettings = {
  providerId: string | null;
  transcribeModel: string;
  speechModel: string;
  voice: string;
  /** A voice per Bot (falls back to `voice`). */
  botVoices: Record<string, string>;
  /** Everyone else's own call preferences (the host's are the fields here). */
  people?: Record<string, CallPrefs>;
  allowCalls: boolean;
  quietFrom: string;
  quietTo: string;
};
/** Whether your Bots may ring you, and when not to. Each person sets their own. */
export type CallPrefs = { allowCalls: boolean; quietFrom: string; quietTo: string };
const DEFAULT_PREFS: CallPrefs = { allowCalls: true, quietFrom: "22:00", quietTo: "07:00" };
const DEFAULT_VOICE: VoiceSettings = {
  providerId: null, transcribeModel: "gpt-4o-mini-transcribe", speechModel: "gpt-4o-mini-tts", voice: "alloy",
  botVoices: {}, allowCalls: true, quietFrom: "22:00", quietTo: "07:00",
};
export type SettingsView = { providers: ProviderView[]; defaultModel: string; configured: boolean; source: "app" | "env"; voice: VoiceSettings; host: boolean };
/** The host's id: their default is the shared default every Bot falls back to. */
const HOST = "owner";

/**
 * Bots point at "<provider id>::<model id>". Model ids often contain "/" or ":"
 * (openai/gpt-…, llama3:8b), so the separator is a double colon.
 */
const SEP = "::";
export const modelRef = (providerId: string, model: string) => `${providerId}${SEP}${model}`;

let providers: Provider[] = [];
let defaultRef = "";
/** Each person's own default model for new Bots (the host's is `defaultRef`). */
let personalDefaults: Record<string, string> = {};
let voice: VoiceSettings = { ...DEFAULT_VOICE };
/** The host's monthly limit on each person's use of shared keys, in dollars. */
let spendLimits: Record<string, number> = {};
let source: "app" | "env" = "env";

const settingsFile = () => path.join(config.dataDir, "settings.json");
const normalizeURL = (url: string) => url.trim().replace(/\/+$/, "");
const hostName = (url: string) => { try { return new URL(url).hostname; } catch { return "Provider"; } };

/** Loads providers saved in the app, or starts from .env. Call once at startup. */
export function loadSettings() {
  const env = config.model;
  providers = env.baseURL && env.models.length
    ? [{ id: "env", name: env.providerName === "colony" ? hostName(env.baseURL) : env.providerName, baseURL: normalizeURL(env.baseURL), protocol: "openai", apiKey: env.apiKey, models: [...env.models], desktop: [], ownerId: null }]
    : [];
  defaultRef = "";
  source = "env";
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as {
      providers?: Provider[];
      defaultModel?: string;
      /** The single-provider format from before multiple providers. */
      model?: { providerName: string; baseURL: string; apiKey: string; models: string[] };
      voice?: Partial<VoiceSettings>;
      personalDefaults?: Record<string, string>;
      spendLimits?: Record<string, number>;
    };
    personalDefaults = { ...saved.personalDefaults };
    spendLimits = { ...saved.spendLimits };
    voice = { ...DEFAULT_VOICE, ...saved.voice, botVoices: { ...saved.voice?.botVoices }, people: { ...saved.voice?.people } };
    if (saved.providers) {
      providers = saved.providers.map((provider) => {
        const protocol = provider.protocol ?? "openai";
        // Providers from before the family are shared.
        return { ...provider, protocol, desktop: provider.desktop ?? defaultDesktop(protocol, provider.models), ownerId: provider.ownerId ?? null };
      });
      defaultRef = saved.defaultModel ?? "";
    } else if (saved.model) {
      providers = [{ id: "env", name: saved.model.providerName, baseURL: normalizeURL(saved.model.baseURL), protocol: "openai", apiKey: saved.model.apiKey, models: saved.model.models, desktop: [], ownerId: null }];
    }
    source = "app";
  } catch { /* Nothing saved yet: .env values stand. */ }
  ensureDefault();
}

function ensureDefault() {
  if (find(defaultRef)?.provider.ownerId === null) return;
  const first = providers.find((provider) => provider.ownerId === null && provider.models.length);
  defaultRef = first ? modelRef(first.id, first.models[0]) : "";
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Write then rename, so a crash never leaves half a file. Readable only by you.
  const temp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ providers, defaultModel: defaultRef, personalDefaults, voice, spendLimits }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, settingsFile());
  source = "app";
}

/** An exact "<provider>::<model>" ref that's still configured, or null. */
function find(ref: string | undefined): ModelTarget | null {
  if (!ref) return null;
  const split = ref.indexOf(SEP);
  if (split < 0) return null;
  const provider = providers.find((item) => item.id === ref.slice(0, split));
  const model = ref.slice(split + SEP.length);
  return provider?.models.includes(model) ? { provider, model, ref } : null;
}

/** Whether a person's Bots may use this provider: shared ones, and their own. */
export const usable = (provider: Provider, personId = HOST) => provider.ownerId === null || provider.ownerId === personId;

/**
 * What a Bot's model setting means right now, for a Bot owned by `ownerId`. Accepts refs and
 * plain model ids from before multiple providers (matched to the first provider offering
 * that model). Someone else's provider doesn't count. Falls back to the owner's default
 * (or the shared default) unless `fallback` is false.
 */
export function resolveModel(requested: string | undefined, { fallback = true, ownerId = HOST }: { fallback?: boolean; ownerId?: string } = {}): ModelTarget | null {
  const exact = find(requested);
  if (exact && usable(exact.provider, ownerId)) return exact;
  if (requested && !requested.includes(SEP)) {
    const provider = providers.find((item) => usable(item, ownerId) && item.models.includes(requested));
    if (provider) return { provider, model: requested, ref: modelRef(provider.id, requested) };
  }
  return fallback ? find(defaultModel(ownerId)) : null;
}

export const modelConfigured = (personId = HOST) => Boolean(find(defaultModel(personId)));

/** The models a person's Bots can use: shared ones, then their own. */
export function modelOptions(personId = HOST): ModelOption[] {
  return providers.filter((provider) => usable(provider, personId)).flatMap((provider) => provider.models.map((model) => ({
    ref: modelRef(provider.id, model), providerId: provider.id, providerName: provider.name, model, desktop: provider.desktop.includes(model), ownerId: provider.ownerId,
  })));
}

export const providerById = (id: string) => providers.find((item) => item.id === id) ?? null;

/** A model's price: set by hand on its provider, or from the built-in table. */
export const priceOf = (provider: Provider, model: string): Price | null => provider.prices?.[model] ?? builtInPrice(model);

/** A model on a person's own key, for when their share of the shared keys is used up: their own default, else their first. */
export function ownModel(personId: string): ModelTarget | null {
  const own = find(personalDefaults[personId]);
  if (own?.provider.ownerId === personId) return own;
  const provider = providers.find((item) => item.ownerId === personId && item.models.length);
  return provider ? { provider, model: provider.models[0], ref: modelRef(provider.id, provider.models[0]) } : null;
}

export const spendLimit = (personId: string): number | null => spendLimits[personId] ?? null;

/** Sets (or, with null, removes) a person's monthly limit on shared keys. */
export function setSpendLimit(personId: string, limit: number | null) {
  const { [personId]: _, ...rest } = spendLimits;
  spendLimits = limit === null ? rest : { ...rest, [personId]: limit };
  persist();
}

/** Whether this model can drive a desktop. */
export const canDriveDesktop = (target: ModelTarget | null) => Boolean(target?.provider.desktop.includes(target.model));

/** Records the desktop check's verdicts for some of a provider's models. */
export function setDesktopModels(providerId: string, verdicts: Record<string, boolean>) {
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) throw new Error("That provider no longer exists.");
  const desktop = new Set(provider.desktop);
  for (const [model, can] of Object.entries(verdicts)) {
    if (!provider.models.includes(model)) continue;
    if (can) desktop.add(model); else desktop.delete(model);
  }
  provider.desktop = provider.models.filter((model) => desktop.has(model));
  persist();
}

/** Voice as one person sees it: the shared provider and voice, with their own call preferences. */
export const voiceSettings = (personId = HOST): VoiceSettings => {
  const { people, ...shared } = voice;
  return personId === HOST ? shared : { ...shared, ...DEFAULT_PREFS, ...people?.[personId] };
};

/** Changes the shared voice settings (the host's) and the host's own call preferences. */
export function setVoiceSettings(patch: Partial<VoiceSettings>) {
  voice = { ...voice, ...patch, botVoices: { ...voice.botVoices, ...patch.botVoices }, people: voice.people };
  persist();
  return voice;
}

/** Someone's own call preferences, and the voices of their own Bots. */
export function setCallPrefs(personId: string, patch: Partial<CallPrefs>, botVoices: Record<string, string> = {}) {
  if (personId === HOST) return setVoiceSettings({ ...patch, botVoices });
  voice = { ...voice, botVoices: { ...voice.botVoices, ...botVoices }, people: { ...voice.people, [personId]: { ...DEFAULT_PREFS, ...voice.people?.[personId], ...patch } } };
  persist();
  return voice;
}

/** The provider that does voice, if it's set and still exists (Anthropic's API has no audio endpoints). */
export function voiceProvider(): Provider | null {
  const provider = voice.providerId ? providerById(voice.providerId) : null;
  return provider && provider.protocol === "openai" ? provider : null;
}

/** A person's default for new Bots: their own pick if it's still usable, else the shared default. */
export function defaultModel(personId = HOST) {
  if (personId === HOST) return defaultRef;
  const own = find(personalDefaults[personId]);
  return own && usable(own.provider, personId) ? own.ref : defaultRef;
}

/** Settings as this person sees them: shared providers and their own (keys never leave). */
export function settingsView(personId = HOST): SettingsView {
  return {
    providers: providers.filter((provider) => usable(provider, personId))
      .map((provider) => {
        const { apiKey, prices: _, ...rest } = provider;
        const prices = Object.fromEntries(provider.models.flatMap((model) => { const price = priceOf(provider, model); return price ? [[model, price]] : []; }));
        return { ...rest, keySet: Boolean(apiKey), keyHint: apiKey.length >= 12 ? apiKey.slice(-4) : null, prices };
      }),
    defaultModel: defaultModel(personId),
    configured: modelConfigured(personId),
    source,
    voice: voiceSettings(personId),
    host: personId === HOST,
  };
}

/** Whether this person may change this provider: their own, or (the host) a shared one. */
export const canEditProvider = (provider: Provider, personId: string) => provider.ownerId === personId || (provider.ownerId === null && personId === HOST);

/**
 * Adds a provider (id null) or updates one. A blank key keeps the saved one only while
 * the address stays the same: a key is never sent anywhere but where it was saved for.
 */
export function saveProvider(id: string | null, input: ProviderInput, ownerId: string | null = null) {
  const existing = id ? providers.find((item) => item.id === id) : undefined;
  if (id && !existing) throw new Error("That provider no longer exists.");
  const baseURL = normalizeURL(input.baseURL);
  const keepKey = existing && normalizeURL(existing.baseURL) === baseURL;
  const protocol = input.protocol ?? existing?.protocol ?? "openai";
  const models = [...new Set(input.models.map((item) => item.trim()).filter(Boolean))];
  // New Claude models on Anthropic's API start out able to drive a desktop; kept verdicts stay.
  const known = new Set(existing?.models ?? []);
  const desktop = input.desktop ?? [
    ...(existing?.desktop ?? []),
    ...defaultDesktop(protocol, models.filter((model) => !known.has(model))),
  ];
  const next: Provider = {
    id: existing?.id ?? `p${randomBytes(4).toString("hex")}`,
    name: input.name.trim() || hostName(baseURL),
    baseURL,
    protocol,
    apiKey: input.apiKey?.trim() || (keepKey ? existing.apiKey : ""),
    models,
    desktop: models.filter((model) => desktop.includes(model)),
    ownerId: existing ? existing.ownerId : ownerId,
    prices: pricesFor(models, existing?.prices, input.prices),
  };
  providers = existing ? providers.map((item) => (item.id === next.id ? next : item)) : [...providers, next];
  ensureDefault();
  persist();
  return next.id;
}

/** Kept prices for the models still there, changed by any typed in (null clears one back to the built-in price). */
function pricesFor(models: string[], kept: Record<string, Price> = {}, typed: Record<string, Price | null> = {}) {
  const prices: Record<string, Price> = {};
  for (const model of models) {
    const price = model in typed ? typed[model] : kept[model];
    if (price && Number.isFinite(price.input) && Number.isFinite(price.output)) prices[model] = price;
  }
  return Object.keys(prices).length ? prices : undefined;
}

export function deleteProvider(id: string) {
  providers = providers.filter((item) => item.id !== id);
  ensureDefault();
  persist();
}

/** Sets a person's default for new Bots (the host's is the shared default everyone falls back to). */
export function setDefaultModel(ref: string, personId = HOST) {
  const target = find(ref);
  if (!target || !usable(target.provider, personId)) throw new Error("That model isn't configured.");
  if (personId === HOST) {
    if (target.provider.ownerId !== null) throw new Error("The shared default has to be a shared model.");
    defaultRef = ref;
  } else personalDefaults[personId] = ref;
  persist();
}

/** The key for checking `baseURL`: one typed in, or the named provider's saved key if the address matches. */
export function keyFor(providerId: string | undefined, baseURL: string, typed?: string) {
  if (typed?.trim()) return typed.trim();
  const provider = providers.find((item) => item.id === providerId);
  return provider && normalizeURL(provider.baseURL) === normalizeURL(baseURL) ? provider.apiKey : "";
}

/** Lists a provider's models (GET /models in either API format). Doubles as a connection check. */
export async function listProviderModels(baseURL: string, apiKey: string, protocol: Protocol = "openai"): Promise<string[]> {
  const anthropic = protocol === "anthropic";
  const auth: Record<string, string> = !apiKey ? {} : anthropic ? { "x-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` };
  let response: Response;
  try {
    // Anthropic pages its model list (20 by default); ask for all of them.
    response = await fetch(`${normalizeURL(baseURL)}/models${anthropic ? "?limit=1000" : ""}`, {
      headers: { Accept: "application/json", ...auth, ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Couldn't reach that address. Check the URL (and that the server is running, for local models).");
  }
  if (response.status === 401 || response.status === 403) throw new Error("The provider rejected the API key.");
  if (!response.ok) throw new Error(`The provider answered ${response.status}. Check the base URL; it usually ends in /v1.`);
  const body = await response.json().catch(() => null) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] } | null;
  const items = body?.data ?? body?.models ?? [];
  return [...new Set(items.map((item) => String((item as { id?: unknown }).id ?? (item as { name?: unknown }).name ?? "")).filter(Boolean))].sort();
}
