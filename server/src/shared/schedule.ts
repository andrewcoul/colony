import type { Schedule } from "./types.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MIN_INTERVAL_MINUTES = 15;

/** Parses "8:00", "08:00" or "18:30" into minutes after midnight. */
export function parseTime(time: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The next run strictly after `after` (local time), or null if the schedule is spent. */
export function nextRun(schedule: Schedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "interval") return after + Math.max(MIN_INTERVAL_MINUTES, schedule.minutes) * 60_000;
  const minutes = parseTime(schedule.time);
  if (minutes === null) return null;
  const days = schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const day = new Date(after);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, Math.floor(minutes / 60), minutes % 60);
    if (candidate.getTime() > after && days.includes(candidate.getDay())) return candidate.getTime();
  }
  return null;
}

function clock(time: string) {
  const minutes = parseTime(time) ?? 0;
  const hours = Math.floor(minutes / 60);
  return `${hours % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** "Every day at 8:00 AM", "Weekdays at 6:00 PM", "Every 2 hours", "Once, Oct 14 at 9:00 AM". */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.type === "interval") {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, schedule.minutes);
    if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
    return `Every ${minutes} minutes`;
  }
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return `Once, ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  const days = [...new Set(schedule.days)].sort();
  const when = clock(schedule.time);
  if (!days.length || days.length === 7) return `Every day at ${when}`;
  if (days.join() === "1,2,3,4,5") return `Weekdays at ${when}`;
  if (days.join() === "0,6") return `Weekends at ${when}`;
  if (days.length === 1) return `${FULL_DAY_NAMES[days[0]]}s at ${when}`;
  return `${days.map((day) => DAY_NAMES[day]).join(", ")} at ${when}`;
}
