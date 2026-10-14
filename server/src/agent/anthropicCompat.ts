/**
 * Some gateways that speak Anthropic's Messages API (OpenCode Go, at least) drop the
 * `toolset_name` field from tool_use blocks. The AI SDK needs it to route computer
 * actions ("screenshot", "left_click", …) to the computer tool, so put it back.
 */
const COMPUTER_ACTIONS = new Set([
  "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position",
  "scroll", "type", "key", "hold_key", "wait",
]);

type Block = { type?: string; name?: string; toolset_name?: string };

function patchBlock(block: Block | undefined) {
  if (block?.type === "tool_use" && block.name && !block.toolset_name && COMPUTER_ACTIONS.has(block.name)) block.toolset_name = "computer";
}

/** Rewrites one SSE `data:` payload (streaming) if it starts a computer tool_use block. */
function patchEventData(data: string) {
  if (!data.includes("tool_use")) return data;
  try {
    const event = JSON.parse(data) as { type?: string; content_block?: Block };
    if (event.type !== "content_block_start") return data;
    patchBlock(event.content_block);
    return JSON.stringify(event);
  } catch { return data; }
}

function patchStream(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const flushLines = (final: boolean, controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = buffer.split("\n");
    buffer = final ? "" : lines.pop() ?? "";
    const out = lines.map((line) => (line.startsWith("data: ") ? `data: ${patchEventData(line.slice(6))}` : line)).join("\n");
    if (out || lines.length) controller.enqueue(encoder.encode(final ? out : `${out}\n`));
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); flushLines(false, controller); },
    flush(controller) { buffer += decoder.decode(); flushLines(true, controller); },
  }));
}

/** A fetch for Anthropic-format providers that restores `toolset_name` on computer actions. */
export const restoreToolsetNames: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !response.body) return response;
  if (type.includes("text/event-stream")) {
    return new Response(patchStream(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  if (type.includes("json")) {
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { content?: Block[] };
      body.content?.forEach(patchBlock);
      return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch {
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  }
  return response;
};
