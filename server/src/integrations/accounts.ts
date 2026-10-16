import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Db } from "../db.js";
import type { EventLog } from "../events.js";
import type { Access, Account, AccountKind, CalendarAccess, MailAccess, VaultAccess } from "../shared/types.js";

/** What signs Colony in to an account. Kept in data/accounts.json, never in the database or on devices. */
export type AccountSecret =
  | { kind: "google"; clientId: string; clientSecret: string; refreshToken: string; scopes: string[] }
  | { kind: "microsoft"; clientId: string; refreshToken: string }
  /** A service-account token, or the 1Password app on this PC (`desktopAccount`). */
  | { kind: "onepassword"; token?: string; desktopAccount?: string; saveVaultId?: string };

/** The OAuth clients you registered, remembered so reconnecting doesn't ask again. */
export type OAuthApps = { google?: { clientId: string; clientSecret: string }; microsoft?: { clientId: string } };

type SecretsFile = { apps: OAuthApps; accounts: Record<string, AccountSecret> };

type Row = Record<string, unknown>;

const toAccount = (row: Row): Account => ({
  id: row.id as string,
  kind: row.kind as AccountKind,
  label: row.label as string,
  email: row.email as string,
  status: row.status as Account["status"],
  createdAt: row.created_at as number,
});

const toAccess = (row: Row): Access => ({
  botId: row.bot_id as string,
  accountId: row.account_id as string,
  mail: row.mail as MailAccess,
  calendar: row.calendar as CalendarAccess,
  vault: row.vault as VaultAccess,
});

const MAIL_LEVELS: MailAccess[] = ["none", "read", "draft", "send"];
const CALENDAR_LEVELS: CalendarAccess[] = ["none", "read", "write"];
const VAULT_LEVELS: VaultAccess[] = ["none", "use", "save"];

/** Whether `level` includes `needed` (send includes draft includes read). */
export const allows = {
  mail: (level: MailAccess, needed: MailAccess) => MAIL_LEVELS.indexOf(level) >= MAIL_LEVELS.indexOf(needed),
  calendar: (level: CalendarAccess, needed: CalendarAccess) => CALENDAR_LEVELS.indexOf(level) >= CALENDAR_LEVELS.indexOf(needed),
  vault: (level: VaultAccess, needed: VaultAccess) => VAULT_LEVELS.indexOf(level) >= VAULT_LEVELS.indexOf(needed),
};

const NONE = { mail: "none", calendar: "none", vault: "none" } as const;

/**
 * Connected accounts and what each Bot may do with them. Account details live in the
 * database; tokens live in data/accounts.json (readable only by you), so a copy of the
 * database never carries them. Every change emits `accounts.updated`.
 */
export class Accounts {
  /** Called when an account's sign-in stops working (expired or revoked). */
  onNeedsReauth?: (account: Account) => void;
  private secrets: SecretsFile;

  constructor(private db: Db, private events: EventLog, private file = path.join(config.dataDir, "accounts.json")) {
    this.secrets = this.read();
    // Colony is single-user: accounts other people connected in the family build go, with their tokens.
    for (const row of db.prepare("SELECT id FROM accounts WHERE person_id <> 'owner'").all() as Row[]) this.remove(row.id as string);
    events.subscribe(({ event }) => {
      if (event.type === "bot.deleted") this.forgetBot(event.botId);
    });
  }

  private read(): SecretsFile {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<SecretsFile>;
      return { apps: saved.apps ?? {}, accounts: saved.accounts ?? {} };
    } catch {
      return { apps: {}, accounts: {} };
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write then rename, so a crash never leaves half a file. Readable only by you.
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  private emit() {
    this.events.emit({ type: "accounts.updated", accounts: this.list(), access: this.listAccess() });
  }

  // ---------- Accounts ----------
  list(): Account[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as Row[]).map(toAccount);
  }

  get(id: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return row ? toAccount(row) : null;
  }

  /**
   * Adds an account, or reconnects it if the same mailbox (or 1Password account) is
   * already connected: its access settings stay, the new sign-in replaces the old.
   */
  connect(input: { kind: AccountKind; label: string; email: string }, secret: AccountSecret): Account {
    const existing = this.db.prepare("SELECT id FROM accounts WHERE kind = ? AND lower(email) = lower(?)").get(input.kind, input.email) as Row | undefined;
    const id = (existing?.id as string | undefined) ?? randomUUID();
    if (existing) {
      this.db.prepare("UPDATE accounts SET label = ?, email = ?, status = 'ok' WHERE id = ?").run(input.label, input.email, id);
    } else {
      this.db.prepare("INSERT INTO accounts (id, kind, label, email, status, created_at) VALUES (?, ?, ?, ?, 'ok', ?)")
        .run(id, input.kind, input.label, input.email, Date.now());
    }
    this.secrets.accounts[id] = secret;
    this.persist();
    this.emit();
    return this.get(id)!;
  }

