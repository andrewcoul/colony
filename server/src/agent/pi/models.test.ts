import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-models-"));
process.env.COLONY_DATA_DIR = dataDir;
delete process.env.COLONY_API_BASE_URL;

const settings = await import("../../settings.js");
const { ColonyModels, modelFor, providerIdOf, tokensOf } = await import("./models.js");

/** An OpenAI-compatible endpoint that streams one short answer and remembers who asked, with which key. */
async function fakeOpenAI() {
  const seen: { auth: string | undefined; model: string; session: string | undefined }[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { model: string };
      seen.push({ auth: request.headers.authorization, model: parsed.model, session: request.headers["x-opencode-session"] as string | undefined });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] });
      chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() };
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("each provider in Settings is a pi provider, and each request carries that provider's own key", async () => {
  const endpoint = await fakeOpenAI();
  settings.loadSettings();
  const a = settings.saveProvider(null, { name: "A", baseURL: endpoint.url, protocol: "openai", apiKey: "key-a-111111111111", models: ["model-a"] });
  const b = settings.saveProvider(null, { name: "B", baseURL: endpoint.url, protocol: "openai", apiKey: "key-b-222222222222", models: ["model-b"] });
  const source = new ColonyModels();
  const ask = (providerId: string, model: string) => {
    const target = settings.resolveModel(settings.modelRef(providerId, model), { fallback: false })!;
    const ref = source.ref(target);
    return source.models.complete(source.models.getModel(ref.provider, ref.modelId)!, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
  };
  const [first, second] = await Promise.all([ask(a, "model-a"), ask(b, "model-b")]);
  expect(first.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
  expect(second.stopReason).toBe("stop");
  expect(endpoint.seen.map((item) => [item.model, item.auth]).sort()).toEqual([["model-a", "Bearer key-a-111111111111"], ["model-b", "Bearer key-b-222222222222"]]);

  // A changed key applies to the next request; a removed provider is gone.
  settings.saveProvider(a, { name: "A", baseURL: endpoint.url, protocol: "openai", apiKey: "key-a-333333333333", models: ["model-a"] });
  await ask(a, "model-a");
  expect(endpoint.seen.at(-1)!.auth).toBe("Bearer key-a-333333333333");
  settings.deleteProvider(b);
  expect(source.models.getProvider(providerIdOf({ id: b }))).toBeUndefined();
  expect(source.models.getProvider(providerIdOf({ id: a }))).toBeDefined();
  source.close();
  endpoint.close();
});

test("models borrow what the catalog knows, and Anthropic addresses lose their /v1", () => {
  const claude = modelFor({ id: "p", name: "Claude", baseURL: "https://api.anthropic.com/v1", protocol: "anthropic", apiKey: "", models: ["claude-sonnet-4-5"], desktop: [] }, "claude-sonnet-4-5");
  expect(claude).toMatchObject({ api: "anthropic-messages", baseUrl: "https://api.anthropic.com", reasoning: true, input: ["text", "image"] });
  expect(claude.contextWindow).toBeGreaterThanOrEqual(200_000);
  const local = modelFor({ id: "q", name: "Ollama", baseURL: "http://localhost:11434/v1", protocol: "openai", apiKey: "", models: ["my-finetune"], desktop: [] }, "my-finetune");
  expect(local).toMatchObject({ api: "openai-completions", baseUrl: "http://localhost:11434/v1", input: ["text"], contextWindow: 128_000 });
});

test("cache reads and writes count as input, priced as before", () => {
  expect(tokensOf({ input: 100, output: 20, cacheRead: 900, cacheWrite: 50 })).toEqual({ input: 1050, cached: 900, output: 20 });
});
