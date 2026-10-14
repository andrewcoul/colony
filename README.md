# Colony

A self-hosted team of AI Bots, in the spirit of Grok Bot. Each Bot is a persistent
teammate with a name, a face, its own memory and skills, and its own computer. Bots
work on a schedule, ask before anything leaves your PC, and reach you on your
phone. Colony runs on your own PC, works with any OpenAI-compatible API, and
has no accounts: your Tailscale network is the only way in.

- **Bots**: a roster with live presence (thinking, working, needs you, blocked).
  Each Bot has a persona (`SOUL.md`), a memory it curates (`MEMORY.md`), shared
  knowledge about you (`USER.md`), and reusable skills it writes itself.
- **Step log**: every tool call is a readable step ("Searched the web", "Ran
  `npm test` · 212 passed"), collapsed to one line when the work is done.
- **A computer per Bot**: a hardened Docker container with a persistent
  `/workspace`, plus a shell and file tools. You see a live terminal and the
  Bot's files.
- **Approvals**: pushing, publishing, posting data out, or deleting the workspace
  pauses the Bot and shows Approve/Deny. Approvals fail closed: a Stop, a
  timeout or a restart denies the action.
- **Routines**: "every weekday at 8:30, brief me on…" becomes a scheduled run
  whose result lands in the chat.
- **Phone**: an installable app over `tailscale serve`, with push notifications
  when a Bot finishes, a routine runs, or something needs your approval.
- **Groups**: group chats with a coordinator. `@Name` asks one Bot.
- **Web**: search and page reading through your self-hosted Firecrawl.

## Requirements

- Windows, macOS or Linux with **Node.js 22.13+** (Colony uses the built-in `node:sqlite`)
- An **OpenAI-compatible API**: OpenRouter, xAI, OpenCode Go, a local server…
- Optional: **Docker Desktop**, for Bot computers
- Optional: **self-hosted Firecrawl** at `127.0.0.1:3002`, for web search and reading
- Optional: **Tailscale**, for your phone and other devices

## Set up

```powershell
git clone <this repo> colony; cd colony
npm ci
npm run computer:build      # once, if you use Docker computers
npm run build
npm start                   # http://127.0.0.1:8787
```

Open Colony and tap the **gear** (Settings) to connect a model.
- Pick a provider preset or type any OpenAI-compatible base URL, then paste your
  API key.
- **Check connection** lists the provider's models; choose yours. The first is
  the default for new Bots.
- Switch keys, providers or models any time. The next reply uses them, with no
  restart.
- The key is saved in `data/settings.json`, readable only by you. Devices only
  ever see its last four characters.
- A saved key is never sent to a different address than the one it was saved for.

Optionally, `.env` (see `.env.example`) can supply starting values instead.

Everything Colony stores lives in `data/`: the SQLite database, settings, each
Bot's folder (`data/bots/<id>/` with `SOUL.md`, `MEMORY.md`, `skills/`,
`workspace/`), and the push keys. `data/` and `.env` are git-ignored.

Only run one Colony per `data/` folder. A second copy refuses to start, so
routines can't run twice.

### Start with Windows

Routines only run while Colony is running. To start it whenever you sign in:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1          # install
Start-ScheduledTask -TaskName Colony                                    # start now
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove  # uninstall
```

`scripts\run.ps1` keeps Colony running: it restarts it within 10 seconds if it exits,
starts Docker Desktop if needed, and logs to `data\colony.log`. After pulling changes:
`npm run build`, then `powershell -ExecutionPolicy Bypass -File scriptsestart.ps1` (it waits until Colony answers).

## Use it from your phone (Tailscale)

Colony listens on `127.0.0.1` only. `tailscale serve` gives it an HTTPS address
that only devices on your tailnet can reach:

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), turn
   on **MagicDNS** and **HTTPS certificates**.
2. On the PC running Colony:

   ```powershell
   tailscale serve --bg http://127.0.0.1:8787
   tailscale serve status    # shows https://<machine>.<tailnet>.ts.net
   ```

   If port 443 already serves something else, give Colony its own port:
   `tailscale serve --bg --https=8443 http://127.0.0.1:8787`. `--bg` keeps
   serving across reboots. Turn it off with `tailscale serve --https=443 off`
   (or `--https=8443 off`).
3. On your phone, install Tailscale, sign in to the same tailnet, and open the
   `https://…ts.net` address.
4. Install the app:
   - **iPhone** (Safari): Share → **Add to Home Screen**, then open Colony from
     the Home Screen. iOS only allows notifications for Home Screen apps.
   - **Android** (Chrome): menu → **Install app**.
5. Tap the **bell** on the Bots screen → **Turn on** → allow notifications. Then
   tap **Send a test**.

Notifications skip the chat you're looking at. If push stops working after you
wipe `data/`, turn notifications off and on again on each device.

