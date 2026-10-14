// Starts a release: sets the version everywhere, commits, and tags it.
//   npm run release -- 0.2.0
// Then `git push --follow-tags`; the tag makes GitHub Actions build and publish the release
// (.github/workflows/release.yml), which every Colony server and desktop app updates from.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error("Usage: npm run release -- <version>, e.g. 0.2.0");

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain")) throw new Error("Commit or stash your changes first.");

for (const file of ["package.json", "server/package.json", "web/package.json", "desktop/package.json"]) {
  const full = path.join(root, file);
  const text = fs.readFileSync(full, "utf8");
  fs.writeFileSync(full, text.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`));
}
const npm = (cwd) => execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund", "--loglevel=error"], { cwd, stdio: "inherit", shell: process.platform === "win32" });
npm(root);
npm(path.join(root, "desktop"));

git("add", "-A");
git("commit", "-m", `Release v${version}`);
git("tag", "-a", `v${version}`, "-m", `Colony ${version}`);
console.log(`Tagged v${version}. Publish it with: git push --follow-tags`);
