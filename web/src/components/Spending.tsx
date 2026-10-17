import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { m } from "motion/react";
import type { Spending } from "@shared/types";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { Face } from "./Face";

/** Dollars, to the cent; a sliver shows as "<$0.01" rather than nothing. */
export const money = (amount: number) => (amount > 0 && amount < 0.005 ? "<$0.01" : `$${amount.toFixed(2)}`);
const tokens = (count: number) => (count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count));

function Back({ onBack }: { onBack: () => void }) {
  return <button type="button" onClick={onBack} className="-mt-1 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>;
}

/** Settings › Spending: this month by Bot, and the last 30 days. */
export function SpendingPage({ onBack }: { onBack: () => void }) {
  const bots = useLive((s) => s.bots);
  const [spending, setSpending] = useState<Spending | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api.spending().then(setSpending).catch(() => setError("Couldn't load your spending.")); }, []);
  const peak = spending ? Math.max(...spending.days.map((day) => day.cost), 0) : 0;

  return (
    <div className="flex flex-col gap-4">
      <Back onBack={onBack} />
      {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
      {spending && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-meta text-muted">{spending.month} so far</span>
            <strong className="text-[32px] leading-none font-semibold tracking-tight tabular-nums">{money(spending.total)}</strong>
            {spending.cap !== null && spending.cap !== undefined && (
              <span className={cn("text-meta", spending.total >= spending.cap ? "text-danger" : "text-muted")}>
                {spending.total >= spending.cap ? `Your ${money(spending.cap)} monthly limit is reached: new replies wait until the 1st.` : `of your ${money(spending.cap)} monthly limit`}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-meta text-muted">Last 30 days</span>
            <div className="flex h-20 items-end gap-[3px]" role="img" aria-label={`Daily spending over the last 30 days, up to ${money(peak)} a day`}>
              {spending.days.map((day) => (
                <span key={day.date} className="flex h-full flex-1 flex-col justify-end" title={`${day.date}: ${money(day.cost)}`}>
                  <m.span className="w-full rounded-t-[2px] bg-sky" initial={{ height: 0 }} animate={{ height: peak > 0 ? `${(day.cost / peak) * 100}%` : "0%" }} transition={soft} />
                  {day.cost === 0 && <span className="h-px w-full bg-rule" />}
                </span>
              ))}
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
                    <strong className="truncate text-sm font-medium">{row.name}{!bot && <span className="font-normal text-muted"> · deleted</span>}</strong>
                    <span className="truncate text-meta text-muted">{tokens(row.tokens)} tokens</span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">{money(row.cost)}</span>
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