  remove(id: string) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM account_sync WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM bot_access WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM vault_item_grants WHERE account_id = ?").run(id);
    delete this.secrets.accounts[id];
    this.persist();
    this.emit();
  }

  secret(id: string): AccountSecret | null {
    return this.secrets.accounts[id] ?? null;
  }

  /** Saves a rotated refresh token or changed setting. */
  updateSecret(id: string, secret: AccountSecret) {
    if (!this.get(id)) return;
    this.secrets.accounts[id] = secret;
    this.persist();
  }

  setStatus(id: string, status: Account["status"]) {
    const account = this.get(id);
    if (!account || account.status === status) return;
    this.db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id);
    this.emit();
    if (status === "needs_reauth") this.onNeedsReauth?.({ ...account, status });
  }

  apps(): OAuthApps {
    return this.secrets.apps;
  }

  saveApp<K extends keyof OAuthApps>(kind: K, app: NonNullable<OAuthApps[K]>) {
    this.secrets.apps[kind] = app;
    this.persist();
  }

  // ---------- Sync cursors (where the new-mail check left off) ----------
  /** Where the last check left off, or null if there's none newer than `maxAgeMs` (then checking starts afresh from now). */
  cursor(accountId: string, resource: string, maxAgeMs = Infinity): string | null {
    const row = this.db.prepare("SELECT cursor, updated_at FROM account_sync WHERE account_id = ? AND resource = ?").get(accountId, resource) as Row | undefined;
    if (!row || Date.now() - (row.updated_at as number) > maxAgeMs) return null;
    return row.cursor as string;
  }

  setCursor(accountId: string, resource: string, cursor: string) {
    this.db.prepare(`INSERT INTO account_sync (account_id, resource, cursor, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id, resource) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`)
      .run(accountId, resource, cursor, Date.now());
  }

  // ---------- What each Bot may do ----------
  listAccess(): Access[] {
    return (this.db.prepare("SELECT * FROM bot_access ORDER BY rowid").all() as Row[]).map(toAccess);
  }

  access(botId: string, accountId: string): Access {
    const row = this.db.prepare("SELECT * FROM bot_access WHERE bot_id = ? AND account_id = ?").get(botId, accountId) as Row | undefined;
    return row ? toAccess(row) : { botId, accountId, ...NONE };
  }

  /** The accounts this Bot can use at all, with its access to each. */
  forBot(botId: string): { account: Account; access: Access }[] {
    return this.list()
      .map((account) => ({ account, access: this.access(botId, account.id) }))
      .filter(({ access }) => access.mail !== "none" || access.calendar !== "none" || access.vault !== "none");
  }

  setAccess(botId: string, accountId: string, patch: Partial<Pick<Access, "mail" | "calendar" | "vault">>): Access {
    const account = this.get(accountId);
    if (!account) throw new Error("That account isn't connected.");
    const next = { ...this.access(botId, accountId), ...patch };
    // Each kind of account only offers what it has.
    if (account.kind === "onepassword") { next.mail = "none"; next.calendar = "none"; } else next.vault = "none";
    this.db.prepare(`INSERT INTO bot_access (bot_id, account_id, mail, calendar, vault) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (bot_id, account_id) DO UPDATE SET mail = excluded.mail, calendar = excluded.calendar, vault = excluded.vault`)
      .run(botId, accountId, next.mail, next.calendar, next.vault);
    // Taking vault access away also forgets which logins it was allowed to use.
    if (next.vault === "none") this.db.prepare("DELETE FROM vault_item_grants WHERE bot_id = ? AND account_id = ?").run(botId, accountId);
    this.emit();
    return next;
  }

  /** Whether you've let this Bot use this 1Password item before. */
  itemAllowed(botId: string, accountId: string, itemId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM vault_item_grants WHERE bot_id = ? AND account_id = ? AND item_id = ?").get(botId, accountId, itemId));
  }

  allowItem(botId: string, accountId: string, itemId: string) {
    this.db.prepare("INSERT OR IGNORE INTO vault_item_grants (bot_id, account_id, item_id, created_at) VALUES (?, ?, ?, ?)")
      .run(botId, accountId, itemId, Date.now());
  }

  private forgetBot(botId: string) {
    this.db.prepare("DELETE FROM bot_access WHERE bot_id = ?").run(botId);
    this.db.prepare("DELETE FROM vault_item_grants WHERE bot_id = ?").run(botId);
    this.emit();
  }
}
