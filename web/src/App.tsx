import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AnimatePresence } from "motion/react";
import { Plus, WifiOff, X } from "lucide-react";
import { setFocusedChat, useLive, type RingingCall } from "./lib/live";
import { useCall } from "./lib/call";
import { CallBar, CallScreen, IncomingCall } from "./components/CallView";
import { onOpenSettings, onOpenUpdates } from "./lib/settings";
import { startUpdates } from "./lib/updates";
import { ChatScreen } from "./components/ChatScreen";
import { CreateBotDialog, TopicDialog } from "./components/Dialogs";
import { LogoMark } from "./components/Logo";
import { Roster } from "./components/Roster";
import { SettingsDialog } from "./components/SettingsDialog";
import { UpdatesDialog } from "./components/UpdatesDialog";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";

const phoneQuery = matchMedia("(max-width: 767px)");
const usePhone = () => useSyncExternalStore(
  (listener) => { phoneQuery.addEventListener("change", listener); return () => phoneQuery.removeEventListener("change", listener); },
  () => phoneQuery.matches,
);

/** "#/chat/<id>?call=<call id>": opened from a Bot's ringing notification. */
const ringFromLink = (): RingingCall | null => {
  const match = /^#\/chat\/([\w-]+)\?call=([\w-]+)$/.exec(location.hash);
  return match ? { chatId: match[1], callId: match[2], botId: "", reason: "" } : null;
};

/** The open chat lives in the URL hash so the phone's back gesture works. */
function useOpenChat() {
  const read = () => /^#\/chat\/([\w-]+)(\/browser|\?call=[\w-]+)?$/.exec(location.hash)?.[1] ?? null;
  const [chatId, setChatId] = useState(read);
  useEffect(() => {
    const onHash = () => setChatId(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const open = useCallback((id: string | null) => {
    if (id) location.hash = `#/chat/${id}`;
    else if (location.hash) history.length > 1 ? history.back() : (location.hash = "");
  }, []);
  return [chatId, open] as const;
}

export default function App() {
  const ready = useLive((s) => s.ready);
  const connected = useLive((s) => s.connected);
  // Only show "Reconnecting" for a real outage, not the first connect or a brief blip.
  const [showOffline, setShowOffline] = useState(false);
  useEffect(() => {
    if (connected) { setShowOffline(false); return; }
    const timer = setTimeout(() => setShowOffline(true), 2500);
    return () => clearTimeout(timer);
  }, [connected]);
  const loadError = useLive((s) => s.error);
  const chats = useLive((s) => s.chats);
  const phone = usePhone();
  const [chatId, openChat] = useOpenChat();
  const [creating, setCreating] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => onOpenSettings(() => setSettingsOpen(true)), []);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  useEffect(() => { startUpdates(); return onOpenUpdates(() => setUpdatesOpen(true)); }, []);
  const [error, setError] = useState("");
  const chat = chatId ? chats[chatId] : undefined;
  const call = useCall();
  // Phone: the call fills the screen until you go to the chat.
  const [callExpanded, setCallExpanded] = useState(true);
  useEffect(() => { if (call?.chatId) setCallExpanded(true); }, [call?.chatId]);
  const ringing = useLive((s) => s.ringing);
  const bots = useLive((s) => s.bots);
  // Opened from the notification: the Bot's still ringing until you answer here.
  const [linked, setLinked] = useState(ringFromLink);
  useEffect(() => {
    if (!linked) return;
    history.replaceState(null, "", `#/chat/${linked.chatId}`);
  }, [linked]);
  const dismissLinked = useCallback(() => setLinked(null), []);
  const linkedRing = linked && chats[linked.chatId]
    ? { ...linked, botId: ringing[linked.callId]?.botId ?? chats[linked.chatId].coordinatorId ?? chats[linked.chatId].memberIds[0] ?? "", reason: ringing[linked.callId]?.reason ?? "" }
    : null;
  const ring = call ? null : (Object.values(ringing).find((item) => bots[item.botId]) ?? linkedRing);

  useEffect(() => {
    if (ready && chatId && !chat) openChat(null); // Deleted or unknown chat.
  }, [ready, chatId, chat, openChat]);
  // Tell the server what's on screen so it doesn't notify about it.
  useEffect(() => { setFocusedChat(chat?.id ?? null); }, [chat?.id]);

  if (!ready) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <LogoMark size={48} mood="connecting" />
        <p className="m-0 text-label text-muted">{loadError ? `${loadError} Retrying…` : "Connecting to Colony…"}</p>
      </main>
    );
  }

  const roster = (
    <Roster activeChatId={chat?.id ?? null} onOpen={openChat} onNewBot={() => setCreating(true)} onNewTopic={() => setGrouping(true)} onSettings={() => setSettingsOpen(true)} phone={phone} />
  );

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-dvh overflow-hidden">
        {phone ? (chat ? null : roster) : roster}
        {chat ? (
          <ChatScreen key={chat.id} chat={chat} phone={phone} onBack={() => openChat(null)} onOpenChat={openChat} onError={setError} onExpandCall={() => setCallExpanded(true)} />
        ) : !phone && (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <LogoMark size={56} mood="alive" />
            <h1 className="m-0 text-2xl font-semibold tracking-tight">Your colony</h1>
            <p className="m-0 max-w-sm text-label leading-relaxed text-muted">Bots are teammates that remember, work on their own computers, and ask before anything leaves your PC.</p>
            <Button variant="primary" size="pill" className="px-4" onClick={() => setCreating(true)}><Plus size={14} />New Bot</Button>
          </section>
        )}
      </div>

      <AnimatePresence>
        {phone && call && callExpanded && <CallScreen key="call" call={call} onMinimize={() => { setCallExpanded(false); openChat(call.chatId); }} />}
        {ring && <IncomingCall key={ring.callId} ring={ring} onAnswered={(id) => { setLinked(null); setCallExpanded(true); openChat(id); }} onDeclined={dismissLinked} />}
      </AnimatePresence>
      {/* Elsewhere in the app, the call stays one tap away. */}
      {call && chat?.id !== call.chatId && (!phone || !callExpanded) && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-surface pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[420px] sm:overflow-hidden sm:rounded-2xl sm:border sm:pb-0 sm:shadow-pop">
          <CallBar call={call} here={false} onOpenChat={openChat} />
        </div>
      )}

      {showOffline && (
        <div className="fixed top-[max(env(safe-area-inset-top),8px)] left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-raised px-3.5 py-1.5 text-meta text-soft shadow-pop">
          <WifiOff size={13} />Reconnecting…
        </div>
      )}
      {error && (
        <div role="alert" className="fixed bottom-[max(env(safe-area-inset-bottom),16px)] left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-xl bg-danger-wash py-2 pr-2 pl-3.5 text-label text-danger shadow-pop backdrop-blur">
          <span>{error}</span>
          <Button size="icon-sm" aria-label="Dismiss" onClick={() => setError("")}><X size={14} /></Button>
        </div>
      )}

      <CreateBotDialog open={creating} onOpenChange={setCreating} onCreated={(bot) => openChat(bot.chatId)} />
      <TopicDialog open={grouping} onOpenChange={setGrouping} onSaved={openChat} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UpdatesDialog open={updatesOpen} onOpenChange={setUpdatesOpen} />
    </TooltipProvider>
  );
}
