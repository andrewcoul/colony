import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ApprovalGate } from "./agent/approvals.js";
import { ColonyModels } from "./agent/pi/models.js";
import { PiRunner } from "./agent/pi/runner.js";
import { ModelSignIns } from "./agent/pi/signins.js";
import type { Runner } from "./agent/runner.js";
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
import { requirePerson, resolver, standardSources, upgradePerson } from "./access.js";
import { createApi, isPublicApi } from "./api.js";
import { Invites } from "./invites.js";
import { mailerFromEnv } from "./mailer.js";
import { WebAccounts, webSessionsFromEnv } from "./webauth.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { PushService } from "./push.js";
import { RoutineScheduler } from "./routines.js";
import { defaultModel, loadSettings, modelConfigured, modelOptions, onProvidersChanged, ownerLogin, resolveModel, setOwnerLogin } from "./settings.js";
import { Store } from "./store.js";
import { Calls, callTools } from "./voice.js";
import { NodeHub, pcToolsFor } from "./nodes.js";
import { ADMIN_ID, foldHousehold, People } from "./people.js";
import { authorizeUpgrade, type Upgrade } from "./upgrades.js";

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
// Your ChatGPT and OpenCode sign-ins (data/credentials.json) and the models picked from each.
const models = new ColonyModels();
const modelSignIns = new ModelSignIns(models);
// A sign-in finishing or ending changes which models Bots can use (each person's stream narrows them to theirs).
onProvidersChanged(() => events.emit({ type: "settings.updated", models: modelOptions(), defaultModel: defaultModel(), configured: modelConfigured() }, null));
// The family build's host login is the admin's tailnet login.
if (!ownerLogin()) {
  const host = db.prepare("SELECT login FROM people WHERE id = 'owner'").get() as { login: string | null } | undefined;
  if (host?.login) setOwnerLogin(host.login);
}
foldHousehold();
// Bots from before multiple providers stored a plain model id, and Bots from before sign-ins an
// API key provider's id; point them at the provider their model is in now.
// (Members' Bots are on the members' provider, which never moved.)
for (const bot of store.listBots(ADMIN_ID)) {
  const target = resolveModel(bot.model, { fallback: false });
  if (target && target.ref !== bot.model) store.updateBot(bot.id, { model: target.ref });
}
const gate = new ApprovalGate(store);
const nodes = new NodeHub(store, events);
const computer = new ComputerService(store, events);
void computer.syncStates().then(() => computer.pruneOldImages());
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
/**
 * Each Bot's tools: the basics, its computer if it has one, and whatever accounts you've given it.
 * Accounts and PCs are the admin's, so only the admin's Bots ever get those.
 */
const toolsFor = (botId: string): ToolRegistry => {
  const bot = store.getBot(botId);
  const hasComputer = Boolean(bot?.computer);
  const admins = bot?.ownerId === ADMIN_ID;
  return {
    ...coreTools,
    ...(hasComputer ? computerToolset : {}),
    ...(admins ? mailToolsFor(accountTools, integrations, botId) : {}),
    ...(admins && hasComputer ? vaultToolsFor(loginTools, integrations, botId) : {}),
    ...ringTools,
    ...pcToolsFor(nodes, store, botId),
  };
};
const guidance = (botId: string) => (store.getBot(botId)?.ownerId === ADMIN_ID ? accountsGuidance(integrations, botId, Boolean(store.getBot(botId)?.computer)) : "");
// pi durable keeps each Bot's conversations in data/agent.db.
const runner: Runner = await PiRunner.open(store, events, gate, toolsFor, { storage: path.join(config.dataDir, "agent.db"), models, desktop, integrations, guidance });
const calls = new Calls(store, events, runner);
nodes.stopBot = (botId) => runner.stopBot(botId);
const ringTools = callTools(calls);
const routines = new RoutineScheduler(store, runner);
routines.start();
const poller = new MailPoller(store, integrations, routines);
poller.start();
const push = new PushService(db, store, events);
calls.notify = (notification, personId) => void push.notify(notification, { force: true, personId });
// Pick up the turns that were running when Colony stopped, in the replies they were writing.
runner.resumeAll(resumable);
// Accounts are the admin's.
accounts.onNeedsReauth = (account) => void push.notify({
  title: `Reconnect ${account.label}`,
  body: `${account.email} stopped working for your Bots. Reconnect it in Settings → Accounts.`,
  chatId: null,
  tag: `reauth-${account.id}`,
}, { personId: ADMIN_ID });

