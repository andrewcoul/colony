import { useUIMessages } from "@convex-dev/agent/react";
import { ArrowDown, RefreshCw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { AssistantTurn, TypingDots, UserTurn } from "./Message";
import { Button } from "./ui/button";

export function ChatView({ conversation, onEdit, onRegenerate, onError }: {
  conversation: Doc<"conversations">;
  onEdit: (text: string) => void;
  onRegenerate: () => void;
  onError: (message: string) => void;
}) {
  const { results, status, loadMore } = useUIMessages(
    api.chat.messages,
    { conversationId: conversation._id, threadId: conversation.threadId },
    { initialNumItems: 30, stream: true },
  );
  const messages = results.filter((message) => message.role === "user"
    || (message.role === "assistant" && (message.text || message.parts.length || message.status === "streaming" || message.status === "failed")));
  const last = messages.at(-1);
  const { ref, onScroll, atBottom, scrollToBottom, unpin } = useStickToBottom(
    (last?.text.length ?? 0) + ":" + messages.length + ":" + conversation.generating,
  );
  const waiting = conversation.generating && last?.role !== "assistant";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <div className="mx-auto flex max-w-chat flex-col gap-7 px-6 pt-3 pb-8 max-sm:px-4">
          {status === "CanLoadMore" && (
            <Button variant="outline" size="pill" className="self-center" onClick={() => { unpin(); loadMore(30); }}>Load earlier messages</Button>
          )}
          {status === "LoadingFirstPage" && <p className="py-12 text-center text-label text-muted">Loading…</p>}
          {messages.map((message) => message.role === "user"
            ? <UserTurn key={message.key} message={message} onEdit={onEdit} />
            : <AssistantTurn
                key={message.key} message={message} latest={message === last}
                canRegenerate={!conversation.generating} onRegenerate={onRegenerate} onError={onError}
              />)}
          {waiting && <TypingDots />}
          {conversation.error && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger-wash px-3.5 py-3 text-label text-danger">
              <span>{conversation.error}</span>
              <Button variant="outline" size="pill" className="border-danger/40 text-danger" onClick={onRegenerate}><RefreshCw size={14} />Retry</Button>
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <Button
          variant="outline" size="icon" aria-label="Jump to latest"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-ground shadow-pop"
          onClick={() => scrollToBottom()}
        ><ArrowDown size={17} /></Button>
      )}
    </div>
  );
}
