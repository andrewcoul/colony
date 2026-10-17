import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Me, Role } from "./shared/types.js";
import type { Store } from "./store.js";

/*
 * People: everyone has their own account and their own Bots. The admin ("owner", the person who
 * runs Colony) has everything from before accounts; members are made on their first sign-in with
 * an allowed email. Nobody sees anyone else's things, not even the admin. In a chat, its owner's
 * messages are signed "user".
 */

export const ADMIN_ID = "owner";

/** A person with an account here. */
export type Person = Me & { color: string; createdAt: number };

export const isAdmin = (person: Pick<Me, "role">) => person.role === "admin";
/** What devices see of a person. */
export const meOf = ({ id, role, name, login }: Pick<Me, "id" | "role" | "name" | "login">): Me => ({ id, role, name, login });

/** Whether a message author is a person (the chat's owner), as opposed to a Bot or a system note. */
export const isHuman = (author: string) => author === "user";

const COLORS = ["#7CC4FA", "#7EE2B8", "#FFB38A", "#C5A6FF", "#FF8A9A", "#FFE07A"];

/** "marija.k@example.com" → "Marija". */
const nameFromLogin = (login: string) => {
  const first = login.split("@")[0].split(/[._+-]/)[0] || login;
  return first.charAt(0).toUpperCase() + first.slice(1);
};

/** A refused sign-in: why, in words for the person. */
export type Refusal = { refused: string };

/**
 * Who a verified email is. The admin's emails (COLONY_ADMIN_EMAILS) are the admin; any other
 * email is a member, made on its first sign-in. The caller decides which emails may sign in at
 * all (each identity source keeps its own allowlist). A member can never become the admin: only
 * the admin's emails reach the admin, and the admin's own login is never given to a member.
 */
export class People {
  private adminEmails: Set<string>;

  constructor(private store: Store, options: { adminEmails: readonly string[] }) {
    this.adminEmails = new Set(options.adminEmails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  }

  admin(): Person {
    return this.store.getPerson(ADMIN_ID)!;
  }

  isAdminEmail(email: string) {
    return this.adminEmails.has(email.trim().toLowerCase());
  }

  byEmail(email: string): Person | Refusal {
    const login = email.trim().toLowerCase();
    if (!login) return { refused: "That sign-in has no email." };
    if (this.isAdminEmail(login)) return this.admin();
    const known = this.store.personByLogin(login);
    if (known?.id === ADMIN_ID || known?.role === "admin") {
      return { refused: `${login} is this Colony's admin login. Add it to COLONY_ADMIN_EMAILS to sign in with it.` };
    }
    if (known) return known;
    const used = new Set(this.store.listPeople().map((person) => person.color));
    return this.store.addPerson({
      login, name: nameFromLogin(login), role: "member",
      color: COLORS.find((color) => !used.has(color)) ?? COLORS[this.store.listPeople().length % COLORS.length],
    });
  }
}

/** Person ids become folder names; only ids Colony makes (and "owner") are accepted. */
const safeId = (personId: string) => {
  if (!/^[\w-]{1,64}$/.test(personId)) throw new Error("Not a person id.");
  return personId;
};

// ---------- What Bots know about each person ----------
/** The admin's USER.md is data/USER.md (as before accounts); each member's is data/people/<id>/USER.md. */
export const aboutFile = (personId: string) => (personId === ADMIN_ID
  ? path.join(config.dataDir, "USER.md")
  : path.join(config.dataDir, "people", safeId(personId), "USER.md"));
const readText = (file: string) => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; } };
const writeText = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text.trim() ? `${text.trim()}\n` : ""); };

/** A person's USER.md. */
export const readAbout = (personId: string) => readText(aboutFile(personId));
export const writeAbout = (personId: string, text: string) => writeText(aboutFile(personId), text);

/**
 * Folds what was kept for the household (HOUSEHOLD.md, from the family build) into the admin's
 * USER.md once. Safe to run on every start. Everyone's own notes (data/people/) stay.
 */
export function foldHousehold() {
  const household = path.join(config.dataDir, "HOUSEHOLD.md");
  const text = readText(household);
  // USER.md is one entry per line ("- …"), like the Bots' memory files.
  const entries = text.split("\n").map((line) => line.replace(/^\s*[-*#]+\s*/, "").trim()).filter(Boolean).map((line) => `- ${line}`);
  if (entries.length) writeAbout(ADMIN_ID, [readAbout(ADMIN_ID), ...entries].filter(Boolean).join("\n"));
  fs.rmSync(household, { force: true });
}

export type { Role };
