import type { AppState, Bot, Chat, Message } from "@shared/types";

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

export type FileEntry = { name: string; path: string; type: "file" | "dir"; size: number; modifiedAt: number };

export type NewBot = { name: string; title: string; description: string; model?: string; computer: boolean; faceSeed?: string };

export const api = {
  state: () => request<AppState>("GET", "/state"),
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
};
