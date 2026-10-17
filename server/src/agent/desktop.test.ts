import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-desktop-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_DEV_BASE_URL = "http://model.invalid/v1";
// mock-model can see; other-model can't (see testkit.ts).
process.env.COLONY_DEV_MODELS = "mock-model,other-model";

const { openDb } = await import("../db.js");
const { EventLog } = await import("../events.js");
const { Store } = await import("../store.js");
const { ApprovalGate } = await import("./approvals.js");
const { PiRunner } = await import("./pi/runner.js");
const { MemoryStorage } = await import("@earendil-works/pi-durable");
const { scriptedModels, textTurn, toolTurn, promptText } = await import("./pi/testkit.js");
const { coreTools } = await import("./tools.js");
const { createApi } = await import("../api.js");
const { checkDesktop } = await import("./desktopCheck.js");
const settings = await import("../settings.js");
settings.loadSettings();

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const scripted = scriptedModels();

const shot = { data: Buffer.from("fake-jpeg").toString("base64"), mediaType: "image/jpeg" as const, width: 1280, height: 800 };
const actions: string[] = [];
const fakeDesktop = {
  screenshot: async () => { actions.push("screenshot"); return shot; },
  click: async (_id: string, x: number, y: number) => { actions.push(`click ${x},${y}`); },
  type: async (_id: string, text: string) => { actions.push(`type ${text}`); },
  key: async (_id: string, keys: string) => { actions.push(`key ${keys}`); },
} as never;

async function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = await PiRunner.open(store, events, gate, () => ({ ...coreTools }), { storage: new MemoryStorage(), models: scripted.source, desktop: fakeDesktop });
  const api = createApi({ store, events, gate, runner, models: scripted.source });
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
    scripted.play([textTurn("Hi.")]);
    const { call } = await setup();
    settings.setDesktopModels("dev", { "mock-model": true, "other-model": false });
    expect(settings.modelOptions().map((option) => [option.model, option.desktop])).toEqual([["mock-model", true], ["other-model", false]]);

    expect((await call("POST", "/bots", { name: "A", computer: true, desktop: true, model: "dev::other-model" })).status).toBe(400);
    expect((await call("POST", "/bots", { name: "B", computer: false, desktop: true, model: "dev::mock-model" })).status).toBe(400);
    const { json: bot } = await call("POST", "/bots", { name: "C", computer: true, desktop: true, model: "dev::mock-model" });
    expect(bot).toMatchObject({ computer: true, desktop: true });
    // Switching to a model that can't see, while the desktop is on, is refused…
    expect((await call("PATCH", `/bots/${bot.id}`, { model: "dev::other-model" })).status).toBe(400);
    // …but fine once the desktop is off; and no computer means no desktop.
    expect((await call("PATCH", `/bots/${bot.id}`, { desktop: false, model: "dev::other-model" })).json).toMatchObject({ desktop: false, model: "dev::other-model" });
    await call("PATCH", `/bots/${bot.id}`, { desktop: true, model: "dev::mock-model" });
    expect((await call("PATCH", `/bots/${bot.id}`, { computer: false })).json).toMatchObject({ computer: false, desktop: false });
  });

  test("the desktop check marks models that read the screen and point accurately", async () => {
    const target = settings.resolveModel("dev::mock-model")!;
    const good = scripted.play([textTurn("echo hi && uname -sr\nls"), textTurn("566,777")]);
    expect(await checkDesktop(target, scripted.source)).toMatchObject({ reads: true, points: true, canDrive: true });
    // It really sends the screenshot.
    expect(promptText(good.prompts[0])).toContain("image/png");
    scripted.play([textTurn("uname -sr\nls"), textTurn("443,775")]);
    expect(await checkDesktop(target, scripted.source)).toMatchObject({ reads: true, points: false, canDrive: false });

    const { call } = await setup();
    scripted.play([textTurn("I can't see images."), textTurn("no idea")]);
    const { json } = await call("POST", "/settings/providers/dev/desktop-check", { models: ["other-model"] });
    expect(json.results).toEqual([{ model: "other-model", reads: false, points: false, canDrive: false }]);
    expect(settings.modelOptions().find((option) => option.model === "other-model")!.desktop).toBe(false);
  });

  test("a model clicks, then sees the new screenshot as an image", async () => {
    settings.setDesktopModels("dev", { "mock-model": true });
    const script = scripted.play([
      textTurn("Hi."),
      toolTurn("desktop_click", { x: 567, y: 775 }),
      textTurn("Opened the terminal."),
    ]);
    const { store, call } = await setup();
    actions.length = 0;
    const { json: bot } = await call("POST", "/bots", { name: "Dee", computer: true, desktop: true, model: "dev::mock-model" });
    await until(() => store.listMessages(bot.chatId).every((m) => m.status !== "streaming") && store.listMessages(bot.chatId).length);
    await call("POST", `/chats/${bot.chatId}/messages`, { text: "Open the terminal." });
    const reply = await until(() => { const last = store.listMessages(bot.chatId).at(-1)!; return last.author === bot.id && last.status === "done" && last; });
    expect(reply.steps[0]).toMatchObject({ tool: "desktop_click", title: "Clicked at (567, 775)", status: "done" });
    expect(actions).toEqual(["click 567,775", "screenshot"]);
    // The step after the click shows the model the screen as an image, and its prompt says it has a desktop.
    expect(promptText(script.prompts.at(-1))).toContain("image/jpeg");
    expect(promptText(script.prompts.at(-1))).toContain("Your desktop");
  });
});
