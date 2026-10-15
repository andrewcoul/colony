# Plan: Steering, durable runs, topics, artifacts, people, voice, "this PC", logo and motion

Status: proposed, 2026-10-15. Nothing built yet.

Designs: Paper file "Colony · Grok-style chat", one page per section below (`Pip parity · 1 Steering & recovery` … `Pip parity · 6 This PC`). Artboards are numbered to match the sections (1a, 1b, 2a …). The new logo is on the `Brand · Colony logo` page.

Background: kitze's Pip (launched 2026-10-14) is a personal agent app close to Colony: named agents, family group chat, per-project threads with a versioned artifact beside the chat, schedules, voice calls, and desktop apps that lend the agent their computer. It runs on `@earendil-works/pi-durable`. This plan brings the parts that fit Colony across, on Colony's own stack.

## Goals

- A message sent while a Bot is working changes what it does now (steering), instead of being ignored until the next turn. A follow-up can still be queued on purpose.
- A Colony restart or crash no longer throws away a Bot's work in progress: the run picks up at the step it was on, and pending approvals survive.
- Ongoing pieces of life and work get their own **topics** (Pip's threads/projects), filed in folders, each with its own history, artifact, files and schedule.
- A Bot keeps a versioned **artifact** for a topic (a shopping list, a trip plan, a renovation budget) that the user reads in the side panel instead of scrolling the chat.
- The people in a household can use one Colony, each as themselves.
- You can talk to a Bot (voice call), and a Bot can ring you.
- The Colony desktop app can lend a Bot this PC (browser windows, screen, apps, terminal, files), behind tiered permissions and approvals.

## Non-goals (v1)

- Switching the agent runtime to pi durable (see section 0).
- Chat-app bridges (Telegram, WhatsApp, iMessage, Slack, Discord). Pip leaves these out on purpose and so does Colony.
- Real phone calls over the phone network. They need a public webhook, and Colony is tailnet-only. Calls happen inside the Colony app.
- Accounts, passwords or logins. People are identified by their tailnet login (section 5).
- Several artifacts per topic. One per topic in v1; the table allows more later.
- Controlling another person's PC. A node only lends the PC the desktop app runs on, to the people who use that app.

---

## 0. Runtime: stay on the AI SDK

Pi durable would give us crash recovery and steering, but it replaces `AgentRunner` (`server/src/agent/run.ts`), every tool's wiring, the streaming to the web app and the provider layer (`pi-ai` instead of `@ai-sdk/*`), and it keeps its own store next to `colony.db`. It went from 0.0.1 to 1.2.0 in three weeks and its README says the API changes without notice.

Everything we need from it can be built on what we have:

- `streamText`'s `prepareStep` (ai@7.0.139) can return `messages`, and the override carries forward to later steps. That is the hook for steering (1.1) and for resuming (2.2). `run.ts` already uses it for desktop screenshots (`prepareDesktopMessages`); the two compose.
- Per-step checkpoints are a table and an `onStepFinish` write (2.1).
- "Re-run a cut-off tool call only if safe" is a per-tool flag (2.3).

Revisit if pi durable settles down and we want its multi-step tasks or forks.

## 1. Steering and queued messages

### 1.1 Server

- `api.ts` (around line 353) stops skipping Bots that are already running. For each addressed Bot that is running in that chat, the message is handed to the run instead: `runner.deliver(chatId, botId, messageId, mode)`.
- `AgentRunner.active` entries get an `inbox: string[]` of message ids.
- **Steer** (default): `prepareStep` checks the inbox before every model step. If there are messages, it appends them to `messages` as user messages, wrapped so the model knows they arrived mid-task: `"[While you were working, the user added:] …"`. It records `steeredAt: stepNumber` on each message and clears the inbox. The step then runs with the new instruction.
- If the model finishes its final step while the inbox is non-empty (the message arrived during the last model call), the runner starts a new turn straight away rather than dropping it.
- **Queue** (Alt+Enter): the message is saved with `delivery: "queued"` and is not added to the running turn. When the turn ends, the runner starts one new turn for all queued messages. "Steer now" on a queued message moves it into the inbox; "Cancel" deletes it.
- Group chats: each addressed Bot gets the message in its own inbox. A Bot that isn't running starts normally, as today.
- Stop (`POST /chats/:id/stop`) also clears inboxes and turns queued messages back into plain messages.
- **Migration:** `messages.delivery TEXT` (`null | 'steer' | 'queued'`), `messages.steered_at INTEGER` (the step number it was picked up at).
- Presence: while the inbox is non-empty the Bot's activity reads "Reading your message".

### 1.2 Web

- `Composer.tsx`: while the open chat's Bot is working, the placeholder is "Steer <Bot>…" and a hint line reads "<Bot> is working · Enter steers now · Alt+Enter waits until <Bot> is done". On touch devices the send button long-press offers "Send after".
- `Transcript.tsx`: a steered message keeps its place in time (between the step log entries it interrupted) with a mint outline and a "Steered · picked up after step N" line. A queued message is dashed with "Queued · sends when <Bot> finishes · Steer now · Cancel".
- The step log header shows "Stop" while running (today "Hide").

Designs: **1a** steer while working, **1b** queued follow-up.

## 2. Durable runs

### 2.1 Checkpoints

- **Migration:** `runs(message_id PK, chat_id, bot_id, status TEXT, step INTEGER, messages TEXT, hidden_prompt TEXT, depth INTEGER, started_at, updated_at)`. `status` is `running | waiting | done | failed | stopped`. `messages` is the JSON of the `ModelMessage[]` the run has produced so far (assistant and tool messages), not the whole history.
- `onStepFinish` writes `step` and the response messages (`step.response.messages`) for the run in one transaction with the message's `steps`. This is a few KB per step. Desktop screenshots are stored as a placeholder (`[screenshot omitted]`), since `prepareDesktopMessages` only keeps the latest anyway.
- Rows are deleted 24 h after the run ends.

### 2.2 Resume after restart

`store.recoverAfterRestart()` changes from "mark everything stopped" to:

- For each `runs` row in `running` or `waiting`, rebuild the history the run started from (`historyFor` up to the run's message), append the checkpointed `messages`, and start the run again through `AgentRunner.resume(runId)` with the original `hiddenPrompt` and `depth`. The reply message keeps its id, text and steps; streaming continues into it.
- A system note is added to the step log: "Colony restarted · picked up at step N".
- Runs older than `config.limits.turnTimeoutMs` are not resumed; they are marked stopped as today, with the existing "Colony restarted while this reply was running." text.
- Resumes are staggered (one per Bot, 2 s apart) so a restart doesn't fire every provider at once.
- `consult()` threads: the asking Bot's run resumes; its pending `message_bot` call is treated like any cut-off tool call (2.3).

### 2.3 Cut-off tool calls

A step that was `running` when Colony stopped may or may not have taken effect.

- `ToolSpec` gets `replay: "safe" | "check"`. Read-only tools are `safe`: `web_search`, `web_read`, `memory` (read), `skill_read`, `read_file`, `list_files`, `browser_read`, `mail_search`, `mail_read`, `calendar_list`, `vault_list`, `artifact_read`, `desktop_screenshot`.
- On resume, a cut-off `safe` call is re-run. Anything else is not re-run: it gets a tool result `"Colony restarted while this was running. It may or may not have happened; check before trying again."` and the step is marked `interrupted` (new `Step.status`).
- Calls waiting on an approval are not cut off; see 2.4.

### 2.4 Approvals survive restarts

- `ApprovalGate` keeps pending approvals across restarts instead of expiring them. On resume, the run reaches the same tool call, and `gate.request` finds the existing pending approval for that `message_id` + tool call id and waits on it, instead of creating a new one.
- The 6 h timeout counts from `approvals.created_at`, so a restart doesn't extend it.
- Approvals are still fail-closed: an approval whose run can't be resumed (too old, Bot deleted) is expired.

### 2.5 Other in-memory state

- Mail-triggered routines: `MailPoller`'s waiting list moves to `pending_triggers(routine_id PK, matched_at, detail)`.
- The updater (`server/src/updates.ts`) can now offer "Update now; Bots will pick up where they left off" instead of refusing while Bots are busy. It still refuses while an approval is mid-decision in an open dialog.

Design: **1c** a reply that was resumed after a restart, with an approval that survived it.

## 3. Topics and folders

Today each Bot has exactly one chat (`kind: 'bot'`), plus groups. Pip files its conversations as projects: "Mortgage", "Flights to Macedonia in January", "Hallway renovation". Colony gets the same as **topics**. ("Thread" is already taken by Bot-to-Bot chats.)

### 3.1 Data

- **Migration:**
  - New chat kind `topic`. `chats` gains `folder_id TEXT`, `icon TEXT` (an icon key from a fixed set, not free emoji), `archived_at INTEGER`, `created_by TEXT` (a person id, section 5).
  - `folders(id PK, title, icon, position INTEGER, collapsed INTEGER)`.
- A topic has one or more Bot members, like a group, and a coordinator when it has several. A one-Bot topic behaves like that Bot's chat with its own history.
- A Bot's own chat stays, as its "General" topic. It can't be filed or archived.
- Groups become topics with several Bots. The migration turns each `group` chat into a `topic` in a "Groups" folder, and the sidebar's Groups section goes away.
- Routines, artifacts and files belong to a chat, so a topic carries its own (sections 4.1–4.3).
- History is per chat already (`historyFor` reads one chat), so topics don't leak into each other. `MEMORY.md` stays per Bot and shared across its topics.

### 3.2 Tools

- `topic_create({ title, folder?, icon?, members? })`: a Bot can propose a topic ("Want me to start a topic for the hallway renovation?"). It shows as a card in the chat with "Create" / "Not now"; nothing is created until the user taps Create.
- `topic_list()` so a Bot can point the user at an existing topic instead of making a duplicate.

### 3.3 Web

- `Roster.tsx` gets a **Topics** section under Bots, grouped by folder (collapsible) or by Bot (toggle in the section header, remembered per device). Rows show the topic icon, title, the Bot face(s), and the same presence and unread signals as Bot rows.
- "New topic" dialog: title, Bot(s), folder, icon.
- Drag a topic onto a folder to file it. Archive from the topic menu; archived topics live under "Archived" at the bottom of the list.
- Phone: Topics is a second segment next to Bots on the list screen.

Designs: **2a** desktop with folders and a topic open, **2b** new topic dialog, **2c** phone topic list.

## 4. The topic side panel: Artifact, Files, Schedule

`SidePanel.tsx` already hosts Computer, Routines and Profile, one at a time, 430 px on desktop and full screen on phone. For topics it gets three tabs, matching Pip: **Doc** (the artifact; "artifact" is the code name, "Doc" is what people see), **Files**, **Schedule** (today's Routines panel, scoped to the chat). Computer and Profile stay where they are. The chat header gets a "Doc · v6" pill that opens the panel.

### 4.1 Artifacts

- **Migration:** `artifacts(id PK, chat_id, title, status TEXT, body TEXT, version INTEGER, updated_by TEXT, updated_at)` and `artifact_versions(artifact_id, version, body, note, updated_by, created_at, PK(artifact_id, version))`. `status` is free text the Bot sets ("Draft", "Almost final", "Booked").
- **Body format:** Markdown (GFM tables and task lists), plus three fenced blocks the web app renders specially:
  - ` ```colony-stats ` a row of big numbers: `Total so far | ≈ €1,017 | 4,453 zł`.
  - ` ```colony-items ` product or option cards: name, tag, detail lines, price, link, image URL.
  - ` ```colony-note ` a muted provenance line ("IKEA PL prices as of 13 Oct · €1 ≈ 4.38 zł · stock not verified").
  Anything else is plain Markdown, so the artifact still reads fine as a file.
- **Tools:** `artifact_read()`, `artifact_write({ title?, status?, body, note })` (full replace, bumps the version), `artifact_edit({ find, replace, note })` (targeted edit, same versioning as `edit_file`). Every write emits `artifact.upserted` and adds a small card to the chat: "Updated IKEA trip list · v6 · added photos".
- **Images:** remote image URLs are fetched through a server proxy (`GET /api/img?u=…`, cached in `data/cache/img/`), so the phone never loads third-party images directly.
- **History:** the panel's version menu lists versions with their notes and shows a diff against the previous one. "Restore" writes the old body as a new version.
- **Open questions in a reply:** Pip shows tappable "Open" chips under a message. New tool `ask({ questions: [{ label, options? }] })` adds an `ask` card to the reply; tapping a chip puts the answer in the composer (or sends it straight away for option chips).
- The artifact can be opened full screen or exported as Markdown.

### 4.2 Files

- Uploads: `POST /api/chats/:id/files` (multipart, 25 MB cap), stored in `data/chats/<chatId>/files/`. If a member Bot has a computer, the folder is also visible inside it at `/workspace/topics/<slug>/`.
- `Composer.tsx` gets the + button for attachments (files and photos) and paste/drop. Attached files show as chips above the input and as a file row on the sent message.
- Bots without a computer get `chat_files({ action: 'list' | 'read' })`. Images go to vision models as image parts; PDFs and text are read as text (PDF text extraction with `pdfjs-dist` on the server).
- The Files tab lists the topic's files (uploaded and Bot-written) with who added them and when.

### 4.3 Schedule

- Routines can belong to any chat, not just the Bot's own (`api.ts` line 527 stops forcing `bot.chatId`). The Schedule tab is `RoutinesPanel` filtered to the chat, with the topic's routines, a "New" button, and the next run time.
- Reminders are routines with a `once` schedule; no new concept.
- The sidebar footer "Routines" opens an all-routines view (Pip's "Automations"), grouped by topic.

Designs: **3a** Doc tab with ask chips in the chat, **3b** Doc version history, **3c** Files tab and attachments in the composer, **3d** Schedule tab.

## 5. People

Colony is single-owner by design: no login, the tailnet is the boundary. A household needs each person to be themselves (whose list is this, who asked for what, who gets the notification) without adding accounts.

### 5.1 Identity from the tailnet

- Behind `tailscale serve`, each request carries `Tailscale-User-Login` (already read in `server/src/access.ts` when `COLONY_ALLOWED_USERS` is set). That login is the person. Requests from 127.0.0.1 (the desktop app on the Colony PC) are the owner.
- **Migration:** `people(id PK, login TEXT UNIQUE, name, color, role TEXT, created_at)`. `role` is `owner | member`. The first login seen, or the local user, is the owner. New logins appear as "New person waiting" and get nothing until the owner adds them.
- Messages' `author` becomes `"person:<id>"` for people (the existing `"user"` maps to the owner). `push_subscriptions` gains `person_id`, so notifications go to the right phone.

### 5.2 What a member can do

- See and post in the topics they are a member of (`chat_members` gains person rows), and in topics marked "Everyone".
- In a topic with people in it, the topic's Bot (or coordinator) answers every message by default, as today. `@Marija` addresses only that person and the Bot stays quiet.
- Talk to Bots the owner has shared with them. A Bot's own chat is per person: Bot × person, so two people don't share one history.
- **Never** approve on the owner's behalf: approvals for mail, calendar and vault actions on the owner's accounts go to the owner only. A member can approve actions that only touch things they own.
- Each person has their own `USER.md` (`data/people/<id>/USER.md`), and there is a shared `HOUSEHOLD.md`. The system prompt includes the profile of whoever sent the message, and names them.
- Settings, providers, accounts and Bot creation stay owner-only.

### 5.3 Web

- Settings > People: people with their tailnet login, color, role, the Bots and topics they can use; pending logins with Add / Ignore.
- Messages from people show their name and color dot. Artifact items can carry a person tag ("Marija").

Designs: **4a** Settings > People, **4b** a shared topic with two people and a Bot.

## 6. Voice

### 6.1 Calls in the app

- A call is a mode of a chat, not a separate thing: a Call button in the chat header (and on the phone) opens the call screen; what is said lands in the chat as messages marked `via: 'voice'`.
- **Pipeline** (cascade, provider-agnostic): the browser captures audio, runs voice activity detection (`@ricky0123/vad-web`), and streams speech segments over a WebSocket (`/api/chats/:id/call`) to the server. The server transcribes them (OpenAI-compatible `/audio/transcriptions`; local Whisper via `faster-whisper-server` works), runs a normal Bot turn, and streams the reply sentence by sentence to TTS (`/audio/speech`; local Kokoro works), back over the socket.
- **Barge-in is steering.** If you speak while the Bot is talking, playback stops and what you said goes to the run's inbox (1.1). Speaking while it's working on a tool call steers it the same way.
- Settings > Voice: transcription and speech provider (from the existing provider list), voice per Bot, speed (0.75×–1.3×, as in Pip).
- The AI SDK's `experimental_transcribe` / `experimental_generateSpeech` cover the provider calls. A realtime speech-to-speech model is a later option per Bot; the cascade keeps tools, steering and any model working first.

### 6.2 A Bot calls you

- New tool `call_user({ reason })`. It sends a high-priority push ("Luke is calling · Your 3 PM flight moved to 4:10"). Opening it starts a call with that Bot, with the reason as the Bot's first line. If it isn't answered in 45 s, the Bot posts the reason in the chat instead.
- Limits: at most one call per Bot per 30 min, never during quiet hours (Settings > Voice, default 22:00–07:00), and only for people who allowed calls from that Bot.
- iOS PWAs can't ring like a phone call. The push shows as a normal notification; this is documented, not worked around.

Designs: **5a** phone call screen, **5b** incoming call from a Bot, **5c** desktop call bar with the live transcript in the chat.

## 7. This PC as a node

Bots already have their own Linux computer (Docker, with a desktop). A node is different: it lends a Bot the person's own PC, through the Colony desktop app.

### 7.1 Transport

- The desktop app (`desktop/src/main.ts`) opens a WebSocket to the server it is connected to (`/api/nodes/connect`) and registers as a node: name ("Andrew's PC"), platform, and the capabilities switched on. It reconnects on its own.
- The node speaks MCP over that socket: the node is an MCP server, the Colony server an MCP client. This is the MCP client that `integrations.md` deferred, built once and reusable for other MCP servers later.
- **Migration:** `nodes(id PK, name, person_id, platform, capabilities TEXT, last_seen)` and per-Bot grants in `node_access(bot_id, node_id, level)`.

### 7.2 Capabilities and levels

| Level | Capability | Tools | Default |
|---|---|---|---|
| 1 | Browser windows | `pc_browser_open`, `pc_browser_read`, `pc_browser_click`, `pc_browser_type` (Electron `BrowserWindow`s the node opens and drives; logins persist in their own partition) | on |
| 1 | See the screen | `pc_screenshot` (`desktopCapturer`) | off |
| 1 | Control other apps | `pc_click`, `pc_type`, `pc_key` (`@nut-tree-fork/nut-js`) | off |
| 2 | Terminal | `pc_shell` (the user's shell, in a folder they pick) | off |
| 3 | Files | `pc_read_file`, `pc_write_file`, `pc_list_files` (home folder only; "Full disk" is a separate switch) | off |

- Every switch lives on the node (Settings > This PC in the desktop app) and is enforced there, so the server can't grant itself more than the PC allows.
- Approvals: level 1 browser use asks once per task; screen, apps, terminal and file writes ask every time, through the same `ApprovalGate` cards. Reading files in the home folder doesn't ask once it is switched on. The approval card names the PC. Approvals for a node go only to the person whose node it is.
- While a Bot is driving the PC, the desktop app shows a thin border around the screen and a floating "Luke is using this PC · Stop" pill. Windows the Bot opens are labelled with its name.

Designs: **6a** desktop Settings > This PC, **6b** a chat where a Bot asks to use this PC, **6c** the on-screen indicator while a Bot drives it.

## 8. Logo and motion

### 8.1 The King Bot

The new logo is a Bot face like the others (round, black glossy eyes), in plain white, wearing a little black crown tilted to one side. The king is you: every Bot in the colony has a colored face, and the one without a color, wearing the crown, is the person they work for.

- The crown has a white outline so it stays visible on Colony's near-black background. A light-background variant adds a thin black outline to the head instead (README, GitHub, print).
- It replaces the current mark everywhere:
  - `web/src/components/Logo.tsx` (`LogoMark`, used in `App.tsx` and `Roster.tsx`).
  - `web/public/colony.svg` (favicon and PWA icon).
  - `web/public/icon-512.png` (Apple touch icon, maskable PWA icon, push icon): the mark on a `#141414` tile, with 20% safe-zone padding for the maskable crop.
  - `desktop/build/icon.png`, and a multi-size `icon.ico` for the Windows installer.
  - The push badge in `web/public/sw.js`: just the crown silhouette, because Android draws badges from the alpha channel only.
- PNGs are generated from the one SVG by a small script (`scripts/icons.ts`, using the Playwright Chromium the server already depends on), so the sizes never drift apart.
- With People (section 5), each person's avatar is the crowned face. The crown marks a person and its absence marks a Bot, so shared topics stay readable at a glance.

Design: page `Brand · Colony logo`.

### 8.2 Motion

Today all motion is CSS: the face loops in `globals.css` (`.face[data-state]`), typing dots, and base-ui's dialog fades. Side panels, messages, roster rows and step logs appear and disappear with no transition. The new screens add more state changes (steering, resuming, versions, calls), and they read better when the change is visible.

- **Library:** [Motion](https://motion.dev) (`motion`, imported from `motion/react`). Use `LazyMotion` with `domAnimation` and the `m.*` components to keep the bundle small (about 15 kB gzipped). Wrap the app in `<MotionConfig reducedMotion="user">`, so Motion follows the OS setting the same way the existing `prefers-reduced-motion` CSS block does.
- **Tokens** in `web/src/lib/motion.ts`, so every component moves the same way:
  - `spring.snappy` (stiffness 500, damping 34): chips, badges, toggles.
  - `spring.soft` (stiffness 260, damping 30): panels, cards, layout shifts.
  - `fade` (160 ms, ease-out), for anything that only changes opacity.
  - Enter is a 6–8 px rise plus a fade. Exit is a fade only, at roughly half the enter time.
- **Where it goes:**

| Component | Transition |
|---|---|
| Side panels (`SidePanel.tsx`) | Slide in 24 px with a fade (`AnimatePresence`). The chat column resizes with `layout`, and switching tabs crossfades. |
| Messages (`Transcript.tsx`) | New messages rise in. Your own message springs up from the composer's position. A steered message pulses its mint outline once when it's picked up. |
| Queued message | Dashed outline while waiting. When it sends, the dash turns solid and the "Queued" line collapses. |
| Step log | Rows stagger in (30 ms apart). Expand and collapse animate height. The running icon morphs into a check when the step finishes. |
| Approval card | Springs in. Once decided, it shrinks to a one-line "Approved" or "Denied" chip, so the transcript doesn't stay full of finished cards. |
| Restart marker (1c) | The sky "picked up here" line draws in from the left. |
| Roster and topics | `layout` animation when rows reorder by activity. Presence labels crossfade. Folders expand and collapse height. |
| Bot faces (`Face.tsx`) | Motion handles the *changes* between states: the ring scales in when work starts, badges pop in with `spring.snappy`, and the face squints on done. The existing CSS keyframes keep running the loops. |
| Doc panel | The version number rolls on a bump. Changed items flash a soft highlight. The total counts up to its new value. |
| Ask chips | Stagger in after the reply finishes. A tapped chip flies into the composer. |
| Calls | The face ring scales with the live audio level. The incoming-call ring pulses. The call bar slides down from the header. |
| Logo | The King Bot blinks now and then. On the connecting screen the crown bobs, and when the app connects it lands with a small bounce. |

- **Don't animate:** streamed text (no per-token effects), scroll position, or anything over 400 ms. Lists over 50 items skip stagger.
- **Perf:** animate `transform` and `opacity` only, and use `layout` only on rows that actually reorder. Test on the phone PWA, since that's the slowest device.

Prototype: the "Colony motion" preview shows the main transitions running.

---

## 9. Phases

0. **Logo and motion foundations** (section 8). Swap in the King Bot everywhere, add Motion with the tokens, and animate the existing screens (side panels, messages, step log, approvals, roster). New screens from later phases then use the same tokens from the start.
1. **Steering** (section 1). Small, and fixes the worst gap: messages sent mid-turn are ignored today. Exit check: steer a coding Bot mid-run and see it change course at the next step; queue a follow-up and see it run after.
2. **Durable runs** (section 2). Exit check: kill the server mid-run (during a read, during a write, while waiting on an approval) and confirm each case resumes or reports as designed.
3. **Topics and folders** (section 3).
4. **Side panel: artifacts, files, schedule** (section 4). Artifacts first; files second; schedule is mostly re-scoping existing code.
5. **Voice in the app** (6.1), then **Bots calling you** (6.2).
6. **This PC** (section 7). The MCP client first, then browser windows, then the rest by level.
7. **People** (section 5). Last because it changes the trust model; it can move up if the household is the main use. Topics (3) should land first either way, since people mostly share topics.

## 10. Tests (Vitest, alongside the code)

- `run.test.ts`: a fake model that takes three tool steps; deliver a steer message after step 1 and assert it is in the messages for step 2 and that `steered_at` is 1. Queue a message and assert a second turn starts after the first ends. Message arriving during the final step starts a new turn.
- Durable runs: checkpoint after each step; simulate a restart by building a new `AgentRunner` on the same database; assert the resumed run's first model call contains the checkpointed messages; a cut-off `safe` tool re-runs, a cut-off `check` tool gets the interrupted result; a pending approval is re-bound, not duplicated.
- Topics: routines, artifacts and files follow the chat; history doesn't cross topics.
- Artifacts: write/edit bump versions, restore makes a new version, `colony-*` blocks parse and bad blocks fall back to code blocks.
- People: author mapping from `Tailscale-User-Login`; a member can't approve an owner-account action; push goes to the right subscriptions.
- Voice: the call socket with a fake transcriber and speaker; barge-in delivers to the inbox.
- Nodes: an in-process fake node over the MCP socket; a capability switched off on the node is refused even if the server asks.

## Open questions

1. Is the household (section 5) the main reason for this work? If so it moves up to phase 3, after durable runs.
2. Which speech providers are on hand? The plan assumes OpenAI-compatible endpoints, local or hosted.
3. Should the node's "Control other apps" level ship at all on Windows in v1, or stop at browser windows, screen, terminal and files?
4. Topic icons: a fixed icon set (as planned), or free emoji like Pip?
