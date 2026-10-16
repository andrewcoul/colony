import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Loader2, Volume2 } from "lucide-react";
import { api, type Settings, type VoiceSettings } from "../lib/api";
import { useLive } from "../lib/live";
import { Face } from "./Face";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

/** OpenAI's voices; local servers (Kokoro and others) have their own names, typed in by hand. */
const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

/** Settings › Voice: who transcribes and speaks, each Bot's voice, and when Bots may ring you. */
export function VoiceSettingsEditor({ settings, onBack, onSaved }: { settings: Settings; onBack: () => void; onSaved: (settings: Settings) => void }) {
  const botMap = useLive((s) => s.bots);
  const bots = useMemo(() => Object.values(botMap), [botMap]);
  const [voice, setVoice] = useState(settings.voice);
  const [error, setError] = useState("");
  const [trying, setTrying] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => player.current?.pause(), []);
  const providers = settings.providers.filter((provider) => provider.protocol === "openai");

  async function save(patch: Partial<VoiceSettings>) {
    setVoice((current) => ({ ...current, ...patch, botVoices: { ...current.botVoices, ...patch.botVoices } }));
    setError("");
    try { onSaved(await api.setVoice(patch)); } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save that."); }
  }

  async function tryVoice(name: string, key: string) {
    setTrying(key);
    setError("");
    try {
      const audio = new Audio(URL.createObjectURL(await api.tryVoice(name)));
      player.current?.pause();
      player.current = audio;
      await audio.play();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't play that voice.");
    } finally {
      setTrying(null);
    }
  }

  const ready = Boolean(voice.providerId && providers.some((provider) => provider.id === voice.providerId));
  const TryButton = ({ name, id }: { name: string; id: string }) => (
    <Button variant="outline" size="icon" aria-label={`Hear ${name}`} disabled={!ready || !name || trying !== null} onClick={() => void tryVoice(name, id)}>
      {trying === id ? <Loader2 size={15} className="animate-spin" /> : <Volume2 size={15} />}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="-mt-1 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>
      <p className="m-0 text-label leading-relaxed text-soft">
        Talk to a Bot with the call button in its chat. What you say is transcribed and posted as your messages; replies are read aloud as they're written.
        Any provider with OpenAI-style audio works, including local Whisper and Kokoro servers.
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="text-label text-muted">Provider</span>
        <select value={voice.providerId ?? ""} onChange={(event) => void save({ providerId: event.target.value || null })}
          className="h-[42px] w-full rounded-lg border border-rule bg-ground px-3 text-sm text-ink outline-none">
          <option value="">Off</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
        {providers.length === 0 && <span className="text-meta text-muted">Add an OpenAI-compatible provider first (Anthropic's API has no audio).</span>}
      </label>

      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label="Transcription model" htmlFor="voice-stt">
          <Input id="voice-stt" defaultValue={voice.transcribeModel} className="font-mono text-[13px]"
            onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== voice.transcribeModel) void save({ transcribeModel: value }); }} />
        </Field>
        <Field label="Speech model" htmlFor="voice-tts">
          <Input id="voice-tts" defaultValue={voice.speechModel} className="font-mono text-[13px]"
            onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== voice.speechModel) void save({ speechModel: value }); }} />
        </Field>
      </div>

      <datalist id="voice-names">{VOICES.map((name) => <option key={name} value={name} />)}</datalist>
      <div className="flex flex-col gap-1.5">
        <span className="text-label text-muted">Voices</span>
        <div className="flex flex-col divide-y divide-rule rounded-xl border border-rule">
          {(
            <div className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="flex-1 text-sm">Every Bot, unless set below</span>
              <Input list="voice-names" defaultValue={voice.voice} aria-label="Default voice" className="h-9 w-32"
                onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== voice.voice) void save({ voice: value }); }} />
              <TryButton name={voice.voice} id="default" />
            </div>
          )}
          {bots.map((bot) => (
            <div key={bot.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Face seed={bot.faceSeed} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
              <Input list="voice-names" defaultValue={voice.botVoices[bot.id] ?? ""} placeholder={voice.voice} aria-label={`${bot.name}'s voice`} className="h-9 w-32"
                onBlur={(event) => { const value = event.target.value.trim(); if (value !== (voice.botVoices[bot.id] ?? "")) void save({ botVoices: { [bot.id]: value } }); }} />
              <TryButton name={voice.botVoices[bot.id] || voice.voice} id={bot.id} />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-rule px-3.5 py-3">
        <label className="flex items-center gap-3">
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-sm">Your Bots can call you</span>
            <span className="text-meta text-muted">For things that need you now. At most once every 30 minutes per Bot; a missed call leaves its message in the chat.</span>
          </span>
          <input type="checkbox" checked={voice.allowCalls} onChange={(event) => void save({ allowCalls: event.target.checked })} className="size-4 accent-[var(--ink)]" />
        </label>
        <div className="flex items-center gap-2 text-sm">
          <span className="flex-1">Quiet hours</span>
          <input type="time" aria-label="Quiet from" value={voice.quietFrom} disabled={!voice.allowCalls} onChange={(event) => event.target.value && void save({ quietFrom: event.target.value })}
            className="h-9 rounded-lg border border-rule bg-ground px-2 text-ink disabled:opacity-50" />
          <span className="text-muted">to</span>
          <input type="time" aria-label="Quiet until" value={voice.quietTo} disabled={!voice.allowCalls} onChange={(event) => event.target.value && void save({ quietTo: event.target.value })}
            className="h-9 rounded-lg border border-rule bg-ground px-2 text-ink disabled:opacity-50" />
        </div>
        <span className="text-meta text-muted">On iPhone, a call arrives as a notification rather than ringing like a phone.</span>
      </div>
      {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
    </div>
  );
}
