import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { catalogOf } from "./agent/pi/catalog.js";
import { config } from "./config.js";
import { builtInPrice } from "./prices.js";
import type { ModelOption, Price } from "./shared/types.js";

/**
 * Where models come from: your ChatGPT subscription (OpenAI's own sign-in) and OpenCode
 * (one console sign-in for Zen and Go). No API keys. "dev" is a keyless OpenAI-compatible
 * server from .env (COLONY_DEV_BASE_URL), for development and tests.
 */
export type ProviderId = "openai" | "opencode-go" | "opencode" | "dev";
export type SignInId = "chatgpt" | "opencode";

const SIGNED: { id: Exclude<ProviderId, "dev">; name: string; signIn: SignInId }[] = [
  { id: "openai", name: "ChatGPT", signIn: "chatgpt" },
  { id: "opencode-go", name: "OpenCode Go", signIn: "opencode" },
  { id: "opencode", name: "OpenCode Zen", signIn: "opencode" },
];
export const SIGN_INS: { id: SignInId; name: string }[] = [{ id: "chatgpt", name: "ChatGPT" }, { id: "opencode", name: "OpenCode" }];

/**
 * One provider: the models you've picked from it, and which of those can drive a desktop
 * (read a screenshot and point accurately).
 */
export type Provider = {
  id: ProviderId; name: string;
  /** The sign-in it needs (none for the dev server). */
  signIn: SignInId | null;
  /** The dev server's address; the others are pi-ai's built-in providers. */
  baseURL?: string;
  models: string[]; desktop: string[];
  /** Prices set by hand; models without one use the built-in table, or have no price. */
  prices?: Record<string, Price>;
};
export type ModelTarget = { provider: Provider; model: string; ref: string };

/** A model a provider offers, for picking in Settings. */
export type CatalogModel = { id: string; name: string; images: boolean };
/** What devices see of a provider. `prices`: each picked model's price, set or built in. */
export type ProviderView = Omit<Provider, "prices" | "baseURL"> & { signedIn: boolean; prices: Record<string, Price>; catalog: CatalogModel[] };
export type SignInView = { id: SignInId; name: string; signedIn: boolean; account: string | null };

/**
 * Voice: OpenAI-compatible /audio endpoints transcribe what you say and speak replies
 * (OpenAI itself with an API key, or local servers like faster-whisper-server and Kokoro).
 * An empty address turns voice off. Quiet hours are local time; Bots never ring you inside them.
 */
export type VoiceSettings = {
  baseURL: string;
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
  baseURL: "", transcribeModel: "gpt-4o-mini-transcribe", speechModel: "gpt-4o-mini-tts", voice: "alloy",
  botVoices: {}, allowCalls: true, quietFrom: "22:00", quietTo: "07:00",
};
export const OPENAI_AUDIO = "https://api.openai.com/v1";
/** Voice as devices see it: the key stays here, only its last four characters go out. */
export type VoiceView = VoiceSettings & { keySet: boolean; keyHint: string | null };
export type SettingsView = { providers: ProviderView[]; signIns: SignInView[]; defaultModel: string; configured: boolean; voice: VoiceView };

/**
 * Bots point at "<provider id>::<model id>". Model ids often contain "/" or ":"
 * (openai/gpt-…, llama3:8b), so the separator is a double colon.
 */
const SEP = "::";
export const modelRef = (providerId: string, model: string) => `${providerId}${SEP}${model}`;

let providers: Provider[] = [];
let defaultRef = "";
let voice: VoiceSettings = { ...DEFAULT_VOICE };
let voiceKey = "";
/** Provider ids from before sign-ins, and the provider their models moved to (so Bots keep their model). */
let aliases: Record<string, ProviderId> = {};
/** Identifies this Colony to OpenAI's sign-in (it asks for a stable id per installation). */
let deviceId: string = randomUUID();
/** Your tailnet login, recorded the first time you open Colony through `tailscale serve` (see access.ts). */
let owner: string | null = null;
/** Which sign-ins are done, and the account each is for (kept in step by the sign-in store). */
const signedIn = new Map<SignInId, string | null>();
/** Called whenever providers or sign-ins change (the agent runtime keeps one pi provider per provider). */
const listeners = new Set<() => void>();

const settingsFile = () => path.join(config.dataDir, "settings.json");

/** The fixed providers, with nothing picked yet. */
function freshProviders(): Provider[] {
  const dev: Provider[] = config.dev.baseURL && config.dev.models.length
    ? [{ id: "dev", name: "Dev server", signIn: null, baseURL: config.dev.baseURL.trim().replace(/\/+$/, ""), models: [...config.dev.models], desktop: [] }]
    : [];
  return [...SIGNED.map(({ id, name, signIn }) => ({ id, name, signIn, models: [], desktop: [] })), ...dev];
}

/** Settings from before sign-ins: one provider per API key. */
type LegacyProvider = { id: string; baseURL: string; apiKey?: string; models?: string[]; desktop?: string[]; prices?: Record<string, Price>; ownerId?: string | null };

