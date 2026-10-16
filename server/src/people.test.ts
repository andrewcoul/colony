import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-people-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_API_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_MODELS = "mock-model";

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { AgentRunner } = await import("./agent/run.js");
const { coreTools } = await import("./agent/tools.js");
const { createApi } = await import("./api.js");
const { eventFor, writeAbout } = await import("./people.js");
(await import("./settings.js")).loadSettings();

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const prompts: { system: string; messages: string }[] = [];
const model = new MockLanguageModelV4({
  doStream: async (options) => {
    const system = options.prompt.filter((item) => item.role === "system").map((item) => String(item.content)).join("\n");
    prompts.push({ system, messages: JSON.stringify(options.prompt.filter((item) => item.role !== "system")) });
    return { stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "On it." }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as never[]) };
  },
});

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = new AgentRunner(store, events, gate, () => coreTools, () => model);
  const api = createApi({ store, events, gate, runner });
  const as = (login: string | null) => async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (login) headers["Tailscale-User-Login"] = login;
    const response = await api.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    return { status: response.status, json: json as any };
  };
  return { store, events, runner, as };
}

/** The host (first login) and Marija, each with a Bot of their own. */
async function family() {
  const env = setup();
  const andrew = env.as("andrew@example.com");
  const marija = env.as("marija@example.com");
  const luke = (await andrew("POST", "/bots", { name: "Luke", model: "env::mock-model" })).json;
  const ivy = (await marija("POST", "/bots", { name: "Ivy", model: "env::mock-model" })).json;
  const me = (await marija("GET", "/me")).json.me;
  return { ...env, andrew, marija, luke, ivy, marijaId: me.id as string };
}

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("the family", () => {
  test("the first login is the host's; anyone else is family straight away", async () => {
    const { as } = setup();
    expect((await as("andrew@example.com")("GET", "/me")).json.me).toMatchObject({ id: "owner", role: "host", name: "Andrew" });
    // This PC (no login) is the host too.
    expect((await as(null)("GET", "/me")).json.me.id).toBe("owner");
    expect((await as("marija.k@example.com")("GET", "/me")).json.me).toMatchObject({ role: "family", name: "Marija" });
    expect((await as("marija.k@example.com")("GET", "/state")).status).toBe(200);
  });

  test("everyone's Bots are their own: nobody else sees them, their chats or their routines", async () => {
    const { andrew, marija, luke, ivy, store } = await family();
    expect(luke.ownerId).toBe("owner");
    const andrewSees = (await andrew("GET", "/state")).json;
    const marijaSees = (await marija("GET", "/state")).json;
    expect(andrewSees.bots.map((bot: { name: string }) => bot.name)).toEqual(["Luke"]);
    expect(marijaSees.bots.map((bot: { name: string }) => bot.name)).toEqual(["Ivy"]);
    expect(marijaSees.chats.map((chat: { id: string }) => chat.id)).toEqual([ivy.chatId]);
    // Not even the host can read or drive someone else's Bot.
    expect((await andrew("GET", `/chats/${ivy.chatId}/messages`)).status).toBe(403);
    expect((await andrew("POST", `/chats/${ivy.chatId}/messages`, { text: "hi" })).status).toBe(403);
    expect((await andrew("PATCH", `/bots/${ivy.id}`, { name: "Mine" })).status).toBe(403);
    expect((await marija("POST", `/bots/${luke.id}/routines`, { title: "x", prompt: "y", schedule: { type: "interval", minutes: 60 } })).status).toBe(403);
    // Server settings stay the host's.
    expect((await marija("PUT", "/settings/default-model", { model: "env::mock-model" })).status).toBe(403);
    await until(() => store.listMessages(ivy.chatId).length > 0);
  });

  test("a shared topic: each person brings their own Bots, and the Bot hears who's talking", async () => {
    const { store, andrew, marija, luke, ivy, marijaId } = await family();
    writeAbout(marijaId, "- Vegetarian. Likes window seats.");
    const trip = (await andrew("POST", "/topics", { title: "Trip to Skopje", icon: "plane", memberIds: [luke.id] })).json;
    // You can only bring in your own Bots.
    expect((await andrew("POST", "/topics", { title: "Sneaky", icon: "plane", memberIds: [ivy.id] })).status).toBe(400);
    await andrew("PATCH", `/chats/${trip.id}`, { peopleIds: [marijaId] });
    expect((await marija("GET", "/state")).json.chats.map((chat: { title: string }) => chat.title)).toContain("Trip to Skopje");
    // Marija adds Ivy; she can't rename Andrew's topic or remove Luke.
    expect((await marija("PATCH", `/chats/${trip.id}`, { memberIds: [luke.id, ivy.id] })).status).toBe(200);
    expect((await marija("PATCH", `/chats/${trip.id}`, { title: "Mine now" })).status).toBe(403);
    expect((await marija("PATCH", `/chats/${trip.id}`, { memberIds: [ivy.id] })).status).toBe(400);
    // Now each sees the other's Bot, read-only.
    expect((await marija("GET", "/state")).json.bots.map((bot: { name: string }) => bot.name).sort()).toEqual(["Ivy", "Luke"]);

    // With no @mention, your own Bot answers you; Andrew's Bot answers Andrew.
    expect((await marija("POST", `/chats/${trip.id}/messages`, { text: "Hi" })).json.replies).toHaveLength(1);
    await until(() => store.listMessages(trip.id).find((message) => message.author === ivy.id && message.status === "done"));
    expect(store.listMessages(trip.id).some((message) => message.author === luke.id)).toBe(false);

    prompts.length = 0;
    const sent = await marija("POST", `/chats/${trip.id}/messages`, { text: "@Ivy can we fly Thursday?" });
    expect(sent.json.message.author).toBe(`person:${marijaId}`);
    await until(() => store.listMessages(trip.id).filter((message) => message.author === ivy.id && message.status === "done").length === 2 && prompts.length);
    const prompt = prompts.at(-1)!;
    expect(prompt.messages).toContain("[Marija]: @Ivy can we fly Thursday?");
    expect(prompt.system).toContain("This topic is shared: Andrew (who runs Colony), Marija.");
    expect(prompt.system).toContain("Vegetarian. Likes window seats.");
  });

  test("@Name for a person keeps the Bots quiet unless one is named too", async () => {
    const { andrew, luke, marijaId } = await family();
    const trip = (await andrew("POST", "/topics", { title: "Trip", icon: "plane", memberIds: [luke.id] })).json;
    await andrew("PATCH", `/chats/${trip.id}`, { everyone: true });
    expect((await andrew("POST", `/chats/${trip.id}/messages`, { text: "@Marija are you free Thursday?" })).json.replies).toEqual([]);
    expect((await andrew("POST", `/chats/${trip.id}/messages`, { text: "@Marija Thursday works. Luke, can you check flights?" })).json.replies).toHaveLength(1);
    expect(marijaId).toBeTruthy();
  });

  test("events reach only the people they're about", async () => {
    const { store, luke, ivy, marijaId } = await family();
    const marija = store.getPerson(marijaId)!;
    const host = store.getPerson("owner")!;
    const message = store.createMessage({ chatId: luke.chatId, author: "user", text: "private" });
    expect(eventFor(marija, { type: "message.upserted", message }, store)).toBeNull();
    expect(eventFor(host, { type: "chat.upserted", chat: store.getChat(ivy.chatId)! }, store)).toEqual({ type: "chat.deleted", chatId: ivy.chatId });
    expect(eventFor(host, { type: "bot.upserted", bot: store.getBot(ivy.id)! }, store)).toEqual({ type: "bot.deleted", botId: ivy.id });
    expect(eventFor(marija, { type: "bot.upserted", bot: store.getBot(ivy.id)! }, store)).not.toBeNull();
    expect(eventFor(marija, { type: "computer.output", botId: luke.id, text: "ls" }, store)).toBeNull();
  });
});
