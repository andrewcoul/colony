import { afterEach, expect, test, vi } from "vitest";
import { restoreToolsetNames } from "./anthropicCompat.js";

afterEach(() => vi.unstubAllGlobals());

const reply = (body: string, type: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": type } })));

test("restores toolset_name on computer actions in a JSON reply, and leaves other tools alone", async () => {
  reply(JSON.stringify({ content: [
    { type: "tool_use", id: "a", name: "screenshot", input: {} },
    { type: "tool_use", id: "b", name: "web_search", input: { query: "x" } },
    { type: "tool_use", id: "c", name: "left_click", toolset_name: "computer", input: {} },
  ] }), "application/json");
  const body = await (await restoreToolsetNames("https://gateway.invalid/v1/messages")).json() as { content: { name: string; toolset_name?: string }[] };
  expect(body.content.map((block) => [block.name, block.toolset_name])).toEqual([["screenshot", "computer"], ["web_search", undefined], ["left_click", "computer"]]);
});

test("restores toolset_name in a streamed reply, even when an event is split across chunks", async () => {
  const start = `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "left_click", input: {} } })}\n\n`;
  const rest = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })}\n\n`;
  const encoder = new TextEncoder();
  const chunks = [start.slice(0, 40), start.slice(40), rest];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })));
  const text = await (await restoreToolsetNames("https://gateway.invalid/v1/messages")).text();
  const events = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  expect(events[0].content_block).toMatchObject({ name: "left_click", toolset_name: "computer" });
  expect(events[1].delta.partial_json).toBe("{}");
});