// Who's asking: every request and WebSocket upgrade is a person (see access.ts), or refused.
const owner = { allowed: config.allowedUsers, login: ownerLogin, claim: (login: string) => setOwnerLogin(login) };
const people = new People(store, { adminEmails: config.adminEmails });
// Web sign-in (through the colony-site Worker): invite-only accounts, and email through Resend.
const invites = new Invites(db, config.inviteTtlDays);
const mailer = mailerFromEnv();
const webAccounts = new WebAccounts(store, people, invites, webSessionsFromEnv());
const resolve = resolver(standardSources(owner, config.cloudflareAccess), people, (header) => webAccounts.personFor(header));
const app = new Hono();
// Pages load without a sign-in (that's where you sign in); /api needs one, except signing in itself.
app.use(requirePerson(resolve, { origins: config.publicOrigins, isPublic: (path) => !path.startsWith("/api/") || isPublicApi(path) }));
const updater = new Updater({
  version: VERSION,
  home: config.home,
  repo: config.updateRepo,
  apiBase: config.updateApi,
  // Members' Bots count, but their names stay theirs.
  busy: () => store.listBots().filter((bot) => runner.isBotRunning(bot.id)).map((bot) => (bot.ownerId === ADMIN_ID ? bot.name : "a member's Bot")),
});
updater.start();
app.route("/api", createApi({ store, events, gate, runner, computer, browser, desktop, routines, push, updater, access: resolve, models, modelSignIns,
  memberKey: { set: (key) => models.setMemberKey(key), clear: () => models.clearMemberKey() }, integrations, signIns, calls, nodes,
  web: { accounts: webAccounts, invites, mailer, origins: config.publicOrigins } }));

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
  if (!modelConfigured()) console.log("No model yet: open Colony and sign in to ChatGPT or OpenCode in Settings.");
});

// The desktop viewer streams video over a WebSocket at /api/bots/<id>/screen/media. Hono doesn't
// proxy upgrades, so pass them straight to the Bot's desktop, under the same access rules.
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
  // Checking a Cloudflare Access sign-in can take a moment; the socket holds its data until then.
  const failed = () => socket.destroy();
  socket.on("error", failed);
  // Through the website, upgrades need a web sign-in and must come from Colony's own pages.
  void upgradePerson(resolve, header, config.publicOrigins).then((person) => {
    socket.off("error", failed);
    if (!person || socket.destroyed) { socket.destroy(); return; }
    // Only the admin lends PCs, and only a chat's or a Bot's owner calls it or watches it.
    const upgrade = authorizeUpgrade(store, person, request.url ?? "");
    if (!upgrade) { socket.destroy(); return; }
    routeUpgrade(upgrade, person.id, request, socket, head);
  }, () => socket.destroy());
});
function routeUpgrade(upgrade: Upgrade, personId: string, request: IncomingMessage, socket: Duplex, head: Buffer) {
  // The desktop app lending your PC to your Bots.
  if (upgrade.kind === "nodes") { nodes.upgrade(request, socket, head); return; }
  // A voice call with one of your Bots: /api/chats/<id>/call.
  if (upgrade.kind === "call") { calls.upgrade(request, socket, head, personId); return; }
  // Watching a Bot's screen.
  const bot = store.getBot(upgrade.botId);
  if (!bot?.computer) { socket.destroy(); return; }
  void computer.runningDesktopPort(bot.id).then((port) => {
    if (!port) { socket.destroy(); return; }
    const upstream = net.connect(port, "127.0.0.1", () => {
      const headers = Object.entries(request.headers)
        .filter(([name]) => !["host", "cookie", "origin", "referer"].includes(name))
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
      upstream.write([`${request.method} ${upgrade.path}${upgrade.query} HTTP/1.1`, `host: 127.0.0.1:${port}`, ...headers, "", ""].join("\r\n"));
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
}
