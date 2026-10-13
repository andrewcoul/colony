import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Plus, WifiOff, X } from "lucide-react";
import { useLive } from "./lib/live";
import { ChatScreen } from "./components/ChatScreen";
import { CreateBotDialog, NewGroupDialog } from "./components/Dialogs";
import { LogoMark } from "./components/Logo";
import { Roster } from "./components/Roster";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";

const phoneQuery = matchMedia("(max-width: 767px)");
const usePhone = () => useSyncExternalStore(
  (listener) => { phoneQuery.addEventListener("change", listener); return () => phoneQuery.removeEventListener("change", listener); },
  () => phoneQuery.matches,
);

/** The open chat lives in the URL hash so the phone's back gesture works. */
function useOpenChat() {
  const read = () => /^#\/chat\/([\w-]+)$/.exec(location.hash)?.[1] ?? null;
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
  const [error, setError] = useState("");
  const chat = chatId ? chats[chatId] : undefined;

  useEffect(() => {
    if (ready && chatId && !chat) openChat(null); // Deleted or unknown chat.
  }, [ready, chatId, chat, openChat]);

  if (!ready) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <LogoMark size={40} strokeWidth={1.6} />
        <p className="m-0 text-label text-muted">{loadError ? `${loadError} Retrying…` : "Connecting to Colony…"}</p>
      </main>
    );
  }

  const roster = (
    <Roster activeChatId={chat?.id ?? null} onOpen={openChat} onNewBot={() => setCreating(true)} onNewGroup={() => setGrouping(true)} phone={phone} />
  );

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-dvh overflow-hidden">
        {phone ? (chat ? null : roster) : roster}
        {chat ? (
          <ChatScreen key={chat.id} chat={chat} phone={phone} onBack={() => openChat(null)} onError={setError} />
        ) : !phone && (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <LogoMark size={44} strokeWidth={1.6} />
            <h1 className="m-0 text-2xl font-semibold tracking-tight">Your colony</h1>
            <p className="m-0 max-w-sm text-label leading-relaxed text-muted">Bots are teammates that remember, work on their own computers, and ask before anything leaves your PC.</p>
            <Button variant="primary" size="pill" className="px-4" onClick={() => setCreating(true)}><Plus size={14} />New Bot</Button>
          </section>
        )}
      </div>

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
      <NewGroupDialog open={grouping} onOpenChange={setGrouping} onCreated={openChat} />
    </TooltipProvider>
  );
}
