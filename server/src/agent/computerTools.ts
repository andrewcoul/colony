import { z } from "zod";
import type { ComputerService } from "../computer/docker.js";
import { approvalReason } from "../computer/policy.js";
import * as ws from "../computer/workspace.js";
import type { ColonyTool, ToolRegistry } from "./tools.js";

const short = (text: string, max = 60) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};
const fileName = (path: string) => path.replace(/^\/workspace\/?/, "") || "/workspace";

/** Pulls a useful one-liner out of command output, e.g. "212 passed". */
function outcome(result: { exitCode: number; output: string; timedOut: boolean; durationMs: number }) {
  if (result.timedOut) return "timed out";
  const tests = /(\d+)\s+(passed|passing)/i.exec(result.output);
  const seconds = `${Math.max(0.1, Math.round(result.durationMs / 100) / 10)}s`;
  if (tests && result.exitCode === 0) return `${tests[1]} passed`;
  return result.exitCode === 0 ? seconds : `exit ${result.exitCode}`;
}

/** Tools for Bots that have their own computer (a Docker container with /workspace). */
export function computerTools(computer: ComputerService): ToolRegistry {
  const shell: ColonyTool<{ command: string; cwd?: string; timeoutSec?: number }, unknown> = {
    description: "Run a bash command on your own Linux computer (Debian, Node 22, Python 3, git, ripgrep). /workspace persists between runs. Commands that publish, push, or send data outside the PC wait for the user's approval automatically.",
    inputSchema: z.object({
      command: z.string().min(1).max(8000),
      cwd: z.string().max(400).optional().describe("Working directory under /workspace."),
      timeoutSec: z.number().int().min(1).max(1800).optional().describe("Default 120."),
    }),
    describe: ({ command }) => `Ran \`${short(command, 56)}\``,
    summarize: (result: any) => (result && typeof result.exitCode === "number" ? outcome(result) : undefined),
    execute: async ({ command, cwd, timeoutSec }, ctx) => {
      const reason = approvalReason(command);
      if (reason) {
        const approved = await ctx.gate.request({
          botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: "shell",
          summary: `${ctx.botName} wants to run a command`, detail: command, reason: `${reason} · always asks`,
        }, ctx.signal);
        if (!approved) throw new Error("The user denied approval for this command. Don't retry it.");
      }
      const result = await computer.exec(ctx.botId, command, { cwd, timeoutSec, signal: ctx.signal });
      return { exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output, truncated: result.truncated };
    },
  };

  const readFile: ColonyTool<{ path: string; offset?: number; limit?: number }, unknown> = {
    description: "Read a text file from your workspace.",
    inputSchema: z.object({ path: z.string().min(1).max(400), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200_000).optional() }),
    describe: ({ path }) => `Read ${fileName(path)}`,
    execute: async ({ path, offset, limit }, ctx) => ws.readWorkspaceFile(ctx.botId, path, offset, limit),
  };

  const writeFile: ColonyTool<{ path: string; content: string }, { path: string; bytes: number }> = {
    description: "Create or overwrite a file in your workspace. For small changes to an existing file, prefer edit_file.",
    inputSchema: z.object({ path: z.string().min(1).max(400), content: z.string().max(2_000_000) }),
    describe: ({ path }) => `Wrote ${fileName(path)}`,
    summarize: ({ bytes }) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`),
    execute: async ({ path, content }, ctx) => ws.writeWorkspaceFile(ctx.botId, path, content),
  };

  const editFile: ColonyTool<{ path: string; find: string; replace: string }, { added: number; removed: number }> = {
    description: "Replace one exact snippet in a workspace file. `find` must match exactly once; include surrounding lines to disambiguate.",
    inputSchema: z.object({ path: z.string().min(1).max(400), find: z.string().min(1).max(200_000), replace: z.string().max(200_000) }),
    describe: ({ path }) => `Edited ${fileName(path)}`,
    summarize: ({ added, removed }) => `+${added} −${removed}`,
    execute: async ({ path, find, replace }, ctx) => ws.editWorkspaceFile(ctx.botId, path, find, replace),
  };

  const listFiles: ColonyTool<{ path?: string; depth?: number }, ws.FileEntry[]> = {
    description: "List files in your workspace.",
    inputSchema: z.object({ path: z.string().max(400).optional(), depth: z.number().int().min(1).max(4).optional() }),
    describe: ({ path }) => `Listed ${path ? fileName(path) : "workspace"}`,
    summarize: (entries) => `${entries.length} item${entries.length === 1 ? "" : "s"}`,
    execute: async ({ path, depth }, ctx) => ws.listWorkspace(ctx.botId, path ?? "", depth ?? 2).map(({ path, type, size }) => ({ path, type, size }) as ws.FileEntry),
  };

  return { shell, read_file: readFile, write_file: writeFile, edit_file: editFile, list_files: listFiles };
}
