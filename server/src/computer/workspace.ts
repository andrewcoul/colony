import fs from "node:fs";
import path from "node:path";
import { workspaceDir } from "../files.js";

const MAX_READ = 200_000;

/**
 * Resolves a Bot-supplied path inside its workspace. Accepts "src/a.ts", "/workspace/src/a.ts",
 * or "./a.ts"; rejects anything that escapes the workspace, including through symlinks.
 */
export function resolveInWorkspace(botId: string, input: string) {
  fs.mkdirSync(workspaceDir(botId), { recursive: true });
  const root = fs.realpathSync(workspaceDir(botId));
  const relative = input.replace(/\\/g, "/").replace(/^\/workspace(\/|$)/, "").replace(/^\/+/, "");
  const target = path.resolve(root, relative || ".");
  const inside = (candidate: string) => candidate === root || candidate.startsWith(root + path.sep);
  if (!inside(target)) throw new Error(`"${input}" is outside the workspace.`);
  // Follow existing symlinks (on the path or its nearest existing parent) and re-check.
  let probe = target;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  if (!inside(fs.realpathSync(probe))) throw new Error(`"${input}" is outside the workspace.`);
  return { root, target, display: "/workspace/" + path.relative(root, target).replace(/\\/g, "/") };
}

export function readWorkspaceFile(botId: string, file: string, offset = 0, limit = MAX_READ) {
  const { target, display } = resolveInWorkspace(botId, file);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) throw new Error(`${display} is a directory; use list_files.`);
  const buffer = fs.readFileSync(target);
  if (buffer.subarray(0, 8000).includes(0)) throw new Error(`${display} looks like a binary file.`);
  const text = buffer.toString("utf8");
  const slice = text.slice(offset, offset + limit);
  return { path: display, content: slice, size: text.length, truncated: offset + limit < text.length };
}

export function writeWorkspaceFile(botId: string, file: string, content: string) {
  const { target, display } = resolveInWorkspace(botId, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return { path: display, bytes: Buffer.byteLength(content) };
}

/** Replaces exactly one occurrence of `find`; ambiguity is an error so edits stay precise. */
export function editWorkspaceFile(botId: string, file: string, find: string, replace: string) {
  const { target, display } = resolveInWorkspace(botId, file);
  const text = fs.readFileSync(target, "utf8");
  const count = find ? text.split(find).length - 1 : 0;
  if (count !== 1) throw new Error(count ? `The text to replace appears ${count} times in ${display}; include more context.` : `The text to replace wasn't found in ${display}.`);
  const next = text.replace(find, () => replace);
  fs.writeFileSync(target, next, "utf8");
  const lines = (value: string) => value.split("\n").length;
  return { path: display, added: lines(replace), removed: lines(find) };
}

export type FileEntry = { name: string; path: string; type: "file" | "dir"; size: number; modifiedAt: number };

const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".next"]);

export function listWorkspace(botId: string, dir = "", depth = 1): FileEntry[] {
  const { target, root } = resolveInWorkspace(botId, dir);
  const out: FileEntry[] = [];
  const walk = (current: string, level: number) => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (out.length >= 500) return;
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      out.push({
        name: entry.name,
        path: "/workspace/" + path.relative(root, full).replace(/\\/g, "/"),
        type: entry.isDirectory() ? "dir" : "file",
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
      if (entry.isDirectory() && level < depth && !SKIP.has(entry.name)) walk(full, level + 1);
    }
  };
  walk(target, 1);
  return out;
}
