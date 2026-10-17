import type { Db } from "./db.js";
import type { EphemeralEvent, ServerEvent } from "./shared/types.js";

/** Who an event is for: one person's id, or null for everyone (what models exist, say). */
export type Audience = string | null;
export type Item = { seq: number | null; event: ServerEvent | EphemeralEvent; personId: Audience };
type Listener = (item: Item) => void;

/** Keep enough history for a phone that slept for a while; older clients refetch state. */
const RETAIN = 5000;

/**
 * Persisted, sequenced event log. Clients replay from their last seq after a
 * reconnect; ephemeral events (streamed text) are broadcast without a seq. Every event
 * names who it's for, and each person's live stream carries only theirs (see `visibleTo`).
 */
export class EventLog {
  private listeners = new Set<Listener>();
  private sinceTrim = 0;
  private pending: Item[] = [];
  private delivering = false;

  constructor(private db: Db) {}

  emit(event: ServerEvent, personId: Audience) {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO events (payload, person_id, created_at) VALUES (?, ?, ?)")
      .run(JSON.stringify(event), personId, Date.now());
    const seq = Number(lastInsertRowid);
    if (++this.sinceTrim >= 500) {
      this.sinceTrim = 0;
      this.db.prepare("DELETE FROM events WHERE seq <= ?").run(seq - RETAIN);
    }
    this.deliver({ seq, event, personId });
    return seq;
  }

  broadcast(event: EphemeralEvent, personId: Audience) {
    this.deliver({ seq: null, event, personId });
  }

  /**
   * Delivers in seq order. A listener that emits while handling an event (Accounts emits
   * accounts.updated on bot.deleted) would otherwise reach later listeners first, and the SSE
   * stream drops anything older than what it last sent.
   */
  private deliver(item: Item) {
    this.pending.push(item);
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let next = this.pending.shift(); next; next = this.pending.shift()) {
        for (const listener of this.listeners) listener(next);
      }
    } finally {
      this.delivering = false;
      this.pending = [];
    }
  }

  latestSeq() {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  /** Events after `seq`, or null if they have been trimmed and the client must refetch. */
  since(seq: number): { seq: number; event: ServerEvent; personId: Audience }[] | null {
    const oldest = this.db.prepare("SELECT MIN(seq) AS seq FROM events").get() as { seq: number | null };
    if (oldest.seq !== null && seq < oldest.seq - 1) return null;
    const rows = this.db.prepare("SELECT seq, payload, person_id FROM events WHERE seq > ? ORDER BY seq").all(seq) as { seq: number; payload: string; person_id: string | null }[];
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as ServerEvent, personId: row.person_id }));
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** Whether this person's stream carries an event: it's theirs, or everyone's. */
export const visibleTo = (personId: string, item: Pick<Item, "personId">) => item.personId === null || item.personId === personId;
