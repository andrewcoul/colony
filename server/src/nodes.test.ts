import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { WebSocket } from "ws";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-nodes-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_API_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_MODELS = "mock-model";

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { AgentRunner } = await import("./agent/run.js");
const { coreTools } = await import("./agent/tools.js");
const { NodeHub, pcToolsFor } = await import("./nodes.js");
(await import("./settings.js")).loadSettings();

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const textTurn = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const toolTurn = (toolName: string, input: unknown, id = toolName) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `call-${id}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
];
let turns: unknown[][] = [];
let call = 0;
const toolNames: string[][] = [];
const model = new MockLanguageModelV4({
  doStream: async (options) => {
    toolNames.push((options.tools ?? []).map((item) => item.name));
    return { stream: convertArrayToReadableStream(turns[Math.min(call++, turns.length - 1)] as never[]) };
  },
});

async function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const hub = new NodeHub(store, events);
  const runner = new AgentRunner(store, events, gate, (botId) => ({ ...coreTools, ...pcToolsFor(hub, store, botId) }), () => model);
  hub.stopBot = (botId) => runner.stopBot(botId);
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => hub.upgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/nodes/connect`;
  const bot = store.createBot({ name: "Luke", title: "", description: "", model: "env::mock-model", computer: false });
  const chat = store.listChats().find((item) => item.kind === "bot")!;
  return { store, gate, hub, runner, bot, chat, url, close: () => server.close() };
}

/** A pretend desktop app: an MCP server over the socket, with the switches given. */
async function fakePc(url: string, capabilities: string[]) {
  const calls: { name: string; arguments: unknown; meta: unknown }[] = [];
  const tools = () => [
    ...(capabilities.includes("browser") ? ["pc_browser_open", "pc_browser_read", "pc_browser_click", "pc_browser_type"] : []),
    ...(capabilities.includes("screen") ? ["pc_screenshot"] : []),
    ...(capabilities.includes("shell") ? ["pc_shell"] : []),
  ].map((name) => ({ name, inputSchema: { type: "object" } }));
  const ws = new WebSocket(url);
  ws.on("message", (data) => {
    const message = JSON.parse(String(data)) as { id: number; method: string; params: { name: string; arguments: unknown; _meta: unknown } };
    const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pc" } });
    if (message.method === "tools/list") reply({ tools: tools() });
    if (message.method === "tools/call") {
      calls.push({ name: message.params.name, arguments: message.params.arguments, meta: message.params._meta });
      reply({ content: [{ type: "text", text: `window 1 · Example Domain · ${JSON.stringify(message.params.arguments)}` }] });
    }
  });
  await new Promise((resolve) => ws.once("open", resolve));
  const hello = () => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "node/hello", params: { id: "pc-andrew-0001", name: "Andrew's PC", platform: "win32", capabilities } }));
  hello();
  return {
    ws, calls,
    setCapabilities: (next: string[]) => { capabilities = next; hello(); },
    stop: () => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "node/stop" })),
  };
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

describe("This PC", () => {
  test("a PC registers, and Bots only get what its switches and their level allow", async () => {
    const { store, hub, bot, url, close } = await setup();
    const pc = await fakePc(url, ["browser", "shell"]);
    await until(() => hub.offered("pc-andrew-0001").size > 0);
    expect(hub.list()).toMatchObject([{ id: "pc-andrew-0001", name: "Andrew's PC", online: true, capabilities: ["browser", "shell"] }]);
    // Nothing until you grant it.
    expect(Object.keys(pcToolsFor(hub, store, bot.id))).toEqual([]);
    store.setNodeAccess(bot.id, "pc-andrew-0001", 1);
    expect(Object.keys(pcToolsFor(hub, store, bot.id))).toEqual(["pc_browser_open", "pc_browser_read", "pc_browser_click", "pc_browser_type"]);
    store.setNodeAccess(bot.id, "pc-andrew-0001", 2);
    expect(Object.keys(pcToolsFor(hub, store, bot.id))).toContain("pc_shell");
    // Switching the terminal off on the PC wins over the level.
    pc.setCapabilities(["browser"]);
    await until(() => !hub.offered("pc-andrew-0001").has("pc_shell"));
    expect(Object.keys(pcToolsFor(hub, store, bot.id))).not.toContain("pc_shell");
    pc.ws.close();
    await until(() => !hub.list()[0].online);
    expect(Object.keys(pcToolsFor(hub, store, bot.id))).toEqual([]);
    close();
  });

  test("browser use asks once per task, naming the PC; the terminal asks every time", async () => {
    const { store, gate, hub, runner, bot, chat, url, close } = await setup();
    const pc = await fakePc(url, ["browser", "shell"]);
    await until(() => hub.offered("pc-andrew-0001").size > 0);
    store.setNodeAccess(bot.id, "pc-andrew-0001", 2);
    call = 0;
    turns = [
      toolTurn("pc_browser_open", { url: "https://example.com" }, "a"),
      toolTurn("pc_browser_read", {}, "b"),
      toolTurn("pc_browser_click", { text: "More" }, "c"),
      toolTurn("pc_shell", { command: "dir" }, "d"),
      textTurn("Done."),
    ];
    store.createMessage({ chatId: chat.id, author: "user", text: "Check example.com on my PC" });
    runner.start(chat.id, bot.id);

    const first = await until(() => store.listApprovals("pending")[0]);
    expect(first.summary).toBe("Luke wants to use the browser on Andrew's PC");
    gate.resolve(first.id, true);
    // Reading and clicking ran without asking again; the terminal asks.
    const second = await until(() => store.listApprovals("pending")[0]);
    expect(second.summary).toBe("Luke wants to use Andrew's PC");
    expect(second.detail).toContain("Run: dir");
    expect(pc.calls.map((item) => item.name)).toEqual(["pc_browser_open", "pc_browser_read", "pc_browser_click"]);
    gate.resolve(second.id, true);
    await until(() => store.listMessages(chat.id).find((message) => message.author === bot.id && message.status === "done"));
    expect(pc.calls.at(-1)).toMatchObject({ name: "pc_shell", arguments: { command: "dir" }, meta: { botName: "Luke" } });
    pc.ws.close();
    close();
  });

  test("Stop on the PC stops the Bot that's driving it", async () => {
    const { store, gate, hub, runner, bot, chat, url, close } = await setup();
    const pc = await fakePc(url, ["browser", "shell"]);
    await until(() => hub.offered("pc-andrew-0001").size > 0);
    store.setNodeAccess(bot.id, "pc-andrew-0001", 2);
    call = 0;
    turns = [toolTurn("pc_browser_open", { url: "https://example.com" }), toolTurn("pc_shell", { command: "dir" }), textTurn("Done.")];
    store.createMessage({ chatId: chat.id, author: "user", text: "Go" });
    runner.start(chat.id, bot.id);
    gate.resolve((await until(() => store.listApprovals("pending")[0])).id, true);
    // Waiting on the terminal approval: the person hits Stop on the PC.
    await until(() => store.listApprovals("pending")[0]);
    pc.stop();
    await until(() => !runner.isBotRunning(bot.id));
    expect(pc.calls.map((item) => item.name)).toEqual(["pc_browser_open"]);
    pc.ws.close();
    close();
  });
});
