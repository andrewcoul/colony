import { z } from "zod";
import type { DesktopService } from "../computer/desktop.js";
import { SCREEN } from "../computer/desktop.js";
import type { ColonyTool, ToolContext, ToolRegistry } from "./tools.js";

/** How a Bot drives its desktop: Colony's desktop_* tools, for any model that passed the desktop check. */
export type DesktopMode = "generic";

const quote = (text: string, max = 40) => `“${text.length > max ? text.slice(0, max - 1) + "…" : text}”`;
const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Desktop tools for vision models. Every action is followed by a fresh
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
