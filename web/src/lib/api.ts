import type { Access, Account, AppState, Artifact, ArtifactVersion, Bot, Chat, ChatFile, Folder, Me, Message, ModelOption, PersonSummary, Price, Routine, Schedule, Spending, TopicIcon } from "@shared/types";

export type TopicInput = { title: string; icon: TopicIcon; brief: string; folderId: string | null; memberIds: string[]; coordinatorId?: string };

/**
 * A request that failed. `signIn`: you need to sign in (through the website). `offline`: the
 * website can't reach the PC Colony runs on.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly signIn = false, readonly offline = false) { super(message); this.name = "ApiError"; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string; signIn?: boolean; offline?: boolean } | null;
    throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status, response.status === 401 && Boolean(data?.signIn), Boolean(data?.offline));
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** An invite as the admin sees it (server/src/invites.ts). */
export type Invite = { id: string; email: string; status: "pending" | "used" | "revoked" | "expired"; createdAt: number; expiresAt: number; sentAt: number | null; usedAt: number | null };
/** Inviting: emailed, or a link to copy (no email set up, or it didn't work). */
export type InviteSent = { invite: Invite; emailed: boolean; link?: string; error?: string };
export type WebSignIn = { enabled: boolean; email: boolean; adminEmails: string[]; origins: string[] };

export type BrowserInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "viewport"; mobile: boolean };

export type FileEntry = { name: string; path: string; type: "file" | "dir"; size: number; modifiedAt: number };

/** The sign-ins models come from (server/src/settings.ts). */
export type SignInId = "chatgpt" | "opencode";
export type SignInView = { id: SignInId; name: string; signedIn: boolean; account: string | null };
/** A model a provider offers. */
export type CatalogModel = { id: string; name: string; images: boolean };
/**
 * A provider: ChatGPT, OpenCode Go or Zen (or a dev server from .env, `signIn` null), the models
 * picked from it, and what it offers. `prices`: each picked model's price per million tokens, set or built in.
 */
export type ProviderView = { id: string; name: string; signIn: SignInId | null; signedIn: boolean; models: string[]; desktop: string[]; prices: Record<string, Price>; catalog: CatalogModel[] };
/** `prices`: changed ones only; null puts a model back to its built-in price. */
export type ProviderInput = { models: string[]; desktop?: string[]; prices?: Record<string, Price | null> };
/** How a sign-in continues: open `url` (ChatGPT), or approve `userCode` at `verificationUri` (OpenCode). */
export type ModelSignInStart =
  | { id: string; kind: "browser"; url: string }
  | { id: string; kind: "code"; userCode: string; verificationUri: string };
