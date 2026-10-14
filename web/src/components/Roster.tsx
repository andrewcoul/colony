import { useMemo, useState } from "react";
import { Plus, Search, Users } from "lucide-react";
import type { Bot, Chat, Presence } from "@shared/types";
import { shortTime } from "../lib/dates";
import { useLive } from "../lib/live";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { LogoMark } from "./Logo";
import { NotificationsMenu } from "./NotificationsMenu";
import { Button } from "./ui/button";

const LABEL: Partial<Record<Presence, { text: string; className: string }>> = {
  thinking: { text: "thinking", className: "text-mint" },
  working: { text: "working", className: "text-mint" },
  waiting: { text: "needs you", className: "text-lemon" },
  blocked: { text: "blocked", className: "text-coral" },
};

export function Roster({ activeChatId, onOpen, onNewBot, onNewGroup, phone }: {
  activeChatId: string | null;
  onOpen: (chatId: string) => void;
  onNewBot: () => void;
  onNewGroup: () => void;
  phone: boolean;
}) {
  const botMap = useLive((s) => s.bots);
  const chatMap = useLive((s) => s.chats);
  const [query, setQuery] = useState("");

  const { bots, groups, needsYou } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const match = (text: string) => !needle || text.toLowerCase().includes(needle);
    const recency = (bot: Bot) => chatMap[bot.chatId]?.updatedAt ?? bot.createdAt;
    const all = Object.values(botMap).sort((a, b) => recency(b) - recency(a));
    return {
      bots: all.filter((bot) => match(bot.name) || match(bot.title)),
      needsYou: all.filter((bot) => bot.presence === "waiting" || bot.presence === "blocked"),
      groups: Object.values(chatMap).filter((chat) => chat.kind === "group" && match(chat.title)).sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }, [botMap, chatMap, query]);

  return (
    <aside aria-label="Bots" className={cn("flex h-full flex-col bg-surface", phone ? "w-full" : "w-[290px] shrink-0 border-r border-rule")}>
      {phone ? (
        <div className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-4">
          <h1 className="m-0 text-[30px] font-semibold tracking-tight">Bots</h1>
          <div className="flex gap-2.5">
            <NotificationsMenu className="size-10 bg-raised" />
            <Button variant="outline" size="icon" className="size-10 bg-raised" aria-label="New group" onClick={onNewGroup}><Users size={18} /></Button>
            <Button variant="primary" size="icon" className="size-10" aria-label="New Bot" onClick={onNewBot}><Plus size={19} strokeWidth={2.4} /></Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3.5 pt-4 pb-3.5">
          <span className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"><LogoMark />Colony</span>
          <div className="flex items-center gap-2">
            <NotificationsMenu className="border-transparent" />
            <Button variant="primary" size="pill" onClick={onNewBot}><Plus size={14} strokeWidth={2.4} />New Bot</Button>
          </div>
        </div>
      )}

      <div className="px-2.5">
        <label className="flex h-[38px] items-center gap-2.5 rounded-lg border border-rule px-2.5 text-muted focus-within:border-muted">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search Bots and groups"
            className="min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-muted" />
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-3.5 pb-3 [scrollbar-width:thin]">
        {phone && needsYou.length > 0 && !query && (
          <section className="mb-4">
            <h2 className="m-0 px-2.5 pb-2 text-label font-normal text-muted">Needs you · {needsYou.length}</h2>
            <div className="flex gap-2.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
              {needsYou.map((bot) => (
                <button key={bot.id} type="button" onClick={() => onOpen(bot.chatId)}
                  className={cn("flex w-40 shrink-0 flex-col items-start gap-2 rounded-2xl border p-3 text-left",
                    bot.presence === "waiting" ? "border-lemon/30 bg-lemon/8" : "border-coral/30 bg-coral/8")}>
                  <Face seed={bot.faceSeed} state={bot.presence} size={34} title={bot.name} />
                  <strong className="text-sm">{bot.name}</strong>
                  <span className="line-clamp-2 text-meta leading-snug text-soft">{bot.activity || (bot.presence === "waiting" ? "Waiting for you" : "Needs help")}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <h2 className="m-0 px-2.5 pb-1.5 text-meta font-normal text-muted">Bots</h2>
        {bots.length === 0 && (
          <p className="px-2.5 py-6 text-label leading-relaxed text-muted">
            {query ? "No Bots match." : "No Bots yet. Create your first teammate and give it something to do."}
          </p>
        )}
        {bots.map((bot) => (
          <BotRow key={bot.id} bot={bot} chat={chatMap[bot.chatId]} active={bot.chatId === activeChatId} onOpen={onOpen} />
        ))}

        <div className="flex items-center justify-between px-2.5 pt-4 pb-1.5">
          <h2 className="m-0 text-meta font-normal text-muted">Groups</h2>
          {!phone && <button type="button" onClick={onNewGroup} className="text-meta text-muted hover:text-ink">+ New group</button>}
        </div>
        {groups.length === 0 && !query && <p className="px-2.5 pb-2 text-meta text-muted">Put Bots in a group to work together.</p>}
        {groups.map((chat) => (
          <GroupRow key={chat.id} chat={chat} bots={chat.memberIds.map((id) => botMap[id]).filter(Boolean)} active={chat.id === activeChatId} onOpen={onOpen} />
        ))}
      </nav>
    </aside>
  );
}

function RowShell({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined}
      className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-hover", active && "bg-raised hover:bg-raised")}>
      {children}
    </button>
  );
}

function BotRow({ bot, chat, active, onOpen }: { bot: Bot; chat: Chat | undefined; active: boolean; onOpen: (chatId: string) => void }) {
  const label = LABEL[bot.presence];
  const unread = (chat?.unread ?? 0) > 0 && !active;
  return (
    <RowShell active={active} onClick={() => onOpen(bot.chatId)}>
      <Face seed={bot.faceSeed} state={bot.presence} size={40} title={bot.name} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <strong className="truncate text-sm">{bot.name}</strong>
          {label
            ? <span className={cn("shrink-0 text-meta", label.className)}>{label.text}</span>
            : chat?.lastPreview && <span className="shrink-0 text-meta text-muted">{shortTime(chat.updatedAt)}</span>}
        </span>
        <span className={cn("flex items-center gap-2 text-label", unread || label ? "text-soft" : "text-muted")}>
          <span className="truncate">{(label && bot.activity) || chat?.lastPreview || bot.title || "New teammate"}</span>
          {unread && <span className="ml-auto size-2 shrink-0 rounded-full bg-ink" aria-label="Unread" />}
        </span>
      </span>
    </RowShell>
  );
}

function GroupRow({ chat, bots, active, onOpen }: { chat: Chat; bots: Bot[]; active: boolean; onOpen: (chatId: string) => void }) {
  return (
    <RowShell active={active} onClick={() => onOpen(chat.id)}>
      <GroupFaces bots={bots} size={26} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <strong className="truncate text-sm">{chat.title}</strong>
          <span className="shrink-0 text-meta text-muted">{shortTime(chat.updatedAt)}</span>
        </span>
        <span className="truncate text-label text-muted">{chat.lastPreview ?? `${bots.map((bot) => bot.name).join(", ")}`}</span>
      </span>
    </RowShell>
  );
}

/** Two overlapping faces for a group avatar. */
export function GroupFaces({ bots, size }: { bots: Bot[]; size: number }) {
  const [first, second] = bots;
  return (
    <span className="relative inline-block shrink-0" style={{ width: size * 1.55, height: size * 1.55 }}>
      {first && <Face seed={first.faceSeed} state={first.presence} size={size} className="absolute top-0 left-0" />}
      {second && <Face seed={second.faceSeed} state={second.presence} size={size} className="absolute right-0 bottom-0" />}
    </span>
  );
}
