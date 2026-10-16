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
const model = new MockLanguageModelV4({
  doStream: async () => ({ stream: convertArrayToReadableStream(turns[Math.min(call++, turns.length - 1)] as never[]) }),
});

/** Two Bots, Luke and Ivy, and a server your PCs connect to. */
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
  const luke = store.createBot({ name: "Luke", title: "", description: "", model: "env::mock-model", computer: false });
  const ivy = store.createBot({ name: "Ivy", title: "", description: "", model: "env::mock-model", computer: false });
  return { store, gate, hub, runner, luke, ivy, url, close: () => server.close() };
}

/** A pretend desktop app lending a PC: an MCP server over the socket, with the switches given. */
async function fakePc(url: string, id: string, name: string, capabilities: string[]) {
  const calls: { name: string; arguments: unknown; meta: { botName?: string; ownerName?: string | null } }[] = [];
  const tools = () => [
    ...(capabilities.includes("browser") ? ["pc_browser_open", "pc_browser_read", "pc_browser_click", "pc_browser_type"] : []),
    ...(capabilities.includes("screen") ? ["pc_screenshot"] : []),
    ...(capabilities.includes("shell") ? ["pc_shell"] : []),
  ].map((tool) => ({ name: tool, inputSchema: { type: "object" } }));
  const ws = new WebSocket(url);
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  ws.on("message", (data) => {
    const message = JSON.parse(String(data)) as { id: number; method: string; params: { name: string; arguments: unknown; _meta: { botName?: string; ownerName?: string | null } } };
    const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pc" } });
    if (message.method === "tools/list") reply({ tools: tools() });
    if (message.method === "tools/call") {
      calls.push({ name: message.params.name, arguments: message.params.arguments, meta: message.params._meta });
      reply({ content: [{ type: "text", text: `${name}: ${JSON.stringify(message.params.arguments)}` }] });
    }
  });
  await new Promise((resolve) => ws.once("open", resolve));
  const hello = () => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "node/hello", params: { id, name, platform: "win32", capabilities } }));
  hello();
  return {
    ws, calls, closed,
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
  test("every Bot can use a lent PC, within its switches", async () => {
    const { store, hub, luke, ivy, url, close } = await setup();
    const laptop = await fakePc(url, "pc-laptop-0001", "Laptop", ["browser", "shell"]);
    await until(() => hub.offered("pc-laptop-0001").size > 0);
    expect(hub.list()).toMatchObject([{ id: "pc-laptop-0001", name: "Laptop", online: true }]);
    expect(Object.keys(pcToolsFor(hub, store, luke.id))).toEqual(["pc_browser_open", "pc_browser_read", "pc_browser_click", "pc_browser_type", "pc_shell"]);
    expect(Object.keys(pcToolsFor(hub, store, ivy.id))).toContain("pc_shell");
    // The PC's switches win.
    laptop.setCapabilities(["browser"]);
    await until(() => !hub.offered("pc-laptop-0001").has("pc_shell"));
    expect(Object.keys(pcToolsFor(hub, store, luke.id))).not.toContain("pc_shell");
    laptop.ws.close();
    await until(() => !hub.list()[0].online);
    expect(Object.keys(pcToolsFor(hub, store, luke.id))).toEqual([]);
    close();
  });

  test("a Bot asks you first: the browser once per task, the terminal every time", async () => {
    const { store, gate, hub, runner, luke, url, close } = await setup();
    const laptop = await fakePc(url, "pc-laptop-0001", "Laptop", ["browser", "shell"]);
    await until(() => hub.offered("pc-laptop-0001").size > 0);
    call = 0;
    turns = [
      toolTurn("pc_browser_open", { url: "https://example.com" }, "a"),
      toolTurn("pc_browser_click", { text: "More" }, "b"),
      toolTurn("pc_shell", { command: "lp boarding.pdf" }, "c"),
      textTurn("Printed."),
    ];
    store.createMessage({ chatId: luke.chatId, author: "user", text: "Print the boarding passes" });
    runner.start(luke.chatId, luke.id);

    const first = await until(() => store.listApprovals("pending")[0]);
    expect(first).toMatchObject({ summary: "Luke wants to use the browser on Laptop" });
    gate.resolve(first.id, true);
    const second = await until(() => store.listApprovals("pending")[0]);
    expect(second).toMatchObject({ summary: "Luke wants to use Laptop" });
    expect(second.detail).toContain("Run: lp boarding.pdf");
    gate.resolve(second.id, true);
    await until(() => store.listMessages(luke.chatId).find((message) => message.author === luke.id && message.text === "Printed."));
    expect(laptop.calls.map((item) => item.name)).toEqual(["pc_browser_open", "pc_browser_click", "pc_shell"]);
    // The pill on the laptop names the Bot.
    expect(laptop.calls[0].meta).toMatchObject({ botName: "Luke" });
    laptop.ws.close();
    close();
  });

  test("with several PCs, a Bot uses the most recent one unless it names another", async () => {
    const { store, gate, hub, runner, luke, url, close } = await setup();
    const laptop = await fakePc(url, "pc-laptop-0001", "Laptop", ["shell"]);
    await until(() => hub.offered("pc-laptop-0001").size > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const desktop = await fakePc(url, "pc-desktop-0001", "Desktop", ["shell"]);
    await until(() => hub.offered("pc-desktop-0001").size > 0);
    call = 0;
    turns = [toolTurn("pc_shell", { command: "hostname" }, "a"), toolTurn("pc_shell", { command: "hostname", pc: "LAPTOP" }, "b"), textTurn("Done.")];
    store.createMessage({ chatId: luke.chatId, author: "user", text: "Check both" });
    runner.start(luke.chatId, luke.id);
    const first = await until(() => store.listApprovals("pending")[0]);
    expect(first.summary).toBe("Luke wants to use Desktop");
    gate.resolve(first.id, true);
    const second = await until(() => store.listApprovals("pending").find((approval) => approval.id !== first.id));
    expect(second.summary).toBe("Luke wants to use Laptop");
    gate.resolve(second.id, true);
    await until(() => store.listMessages(luke.chatId).find((message) => message.author === luke.id && message.text === "Done."));
    expect(desktop.calls.map((item) => item.arguments)).toEqual([{ command: "hostname" }]);
    expect(laptop.calls.map((item) => item.arguments)).toEqual([{ command: "hostname" }]);
    desktop.ws.close();
    laptop.ws.close();
    close();
  });

  test("Stop on the PC stops whichever Bot is driving it", async () => {
    const { store, gate, hub, runner, luke, url, close } = await setup();
    const laptop = await fakePc(url, "pc-laptop-0001", "Laptop", ["browser", "shell"]);
    await until(() => hub.offered("pc-laptop-0001").size > 0);
    call = 0;
    turns = [toolTurn("pc_browser_open", { url: "https://example.com" }), toolTurn("pc_shell", { command: "dir" }), textTurn("Done.")];
    store.createMessage({ chatId: luke.chatId, author: "user", text: "Go" });
    runner.start(luke.chatId, luke.id);
    gate.resolve((await until(() => store.listApprovals("pending")[0])).id, true);
    await until(() => store.listApprovals("pending")[0]);
    laptop.stop();
    await until(() => !runner.isBotRunning(luke.id));
    expect(laptop.calls.map((item) => item.name)).toEqual(["pc_browser_open"]);
    laptop.ws.close();
    close();
  });
});
