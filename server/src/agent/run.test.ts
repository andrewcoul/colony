import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";

// Config is read at import time, so point it at a temp data dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-test-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_API_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_MODELS = "mock-model,other-model";

const { openDb } = await import("../db.js");
const { EventLog } = await import("../events.js");
const { Store } = await import("../store.js");
const { ApprovalGate } = await import("./approvals.js");
const { AgentRunner } = await import("./run.js");
const { coreTools } = await import("./tools.js");
const { createApi } = await import("../api.js");
const { RoutineScheduler } = await import("../routines.js");
const { PushService } = await import("../push.js");
const files = await import("../files.js");
// .env values become the one provider "env" (models mock-model and other-model).
(await import("../settings.js")).loadSettings();
type ColonyTool = import("./tools.js").ColonyTool;

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const textTurn = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  ...text.split(/(?<= )/).map((delta) => ({ type: "text-delta", id: "t", delta })),
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const toolTurn = (toolName: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
];

/** A model that plays back scripted turns, one per model call. */
function scriptedModel(turns: unknown[][]) {
  const prompts: unknown[] = [];
  const toolNames: string[][] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      toolNames.push((options.tools ?? []).map((item) => item.name));
      const chunks = turns[Math.min(call++, turns.length - 1)];
      return { stream: convertArrayToReadableStream(chunks as never[]) };
    },
  });
  return { model, prompts, toolNames };
}

let script: ReturnType<typeof scriptedModel>;
const sent: string[] = [];
const sendEmail: ColonyTool = {
  description: "Send an email (needs approval).",
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  describe: ({ to }) => `Emailed ${to}`,
  execute: async ({ to, body }, ctx) => {
    const ok = await ctx.gate.request({ botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: "send_email",
      summary: `${ctx.botName} wants to send an email`, detail: `To: ${to}\n\n${body}`, reason: "Sends outside your PC" }, ctx.signal);
    if (!ok) throw new Error("Approval denied by the user.");
    sent.push(to);
    return { sent: true };
  },
};

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = new AgentRunner(store, events, gate, () => ({ ...coreTools, send_email: sendEmail }), () => script.model);
  const routines = new RoutineScheduler(store, runner);
  const pushed: { title: string; body: string; url: string }[] = [];
  const push = new PushService(db, store, events, async (_subscription, payload) => { pushed.push(JSON.parse(String(payload))); return {} as never; });
  push.subscribe({ endpoint: "https://push.example/device", keys: { p256dh: "k", auth: "a" } });
  const api = createApi({ store, events, gate, runner, routines, push });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    return { status: response.status, json: json as any };
  };
  return { db, store, events, runner, routines, push, pushed, call };
}

