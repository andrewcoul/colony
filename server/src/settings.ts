import fs from "node:fs";
import path from "node:path";
import { config, modelConfigured } from "./config.js";

export type ModelSettingsInput = { providerName: string; baseURL: string; apiKey?: string; models: string[] };

/** What devices see. The key itself never leaves the server. */
export type ModelSettingsView = {
  providerName: string;
  baseURL: string;
  models: string[];
  defaultModel: string;
  keySet: boolean;
  /** Last four characters, so you can tell keys apart. */
  keyHint: string | null;
  configured: boolean;
  source: "app" | "env";
};

const settingsFile = () => path.join(config.dataDir, "settings.json");
let source: "app" | "env" = "env";

const normalizeURL = (url: string) => url.trim().replace(/\/+$/, "");

/** Applies settings saved in the app over the .env values. Call once at startup. */
export function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { model?: Omit<ModelSettingsInput, "apiKey"> & { apiKey: string } };
    if (saved.model) { apply(saved.model); source = "app"; }
  } catch { /* No saved settings yet: .env values stand. */ }
}

function apply(next: { providerName: string; baseURL: string; apiKey: string; models: string[] }) {
  Object.assign(config.model, { ...next, baseURL: normalizeURL(next.baseURL), defaultModel: next.models[0] ?? "" });
}

/**
 * Saves the model connection and switches to it immediately (the next reply uses it).
 * A blank key keeps the saved one, but only for the same address: a key is never
 * sent to a different provider than the one it was saved for.
 */
export function saveModelSettings(input: ModelSettingsInput) {
  const baseURL = normalizeURL(input.baseURL);
  const sameProvider = baseURL === normalizeURL(config.model.baseURL);
  const apiKey = input.apiKey?.trim() || (sameProvider ? config.model.apiKey : "");
  const models = [...new Set(input.models.map((item) => item.trim()).filter(Boolean))];
  const next = { providerName: input.providerName.trim(), baseURL, apiKey, models };
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Write then rename, so a crash never leaves half a file. Readable only by you.
  const temp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ model: next }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, settingsFile());
  apply(next);
  source = "app";
  return modelSettingsView();
}

export function modelSettingsView(): ModelSettingsView {
  const key = config.model.apiKey;
  return {
    providerName: config.model.providerName,
    baseURL: config.model.baseURL,
    models: [...config.model.models],
    defaultModel: config.model.defaultModel,
    keySet: Boolean(key),
    keyHint: key.length >= 12 ? key.slice(-4) : null,
    configured: modelConfigured(),
    source,
  };
}

/** The key to use when checking `baseURL`: one typed in, or the saved one for that same address. */
export function keyFor(baseURL: string, typed?: string) {
  if (typed?.trim()) return typed.trim();
  return normalizeURL(baseURL) === normalizeURL(config.model.baseURL) ? config.model.apiKey : "";
}

/** Lists the provider's models (OpenAI-compatible GET /models). Doubles as a connection check. */
export async function listProviderModels(baseURL: string, apiKey: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${normalizeURL(baseURL)}/models`, {
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
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
