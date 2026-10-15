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
  const bot = store.createBot({ name: "Luke", title: "", description: "", model: "env::mock-model", computer: false });
  return { store, events, runner, bot, as };
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

describe("people", () => {
  test("the first login is the owner's; a new one waits until the owner adds it", async () => {
    const { as } = setup();
    const andrew = as("andrew@example.com");
    expect((await andrew("GET", "/me")).json.me).toMatchObject({ id: "owner", role: "owner", name: "Andrew", login: "andrew@example.com" });
    // This PC (no login) is the owner too.
    expect((await as(null)("GET", "/me")).json.me.id).toBe("owner");

    const marija = as("marija.k@example.com");
    expect((await marija("GET", "/me")).json.me).toMatchObject({ role: "pending", name: "Marija" });
    expect(await marija("GET", "/state")).toMatchObject({ status: 403, json: { pending: true } });
    const pending = (await andrew("GET", "/state")).json.people.find((person: { role: string }) => person.role === "pending");
    expect(pending.login).toBe("marija.k@example.com");

    await andrew("PATCH", `/people/${pending.id}`, { role: "member" });
    expect((await marija("GET", "/state")).status).toBe(200);
    // Settings, accounts and Bots stay the owner's.
    expect((await marija("GET", "/settings")).status).toBe(403);
    expect((await marija("POST", "/bots", { name: "Mine" })).status).toBe(403);
  });

  test("members see only the topics shared with them, and talk to its Bot by name", async () => {
    const { store, bot, as } = setup();
    const andrew = as("andrew@example.com");
    await andrew("GET", "/me");
    const marija = as("marija@example.com");
    const me = (await marija("GET", "/me")).json.me;
    await andrew("PATCH", `/people/${me.id}`, { role: "member" });
    writeAbout(me.id, "- Vegetarian. Likes window seats.");

    const trip = store.createChat({ kind: "topic", title: "Trip to Skopje", memberIds: [bot.id], coordinatorId: bot.id, icon: "plane" });
    const secret = store.createChat({ kind: "topic", title: "Birthday present", memberIds: [bot.id], coordinatorId: bot.id, icon: "gift" });
    await andrew("PATCH", `/chats/${trip.id}`, { peopleIds: [me.id] });

    const state = (await marija("GET", "/state")).json;
    expect(state.chats.map((chat: { title: string }) => chat.title)).toEqual(["Trip to Skopje"]);
    expect(state.bots.map((item: { name: string }) => item.name)).toEqual(["Luke"]);
    expect((await marija("GET", `/chats/${secret.id}/messages`)).status).toBe(403);
    expect((await marija("GET", `/chats/${bot.chatId}/messages`)).status).toBe(403);

    prompts.length = 0;
    const sent = await marija("POST", `/chats/${trip.id}/messages`, { text: "Can we fly Thursday?" });
    expect(sent.json.message.author).toBe(`person:${me.id}`);
    await until(() => store.listMessages(trip.id).find((message) => message.author === bot.id && message.status === "done"));
    expect(prompts[0].messages).toContain("[Marija]: Can we fly Thursday?");
    expect(prompts[0].system).toContain("This topic is shared: Andrew (who runs Colony), Marija.");
    expect(prompts[0].system).toContain("The latest message is from Marija.");
    expect(prompts[0].system).toContain("Vegetarian. Likes window seats.");
  });

  test("@Name for another person is between people: the Bot stays quiet", async () => {
    const { store, bot, as } = setup();
    const andrew = as("andrew@example.com");
    await andrew("GET", "/me");
    const me = (await as("marija@example.com")("GET", "/me")).json.me;
    await andrew("PATCH", `/people/${me.id}`, { role: "member" });
    const trip = store.createChat({ kind: "topic", title: "Trip", memberIds: [bot.id], coordinatorId: bot.id, icon: "plane" });
    await andrew("PATCH", `/chats/${trip.id}`, { everyone: true });
    const sent = await andrew("POST", `/chats/${trip.id}/messages`, { text: "@Marija are you free Thursday?" });
    expect(sent.json.replies).toEqual([]);
    // Naming the Bot too brings it in.
    const both = await andrew("POST", `/chats/${trip.id}/messages`, { text: "@Marija Thursday works. Luke, can you check the 9am flight?" });
    expect(both.json.replies).toHaveLength(1);
  });

  test("members only hear events about topics shared with them", () => {
    const { store, bot } = setup();
    const member = store.addPerson({ login: "m@example.com", name: "M", color: "#7CC4FA", role: "member" });
    const shared = store.createChat({ kind: "topic", title: "Shared", memberIds: [bot.id], coordinatorId: bot.id });
    store.updateTopic(shared.id, { peopleIds: [member.id] });
    const message = store.createMessage({ chatId: bot.chatId, author: "user", text: "private" });
    expect(eventFor(member, { type: "message.upserted", message }, store)).toBeNull();
    expect(eventFor(member, { type: "chat.upserted", chat: store.getChat(bot.chatId)! }, store)).toEqual({ type: "chat.deleted", chatId: bot.chatId });
    expect(eventFor(member, { type: "chat.upserted", chat: store.getChat(shared.id)! }, store)).not.toBeNull();
    expect(eventFor(member, { type: "settings.updated", models: [], defaultModel: "", configured: true }, store)).toBeNull();
  });
});
