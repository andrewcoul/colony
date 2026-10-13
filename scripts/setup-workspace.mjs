import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = new URL("../.colony-setup.local", import.meta.url);
let workspaceCode;
try { workspaceCode = JSON.parse(readFileSync(file, "utf8")).workspaceCode; } catch { /* First setup */ }
if (typeof workspaceCode !== "string" || !/^[a-f0-9]{64}$/.test(workspaceCode)) {
  workspaceCode = randomBytes(32).toString("hex");
}

// Invoke the CLI directly, with argument boundaries, and without a shell.
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/convex/bin/main.js", import.meta.url)),
  "env", "set", "COLONY_REGISTRATION_CODE", workspaceCode,
], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
writeFileSync(file, JSON.stringify({ workspaceCode }, null, 2) + "\n", { mode: 0o600 });
console.log("Workspace code saved in .colony-setup.local. Use it when creating your account.");
