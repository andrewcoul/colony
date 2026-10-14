import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CornerDownLeft, Delete, Globe, Hand, Loader2, MousePointer2 } from "lucide-react";
import type { Bot } from "@shared/types";
import { api, type BrowserInput } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

type Frame = { data: string; url: string; width: number; height: number };

/** The Bot's real browser, live. Take over to tap, type and scroll in it yourself. */
export function BrowserView({ bot, phone }: { bot: Bot; phone: boolean }) {
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [url, setUrl] = useState("");
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const screen = useRef<HTMLDivElement>(null);
  const wheel = useRef({ dy: 0, timer: 0 as ReturnType<typeof setTimeout> | 0 });

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      source = new EventSource(`/api/bots/${bot.id}/browser/live`);
      source.addEventListener("open", (event) => { setState("open"); setUrl(JSON.parse((event as MessageEvent<string>).data).url ?? ""); });
      source.addEventListener("closed", () => { setState("closed"); setFrame(null); });
      source.addEventListener("frame", (event) => {
        const next = JSON.parse((event as MessageEvent<string>).data) as Frame;
        setState("open");
        setFrame(next);
        setUrl(next.url);
      });
      source.onerror = () => { if (source?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 3000); };
    };
    connect();
    return () => { source?.close(); clearTimeout(retry); };
  }, [bot.id]);

  // Taking over from a phone switches the page to a phone-sized layout; handing back restores it.
  useEffect(() => {
    if (!phone || !control) return;
    void api.browserInput(bot.id, { type: "viewport", mobile: true }).catch(() => {});
    return () => { void api.browserInput(bot.id, { type: "viewport", mobile: false }).catch(() => {}); };
  }, [phone, control, bot.id]);

  async function send(input: BrowserInput) {
    setError("");
    try { await api.browserInput(bot.id, input); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "That didn't work."); }
  }

  async function openBrowser() {
    setBusy(true); setError("");
    try { await api.openBrowser(bot.id); setState("open"); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't open the browser."); }
    finally { setBusy(false); }
  }

  function tap(event: React.PointerEvent<HTMLDivElement>) {
    if (!control || !screen.current) return;
    const box = screen.current.getBoundingClientRect();
    void send({ type: "click", x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
  }

  function scroll(event: React.WheelEvent<HTMLDivElement>) {
    if (!control) return;
    // Batch wheel ticks into one request every 120ms.
    wheel.current.dy += event.deltaY;
    if (wheel.current.timer) return;
    wheel.current.timer = setTimeout(() => {
      const dy = wheel.current.dy;
      wheel.current = { dy: 0, timer: 0 };
      void send({ type: "scroll", dy });
    }, 120);
  }

  if (state === "closed") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-rule p-6 text-center">
        <Globe size={22} className="text-muted" />
        <p className="m-0 max-w-72 text-label leading-relaxed text-muted">
          {bot.name}'s browser isn't open. It opens when {bot.name} browses, or open it now to sign in to a site ahead of time.
        </p>
        <Button variant="outline" size="pill" disabled={busy} onClick={() => void openBrowser()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}Open browser
        </Button>
        {error && <span className="text-meta text-danger">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button size="icon-sm" aria-label="Back" onClick={() => void send({ type: "back" })}><ArrowLeft size={15} /></Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => {
          event.preventDefault();
          if (editingUrl?.trim()) void send({ type: "navigate", url: editingUrl.trim() });
          setEditingUrl(null);
        }}>
          <input
            aria-label="Address"
            value={editingUrl ?? url}
            onFocus={() => setEditingUrl(url)}
            onBlur={() => setEditingUrl(null)}
            onChange={(event) => setEditingUrl(event.target.value)}
            className="h-8 w-full truncate rounded-full bg-raised px-3 font-mono text-[12px] text-soft outline-none focus:text-ink"
          />
        </form>
        <Button variant={control ? "primary" : "outline"} size="pill" className="h-8" aria-pressed={control} onClick={() => setControl(!control)}>
          {control ? <MousePointer2 size={14} /> : <Hand size={14} />}{control ? "Controlling" : "Take over"}
        </Button>
      </div>

      <div
        ref={screen}
        onPointerUp={tap}
        onWheel={scroll}
        style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : "16 / 10" }}
        className={cn("relative mx-auto max-h-full w-full max-w-full overflow-hidden rounded-xl border bg-[#0b0b0f]",
          // Portrait (phone takeover): fit the height so the typing controls stay on screen.
          frame && frame.width < frame.height && "h-[52dvh] w-auto",
          control ? "cursor-pointer border-lilac/60 ring-2 ring-lilac/25" : "border-rule")}
      >
        {frame
          ? <img src={`data:image/jpeg;base64,${frame.data}`} alt={`${bot.name}'s browser`} draggable={false} className="size-full select-none object-fill" />
          : <span className="absolute inset-0 flex items-center justify-center text-meta text-muted"><Loader2 size={16} className="mr-2 animate-spin" />Connecting…</span>}
      </div>

      {control ? (
        <div className="flex flex-col gap-2">
          <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); if (text) { void send({ type: "type", text }); setText(""); } }}>
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Type into the page…" aria-label="Type into the page"
              autoComplete="off" autoCapitalize="off" spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded-lg border border-rule bg-ground px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-muted" />
            <Button type="submit" variant="outline" size="pill" className="h-9" disabled={!text}>Send</Button>
          </form>
          <div className="flex gap-1.5">
            <Button variant="outline" size="pill" className="h-8 flex-1" onClick={() => void send({ type: "key", key: "Enter" })}><CornerDownLeft size={13} />Enter</Button>
            <Button variant="outline" size="pill" className="h-8 flex-1" onClick={() => void send({ type: "key", key: "Tab" })}>Tab</Button>
            <Button variant="outline" size="pill" className="h-8 flex-1" onClick={() => void send({ type: "key", key: "Backspace" })}><Delete size={13} />Delete</Button>
          </div>
          <p className="m-0 text-meta text-muted">Tap the page to click; what you type goes into the focused field. Passwords you type here go straight to the site, not to {bot.name}.</p>
        </div>
      ) : (
        <p className="m-0 text-meta text-muted">You're watching live. Take over to sign in or help {bot.name} past a blocker.</p>
      )}
      {error && <span className="text-meta text-danger">{error}</span>}
    </div>
  );
}
