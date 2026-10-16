import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Archive, ChevronDown, Download, KeyRound, MessageSquarePlus, Plus, Search, Settings } from "lucide-react";
import { openUpdates } from "../lib/settings";
import { pending, useUpdates } from "../lib/updates";
import type { Bot, Chat, Folder, Presence } from "@shared/types";
import { api } from "../lib/api";
import { shortTime } from "../lib/dates";
import { useIsHost, useLive, useMyId } from "../lib/live";
import { rise, snappy, soft } from "../lib/motion";
import { cn } from "../lib/utils";
import { Face } from "./Face";
import { LogoMark, type LogoMood } from "./Logo";
import { NotificationsMenu } from "./NotificationsMenu";
import { TopicTile } from "./TopicIcon";
import { MenuContent, MenuRadioGroup, MenuRadioItem, MenuRoot, MenuTrigger } from "./ui/menu";
import { Button } from "./ui/button";

/** The crown lands once per page load; after that the mark just blinks now and then. */
let landed = false;
const brandMood = (): LogoMood => (landed ? "alive" : "landing");

const LABEL: Partial<Record<Presence, { text: string; className: string }>> = {
  thinking: { text: "thinking", className: "text-mint" },
  working: { text: "working", className: "text-mint" },
  waiting: { text: "needs you", className: "text-lemon" },
  blocked: { text: "blocked", className: "text-coral" },
};

/** Small UI choices that should survive a reload, per device. */
function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw === null ? initial : (JSON.parse(raw) as T); } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }, [key, value]);
  return [value, setValue] as const;
}

