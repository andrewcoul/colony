import { useRef, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex, useConvexAuth, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Download, PanelLeftOpen, SquarePen } from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { ChatView } from "./components/ChatView";
import { Composer, type ReplyOptions } from "./components/Composer";
import { DeleteDialog, RenameDialog } from "./components/ConversationDialogs";
import { Home, type Suggestion } from "./components/Home";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SignInScreen } from "./components/SignInScreen";
import { Button } from "./components/ui/button";
import { Tooltip, TooltipProvider } from "./components/ui/tooltip";
import { useHotkeys } from "./hooks/useHotkeys";
import { usePersistentState } from "./hooks/usePersistentState";
import { useTheme } from "./hooks/useTheme";
import { errorText } from "./lib/errors";
import { exportConversation } from "./lib/exportConversation";
import { searchAvailable } from "./lib/links";
import { SearchWorker } from "./search/SearchWorker";

const isNarrow = () => window.matchMedia("(max-width: 900px)").matches;

export default function App() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const theme = useTheme();
  if (isLoading) return <div className="h-dvh bg-ground" />;
  return (
    <TooltipProvider delay={400}>
      {isAuthenticated ? <Workspace theme={theme} /> : <SignInScreen />}
    </TooltipProvider>
  );
}

function Workspace({ theme }: { theme: ReturnType<typeof useTheme> }) {
  const convex = useConvex();
  const { signOut } = useAuthActions();
  const settings = useQuery(api.settings.status, {});
  const conversations = usePaginatedQuery(api.chat.list, {}, { initialNumItems: 40 });
  const [activeId, setActiveId] = useState<Id<"conversations"> | null>(null);
  const conversation = useQuery(api.chat.get, activeId ? { conversationId: activeId } : "skip");
  const send = useMutation(api.chat.send);
  const regenerate = useMutation(api.chat.regenerate);
  const stop = useMutation(api.chat.stop);
  const rename = useMutation(api.chat.rename);
  const remove = useMutation(api.chat.remove);

  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = usePersistentState("sidebar", !isNarrow());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState<Doc<"conversations"> | null>(null);
  const [deleting, setDeleting] = useState<Doc<"conversations"> | null>(null);
  const [savedOptions, setOptions] = usePersistentState<ReplyOptions>("reply-options", { webSearch: true, think: false, model: "" });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Fall back to the backend default if the remembered model is no longer offered.
  const models = settings?.models ?? [];
  const options = { ...savedOptions, model: models.includes(savedOptions.model) ? savedOptions.model : settings?.model ?? "" };
  const generating = Boolean(conversation?.generating);
  const canGenerate = Boolean(settings?.canGenerate);
  const replyArgs = { webSearch: options.webSearch && searchAvailable, think: options.think, model: options.model || undefined };

  // Bumped on every navigation so a slow send can tell whether the user has moved on.
  const navigation = useRef(0);
  function focusComposer() { requestAnimationFrame(() => composerRef.current?.focus()); }
  function newChat() {
    navigation.current++;
    setActiveId(null); setDraft(""); setError("");
    if (isNarrow()) setSidebarOpen(false);
    focusComposer();
  }
  function select(id: Id<"conversations">) {
    navigation.current++;
    setActiveId(id); setError("");
    if (isNarrow()) setSidebarOpen(false);
  }
  async function run(action: () => Promise<unknown>) {
    setError("");
    try { await action(); } catch (err) { setError(errorText(err)); }
  }

  async function submit() {
    if (!canGenerate) { setSettingsOpen(true); return; }
    const prompt = draft;
    const startedAt = navigation.current;
    setBusy(true); setDraft("");
    await run(async () => {
      try {
        const id = await send({ ...(activeId ? { conversationId: activeId } : {}), prompt, ...replyArgs });
        if (navigation.current === startedAt) setActiveId(id);
      } catch (err) {
        // Give the prompt back unless the user has started typing something else.
        setDraft((current) => current || prompt);
        throw err;
      }
    });
    setBusy(false);
    focusComposer();
  }

  useHotkeys({
    n: newChat,
    k: () => { setSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); },
    b: () => setSidebarOpen((open) => !open),
  });

  const composer = (
    <Composer
      inputRef={composerRef} value={draft} onChange={setDraft} onSubmit={() => void submit()}
      onStop={() => activeId && void run(() => stop({ conversationId: activeId }))}
      generating={generating} stopping={Boolean(conversation?.stopRequested)} busy={busy}
      options={options} onOptionsChange={setOptions} models={models} searchAvailable={searchAvailable}
      placeholder={activeId ? "Ask a follow-up" : "What do you want to know?"}
    />
  );
  const errorBanner = error && (
    <div role="alert" className="mb-2.5 flex items-center gap-2.5 rounded-xl bg-danger-wash py-2.5 pr-2 pl-3.5 text-label text-danger">
      <span className="flex-1">{error}</span>
      <Button size="pill" className="text-danger hover:text-danger" onClick={() => setError("")}>Dismiss</Button>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <SearchWorker enabled={canGenerate} onError={setError} />
      {sidebarOpen && (
        <>
          <div className="fixed inset-0 z-30 hidden bg-backdrop max-[900px]:block" onClick={() => setSidebarOpen(false)} />
          <Sidebar
            conversations={conversations.results} loading={conversations.status === "LoadingFirstPage"}
            canLoadMore={conversations.status === "CanLoadMore"} onLoadMore={() => conversations.loadMore(40)}
            activeId={activeId} onSelect={select} onNewChat={newChat}
            onRename={setRenaming} onDelete={setDeleting}
            filter={filter} onFilterChange={setFilter} searchRef={searchRef}
            onClose={() => setSidebarOpen(false)} signedIn email={settings?.email} onAccount={() => setSettingsOpen(true)}
          />
        </>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 pr-4 pl-3">
          {!sidebarOpen && (
            <>
              <Tooltip label="Open sidebar (Ctrl B)">
                <Button size="icon" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={18} /></Button>
              </Tooltip>
              <Tooltip label="New chat (Ctrl N)">
                <Button size="icon" aria-label="New chat" onClick={newChat}><SquarePen size={17} /></Button>
              </Tooltip>
            </>
          )}
          <div className="min-w-0 flex-1 truncate pl-2 text-label font-medium">{conversation?.title}</div>
          {conversation && (
            <Button variant="outline" size="pill" disabled={generating} onClick={() => void run(() => exportConversation(convex, conversation))}>
              <Download size={15} />Export
            </Button>
          )}
        </header>

        {!activeId ? (
          <Home
            composer={<>{errorBanner}{composer}</>}
            notice={settings && !canGenerate && (
              <p className="m-0 max-w-md text-center text-label leading-relaxed text-muted">
                No model is connected yet. <button className="text-ink underline underline-offset-4" onClick={() => setSettingsOpen(true)}>Open settings</button> to set one up.
              </p>
            )}
            onSuggestion={(suggestion: Suggestion) => {
              setDraft(suggestion.prompt);
              if ("webSearch" in suggestion) setOptions({ ...options, webSearch: true });
              focusComposer();
            }}
          />
        ) : conversation === undefined ? (
          <div className="flex-1" />
        ) : conversation === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted">
            <p className="m-0">This chat is no longer available.</p>
            <Button variant="outline" size="pill" onClick={newChat}>Start a new chat</Button>
          </div>
        ) : (
          <>
            <ChatView
              key={conversation._id} conversation={conversation} onError={setError}
              onEdit={(text) => { setDraft(text); focusComposer(); }}
              onRegenerate={() => void run(() => regenerate({ conversationId: conversation._id, ...replyArgs }))}
            />
            <div className="mx-auto w-full max-w-[calc(var(--container-chat)+48px)] shrink-0 px-6 pb-5 max-sm:px-3 max-sm:pb-3">
              {errorBanner}{composer}
            </div>
          </>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings}
        theme={theme.preference} onThemeChange={theme.setPreference}
        onSignOut={() => void run(async () => { await signOut(); setSettingsOpen(false); })}
      />
      <RenameDialog conversation={renaming} onClose={() => setRenaming(null)} onRename={(title) => run(async () => {
        if (renaming) await rename({ conversationId: renaming._id, title });
        setRenaming(null);
      })} />
      <DeleteDialog conversation={deleting} onClose={() => setDeleting(null)} onDelete={() => run(async () => {
        if (!deleting) return;
        await remove({ conversationId: deleting._id });
        if (deleting._id === activeId) newChat();
        setDeleting(null);
      })} />
    </div>
  );
}
