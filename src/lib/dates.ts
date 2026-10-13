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
