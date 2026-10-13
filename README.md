# Colony desktop

A personal, Grok-style AI chat built with Tauri 2, React + Vite + TypeScript, and a
Convex TypeScript backend. It has a centred composer with **Search** and **Think**
modes and a model picker, streamed Markdown replies with collapsible reasoning,
web-search activity and source cards, regenerate, copy, and edit-in-composer.
Also included: date-grouped history with rename/delete, JSON export, and
dark/light/system themes.

The UI is designed in Paper (file "Colony · Grok-style chat"); `src/styles/tokens.css`
mirrors its tokens. Components follow the shadcn pattern on Base UI primitives
with Tailwind v4 (`src/components/ui`), the same stack T3 Code uses.

## Run

Requires Node.js 22+, Rust, Visual Studio C++ Build Tools, and WebView2 on Windows.

```powershell
cd "$env:USERPROFILE\Documents\GitHub\colony"
npm ci
npm run backend
```

The first backend run links a Convex development deployment and generates
`.env.local`. In another terminal:

```powershell
npx @convex-dev/auth --skip-git-check --web-server-url http://localhost:1420
npm run setup:workspace
npm run search:start
npm run desktop
```

Create your account using the workspace code in `.colony-setup.local`. That file
is private and gitignored. Sign-in persists on the device. Password reset and
email verification are not implemented in this personal prototype.

## Connect a model

Set these **backend** environment variables in the Convex dashboard or with
`npx convex env set NAME VALUE` from this folder:

| Variable | Value |
| --- | --- |
| `AI_API_KEY` | Your provider API key |
| `AI_BASE_URL` | Your OpenAI-compatible API base URL, including its version path |
| `AI_MODEL` | The default model ID supported by that provider |
| `AI_MODELS` | Optional: comma-separated extra model IDs offered in the composer's model picker |
| `AI_PROVIDER_NAME` | Display name, such as xAI or OpenRouter |
| `COLONY_OWNER_EMAIL` | Optional: restrict model access to one invited account's email |

This installation uses OpenCode Go / DeepSeek V4.1 Flash and restricts model
access and registration to `acoulson4646@gmail.com`. Sign in with a password you
choose in Colony; this is not Google OAuth. The workspace code also gates account
creation. Keys never enter the frontend bundle.
**Think** sends a high reasoning effort to the model (`reasoning_effort`), and
reasoning-capable models stream their thoughts into a collapsible "Thoughts" row.
Requests allow up to 16,000
characters, 4,096 output tokens, 40 messages of context, and 100 messages per day.
Attachments and offline/local-model connections are not included.
The backend runs in Convex Cloud; the desktop app needs internet access.

## Local web search

Your existing Firecrawl API runs at `127.0.0.1:3002` in Docker and is served
privately over Tailscale. `npm run search:start` starts a small read-only MCP
adapter at `127.0.0.1:3003/mcp`, on the existing `firecrawl_backend` Docker network.
The adapter exposes only `firecrawl_search` and forwards queries to the installed
Firecrawl API version, avoiding incompatible fields in newer MCP releases.

Turn **Search web** on in the composer. Convex queues a search request; the
signed-in desktop app claims it, calls the local MCP endpoint through Tauri, and
returns the results so the model can cite them. Keep Colony and Docker running.
Firecrawl does not need to be exposed publicly. Searches use public web snippets,
not full-page scraping. Each reply allows at most three searches.

The Vite browser preview uses a local development proxy for the same MCP calls;
packaged applications use the native command.

### Sharing search with coding agents

The adapter also serves local coding agents, so they use your Firecrawl instead of
Firecrawl's cloud. It exposes `firecrawl_search` (up to 10 results) and
`firecrawl_scrape` (one public page as Markdown, truncated to 20,000 characters
by default). It rejects foreign `Host`/`Origin` headers, and scrape refuses
private and loopback addresses. The official `firecrawl-mcp` package sends fields
the installed Firecrawl API rejects, so point agents at the adapter instead:

```powershell
claude mcp add --transport http firecrawl http://127.0.0.1:3003/mcp -s user
codex mcp add firecrawl --url http://127.0.0.1:3003/mcp
```

For OpenCode, add to `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": { "firecrawl": { "type": "remote", "url": "http://127.0.0.1:3003/mcp", "enabled": true } }
```

After changing `mcp/`, rebuild with `docker compose -f firecrawl-mcp.compose.yml up -d --build`.

## Build and verify

```powershell
npm run check
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

`npm run tauri -- build --debug --no-bundle` produces a standalone debug
executable at `src-tauri/target/debug/colony.exe`. The regular build creates
platform installers. Tests cover authorization, input bounds, overlapping
requests, persisted streaming with a mocked model, early stops, stale jobs,
search ownership, atomic claims, cancellation, and safe result URLs.

To repeat the live native search check with Docker running:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml live_self_hosted_search -- --ignored
```

