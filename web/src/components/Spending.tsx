import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { SharedSpending, Spending } from "@shared/types";
import { api } from "../lib/api";
import { HOST_ID, useLive } from "../lib/live";
import { soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { PersonAvatar } from "./People";
import { Input } from "./ui/input";

/** Dollars, to the cent; a sliver shows as "<$0.01" rather than nothing. */
export const money = (amount: number) => (amount > 0 && amount < 0.005 ? "<$0.01" : `$${amount.toFixed(2)}`);
const tokens = (count: number) => (count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count));

function Back({ onBack }: { onBack: () => void }) {
  return <button type="button" onClick={onBack} className="-mt-1 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>;
}

/** How much of a monthly limit is used: a bar that turns lemon near the end and red past it. */
function LimitBar({ used, limit }: { used: number; limit: number }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 1;
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-raised">
      <m.span className={cn("block h-full rounded-full", share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-lemon" : "bg-mint")}
        initial={{ width: 0 }} animate={{ width: `${share * 100}%` }} transition={soft} />
    </span>
  );
}

/** Settings › You › Spending: this month by Bot, your keys and the shared ones, and the last 30 days. */
export function SpendingPage({ onBack }: { onBack: () => void }) {
  const bots = useLive((s) => s.bots);
  const [spending, setSpending] = useState<Spending | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api.spending().then(setSpending).catch(() => setError("Couldn't load your spending.")); }, []);
  const total = spending ? spending.own + spending.shared : 0;
  const peak = spending ? Math.max(...spending.days.map((day) => day.own + day.shared), 0) : 0;

  return (
    <div className="flex flex-col gap-4">
      <Back onBack={onBack} />
      {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
      {spending && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-meta text-muted">{spending.month} so far</span>
            <strong className="text-[32px] leading-none font-semibold tracking-tight tabular-nums">{money(total)}</strong>
            <span className="flex flex-wrap gap-x-4 text-label text-soft">
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-sky" />Your keys {money(spending.own)}</span>
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-lemon" />{spending.hostName}'s shared keys {money(spending.shared)}</span>
            </span>
          </div>

          {spending.limit !== null && (
            <div className="flex flex-col gap-1.5 rounded-xl border border-rule px-3.5 py-3">
              <span className="flex items-baseline justify-between gap-3 text-label">
                <span>Your share of {spending.hostName}'s keys</span>
                <span className="tabular-nums text-soft">{money(spending.shared)} of {money(spending.limit)}</span>
              </span>
              <LimitBar used={spending.shared} limit={spending.limit} />
              <span className="text-meta text-muted">
                {spending.shared >= spending.limit
                  ? `Used up for ${spending.month}. Your Bots use your own key if you have one; otherwise they wait until the 1st.`
                  : "Resets on the 1st. When it's used up, your Bots switch to your own key if you have one."}
              </span>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-meta text-muted">Last 30 days</span>
            <div className="flex h-20 items-end gap-[3px]" role="img" aria-label={`Daily spending over the last 30 days, up to ${money(peak)} a day`}>
              {spending.days.map((day) => {
                const height = (amount: number) => (peak > 0 ? `${(amount / peak) * 100}%` : "0%");
                return (
                  <span key={day.date} className="flex h-full flex-1 flex-col justify-end" title={`${day.date}: ${money(day.own + day.shared)}`}>
                    <m.span className="w-full rounded-t-[2px] bg-lemon" initial={{ height: 0 }} animate={{ height: height(day.shared) }} transition={soft} />
                    <m.span className={cn("w-full bg-sky", day.shared === 0 && "rounded-t-[2px]")} initial={{ height: 0 }} animate={{ height: height(day.own) }} transition={soft} />
                    {day.own + day.shared === 0 && <span className="h-px w-full bg-rule" />}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col rounded-xl border border-rule">
            {spending.bots.length === 0 && <p className="m-0 p-4 text-label text-muted">Nothing yet this month.</p>}
            {spending.bots.map((row, index) => {
              const bot = bots[row.botId];
              return (
                <div key={row.botId} className={cn("flex items-center gap-3 px-3.5 py-3", index > 0 && "border-t border-rule")}>
                  {bot ? <Face seed={bot.faceSeed} size={28} title={bot.name} /> : <span className="size-7 shrink-0 rounded-full bg-raised" />}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="truncate text-sm font-medium">{row.name}{!bot && <span className="font-normal text-muted"> · given away</span>}</strong>
                    <span className="truncate text-meta text-muted">
                      {[row.own > 0 ? `${money(row.own)} yours` : null, row.shared > 0 ? `${money(row.shared)} shared` : null, `${tokens(row.tokens)} tokens`].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">{money(row.own + row.shared)}</span>
                </div>
              );
            })}
          </div>

          {spending.unpriced.length > 0 && (
            <p className="m-0 text-meta leading-relaxed text-muted">
              No price set for <span className="font-mono">{spending.unpriced.join(", ")}</span>: their tokens count, but not their cost. Add a price on the provider in Settings.
            </p>
          )}
          <p className="m-0 text-meta leading-relaxed text-muted">Costs are estimates from each model's price per million tokens, not your provider's bill.</p>
        </>
      )}
    </div>
  );
}

/** Settings › This Colony › Shared keys (the host): this month on the shared keys, by person and Bot, with monthly limits. */
export function SharedKeysPage({ onBack }: { onBack: () => void }) {
  const people = useLive((s) => s.people);
  const [spending, setSpending] = useState<SharedSpending | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api.sharedSpending().then(setSpending).catch(() => setError("Couldn't load the shared keys.")); }, []);

  async function setLimit(personId: string, text: string) {
    const limit = text.trim() === "" ? null : Number(text.replace(/[$,\s]/g, ""));
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) { setError("A limit is an amount in dollars, or blank for none."); return; }
    setError("");
    try { setSpending(await api.setSpendLimit(personId, limit)); } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't set the limit."); }
  }

  const rows = spending?.people.map((row) => ({ ...row, person: people.find((person) => person.id === row.personId) }))
    .filter((row) => row.person).sort((a, b) => Number(b.personId === HOST_ID) - Number(a.personId === HOST_ID) || b.cost - a.cost) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Back onBack={onBack} />
      {spending && (
        <div className="flex flex-col gap-1">
          <span className="text-meta text-muted">{spending.month} on your shared keys</span>
          <strong className="text-[32px] leading-none font-semibold tracking-tight tabular-nums">{money(spending.total)}</strong>
        </div>
      )}
      <div className="flex flex-col rounded-xl border border-rule">
        {rows.map((row, index) => {
          const you = row.personId === HOST_ID;
          const expanded = open === row.personId;
          return (
            <div key={row.personId} className={cn(index > 0 && "border-t border-rule")}>
              <div className="flex items-center gap-3 px-3.5 py-3">
                <button type="button" onClick={() => setOpen(expanded ? null : row.personId)} aria-expanded={expanded} disabled={row.bots.length === 0}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
                  <PersonAvatar person={row.person!} size={28} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="truncate text-sm font-medium">{row.person!.name}{you && <span className="font-normal text-muted"> · you</span>}</strong>
                    <span className="truncate text-meta text-muted">{row.bots.length ? `${row.bots.length} Bot${row.bots.length === 1 ? "" : "s"}` : "Nothing yet this month"}</span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">{money(row.cost)}</span>
                  {row.bots.length > 0 && <ChevronDown size={15} className={cn("shrink-0 text-muted transition-transform", expanded && "rotate-180")} />}
                </button>
              </div>
              {!you && (
                <div className="flex flex-col gap-1.5 px-3.5 pb-3">
                  <label className="flex items-center gap-2 text-meta text-muted">
                    Monthly limit
                    <span className="relative">
                      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">$</span>
                      <Input key={`${row.personId}:${row.limit}`} defaultValue={row.limit ?? ""} placeholder="none" inputMode="decimal" aria-label={`${row.person!.name}'s monthly limit in dollars`}
                        className="h-8 w-24 pl-5 tabular-nums" onBlur={(event) => { if (event.target.value.trim() !== String(row.limit ?? "")) void setLimit(row.personId, event.target.value); }}
                        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
                    </span>
                  </label>
                  {row.limit !== null && <LimitBar used={row.cost} limit={row.limit} />}
                </div>
              )}
              <AnimatePresence initial={false}>
                {expanded && (
                  <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={soft} className="overflow-hidden">
                    <div className="flex flex-col gap-1 border-t border-rule px-3.5 py-2.5">
                      {row.bots.map((bot) => (
                        <span key={bot.botId} className="flex items-baseline justify-between gap-3 text-label text-soft">
                          <span className="truncate">{bot.name}</span><span className="tabular-nums">{money(bot.cost)}</span>
                        </span>
                      ))}
                    </div>
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
      {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
      <p className="m-0 text-meta leading-relaxed text-muted">
        When someone reaches their limit, their Bots switch to their own key if they have one; otherwise they stop until the 1st, and you both get a notification.
        Bots already working finish what they're doing, so a limit can be passed by a little. Costs are estimates from each model's price.
      </p>
    </div>
  );
}
