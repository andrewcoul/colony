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
process.env.COLONY_PROVIDER_NAME = "OpenCode Go";
process.env.COLONY_MODELS = "env-model";

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { AgentRunner } = await import("./agent/run.js");
const { createApi } = await import("./api.js");
const settings = await import("./settings.js");

settings.loadSettings();

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
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith("{") ? JSON.parse(text) : null };
  };
  return { call, events, store };
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("starts from .env as one provider; devices only see a key's last four characters", async () => {
  const { call } = app();
  const { text, json } = await call("GET", "/settings");
  expect(json).toMatchObject({ providers: [{ id: "env", name: "OpenCode Go", models: ["env-model"], keySet: true, keyHint: "0000" }], defaultModel: "env::env-model", source: "env" });
  expect(text).not.toContain("sk-from-env");
});

test("several providers at once, each Bot on its own provider and model", async () => {
  const { call, events, store } = app();
  const before = events.latestSeq();
  const added = await call("POST", "/settings/providers", { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1/", apiKey: "sk-or-key-123456789", models: ["anthropic/claude-x", "openai/gpt-y"] });
  expect(added.status).toBe(201);
  expect(added.text).not.toContain("sk-or-key");
  const openrouter = added.json.providers.find((item: { name: string }) => item.name === "OpenRouter");
  expect(openrouter).toMatchObject({ baseURL: "https://openrouter.ai/api/v1", keyHint: "6789" });

  const updated = events.since(before)!.map((item) => item.event).find((event) => event.type === "settings.updated");
  expect(updated).toMatchObject({ defaultModel: "env::env-model" });
  expect((updated as { models: { ref: string }[] }).models.map((item) => item.ref)).toEqual(["env::env-model", `${openrouter.id}::anthropic/claude-x`, `${openrouter.id}::openai/gpt-y`]);

  // Bots pick any model from any provider; the runner gets the right provider for each.
  const john = (await call("POST", "/bots", { name: "John", model: `${openrouter.id}::anthropic/claude-x` })).json;
  const jeff = (await call("POST", "/bots", { name: "Jeff" })).json;
  expect(john.model).toBe(`${openrouter.id}::anthropic/claude-x`);
  expect(jeff.model).toBe("env::env-model");
  expect(settings.resolveModel(store.getBot(john.id)!.model)).toMatchObject({ model: "anthropic/claude-x", provider: { name: "OpenRouter", apiKey: "sk-or-key-123456789" } });
  expect(settings.resolveModel(store.getBot(jeff.id)!.model)).toMatchObject({ model: "env-model", provider: { name: "OpenCode Go", apiKey: "sk-from-env-0000" } });
  expect((await call("PATCH", `/bots/${jeff.id}`, { model: "nope::nope" })).status).toBe(400);

  // Old plain model ids still resolve to the provider that offers them.
  expect(settings.resolveModel("openai/gpt-y")!.ref).toBe(`${openrouter.id}::openai/gpt-y`);

  // Changing the default; removing a provider moves Bots on it to the default.
  expect((await call("PUT", "/settings/default-model", { model: `${openrouter.id}::openai/gpt-y` })).json.defaultModel).toBe(`${openrouter.id}::openai/gpt-y`);
  await call("DELETE", `/settings/providers/${openrouter.id}`);
  expect(settings.defaultModel()).toBe("env::env-model");
  expect(settings.resolveModel(store.getBot(john.id)!.model)!.ref).toBe("env::env-model");

  // Saved to disk and loaded again on restart.
  settings.loadSettings();
  expect(settings.settingsView()).toMatchObject({ source: "app", providers: [{ id: "env" }] });
});

test("a key is only ever sent to the address it was saved for", async () => {
  const { call } = app();
  const home = await fakeProvider(["m1", "m2"]);
  const other = await fakeProvider(["x"]);
  try {
    const created = await call("POST", "/settings/providers", { name: "Home", baseURL: home.url, apiKey: "sk-home-secret-1111", models: ["m1"] });
    const id = created.json.providers.find((item: { name: string }) => item.name === "Home").id;
    expect((await call("POST", "/settings/providers/check", { providerId: id, baseURL: home.url })).json).toEqual({ models: ["m1", "m2"] });
    expect(home.seen.at(-1)).toBe("Bearer sk-home-secret-1111");

    // Same provider, different address: no key goes out, and saving it there clears the key.
    await call("POST", "/settings/providers/check", { providerId: id, baseURL: other.url });
    expect(other.seen.at(-1)).toBeUndefined();
    await call("PUT", `/settings/providers/${id}`, { name: "Home", baseURL: other.url, models: ["x"] });
    expect(settings.resolveModel(`${id}::x`)!.provider.apiKey).toBe("");
    // A blank key on the same address keeps it.
    await call("PUT", `/settings/providers/${id}`, { name: "Home", baseURL: other.url, apiKey: "sk-other-2222-abcd", models: ["x"] });
    await call("PUT", `/settings/providers/${id}`, { name: "Home renamed", baseURL: other.url, models: ["x"] });
    expect(settings.resolveModel(`${id}::x`)!.provider).toMatchObject({ name: "Home renamed", apiKey: "sk-other-2222-abcd" });
  } finally {
    home.close();
    other.close();
  }
});

test("bad input explains itself", async () => {
  const { call } = app();
  const checked = await call("POST", "/settings/providers/check", { baseURL: "http://127.0.0.1:9/v1" });
  expect(checked.status).toBe(400);
  expect(checked.json.error).toContain("Couldn't reach");
  expect((await call("POST", "/settings/providers", { name: "X", baseURL: "ftp://x", models: ["m"] })).status).toBe(400);
  expect((await call("POST", "/settings/providers", { name: "X", baseURL: "https://x.dev/v1", models: [] })).status).toBe(400);
  expect((await call("PUT", "/settings/providers/missing", { name: "X", baseURL: "https://x.dev/v1", models: ["m"] })).status).toBe(404);
  expect((await call("PUT", "/settings/default-model", { model: "missing::m" })).status).toBe(400);
});
