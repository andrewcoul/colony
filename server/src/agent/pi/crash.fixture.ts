/*
 * The first life of a Colony that gets killed mid-turn (see restart.test.ts). Run as
 *   node --import tsx crash.fixture.ts <data dir> <scenario>
 * It starts a Bot, sends it a message, and prints READY once the turn is at the point the
 * scenario needs: waiting on an approval, in the middle of writing, or in the middle of reading.
 */
import fs from "node:fs";
import path from "node:path";

const [dataDir, scenario] = process.argv.slice(2) as [string, "approval" | "write" | "read" | "acting"];
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_DEV_BASE_URL = "http://model.invalid/v1";
process.env.COLONY_DEV_MODELS = "mock-model";

const { openDb } = await import("../../db.js");
const { EventLog } = await import("../../events.js");
const { Store } = await import("../../store.js");
const { ApprovalGate } = await import("../approvals.js");
const { PiRunner } = await import("./runner.js");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { scriptedModels, textTurn, toolTurn } = await import("./testkit.js");
const { crashTools } = await import("./crashTools.js");
(await import("../../settings.js")).loadSettings();

const db = openDb(path.join(dataDir, "colony.db"));
const events = new EventLog(db);
const store = new Store(db, events);
const gate = new ApprovalGate(store);
const scripted = scriptedModels();
const call = { approval: toolTurn("send_email", { to: "sarah@acme.com", body: "Draft" }), write: toolTurn("write_note", { text: "hello" }), read: toolTurn("read_note", {}), acting: toolTurn("pay", { amount: 40 }) }[scenario];
scripted.play([textTurn("Hi."), call]);
const runner = await PiRunner.open(store, events, gate, () => crashTools(dataDir, 1), { storage: await openNodeSqliteStorage(path.join(dataDir, "agent.db")), models: scripted.source });

const bot = store.createBot({ name: "Peng", title: "", description: "", model: "dev::mock-model", computer: false, ownerId: "owner" });
runner.start(bot.chatId, bot.id, { hiddenPrompt: "Say hi." });
const ready = () => {
  if (scenario === "approval") return store.listApprovals("pending").length > 0;
  // Approve the payment as soon as it asks; it's killed while paying.
  if (scenario === "acting") { const pending = store.listApprovals("pending")[0]; if (pending) gate.resolve(pending.id, true); }
  return fs.existsSync(path.join(dataDir, `${scenario}.log`));
};
const intro = setInterval(() => {
  if (store.listMessages(bot.chatId).some((message) => message.author === bot.id && message.status === "done")) {
    clearInterval(intro);
    store.createMessage({ chatId: bot.chatId, author: "user", text: "Go ahead." });
    runner.start(bot.chatId, bot.id);
    const wait = setInterval(() => { if (ready()) { clearInterval(wait); console.log("READY", JSON.stringify({ botId: bot.id, chatId: bot.chatId })); } }, 20);
  }
}, 20);
