import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ApprovalGate } from "./agent/approvals.js";
import { AgentRunner } from "./agent/run.js";
import { browserTools } from "./agent/browserTools.js";
import { computerTools } from "./agent/computerTools.js";
import { coreTools } from "./agent/tools.js";
import { BrowserService } from "./computer/browser.js";
import { ComputerService } from "./computer/docker.js";
import { tailnetOnly } from "./access.js";
import { createApi } from "./api.js";
import { config, modelConfigured } from "./config.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { PushService } from "./push.js";
import { RoutineScheduler } from "./routines.js";
import { Store } from "./store.js";

// One Colony per data folder: a second one would run every routine twice.
const lockFile = path.join(config.dataDir, "colony.pid");
try {
  const other = Number(fs.readFileSync(lockFile, "utf8"));
  if (other && other !== process.pid) {
    process.kill(other, 0); // Throws if that process is gone.
    console.error(`Colony is already running (pid ${other}) with data in ${config.dataDir}. Stop it first.`);
    process.exit(1);
  }
} catch { /* No lock, or a stale one. */ }
fs.mkdirSync(config.dataDir, { recursive: true });
fs.writeFileSync(lockFile, String(process.pid));
const releaseLock = () => { try { if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.rmSync(lockFile); } catch { /* already gone */ } };
process.on("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

const db = openDb(path.join(config.dataDir, "colony.db"));
const events = new EventLog(db);
const store = new Store(db, events);
store.recoverAfterRestart();
const gate = new ApprovalGate(store);
const computer = new ComputerService(store, events);
void computer.syncStates();
const browser = new BrowserService(computer);
const computerToolset = { ...computerTools(computer), ...browserTools(browser) };
const runner = new AgentRunner(store, events, gate, (botId) => (store.getBot(botId)?.computer ? { ...coreTools, ...computerToolset } : coreTools));
const routines = new RoutineScheduler(store, runner);
routines.start();
const push = new PushService(db, store, events);

const app = new Hono();
app.use(tailnetOnly(config.allowedUsers));
app.route("/api", createApi({ store, events, gate, runner, computer, browser, routines, push }));

// In production the server also serves the built web app (web/dist).
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  const root = path.relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: path.join(root, "index.html") }));
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, ({ address, port }) => {
  console.log(`Colony is running at http://${address}:${port}`);
  console.log(`Data: ${config.dataDir}`);
  if (!modelConfigured()) console.log("No model configured yet: set COLONY_API_BASE_URL, COLONY_API_KEY and COLONY_MODELS in .env.");
});
