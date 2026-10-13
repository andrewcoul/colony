import { useEffect, useState } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

export function RenameDialog({ conversation, onClose, onRename }: {
  conversation: Doc<"conversations"> | null;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => { if (conversation) setTitle(conversation.title); }, [conversation]);
  return (
    <Dialog open={Boolean(conversation)} onOpenChange={(open) => { if (!open) onClose(); }} title="Rename chat">
      <form onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        try { await onRename(title.trim()); } finally { setPending(false); }
      }}>
        <Input aria-label="Title" value={title} maxLength={100} autoFocus onChange={(event) => setTitle(event.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending || !title.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function DeleteDialog({ conversation, onClose, onDelete }: {
  conversation: Doc<"conversations"> | null;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={Boolean(conversation)} onOpenChange={(open) => { if (!open) onClose(); }}
      title="Delete chat?" description={<>“{conversation?.title}” and all its messages will be deleted. This can't be undone.</>}
    >
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={pending} onClick={async () => {
          setPending(true);
          try { await onDelete(); } finally { setPending(false); }
        }}>Delete</Button>
      </div>
    </Dialog>
  );
}
