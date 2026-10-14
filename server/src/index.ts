import fs from "node:fs";
import net from "node:net";
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
import { DesktopService } from "./computer/desktop.js";
import { ComputerService } from "./computer/docker.js";
import { IdleStopper } from "./computer/idle.js";
import { Updater } from "./updates.js";
import { VERSION } from "./version.js";
import { accessCheck, tailnetOnly } from "./access.js";
import { createApi } from "./api.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { PushService } from "./push.js";
import { RoutineScheduler } from "./routines.js";
import { loadSettings, modelConfigured, resolveModel } from "./settings.js";
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
loadSettings();
// Bots from before multiple providers stored a plain model id; point them at its provider.
for (const bot of store.listBots()) {
  const target = bot.model.includes("::") ? null : resolveModel(bot.model, { fallback: false });
  if (target) store.updateBot(bot.id, { model: target.ref });
}
const gate = new ApprovalGate(store);
const computer = new ComputerService(store, events);
void computer.syncStates().then(() => computer.pruneOldImages());
const browser = new BrowserService(computer);
const desktop = new DesktopService(computer);
const computerToolset = { ...computerTools(computer), ...browserTools(browser) };
const runner = new AgentRunner(store, events, gate, (botId) => (store.getBot(botId)?.computer ? { ...coreTools, ...computerToolset } : coreTools), undefined, desktop);
const routines = new RoutineScheduler(store, runner);
routines.start();
const push = new PushService(db, store, events);

const app = new Hono();
app.use(tailnetOnly(config.allowedUsers));
const updater = new Updater({
  version: VERSION,
  home: config.home,
  repo: config.updateRepo,
  apiBase: config.updateApi,
  busy: () => store.listBots().filter((bot) => runner.isBotRunning(bot.id)).map((bot) => bot.name),
});
updater.start();
app.route("/api", createApi({ store, events, gate, runner, computer, browser, desktop, routines, push, updater }));

// In production the server also serves the built web app (web/dist).
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  const root = path.relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: path.join(root, "index.html") }));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, ({ address, port }) => {
  console.log(`Colony ${VERSION} is running at http://${address}:${port}`);
  // A new version confirms itself once it has stayed up for a bit; until then its launcher
  // would go back to the previous version if it exited.
  setTimeout(() => { try { updater.confirm(); } catch (error) { console.log(`[colony] Couldn't confirm the update: ${error}`); } }, 15_000).unref();
  console.log(`Data: ${config.dataDir}`);
  if (!modelConfigured()) console.log("No model configured yet: open Colony and add your API key in Settings.");
});

// The desktop viewer streams video over a WebSocket at /api/bots/<id>/screen/media. Hono doesn't
// proxy upgrades, so pass them straight to the Bot's desktop, under the same access rules.
const allowed = accessCheck(config.allowedUsers);
/** Open Screen viewers per Bot; an open viewer keeps the computer awake. */
const screenViewers = new Map<string, number>();
const idle = new IdleStopper({
  idleMs: config.limits.computerIdleMinutes * 60_000,
  // Only this Colony's Bots: another Colony (e.g. a dev copy) may share Docker.
  running: async () => (await computer.runningBots()).filter((botId) => store.getBot(botId)),
  busy: (botId) => runner.isBotRunning(botId) || browser.isWatched(botId) || (screenViewers.get(botId) ?? 0) > 0,
  stop: async (botId) => {
    await browser.close(botId);
    desktop.forget(botId);
    await computer.stop(botId);
    console.log(`[colony] Switched off ${store.getBot(botId)?.name ?? botId}'s computer after ${config.limits.computerIdleMinutes} idle minutes.`);
  },
});
computer.onUse = (botId) => idle.touch(botId);
idle.start();
server.on("upgrade", (request, socket, head) => {
  const match = /^\/api\/bots\/([\w-]+)\/screen(\/[^?#]*)(\?[^#]*)?$/.exec(request.url ?? "");
  const header = (name: string) => { const value = request.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; };
  const bot = match ? store.getBot(match[1]) : null;
  if (!match || !bot?.computer || allowed(header)) { socket.destroy(); return; }
  void computer.runningDesktopPort(bot.id).then((port) => {
    if (!port) { socket.destroy(); return; }
    const upstream = net.connect(port, "127.0.0.1", () => {
      const headers = Object.entries(request.headers)
        .filter(([name]) => !["host", "cookie", "origin", "referer"].includes(name))
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
      upstream.write([`${request.method} ${match[2]}${match[3] ?? ""} HTTP/1.1`, `host: 127.0.0.1:${port}`, ...headers, "", ""].join("\r\n"));
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      screenViewers.set(bot.id, (screenViewers.get(bot.id) ?? 0) + 1);
      let closed = false;
      const release = () => {
        if (closed) return;
        closed = true;
        screenViewers.set(bot.id, Math.max(0, (screenViewers.get(bot.id) ?? 1) - 1));
        idle.touch(bot.id); // Closing the viewer starts a fresh idle window.
      };
      socket.on("close", release);
      upstream.on("close", release);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }, () => socket.destroy());
});
