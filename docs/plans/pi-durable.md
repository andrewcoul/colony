# Plan: Single-user Colony on pi durable, with persistent Bots

Status: built, 2026-10-15, on branch `pi-durable` (phases 1–8, one commit each; Phase 9 is for a later release). See "Where the build differs" at the end.

Follows `pip-parity.md` (section 0 explains why we stayed on the AI SDK) and `family.md`. Colony is in use again, so the plan also covers runs that are in flight on the live server when the new version is installed.

## What changes

1. **Colony becomes single-user again.** The family build (`family.md`) and the people model (`pip-parity.md` section 5) are removed: no people, owners, shared keys, approver routing, hand-overs or per-person settings. Only your tailnet login gets in. Multi-user can come back later from `v0.2.0`.
2. **Bots become long-running and persistent.** Each Bot keeps one ongoing conversation per chat or topic. When the conversation nears the model's context limit it is compacted (summarised) instead of being cut to the last 40 messages, as happens today. It can be forked ("branch from here").
3. **The agent runtime moves from the Vercel AI SDK to pi durable** (`@earendil-works/pi-durable`, with `pi-ai` as the provider layer). Pi durable provides the persistence, compaction, forks, steering and crash recovery.

### Why pi durable now

Last time (`pip-parity.md` section 0) the only things we needed were steering and resuming after a restart, and those were cheap to build on the AI SDK. Long-running Bots need more:

- **Compaction.** It is triggered by tokens, done by the Bot's own model, keeps recent turns verbatim and keeps old entries in storage.
- **Forks.** A forked conversation shares the parent's history up to the fork point without copying it.
- **One durable transcript per conversation** that survives crashes in the middle of a tool call or a model call.

Building those ourselves is a project of its own. Pi durable has them, and single-user removes the gap that mattered most last time (choosing an API key per person).

### The catches

- **The API isn't stable.** Pi durable 1.3.0 shipped today. The README says "Experimental. The API changes without notice", and 4 of its last 8 releases broke something. We pin exact versions and keep every pi call in one folder.
- **Approvals.** Nothing built in pauses a tool for a person across a restart. We add a small effect ledger (section 3.4).
- **Computer use.** pi-ai doesn't support Anthropic's computer-use toolset, so Claude uses Colony's own `desktop_*` tools on the Bot's computer (measured in Phase 6).
- **Storage.** There's no API to delete a conversation, so `agent.db` only grows (section 4).

---

## 1. Where pi durable is now

Researched 2026-10-15 from the npm tarballs (`.d.ts`, compiled `dist/`, README, CHANGELOG), the repo `earendil-works/pi` (`packages/durable`) and the launch post (earendil.com/posts/pi-durable).

### 1.1 Version and stability

- **Releases:** latest is 1.3.0 (2026-10-15). 1.0.0 came out around 10-02, then 1.0.3/1.0.4 (10-05), 1.1.0 (10-07), 1.2.0 (10-12) and 1.3.0 (10-15).
- **Pins:** it pins `pi-ai`, `chord` and `pi-codemode` to exactly 1.3.0, so the four move together. Other dependencies are `typebox` 1.3.x, `diff` and `@silvia-odwyer/photon`.
- **Stability:** "Experimental. The API changes without notice between releases." There's no semver policy, so 1.x doesn't mean stable.
- **Breaking changes:**
  - 1.0.3: `FileSystem`/`BinaryReader` contracts.
  - 1.0.4: watch behaviour.
  - 1.1.0: `order` on `Storage`; `TaskRuntime.context`.
  - 1.2.0: tagged unions; tool result `content` → `output`; storage errors.
  - 1.3.0: none.
- **Open upstream changes:** #10858 (`ToolControl` `terminate` type change) and #11014 (storage commit errors missing from summaries).
- **Runtime requirements:** Node `>=22.19.0` and ESM only. Colony is ESM, and this PC runs 22.23.2, but Colony's `engines` and `scripts/install.ps1` say 22.13, so both get raised. MIT licence.

### 1.2 The Node/TypeScript API (1.3.0)

