import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, Copy, KeyRound, LogOut, Mail, Plus, X } from "lucide-react";
import { auth } from "../lib/auth";
import { signOut } from "./SignIn";
import type { PersonSummary } from "@shared/types";
import { api, type Invite, type InviteSent, type MembersView, type Settings, type WebSignIn } from "../lib/api";
import { cn } from "../lib/utils";
import { money } from "./Spending";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);
const capText = (cap: number | null) => (cap === null ? "no cap set" : `${money(cap)} a month`);
/** A typed amount: blank is no cap; anything else must be a number of dollars. */
const parseCap = (typed: string): number | null | undefined => {
  if (!typed.trim()) return null;
  const amount = Number(typed.replace(/^\$/, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

function Back({ onBack }: { onBack: () => void }) {
  return <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1 self-start text-label text-muted hover:text-ink"><ChevronLeft size={15} />Settings</button>;
}

/** Settings › People (the admin's): everyone's spending this month, caps and computers; turning members off or removing them. */
export function PeoplePage({ onBack }: { onBack: () => void }) {
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => { void api.people().then(setPeople).catch(() => setError("Couldn't load people.")); }, []);
  useEffect(reload, [reload]);
  const members = people?.filter((person) => person.role === "member") ?? [];
  return (
    <div className="flex flex-col">
      <Back onBack={onBack} />
      <p className="m-0 mb-3 text-meta leading-relaxed text-muted">
        Colony is invite-only: each person you invite gets their own account. Nobody sees anyone else's Bots, chats or files, you included.
      </p>
      {error && <p role="alert" className="m-0 mb-2 text-label text-danger">{error}</p>}
      <InvitesSection onChanged={reload} />
      <WebSignInSection />
      {people?.filter((person) => person.role === "admin").map((person) => (
        <div key={person.id} className="mb-2 flex items-center gap-3 rounded-xl border border-rule px-3.5 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="truncate text-sm font-medium">{person.login ?? person.name} <span className="font-normal text-muted">· admin (you)</span></strong>
            <span className="truncate text-meta text-muted">{money(person.spent)} this month · {person.bots} Bot{person.bots === 1 ? "" : "s"} · {person.computers} computer{person.computers === 1 ? "" : "s"} on</span>
          </span>
        </div>
      ))}
      {people && members.length === 0 && <p className="m-0 text-label text-muted">No members yet.</p>}
      {members.map((person) => <MemberRow key={person.id} person={person} onChanged={reload} onError={setError} />)}
    </div>
  );
}

function MemberRow({ person, onChanged, onError }: { person: PersonSummary; onChanged: () => void; onError: (text: string) => void }) {
  const [cap, setCap] = useState(person.cap === null ? "" : String(person.cap));
  const [busy, setBusy] = useState(false);
  const act = async (task: () => Promise<unknown>, fallback: string) => {
    setBusy(true); onError("");
    try { await task(); onChanged(); } catch (failure) { onError(message(failure, fallback)); } finally { setBusy(false); }
  };
  const typed = parseCap(cap);
  const capChanged = typed !== undefined && typed !== person.cap;
  return (
    <div className={cn("mb-2 flex flex-col gap-2 rounded-xl border border-rule px-3.5 py-3", person.disabled && "opacity-70")}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="truncate text-sm font-medium">{person.login ?? person.name}{person.disabled && <span className="font-normal text-danger"> · turned off</span>}</strong>
        <span className="truncate text-meta text-muted">
          {money(person.spent)} this month of {capText(person.cap)}{person.cap !== null && !person.capOwn ? " (the default)" : ""} · {person.bots} Bot{person.bots === 1 ? "" : "s"} · {person.computers} computer{person.computers === 1 ? "" : "s"} on
        </span>
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" inputMode="decimal" aria-label={`${person.login ?? person.name}'s monthly cap in dollars`} className="h-8 w-28 text-[13px] tabular-nums" />
        <Button variant="outline" size="pill" disabled={busy || !capChanged} onClick={() => void act(() => api.updatePerson(person.id, { cap: typed ?? null }), "Couldn't set the cap.")}>Set cap</Button>
        {person.capOwn && <Button variant="outline" size="pill" disabled={busy} onClick={() => void act(() => api.updatePerson(person.id, { cap: "default" }), "Couldn't change the cap.")}>Use default</Button>}
        <span className="flex-1" />
        <Button variant="outline" size="pill" disabled={busy} onClick={() => void act(() => api.updatePerson(person.id, { disabled: !person.disabled }), "Couldn't change that.")}>
          {person.disabled ? "Turn on" : "Turn off"}
        </Button>
        <Button variant="outline" size="pill" disabled={busy} onClick={() => {
          const who = person.login ?? person.name;
          if (!confirm(`Remove ${who}'s account? They're signed out and can't sign in again. Their Bots, chats and files are kept.`)) return;
          const deleteData = confirm(`Also delete ${who}'s Bots, chats, files and spending for good? Yours stay either way.\n\nOK deletes them; Cancel keeps them.`);
          void act(() => api.removePerson(person.id, deleteData), "Couldn't remove them.");
        }}>Remove</Button>
      </div>
    </div>
  );
}

/** Settings › Members' models (the admin's): the members' OpenCode Zen API key, the Zen models members may use, and the default cap. */
export function MembersModelsPage({ members, onBack, onSaved }: { members: MembersView; onBack: () => void; onSaved: (settings: Settings) => void }) {
  const [key, setKey] = useState("");
  const [models, setModels] = useState(members.models);
  const [preferred, setPreferred] = useState(members.defaultModel);
  const [cap, setCap] = useState(members.defaultCap === null ? "" : String(members.defaultCap));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (task: () => Promise<Settings>, fallback: string) => {
    setBusy(true); setError("");
    try { onSaved(await task()); } catch (failure) { setError(message(failure, fallback)); } finally { setBusy(false); }
  };
  const needle = draft.trim().toLowerCase();
  const suggestions = members.catalog.filter((model) => !models.includes(model.id) && (!needle || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)));
  const typedCap = parseCap(cap);
  const same = models.length === members.models.length && models.every((id, index) => id === members.models[index]);
  const changed = !same || preferred !== members.defaultModel || (typedCap !== undefined && typedCap !== members.defaultCap);

  return (
    <div className="flex flex-col">
      <Back onBack={onBack} />
      <div className="mb-5 flex flex-col gap-2.5 rounded-xl border border-rule p-3.5">
        <span className="flex items-center gap-2 text-sm"><KeyRound size={15} className="shrink-0 text-muted" />
          {members.keySet ? <span className="flex items-center gap-1 text-mint"><Check size={14} />OpenCode Zen API key set{members.keyHint ? ` (ends in ${members.keyHint})` : ""}</span> : <span className="text-lemon">No OpenCode Zen API key yet</span>}
        </span>
        <span className="text-meta leading-relaxed text-muted">Members' Bots run on OpenCode Zen with this key, never with your own sign-ins. Make one in the OpenCode Console (opencode.ai, API keys). Without it, members can't use any model.</span>
        <div className="flex gap-2">
          <Input value={key} onChange={(e) => setKey(e.target.value)} type="password" autoComplete="off" placeholder={members.keySet ? "Paste a new key to replace it" : "Paste an OpenCode Zen API key"} aria-label="Members' OpenCode Zen API key" className="h-9 flex-1 font-mono text-[13px]" />
          <Button variant="outline" size="pill" disabled={busy || !key.trim()} onClick={() => void run(async () => { const next = await api.setMemberKey(key.trim()); setKey(""); return next; }, "Couldn't save the key.")}>Save</Button>
          {members.keySet && <Button variant="outline" size="pill" disabled={busy} onClick={() => { if (confirm("Remove the members' key? Members' Bots stop until you add one.")) void run(() => api.clearMemberKey(), "Couldn't remove the key."); }}>Remove</Button>}
        </div>
      </div>

      <span className="mb-1.5 text-label text-muted">Models members may use</span>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {models.length === 0 && <span className="text-meta text-muted">None: members can't use any model.</span>}
        {models.map((id) => (
          <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-rule py-1 pr-1 pl-2.5 text-meta text-soft">
            <span className="truncate font-mono">{id}</span>
            {members.prices[id] && <span className="shrink-0 text-muted">{members.prices[id].input || members.prices[id].output ? `$${members.prices[id].input}/$${members.prices[id].output}` : "free"}</span>}
            <button type="button" aria-label={`Remove ${id}`} onClick={() => setModels(models.filter((item) => item !== id))} className="shrink-0 rounded-full p-0.5 text-muted hover:text-ink"><X size={12} /></button>
          </span>
        ))}
      </div>
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Search OpenCode Zen's ${members.catalog.length} models…`} aria-label="Find a model for members" className="mb-1 h-9 font-mono text-[13px]" />
      {draft.trim() && suggestions.length > 0 && (
        <div className="mb-2 flex max-h-40 flex-col overflow-y-auto rounded-lg border border-rule p-1">
          {suggestions.map((model) => (
            <button key={model.id} type="button" onClick={() => { setModels([...models, model.id]); setDraft(""); }} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-hover">
              <Plus size={12} className="shrink-0 text-muted" /><span className="truncate font-mono text-[12px] text-soft">{model.id}</span>
            </button>
          ))}
        </div>
      )}
      <label className="mt-2 mb-3 flex flex-col gap-1.5">
        <span className="text-label text-muted">Default for members' new Bots</span>
        <select value={models.includes(preferred) ? preferred : models[0] ?? ""} onChange={(e) => setPreferred(e.target.value)}
          className="h-[38px] w-full rounded-lg border border-rule bg-ground px-3 font-mono text-[13px] text-ink outline-none">
          {models.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      <label className="mb-1 flex flex-col gap-1.5">
        <span className="text-label text-muted">Monthly cap for members without their own <span className="text-meta">· dollars, blank for none</span></span>
        <Input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap set" inputMode="decimal" className="h-9 w-32 text-[13px] tabular-nums" />
      </label>
      <span className="text-meta text-muted">Months run on Chicago time. Once a member's spending this month reaches their cap, their Bots wait until the 1st.</span>
      {error && <p role="alert" className="m-0 mt-2 text-label text-danger">{error}</p>}
      <Button variant="primary" className="mt-4" disabled={busy || !changed || typedCap === undefined}
        onClick={() => void run(() => api.setMemberPolicy({ models, defaultModel: models.includes(preferred) ? preferred : models[0] ?? "", defaultCap: typedCap ?? null }), "Couldn't save.")}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

const STATUS: Record<Invite["status"], string> = { pending: "waiting", used: "joined", revoked: "withdrawn", expired: "expired" };
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Invites: send one, and see, resend or withdraw them. Without email set up, each comes with a link to copy. */
function InvitesSection({ onChanged }: { onChanged: () => void }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ email: string; link: string; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(() => { void api.invites().then(setInvites).catch(() => {}); }, []);
  useEffect(reload, [reload]);
  const sent = (result: InviteSent) => {
    setLink(result.emailed ? null : { email: result.invite.email, link: result.link ?? "", note: result.error });
    reload(); onChanged();
  };
  const act = async (task: () => Promise<InviteSent | void>, fallback: string) => {
    setBusy(true); setError("");
    try { const result = await task(); if (result) sent(result); else reload(); } catch (failure) { setError(message(failure, fallback)); } finally { setBusy(false); }
  };
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-rule p-3.5">
      <span className="text-label text-muted">Invite someone</span>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void act(async () => { const result = await api.invite(email.trim()); setEmail(""); return result; }, "Couldn't invite them."); }}>
        <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="their@email.com" aria-label="Email to invite" className="h-9 flex-1 text-[13px]" />
        <Button variant="outline" size="pill" disabled={busy || !email.trim()}><Mail size={14} />Invite</Button>
      </form>
      {link && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-raised/60 p-2.5">
          <span className="text-meta text-muted">{link.note ?? "Email isn't set up, so send this link yourself."} It works once, for {link.email}.</span>
          <div className="flex gap-2">
            <Input value={link.link} readOnly aria-label="Invite link" className="h-8 flex-1 font-mono text-[12px]" onFocus={(e) => e.target.select()} />
            <Button variant="outline" size="pill" onClick={() => void navigator.clipboard?.writeText(link.link)}><Copy size={13} />Copy</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="m-0 text-label text-danger">{error}</p>}
      {invites.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {invites.map((invite) => (
            <li key={invite.id} className="flex items-center gap-2 border-t border-rule py-2 first:border-t-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{invite.email}</span>
                <span className="text-meta text-muted">{STATUS[invite.status]} · {invite.status === "used" && invite.usedAt ? `joined ${day(invite.usedAt)}` : `until ${day(invite.expiresAt)}`}</span>
              </span>
              {(invite.status === "pending" || invite.status === "expired") && (
                <Button variant="outline" size="pill" disabled={busy} onClick={() => void act(() => api.resendInvite(invite.id), "Couldn't resend it.")}>Resend</Button>
              )}
              {invite.status === "pending" && (
                <Button variant="outline" size="pill" disabled={busy} onClick={() => void act(() => api.revokeInvite(invite.id), "Couldn't withdraw it.")}>Withdraw</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Set up web sign-in": a password for one of the admin's own emails (from the tailnet or this PC). */
function WebSignInSection() {
  const [info, setInfo] = useState<WebSignIn | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void api.webSignIn().then((next) => { setInfo(next); setEmail(next.adminEmails[0] ?? ""); }).catch(() => {}); }, []);
  if (!info) return null;
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-rule p-3.5">
      <span className="text-label text-muted">Set up web sign-in for yourself</span>
      {!info.enabled ? <span className="text-meta text-muted">Web sign-in is off on this Colony (BETTER_AUTH_SECRET isn't set).</span>
        : !info.adminEmails.length ? <span className="text-meta text-muted">Add your email to COLONY_ADMIN_EMAILS first.</span> : (
          <form className="flex flex-col gap-2" onSubmit={(event) => {
            event.preventDefault(); setError(""); setNote("");
            void api.setUpAdminSignIn(email, password).then(() => { setPassword(""); setNote(`Done: sign in on the web as ${email}.`); }, (failure) => setError(message(failure, "Couldn't set it up.")));
          }}>
            <select value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Your admin email" className="h-9 rounded-lg border border-rule bg-ground px-3 text-[13px] text-ink outline-none">
              {info.adminEmails.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <div className="flex gap-2">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoComplete="new-password" placeholder="A password, 10 characters or more" aria-label="Web sign-in password" className="h-9 flex-1 text-[13px]" />
              <Button variant="outline" size="pill" disabled={password.length < 10}>Save</Button>
            </div>
          </form>
        )}
      {note && <span className="text-meta text-mint">{note}</span>}
      {error && <span role="alert" className="text-meta text-danger">{error}</span>}
    </div>
  );
}

/** "Sign out", for people who came through the website (never on the tailnet or this PC). */
export function SignOutButton() {
  const [web, setWeb] = useState(false);
  useEffect(() => { void auth.status().then((status) => setWeb(status.via === "cloudflare" && status.signedIn)); }, []);
  if (!web) return null;
  return <Button variant="outline" size="pill" className="self-start" onClick={() => void signOut()}><LogOut size={14} />Sign out</Button>;
}

/** What your Bots know about you (your USER.md), to read and change. */
export function AboutYou() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void api.me().then(({ about }) => { setText(about); setSaved(about); }).catch(() => setError("Couldn't load what your Bots know about you.")); }, []);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label text-muted">What your Bots know about you <span className="text-meta">· USER.md, one note a line</span></span>
      <textarea value={text ?? ""} disabled={text === null} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000}
        className="resize-y rounded-lg border border-rule bg-ground px-3 py-2 text-[13px] leading-relaxed text-ink outline-none" />
      {error && <span role="alert" className="text-meta text-danger">{error}</span>}
      {text !== null && text !== saved && (
        <Button variant="outline" size="pill" className="self-start" onClick={() => void api.setAbout(text).then(({ about }) => { setText(about); setSaved(about); }).catch((failure) => setError(message(failure, "Couldn't save.")))}>Save</Button>
      )}
    </label>
  );
}
