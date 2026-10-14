import { randomInt } from "node:crypto";
import { VERSION } from "../version.js";
import type { AccountSecret, Accounts } from "./accounts.js";

/** A login a Bot may use: titles and addresses only. Values never leave the server. */
export type VaultItem = { id: string; vaultId: string; vault: string; title: string; websites: string[] };
/** The values themselves, fetched only to type them into a page. */
export type Login = { username: string; password: string; totp: string | null; websites: string[] };

export interface VaultClient {
  vaults(): Promise<{ id: string; title: string }[]>;
  items(): Promise<VaultItem[]>;
  login(vaultId: string, itemId: string): Promise<Login>;
  createLogin(vaultId: string, input: { title: string; website: string; username: string; password: string }): Promise<VaultItem>;
}

export type OnePasswordAuth = { token: string } | { desktopAccount: string };

/** How long the list of logins is reused before asking 1Password again (it rate-limits reads). */
const LIST_TTL_MS = 5 * 60_000;

/** Signs in to 1Password through its SDK (a service-account token, or the 1Password app on this PC). */
export async function connectOnePassword(auth: OnePasswordAuth): Promise<VaultClient> {
  // Loaded on first use: the SDK carries a large WebAssembly core.
  const sdk = await import("@1password/sdk");
  const client = await sdk.createClient({
    auth: "token" in auth ? auth.token : new sdk.DesktopAuth(auth.desktopAccount),
    integrationName: "Colony",
    integrationVersion: VERSION,
  });
  let cache: { at: number; items: VaultItem[] } | null = null;

  const vaults = async () => (await client.vaults.list()).map((vault) => ({ id: vault.id, title: vault.title }));
  return {
    vaults,
    async items() {
      if (cache && Date.now() - cache.at < LIST_TTL_MS) return cache.items;
      const items: VaultItem[] = [];
      for (const vault of await vaults()) {
        for (const item of await client.items.list(vault.id)) {
          if (item.category !== sdk.ItemCategory.Login && item.category !== sdk.ItemCategory.Password) continue;
          items.push({ id: item.id, vaultId: vault.id, vault: vault.title, title: item.title, websites: item.websites.map((site) => site.url) });
        }
      }
      cache = { at: Date.now(), items };
      return items;
    },
    async login(vaultId, itemId) {
      const item = await client.items.get(vaultId, itemId);
      const field = (test: (field: (typeof item.fields)[number]) => boolean) => item.fields.find(test);
      const username = field((item) => item.id === "username")
        ?? field((item) => item.fieldType === sdk.ItemFieldType.Text && /user|e-?mail|login/i.test(item.title))
        ?? field((item) => item.fieldType === sdk.ItemFieldType.Email);
      const password = field((item) => item.id === "password") ?? field((item) => item.fieldType === sdk.ItemFieldType.Concealed && /pass/i.test(item.title));
      const totp = field((item) => item.fieldType === sdk.ItemFieldType.Totp);
      const code = totp?.details?.type === "Otp" ? totp.details.content.code ?? null : null;
      return { username: username?.value ?? "", password: password?.value ?? "", totp: code, websites: item.websites.map((site) => site.url) };
    },
    async createLogin(vaultId, input) {
      const item = await client.items.create({
        category: sdk.ItemCategory.Login,
        vaultId,
        title: input.title,
        fields: [
          { id: "username", title: "username", fieldType: sdk.ItemFieldType.Text, value: input.username },
          { id: "password", title: "password", fieldType: sdk.ItemFieldType.Concealed, value: input.password },
        ],
        websites: [{ url: input.website, label: "website", autofillBehavior: sdk.AutofillBehavior.AnywhereOnWebsite }],
      });
      cache = null;
      const vault = (await vaults()).find((entry) => entry.id === vaultId);
      return { id: item.id, vaultId, vault: vault?.title ?? "", title: item.title, websites: [input.website] };
    },
  };
}

export type VaultConnector = (auth: OnePasswordAuth) => Promise<VaultClient>;

export const authOf = (secret: AccountSecret | null): OnePasswordAuth | null =>
  secret?.kind !== "onepassword" ? null
    : secret.token ? { token: secret.token }
    : secret.desktopAccount ? { desktopAccount: secret.desktopAccount }
    : null;

/** One signed-in 1Password client per connected account, made on first use. */
export class Vaults {
  private clients = new Map<string, Promise<VaultClient>>();

  constructor(private accounts: Accounts, private connect: VaultConnector = connectOnePassword) {}

  client(accountId: string): Promise<VaultClient> {
    let client = this.clients.get(accountId);
    if (!client) {
      const auth = authOf(this.accounts.secret(accountId));
      if (!auth) return Promise.reject(new Error("That 1Password account isn't connected."));
      client = this.connect(auth);
      this.clients.set(accountId, client);
      client.catch(() => this.clients.delete(accountId));
    }
    return client;
  }

  /** Runs `use` with the account's client, signing in again once if the session lapsed (e.g. the app locked). */
  async with<T>(accountId: string, use: (client: VaultClient) => Promise<T>): Promise<T> {
    try {
      return await use(await this.client(accountId));
    } catch (error) {
      if (!/auth|session|locked|expired|unauthori[sz]ed|desktop/i.test(String(error))) throw error;
      this.forget(accountId);
      try {
        return await use(await this.client(accountId));
      } catch (again) {
        const secret = this.accounts.secret(accountId);
        const desktop = secret?.kind === "onepassword" && !secret.token;
        throw new Error(desktop
          ? "1Password is locked or asked for approval nobody gave. Ask the user to unlock the 1Password app on their PC, then try again."
          : `1Password refused the request: ${again instanceof Error ? again.message : again}`);
      }
    }
  }

  forget(accountId: string) {
    this.clients.delete(accountId);
  }
}

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

/** A strong random password with every kind of character, for new sign-ups. */
export function generatePassword(length = 24) {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let index = chars.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars.join("");
}

/**
 * Whether a page may receive this login: same site as one of the item's addresses
 * (its subdomains count), and https unless the item itself says http.
 */
export function originMatches(pageUrl: string, websites: string[]) {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return false; }
  const host = page.hostname.toLowerCase().replace(/^www\./, "");
  return websites.some((site) => {
    let saved: URL;
    try { saved = new URL(/^[a-z]+:\/\//i.test(site) ? site : `https://${site}`); } catch { return false; }
    if (page.protocol !== "https:" && !(page.protocol === "http:" && saved.protocol === "http:")) return false;
    const want = saved.hostname.toLowerCase().replace(/^www\./, "");
    return Boolean(want) && (host === want || host.endsWith(`.${want}`));
  });
}
