import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

/*
 * Members' models and money: their Bots run on the members' OpenCode Zen provider (the admin's
 * members' key, never the admin's sign-ins), only on the models the admin allows, and stop taking
 * new turns once a month's spending reaches the cap the admin set. The admin is unaffected.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-members-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_DEV_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_DEV_MODELS = "mock-model";

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { PiRunner } = await import("./agent/pi/runner.js");
const { MemoryStorage } = await import("@earendil-works/pi-durable");
const { scriptedModels, textTurn } = await import("./agent/pi/testkit.js");
const { coreTools } = await import("./agent/tools.js");
const { createApi } = await import("./api.js");
const { resolver } = await import("./access.js");
const { People } = await import("./people.js");
const { ColonyModels } = await import("./agent/pi/models.js");
const { FileCredentialStore } = await import("./credentials.js");
const { monthStart, spendLimitProblem } = await import("./spending.js");
const { builtInPrice, costMicros } = await import("./prices.js");
const settings = await import("./settings.js");
settings.loadSettings();
type IdentitySource = import("./access.js").IdentitySource;
type ModelSource = import("./agent/pi/models.js").ModelSource;

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const FREE = "deepseek-v4.1-flash-free";
const FREE_REF = `opencode-members::${FREE}`;

/** The scripted model, recording which provider and model each turn was given. */
const scripted = scriptedModels();
const targets: string[] = [];
const source: ModelSource = {
  models: scripted.source.models,
  ref: (target) => { targets.push(`${target.provider.id}::${target.model}`); return { provider: "faux", modelId: "mock-model" }; },
};

const testSource: IdentitySource = {
  name: "test",
  claim: async (header) => {
    const who = header("X-Person");
    if (!who) return { kind: "refused", reason: "Who are you?" };
    return who === "admin" ? { kind: "admin" } : { kind: "email", email: `${who}@example.com` };
  },
};

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = await PiRunner.open(store, events, gate, () => ({ ...coreTools }), { storage: new MemoryStorage(), models: source });
  const people = new People(store, { adminEmails: [] });
  const alice = (people.byEmail("alice@example.com") as { id: string }).id;
  const api = createApi({ store, events, gate, runner, access: resolver([testSource], people) });
  const call = async (who: string, method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "X-Person": who, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    return { status: response.status, json: json as any };
  };
  /** The last reply in a chat, once it's finished. */
  const reply = (chatId: string) => until(() => { const last = store.listMessages(chatId).filter((message) => message.author !== "user" && message.author !== "system").at(-1); return last && last.status !== "streaming" && last; });
  return { db, store, runner, alice, call, reply };
}

beforeEach(() => {
  targets.length = 0;
  scripted.play([textTurn("Hello!")]);
  settings.setMemberPolicy({ models: [FREE], defaultModel: FREE, defaultCap: null });
  settings.setMemberKeyStatus("abcd");
});

