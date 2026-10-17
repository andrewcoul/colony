import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { catalogOf, catalogPrice } from "./agent/pi/catalog.js";
import { config } from "./config.js";
import { builtInPrice } from "./prices.js";
import type { ModelOption, Price } from "./shared/types.js";

/**
 * Where models come from: your ChatGPT subscription (OpenAI's own sign-in) and OpenCode
 * (one console sign-in for Zen and Go). No API keys. "dev" is a keyless OpenAI-compatible
 * server from .env (COLONY_DEV_BASE_URL), for development and tests.
 */
export type ProviderId = "openai" | "opencode-go" | "opencode" | "dev" | typeof MEMBER_PROVIDER;
export type SignInId = "chatgpt" | "opencode";

/**
 * Members' Bots run on OpenCode Zen through a provider of their own, with an OpenCode Zen API key
 * the admin sets (kept in data/credentials.json as MEMBER_KEY), never with the admin's sign-ins.
 */
export const MEMBER_PROVIDER = "opencode-members";
export const MEMBER_KEY = "opencode-key";
/** The members' provider before it moved from OpenCode Go to Zen (bots.model is migrated in db.ts). */
export const LEGACY_MEMBER_PROVIDER = "opencode-go-members";
/** What members may use until the admin says otherwise: free on Zen. */
export const MEMBER_DEFAULT_MODEL = "deepseek-v4.1-flash-free";
export const NO_MEMBER_MODELS = "Your Colony admin hasn't set up models for members yet.";

/** A turn that can't start, in words for the chat (shown as they are). */
export class RunRefused extends Error {
  constructor(message: string) { super(message); this.name = "RunRefused"; }
}

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
/** Settings as the admin sees them: everything, to change. */
/**
 * What the admin sees of members' models: whether the members' OpenCode API key is set (and its
 * last four characters, never the key), the models members may use, and the cap for new members.
 */
export type MembersView = {
  keySet: boolean; keyHint: string | null; models: string[]; defaultModel: string; defaultCap: number | null;
  catalog: CatalogModel[]; prices: Record<string, Price>;
};
export type SettingsView = { role: "admin"; providers: ProviderView[]; signIns: SignInView[]; defaultModel: string; configured: boolean; voice: VoiceView; members: MembersView };
/**
 * Settings as a member sees them: the models they may give their Bots, and whether voice is on.
 * Nothing about sign-ins, keys or where voice goes.
 */
export type MemberSettingsView = {
  role: "member"; models: ModelOption[]; defaultModel: string; configured: boolean;
  voice: { on: boolean; allowCalls: boolean; quietFrom: string; quietTo: string };
};

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
/**
 * What members may use: OpenCode Zen models (ids), the default for their new Bots, and what each
 * may spend a month in dollars (`caps` per member; anyone not listed has `defaultCap`; null: no cap).
 */
