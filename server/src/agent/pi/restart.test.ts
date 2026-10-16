import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/*
 * Colony is killed mid-turn and comes back: the first life runs in a child process
 * (crash.fixture.ts) and is killed outright; this process is the second life, on the same
 * colony.db and agent.db.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "colony-restart-"));
process.env.COLONY_DATA_DIR = root;
process.env.COLONY_DEV_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_DEV_MODELS = "mock-model";

const { openDb } = await import("../../db.js");
const { EventLog } = await import("../../events.js");
const { Store } = await import("../../store.js");
const { ApprovalGate } = await import("../approvals.js");
const { PiRunner } = await import("./runner.js");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { scriptedModels, textTurn, promptText } = await import("./testkit.js");
const { crashTools } = await import("./crashTools.js");
const config = (await import("../../config.js")).config;
(await import("../../settings.js")).loadSettings();

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../../..");

/** Runs the first life until it's at the scenario's point, then kills it. */
async function firstLife(scenario: "approval" | "write" | "read" | "acting") {
  const dataDir = fs.mkdtempSync(path.join(root, `${scenario}-`));
  const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "crash.fixture.ts"), dataDir, scenario], { cwd: serverDir, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const ids = await new Promise<{ botId: string; chatId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The first life never got ready.\n${errors}`)), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const line = String(chunk).split("\n").find((item) => item.startsWith("READY "));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(6))); }
    });
    child.on("exit", (code) => reject(new Error(`The first life exited (${code}).\n${errors}`)));
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return { dataDir, ...ids };
}

/** Colony coming back up on the first life's data. */
async function secondLife(dataDir: string, turns: ReturnType<typeof textTurn>[]) {
  const db = openDb(path.join(dataDir, "colony.db"));
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const scripted = scriptedModels();
  const script = scripted.play(turns);
  const runner = await PiRunner.open(store, events, gate, () => crashTools(dataDir, 2), { storage: await openNodeSqliteStorage(path.join(dataDir, "agent.db")), models: scripted.source });
  runner.resumeAll(store.recoverAfterRestart(config.limits.turnTimeoutMs));
  return { db, store, gate, runner, script };
}

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const count = (dataDir: string, name: string) => { try { return fs.readFileSync(path.join(dataDir, `${name}.log`), "utf8").length; } catch { return 0; } };
const lastReply = (store: InstanceType<typeof Store>, chatId: string, botId: string) => store.listMessages(chatId).filter((message) => message.author === botId).at(-1)!;

afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment longer */ } });

describe("pi runtime: Colony killed mid-turn", () => {
  test("waiting on an approval: the same card still works after the restart, and approving acts once", async () => {
    const first = await firstLife("approval");
    const { store, gate, runner, script } = await secondLife(first.dataDir, [textTurn("Sent after the restart.")]);
    const approval = await until(() => store.listApprovals("pending")[0]);
    await until(() => store.getBot(first.botId)!.presence === "waiting");
    // Asking again re-attaches to the card that was waiting; nothing new is asked.
    expect(store.listApprovals("pending")).toHaveLength(1);
    expect(store.listApprovals().filter((item) => item.status !== "pending")).toEqual([]);
    expect(gate.resolve(approval.id, true)).toBe(true);
    const reply = await until(() => { const message = lastReply(store, first.chatId, first.botId); return message.status === "done" && message; });
    expect(reply.text).toBe("Sent after the restart.");
    expect(reply.steps.map((step) => step.tool)).toContain("colony.restart");
    expect(reply.steps.find((step) => step.tool === "send_email")!.status).toBe("done");
    expect(count(first.dataDir, "sent")).toBe(1);
    expect(promptText(script.prompts.at(-1))).toContain("sent");
    expect(store.listRuns()).toEqual([]);
    await runner.close();
  }, 40_000);

  test("in the middle of a write: it isn't repeated, and the model is told it may or may not have happened", async () => {
    const first = await firstLife("write");
    const { store, runner, script } = await secondLife(first.dataDir, [textTurn("I'll check whether the note was written.")]);
    const reply = await until(() => { const message = lastReply(store, first.chatId, first.botId); return message.status === "done" && message; });
    expect(count(first.dataDir, "write")).toBe(1);
    expect(reply.steps.find((step) => step.tool === "write_note")).toMatchObject({ status: "interrupted" });
    expect(promptText(script.prompts.at(-1))).toMatch(/interrupted|partially/i);
    expect(reply.text).toBe("I'll check whether the note was written.");
    await runner.close();
  }, 40_000);

  test("approved and acting when Colony died: it isn't done twice, and the model is told to check", async () => {
    const first = await firstLife("acting");
    const { store, runner, script } = await secondLife(first.dataDir, [textTurn("Let me check whether the payment went through.")]);
    const reply = await until(() => { const message = lastReply(store, first.chatId, first.botId); return message.status === "done" && message; });
    expect(count(first.dataDir, "acting")).toBe(1);
    expect(store.listApprovals("pending")).toEqual([]);
    expect(reply.steps.find((step) => step.tool === "pay")).toMatchObject({ status: "interrupted" });
    expect(promptText(script.prompts.at(-1))).toContain("may or may not have happened");
    await runner.close();
  }, 40_000);

  test("in the middle of a read: it simply runs again", async () => {
    const first = await firstLife("read");
    const { store, runner, script } = await secondLife(first.dataDir, [textTurn("The note says hello.")]);
    const reply = await until(() => { const message = lastReply(store, first.chatId, first.botId); return message.status === "done" && message; });
    expect(count(first.dataDir, "read")).toBe(2);
    expect(reply.steps.find((step) => step.tool === "read_note")).toMatchObject({ status: "done" });
    expect(promptText(script.prompts.at(-1))).toContain("The note says hello.");
    await runner.close();
  }, 40_000);
});
