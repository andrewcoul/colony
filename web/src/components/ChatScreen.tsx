import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ChevronLeft, MoreHorizontal, Trash2 } from "lucide-react";
import type { Bot, Chat } from "@shared/types";
import { api } from "../lib/api";
import { loadMessages, loadOlder, useLive } from "../lib/live";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { Composer } from "./Composer";
import { Face } from "./Face";
import { GroupFaces } from "./Roster";
import { MessageItem } from "./Transcript";
import { Button } from "./ui/button";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";

const EMPTY: never[] = [];

export function ChatScreen({ chat, phone, onBack, onError }: {
  chat: Chat;
  phone: boolean;
  onBack: () => void;
  onError: (message: string) => void;
}) {
  const botMap = useLive((s) => s.bots);
  const messages = useLive((s) => s.messages[chat.id]) ?? EMPTY;
  const loaded = useLive((s) => chat.id in s.messages);
  const [hasOlder, setHasOlder] = useState(true);
  const members = useMemo(() => chat.memberIds.map((id) => botMap[id]).filter(Boolean) as Bot[], [chat.memberIds, botMap]);
  const bot = chat.kind === "bot" ? members[0] : undefined;
  const busy = messages.some((message) => message.status === "streaming");
  const last = messages.at(-1);
  const { ref, onScroll, atBottom, scrollToBottom, unpin } = useStickToBottom(`${messages.length}:${last?.text.length}:${last?.steps.length}:${last?.cards.length}`);

  useEffect(() => {
    if (!loaded) void loadMessages(chat.id).catch(() => onError("Couldn't load this chat."));
  }, [chat.id, loaded, onError]);
  useEffect(() => {
    if (chat.unread > 0 && document.visibilityState === "visible") void api.markRead(chat.id).catch(() => {});
  }, [chat.id, chat.unread]);

  async function send(text: string) {
    try { await api.send(chat.id, text); }
    catch (failure) { onError(failure instanceof Error ? failure.message : "Couldn't send that."); throw failure; }
  }

  const subtitle = bot
    ? [bot.title, bot.activity && bot.presence !== "idle" && bot.presence !== "done" ? bot.activity : null].filter(Boolean).join(" · ")
    : `Group · ${members.map((member) => member.name).join(", ")}`;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-rule px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 sm:px-5">
        {phone && <Button size="icon" aria-label="Back" className="-ml-2 text-ink" onClick={onBack}><ChevronLeft size={22} /></Button>}
        {bot ? <Face seed={bot.faceSeed} state={bot.presence} size={36} title={bot.name} /> : <GroupFaces bots={members} size={22} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-[15px]">{chat.title}</strong>
          <span className="truncate text-meta text-muted">{subtitle || "Teammate"}</span>
        </div>
        <MenuRoot>
          <MenuTrigger><Button size="icon" aria-label="Chat options"><MoreHorizontal size={18} /></Button></MenuTrigger>
          <MenuContent>
            {bot ? (
              <MenuItem className="text-danger" onClick={() => { if (confirm(`Delete ${bot.name}? Its memory, skills and workspace are removed.`)) void api.deleteBot(bot.id).then(onBack); }}>
                <Trash2 size={15} />Delete {bot.name}
              </MenuItem>
            ) : (
              <MenuItem className="text-danger" onClick={() => { if (confirm(`Delete the group "${chat.title}"?`)) void api.deleteChat(chat.id).then(onBack); }}>
                <Trash2 size={15} />Delete group
              </MenuItem>
            )}
          </MenuContent>
        </MenuRoot>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
          <div className="mx-auto flex max-w-[780px] flex-col gap-6 px-4 pt-5 pb-8 sm:px-8">
            {loaded && hasOlder && messages.length >= 50 && (
              <Button variant="outline" size="pill" className="self-center" onClick={() => { unpin(); void loadOlder(chat.id).then(setHasOlder); }}>Load earlier</Button>
            )}
            {!loaded && <p className="py-10 text-center text-label text-muted">Loading…</p>}
            {loaded && messages.length === 0 && (
              <p className="py-10 text-center text-label text-muted">{bot ? `Say hello to ${bot.name}.` : "Message the group, or @mention one Bot."}</p>
            )}
            {messages.map((message) => (
              <MessageItem key={message.id} message={message} bot={botMap[message.author]} showAuthor={chat.kind === "group"} />
            ))}
          </div>
        </div>
        {!atBottom && (
          <Button variant="outline" size="icon" aria-label="Jump to latest" className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-ground shadow-pop" onClick={() => scrollToBottom()}>
            <ArrowDown size={17} />
          </Button>
        )}
      </div>

      <div className="mx-auto w-full max-w-[844px] shrink-0 px-3 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-8 sm:pb-5">
        <Composer
          placeholder={bot ? `Message ${bot.name}` : "Message the group"}
          hint={chat.kind === "group" ? "@Name to ask one Bot" : undefined}
          busy={busy}
          onSend={send}
          onStop={() => void api.stop(chat.id)}
        />
      </div>
    </section>
  );
}
