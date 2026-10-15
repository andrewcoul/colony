import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { AnimatePresence, m } from "motion/react";
import { ArrowUp, FileText, Loader2, Plus, Square, X } from "lucide-react";
import type { ChatFile } from "@shared/types";
import { snappy } from "../lib/motion";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export type SendMode = "steer" | "queue";

/** What the chat screen can do to the composer: hand it dropped files, or text to finish (a question chip). */
export type ComposerHandle = { attach: (files: FileList | File[]) => void; insert: (text: string) => void };

type Pending = { key: string; name: string; mime: string; preview: string | null; file: ChatFile | null; failed: boolean };

export function Composer({ placeholder, hint, busy, onSend, onStop, onUpload, ref }: {
  placeholder: string;
  hint?: string;
  /** A Bot is working in this chat: show Stop, and Enter steers while Alt+Enter queues. */
  busy: boolean;
  onSend: (text: string, mode: SendMode, attachments: string[]) => Promise<void>;
  onStop: () => void;
  /** Uploads a file to this chat; without it the composer has no attach button. */
  onUpload?: (file: File) => Promise<ChatFile>;
  ref?: Ref<ComposerHandle>;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Phones have no Alt+Enter: while a Bot works, holding Send queues the message instead.
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const pressSend = () => {
    if (!busy) return;
    const press = { fired: false, timer: setTimeout(() => { press.fired = true; navigator.vibrate?.(12); void submit("queue"); }, 450) };
    hold.current = press;
  };
  const releaseSend = () => { if (hold.current) clearTimeout(hold.current.timer); };

  /** Files upload as soon as they're attached, so sending is instant. */
  function attach(files: FileList | File[]) {
    if (!onUpload) return;
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      setPending((list) => [...list, { key, name: file.name, mime: file.type, preview, file: null, failed: false }]);
      void onUpload(file)
        .then((uploaded) => setPending((list) => list.map((item) => (item.key === key ? { ...item, file: uploaded } : item))))
        .catch(() => setPending((list) => list.map((item) => (item.key === key ? { ...item, failed: true } : item))));
    }
  }
  const remove = (key: string) => setPending((list) => {
    const gone = list.find((item) => item.key === key);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    return list.filter((item) => item.key !== key);
  });

  useImperativeHandle(ref, () => ({
    attach,
    insert: (text) => { setValue((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text)); requestAnimationFrame(() => input.current?.focus()); },
  }));

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);

  const uploading = pending.some((item) => !item.file && !item.failed);
  const ready = pending.filter((item) => item.file);

  async function submit(mode: SendMode = "steer") {
    const text = value.trim();
    if ((!text && !ready.length) || sending || uploading) return;
    const sent = pending;
    setSending(true);
    setValue("");
    setPending([]);
    try {
      await onSend(text, mode, ready.map((item) => item.file!.id));
      for (const item of sent) if (item.preview) URL.revokeObjectURL(item.preview);
    } catch {
      setValue((current) => current || text);
      setPending((current) => (current.length ? current : sent));
    } finally { setSending(false); input.current?.focus(); }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const held = hold.current?.fired;
        hold.current = null;
        if (!held) void submit();
      }}
      onDragOver={(event) => { if (onUpload && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => { if (!onUpload || !event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); attach(event.dataTransfer.files); }}
      className="flex flex-col gap-2.5 rounded-composer border border-rule bg-raised py-3 pr-2.5 pl-5 transition-colors focus-within:border-muted"
    >
      <AnimatePresence initial={false}>
        {pending.length > 0 && (
          <m.div key="attachments" className="flex flex-wrap gap-2 overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <AnimatePresence initial={false}>
              {pending.map((item) => (
                <m.div key={item.key} layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={snappy}
                  className={cn("flex items-center gap-2 rounded-xl bg-hover py-1.5 pr-2 pl-1.5", item.failed && "ring-1 ring-danger/60")}>
                  {item.preview
                    ? <img src={item.preview} alt="" className="size-8 rounded-[7px] object-cover" />
                    : <span className="flex size-8 items-center justify-center rounded-[7px] bg-raised text-muted"><FileText size={15} /></span>}
                  <span className="flex flex-col">
                    <span className="max-w-40 truncate text-label">{item.name}</span>
                    <span className={cn("text-[11px] leading-[14px]", item.failed ? "text-danger" : "text-muted")}>
                      {item.failed ? "Didn't upload" : item.file ? "Ready" : <span className="inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" />Uploading</span>}
                    </span>
                  </span>
                  <button type="button" aria-label={`Remove ${item.name}`} onClick={() => remove(item.key)} className="text-muted hover:text-ink"><X size={13} /></button>
                </m.div>
              ))}
            </AnimatePresence>
          </m.div>
        )}
      </AnimatePresence>
      <textarea
        ref={input} rows={1} value={value} aria-label="Message" placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onPaste={(event) => { if (onUpload && event.clipboardData.files.length) { event.preventDefault(); attach(event.clipboardData.files); } }}
        onKeyDown={(event) => {
          // Enter sends on desktop (Alt+Enter queues it behind the running turn); phones keep Enter for new lines.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) {
            event.preventDefault();
            void submit(event.altKey && busy ? "queue" : "steer");
          }
        }}
        className="max-h-56 w-full resize-none bg-transparent pt-1 text-base leading-6 text-ink outline-none placeholder:text-muted"
      />
      <div className="flex items-center gap-2">
        {onUpload && (
          <>
            <Button variant="outline" size="icon" className="-ml-2.5 size-9 rounded-full" aria-label="Attach files or photos" onClick={() => picker.current?.click()}><Plus size={17} /></Button>
            <input ref={picker} type="file" multiple hidden onChange={(event) => { if (event.target.files) attach(event.target.files); event.target.value = ""; }} />
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-label text-muted">{hint}</span>
        {busy && (
          <Button variant="outline" size="icon" className="size-9" aria-label="Stop" onClick={onStop}><Square size={13} fill="currentColor" /></Button>
        )}
        <Button type="submit" variant="primary" className="size-9 rounded-full" aria-label={busy ? "Send (hold to send after)" : "Send"}
          disabled={(!value.trim() && !ready.length) || sending || uploading}
          onPointerDown={pressSend} onPointerUp={releaseSend} onPointerLeave={releaseSend} onContextMenu={(event) => { if (busy) event.preventDefault(); }}>
          <ArrowUp size={19} strokeWidth={2.25} />
        </Button>
      </div>
    </form>
  );
}
