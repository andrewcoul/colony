import { describe, expect, test } from "vitest";
import { IdleStopper } from "./idle.js";

const MINUTE = 60_000;

function setup(running: string[], busy = new Set<string>()) {
  let clock = 0;
  const stopped: string[] = [];
  const idle = new IdleStopper({
    idleMs: 5 * MINUTE,
    running: async () => running.filter((id) => !stopped.includes(id)),
    busy: (botId) => busy.has(botId),
    stop: async (botId) => void stopped.push(botId),
    now: () => clock,
  });
  return { idle, stopped, advance: (ms: number) => void (clock += ms) };
}

describe("IdleStopper", () => {
  test("switches off a computer five idle minutes after its last use", async () => {
    const { idle, stopped, advance } = setup(["a"]);
    idle.touch("a");
    advance(4 * MINUTE);
    expect(await idle.tick()).toEqual([]);
    advance(MINUTE);
    expect(await idle.tick()).toEqual(["a"]);
    expect(stopped).toEqual(["a"]);
  });

  test("each use starts the idle window again", async () => {
    const { idle, advance } = setup(["a"]);
    idle.touch("a");
    advance(4 * MINUTE);
    idle.touch("a");
    advance(4 * MINUTE);
    expect(await idle.tick()).toEqual([]);
  });

  test("keeps a computer on while it's busy, then gives it a full window", async () => {
    const busy = new Set(["a"]);
    const { idle, advance } = setup(["a"], busy);
    idle.touch("a");
    advance(30 * MINUTE);
    expect(await idle.tick()).toEqual([]);
    busy.delete("a");
    advance(4 * MINUTE);
    expect(await idle.tick()).toEqual([]);
    advance(MINUTE);
    expect(await idle.tick()).toEqual(["a"]);
  });

  test("a computer that was already running gets a full window first", async () => {
    const { idle, advance } = setup(["a"]);
    advance(60 * MINUTE);
    expect(await idle.tick()).toEqual([]);
    advance(5 * MINUTE);
    expect(await idle.tick()).toEqual(["a"]);
  });

  test("an idle time of 0 never starts the timer", () => {
    const idle = new IdleStopper({ idleMs: 0, running: async () => [], busy: () => false, stop: async () => {} });
    idle.start();
    expect((idle as unknown as { timer: unknown }).timer).toBeUndefined();
  });
});