export function Roster({ activeChatId, onOpen, onNewBot, onNewTopic, onSettings, phone }: {
  activeChatId: string | null;
  onOpen: (chatId: string) => void;
  onNewBot: () => void;
  onNewTopic: () => void;
  onSettings: () => void;
  phone: boolean;
}) {
  const configured = useLive((s) => s.configured);
  // Your Bots are yours; other people's only appear inside topics you share.
  const myId = useMyId();
  const host = useIsHost();
  const myName = useLive((s) => s.me?.name ?? "");
  const botMap = useLive((s) => s.bots);
  const chatMap = useLive((s) => s.chats);
  const folderMap = useLive((s) => s.folders);
  const approvals = useLive((s) => s.approvals);
  const [storedTab, setTab] = useStored<"bots" | "topics">("colony.phoneTab", "bots");
  const tab = storedTab;
  // A Bot waiting on you may be waiting in a topic or a thread, not its own chat.
  const chatFor = (bot: Bot) => Object.values(approvals).find((item) => item.botId === bot.id && item.status === "pending")?.chatId ?? bot.chatId;
  const [query, setQuery] = useState("");
  const [logoMood] = useState(brandMood);
  useEffect(() => { landed = true; }, []);
  const updates = useUpdates();
  const news = pending(updates);

  const { bots, topics, archived, needsYou } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const match = (text: string) => !needle || text.toLowerCase().includes(needle);
    const recency = (bot: Bot) => chatMap[bot.chatId]?.updatedAt ?? bot.createdAt;
    const all = Object.values(botMap).filter((bot) => bot.ownerId === myId).sort((a, b) => recency(b) - recency(a));
    return {
      bots: all.filter((bot) => match(bot.name) || match(bot.title)),
      needsYou: all.filter((bot) => bot.presence === "waiting" || bot.presence === "blocked"),
      topics: Object.values(chatMap).filter((chat) => chat.kind === "topic" && !chat.archivedAt && match(chat.title)).sort((a, b) => b.updatedAt - a.updatedAt),
      archived: Object.values(chatMap).filter((chat) => chat.kind === "topic" && chat.archivedAt && match(chat.title)).sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }, [botMap, chatMap, query, myId]);

  return (
    <aside aria-label="Bots" className={cn("flex h-full flex-col bg-surface", phone ? "w-full" : "w-[290px] shrink-0 border-r border-rule")}>
      {phone ? (
        <div className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-4">
          <h1 className="m-0 text-[30px] font-semibold tracking-tight">{tab === "topics" ? "Topics" : "Bots"}</h1>
          <div className="flex gap-2.5">
            <Button variant="outline" size="icon" className="size-10 bg-raised" aria-label="Settings" onClick={onSettings}><Settings size={18} /></Button>
            <NotificationsMenu className="size-10 bg-raised" />
            <Button variant="primary" size="icon" className="size-10" aria-label={tab === "topics" ? "New topic" : "New Bot"} onClick={tab === "topics" ? onNewTopic : onNewBot}>
              <Plus size={19} strokeWidth={2.4} />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3.5 pt-4 pb-3.5">
          <span className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"><LogoMark size={26} mood={logoMood} />Colony</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="Settings" onClick={onSettings}><Settings size={17} /></Button>
            <NotificationsMenu className="border-transparent" />
            <Button variant="primary" size="pill" onClick={onNewBot}><Plus size={14} strokeWidth={2.4} />New Bot</Button>
          </div>
        </div>
      )}

      {phone && (
        <div className="mx-2.5 mb-3 flex rounded-full border border-rule bg-surface p-1" role="tablist" aria-label="Show">
          {(["bots", "topics"] as const).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}
              className={cn("relative h-[34px] flex-1 rounded-full text-sm", tab === name ? "text-ink" : "text-muted")}>
              {tab === name && <m.span layoutId="roster-tab" className="absolute inset-0 rounded-full bg-raised" transition={snappy} />}
              <span className="relative">{name === "bots" ? "Bots" : "Topics"}</span>
            </button>
          ))}
        </div>
      )}

      <div className="px-2.5">
        <label className="flex h-[38px] items-center gap-2.5 rounded-lg border border-rule px-2.5 text-muted focus-within:border-muted">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search Bots and topics"
            className="min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-muted" />
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-3.5 pb-3 [scrollbar-width:thin]">
        {!configured && host && (
          <button type="button" onClick={onSettings}
            className="mb-4 flex w-full items-center gap-3 rounded-2xl border border-lemon/30 bg-lemon/8 p-3.5 text-left">
            <KeyRound size={18} className="shrink-0 text-lemon" />
            <span className="flex flex-col gap-0.5">
              <strong className="text-sm">Connect a model</strong>
              <span className="text-meta text-soft">Add an API key from any OpenAI-compatible provider so your Bots can think.</span>
            </span>
          </button>
        )}
        {(news.server || news.desktop || news.reload || updates.waitingFor) && !query && (
          <button type="button" onClick={openUpdates}
            className="mb-4 flex w-full items-center gap-3 rounded-2xl border border-rule bg-raised/60 p-3.5 text-left hover:bg-hover">
            <Download size={18} className="shrink-0 text-soft" />
            <span className="flex flex-col gap-0.5">
              <strong className="text-sm">
                {updates.waitingFor ? `Updating to ${updates.waitingFor}…`
                  : news.server ? `Colony ${updates.system?.latest?.version} is out`
                  : news.desktop ? "Desktop app update ready"
                  : `Colony was updated to ${updates.system?.version}`}
              </strong>
              <span className="text-meta text-soft">
                {updates.waitingFor ? "It reloads by itself when it's done."
                  : news.server ? "Update the server from here, in about a minute."
                  : news.desktop ? "Restart the app to finish updating."
                  : "Reload to use the new version."}
              </span>
            </span>
          </button>
        )}
        {phone && tab === "bots" && needsYou.length > 0 && !query && (
          <section className="mb-4">
            <h2 className="m-0 px-2.5 pb-2 text-label font-normal text-muted">Needs you · {needsYou.length}</h2>
            <div className="flex gap-2.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
              <AnimatePresence initial={false}>
              {needsYou.map((bot) => (
                <m.button key={bot.id} type="button" onClick={() => onOpen(chatFor(bot))} layout transition={soft}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                  className={cn("flex w-40 shrink-0 flex-col items-start gap-2 rounded-2xl border p-3 text-left",
                    bot.presence === "waiting" ? "border-lemon/30 bg-lemon/8" : "border-coral/30 bg-coral/8")}>
                  <Face seed={bot.faceSeed} state={bot.presence} size={34} title={bot.name} />
                  <strong className="text-sm">{bot.name}</strong>
                  <span className="line-clamp-2 text-meta leading-snug text-soft">{bot.activity || (bot.presence === "waiting" ? "Waiting for you" : "Needs help")}</span>
                </m.button>
              ))}
              </AnimatePresence>
            </div>
          </section>
        )}

        {(!phone || tab === "bots") && (
          <>
            {bots.length === 0 && !query ? (
              <m.div variants={rise} initial="hidden" animate="shown" className="mb-2 flex flex-col gap-3 rounded-2xl border border-lilac/25 bg-lilac/8 p-4">
                <span className="flex flex-col gap-0.5">
                  <strong className="text-[15px]">{host ? "Make your first Bot" : `Welcome${myName ? `, ${myName}` : ""}`}</strong>
                  <span className="text-meta text-soft">{host ? "A teammate that remembers, works on its own computer, and asks before anything leaves your PC." : "This is your Colony too. Make a Bot of your own: only you see its chat, memory and routines."}</span>
                </span>
                <Button variant="primary" size="pill" className="self-start" onClick={onNewBot}><Plus size={14} strokeWidth={2.4} />Make my first Bot</Button>
              </m.div>
            ) : (
              <h2 className="m-0 px-2.5 pb-1.5 text-meta font-normal text-muted">{host ? "Bots" : "Your Bots"}</h2>
            )}
            {bots.length === 0 && query && <p className="px-2.5 py-6 text-label leading-relaxed text-muted">No Bots match.</p>}
            {bots.map((bot) => (
              <BotRow key={bot.id} bot={bot} chat={chatMap[bot.chatId]} active={bot.chatId === activeChatId} onOpen={() => onOpen(chatFor(bot))} />
            ))}
          </>
        )}

        {(!phone || tab === "topics") && (
          <TopicsSection topics={topics} archived={archived} folders={folderMap} bots={botMap} activeChatId={activeChatId}
            onOpen={onOpen} onNew={onNewTopic} myId={myId} phone={phone} searching={Boolean(query)} />
        )}
      </nav>
    </aside>
  );
}

