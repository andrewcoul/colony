import type { AgentRunner } from "./agent/run.js";
import { nextRun } from "./shared/schedule.js";
import type { Routine } from "./shared/types.js";
import type { Store } from "./store.js";

/** A run missed by more than this (the PC was off or asleep) is skipped, not caught up. */
const MISSED_GRACE_MS = 6 * 60 * 60_000;
/** If the Bot is busy in that chat when a routine is due, try again shortly. */
const BUSY_RETRY_MS = 60_000;

const routinePrompt = (routine: Routine) =>
  `(System: your routine "${routine.title}" ${routine.schedule.type === "mail" ? "was triggered by new mail" : "is running on its schedule"}. The user isn't watching right now; do the work and post the result as your reply, written for them to read later. Don't ask questions you could answer yourself.)\n\n${routine.prompt}`;

/** Fires due routines. Results land in the routine's chat with a "routine" card. */
export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private store: Store, private runner: AgentRunner) {}

  start(intervalMs = 20_000) {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  tick(now = Date.now()) {
    for (const routine of this.store.dueRoutines(now)) {
      if (now - routine.nextRunAt! > MISSED_GRACE_MS) {
        const next = nextRun(routine.schedule, now);
        this.store.updateRoutine(routine.id, { nextRunAt: next, ...(next === null ? { enabled: false } : {}) });
        continue;
      }
      if (this.runner.isRunning(routine.chatId, routine.botId)) {
        this.store.updateRoutine(routine.id, { nextRunAt: now + BUSY_RETRY_MS });
        continue;
      }
      this.run(routine.id, { now });
    }
  }

  /** Whether the routine's Bot is already replying in the routine's chat. */
  busy(routine: Routine) {
    return this.runner.isRunning(routine.chatId, routine.botId);
  }

  /**
   * Runs a routine now. A manual run leaves the schedule alone. `context` is added to the
   * instruction (e.g. the new mail that triggered it). Returns the reply message id.
   */
  run(routineId: string, { now = Date.now(), manual = false, context = "" } = {}): string | null {
    const routine = this.store.getRoutine(routineId);
    if (!routine) return null;
    const bot = this.store.getBot(routine.botId);
    if (!bot) { this.store.deleteRoutine(routine.id); return null; }
    const chat = this.store.getChat(routine.chatId);
    const chatId = chat?.memberIds.includes(bot.id) ? chat.id : bot.chatId;

    const next = manual ? routine.nextRunAt : nextRun(routine.schedule, now);
    // A spent one-off routine switches off; mail-triggered routines have no next time but aren't spent.
    const spent = !manual && next === null && routine.schedule.type !== "mail";
    this.store.updateRoutine(routine.id, {
      chatId, lastRunAt: now, nextRunAt: next,
      ...(spent ? { enabled: false } : {}),
    });
    try {
      return this.runner.start(chatId, bot.id, {
        hiddenPrompt: routinePrompt(routine) + (context ? `\n\n${context}` : ""),
        cards: [{ type: "routine", routineId: routine.id, action: "ran", title: routine.title }],
        onFinish: (message) => {
          const status = message.status === "done" ? "done" : message.status === "stopped" ? "stopped" : "failed";
          if (this.store.getRoutine(routine.id)) this.store.updateRoutine(routine.id, { lastStatus: status });
        },
      });
    } catch (error) {
      console.warn(`[colony] routine "${routine.title}" couldn't start:`, error instanceof Error ? error.message : error);
      this.store.updateRoutine(routine.id, { lastStatus: "failed" });
      return null;
    }
  }
}
