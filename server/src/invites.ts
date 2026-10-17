import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";

/*
 * Invites: the only way onto this Colony from the web. The admin invites an email; the link
 * (https://<site>/signup?invite=<token>) works once, for that email only, until it expires. Only a
 * SHA-256 hash of the token is kept, so a copy of the database can't be turned into links.
 */

export type InviteStatus = "pending" | "used" | "revoked" | "expired";
/** An invite as the admin sees it (never its token). */
export type Invite = { id: string; email: string; status: InviteStatus; createdAt: number; expiresAt: number; sentAt: number | null; usedAt: number | null; personId: string | null };

const DAY = 24 * 60 * 60_000;
type Row = Record<string, unknown>;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
export const normalEmail = (email: string) => email.trim().toLowerCase();
export const looksLikeEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function toInvite(row: Row, now: number): Invite {
  const status = row.status as Exclude<InviteStatus, "expired">;
  return {
    id: row.id as string, email: row.email as string,
    status: status === "pending" && (row.expires_at as number) <= now ? "expired" : status,
    createdAt: row.created_at as number, expiresAt: row.expires_at as number,
    sentAt: (row.sent_at as number | null) ?? null, usedAt: (row.used_at as number | null) ?? null, personId: (row.person_id as string | null) ?? null,
  };
}

/** Why an invite link doesn't work, in words for the signup page. */
const PROBLEMS = {
  unknown: "This invite link isn't valid. Ask for a new one.",
  used: "This invite has already been used. Sign in instead.",
  revoked: "This invite was withdrawn. Ask for a new one.",
  expired: "This invite has expired. Ask for a new one.",
  email: "This invite is for a different email address.",
};

export class Invites {
  constructor(private db: Db, private ttlDays: number) {}

  list(now = Date.now()): Invite[] {
    return (this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as Row[]).map((row) => toInvite(row, now));
  }

  get(id: string, now = Date.now()): Invite | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as Row | undefined;
    return row ? toInvite(row, now) : null;
  }

  /** Invites an email, returning the link's token (shown once). An earlier pending invite for it stops working. */
  create(email: string, now = Date.now()): { invite: Invite; token: string } {
    const address = normalEmail(email);
    if (!looksLikeEmail(address)) throw new Error("That isn't an email address.");
    this.db.prepare("UPDATE invites SET status = 'revoked' WHERE email = ? AND status = 'pending'").run(address);
    const token = newToken();
    const id = randomUUID();
    this.db.prepare("INSERT INTO invites (id, email, token_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .run(id, address, hash(token), now, now + this.ttlDays * DAY);
    return { invite: this.get(id, now)!, token };
  }

  /** A new link for a pending (or expired) invite, with a fresh expiry. The old link stops working. */
  resend(id: string, now = Date.now()): { invite: Invite; token: string } {
    const invite = this.get(id, now);
    if (!invite) throw new Error("That invite doesn't exist.");
    if (invite.status === "used" || invite.status === "revoked") throw new Error(invite.status === "used" ? "That invite was already used." : "That invite was withdrawn. Invite them again.");
    const token = newToken();
    this.db.prepare("UPDATE invites SET token_hash = ?, status = 'pending', expires_at = ? WHERE id = ?").run(hash(token), now + this.ttlDays * DAY, id);
    return { invite: this.get(id, now)!, token };
  }

  revoke(id: string) {
    const changed = this.db.prepare("UPDATE invites SET status = 'revoked' WHERE id = ? AND status = 'pending'").run(id).changes;
    return changed > 0;
  }

  markSent(id: string, now = Date.now()) {
    this.db.prepare("UPDATE invites SET sent_at = ? WHERE id = ?").run(now, id);
  }

  /** The pending invite a link is for, or why it doesn't work. With `email`, it must be the invited one. */
  check(token: string, email?: string, now = Date.now()): { invite: Invite } | { problem: string } {
    const row = token ? this.db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(hash(token)) as Row | undefined : undefined;
    if (!row) return { problem: PROBLEMS.unknown };
    const invite = toInvite(row, now);
    if (invite.status !== "pending") return { problem: PROBLEMS[invite.status] };
    if (email !== undefined && normalEmail(email) !== invite.email) return { problem: PROBLEMS.email };
    return { invite };
  }

  /** Uses an invite up (once): the account for `email` was made, for this person. */
  consume(token: string, email: string, personId: string, now = Date.now()): { invite: Invite } | { problem: string } {
    const checked = this.check(token, email, now);
    if ("problem" in checked) return checked;
    // Only one sign-up can use it, even two at once.
    const changed = this.db.prepare("UPDATE invites SET status = 'used', used_at = ?, person_id = ? WHERE id = ? AND status = 'pending'").run(now, personId, checked.invite.id).changes;
    return changed ? { invite: this.get(checked.invite.id, now)! } : { problem: PROBLEMS.used };
  }
}
