import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

/*
 * Separate accounts, route by route. Every API route and WebSocket upgrade is listed below with a
 * request that reaches it. For each one: other members and the admin get 404 on a member's things,
 * members get 403 on the admin's routes, and the owner gets through. A route the API serves that
 * isn't listed here fails the first test, so a new route can't skip these checks.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-isolation-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_DEV_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_DEV_MODELS = "mock-model";

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { createApi, routesOf } = await import("./api.js");
const { resolver } = await import("./access.js");
const { People, readAbout } = await import("./people.js");
const { PushService } = await import("./push.js");
const { ComputerService } = await import("./computer/docker.js");
const { authorizeUpgrade, UPGRADES } = await import("./upgrades.js");
const { coreTools } = await import("./agent/tools.js");
const { writeChatFile } = await import("./chatFiles.js");
const files = await import("./files.js");
const settings = await import("./settings.js");
const { ColonyModels } = await import("./agent/pi/models.js");
const { Invites } = await import("./invites.js");
const { Mailer } = await import("./mailer.js");
const { WebAccounts } = await import("./webauth.js");
settings.loadSettings();
/** The real credential store (data/credentials.json in this test's folder), for the members' key. */
const colonyModels = new ColonyModels();

type Runner = import("./agent/runner.js").Runner;
type Policy = import("./api.js").Policy;
type Upgrade = import("./upgrades.js").Upgrade;
type Calls = import("./voice.js").Calls;
type IdentitySource = import("./access.js").IdentitySource;
type ToolContext = import("./agent/tools.js").ToolContext;

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** Requests say who they are with X-Person (a test identity source: the admin, or a member's email). */
const testSource: IdentitySource = {
  name: "test",
  claim: async (header) => {
    const who = header("X-Person");
    if (!who) return { kind: "refused", reason: "Who are you?" };
    return who === "admin" ? { kind: "admin" } : { kind: "email", email: `${who}@example.com` };
  },
};

type Who = "admin" | "alice" | "bob";

/** One person's things: a Bot with a computer and every kind of thing it can have. */
function own(store: InstanceType<typeof Store>, ownerId: string, name: string, rings: Map<string, string>) {
  const bot = store.createBot({ name, title: "", description: "", model: "dev::mock-model", computer: true, ownerId });
  files.initBotFolder(bot);
  files.saveSkill(bot.id, "Skill", "A skill.", "Do it.");
  files.addEntry(bot, "memory", `${name} remembers`);
  const folder = store.createFolder(`${name}'s folder`, ownerId);
  const topic = store.createChat({ kind: "topic", title: `${name}'s topic`, memberIds: [bot.id], coordinatorId: bot.id, folderId: folder.id, ownerId });
  const message = store.createMessage({
    chatId: bot.chatId, author: bot.id, text: `Hi from ${name}`,
    cards: [{ type: "topic", proposalId: "p1", proposal: { title: "Idea", icon: "chat", brief: "", memberIds: [bot.id], folderId: null }, chatId: null, dismissed: false }],
  });
  const file = store.addFile({ chatId: topic.id, name: "notes.txt", mime: "text/plain", size: 5, addedBy: "user" });
  writeChatFile(file, new TextEncoder().encode("notes"));
  store.saveArtifact(topic.id, { body: `${name}'s doc`, note: "first", by: bot.id });
  const routine = store.createRoutine({ botId: bot.id, chatId: bot.chatId, title: "Brief", prompt: "Brief me.", schedule: { type: "interval", minutes: 60 } });
  const approval = store.createApproval({ botId: bot.id, chatId: bot.chatId, messageId: message.id, tool: "shell", summary: "s", detail: "d", reason: "r" });
  const callId = `call-${ownerId}`;
  rings.set(callId, ownerId);
  return { bot, folder, topic, message, file, routine, approval, callId };
}
type Things = ReturnType<typeof own>;

/** A Colony with the admin and two members, Alice and Bob, each owning one of everything. */
async function world() {
  // Members' models as a fresh Colony has them (routes above change them).
  settings.setMemberPolicy({ models: ["deepseek-v4.1-flash-free"], defaultModel: "deepseek-v4.1-flash-free", defaultCap: null });
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const people = new People(store, { adminEmails: [] });
  const ids: Record<Who, string> = {
    admin: "owner",
    alice: (people.byEmail("alice@example.com") as { id: string }).id,
    bob: (people.byEmail("bob@example.com") as { id: string }).id,
  };
  const started: string[] = [];
  const runner: Runner = {
    isRunning: () => false, stop: () => {}, deliver: () => false, steerNow: () => false, unqueue: () => false,
    isBotRunning: () => false, stopBot: () => {}, resumeAll: () => {},
    start: (chatId, botId) => { started.push(botId); return store.createMessage({ chatId, author: botId, text: "ok" }).id; },
    compact: async () => {}, startFresh: async () => {},
    branch: async (messageId) => {
      const message = store.getMessage(messageId)!;
      const chat = store.getChat(message.chatId)!;
      return store.createChat({ kind: "topic", title: "Branch", memberIds: [message.author], coordinatorId: message.author, ownerId: chat.ownerId }).id;
    },
  };
  const pushed: { endpoint: string; payload: string }[] = [];
  const push = new PushService(db, store, events, async (subscription, payload) => { pushed.push({ endpoint: subscription.endpoint, payload: String(payload) }); return {} as never; });
  // A computer service whose Docker has nothing running.
  const computer = new ComputerService(store, events, { docker: async () => ({ code: 1, stdout: "", stderr: "" }) });
  const rings = new Map<string, string>();
  const calls = { ownerOf: (id: string) => rings.get(id) ?? null, miss: (id: string) => { rings.delete(id); } } as unknown as Calls;
  const memberKey = { set: (key: string) => colonyModels.setMemberKey(key), clear: () => colonyModels.clearMemberKey() };
  // Web sign-in with a stand-in sign-in service, no email, and one pending invite.
  const invites = new Invites(db, 7);
  const { invite, token: inviteToken } = invites.create("invited@example.com");
  const webSessions = { emailFor: async () => null, revoke: async () => {}, deleteAccount: async () => {}, setUpAdmin: async () => {} };
  const web = { accounts: new WebAccounts(store, people, invites, webSessions), invites, mailer: new Mailer(null), origins: ["https://colony.example"] };
  const api = createApi({ store, events, gate, runner, push, computer, calls, memberKey, web, access: resolver([testSource], people) });
  const things: Record<Who, Things> = {
    admin: own(store, ids.admin, "Max", rings),
    alice: own(store, ids.alice, "Ana", rings),
    bob: own(store, ids.bob, "Bo", rings),
  };
  const call = async (who: Who, method: string, url: string, body?: unknown, signal?: AbortSignal) => {
    const form = body instanceof FormData;
    const response = await api.request(url, {
      method, signal,
      headers: { "X-Person": who, ...(body !== undefined && !form ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    const streaming = response.headers.get("content-type")?.includes("event-stream");
    if (streaming) { await response.body?.cancel(); return { status: response.status, json: null as any }; }
    const json = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    return { status: response.status, json: json as any };
  };
  return { db, events, store, gate, people, ids, api, things, call, pushed, push, rings, started, inviteId: invite.id, inviteToken };
}
type World = Awaited<ReturnType<typeof world>>;

/** Everything of one person's, to check nobody else's request changed any of it. */
function fingerprint(w: World, who: Who) {
  const id = w.ids[who];
  const t = w.things[who];
  const chats = w.store.listChats(id);
  return JSON.stringify({
    bots: w.store.listBots(id).map(({ presence: _, activity: __, ...bot }) => bot),
    chats: chats.map(({ updatedAt: _, ...chat }) => chat),
    messages: chats.map((chat) => w.store.listMessages(chat.id)),
    files: chats.map((chat) => w.store.listFiles(chat.id)),
    docs: chats.map((chat) => w.store.getArtifact(chat.id)),
    folders: w.store.listFolders(id),
    routines: w.store.routinesOf(id),
    approvals: w.store.approvalsFor(id),
    soul: files.readSoul(t.bot.id),
    memory: [files.readEntries(t.bot, "memory"), files.readEntries(t.bot, "user"), files.listSkills(t.bot.id)],
    about: readAbout(id),
    calls: w.rings.get(t.callId) ?? null,
  });
}

type Case = { url: (t: Things, w: World) => string; body?: (t: Things, w: World) => unknown };
const get = (url: Case["url"]): Case => ({ url });
const send = (url: Case["url"], body: Case["body"] = () => ({})): Case => ({ url, body });
const upload = () => { const form = new FormData(); form.append("file", new File(["hello"], "hello.txt", { type: "text/plain" })); return form; };

/** A request for every route, aimed at the owner's things (`t`). */
const CASES: Record<string, Case> = {
  "GET /state": get(() => "/state"),
  "GET /me": get(() => "/me"),
  "PUT /me/about": send(() => "/me/about", () => ({ text: "- Likes tea" })),
  "GET /system": get(() => "/system"),
  "POST /system/check": send(() => "/system/check"),
  "POST /system/update": send(() => "/system/update"),
  "POST /bots": send(() => "/bots", () => ({ name: "New" })),
  "PATCH /bots/:id": send((t) => `/bots/${t.bot.id}`, () => ({ title: "Renamed" })),
  "DELETE /bots/:id": send((t) => `/bots/${t.bot.id}`),
  "GET /bots/:id/terminal": get((t) => `/bots/${t.bot.id}/terminal`),
  "GET /bots/:id/files": get((t) => `/bots/${t.bot.id}/files`),
  "GET /bots/:id/file": get((t) => `/bots/${t.bot.id}/file?path=missing.txt`),
  "POST /bots/:id/computer/stop": send((t) => `/bots/${t.bot.id}/computer/stop`),
  "GET /bots/:id/screen-link": get((t) => `/bots/${t.bot.id}/screen-link`),
  "ALL /bots/:id/screen/*": get((t) => `/bots/${t.bot.id}/screen/index.html`),
  "GET /bots/:id/browser": get((t) => `/bots/${t.bot.id}/browser`),
  "POST /bots/:id/browser/open": send((t) => `/bots/${t.bot.id}/browser/open`),
  "POST /bots/:id/browser/input": send((t) => `/bots/${t.bot.id}/browser/input`, () => ({ type: "back" })),
  "GET /bots/:id/browser/live": get((t) => `/bots/${t.bot.id}/browser/live`),
  "GET /bots/:id/soul": get((t) => `/bots/${t.bot.id}/soul`),
  "PUT /bots/:id/soul": send((t) => `/bots/${t.bot.id}/soul`, () => ({ content: "# Changed" })),
  "GET /bots/:id/memory": get((t) => `/bots/${t.bot.id}/memory`),
  "POST /bots/:id/memory": send((t) => `/bots/${t.bot.id}/memory`, () => ({ target: "user", entry: "Has a cat" })),
  "POST /bots/:id/memory/remove": send((t) => `/bots/${t.bot.id}/memory/remove`, (t) => ({ target: "memory", entry: `${t.bot.name} remembers` })),
  "GET /bots/:id/skills/:slug": get((t) => `/bots/${t.bot.id}/skills/skill`),
  "DELETE /bots/:id/skills/:slug": send((t) => `/bots/${t.bot.id}/skills/skill`),
  "POST /topics": send(() => "/topics", (t) => ({ title: "Mine", memberIds: [t.bot.id] })),
  "PATCH /chats/:id": send((t) => `/chats/${t.topic.id}`, () => ({ title: "Renamed" })),
  "POST /folders": send(() => "/folders", () => ({ title: "New" })),
  "PATCH /folders/:id": send((t) => `/folders/${t.folder.id}`, () => ({ title: "Renamed" })),
  "DELETE /folders/:id": send((t) => `/folders/${t.folder.id}`),
  "POST /messages/:id/topics/:proposalId": send((t) => `/messages/${t.message.id}/topics/p1`, () => ({ accept: true })),
  "DELETE /chats/:id": send((t) => `/chats/${t.topic.id}`),
  "GET /chats/:id/messages": get((t) => `/chats/${t.bot.chatId}/messages`),
  "POST /chats/:id/messages": send((t) => `/chats/${t.bot.chatId}/messages`, () => ({ text: "Hello" })),
  "GET /chats/:id/artifact": get((t) => `/chats/${t.topic.id}/artifact`),
  "GET /chats/:id/artifact/versions/:version": get((t) => `/chats/${t.topic.id}/artifact/versions/1`),
  "POST /chats/:id/artifact/restore": send((t) => `/chats/${t.topic.id}/artifact/restore`, () => ({ version: 1 })),
  "GET /chats/:id/files": get((t) => `/chats/${t.topic.id}/files`),
  "POST /chats/:id/files": send((t) => `/chats/${t.topic.id}/files`, upload),
  "GET /files/:id": get((t) => `/files/${t.file.id}`),
  "DELETE /files/:id": send((t) => `/files/${t.file.id}`),
  "GET /img": get(() => "/img?u=http%3A%2F%2F127.0.0.1%2Fx.png"),
  "POST /messages/:id/branch": send((t) => `/messages/${t.message.id}/branch`, () => ({ title: "Branch" })),
  "POST /messages/:id/steer": send((t) => `/messages/${t.message.id}/steer`),
  "DELETE /messages/:id": send((t) => `/messages/${t.message.id}`),
  "POST /chats/:id/compact": send((t) => `/chats/${t.bot.chatId}/compact`),
  "POST /chats/:id/fresh": send((t) => `/chats/${t.bot.chatId}/fresh`),
  "POST /chats/:id/stop": send((t) => `/chats/${t.bot.chatId}/stop`),
  "POST /chats/:id/read": send((t) => `/chats/${t.bot.chatId}/read`),
  "GET /settings": get(() => "/settings"),
  "GET /spending": get(() => "/spending"),
  "PUT /settings/voice": send(() => "/settings/voice", () => ({ allowCalls: true })),
  "POST /settings/voice/try": send(() => "/settings/voice/try", () => ({ voice: "alloy" })),
  "DELETE /nodes/:id": send(() => "/nodes/pc-00000001"),
  "POST /calls/:id/decline": send((t) => `/calls/${t.callId}/decline`),
  "PUT /settings/providers/:id": send(() => "/settings/providers/opencode", () => ({ models: [] })),
  "PUT /settings/default-model": send(() => "/settings/default-model", () => ({ model: "dev::mock-model" })),
  "POST /settings/providers/:id/desktop-check": send(() => "/settings/providers/dev/desktop-check"),
  "POST /settings/signins/:id/start": send(() => "/settings/signins/chatgpt/start"),
  "GET /settings/signins/session/:session": get(() => "/settings/signins/session/s1"),
  "POST /settings/signins/session/:session/finish": send(() => "/settings/signins/session/s1/finish", () => ({ url: "http://localhost/cb" })),
  "POST /settings/signins/session/:session/cancel": send(() => "/settings/signins/session/s1/cancel"),
  "DELETE /settings/signins/:id": send(() => "/settings/signins/chatgpt"),
  "GET /accounts": get(() => "/accounts"),
  "POST /accounts/google/start": send(() => "/accounts/google/start"),
  "POST /accounts/google/finish": send(() => "/accounts/google/finish", () => ({ id: "x", url: "http://localhost/cb" })),
  "POST /accounts/microsoft/start": send(() => "/accounts/microsoft/start"),
  "GET /accounts/signin/:id": get(() => "/accounts/signin/x"),
  "POST /accounts/signin/:id/cancel": send(() => "/accounts/signin/x/cancel"),
  "POST /accounts/onepassword": send(() => "/accounts/onepassword", () => ({ token: "ops_x" })),
  "DELETE /accounts/:id": send(() => "/accounts/a1"),
  "PUT /bots/:id/access/:accountId": send((t) => `/bots/${t.bot.id}/access/a1`, () => ({ mail: "read" })),
  "POST /bots/:id/routines": send((t) => `/bots/${t.bot.id}/routines`, () => ({ title: "New", prompt: "Do it.", schedule: { type: "interval", minutes: 60 } })),
  "PATCH /routines/:id": send((t) => `/routines/${t.routine.id}`, () => ({ title: "Renamed" })),
  "DELETE /routines/:id": send((t) => `/routines/${t.routine.id}`),
  "POST /routines/:id/run": send((t) => `/routines/${t.routine.id}/run`),
  "GET /push/key": get(() => "/push/key"),
  "POST /push/subscribe": send(() => "/push/subscribe", () => ({ endpoint: "https://push.example/new", keys: { p256dh: "k", auth: "a" } })),
  "POST /push/unsubscribe": send(() => "/push/unsubscribe", () => ({ endpoint: "https://push.example/new" })),
  "POST /push/status": send(() => "/push/status", () => ({ endpoint: "https://push.example/new" })),
  "POST /push/test": send(() => "/push/test"),
  "POST /focus": send(() => "/focus", () => ({ clientId: "w1", chatId: null, visible: true })),
  "POST /approvals/:id": send((t) => `/approvals/${t.approval.id}`, () => ({ approve: false })),
  "GET /events": get(() => "/events"),
  "PUT /settings/members/key": send(() => "/settings/members/key", () => ({ key: "sk-test-replacement-0000" })),
  "DELETE /settings/members/key": send(() => "/settings/members/key"),
  "PUT /settings/members": send(() => "/settings/members", () => ({ defaultCap: 5 })),
  "GET /people": get(() => "/people"),
  "PUT /people/:id": send((_t, w) => `/people/${w.ids.bob}`, () => ({ cap: 3 })),
  "DELETE /people/:id": send((_t, w) => `/people/${w.ids.bob}`),
  "GET /auth-status": get(() => "/auth-status"),
  "ALL /auth/*": get(() => "/auth/get-session"),
  "GET /invites/check": get((_t, w) => `/invites/check?invite=${w.inviteToken}`),
  "GET /web-signin": get(() => "/web-signin"),
  "POST /web-signin/admin": send(() => "/web-signin/admin", () => ({ email: "admin@example.com", password: "a long password" })),
  "GET /invites": get(() => "/invites"),
  "POST /invites": send(() => "/invites", () => ({ email: "new@example.com" })),
  "POST /invites/:id/resend": send((_t, w) => `/invites/${w.inviteId}/resend`),
  "DELETE /invites/:id": send((_t, w) => `/invites/${w.inviteId}`),
};

/**
 * The policy each route must have, decided here rather than read from the API: weakening one in
 * api.ts (say, a Bot route made "anyone") fails the checks below.
 */
const EXPECTED: Record<Policy, string[]> = {
  anyone: [
    "GET /state", "GET /me", "PUT /me/about", "POST /bots", "POST /topics", "POST /folders", "GET /img", "GET /settings", "GET /spending",
    "GET /push/key", "POST /push/subscribe", "POST /push/unsubscribe", "POST /push/status", "POST /push/test", "POST /focus", "GET /events",
  ],
  admin: [
    "GET /system", "POST /system/check", "POST /system/update",
    "PUT /settings/voice", "POST /settings/voice/try", "DELETE /nodes/:id",
    "PUT /settings/providers/:id", "PUT /settings/default-model", "POST /settings/providers/:id/desktop-check",
    "POST /settings/signins/:id/start", "GET /settings/signins/session/:session", "POST /settings/signins/session/:session/finish",
    "POST /settings/signins/session/:session/cancel", "DELETE /settings/signins/:id",
    "GET /accounts", "POST /accounts/google/start", "POST /accounts/google/finish", "POST /accounts/microsoft/start",
    "GET /accounts/signin/:id", "POST /accounts/signin/:id/cancel", "POST /accounts/onepassword", "DELETE /accounts/:id",
    "PUT /settings/members/key", "DELETE /settings/members/key", "PUT /settings/members",
    "GET /people", "PUT /people/:id", "DELETE /people/:id",
    "GET /web-signin", "POST /web-signin/admin", "GET /invites", "POST /invites", "POST /invites/:id/resend", "DELETE /invites/:id",
  ],
  "admin-bot": ["PUT /bots/:id/access/:accountId"],
  public: ["GET /auth-status", "GET /invites/check", "ALL /auth/*"],
  bot: [
    "PATCH /bots/:id", "DELETE /bots/:id", "GET /bots/:id/terminal", "GET /bots/:id/files", "GET /bots/:id/file", "POST /bots/:id/computer/stop",
    "GET /bots/:id/screen-link", "ALL /bots/:id/screen/*", "GET /bots/:id/browser", "POST /bots/:id/browser/open", "POST /bots/:id/browser/input",
    "GET /bots/:id/browser/live", "GET /bots/:id/soul", "PUT /bots/:id/soul", "GET /bots/:id/memory", "POST /bots/:id/memory",
    "POST /bots/:id/memory/remove", "GET /bots/:id/skills/:slug", "DELETE /bots/:id/skills/:slug", "POST /bots/:id/routines",
  ],
  chat: [
    "PATCH /chats/:id", "DELETE /chats/:id", "GET /chats/:id/messages", "POST /chats/:id/messages", "GET /chats/:id/artifact",
    "GET /chats/:id/artifact/versions/:version", "POST /chats/:id/artifact/restore", "GET /chats/:id/files", "POST /chats/:id/files",
    "POST /chats/:id/compact", "POST /chats/:id/fresh", "POST /chats/:id/stop", "POST /chats/:id/read",
  ],
  folder: ["PATCH /folders/:id", "DELETE /folders/:id"],
  message: ["POST /messages/:id/topics/:proposalId", "POST /messages/:id/branch", "POST /messages/:id/steer", "DELETE /messages/:id"],
  file: ["GET /files/:id", "DELETE /files/:id"],
  routine: ["PATCH /routines/:id", "DELETE /routines/:id", "POST /routines/:id/run"],
  approval: ["POST /approvals/:id"],
  call: ["POST /calls/:id/decline"],
};
const expectedPolicy = new Map(Object.entries(EXPECTED).flatMap(([policy, keys]) => keys.map((key) => [key, policy as Policy])));

/** A refusal by the route's policy (as opposed to the route itself answering 4xx). */
const GUARD_404 = new Set(["Bot not found.", "Chat not found.", "Folder not found.", "Message not found.", "File not found.", "Routine not found.", "This approval is no longer waiting.", "That call has ended."]);
const refused = (response: { status: number; json: any }) => response.status === 403 || (response.status === 404 && GUARD_404.has(response.json?.error));
/** Every route the API serves, with its policy. */
const POLICIES = routesOf((await world()).api);

describe("every route", () => {
  test("is listed here, with a policy, and nothing reaches the router without one", async () => {
    const w = await world();
    const listed = routesOf(w.api).map((route) => `${route.method} ${route.path}`);
    expect(new Set(listed).size).toBe(listed.length);
    // What Hono actually routes (less the sign-in middleware) is exactly what went through route().
    const served = new Set(w.api.routes.filter((route) => route.path !== "/*" && route.path !== "*").map((route) => `${route.method} ${route.path}`));
    expect([...served].sort()).toEqual([...listed].sort());
    expect(Object.keys(CASES).sort()).toEqual([...listed].sort());
    // Each route has the policy decided here.
    expect([...expectedPolicy.keys()].sort()).toEqual([...listed].sort());
    for (const route of routesOf(w.api)) expect(route.policy, `${route.method} ${route.path}`).toBe(expectedPolicy.get(`${route.method} ${route.path}`));
  });

  test("refuses requests from nobody in particular", async () => {
    const w = await world();
    for (const route of routesOf(w.api)) {
      const response = await w.api.request(CASES[`${route.method} ${route.path}`].url(w.things.alice, w).split("?")[0], { method: route.method === "ALL" ? "GET" : route.method });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  for (const { method, path: routePath } of POLICIES) {
    const key = `${method} ${routePath}`;
    // What the route must allow, as decided here (unknown routes fail the first test).
    const policy = expectedPolicy.get(key) ?? "admin";
    const verb = method === "ALL" ? "GET" : method;
    if (policy === "admin") {
      test(`${key}: the admin's alone (members get 403)`, async () => {
        const w = await world();
        const request = CASES[key];
        for (const who of ["alice", "bob"] as const) {
          const before = fingerprint(w, "admin");
          const response = await w.call(who, verb, request.url(w.things.admin, w), request.body?.(w.things.admin, w));
          expect(response.status, `${who}: ${key}`).toBe(403);
          expect(fingerprint(w, "admin")).toBe(before);
        }
        const response = await w.call("admin", verb, request.url(w.things.admin, w), request.body?.(w.things.admin, w));
        expect(refused(response), `admin: ${key} → ${response.status} ${JSON.stringify(response.json)}`).toBe(false);
      });
    } else if (policy === "admin-bot") {
      test(`${key}: the admin's, on the admin's own Bots only`, async () => {
        const w = await world();
        const request = CASES[key];
        expect((await w.call("alice", verb, request.url(w.things.alice, w), request.body?.(w.things.alice, w))).status).toBe(403);
        expect((await w.call("alice", verb, request.url(w.things.admin, w), request.body?.(w.things.admin, w))).status).toBe(403);
        const others = await w.call("admin", verb, request.url(w.things.alice, w), request.body?.(w.things.alice, w));
        expect(others.status).toBe(404);
        const mine = await w.call("admin", verb, request.url(w.things.admin, w), request.body?.(w.things.admin, w));
        expect(refused(mine), `admin: ${key} → ${mine.status}`).toBe(false);
      });
    } else if (policy === "anyone" || policy === "public") {
      test(`${key}: anyone signed in, on their own things`, async () => {
        const w = await world();
        const request = CASES[key];
        for (const who of ["alice", "admin"] as const) {
          const others = fingerprint(w, who === "alice" ? "bob" : "alice");
          const response = await w.call(who, verb, request.url(w.things[who], w), request.body?.(w.things[who], w));
          expect(refused(response), `${who}: ${key} → ${response.status} ${JSON.stringify(response.json)}`).toBe(false);
          expect(fingerprint(w, who === "alice" ? "bob" : "alice")).toBe(others);
        }
      });
    } else {
      test(`${key}: only the owner of the ${policy} (everyone else gets 404, the admin too)`, async () => {
        const w = await world();
        const request = CASES[key];
        const target = w.things.alice;
        for (const who of ["bob", "admin"] as const) {
          const before = fingerprint(w, "alice");
          const response = await w.call(who, verb, request.url(target, w), request.body?.(target, w));
          expect(response.status, `${who}: ${key}`).toBe(404);
          expect(GUARD_404.has(response.json?.error), `${who}: ${key} said ${response.json?.error}`).toBe(true);
          expect(fingerprint(w, "alice"), `${who} changed Alice's things with ${key}`).toBe(before);
        }
        const response = await w.call("alice", verb, request.url(target, w), request.body?.(target, w));
        expect(refused(response), `alice: ${key} → ${response.status} ${JSON.stringify(response.json)}`).toBe(false);
      });
    }
  }

  test("an owner's requests reach their things (a few, end to end)", async () => {
    const w = await world();
    const ana = w.things.alice;
    expect((await w.call("alice", "PATCH", `/bots/${ana.bot.id}`, { title: "Planner" })).json.title).toBe("Planner");
    expect((await w.call("alice", "GET", `/chats/${ana.bot.chatId}/messages`)).json.map((message: { text: string }) => message.text)).toContain("Hi from Ana");
    expect((await w.call("alice", "GET", `/chats/${ana.topic.id}/artifact`)).json.artifact.body).toBe("Ana's doc");
    expect((await w.call("alice", "DELETE", `/folders/${ana.folder.id}`)).status).toBe(204);
    expect(w.store.getFolder(ana.folder.id)).toBeNull();
    // What a member makes is theirs.
    const bot = (await w.call("alice", "POST", "/bots", { name: "Second" })).json;
    expect(bot.ownerId).toBe(w.ids.alice);
    expect(w.store.getChat(bot.chatId)!.ownerId).toBe(w.ids.alice);
    expect((await w.call("alice", "POST", "/folders", { title: "Work" })).json.ownerId).toBe(w.ids.alice);
    expect((await w.call("alice", "POST", "/topics", { title: "Plans", memberIds: [bot.id] })).json.ownerId).toBe(w.ids.alice);
    expect((await w.call("alice", "POST", `/messages/${ana.message.id}/branch`, { title: "Fork" })).status).toBe(201);
    expect(w.store.listChats(w.ids.alice).find((chat) => chat.title === "Branch")).toBeTruthy();
  });
});

describe("the members' OpenCode API key", () => {
  const KEY = "sk-oc-test-0123456789-QXZW";

  /** A route's whole answer as text (an event stream up to its "ready"). */
  async function raw(w: World, who: Who, key: string) {
    const request = CASES[key];
    const [method] = key.split(" ");
    const body = request.body?.(w.things[who], w);
    const form = body instanceof FormData;
    const controller = new AbortController();
    const response = await w.api.request(request.url(w.things[who], w), {
      method: method === "ALL" ? "GET" : method, signal: controller.signal,
      headers: { "X-Person": who, ...(body !== undefined && !form ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    if (!response.headers.get("content-type")?.includes("event-stream")) return response.text();
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: ready") && !text.includes("event: closed")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    return text;
  }

  test("is kept in data/credentials.json (mode 600) only, and no route ever returns it", async () => {
    const w = await world();
    // Setting it answers with whether it's set and its last four characters, not the key.
    const set = await w.call("admin", "PUT", "/settings/members/key", { key: KEY });
    expect(set.status).toBe(200);
    expect(set.json.members).toMatchObject({ keySet: true, keyHint: "QXZW" });
    expect(JSON.stringify(set.json)).not.toContain(KEY);
    const file = path.join(dataDir, "credentials.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))["opencode-key"]).toEqual({ type: "api_key", key: KEY });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Every route, as the admin and as a member: never the key; members never even get its last four characters.
    for (const key of Object.keys(CASES).filter((item) => !item.includes("/settings/members/key")).sort()) {
      for (const who of ["admin", "alice"] as const) {
        const text = await raw(w, who, key);
        expect(text.includes(KEY), `${who}: ${key} returned the key`).toBe(false);
        if (who === "alice") expect(/QXZW|keyHint/.test(text), `${key} showed a member the key's hint`).toBe(false);
      }
    }
    // Nor does it reach the event log or settings.json.
    expect(JSON.stringify(w.events.since(0))).not.toContain(KEY);
    expect(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).not.toContain(KEY);
    // Members can't set or clear it.
    expect((await w.call("alice", "PUT", "/settings/members/key", { key: "sk-member-tries-this-1" })).status).toBe(403);
    expect((await w.call("alice", "DELETE", "/settings/members/key")).status).toBe(403);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))["opencode-key"].key).toBe(KEY);
    // Clearing it: unset again.
    const cleared = await w.call("admin", "DELETE", "/settings/members/key");
    expect(cleared.json.members).toMatchObject({ keySet: false, keyHint: null });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).not.toHaveProperty("opencode-key");
  });
});

describe("WebSocket upgrades", () => {
  test("every upgrade path is checked here", () => {
    // A new kind of upgrade fails type-checking here until it's added (and tested below).
    const checked: Record<Upgrade["kind"], string> = { nodes: "admin", call: "chat", screen: "bot" };
    expect(UPGRADES.map((upgrade) => [upgrade.kind, upgrade.policy]).sort()).toEqual(Object.entries(checked).sort());
  });

  test("PC lending (/api/nodes/connect) is the admin's alone", async () => {
    const w = await world();
    const person = (who: Who) => w.store.getPerson(w.ids[who])!;
    expect(authorizeUpgrade(w.store, person("admin"), "/api/nodes/connect")).toEqual({ kind: "nodes" });
    expect(authorizeUpgrade(w.store, person("alice"), "/api/nodes/connect")).toBeNull();
    expect(authorizeUpgrade(w.store, person("alice"), "/api/nodes/connect?x=1")).toBeNull();
  });

  test("a voice call (/api/chats/:id/call) is only for the chat's owner", async () => {
    const w = await world();
    const person = (who: Who) => w.store.getPerson(w.ids[who])!;
    const url = `/api/chats/${w.things.alice.bot.chatId}/call`;
    expect(authorizeUpgrade(w.store, person("alice"), url)).toEqual({ kind: "call", chatId: w.things.alice.bot.chatId });
    expect(authorizeUpgrade(w.store, person("alice"), `${url}?answer=x`)).toMatchObject({ kind: "call" });
    expect(authorizeUpgrade(w.store, person("bob"), url)).toBeNull();
    expect(authorizeUpgrade(w.store, person("admin"), url)).toBeNull();
  });

  test("a Bot's screen (/api/bots/:id/screen/*) is only for the Bot's owner", async () => {
    const w = await world();
    const person = (who: Who) => w.store.getPerson(w.ids[who])!;
    const url = `/api/bots/${w.things.alice.bot.id}/screen/media?x=1`;
    expect(authorizeUpgrade(w.store, person("alice"), url)).toEqual({ kind: "screen", botId: w.things.alice.bot.id, path: "/media", query: "?x=1" });
    expect(authorizeUpgrade(w.store, person("bob"), url)).toBeNull();
    expect(authorizeUpgrade(w.store, person("admin"), url)).toBeNull();
    // Anything else isn't an upgrade Colony takes.
    expect(authorizeUpgrade(w.store, person("admin"), "/api/events")).toBeNull();
  });
});

describe("what each person sees", () => {
  test("/api/state is the asker's own things, and the admin's settings stay the admin's", async () => {
    const w = await world();
    const alice = (await w.call("alice", "GET", "/state")).json;
    expect(alice.me).toMatchObject({ id: w.ids.alice, role: "member", login: "alice@example.com" });
    expect(alice.bots.map((bot: { id: string }) => bot.id)).toEqual([w.things.alice.bot.id]);
    expect(alice.chats.map((chat: { id: string }) => chat.id).sort()).toEqual([w.things.alice.bot.chatId, w.things.alice.topic.id].sort());
    expect(alice.folders.map((folder: { id: string }) => folder.id)).toEqual([w.things.alice.folder.id]);
    expect(alice.approvals.map((approval: { id: string }) => approval.id)).toEqual([w.things.alice.approval.id]);
    expect(alice.routines.map((routine: { id: string }) => routine.id)).toEqual([w.things.alice.routine.id]);
    expect([alice.accounts, alice.access, alice.nodes]).toEqual([[], [], []]);
    // Members' Bots only ever get the members' models, never the admin's.
    expect(alice.models.map((model: { ref: string }) => model.ref)).toEqual(["opencode-members::deepseek-v4.1-flash-free"]);
    const admin = (await w.call("admin", "GET", "/state")).json;
    expect(admin.me).toMatchObject({ id: "owner", role: "admin" });
    // The admin doesn't see members' things either.
    expect(admin.bots.map((bot: { id: string }) => bot.id)).toEqual([w.things.admin.bot.id]);
    expect(admin.chats.every((chat: { ownerId: string }) => chat.ownerId === "owner")).toBe(true);
  });

  test("the live event stream carries only the asker's events (and everyone's)", async () => {
    const w = await world();
    const controller = new AbortController();
    const response = await w.api.request(`/events?since=${w.events.latestSeq()}`, { headers: { "X-Person": "alice" }, signal: controller.signal });
    const reader = response.body!.getReader();
    let text = "";
    const read = async (until: string) => {
      while (!text.includes(until)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await read("event: ready");
    w.store.updateBot(w.things.bob.bot.id, { title: "Bob's secret" });
    w.store.createMessage({ chatId: w.things.admin.bot.chatId, author: "user", text: "Admin's secret" });
    w.events.broadcast({ type: "computer.output", botId: w.things.bob.bot.id, text: "bob's terminal" }, w.ids.bob);
    w.events.emit({ type: "settings.updated", models: settings.modelOptions(), defaultModel: "", configured: true }, null);
    w.store.updateBot(w.things.alice.bot.id, { title: "Alice's own" });
    await read("Alice's own");
    controller.abort();
    await reader.cancel().catch(() => {});
    expect(text).toContain("settings.updated");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("bob's terminal");
    // A replay from the start carries none of theirs either.
    const replay = w.events.since(0)!.filter((item) => item.personId === w.ids.alice || item.personId === null);
    expect(JSON.stringify(replay)).not.toContain(w.things.bob.bot.id);
  });

  test("spending is the asker's Bots only", async () => {
    const w = await world();
    for (const who of ["alice", "bob"] as const) {
      w.store.recordUsage({ botId: w.things[who].bot.id, providerId: "dev", model: "mock-model", inputTokens: 100, outputTokens: 10, cachedTokens: 0, costMicros: who === "alice" ? 1_000_000 : 5_000_000 });
    }
    const alice = (await w.call("alice", "GET", "/spending")).json;
    expect(alice.total).toBe(1);
    expect(alice.bots.map((bot: { botId: string }) => bot.botId)).toEqual([w.things.alice.bot.id]);
    expect((await w.call("admin", "GET", "/spending")).json.total).toBe(0);
  });

  test("members read a reduced Settings; the admin reads all of it", async () => {
    const w = await world();
    const member = (await w.call("alice", "GET", "/settings")).json;
    expect(member).toMatchObject({ role: "member", defaultModel: "opencode-members::deepseek-v4.1-flash-free", cap: null, spent: 0 });
    expect(member).not.toHaveProperty("providers");
    expect(member).not.toHaveProperty("signIns");
    expect(JSON.stringify(member)).not.toContain("keyHint");
    expect((await w.call("admin", "GET", "/settings")).json).toMatchObject({ role: "admin", providers: expect.any(Array) });
  });

  test("what Bots know about you is per person: data/people/<id>/USER.md, and data/USER.md stays the admin's", async () => {
    const w = await world();
    const adminBefore = readAbout("owner");
    await w.call("alice", "POST", `/bots/${w.things.alice.bot.id}/memory`, { target: "user", entry: "Allergic to nuts" });
    await w.call("alice", "PUT", "/me/about", { text: "- Allergic to nuts\n- Lives in Ohrid" });
    expect(fs.readFileSync(path.join(dataDir, "people", w.ids.alice, "USER.md"), "utf8")).toContain("Lives in Ohrid");
    expect(readAbout("owner")).toBe(adminBefore);
    expect(readAbout(w.ids.bob)).toBe("");
    expect((await w.call("bob", "GET", "/me")).json.about).toBe("");
    // Bob's Bot reads Bob's notes, not Alice's.
    expect(files.readEntries(w.things.bob.bot, "user")).toEqual([]);
    expect(files.readEntries(w.things.alice.bot, "user")).toContain("Lives in Ohrid");
  });

  test("push notifications reach only the owner's devices", async () => {
    const w = await world();
    await w.call("alice", "POST", "/push/subscribe", { endpoint: "https://push.example/alice", keys: { p256dh: "k", auth: "a" } });
    await w.call("bob", "POST", "/push/subscribe", { endpoint: "https://push.example/bob", keys: { p256dh: "k", auth: "a" } });
    // Bob can't see or drop Alice's device.
    expect((await w.call("bob", "POST", "/push/status", { endpoint: "https://push.example/alice" })).json.subscribed).toBe(false);
    await w.call("bob", "POST", "/push/unsubscribe", { endpoint: "https://push.example/alice" });
    expect((await w.call("alice", "POST", "/push/status", { endpoint: "https://push.example/alice" })).json.subscribed).toBe(true);
    // A finished reply in Bob's chat goes to Bob only.
    const reply = w.store.createMessage({ chatId: w.things.bob.bot.chatId, author: w.things.bob.bot.id, status: "streaming" });
    w.store.updateMessage(reply.id, { text: "Done!", status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.pushed.map((item) => item.endpoint)).toEqual(["https://push.example/bob"]);
    // Alice watching her own chat doesn't hush Bob's notifications.
    await w.call("alice", "POST", "/focus", { clientId: "w1", chatId: w.things.bob.bot.chatId, visible: true });
    expect(w.push.watching(w.ids.bob, w.things.bob.bot.chatId)).toBe(false);
    expect((await w.call("alice", "POST", "/push/test")).json.delivered).toBe(1);
  });
});

describe("approvals", () => {
  test("go to the Bot's owner: only they see and answer them", async () => {
    const w = await world();
    const ana = w.things.alice;
    const controller = new AbortController();
    const waiting = w.gate.request({ botId: ana.bot.id, chatId: ana.bot.chatId, messageId: ana.message.id, tool: "send_email", summary: "Ana wants to send", detail: "To: x", reason: "Leaves your PC" }, controller.signal);
    const approval = w.store.listApprovals("pending").find((item) => item.tool === "send_email")!;
    expect(approval.approverId).toBe(w.ids.alice);
    expect((await w.call("bob", "GET", "/state")).json.approvals.map((item: { id: string }) => item.id)).not.toContain(approval.id);
    expect((await w.call("bob", "POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(404);
    expect((await w.call("admin", "POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(404);
    expect((await w.call("alice", "POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(204);
    expect(await waiting).toBe(true);
  });
});

describe("no shared topics", () => {
  test("a topic only ever holds its owner's Bots", async () => {
    const w = await world();
    const ana = w.things.alice;
    expect((await w.call("alice", "POST", "/topics", { title: "Mixed", memberIds: [ana.bot.id, w.things.bob.bot.id] })).status).toBe(400);
    expect((await w.call("alice", "PATCH", `/chats/${ana.topic.id}`, { memberIds: [ana.bot.id, w.things.bob.bot.id] })).status).toBe(400);
    expect((await w.call("alice", "POST", "/topics", { title: "Filed", memberIds: [ana.bot.id], folderId: w.things.bob.folder.id })).status).toBe(400);
    expect((await w.call("alice", "POST", `/bots/${ana.bot.id}/routines`, { title: "R", prompt: "p", schedule: { type: "interval", minutes: 60 }, chatId: w.things.bob.topic.id })).status).toBe(400);
    expect(() => w.store.createChat({ kind: "topic", title: "Sneaky", memberIds: [w.things.bob.bot.id], coordinatorId: null, ownerId: w.ids.alice })).toThrow();
    expect(w.store.getChat(ana.topic.id)!.memberIds).toEqual([ana.bot.id]);
  });

  test("a suggested topic takes only the owner's Bots", async () => {
    const w = await world();
    const ana = w.things.alice;
    const message = w.store.createMessage({
      chatId: ana.bot.chatId, author: ana.bot.id, text: "Let's",
      cards: [{ type: "topic", proposalId: "mix", proposal: { title: "Mix", icon: "chat", brief: "", memberIds: [ana.bot.id, w.things.bob.bot.id], folderId: w.things.bob.folder.id }, chatId: null, dismissed: false }],
    });
    const chat = (await w.call("alice", "POST", `/messages/${message.id}/topics/mix`, { accept: true })).json;
    expect(chat).toMatchObject({ memberIds: [ana.bot.id], folderId: null, ownerId: w.ids.alice });
  });

  test("Bots only know, message and file for their own owner's team", async () => {
    const w = await world();
    const ana = w.things.alice;
    const ctx = { botId: ana.bot.id, botName: "Ana", chatId: ana.bot.chatId, messageId: ana.message.id, store: w.store, depth: 0, consult: async () => { throw new Error("no"); } } as unknown as ToolContext;
    await expect(coreTools.message_bot.execute({ to: "Bo", message: "hi" }, ctx)).rejects.toThrow(/No teammate named/);
    const listed = await coreTools.topic_list.execute({}, ctx);
    expect(listed.folders).toEqual(["Ana's folder"]);
    expect(listed.topics.map((topic) => topic.title)).toEqual(["Ana's topic"]);
    await coreTools.topic_create.execute({ title: "T", icon: "chat", brief: "", bots: ["Bo", "Max"], folder: "Bo's folder" }, ctx);
    const card = w.store.getMessage(ana.message.id)!.cards.at(-1)!;
    expect(card).toMatchObject({ type: "topic", proposal: { memberIds: [ana.bot.id], folderId: null } });
  });
});
