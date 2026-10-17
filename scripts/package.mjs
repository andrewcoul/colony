// Packages the built server and web app as a release archive for this platform:
//   release/colony-server-<version>-<platform>-<arch>.zip   (with its production dependencies)
//   release/install-colony-server.ps1                       (the Windows installer)
//   release/SHA256SUMS
// Run `npm run build` first. CI runs this for every release (.github/workflows/release.yml).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const { version, engines, license } = read("package.json");
const server = read("server/package.json");
const platform = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const name = `colony-server-${version}-${platform}.zip`;
const out = path.join(root, "release");
const stage = path.join(out, "stage");

for (const built of ["server/dist/index.js", "web/dist/index.html"]) {
  if (!fs.existsSync(path.join(root, built))) throw new Error(`Missing ${built}: run npm run build first.`);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(stage, to), { recursive: true, filter: (source) => !source.endsWith(".test.js") });
for (const item of ["server/dist", "server/assets", "web/dist", "computer", ".env.example", "README.md", "LICENSE"]) copy(item);
for (const script of ["launcher.mjs", "service.ps1", "install.ps1"]) copy(`scripts/${script}`);

// Pin the server's direct dependencies to the versions this build was tested with.
// npm keeps a dependency in server/node_modules when it can't share the root's copy.
const installed = (dependency) => {
  const file = ["server/node_modules", "node_modules"].map((dir) => path.join(root, dir, dependency, "package.json")).find((candidate) => fs.existsSync(candidate));
  return JSON.parse(fs.readFileSync(file, "utf8")).version;
};
const dependencies = Object.fromEntries(Object.keys(server.dependencies).map((dependency) => [dependency, installed(dependency)]));
const write = (file, data) => fs.writeFileSync(path.join(stage, file), `${JSON.stringify(data, null, 2)}\n`);
write("package.json", { name: "colony-server", version, private: true, type: "module", license, engines, dependencies });
write("server/package.json", { name: "@colony/server", version, private: true, type: "module" });

console.log(`Installing production dependencies for ${platform}...`);
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });

const archive = path.join(out, name);
fs.rmSync(archive, { force: true });
// bsdtar (built into Windows 10+ and macOS) writes a zip when the name ends in .zip.
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
execFileSync(tar, ["-a", "-c", "-f", archive, "-C", stage, "."], { stdio: "inherit" });
fs.copyFileSync(path.join(root, "scripts", "install.ps1"), path.join(out, "install-colony-server.ps1"));
fs.rmSync(stage, { recursive: true, force: true });

const files = [name, "install-colony-server.ps1"];
const sums = files.map((file) => `${createHash("sha256").update(fs.readFileSync(path.join(out, file))).digest("hex")}  ${file}`);
fs.writeFileSync(path.join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
const size = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
console.log(`Packaged ${name} (${size} MB), install-colony-server.ps1 and SHA256SUMS in release/.`);
