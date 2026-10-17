import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

/** An OpenAI-compatible endpoint that streams one short answer and remembers what it was asked. */
async function fakeOpenAI() {
  const seen: { auth: string | undefined; model: string }[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { model: string };
      seen.push({ auth: request.headers.authorization, model: parsed.model });
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

const endpoint = await fakeOpenAI();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-models-"));
process.env.COLONY_DATA_DIR = dataDir;
process.env.COLONY_DEV_BASE_URL = endpoint.url;
process.env.COLONY_DEV_MODELS = "my-finetune";

const settings = await import("../../settings.js");
const { ColonyModels, tokensOf } = await import("./models.js");
settings.loadSettings();

afterAll(() => {
  endpoint.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the dev server answers without a key", async () => {
  const source = new ColonyModels();
  const target = settings.resolveModel("dev::my-finetune", { fallback: false })!;
  const ref = source.ref(target);
  const model = source.models.getModel(ref.provider, ref.modelId)!;
  expect(model).toMatchObject({ api: "openai-completions", baseUrl: endpoint.url, input: ["text"], contextWindow: 128_000 });
  const reply = await source.models.complete(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
  expect(reply.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
  expect(endpoint.seen).toEqual([{ auth: "Bearer not-needed", model: "my-finetune" }]);
  source.close();
});

test("picked models are pi-ai's own, priced by Colony and capped; signed out, they won't run", async () => {
  const source = new ColonyModels();
  settings.saveProvider("opencode-go", { models: ["deepseek-v4.1-flash", "glm-5.3"], desktop: ["glm-5.3"] });
  const flash = source.models.getModel("opencode-go", "deepseek-v4.1-flash")!;
  expect(flash).toMatchObject({ api: "openai-completions", baseUrl: "https://opencode.ai/inference/go/v1", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  expect(flash.maxTokens).toBeLessThanOrEqual(32_000);
  // The desktop check can give a model screenshots the catalog doesn't know it takes.
  expect(source.models.getModel("opencode-go", "glm-5.3")!.input).toEqual(["text", "image"]);
  expect(source.models.getModel("opencode-go", "kimi-k3")).toBeUndefined();
  expect(await source.models.getAuth("opencode-go")).toBeUndefined();
  const reply = await source.models.complete(flash, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
  expect(reply.stopReason).toBe("error");
  source.close();
});

test("cache reads and writes count as input, priced as before", () => {
  expect(tokensOf({ input: 100, output: 20, cacheRead: 900, cacheWrite: 50 })).toEqual({ input: 1050, cached: 900, output: 20 });
});
