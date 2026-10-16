import { useState } from "react";
import { ArrowRightLeft, Check, Gift } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { Bot, BotTransfer } from "@shared/types";
import { api } from "../lib/api";
import { useLive, useMyId } from "../lib/live";
import { rise, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { PersonAvatar } from "./People";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

const failed = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

/** In a Bot's profile: give it to someone in the family, or see the offer waiting for an answer. */
export function GiveBotSection({ bot, onError }: { bot: Bot; onError: (message: string) => void }) {
  const myId = useMyId();
  const people = useLive((s) => s.people);
  const offer = useLive((s) => s.transfers.find((transfer) => transfer.botId === bot.id));
  const [open, setOpen] = useState(false);
  const others = people.filter((person) => person.id !== myId);
  if (!others.length || bot.ownerId !== myId) return null;
  const to = offer && people.find((person) => person.id === offer.toId);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 flex items-center gap-2 text-label font-semibold"><Gift size={14} className="text-muted" />Give {bot.name} away</h3>
      {offer ? (
        <div className="flex items-center gap-3 rounded-xl border border-lemon/30 bg-lemon/8 px-3.5 py-3">
          {to && <PersonAvatar person={to} size={26} />}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="truncate text-sm font-medium">Offered to {to?.name ?? "someone"}</strong>
            <span className="truncate text-meta text-muted">Nothing changes until they accept{offer.keepMemory ? "" : " · starts fresh"}</span>
          </span>
          <Button variant="outline" size="pill" onClick={() => void api.cancelTransfer(offer.id).catch((failure) => onError(failed(failure, "Couldn't cancel.")))}>Cancel</Button>
        </div>
      ) : (
        <>
          <p className="m-0 text-meta text-muted">Hand {bot.name} to someone in the family. They decide whether to take it.</p>
          <Button variant="outline" size="pill" className="self-start" onClick={() => setOpen(true)}><ArrowRightLeft size={14} />Give {bot.name} to…</Button>
        </>
      )}
      <GiveDialog bot={bot} open={open} onOpenChange={setOpen} onError={onError} />
    </section>
  );
}

/** Pick who gets the Bot and whether its memory goes too; says plainly what moves and what stays. */
function GiveDialog({ bot, open, onOpenChange, onError }: { bot: Bot; open: boolean; onOpenChange: (open: boolean) => void; onError: (message: string) => void }) {
  const myId = useMyId();
  const others = useLive((s) => s.people).filter((person) => person.id !== myId);
  const [toId, setToId] = useState<string | null>(null);
  const [keepMemory, setKeepMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const to = others.find((person) => person.id === toId);

  async function give() {
    if (!toId) return;
    setBusy(true);
    try { await api.giveBot(bot.id, toId, keepMemory); onOpenChange(false); }
    catch (failure) { onError(failed(failure, "Couldn't offer it.")); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Give ${bot.name} to…`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col rounded-xl border border-rule" role="radiogroup" aria-label="Who gets it">
          {others.map((person, index) => (
            <button key={person.id} type="button" role="radio" aria-checked={toId === person.id} onClick={() => setToId(person.id)}
              className={cn("flex items-center gap-3 px-3.5 py-3 text-left hover:bg-hover", index > 0 && "border-t border-rule")}>
              <PersonAvatar person={person} size={28} />
              <strong className="flex-1 truncate text-sm font-medium">{person.name}</strong>
              <span className={cn("grid size-5 place-items-center rounded-full border", toId === person.id ? "border-transparent bg-ink text-on-ink" : "border-rule")}>
                {toId === person.id && <Check size={12} strokeWidth={3} />}
              </span>
            </button>
          ))}
        </div>

        <div className="flex rounded-full bg-raised p-[3px]" role="radiogroup" aria-label="Memory">
          {([[true, "Keep its memory"], [false, "Start fresh"]] as const).map(([value, label]) => (
            <button key={label} type="button" role="radio" aria-checked={keepMemory === value} onClick={() => setKeepMemory(value)}
              className={cn("h-8 flex-1 rounded-full text-meta", keepMemory === value ? "bg-ground text-ink" : "text-muted hover:text-ink")}>{label}</button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 text-meta leading-relaxed">
          <div className="flex flex-col gap-1">
            <span className="text-muted">Goes to {to?.name ?? "them"}</span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-soft">
              <li>{bot.name}: persona and skills</li>
              <li>Routines, in a new chat with {to?.name ?? "them"}</li>
              <li>Its computer and workspace</li>
              <li>{keepMemory ? "Its memory" : "A blank memory"}</li>
            </ul>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted">Stays with you</span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-soft">
              <li>Your chat with {bot.name}, archived</li>
              <li>Your accounts (its access ends)</li>
              <li>Your own model key</li>
              <li>What it cost you so far</li>
            </ul>
          </div>
        </div>
        <p className="m-0 text-meta leading-relaxed text-muted">Topics stay as they are; if {to?.name ?? "they"} can't see one, {bot.name} leaves it. Nothing changes until {to?.name ?? "they"} accepts.</p>
        <Button variant="primary" disabled={!toId || busy} onClick={() => void give()}>{busy ? "Offering…" : to ? `Offer ${bot.name} to ${to.name}` : "Pick someone"}</Button>
      </div>
    </Dialog>
  );
}

/** At the top of the list: a Bot someone wants to give you. */
export function TransferOffers({ onError }: { onError?: (message: string) => void }) {
  const myId = useMyId();
  const offers = useLive((s) => s.transfers).filter((transfer) => transfer.toId === myId);
  return (
    <AnimatePresence initial={false}>
      {offers.map((offer) => <Offer key={offer.id} offer={offer} onError={onError} />)}
    </AnimatePresence>
  );
}

function Offer({ offer, onError }: { offer: BotTransfer; onError?: (message: string) => void }) {
  const from = useLive((s) => s.people.find((person) => person.id === offer.fromId));
  const [busy, setBusy] = useState(false);
  const answer = (action: Promise<unknown>) => {
    setBusy(true);
    void action.catch((failure) => { onError?.(failed(failure, "Couldn't answer that.")); setBusy(false); });
  };
  return (
    <m.div layout variants={rise} initial="hidden" animate="shown" exit={{ opacity: 0, height: 0, marginBottom: 0 }} transition={soft}
      className="mb-2 flex flex-col gap-3 overflow-hidden rounded-2xl border border-mint/25 bg-mint/8 p-4">
      <span className="flex items-center gap-3">
        <Face seed={offer.bot.faceSeed} size={40} title={offer.bot.name} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-[15px]">{from?.name ?? "Someone"} wants to give you {offer.bot.name}</strong>
          <span className="text-meta text-soft">
            {offer.bot.title ? `${offer.bot.title}. ` : ""}{offer.keepMemory ? `${offer.bot.name} keeps what it remembers` : `${offer.bot.name} starts fresh`}, and its routines come too.
          </span>
        </span>
      </span>
      <span className="flex gap-2">
        <Button variant="primary" size="pill" disabled={busy} onClick={() => answer(api.acceptTransfer(offer.id))}>Accept</Button>
        <Button variant="outline" size="pill" disabled={busy} onClick={() => answer(api.declineTransfer(offer.id))}>Decline</Button>
      </span>
    </m.div>
  );
}
