import { useMemo, type RefObject } from "react";
import { MoreHorizontal, PanelLeftClose, Pencil, Search, Settings, SquarePen, Trash2 } from "lucide-react";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { groupByRecency } from "../lib/dates";
import { cn } from "../lib/utils";
import { LogoMark } from "./Logo";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";

export function Sidebar({
  conversations, loading, canLoadMore, onLoadMore, activeId, onSelect, onNewChat, onRename, onDelete,
  filter, onFilterChange, searchRef, onClose, signedIn, email, onAccount,
}: {
  conversations: Doc<"conversations">[];
  loading: boolean;
  canLoadMore: boolean;
  onLoadMore: () => void;
  activeId: Id<"conversations"> | null;
  onSelect: (id: Id<"conversations">) => void;
  onNewChat: () => void;
  onRename: (conversation: Doc<"conversations">) => void;
  onDelete: (conversation: Doc<"conversations">) => void;
  filter: string;
  onFilterChange: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  signedIn: boolean;
  email?: string;
  onAccount: () => void;
}) {
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return groupByRecency(needle ? conversations.filter((c) => c.title.toLowerCase().includes(needle)) : conversations);
  }, [conversations, filter]);

  return (
    <aside aria-label="Conversations" className="flex h-full w-[260px] shrink-0 flex-col border-r border-rule bg-surface px-2.5 pt-3 max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:z-40 max-[900px]:shadow-pop">
      <div className="flex items-center justify-between pt-1 pb-3.5 pl-2">
        <span className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"><LogoMark />Colony</span>
        <Tooltip label="Close sidebar">
          <Button size="icon" aria-label="Close sidebar" onClick={onClose}><PanelLeftClose size={18} /></Button>
        </Tooltip>
      </div>

      <label className="flex h-[38px] items-center gap-2.5 rounded-lg border border-rule px-2.5 text-muted focus-within:border-muted">
        <Search size={16} />
        <input
          ref={searchRef} value={filter} onChange={(event) => onFilterChange(event.target.value)}
          placeholder="Search" aria-label="Search conversations"
          className="min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-muted"
        />
        <kbd className="font-sans text-meta">Ctrl K</kbd>
      </label>
      <button type="button" onClick={onNewChat} className="mt-1.5 flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-label font-medium hover:bg-hover">
        <SquarePen size={16} /><span className="flex-1">New chat</span><kbd className="font-sans text-meta text-muted">Ctrl N</kbd>
      </button>

      <nav className="min-h-0 flex-1 overflow-y-auto pt-3 pb-2 [scrollbar-width:thin]">
        {!signedIn && <p className="px-2.5 py-8 text-label leading-relaxed text-muted">Sign in to keep your conversations here.</p>}
        {signedIn && loading && <p className="px-2.5 py-8 text-label text-muted">Loading…</p>}
        {signedIn && !loading && !groups.length && (
          <p className="px-2.5 py-8 text-label leading-relaxed text-muted">{filter ? "No conversations match." : "Your conversations will appear here."}</p>
        )}
        {groups.map((group) => (
          <section key={group.label} className="flex flex-col gap-0.5">
            <h2 className="m-0 px-2.5 pt-3.5 pb-1.5 text-meta font-normal text-muted first:pt-1">{group.label}</h2>
            {group.items.map((conversation) => (
              <HistoryRow
                key={conversation._id} conversation={conversation} active={conversation._id === activeId}
                onSelect={onSelect} onRename={onRename} onDelete={onDelete}
              />
            ))}
          </section>
        ))}
        {canLoadMore && !filter && (
          <button type="button" onClick={onLoadMore} className="w-full rounded-lg p-2.5 text-meta text-muted hover:bg-hover hover:text-ink">Show older</button>
        )}
      </nav>

      <button type="button" onClick={onAccount} className="group -mx-2.5 mt-auto flex items-center gap-2.5 border-t border-rule px-5 py-3 text-left">
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-raised text-label font-semibold">
          {(email?.[0] || "?").toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-label font-medium">{signedIn ? "Settings" : "Sign in"}</strong>
          <small className="truncate text-meta text-muted">{signedIn ? email : "Save your conversations"}</small>
        </span>
        <Settings size={16} className="text-muted group-hover:text-ink" />
      </button>
    </aside>
  );
}

function HistoryRow({ conversation, active, onSelect, onRename, onDelete }: {
  conversation: Doc<"conversations">;
  active: boolean;
  onSelect: (id: Id<"conversations">) => void;
  onRename: (conversation: Doc<"conversations">) => void;
  onDelete: (conversation: Doc<"conversations">) => void;
}) {
  return (
    <div className={cn("group relative flex items-center rounded-lg hover:bg-hover", active && "bg-raised hover:bg-raised")}>
      <button
        type="button" onClick={() => onSelect(conversation._id)} aria-current={active ? "page" : undefined}
        className={cn("flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-label", active ? "text-ink" : "text-soft")}
      >
        <span className="truncate">{conversation.title}</span>
        {conversation.generating && <span aria-label="Replying" className="ml-auto size-1.5 shrink-0 animate-blink rounded-full bg-ink group-hover:hidden" />}
      </button>
      <MenuRoot>
        <MenuTrigger>
          <Button size="icon-sm" aria-label={"Options for " + conversation.title} className="mr-0.5 hidden group-focus-within:inline-flex group-hover:inline-flex data-[popup-open]:inline-flex">
            <MoreHorizontal size={16} />
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onClick={() => onRename(conversation)}><Pencil size={15} />Rename</MenuItem>
          <MenuItem disabled={conversation.generating} onClick={() => onDelete(conversation)} className="text-danger"><Trash2 size={15} />Delete</MenuItem>
        </MenuContent>
      </MenuRoot>
    </div>
  );
}
