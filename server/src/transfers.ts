import { clearMemory } from "./files.js";
import type { Integrations } from "./integrations/index.js";
import { canSee } from "./people.js";
import { defaultModel, resolveModel } from "./settings.js";
import type { BotTransfer } from "./shared/types.js";
import type { Store } from "./store.js";

/**
 * Hands a Bot to the person it was offered to, once they accept. What moves: the Bot (persona,
 * skills, routines, its computer and workspace) and its memory unless "Start fresh" was chosen.
 * What stays with the giver: their chat with it (archived on their side), its access to their
 * accounts (removed) and their own model key (it switches to the recipient's default).
 */
export function handOver(store: Store, transfer: BotTransfer, { integrations, stopBot }: { integrations?: Integrations; stopBot?: (botId: string) => void } = {}) {
  const bot = store.getBot(transfer.botId);
  const recipient = store.getPerson(transfer.toId);
  if (!bot || !recipient) throw new Error("That Bot or person is gone.");
  stopBot?.(bot.id);
  // Accepted first, so the giver still sees the Bot's name in their old chat once it moves.
  const accepted = store.setTransferStatus(transfer.id, "accepted");
  store.moveBot(bot.id, recipient.id, `Chat with ${bot.name} (now ${recipient.name}'s)`);

  // Topics it was in stay, now with the recipient's Bot; one the recipient can't see, it leaves.
  for (const chat of store.listChats()) {
    if (chat.kind !== "topic" || !chat.memberIds.includes(bot.id) || canSee(recipient, chat)) continue;
    const memberIds = chat.memberIds.filter((id) => id !== bot.id);
    store.updateTopic(chat.id, { memberIds, coordinatorId: chat.coordinatorId === bot.id ? memberIds[0] ?? null : chat.coordinatorId });
  }
  // The giver's accounts aren't the recipient's to use.
  const accounts = integrations?.accounts;
  for (const grant of accounts?.listAccess().filter((item) => item.botId === bot.id) ?? []) {
    if (accounts!.get(grant.accountId)?.personId !== recipient.id) accounts!.setAccess(bot.id, grant.accountId, { mail: "none", calendar: "none", vault: "none" });
  }
  // A model on the giver's own key goes back to the recipient's default.
  if (!resolveModel(bot.model, { ownerId: recipient.id, fallback: false })) store.updateBot(bot.id, { model: defaultModel(recipient.id) });
  if (!transfer.keepMemory) clearMemory(bot.id);
  return accepted;
}
