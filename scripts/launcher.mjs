// Colony's launcher, for installed servers (see install.ps1). It lives in the install's home
// folder and keeps the server running:
//   - runs `trial ?? current` from versions/<version>/ (state.json says which),
//   - starts it again when it exits (right away when it asks to, e.g. after an update),
//   - goes back to the previous version if a new one exits before confirming it started.
// Plain JavaScript with no dependencies, so it never needs installing.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(home, "state.json");
const RESTART = 75; // Matches RESTART in server/src/updates.ts.

const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => {
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
};
const log = (text) => console.log(`${new Date().toISOString()} [launcher] ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child = null;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child?.kill(); process.exit(0); });

while (true) {
  const state = readState();
  const version = state.trial ?? state.current;
  const folder = path.join(home, "versions", version);
  log(`Starting Colony ${version}${state.trial ? " (new version)" : ""}.`);
  const code = await new Promise((resolve) => {
    child = spawn(process.execPath, [`--env-file-if-exists=${path.join(home, ".env")}`, path.join(folder, "server", "dist", "index.js")], {
      cwd: fs.existsSync(folder) ? folder : home,
      stdio: "inherit",
      env: { ...process.env, COLONY_HOME: home },
      windowsHide: true,
    });
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    child.on("error", () => resolve(1));
  });
  child = null;

  const after = readState();
  if (after.trial === version) {
    // The new version stopped before confirming itself: go back to the one that worked.
    writeState({ ...after, trial: null, failed: { version, at: new Date().toISOString(), reason: `It stopped (code ${code}) before it finished starting.` } });
    log(`Colony ${version} didn't start (code ${code}); going back to ${after.current}.`);
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* removed on the next update */ }
    continue;
  }
  if (code === RESTART) continue;
  log(`Colony exited with code ${code}. Restarting in 10 seconds.`);
  await sleep(10_000);
}
