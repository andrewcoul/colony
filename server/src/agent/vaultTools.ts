import { z } from "zod";
import type { BrowserService } from "../computer/browser.js";
import { allows } from "../integrations/accounts.js";
import type { Integrations } from "../integrations/index.js";
import { generatePassword, originMatches, type VaultItem } from "../integrations/onepassword.js";
import type { Account, VaultAccess } from "../shared/types.js";
import { pageTitle, ref, view } from "./browserTools.js";
import type { ColonyTool, ToolContext, ToolRegistry } from "./tools.js";

export type VaultBrowser = Pick<BrowserService, "currentUrl" | "fieldType" | "type" | "snapshot">;

const quote = (text: string, max = 40) => `“${text.length > max ? text.slice(0, max - 1) + "…" : text}”`;
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const itemRef = z.string().trim().regex(/^[\w-]+\/[\w-]+$/, "Use the item from vault_list, like vault/item.").describe("The login's item from vault_list.");

/** The 1Password accounts this Bot may use at the needed level. */
function vaultAccounts(services: Integrations, botId: string, needed: VaultAccess): Account[] {
  return services.accounts.forBot(botId)
    .filter(({ account, access }) => account.kind === "onepassword" && allows.vault(access.vault, needed))
    .map(({ account }) => account);
}

/** Finds a login among the Bot's 1Password accounts. */
async function findItem(services: Integrations, botId: string, item: string): Promise<{ account: Account; item: VaultItem }> {
  const [vaultId, itemId] = item.split("/");
  for (const account of vaultAccounts(services, botId, "use")) {
    const items = await services.vaults.with(account.id, (client) => client.items());
    const found = items.find((entry) => entry.vaultId === vaultId && entry.id === itemId);
    if (found) return { account, item: found };
  }
  throw new Error("That login isn't in any vault you can use. List them with vault_list.");
}

/** The page the Bot is on, which must be one of the login's websites. */
function checkOrigin(browser: VaultBrowser, botId: string, title: string, websites: string[]) {
  const url = browser.currentUrl(botId);
  if (!url) throw new Error("Your browser isn't open. Open the site's sign-in page first.");
  if (!websites.length) throw new Error(`“${title}” has no website saved in 1Password, so Colony can't tell which site it's for. Ask the user to add the website to the item.`);
  if (!originMatches(url, websites)) {
    throw new Error(`This page (${hostOf(url)}) isn't a website saved for “${title}” (${websites.map(hostOf).join(", ")}). Only fill it on the real site: open its sign-in page first.`);
  }
  return url;
}

/** Asks once per Bot and login; after that the Bot may use it freely (you can take access away in its profile). */
async function allowOnce(services: Integrations, ctx: ToolContext, account: Account, item: VaultItem, url: string, username: string) {
  if (services.accounts.itemAllowed(ctx.botId, account.id, item.id)) return;
  const approved = await ctx.gate.request({
    botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: "vault_login", approverId: account.personId,
    summary: `${ctx.botName} wants to sign in to ${hostOf(url)} with “${item.title}”`,
    detail: `1Password: ${item.title} (${item.vault})${username ? `\nUsername: ${username}` : ""}\nOn: ${url}\n\n${ctx.botName} never sees the password. Approving lets ${ctx.botName} use this login from now on.`,
    reason: "First use of this login · asks once",
  }, ctx.signal);
  if (!approved) throw new Error("The user didn't allow this login. Don't retry; ask them to sign in themselves with browser_ask_user if needed.");
  services.accounts.allowItem(ctx.botId, account.id, item.id);
}

/** Puts a value into a field. Passwords only go into password fields, so they never show on the page. */
async function fill(browser: VaultBrowser, botId: string, field: string, value: string, kind: "username" | "password" | "code", submit: boolean) {
  const { tag, type } = await browser.fieldType(botId, field);
  if (tag !== "input" && tag !== "textarea") throw new Error(`${field} isn't a text field; pick the ${kind} field's ref from the page.`);
  if (kind === "password" && type !== "password") throw new Error(`${field} isn't a password field, so the password would show on the page. Pick the password field's ref.`);
  if (kind !== "password" && type === "password") throw new Error(`${field} is a password field; pick the ${kind} field's ref.`);
  await browser.type(botId, field, value, submit);
}

