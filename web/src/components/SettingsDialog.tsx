import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines, Check, ChevronLeft, ChevronRight, Coins, Loader2, LogOut, Monitor, Plus, Server, X } from "lucide-react";
import type { Price } from "@shared/types";
import type { AccountKind } from "@shared/types";
import { api, type DesktopVerdict, type MemberSettings, type ProviderView, type Settings } from "../lib/api";
import { AccountsList, ConnectAccount, KIND_NAMES } from "./AccountsSettings";
import { ModelSignIn } from "./ModelSignIn";
import { VoiceSettingsEditor } from "./VoiceSettings";
import { ThisPcSettings } from "./ThisPcSettings";
import { SpendingPage } from "./Spending";
import { desktopApp } from "../lib/desktop";
import { useIsAdmin, useLive } from "../lib/live";
import { openUpdates } from "../lib/settings";
import { pending, useUpdates, WEB_VERSION } from "../lib/updates";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

/** One line on a desktop-check result. */
const verdictText = (verdict: DesktopVerdict) => verdict.error ? `couldn't check (${verdict.error})`
  : verdict.canDrive ? "reads the screen and clicks accurately"
  : verdict.reads ? "reads the screen but misses its clicks"
  : verdict.points ? "clicks well but misread the screen"
  : "can't read screenshots";

const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** Settings: all of it for the admin; for a member, what's theirs. */
export function SettingsDialog(props: DialogProps) {
  return useIsAdmin() ? <AdminSettingsDialog {...props} /> : <MemberSettingsDialog {...props} />;
}

/** A member's Settings: who they're signed in as, the models their Bots may use, and their spending. */
function MemberSettingsDialog({ open, onOpenChange }: DialogProps) {
  const me = useLive((s) => s.me);
  const [settings, setSettings] = useState<MemberSettings | null>(null);
  const [spendingOpen, setSpendingOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setSpendingOpen(false); setError("");
    void api.memberSettings().then(setSettings).catch(() => setError("Couldn't load settings."));
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={spendingOpen ? "Spending" : "Settings"} description={undefined}>
      {spendingOpen ? <SpendingPage onBack={() => setSpendingOpen(false)} /> : (
        <div className="flex flex-col gap-2">
          <p className="m-0 mb-2 text-label text-muted">Signed in as <span className="text-ink">{me?.login ?? me?.name}</span>.</p>
          <div className="mb-2 flex flex-col gap-1">
            <span className="text-label text-muted">Models your Bots may use</span>
            <span className="text-meta text-muted">{settings ? settings.models.map((model) => model.model).join(", ") || "None yet. Ask the person who runs this Colony." : "…"}</span>
          </div>
          <SettingsRow icon={<Coins size={16} />} title="Spending" onClick={() => setSpendingOpen(true)} detail="What your Bots cost this month, by Bot" />
          <p className="m-0 mt-1 text-meta text-muted">
            {settings?.voice.on ? `Voice calls are on${settings.voice.allowCalls ? ` · Bots can ring you, not ${settings.voice.quietFrom}–${settings.voice.quietTo}` : ""}.` : "Voice calls are off."}
          </p>
          {error && <p role="alert" className="m-0 mt-2 text-label text-danger">{error}</p>}
          <p className="m-0 mt-4 border-t border-rule pt-4 text-meta text-muted">Colony {WEB_VERSION} · Models, voice, accounts and updates are set by the person who runs this Colony.</p>
        </div>
      )}
    </Dialog>
  );
}

