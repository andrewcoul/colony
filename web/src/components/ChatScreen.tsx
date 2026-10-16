import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Archive, ArchiveRestore, ArrowDown, CalendarClock, ChevronLeft, FileText, IdCard, Lock, Monitor, MoreHorizontal, Pencil, Phone, RotateCcw, Shrink, Square, Trash2 } from "lucide-react";
import type { Bot, Chat } from "@shared/types";
import { api } from "../lib/api";
import { loadArtifact, loadMessages, loadOlder, useLive } from "../lib/live";
import { startCall, useCall } from "../lib/call";
import { CallBar } from "./CallView";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { Composer, type ComposerHandle, type SendMode } from "./Composer";
import { TopicPanel, type TopicTab } from "./TopicPanel";
import { TopicDialog } from "./Dialogs";
import { TopicTile } from "./TopicIcon";
import { BotProfile } from "./BotProfile";
import { ComputerPanel, type ComputerTab } from "./ComputerPanel";
import { Face } from "./Face";
import { GroupFaces } from "./Roster";
import { RoutinesPanel } from "./RoutinesPanel";
import { PanelDock } from "./SidePanel";
import { MessageItem } from "./Transcript";
import { Button } from "./ui/button";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";
import { fade, rise, sent, snappy } from "../lib/motion";
import { cn } from "../lib/utils";

const EMPTY: never[] = [];

