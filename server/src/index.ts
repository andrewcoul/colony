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
import { accountsGuidance, mailTools, mailToolsFor } from "./agent/mailTools.js";
import { coreTools, type ToolRegistry } from "./agent/tools.js";
import { vaultTools, vaultToolsFor } from "./agent/vaultTools.js";
import { Accounts } from "./integrations/accounts.js";
import { Integrations } from "./integrations/index.js";
import { SignIns, Tokens } from "./integrations/oauth.js";
import { Vaults } from "./integrations/onepassword.js";
import { MailPoller } from "./integrations/poller.js";
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
import { loadSettings, modelConfigured, ownerLogin, resolveModel, setOwnerLogin } from "./settings.js";
import { Store } from "./store.js";
import { Calls, callTools } from "./voice.js";
import { NodeHub, pcToolsFor } from "./nodes.js";
import { foldHousehold } from "./people.js";
import { removeBotFolder } from "./files.js";

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
// Turns that were running when Colony stopped are resumed once the runner exists (below).
const resumable = store.recoverAfterRestart(config.limits.turnTimeoutMs);
loadSettings();
// Colony is single-user: the family build's host login is yours, and everyone else's things go.
if (!ownerLogin()) {
  const host = db.prepare("SELECT login FROM people WHERE id = 'owner'").get() as { login: string | null } | undefined;
  if (host?.login) setOwnerLogin(host.login);
}
const othersBots = store.forgetOthers();
for (const botId of othersBots) removeBotFolder(botId);
foldHousehold();
// Bots from before multiple providers stored a plain model id; point them at its provider.
for (const bot of store.listBots()) {
  const target = bot.model.includes("::") ? null : resolveModel(bot.model, { fallback: false });
  if (target) store.updateBot(bot.id, { model: target.ref });
}
const gate = new ApprovalGate(store);
const nodes = new NodeHub(store, events);
const computer = new ComputerService(store, events);
void computer.syncStates().then(async () => {
  for (const botId of othersBots) await computer.remove(botId).catch(() => {});
  await computer.pruneOldImages();
});
const browser = new BrowserService(computer);
const desktop = new DesktopService(computer);
const computerToolset = { ...computerTools(computer), ...browserTools(browser) };
// Mail, calendars and 1Password: connected in Settings, then given to Bots one by one.
const accounts = new Accounts(db, events);
const tokens = new Tokens(accounts);
const integrations = new Integrations(accounts, tokens, new Vaults(accounts));
const signIns = new SignIns(accounts, tokens);
const accountTools = mailTools(integrations);
const loginTools = vaultTools(browser, integrations);
/** Each Bot's tools: the basics, its computer if it has one, and whatever accounts you've given it. */
const toolsFor = (botId: string): ToolRegistry => {
  const hasComputer = Boolean(store.getBot(botId)?.computer);
  return {
    ...coreTools,
    ...(hasComputer ? computerToolset : {}),
    ...mailToolsFor(accountTools, integrations, botId),
    ...(hasComputer ? vaultToolsFor(loginTools, integrations, botId) : {}),
    ...ringTools,
    ...pcToolsFor(nodes, store, botId),
  };
};
const runner = new AgentRunner(store, events, gate, toolsFor, undefined, desktop, {
  integrations,
  guidance: (botId) => accountsGuidance(integrations, botId, Boolean(store.getBot(botId)?.computer)),
  notify: (notification) => void push.notify(notification, { force: true }),
});
const calls = new Calls(store, events, runner);
nodes.stopBot = (botId) => runner.stopBot(botId);
const ringTools = callTools(calls);
const routines = new RoutineScheduler(store, runner);
routines.start();
const poller = new MailPoller(store, integrations, routines);
poller.start();
const push = new PushService(db, store, events);
calls.notify = (notification) => void push.notify(notification, { force: true });
// Pick up the turns that were running when Colony stopped, in the replies they were writing.
runner.resumeAll(resumable);
accounts.onNeedsReauth = (account) => void push.notify({
  title: `Reconnect ${account.label}`,
  body: `${account.email} stopped working for your Bots. Reconnect it in Settings → Accounts.`,
  chatId: null,
  tag: `reauth-${account.id}`,
});

const app = new Hono();
const owner = { allowed: config.allowedUsers, login: ownerLogin, claim: (login: string) => setOwnerLogin(login) };
app.use(tailnetOnly(owner));
const updater = new Updater({
  version: VERSION,
  home: config.home,
  repo: config.updateRepo,
  apiBase: config.updateApi,
  busy: () => store.listBots().filter((bot) => runner.isBotRunning(bot.id)).map((bot) => bot.name),
});
updater.start();
app.route("/api", createApi({ store, events, gate, runner, computer, browser, desktop, routines, push, updater, integrations, signIns, calls, nodes }));

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
const allowed = accessCheck(owner);
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
  const header = (name: string) => { const value = request.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; };
  if (allowed(header)) { socket.destroy(); return; }
  // The desktop app lending your PC to your Bots.
  if (/^\/api\/nodes\/connect(\?|$)/.test(request.url ?? "")) {
    nodes.upgrade(request, socket, head);
    return;
  }
  // A voice call with one of your Bots: /api/chats/<id>/call.
  if (/^\/api\/chats\/[\w-]+\/call(\?|$)/.test(request.url ?? "")) {
    calls.upgrade(request, socket, head);
    return;
  }
  // Watching a Bot's screen.
  const match = /^\/api\/bots\/([\w-]+)\/screen(\/[^?#]*)(\?[^#]*)?$/.exec(request.url ?? "");
  const bot = match ? store.getBot(match[1]) : null;
  if (!match || !bot?.computer) { socket.destroy(); return; }
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