**Security model:** there's no login, so anyone who can reach Colony can use your
Bots and their computers.
- Never use `tailscale funnel` for Colony. Colony refuses Funnel (public internet)
  traffic.
- To limit which tailnet accounts get in, list their logins in `.env`, e.g.
  `COLONY_ALLOWED_USERS=you@gmail.com`. Tailscale adds each request's login, and
  clients can't forge it.
- Requests made directly on the PC are always allowed.

## Bot computers

Each Bot with **Own computer** turned on gets the container `colony-<id>` from the
`colony-computer` image (Debian, Node 22, Python 3, git, ripgrep). Its limits:
- 2 GB of memory, 2 CPUs and 512 processes
- all Linux capabilities dropped except a few that file ownership needs
- `no-new-privileges`

`data/bots/<id>/workspace` is mounted at `/workspace` and persists. Commands
time out, and Stop kills their whole process group. Commands that push, publish,
send data out, or wipe the workspace need your approval. Turn a computer off from
its panel; it starts again on demand.

### The browser

Each computer also runs a real Chromium that Colony drives with Playwright.
- Bots read a page as numbered elements, then click, type, scroll and go back.
- It can only reach the public web. Your PC and local network are blocked.
- Its logins persist in `data/bots/<id>/browser`, outside the workspace.
- Clicks that would send something ask for approval first. That means submitting
  a POST form, or buttons like Send, Buy or Delete.
- Bots never type passwords, 2FA codes or payment details. They hand the browser
  to you (`browser_ask_user`) and wait.

Watch the browser live in the computer panel's **Browser** tab. Tap **Take over**
to click, type and scroll yourself. On a phone, the page switches to its mobile
layout while you're in control. You can also open a Bot's browser yourself to
sign in to a site ahead of time.

The image is about 1.8 GB with the browser and fonts. After an image update,
each computer is rebuilt on its next use; `/workspace` and browser logins are
kept.

## Web search (self-hosted Firecrawl)

Bots call your Firecrawl API directly (`COLONY_FIRECRAWL_URL`, default
`http://127.0.0.1:3002`). They have two tools:
- `web_search`: titles, URLs and snippets
- `web_read`: one public page as Markdown; private and loopback addresses are refused

Bots treat page content as data, never as instructions.

### Sharing search with coding agents

`npm run search:start` runs a small read-only MCP adapter at
`127.0.0.1:3003/mcp`, on the existing `firecrawl_backend` Docker network. Local
coding agents can then use your Firecrawl instead of Firecrawl's cloud. It has
two tools:
- `firecrawl_search`: up to 10 results
- `firecrawl_scrape`: one public page as Markdown, 20,000 characters by default

It rejects foreign `Host`/`Origin` headers, and scrape refuses private and
loopback addresses. Point agents at the adapter rather than the official
`firecrawl-mcp` package, which sends fields this Firecrawl version rejects:

```powershell
claude mcp add --transport http firecrawl http://127.0.0.1:3003/mcp -s user
codex mcp add firecrawl --url http://127.0.0.1:3003/mcp
```

For OpenCode, add to `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": { "firecrawl": { "type": "remote", "url": "http://127.0.0.1:3003/mcp", "enabled": true } }
```

After changing `mcp/`, rebuild with `docker compose -f firecrawl-mcp.compose.yml up -d --build`.

## Develop

```powershell
npm run dev      # server on 8787 (restarts on change) + Vite on http://localhost:5180
npm run check    # TypeScript, server and web
npm test         # Vitest: agent runs against a scripted model, approvals, routines, push, policies
```

To develop while your real Colony keeps running, give the dev copy its own data and ports:
`$env:COLONY_DATA_DIR="data-dev"; $env:COLONY_PORT="8790"; $env:COLONY_WEB_PORT="5181"; npm run dev`.

To try the dev build on your phone, run `tailscale serve --bg --https=8443 http://127.0.0.1:5180`.
Vite accepts `*.ts.net` hosts.

- **Server** (`server/`): Hono on Node, `node:sqlite`, and the Vercel AI SDK.
  - Persistent state goes through `Store`, and every change is a sequenced event.
  - The app follows those events over a resumable SSE stream (`/api/events`).
  - `AgentRunner` streams a Bot's turn into steps and presence.
  - Tools sit in `agent/` and `computer/`; routines, push and access control
    each have a small module.
- **Web** (`web/`): React 19, Vite and Tailwind v4.
  - Components follow the shadcn pattern on Base UI primitives (`components/ui`).
  - Types and schedule logic are shared with the server (`@shared`).

Ideas borrowed with thanks:
- [Hermes Agent](https://hermes-agent.nousresearch.com): Bot folders,
  memory and skills
- OpenBot: the approval gateway
- Grok Bot: the overall product shape
