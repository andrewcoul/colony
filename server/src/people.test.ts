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
  const told: { title: string; body: string; personId: string }[] = [];
  const runner = new AgentRunner(store, events, gate, () => coreTools, () => model, undefined, { notify: (notification, personId) => told.push({ ...notification, personId }) });
  const api = createApi({ store, events, gate, runner });
  const as = (login: string | null) => async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (login) headers["Tailscale-User-Login"] = login;
    const response = await api.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    return { status: response.status, json: json as any };
  };
  return { store, events, runner, as, told };
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
  test("everyone can bring their own model key; only their Bots use it, and the shared models stay the host's", async () => {
    const { andrew, marija, luke, ivy } = await family();
    const added = await marija("POST", "/settings/providers", { name: "Marija's OpenAI", baseURL: "http://marija.invalid/v1", apiKey: "sk-marija-000000000", models: ["gpt-own"] });
    expect(added.status).toBe(201);
    const own = added.json.providers.find((provider: { name: string }) => provider.name === "Marija's OpenAI");
    expect(own.ownerId).not.toBeNull();
    // Andrew doesn't see it, can't use it, can't change it.
    expect((await andrew("GET", "/settings")).json.providers.map((provider: { name: string }) => provider.name)).not.toContain("Marija's OpenAI");
    expect((await andrew("PATCH", `/bots/${luke.id}`, { model: `${own.id}::gpt-own` })).status).toBe(400);
    expect((await andrew("DELETE", `/settings/providers/${own.id}`)).status).toBe(403);
    // Marija's Bot can, and it becomes her default.
    expect((await marija("PATCH", `/bots/${ivy.id}`, { model: `${own.id}::gpt-own` })).json.model).toBe(`${own.id}::gpt-own`);
    expect((await marija("PUT", "/settings/default-model", { model: `${own.id}::gpt-own` })).json.defaultModel).toBe(`${own.id}::gpt-own`);
    expect((await andrew("GET", "/settings")).json.defaultModel).toBe("env::mock-model");
    // Shared models are added by the host only.
    expect((await marija("POST", "/settings/providers", { name: "Sneaky", baseURL: "http://x.invalid/v1", models: ["m"], shared: true })).status).toBe(403);
    await marija("DELETE", `/settings/providers/${own.id}`);
  });

  test("accounts are whoever connected them: only their Bots can use them", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const store = new Store(db, events);
    const gate = new ApprovalGate(store);
    const runner = new AgentRunner(store, events, gate, () => coreTools, () => model);
    const { Accounts } = await import("./integrations/accounts.js");
    const { Integrations } = await import("./integrations/index.js");
    const { Tokens } = await import("./integrations/oauth.js");
    const { Vaults } = await import("./integrations/onepassword.js");
    const accounts = new Accounts(db, events, path.join(dataDir, `accounts-${Math.random()}.json`));
    const vault = { vaults: async () => [{ id: "v1", title: "Family" }] } as never;
    const integrations = new Integrations(accounts, new Tokens(accounts), new Vaults(accounts, async () => vault));
    const api = createApi({ store, events, gate, runner, integrations, connectVault: async () => vault });
    const as = (login: string) => async (method: string, url: string, body?: unknown) => {
      const response = await api.request(url, { method, headers: { "Content-Type": "application/json", "Tailscale-User-Login": login }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, json: (response.headers.get("content-type")?.includes("json") ? await response.json() : null) as any };
    };
    const andrew = as("andrew@example.com");
    const marija = as("marija@example.com");
    const luke = (await andrew("POST", "/bots", { name: "Luke", model: "env::mock-model" })).json;
    const ivy = (await marija("POST", "/bots", { name: "Ivy", model: "env::mock-model" })).json;
    const vaultAccount = (await marija("POST", "/accounts/onepassword", { token: "ops_marija" })).json;
    expect(vaultAccount.personId).not.toBe("owner");
    // Only Marija sees it, and only her Bots can be given it.
    expect((await andrew("GET", "/accounts")).json.accounts).toEqual([]);
    expect((await marija("GET", "/accounts")).json.accounts.map((account: { id: string }) => account.id)).toEqual([vaultAccount.id]);
    expect((await andrew("PUT", `/bots/${luke.id}/access/${vaultAccount.id}`, { vault: "use" })).status).toBe(403);
    expect((await marija("PUT", `/bots/${ivy.id}/access/${vaultAccount.id}`, { vault: "use" })).status).toBe(200);
    expect((await andrew("DELETE", `/accounts/${vaultAccount.id}`)).status).toBe(403);
    expect((await andrew("GET", "/state")).json.accounts).toEqual([]);
  });

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
    // What the whole Colony shares stays the host's.
    expect((await marija("PUT", "/settings/voice", { providerId: null })).status).toBe(403);
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

  test("an approval goes to the person it's for: only they can answer, only their phone buzzes", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const store = new Store(db, events);
    const gate = new ApprovalGate(store);
    const runner = new AgentRunner(store, events, gate, () => coreTools, () => model);
    const { PushService } = await import("./push.js");
    const pushed: { endpoint: string; title: string; tag: string }[] = [];
    const push = new PushService(db, store, events, async (subscription, payload) => { pushed.push({ endpoint: subscription.endpoint, ...JSON.parse(String(payload)) }); return {} as never; });
    const api = createApi({ store, events, gate, runner, push });
    const as = (login: string) => async (method: string, url: string, body?: unknown) => {
      const response = await api.request(url, { method, headers: { "Content-Type": "application/json", "Tailscale-User-Login": login }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status };
    };
    const andrew = as("andrew@example.com");
    const marija = as("marija@example.com");
    await andrew("POST", "/push/subscribe", { endpoint: "https://push.example/andrew", keys: { p256dh: "k", auth: "a" } });
    await marija("POST", "/push/subscribe", { endpoint: "https://push.example/marija", keys: { p256dh: "k", auth: "a" } });
    const marijaId = store.listPeople().find((person) => person.name === "Marija")!.id;
    const luke = store.createBot({ name: "Luke", title: "", description: "", model: "env::mock-model", computer: false });
    const trip = store.createChat({ kind: "topic", title: "Trip", memberIds: [luke.id], coordinatorId: luke.id });
    store.updateTopic(trip.id, { peopleIds: [marijaId] });
    const message = store.createMessage({ chatId: trip.id, author: luke.id, text: "" });
    // Luke (Andrew's) wants to use something of Marija's.
    const answer = gate.request({ botId: luke.id, chatId: trip.id, messageId: message.id, tool: "pc_shell", summary: "Luke wants to use Marija's laptop", detail: "Run: lp boarding.pdf", reason: "", approverId: marijaId }, new AbortController().signal);
    const approval = await until(() => store.listApprovals("pending")[0]);
    expect(approval.approverId).toBe(marijaId);
    await until(() => pushed.some((item) => item.tag.startsWith("approval-")));
    expect(pushed.filter((item) => item.tag.startsWith("approval-")).map((item) => item.endpoint)).toEqual(["https://push.example/marija"]);
    expect((await andrew("POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(403);
    expect((await marija("POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(204);
    expect(await answer).toBe(true);
  });

  test("calls are on each person's terms: their Bots ring only them, never in their quiet hours", async () => {
    const { store, events, runner, andrew, marija, luke, ivy } = await family();
    const settings = await import("./settings.js");
    const { Calls } = await import("./voice.js");
    settings.setVoiceSettings({ providerId: "env", allowCalls: true, quietFrom: "22:00", quietTo: "07:00" });
    // Marija turns calls off for herself and picks Ivy's voice; she can't pick Luke's, or the provider.
    expect((await marija("PUT", "/settings/voice", { allowCalls: false, botVoices: { [ivy.id]: "nova" } })).json.voice).toMatchObject({ allowCalls: false });
    expect((await marija("PUT", "/settings/voice", { botVoices: { [luke.id]: "onyx" } })).status).toBe(403);
    expect((await andrew("GET", "/settings")).json.voice.allowCalls).toBe(true);
    const calls = new Calls(store, events, runner);
    const rang: string[] = [];
    calls.notify = (_input, personId) => rang.push(personId);
    const noon = new Date(2026, 9, 15, 12).getTime();
    expect(calls.ring(ivy.id, ivy.chatId, "Hi", noon).ringing).toBe(false);
    expect(calls.ring(luke.id, luke.chatId, "Hi", noon).ringing).toBe(true);
    expect(rang).toEqual(["owner"]);
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

describe("spending", () => {
  /** The shared model at $4,000 per million tokens in and $8,000 out: each reply here (10 in, 5 out) costs $0.08. */
  const pricey = { name: "Shared", baseURL: "http://model.invalid/v1", models: ["mock-model"], prices: { "mock-model": { input: 4_000, output: 8_000 } } };
  /** Marija says something to Ivy once Ivy is free, and gets Ivy's finished reply. */
  const sayer = (env: Awaited<ReturnType<typeof family>>) => async (text: string) => {
    const replies = () => env.store.listMessages(env.ivy.chatId).filter((message) => message.author === env.ivy.id);
    await until(() => !env.runner.isBotRunning(env.ivy.id) && replies().every((message) => message.status !== "streaming"));
    const before = replies().length;
    await env.marija("POST", `/chats/${env.ivy.chatId}/messages`, { text });
    return until(() => replies().length > before && !env.runner.isBotRunning(env.ivy.id) && replies().at(-1)!.status !== "streaming" && replies().at(-1)!);
  };

  test("every step counts against the Bot's owner and whoever's key paid; the host sees the shared keys", async () => {
    const env = await family();
    const { andrew, marija, ivy, marijaId } = env;
    const say = sayer(env);
    await until(() => !env.runner.isBotRunning(ivy.id));
    expect((await andrew("PUT", "/settings/providers/env", pricey)).status).toBe(200);
    expect((await andrew("GET", "/settings")).json.providers.find((provider: { id: string }) => provider.id === "env").prices["mock-model"]).toEqual({ input: 4_000, output: 8_000 });
    await say("Plan the week");

    const mine = (await marija("GET", "/spending")).json;
    expect(mine).toMatchObject({ own: 0, shared: 0.08, limit: null, hostName: "Andrew", bots: [{ botId: ivy.id, name: "Ivy", own: 0, shared: 0.08, tokens: 30 }], unpriced: ["mock-model"] });
    // (Ivy's hello ran before there was a price: its tokens count, at no cost.)
    expect(mine.days).toHaveLength(30);
    expect(mine.days.at(-1).shared).toBe(0.08);
    // Luke's hello is Andrew's, on the house.
    expect((await andrew("GET", "/spending")).json).toMatchObject({ own: 0, shared: 0, bots: [{ name: "Luke", shared: 0 }] });
    // Only the host sees the shared keys and sets limits.
    expect((await andrew("GET", "/spending/shared")).json.people.find((person: { personId: string }) => person.personId === marijaId)).toMatchObject({ cost: 0.08, limit: null, bots: [{ name: "Ivy", cost: 0.08 }] });
    expect((await marija("GET", "/spending/shared")).status).toBe(403);
    expect((await marija("PUT", `/spending/limits/${marijaId}`, { limit: 100 })).status).toBe(403);
    expect((await andrew("PUT", "/spending/limits/owner", { limit: 5 })).status).toBe(400);
  });

  test("over the limit: the turn stops before calling the model and both are told, until there's an own key", async () => {
    const env = await family();
    const { andrew, marija, marijaId, told } = env;
    const say = sayer(env);
    await until(() => !env.runner.isBotRunning(env.ivy.id));
    await andrew("PUT", "/settings/providers/env", pricey);
    // (Ivy's hello may already have cost something, depending on the prices other tests left.)
    const before = (await marija("GET", "/spending")).json.shared as number;
    expect((await andrew("PUT", `/spending/limits/${marijaId}`, { limit: before + 0.05 })).json.people.find((person: { personId: string }) => person.personId === marijaId).limit).toBe(before + 0.05);
    // The check is before each turn, so the first one goes over.
    expect(await say("One")).toMatchObject({ status: "done", error: null });
    const stopped = await say("Two");
    expect(stopped).toMatchObject({ status: "failed", error: expect.stringMatching(/^Your share of Andrew's keys is used up for \w+\. Add your own key in Settings to keep going\.$/) });
    expect((await marija("GET", "/spending")).json.shared).toBeCloseTo(before + 0.08);
    expect(told.map((item) => [item.personId, item.title])).toEqual([[marijaId, "Your share is used up"], ["owner", "Marija's share of your keys is used up"]]);

    // With a key of her own, Ivy goes on with it; that spending is Marija's own.
    await marija("POST", "/settings/providers", { name: "Marija's", baseURL: "http://marija.invalid/v1", apiKey: "sk-marija-000000000", models: ["gpt-own"] });
    const carried = await say("Three");
    expect(carried).toMatchObject({ status: "done", text: "On it." });
    const after = (await marija("GET", "/spending")).json;
    expect(after).toMatchObject({ own: 0, unpriced: expect.arrayContaining(["gpt-own"]), bots: [{ name: "Ivy", tokens: 45 }] });
    expect(after.shared).toBeCloseTo(before + 0.08);
    expect(told).toHaveLength(2);
    // Lifting the limit puts Ivy back on the shared model.
    await andrew("PUT", `/spending/limits/${marijaId}`, { limit: null });
    expect((await marija("GET", "/spending")).json.limit).toBeNull();
  });
});

describe("handing a Bot over", () => {
  test("nothing changes until the recipient accepts; either side can back out while it waits", async () => {
    const { andrew, marija, luke, ivy, marijaId } = await family();
    expect((await andrew("POST", `/bots/${ivy.id}/give`, { toId: marijaId })).status).toBe(403);
    expect((await andrew("POST", `/bots/${luke.id}/give`, { toId: "owner" })).status).toBe(400);
    const offer = (await andrew("POST", `/bots/${luke.id}/give`, { toId: marijaId })).json;
    expect(offer).toMatchObject({ botId: luke.id, fromId: "owner", toId: marijaId, keepMemory: true, status: "pending", bot: { name: "Luke" } });
    expect((await andrew("POST", `/bots/${luke.id}/give`, { toId: marijaId })).status).toBe(409);
    // Marija sees the offer (and Luke's name and face), not Luke himself yet.
    const state = (await marija("GET", "/state")).json;
    expect(state.transfers).toMatchObject([{ id: offer.id }]);
    expect(state.bots.map((bot: { name: string }) => bot.name)).toEqual(["Ivy"]);
    // Only Marija answers; only Andrew cancels.
    expect((await andrew("POST", `/transfers/${offer.id}/accept`)).status).toBe(403);
    expect((await marija("DELETE", `/transfers/${offer.id}`)).status).toBe(403);
    expect((await marija("POST", `/transfers/${offer.id}/decline`)).json.status).toBe("declined");
    expect((await marija("POST", `/transfers/${offer.id}/accept`)).status).toBe(409);
    const again = (await andrew("POST", `/bots/${luke.id}/give`, { toId: marijaId })).json;
    expect((await andrew("DELETE", `/transfers/${again.id}`)).json.status).toBe("cancelled");
    expect((await andrew("GET", "/state")).json.transfers).toEqual([]);
    expect((await andrew("PATCH", `/bots/${luke.id}`, { title: "Still mine" })).status).toBe(200);
  });

  test("accepting moves the Bot, its routines and (if chosen) a fresh memory; the giver keeps their chat, accounts and key", async () => {
    const { store, andrew, marija, luke, marijaId } = await family();
    const files = await import("./files.js");
    files.addEntry(luke.id, "memory", "Andrew takes coffee black");
    const routine = store.createRoutine({ botId: luke.id, chatId: luke.chatId, title: "Morning brief", prompt: "Brief me.", schedule: { type: "daily", time: "08:00", days: [] } });
    // Luke runs on a key of Andrew's own, and is in a private topic and a shared one.
    const own = (await andrew("POST", "/settings/providers", { name: "Andrew's own", baseURL: "http://andrew.invalid/v1", apiKey: "sk-andrew-000000000", models: ["gpt-andrew"], shared: false })).json.providers.find((provider: { name: string }) => provider.name === "Andrew's own");
    await andrew("PATCH", `/bots/${luke.id}`, { model: `${own.id}::gpt-andrew` });
    const secret = (await andrew("POST", "/topics", { title: "Birthday surprise", icon: "gift", memberIds: [luke.id] })).json;
    const trip = (await andrew("POST", "/topics", { title: "Trip to Skopje", icon: "plane", memberIds: [luke.id] })).json;
    await andrew("PATCH", `/chats/${trip.id}`, { peopleIds: [marijaId] });

    const offer = (await andrew("POST", `/bots/${luke.id}/give`, { toId: marijaId, keepMemory: false })).json;
    const { bot } = (await marija("POST", `/transfers/${offer.id}/accept`)).json;
    expect(bot).toMatchObject({ id: luke.id, ownerId: marijaId, model: "env::mock-model" });
    expect(bot.chatId).not.toBe(luke.chatId);
    expect(store.getRoutine(routine.id)?.chatId).toBe(bot.chatId);
    expect(files.readEntries(luke.id, "memory")).toEqual([]);
    // Luke is Marija's: she sees the new chat but not Andrew's history with him.
    const hers = (await marija("GET", "/state")).json;
    expect(hers.chats.map((chat: { id: string }) => chat.id)).toContain(bot.chatId);
    expect((await marija("GET", `/chats/${luke.chatId}/messages`)).status).toBe(403);
    expect((await marija("PATCH", `/bots/${luke.id}`, { title: "Travel agent" })).status).toBe(200);
    // Andrew keeps that history, archived, and can't drive Luke any more.
    const his = (await andrew("GET", "/state")).json;
    expect(his.chats.find((chat: { id: string }) => chat.id === luke.chatId)).toMatchObject({ kind: "topic", title: "Chat with Luke (now Marija's)", memberIds: [], archivedAt: expect.any(Number) });
    expect(his.bots.map((item: { name: string }) => item.name)).toContain("Luke");
    expect((await andrew("PATCH", `/bots/${luke.id}`, { title: "Mine" })).status).toBe(403);
    // Luke leaves the topic Marija can't see and stays in the one she shares.
    expect(store.getChat(secret.id)?.memberIds).toEqual([]);
    expect(store.getChat(trip.id)?.memberIds).toEqual([luke.id]);
    // What Luke costs from now on is Marija's.
    await marija("POST", `/chats/${bot.chatId}/messages`, { text: "Hello, Luke" });
    await until(() => store.listMessages(bot.chatId).find((message) => message.author === luke.id && message.status === "done"));
    expect(store.listUsage(0).at(-1)).toMatchObject({ botId: luke.id, ownerId: marijaId });
  });
});
