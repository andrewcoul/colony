const DAY = 86_400_000;

/** Groups items into Grok-style history buckets, preserving their order. */
export function groupByRecency<T extends { updatedAt: number }>(items: T[], now = Date.now()) {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const buckets: { label: string; test: (time: number) => boolean }[] = [
    { label: "Today", test: (t) => t >= startOfToday },
    { label: "Yesterday", test: (t) => t >= startOfToday - DAY },
    { label: "Previous 7 days", test: (t) => t >= startOfToday - 7 * DAY },
    { label: "Previous 30 days", test: (t) => t >= startOfToday - 30 * DAY },
    { label: "Older", test: () => true },
  ];
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = buckets.find((bucket) => bucket.test(item.updatedAt))!.label;
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Roster-style timestamp: "7:34 PM", "Yesterday", "Tue", or "Oct 2". */
export function shortTime(time: number, now = Date.now()) {
  const date = new Date(time);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (time >= startOfToday) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (time >= startOfToday - DAY) return "Yesterday";
  if (time >= startOfToday - 6 * DAY) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** When a routine runs next: "Today 8:00 AM", "Tomorrow 8:00 AM", "Fri 6:00 PM", or "Oct 30, 9:00 AM". */
export function upcoming(time: number, now = Date.now()) {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (time < startOfToday + DAY) return `Today ${clock}`;
  if (time < startOfToday + 2 * DAY) return `Tomorrow ${clock}`;
  if (time < startOfToday + 7 * DAY) return `${date.toLocaleDateString([], { weekday: "short" })} ${clock}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock}`;
}
