/**
 * Switches off Bot computers nobody is using, so they don't hold memory all day. A computer
 * is in use while its Bot is working, while you watch its screen or browser, or for `idleMs`
 * after its last command, desktop action or browser action. It starts again (in seconds) on
 * the next use; /workspace and browser logins persist.
 */
export class IdleStopper {
  private lastUsed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = new Set<string>();

  constructor(private options: {
    idleMs: number;
    /** Bots whose computers are running right now. */
    running: () => Promise<string[]>;
    /** Whether something still needs this computer (a reply in progress, a viewer open). */
    busy: (botId: string) => boolean;
    stop: (botId: string) => Promise<void>;
    now?: () => number;
  }) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Records use of a Bot's computer. */
  touch(botId: string) {
    this.lastUsed.set(botId, this.now());
  }

  start(intervalMs = 30_000) {
    if (this.options.idleMs <= 0) return; // Turned off.
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  stopTimer() {
    clearInterval(this.timer);
  }

  /** Stops computers idle for longer than `idleMs`. Returns the Bots it stopped. */
  async tick(): Promise<string[]> {
    const now = this.now();
    const stopped: string[] = [];
    for (const botId of await this.options.running()) {
      if (this.stopping.has(botId)) continue;
      const last = this.lastUsed.get(botId);
      // A computer we haven't seen (e.g. running before a restart) gets a full idle window.
      if (last === undefined || this.options.busy(botId)) { this.lastUsed.set(botId, now); continue; }
      if (now - last < this.options.idleMs) continue;
      this.stopping.add(botId);
      try {
        await this.options.stop(botId);
        this.lastUsed.delete(botId);
        stopped.push(botId);
      } finally {
        this.stopping.delete(botId);
      }
    }
    return stopped;
  }
}
