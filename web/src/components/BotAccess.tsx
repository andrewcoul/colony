import { Monitor, ShieldCheck } from "lucide-react";
import type { Access, Account, Bot, CalendarAccess, MailAccess, PcNode, VaultAccess } from "@shared/types";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { openSettings } from "../lib/settings";
import { cn } from "../lib/utils";
import { AccountIcon } from "./AccountsSettings";

const MAIL: [MailAccess, string][] = [["none", "No mail"], ["read", "Read mail"], ["draft", "Read and draft"], ["send", "Read, draft and send"]];
const CALENDAR: [CalendarAccess, string][] = [["none", "No calendar"], ["read", "Read calendar"], ["write", "Read and change"]];
const VAULT: [VaultAccess, string][] = [["none", "No logins"], ["use", "Sign in to sites"], ["save", "Sign in and save new logins"]];

const SWITCHES: [PcNode["capabilities"][number], string][] = [["browser", "browser"], ["screen", "screen"], ["shell", "terminal"], ["files", "files"]];

const selectClass = "h-9 min-w-0 flex-1 rounded-lg border border-rule bg-ground px-2.5 text-label text-ink outline-none disabled:opacity-50";

/** What this Bot may do with each connected account. Nothing until you choose. */
export function BotAccess({ bot, onError }: { bot: Bot; onError: (message: string) => void }) {
  const accounts = useLive((s) => s.accounts);
  const access = useLive((s) => s.access);
  const nodes = useLive((s) => s.nodes);

  const current = (account: Account): Access =>
    access.find((item) => item.botId === bot.id && item.accountId === account.id) ?? { botId: bot.id, accountId: account.id, mail: "none", calendar: "none", vault: "none" };
  const change = (account: Account, patch: Partial<Pick<Access, "mail" | "calendar" | "vault">>) =>
    void api.setAccess(bot.id, account.id, patch).catch((failure) => onError(failure instanceof Error ? failure.message : "Couldn't change access."));

  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 flex items-center gap-2 text-label font-semibold"><ShieldCheck size={14} className="text-muted" />Access</h3>
      {accounts.length === 0 ? (
        <p className="m-0 text-meta text-muted">
          No accounts connected. <button type="button" onClick={openSettings} className="underline hover:text-ink">Connect Gmail, Outlook or 1Password</button> in Settings, then choose here what {bot.name} may do.
        </p>
      ) : (
        <p className="m-0 text-meta text-muted">Sending, inviting, and using a login for the first time always ask you first.</p>
      )}
      {accounts.map((account) => {
        const level = current(account);
        return (
          <div key={account.id} className="flex flex-col gap-2 rounded-xl border border-rule px-3.5 py-3">
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <AccountIcon kind={account.kind} className="shrink-0 text-muted" />
              <span className="truncate">{account.label} <span className="text-muted">{account.email}</span></span>
            </span>
            {account.kind === "onepassword" ? (
              <>
                <select aria-label={`${bot.name}'s 1Password access`} value={level.vault} className={cn(selectClass, "w-full flex-none")} disabled={!bot.computer && level.vault === "none"}
                  onChange={(e) => change(account, { vault: e.target.value as VaultAccess })}>
                  {VAULT.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                {!bot.computer && <span className="text-meta text-muted">Needs {bot.name}'s own computer, for its browser.</span>}
              </>
            ) : (
              <div className="flex gap-1.5">
                <select aria-label={`${bot.name}'s mail access to ${account.email}`} value={level.mail} className={selectClass}
                  onChange={(e) => change(account, { mail: e.target.value as MailAccess })}>
                  {MAIL.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select aria-label={`${bot.name}'s calendar access to ${account.email}`} value={level.calendar} className={selectClass}
                  onChange={(e) => change(account, { calendar: e.target.value as CalendarAccess })}>
                  {CALENDAR.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
            )}
            {account.status === "needs_reauth" && <span className="text-meta text-coral">Needs reconnecting in Settings.</span>}
          </div>
        );
      })}
      {/* PCs you lend through the desktop app: any of your Bots can use them, within each PC's switches. */}
      {nodes.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-rule px-3.5 py-3">
          <span className="text-meta text-muted">{bot.name} can use these PCs, within what you switched on there. You approve anything that acts on them.</span>
          {nodes.map((node) => {
            const on = SWITCHES.filter(([key]) => node.capabilities.includes(key)).map(([, label]) => label);
            return (
              <span key={node.id} className="flex min-w-0 items-center gap-2 text-sm">
                <Monitor size={14} className="shrink-0 text-muted" />
                <span className="truncate">{node.name}</span>
                <span className="truncate text-meta text-muted">{on.length ? on.join(", ") : "nothing switched on"}</span>
                <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 text-meta", node.online ? "text-mint" : "text-muted")}>
                  <span className={cn("size-1.5 rounded-full", node.online ? "bg-mint" : "bg-muted")} />{node.online ? "Online" : "Offline"}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
