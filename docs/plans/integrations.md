# Plan: Mail, Calendar and 1Password integrations

Status: built on branch `integrations`, 2026-10-14

Where the build differs from this plan:
- Per-Bot access is one row per Bot and account (`bot_access`: mail, calendar and vault levels), plus `vault_item_grants` for logins a Bot was allowed to use, instead of a generic scope table.
- Outlook new-mail checks poll the inbox for mail received after the last time seen, rather than using Graph delta queries. This is simpler, and a first check doesn't page through the whole inbox.
- 1Password can also sign in through the 1Password app on this PC (`DesktopAuth`), as well as with a service-account token.
- Not done yet: shell secrets (4.4).

## Goals

- Bots can search, read and draft email, and keep a calendar, in a personal Gmail account and an Outlook.com or Microsoft 365 account.
- Bots can sign in to websites with credentials from 1Password, and the model never sees a password, TOTP code or API key.
- Nothing leaves the PC without approval, in line with the rest of Colony: sending mail, sending invites and replying to invites all go through `ApprovalGate`.
- A routine can be triggered by new mail as well as by a schedule.

## Non-goals (v1)

- Deleting mail, managing filters or rules, out-of-office replies.
- Attachments beyond listing their names and sizes. Reading attachment contents comes later.
- Colony keeping its own secrets (provider keys, OAuth tokens) in 1Password.
- Being an MCP client. That is a separate piece of work.

---

## 1. Foundations (shared by all three integrations)

### 1.1 Connected accounts

New module `server/src/integrations/accounts.ts`.

- **Secrets file.** Refresh tokens, the 1Password service-account token and the OAuth client secrets go in `data/accounts.json`. It is written the same way as `settings.json`: write a temp file, rename it, `mode: 0o600`. Keeping them out of SQLite means a copy of the database never leaks tokens.
- **Redacted view.** `accountsView()` works like `settingsView()`. It returns `{ id, kind, label, email, scopes, status, connectedAt }` and never a token.
- **Migration** (append to `MIGRATIONS` in `server/src/db.ts`):
  - `accounts(id TEXT PK, kind TEXT, label TEXT, email TEXT, status TEXT, created_at)`. `kind` is `google | microsoft | onepassword`. `status` is `ok | needs_reauth`.
  - `account_sync(account_id, resource TEXT, cursor TEXT, updated_at, PK(account_id, resource))`. `resource` is `mail | calendar`.
  - `bot_grants(bot_id, account_id, scope TEXT, PK(bot_id, account_id, scope))`. Possible scopes are listed in 1.2.
- **Token refresh.** `accessToken(accountId)` caches the access token until about 60 s before it expires, then refreshes it. When a refresh token is rejected (`invalid_grant`), the account is marked `needs_reauth`, the user gets a push notification ("Reconnect Gmail"), and the tool returns a clear error to the Bot.
- **Routes** in `server/src/api.ts`, behind `tailnetOnly` like the rest:
  - `GET /api/accounts`
  - `DELETE /api/accounts/:id`, which also revokes the token where the provider supports it
  - `POST /api/accounts/google/start` and `GET /api/accounts/google/callback`
  - `POST /api/accounts/microsoft/start`, which returns the device code and keeps polling in the background
  - `POST /api/accounts/onepassword`
  - An SSE event `accounts.updated`, with no secrets in it.

### 1.2 Per-Bot access

Bots get nothing by default. Each Bot is given access to each account explicitly, on its profile (`web/src/components/BotProfile.tsx`), next to the "Own computer" switch.

| Scope | Allows |
|---|---|
| `mail.read` | `mail_search`, `mail_read` |
| `mail.draft` | the above, plus `mail_draft` and `mail_organize` (archive, mark read, label) |
| `mail.send` | the above, plus `mail_send` (still needs approval every time) |
| `calendar.read` | `calendar_list` |
| `calendar.write` | the above, plus `calendar_create`, `calendar_update` and `calendar_respond` |
| `vault.use` | `vault_list`, `browser_login`, `browser_fill_totp` |
| `vault.save` | `vault_save` |

