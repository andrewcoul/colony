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