/** 1Password tools: sign Bots in to websites without the model ever seeing a password. */
export function vaultTools(browser: VaultBrowser, services: Integrations) {
  const list: ColonyTool<{ query?: string }, { count: number }> = {
    description: "List the website logins in 1Password you may use (titles and websites only; you never see passwords). Sign in with browser_login.",
    inputSchema: z.object({ query: z.string().trim().max(100).optional().describe("Part of a title or website.") }),
    describe: ({ query }) => `Looked for logins${query ? ` for ${quote(query, 30)}` : ""}`,
    summarize: (output) => `${output.count} login${output.count === 1 ? "" : "s"}`,
    execute: async ({ query }, ctx) => {
      const accounts = vaultAccounts(services, ctx.botId, "use");
      if (!accounts.length) throw new Error("You don't have 1Password access. The user can give it to you in your profile, under Access.");
      const needle = query?.toLowerCase();
      const logins = [];
      for (const account of accounts) {
        for (const item of await services.vaults.with(account.id, (client) => client.items())) {
          if (needle && !item.title.toLowerCase().includes(needle) && !item.websites.some((site) => site.toLowerCase().includes(needle))) continue;
          logins.push({ item: `${item.vaultId}/${item.id}`, title: item.title, websites: item.websites.map(hostOf), ...(services.accounts.itemAllowed(ctx.botId, account.id, item.id) ? { allowed: true } : {}) });
        }
      }
      return { count: logins.length, logins: logins.slice(0, 50) };
    },
  };

  const login: ColonyTool<{ item: string; usernameRef?: string; passwordRef?: string; submit?: boolean }, string> = {
    description: "Sign in on the current page with a login from 1Password: Colony types the username and password into the fields you name, and you never see the password. Only works on the login's own website. The first time you use a login, the user approves it. For sites that ask for the username and password on separate pages, call it once per page.",
    inputSchema: z.object({
      item: itemRef,
      usernameRef: ref.optional().describe("The username or email field's ref, if this page has one."),
      passwordRef: ref.optional().describe("The password field's ref, if this page has one."),
      submit: z.boolean().optional().describe("Press Enter after filling."),
    }),
    describe: () => "Signed in with 1Password",
    summarize: pageTitle,
    execute: async ({ item: reference, usernameRef, passwordRef, submit }, ctx) => {
      if (!usernameRef && !passwordRef) throw new Error("Give the username field, the password field, or both.");
      const { account, item } = await findItem(services, ctx.botId, reference);
      checkOrigin(browser, ctx.botId, item.title, item.websites);
      const secret = await services.vaults.with(account.id, (client) => client.login(item.vaultId, item.id));
      // Check again against the item itself, not the cached list.
      const url = checkOrigin(browser, ctx.botId, item.title, secret.websites);
      if (passwordRef && !secret.password) throw new Error(`“${item.title}” has no password in 1Password.`);
      if (usernameRef && !secret.username) throw new Error(`“${item.title}” has no username in 1Password.`);
      await allowOnce(services, ctx, account, item, url, secret.username);
      ctx.secrets.add(secret.password);
      if (usernameRef) await fill(browser, ctx.botId, usernameRef, secret.username, "username", Boolean(submit && !passwordRef));
      if (passwordRef) await fill(browser, ctx.botId, passwordRef, secret.password, "password", Boolean(submit));
      const filled = [usernameRef && "username", passwordRef && "password"].filter(Boolean).join(" and ");
      return `Filled the ${filled} for “${item.title}”${submit ? " and submitted" : ""}.\n\n${view(await browser.snapshot(ctx.botId))}`;
    },
  };

  const totp: ColonyTool<{ item: string; ref: string; submit?: boolean }, string> = {
    description: "Fill a two-factor (one-time) code from 1Password into the current page's code field, for a login that has one. You never see the code.",
    inputSchema: z.object({ item: itemRef, ref: ref.describe("The code field's ref."), submit: z.boolean().optional() }),
    describe: () => "Filled a one-time code from 1Password",
    summarize: pageTitle,
    execute: async ({ item: reference, ref: field, submit }, ctx) => {
      const { account, item } = await findItem(services, ctx.botId, reference);
      checkOrigin(browser, ctx.botId, item.title, item.websites);
      const secret = await services.vaults.with(account.id, (client) => client.login(item.vaultId, item.id));
      const url = checkOrigin(browser, ctx.botId, item.title, secret.websites);
      if (!secret.totp) throw new Error(`“${item.title}” has no one-time code set up in 1Password. Ask the user to take over with browser_ask_user.`);
      await allowOnce(services, ctx, account, item, url, secret.username);
      ctx.secrets.add(secret.totp);
      await fill(browser, ctx.botId, field, secret.totp, "code", Boolean(submit));
      return `Filled the one-time code for “${item.title}”${submit ? " and submitted" : ""}.\n\n${view(await browser.snapshot(ctx.botId))}`;
    },
  };

  const save: ColonyTool<{ title?: string; username: string; usernameRef?: string; passwordRef: string; submit?: boolean }, string> = {
    description: "When signing up for a website: Colony makes a strong new password, saves the login to 1Password for this site, and types it into the page's password field. You never see the password. The user approves first.",
    inputSchema: z.object({
      title: z.string().trim().max(100).optional().describe("What to call it in 1Password; defaults to the site's name."),
      username: z.string().trim().min(1).max(200).describe("The username or email to sign up with."),
      usernameRef: ref.optional().describe("The username or email field's ref, to fill it too."),
      passwordRef: ref.describe("The new-password field's ref."),
      submit: z.boolean().optional(),
    }),
    describe: () => "Saved a new login to 1Password",
    summarize: pageTitle,
    execute: async ({ title, username, usernameRef, passwordRef, submit }, ctx) => {
      const account = vaultAccounts(services, ctx.botId, "save")[0];
      if (!account) throw new Error("You can't save logins to 1Password. The user can allow it in your profile, under Access.");
      const url = browser.currentUrl(ctx.botId);
      if (!url || !/^https:\/\//i.test(url)) throw new Error("Open the site's sign-up page (https) first.");
      const site = new URL(url);
      const name = title || hostOf(url);
      const secret = services.accounts.secret(account.id);
      const vaults = await services.vaults.with(account.id, (client) => client.vaults());
      const vault = vaults.find((entry) => secret?.kind === "onepassword" && entry.id === secret.saveVaultId) ?? vaults[0];
      if (!vault) throw new Error("1Password shows no vault to save into.");
      // Check the field before asking, so an approval never goes to waste.
      if ((await browser.fieldType(ctx.botId, passwordRef)).type !== "password") throw new Error(`${passwordRef} isn't a password field. Pick the new-password field's ref.`);
      const approved = await ctx.gate.request({
        botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: "vault_save", approverId: account.personId,
        summary: `${ctx.botName} wants to save a new login for ${site.hostname}`,
        detail: `1Password: ${name} (${vault.title})\nUsername: ${username}\nWebsite: ${site.origin}\n\nColony makes a strong password, saves it, and types it in. ${ctx.botName} never sees it.`,
        reason: "Adds to your 1Password · always asks",
      }, ctx.signal);
      if (!approved) throw new Error("The user didn't want this login saved. Don't retry; ask how they'd like to sign up.");
      const password = generatePassword();
      ctx.secrets.add(password);
      const item = await services.vaults.with(account.id, (client) => client.createLogin(vault.id, { title: name, website: site.origin, username, password }));
      services.accounts.allowItem(ctx.botId, account.id, item.id);
      if (usernameRef) await fill(browser, ctx.botId, usernameRef, username, "username", false);
      await fill(browser, ctx.botId, passwordRef, password, "password", Boolean(submit));
      return `Saved “${name}” to 1Password (item ${item.vaultId}/${item.id}) and filled the new password${submit ? ", then submitted" : ""}. If the page has a "confirm password" field, use browser_login with this item and that field.\n\n${view(await browser.snapshot(ctx.botId))}`;
    },
  };

  return { vault_list: list, browser_login: login, browser_fill_totp: totp, vault_save: save } satisfies ToolRegistry;
}

/** The 1Password tools this Bot may use (it needs its own browser). */
export function vaultToolsFor(tools: ReturnType<typeof vaultTools>, services: Integrations, botId: string): ToolRegistry {
  const levels = services.accounts.forBot(botId).filter(({ account }) => account.kind === "onepassword").map(({ access }) => access.vault);
  return {
    ...(levels.some((level) => allows.vault(level, "use")) ? { vault_list: tools.vault_list, browser_login: tools.browser_login, browser_fill_totp: tools.browser_fill_totp } : {}),
    ...(levels.some((level) => allows.vault(level, "save")) ? { vault_save: tools.vault_save } : {}),
  };
}