/** Where an API-key provider's models live now: OpenCode's and OpenAI's carry over; others are dropped. */
function successorOf(baseURL: string): Exclude<ProviderId, "dev"> | null {
  try {
    const url = new URL(baseURL);
    if (url.hostname.endsWith("opencode.ai")) return /\/go(\/|$)/.test(url.pathname) ? "opencode-go" : "opencode";
    if (url.hostname === "api.openai.com") return "openai";
  } catch { /* Not an address. */ }
  return null;
}

/** Loads Settings. Call once at startup. */
export function loadSettings() {
  providers = freshProviders();
  defaultRef = "";
  voice = { ...DEFAULT_VOICE };
  voiceKey = "";
  aliases = {};
  owner = null;
  deviceId = randomUUID();
  let saved: {
    providers?: (Partial<Provider> | LegacyProvider)[];
    aliases?: Record<string, ProviderId>;
    defaultModel?: string;
    voice?: Partial<VoiceSettings> & { providerId?: string | null; people?: unknown };
    voiceKey?: string;
    ownerLogin?: string | null;
    deviceId?: string;
  } | null = null;
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch { /* Nothing saved yet. */ }
  if (saved) {
    const { people: _, providerId: legacyVoice, ...savedVoice } = saved.voice ?? {};
    voice = { ...DEFAULT_VOICE, ...savedVoice, botVoices: { ...saved.voice?.botVoices } };
    voiceKey = saved.voiceKey ?? "";
    owner = saved.ownerLogin ?? null;
    deviceId = saved.deviceId ?? deviceId;
    aliases = { ...saved.aliases };
    defaultRef = saved.defaultModel ?? "";
    let migrated = false;
    for (const item of saved.providers ?? []) {
      const legacy = "baseURL" in item && typeof item.baseURL === "string" && item.id !== "dev" ? item as LegacyProvider : null;
      if (legacy?.ownerId) { migrated = true; continue; }
      // An API key's models move to the sign-in that serves them; voice keeps the key it used.
      const id = legacy ? successorOf(legacy.baseURL) : item.id as ProviderId;
      if (legacy) {
        migrated = true;
        if (legacyVoice === legacy.id && !voice.baseURL) { voice.baseURL = legacy.baseURL.replace(/\/+$/, ""); voiceKey = legacy.apiKey ?? ""; }
        if (id) aliases[legacy.id] = id;
      }
      const provider = providers.find((candidate) => candidate.id === id);
      if (!provider || provider.id === "dev") continue;
      provider.models = [...new Set([...provider.models, ...(item.models ?? [])])];
      provider.desktop = provider.models.filter((model) => provider.desktop.includes(model) || item.desktop?.includes(model));
      if (item.prices) provider.prices = { ...provider.prices, ...item.prices };
    }
    const split = defaultRef.indexOf(SEP);
    if (split > 0 && aliases[defaultRef.slice(0, split)]) defaultRef = modelRef(aliases[defaultRef.slice(0, split)], defaultRef.slice(split + SEP.length));
    ensureDefault();
    // Old keys (in providers) leave the file now that nothing uses them.
    if (migrated) persist();
  } else {
    ensureDefault();
  }
  changed();
}

/** The provider a ref names, following ids from before sign-ins. */
function providerOf(id: string) {
  return providers.find((item) => item.id === (aliases[id] ?? id));
}

/** The default stays a model you've picked; once it isn't, the first one usable now (or picked at all). */
function ensureDefault() {
  if (picked(defaultRef)) return;
  const first = providers.find((provider) => provider.models.length && usable(provider)) ?? providers.find((provider) => provider.models.length);
  defaultRef = first ? modelRef(first.id, first.models[0]) : "";
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Write then rename, so a crash never leaves half a file. Readable only by you.
  const temp = `${settingsFile()}.${process.pid}.tmp`;
  const saved = providers.filter((provider) => provider.id !== "dev").map(({ id, models, desktop, prices }) => ({ id, models, desktop, ...(prices ? { prices } : {}) }));
  fs.writeFileSync(temp, JSON.stringify({ providers: saved, aliases, defaultModel: defaultRef, voice, voiceKey, ownerLogin: owner, deviceId }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, settingsFile());
}

const changed = () => { for (const listener of listeners) listener(); };
/** Runs `listener` whenever providers or sign-ins change. Returns a function that stops it. */
export function onProvidersChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a provider can answer now: signed in, or the dev server. */
const usable = (provider: Provider) => !provider.signIn || signedIn.has(provider.signIn);

/** A "<provider>::<model>" ref you've picked, signed in or not. */
function picked(ref: string | undefined): ModelTarget | null {
  if (!ref) return null;
  const split = ref.indexOf(SEP);
  if (split < 0) return null;
  const provider = providerOf(ref.slice(0, split));
  const model = ref.slice(split + SEP.length);
  return provider?.models.includes(model) ? { provider, model, ref: modelRef(provider.id, model) } : null;
}

/** A ref that's picked and whose provider is signed in, or null. */
function find(ref: string | undefined): ModelTarget | null {
  const target = picked(ref);
  return target && usable(target.provider) ? target : null;
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
    const provider = providers.find((item) => usable(item) && item.models.includes(requested));
    if (provider) return { provider, model: requested, ref: modelRef(provider.id, requested) };
  }
  return fallback ? find(defaultModel()) : null;
}

