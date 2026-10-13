import type { Db } from "./db.js";
import type { EphemeralEvent, ServerEvent } from "./shared/types.js";

type Listener = (event: { seq: number | null; event: ServerEvent | EphemeralEvent }) => void;

/** Keep enough history for a phone that slept for a while; older clients refetch state. */
const RETAIN = 5000;

/**
 * Persisted, sequenced event log. Clients replay from their last seq after a
 * reconnect; ephemeral events (streamed text) are broadcast without a seq.
 */
export class EventLog {
  private listeners = new Set<Listener>();
  private sinceTrim = 0;

  constructor(private db: Db) {}

  emit(event: ServerEvent) {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO events (payload, created_at) VALUES (?, ?)")
      .run(JSON.stringify(event), Date.now());
    const seq = Number(lastInsertRowid);
    if (++this.sinceTrim >= 500) {
      this.sinceTrim = 0;
      this.db.prepare("DELETE FROM events WHERE seq <= ?").run(seq - RETAIN);
    }
    for (const listener of this.listeners) listener({ seq, event });
    return seq;
  }

  broadcast(event: EphemeralEvent) {
    for (const listener of this.listeners) listener({ seq: null, event });
  }

  latestSeq() {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  /** Events after `seq`, or null if they have been trimmed and the client must refetch. */
  since(seq: number): { seq: number; event: ServerEvent }[] | null {
    const oldest = this.db.prepare("SELECT MIN(seq) AS seq FROM events").get() as { seq: number | null };
    if (oldest.seq !== null && seq < oldest.seq - 1) return null;
    const rows = this.db.prepare("SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq").all(seq) as { seq: number; payload: string }[];
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as ServerEvent }));
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
