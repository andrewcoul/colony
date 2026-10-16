import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

// Config is read at import time, so point it at a temp data dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-pi-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_API_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_MODELS = "mock-model,other-model";

const { openDb } = await import("../../db.js");
const { EventLog } = await import("../../events.js");
const { Store } = await import("../../store.js");
const { ApprovalGate } = await import("../approvals.js");
const { PiRunner } = await import("./runner.js");
const { coreTools } = await import("../tools.js");
const { createApi } = await import("../../api.js");
const { RoutineScheduler } = await import("../../routines.js");
const { MemoryStorage } = await import("@earendil-works/pi-durable");
const files = await import("../../files.js");
const { scriptedModels, textTurn, toolTurn, promptText } = await import("./testkit.js");
(await import("../../settings.js")).loadSettings();
type ColonyTool = import("../tools.js").ColonyTool;

const sent: string[] = [];
const sendEmail: ColonyTool = {
  description: "Send an email (needs approval).",
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  describe: ({ to }) => `Emailed ${to}`,
  replay: "gated",
  execute: async ({ to, body }, ctx) => {
    const ok = await ctx.gate.request({ botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: "send_email",
      summary: `${ctx.botName} wants to send an email`, detail: `To: ${to}\n\n${body}`, reason: "Sends outside your PC" }, ctx.signal);
    if (!ok) throw new Error("Approval denied by the user.");
    sent.push(to);
    return { sent: true };
  },
};

const scripted = scriptedModels();
const tools = () => ({ ...coreTools, send_email: sendEmail });

async function setup(options: { models?: typeof scripted; settings?: Parameters<typeof PiRunner.open>[4]["settings"] } = {}) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = await PiRunner.open(store, events, gate, tools, { storage: new MemoryStorage(), models: (options.models ?? scripted).source, settings: options.settings });
  const routines = new RoutineScheduler(store, runner);
  const api = createApi({ store, events, gate, runner, routines });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    return { status: response.status, json: json as any };
  };
  return { db, store, events, gate, runner, routines, call };
}

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
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

