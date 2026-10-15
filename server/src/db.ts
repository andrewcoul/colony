import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  `
  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    face_seed TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    computer INTEGER NOT NULL DEFAULT 0,
    presence TEXT NOT NULL DEFAULT 'idle',
    activity TEXT,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    coordinator_id TEXT,
    last_preview TEXT,
    last_author TEXT,
    updated_at INTEGER NOT NULL,
    unread INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE chat_members (
    chat_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    PRIMARY KEY (chat_id, bot_id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    cards TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_by_chat ON messages (chat_id, created_at);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `ALTER TABLE bots ADD COLUMN computer_state TEXT NOT NULL DEFAULT 'off';`,
  `
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX routines_due ON routines (enabled, next_run_at);
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `ALTER TABLE bots ADD COLUMN desktop INTEGER NOT NULL DEFAULT 0;`,
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ok',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE account_sync (
    account_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    cursor TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, resource)
  );
  CREATE TABLE bot_access (
    bot_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    mail TEXT NOT NULL DEFAULT 'none',
    calendar TEXT NOT NULL DEFAULT 'none',
    vault TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (bot_id, account_id)
  );
  CREATE TABLE vault_item_grants (
    bot_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, account_id, item_id)
  );
  `,
  // v6: steering. A message sent while a Bot works is steered into the run or queued for after it.
  `
  ALTER TABLE messages ADD COLUMN delivery TEXT;
  ALTER TABLE messages ADD COLUMN steered_at INTEGER;
  `,
  // v7: durable runs. A checkpoint before every model step, so a restart can pick a turn back up;
  // and mail that matched a routine but hasn't run it yet.
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    steps_before INTEGER NOT NULL DEFAULT 0,
    messages TEXT NOT NULL,
    options TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE pending_triggers (
    routine_id TEXT PRIMARY KEY,
    mail TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v8: topics and folders. Groups become topics with several Bots, filed in a "Groups" folder.
  `
  ALTER TABLE chats ADD COLUMN icon TEXT;
  ALTER TABLE chats ADD COLUMN folder_id TEXT;
  ALTER TABLE chats ADD COLUMN brief TEXT NOT NULL DEFAULT '';
  ALTER TABLE chats ADD COLUMN archived_at INTEGER;
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO folders (id, title, position, created_at)
    SELECT 'groups', 'Groups', 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE EXISTS (SELECT 1 FROM chats WHERE kind = 'group');
  UPDATE chats SET folder_id = 'groups', icon = 'users', kind = 'topic' WHERE kind = 'group';
  `,
  // v9: a topic's Doc (versioned), and files in chats and on messages.
  `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    version INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE artifact_versions (
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    note TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );
  CREATE TABLE chat_files (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX chat_files_by_chat ON chat_files (chat_id, created_at);
  ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  `,
  // v10: messages said on a call.
  `ALTER TABLE messages ADD COLUMN via TEXT;`,
  // v11: PCs lent through the desktop app, and how far each Bot may use them.
  `
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '[]',
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE node_access (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    level INTEGER NOT NULL,
    PRIMARY KEY (bot_id, node_id)
  );
  `,
];

export type Db = DatabaseSync;

/** Opens (and migrates) the SQLite database. Pass ":memory:" in tests. */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let index = version; index < MIGRATIONS.length; index++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}
