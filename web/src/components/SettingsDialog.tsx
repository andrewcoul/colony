import { useEffect, useMemo, useState } from "react";
import { Check, Eye, EyeOff, Loader2, Plus, Star, X } from "lucide-react";
import { api, type ModelSettings } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/input";

/** Common OpenAI-compatible providers. Any other works too: type its base URL. */
const PRESETS = [
  { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { name: "OpenAI", baseURL: "https://api.openai.com/v1" },
  { name: "xAI", baseURL: "https://api.x.ai/v1" },
  { name: "OpenCode Go", baseURL: "https://opencode.ai/zen/go/v1" },
  { name: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1" },
  { name: "Ollama (this PC)", baseURL: "http://localhost:11434/v1" },
];

const sameURL = (a: string, b: string) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/** The model connection: provider, API key and models. Changes apply to the next reply. */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [saved, setSaved] = useState<ModelSettings | null>(null);
  const [providerName, setProviderName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [available, setAvailable] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "error"; message?: string }>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setApiKey(""); setShowKey(false); setAvailable(null); setDraft(""); setCheck({ state: "idle" }); setError(""); setDone(false);
    void api.modelSettings().then((current) => {
      setSaved(current);
      setProviderName(current.providerName === "colony" ? "" : current.providerName);
      setBaseURL(current.baseURL);
      setModels(current.models);
    }).catch(() => setError("Couldn't load settings."));
  }, [open]);

  // The saved key only applies to the address it was saved for.
  const keepsKey = Boolean(saved?.keySet && sameURL(baseURL, saved.baseURL));
  const suggestions = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    return (available ?? []).filter((id) => !models.includes(id) && (!needle || id.toLowerCase().includes(needle))).slice(0, 8);
  }, [available, draft, models]);

  function choosePreset(preset: (typeof PRESETS)[number]) {
    setProviderName(preset.name);
    setBaseURL(preset.baseURL);
    setAvailable(null);
    setCheck({ state: "idle" });
    if (!sameURL(preset.baseURL, saved?.baseURL ?? "")) setModels([]);
  }

  async function checkConnection() {
    setCheck({ state: "checking" });
    try {
      const { models: found } = await api.checkModelSettings(baseURL, apiKey || undefined);
      setAvailable(found);
      setCheck({ state: "ok", message: found.length ? `Connected · ${found.length} model${found.length === 1 ? "" : "s"} available` : "Connected" });
    } catch (failure) {
      setCheck({ state: "error", message: failure instanceof Error ? failure.message : "Couldn't connect." });
    }
  }

  const addModel = (id: string) => {
    const clean = id.trim();
    if (clean && !models.includes(clean)) setModels([...models, clean]);
    setDraft("");
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const next = await api.saveModelSettings({ providerName: providerName.trim() || "Provider", baseURL: baseURL.trim(), apiKey: apiKey.trim() || undefined, models });
      setSaved(next); setApiKey(""); setDone(true);
      setTimeout(() => onOpenChange(false), 700);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save."); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Model settings"
      description="Any OpenAI-compatible provider works. Changes apply to the next reply, so you can switch keys or providers any time.">
      <form onSubmit={save} className="flex flex-col">
        <div className="-mx-1 mb-4 flex flex-wrap gap-1.5 px-1">
          {PRESETS.map((preset) => (
            <button key={preset.name} type="button" onClick={() => choosePreset(preset)} aria-pressed={sameURL(baseURL, preset.baseURL)}
              className={cn("rounded-full border px-3 py-1.5 text-meta", sameURL(baseURL, preset.baseURL) ? "border-transparent bg-ink text-on-ink" : "border-rule text-soft hover:bg-hover hover:text-ink")}>
              {preset.name}
            </button>
          ))}
        </div>

        <Field label="Provider" htmlFor="settings-name"><Input id="settings-name" value={providerName} onChange={(e) => setProviderName(e.target.value)} maxLength={40} placeholder="OpenRouter" /></Field>
        <Field label="Base URL" htmlFor="settings-url">
          <Input id="settings-url" value={baseURL} onChange={(e) => { setBaseURL(e.target.value); setCheck({ state: "idle" }); }} required placeholder="https://openrouter.ai/api/v1" inputMode="url" autoCapitalize="off" spellCheck={false} />
        </Field>
        <Field label="API key" htmlFor="settings-key">
          <div className="relative">
            <Input id="settings-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} className="pr-11"
              placeholder={keepsKey ? `Saved key${saved?.keyHint ? ` ending ${saved.keyHint}` : ""} · leave blank to keep` : "Paste your API key (blank for local models)"} />
            <button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? "Hide key" : "Show key"}
              className="absolute top-1/2 right-3 -translate-y-1/2 text-muted hover:text-ink">{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
        </Field>
        <div className="mb-4 flex items-center gap-3">
          <Button variant="outline" size="pill" disabled={!baseURL.trim() || check.state === "checking"} onClick={() => void checkConnection()}>
            {check.state === "checking" ? <Loader2 size={14} className="animate-spin" /> : null}Check connection
          </Button>
          {check.message && <span className={cn("min-w-0 text-meta", check.state === "error" ? "text-danger" : "text-mint")}>{check.message}</span>}
        </div>

        <span className="mb-1.5 text-label text-muted">Models <span className="text-meta">· the first is the default for new Bots</span></span>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {models.length === 0 && <span className="text-meta text-muted">None yet. Check the connection to pick from the provider's list, or type an id.</span>}
          {models.map((id, index) => (
            <span key={id} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border py-1 pr-1 pl-2.5 text-meta", index === 0 ? "border-mint/40 text-ink" : "border-rule text-soft")}>
              <button type="button" aria-label={index === 0 ? "Default model" : `Make ${id} the default`} disabled={index === 0}
                onClick={() => setModels([id, ...models.filter((item) => item !== id)])} className={cn("shrink-0", index === 0 ? "text-mint" : "text-muted hover:text-ink")}>
                <Star size={12} fill={index === 0 ? "currentColor" : "none"} />
              </button>
              <span className="truncate font-mono">{id}</span>
              <button type="button" aria-label={`Remove ${id}`} onClick={() => setModels(models.filter((item) => item !== id))} className="shrink-0 rounded-full p-0.5 text-muted hover:text-ink"><X size={12} /></button>
            </span>
          ))}
        </div>
        <div className="mb-1 flex gap-1.5">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={available?.length ? "Search the provider's models…" : "Model id, e.g. deepseek/deepseek-v4.1-flash"}
            aria-label="Add a model" autoCapitalize="off" spellCheck={false} className="h-9 font-mono text-[13px]"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModel(suggestions[0] && draft && !available?.includes(draft.trim()) ? suggestions[0] : draft); } }} />
          <Button variant="outline" size="icon" className="size-9" aria-label="Add model" disabled={!draft.trim()} onClick={() => addModel(draft)}><Plus size={15} /></Button>
        </div>
        {suggestions.length > 0 && (draft || models.length === 0) && (
          <div className="mb-2 flex max-h-44 flex-col overflow-y-auto rounded-lg border border-rule p-1">
            {suggestions.map((id) => (
              <button key={id} type="button" onClick={() => addModel(id)} className="truncate rounded-md px-2.5 py-1.5 text-left font-mono text-[12px] text-soft hover:bg-hover hover:text-ink">{id}</button>
            ))}
          </div>
        )}
        <p className="m-0 mt-2 mb-4 text-meta leading-relaxed text-muted">
          Bots set to a model you remove switch to the default. Your key stays on this PC; devices only see its last four characters.
        </p>

        {error && <p role="alert" className="m-0 mb-3 text-label text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !baseURL.trim() || models.length === 0}>
          {done ? <><Check size={15} />Saved</> : busy ? "Saving…" : "Save"}
        </Button>
      </form>
    </Dialog>
  );
}