export type MemberPolicy = { models: string[]; defaultModel: string; defaultCap: number | null; caps: Record<string, number | null> };
const freshPolicy = (): MemberPolicy => ({ models: [MEMBER_DEFAULT_MODEL], defaultModel: MEMBER_DEFAULT_MODEL, defaultCap: null, caps: {} });
let members: MemberPolicy = freshPolicy();
/** The last four characters of the members' key once it's set (kept in step by the credential store). */
let memberKey: { set: boolean; hint: string | null } = { set: false, hint: null };
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
  members = freshPolicy();
  let saved: {
    members?: Partial<MemberPolicy>;
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
    if (saved.members) {
      members = savedPolicy(saved.members);
      migrated = members.models.join() !== (saved.members.models ?? []).join() || members.defaultModel !== saved.members.defaultModel;
    }
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

/** The models OpenCode Zen offers, which members may be allowed. */
const zenOffers = () => new Set(catalogOf({ id: MEMBER_PROVIDER, models: [] }).map((model) => model.id));

/**
 * The saved members' policy, with only models Zen offers. Models from when members ran on OpenCode
 * Go (muse-spark-1.3-contributor) drop out; if none are left, members get the default again.
 */
function savedPolicy(saved: Partial<MemberPolicy>): MemberPolicy {
  const policy = { ...freshPolicy(), ...saved, caps: { ...saved.caps } };
  const offered = zenOffers();
  const models = policy.models.filter((model) => offered.has(model));
  policy.models = models.length || !policy.models.length ? models : [MEMBER_DEFAULT_MODEL];
  if (!policy.models.includes(policy.defaultModel)) {
    policy.defaultModel = policy.models.includes(MEMBER_DEFAULT_MODEL) ? MEMBER_DEFAULT_MODEL : policy.models[0] ?? "";
  }
  return policy;
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
  fs.writeFileSync(temp, JSON.stringify({ providers: saved, aliases, defaultModel: defaultRef, voice, voiceKey, ownerLogin: owner, deviceId, members }, null, 2), { mode: 0o600 });
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

// ---------- What members may use ----------
type Someone = { id: string; role: "admin" | "member" };

/** The provider members' Bots run on: OpenCode Zen with the members' key, limited to the allowed models. */
export const memberProvider = (): Provider => ({ id: MEMBER_PROVIDER, name: "OpenCode Zen", signIn: null, models: [...members.models], desktop: [] });
export const memberPolicy = (): Readonly<MemberPolicy> => members;
export const memberKeyStatus = () => ({ ...memberKey });

/** Records whether the members' key is set, and its last four characters (kept in step by the credential store). */
export function setMemberKeyStatus(hint: string | null | false) {
  const next = hint === false ? { set: false, hint: null } : { set: true, hint };
  if (next.set === memberKey.set && next.hint === memberKey.hint) return;
  memberKey = next;
  changed();
}

/** Changes which OpenCode Zen models members may use, their default, and the cap for members without their own. */
export function setMemberPolicy(patch: { models?: string[]; defaultModel?: string; defaultCap?: number | null }) {
  const offered = zenOffers();
  const models = patch.models ? [...new Set(patch.models.map((item) => item.trim()).filter(Boolean))] : members.models;
  const unknown = models.find((model) => !offered.has(model));
  if (unknown) throw new Error(`OpenCode Zen doesn't offer ${unknown}.`);
  const preferred = patch.defaultModel ?? members.defaultModel;
  if (patch.defaultModel !== undefined && !models.includes(preferred)) throw new Error("Pick the default from the models members may use.");
  members = {
    ...members, models,
    defaultModel: models.includes(preferred) ? preferred : models[0] ?? "",
    ...(patch.defaultCap !== undefined ? { defaultCap: patch.defaultCap } : {}),
  };
  persist();
  changed();
}

/** What a member may spend a month, in dollars (null: no cap), and whether it's their own or the default. */
export function spendCapOf(personId: string): { cap: number | null; own: boolean } {
  return personId in members.caps ? { cap: members.caps[personId], own: true } : { cap: members.defaultCap, own: false };
}

/** Sets one member's monthly cap (a number, or null for none), or puts them back on the default. */
export function setSpendCap(personId: string, cap: number | null | "default") {
  const caps = { ...members.caps };
  if (cap === "default") delete caps[personId]; else caps[personId] = cap;
  members = { ...members, caps };
  persist();
}

const memberRef = (model: string) => modelRef(MEMBER_PROVIDER, model);

/** The models this person's Bots may use: the admin's own for the admin; the allowed OpenCode Zen ones for a member. */
export function modelOptionsFor(person: Someone): ModelOption[] {
  if (person.role === "admin") return modelOptions();
  return members.models.map((model) => ({ ref: memberRef(model), providerId: MEMBER_PROVIDER, providerName: "OpenCode Zen", model, desktop: false }));
}

/** The default for this person's new Bots. */
export function defaultModelFor(person: Someone) {
  if (person.role === "admin") return defaultModel();
  return members.defaultModel && members.models.includes(members.defaultModel) ? memberRef(members.defaultModel) : "";
}

/** Whether this person's Bots have a model they can use right now. */
export const configuredFor = (person: Someone) => (person.role === "admin" ? modelConfigured() : memberKey.set && Boolean(defaultModelFor(person)));

/**
 * The model a person picks for a Bot: for the admin, resolveModel as always; for a member, one of
 * the allowed models (the one asked for, else their default unless `fallback` is false). A member
 * gets nothing else, whether or not the members' key is set yet.
 */
export function resolveModelFor(person: Someone, requested: string | undefined, { fallback = true }: { fallback?: boolean } = {}): ModelTarget | null {
  if (person.role === "admin") return resolveModel(requested, { fallback });
  const provider = memberProvider();
  const prefix = [MEMBER_PROVIDER, LEGACY_MEMBER_PROVIDER].find((id) => requested?.startsWith(`${id}${SEP}`));
  const asked = prefix ? requested!.slice(prefix.length + SEP.length) : null;
  if (asked && provider.models.includes(asked)) return { provider, model: asked, ref: memberRef(asked) };
  if (!fallback) return null;
  const preferred = defaultModelFor(person);
  return preferred ? { provider, model: members.defaultModel, ref: preferred } : null;
}

/**
 * The model a Bot's turn runs on, or why it can't run. The admin's Bots use the admin's models; a
 * member's Bots only ever use the members' provider and an allowed model, never the admin's sign-ins.
 */
export function modelForBot(bot: { model: string; ownerId: string }, owner: Someone): ModelTarget {
  if (owner.role === "admin") {
    const target = resolveModel(bot.model);
    if (!target) throw new RunRefused("No model yet. Open Settings (the gear on the Bots screen) and sign in to ChatGPT or OpenCode.");
    return target;
  }
  if (!memberKey.set) throw new RunRefused(NO_MEMBER_MODELS);
  const target = resolveModelFor(owner, bot.model || undefined, { fallback: !bot.model });
  if (!target) {
    const name = bot.model.split(SEP).pop() || "That model";
    throw new RunRefused(`${name} isn't one of the models members may use. Pick another in this Bot's profile.`);
  }
  return target;
}

/** Every provider. */
export const listProviders = (): readonly Provider[] => providers;
export const providerById = (id: string) => providerOf(id) ?? null;

/**
 * A model's price: set by hand on its provider, else $0 if pi-ai's catalog lists it as free, else
 * from the built-in table. Members' models use OpenCode Zen's own catalog price (what the members'
 * key is billed, $0 for the free ones), and the built-in table only for models the catalog lacks.
 */
export function priceOf(provider: Provider, model: string): Price | null {
  if (provider.id === MEMBER_PROVIDER) return catalogPrice("opencode", model) ?? builtInPrice(model);
  const listed = provider.id === "dev" ? null : catalogPrice(provider.id, model);
  const free = listed && !listed.input && !listed.output ? listed : null;
  return provider.prices?.[model] ?? free ?? builtInPrice(model);
}

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
    role: "admin",
    providers: providers.map((provider) => {
      const { prices: _, baseURL: __, ...rest } = provider;
      const prices = Object.fromEntries(provider.models.flatMap((model) => { const price = priceOf(provider, model); return price ? [[model, price]] : []; }));
      return { ...rest, signedIn: usable(provider), prices, catalog: catalogOf(provider) };
    }),
    signIns: SIGN_INS.map(({ id, name }) => ({ id, name, signedIn: signedIn.has(id), account: signedIn.get(id) ?? null })),
    defaultModel: defaultModel(),
    configured: modelConfigured(),
    voice: { ...voice, keySet: Boolean(voiceKey), keyHint: voiceKey.length >= 12 ? voiceKey.slice(-4) : null },
    members: {
      keySet: memberKey.set, keyHint: memberKey.hint, models: [...members.models], defaultModel: members.defaultModel, defaultCap: members.defaultCap,
      catalog: catalogOf({ id: MEMBER_PROVIDER, models: [] }),
      prices: Object.fromEntries(members.models.flatMap((model) => { const price = priceOf(memberProvider(), model); return price ? [[model, price]] : []; })),
    },
  };
}

/** A member's reduced settings. */
export function memberSettingsView(person: Someone): MemberSettingsView {
  return {
    role: "member", models: modelOptionsFor(person), defaultModel: defaultModelFor(person), configured: configuredFor(person),
    voice: { on: Boolean(voice.baseURL), allowCalls: voice.allowCalls, quietFrom: voice.quietFrom, quietTo: voice.quietTo },
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