/** Where models come from (ChatGPT and OpenCode sign-ins), the default model for new Bots, and connected accounts. */
function AdminSettingsDialog({ open, onOpenChange }: DialogProps) {
  const models = useLive((s) => s.models);
  const updates = useUpdates();
  const news = pending(updates);
  const [settings, setSettings] = useState<Settings | null>(null);
  // The provider whose page is open.
  const [editing, setEditing] = useState<string | null>(null);
  /** Connecting an account: which kind (null = pick one), or undefined when not connecting. */
  const [connecting, setConnecting] = useState<AccountKind | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [voicing, setVoicing] = useState(false);
  const [lending, setLending] = useState(false);
  const [spendingOpen, setSpendingOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEditing(null); setConnecting(undefined); setVoicing(false); setLending(false); setSpendingOpen(false); setError("");
    void api.settings().then(setSettings).catch(() => setError("Couldn't load settings."));
  }, [open]);
  const reload = useCallback(() => { void api.settings().then(setSettings).catch(() => {}); }, []);
  const provider = settings?.providers.find((item) => item.id === editing) ?? null;

  async function setDefault(ref: string) {
    setError("");
    try { setSettings(await api.setDefaultModel(ref)); } catch (failure) { setError(message(failure, "Couldn't change the default.")); }
  }

  const groups = [...new Set(models.map((item) => item.providerId))].map((id) => models.filter((item) => item.providerId === id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}
      title={connecting !== undefined ? `Connect ${connecting ? KIND_NAMES[connecting] : "an account"}` : provider ? provider.name : voicing ? "Voice" : lending ? "This PC" : spendingOpen ? "Spending" : "Settings"}
      description={undefined}>
      {connecting !== undefined ? (
        <ConnectAccount kind={connecting} onBack={() => setConnecting(undefined)} />
      ) : spendingOpen ? (
        <SpendingPage onBack={() => setSpendingOpen(false)} />
      ) : lending ? (
        <ThisPcSettings onBack={() => setLending(false)} />
      ) : voicing && settings ? (
        <VoiceSettingsEditor settings={settings} onBack={() => setVoicing(false)} onSaved={setSettings} />
      ) : provider && settings ? (
        <ProviderPage
          key={provider.id}
          provider={provider}
          settings={settings}
          onBack={() => setEditing(null)}
          onChanged={reload}
          onSaved={(next) => { setSettings(next); setEditing(null); }}
        />
      ) : (
        <div className="flex flex-col">
          {models.length > 0 && (
            <label className="mb-4 flex flex-col gap-1.5">
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
          <ProviderList providers={settings?.providers ?? []} onOpen={setEditing} />
          <div className="flex flex-col gap-2">
            <SettingsRow icon={<Coins size={16} />} title="Spending" onClick={() => setSpendingOpen(true)}
              detail="What your Bots cost this month, by Bot" />
            <SettingsRow icon={<AudioLines size={16} />} title="Voice" onClick={() => setVoicing(true)} disabled={!settings}
              detail={settings?.voice.baseURL
                ? settings.voice.allowCalls ? `Talk to your Bots · they can ring you · quiet ${settings.voice.quietFrom}–${settings.voice.quietTo}` : "Talk to your Bots · they can't ring you"
                : "Off · add an OpenAI API key to talk to Bots"} />
            {desktopApp?.node && (
              <SettingsRow icon={<Monitor size={16} />} title="This PC" onClick={() => setLending(true)}
                detail="Lend this computer to your Bots: browser, screen, terminal, files" />
            )}
          </div>
          <AccountsList onConnect={setConnecting} />
          {error && <p role="alert" className="m-0 mt-3 text-label text-danger">{error}</p>}
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

/** A row that opens a page of Settings. */
function SettingsRow({ icon, title, detail, onClick, disabled }: { icon: React.ReactNode; title: string; detail: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3 text-left hover:bg-hover disabled:opacity-60">
      <span className="flex shrink-0 justify-center text-muted">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="truncate text-sm font-medium">{title}</strong>
        <span className="truncate text-meta text-muted">{detail}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-muted" />
    </button>
  );
}

/** The providers: ChatGPT, OpenCode Go and OpenCode Zen, each with its sign-in and the models picked from it. */
function ProviderList({ providers, onOpen }: { providers: ProviderView[]; onOpen: (id: string) => void }) {
  return (
    <div className="mb-4 flex flex-col">
      <span className="text-label text-muted">Models</span>
      <span className="mb-2 text-meta text-muted">Sign in with your subscriptions, then pick the models your Bots may use. No API keys.</span>
      <div className="flex flex-col gap-2">
        {providers.map((provider) => (
          <button key={provider.id} type="button" onClick={() => onOpen(provider.id)}
            className="flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3 text-left hover:bg-hover">
            <Server size={16} className="shrink-0 text-muted" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="truncate text-sm font-medium">{provider.name}</strong>
              <span className={cn("truncate text-meta", provider.signedIn ? "text-muted" : "text-lemon")}>
                {!provider.signIn ? ".env" : provider.signedIn ? "Signed in" : "Not signed in"} · {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
              </span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-muted" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** A provider's page: its sign-in, the models picked from it, which can drive a desktop, and their prices. */
function ProviderPage({ provider, settings, onBack, onChanged, onSaved }: {
  provider: ProviderView; settings: Settings; onBack: () => void; onChanged: () => void; onSaved: (settings: Settings) => void;
}) {
  const signIn = settings.signIns.find((item) => item.id === provider.signIn) ?? null;
  // OpenCode Go and Zen share one sign-in.
  const sharing = settings.providers.filter((item) => item.signIn && item.signIn === provider.signIn && item.id !== provider.id).map((item) => item.name);
  // The dev server's models come from .env.
  const editable = Boolean(provider.signIn);
  const [models, setModels] = useState<string[]>(provider.models);
  // Which models can drive a desktop (set by the desktop check or by hand).
  const [desktop, setDesktop] = useState<string[]>(provider.desktop);
  const [verdicts, setVerdicts] = useState<Record<string, DesktopVerdict>>({});
  const [checking, setChecking] = useState(false);
  const [draft, setDraft] = useState("");
  // Prices as typed, dollars per million tokens; models with a built-in price start with it.
  const [prices, setPrices] = useState<Record<string, { input: string; output: string }>>(() =>
    Object.fromEntries(Object.entries(provider.prices).map(([id, price]) => [id, { input: String(price.input), output: String(price.output) }])));
  const [pricing, setPricing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const names = useMemo(() => new Map(provider.catalog.map((model) => [model.id, model.name])), [provider.catalog]);
  const suggestions = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    return provider.catalog.filter((model) => !models.includes(model.id) && (!needle || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)));
  }, [provider.catalog, draft, models]);

  /** Only the prices you changed: a cleared one goes back to the built-in price. */
  function changedPrices() {
    const next: Record<string, Price | null> = {};
    for (const id of models) {
      const typed = prices[id];
      const shown = provider.prices[id];
      if (!typed) continue;
      if (!typed.input.trim() && !typed.output.trim()) { if (shown) next[id] = null; continue; }
      const price = { input: Number(typed.input), output: Number(typed.output) };
      if (!Number.isFinite(price.input) || !Number.isFinite(price.output)) continue;
      if (price.input !== shown?.input || price.output !== shown?.output) next[id] = { ...price, ...(shown?.cached !== undefined ? { cached: shown.cached } : {}) };
    }
    return next;
  }
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);
  const changed = !same(models, provider.models) || !same(desktop.filter((id) => models.includes(id)), provider.desktop) || Object.keys(changedPrices()).length > 0;

  const addModel = (id: string) => {
    if (id && !models.includes(id)) setModels([...models, id]);
    setDraft("");
  };

  async function save() {
    setBusy(true); setError("");
    try { onSaved(await api.updateProvider(provider.id, { models, desktop: desktop.filter((id) => models.includes(id)), prices: changedPrices() })); }
    catch (failure) { setError(message(failure, "Couldn't save.")); }
    finally { setBusy(false); }
  }

  async function runDesktopCheck() {
    setChecking(true); setError("");
    try {
      const { results, settings: next } = await api.desktopCheck(provider.id, models.filter((id) => provider.models.includes(id)));
      setVerdicts(Object.fromEntries(results.map((result) => [result.model, result])));
      const saved = next.providers.find((item) => item.id === provider.id);
      if (saved) setDesktop(saved.desktop);
    } catch (failure) { setError(message(failure, "Couldn't run the desktop check.")); }
    finally { setChecking(false); }
  }

  async function signOut() {
    if (!signIn || !confirm(`Sign out of ${signIn.name}? Bots using its models switch to the default model.`)) return;
    setBusy(true); setError("");
    try { await api.signOut(signIn.id); onChanged(); } catch (failure) { setError(message(failure, "Couldn't sign out.")); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col">
      <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>

      {signIn && (
        <div className="mb-5 flex flex-col gap-2.5 rounded-xl border border-rule p-3.5">
          {signIn.signedIn ? (
            <div className="flex items-center gap-3">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-mint"><Check size={16} className="shrink-0" />
                <span className="truncate">Signed in to {signIn.name}{signIn.account ? ` as ${signIn.account}` : ""}</span>
              </span>
              <Button variant="outline" size="pill" disabled={busy} onClick={() => void signOut()}><LogOut size={14} />Sign out</Button>
            </div>
          ) : (
            <>
              <span className="text-label leading-relaxed text-soft">
                {signIn.id === "chatgpt" ? "Uses your ChatGPT plan." : "Uses your OpenCode subscription: Go, or your Zen balance."}
                {sharing.length > 0 && ` One sign-in covers ${sharing.join(" and ")} too.`}
              </span>
              <ModelSignIn id={signIn.id} onDone={onChanged} />
            </>
          )}
        </div>
      )}

      <span className="mb-1.5 text-label text-muted">Models your Bots may use <span className="text-meta">· <Monitor size={11} className="inline align-[-1px]" /> = can drive a desktop</span></span>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {models.length === 0 && <span className="text-meta text-muted">None yet. Pick from the list below.</span>}
        {models.map((id) => {
          const drives = desktop.includes(id);
          const verdict = verdicts[id];
          return (
            <span key={id} title={verdict ? verdictText(verdict) : names.get(id)}
              className={cn("inline-flex max-w-full items-center gap-1 rounded-full border py-1 pr-1 pl-1.5 text-meta", drives ? "border-sky/40 text-ink" : "border-rule text-soft")}>
              <button type="button" aria-pressed={drives} aria-label={drives ? `${id} can drive a desktop (tap to unmark)` : `Mark ${id} as able to drive a desktop`}
                onClick={() => setDesktop(drives ? desktop.filter((item) => item !== id) : [...desktop, id])}
                className={cn("shrink-0 rounded-full p-0.5", drives ? "text-sky" : "text-muted/50 hover:text-ink")}><Monitor size={12} /></button>
              <span className="truncate font-mono">{id}</span>
              {verdict && <span className={cn("shrink-0", verdict.canDrive ? "text-mint" : "text-muted")}>{verdict.canDrive ? "✓" : verdict.error ? "!" : "✗"}</span>}
              {editable && <button type="button" aria-label={`Remove ${id}`} onClick={() => setModels(models.filter((item) => item !== id))} className="shrink-0 rounded-full p-0.5 text-muted hover:text-ink"><X size={12} /></button>}
            </span>
          );
        })}
      </div>
      {provider.signedIn && provider.models.length > 0 && (
        <div className="mb-3 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="pill" disabled={checking} onClick={() => void runDesktopCheck()}>
              {checking ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}Test desktop skills
            </Button>
            <span className="text-meta text-muted">{checking ? `Showing each model a screenshot… (about ${Math.ceil(provider.models.length / 4) * 20}s)` : "Can each model read the screen and click accurately?"}</span>
          </div>
          {Object.values(verdicts).some((verdict) => !verdict.canDrive) && (
            <ul className="m-0 list-none p-0 text-meta text-muted">
              {Object.values(verdicts).filter((verdict) => !verdict.canDrive).map((verdict) => <li key={verdict.model}><span className="font-mono">{verdict.model}</span>: {verdictText(verdict)}</li>)}
            </ul>
          )}
        </div>
      )}
      {editable && (
        <>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Search ${provider.name}'s ${provider.catalog.length} models…`}
            aria-label="Find a model" autoCapitalize="off" spellCheck={false} className="mb-1 h-9 font-mono text-[13px]"
            onKeyDown={(e) => { if (e.key === "Enter" && suggestions[0]) { e.preventDefault(); addModel(suggestions[0].id); } }} />
          {suggestions.length > 0 && (
            <div className="mb-2 flex max-h-52 flex-col overflow-y-auto rounded-lg border border-rule p-1">
              {suggestions.map((model) => (
                <button key={model.id} type="button" onClick={() => addModel(model.id)} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-hover">
                  <Plus size={12} className="shrink-0 text-muted" />
                  <span className="truncate font-mono text-[12px] text-soft">{model.id}</span>
                  {model.name !== model.id && <span className="truncate text-meta text-muted">{model.name}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {models.length > 0 && (
        <div className="mt-2 flex flex-col">
          <button type="button" onClick={() => setPricing(!pricing)} aria-expanded={pricing} className="flex items-center gap-1 self-start text-label text-muted hover:text-ink">
            Prices <span className="text-meta">· for Spending, $ per million tokens</span><ChevronRight size={14} className={cn("transition-transform", pricing && "rotate-90")} />
          </button>
          {pricing && (
            <div className="mt-2 flex flex-col gap-1.5">
              <span className="grid grid-cols-[1fr_5.5rem_5.5rem] gap-2 text-meta text-muted"><span>Model</span><span>In</span><span>Out</span></span>
              {models.map((id) => (
                <span key={id} className="grid grid-cols-[1fr_5.5rem_5.5rem] items-center gap-2">
                  <span className="truncate font-mono text-[12px] text-soft" title={id}>{id}</span>
                  {(["input", "output"] as const).map((side) => (
                    <Input key={side} value={prices[id]?.[side] ?? ""} placeholder="no price" inputMode="decimal" aria-label={`${id} price ${side === "input" ? "in" : "out"}`} className="h-8 text-[13px] tabular-nums"
                      onChange={(e) => setPrices({ ...prices, [id]: { input: prices[id]?.input ?? "", output: prices[id]?.output ?? "", [side]: e.target.value } })} />
                  ))}
                </span>
              ))}
              <span className="text-meta text-muted">Subscriptions don't bill per token, so a price here only estimates what the same use would cost. A model with no price counts tokens only.</span>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="m-0 mt-2 mb-1 text-label text-danger">{error}</p>}
      <Button variant="primary" className="mt-4" disabled={busy || !changed} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
    </div>
  );
}
