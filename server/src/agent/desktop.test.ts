import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-desktop-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_API_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_MODELS = "sees-model,blind-model";

const { openDb } = await import("../db.js");
const { EventLog } = await import("../events.js");
const { Store } = await import("../store.js");
const { ApprovalGate } = await import("./approvals.js");
const { AgentRunner } = await import("./run.js");
const { coreTools } = await import("./tools.js");
const { createApi } = await import("../api.js");
const { checkDesktop } = await import("./desktopCheck.js");
const { prepareDesktopMessages } = await import("./desktopTools.js");
const settings = await import("../settings.js");
settings.loadSettings();

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: "stop" | "tool-calls") => ({ type: "finish", finishReason: { unified, raw: unified }, usage });
const textTurn = (text: string) => [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, finish("stop")];
const toolTurn = (toolName: string, input: unknown) => [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }, finish("tool-calls")];

/** Plays back turns; records each call's prompt so tests can see what the model was shown. */
function scripted(turns: unknown[][]) {
  const prompts: any[] = [];
  let call = 0;
  return {
    prompts,
    model: new MockLanguageModelV4({
      doStream: async (options) => { prompts.push(options.prompt); return { stream: convertArrayToReadableStream(turns[Math.min(call++, turns.length - 1)] as never[]) }; },
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        const text = String((turns[Math.min(call++, turns.length - 1)] as any)[2]?.delta ?? "");
        return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] } as never;
      },
    }),
  };
}

const shot = { data: Buffer.from("fake-jpeg").toString("base64"), mediaType: "image/jpeg" as const, width: 1280, height: 800 };
const actions: string[] = [];
const fakeDesktop = {
  screenshot: async () => { actions.push("screenshot"); return shot; },
  click: async (_id: string, x: number, y: number) => { actions.push(`click ${x},${y}`); },
  type: async (_id: string, text: string) => { actions.push(`type ${text}`); },
  key: async (_id: string, keys: string) => { actions.push(`key ${keys}`); },
} as never;

function setup(model: ReturnType<typeof scripted>) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = new AgentRunner(store, events, gate, () => ({ ...coreTools }), () => model.model, fakeDesktop);
  const api = createApi({ store, events, gate, runner, modelFactory: () => model.model });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    return { status: response.status, json: json as any };
  };
  return { store, runner, call };
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

describe("desktop", () => {
  test("only models that can drive a desktop are allowed while the desktop is on", async () => {
    const model = scripted([textTurn("Hi.")]);
    const { call } = setup(model);
    settings.setDesktopModels("env", { "sees-model": true, "blind-model": false });
    expect(settings.modelOptions().map((option) => [option.model, option.desktop])).toEqual([["sees-model", true], ["blind-model", false]]);

    expect((await call("POST", "/bots", { name: "A", computer: true, desktop: true, model: "env::blind-model" })).status).toBe(400);
    expect((await call("POST", "/bots", { name: "B", computer: false, desktop: true, model: "env::sees-model" })).status).toBe(400);
    const { json: bot } = await call("POST", "/bots", { name: "C", computer: true, desktop: true, model: "env::sees-model" });
    expect(bot).toMatchObject({ computer: true, desktop: true });
    // Switching to a model that can't see, while the desktop is on, is refused…
    expect((await call("PATCH", `/bots/${bot.id}`, { model: "env::blind-model" })).status).toBe(400);
    // …but fine once the desktop is off; and no computer means no desktop.
    expect((await call("PATCH", `/bots/${bot.id}`, { desktop: false, model: "env::blind-model" })).json).toMatchObject({ desktop: false, model: "env::blind-model" });
    await call("PATCH", `/bots/${bot.id}`, { desktop: true, model: "env::sees-model" });
    expect((await call("PATCH", `/bots/${bot.id}`, { computer: false })).json).toMatchObject({ computer: false, desktop: false });
  });

  test("the desktop check marks models that read the screen and point accurately", async () => {
    const good = scripted([textTurn("echo hi && uname -sr\nls"), textTurn("566,777")]);
    const target = settings.resolveModel("env::sees-model")!;
    expect(await checkDesktop(target, () => good.model)).toMatchObject({ reads: true, points: true, canDrive: true });
    // It really sends the screenshot.
    expect(JSON.stringify(good.prompts[0])).toContain("image/png");
    const off = scripted([textTurn("uname -sr\nls"), textTurn("443,775")]);
    expect(await checkDesktop(target, () => off.model)).toMatchObject({ reads: true, points: false, canDrive: false });

    const { call } = setup(scripted([textTurn("I can't see images."), textTurn("no idea")]));
    const { json } = await call("POST", "/settings/providers/env/desktop-check", { models: ["blind-model"] });
    expect(json.results).toEqual([{ model: "blind-model", reads: false, points: false, canDrive: false }]);
    expect(settings.modelOptions().find((option) => option.model === "blind-model")!.desktop).toBe(false);
  });

  test("a non-Claude model clicks, then sees the new screenshot as an image", async () => {
    settings.setDesktopModels("env", { "sees-model": true });
    const model = scripted([
      textTurn("Hi."),
      toolTurn("desktop_click", { x: 567, y: 775 }),
      textTurn("Opened the terminal."),
    ]);
    const { store, call } = setup(model);
    actions.length = 0;
    const { json: bot } = await call("POST", "/bots", { name: "Dee", computer: true, desktop: true, model: "env::sees-model" });
    await until(() => store.listMessages(bot.chatId).every((m) => m.status !== "streaming") && store.listMessages(bot.chatId).length);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Open the terminal." });
    const reply = await until(() => { const last = store.listMessages(bot.chatId).at(-1)!; return last.author === bot.id && last.status === "done" && last; });
    expect(reply.steps[0]).toMatchObject({ tool: "desktop_click", title: "Clicked at (567, 775)", status: "done" });
    expect(actions).toEqual(["click 567,775", "screenshot"]);
    // The step after the click shows the model the screen, as an image in a user message.
    const after = model.prompts.at(-1) as { role: string; content: { type: string; mediaType?: string }[] }[];
    const last = after.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content.some((part) => part.type === "file" && part.mediaType === "image/jpeg")).toBe(true);
    // Its prompt says it has a desktop.
    expect(JSON.stringify(model.prompts.at(-1))).toContain("Your desktop");
  });
});

test("only the newest screenshots stay in the conversation", () => {
  const withImage = (id: string) => ({ role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: id, toolName: "computer", output: { type: "content" as const, value: [{ type: "file", data: { type: "data", data: "x" }, mediaType: "image/jpeg" }] } }] });
  const messages = [withImage("a"), withImage("b"), withImage("c")] as never[];
  const pruned = prepareDesktopMessages(messages, null, 2) as any[];
  expect(pruned[0].content[0].output).toEqual({ type: "text", value: "(An earlier screenshot, removed to save space.)" });
  expect(pruned[1].content[0].output.type).toBe("content");
  expect(pruned[2].content[0].output.type).toBe("content");
  const withLatest = prepareDesktopMessages([], { data: "x", mediaType: "image/png", width: 1280, height: 800 }) as any[];
  expect(withLatest.at(-1)).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image", mediaType: "image/png" }] });
});
