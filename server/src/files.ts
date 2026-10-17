import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { aboutFile } from "./people.js";
import type { Bot } from "./shared/types.js";

/*
 * Bots live on disk so you can read, back up, and hand-edit them (borrowed from Hermes):
 *   data/USER.md                       what the admin's Bots know about the admin
 *   data/people/<person>/USER.md       what a member's Bots know about that member
 *   data/bots/<id>/SOUL.md             persona and standing instructions
 *   data/bots/<id>/MEMORY.md           notes the Bot curates itself (character-capped)
 *   data/bots/<id>/skills/<slug>/SKILL.md   reusable procedures (agentskills.io format)
 *   data/bots/<id>/workspace/          files the Bot works on; mounted into its computer
 */

export function botDir(botId: string) {
  return path.join(config.dataDir, "bots", botId);
}

export function workspaceDir(botId: string) {
  return path.join(botDir(botId), "workspace");
}

const soulFile = (botId: string) => path.join(botDir(botId), "SOUL.md");
const memoryFile = (botId: string) => path.join(botDir(botId), "MEMORY.md");
const skillsDir = (botId: string) => path.join(botDir(botId), "skills");

function read(file: string) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

export function initBotFolder(bot: Bot) {
  fs.mkdirSync(workspaceDir(bot.id), { recursive: true });
  fs.mkdirSync(skillsDir(bot.id), { recursive: true });
  if (!fs.existsSync(soulFile(bot.id))) {
    write(soulFile(bot.id), `# ${bot.name}${bot.title ? ` — ${bot.title}` : ""}\n\n${bot.description.trim() || "A helpful teammate."}\n`);
  }
  if (!fs.existsSync(memoryFile(bot.id))) write(memoryFile(bot.id), "");
}

export function removeBotFolder(botId: string) {
  fs.rmSync(botDir(botId), { recursive: true, force: true });
}

export const readSoul = (botId: string) => read(soulFile(botId));
export const writeSoul = (botId: string, content: string) => write(soulFile(botId), content);

// ---------- Memory: bullet entries with a hard character budget ----------

export type MemoryTarget = "memory" | "user";
/** A Bot's memory is its own; what it knows about "the user" is its owner's USER.md, shared by their Bots. */
export type MemoryOwner = Pick<Bot, "id" | "ownerId">;

const memoryPath = (bot: MemoryOwner, target: MemoryTarget) => (target === "user" ? aboutFile(bot.ownerId) : memoryFile(bot.id));
const memoryBudget = (target: MemoryTarget) => (target === "user" ? config.limits.userChars : config.limits.memoryChars);

export function readEntries(bot: MemoryOwner, target: MemoryTarget): string[] {
  return read(memoryPath(bot, target)).split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
}

function writeEntries(bot: MemoryOwner, target: MemoryTarget, entries: string[]) {
  const content = entries.map((entry) => `- ${entry}`).join("\n");
  if (content.length > memoryBudget(target)) {
    throw new Error(`That would exceed the ${memoryBudget(target)}-character ${target} budget (${content.length}). Consolidate or remove entries first.`);
  }
  write(memoryPath(bot, target), content + (content ? "\n" : ""));
}

export function memoryUsage(bot: MemoryOwner, target: MemoryTarget) {
  const used = readEntries(bot, target).map((entry) => `- ${entry}`).join("\n").length;
  return { used, budget: memoryBudget(target) };
}

export function addEntry(bot: MemoryOwner, target: MemoryTarget, entry: string) {
  const clean = entry.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Entry is empty.");
  const entries = readEntries(bot, target);
  if (entries.includes(clean)) return entries;
  writeEntries(bot, target, [...entries, clean]);
  return readEntries(bot, target);
}

/** Replaces the single entry containing `match` (case-insensitive substring). */
export function replaceEntry(bot: MemoryOwner, target: MemoryTarget, match: string, entry: string) {
  const entries = readEntries(bot, target);
  const hits = entries.filter((item) => item.toLowerCase().includes(match.toLowerCase()));
  if (hits.length !== 1) throw new Error(hits.length ? `"${match}" matches ${hits.length} entries; be more specific.` : `No entry contains "${match}".`);
  writeEntries(bot, target, entries.map((item) => (item === hits[0] ? entry.replace(/\s+/g, " ").trim() : item)));
  return readEntries(bot, target);
}

export function removeEntry(bot: MemoryOwner, target: MemoryTarget, match: string) {
  const entries = readEntries(bot, target);
  const hits = entries.filter((item) => item.toLowerCase().includes(match.toLowerCase()));
  if (hits.length !== 1) throw new Error(hits.length ? `"${match}" matches ${hits.length} entries; be more specific.` : `No entry contains "${match}".`);
  writeEntries(bot, target, entries.filter((item) => item !== hits[0]));
  return readEntries(bot, target);
}

// ---------- Skills: SKILL.md with YAML-ish frontmatter (name, description) ----------

export type SkillInfo = { slug: string; name: string; description: string };

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "skill";

function parseFrontmatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields: Record<string, string> = {};
  if (!match) return { fields, body: text };
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fields, body: match[2] };
}

export function listSkills(botId: string): SkillInfo[] {
  let slugs: string[] = [];
  try { slugs = fs.readdirSync(skillsDir(botId)); } catch { return []; }
  return slugs.flatMap((slug) => {
    const text = read(path.join(skillsDir(botId), slug, "SKILL.md"));
    if (!text) return [];
    const { fields } = parseFrontmatter(text);
    return [{ slug, name: fields.name || slug, description: fields.description || "" }];
  });
}

export function readSkill(botId: string, nameOrSlug: string) {
  const skill = listSkills(botId).find((item) => item.slug === nameOrSlug || item.name.toLowerCase() === nameOrSlug.toLowerCase());
  return skill ? read(path.join(skillsDir(botId), skill.slug, "SKILL.md")) : null;
}

/** Deletes a skill by slug; only slugs that exist are accepted, so paths can't escape. */
export function deleteSkill(botId: string, slug: string) {
  if (!listSkills(botId).some((skill) => skill.slug === slug)) return false;
  fs.rmSync(path.join(skillsDir(botId), slug), { recursive: true, force: true });
  return true;
}

/** Removes an entry by its exact text (for the app; Bots use removeEntry's substring match). */
export function removeExactEntry(bot: MemoryOwner, target: MemoryTarget, entry: string) {
  const entries = readEntries(bot, target);
  if (!entries.includes(entry)) return false;
  writeEntries(bot, target, entries.filter((item) => item !== entry));
  return true;
}

export function saveSkill(botId: string, name: string, description: string, body: string) {
  const slug = slugify(name);
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  write(path.join(skillsDir(botId), slug, "SKILL.md"), `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n\n${body.trim()}\n`);
  return slug;
}

/** "Start fresh": a Bot handed to someone new forgets what it had noted. */
export function clearMemory(botId: string) {
  write(memoryFile(botId), "");
}
