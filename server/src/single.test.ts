import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-single-"));
process.env.COLONY_DATA_DIR = dataDir;

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { Accounts } = await import("./integrations/accounts.js");
const settings = await import("./settings.js");
const { foldHousehold, readAbout } = await import("./people.js");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("a family database becomes yours alone: everyone else's Bots, topics, accounts, PCs and keys go", () => {
  // A database from the family build (v17): you (the host) and Marija, each with a Bot, an account and a PC.
  const file = path.join(dataDir, "family.db");
  const before = openDb(file);
  const events = new EventLog(before);
  const store = new Store(before, events);
  const mine = store.createBot({ name: "Luke", title: "", description: "", model: "", computer: false });
  const hers = store.createBot({ name: "Ivy", title: "", description: "", model: "", computer: false });
  const topic = store.createChat({ kind: "topic", title: "Her trip", memberIds: [hers.id], coordinatorId: hers.id });
  before.exec(`
    PRAGMA user_version = 17;
    INSERT INTO people (id, login, name, color, role, created_at) VALUES ('marija', 'marija@example.com', 'Marija', '#7CC4FA', 'family', 1);
    UPDATE people SET login = 'me@example.com' WHERE id = 'owner';
    UPDATE bots SET owner_id = 'marija' WHERE id = '${hers.id}';
    UPDATE chats SET owner_id = 'marija' WHERE id IN ('${hers.chatId}', '${topic.id}');
    INSERT INTO chat_people (chat_id, person_id) VALUES ('${topic.id}', 'owner');
    INSERT INTO accounts (id, kind, label, email, status, person_id, created_at) VALUES ('a-mine', 'google', 'Gmail', 'me@example.com', 'ok', 'owner', 1), ('a-hers', 'google', 'Gmail', 'marija@example.com', 'ok', 'marija', 1);
    INSERT INTO nodes (id, name, platform, capabilities, last_seen, person_id) VALUES ('pc-mine-0001', 'Desktop', 'win32', '[]', 1, 'owner'), ('pc-hers-0001', 'Laptop', 'win32', '[]', 1, 'marija');
    INSERT INTO bot_transfers (id, bot_id, from_id, to_id, keep_memory, status, created_at) VALUES ('t1', '${mine.id}', 'owner', 'marija', 1, 'pending', 1);
  `);
  before.close();

  const db = openDb(file);
  expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(18);
  const after = new Store(db, new EventLog(db));
  const accounts = new Accounts(db, new EventLog(db), path.join(dataDir, "accounts.json"));
  expect(after.forgetOthers()).toEqual([hers.id]);
  expect(after.listBots().map((bot) => bot.name)).toEqual(["Luke"]);
  expect(after.listChats().map((chat) => chat.id)).toEqual([mine.chatId]);
  expect(accounts.list().map((account) => account.id)).toEqual(["a-mine"]);
  expect(after.listNodes().map((node) => node.id)).toEqual(["pc-mine-0001"]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM people").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM bot_transfers").get()).toEqual({ n: 0 });
  // Your login from the family build is still known (index.ts copies it into settings).
  expect(db.prepare("SELECT login FROM people WHERE id = 'owner'").get()).toEqual({ login: "me@example.com" });
  // A second start finds nothing more to remove.
  expect(after.forgetOthers()).toEqual([]);
  db.close();
});

test("other people's own model keys are dropped from settings; shared ones become yours", () => {
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    providers: [
      { id: "shared", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", protocol: "openai", apiKey: "k1", models: ["m1"], desktop: [], ownerId: null },
      { id: "hers", name: "Her key", baseURL: "https://api.openai.com/v1", protocol: "openai", apiKey: "k2", models: ["m2"], desktop: [], ownerId: "marija" },
    ],
    defaultModel: "shared::m1",
    personalDefaults: { marija: "hers::m2" },
    spendLimits: { marija: 5 },
    voice: { voice: "alloy", people: { marija: { allowCalls: false } } },
  }));
  settings.loadSettings();
  expect(settings.listProviders().map((provider) => provider.id)).toEqual(["shared"]);
  expect(settings.resolveModel("hers::m2", { fallback: false })).toBeNull();
  expect(settings.defaultModel()).toBe("shared::m1");
  expect(settings.voiceSettings()).not.toHaveProperty("people");
  settings.setOwnerLogin("me@example.com");
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
  expect(saved).toMatchObject({ ownerLogin: "me@example.com" });
  expect(saved).not.toHaveProperty("spendLimits");
  expect(saved).not.toHaveProperty("personalDefaults");
});

test("HOUSEHOLD.md folds into USER.md once, and other people's notes go", () => {
  fs.writeFileSync(path.join(dataDir, "USER.md"), "- Lives in Skopje\n");
  fs.writeFileSync(path.join(dataDir, "HOUSEHOLD.md"), "# Household\n- Two cats\n");
  fs.mkdirSync(path.join(dataDir, "people", "marija"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "people", "marija", "USER.md"), "- Marija's notes\n");
  foldHousehold();
  foldHousehold();
  expect(readAbout()).toBe("- Lives in Skopje\n- Household\n- Two cats");
  expect(fs.existsSync(path.join(dataDir, "HOUSEHOLD.md"))).toBe(false);
  expect(fs.existsSync(path.join(dataDir, "people"))).toBe(false);
});
