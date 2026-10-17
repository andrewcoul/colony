import { costMicros } from "./prices.js";
import { spendCapOf, type ModelTarget } from "./settings.js";
import type { Price, Spending } from "./shared/types.js";
import type { Store } from "./store.js";

/** Tokens one model call used. `input` includes cached reads (they're priced at the cached price). */
export type TokenUsage = { input: number; cached: number; output: number };

/** One model call's usage. */
export function usageEntry(target: ModelTarget, bot: { id: string }, usage: TokenUsage, price: Price | null) {
  const input = usage.input;
  const cached = Math.min(input, usage.cached);
  const output = usage.output;
  return {
    botId: bot.id, providerId: target.provider.id, model: target.model,
    inputTokens: input, cachedTokens: cached, outputTokens: output, costMicros: costMicros({ input, cached, output }, price),
  };
}

/** Spending months (and members' caps) run on Colony's calendar: America/Chicago. */
export const SPEND_TIME_ZONE = "America/Chicago";

/** A time as a wall clock in `zone` shows it. */
function wallClock(at: number, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
/** How far `zone`'s wall clock is ahead of UTC at a time (negative in America). */
const zoneOffset = (at: number, zone: string) => {
  const wall = wallClock(at, zone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(at / 1000) * 1000;
};

/** Midnight on the 1st of this month in `zone` (America/Chicago unless said). */
export function monthStart(now = Date.now(), zone = SPEND_TIME_ZONE) {
  const { year, month } = wallClock(now, zone);
  const midnight = Date.UTC(year, month - 1, 1);
  // Twice, in case the offset at midnight differs from the guess's (a daylight saving change).
  return midnight - zoneOffset(midnight - zoneOffset(midnight, zone), zone);
}
export const monthName = (now = Date.now(), zone = SPEND_TIME_ZONE) => new Date(now).toLocaleString("en-US", { month: "long", timeZone: zone });
const dollars = (micros: number) => micros / 1_000_000;
const dayKey = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

/** What one person's Bots have spent this calendar month (America/Chicago), in dollars. */
export function monthSpend(store: Store, ownerId: string, now = Date.now()) {
  return dollars(store.listUsage(monthStart(now), ownerId).reduce((sum, row) => sum + (row.costMicros ?? 0), 0));
}

/**
 * Why this person's Bots can't start another turn this month, or null. Only members have caps
 * (set by the admin; none by default); once this month's spending reaches it, new turns wait.
 */
export function spendLimitProblem(store: Store, person: { id: string; role: "admin" | "member" }, now = Date.now()): string | null {
  if (person.role === "admin") return null;
  const { cap } = spendCapOf(person.id);
  if (cap === null) return null;
  const spent = monthSpend(store, person.id, now);
  if (spent < cap) return null;
  return `You've reached your $${cap.toFixed(2)} spending limit for ${monthName(now)} ($${spent.toFixed(2)} spent). Your Bots can work again on the 1st, or sooner if your Colony admin raises it.`;
}

/** One person's spending (what their Bots used): this month by Bot, the last 30 days, and their cap. */
export function spendingFor(store: Store, ownerId: string, now = Date.now(), cap: number | null = null): Spending {
  const start = monthStart(now);
  const today = new Date(now);
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29).getTime();
  const rows = store.listUsage(Math.min(start, from), ownerId);
  const month = rows.filter((row) => row.at >= start);
  const bots = new Map<string, { botId: string; name: string; cost: number; tokens: number }>();
  for (const row of month) {
    const bot = bots.get(row.botId) ?? { botId: row.botId, name: store.getBot(row.botId)?.name ?? "A Bot", cost: 0, tokens: 0 };
    bot.cost += row.costMicros ?? 0;
    bot.tokens += row.inputTokens + row.outputTokens;
    bots.set(row.botId, bot);
  }
  const days = Array.from({ length: 30 }, (_, index) => ({ date: dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29 + index).getTime()), cost: 0 }));
  const byDay = new Map(days.map((day) => [day.date, day]));
  for (const row of rows) {
    const day = byDay.get(dayKey(row.at));
    if (day) day.cost += row.costMicros ?? 0;
  }
  return {
    month: monthName(now),
    total: dollars(month.reduce((sum, row) => sum + (row.costMicros ?? 0), 0)),
    bots: [...bots.values()].map((bot) => ({ ...bot, cost: dollars(bot.cost) })).sort((a, b) => b.cost - a.cost),
    days: days.map((day) => ({ ...day, cost: dollars(day.cost) })),
    unpriced: [...new Set(month.filter((row) => row.costMicros === null).map((row) => row.model))],
    cap,
  };
}
