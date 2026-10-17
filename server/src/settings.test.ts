import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-settings-"));
process.env.COLONY_DATA_DIR = dataDir;
delete process.env.COLONY_DEV_BASE_URL;

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { ApprovalGate } = await import("./agent/approvals.js");
const { PiRunner } = await import("./agent/pi/runner.js");
const { MemoryStorage } = await import("@earendil-works/pi-durable");
const { scriptedModels } = await import("./agent/pi/testkit.js");
const { createApi } = await import("./api.js");
const settings = await import("./settings.js");

const file = path.join(dataDir, "settings.json");
const scripted = scriptedModels();

async function app() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = await PiRunner.open(store, events, gate, undefined, { storage: new MemoryStorage(), models: scripted.source });
  const api = createApi({ store, events, gate, runner });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith("{") ? JSON.parse(text) : null };
  };
  return { call, events, store };
}

beforeEach(() => {
  fs.rmSync(file, { force: true });
  settings.setSignedIn("chatgpt", false);
  settings.setSignedIn("opencode", false);
  settings.loadSettings();
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("starts with the ChatGPT and OpenCode sign-ins and nothing picked; no API key fields", async () => {
  const { call } = await app();
  const { json } = await call("GET", "/settings");
  expect(json.providers.map((provider: { id: string; name: string; signIn: string; signedIn: boolean; models: string[] }) => [provider.id, provider.name, provider.signIn, provider.signedIn, provider.models]))
    .toEqual([["openai", "ChatGPT", "chatgpt", false, []], ["opencode-go", "OpenCode Go", "opencode", false, []], ["opencode", "OpenCode Zen", "opencode", false, []]]);
  expect(json.signIns).toEqual([{ id: "chatgpt", name: "ChatGPT", signedIn: false, account: null }, { id: "opencode", name: "OpenCode", signedIn: false, account: null }]);
  expect(json).toMatchObject({ defaultModel: "", configured: false });
  expect(JSON.stringify(json)).not.toContain("apiKey");
});

test("models are offered only while their sign-in is done; Bots fall back to a model that works", async () => {
  const { call } = await app();
  expect((await call("PUT", "/settings/providers/opencode-go", { models: ["deepseek-v4.1-flash", "mimo-v2.6-pro"] })).status).toBe(200);
  expect((await call("PUT", "/settings/providers/openai", { models: ["gpt-5.5"] })).status).toBe(200);
  expect(settings.modelOptions()).toEqual([]);
  expect(settings.resolveModel("opencode-go::mimo-v2.6-pro")).toBeNull();

  settings.setSignedIn("opencode", null);
  expect(settings.modelOptions().map((option) => option.ref)).toEqual(["opencode-go::deepseek-v4.1-flash", "opencode-go::mimo-v2.6-pro"]);
  expect(settings.resolveModel("opencode-go::mimo-v2.6-pro")).toMatchObject({ model: "mimo-v2.6-pro", provider: { id: "opencode-go", name: "OpenCode Go" } });
  // A ChatGPT model while ChatGPT is signed out: the default instead.
  expect(settings.resolveModel("openai::gpt-5.5")).toMatchObject({ ref: "opencode-go::deepseek-v4.1-flash" });
  expect((await call("PUT", "/settings/default-model", { model: "openai::gpt-5.5" })).status).toBe(400);
  expect((await call("PUT", "/settings/default-model", { model: "opencode-go::mimo-v2.6-pro" })).json).toMatchObject({ defaultModel: "opencode-go::mimo-v2.6-pro", configured: true });

  settings.setSignedIn("chatgpt", null);
  expect(settings.resolveModel("openai::gpt-5.5")).toMatchObject({ provider: { id: "openai" } });
  expect((await call("GET", "/settings")).json.providers[0].catalog).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gpt-5.5", images: true })]));
});

test("from API keys to sign-ins: OpenCode and OpenAI models carry over, Bots keep them, the keys are dropped", async () => {
  fs.writeFileSync(file, JSON.stringify({
    providers: [
      { id: "env", name: "OpenCode Go", baseURL: "https://opencode.ai/zen/go/v1", protocol: "openai", apiKey: "sk-go-key-1111", models: ["mimo-v2.6-pro", "deepseek-v4.1-flash"], desktop: ["mimo-v2.6-pro"] },
      { id: "pclaude", name: "Claude (Anthropic)", baseURL: "https://api.anthropic.com/v1", protocol: "anthropic", apiKey: "sk-ant-key-2222", models: ["claude-haiku-5-5"], desktop: ["claude-haiku-5-5"] },
      { id: "popenai", name: "OpenAI", baseURL: "https://api.openai.com/v1", protocol: "openai", apiKey: "sk-openai-key-33334444", models: ["gpt-5.5"], desktop: [], prices: { "gpt-5.5": { input: 1, output: 2 } } },
    ],
    defaultModel: "env::deepseek-v4.1-flash",
    voice: { providerId: "popenai", voice: "nova" },
  }));
  settings.loadSettings();
  settings.setSignedIn("opencode", null);
  expect(settings.providerById("opencode-go")).toMatchObject({ models: ["mimo-v2.6-pro", "deepseek-v4.1-flash"], desktop: ["mimo-v2.6-pro"] });
  expect(settings.providerById("openai")).toMatchObject({ models: ["gpt-5.5"], prices: { "gpt-5.5": { input: 1, output: 2 } } });
  expect(settings.defaultModel()).toBe("opencode-go::deepseek-v4.1-flash");
  // A Bot that pointed at the old provider still finds its model.
  expect(settings.resolveModel("env::mimo-v2.6-pro", { fallback: false })).toMatchObject({ ref: "opencode-go::mimo-v2.6-pro" });
  // Claude by API key has nowhere to go: its Bots use the default.
  expect(settings.resolveModel("pclaude::claude-haiku-5-5")).toMatchObject({ ref: "opencode-go::deepseek-v4.1-flash" });
  // Voice keeps the OpenAI key it used; no other key is left on disk.
  expect(settings.voiceEndpoint()).toEqual({ baseURL: "https://api.openai.com/v1", apiKey: "sk-openai-key-33334444" });
  expect(settings.voiceSettings().voice).toBe("nova");
  const saved = fs.readFileSync(file, "utf8");
  expect(saved).not.toContain("sk-go-key");
  expect(saved).not.toContain("sk-ant-key");
  // Loading again changes nothing.
  settings.loadSettings();
  expect(settings.resolveModel("env::mimo-v2.6-pro", { fallback: false })).toMatchObject({ ref: "opencode-go::mimo-v2.6-pro" });
  expect(settings.voiceEndpoint()?.apiKey).toBe("sk-openai-key-33334444");
});

test("voice is the one API key: saved here, only its last four characters go out", async () => {
  const { call } = await app();
  const { json, text } = await call("PUT", "/settings/voice", { baseURL: "https://api.openai.com/v1/", apiKey: "sk-voice-secret-9876" });
  expect(json.voice).toMatchObject({ baseURL: "https://api.openai.com/v1", keySet: true, keyHint: "9876" });
  expect(text).not.toContain("sk-voice-secret");
  expect((await call("GET", "/settings")).text).not.toContain("sk-voice-secret");
  // Leaving the key out keeps it; "" removes it; an empty address turns voice off.
  await call("PUT", "/settings/voice", { voice: "nova" });
  expect(settings.voiceEndpoint()).toEqual({ baseURL: "https://api.openai.com/v1", apiKey: "sk-voice-secret-9876" });
  await call("PUT", "/settings/voice", { apiKey: "" });
  expect(settings.voiceEndpoint()?.apiKey).toBe("");
  await call("PUT", "/settings/voice", { baseURL: "" });
  expect(settings.voiceEndpoint()).toBeNull();
  expect((await call("PUT", "/settings/voice", { baseURL: "ftp://x" })).status).toBe(400);
});

test("rejects bad input", async () => {
  const { call } = await app();
  expect((await call("PUT", "/settings/providers/missing", { models: ["m"] })).status).toBe(404);
  expect((await call("PUT", "/settings/providers/openai", { models: "gpt-5.5" })).status).toBe(400);
  expect((await call("POST", "/settings/signins/chatgpt/start")).status).toBe(503);
});
