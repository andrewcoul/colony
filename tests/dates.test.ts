import { expect, test } from "vitest";
import { groupByRecency } from "../src/lib/dates";

test("groups conversations into Grok-style recency buckets in order", () => {
  const now = new Date(2026, 9, 13, 15, 0).getTime();
  const hour = 3_600_000;
  const items = [
    { id: "a", updatedAt: now - hour },
    { id: "b", updatedAt: now - 20 * hour },
    { id: "c", updatedAt: now - 4 * 24 * hour },
    { id: "d", updatedAt: now - 60 * 24 * hour },
  ];
  expect(groupByRecency(items, now).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
    ["Today", ["a"]], ["Yesterday", ["b"]], ["Previous 7 days", ["c"]], ["Older", ["d"]],
  ]);
});
