import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "ai";
import type { ModelTarget } from "../settings.js";
import type { ModelFactory } from "./run.js";

/**
 * A screenshot of a Bot desktop (1280×800): a terminal where `echo … && uname -sr` and `ls`
 * were run, and a dock whose Terminal icon is centred at (567, 775).
 */
const SCREENSHOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/desktop-check.png");
const TERMINAL_ICON = { x: 567, y: 775 };
const TOLERANCE = 25;

export type DesktopVerdict = { model: string; reads: boolean; points: boolean; canDrive: boolean; error?: string };

/**
 * Can this model drive a desktop? It must read text off a screenshot and point at a small
 * target within a few pixels. Passing is a good sign, not a guarantee for long tasks.
 */
export async function checkDesktop(target: ModelTarget, factory: ModelFactory): Promise<DesktopVerdict> {
  const image = fs.readFileSync(SCREENSHOT);
  const ask = async (question: string) => (await generateText({
    model: factory(target, `colony-desktop-check-${target.model}`),
    // Reasoning models think before answering; leave them room.
    maxOutputTokens: 4000,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(120_000),
    messages: [{ role: "user", content: [{ type: "text", text: question }, { type: "image", image, mediaType: "image/png" }] }],
  })).text;
  try {
    const read = await ask("This is a 1280x800 screenshot of a Linux desktop. What exact commands were typed in the terminal? Answer with just the commands, one per line.");
    const reads = /uname/.test(read) && /\bls\b/.test(read);
    const answer = await ask("This is a 1280x800 screenshot. Give the pixel coordinates of the center of the Terminal icon (the black square with >_ ) in the dock at the bottom. Reply with only: x,y");
    const match = /(\d{2,4})\s*,\s*(\d{2,4})/.exec(answer);
    const points = Boolean(match && Math.hypot(Number(match[1]) - TERMINAL_ICON.x, Number(match[2]) - TERMINAL_ICON.y) <= TOLERANCE);
    return { model: target.model, reads, points, canDrive: reads && points };
  } catch (failure) {
    const message = failure instanceof Error ? failure.message.replace(/\s+/g, " ").slice(0, 160) : "Couldn't check.";
    return { model: target.model, reads: false, points: false, canDrive: false, error: message };
  }
}
