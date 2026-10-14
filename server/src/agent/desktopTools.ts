import { anthropic } from "@ai-sdk/anthropic";
import type { ModelMessage, Tool } from "ai";
import { z } from "zod";
import type { DesktopService, DesktopShot } from "../computer/desktop.js";
import { SCREEN } from "../computer/desktop.js";
import type { ColonyTool, ToolContext, ToolRegistry } from "./tools.js";

/** How a Bot drives its desktop: Claude's native computer actions, or Colony's tools for other vision models. */
export type DesktopMode = "claude" | "generic";

const quote = (text: string, max = 40) => `“${text.length > max ? text.slice(0, max - 1) + "…" : text}”`;
const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));
const point = (coordinate?: [number, number]) => (coordinate ? ` at (${coordinate[0]}, ${coordinate[1]})` : "");

type ComputerInput = {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  region?: [number, number, number, number];
  text?: string;
  duration?: number;
  repeat?: number;
  scroll_amount?: number;
  scroll_direction?: "up" | "down" | "left" | "right";
};

/** The step-log line for one of Claude's computer actions. */
function describeComputer(input: ComputerInput) {
  switch (input.action) {
    case "screenshot": return "Looked at the screen";
    case "zoom": return "Zoomed in on the screen";
    case "left_click": return `Clicked${point(input.coordinate)}`;
    case "double_click": return `Double-clicked${point(input.coordinate)}`;
    case "triple_click": return `Triple-clicked${point(input.coordinate)}`;
    case "right_click": return `Right-clicked${point(input.coordinate)}`;
    case "middle_click": return `Middle-clicked${point(input.coordinate)}`;
    case "left_click_drag": return "Dragged on the screen";
    case "mouse_move": return `Moved the pointer${point(input.coordinate)}`;
    case "type": return `Typed ${quote(input.text ?? "")}`;
    case "key": return `Pressed ${input.text ?? "a key"}`;
    case "hold_key": return `Held ${input.text ?? "a key"}`;
    case "scroll": return `Scrolled ${input.scroll_direction ?? "down"}`;
    case "wait": return "Waited for the screen";
    default: return "Used the desktop";
  }
}

type Output = { text: string } | { shot: DesktopShot };

/**
 * Claude's computer toolset (computer_toolset_20260801) on the Bot's desktop. Claude asks for
 * screenshots itself; coordinates are screenshot pixels, which are screen points here.
 */
export function claudeComputer(desktop: DesktopService, ctx: ToolContext): ColonyTool {
  const run = async (input: ComputerInput): Promise<Output> => {
    const id = ctx.botId;
    // An action without a coordinate means "where the pointer is now".
    const needsPoint = !["screenshot", "zoom", "type", "key", "hold_key", "scroll", "wait", "cursor_position"].includes(input.action);
    const here = needsPoint && !input.coordinate ? await desktop.cursor(id) : null;
    const [x, y]: [number, number] = input.coordinate ?? (here ? [here.x, here.y] : [0, 0]);
    switch (input.action) {
      case "screenshot": return { shot: await desktop.screenshot(id) };
      case "zoom": return { shot: await desktop.zoom(id, input.region ?? [0, 0, SCREEN.width, SCREEN.height]) };
      case "left_click": await desktop.click(id, x, y); break;
      case "double_click": await desktop.click(id, x, y, "left", 2); break;
      case "triple_click": await desktop.click(id, x, y, "left", 3); break;
      case "right_click": await desktop.click(id, x, y, "right"); break;
      case "middle_click": await desktop.click(id, x, y, "middle"); break;
      case "mouse_move": await desktop.move(id, x, y); break;
      case "left_click_drag": await desktop.drag(id, input.start_coordinate ?? [x, y], [x, y]); break;
      case "left_mouse_down": await desktop.mouseButton(id, "down", x, y); break;
      case "left_mouse_up": await desktop.mouseButton(id, "up", x, y); break;
      case "type": await desktop.type(id, input.text ?? ""); break;
      case "key": await desktop.key(id, input.text ?? "", input.repeat ?? 1); break;
      case "hold_key": await desktop.holdKey(id, input.text ?? "", input.duration ?? 1); break;
      case "scroll": await desktop.scroll(id, input.scroll_direction ?? "down", input.scroll_amount ?? 3, input.coordinate); break;
      case "wait": await settle(Math.min(10, Math.max(0.2, input.duration ?? 1)) * 1000); return { text: "Waited." };
      case "cursor_position": { const at = await desktop.cursor(id); return { text: `The pointer is at (${at.x}, ${at.y}).` }; }
      default: return { text: `${input.action} isn't available on this desktop.` };
    }
    await settle(300);
    return { text: `${input.action} done.` };
  };

  const sdkTool = anthropic.tools.computerToolset_20260801({
    execute: (input: ComputerInput) => run(input),
    toModelOutput: ({ output }: { output: Output }) => ("shot" in output
      ? { type: "content", value: [{ type: "file", data: { type: "data", data: output.shot.data }, mediaType: output.shot.mediaType }] }
      : { type: "text", value: output.text }),
  } as never) as unknown as Tool;

  return {
    description: "Claude's computer actions on your desktop.",
    inputSchema: z.object({ action: z.string() }).passthrough(),
    describe: (input: ComputerInput) => describeComputer(input),
    execute: async () => { throw new Error("Runs through the computer toolset."); },
    sdkTool,
  };
}