`index.ts` already decides each Bot's tools in its `tools(bot)` callback. It would add the mail, calendar and vault tools only when the Bot has at least one grant, so a Bot without access never sees those tools. Tools also check the grant again when they run, since grants can change in the middle of a run.

### 1.3 Treat mail and web content as untrusted

Once a Bot can read email, anyone who can email you can put instructions in front of it. Three defences:

1. **Fence the content.** `mail_read`, `calendar_list` (event descriptions) and `browser_read` wrap third-party text in a marked block, and the system prompt says that text inside it is data, never instructions.
2. **Approval on every outbound step.** Sends always go through approval, and the approval card shows the real recipients and body, fetched again by the server rather than taken from the model.
3. **No secret values in context.** Because of 1Password's design (section 4), a Bot that has been tricked has no secret values to leak.

### 1.4 Secret scrubber

New module `server/src/agent/scrub.ts`. It keeps a list of every secret value Colony has put into a page or a process during the current run. Every tool output, step title and persisted `messages.steps` entry passes through `scrub()`, which replaces those exact strings with `[secret]`.

This is a second line of defence, not a guarantee: a command can encode a secret before printing it. Section 4.4 explains why secrets in the shell stay behind a separate switch.

---

## 2. Mail and calendar providers

### 2.1 Shape

`server/src/integrations/mail/types.ts`:

```ts
interface MailProvider {
  search(q: MailQuery, limit: number): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage>;            // body as plain text, attachments listed by name
  thread(threadId: string): Promise<MailMessage[]>;
  createDraft(d: DraftInput): Promise<Draft>;         // to, cc, subject, body, inReplyTo?
  updateDraft(id: string, d: DraftInput): Promise<Draft>;
  getDraft(id: string): Promise<Draft>;
  sendDraft(id: string): Promise<void>;
  organize(ids: string[], op: OrganizeOp): Promise<void>;
  changes(cursor: string | null): Promise<{ added: MailSummary[]; cursor: string }>;
}
interface CalendarProvider {
  list(from: Date, to: Date): Promise<CalEvent[]>;
  create(e: EventInput): Promise<CalEvent>;
  update(id: string, e: Partial<EventInput>): Promise<CalEvent>;
  respond(id: string, r: "accept" | "tentative" | "decline", note?: string): Promise<void>;
}
```

`MailQuery` is structured: `{ from, to, subject, text, after, before, unread, folder }`. Each backend turns it into its own search syntax (Gmail's `q` operators, Graph's `$search` and `$filter`), so the model doesn't have to learn two of them.

Both backends call the APIs with plain `fetch`, not `googleapis` or `@azure/msal-node`. Colony uses only a handful of endpoints, the SDKs are large, and plain fetch is easy to mock in tests. HTML bodies become text through a small converter, and each body is cut to about 20k characters.

### 2.2 Gmail

- **Client.** Each user creates a Google Cloud "Desktop app" OAuth client and pastes its ID and secret into Settings → Accounts. The Settings page links a short walkthrough.
  - Colony can't ship a shared Google client ID: the Gmail scopes it needs are "restricted", and a client used by many people would have to pass Google's verification and a paid security assessment. A personal project used only by its owner doesn't need either.
- **Scopes.** `gmail.modify` (read, draft, send, label; one restricted scope) and `calendar.events`, plus `openid email`.
- **Sign-in flow.** Loopback redirect with PKCE. Google doesn't allow its device-code flow for Gmail or Calendar scopes.
  - On the PC (desktop app or a browser on the PC): the server starts a one-off listener on `127.0.0.1:<random port>`, opens Google's consent screen, catches the redirect, exchanges the code and closes the listener.
  - From the phone: the redirect to `127.0.0.1` fails to load in the phone's browser, which is expected. Colony asks the user to paste that failed URL into a box, then takes the code from it and exchanges it. This is the same approach rclone uses.
