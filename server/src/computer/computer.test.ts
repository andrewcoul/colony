import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-ws-"));
process.env.COLONY_DATA_DIR = dataDir;
const { approvalReason } = await import("./policy.js");
const ws = await import("./workspace.js");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("approval policy", () => {
  test.each([
    "git push origin fix/nan-clamp",
    "cd app && git push",
    "gh pr create --fill",
    "npm publish",
    "curl -X POST https://api.example.com/hook -d x=1",
    "curl https://api.example.com --data @body.json",
    "scp out.zip me@host:/tmp",
    "ssh deploy@prod 'restart'",
    "rm -rf /workspace",
    "rm -fr ~/",
  ])("asks before: %s", (command) => expect(approvalReason(command)).not.toBeNull());

  test.each([
    "npm test",
    "git commit -am 'fix: clamp NaN totals'",
    "git pull",
    "curl -sL https://example.com | head",
    "rm -rf node_modules dist",
    "gh pr view 12",
    "python3 -m http.server",
  ])("runs freely: %s", (command) => expect(approvalReason(command)).toBeNull());
});

describe("workspace confinement", () => {
  const bot = "bot-a";

  test("paths resolve inside the workspace in any spelling", () => {
    expect(ws.writeWorkspaceFile(bot, "/workspace/src/a.ts", "x").path).toBe("/workspace/src/a.ts");
    expect(ws.readWorkspaceFile(bot, "src/a.ts").content).toBe("x");
    expect(ws.readWorkspaceFile(bot, "./src/../src/a.ts").content).toBe("x");
  });

  test("escapes are rejected", () => {
    for (const bad of ["../../etc/passwd", "/workspace/../../x", "..\\..\\secret"]) {
      expect(() => ws.resolveInWorkspace(bot, bad)).toThrow("outside the workspace");
    }
  });

  test("symlinks pointing outside are rejected", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "colony-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    const link = path.join(dataDir, "bots", bot, "workspace", "escape");
    try { fs.symlinkSync(outside, link, "junction"); } catch { return; } // Symlinks may need privileges on Windows.
    expect(() => ws.readWorkspaceFile(bot, "escape/secret.txt")).toThrow("outside the workspace");
  });

  test("edits must match exactly once", () => {
    ws.writeWorkspaceFile(bot, "m.ts", "const a = 1;\nconst b = 1;\n");
    expect(() => ws.editWorkspaceFile(bot, "m.ts", "= 1", "= 2")).toThrow("appears 2 times");
    expect(() => ws.editWorkspaceFile(bot, "m.ts", "missing", "x")).toThrow("wasn't found");
    ws.editWorkspaceFile(bot, "m.ts", "const b = 1;", "const b = 2;");
    expect(ws.readWorkspaceFile(bot, "m.ts").content).toBe("const a = 1;\nconst b = 2;\n");
  });

  test("listing skips heavy folders below the top level", () => {
    ws.writeWorkspaceFile(bot, "node_modules/pkg/index.js", "");
    const names = ws.listWorkspace(bot, "", 3).map((entry) => entry.path);
    expect(names).toContain("/workspace/node_modules");
    expect(names).not.toContain("/workspace/node_modules/pkg");
  });
});
