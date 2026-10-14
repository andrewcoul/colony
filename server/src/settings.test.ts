import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-settings-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_API_BASE_URL = "http://env.invalid/v1";
process.env.COLONY_API_KEY = "sk-from-env-0000";
process.env.COLONY_MODELS = "env-model";

const { config, resolveModel } = await import("./config.js");
const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { AgentRunner } = await import("./agent/run.js");
const { createApi } = await import("./api.js");
const settings = await import("./settings.js");

/** A pretend OpenAI-compatible provider that records the Authorization header it receives. */
async function fakeProvider(models: string[]) {
  const seen: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.headers.authorization);
    if (request.url !== "/v1/models") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() };
}

function app() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const api = createApi({ store, events, gate, runner: new AgentRunner(store, events, gate) });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, text: await response.text(), events };
  };
  return { call, events };
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("starts from .env, and devices only ever see the key's last four characters", async () => {
  const { call } = app();
  const { text } = await call("GET", "/settings/model");
  expect(JSON.parse(text)).toMatchObject({ baseURL: "http://env.invalid/v1", models: ["env-model"], keySet: true, keyHint: "0000", source: "env" });
  expect(text).not.toContain("sk-from-env");
});

test("saving switches the model connection immediately, persists it, and tells every device", async () => {
  const { call, events } = app();
  const before = events.latestSeq();
  const saved = await call("PUT", "/settings/model", { providerName: "OpenRouter", baseURL: "https://openrouter.ai/api/v1/", apiKey: "sk-or-new-key-9876", models: ["a/fast", "b/smart", "a/fast"] });
  expect(saved.status).toBe(200);
  expect(saved.text).not.toContain("sk-or-new-key");
  expect(config.model).toMatchObject({ baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or-new-key-9876", models: ["a/fast", "b/smart"], defaultModel: "a/fast" });
  expect(resolveModel("b/smart")).toBe("b/smart");
  expect(resolveModel("env-model")).toBe("a/fast"); // Old models fall back to the new default.
  expect(events.since(before)!.map((item) => item.event)).toContainEqual({ type: "settings.updated", models: ["a/fast", "b/smart"], defaultModel: "a/fast", configured: true });

  const file = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
  expect(file.model.apiKey).toBe("sk-or-new-key-9876");
  // A blank key keeps the saved one for the same provider.
  await call("PUT", "/settings/model", { providerName: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", models: ["b/smart"] });
  expect(config.model.apiKey).toBe("sk-or-new-key-9876");
  // Restarting loads the saved settings over .env.
  config.model.apiKey = "";
  settings.loadSettings();
  expect(config.model).toMatchObject({ apiKey: "sk-or-new-key-9876", models: ["b/smart"] });
});

test("a saved key is never sent to a different provider", async () => {
  const { call } = app();
  const home = await fakeProvider(["m1", "m2"]);
  const other = await fakeProvider(["x"]);
  try {
    await call("PUT", "/settings/model", { providerName: "Home", baseURL: home.url, apiKey: "sk-home-secret-1111", models: ["m1"] });
    const checked = await call("POST", "/settings/model/check", { baseURL: home.url });
    expect(JSON.parse(checked.text)).toEqual({ models: ["m1", "m2"] });
    expect(home.seen.at(-1)).toBe("Bearer sk-home-secret-1111");

    await call("POST", "/settings/model/check", { baseURL: other.url });
    expect(other.seen.at(-1)).toBeUndefined();
    // Switching providers without a new key clears the old one rather than sending it elsewhere.
    await call("PUT", "/settings/model", { providerName: "Other", baseURL: other.url, models: ["x"] });
    expect(config.model.apiKey).toBe("");
  } finally {
    home.close();
    other.close();
  }
});

test("bad connections explain themselves", async () => {
  const { call } = app();
  const checked = await call("POST", "/settings/model/check", { baseURL: "http://127.0.0.1:9/v1" });
  expect(checked.status).toBe(400);
  expect(JSON.parse(checked.text).error).toContain("Couldn't reach");
  expect((await call("PUT", "/settings/model", { providerName: "X", baseURL: "ftp://x", models: ["m"] })).status).toBe(400);
  expect((await call("PUT", "/settings/model", { providerName: "X", baseURL: "https://x.dev/v1", models: [] })).status).toBe(400);
});