/** A roster row. Rows glide to their new place when activity reorders the list. */
function RowShell({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <m.button type="button" layout="position" transition={soft} onClick={onClick} aria-current={active ? "page" : undefined}
      className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-hover", active && "bg-raised hover:bg-raised")}>
      {children}
    </m.button>
  );
}

/** Text that crossfades when it changes ("working" → "needs you"), and not on first render. */
function Fading({ id, className, children }: { id: string; className?: string; children: React.ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.span key={id} className={className} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.14 }}>
        {children}
      </m.span>
    </AnimatePresence>
  );
}

function BotRow({ bot, chat, active, onOpen }: { bot: Bot; chat: Chat | undefined; active: boolean; onOpen: () => void }) {
  const label = LABEL[bot.presence];
  const unread = (chat?.unread ?? 0) > 0 && !active;
  return (
    <RowShell active={active} onClick={onOpen}>
      <Face seed={bot.faceSeed} state={bot.presence} size={40} title={bot.name} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <strong className="truncate text-sm">{bot.name}</strong>
          {label
            ? <Fading id={label.text} className={cn("shrink-0 text-meta", label.className)}>{label.text}</Fading>
            : chat?.lastPreview && <Fading id="time" className="shrink-0 text-meta text-muted">{shortTime(chat.updatedAt)}</Fading>}
        </span>
        <span className={cn("flex items-center gap-2 text-label", unread || label ? "text-soft" : "text-muted")}>
          <span className="truncate">{(label && bot.activity) || chat?.lastPreview || bot.title || "New teammate"}</span>
          <AnimatePresence initial={false}>
            {unread && <m.span key="unread" className="ml-auto size-2 shrink-0 rounded-full bg-ink" aria-label="Unread"
              initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={snappy} />}
          </AnimatePresence>
        </span>
      </span>
    </RowShell>
  );
}

/**
 * Topics, filed in folders (or grouped by Bot). Folders fold away and remember it; on desktop a
 * topic can be dragged onto a folder to file it. Archived topics wait at the bottom.
 */