export type ModelSignInStatus = { status: "pending" | "done" | "error"; error?: string };
export type DesktopVerdict = { model: string; reads: boolean; points: boolean; canDrive: boolean; error?: string };
/** Voice calls (server/src/settings.ts VoiceSettings). */
export type VoiceSettings = {
  /** OpenAI-compatible audio endpoints; "" is off. */
  baseURL: string;
  transcribeModel: string;
  speechModel: string;
  voice: string;
  botVoices: Record<string, string>;
  allowCalls: boolean;
  quietFrom: string;
  quietTo: string;
};
/** Voice as devices see it: the key's last four characters at most. */
export type VoiceView = VoiceSettings & { keySet: boolean; keyHint: string | null };
/** Members' models: whether the members' OpenCode API key is set (its last four characters only), and what members may use. */
export type MembersView = {
  keySet: boolean; keyHint: string | null; models: string[]; defaultModel: string; defaultCap: number | null;
  catalog: CatalogModel[]; prices: Record<string, Price>;
};
export type Settings = { role?: "admin"; providers: ProviderView[]; signIns: SignInView[]; defaultModel: string; configured: boolean; voice: VoiceView; members?: MembersView };
/** What a member sees of Settings: the models they may use, their spending and cap, and whether voice is on (server/src/settings.ts). */
export type MemberSettings = {
  role: "member"; models: ModelOption[]; defaultModel: string; configured: boolean;
  voice: { on: boolean; allowCalls: boolean; quietFrom: string; quietTo: string };
  spent: number; cap: number | null;
};

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
  /** A new topic carrying the Bot's conversation up to this reply. */
  branch: (messageId: string, title: string, folderId: string | null = null) => request<{ chatId: string }>("POST", `/messages/${messageId}/branch`, { title, folderId }),
  unqueue: (messageId: string) => request<void>("DELETE", `/messages/${messageId}`),
  stop: (chatId: string) => request<void>("POST", `/chats/${chatId}/stop`),
  /** Persistent conversations: summarise the older part now, or start the Bot afresh here. */
  compact: (chatId: string) => request<void>("POST", `/chats/${chatId}/compact`, {}),
  startFresh: (chatId: string) => request<void>("POST", `/chats/${chatId}/fresh`, {}),
  markRead: (chatId: string) => request<void>("POST", `/chats/${chatId}/read`),
  decide: (approvalId: string, approve: boolean) => request<void>("POST", `/approvals/${approvalId}`, { approve }),
  terminal: (botId: string) => request<{ text: string }>("GET", `/bots/${botId}/terminal`),
  files: (botId: string, path = "") => request<FileEntry[]>("GET", `/bots/${botId}/files?path=${encodeURIComponent(path)}`),
  file: (botId: string, path: string) => request<{ path: string; content: string; size: number; truncated: boolean }>("GET", `/bots/${botId}/file?path=${encodeURIComponent(path)}`),
  stopComputer: (botId: string) => request<void>("POST", `/bots/${botId}/computer/stop`),
  settings: () => request<Settings>("GET", "/settings"),
  /** A member's reduced Settings. */
  memberSettings: () => request<MemberSettings>("GET", "/settings"),
  /** Who you are, and what your Bots know about you (your USER.md). */
  me: () => request<{ me: Me; about: string }>("GET", "/me"),
  setAbout: (text: string) => request<{ about: string }>("PUT", "/me/about", { text }),
  /** The admin's: the members' OpenCode API key (only its last four characters ever come back). */
  setMemberKey: (key: string) => request<Settings>("PUT", "/settings/members/key", { key }),
  clearMemberKey: () => request<Settings>("DELETE", "/settings/members/key"),
  setMemberPolicy: (patch: { models?: string[]; defaultModel?: string; defaultCap?: number | null }) => request<Settings>("PUT", "/settings/members", patch),
  people: () => request<PersonSummary[]>("GET", "/people"),
  /** `cap`: dollars a month, null for none, "default" for the members' default. */
  updatePerson: (id: string, patch: { cap?: number | null | "default"; disabled?: boolean }) => request<PersonSummary>("PUT", `/people/${encodeURIComponent(id)}`, patch),
  /** Removes a member's account (they're turned off); `deleteData` removes their Bots, chats and files too. */
  removePerson: (id: string, deleteData = false) => request<PersonSummary | void>("DELETE", `/people/${encodeURIComponent(id)}${deleteData ? "?data=delete" : ""}`),
  invites: () => request<Invite[]>("GET", "/invites"),
  invite: (email: string) => request<InviteSent>("POST", "/invites", { email }),
  resendInvite: (id: string) => request<InviteSent>("POST", `/invites/${encodeURIComponent(id)}/resend`),
  revokeInvite: (id: string) => request<void>("DELETE", `/invites/${encodeURIComponent(id)}`),
  webSignIn: () => request<WebSignIn>("GET", "/web-signin"),
  setUpAdminSignIn: (email: string, password: string) => request<void>("POST", "/web-signin/admin", { email, password }),
  spending: () => request<Spending>("GET", "/spending"),
  updateProvider: (id: string, input: ProviderInput) => request<Settings>("PUT", `/settings/providers/${encodeURIComponent(id)}`, input),
  startModelSignIn: (id: SignInId) => request<ModelSignInStart>("POST", `/settings/signins/${id}/start`),
  modelSignInStatus: (session: string) => request<ModelSignInStatus>("GET", `/settings/signins/session/${encodeURIComponent(session)}`),
  finishModelSignIn: (session: string, url: string) => request<void>("POST", `/settings/signins/session/${encodeURIComponent(session)}/finish`, { url }),
  cancelModelSignIn: (session: string) => request<void>("POST", `/settings/signins/session/${encodeURIComponent(session)}/cancel`),
  signOut: (id: SignInId) => request<Settings>("DELETE", `/settings/signins/${id}`),
  setDefaultModel: (model: string) => request<Settings>("PUT", "/settings/default-model", { model }),
  /** `apiKey`: a new key, "" to remove it; left out keeps it. */
  setVoice: (patch: Partial<VoiceSettings> & { apiKey?: string }) => request<Settings>("PUT", "/settings/voice", patch),
  /** A sample line in a voice, as audio. */
  tryVoice: async (voice: string) => {
    const response = await fetch("/api/settings/voice/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice }) });
    if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't play that voice.");
    return response.blob();
  },
  forgetNode: (nodeId: string) => request<{ ok: true }>("DELETE", `/nodes/${encodeURIComponent(nodeId)}`),
  declineCall: (callId: string) => request<{ ok: true }>("POST", `/calls/${encodeURIComponent(callId)}/decline`),
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
