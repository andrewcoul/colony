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
- **Updates**: the server and the desktop app update themselves from GitHub
  Releases. Update the server from any device, even your phone.

## Requirements

- Windows, macOS or Linux with **Node.js 22.19+** (Colony uses the built-in `node:sqlite`)
- An **OpenAI-compatible API**: OpenRouter, xAI, OpenCode Go, a local server…
- Optional: **Docker Desktop**, for Bot computers
- Optional: **self-hosted Firecrawl** at `127.0.0.1:3002`, for web search and reading
- Optional: **Tailscale**, for your phone and other devices

## Install

**The server** (Windows; needs Node.js 22.19+). In PowerShell:

```powershell
irm https://github.com/andrewcoul/colony/releases/latest/download/install-colony-server.ps1 | iex
```

The installer:
- downloads the latest release and checks it against the release's checksums;
- installs it in `%LOCALAPPDATA%\Colony`;
- starts it, and again every time you sign in.

Then open http://127.0.0.1:8787. Options: `-InstallDir`, `-DataDir` (where
your Bots live), `-EnvFile` (a `.env` to start from). To pass them, run
`& ([scriptblock]::Create((irm <same URL>))) -DataDir D:\Colony`.

**The desktop app** (Windows): download `Colony-Setup-<version>.exe` from the
[latest release](https://github.com/andrewcoul/colony/releases/latest).
- It finds a Colony on the same PC by itself.
- Otherwise, give it the server's address, e.g. its `https://…ts.net` address
  on your tailnet.
- The app isn't code-signed yet, so the first time it runs, Windows SmartScreen
  asks: choose **More info → Run anyway**.

**Phones** don't need an app. Open the server's address and add it to your Home
Screen (see [Use it from your phone](#use-it-from-your-phone-tailscale)).

### Updates

- Tap the **gear → Colony <version>** (or the card that appears above your Bots)
  to see what's new and update.
- **The server** checks GitHub every few hours. **Update server** downloads the
  new version, checks it against the release's checksums, and restarts into
  it. Open pages reload by themselves.
- If Bots are mid-reply, Colony asks first: restarting stops those replies.
- If a new version fails to start, Colony goes back to the previous one and
  says why. It keeps the previous version until the next update.
- **The desktop app** checks every hour and downloads updates in the
  background. **Restart to update** installs one; otherwise it installs the
  next time you quit.
- Colony runs from source when you start it from a checkout (below). Then it
  only tells you about updates; pull and rebuild to update.

## Run from source

```powershell
git clone https://github.com/andrewcoul/colony; cd colony
npm ci
npm run computer:build      # once, if you use Docker computers
npm run build
npm start                   # http://127.0.0.1:8787
```

## Connect models

Open Colony and tap the **gear** (Settings) to connect models.
- **Add provider**: pick a preset or type a base URL, then paste its API key.
- Choose the provider's **API format**. Most providers are OpenAI-compatible.
  Claude uses the Anthropic format, both from `api.anthropic.com` and through
  gateways that offer it (e.g. OpenCode Go's Claude models). OpenRouter serves
  Claude in the OpenAI format.
- **Check connection** lists that provider's models; choose the ones you want.
- Add as many providers as you like, each with its own key. For example,
  OpenRouter for Claude, OpenCode Go for DeepSeek, and Ollama for local models.
- Each Bot uses any model from any provider (pick it in the Bot's profile). Set
  the **default model** for new Bots at the top of Settings.
- Change keys, providers or models any time. The next reply uses them, with no
  restart.
- If you remove a model or provider, Bots that used it fall back to the default.
- A Bot's failed reply shows the provider's own error, e.g. a model that needs a
  different API.
- Keys are saved in `data/settings.json`, readable only by you. Devices only ever
  see their last four characters.
- A saved key is only ever sent to the address it was saved for.

Optionally, `.env` (see `.env.example`) can supply a first provider instead.

Everything Colony stores lives in `data/`: the SQLite database, settings, each
Bot's folder (`data/bots/<id>/` with `SOUL.md`, `MEMORY.md`, `skills/`,
`workspace/`), and the push keys. `data/` and `.env` are git-ignored.

Only run one Colony per `data/` folder. A second copy refuses to start, so
routines can't run twice.

### Start with Windows (from source)

The installer already does this. For a checkout, routines only run while Colony
is running. To start it whenever you sign in:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1          # install
Start-ScheduledTask -TaskName Colony                                    # start now
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove  # uninstall
```

`scripts\run.ps1` keeps Colony running: it restarts it within 10 seconds if it exits,
starts Docker Desktop if needed, and logs to `data\colony.log`. After pulling changes:
`npm run build`, then `powershell -ExecutionPolicy Bypass -File scripts\restart.ps1` (it waits until Colony answers).

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
`colony-computer` image. The image is built on [Cua](https://cua.ai)'s Ubuntu 24.04
desktop (XFCE, plus `cua-spacesd` for screenshots, input and a live viewer), with
Node 22, Python 3, git and ripgrep added. Its limits:
- 2 GB of memory, 2 CPUs and 512 processes
- all Linux capabilities dropped except a few that file ownership needs
- `no-new-privileges`

`data/bots/<id>/workspace` is mounted at `/workspace` and persists. Commands run
as the desktop user, time out, and Stop kills their whole process group. Commands
that push, publish, send data out, or wipe the workspace need your approval. Turn
a computer off from its panel; it starts again on demand.

Computers switch themselves off after 5 idle minutes, so they don't hold memory
all day. A computer stays on while its Bot is working or while you watch its
Screen or Browser tab. Its next use starts it again in a few seconds, with
`/workspace` and browser logins intact. Set `COLONY_COMPUTER_IDLE_MINUTES` in
`.env` to change the wait, or to `0` to keep computers on.

The computer panel has four tabs: **Screen** (the live desktop), **Terminal**,
**Browser** and **Files**.

The image is about 2.3 GB. After an image update, each computer is rebuilt on its
next use; `/workspace` and browser logins are kept. Once no computer uses an older
image, Colony deletes it. Cua's usage data is switched off (`DO_NOT_TRACK=1`).

### The desktop

Turn on **Desktop control** in a Bot's profile to let it see the screen and use the
mouse and keyboard, like a person at the computer.
- Only models that can drive a desktop can be picked while it's on. The others are
  disabled.
- Claude models (Anthropic format) are marked automatically and use Claude's own
  computer-use actions.
- Any other model can be marked by **Test desktop skills** in Settings. It shows
  each model a screenshot and checks that it reads the screen and clicks within a
  few pixels; you can also mark models by hand. Those models get Colony's
  screenshot, click, type, key and scroll tools.
- A desktop run can take up to 80 steps. Only the newest screenshots are sent to
  the model, to keep it affordable.

Watch it in the **Screen** tab: Cua's viewer, served through Colony, with video,
mouse, keyboard and touch. Tap in to take over; you and the Bot share one screen.
Each viewer link carries a short-lived ticket in the URL fragment, and the desktop
is only reachable through Colony.

The viewer is source-available (FSL-1.1-MIT, free to use) as part of Cua Spaces;
the rest of Cua that Colony uses is MIT.

### The browser

Each computer also runs a real Chromium, in a window on the desktop, that Colony
drives with Playwright.
- Bots read a page as numbered elements, then click, type, scroll and go back.
- It can only reach the public web. Your PC and local network are blocked.
- Its logins persist in `data/bots/<id>/browser`, outside the workspace.
- Clicks that would send something ask for approval first. That means submitting
  a POST form, or buttons like Send, Buy or Delete.
- Bots never type passwords, 2FA codes or payment details. They hand the browser
  to you (`browser_ask_user`) and wait.

Watch the browser live in the **Browser** tab. Tap **Take over** to click, type and
scroll yourself. On a phone, the page switches to its mobile layout while you're
in control. You can also open a Bot's browser yourself to sign in to a site ahead
of time.

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

The desktop app (`desktop/`, Electron) has its own dependencies: `npm ci --prefix desktop`,
then `npm run desktop` to run it, or `npm run dist --prefix desktop` to build its installer.

### Releasing

```powershell
npm run release -- 0.2.0   # sets the version everywhere, commits and tags v0.2.0
git push --follow-tags     # GitHub Actions builds and publishes the release
```

A release has these files:
- `colony-server-<version>-win-x64.zip`: the server and web app with their
  dependencies (`npm run package` builds it locally).
- `install-colony-server.ps1`: the installer.
- `SHA256SUMS`.
- `Colony-Setup-<version>.exe`, `latest.yml` and its `.blockmap`: the desktop
  app and what its updater reads.

The server, web app and desktop app share one version number.

An installed server lives in `%LOCALAPPDATA%\Colony`:
- `versions/<version>/`: each installed version.
- `state.json`: which version is current.
- `launcher.mjs`: runs the current version, switches versions for updates, and
  goes back if a new one fails to start.
- `service.ps1`: the scheduled task's runner.
- `.env`, `data/` and `logs/`.

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
