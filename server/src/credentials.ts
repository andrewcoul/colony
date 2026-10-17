import fs from "node:fs";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * The model sign-ins (ChatGPT, OpenCode), one per pi provider id, and the members' OpenCode API
 * key (under its own id, "opencode-key"), in data/credentials.json.
 * Readable only by you; tokens never leave the server. Writes for one provider run one at a
 * time, so a refresh and a sign-in never both rotate a token.
 */
export class FileCredentialStore implements CredentialStore {
  private credentials: Record<string, Credential> = {};
  private chains = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();

  constructor(private file: string) {
    try { this.credentials = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Credential>; } catch { /* None saved yet. */ }
  }

  /** Whether a provider has a credential saved (possibly expired). */
  has(providerId: string) { return providerId in this.credentials; }

  /** The last four characters of a saved API key (to tell keys apart), or null. The key itself never leaves. */
  keyHint(id: string): string | null {
    const credential = this.credentials[id];
    return credential?.type === "api_key" && credential.key && credential.key.length >= 8 ? credential.key.slice(-4) : null;
  }

  /** Saved details that aren't secret, e.g. the account a sign-in belongs to. */
  detail(providerId: string): string | null {
    const credential = this.credentials[providerId] as (Credential & { label?: unknown }) | undefined;
    return typeof credential?.label === "string" ? credential.label : null;
  }

  /** Runs `listener` after every change. Returns a function that stops it. */
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async read(providerId: string) { return this.credentials[providerId]; }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.credentials).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.serial(providerId, async () => {
      const current = this.credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      this.credentials = { ...this.credentials, [providerId]: next };
      this.persist();
      return next;
    });
  }

  delete(providerId: string) {
    return this.serial(providerId, async () => {
      if (!(providerId in this.credentials)) return;
      const { [providerId]: _, ...rest } = this.credentials;
      this.credentials = rest;
      this.persist();
    });
  }

  private serial<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const queued = (this.chains.get(providerId) ?? Promise.resolve()).catch(() => {}).then(task);
    const tail = queued.catch(() => {});
    this.chains.set(providerId, tail);
    void tail.then(() => { if (this.chains.get(providerId) === tail) this.chains.delete(providerId); });
    return queued;
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write then rename, so a crash never leaves half a file.
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    for (const listener of this.listeners) listener();
  }
}