| Area | API |
|---|---|
| Open | `openNodeSqliteStorage(path)` (`node:sqlite`, the same driver as `colony.db`), then `Harness.open(storage, options, ctx)`. Options: `models`, `registry`, `settings`, `env`, `conversationCreated`, `now`, `onReport`. |
| Conversations | `harness.createConversation(options, ctx)`, `harness.conversation(id, ctx)`. `harness.resume()` restarts durable work after open. |
| Turns | `conversation.submit({ type: "input", content, whenBusy: "steer" \| "followUp" \| "reject", requestId? }, ctx)`. The same `requestId` finds the existing submission. |
| Context without a turn | `submit({ type: "write", kind, data, model })`. With `model` content it enters the model's context without running the model (for other Bots' messages in a topic). Without it, it's display-only. |
| Agent config | `conversation.configure(change)`: model (`{ provider, modelId }`), thinking level, tools, instructions. The system prompt is rendered before each request, and a change is appended as a `pi.system` diff entry, so it can change every turn. |
| Tools | `defineTool({ name, description, parameters /* TypeBox */, execute(args, api, ctx), replay?: "safe" \| "unsafe" })`. `output` is `(TextContent \| ImageContent)[]`, so screenshots can be tool results. `api` offers `createTask`, `waitForTask`, `output`, `details`. |
| Hooks | `beforeTool` can block a call with a message. `beforeRequest` can replace the outgoing messages. `beforeCompact` can decline a compaction or supply its own summary. |
| Steering | A busy `submit` goes to the `pi.inbox` document. Steers are placed after a tool round, before the next model call, and at the final answer. Follow-ups wait for the turn to end. An inbox item can be withdrawn (`Submissions.abort`). |
| Compaction | Automatic. Defaults are `{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }`. It runs in the background from `contextWindow − reserve − background` and blocks at `contextWindow − reserve`. It also compacts and retries once if the provider says the request is too long. The summary is written by the conversation's own model with no tools; its sections are Goal, Constraints & Preferences and Progress. The model then sees "The conversation history before this point was compacted into the following summary: …". Old entries stay in storage. `conversation.compact(instructions)` compacts by hand. |
| Forks | `conversation.fork(entryId, { ownership }, ctx)`. The fork sees the parent's entries up to `entryId` (shared, not copied) and the agent config as of that point. Documents are copied by policy (`asOf`/`current`/`initial`); tasks aren't. |
| Events | `watchEvents(harness, conversationId, ctx)` (marked experimental): `message_update` (`text_delta`, `thinking_delta`, `toolcall_delta`) and `usage_changed`. Events are derived from commits, with partial output committed at most every 100 ms (`progress.partialIntervalMs`). |
| Usage | `Usage { input, output, cacheRead, cacheWrite, cost }` per assistant message. `harness.usage(ctx)` gives totals per model and per tool. |
| Abort | `conversation.abort`, `submission.abort`, `harness.abortTask`. Tools get an `AbortSignal`. |
| Tasks | Durable state machines (`pending → running → waiting → completing`; terminal `faulted`, `orphaned`). Child tasks and sub-agents. Running tasks go back to `pending` on restart and continue from their checkpoint. |
| Context | Every call takes a chord `Context`. Use `BACKGROUND_CONTEXT` as the root and `withAbortSignal` per request. |

### 1.3 Crash and resume

- **Tool calls** are checkpointed in phases:
  - A call cut off before it ran is resolved again and not executed.
  - A call cut off while it ran is re-run if `replay: "safe"` (the default is `"unsafe"`).
  - Otherwise the call is settled as interrupted, "may have partially run".
- **A model call** cut off mid-stream keeps its committed partial output as an aborted entry, and the request is re-sent.
- **Storage:** one process owns a storage, with no cross-process lock. SQLite runs in WAL with `synchronous = NORMAL`. The schema is versioned (`durableSchema`), and an older library refuses a newer file.
- **Missing:** I found no API that deletes or prunes conversations.

### 1.4 pi-ai

- **Providers:** `createProvider({ id, baseUrl, auth, models, api })`, with `anthropicMessagesApi()`, `openAICompletionsApi()` (compat flags such as `supportsDeveloperRole`, `maxTokensField`, `thinkingFormat`), `openAIResponsesApi()` and others. Model ids are free strings. Providers are added and replaced on a `Models` collection with `setProvider`.
- **Keys:** pi durable passes no per-call key, so each provider's `auth.apiKey.resolve` supplies it. That's fine single-user: one pi-ai provider per Colony provider row.
- **Anthropic:** thinking (budget, interleaved), prompt caching (`cacheRetention`), images, and beta headers set automatically. **No server or provider-defined tools** (no computer use, no `web_search`).
- **Cost:** prices come from static JSON bundled in the package. We keep Colony's own editable prices (`prices.ts`).

