import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ApprovalGate } from "./agent/approvals.js";
import { AgentRunner } from "./agent/run.js";
import { createApi } from "./api.js";
import { config, modelConfigured } from "./config.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { Store } from "./store.js";

const db = openDb(path.join(config.dataDir, "colony.db"));
const events = new EventLog(db);
const store = new Store(db, events);
store.recoverAfterRestart();
const gate = new ApprovalGate(store);
const runner = new AgentRunner(store, events, gate);

const app = new Hono();
app.route("/api", createApi({ store, events, gate, runner }));

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
