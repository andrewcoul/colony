// Draws every Colony icon from one SVG source, so the sizes never drift apart.
// Usage: node scripts/icons.mjs   (needs Edge or Chrome; uses the playwright-core the server already has)
//
// The King Bot is also drawn in React by web/src/components/Logo.tsx; keep the two in step.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const GROUND = "#141414";
const INK = "#0F0F0F";
const CROWN = "M13.2 10.6 12.2 3.6l4.4 3.3L20 2.2l3.4 4.7 4.4-3.3-1 7z";

/** The mark in its 40×40 box: white head, black eyes, little black crown with a white outline. */
const mark = `
  <circle cx="20" cy="23" r="15" fill="#fff"/>
  <g transform="rotate(-10 20 8) translate(4 2.6) scale(0.8)">
    <path d="${CROWN}" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>
    <path d="${CROWN}" fill="${INK}" stroke="${INK}" stroke-width="0.8" stroke-linejoin="round"/>
  </g>
  <ellipse cx="14.5" cy="23" rx="3.4" ry="4.4" fill="${INK}"/>
  <ellipse cx="25.5" cy="23" rx="3.4" ry="4.4" fill="${INK}"/>
  <circle cx="15.5" cy="21.5" r="1.2" fill="#fff"/>
  <circle cx="26.5" cy="21.5" r="1.2" fill="#fff"/>`;

/** Place the 40-unit mark at `size` px wide, centred on (cx, cy) of its visual middle (x 20, y 19.5). */
const placed = (size, cx, cy) => {
  const s = size / 40;
  return `<g transform="translate(${cx - 20 * s} ${cy - 19.5 * s}) scale(${s})">${mark}</g>`;
};

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

/** Rounded app tile: favicon, desktop app icon. */
const tile = svg(512, 512, `<rect width="512" height="512" rx="112" fill="${GROUND}"/>${placed(372, 256, 262)}`);
/** Full-bleed square for the maskable PWA icon: the mark stays inside the 80% safe zone. */
const maskable = svg(512, 512, `<rect width="512" height="512" fill="${GROUND}"/>${placed(300, 256, 262)}`);
/** Android notification badge: drawn from alpha only, so just the crown, in white. */
const badge = svg(96, 96, `<g transform="translate(-52 16) scale(5)"><path d="${CROWN}" fill="#fff" stroke="#fff" stroke-width="0.6" stroke-linejoin="round"/></g>`);

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try { return await chromium.launch({ channel }); } catch { /* try the next browser */ }
  }
  return chromium.launch();
}

const browser = await launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(source, size, out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${source.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.locator("svg").screenshot({ path: `${root}${out}`, omitBackground: true });
  console.log(`wrote ${out} (${size}px)`);
}

await writeFile(`${root}web/public/colony.svg`, `${tile}\n`);
console.log("wrote web/public/colony.svg");
await png(maskable, 512, "web/public/icon-512.png");
await png(tile, 192, "web/public/icon-192.png");
await png(badge, 96, "web/public/badge-96.png");
await png(tile, 512, "desktop/build/icon.png");
await browser.close();
