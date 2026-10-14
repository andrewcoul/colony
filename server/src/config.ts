import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root (server/src or server/dist sit two levels below it). */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function list(value: string | undefined) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

const models = list(process.env.COLONY_MODELS);

export type ModelConfig = { providerName: string; baseURL: string; apiKey: string; models: string[]; defaultModel: string };

/**
 * Starting values for the model provider (any OpenAI-compatible endpoint). Settings in
 * the app take over once saved; see settings.ts.
 */
const model: ModelConfig = {
  baseURL: process.env.COLONY_API_BASE_URL ?? "",
  apiKey: process.env.COLONY_API_KEY ?? "",
  providerName: process.env.COLONY_PROVIDER_NAME ?? "colony",
  models,
  defaultModel: models[0] ?? "",
};

/** Server configuration from environment variables (see .env.example). */
export const config = {
  host: process.env.COLONY_HOST ?? "127.0.0.1",
  port: Number(process.env.COLONY_PORT ?? 8787),
  dataDir: path.resolve(root, process.env.COLONY_DATA_DIR ?? "data"),
  model,
  firecrawlUrl: process.env.COLONY_FIRECRAWL_URL ?? "http://127.0.0.1:3002",
  /** Optional: tailnet logins (e.g. you@gmail.com) allowed in through `tailscale serve`. */
  allowedUsers: list(process.env.COLONY_ALLOWED_USERS),
  limits: {
    historyMessages: 40,
    maxSteps: 25,
    /** Desktop work is many small actions (look, click, type). */
    maxDesktopSteps: 80,
    /** Switch off a Bot's computer after this many idle minutes (0 keeps computers on). */
    computerIdleMinutes: Number(process.env.COLONY_COMPUTER_IDLE_MINUTES ?? 5),
    memoryChars: 4000,
    userChars: 2000,
    maxOutputTokens: 8192,
    turnTimeoutMs: 15 * 60_000,
  },
} as const;