---

## 2. What we gain

| Today | With pi durable |
|---|---|
| The model sees the last 40 messages (`historyMessages`) plus `MEMORY.md`, so anything older drops out silently | **One persistent conversation per Bot per chat, compacted automatically.** A Bot can run for months and keep the thread. |
| No branching | **Forks:** "Branch from here" starts a new topic that carries the context up to that message. |
| Steering via `prepareStep` and an in-memory inbox, lost on a crash | Steers and follow-ups persisted in `pi.inbox` |
| Checkpoint per step; a crash mid-model-call loses that step's partial text | Partial output kept and the request re-sent |
| `SAFE_TO_REPEAT` name list plus `restore()` | `replay` per tool, with interrupted calls settled by the harness |
| `message_bot` cut off on restart ("check before retrying") | Durable child work: both sides resume |
| About 600 lines in `run.ts` we maintain | The loop is maintained upstream, but it's an experimental API we have to track |
| Screenshots as a separate user message for OpenAI-compatible models | Image tool results for every provider |

Not planned now, but possible later: deferred (batch) responses for routines that aren't urgent.

---

## 3. Feature by feature

### 3.1 The shape of the port

- **One pi conversation per (chat, Bot).** A Bot's own chat is one long-lived conversation. A topic with three Bots has three conversations, one per member Bot.
  - **`colony.db` and `agent.db`.** `messages` in `colony.db` stays the record of what you see (transcript, cards, steps, artifacts). The pi conversation is what the model sees. A new table links the two: `conversations(chat_id, bot_id, conversation_id, created_at, PK(chat_id, bot_id))`.
  - **What goes into a conversation.** Your messages are submitted as `input`, with photos as image content. What other Bots say in a shared topic is added to each member's conversation as a `write` with model content, attributed by name, the way `historyFor` attributes it today. Routine and intro prompts are submitted as `input` with their existing hidden marker.
  - **System prompt.** The system prompt (`prompt.ts`) is set through `configure` before each turn, so routines, team, topic, desktop state and time stay current.
  - **Long-term memory.** `MEMORY.md` stays: memory shared across a Bot's topics. Compaction covers one conversation.
- **One pi-ai provider per Colony provider row** (`colony:<providerId>`), with its key read from `colony.db` on each request. A Bot's model is `configure`d as `{ provider: "colony:<id>", modelId }`.
- **Colony keeps its wire protocol.** The web app keeps consuming SSE `ServerEvent`/`EphemeralEvent`. An event bridge maps harness events onto `message.delta`, `message.upserted` and steps.

### 3.2 Mapping