/** Colony coming back up on the same database: a fresh store, gate and runner, as after a restart. */
function restarted(db: ReturnType<typeof openDb>) {
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = new AgentRunner(store, events, gate, () => ({ ...coreTools, send_email: sendEmail }), () => script.model);
  return { store, gate, runner };
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

const finished = (store: InstanceType<typeof Store>, chatId: string, count: number) =>
  until(() => { const messages = store.listMessages(chatId).filter((m) => m.author !== "user"); return messages.length >= count && messages.every((m) => m.status !== "streaming") && messages; });

beforeEach(() => { sent.length = 0; });
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("Bots", () => {
  test("a new Bot gets a folder and introduces itself in its own chat", async () => {
    script = scriptedModel([textTurn("Hi, I'm Luke. I'll keep your inbox near zero.")]);
    const { store, call } = setup();
    const { status, json: bot } = await call("POST", "/bots", { name: "Luke", title: "Inbox manager", description: "Keep my inbox near zero." });
    expect(status).toBe(201);
    expect(fs.readFileSync(path.join(dataDir, "bots", bot.id, "SOUL.md"), "utf8")).toContain("Keep my inbox near zero.");
    const [intro] = await finished(store, bot.chatId, 1);
    expect(intro.text).toBe("Hi, I'm Luke. I'll keep your inbox near zero.");
    expect(intro.status).toBe("done");
    expect(store.getBot(bot.id)!.presence).toBe("done");
    expect(store.getChat(bot.chatId)!.lastPreview).toContain("Hi, I'm Luke");
  });

  test("tool calls become titled steps, and memory persists to MEMORY.md", async () => {
    script = scriptedModel([textTurn("Hello."), toolTurn("memory", { action: "add", target: "memory", entry: "Prefers replies under 3 lines" }), textTurn("Noted.")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Kenny" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Keep replies short please." });
    const replies = await finished(store, bot.chatId, 2);
    const reply = replies.at(-1)!;
    expect(reply.text).toBe("Noted.");
    expect(reply.steps).toMatchObject([{ tool: "memory", title: "Saved to memory", status: "done" }]);
    expect(files.readEntries(bot.id, "memory")).toEqual(["Prefers replies under 3 lines"]);
    // The next turn's system prompt includes the saved memory.
    expect(JSON.stringify(script.prompts.at(-1))).toContain("Prefers replies under 3 lines");
  });

  test("text before and after a tool call reads as separate paragraphs", async () => {
    const [start, ...rest] = toolTurn("memory", { action: "add", target: "memory", entry: "x" });
    const narrated = [start, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "Checking." }, { type: "text-end", id: "a" }, ...rest];
    script = scriptedModel([textTurn("Hi."), narrated, textTurn("Done.")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Kenny" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Go." });
    expect((await finished(store, bot.chatId, 2)).at(-1)!.text).toBe("Checking.\n\nDone.");
  });

  test("per-Bot routes refuse unknown ids, so ids can't reach outside the data folder", async () => {
    const { call } = setup();
    for (const id of ["nope", "..", encodeURIComponent("../../evil")]) {
      expect((await call("PUT", `/bots/${id}/soul`, { content: "x" })).status).toBe(404);
    }
    expect(fs.existsSync(path.join(dataDir, "..", "evil"))).toBe(false);
  });

  test("the profile edits memory and skills", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Mia" });
    await finished(store, bot.chatId, 1);
    const added = await call("POST", `/bots/${bot.id}/memory`, { target: "memory", entry: "Ships on Fridays" });
    expect(added.json.memory).toEqual(["Ships on Fridays"]);
    expect(added.json.usage.memory.used).toBeGreaterThan(0);
    expect((await call("POST", `/bots/${bot.id}/memory/remove`, { target: "memory", entry: "Ships on Fridays" })).json.memory).toEqual([]);
    files.saveSkill(bot.id, "Weekly report", "How to write it", "1. Gather\n2. Write");
    expect((await call("GET", `/bots/${bot.id}/skills/weekly-report`)).json.content).toContain("1. Gather");
    await call("DELETE", `/bots/${bot.id}/skills/weekly-report`);
    expect(files.listSkills(bot.id)).toEqual([]);
    // An unknown or traversing slug deletes nothing.
    expect([204, 404]).toContain((await call("DELETE", `/bots/${bot.id}/skills/..`)).status);
    expect([204, 404]).toContain((await call("DELETE", `/bots/${bot.id}/skills/${encodeURIComponent("../workspace")}`)).status);
    expect(fs.existsSync(path.join(dataDir, "bots", bot.id, "workspace"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "bots", bot.id))).toBe(true);
  });

  test("editing one field of a Bot leaves the others alone", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Kenny", title: "Researcher", description: "Finds things.", computer: true });
    await finished(store, bot.chatId, 1);
    const { json: patched } = await call("PATCH", `/bots/${bot.id}`, { model: "other-model" });
    expect(patched).toMatchObject({ model: "env::other-model", title: "Researcher", description: "Finds things.", computer: true });
  });

  test("unknown models fall back to the default", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { call } = setup();
    expect((await call("POST", "/bots", { name: "A", model: "expensive-unlisted" })).json.model).toBe("env::mock-model");
    expect((await call("POST", "/bots", { name: "B", model: "env::other-model" })).json.model).toBe("env::other-model");
  });
});

