import { useEffect, useMemo, useState } from "react";
import { AudioLines, ChevronLeft, ChevronRight, Eye, EyeOff, KeyRound, Loader2, Monitor, Plus, Server, Trash2, X } from "lucide-react";
import type { AccountKind } from "@shared/types";
import { api, type DesktopVerdict, type Protocol, type ProviderView, type Settings } from "../lib/api";
import { AccountsList, ConnectAccount, KIND_NAMES } from "./AccountsSettings";
import { VoiceSettingsEditor } from "./VoiceSettings";
import { ThisPcSettings } from "./ThisPcSettings";
import { FamilySettings, PersonAvatar } from "./People";
import { desktopApp } from "../lib/desktop";
import { HOST_ID, useIsHost, useLive } from "../lib/live";
import { openUpdates } from "../lib/settings";
import { pending, useUpdates, WEB_VERSION } from "../lib/updates";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/input";

/** Common providers. Any other works too: type its base URL and pick its API format. */
const PRESETS: { name: string; baseURL: string; protocol: Protocol }[] = [
  { name: "Claude (Anthropic)", baseURL: "https://api.anthropic.com/v1", protocol: "anthropic" },
  { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", protocol: "openai" },
  { name: "OpenAI", baseURL: "https://api.openai.com/v1", protocol: "openai" },
  { name: "xAI", baseURL: "https://api.x.ai/v1", protocol: "openai" },
  { name: "OpenCode Go", baseURL: "https://opencode.ai/zen/go/v1", protocol: "openai" },
  { name: "Groq", baseURL: "https://api.groq.com/openai/v1", protocol: "openai" },
  { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", protocol: "openai" },
  { name: "Ollama (this PC)", baseURL: "http://localhost:11434/v1", protocol: "openai" },
];

/** One line on a desktop-check result. */
const verdictText = (verdict: DesktopVerdict) => verdict.error ? `couldn't check (${verdict.error})`
  : verdict.canDrive ? "reads the screen and clicks accurately"
  : verdict.reads ? "reads the screen but misses its clicks"
  : verdict.points ? "clicks well but misread the screen"
  : "can't read screenshots";

const sameURL = (a: string, b: string) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

/** Model providers (each with its own key and models), the default model for new Bots, and connected accounts. */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const models = useLive((s) => s.models);
  const updates = useUpdates();
  const news = pending(updates);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<ProviderView | "new" | null>(null);
  /** Connecting an account: which kind (null = pick one), or undefined when not connecting. */
  const [connecting, setConnecting] = useState<AccountKind | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [voicing, setVoicing] = useState(false);
  const [lending, setLending] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const people = useLive((s) => s.people);
  // Shared models, voice, accounts and updates are the host's to look after.
  const host = useIsHost();
  const hostName = people.find((person) => person.id === HOST_ID)?.name ?? "The host";

  useEffect(() => {
    if (!open) return;
    setEditing(null); setConnecting(undefined); setVoicing(false); setLending(false); setPeopleOpen(false); setError("");
    void api.settings().then(setSettings).catch(() => setError("Couldn't load settings."));
  }, [open]);

  async function setDefault(ref: string) {
    setError("");
    try { setSettings(await api.setDefaultModel(ref)); } catch (failure) { setError(message(failure, "Couldn't change the default.")); }
  }

  const groups = [...new Set(models.map((item) => item.providerId))].map((id) => models.filter((item) => item.providerId === id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}
      title={connecting !== undefined ? `Connect ${connecting ? KIND_NAMES[connecting] : "an account"}` : editing ? (editing === "new" ? "Add a provider" : editing.name) : voicing ? "Voice" : lending ? "This PC" : peopleOpen ? "Family" : "Settings"}
      description={editing || voicing || lending || peopleOpen || connecting !== undefined || !host ? undefined : "Add any OpenAI-compatible providers, each with its own key. Every Bot can use any model from any of them; changes apply to the next reply."}>
      {connecting !== undefined ? (
        <ConnectAccount kind={connecting} onBack={() => setConnecting(undefined)} />
      ) : peopleOpen ? (
        <FamilySettings onBack={() => setPeopleOpen(false)} />
      ) : lending ? (
        <ThisPcSettings onBack={() => setLending(false)} />
      ) : voicing && settings ? (
        <VoiceSettingsEditor settings={settings} onBack={() => setVoicing(false)} onSaved={setSettings} />
      ) : editing ? (
        <ProviderEditor
          provider={editing === "new" ? null : editing}
          onBack={() => setEditing(null)}
          onSaved={(next) => { setSettings(next); setEditing(null); }}
        />
      ) : (
        <div className="flex flex-col">
          {!host && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3">
              {people.find((person) => person.id === HOST_ID) && <PersonAvatar person={people.find((person) => person.id === HOST_ID)!} size={26} />}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-sm font-medium">{hostName} runs this Colony</strong>
                <span className="truncate text-meta text-muted">Shared models, voice and updates are looked after on {hostName}'s PC.</span>
              </span>
            </div>
          )}
          {host && <>
          {models.length > 0 && (
            <label className="mb-5 flex flex-col gap-1.5">
              <span className="text-label text-muted">Default model for new Bots</span>
              <select value={settings?.defaultModel ?? ""} onChange={(e) => void setDefault(e.target.value)}
                className="h-[42px] w-full rounded-lg border border-rule bg-ground px-3 font-mono text-[13px] text-ink outline-none">
                {groups.map((group) => (
                  <optgroup key={group[0].providerId} label={group[0].providerName}>
                    {group.map((item) => <option key={item.ref} value={item.ref}>{item.model}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          )}

          <span className="mb-1.5 text-label text-muted">Providers</span>
          <div className="mb-3 flex flex-col gap-2">
            {settings?.providers.length === 0 && (
              <p className="m-0 rounded-xl border border-dashed border-rule p-4 text-label text-muted">No providers yet. Add one to give your Bots a model.</p>
            )}
            {settings?.providers.map((provider) => (
              <button key={provider.id} type="button" onClick={() => setEditing(provider)}
                className="flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3 text-left hover:bg-hover">
                <Server size={16} className="shrink-0 text-muted" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <strong className="truncate text-sm font-medium">{provider.name}</strong>
                  <span className="truncate text-meta text-muted">
                    {hostOf(provider.baseURL)}{provider.protocol === "anthropic" ? " · Anthropic API" : ""} · {provider.models.length} model{provider.models.length === 1 ? "" : "s"} · {provider.keySet ? `key ${provider.keyHint ? `…${provider.keyHint}` : "saved"}` : "no key"}
                  </span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-muted" />
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={() => setEditing("new")}><Plus size={15} />Add provider</Button>
          <p className="m-0 mt-4 text-meta leading-relaxed text-muted">Keys stay on this PC; devices only see their last four characters. A key is only ever sent to the address it was saved for.</p>
          </>}
          {error && <p role="alert" className="m-0 mt-3 text-label text-danger">{error}</p>}
          <span className={cn("mb-1.5 text-label text-muted", host && "mt-6")}>Family</span>
          <button type="button" onClick={() => setPeopleOpen(true)}
            className="mb-2 flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3 text-left hover:bg-hover">
            <span className="flex shrink-0 -space-x-2">
              {people.slice(0, 3).map((person) => <PersonAvatar key={person.id} person={person} size={22} className="rounded-full ring-2 ring-raised" />)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="truncate text-sm font-medium">Family</strong>
              <span className="truncate text-meta text-muted">
                {people.length === 1 ? "Just you so far · anyone on the tailnet can join" : `${people.length} people · you, your name and what Bots know about you`}
              </span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-muted" />
          </button>
          {host && <>
          <span className="mt-4 mb-1.5 text-label text-muted">Voice</span>
          <button type="button" onClick={() => setVoicing(true)} disabled={!settings}
            className="flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3 text-left hover:bg-hover">
            <AudioLines size={16} className="shrink-0 text-muted" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="truncate text-sm font-medium">Calls</strong>
              <span className="truncate text-meta text-muted">
                {settings?.voice.providerId ? `${settings.providers.find((provider) => provider.id === settings.voice.providerId)?.name ?? "Provider removed"} · ${settings.voice.allowCalls ? `Bots can call you, quiet ${settings.voice.quietFrom}–${settings.voice.quietTo}` : "Bots can't call you"}` : "Off · pick a provider to talk to your Bots"}
              </span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-muted" />
          </button>
          </>}
          {desktopApp?.node && (
            <button type="button" onClick={() => setLending(true)}
              className="mt-2 flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3 text-left hover:bg-hover">
              <Monitor size={16} className="shrink-0 text-muted" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-sm font-medium">This PC</strong>
                <span className="truncate text-meta text-muted">Lend this computer to your Bots: browser, screen, terminal, files</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </button>
          )}
          {host && <AccountsList onConnect={setConnecting} />}
          <button type="button" onClick={() => { onOpenChange(false); openUpdates(); }}
            className="mt-5 flex items-center justify-between gap-3 border-t border-rule pt-4 text-left text-meta text-muted hover:text-ink">
            <span>Colony {updates.system?.version ?? WEB_VERSION}</span>
            <span className={cn("flex items-center gap-1", (news.server || news.desktop || news.reload) && "text-lemon")}>
              {news.server || news.desktop ? "Update available" : news.reload ? "Reload to update" : "Updates"}<ChevronRight size={14} />
            </span>
          </button>
        </div>
      )}
    </Dialog>
  );
}

function ProviderEditor({ provider, onBack, onSaved }: { provider: ProviderView | null; onBack: () => void; onSaved: (settings: Settings) => void }) {
  const [name, setName] = useState(provider?.name ?? "");
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? "");
  const [protocol, setProtocol] = useState<Protocol>(provider?.protocol ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>(provider?.models ?? []);
  // Which models can drive a desktop (set by the desktop check or by hand).
  const [desktop, setDesktop] = useState<string[]>(provider?.desktop ?? []);
  const [verdicts, setVerdicts] = useState<Record<string, DesktopVerdict>>({});
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "error"; message?: string }>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The saved key only applies to the address it was saved for.
  const keepsKey = Boolean(provider?.keySet && sameURL(baseURL, provider.baseURL));
  const suggestions = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    return (available ?? []).filter((id) => !models.includes(id) && (!needle || id.toLowerCase().includes(needle))).slice(0, 8);
  }, [available, draft, models]);

  function choosePreset(preset: (typeof PRESETS)[number]) {
    setName(preset.name);
    setBaseURL(preset.baseURL);
    setProtocol(preset.protocol);
    setAvailable(null);
    setCheck({ state: "idle" });
  }

  async function checkConnection() {
    setCheck({ state: "checking" });
    try {
      const { models: found } = await api.checkProvider({ providerId: provider?.id, baseURL, protocol, apiKey: apiKey || undefined });
      setAvailable(found);
      setCheck({ state: "ok", message: found.length ? `Connected · ${found.length} model${found.length === 1 ? "" : "s"} available` : "Connected" });
    } catch (failure) {
      setCheck({ state: "error", message: message(failure, "Couldn't connect.") });
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
      const input = { name: name.trim(), baseURL: baseURL.trim(), protocol, apiKey: apiKey.trim() || undefined, models, desktop: desktop.filter((id) => models.includes(id)) };
      onSaved(provider ? await api.updateProvider(provider.id, input) : await api.addProvider(input));
    } catch (failure) { setError(message(failure, "Couldn't save.")); }
    finally { setBusy(false); }
  }

  async function runDesktopCheck() {
    if (!provider) return;
    setChecking(true); setError("");
    try {
      const { results, settings } = await api.desktopCheck(provider.id, models.filter((id) => provider.models.includes(id)));
      setVerdicts(Object.fromEntries(results.map((result) => [result.model, result])));
      const saved = settings.providers.find((item) => item.id === provider.id);
      if (saved) setDesktop(saved.desktop);
    } catch (failure) { setError(message(failure, "Couldn't run the desktop check.")); }
    finally { setChecking(false); }
  }

  async function remove() {
    if (!provider || !confirm(`Remove ${provider.name}? Bots using its models switch to the default model.`)) return;
    setBusy(true);
    try { onSaved(await api.deleteProvider(provider.id)); } catch (failure) { setError(message(failure, "Couldn't remove it.")); setBusy(false); }
  }

  return (
    <form onSubmit={save} className="flex flex-col">
      <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />All providers</button>
      {!provider && (
        <div className="-mx-1 mb-4 flex flex-wrap gap-1.5 px-1">
          {PRESETS.map((preset) => (
            <button key={preset.name} type="button" onClick={() => choosePreset(preset)} aria-pressed={sameURL(baseURL, preset.baseURL)}
              className={cn("rounded-full border px-3 py-1.5 text-meta", sameURL(baseURL, preset.baseURL) ? "border-transparent bg-ink text-on-ink" : "border-rule text-soft hover:bg-hover hover:text-ink")}>
              {preset.name}
            </button>
          ))}
        </div>
      )}

      <Field label="Name" htmlFor="provider-name"><Input id="provider-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="OpenRouter" /></Field>
      <Field label="Base URL" htmlFor="provider-url">
        <Input id="provider-url" value={baseURL} onChange={(e) => { setBaseURL(e.target.value); setCheck({ state: "idle" }); }} required placeholder="https://openrouter.ai/api/v1" inputMode="url" autoCapitalize="off" spellCheck={false} />
      </Field>
      <div className="mb-3.5 flex flex-col gap-1.5">
        <span className="text-label text-muted">API format</span>
        <div className="flex rounded-full bg-raised p-[3px]" role="radiogroup" aria-label="API format">
          {([["openai", "OpenAI-compatible"], ["anthropic", "Anthropic (Claude)"]] as const).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={protocol === value} onClick={() => { setProtocol(value); setCheck({ state: "idle" }); }}
              className={cn("h-8 flex-1 rounded-full text-meta", protocol === value ? "bg-ground text-ink" : "text-muted hover:text-ink")}>{label}</button>
          ))}
        </div>
        {protocol === "openai" && models.some((id) => /^claude/i.test(id)) && !/openrouter\.ai/.test(baseURL) && (
          <span className="text-meta text-lemon">Claude models usually need the Anthropic format. If they fail, add them as a separate provider with this set to Anthropic.</span>
        )}
      </div>
      <Field label="API key" htmlFor="provider-key">
        <div className="relative">
          <Input id="provider-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} className="pr-11"
            placeholder={keepsKey ? `Saved key${provider?.keyHint ? ` ending ${provider.keyHint}` : ""} · leave blank to keep` : "Paste the API key (blank for local models)"} />
          <button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? "Hide key" : "Show key"}
            className="absolute top-1/2 right-3 -translate-y-1/2 text-muted hover:text-ink">{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
        {provider?.keySet && !keepsKey && <span className="flex items-center gap-1.5 text-meta text-lemon"><KeyRound size={12} />New address: enter its key. The saved key won't be sent here.</span>}
      </Field>
      <div className="mb-4 flex items-center gap-3">
        <Button variant="outline" size="pill" disabled={!baseURL.trim() || check.state === "checking"} onClick={() => void checkConnection()}>
          {check.state === "checking" ? <Loader2 size={14} className="animate-spin" /> : null}Check connection
        </Button>
        {check.message && <span className={cn("min-w-0 text-meta", check.state === "error" ? "text-danger" : "text-mint")}>{check.message}</span>}
      </div>

      <span className="mb-1.5 text-label text-muted">Models from this provider <span className="text-meta">· <Monitor size={11} className="inline align-[-1px]" /> = can drive a desktop</span></span>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {models.length === 0 && <span className="text-meta text-muted">None yet. Check the connection to pick from its list, or type a model id.</span>}
        {models.map((id) => {
          const drives = desktop.includes(id);
          const verdict = verdicts[id];
          return (
            <span key={id} title={verdict ? verdictText(verdict) : undefined}
              className={cn("inline-flex max-w-full items-center gap-1 rounded-full border py-1 pr-1 pl-1.5 text-meta", drives ? "border-sky/40 text-ink" : "border-rule text-soft")}>
              <button type="button" aria-pressed={drives} aria-label={drives ? `${id} can drive a desktop (tap to unmark)` : `Mark ${id} as able to drive a desktop`}
                onClick={() => setDesktop(drives ? desktop.filter((item) => item !== id) : [...desktop, id])}
                className={cn("shrink-0 rounded-full p-0.5", drives ? "text-sky" : "text-muted/50 hover:text-ink")}><Monitor size={12} /></button>
              <span className="truncate font-mono">{id}</span>
              {verdict && <span className={cn("shrink-0", verdict.canDrive ? "text-mint" : "text-muted")}>{verdict.canDrive ? "✓" : verdict.error ? "!" : "✗"}</span>}
              <button type="button" aria-label={`Remove ${id}`} onClick={() => setModels(models.filter((item) => item !== id))} className="shrink-0 rounded-full p-0.5 text-muted hover:text-ink"><X size={12} /></button>
            </span>
          );
        })}
      </div>
      {provider && models.length > 0 && (
        <div className="mb-3 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="pill" disabled={checking} onClick={() => void runDesktopCheck()}>
              {checking ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}Test desktop skills
            </Button>
            <span className="text-meta text-muted">{checking ? `Showing each model a screenshot… (about ${Math.ceil(models.length / 4) * 20}s)` : "Can each model read the screen and click accurately?"}</span>
          </div>
          {Object.values(verdicts).some((verdict) => !verdict.canDrive) && (
            <ul className="m-0 list-none p-0 text-meta text-muted">
              {Object.values(verdicts).filter((verdict) => !verdict.canDrive).map((verdict) => <li key={verdict.model}><span className="font-mono">{verdict.model}</span>: {verdictText(verdict)}</li>)}
            </ul>
          )}
        </div>
      )}
      <div className="mb-1 flex gap-1.5">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={available?.length ? "Search this provider's models…" : protocol === "anthropic" ? "Model id, e.g. claude-haiku-5-5" : "Model id, e.g. deepseek/deepseek-v4.1-flash"}
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

      {error && <p role="alert" className="m-0 mt-2 mb-1 text-label text-danger">{error}</p>}
      <div className="mt-4 flex gap-2">
        <Button type="submit" variant="primary" className="flex-1" disabled={busy || !baseURL.trim() || models.length === 0}>{busy ? "Saving…" : provider ? "Save" : "Add provider"}</Button>
        {provider && <Button variant="outline" aria-label={`Remove ${provider.name}`} disabled={busy} onClick={() => void remove()}><Trash2 size={15} /></Button>}
      </div>
    </form>
  );
}
