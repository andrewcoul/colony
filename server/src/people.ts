import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/*
 * Colony is yours alone: one person, known on the tailnet by their Tailscale login (see access.ts).
 * Your messages are signed "user".
 */

/** Whether a message author is you (as opposed to a Bot or a system note). */
export const isHuman = (author: string) => author === "user";

// ---------- What Bots know about you ----------
const aboutFile = () => path.join(config.dataDir, "USER.md");
const readText = (file: string) => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; } };
const writeText = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text.trim() ? `${text.trim()}\n` : ""); };

/** Your USER.md. */
export const readAbout = () => readText(aboutFile());
export const writeAbout = (text: string) => writeText(aboutFile(), text);

/**
 * Folds what was kept for the household (HOUSEHOLD.md, from the family build) into USER.md once,
 * and drops other people's notes. Safe to run on every start.
 */
export function foldHousehold() {
  const household = path.join(config.dataDir, "HOUSEHOLD.md");
  const text = readText(household);
  // USER.md is one entry per line ("- …"), like the Bots' memory files.
  const entries = text.split("\n").map((line) => line.replace(/^\s*[-*#]+\s*/, "").trim()).filter(Boolean).map((line) => `- ${line}`);
  if (entries.length) writeAbout([readAbout(), ...entries].filter(Boolean).join("\n"));
  fs.rmSync(household, { force: true });
  fs.rmSync(path.join(config.dataDir, "people"), { recursive: true, force: true });
}