/** The default for new Bots: the one you chose, or while its sign-in is missing, the first model that works. */
export const defaultModel = () => (find(defaultRef) ? defaultRef : modelOptions()[0]?.ref ?? "");
export const modelConfigured = () => Boolean(find(defaultModel()));

/** Every picked model of every signed-in provider. */
export function modelOptions(): ModelOption[] {
  return providers.filter(usable).flatMap((provider) => provider.models.map((model) => ({
    ref: modelRef(provider.id, model), providerId: provider.id, providerName: provider.name, model, desktop: provider.desktop.includes(model),
  })));
}

/** Every provider. */
export const listProviders = (): readonly Provider[] => providers;
export const providerById = (id: string) => providerOf(id) ?? null;

/** A model's price: set by hand on its provider, or from the built-in table. */
export const priceOf = (provider: Provider, model: string): Price | null => provider.prices?.[model] ?? builtInPrice(model);

/** Your tailnet login, once Colony has seen it. */
export const ownerLogin = () => owner;
/** Records your tailnet login (the first one seen through `tailscale serve`), or forgets it (null). */
export function setOwnerLogin(login: string | null) {
  owner = login;
  persist();
}

/** This installation's id, for OpenAI's sign-in. */
export const installationId = () => deviceId;

/** Records whether a sign-in is done (and for which account). */
export function setSignedIn(id: SignInId, account: string | null | false) {
  const before = signedIn.has(id) ? signedIn.get(id) : false;
  if (account === false) signedIn.delete(id); else signedIn.set(id, account);
  if (before !== account) changed();
}

/** Whether this model can drive a desktop. */
export const canDriveDesktop = (target: ModelTarget | null) => Boolean(target?.provider.desktop.includes(target.model));

/** Records the desktop check's verdicts for some of a provider's models. */
export function setDesktopModels(providerId: string, verdicts: Record<string, boolean>) {
  const provider = providerOf(providerId);
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

/** Changes voice settings. `apiKey`: a new key, "" to remove it, undefined to keep it. */
export function setVoiceSettings(patch: Partial<VoiceSettings> & { apiKey?: string }) {
  const { apiKey, ...rest } = patch;
  voice = { ...voice, ...rest, botVoices: { ...voice.botVoices, ...rest.botVoices } };
  if (rest.baseURL !== undefined) voice.baseURL = rest.baseURL.trim().replace(/\/+$/, "");
  if (apiKey !== undefined) voiceKey = apiKey.trim();
  persist();
  return voice;
}

/** Where voice goes, and its key, when voice is on. */
export function voiceEndpoint(): { baseURL: string; apiKey: string } | null {
  return voice.baseURL ? { baseURL: voice.baseURL, apiKey: voiceKey } : null;
}

/** Settings as devices see them (the voice key never leaves; only its last four characters). */
export function settingsView(): SettingsView {
  return {
    providers: providers.map((provider) => {
      const { prices: _, baseURL: __, ...rest } = provider;
      const prices = Object.fromEntries(provider.models.flatMap((model) => { const price = priceOf(provider, model); return price ? [[model, price]] : []; }));
      return { ...rest, signedIn: usable(provider), prices, catalog: catalogOf(provider) };
    }),
    signIns: SIGN_INS.map(({ id, name }) => ({ id, name, signedIn: signedIn.has(id), account: signedIn.get(id) ?? null })),
    defaultModel: defaultModel(),
    configured: modelConfigured(),
    voice: { ...voice, keySet: Boolean(voiceKey), keyHint: voiceKey.length >= 12 ? voiceKey.slice(-4) : null },
  };
}

export type ProviderInput = { models: string[]; desktop?: string[]; prices?: Record<string, Price | null> };

/** Picks a provider's models (and which can drive a desktop, and their prices). */
export function saveProvider(id: string, input: ProviderInput) {
  const provider = providerOf(id);
  if (!provider) throw new Error("That provider doesn't exist.");
  if (provider.id === "dev") throw new Error("The dev server's models come from .env.");
  const models = [...new Set(input.models.map((item) => item.trim()).filter(Boolean))];
  const desktop = input.desktop ?? provider.desktop;
  provider.models = models;
  provider.desktop = models.filter((model) => desktop.includes(model));
  provider.prices = pricesFor(models, provider.prices, input.prices);
  ensureDefault();
  persist();
  changed();
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

/** Sets the default for new Bots. */
export function setDefaultModel(ref: string) {
  const target = find(ref);
  if (!target) throw new Error("That model isn't available. Sign in to its provider and pick it first.");
  defaultRef = target.ref;
  persist();
}
