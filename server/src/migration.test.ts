import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-migration-"));
process.env.COLONY_DATA_DIR = dataDir;

const { openDb } = await import("./db.js");
const { EventLog } = await import("./events.js");
const { Store } = await import("./store.js");
const { Accounts } = await import("./integrations/accounts.js");
const settings = await import("./settings.js");
const { foldHousehold, readAbout } = await import("./people.js");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const count = (db: ReturnType<typeof openDb>, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("a database from before accounts stays the admin's: every row is the owner's, and nothing is deleted", () => {
  // The single-user Colony (v19): one Bot, its chat and a topic, a folder, an approval, usage, a device, events.
  const file = path.join(dataDir, "single.db");
  const before = openDb(file, 19);
  before.exec(`
    INSERT INTO bots (id, name, face_seed, chat_id, created_at) VALUES ('luke', 'Luke', 'Luke', 'c-luke', 1);
    INSERT INTO chats (id, kind, title, coordinator_id, updated_at) VALUES ('c-luke', 'bot', 'Luke', 'luke', 1), ('c-trip', 'topic', 'Trip', 'luke', 2);
    INSERT INTO chat_members (chat_id, bot_id) VALUES ('c-luke', 'luke'), ('c-trip', 'luke');
    INSERT INTO folders (id, title, position, created_at) VALUES ('f1', 'Home', 0, 1);
    INSERT INTO messages (id, chat_id, author, status, created_at) VALUES ('m1', 'c-luke', 'user', 'done', 1);
    INSERT INTO approvals (id, bot_id, chat_id, message_id, tool, summary, detail, status, created_at) VALUES ('a1', 'luke', 'c-luke', 'm1', 'shell', 's', 'd', 'pending', 1);
    INSERT INTO routines (id, bot_id, chat_id, title, prompt, schedule, created_at) VALUES ('r1', 'luke', 'c-trip', 'Brief', 'p', '{"type":"interval","minutes":60}', 1);
    INSERT INTO usage (id, at, bot_id, owner_id, provider_id, model, input_tokens, output_tokens, cached_tokens) VALUES ('u1', 1, 'luke', 'owner', 'openai', 'm', 1, 1, 0);
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES ('https://push.example/phone', 'k', 'a', 1);
    INSERT INTO events (payload, created_at) VALUES ('{"type":"bot.deleted","botId":"x"}', 1);
  `);
  const counts = (db: ReturnType<typeof openDb>) => ["bots", "chats", "chat_members", "folders", "messages", "approvals", "routines", "usage", "push_subscriptions", "events"].map((table) => count(db, table));
  const was = counts(before);
  before.close();

  const db = openDb(file);
  expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(22);
  expect(counts(db)).toEqual(was);
  const store = new Store(db, new EventLog(db));
  expect(store.listPeople().map((person) => [person.id, person.role])).toEqual([["owner", "admin"]]);
  expect(db.prepare("SELECT role FROM people WHERE id = 'owner'").get()).toEqual({ role: "admin" });
  expect(store.listBots("owner").map((bot) => bot.id)).toEqual(["luke"]);
  expect(store.listChats("owner").map((chat) => chat.id).sort()).toEqual(["c-luke", "c-trip"]);
  expect(store.getChat("c-trip")!.memberIds).toEqual(["luke"]);
  expect(store.listFolders("owner").map((folder) => folder.id)).toEqual(["f1"]);
  expect(store.approvalsFor("owner").map((approval) => approval.id)).toEqual(["a1"]);
  expect(store.routinesOf("owner").map((routine) => routine.id)).toEqual(["r1"]);
  expect(store.listUsage(0, "owner").map((row) => row.id)).toEqual(["u1"]);
  expect(db.prepare("SELECT person_id FROM push_subscriptions").all()).toEqual([{ person_id: "owner" }]);
  expect(db.prepare("SELECT person_id FROM events").all()).toEqual([{ person_id: "owner" }]);
  db.close();
});

test("a family database keeps everyone's things as their own; only sharing ends", () => {
  // A database from the family build (v17): the host and Marija, each with a Bot, an account, a PC and
  // a device; her topic also had the host's Bot in it (shared), and was shared with the host.
  const file = path.join(dataDir, "family.db");
  const before = openDb(file, 17);
  before.exec(`
    INSERT INTO people (id, login, name, color, role, created_at) VALUES ('marija', 'marija@example.com', 'Marija', '#7CC4FA', 'family', 1);
    UPDATE people SET login = 'me@example.com' WHERE id = 'owner';
    INSERT INTO bots (id, name, face_seed, chat_id, owner_id, created_at) VALUES ('luke', 'Luke', 'Luke', 'c-luke', 'owner', 1), ('ivy', 'Ivy', 'Ivy', 'c-ivy', 'marija', 2);
    INSERT INTO chats (id, kind, title, coordinator_id, owner_id, updated_at) VALUES ('c-luke', 'bot', 'Luke', 'luke', 'owner', 1), ('c-ivy', 'bot', 'Ivy', 'ivy', 'marija', 1), ('c-her-trip', 'topic', 'Her trip', 'ivy', 'marija', 1);
    INSERT INTO chat_members (chat_id, bot_id) VALUES ('c-luke', 'luke'), ('c-ivy', 'ivy'), ('c-her-trip', 'ivy'), ('c-her-trip', 'luke');
    INSERT INTO chat_people (chat_id, person_id) VALUES ('c-her-trip', 'owner');
    INSERT INTO folders (id, title, position, owner_id, created_at) VALUES ('f-hers', 'Hers', 0, 'marija', 1);
    INSERT INTO messages (id, chat_id, author, status, created_at) VALUES ('m-hers', 'c-ivy', 'person:marija', 'done', 1);
    INSERT INTO approvals (id, bot_id, chat_id, message_id, tool, summary, detail, status, approver_id, created_at) VALUES ('a-hers', 'ivy', 'c-ivy', 'm-hers', 'shell', 's', 'd', 'pending', 'owner', 1);
    INSERT INTO usage (id, at, bot_id, owner_id, provider_id, model, input_tokens, output_tokens, cached_tokens) VALUES ('u-hers', 1, 'ivy', 'owner', 'openai', 'm', 1, 1, 0);
    INSERT INTO accounts (id, kind, label, email, status, person_id, created_at) VALUES ('a-mine', 'google', 'Gmail', 'me@example.com', 'ok', 'owner', 1), ('a-hers', 'google', 'Gmail', 'marija@example.com', 'ok', 'marija', 1);
    INSERT INTO nodes (id, name, platform, capabilities, last_seen, person_id) VALUES ('pc-mine-0001', 'Desktop', 'win32', '[]', 1, 'owner'), ('pc-hers-0001', 'Laptop', 'win32', '[]', 1, 'marija');
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, person_id) VALUES ('https://push.example/hers', 'k', 'a', 1, 'marija');
    INSERT INTO bot_transfers (id, bot_id, from_id, to_id, keep_memory, status, created_at) VALUES ('t1', 'luke', 'owner', 'marija', 1, 'pending', 1);
  `);
  before.close();

  const db = openDb(file);
  const store = new Store(db, new EventLog(db));
  // Accounts used to remove other people's accounts on start; now they stay (unused: accounts are the admin's).
  const accounts = new Accounts(db, new EventLog(db), path.join(dataDir, "accounts.json"));
  expect(store.listPeople().map((person) => [person.id, person.role, person.login])).toEqual([["owner", "admin", "me@example.com"], ["marija", "member", "marija@example.com"]]);
  expect(store.listBots("owner").map((bot) => bot.id)).toEqual(["luke"]);
  expect(store.listBots("marija").map((bot) => bot.id)).toEqual(["ivy"]);
  expect(store.listChats("marija").map((chat) => chat.id).sort()).toEqual(["c-her-trip", "c-ivy"]);
  // No shared topics: her topic keeps only her Bot, and isn't shared with anyone.
  expect(store.getChat("c-her-trip")!.memberIds).toEqual(["ivy"]);
  expect(count(db, "chat_people") + count(db, "bot_transfers")).toBe(0);
  expect(store.listFolders("marija").map((folder) => folder.id)).toEqual(["f-hers"]);
  // Her Bot's approval waits for her, and its usage is hers.
  expect(store.getApproval("a-hers")!.approverId).toBe("marija");
  expect(store.listUsage(0, "marija").map((row) => row.id)).toEqual(["u-hers"]);
  expect(store.listUsage(0, "owner")).toEqual([]);
  expect(accounts.list().map((account) => account.id)).toEqual(["a-mine"]);
  expect(store.listNodes().map((node) => node.id)).toEqual(["pc-mine-0001"]);
  expect([count(db, "accounts"), count(db, "nodes"), count(db, "push_subscriptions"), count(db, "messages")]).toEqual([2, 2, 1, 1]);
  db.close();
});

test("other people's own model keys are dropped from settings; shared ones become the admin's", () => {
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    providers: [
      { id: "shared", name: "OpenAI", baseURL: "https://api.openai.com/v1", protocol: "openai", apiKey: "k1", models: ["m1"], desktop: [], ownerId: null },
      { id: "hers", name: "Her key", baseURL: "https://opencode.ai/zen/v1", protocol: "openai", apiKey: "k2", models: ["m2"], desktop: [], ownerId: "marija" },
    ],
    defaultModel: "shared::m1",
    personalDefaults: { marija: "hers::m2" },
    spendLimits: { marija: 5 },
    voice: { voice: "alloy", people: { marija: { allowCalls: false } } },
  }));
  settings.loadSettings();
  settings.setSignedIn("chatgpt", null);
  settings.setSignedIn("opencode", null);
  expect(settings.listProviders().map((provider) => [provider.id, provider.models])).toEqual([["openai", ["m1"]], ["opencode-go", []], ["opencode", []]]);
  expect(settings.resolveModel("hers::m2", { fallback: false })).toBeNull();
  expect(settings.defaultModel()).toBe("openai::m1");
  expect(settings.voiceSettings()).not.toHaveProperty("people");
  settings.setOwnerLogin("me@example.com");
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
  expect(saved).toMatchObject({ ownerLogin: "me@example.com" });
  expect(saved).not.toHaveProperty("spendLimits");
  expect(saved).not.toHaveProperty("personalDefaults");
});

test("HOUSEHOLD.md folds into the admin's USER.md once; members' own USER.md files stay", () => {
  fs.writeFileSync(path.join(dataDir, "USER.md"), "- Lives in Skopje\n");
  fs.writeFileSync(path.join(dataDir, "HOUSEHOLD.md"), "# Household\n- Two cats\n");
  fs.mkdirSync(path.join(dataDir, "people", "marija"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "people", "marija", "USER.md"), "- Marija's notes\n");
  foldHousehold();
  foldHousehold();
  expect(readAbout("owner")).toBe("- Lives in Skopje\n- Household\n- Two cats");
  expect(readAbout("marija")).toBe("- Marija's notes");
  expect(fs.existsSync(path.join(dataDir, "HOUSEHOLD.md"))).toBe(false);
});