| Feature | Today | On pi durable | Lost or changed |
|---|---|---|---|
| **History** | `historyFor`: last 40 messages, rebuilt each turn | The persistent conversation. The first turn after the upgrade seeds it from the last 40 messages, so nothing is lost relative to today. | Context now grows until compaction rather than being cut at 40. |
| **Compaction** | None | Automatic, with pi's defaults. The step log shows "Compacted earlier conversation" with the summary expandable. The chat menu gets **Compact now**. `beforeCompact` adds Colony's instruction to keep names, decisions and open tasks. | New |
| **"Start fresh"** | None | A chat menu item that starts a new conversation for that Bot. The old one stays in `agent.db`. | New |
| **Forks** | None | **Branch from here** on a message: `conversation.fork(entryId)`, then a new topic with that Bot, titled by you. | New |
| **Streaming deltas** | `fullStream` → ephemeral `message.delta` | `watchEvents` `message_update` → the same `message.delta` | Deltas batched at ≤100 ms. That doesn't matter for voice (section 3.5). |
| **Steps** (step log) | `tool-call` / `tool-result` parts → `Step` rows | Tool entries and their settlement → the same `Step`s. Interrupted calls → `interrupted`. | None |
| **Steering** | `deliver` → inbox → `prepareStep`; a steer splits the reply | `submit({ whenBusy: "steer" })`. Inbox consumption drives the split and `steered_at`. | A steer sent during the very first model call (before any tool) waits for that call to finish. |
| **Queue / Steer now / Cancel** | Colony `delivery: "queued"` + `followUp` | `whenBusy: "followUp"`. **Steer now** withdraws the inbox item and resubmits it as a steer. **Cancel** withdraws it. | None |
| **Stop, turn timeout** | `AbortController` (`"stopped"` / `"timeout"`) | `conversation.abort`, plus Colony's timer and reason | None |
| **Step cap** (25, or 80 on the desktop) | `stopWhen: stepCountIs` | A `beforeTool` hook counts tool rounds and blocks past the cap, then the model gives its answer. | Possibly one extra model call at the cap |
| **Restart / resume** | `runs` checkpoints, `resumeAll`, `restore()` | `harness.resume()` on boot. The "Colony restarted · picked up at step N" note stays. | The `runs` table retires (Phase 9). |
| **Re-run flags** | `SAFE_TO_REPEAT` (`run.ts:57-60`) | `ColonyTool.replay: "safe" \| "check"` → `"safe" \| "unsafe"`. `artifact_read` and `chat_files` (read) become safe. | None |
| **Approvals** | `ApprovalGate`; `adopt` reattaches after a restart | Gated tools wrapped by the effect ledger (3.4). The cards, push, 6 h timeout and fail-closed behaviour stay. Every approval goes to you. | `approverId` routing goes away with multi-user. |
| **Models and keys** | `resolveModel(ref, { ownerId })` → `defaultModelFactory` | `resolveModel(ref)` → `colony:<id>` provider. One list of providers, all yours. | Shared vs own keys go (multi-user). |
| **Usage and cost** | `finish-step` → `usageEntry` with payer and owner | Each settled assistant message → `usageEntry(bot, model, usage)`. pi-ai's `input` excludes cache reads (the AI SDK's includes them), so the mapping is tested. Prices stay Colony's. | Shared-key limits go. Settings › Spending shows your month and each Bot, with the 30-day chart. |
| **Anthropic** | `@ai-sdk/anthropic`, `anthropicCompat.ts`, adaptive thinking with `drop_block` | `anthropicMessagesApi()` with thinking and `cacheRetention: "long"` for persistent conversations | `anthropicCompat.ts` goes. pi-ai drops thinking blocks when the model changes. |
| **OpenAI-compatible** | `@ai-sdk/openai-compatible` | `openAICompletionsApi()` with compat flags per provider | Ollama, LM Studio and OpenRouter may need flags; Phase 3 tests each. |
| **Bot computer: desktop** | Claude uses `computerToolset_20260801`; others use `desktop_*` plus an extra user message per screenshot | All models use `desktop_*` with image tool results. `prepareDesktopMessages` (keep the newest 2 images) becomes a `beforeRequest` hook. | **Claude loses the trained computer-use tool.** Measured in Phase 6. |
| **Bot computer: shell, files, browser** | `toToolSet` | `toPiTools`: zod → `z.toJSONSchema` → TypeBox `Type.Unsafe`. Arguments are parsed with zod and secrets scrubbed, as now. | None |
| **PC tools** (node hub) | `pcToolsFor`, `toModelOutput` for screenshots | Same tools through `toPiTools`, screenshots as image output. The 120 s timeout stays. | Owner and person checks go (it's your PC). |
| **`message_bot`** | `consult()`: a nested run in a thread chat | The thread chat gets its own persistent conversation (so the helper Bot remembers past consults). The asking tool waits durably and reattaches after a restart. Depth limit stays 1. | Gain |
| **Voice calls** | `sendUserMessage(via: "voice")`; barge-in = steer | Unchanged (through `send.ts`); see 3.5 | None |
| **`call_user`, routines** | `AgentRunner.start` with a hidden prompt | Unchanged API. A routine runs in its chat's persistent conversation, so it sees earlier runs. | Gain |
| **Hand-over** | `transfers.ts` | Removed with multi-user | Gone (Phase 1) |
| **Desktop check** | `generateText` with an image | `models.complete` with an image part | None |

### 3.3 What would be lost

1. Claude's native computer-use toolset on the Bot's computer.
2. Token-by-token deltas (they'd arrive in batches of up to 100 ms).
3. `drop_block` thinking behaviour on Anthropic (expected to be harmless).
4. A stable dependency: we'd be tracking an experimental package through exact pins.
5. Everything multi-user, on purpose (Phase 1).

### 3.4 The effect ledger (approvals and "check" tools)

Pi durable either re-runs a cut-off tool (`safe`) or settles it as interrupted (`unsafe`). A tool waiting on your approval hasn't done anything yet, so after a restart it should ask again.

- **Migration:** `tool_effects(call_id PK, conversation_id, tool, phase TEXT, result TEXT, updated_at)`, where `phase` is `approval | acting | done`.
- Gated tools (`shell`, `mail_send`, `calendar_*`, `vault_save`, `browser_login`, PC tools that ask) are declared `replay: "safe"` and wrapped:
  1. `done`: return the stored result.
  2. `acting`: return "Colony restarted while this was running. It may or may not have happened; check before trying again."
  3. Otherwise ask (`gate.request` already reattaches to a pending approval and keeps its deadline). On approval write `acting`, run the effect, then write `done`.
- The key is the tool call id, if `execute` can see it. If it can't, the key is the conversation, tool and a hash of the arguments, which is what `adopt` matches on today.

### 3.5 Voice: keep the cascade

- **What's standard:**
  - The research (LiveKit, the OpenAI Agents SDK, Pipecat, Vapi; sources in the research notes) agrees that the cascade (speech-to-text → LLM → text-to-speech) is still the default for agents that use tools.
  - Speech-to-speech realtime models are lower latency, but tool calling is "supported, but varies by provider; can be less reliable" (LiveKit), and they're billed per second of audio.
  - Even LiveKit's GPT-Live setup hands tool calls to a separate text model.
  - Colony already does the standard thing: a normal Bot turn, with the reply spoken sentence by sentence and barge-in as steering.
- **The 100 ms batching doesn't matter.**
  - TTS services flush at sentence boundaries (ElevenLabs and Cartesia both recommend it), so speech starts when the first sentence is complete, not on the first token.
  - Good voice-to-voice latency is about 700 ms at p50 and under 1.4 s at p95, dominated by end-of-speech detection (LiveKit waits 0.5–3 s by default), model time-to-first-token and TTS.
  - Up to 100 ms on the first sentence is small next to those.
- **Not in this plan, but the usual next steps if calls feel slow:**
  - streaming speech-to-text instead of transcribing each clip after it ends;
  - a turn-detection model (Pipecat's Smart Turn, LiveKit's turn detector) instead of the energy detector;
  - on barge-in, cutting the Bot's message to what was actually played.

---

## 4. Storage

- **Where:** `data/agent.db` beside `colony.db`, opened with `openNodeSqliteStorage`. It's a separate file because pi runs its own schema migrations and refuses newer files. Both use `node:sqlite`, so there's no new native module.
- **Ownership:** one process. The server opens the harness after `openDb` and closes it on shutdown. The updater's restart closes the old harness before the new process opens it, with a test for this order.
- **Backups:** the updater's pre-update backup includes `agent.db`.
- **Growth:**
  - Conversations are now permanent, and old entries stay after compaction. A heavy chat might add a few MB a month. Images are the big item, so screenshots older than the newest two are stored as placeholders (as `runs` checkpoints do now).
  - Since there's no delete API, deleting a Bot or topic just unlinks its conversations.
  - Settings › This Colony shows the size of `agent.db`. If it ever matters, a maintenance step can copy only the live conversations into a fresh `agent.db` while no run is active.
- **Durability:** `synchronous = NORMAL` can lose the last commits on power loss, not on a process crash. That's the same as `colony.db`.
- **Changes to `colony.db`** are additive until the last phase, so an older Colony still opens it: `conversations`, `tool_effects`. The multi-user columns and the `runs` table are dropped only in Phase 9.

### 4.1 In-flight runs at install time

1. The updater already offers "Update now; Bots will pick up where they left off". No change there.
2. On first boot of the pi runtime:
   - each remaining `runs` row (an AI SDK `ModelMessage[]` snapshot) goes through today's `restore()` classification;
   - it is converted to pi-ai messages and seeded as the start of that chat's new persistent conversation;
   - it then continues into the same reply message.
3. A row that can't be converted is marked stopped with the existing restart text, and its approval expires (fail-closed).
4. Chats with no in-flight run are seeded lazily from their last 40 messages on their next turn.
5. The converter is tested against fixture checkpoints: text, tool calls, images, an approval wait and a steered message.

---

## 5. Removing multi-user

Done first, because it shrinks what the port has to carry.

### 5.1 Who gets in

- **The owner's login.** The owner is your tailnet login: `COLONY_ALLOWED_USERS` if set, otherwise the host login already recorded in `people`, otherwise the first login seen on a fresh install (shown in Settings with **Not you? Reset**, which only works from this PC).
- **Requests.** Any other login gets 403. Requests with no login header are allowed only from loopback, and the server refuses to start on a non-loopback `COLONY_HOST` without an owner login. Funnel stays refused.

Without this, removing `people.ts` would give every tailnet login full access.

### 5.2 What goes

- **Server:**
  - `transfers.ts`;
  - most of `people.ts` (`identify`, `canSee*`, `RULES`, `refusal`, `eventFor`; `authorOf` becomes `"user"`);
  - shared-key limits and payer logic in `spending.ts`;
  - provider ownership in `settings.ts` (`ownerId`, `ownModel`, `spendLimit`, per-person voice);
  - the identity middleware and person filters in `api.ts`, `index.ts`, `push.ts` and `send.ts`;
  - the `/family`, `/people`, `/household`, `/transfers`, `/bots/:id/give` and `/spending/shared` routes;
  - `approverId` routing (every approval is yours).
- **Web:**
  - `People.tsx`, `GiveBot.tsx` and the shared-keys part of `Spending.tsx`;
  - the You / This Colony split (back to one Settings);
  - owner dots, "Waiting for {name}", the first-run family card;
  - people pickers and "Everyone" in the topic dialog, and @Person.
- **Desktop:** the owner name on the PC pill. The 403 text now points at the owner login.
- **Types:** `Person`, `PersonRole`, `BotTransfer`, `SharedSpending`; owner and person fields on `Bot`, `Chat`, `Account`, `Approval`, `PcNode` and `Provider`.

### 5.3 What stays

- **Topics, folders, multi-Bot topics, routines, artifacts, files, voice, This PC.**
- **USER.md** (`data/USER.md`). If `HOUSEHOLD.md` has content, it's appended to `USER.md` once.
- **The usage log and a personal Spending page:** this month's total, each Bot, the 30-day chart and unpriced models.

### 5.4 Data

- **Migration v18:**
  - Everything recorded as the host's stays.
  - Other people's credentials (accounts, personal providers, lent PCs) and their Bots, topics and pending transfers are deleted. The updater's pre-update backup still has them. The migration logs the counts.
  - Columns stay, unused, until Phase 9 drops them, so 0.2.0 can still open the database during rollback.
  - Family shipped on 2026-10-15 and Colony was shelved the same day, so this is expected to be empty. The release notes still say what happens.
- **Tests:** tests of removed features are deleted with them: the 13 in `people.test.ts`, and 2 of the 4 in `nodes.test.ts` (lent PC, someone else's Bot). Others are rewritten to the single-user rule (`access.test.ts`, 2 cases in `nodes.test.ts`, any person-routing asserts in `run.test.ts` and `voice.test.ts`). New tests cover the owner-only gate. The commit message records the count before and after.

---

## 6. Phases

Rules for every phase:

- **Commits:** one commit per phase on `pi-durable`; no pushes. Each is gated by `npm run check` (root) and `npx vitest run` in `server`.
- **Tests:** every existing test keeps passing, except tests of removed features (Phase 1) and tests whose subject moves (for example the `.provider` string in `settings.test.ts`), which are rewritten in the same commit to assert the new equivalent.
- **Sandbox:** manual checks run with `COLONY_DATA_DIR` set to a temp folder, `COLONY_PORT` set to a free port (so there's no clash with the live server), `COLONY_DESKTOP_DATA` for the desktop app, and a fresh sandbox Bot computer, never `colony-13b2aaec`. The real `colony\data`, `%APPDATA%\Colony` and the installed server aren't touched.
- **Pins:** exact versions for `@earendil-works/pi-durable`, `pi-ai` and `chord`.

### Phase 1: Single-user

Section 5: owner-only access, removals, migration v18, tests.

Exit check:
- On the sandbox, your login and loopback get in, and a second login (a fake `Tailscale-User-Login` header) gets 403.
- A copy of a v17 test database with a host and one family member migrates to v18: host data kept, the member's gone, `USER.md` merged.
- The web app has no Family or You / This Colony screens.

### Phase 2: A runtime seam (no behaviour change)

- Split `AgentRunner` into the public runner (same methods) and a `Runtime` interface. Today's loop moves to `agent/runtime/aiSdk.ts`.
- `ColonyTool.replay` replaces `SAFE_TO_REPEAT`.
- A runtime switch: `COLONY_RUNTIME=ai-sdk|pi` (default `ai-sdk`).

Exit check: all tests pass untouched, and the sandbox chats, steers and resumes after a kill as before.

### Phase 3: Provider layer on pi-ai

- `agent/pi/models.ts`: one `Models`, one `colony:<id>` provider per provider row, kept in sync on add, edit and remove.
- `usageEntry` accepts pi-ai `Usage`.
- `desktopCheck` runs through pi-ai under the pi runtime.
- Node raised to 22.19 in `engines` and `install.ps1`.

Exit check: tests for provider sync, the right key on each request, and the usage mapping (cache reads and writes priced as today). One live call each to Anthropic and an OpenAI-compatible endpoint on the sandbox.

### Phase 4: Pi runtime with persistent conversations, behind the switch

- `agent/runtime/pi.ts`:
  - the harness on `data/agent.db`;
  - the `conversations` table, with lazy seeding from the last 40 messages;
  - `write` entries for other Bots in topics;
  - the per-turn system prompt;
  - `toPiTools`;
  - the event bridge;
  - stop and timeout, step cap, steer, follow-up, Steer now and Cancel;
  - usage rows.
- Compaction: pi defaults plus Colony's `beforeCompact` instruction, a step-log marker, and **Compact now** and **Start fresh** in the chat menu.
- `run.test.ts` is parameterized over both runtimes, with a scripted fake pi-ai provider for pi.

Exit check:
- `run.test.ts` passes on both runtimes.
- A test drives a conversation past a small fake context window: it compacts, the summary is in the next request, and old entries are still in storage.
- On the sandbox:
  - a Bot remembers something from 60 messages back;
  - a topic Bot sees another Bot's reply;
  - steer, queue, Steer now, Cancel and Stop all work;
  - Compact now shows the marker.

### Phase 5: Durability and approvals on pi

- The `tool_effects` ledger and gated-tool wrapper (3.4).
- `harness.resume()` on boot, plus the restart notes.
- Durable `message_bot`.
- The legacy `runs` converter (4.1).

Exit check: kill the sandbox server:
- during a read: it re-runs;
- during a write: the model is told to check;
- while waiting on an approval: the same card still works, and approving runs the action once;
- during a `message_bot` consult: the answer still arrives;
- mid-stream: the reply continues.

Also, a fixture AI SDK checkpoint converts and continues. Automated equivalents go in `run.test.ts`.

### Phase 6: Bot computer, desktop and PC tools

- `desktop_*` for all models, with image tool results; `prepareDesktopMessages` as a `beforeRequest` hook.
- PC tools through `toPiTools`.
- `anthropicCompat.ts` unused under pi.

Exit check:
- `desktop.test.ts` and `nodes.test.ts` pass on both runtimes.
- `desktopCheck` passes for Claude and one OpenAI-compatible vision model.
- On the sandbox, Claude does the 0.2.0 click-through task on its sandbox computer, under both runtimes, and the success and step count are recorded here.
- A dev desktop app (`COLONY_DESKTOP_DATA`) lends the PC: browser, screenshot, shell, each with its approval.
- If Claude is clearly worse without the native toolset, stop and decide before Phase 8.

### Phase 7: Forks

- **Branch from here** on any Bot message: `fork(entryId)`, then a new topic (title and folder from the dialog) linked to the fork.
- A small "Branched from {chat} · {date}" line at the top of the new topic, linking back.

Exit check: a test that a fork's first request contains the parent's context up to the branch point and nothing after. On the sandbox, branching mid-chat gives a topic that knows the earlier discussion, and the original chat is unchanged.

### Phase 8: End to end; pi becomes the default

- On the sandbox under pi: a voice call with barge-in, `call_user`, routines (scheduled and mail-triggered, each seeing its earlier runs), mail, calendar and vault approvals, artifacts and files.
- `COLONY_RUNTIME` defaults to `pi`. The AI SDK runtime stays for one release as the fallback.

Exit check: everything above passes, and a release candidate installed into a sandbox `COLONY_HOME` updates from 0.2.0 while a run is in flight and continues it.

### Phase 9: Cleanup (a later release, after a clean week on pi)

- Remove `runtime/aiSdk.ts`, `anthropicCompat.ts`, `ai` and `@ai-sdk/*`.
- Migration v19 drops `runs`, `bot_transfers`, `chat_people`, `people` and the owner, person, approver and payer columns.
- Port the tests that used `MockLanguageModelV4` to the fake pi-ai provider, keeping each assertion.

Exit check: no `ai` / `@ai-sdk` imports, and all tests pass.

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Upstream breaks the API again | High | Exact pins and deliberate upgrades. All pi calls live in `agent/pi/` and `runtime/pi.ts`. The fake-provider tests act as a contract suite on each upgrade. |
| Another tailnet login gets in after the people code goes | Medium if missed | Owner-only gate is Phase 1's first item, with tests. |
| Approvals duplicate or vanish across restarts | Medium | Effect ledger (3.4) and the Phase 5 kill tests |
| Compaction loses something important | Medium | Colony's `beforeCompact` instruction, `MEMORY.md` for durable facts, the summary visible in the step log, and the full history kept in storage |
| Persistent conversations raise cost (longer contexts) | Medium | Compaction keeps them under the context window. `cacheRetention: "long"` on Anthropic. Spending shows each Bot. A per-Bot `keepRecentTokens` could be lowered if needed. |
| Claude computer use gets worse | Medium | Measured in Phase 6 before the default flips |
| `watchEvents` (experimental) changes | Medium | The event bridge is one file. A `Models` wrapper that taps pi-ai's stream is the fallback. |
| `agent.db` grows with no delete API | Low | Placeholders for old screenshots, the size shown in Settings, a copy-live-conversations maintenance step |
| Two processes open `agent.db` during an update | Low | Close-before-open order in the launcher, with a test |

## 8. Rollback

- **Phases 2–8:** set `COLONY_RUNTIME=ai-sdk` and restart. `colony.db` only gained tables, and the AI SDK runtime goes back to `historyFor` (last 40 messages), which still works because `messages` is complete. `agent.db` is ignored. Runs in flight on pi at that moment are marked stopped with the restart text, and their approvals expire.
- **Phase 1 (single-user):** install 0.2.0 from `%LOCALAPPDATA%\Colony\versions`. It opens the v18 database because the columns are still there. Deleted family data comes back only by restoring the pre-update backup.
- **After Phase 9:** install the previous release from `versions`. Its database expectations match v18 or v19 except for the dropped `runs` table, which it recreates empty. If needed, restore the updater's pre-update backup.
- **Before anything ships:** `main` stays on 0.2.0 and this branch can be dropped.

## Open questions

1. If Claude is measurably worse on its computer without the native toolset (Phase 6), do we stop there, or accept it for persistent Bots?
2. Should other people's data be deleted by migration v18 (as planned, with the backup as the safety net), or should the upgrade refuse until you confirm?

## Where the build differs

What shipped follows the plan except where noted here.

- **Phase 0** was dropped: you asked to go straight to the build.
- **Owner login (Phase 1):**
  - Your login is recorded the first time Colony sees one, as planned, or taken from the family build's host.
  - Requests with no login header are still allowed (Colony listens on 127.0.0.1 unless `COLONY_HOST` says otherwise). There's no startup refusal for a non-loopback `COLONY_HOST`.
- **What Bots know about you** is edited in a Bot's profile (memory, "About you"), as before the family build. The Family page's notes box went with it. `HOUSEHOLD.md` is folded into `USER.md` once, a line per entry.
- **The effect ledger** uses pi durable's durable per-call memo (`api.memo`) instead of a `tool_effects` table. A tool that asks first records "acting" once you approve; a rerun after a restart then says it may already have happened. No migration was needed.
- **`message_bot`** is durable the same way: the asking call remembers which reply it's waiting for and waits for it again after a restart.
- **Step cap:** the tool wrapper refuses calls past the cap ("reply with what you have") rather than a `beforeTool` hook.
- **Compaction** uses pi's defaults. There's no Colony instruction added to automatic summaries: a `beforeCompact` hook can only decline or replace a summary, not add instructions.
- **Start fresh** resets the Bot's context in the same conversation (pi's `reset()`), rather than starting a new conversation. Everything before stays in storage.
- **History bookkeeping:** `conversations`, `conversation_seen` (which chat messages each conversation has taken in) and `message_entries` (where each reply ended, for branching), all in migration v19.
- **Thinking:** models the catalog marks as reasoning run at pi's "medium" level.
- **Turns the AI SDK runtime was running** at the update continue as a new pi turn in the same reply, with the cut-off steps marked interrupted and a note telling the model so. Checkpoints aren't converted message by message.
- **Desktop check** still uses the AI SDK until Phase 9.
- **`agent.db` size** isn't shown in Settings yet.
- **Branch from here** asks for the new topic's name with the browser's prompt. The topic starts with a "Branched from …" line, which doesn't link back.
- **Tests:** 145 at the start; 13 family tests went in Phase 1. With the new owner-login, migration, provider, pi runtime, compaction, branching, desktop and kill-and-restart tests, there are 164.