describe("approval gate", () => {
  test("approve lets the action run; the Bot waits and shows a card meanwhile", async () => {
    script = scriptedModel([textTurn("Hi."), toolTurn("send_email", { to: "sarah@acme.com", body: "Moving Friday's review to 2 PM." }), textTurn("Sent.")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Email Sarah about the review." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    expect(approval.detail).toContain("sarah@acme.com");
    expect(store.getBot(bot.id)!.presence).toBe("waiting");
    const reply = store.getMessage(approval.messageId)!;
    expect(reply.cards).toEqual([{ type: "approval", approvalId: approval.id }]);
    expect(sent).toEqual([]);

    expect((await call("POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(204);
    const done = (await finished(store, bot.chatId, 2)).at(-1)!;
    expect(sent).toEqual(["sarah@acme.com"]);
    expect(done.steps[0]).toMatchObject({ title: "Emailed sarah@acme.com", status: "done" });
    expect(store.getApproval(approval.id)!.status).toBe("approved");
    expect((await call("POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(409);
  });

  test("deny fails closed: nothing is sent and the step is marked denied", async () => {
    script = scriptedModel([textTurn("Hi."), toolTurn("send_email", { to: "x@y.com", body: "hi" }), textTurn("Okay, I won't send it.")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Email them." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    await call("POST", `/approvals/${approval.id}`, { approve: false });
    const done = (await finished(store, bot.chatId, 2)).at(-1)!;
    expect(sent).toEqual([]);
    expect(done.steps[0].status).toBe("denied");
  });

  test("stopping a run while it waits denies the pending approval", async () => {
    script = scriptedModel([textTurn("Hi."), toolTurn("send_email", { to: "x@y.com", body: "hi" }), textTurn("…")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Email them." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    await call("POST", `/chats/${bot.chatId}/stop`);
    const done = (await finished(store, bot.chatId, 2)).at(-1)!;
    expect(done.status).toBe("stopped");
    expect(store.getApproval(approval.id)!.status).toBe("denied");
    expect(sent).toEqual([]);
  });
});

describe("groups and events", () => {
  test("@mentions route a group message to that Bot; otherwise the coordinator answers", async () => {
    script = scriptedModel([textTurn("On it.")]);
    const { store, call } = setup();
    const { json: kenny } = await call("POST", "/bots", { name: "Kenny" });
    const { json: jenny } = await call("POST", "/bots", { name: "Jenny" });
    await finished(store, kenny.chatId, 1);
    await finished(store, jenny.chatId, 1);
    const { json: group } = await call("POST", "/groups", { title: "Launch", memberIds: [kenny.id, jenny.id], coordinatorId: jenny.id });
    await call("POST", `/chats/${group.id}/messages`, { text: "Status, everyone?" });
    expect((await finished(store, group.id, 1)).map((m) => m.author)).toEqual([jenny.id]);
    await call("POST", `/chats/${group.id}/messages`, { text: "@Kenny can you check the build?" });
    expect((await finished(store, group.id, 2)).map((m) => m.author)).toEqual([jenny.id, kenny.id]);
  });

  test("the event log replays from a sequence number", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { store, events, call } = setup();
    const before = events.latestSeq();
    const { json: bot } = await call("POST", "/bots", { name: "Tyler" });
    await finished(store, bot.chatId, 1);
    const replay = events.since(before)!;
    expect(replay.map((item) => item.event.type)).toContain("bot.upserted");
    expect(replay.map((item) => item.event.type)).toContain("message.upserted");
    expect(replay.every((item, index) => index === 0 || item.seq > replay[index - 1].seq)).toBe(true);
  });

  test("after a restart, replies with no checkpoint are stopped and their approvals expire", () => {
    const { store } = setup();
    const bot = store.createBot({ name: "Ghost", title: "", description: "", model: "mock-model", computer: false });
    const message = store.createMessage({ chatId: bot.chatId, author: bot.id, status: "streaming" });
    const approval = store.createApproval({ botId: bot.id, chatId: bot.chatId, messageId: message.id, tool: "x", summary: "s", detail: "d", reason: "" });
    expect(store.recoverAfterRestart(15 * 60_000)).toEqual([]);
    expect(store.getMessage(message.id)!.status).toBe("stopped");
    expect(store.getApproval(approval.id)!.status).toBe("expired");
  });
});

describe("routines and notifications", () => {
  test("a Bot creates a routine in chat; it runs on schedule with a routine card and notifies you", async () => {
    script = scriptedModel([
      textTurn("Hi."),
      toolTurn("routines", { action: "create", title: "Morning briefing", prompt: "Summarise overnight news about Tauri.", schedule: { type: "daily", time: "08:00", days: [] } }),
      textTurn("Done: every day at 8:00 AM."),
      textTurn("Here's your briefing: Tauri 2.12.3 shipped."),
    ]);
    const { store, routines, pushed, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Kenny" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Brief me every morning at 8." });
    const confirm = (await finished(store, bot.chatId, 2)).at(-1)!;
    const [routine] = store.listRoutines(bot.id);
    expect(routine).toMatchObject({ title: "Morning briefing", chatId: bot.chatId, enabled: true });
    expect(new Date(routine.nextRunAt!).getHours()).toBe(8);
    expect(confirm.cards).toEqual([{ type: "routine", routineId: routine.id, action: "created", title: "Morning briefing" }]);
    expect(confirm.steps[0]).toMatchObject({ title: "Created routine “Morning briefing”", detail: "Every day at 8:00 AM" });

    routines.tick(routine.nextRunAt! + 1000);
    const run = (await finished(store, bot.chatId, 3)).at(-1)!;
    expect(run.text).toContain("Tauri 2.12.3");
    expect(run.cards).toEqual([{ type: "routine", routineId: routine.id, action: "ran", title: "Morning briefing" }]);
    expect(JSON.stringify(script.prompts.at(-1))).toContain("Summarise overnight news about Tauri.");
    const after = await until(() => store.getRoutine(routine.id)?.lastStatus === "done" && store.getRoutine(routine.id));
    expect(after.nextRunAt! - routine.nextRunAt!).toBe(86_400_000);
    expect(pushed.at(-1)).toMatchObject({ title: "Kenny · Morning briefing", url: `/#/chat/${bot.chatId}` });
  });

  test("no notification for the chat you're looking at; approvals always ask", async () => {
    script = scriptedModel([textTurn("Hi."), textTurn("Sure."), toolTurn("send_email", { to: "x@y.com", body: "hi" }), textTurn("Ok.")]);
    const { store, push, pushed, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    expect(pushed.map((item) => item.title)).toEqual(["Peng"]);
    push.setFocus("phone", bot.chatId, true);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Hello" });
    await finished(store, bot.chatId, 2);
    expect(pushed).toHaveLength(1);
    push.setFocus("phone", null, true);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Email them." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    expect(pushed.at(-1)).toMatchObject({ title: "Peng needs you", body: approval.summary });
    await call("POST", `/approvals/${approval.id}`, { approve: false });
    await finished(store, bot.chatId, 3);
  });

  test("missed runs are skipped after a long gap, and one-off routines switch off after running", async () => {
    script = scriptedModel([textTurn("Reminder: call Sarah.")]);
    const { store, routines } = setup();
    const bot = store.createBot({ name: "Tyler", title: "", description: "", model: "mock-model", computer: false });
    const daily = store.createRoutine({ botId: bot.id, chatId: bot.chatId, title: "Daily", prompt: "x", schedule: { type: "daily", time: "08:00", days: [] } });
    routines.tick(daily.nextRunAt! + 7 * 60 * 60_000);
    expect(store.getRoutine(daily.id)!.lastRunAt).toBeNull();
    expect(store.getRoutine(daily.id)!.nextRunAt).toBe(daily.nextRunAt! + 86_400_000);

    const once = store.createRoutine({ botId: bot.id, chatId: bot.chatId, title: "Call Sarah", prompt: "Remind me to call Sarah.", schedule: { type: "once", at: Date.now() + 60_000 } });
    routines.tick(once.nextRunAt! + 1000);
    expect(store.getRoutine(once.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await finished(store, bot.chatId, 1))[0].text).toBe("Reminder: call Sarah.");
  });

  test("routines move to the Bot's own chat when their group is deleted", () => {
    const { store } = setup();
    const a = store.createBot({ name: "A", title: "", description: "", model: "mock-model", computer: false });
    const b = store.createBot({ name: "B", title: "", description: "", model: "mock-model", computer: false });
    const group = store.createChat({ kind: "group", title: "G", memberIds: [a.id, b.id], coordinatorId: a.id });
    const routine = store.createRoutine({ botId: a.id, chatId: group.id, title: "R", prompt: "x", schedule: { type: "interval", minutes: 60 } });
    store.deleteChat(group.id);
    expect(store.getRoutine(routine.id)!.chatId).toBe(a.chatId);
    store.deleteBot(a.id);
    expect(store.getRoutine(routine.id)).toBeNull();
  });
});

describe("Bots messaging each other", () => {
  async function team(call: (method: string, url: string, body?: unknown) => Promise<{ json: any }>, store: InstanceType<typeof Store>) {
    const { json: kenny } = await call("POST", "/bots", { name: "Kenny", title: "Chief of staff" });
    await finished(store, kenny.chatId, 1);
    const { json: john } = await call("POST", "/bots", { name: "John", title: "Engineer", description: "Owns the build." });
    await finished(store, john.chatId, 1);
    return { kenny, john };
  }

  test("a Bot asks a teammate in a private thread and gets a handoff card", async () => {
    script = scriptedModel([
      textTurn("Hi."), textTurn("Hi."),
      toolTurn("message_bot", { to: "John", message: "Is the build green?" }),
      textTurn("Yes, all 212 tests pass."),
      textTurn("John says the build is green."),
    ]);
    const { store, pushed, call } = setup();
    const { kenny, john } = await team(call, store);
    await call("POST", `/chats/${kenny.chatId}/messages`, { text: "Ask John if the build is green." });
    const reply = (await finished(store, kenny.chatId, 2)).at(-1)!;
    expect(reply.text).toBe("John says the build is green.");
    expect(reply.steps[0]).toMatchObject({ title: "Messaged John", detail: "John replied", status: "done" });

    const thread = store.findThread(kenny.id, john.id)!;
    expect(thread.kind).toBe("thread");
    expect(reply.cards).toEqual([{ type: "handoff", threads: [{ botId: john.id, chatId: thread.id, count: 2 }] }]);
    expect(store.listMessages(thread.id).map((m) => [m.author, m.text])).toEqual([[kenny.id, "Is the build green?"], [john.id, "Yes, all 212 tests pass."]]);
    // Kenny's prompt lists his teammates; John answers in a thread and can't pass the work on.
    expect(JSON.stringify(script.prompts[2])).toContain("John, Engineer: Owns the build.");
    expect(JSON.stringify(script.prompts[3])).toContain("private thread with Kenny");
    expect(script.toolNames[2]).toContain("message_bot");
    expect(script.toolNames[3]).not.toContain("message_bot");
    // Only the answer the user asked for notifies, not the Bots' chatter.
    expect(pushed.map((item) => item.title)).toEqual(["Kenny", "John", "Kenny"]);
    expect(store.getChat(thread.id)!.unread).toBe(0);
    // You can read a thread but not post in it.
    expect((await call("POST", `/chats/${thread.id}/messages`, { text: "hi" })).status).toBe(400);
  });

  test("stopping the asker stops the teammate's answer, and its pending approval is denied", async () => {
    script = scriptedModel([
      textTurn("Hi."), textTurn("Hi."),
      toolTurn("message_bot", { to: "John", message: "Email the client." }),
      toolTurn("send_email", { to: "client@acme.com", body: "Update" }),
      textTurn("…"),
    ]);
    const { store, call } = setup();
    const { kenny, john } = await team(call, store);
    await call("POST", `/chats/${kenny.chatId}/messages`, { text: "Get John to email the client." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    expect(store.getBot(john.id)!.presence).toBe("waiting");
    await call("POST", `/chats/${kenny.chatId}/stop`);
    expect((await finished(store, kenny.chatId, 2)).at(-1)!.status).toBe("stopped");
    const thread = store.findThread(kenny.id, john.id)!;
    expect((await until(() => { const last = store.listMessages(thread.id).at(-1)!; return last.status !== "streaming" && last; })).status).toBe("stopped");
    expect(store.getApproval(approval.id)!.status).toBe("denied");
    expect(sent).toEqual([]);
  });

  test("unknown teammates get a helpful error, and threads go when a Bot is deleted", async () => {
    script = scriptedModel([textTurn("Hi."), textTurn("Hi."), toolTurn("message_bot", { to: "Tyler", message: "?" }), textTurn("There's no Tyler.")]);
    const { store, call } = setup();
    const { kenny, john } = await team(call, store);
    await call("POST", `/chats/${kenny.chatId}/messages`, { text: "Ask Tyler." });
    const reply = (await finished(store, kenny.chatId, 2)).at(-1)!;
    expect(reply.steps[0]).toMatchObject({ status: "error" });
    expect(reply.steps[0].detail).toContain("Your teammates: John");

    const thread = store.createChat({ kind: "thread", title: "Kenny & John", memberIds: [kenny.id, john.id], coordinatorId: null });
    store.deleteBot(john.id);
    expect(store.getChat(thread.id)).toBeNull();
  });
});

describe("steering while a Bot works", () => {
  // The email tool waits for approval, which holds the run mid-turn so messages can arrive.
  async function working() {
    script = scriptedModel([textTurn("Hi."), toolTurn("send_email", { to: "sarah@acme.com", body: "Draft" }), textTurn("Sent, and noted.")]);
    const harness = setup();
    const { json: bot } = await harness.call("POST", "/bots", { name: "Peng" });
    await finished(harness.store, bot.chatId, 1);
    await harness.call("POST", `/chats/${bot.chatId}/messages`, { text: "Email Sarah the draft." });
    const approval = await until(() => harness.store.listApprovals("pending")[0]);
    return { ...harness, bot, approval };
  }

  test("a message sent mid-turn reaches the model at its next step, and is marked steered", async () => {
    const { store, call, bot, approval } = await working();
    const { status, json } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Also cc Tom." });
    expect(status).toBe(201);
    expect(json.replies).toEqual([]); // no second turn: it joins the running one
    expect(json.message.delivery).toBe("steer");

    await call("POST", `/approvals/${approval.id}`, { approve: true });
    await finished(store, bot.chatId, 3);
    const nextStep = JSON.stringify(script.prompts.at(-1));
    expect(nextStep).toContain("Added while you were working");
    expect(nextStep).toContain("Also cc Tom.");
    const steered = store.getMessage(json.message.id)!;
    expect(steered).toMatchObject({ delivery: "steer", steeredAt: 1 });
    // The reply splits where you cut in: the step before your message, the rest after it.
    const [, before, yours, after] = store.listMessages(bot.chatId).slice(-4);
    expect(before).toMatchObject({ author: bot.id, status: "done" });
    expect(before.steps).toMatchObject([{ tool: "send_email", status: "done" }]);
    expect(yours.id).toBe(json.message.id);
    expect(after).toMatchObject({ author: bot.id, status: "done", text: "Sent, and noted.", steps: [] });
    // Nothing left over, so no follow-up turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.listMessages(bot.chatId).filter((m) => m.author === bot.id)).toHaveLength(3);
  });

  test("a queued message waits for the turn to end, then gets a turn of its own", async () => {
    const { store, call, bot, approval } = await working();
    const { json } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Then summarise it.", mode: "queue" });
    expect(json.message.delivery).toBe("queued");

    // The running turn keeps its model; the follow-up turn gets this one.
    const firstTurn = script;
    script = scriptedModel([textTurn("Here's the summary.")]);
    await call("POST", `/approvals/${approval.id}`, { approve: true });
    const replies = await finished(store, bot.chatId, 3);
    expect(replies.at(-1)!.text).toBe("Here's the summary.");
    // The first turn never saw it; the follow-up turn did, as an ordinary message.
    expect(JSON.stringify(firstTurn.prompts)).not.toContain("Then summarise it.");
    expect(JSON.stringify(script.prompts.at(-1))).toContain("Then summarise it.");
    expect(store.getMessage(json.message.id)!.delivery).toBeNull();
  });

  test("steer now moves a queued message into the running turn; cancel takes one back", async () => {
    const { store, call, bot, approval } = await working();
    const { json: first } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Use the formal greeting.", mode: "queue" });
    const { json: second } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Never mind that.", mode: "queue" });

    expect((await call("POST", `/messages/${first.message.id}/steer`)).status).toBe(204);
    expect(store.getMessage(first.message.id)!.delivery).toBe("steer");
    expect((await call("DELETE", `/messages/${second.message.id}`)).status).toBe(204);
    expect(store.getMessage(second.message.id)).toBeNull();
    expect((await call("DELETE", `/messages/${first.message.id}`)).status).toBe(409); // not waiting any more

    await call("POST", `/approvals/${approval.id}`, { approve: true });
    await finished(store, bot.chatId, 3);
    expect(JSON.stringify(script.prompts.at(-1))).toContain("Use the formal greeting.");
    expect(JSON.stringify(script.prompts.at(-1))).not.toContain("Never mind that.");
  });

  test("stop clears waiting messages instead of starting another turn", async () => {
    const { store, call, bot } = await working();
    const { json } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "And then the next one.", mode: "queue" });
    await call("POST", `/chats/${bot.chatId}/stop`);
    const replies = await finished(store, bot.chatId, 2);
    expect(replies.at(-1)!.status).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.listMessages(bot.chatId).filter((m) => m.author === bot.id)).toHaveLength(2);
    expect(store.getMessage(json.message.id)!.delivery).toBeNull();
  });
});

describe("durable runs", () => {
  test("a turn that was running picks up from its checkpoint in the same reply, and keeps its approval", async () => {
    script = scriptedModel([textTurn("Hi."), toolTurn("send_email", { to: "sarah@acme.com", body: "Draft" }), textTurn("…")]);
    const { db, store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Email Sarah the draft." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    expect(store.listRuns()).toHaveLength(1);

    // Colony stops here (the old runner just never continues) and starts again.
    const after = restarted(db);
    const resumable = after.store.recoverAfterRestart(15 * 60_000);
    expect(resumable).toHaveLength(1);
    expect(after.store.getApproval(approval.id)!.status).toBe("pending");
    expect(after.store.getMessage(approval.messageId)!.status).toBe("streaming");

    script = scriptedModel([toolTurn("send_email", { to: "sarah@acme.com", body: "Draft" }), textTurn("Sent after the restart.")]);
    after.runner.resumeAll(resumable, 0);
    await until(() => script.prompts.length >= 1);
    expect(JSON.stringify(script.prompts[0])).toContain("Colony restarted while you were working");
    expect(JSON.stringify(script.prompts[0])).toContain("was waiting for the user's approval and did not run");
    // Asking again for the same email re-attaches to the waiting approval instead of asking twice.
    await until(() => after.store.getBot(bot.id)!.presence === "waiting");
    expect(after.store.listApprovals("pending").map((item) => item.id)).toEqual([approval.id]);

    expect(after.gate.resolve(approval.id, true)).toBe(true);
    const reply = await until(() => { const message = after.store.getMessage(approval.messageId)!; return message.status === "done" && message; });
    expect(reply.text).toBe("Sent after the restart.");
    expect(reply.steps.map((step) => [step.tool, step.status])).toEqual([
      ["send_email", "interrupted"], ["colony.restart", "done"], ["send_email", "done"],
    ]);
    expect(reply.steps[1].title).toBe("Colony restarted · picked up from the start");
    expect(sent).toEqual(["sarah@acme.com"]);
    expect(after.store.listRuns()).toEqual([]);
  });

  test("a step that finished just before the restart is reported to the model, not repeated", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { db, store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    const reply = store.createMessage({ chatId: bot.chatId, author: bot.id, status: "streaming" });
    store.updateMessage(reply.id, { text: "Emailing", steps: [{ id: "a", tool: "send_email", title: "Emailed tom@acme.com", status: "done", startedAt: 1, endedAt: 2 }] });
    const conversation = [{ role: "user", content: "Email Tom." }];
    store.saveRun({ id: reply.id, chatId: bot.chatId, botId: bot.id, messageId: reply.id, stepsBefore: 0, startedAt: Date.now(), updatedAt: Date.now(),
      messages: JSON.stringify({ conversation, text: "", reasoning: "", steps: 0 }), options: {} });

    const after = restarted(db);
    script = scriptedModel([textTurn("Done: Tom has the email.")]);
    after.runner.resumeAll(after.store.recoverAfterRestart(15 * 60_000), 0);
    const done = await until(() => { const message = after.store.getMessage(reply.id)!; return message.status === "done" && message; });
    expect(JSON.stringify(script.prompts[0])).toContain("finished just before the restart");
    expect(JSON.stringify(script.prompts[0])).toContain("don't do it again");
    // The half-written text from before the restart is replaced by the resumed reply.
    expect(done.text).toBe("Done: Tom has the email.");
    expect(done.steps[0]).toMatchObject({ tool: "send_email", status: "done" });
    expect(done.steps[1].title).toBe("Colony restarted · picked up from the start");
  });

  test("checkpoints older than a turn can last are not resumed", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { db, store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    const reply = store.createMessage({ chatId: bot.chatId, author: bot.id, status: "streaming" });
    store.saveRun({ id: reply.id, chatId: bot.chatId, botId: bot.id, messageId: reply.id, stepsBefore: 0, startedAt: 0, updatedAt: 0,
      messages: JSON.stringify({ conversation: [], text: "", reasoning: "", steps: 0 }), options: {} });
    const after = restarted(db);
    expect(after.store.recoverAfterRestart(15 * 60_000)).toEqual([]);
    expect(after.store.getMessage(reply.id)!.status).toBe("stopped");
    expect(after.store.listRuns()).toEqual([]);
  });

  test("a finished turn removes its checkpoint", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { store, call } = setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    expect(store.listRuns()).toEqual([]);
  });
});