- **The 7-day trap.** If the user's Google app is left in "Testing", its sign-in expires every 7 days. The walkthrough tells the user to switch it to "In production". Google then shows a one-time "Google hasn't verified this app" warning, which the user clicks through.
  - Google's docs disagree on whether this works. They only state the 7-day limit for "Testing", and they exempt apps that only their owner uses from verification. But one policy page says restricted scopes "can't be used in production apps without review". rclone tells its users to do exactly this, so it appears to work in practice. Test it with a real account before shipping (phase 1 exit check). If it doesn't work, the fallback is to stay in Testing and remind the user to reconnect every week, which is poor.
  - Tokens also stop working after a password change or six months without use. `needs_reauth` handles both.
- **Endpoints.**
  - Search: `users.messages.list?q=`
  - Read: `users.messages.get?format=full`
  - Threads: `users.threads.get`
  - Drafts: `users.drafts.create`, `users.drafts.update`, `users.drafts.get`, then `users.drafts.send`
  - Organize: `users.messages.batchModify`
- **New mail.** Poll `users.history.list?startHistoryId=…&historyTypes=messageAdded`. If Google returns 404 because the history id is too old, reset the cursor from `users.getProfile().historyId` and skip the gap rather than replaying old mail as "new".
- **Calendar.** `events.list` on `primary` with `singleEvents=true`, `timeMin` and `timeMax`. The v1 trigger is mail only, so calendar change tracking (`syncToken`) isn't needed.

### 2.3 Outlook / Microsoft 365