export function ChatScreen({ chat, phone, onBack, onOpenChat, onError, onExpandCall }: {
  chat: Chat;
  phone: boolean;
  onBack: () => void;
  onOpenChat: (chatId: string) => void;
  onError: (message: string) => void;
  /** Phone: back to the full-screen call. */
  onExpandCall?: () => void;
}) {
  const call = useCall();
  const mine = "user";
  const persistent = useLive((s) => s.persistent);
  const botMap = useLive((s) => s.bots);
  const messages = useLive((s) => s.messages[chat.id]) ?? EMPTY;
  const loaded = useLive((s) => chat.id in s.messages);
  const [hasOlder, setHasOlder] = useState(true);
  // "#/chat/<id>/browser" (from a takeover card or notification) opens straight to the browser.
  const [panel, setPanel] = useState<"computer" | "routines" | "profile" | null>(() => (location.hash.endsWith("/browser") ? "computer" : null));
  const [computerTab, setComputerTab] = useState<ComputerTab>(() => (location.hash.endsWith("/browser") ? "browser" : "screen"));
  const togglePanel = (name: "computer" | "routines") => setPanel((current) => (current === name ? null : name));
  const members = useMemo(() => chat.memberIds.map((id) => botMap[id]).filter(Boolean) as Bot[], [chat.memberIds, botMap]);
  const bot = chat.kind === "bot" ? members[0] : undefined;
  const topic = chat.kind === "topic";
  // Who your messages go to: the Bot of its own chat, or a topic's lead.
  const answerer = bot ?? (topic ? members.find((member) => member.id === chat.coordinatorId) ?? members[0] : undefined);
  const solo = bot ?? (topic && members.length === 1 ? members[0] : undefined) ?? answerer;
  const folder = useLive((s) => (chat.folderId ? s.folders[chat.folderId] : undefined));
  const [editing, setEditing] = useState(false);
  // A topic's side panel: its Doc, Files and Schedule.
  const [topicTab, setTopicTab] = useState<TopicTab | null>(null);
  const artifact = useLive((s) => s.artifacts[chat.id]);
  useEffect(() => { if (topic && artifact === undefined) void loadArtifact(chat.id).catch(() => {}); }, [topic, chat.id, artifact]);
  const composer = useRef<ComposerHandle>(null);
  const routineCount = useLive((s) => (bot ? Object.values(s.routines).filter((routine) => routine.botId === bot.id && routine.enabled).length : 0));
  const busy = messages.some((message) => message.status === "streaming");
  const openBrowser = (botId: string) => {
    if (bot?.id === botId) { setComputerTab("browser"); setPanel("computer"); }
    else if (botMap[botId]) onOpenChat(`${botMap[botId].chatId}/browser`);
  };
  const last = messages.at(-1);
  // Messages already here when the chat loaded stay still; anything newer animates in.
  // ("Load earlier" adds older messages, which are before the line and so don't animate.)
  const settled = useRef<number | null>(null);
  if (loaded && settled.current === null) settled.current = messages.at(-1)?.createdAt ?? 0;
  const fresh = (createdAt: number) => settled.current !== null && createdAt > settled.current;
  const { ref, onScroll, atBottom, scrollToBottom, unpin } = useStickToBottom(`${messages.length}:${last?.text.length}:${last?.steps.length}:${last?.cards.length}`);

  useEffect(() => {
    if (!loaded) void loadMessages(chat.id).catch(() => onError("Couldn't load this chat."));
  }, [chat.id, loaded, onError]);
  useEffect(() => {
    if (chat.unread > 0 && document.visibilityState === "visible") void api.markRead(chat.id).catch(() => {});
  }, [chat.id, chat.unread]);

  async function send(text: string, mode: SendMode, attachments: string[] = []) {
    try { await api.send(chat.id, text, mode, attachments); }
    catch (failure) { onError(failure instanceof Error ? failure.message : "Couldn't send that."); throw failure; }
  }

  const thread = chat.kind === "thread";
  const title = thread ? members.map((member) => member.name).join(" & ") || chat.title : chat.title;
  const subtitle = bot
    ? [bot.title, bot.activity && bot.presence !== "idle" && bot.presence !== "done" ? bot.activity : null].filter(Boolean).join(" · ")
    : thread ? "Private thread between Bots"
    : [chat.archivedAt ? "Archived" : null, folder?.title, members.length ? `with ${members.map((member) => member.name).join(", ")}` : "No Bots yet"].filter(Boolean).join(" · ");

  return (
    <div className="flex min-w-0 flex-1">
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-rule px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 sm:px-5">
        {phone && <Button size="icon" aria-label="Back" className="-ml-2 text-ink" onClick={onBack}><ChevronLeft size={22} /></Button>}
        {bot ? (
          // Tapping the Bot opens its profile: persona, memory, skills.
          <button type="button" onClick={() => setPanel(panel === "profile" ? null : "profile")} aria-label={`${bot.name}'s profile`}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left">
            <Face seed={bot.faceSeed} state={bot.presence} size={36} title={bot.name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="truncate text-[15px]">{title}</strong>
              <span className="truncate text-meta text-muted">{subtitle || "Teammate"}</span>
            </span>
          </button>
        ) : (
          <>
            {topic ? <TopicTile icon={chat.icon} size={32} active /> : <GroupFaces bots={members} size={22} />}
            <div className="flex min-w-0 flex-1 flex-col">
              <strong className="flex min-w-0 items-center gap-2 text-[15px]">
                <span className="truncate">{title}</span>
              </strong>
              <span className="truncate text-meta text-muted">{subtitle || "Teammate"}</span>
            </div>
          </>
        )}
        {topic && (
          <Button
            variant="ghost" size="pill" aria-pressed={topicTab === "doc"} aria-label={`${chat.title} doc`}
            onClick={() => setTopicTab((current) => (current ? null : "doc"))}
            className={cn(artifact ? "bg-peach/12 text-peach hover:bg-peach/18 hover:text-peach" : "text-muted", topicTab && "ring-1 ring-peach/40")}
          >
            <FileText size={15} /><span className="max-sm:hidden">Doc</span>{artifact && <span className="tabular-nums">· v{artifact.version}</span>}
          </Button>
        )}
        {bot && (
          <Button
            variant="ghost" size="pill" aria-pressed={panel === "routines"} aria-label={`${bot.name}'s routines`}
            onClick={() => togglePanel("routines")}
            className={cn(routineCount ? "text-sky hover:text-sky" : "text-muted", panel === "routines" && "ring-1 ring-sky/40")}
          >
            <CalendarClock size={15} /><span className="max-sm:hidden">Routines</span>{routineCount > 0 && <span className="tabular-nums">{routineCount}</span>}
          </Button>
        )}
        {bot?.computer && (
          <Button
            variant="ghost" size="pill" aria-pressed={panel === "computer"} aria-label={`${bot.name}'s computer`}
            onClick={() => togglePanel("computer")}
            className={cn(bot.computerState === "on" ? "bg-lilac/14 text-lilac hover:bg-lilac/20 hover:text-lilac" : "text-muted", panel === "computer" && "ring-1 ring-lilac/40")}
          >
            <Monitor size={15} /><span className="max-sm:hidden">Computer</span>
          </Button>
        )}
        {chat.kind !== "thread" && members.length > 0 && !chat.archivedAt && call?.chatId !== chat.id && (
          <Button size="icon" aria-label={`Call ${solo?.name ?? "your Bot"}`} onClick={() => startCall(chat.id)}><Phone size={17} /></Button>
        )}
        <MenuRoot>
          <MenuTrigger><Button size="icon" aria-label="Chat options"><MoreHorizontal size={18} /></Button></MenuTrigger>
          <MenuContent>
            {bot && <MenuItem onClick={() => setPanel("profile")}><IdCard size={15} />Profile, memory & skills</MenuItem>}
            {topic && <MenuItem onClick={() => setEditing(true)}><Pencil size={15} />Edit topic</MenuItem>}
            {/* Persistent conversations: the Bot's context here, summarised now or started over. */}
            {persistent && !thread && answerer && <>
              <MenuItem onClick={() => void api.compact(chat.id).catch((failure) => onError(failure instanceof Error ? failure.message : "Couldn't compact."))}>
                <Shrink size={15} />Compact {answerer.name}'s conversation
              </MenuItem>
              <MenuItem disabled={busy} onClick={() => { if (confirm(`${answerer.name} starts fresh here: it won't see this conversation any more. Its memory and skills stay, and the chat stays as it is.`)) void api.startFresh(chat.id).catch((failure) => onError(failure instanceof Error ? failure.message : "Couldn't start fresh.")); }}>
                <RotateCcw size={15} />Start {answerer.name} fresh here
              </MenuItem>
            </>}
            {topic && (
              <MenuItem onClick={() => void api.updateTopic(chat.id, { archived: !chat.archivedAt }).catch(() => onError("Couldn't change that."))}>
                {chat.archivedAt ? <><ArchiveRestore size={15} />Move out of the archive</> : <><Archive size={15} />Archive</>}
              </MenuItem>
            )}
            {bot ? (
              <MenuItem className="text-danger" onClick={() => { if (confirm(`Delete ${bot.name}? Its memory, skills and workspace are removed.`)) void api.deleteBot(bot.id).then(onBack); }}>
                <Trash2 size={15} />Delete {bot.name}
              </MenuItem>
            ) : (
              <MenuItem className="text-danger" onClick={() => { if (confirm(thread ? `Delete the thread between ${title}?` : `Delete the topic "${chat.title}" and its messages?`)) void api.deleteChat(chat.id).then(onBack); }}>
                <Trash2 size={15} />{thread ? "Delete thread" : "Delete topic"}
              </MenuItem>
            )}
          </MenuContent>
        </MenuRoot>
      </header>
      <AnimatePresence initial={false}>
        {call?.chatId === chat.id && <CallBar key="call" call={call} here onExpand={phone ? onExpandCall : undefined} onOpenChat={onOpenChat} />}
      </AnimatePresence>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]"
          // Files dropped anywhere on the conversation are attached to your next message.
          onDragOver={(event) => { if (!thread && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDrop={(event) => { if (thread || !event.dataTransfer.files.length) return; event.preventDefault(); composer.current?.attach(event.dataTransfer.files); }}>
          <div className="mx-auto flex max-w-[780px] flex-col gap-6 px-4 pt-5 pb-8 sm:px-8">
            {loaded && hasOlder && messages.length >= 50 && (
              <Button variant="outline" size="pill" className="self-center" onClick={() => { unpin(); void loadOlder(chat.id).then(setHasOlder); }}>Load earlier</Button>
            )}
            {!loaded && <p className="py-10 text-center text-label text-muted">Loading…</p>}
            {loaded && messages.length === 0 && (
              <p className="py-10 text-center text-label text-muted">
                {bot ? `Say hello to ${bot.name}.` : thread ? "No messages yet." : solo ? `Tell ${solo.name} what this topic is about.` : "Message the topic, or @mention one Bot."}
              </p>
            )}
            {messages.map((message) => (
              <m.div key={message.id} variants={message.author === mine ? sent : rise} initial={fresh(message.createdAt) ? "hidden" : false} animate="shown"
                style={message.author === mine ? { originX: 1, originY: 1 } : undefined}>
                <MessageItem message={message} bot={botMap[message.author]} showAuthor={chat.kind !== "bot"} recipient={solo?.name}
                  onOpenRoutines={bot ? () => setPanel("routines") : topic ? () => setTopicTab("schedule") : undefined} onOpenChat={onOpenChat} onOpenBrowser={openBrowser}
                  onOpenDoc={topic ? () => setTopicTab("doc") : undefined}
                  onAnswer={thread ? undefined : (text, now) => (now ? void send(text, "steer").catch(() => {}) : composer.current?.insert(text))} />
              </m.div>
            ))}
          </div>
        </div>
        <AnimatePresence>
          {!atBottom && (
            <m.div key="jump" className="absolute bottom-3 left-1/2 -translate-x-1/2"
              initial={{ opacity: 0, y: 8, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.9 }} transition={snappy}>
              <Button variant="outline" size="icon" aria-label="Jump to latest" className="bg-ground shadow-pop" onClick={() => scrollToBottom()}>
                <ArrowDown size={17} />
              </Button>
            </m.div>
          )}
        </AnimatePresence>
      </div>

      {thread ? (
        <div className="mx-auto flex w-full max-w-[844px] shrink-0 items-center gap-2.5 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),14px)] text-meta text-muted sm:px-8 sm:pb-5">
          <Lock size={13} className="shrink-0" /><span className="flex-1">Bots talk here when one asks another for help. You can read along; message a Bot directly to join in.</span>
          {busy && <Button variant="outline" size="pill" onClick={() => void api.stop(chat.id)}><Square size={11} fill="currentColor" />Stop</Button>}
        </div>
      ) : (
      <div className="mx-auto w-full max-w-[844px] shrink-0 px-3 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-8 sm:pb-5">
        <Composer
          ref={composer}
          onUpload={(file) => api.uploadFile(chat.id, file)}
          placeholder={solo ? (busy ? `Steer ${solo.name}…` : topic ? `Message ${solo.name} about ${chat.title}` : `Message ${solo.name}`) : "Message the topic"}
          hint={busy
            ? (phone ? "Sends now · hold Send to wait until it's done" : `${solo?.name ?? "A Bot"} is working · Enter steers now · Alt+Enter waits until ${solo ? `${solo.name} is` : "it's"} done`)
            : topic && members.length > 1 ? "@Name to ask one Bot" : undefined}
          busy={busy}
          onSend={send}
          onStop={() => void api.stop(chat.id)}
        />
      </div>
      )}
    </section>
    {topic && <TopicDialog open={editing} onOpenChange={setEditing} topic={chat} onSaved={() => {}} />}
    <AnimatePresence initial={false}>
      {topic && topicTab && (
        <PanelDock key="topic-dock" phone={phone}>
          <TopicPanel chat={chat} bots={members} tab={topicTab} onTab={setTopicTab} phone={phone} onClose={() => setTopicTab(null)} onError={onError} />
        </PanelDock>
      )}
      {bot && panel && (
        <PanelDock key="dock" phone={phone}>
          {/* Switching panels crossfades inside the open dock instead of closing and reopening it. */}
          <AnimatePresence mode="wait" initial={false}>
            <m.div key={panel} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
              {panel === "computer" && <ComputerPanel bot={bot} phone={phone} tab={computerTab} onTab={setComputerTab} onClose={() => setPanel(null)} />}
              {panel === "routines" && <RoutinesPanel bot={bot} phone={phone} onClose={() => setPanel(null)} onError={onError} />}
              {panel === "profile" && <BotProfile bot={bot} phone={phone} onClose={() => setPanel(null)} onError={onError} />}
            </m.div>
          </AnimatePresence>
        </PanelDock>
      )}
    </AnimatePresence>
    </div>
  );
}
