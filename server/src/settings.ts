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
export type Provider = {
  id: string; name: string; baseURL: string; protocol: Protocol; apiKey: string; models: string[]; desktop: string[];
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
  allowCalls: boolean;
  quietFrom: string;
  quietTo: string;
};
const DEFAULT_VOICE: VoiceSettings = {
  providerId: null, transcribeModel: "gpt-4o-mini-transcribe", speechModel: "gpt-4o-mini-tts", voice: "alloy",
  botVoices: {}, allowCalls: true, quietFrom: "22:00", quietTo: "07:00",
};
export type SettingsView = { providers: ProviderView[]; defaultModel: string; configured: boolean; source: "app" | "env"; voice: VoiceSettings };

/**
 * Bots point at "<provider id>::<model id>". Model ids often contain "/" or ":"
 * (openai/gpt-…, llama3:8b), so the separator is a double colon.
 */
const SEP = "::";
export const modelRef = (providerId: string, model: string) => `${providerId}${SEP}${model}`;

let providers: Provider[] = [];
let defaultRef = "";
let voice: VoiceSettings = { ...DEFAULT_VOICE };
/** Your tailnet login, recorded the first time you open Colony through `tailscale serve` (see access.ts). */
let owner: string | null = null;
let source: "app" | "env" = "env";
/** Called whenever providers change (the agent runtime keeps one client per provider). */
const listeners = new Set<() => void>();

const settingsFile = () => path.join(config.dataDir, "settings.json");
const normalizeURL = (url: string) => url.trim().replace(/\/+$/, "");
const hostName = (url: string) => { try { return new URL(url).hostname; } catch { return "Provider"; } };

/** Loads providers saved in the app, or starts from .env. Call once at startup. */
export function loadSettings() {
  const env = config.model;
  providers = env.baseURL && env.models.length
    ? [{ id: "env", name: env.providerName === "colony" ? hostName(env.baseURL) : env.providerName, baseURL: normalizeURL(env.baseURL), protocol: "openai", apiKey: env.apiKey, models: [...env.models], desktop: [] }]
    : [];
  defaultRef = "";
  owner = null;
  source = "env";
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as {
      providers?: (Provider & { ownerId?: string | null })[];
      defaultModel?: string;
      /** The single-provider format from before multiple providers. */
      model?: { providerName: string; baseURL: string; apiKey: string; models: string[] };
      voice?: Partial<VoiceSettings> & { people?: unknown };
      ownerLogin?: string | null;
    };
    const { people: _, ...savedVoice } = saved.voice ?? {};
    voice = { ...DEFAULT_VOICE, ...savedVoice, botVoices: { ...saved.voice?.botVoices } };
    owner = saved.ownerLogin ?? null;
    if (saved.providers) {
      // Keys other people added in the family build (ownerId set) were theirs, not yours: dropped.
      providers = saved.providers.filter((provider) => !provider.ownerId).map(({ ownerId: _, ...provider }) => {
        const protocol = provider.protocol ?? "openai";
        return { ...provider, protocol, desktop: provider.desktop ?? defaultDesktop(protocol, provider.models) };
      });
      defaultRef = saved.defaultModel ?? "";
    } else if (saved.model) {
      providers = [{ id: "env", name: saved.model.providerName, baseURL: normalizeURL(saved.model.baseURL), protocol: "openai", apiKey: saved.model.apiKey, models: saved.model.models, desktop: [] }];
    }
    source = "app";
  } catch { /* Nothing saved yet: .env values stand. */ }
  ensureDefault();
  changed();
}

function ensureDefault() {
  if (find(defaultRef)) return;
  const first = providers.find((provider) => provider.models.length);
  defaultRef = first ? modelRef(first.id, first.models[0]) : "";
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Write then rename, so a crash never leaves half a file. Readable only by you.
  const temp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ providers, defaultModel: defaultRef, voice, ownerLogin: owner }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, settingsFile());
  source = "app";
}

const changed = () => { for (const listener of listeners) listener(); };
/** Runs `listener` whenever providers are added, changed or removed. Returns a function that stops it. */
export function onProvidersChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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

/**
 * What a Bot's model setting means right now. Accepts refs and plain model ids from before
 * multiple providers (matched to the first provider offering that model). Falls back to the
 * default unless `fallback` is false.
 */
export function resolveModel(requested: string | undefined, { fallback = true }: { fallback?: boolean } = {}): ModelTarget | null {
  const exact = find(requested);
  if (exact) return exact;
  if (requested && !requested.includes(SEP)) {
    const provider = providers.find((item) => item.models.includes(requested));
    if (provider) return { provider, model: requested, ref: modelRef(provider.id, requested) };
  }
  return fallback ? find(defaultRef) : null;
}

export const modelConfigured = () => Boolean(find(defaultRef));

/** Every model across every provider. */
export function modelOptions(): ModelOption[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({
    ref: modelRef(provider.id, model), providerId: provider.id, providerName: provider.name, model, desktop: provider.desktop.includes(model),
  })));
}

/** Every provider. */
export const listProviders = (): readonly Provider[] => providers;
export const providerById = (id: string) => providers.find((item) => item.id === id) ?? null;

/** A model's price: set by hand on its provider, or from the built-in table. */
export const priceOf = (provider: Provider, model: string): Price | null => provider.prices?.[model] ?? builtInPrice(model);

/** Your tailnet login, once Colony has seen it. */
export const ownerLogin = () => owner;
/** Records your tailnet login (the first one seen through `tailscale serve`), or forgets it (null). */
export function setOwnerLogin(login: string | null) {
  owner = login;
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

export const voiceSettings = (): VoiceSettings => voice;

export function setVoiceSettings(patch: Partial<VoiceSettings>) {
  voice = { ...voice, ...patch, botVoices: { ...voice.botVoices, ...patch.botVoices } };
  persist();
  return voice;
}

/** The provider that does voice, if it's set and still exists (Anthropic's API has no audio endpoints). */
export function voiceProvider(): Provider | null {
  const provider = voice.providerId ? providerById(voice.providerId) : null;
  return provider && provider.protocol === "openai" ? provider : null;
}

/** The default for new Bots. */
export const defaultModel = () => defaultRef;

/** Settings as devices see them (keys never leave). */
export function settingsView(): SettingsView {
  return {
    providers: providers.map((provider) => {
      const { apiKey, prices: _, ...rest } = provider;
      const prices = Object.fromEntries(provider.models.flatMap((model) => { const price = priceOf(provider, model); return price ? [[model, price]] : []; }));
      return { ...rest, keySet: Boolean(apiKey), keyHint: apiKey.length >= 12 ? apiKey.slice(-4) : null, prices };
    }),
    defaultModel: defaultRef,
    configured: modelConfigured(),
    source,
    voice,
  };
}

/**
 * Adds a provider (id null) or updates one. A blank key keeps the saved one only while
 * the address stays the same: a key is never sent anywhere but where it was saved for.
 */
export function saveProvider(id: string | null, input: ProviderInput) {
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
    prices: pricesFor(models, existing?.prices, input.prices),
  };
  providers = existing ? providers.map((item) => (item.id === next.id ? next : item)) : [...providers, next];
  ensureDefault();
  persist();
  changed();
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
  changed();
}

/** Sets the default for new Bots. */
export function setDefaultModel(ref: string) {
  if (!find(ref)) throw new Error("That model isn't configured.");
  defaultRef = ref;
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