- **Client.** The user registers an app in Entra (about 5 minutes; the Settings page links a walkthrough):
  - Supported account types: "Accounts in any organizational directory and personal Microsoft accounts".
  - "Allow public client flows" turned on.
  - No client secret.
  - Shipping a shared Colony client ID is possible later (it's a public client with no secret). For v1, each user registers their own app so there's no dependency on a Colony-owned registration.
- **Scopes.** `offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite`.
- **Sign-in flow.** Device code against `https://login.microsoftonline.com/common/oauth2/v2.0/devicecode`.
  - Colony shows the code and the `microsoft.com/devicelogin` link, so this works from the phone.
  - The server polls the token endpoint at the interval Microsoft returns.
  - Work tenants whose admins block user consent will fail at this step. Show Microsoft's error text and explain that an admin has to approve the app.
- **Refresh tokens.** About 90 days, renewed on each use. A Bot that checks mail daily keeps the account connected. `needs_reauth` covers the rest.
- **Endpoints.**
  - Search: `GET /me/messages?$search=` or `$filter`
  - Read: `GET /me/messages/{id}`, sent with `Prefer: outlook.body-content-type="text"`
  - Drafts: `POST /me/messages` creates a draft. `POST /me/messages/{id}/createReply` creates a reply draft. `PATCH` edits a draft.
  - Send: `POST /me/messages/{id}/send`
  - Organize: `PATCH` (`isRead`) and `POST …/move` (to Archive)
- **New mail.** `GET /me/mailFolders/inbox/messages/delta`. Store the `@odata.deltaLink` and follow `@odata.nextLink` until the last page.
- **Calendar.** `GET /me/calendarView?startDateTime&endDateTime` for listing. Nothing in v1 needs calendar change tracking, so leave out `calendarView/delta`. It's also unconfirmed whether that endpoint works for personal accounts.
- **Throttling.** On a 429, honour `Retry-After`.
- **No IMAP.** Outlook.com no longer accepts plain passwords over IMAP, so IMAP would need OAuth anyway. Graph is simpler.

### 2.4 Tools

New file `server/src/agent/mailTools.ts`. All of these are `ColonyTool`s, and all of them take an optional `account` argument, which defaults to the Bot's only mail account.

| Tool | Approval | Notes |
|---|---|---|
| `mail_search` | no | At most 25 results: `{id, threadId, from, subject, date, snippet, unread}` |
| `mail_read` | no | `{id}` or `{threadId}`. Body is fenced as untrusted (1.3). |
| `mail_draft` | no | Creates or updates a draft, which stays in the user's own Drafts folder. Returns the draft id and a preview. |
| `mail_send` | **always** | `{draftId}` only. The server fetches the draft and shows the real To, Cc, Subject and body on the approval card. It stores a hash of the draft and checks it again before sending, so the draft can't change between approval and send. |
| `mail_organize` | no | Archive, mark read or unread, add or remove a label. No delete in v1. |
| `calendar_list` | no | A date range. Descriptions are fenced as untrusted. |
| `calendar_create`, `calendar_update` | only when the event has attendees | The approval rule is "anything that reaches another person needs approval", so solo blocks need none. |
| `calendar_respond` | **always** | It notifies the organizer. |

Step titles follow `describe()`: "Searched mail: from:alice after:Oct 1" and "Drafted reply to Alice: Re: Q3 numbers". The `policy.ts` rules for `sendmail` and `mail` in the shell stay as they are.

### 2.5 New-mail trigger for routines

- `shared/schedule.ts` gains a new trigger: `{ kind: "mail", accountId, match?: MailQuery }`. The `routines` tool lets a Bot create one, for example "every time mail from my bank arrives, summarise it", if the Bot holds `mail.read` on that account.
- `server/src/integrations/poller.ts` holds a `MailPoller` class, modelled on `RoutineScheduler`:
  - An `unref`'d interval, started from `index.ts`.
  - Every 2 minutes it polls only the accounts that have at least one mail-triggered routine.
  - It updates `account_sync.cursor` and matches new messages against each routine.
  - It starts a run through the same path `RoutineScheduler` uses, with a hidden prompt listing the new messages' ids, senders and subjects (not the bodies).
- **Batching.** Messages that arrive within one poll make one run. At most one run per routine every 10 minutes; anything that arrives in between is added to the next run.
- Gmail can push through Pub/Sub, but that needs a Google Cloud topic and renewing the watch every week. Polling every 2 minutes is good enough for v1.

---

## 3. Settings UI

- `SettingsDialog.tsx` gets an **Accounts** section next to Providers:
  - Connected accounts, with status, the account's email address, and Reconnect and Remove buttons.
  - "Connect Gmail" opens a two-step form: (1) the client ID and secret, with a "how to create one" link; (2) Connect.
  - "Connect Outlook" opens a one-field form for the client ID, then shows the device code and link with a live "waiting…" state.
  - "Connect 1Password" opens a one-field form for the service-account token, then shows the vaults it can reach.
- `BotProfile.tsx` gets an **Access** section: one row per account, with scope checkboxes from 1.2.
- `web/src/lib/api.ts` gets the matching `api.accounts.*` calls.

---

## 4. 1Password

### 4.1 Approach

Colony's server signs in to 1Password with a **service account** through `@1password/sdk`. The server fetches each credential itself and types it straight into the Bot's browser over the existing Playwright connection.

The model only ever sees item titles, website addresses and "filled". It never sees passwords, TOTP codes or API keys. This is the pattern 1Password recommends for agents: credentials are injected, never shown to the model.

Why not the other options:

- **Connect server:** an extra container, and only worth it for its higher rate limits, which Colony doesn't need.
- **`op` CLI:** an extra binary to install and parse.
- **Secure Agentic Autofill and "1Password for Claude":** they need Browserbase, or Chrome plus Claude Desktop, so they can't drive a browser in a Docker container.

**Setup.** The user creates a vault just for Colony (e.g. "Colony"), copies or moves into it the logins their Bots should use, and creates a service account with read access to that vault (plus write if they want `vault_save`). Service accounts can't reach a Personal or Private vault, which makes this the right boundary: Bots see only what is in that vault.

**Plan check.** 1Password's docs list service-account rate limits for Business, Teams and Families. Whether Individual accounts can create service accounts is unconfirmed (see Open questions). If they can't, the fallback is `DesktopAuth`:

- The SDK asks the 1Password desktop app on the same PC, which shows a biometric prompt.
- It's fine for chats where the user is present.
- Access lapses after 10 minutes idle or when 1Password locks. A routine would then fail the vault step, and push "Unlock 1Password" to the user.

**Rate limits** (Families or Teams: 1,000 reads an hour). The item list is cached for 5 minutes. Secrets are fetched one at a time when needed and never cached to disk.

### 4.2 Tools

New file `server/src/agent/vaultTools.ts`.

| Tool | Returns to the model | Approval |
|---|---|---|
| `vault_list` `{query?}` | `{itemId, title, websites[], hasTotp}`. No username or password. | no |
| `browser_login` `{itemId, usernameRef, passwordRef, submit?}` | `"Signed in as <username> on github.com"` plus a fresh snapshot | First time each Bot uses each item, then remembered. Can be revoked in Access. |
| `browser_fill_totp` `{itemId, ref}` | `"Filled code"` | Same grant as `browser_login` |
| `vault_save` `{title, website, username, ref}` | `"Saved"` | always |

`vault_save` covers sign-ups: the server generates a strong password, saves a new Login item into the Colony vault, and types the password into `ref`.

**Origin check (critical).** Before filling anything, `browser_login` reads the page's origin through Playwright, not from the model. It refuses unless the origin matches one of the item's website addresses (same registrable domain, https only). A phishing page reached through a tricked Bot never receives a password.

**Filling.** Use the same Playwright `fill()` that `browser_type` uses. The filled values go into the scrubber's list for the rest of the run (1.4). Playwright snapshots don't show password-field values, but a username or an echoed TOTP code could appear on the page, so scrubbing those matters.

This replaces most uses of `browser_ask_user`. That tool stays for CAPTCHAs, passkeys, and logins that aren't in the vault.

### 4.3 Grants

`vault.use` and `vault.save` are per Bot, per 1Password account (1.2). On top of that, each item is approved once per Bot, the first time that Bot uses it ("Scout wants to sign in to github.com with 'GitHub – work'"). Those approvals are stored in `bot_grants` as `item:<itemId>`.

### 4.4 Shell secrets: phase 4, off by default

Later, `computer_run` could take `secrets: { GITHUB_TOKEN: "op://Colony/GitHub/token" }`. The server would resolve them, pass them only as environment variables to that one `docker exec`, and scrub the output.

Once a value sits in an environment the Bot controls, though, a tricked Bot can encode it and send it out. So:

- Every item has its own "allow in shell" switch, off by default.
- Every command that uses a secret needs approval.
- The `policy.ts` rules for outbound commands apply as normal.

---

## 5. Phases

1. **Foundations.** Accounts store and migration, per-Bot grants and the Access UI, scrubber, untrusted-content fencing.
   - Exit check: with test accounts on the PC, confirm that a Google client set to "In production" keeps working past 7 days. Run this in the background while phase 2 is built.
2. **Mail and calendar.** Outlook first: device code is the simpler flow, and it shakes out the provider interface. Then Gmail, then both calendars.
3. **1Password.** Service-account sign-in, `vault_list`, `browser_login`, `browser_fill_totp`, item grants. Can be built in parallel with phase 2, because it only depends on phase 1.
4. **Extras.** New-mail trigger, `vault_save`, shell secrets.

## 6. Tests (Vitest, alongside the code)

- Provider tests with a mocked `fetch`:
  - The query translation for each backend.
  - Following Graph's `nextLink` and `deltaLink`.
  - Gmail's history 404 fallback and Calendar's 410 resync.
  - A refresh failure marks the account `needs_reauth`.
- Run tests in the style of `run.test.ts`, using `MockLanguageModelV4`:
  - `mail_send` waits for approval; deny means not sent.
  - The approval card shows the server's copy of the draft.
  - A draft changed after approval is refused.
  - Inviting attendees needs approval; a solo event doesn't.
- Vault tests with a fake SDK client and a fake page:
  - A mismatched origin is refused.
  - The secret never appears in the tool result, the step title, or `messages.steps`.
  - A first-time item asks for approval; a granted item doesn't.
- `scrub()` unit tests.
- A `MailPoller` test with a fake provider covers batching and the 10-minute limit.

## Open questions

1. Which 1Password plan does the user have? If it's Individual, check whether service accounts are available; otherwise v1 uses `DesktopAuth` (attended only).
2. Are the target Microsoft accounts personal (Outlook.com) or a work M365 tenant? A work tenant may need admin approval for the app.
3. Is Colony ever served over HTTPS on a `*.ts.net` name (`tailscale serve`)? If so, Gmail could use a normal "Web application" client with that address as its redirect. Connecting from the phone would then just work, with no pasting.
