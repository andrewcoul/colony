import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root (server/src or server/dist sit two levels below it). */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function list(value: string | undefined) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** An installed Colony's home folder (set by its launcher); unset when run from a checkout. */
const home = process.env.COLONY_HOME ? path.resolve(process.env.COLONY_HOME) : null;

/**
 * A keyless OpenAI-compatible server (Ollama, LM Studio, a test double) offered beside the
 * sign-ins, for development. Off unless both are set.
 */
const dev = { baseURL: process.env.COLONY_DEV_BASE_URL ?? "", models: list(process.env.COLONY_DEV_MODELS) };

const cloudflareEmails = list(process.env.COLONY_CF_ACCESS_ALLOWED_EMAILS);

/** Server configuration from environment variables (see .env.example). */
export const config = {
  host: process.env.COLONY_HOST ?? "127.0.0.1",
  port: Number(process.env.COLONY_PORT ?? 8787),
  dataDir: path.resolve(home ?? root, process.env.COLONY_DATA_DIR ?? "data"),
  home,
  /** GitHub repository whose releases Colony updates from. */
  updateRepo: process.env.COLONY_UPDATE_REPO ?? "andrewcoul/colony",
  /** Where to ask about releases (tests point this at a local server). */
  updateApi: process.env.COLONY_UPDATE_API ?? "https://api.github.com",
  dev,
  firecrawlUrl: process.env.COLONY_FIRECRAWL_URL ?? "http://127.0.0.1:3002",
  /** Optional: tailnet logins (e.g. you@gmail.com) allowed in through `tailscale serve`. They're all the admin. */
  allowedUsers: list(process.env.COLONY_ALLOWED_USERS),
  /**
   * Emails that sign in as the admin (the person who runs Colony) rather than as a member.
   * Nothing is assumed: with none set, a signed-in email is never the admin.
   */
  adminEmails: list(process.env.COLONY_ADMIN_EMAILS),
  /**
   * Optional: Cloudflare Access in front of a Cloudflare Tunnel to this server. Requests through
   * the tunnel are refused unless the team domain and AUD are set and the sign-in's email is allowed.
   */
  cloudflareAccess: {
    teamDomain: process.env.COLONY_CF_ACCESS_TEAM_DOMAIN?.trim() ?? "",
    aud: process.env.COLONY_CF_ACCESS_AUD?.trim() ?? "",
    emails: cloudflareEmails.length ? cloudflareEmails : list(process.env.COLONY_ALLOWED_USERS),
  },
  limits: {
    historyMessages: 40,
    maxSteps: 25,
    /** Desktop work is many small actions (look, click, type). */
    maxDesktopSteps: 80,
    /** Switch off a Bot's computer after this many idle minutes (0 keeps computers on). */
    computerIdleMinutes: Number(process.env.COLONY_COMPUTER_IDLE_MINUTES ?? 5),
    /** How many Bot computers a member may have running at once (the admin has no limit). */
    memberMaxComputers: Math.max(0, Number(process.env.COLONY_MEMBER_MAX_COMPUTERS ?? 2) || 0),
    memoryChars: 4000,
    userChars: 2000,
    maxOutputTokens: 8192,
    turnTimeoutMs: 15 * 60_000,
  },
} as const;

