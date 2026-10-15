import type { Access, Account, AppState, Artifact, ArtifactVersion, Bot, Chat, ChatFile, Folder, Message, NodeAccess, PcLevel, Routine, Schedule, TopicIcon } from "@shared/types";

export type TopicInput = { title: string; icon: TopicIcon; brief: string; folderId: string | null; memberIds: string[]; coordinatorId?: string };

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
/** Voice calls (server/src/settings.ts VoiceSettings). */
export type VoiceSettings = {
  providerId: string | null;
  transcribeModel: string;
  speechModel: string;
  voice: string;
  botVoices: Record<string, string>;
  allowCalls: boolean;
  quietFrom: string;
  quietTo: string;
};
export type Settings = { providers: ProviderView[]; defaultModel: string; configured: boolean; source: "app" | "env"; voice: VoiceSettings };

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

/** Connected accounts, and the OAuth clients you registered (ids only). */
export type AccountsView = { accounts: Account[]; access: Access[]; apps: { google: { clientId: string } | null; microsoft: { clientId: string } | null } };
export type SignInStatus = { status: "pending" | "done" | "error"; error?: string; account?: Account };

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
  createTopic: (input: TopicInput) => request<Chat>("POST", "/topics", input),
  updateTopic: (id: string, patch: Partial<TopicInput> & { archived?: boolean }) => request<Chat>("PATCH", `/chats/${id}`, patch),
  /** A topic a Bot suggested: accept creates it. */
  answerTopic: (messageId: string, proposalId: string, accept: boolean) => request<Chat | void>("POST", `/messages/${messageId}/topics/${proposalId}`, { accept }),
  createFolder: (title: string) => request<Folder>("POST", "/folders", { title }),
  updateFolder: (id: string, patch: { title?: string; position?: number }) => request<Folder>("PATCH", `/folders/${id}`, patch),
  deleteFolder: (id: string) => request<void>("DELETE", `/folders/${id}`),
  deleteChat: (id: string) => request<void>("DELETE", `/chats/${id}`),
  messages: (chatId: string, before?: number) => request<Message[]>("GET", `/chats/${chatId}/messages${before ? `?before=${before}` : ""}`),
  /** mode only matters while a Bot is working: steer joins its turn now, queue waits for it to finish. */
  send: (chatId: string, text: string, mode: "steer" | "queue" = "steer", attachments: string[] = []) =>
    request<{ message: Message; replies: string[] }>("POST", `/chats/${chatId}/messages`, { text, mode, attachments }),
  artifact: (chatId: string) => request<{ artifact: Artifact | null; versions: Omit<ArtifactVersion, "body">[] }>("GET", `/chats/${chatId}/artifact`),
  artifactVersion: (chatId: string, version: number) => request<ArtifactVersion>("GET", `/chats/${chatId}/artifact/versions/${version}`),
  restoreArtifact: (chatId: string, version: number) => request<Artifact>("POST", `/chats/${chatId}/artifact/restore`, { version }),
  chatFiles: (chatId: string) => request<ChatFile[]>("GET", `/chats/${chatId}/files`),
  deleteFile: (id: string) => request<void>("DELETE", `/files/${id}`),
  /** Uploads one file to a chat; it can then be sent with a message or just sit in the topic's Files. */
  async uploadFile(chatId: string, file: File): Promise<ChatFile> {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/chats/${chatId}/files`, { method: "POST", body: form });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error || `Upload failed (${response.status}).`);
    }
    return response.json() as Promise<ChatFile>;
  },
  steerNow: (messageId: string) => request<void>("POST", `/messages/${messageId}/steer`),
  unqueue: (messageId: string) => request<void>("DELETE", `/messages/${messageId}`),
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
  setVoice: (patch: Partial<VoiceSettings>) => request<Settings>("PUT", "/settings/voice", patch),
  /** A sample line in a voice, as audio. */
  tryVoice: async (voice: string) => {
    const response = await fetch("/api/settings/voice/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice }) });
    if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't play that voice.");
    return response.blob();
  },
  setPcLevel: (botId: string, nodeId: string, level: PcLevel) => request<{ nodeAccess: NodeAccess[] }>("PUT", `/bots/${encodeURIComponent(botId)}/pc/${encodeURIComponent(nodeId)}`, { level }),
  forgetNode: (nodeId: string) => request<{ ok: true }>("DELETE", `/nodes/${encodeURIComponent(nodeId)}`),
  declineCall: (callId: string) => request<{ ok: true }>("POST", `/calls/${encodeURIComponent(callId)}/decline`),
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
  /** chatId: a topic the Bot is in, to post results there instead of the Bot's own chat. */
  createRoutine: (botId: string, input: RoutineInput, chatId?: string) => request<Routine>("POST", `/bots/${botId}/routines`, { ...input, chatId }),
  updateRoutine: (id: string, patch: Partial<RoutineInput>) => request<Routine>("PATCH", `/routines/${id}`, patch),
  deleteRoutine: (id: string) => request<void>("DELETE", `/routines/${id}`),
  runRoutine: (id: string) => request<{ messageId: string }>("POST", `/routines/${id}/run`),
  pushKey: () => request<{ publicKey: string }>("GET", "/push/key"),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<void>("POST", "/push/subscribe", subscription),
  pushUnsubscribe: (endpoint: string) => request<void>("POST", "/push/unsubscribe", { endpoint }),
  pushStatus: (endpoint: string) => request<{ subscribed: boolean }>("POST", "/push/status", { endpoint }),
  pushTest: () => request<{ delivered: number }>("POST", "/push/test"),
  focus: (input: { clientId: string; chatId: string | null; visible: boolean }) => request<void>("POST", "/focus", input),
  accounts: () => request<AccountsView>("GET", "/accounts"),
  startGoogle: (app: { clientId?: string; clientSecret?: string }) => request<{ id: string; url: string; redirectUri: string }>("POST", "/accounts/google/start", app),
  finishGoogle: (id: string, url: string) => request<SignInStatus>("POST", "/accounts/google/finish", { id, url }),
  startMicrosoft: (app: { clientId?: string }) => request<{ id: string; userCode: string; verificationUri: string; expiresIn: number }>("POST", "/accounts/microsoft/start", app),
  signInStatus: (id: string) => request<SignInStatus>("GET", `/accounts/signin/${encodeURIComponent(id)}`),
  cancelSignIn: (id: string) => request<void>("POST", `/accounts/signin/${encodeURIComponent(id)}/cancel`),
  connectOnePassword: (input: { token: string } | { desktopAccount: string }) => request<Account>("POST", "/accounts/onepassword", input),
  removeAccount: (id: string) => request<void>("DELETE", `/accounts/${encodeURIComponent(id)}`),
  setAccess: (botId: string, accountId: string, patch: Partial<Pick<Access, "mail" | "calendar" | "vault">>) => request<Access>("PUT", `/bots/${botId}/access/${encodeURIComponent(accountId)}`, patch),
};

/** Where a chat file can be opened or downloaded. */
export const fileUrl = (id: string) => `/api/files/${id}`;
/** A web image, loaded through Colony so the site never sees this device. */
export const imageUrl = (url: string) => `/api/img?u=${encodeURIComponent(url)}`;
