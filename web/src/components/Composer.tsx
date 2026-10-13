import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "./ui/button";

export function Composer({ placeholder, hint, busy, onSend, onStop }: {
  placeholder: string;
  hint?: string;
  /** A Bot is working in this chat; show Stop alongside Send. */
  busy: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);

  async function submit() {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setValue("");
    try { await onSend(text); }
    catch { setValue((current) => current || text); }
    finally { setSending(false); input.current?.focus(); }
  }

  return (
    <form
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      className="flex flex-col gap-2.5 rounded-composer border border-rule bg-raised py-3 pr-2.5 pl-5 transition-colors focus-within:border-muted"
    >
      <textarea
        ref={input} rows={1} value={value} aria-label="Message" placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends on desktop; phones keep Enter for new lines.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) {
            event.preventDefault();
            void submit();
          }
        }}
        className="max-h-56 w-full resize-none bg-transparent pt-1 text-base leading-6 text-ink outline-none placeholder:text-muted"
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-label text-muted">{hint}</span>
        {busy && (
          <Button variant="outline" size="icon" className="size-9" aria-label="Stop" onClick={onStop}><Square size={13} fill="currentColor" /></Button>
        )}
        <Button type="submit" variant="primary" className="size-9 rounded-full" aria-label="Send" disabled={!value.trim() || sending}>
          <ArrowUp size={19} strokeWidth={2.25} />
        </Button>
      </div>
    </form>
  );
}
