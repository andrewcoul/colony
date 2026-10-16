import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { coreTools, type ColonyTool, type ToolRegistry } from "../tools.js";

/*
 * Tools for the restart tests (crash.fixture.ts, restart.test.ts). Each records what it did in a
 * file in the data folder, so the second life can tell what happened in the first. In the first
 * life (`life` 1) the write and the read never finish: the process is killed while they run.
 */
export function crashTools(dataDir: string, life: number): ToolRegistry {
  const log = (name: string) => fs.appendFileSync(path.join(dataDir, `${name}.log`), "x");
  const hang = () => new Promise<never>(() => {});
  const sendEmail: ColonyTool = {
    description: "Send an email (needs approval).",
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    describe: ({ to }) => `Emailed ${to}`,
    replay: "gated",
    execute: async ({ to, body }, ctx) => {
      const ok = await ctx.gate.request({ botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: "send_email",
        summary: `${ctx.botName} wants to send an email`, detail: `To: ${to}\n\n${body}`, reason: "Sends outside your PC" }, ctx.signal);
      if (!ok) throw new Error("Approval denied by the user.");
      log("sent");
      return { sent: true };
    },
  };
  const writeNote: ColonyTool = {
    description: "Write a note somewhere outside the chat.",
    inputSchema: z.object({ text: z.string() }),
    describe: () => "Wrote a note",
    execute: async () => { log("write"); if (life === 1) await hang(); return "Written."; },
  };
  const readNote: ColonyTool = {
    description: "Read the note.",
    inputSchema: z.object({}),
    describe: () => "Read the note",
    replay: "safe",
    execute: async () => { log("read"); if (life === 1) await hang(); return "The note says hello."; },
  };
  const pay: ColonyTool = {
    description: "Pay a bill (needs approval).",
    inputSchema: z.object({ amount: z.number() }),
    describe: ({ amount }) => `Paid ${amount}`,
    replay: "gated",
    execute: async ({ amount }, ctx) => {
      const ok = await ctx.gate.request({ botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: "pay",
        summary: `${ctx.botName} wants to pay ${amount}`, detail: `${amount}`, reason: "Spends money" }, ctx.signal);
      if (!ok) throw new Error("Approval denied by the user.");
      log("acting");
      if (life === 1) await hang();
      return { paid: true };
    },
  };
  return { ...coreTools, send_email: sendEmail, write_note: writeNote, read_note: readNote, pay };
}
