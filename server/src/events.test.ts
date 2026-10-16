import { expect, test } from "vitest";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";

test("an event emitted from a listener reaches every listener after the one that caused it", () => {
  const events = new EventLog(openDb(":memory:"));
  // Like Accounts, which subscribes first and emits accounts.updated on bot.deleted.
  events.subscribe(({ event }) => {
    if (event.type === "bot.deleted") events.emit({ type: "accounts.updated", accounts: [], access: [] });
  });
  const seen: (number | null)[] = [];
  events.subscribe(({ seq }) => seen.push(seq));

  const deleted = events.emit({ type: "bot.deleted", botId: "b1" });

  expect(seen).toEqual([deleted, deleted + 1]);
});
