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
const files = await import("../files.js");
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
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      const chunks = turns[Math.min(call++, turns.length - 1)];
      return { stream: convertArrayToReadableStream(chunks as never[]) };
    },
  });
  return { model, prompts };
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
  const api = createApi({ store, events, gate, runner });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: (response.status === 204 ? null : await response.json()) as any };
  };
  return { store, events, runner, call };
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

  test("unknown models fall back to the default", async () => {
    script = scriptedModel([textTurn("Hi.")]);
    const { call } = setup();
    expect((await call("POST", "/bots", { name: "A", model: "expensive-unlisted" })).json.model).toBe("mock-model");
    expect((await call("POST", "/bots", { name: "B", model: "other-model" })).json.model).toBe("other-model");
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

  test("after a restart, streaming replies are stopped and pending approvals expire", () => {
    const { store } = setup();
    const bot = store.createBot({ name: "Ghost", title: "", description: "", model: "mock-model", computer: false });
    const message = store.createMessage({ chatId: bot.chatId, author: bot.id, status: "streaming" });
    const approval = store.createApproval({ botId: bot.id, chatId: bot.chatId, messageId: message.id, tool: "x", summary: "s", detail: "d", reason: "" });
    store.recoverAfterRestart();
    expect(store.getMessage(message.id)!.status).toBe("stopped");
    expect(store.getApproval(approval.id)!.status).toBe("expired");
  });
});
