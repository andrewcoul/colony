import { describe, expect, test } from "vitest";
import { describeSchedule, nextRun } from "./schedule.js";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("nextRun", () => {
  test("daily: later today, else tomorrow", () => {
    expect(nextRun({ type: "daily", time: "08:00", days: [] }, at(2026, 10, 13, 7, 59))).toBe(at(2026, 10, 13, 8));
    expect(nextRun({ type: "daily", time: "08:00", days: [] }, at(2026, 10, 13, 8))).toBe(at(2026, 10, 14, 8));
  });

  test("weekdays skip the weekend", () => {
    // Fri Oct 16 2026, 18:30 → Mon Oct 19, 18:00
    expect(nextRun({ type: "daily", time: "18:00", days: [1, 2, 3, 4, 5] }, at(2026, 10, 16, 18, 30))).toBe(at(2026, 10, 19, 18));
  });

  test("interval and once", () => {
    expect(nextRun({ type: "interval", minutes: 120 }, 1_000)).toBe(1_000 + 120 * 60_000);
    expect(nextRun({ type: "interval", minutes: 1 }, 0)).toBe(15 * 60_000); // floor of 15 minutes
    expect(nextRun({ type: "once", at: 5_000 }, 4_000)).toBe(5_000);
    expect(nextRun({ type: "once", at: 5_000 }, 5_000)).toBeNull();
  });
});

test("describeSchedule reads like the app", () => {
  expect(describeSchedule({ type: "daily", time: "08:00", days: [] })).toBe("Every day at 8:00 AM");
  expect(describeSchedule({ type: "daily", time: "18:00", days: [5, 1, 2, 3, 4] })).toBe("Weekdays at 6:00 PM");
  expect(describeSchedule({ type: "daily", time: "09:30", days: [1] })).toBe("Mondays at 9:30 AM");
  expect(describeSchedule({ type: "daily", time: "00:15", days: [1, 3] })).toBe("Mon, Wed at 12:15 AM");
  expect(describeSchedule({ type: "interval", minutes: 120 })).toBe("Every 2 hours");
  expect(describeSchedule({ type: "interval", minutes: 30 })).toBe("Every 30 minutes");
});
