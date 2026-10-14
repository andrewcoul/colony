import type { AppState, Bot, Chat, Message, Routine, Schedule } from "@shared/types";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export type BrowserInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "viewport"; mobile: boolean };

export type FileEntry = { name: string; path: string; type: "file" | "dir"; size: number; modifiedAt: number };

/** "openai": OpenAI-compatible chat completions; "anthropic": Anthropic's Messages API (Claude). */
export type Protocol = "openai" | "anthropic";
export type ProviderView = { id: string; name: string; baseURL: string; protocol: Protocol; models: string[]; desktop: string[]; keySet: boolean; keyHint: string | null };
export type ProviderInput = { name: string; baseURL: string; protocol: Protocol; apiKey?: string; models: string[]; desktop?: string[] };
export type DesktopVerdict = { model: string; reads: boolean; points: boolean; canDrive: boolean; error?: string };
export type Settings = { providers: ProviderView[]; defaultModel: string; configured: boolean; source: "app" | "env" };

/** The server's version and updates (server/src/updates.ts). */
export type SystemInfo = {
  version: string;
  managed: boolean;
  latest: { version: string; notes: string; url: string; publishedAt: string } | null;
  available: boolean;
  checkedAt: number | null;
  update: { status: "idle" | "downloading" | "installing" | "restarting" | "failed"; target: string | null; progress: number | null; error: string | null };
  failed: { version: string; at: string; reason: string } | null;
  updated: { from: string | null; to: string; at: string } | null;
};

export type MemoryUsage = { used: number; budget: number };
export type BotMemory = {
  memory: string[];
  user: string[];
  usage: { memory: MemoryUsage; user: MemoryUsage };
  skills: { slug: string; name: string; description: string }[];
};

export type RoutineInput = { title: string; prompt: string; schedule: Schedule; enabled?: boolean };

export type NewBot = { name: string; title: string; description: string; model?: string; computer: boolean; desktop?: boolean; faceSeed?: string };

export const api = {
  state: () => request<AppState>("GET", "/state"),
  system: () => request<SystemInfo>("GET", "/system"),
  checkUpdates: () => request<SystemInfo>("POST", "/system/check"),
  /** Starts a server update; while Bots are mid-reply it says who instead (unless forced). */
  async updateServer(force = false): Promise<SystemInfo | { busy: string[]; message: string }> {
    const response = await fetch("/api/system/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
    const data = await response.json().catch(() => null) as (SystemInfo & { error?: string; busy?: string[] }) | null;
    if (response.status === 409 && data?.busy) return { busy: data.busy, message: data.error ?? "Bots are working." };
    if (!response.ok || !data) throw new Error(data?.error || `Request failed (${response.status}).`);
    return data;
  },
  createBot: (input: NewBot) => request<Bot>("POST", "/bots", input),
  updateBot: (id: string, patch: Partial<NewBot>) => request<Bot>("PATCH", `/bots/${id}`, patch),
  deleteBot: (id: string) => request<void>("DELETE", `/bots/${id}`),
  createGroup: (input: { title: string; memberIds: string[]; coordinatorId?: string }) => request<Chat>("POST", "/groups", input),
  deleteChat: (id: string) => request<void>("DELETE", `/chats/${id}`),
  messages: (chatId: string, before?: number) => request<Message[]>("GET", `/chats/${chatId}/messages${before ? `?before=${before}` : ""}`),
  send: (chatId: string, text: string) => request<{ message: Message; replies: string[] }>("POST", `/chats/${chatId}/messages`, { text }),
  stop: (chatId: string) => request<void>("POST", `/chats/${chatId}/stop`),
  markRead: (chatId: string) => request<void>("POST", `/chats/${chatId}/read`),
  decide: (approvalId: string, approve: boolean) => request<void>("POST", `/approvals/${approvalId}`, { approve }),
  terminal: (botId: string) => request<{ text: string }>("GET", `/bots/${botId}/terminal`),
  files: (botId: string, path = "") => request<FileEntry[]>("GET", `/bots/${botId}/files?path=${encodeURIComponent(path)}`),
  file: (botId: string, path: string) => request<{ path: string; content: string; size: number; truncated: boolean }>("GET", `/bots/${botId}/file?path=${encodeURIComponent(path)}`),
  stopComputer: (botId: string) => request<void>("POST", `/bots/${botId}/computer/stop`),
  settings: () => request<Settings>("GET", "/settings"),
  addProvider: (input: ProviderInput) => request<Settings>("POST", "/settings/providers", input),
  updateProvider: (id: string, input: ProviderInput) => request<Settings>("PUT", `/settings/providers/${encodeURIComponent(id)}`, input),
  deleteProvider: (id: string) => request<Settings>("DELETE", `/settings/providers/${encodeURIComponent(id)}`),
  setDefaultModel: (model: string) => request<Settings>("PUT", "/settings/default-model", { model }),
  checkProvider: (input: { providerId?: string; baseURL: string; protocol: Protocol; apiKey?: string }) => request<{ models: string[] }>("POST", "/settings/providers/check", input),
  soul: (botId: string) => request<{ content: string }>("GET", `/bots/${botId}/soul`),
  saveSoul: (botId: string, content: string) => request<void>("PUT", `/bots/${botId}/soul`, { content }),
  memory: (botId: string) => request<BotMemory>("GET", `/bots/${botId}/memory`),
  addMemory: (botId: string, target: "memory" | "user", entry: string) => request<BotMemory>("POST", `/bots/${botId}/memory`, { target, entry }),
  removeMemory: (botId: string, target: "memory" | "user", entry: string) => request<BotMemory>("POST", `/bots/${botId}/memory/remove`, { target, entry }),
  skill: (botId: string, slug: string) => request<{ content: string }>("GET", `/bots/${botId}/skills/${encodeURIComponent(slug)}`),
  deleteSkill: (botId: string, slug: string) => request<void>("DELETE", `/bots/${botId}/skills/${encodeURIComponent(slug)}`),
  screenLink: (botId: string) => request<{ url: string; expiresAt: number }>("GET", `/bots/${botId}/screen-link`),
  desktopCheck: (providerId: string, models?: string[]) => request<{ results: DesktopVerdict[]; settings: Settings }>("POST", `/settings/providers/${encodeURIComponent(providerId)}/desktop-check`, { models }),
  openBrowser: (botId: string) => request<{ open: boolean; url: string | null }>("POST", `/bots/${botId}/browser/open`),
  browserInput: (botId: string, input: BrowserInput) => request<void>("POST", `/bots/${botId}/browser/input`, input),
  createRoutine: (botId: string, input: RoutineInput) => request<Routine>("POST", `/bots/${botId}/routines`, input),
  updateRoutine: (id: string, patch: Partial<RoutineInput>) => request<Routine>("PATCH", `/routines/${id}`, patch),
  deleteRoutine: (id: string) => request<void>("DELETE", `/routines/${id}`),
  runRoutine: (id: string) => request<{ messageId: string }>("POST", `/routines/${id}/run`),
  pushKey: () => request<{ publicKey: string }>("GET", "/push/key"),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<void>("POST", "/push/subscribe", subscription),
  pushUnsubscribe: (endpoint: string) => request<void>("POST", "/push/unsubscribe", { endpoint }),
  pushStatus: (endpoint: string) => request<{ subscribed: boolean }>("POST", "/push/status", { endpoint }),
  pushTest: () => request<{ delivered: number }>("POST", "/push/test"),
  focus: (input: { clientId: string; chatId: string | null; visible: boolean }) => request<void>("POST", "/focus", input),
};
