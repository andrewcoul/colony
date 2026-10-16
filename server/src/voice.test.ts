import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { WebSocket } from "ws";

/** A pretend OpenAI-compatible audio server: it "hears" a fixed line and "speaks" text as its bytes. */
const heard: string[] = [];
const spoken: string[] = [];
const audioServer = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (request.url === "/v1/audio/transcriptions") {
      heard.push(String(Buffer.concat(chunks).length));
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "What's on today?" }));
    } else if (request.url === "/v1/audio/speech") {
      const { input } = JSON.parse(String(Buffer.concat(chunks))) as { input: string };
      spoken.push(input);
      response.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.from(`mp3:${input}`));
    } else response.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => audioServer.listen(0, "127.0.0.1", resolve));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-voice-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_API_BASE_URL = `http://127.0.0.1:${(audioServer.address() as AddressInfo).port}/v1`;
process.env.COLONY_MODELS = "mock-model";

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { AgentRunner } = await import("./agent/run.js");
const { coreTools } = await import("./agent/tools.js");
const settings = await import("./settings.js");
const { Calls, SentenceSplitter, callTools, speakable } = await import("./voice.js");
settings.loadSettings();

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
let turns: unknown[][] = [];
let call = 0;
const model = new MockLanguageModelV4({
  doStream: async () => ({ stream: convertArrayToReadableStream(turns[Math.min(call++, turns.length - 1)] as never[]) }),
});

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  let calls: InstanceType<typeof Calls>;
  const runner = new AgentRunner(store, events, gate, () => ({ ...coreTools, ...callTools(calls) }), () => model);
  calls = new Calls(store, events, runner);
  const notified: { title: string; path: string }[] = [];
  calls.notify = (input) => notified.push(input);
  const bot = store.createBot({ name: "Ada", title: "Helper", description: "", model: "env::mock-model", computer: false });
  const chat = store.listChats().find((item) => item.kind === "bot" && item.memberIds[0] === bot.id)!;
  const ephemeral: { type: string }[] = [];
  events.subscribe(({ event }) => { if (event.type.startsWith("call.")) ephemeral.push(event); });
  return { store, events, runner, calls, bot, chat, notified, ephemeral };
}

/** Serves the call socket the way index.ts does. */
async function callServer(calls: InstanceType<typeof Calls>) {
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => calls.upgrade(request, socket, head, { id: "owner", login: null, name: "You", color: "#FFE07A", role: "host", createdAt: 0 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
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

beforeEach(() => {
  heard.length = 0;
  spoken.length = 0;
  call = 0;
  settings.setVoiceSettings({ providerId: "env", allowCalls: true, quietFrom: "22:00", quietTo: "07:00" });
});
afterAll(() => {
  audioServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("speech text", () => {
  test("reads markdown the way a person would say it", () => {
    expect(speakable("## Plan\n- **Book** the [hotel](https://x.test)\n```js\nx()\n```\nSee `notes`.")).toBe("Plan Book the hotel See notes.");
  });

  test("hands over each sentence as soon as it's complete", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Your flight is at nine")).toEqual([]);
    expect(splitter.push(". Leave by seven, the roads are busy. And")).toEqual(["Your flight is at nine.", "Leave by seven, the roads are busy."]);
    expect(splitter.push(" pack light")).toEqual([]);
    expect(splitter.flush()).toEqual(["And pack light"]);
  });
});

describe("calls", () => {
  test("what you say is posted as your message and the reply is spoken sentence by sentence", async () => {
    const { store, calls, chat } = setup();
    turns = [textTurn("You have two meetings today. The first is at ten.")];
    const server = await callServer(calls);
    const ws = new WebSocket(`${server.url}/api/chats/${chat.id}/call`);
    const received: (string | Buffer)[] = [];
    ws.on("message", (data, binary) => received.push(binary ? (data as Buffer) : String(data)));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(Buffer.alloc(4000));

    await until(() => received.filter(Buffer.isBuffer).length >= 2);
    const said = store.listMessages(chat.id).find((message) => message.author === "user");
    expect(said).toMatchObject({ text: "What's on today?", via: "voice" });
    expect(spoken).toEqual(["You have two meetings today.", "The first is at ten."]);
    expect(received.filter(Buffer.isBuffer).map(String)).toEqual(["mp3:You have two meetings today.", "mp3:The first is at ten."]);
    expect(received.some((item) => typeof item === "string" && item.includes('"heard"'))).toBe(true);
    ws.close();
    server.close();
  });

  test("a Bot rings you; unanswered, its reason lands in the chat", async () => {
    const { store, calls, chat, bot, notified, ephemeral } = setup();
    expect(calls.ring(bot.id, chat.id, "Your flight was cancelled.", new Date(2026, 9, 15, 12).getTime())).toEqual({ ringing: true });
    expect(notified[0]).toMatchObject({ title: "Ada is calling" });
    const callId = (ephemeral[0] as unknown as { callId: string }).callId;
    expect(notified[0].path).toBe(`${chat.id}?call=${callId}`);
    // Not again within 30 minutes.
    expect(calls.ring(bot.id, chat.id, "Again", new Date(2026, 9, 15, 12, 10).getTime()).ringing).toBe(false);
    calls.miss(callId);
    expect(ephemeral.map((event) => event.type)).toEqual(["call.ringing", "call.ended"]);
    expect(store.listMessages(chat.id).at(-1)).toMatchObject({ author: bot.id, text: "I tried to call you: Your flight was cancelled." });
  });

  test("never during quiet hours, or with calls turned off", () => {
    const { calls, chat, bot } = setup();
    expect(calls.ring(bot.id, chat.id, "Late", new Date(2026, 9, 15, 23, 30).getTime())).toMatchObject({ ringing: false, why: expect.stringContaining("quiet hours") });
    expect(calls.ring(bot.id, chat.id, "Early", new Date(2026, 9, 15, 6, 59).getTime()).ringing).toBe(false);
    settings.setVoiceSettings({ allowCalls: false });
    expect(calls.ring(bot.id, chat.id, "Noon", new Date(2026, 9, 15, 12).getTime())).toMatchObject({ ringing: false, why: expect.stringContaining("off") });
  });

  test("answering opens with the Bot's reason, said aloud and kept in the chat", async () => {
    const { store, calls, chat, bot } = setup();
    calls.ring(bot.id, chat.id, "Your flight was cancelled.", new Date(2026, 9, 15, 12).getTime());
    const callId = [...(calls as unknown as { rings: Map<string, unknown> }).rings.keys()][0];
    const server = await callServer(calls);
    const ws = new WebSocket(`${server.url}/api/chats/${chat.id}/call?answer=${callId}`);
    const audio: Buffer[] = [];
    ws.on("message", (data, binary) => { if (binary) audio.push(data as Buffer); });
    await until(() => audio.length);
    expect(String(audio[0])).toBe("mp3:Your flight was cancelled.");
    expect(store.listMessages(chat.id).at(-1)).toMatchObject({ author: bot.id, text: "Your flight was cancelled.", via: "voice" });
    ws.close();
    server.close();
  });

  test("the call_user tool tells the Bot whether it rang", async () => {
    const { store, runner, chat, bot, notified } = setup();
    settings.setVoiceSettings({ allowCalls: false });
    turns = [toolTurn("call_user", { reason: "Need you" }), textTurn("I'll write it here instead.")];
    store.createMessage({ chatId: chat.id, author: "user", text: "Ping me if it breaks" });
    runner.start(chat.id, bot.id);
    await until(() => store.listMessages(chat.id).find((message) => message.author === bot.id && message.status === "done"));
    expect(notified).toEqual([]);
  });
});
