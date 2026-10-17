import { costMicros } from "./prices.js";
import type { ModelTarget } from "./settings.js";
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

/** Midnight on the 1st of this month, local time. */
export const monthStart = (now = Date.now()) => { const date = new Date(now); return new Date(date.getFullYear(), date.getMonth(), 1).getTime(); };
export const monthName = (now = Date.now()) => new Date(now).toLocaleString("en-US", { month: "long" });
const dollars = (micros: number) => micros / 1_000_000;
const dayKey = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

/** One person's spending (what their Bots used): this month by Bot, and the last 30 days. */
export function spendingFor(store: Store, ownerId: string, now = Date.now()): Spending {
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
  };
}
