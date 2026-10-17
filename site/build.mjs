// Builds site/dist/worker.js: one self-contained ES module with Colony's web app (web/dist)
// embedded, ready to upload through the Cloudflare API (no wrangler), and site/dist/metadata.json.
// Run `npm run build` at the repository root first, so web/dist is current.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../web/dist");
const dist = path.join(here, "dist");
const LIMIT = 3 * 1024 * 1024;
const COMPATIBILITY_DATE = "2026-10-01";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

if (!fs.existsSync(path.join(web, "index.html"))) {
  console.error("web/dist is missing: run `npm run build` at the repository root first.");
  process.exit(1);
}

/** Every file in web/dist, by its path in the site ("/assets/index-….js"). */
function walk(dir, files = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, files); continue; }
    if (entry.name.endsWith(".map")) continue;
    const key = `/${path.relative(web, full).split(path.sep).join("/")}`;
    files[key] = { body: fs.readFileSync(full).toString("base64"), type: TYPES[path.extname(entry.name).toLowerCase()] ?? "application/octet-stream" };
  }
  return files;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const assets = walk(web);
const generated = path.join(dist, "assets.generated.js");
fs.writeFileSync(generated, `export default ${JSON.stringify(assets)};\n`);

await build({
  stdin: {
    contents: `import assets from ${JSON.stringify(generated)};\nimport { createWorker } from ${JSON.stringify(path.join(here, "src/worker.ts"))};\nexport default createWorker(assets);\n`,
    resolveDir: here, sourcefile: "entry.js", loader: "js",
  },
  bundle: true, format: "esm", platform: "neutral", target: "es2022", minify: true, outfile: path.join(dist, "worker.js"), logLevel: "warning",
});
fs.rmSync(generated);

fs.writeFileSync(path.join(dist, "metadata.json"), `${JSON.stringify({
  main_module: "worker.js",
  compatibility_date: COMPATIBILITY_DATE,
  // ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET are set separately, as secrets.
  bindings: [{ type: "plain_text", name: "ORIGIN_URL", text: process.env.ORIGIN_URL ?? "https://colony-origin.werdna.xyz" }],
}, null, 2)}\n`);

const size = fs.statSync(path.join(dist, "worker.js")).size;
console.log(`site/dist/worker.js: ${(size / 1024 / 1024).toFixed(2)} MB (${Object.keys(assets).length} files embedded)`);
if (size > LIMIT) {
  console.error(`That's over the ${LIMIT / 1024 / 1024} MB limit.`);
  process.exit(1);
}
