/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import agentComponent from "@convex-dev/agent/test";
import rateLimiterComponent from "@convex-dev/rate-limiter/test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

vi.mock("@ai-sdk/openai-compatible", async () => {
  const { MockLanguageModelV4, convertArrayToReadableStream } = await import("ai/test");
  return {
    createOpenAICompatible: () => ({
      chatModel: () => new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Hello " },
            { type: "text-delta", id: "answer", delta: "from Colony." },
            { type: "text-end", id: "answer" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 4, text: 4, reasoning: 0 },
            } },
          ]),
        }),
      }),
    }),
  };
});

// Generation ids are "<prompt message id>:<attempt uuid>".
const promptOf = (generationId: string) => generationId.split(":")[0];
const modules = import.meta.glob("../convex/**/*.ts");
async function setup() {
  const t = convexTest(schema, modules);
  agentComponent.register(t);
  rateLimiterComponent.register(t);
  const ownerId = await t.run((ctx) => ctx.db.insert("users", { email: "owner@example.invalid", workspaceAccess: true }));
  const otherId = await t.run((ctx) => ctx.db.insert("users", { email: "other@example.invalid" }));
  return { t, owner: t.withIdentity({ subject: ownerId }), other: t.withIdentity({ subject: otherId }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("COLONY_OWNER_EMAIL", "owner@example.invalid");
  vi.stubEnv("AI_API_KEY", "test-only-key");
  vi.stubEnv("AI_MODEL", "test-only-model");
  vi.stubEnv("AI_BASE_URL", "https://example.invalid/v1");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("private conversations", () => {
  test("search claims are atomic and only the claiming worker can complete them", async () => {
    const { t, owner, other } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Search the web", webSearch: true });
    const conv = (await owner.query(api.chat.get, { conversationId }))!;
    const searchId = await t.mutation(internal.search.begin, { conversationId, generationId: conv.generationId!, query: "Tauri docs" });
    await expect(other.mutation(api.search.claim, { searchId, workerId: "other" })).rejects.toThrow("restricted");
    expect(await owner.mutation(api.search.claim, { searchId, workerId: "first" })).toBe(true);
    expect(await owner.mutation(api.search.claim, { searchId, workerId: "second" })).toBe(false);
    await expect(owner.mutation(api.search.complete, { searchId, workerId: "second", results: [] })).rejects.toThrow("unavailable");
    await owner.mutation(api.search.complete, { searchId, workerId: "first", results: [{ url: "https://v2.tauri.app/", title: "Tauri", description: "Official docs" }] });
    expect((await t.query(internal.search.result, { searchId }))?.status).toBe("complete");
    expect((await owner.query(api.chat.get, { conversationId }))?.searchQuery).toBeUndefined();
  });

  test("stopping a reply cancels pending searches and ignores late results", async () => {
    const { t, owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Search the web", webSearch: true });
    const conv = (await owner.query(api.chat.get, { conversationId }))!;
    const searchId = await t.mutation(internal.search.begin, { conversationId, generationId: conv.generationId!, query: "Tauri docs" });
    await owner.mutation(api.search.claim, { searchId, workerId: "worker" });
    await owner.mutation(api.chat.stop, { conversationId });
    await owner.mutation(api.search.complete, { searchId, workerId: "worker", results: [{ url: "https://v2.tauri.app/", title: "Tauri", description: "Late docs" }] });
    const job = await t.query(internal.search.result, { searchId });
    expect(job?.status).toBe("cancelled");
    expect(job?.results).toBeUndefined();
  });

  test("disabled search and excess searches cannot enqueue work", async () => {
    const { t, owner } = await setup();
    const plainId = await owner.mutation(api.chat.send, { prompt: "No search" });
    const plain = (await owner.query(api.chat.get, { conversationId: plainId }))!;
    await expect(t.mutation(internal.search.begin, { conversationId: plainId, generationId: plain.generationId!, query: "Docs" })).rejects.toThrow("cancelled");
    const id = await owner.mutation(api.chat.send, { prompt: "Search", webSearch: true });
    const conv = (await owner.query(api.chat.get, { conversationId: id }))!;
    for (let i = 0; i < 3; i++) await t.mutation(internal.search.begin, { conversationId: id, generationId: conv.generationId!, query: "Docs " + i });
    await expect(t.mutation(internal.search.begin, { conversationId: id, generationId: conv.generationId!, query: "Fourth" })).rejects.toThrow("limit");
  });

  test("requires sign-in and restricts model calls to the configured owner", async () => {
    const { t, other } = await setup();
    await expect(t.query(api.chat.list, { paginationOpts: { cursor: null, numItems: 10 } })).rejects.toThrow("Sign in");
    await expect(other.mutation(api.chat.send, { prompt: "Hello" })).rejects.toThrow("restricted");
    expect((await other.query(api.settings.status, {})).canGenerate).toBe(false);
  });

  test("account creation rejects an invalid workspace code", async () => {
    vi.stubEnv("COLONY_REGISTRATION_CODE", "test-registration-code");
    const { t } = await setup();
    await expect(t.action(api.auth.signIn, {
      provider: "password", params: { email: "stranger@example.invalid", password: "test-password", flow: "signUp", workspaceCode: "wrong-code" },
    })).rejects.toThrow("Invalid workspace code");
  });

  test("server settings never expose the model key or registration code", async () => {
    const { owner } = await setup();
    const result = JSON.stringify(await owner.query(api.settings.status, {}));
    expect(result).not.toContain("test-only-key");
    expect(result).not.toContain("AI_API_KEY");
    expect(result).not.toContain("REGISTRATION_CODE");
  });

  test("rejects empty and oversized input without creating a conversation", async () => {
    const { owner } = await setup();
    await expect(owner.mutation(api.chat.send, { prompt: "   " })).rejects.toThrow("16,000");
    await expect(owner.mutation(api.chat.send, { prompt: "a".repeat(16001) })).rejects.toThrow("16,000");
    expect((await owner.query(api.chat.list, { paginationOpts: { cursor: null, numItems: 10 } })).page).toEqual([]);
  });

  test("an invitation grants access without an email allowlist; other accounts stay blocked", async () => {
    vi.stubEnv("COLONY_OWNER_EMAIL", "");
    const { owner, other } = await setup();
    expect((await owner.query(api.settings.status, {})).canGenerate).toBe(true);
    expect((await other.query(api.settings.status, {})).canGenerate).toBe(false);
    await expect(other.mutation(api.chat.send, { prompt: "Hello" })).rejects.toThrow("restricted");
  });

  test("isolates list, messages, rename, stop, and deletion by user", async () => {
    const { owner, other } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "A private thought" });
    const conversation = (await owner.query(api.chat.get, { conversationId }))!;
    expect(await other.query(api.chat.get, { conversationId })).toBeNull();
    expect((await other.query(api.chat.list, { paginationOpts: { cursor: null, numItems: 10 } })).page).toEqual([]);
    await expect(other.query(api.chat.messages, { conversationId, threadId: conversation.threadId, paginationOpts: { cursor: null, numItems: 10 }, streamArgs: undefined })).rejects.toThrow("unavailable");
    await expect(other.mutation(api.chat.rename, { conversationId, title: "Stolen" })).rejects.toThrow("unavailable");
    await expect(other.mutation(api.chat.stop, { conversationId })).rejects.toThrow("unavailable");
    await expect(other.mutation(api.chat.remove, { conversationId })).rejects.toThrow("unavailable");
  });

  test("prevents overlapping replies and deleting a running conversation", async () => {
    const { owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Hello" });
    await expect(owner.mutation(api.chat.send, { conversationId, prompt: "Again" })).rejects.toThrow("Wait");
    await expect(owner.mutation(api.chat.remove, { conversationId })).rejects.toThrow("Stop");
    const conv = (await owner.query(api.chat.get, { conversationId }))!;
    await expect(owner.query(api.chat.messages, { conversationId, threadId: "not-this-thread", paginationOpts: { cursor: null, numItems: 10 }, streamArgs: undefined })).rejects.toThrow("unavailable");
    expect(conv.generating).toBe(true);
  });

  test("streams and saves a reply with a mocked provider, then deletes its history", async () => {
    const { t, owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Hello" });
    const before = (await owner.query(api.chat.get, { conversationId }))!;
    await t.action(internal.generate.reply, { conversationId, generationId: before.generationId!, promptMessageId: promptOf(before.generationId!) });
    const after = (await owner.query(api.chat.get, { conversationId }))!;
    expect(after.generating).toBe(false);
    expect(after.error).toBeUndefined();
    const messages = await owner.query(api.chat.messages, { conversationId, threadId: after.threadId, paginationOpts: { cursor: null, numItems: 10 }, streamArgs: undefined });
    expect(messages.page.map((m) => m.text)).toContain("Hello from Colony.");
    expect(messages.page.map((m) => m.text)).toContain("Hello");
    await owner.mutation(api.chat.rename, { conversationId, title: "A new title" });
    expect((await owner.query(api.chat.get, { conversationId }))?.title).toBe("A new title");
    await owner.mutation(api.chat.remove, { conversationId });
    expect(await owner.query(api.chat.get, { conversationId })).toBeNull();
  });

  test("a stop before generation starts finishes without calling the model", async () => {
    const { t, owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Hello" });
    const before = (await owner.query(api.chat.get, { conversationId }))!;
    await owner.mutation(api.chat.stop, { conversationId });
    await t.action(internal.generate.reply, { conversationId, generationId: before.generationId!, promptMessageId: promptOf(before.generationId!) });
    const after = (await owner.query(api.chat.get, { conversationId }))!;
    expect(after.generating).toBe(false);
    expect(after.error).toBeUndefined();
    const messages = await owner.query(api.chat.messages, { conversationId, threadId: before.threadId, paginationOpts: { cursor: null, numItems: 10 }, streamArgs: undefined });
    expect(messages.page).toHaveLength(1);
    expect(messages.page[0].role).toBe("user");
  });

  test("stale completion and timeout callbacks leave a newer generation alone", async () => {
    const { t, owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Hello" });
    await t.mutation(internal.chat.finish, { conversationId, generationId: "stale-generation", error: "Stale error" });
    await t.mutation(internal.chat.expire, { conversationId, generationId: "stale-generation" });
    const conv = (await owner.query(api.chat.get, { conversationId }))!;
    expect(conv.generating).toBe(true);
    expect(conv.error).toBeUndefined();
  });

  test("regenerate replaces the latest reply instead of stacking another", async () => {
    const { t, owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Hello" });
    const first = (await owner.query(api.chat.get, { conversationId }))!;
    await t.action(internal.generate.reply, { conversationId, generationId: first.generationId!, promptMessageId: promptOf(first.generationId!) });
    await owner.mutation(api.chat.regenerate, { conversationId });
    const second = (await owner.query(api.chat.get, { conversationId }))!;
    expect(second.generating).toBe(true);
    expect(second.generationId).not.toBe(first.generationId);
    expect(promptOf(second.generationId!)).toBe(promptOf(first.generationId!));
    await t.action(internal.generate.reply, { conversationId, generationId: second.generationId!, promptMessageId: promptOf(second.generationId!) });
    const messages = await owner.query(api.chat.messages, { conversationId, threadId: second.threadId, paginationOpts: { cursor: null, numItems: 20 }, streamArgs: undefined });
    expect(messages.page.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.page.filter((m) => m.role === "assistant" && m.text)).toHaveLength(1);
  });

  test("regenerate is refused while a reply is running", async () => {
    const { owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Hello" });
    await expect(owner.mutation(api.chat.regenerate, { conversationId })).rejects.toThrow("Wait for this reply");
  });

  test("only configured models can be chosen, and settings list them", async () => {
    vi.stubEnv("AI_MODELS", "second-model, third-model");
    const { owner } = await setup();
    expect((await owner.query(api.settings.status, {})).models).toEqual(["test-only-model", "second-model", "third-model"]);
    const chosen = await owner.mutation(api.chat.send, { prompt: "Hi", model: "third-model", think: true });
    const conv = (await owner.query(api.chat.get, { conversationId: chosen }))!;
    expect(conv.model).toBe("third-model");
    expect(conv.think).toBe(true);
    const sneaky = await owner.mutation(api.chat.send, { prompt: "Hi", model: "not-allowed-expensive-model" });
    expect((await owner.query(api.chat.get, { conversationId: sneaky }))?.model).toBe("test-only-model");
  });

  test("search results with private or credentialed URLs are dropped server-side", async () => {
    const { t, owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Search", webSearch: true });
    const conv = (await owner.query(api.chat.get, { conversationId }))!;
    const searchId = await t.mutation(internal.search.begin, { conversationId, generationId: conv.generationId!, query: "Docs" });
    await owner.mutation(api.search.claim, { searchId, workerId: "w" });
    await owner.mutation(api.search.complete, { searchId, workerId: "w", results: [
      { url: "http://0.0.0.0:3002/admin", title: "Local", description: "" },
      { url: "https://user:pass@example.com/", title: "Creds", description: "" },
      { url: "http://192.168.1.1/", title: "Router", description: "" },
      { url: "https://v2.tauri.app/", title: "Tauri", description: "Docs" },
    ] });
    expect((await t.query(internal.search.result, { searchId }))?.results?.map((r) => r.url)).toEqual(["https://v2.tauri.app/"]);
  });

  test("an expired search discards late results and clears the progress label", async () => {
    const { t, owner } = await setup();
    const conversationId = await owner.mutation(api.chat.send, { prompt: "Search", webSearch: true });
    const conv = (await owner.query(api.chat.get, { conversationId }))!;
    const searchId = await t.mutation(internal.search.begin, { conversationId, generationId: conv.generationId!, query: "Docs" });
    await owner.mutation(api.search.claim, { searchId, workerId: "w" });
    await t.mutation(internal.search.expire, { searchId });
    await owner.mutation(api.search.complete, { searchId, workerId: "w", results: [{ url: "https://v2.tauri.app/", title: "Late", description: "" }] });
    const job = await t.query(internal.search.result, { searchId });
    expect(job?.status).toBe("failed");
    expect(job?.results).toBeUndefined();
    expect((await owner.query(api.chat.get, { conversationId }))?.searchQuery).toBeUndefined();
  });
});