describe("pi runtime: Bots", () => {
  test("a new Bot introduces itself; tool calls become titled steps, and memory reaches the next prompt", async () => {
    const script = scripted.play([textTurn("Hi, I'm Kenny."), toolTurn("memory", { action: "add", target: "memory", entry: "Prefers replies under 3 lines" }), textTurn("Noted.")]);
    const { store, call } = await setup();
    const { json: bot } = await call("POST", "/bots", { name: "Kenny" });
    const [intro] = await finished(store, bot.chatId, 1);
    expect(intro).toMatchObject({ text: "Hi, I'm Kenny.", status: "done" });
    expect(store.getBot(bot.id)!.presence).toBe("done");
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Keep replies short please." });
    const reply = (await finished(store, bot.chatId, 2)).at(-1)!;
    expect(reply.text).toBe("Noted.");
    expect(reply.steps).toMatchObject([{ tool: "memory", title: "Saved to memory", status: "done" }]);
    expect(files.readEntries(bot.id, "memory")).toEqual(["Prefers replies under 3 lines"]);
    expect(promptText(script.prompts.at(-1))).toContain("Prefers replies under 3 lines");
    expect(store.listRuns()).toEqual([]);
  });

  test("text before and after a tool call reads as separate paragraphs", async () => {
    scripted.play([textTurn("Hi."), toolTurn("memory", { action: "add", target: "memory", entry: "x" }, "Checking."), textTurn("Done.")]);
    const { store, call } = await setup();
    const { json: bot } = await call("POST", "/bots", { name: "Kenny" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Go." });
    expect((await finished(store, bot.chatId, 2)).at(-1)!.text).toBe("Checking.\n\nDone.");
  });

  test("a Bot keeps one conversation per chat: later turns see earlier ones, and what other Bots said", async () => {
    const script = scripted.play([textTurn("Hi."), textTurn("Hi."), textTurn("The blue one."), textTurn("Build is green."), textTurn("You picked the blue one, and Jenny says the build is green.")]);
    const { store, call } = await setup();
    const { json: kenny } = await call("POST", "/bots", { name: "Kenny" });
    const { json: jenny } = await call("POST", "/bots", { name: "Jenny" });
    await finished(store, kenny.chatId, 1);
    await finished(store, jenny.chatId, 1);
    const { json: topic } = await call("POST", "/topics", { title: "Launch", memberIds: [kenny.id, jenny.id], coordinatorId: kenny.id });
    await call("POST", `/chats/${topic.id}/messages`, { text: "Which colour did we pick? Answer: the blue one." });
    await finished(store, topic.id, 1);
    await call("POST", `/chats/${topic.id}/messages`, { text: "@Jenny is the build green?" });
    await finished(store, topic.id, 2);
    await call("POST", `/chats/${topic.id}/messages`, { text: "Recap please." });
    await finished(store, topic.id, 3);
    const last = promptText(script.prompts.at(-1));
    // Kenny's own earlier turn is in his conversation, and Jenny's answer reached it as "[Jenny]: …".
    expect(last).toContain("Which colour did we pick?");
    expect(last).toContain("The blue one.");
    expect(last).toContain("[Jenny]: Build is green.");
    expect(last).toContain("@Jenny is the build green?");
    // Each Bot has its own conversation in the topic.
    expect(store.conversationOf(topic.id, kenny.id)).not.toBeNull();
    expect(store.conversationOf(topic.id, jenny.id)!.conversationId).not.toBe(store.conversationOf(topic.id, kenny.id)!.conversationId);
  });

  test("a chat from before the conversation starts it with its recent history", async () => {
    const script = scripted.play([textTurn("Picking up from where we were.")]);
    const { store, call } = await setup();
    const bot = store.createBot({ name: "Old", title: "", description: "", model: "env::mock-model", computer: false });
    store.createMessage({ chatId: bot.chatId, author: "user", text: "We decided on Lisbon." });
    store.createMessage({ chatId: bot.chatId, author: bot.id, text: "Lisbon it is." });
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Where are we going?" });
    await finished(store, bot.chatId, 2);
    const first = promptText(script.prompts[0]);
    expect(first).toContain("We decided on Lisbon.");
    expect(first).toContain("Lisbon it is.");
    expect(first).toContain("Where are we going?");
  });
});

describe("pi runtime: approvals", () => {
  test("approve lets the action run; the Bot waits and shows a card meanwhile", async () => {
    scripted.play([textTurn("Hi."), toolTurn("send_email", { to: "sarah@acme.com", body: "Moving Friday's review to 2 PM." }), textTurn("Sent.")]);
    const { store, call } = await setup();
    const { json: bot } = await call("POST", "/bots", { name: "Peng" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Email Sarah about the review." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    expect(approval.detail).toContain("sarah@acme.com");
    expect(store.getBot(bot.id)!.presence).toBe("waiting");
    expect(store.getMessage(approval.messageId)!.cards).toEqual([{ type: "approval", approvalId: approval.id }]);
    expect(sent).toEqual([]);
    expect((await call("POST", `/approvals/${approval.id}`, { approve: true })).status).toBe(204);
    const done = (await finished(store, bot.chatId, 2)).at(-1)!;
    expect(sent).toEqual(["sarah@acme.com"]);
    expect(done.steps[0]).toMatchObject({ title: "Emailed sarah@acme.com", status: "done" });
    expect(done.text).toBe("Sent.");
  });

  test("deny fails closed: nothing is sent and the step is marked denied", async () => {
    scripted.play([textTurn("Hi."), toolTurn("send_email", { to: "x@y.com", body: "hi" }), textTurn("Okay, I won't send it.")]);
    const { store, call } = await setup();
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
    scripted.play([textTurn("Hi."), toolTurn("send_email", { to: "x@y.com", body: "hi" }), textTurn("…")]);
    const { store, call } = await setup();
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

describe("pi runtime: Bots messaging each other", () => {
  test("a Bot asks a teammate in a private thread and gets a handoff card", async () => {
    const script = scripted.play([
      textTurn("Hi."), textTurn("Hi."),
      toolTurn("message_bot", { to: "John", message: "Is the build green?" }),
      textTurn("Yes, all 212 tests pass."),
      textTurn("John says the build is green."),
    ]);
    const { store, call } = await setup();
    const { json: kenny } = await call("POST", "/bots", { name: "Kenny", title: "Chief of staff" });
    await finished(store, kenny.chatId, 1);
    const { json: john } = await call("POST", "/bots", { name: "John", title: "Engineer", description: "Owns the build." });
    await finished(store, john.chatId, 1);
    await call("POST", `/chats/${kenny.chatId}/messages`, { text: "Ask John if the build is green." });
    const reply = (await finished(store, kenny.chatId, 2)).at(-1)!;
    expect(reply.text).toBe("John says the build is green.");
    expect(reply.steps[0]).toMatchObject({ title: "Messaged John", detail: "John replied", status: "done" });
    const thread = store.findThread(kenny.id, john.id)!;
    expect(reply.cards).toEqual([{ type: "handoff", threads: [{ botId: john.id, chatId: thread.id, count: 2 }] }]);
    expect(store.listMessages(thread.id).map((m) => [m.author, m.text])).toEqual([[kenny.id, "Is the build green?"], [john.id, "Yes, all 212 tests pass."]]);
    expect(promptText(script.prompts[2])).toContain("John, Engineer: Owns the build.");
    expect(promptText(script.prompts[3])).toContain("private thread with Kenny");
    expect(promptText(script.prompts[3])).toContain("[Kenny]: Is the build green?");
    expect(script.toolNames[2]).toContain("message_bot");
    expect(script.toolNames[3]).not.toContain("message_bot");
  });

  test("stopping the asker stops the teammate's answer, and its pending approval is denied", async () => {
    scripted.play([
      textTurn("Hi."), textTurn("Hi."),
      toolTurn("message_bot", { to: "John", message: "Email the client." }),
      toolTurn("send_email", { to: "client@acme.com", body: "Update" }),
      textTurn("…"),
    ]);
    const { store, call } = await setup();
    const { json: kenny } = await call("POST", "/bots", { name: "Kenny" });
    await finished(store, kenny.chatId, 1);
    const { json: john } = await call("POST", "/bots", { name: "John" });
    await finished(store, john.chatId, 1);
    await call("POST", `/chats/${kenny.chatId}/messages`, { text: "Get John to email the client." });
    const approval = await until(() => store.listApprovals("pending")[0]);
    await call("POST", `/chats/${kenny.chatId}/stop`);
    expect((await finished(store, kenny.chatId, 2)).at(-1)!.status).toBe("stopped");
    const thread = store.findThread(kenny.id, john.id)!;
    expect((await until(() => { const last = store.listMessages(thread.id).at(-1)!; return last.status !== "streaming" && last; })).status).toBe("stopped");
    expect(store.getApproval(approval.id)!.status).toBe("denied");
    expect(sent).toEqual([]);
  });
});

describe("pi runtime: steering", () => {
  async function working(more: ReturnType<typeof textTurn>[] = []) {
    const script = scripted.play([textTurn("Hi."), toolTurn("send_email", { to: "sarah@acme.com", body: "Draft" }), textTurn("Sent, and noted."), ...more]);
    const harness = await setup();
    const { json: bot } = await harness.call("POST", "/bots", { name: "Peng" });
    await finished(harness.store, bot.chatId, 1);
    await harness.call("POST", `/chats/${bot.chatId}/messages`, { text: "Email Sarah the draft." });
    const approval = await until(() => harness.store.listApprovals("pending")[0]);
    return { ...harness, bot, approval, script };
  }

  test("a message sent mid-turn reaches the model at its next step, and is marked steered", async () => {
    const { store, call, bot, approval, script } = await working();
    const { status, json } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Also cc Tom." });
    expect(status).toBe(201);
    expect(json.replies).toEqual([]);
    expect(json.message.delivery).toBe("steer");
    await call("POST", `/approvals/${approval.id}`, { approve: true });
    await finished(store, bot.chatId, 3);
    const nextStep = promptText(script.prompts.at(-1));
    expect(nextStep).toContain("Added while you were working");
    expect(nextStep).toContain("Also cc Tom.");
    expect(store.getMessage(json.message.id)).toMatchObject({ delivery: "steer", steeredAt: 1 });
    const [, before, yours, after] = store.listMessages(bot.chatId).slice(-4);
    expect(before).toMatchObject({ author: bot.id, status: "done" });
    expect(before.steps).toMatchObject([{ tool: "send_email", status: "done" }]);
    expect(yours.id).toBe(json.message.id);
    expect(after).toMatchObject({ author: bot.id, status: "done", text: "Sent, and noted.", steps: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.listMessages(bot.chatId).filter((m) => m.author === bot.id)).toHaveLength(3);
  });

  test("a queued message waits for the turn to end, then gets a turn of its own", async () => {
    const { store, call, bot, approval, script } = await working([textTurn("Here's the summary.")]);
    const { json } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Then summarise it.", mode: "queue" });
    expect(json.message.delivery).toBe("queued");
    await call("POST", `/approvals/${approval.id}`, { approve: true });
    const replies = await finished(store, bot.chatId, 3);
    expect(replies.at(-1)!.text).toBe("Here's the summary.");
    // The first turn never saw it; the follow-up turn did, as an ordinary message.
    expect(script.prompts.slice(0, 3).map(promptText).join()).not.toContain("Then summarise it.");
    expect(promptText(script.prompts[3])).toContain("Then summarise it.");
    expect(store.getMessage(json.message.id)!.delivery).toBeNull();
  });

  test("steer now moves a queued message into the running turn; cancel takes one back", async () => {
    const { store, call, bot, approval, script } = await working();
    const { json: first } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Use the formal greeting.", mode: "queue" });
    const { json: second } = await call("POST", `/chats/${bot.chatId}/messages`, { text: "Never mind that.", mode: "queue" });
    expect((await call("POST", `/messages/${first.message.id}/steer`)).status).toBe(204);
    expect(store.getMessage(first.message.id)!.delivery).toBe("steer");
    expect((await call("DELETE", `/messages/${second.message.id}`)).status).toBe(204);
    expect(store.getMessage(second.message.id)).toBeNull();
    await call("POST", `/approvals/${approval.id}`, { approve: true });
    await finished(store, bot.chatId, 3);
    expect(promptText(script.prompts.at(-1))).toContain("Use the formal greeting.");
    expect(promptText(script.prompts.at(-1))).not.toContain("Never mind that.");
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

describe("pi runtime: routines and usage", () => {
  test("a routine runs in its chat's conversation, with its card, and every response records its usage", async () => {
    const script = scripted.play([textTurn("Hi."), textTurn("Morning brief: all quiet.")]);
    const { store, call, routines } = await setup();
    const { json: bot } = await call("POST", "/bots", { name: "Ava" });
    await finished(store, bot.chatId, 1);
    const routine = store.createRoutine({ botId: bot.id, chatId: bot.chatId, title: "Morning brief", prompt: "Brief me.", schedule: { type: "interval", minutes: 60 } });
    routines.run(routine.id, { manual: true });
    const reply = (await finished(store, bot.chatId, 2)).at(-1)!;
    expect(reply.text).toBe("Morning brief: all quiet.");
    expect(reply.cards).toMatchObject([{ type: "routine", title: "Morning brief" }]);
    expect(promptText(script.prompts.at(-1))).toContain("Brief me.");
    expect(store.listUsage(0).map((row) => row.botId)).toEqual([bot.id, bot.id]);
  });
});

describe("pi runtime: compaction", () => {
  test("near the context window the conversation is compacted: the model sees a summary and the recent turns", async () => {
    const small = scriptedModels({ contextWindow: 6500 });
    const script = small.play([textTurn("Hi."), ...Array.from({ length: 8 }, (_, index) => textTurn(`Noted part ${index + 1}.`))]);
    const { store, call } = await setup({ models: small, settings: { compaction: { reserveTokens: 2000, keepRecentTokens: 600, backgroundTokens: 0 } } });
    const { json: bot } = await call("POST", "/bots", { name: "Archie" });
    await finished(store, bot.chatId, 1);
    for (let turn = 1; turn <= 8; turn++) {
      await call("POST", `/chats/${bot.chatId}/messages`, { text: `Part ${turn}: ${"lorem ipsum dolor sit amet ".repeat(60)}` });
      await finished(store, bot.chatId, turn + 1);
    }
    expect(script.summaries).toBeGreaterThan(0);
    const last = promptText(script.prompts.at(-1));
    expect(last).toContain("compacted into the following summary");
    expect(last).toContain("Part 8:");
    expect(last).not.toContain("Part 1:");
    const replies = store.listMessages(bot.chatId).filter((message) => message.author === bot.id);
    expect(replies.flatMap((message) => message.steps).map((step) => step.title)).toContain("Compacted the earlier conversation");
  });

  test("Compact now and Start fresh, from the chat menu", async () => {
    const script = scripted.play([textTurn("Hi."), textTurn("Got it: the code is 4417."), textTurn("I don't know any code.")]);
    const { store, call } = await setup();
    const { json: bot } = await call("POST", "/bots", { name: "Sage" });
    await finished(store, bot.chatId, 1);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Remember the code 4417." });
    await finished(store, bot.chatId, 2);
    expect((await call("GET", "/state")).json.persistent).toBe(true);
    expect((await call("POST", `/chats/${bot.chatId}/compact`)).status).toBe(204);
    expect(store.listMessages(bot.chatId).at(-1)).toMatchObject({ author: "system" });
    expect((await call("POST", `/chats/${bot.chatId}/fresh`)).status).toBe(204);
    expect(store.listMessages(bot.chatId).at(-1)!.text).toContain("starts fresh");
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "What's the code?" });
    await finished(store, bot.chatId, 3);
    const after = promptText(script.prompts.at(-1));
    expect(after).toContain("What's the code?");
    expect(after).not.toContain("4417");
  });
});