describe("members' models", () => {
  test("a member's Bots run on the members' provider and its default model; the admin's on the admin's", async () => {
    const { store, alice, call, reply } = await setup();
    const ana = (await call("alice", "POST", "/bots", { name: "Ana" })).json;
    expect(ana.model).toBe(FREE_REF);
    expect(await reply(ana.chatId)).toMatchObject({ status: "done", text: "Hello!" });
    expect(new Set(targets)).toEqual(new Set([FREE_REF]));
    // What it used is priced at OpenCode Zen's own catalog price (free: $0, not unpriced), and counted as hers.
    expect(store.listUsage(0, alice).map((row) => [row.providerId, row.model, row.costMicros])).toEqual([["opencode-members", FREE, 0]]);

    targets.length = 0;
    const max = (await call("admin", "POST", "/bots", { name: "Max" })).json;
    expect(max.model).toBe("dev::mock-model");
    await reply(max.chatId);
    expect(new Set(targets)).toEqual(new Set(["dev::mock-model"]));
  });

  test("a member may only pick an allowed model, at create, at update and when a turn runs", async () => {
    const { store, call, reply } = await setup();
    for (const model of ["dev::mock-model", `opencode::${FREE}`, "opencode-go::muse-spark-1.3-contributor", "opencode-members::glm-5.3"]) {
      expect((await call("alice", "POST", "/bots", { name: "Nope", model })).status, model).toBe(400);
    }
    const ana = (await call("alice", "POST", "/bots", { name: "Ana", model: FREE_REF })).json;
    await reply(ana.chatId);
    expect((await call("alice", "PATCH", `/bots/${ana.id}`, { model: "dev::mock-model" })).status).toBe(400);
    expect((await call("alice", "PATCH", `/bots/${ana.id}`, { model: FREE_REF })).status).toBe(200);
    // A ref from before members moved to Zen still names the members' provider.
    expect((await call("alice", "PATCH", `/bots/${ana.id}`, { model: `opencode-go-members::${FREE}` })).json.model).toBe(FREE_REF);
    expect(settings.resolveModelFor({ id: "x", role: "member" }, "dev::mock-model", { fallback: false })).toBeNull();

    // A model that slipped in some other way doesn't run: no fallback to anything else.
    store.updateBot(ana.id, { model: "dev::mock-model" });
    targets.length = 0;
    expect((await call("alice", "POST", `/chats/${ana.chatId}/messages`, { text: "Hi" })).status).toBe(201);
    expect(await reply(ana.chatId)).toMatchObject({ status: "failed", error: "mock-model isn't one of the models members may use. Pick another in this Bot's profile." });
    expect(targets).toEqual([]);

    // The admin narrows what members may use: a Bot left on a removed model stops too.
    store.updateBot(ana.id, { model: FREE_REF });
    expect((await call("admin", "PUT", "/settings/members", { models: ["glm-5.3"], defaultModel: "glm-5.3" })).status).toBe(200);
    await call("alice", "POST", `/chats/${ana.chatId}/messages`, { text: "Hi again" });
    expect((await reply(ana.chatId)).error).toMatch(/isn't one of the models members may use/);
    expect(targets).toEqual([]);
    expect((await call("alice", "GET", "/state")).json.models.map((model: { ref: string }) => model.ref)).toEqual(["opencode-members::glm-5.3"]);
    // Only OpenCode Zen's own models (not Go's), and a default from the allowed ones.
    expect((await call("admin", "PUT", "/settings/members", { models: ["not-a-model"] })).status).toBe(400);
    expect((await call("admin", "PUT", "/settings/members", { models: ["muse-spark-1.3-contributor"] })).json.error).toBe("OpenCode Zen doesn't offer muse-spark-1.3-contributor.");
    expect((await call("admin", "PUT", "/settings/members", { defaultModel: FREE })).status).toBe(400);
  });

  test("defaults to exactly deepseek-v4.1-flash-free on Zen, and the admin's own models don't change", async () => {
    const { call } = await setup();
    const admin = (await call("admin", "GET", "/settings")).json;
    expect(admin.members).toMatchObject({ models: [FREE], defaultModel: FREE, defaultCap: null, keySet: true, prices: { [FREE]: { input: 0, output: 0, cached: 0 } } });
    expect(admin.members.catalog.map((model: { id: string }) => model.id)).toContain(FREE);
    expect(admin.members.catalog.map((model: { id: string }) => model.id)).not.toContain("muse-spark-1.3-contributor");
    expect(admin.defaultModel).toBe("dev::mock-model");
    expect((await call("admin", "GET", "/state")).json.models.map((model: { ref: string }) => model.ref)).toEqual(["dev::mock-model"]);
    expect((await call("alice", "GET", "/settings")).json).toMatchObject({ models: [{ ref: FREE_REF, providerName: "OpenCode Zen" }], defaultModel: FREE_REF, configured: true });
    // The admin can't run on the members' provider either.
    expect(settings.resolveModel(FREE_REF, { fallback: false })).toBeNull();
  });

  test("models the catalog lists as free cost $0; priced ones cost their list price; unlisted ones keep the built-in price", () => {
    const members = settings.memberProvider();
    expect(settings.priceOf(members, FREE)).toEqual({ input: 0, output: 0, cached: 0 });
    expect(settings.priceOf(members, "glm-5.3")).toEqual({ input: 1.4, output: 4.4, cached: 0.26 });
    expect(settings.priceOf(members, "deepseek-unlisted")).toEqual(builtInPrice("deepseek-unlisted"));
    expect(builtInPrice(FREE)).not.toBeNull(); // What it used to fall back to.
    expect(costMicros({ input: 50_000, cached: 10_000, output: 5_000 }, settings.priceOf(members, FREE))).toBe(0);
    // The admin's providers too: free is $0 unless the admin set a price; the rest keep the built-in table.
    const zen = settings.providerById("opencode")!;
    expect(settings.priceOf(zen, FREE)).toEqual({ input: 0, output: 0, cached: 0 });
    expect(settings.priceOf({ ...zen, prices: { [FREE]: { input: 1, output: 2 } } }, FREE)).toEqual({ input: 1, output: 2 });
    expect(settings.priceOf(zen, "glm-5.3")).toEqual(builtInPrice("glm-5.3"));
    expect(settings.priceOf(settings.providerById("opencode-go")!, "deepseek-v4.1-flash")).toEqual(builtInPrice("deepseek-v4.1-flash"));
  });

  test("with no members' key, members get a clear error and nothing falls back to the admin's sign-in", async () => {
    settings.setMemberKeyStatus(false);
    const { call, reply } = await setup();
    const ana = (await call("alice", "POST", "/bots", { name: "Ana" })).json;
    expect(await reply(ana.chatId)).toMatchObject({ status: "failed", error: settings.NO_MEMBER_MODELS });
    expect((await call("alice", "POST", `/chats/${ana.chatId}/messages`, { text: "Hi" })).json).toEqual({ error: "Your Colony admin hasn't set up models for members yet." });
    expect((await call("alice", "GET", "/state")).json.configured).toBe(false);
    expect(targets).toEqual([]);
    // The admin's Bots carry on.
    const max = (await call("admin", "POST", "/bots", { name: "Max" })).json;
    expect(await reply(max.chatId)).toMatchObject({ status: "done" });
  });

  test("the members' provider authenticates only with the members' key: not the admin's sign-in, not OPENCODE_API_KEY", async () => {
    const file = path.join(dataDir, "creds", "credentials.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The admin's OpenCode sign-in, and a key in the environment.
    fs.writeFileSync(file, JSON.stringify({ opencode: { type: "oauth", access: "admins-access", refresh: "admins-refresh", expires: Date.now() + 3_600_000 } }));
    process.env.OPENCODE_API_KEY = "sk-from-the-environment";
    const models = new ColonyModels({ credentials: new FileCredentialStore(file) });
    try {
      expect(settings.memberKeyStatus()).toEqual({ set: false, hint: null });
      expect(await models.models.getAuth("opencode-members")).toBeUndefined();
      expect(models.models.getProvider("opencode-go-members")).toBeUndefined();
      // pi-ai's Zen model as it is (its address and API), at Colony's own (zero) cost.
      expect(models.models.getProvider("opencode-members")?.getModels().map((model) => [model.id, model.baseUrl, model.api])).toEqual([[FREE, "https://opencode.ai/inference/v1", "openai-completions"]]);
      await models.setMemberKey("sk-members-key-WXYZ");
      expect(settings.memberKeyStatus()).toEqual({ set: true, hint: "WXYZ" });
      expect((await models.models.getAuth("opencode-members"))?.auth).toMatchObject({ apiKey: "sk-members-key-WXYZ" });
      // Stored under its own id, beside (and separate from) the admin's sign-in, readable only by Colony.
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(saved["opencode-key"]).toEqual({ type: "api_key", key: "sk-members-key-WXYZ" });
      expect(saved.opencode.access).toBe("admins-access");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      await models.clearMemberKey();
      expect(settings.memberKeyStatus().set).toBe(false);
      expect(await models.models.getAuth("opencode-members")).toBeUndefined();
    } finally {
      delete process.env.OPENCODE_API_KEY;
      models.close();
    }
  });
});

describe("members' monthly spending caps", () => {
  const spend = (store: InstanceType<typeof Store>, botId: string, dollars: number, at: number) =>
    store.recordUsage({ botId, providerId: "opencode-members", model: "glm-5.3", inputTokens: 1000, outputTokens: 100, cachedTokens: 0, costMicros: Math.round(dollars * 1_000_000) }, at);

  test("months are America/Chicago's", () => {
    // Oct 31, 22:00 in Chicago is already November in UTC.
    expect(monthStart(Date.UTC(2026, 10, 1, 3))).toBe(Date.UTC(2026, 9, 1, 5));
    expect(monthStart(Date.UTC(2026, 10, 1, 6))).toBe(Date.UTC(2026, 10, 1, 5));
    // After daylight saving time ends, midnight is 06:00 UTC.
    expect(monthStart(Date.UTC(2026, 11, 15))).toBe(Date.UTC(2026, 11, 1, 6));
  });

  test("no cap by default; below it turns run, at or above it they wait; a new month starts over", async () => {
    const { store, alice, call } = await setup();
    const ana = store.createBot({ name: "Ana", title: "", description: "", model: FREE_REF, computer: false, ownerId: alice });
    const member = { id: alice, role: "member" as const };
    const october = Date.UTC(2026, 9, 20, 17);
    spend(store, ana.id, 4, Date.UTC(2026, 9, 15, 17));
    expect(spendLimitProblem(store, member, october)).toBeNull(); // No cap set.
    expect((await call("admin", "GET", "/people")).json.find((person: { id: string }) => person.id === alice)).toMatchObject({ cap: null, capOwn: false });

    expect((await call("admin", "PUT", `/people/${alice}`, { cap: 5 })).json).toMatchObject({ cap: 5, capOwn: true });
    expect(spendLimitProblem(store, member, october)).toBeNull(); // $4 of $5.
    spend(store, ana.id, 1, Date.UTC(2026, 9, 16, 17));
    expect(spendLimitProblem(store, member, october)).toMatch(/You've reached your \$5\.00 spending limit for October \(\$5\.00 spent\)/); // At it.
    spend(store, ana.id, 2, Date.UTC(2026, 9, 17, 17));
    expect(spendLimitProblem(store, member, october)).toMatch(/\$7\.00 spent/); // Above it.
    // Halloween night in Chicago is still October; an hour past midnight is November.
    expect(spendLimitProblem(store, member, Date.UTC(2026, 10, 1, 3))).not.toBeNull();
    expect(spendLimitProblem(store, member, Date.UTC(2026, 10, 1, 6))).toBeNull();
  });

  test("at the cap, new turns are refused with a clear message, and members see their spending and cap", async () => {
    const { store, alice, call, runner, reply } = await setup();
    const ana = (await call("alice", "POST", "/bots", { name: "Ana" })).json;
    await reply(ana.chatId);
    await call("admin", "PUT", `/people/${alice}`, { cap: 1 });
    spend(store, ana.id, 1.25, Date.now());
    const sent = await call("alice", "POST", `/chats/${ana.chatId}/messages`, { text: "One more?" });
    expect(sent.status).toBe(402);
    expect(sent.json.error).toMatch(/^You've reached your \$1\.00 spending limit/);
    // Turns that start on their own (routines, other Bots) stop too.
    targets.length = 0;
    runner.start(ana.chatId, ana.id, { hiddenPrompt: "Routine" });
    expect((await reply(ana.chatId)).error).toMatch(/spending limit/);
    expect(targets).toEqual([]);
    expect((await call("alice", "GET", "/spending")).json).toMatchObject({ cap: 1 });
    expect((await call("alice", "GET", "/spending")).json.total).toBeCloseTo(1.25);
    const view = (await call("alice", "GET", "/settings")).json;
    expect(view.cap).toBe(1);
    expect(view.spent).toBeCloseTo(1.25);
    // Raising it lets them go on.
    await call("admin", "PUT", `/people/${alice}`, { cap: 10 });
    expect((await call("alice", "POST", `/chats/${ana.chatId}/messages`, { text: "Now?" })).status).toBe(201);
  });

  test("the default cap covers members without their own; the admin never has one", async () => {
    const { store, alice, call, reply } = await setup();
    const member = { id: alice, role: "member" as const };
    const ana = (await call("alice", "POST", "/bots", { name: "Ana" })).json;
    await reply(ana.chatId);
    spend(store, ana.id, 3, Date.now());
    await call("admin", "PUT", "/settings/members", { defaultCap: 2 });
    expect(spendLimitProblem(store, member)).toMatch(/\$2\.00 spending limit/);
    await call("admin", "PUT", `/people/${alice}`, { cap: null });
    expect(spendLimitProblem(store, member)).toBeNull(); // Her own: no cap.
    await call("admin", "PUT", `/people/${alice}`, { cap: "default" });
    expect(spendLimitProblem(store, member)).not.toBeNull();
    // The admin: spending as much as they like, never stopped.
    const max = (await call("admin", "POST", "/bots", { name: "Max" })).json;
    await reply(max.chatId);
    spend(store, max.id, 1000, Date.now());
    expect(spendLimitProblem(store, { id: "owner", role: "admin" })).toBeNull();
    expect((await call("admin", "POST", `/chats/${max.chatId}/messages`, { text: "Go" })).status).toBe(201);
    expect((await call("admin", "PUT", "/people/owner", { cap: 1 })).status).toBe(404);
    expect((await call("admin", "GET", "/people")).json[0]).toMatchObject({ id: "owner", role: "admin", cap: null });
  });
});

describe("People", () => {
  test("the admin sees each member's spending, cap and computers; turns a member off and back on", async () => {
    const { store, alice, call, runner, reply } = await setup();
    const ana = (await call("alice", "POST", "/bots", { name: "Ana", computer: true })).json;
    await reply(ana.chatId);
    store.setComputerState(ana.id, "on");
    const people = (await call("admin", "GET", "/people")).json;
    expect(people.map((person: { role: string }) => person.role)).toEqual(["admin", "member"]);
    expect(people[1]).toMatchObject({ id: alice, login: "alice@example.com", bots: 1, computers: 1, cap: null, disabled: false });

    expect((await call("admin", "PUT", `/people/${alice}`, { disabled: true })).json).toMatchObject({ disabled: true });
    expect((await call("alice", "GET", "/state")).status).toBe(403);
    runner.start(ana.chatId, ana.id, { hiddenPrompt: "Routine" });
    expect((await reply(ana.chatId)).error).toMatch(/turned off/);
    await call("admin", "PUT", `/people/${alice}`, { disabled: false });
    expect((await call("alice", "GET", "/state")).status).toBe(200);
  });

  test("removing a member removes only their things; the admin can't be removed", async () => {
    const { store, alice, call, reply } = await setup();
    const ana = (await call("alice", "POST", "/bots", { name: "Ana" })).json;
    const max = (await call("admin", "POST", "/bots", { name: "Max" })).json;
    await reply(ana.chatId);
    await reply(max.chatId);
    await call("alice", "PUT", "/me/about", { text: "- Alice's notes" });
    await call("admin", "PUT", "/me/about", { text: "- The admin's notes" });
    const adminBefore = JSON.stringify([store.listBots("owner"), store.listChats("owner").map(({ updatedAt: _, ...chat }) => chat), store.listMessages(max.chatId)]);
    expect((await call("admin", "DELETE", `/people/${alice}?data=delete`)).status).toBe(204);
    expect(store.getPerson(alice)).toBeNull();
    expect(store.listBots(alice)).toEqual([]);
    expect(store.listChats(alice)).toEqual([]);
    expect(store.listUsage(0, alice)).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "people", alice))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "bots", ana.id))).toBe(false);
    expect(JSON.stringify([store.listBots("owner"), store.listChats("owner").map(({ updatedAt: _, ...chat }) => chat), store.listMessages(max.chatId)])).toBe(adminBefore);
    expect(fs.readFileSync(path.join(dataDir, "USER.md"), "utf8")).toContain("The admin's notes");
    expect((await call("admin", "DELETE", "/people/owner")).status).toBe(404);
    expect(() => store.removePerson("owner")).toThrow();
    // Members can't see or change people.
    expect((await call("bob", "GET", "/people")).status).toBe(403);
  });
});
