import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, MonitorUp, RefreshCw } from "lucide-react";
import type { Bot } from "@shared/types";
import { api } from "../lib/api";
import { Button } from "./ui/button";

/**
 * The Bot's desktop, live: Cua's viewer (video, mouse, keyboard and touch) served through
 * Colony. Tap into it to take over; the Bot and you share one screen.
 */
export function ScreenView({ bot }: { bot: Bot }) {
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setLink(await api.screenLink(bot.id)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't open the screen."); }
    finally { setLoading(false); }
  }, [bot.id]);

  useEffect(() => { void load(); }, [load]);

  // Links expire after a few hours; get a fresh one shortly before.
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => void load(), Math.max(60_000, link.expiresAt - Date.now() - 5 * 60_000));
    return () => clearTimeout(timer);
  }, [link, load]);

  if (!link) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-rule p-6 text-center">
        {loading ? <Loader2 size={20} className="animate-spin text-muted" /> : <MonitorUp size={22} className="text-muted" />}
        <p className="m-0 max-w-72 text-label leading-relaxed text-muted">
          {loading ? `Starting ${bot.name}'s computer…` : error || `${bot.name}'s screen isn't open.`}
        </p>
        {!loading && <Button variant="outline" size="pill" onClick={() => void load()}><RefreshCw size={14} />Try again</Button>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-rule bg-[#0b0b0f]">
        <iframe
          key={link.url}
          src={link.url}
          title={`${bot.name}'s screen`}
          allow="clipboard-read; clipboard-write; fullscreen; autoplay"
          className="absolute inset-0 size-full border-0"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-meta text-muted">
          {bot.desktop ? `${bot.name} and you share this screen. Tap in to take over.` : `${bot.name} doesn't drive the desktop (turn on Desktop control in the profile). You can use it yourself.`}
        </span>
        <Button size="icon-sm" aria-label="Reconnect" onClick={() => void load()}><RefreshCw size={14} /></Button>
        <a href={link.url} target="_blank" rel="noreferrer" aria-label="Open the screen in a new tab"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"><ExternalLink size={14} /></a>
      </div>
    </div>
  );
}