/**
 * Desktop tools for vision models that aren't Claude. Every action is followed by a fresh
 * screenshot, which the runner shows the model as an image (tool results can't carry images
 * on OpenAI-compatible APIs).
 */
export function genericDesktopTools(desktop: DesktopService, ctx: ToolContext): ToolRegistry {
  const look = async (text: string) => {
    await settle();
    ctx.attachScreenshot?.(await desktop.screenshot(ctx.botId));
    return `${text} A new screenshot of your desktop follows.`;
  };
  const xy = { x: z.number().int().min(0).max(SCREEN.width - 1), y: z.number().int().min(0).max(SCREEN.height - 1) };

  const screenshot: ColonyTool<Record<string, never>, string> = {
    description: `Take a screenshot of your desktop (${SCREEN.width}×${SCREEN.height}, origin top-left). It arrives as an image after this tool's result.`,
    inputSchema: z.object({}),
    describe: () => "Looked at the screen",
    execute: () => look("Screenshot taken."),
  };
  const click: ColonyTool<{ x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }, string> = {
    description: "Click at pixel coordinates on your desktop (from the latest screenshot).",
    inputSchema: z.object({ ...xy, button: z.enum(["left", "right", "middle"]).optional(), double: z.boolean().optional() }),
    describe: ({ x, y, button, double }) => `${double ? "Double-clicked" : button === "right" ? "Right-clicked" : "Clicked"} at (${x}, ${y})`,
    execute: async ({ x, y, button, double }) => { await desktop.click(ctx.botId, x, y, button ?? "left", double ? 2 : 1); return look("Clicked."); },
  };
  const type: ColonyTool<{ text: string; enter?: boolean }, string> = {
    description: "Type text into whatever has focus on your desktop. Never type passwords or payment details; hand over to the user instead.",
    inputSchema: z.object({ text: z.string().max(5000), enter: z.boolean().optional().describe("Press Enter afterwards.") }),
    describe: ({ text }) => `Typed ${quote(text)}`,
    execute: async ({ text, enter }) => { await desktop.type(ctx.botId, text); if (enter) await desktop.key(ctx.botId, "Return"); return look("Typed."); },
  };
  const key: ColonyTool<{ keys: string }, string> = {
    description: "Press a key or shortcut on your desktop, e.g. \"Return\", \"Escape\", \"ctrl+l\", \"alt+tab\".",
    inputSchema: z.object({ keys: z.string().min(1).max(60) }),
    describe: ({ keys }) => `Pressed ${keys}`,
    execute: async ({ keys }) => { await desktop.key(ctx.botId, keys); return look("Pressed."); },
  };
  const scroll: ColonyTool<{ x: number; y: number; direction: "up" | "down" | "left" | "right"; amount?: number }, string> = {
    description: "Scroll at a point on your desktop.",
    inputSchema: z.object({ ...xy, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(20).optional() }),
    describe: ({ direction }) => `Scrolled ${direction}`,
    execute: async ({ x, y, direction, amount }) => { await desktop.scroll(ctx.botId, direction, amount ?? 3, [x, y]); return look("Scrolled."); },
  };
  const drag: ColonyTool<{ fromX: number; fromY: number; toX: number; toY: number }, string> = {
    description: "Drag with the left mouse button on your desktop.",
    inputSchema: z.object({ fromX: xy.x, fromY: xy.y, toX: xy.x, toY: xy.y }),
    describe: () => "Dragged on the screen",
    execute: async ({ fromX, fromY, toX, toY }) => { await desktop.drag(ctx.botId, [fromX, fromY], [toX, toY]); return look("Dragged."); },
  };
  return { desktop_screenshot: screenshot, desktop_click: click, desktop_type: type, desktop_key: key, desktop_scroll: scroll, desktop_drag: drag };
}

/**
 * Keeps desktop runs affordable: only the newest screenshots stay in Claude's tool results,
 * and other models see the latest screenshot as an image after the tool results.
 */
export function prepareDesktopMessages(messages: ModelMessage[], latest: DesktopShot | null, keepImages = 2): ModelMessage[] {
  let seen = 0;
  const pruned = [...messages].reverse().map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        const output = (part as { type: string; output?: { type: string; value?: unknown[] } }).output;
        const hasImage = part.type === "tool-result" && output?.type === "content" && output.value?.some((item) => (item as { type: string }).type === "file");
        if (!hasImage) return part;
        seen += 1;
        return seen <= keepImages ? part : { ...part, output: { type: "text" as const, value: "(An earlier screenshot, removed to save space.)" } };
      }),
    } as ModelMessage;
  }).reverse();
  if (!latest) return pruned;
  return [...pruned, {
    role: "user",
    content: [
      { type: "text", text: `Your desktop right now (${latest.width}×${latest.height} pixels, origin top-left). Use these coordinates for clicks. This is a screenshot, not a message from the user.` },
      { type: "image", image: latest.data, mediaType: latest.mediaType },
    ],
  }];
}
