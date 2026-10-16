import type { LanguageModelUsage } from "ai";
import { HOST_ID } from "./people.js";
import { costMicros } from "./prices.js";
import { spendLimit, type ModelTarget } from "./settings.js";
import type { Price, SharedSpending, Spending } from "./shared/types.js";
import type { Store, UsageRow } from "./store.js";

/** One model step's usage, paid for by the key's owner (null: a shared key). */
export function usageEntry(target: ModelTarget, bot: { id: string; ownerId: string }, usage: LanguageModelUsage, price: Price | null) {
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(input, usage.inputTokenDetails?.cacheReadTokens ?? 0);
  const output = usage.outputTokens ?? 0;
  return {
    botId: bot.id, ownerId: bot.ownerId, providerId: target.provider.id, payerId: target.provider.ownerId, model: target.model,
    inputTokens: input, cachedTokens: cached, outputTokens: output, costMicros: costMicros({ input, cached, output }, price),
  };
}

/** Midnight on the 1st of this month, local time: limits reset then. */
export const monthStart = (now = Date.now()) => { const date = new Date(now); return new Date(date.getFullYear(), date.getMonth(), 1).getTime(); };
export const monthName = (now = Date.now()) => new Date(now).toLocaleString("en-US", { month: "long" });
const dollars = (micros: number) => micros / 1_000_000;
const dayKey = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

/** This month's spending on shared keys by a person's Bots, in dollars. */
export const sharedThisMonth = (store: Store, personId: string, now = Date.now()) =>
  dollars(store.listUsage(monthStart(now)).filter((row) => row.ownerId === personId && row.payerId === null).reduce((sum, row) => sum + (row.costMicros ?? 0), 0));

/** Whether a person has used up the monthly share of the host's keys the host gave them. */
export function shareUsedUp(store: Store, personId: string, now = Date.now()) {
  const limit = personId === HOST_ID ? null : spendLimit(personId);
  return limit !== null && sharedThisMonth(store, personId, now) >= limit;
}

/** The words a Bot's turn stops with when its owner's share is used up. */
export const usedUpMessage = (store: Store, now = Date.now()) =>
  `Your share of ${store.getPerson(HOST_ID)?.name ?? "the host"}'s keys is used up for ${monthName(now)}. Add your own key in Settings to keep going.`;

/** Your spending: this month by Bot, split into your keys and shared ones, and the last 30 days. */
export function spendingFor(store: Store, personId: string, now = Date.now()): Spending {
  const start = monthStart(now);
  const today = new Date(now);
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29).getTime();
  const rows = store.listUsage(Math.min(start, from)).filter((row) => row.ownerId === personId);
  const month = rows.filter((row) => row.at >= start);
  const bots = new Map<string, { botId: string; name: string; own: number; shared: number; tokens: number }>();
  for (const row of month) {
    const bot = bots.get(row.botId) ?? { botId: row.botId, name: store.getBot(row.botId)?.name ?? "A Bot", own: 0, shared: 0, tokens: 0 };
    if (row.payerId === null) bot.shared += row.costMicros ?? 0; else bot.own += row.costMicros ?? 0;
    bot.tokens += row.inputTokens + row.outputTokens;
    bots.set(row.botId, bot);
  }
  const days = Array.from({ length: 30 }, (_, index) => ({ date: dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29 + index).getTime()), own: 0, shared: 0 }));
  const byDay = new Map(days.map((day) => [day.date, day]));
  for (const row of rows) {
    const day = byDay.get(dayKey(row.at));
    if (day) { if (row.payerId === null) day.shared += row.costMicros ?? 0; else day.own += row.costMicros ?? 0; }
  }
  const own = month.filter((row) => row.payerId !== null).reduce((sum, row) => sum + (row.costMicros ?? 0), 0);
  const shared = month.filter((row) => row.payerId === null).reduce((sum, row) => sum + (row.costMicros ?? 0), 0);
  return {
    month: monthName(now),
    own: dollars(own),
    shared: dollars(shared),
    limit: personId === HOST_ID ? null : spendLimit(personId),
    hostName: store.getPerson(HOST_ID)?.name ?? "the host",
    bots: [...bots.values()].map((bot) => ({ ...bot, own: dollars(bot.own), shared: dollars(bot.shared) })).sort((a, b) => b.own + b.shared - a.own - a.shared),
    days: days.map((day) => ({ ...day, own: dollars(day.own), shared: dollars(day.shared) })),
    unpriced: [...new Set(month.filter((row) => row.costMicros === null).map((row) => row.model))],
  };
}

/** The host's view of the shared keys this month: by person, then by Bot, with each person's limit. */
export function sharedSpending(store: Store, now = Date.now()): SharedSpending {
  const rows: UsageRow[] = store.listUsage(monthStart(now)).filter((row) => row.payerId === null);
  const people = store.listPeople().map((person) => {
    const theirs = rows.filter((row) => row.ownerId === person.id);
    const bots = new Map<string, { botId: string; name: string; cost: number }>();
    for (const row of theirs) {
      const bot = bots.get(row.botId) ?? { botId: row.botId, name: store.getBot(row.botId)?.name ?? "A Bot", cost: 0 };
      bot.cost += row.costMicros ?? 0;
      bots.set(row.botId, bot);
    }
    return {
      personId: person.id,
      cost: dollars(theirs.reduce((sum, row) => sum + (row.costMicros ?? 0), 0)),
      limit: person.id === HOST_ID ? null : spendLimit(person.id),
      bots: [...bots.values()].map((bot) => ({ ...bot, cost: dollars(bot.cost) })).sort((a, b) => b.cost - a.cost),
    };
  });
  return { month: monthName(now), total: people.reduce((sum, person) => sum + person.cost, 0), people };
}
