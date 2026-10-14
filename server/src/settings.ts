import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { ModelOption } from "./shared/types.js";

/**
 * The API a provider speaks: OpenAI-compatible chat completions (most providers), or
 * Anthropic's Messages API (Claude, directly or through gateways that expose it).
 */
export type Protocol = "openai" | "anthropic";

/** One provider: its address, API format, key, and the models you've picked from it. */
export type Provider = { id: string; name: string; baseURL: string; protocol: Protocol; apiKey: string; models: string[] };
export type ProviderInput = { name: string; baseURL: string; protocol?: Protocol; apiKey?: string; models: string[] };
export type ModelTarget = { provider: Provider; model: string; ref: string };

/** What devices see. Keys never leave the server. */
export type ProviderView = Omit<Provider, "apiKey"> & { keySet: boolean; keyHint: string | null };
export type SettingsView = { providers: ProviderView[]; defaultModel: string; configured: boolean; source: "app" | "env" };

/**
 * Bots point at "<provider id>::<model id>". Model ids often contain "/" or ":"
 * (openai/gpt-…, llama3:8b), so the separator is a double colon.
 */
const SEP = "::";
export const modelRef = (providerId: string, model: string) => `${providerId}${SEP}${model}`;

let providers: Provider[] = [];
let defaultRef = "";
let source: "app" | "env" = "env";

const settingsFile = () => path.join(config.dataDir, "settings.json");
const normalizeURL = (url: string) => url.trim().replace(/\/+$/, "");
const hostName = (url: string) => { try { return new URL(url).hostname; } catch { return "Provider"; } };

/** Loads providers saved in the app, or starts from .env. Call once at startup. */
export function loadSettings() {
  const env = config.model;
  providers = env.baseURL && env.models.length
    ? [{ id: "env", name: env.providerName === "colony" ? hostName(env.baseURL) : env.providerName, baseURL: normalizeURL(env.baseURL), protocol: "openai", apiKey: env.apiKey, models: [...env.models] }]
    : [];
  defaultRef = "";
  source = "env";
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as {
      providers?: Provider[];
      defaultModel?: string;
      /** The single-provider format from before multiple providers. */
      model?: { providerName: string; baseURL: string; apiKey: string; models: string[] };
    };
    if (saved.providers) {
      providers = saved.providers.map((provider) => ({ ...provider, protocol: provider.protocol ?? "openai" }));
      defaultRef = saved.defaultModel ?? "";
    } else if (saved.model) {
      providers = [{ id: "env", name: saved.model.providerName, baseURL: normalizeURL(saved.model.baseURL), protocol: "openai", apiKey: saved.model.apiKey, models: saved.model.models }];
    }
    source = "app";
  } catch { /* Nothing saved yet: .env values stand. */ }
  ensureDefault();
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
  fs.writeFileSync(temp, JSON.stringify({ providers, defaultModel: defaultRef }, null, 2), { mode: 0o600 });
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

/**
 * What a Bot's model setting means right now. Accepts refs and plain model ids from
 * before multiple providers (matched to the first provider offering that model).
 * Falls back to the default model unless `fallback` is false.
 */
export function resolveModel(requested: string | undefined, { fallback = true } = {}): ModelTarget | null {
  const exact = find(requested);
  if (exact) return exact;
  if (requested && !requested.includes(SEP)) {
    const provider = providers.find((item) => item.models.includes(requested));
    if (provider) return { provider, model: requested, ref: modelRef(provider.id, requested) };
  }
  return fallback ? find(defaultRef) : null;
}

export const modelConfigured = () => Boolean(find(defaultRef));

export function modelOptions(): ModelOption[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({ ref: modelRef(provider.id, model), providerId: provider.id, providerName: provider.name, model })));
}

export function defaultModel() {
  return defaultRef;
}

export function settingsView(): SettingsView {
  return {
    providers: providers.map(({ apiKey, ...provider }) => ({ ...provider, keySet: Boolean(apiKey), keyHint: apiKey.length >= 12 ? apiKey.slice(-4) : null })),
    defaultModel: defaultRef,
    configured: modelConfigured(),
    source,
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
  const next: Provider = {
    id: existing?.id ?? `p${randomBytes(4).toString("hex")}`,
    name: input.name.trim() || hostName(baseURL),
    baseURL,
    protocol: input.protocol ?? existing?.protocol ?? "openai",
    apiKey: input.apiKey?.trim() || (keepKey ? existing.apiKey : ""),
    models: [...new Set(input.models.map((item) => item.trim()).filter(Boolean))],
  };
  providers = existing ? providers.map((item) => (item.id === next.id ? next : item)) : [...providers, next];
  ensureDefault();
  persist();
  return next.id;
}

export function deleteProvider(id: string) {
  providers = providers.filter((item) => item.id !== id);
  ensureDefault();
  persist();
}

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