function TopicsSection({ topics, archived, folders, bots, activeChatId, onOpen, onNew, phone, searching, myId }: {
  topics: Chat[];
  archived: Chat[];
  folders: Record<string, Folder>;
  bots: Record<string, Bot>;
  activeChatId: string | null;
  onOpen: (chatId: string) => void;
  onNew: () => void;
  phone: boolean;
  searching: boolean;
  /** Topics other people started (and shared with you) get their own section. */
  myId: string;
}) {
  const [grouping, setGrouping] = useStored<"folder" | "bot">("colony.topicGrouping", "folder");
  const [closed, setClosed] = useStored<string[]>("colony.closedFolders", []);
  const [showArchived, setShowArchived] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const toggle = (id: string) => setClosed((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const sections = useMemo(() => {
    if (grouping === "bot") {
      const byBot = new Map<string, Chat[]>();
      for (const topic of topics) {
        const lead = topic.coordinatorId ?? topic.memberIds[0] ?? "none";
        byBot.set(lead, [...(byBot.get(lead) ?? []), topic]);
      }
      return [...byBot].map(([id, items]) => ({ id: `bot:${id}`, title: bots[id]?.name ?? "No Bot", folderId: undefined, items }))
        .sort((a, b) => a.title.localeCompare(b.title));
    }
    const ordered = Object.values(folders).sort((a, b) => a.position - b.position);
    const mine = topics.filter((topic) => topic.ownerId === myId);
    const shared = topics.filter((topic) => topic.ownerId !== myId);
    const filed = ordered.map((folder) => ({ id: folder.id, title: folder.title, folderId: folder.id as string | null | undefined, items: mine.filter((topic) => topic.folderId === folder.id) }));
    const loose = mine.filter((topic) => !topic.folderId || !folders[topic.folderId]);
    // Empty folders still show (so you can drop topics into them), except while searching.
    return [
      ...(shared.length ? [{ id: "shared", title: "Shared with you", folderId: undefined, items: shared }] : []),
      ...filed.filter((section) => section.items.length || !searching),
      ...(loose.length ? [{ id: "loose", title: ordered.length || shared.length ? "Not in a folder" : "", folderId: null, items: loose }] : []),
    ];
  }, [grouping, topics, folders, bots, searching, myId]);

  const drop = (folderId: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes("text/colony-topic")) return;
      event.preventDefault();
      setDropTarget(folderId ?? "loose");
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (event: React.DragEvent) => {
      const id = event.dataTransfer.getData("text/colony-topic");
      setDropTarget(null);
      if (id) void api.updateTopic(id, { folderId }).catch(() => {});
    },
  });

  return (
    <section className="pt-4">
      <div className="flex items-center justify-between px-2.5 pb-1.5">
        <h2 className={cn("m-0 text-meta font-normal text-muted", phone && "invisible")}>Topics</h2>
        <div className="flex items-center gap-2.5">
          <MenuRoot>
            <MenuTrigger>
              <button type="button" className="flex items-center gap-1 text-meta text-muted hover:text-ink">{grouping === "folder" ? "By folder" : "By Bot"}<ChevronDown size={12} /></button>
            </MenuTrigger>
            <MenuContent>
              <MenuRadioGroup value={grouping} onValueChange={(value) => setGrouping(value as "folder" | "bot")}>
                <MenuRadioItem value="folder">By folder</MenuRadioItem>
                <MenuRadioItem value="bot">By Bot</MenuRadioItem>
              </MenuRadioGroup>
            </MenuContent>
          </MenuRoot>
          {!phone && <button type="button" onClick={onNew} aria-label="New topic" className="text-muted hover:text-ink"><MessageSquarePlus size={15} /></button>}
        </div>
      </div>

      {topics.length === 0 && !searching && (
        <button type="button" onClick={onNew} className="mx-1 mb-2 flex w-[calc(100%-8px)] items-center gap-3 rounded-xl border border-dashed border-rule p-3 text-left text-meta text-muted hover:text-ink">
          <TopicTile icon="sparkles" size={28} />Give an ongoing thing its own conversation: a trip, a renovation, a launch.
        </button>
      )}

      {sections.map((section) => {
        const open = !closed.includes(section.id) || searching;
        const target = section.folderId !== undefined;
        return (
          <div key={section.id} className="flex flex-col">
            {section.title && (
              <button type="button" onClick={() => toggle(section.id)} aria-expanded={open}
                {...(target && !phone ? drop(section.folderId ?? null) : {})}
                className={cn("flex h-8 items-center gap-2 rounded-lg px-2.5 text-left transition-colors",
                  dropTarget === (section.folderId ?? "loose") ? "bg-peach/12 text-ink" : "text-soft hover:text-ink")}>
                <m.span animate={{ rotate: open ? 0 : -90 }} transition={snappy} className="flex"><ChevronDown size={12} className="text-muted" /></m.span>
                <span className="flex-1 truncate text-label font-medium">{section.title}</span>
                <span className="text-meta text-muted tabular-nums">{section.items.length}</span>
              </button>
            )}
            <AnimatePresence initial={false}>
              {open && (
                <m.div key="items" className="overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0, transition: { duration: 0.15 } }} transition={soft}>
                  {section.items.map((topic) => (
                    <TopicRow key={topic.id} topic={topic} bots={topic.memberIds.map((id) => bots[id]).filter(Boolean)} active={topic.id === activeChatId}
                      onOpen={onOpen} draggable={!phone && topic.ownerId === myId} phone={phone} />
                  ))}
                  {section.items.length === 0 && <p className="m-0 px-2.5 pb-1.5 pl-8 text-meta text-muted">{phone ? "Empty" : "Empty · drag a topic here"}</p>}
                </m.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}

      {archived.length > 0 && (
        <div className="mt-2 flex flex-col">
          <button type="button" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}
            className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-meta text-muted hover:text-ink">
            <Archive size={13} />Archived · {archived.length}
          </button>
          <AnimatePresence initial={false}>
            {showArchived && (
              <m.div key="archived" className="overflow-hidden opacity-70" initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={soft}>
                {archived.map((topic) => (
                  <TopicRow key={topic.id} topic={topic} bots={topic.memberIds.map((id) => bots[id]).filter(Boolean)} active={topic.id === activeChatId} onOpen={onOpen} phone={phone} />
                ))}
              </m.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

function TopicRow({ topic, bots, active, onOpen, draggable, phone }: { topic: Chat; bots: Bot[]; active: boolean; onOpen: (chatId: string) => void; draggable?: boolean; phone: boolean }) {
  const unread = topic.unread > 0 && !active;
  // No presence label here: a Bot's presence is about the Bot, not this topic (its face still shows it).
  const label = null as { text: string; className: string } | null;
  if (phone) {
    return (
      <RowShell active={active} onClick={() => onOpen(topic.id)}>
        <TopicTile icon={topic.icon} size={40} active={active} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <strong className={cn("truncate text-[15px]", unread ? "font-semibold" : "font-medium")}>{topic.title}</strong>
            {label ? <Fading id={label.text} className={cn("shrink-0 text-meta", label.className)}>{label.text}</Fading>
              : <span className="shrink-0 text-meta text-muted">{shortTime(topic.updatedAt)}</span>}
          </span>
          <span className={cn("truncate text-label", unread ? "text-soft" : "text-muted")}>
            {topic.lastPreview ? `${bots.find((bot) => bot.id === topic.lastAuthor)?.name ?? "You"}: ${topic.lastPreview}` : bots.map((bot) => bot.name).join(", ")}
          </span>
        </span>
      </RowShell>
    );
  }
  return (
    // Motion moves the row; the plain button inside does the native drag-and-drop onto folders.
    <m.div layout="position" transition={soft}>
    <button type="button" onClick={() => onOpen(topic.id)} aria-current={active ? "page" : undefined}
      draggable={draggable} onDragStart={(event) => { event.dataTransfer.setData("text/colony-topic", topic.id); event.dataTransfer.effectAllowed = "move"; }}
      className={cn("flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left hover:bg-hover", active && "bg-raised hover:bg-raised")}>
      <TopicTile icon={topic.icon} size={24} active={active} />
      <span className={cn("min-w-0 flex-1 truncate text-sm", unread || active ? "font-semibold text-ink" : "text-soft")}>{topic.title}</span>
      {label && <Fading id={label.text} className={cn("shrink-0 text-meta", label.className)}>{label.text}</Fading>}
      <span className="flex shrink-0 items-center">
        {bots.slice(0, 3).map((bot, index) => (
          <Face key={bot.id} seed={bot.faceSeed} state={bot.presence} size={18} title={bot.name} className={cn(index > 0 && "-ml-1.5")} />
        ))}
      </span>
      {unread && <span className="size-1.5 shrink-0 rounded-full bg-ink" aria-label="Unread" />}
    </button>
    </m.div>
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
