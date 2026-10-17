import { fence, when } from "../agent/mailTools.js";
import { ADMIN_ID } from "../people.js";
import type { RoutineScheduler } from "../routines.js";
import type { Routine } from "../shared/types.js";
import type { Store } from "../store.js";
import { allows } from "./accounts.js";
import type { Integrations } from "./index.js";
import type { MailSummary } from "./mail/types.js";

/** How often inboxes with mail-triggered routines are checked. */
const POLL_MS = 2 * 60_000;
/** A routine runs at most this often; mail arriving in between waits for the next run. */
const MIN_GAP_MS = 10 * 60_000;
/** A saved position older than this is stale (no routine was watching): start again from now. */
const STALE_MS = 30 * 60_000;

type MailSchedule = Extract<Routine["schedule"], { type: "mail" }>;

const includes = (value: string, part: string | undefined) => !part || value.toLowerCase().includes(part.toLowerCase());
export const matches = (schedule: MailSchedule, message: MailSummary) => includes(message.from, schedule.from) && includes(message.subject, schedule.subject);

/**
 * Checks the inboxes that mail-triggered routines watch and runs those routines when
 * matching mail arrives. Mail arriving close together goes into one run.
 */
export class MailPoller {
  /** Mail that matched a routine and is waiting for it to run. Kept in the database so a restart doesn't drop it. */
  private waiting: Map<string, MailSummary[]>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(private store: Store, private services: Integrations, private routines: RoutineScheduler) {
    this.waiting = store.pendingTriggers() as Map<string, MailSummary[]>;
  }

  private setWaiting(routineId: string, mail: MailSummary[] | null) {
    if (mail?.length) this.waiting.set(routineId, mail);
    else this.waiting.delete(routineId);
    this.store.setPendingTrigger(routineId, mail);
  }

  start(intervalMs = POLL_MS) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 15_000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.check();
      this.fire(now);
    } finally {
      this.busy = false;
    }
  }

  private watching() {
    return this.store.listRoutines().filter((routine): routine is Routine & { schedule: MailSchedule } => routine.enabled && routine.schedule.type === "mail");
  }

  private async check() {
    const { accounts } = this.services;
    const byAccount = new Map<string, (Routine & { schedule: MailSchedule })[]>();
    for (const routine of this.watching()) {
      // Only Bots still allowed to read that mailbox (accounts are the admin's, for the admin's Bots).
      if (this.store.getBot(routine.botId)?.ownerId !== ADMIN_ID) continue;
      if (!allows.mail(accounts.access(routine.botId, routine.schedule.accountId).mail, "read")) continue;
      byAccount.set(routine.schedule.accountId, [...(byAccount.get(routine.schedule.accountId) ?? []), routine]);
    }
    for (const [accountId, routines] of byAccount) {
      const account = accounts.get(accountId);
      if (!account || account.kind === "onepassword" || account.status !== "ok") continue;
      try {
        const { added, cursor } = await this.services.mail(account).changes(accounts.cursor(accountId, "mail", STALE_MS));
        accounts.setCursor(accountId, "mail", cursor);
        for (const routine of routines) {
          const matching = added.filter((message) => matches(routine.schedule, message));
          if (matching.length) this.setWaiting(routine.id, [...(this.waiting.get(routine.id) ?? []), ...matching].slice(-20));
        }
      } catch (error) {
        console.warn(`[colony] Couldn't check ${account.label} (${account.email}) for new mail:`, error instanceof Error ? error.message : error);
      }
    }
  }

  private fire(now: number) {
    for (const [routineId, messages] of this.waiting) {
      const routine = this.store.getRoutine(routineId);
      if (!routine?.enabled || routine.schedule.type !== "mail") { this.setWaiting(routineId, null); continue; }
      if (routine.lastRunAt && now - routine.lastRunAt < MIN_GAP_MS) continue;
      if (this.routines.busy(routine)) continue;
      const account = this.services.accounts.get(routine.schedule.accountId);
      const list = messages.map((message) => `- id ${message.id} · from ${message.from} · “${message.subject}” · ${when(message.date)}`).join("\n");
      const context = `New mail${account ? ` in ${account.email}` : ""} (read it with mail_read before acting on it):\n${fence(list)}`;
      if (this.routines.run(routine.id, { now, context })) this.setWaiting(routineId, null);
    }
  }
}
