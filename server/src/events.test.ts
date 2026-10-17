import { expect, test } from "vitest";
import { openDb } from "./db.js";
import { EventLog, visibleTo } from "./events.js";

test("an event emitted from a listener reaches every listener after the one that caused it", () => {
  const events = new EventLog(openDb(":memory:"));
  // Like Accounts, which subscribes first and emits accounts.updated on bot.deleted.
  events.subscribe(({ event }) => {
    if (event.type === "bot.deleted") events.emit({ type: "accounts.updated", accounts: [], access: [] }, "owner");
  });
  const seen: (number | null)[] = [];
  events.subscribe(({ seq }) => seen.push(seq));

  const deleted = events.emit({ type: "bot.deleted", botId: "b1" }, "owner");

  expect(seen).toEqual([deleted, deleted + 1]);
});

test("every event keeps who it's for, live and in the replayed backlog", () => {
  const events = new EventLog(openDb(":memory:"));
  const live: { personId: string | null }[] = [];
  events.subscribe((item) => live.push(item));
  events.emit({ type: "bot.deleted", botId: "a1" }, "alice");
  events.emit({ type: "bot.deleted", botId: "b1" }, "bob");
  events.emit({ type: "settings.updated", models: [], defaultModel: "", configured: true }, null);
  events.broadcast({ type: "computer.output", botId: "a1", text: "hi" }, "alice");
  const backlog = events.since(0)!;
  expect(backlog.map((item) => item.personId)).toEqual(["alice", "bob", null]);
  expect(live.map((item) => item.personId)).toEqual(["alice", "bob", null, "alice"]);
  // Alice's stream carries hers and everyone's; never Bob's. Nobody's ("") reaches no one.
  expect(backlog.filter((item) => visibleTo("alice", item)).map((item) => item.event.type === "bot.deleted" ? item.event.botId : item.event.type)).toEqual(["a1", "settings.updated"]);
  expect(visibleTo("alice", { personId: "" })).toBe(false);
});
