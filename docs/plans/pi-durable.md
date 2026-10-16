# Plan: Move the agent runtime to pi durable

Status: plan only, 2026-10-15, on branch `pi-durable`. Nothing is built yet. Phase 0 is a spike that ends in a go/no-go decision.

Follows `pip-parity.md` (section 0 explains why we stayed on the AI SDK) and `family.md`. Colony is in use again, so this plan also covers moving runs that are in flight on the live server when the new version is installed.

## Summary

Pi durable (`@earendil-works/pi-durable`) is a durable agent harness: model turns, tool calls and steering are committed to storage before anything is shown, and reopening the storage resumes the work. Colony already has its own version of the parts we needed (steering through `prepareStep`, per-step checkpoints in `runs`, `resumeAll`, a re-run allowlist, approvals that reattach after a restart). The port would replace about 600 lines we own with a library we don't, and give us a few things we don't have: durable Bot-to-Bot calls, crash recovery inside a model call, compaction, forks and deferred (batch) responses.

It also has real gaps for Colony. There is no built-in way to pause a tool for a human approval across a restart. There is no per-person API key hook. Anthropic's computer-use toolset isn't supported. Live text arrives in commits at most every 100 ms through an API marked experimental. And the package is still labelled "Experimental. The API changes without notice": version 1.3.0 shipped today, and 4 of its last 8 releases broke something.

**Recommendation:** run Phase 0 (a contained spike, about a day) before committing to the port. If every Phase 0 check passes, port behind a runtime switch (Phases 1–6) and remove the AI SDK only after a release on pi has run cleanly (Phase 7). If the per-person key check or the approval check fails, stop and stay on the AI SDK.

---

## 1. Where pi durable is now

Researched 2026-10-15 from the npm tarballs (`.d.ts`, compiled `dist/`, README, CHANGELOG), the GitHub repo `earendil-works/pi` (`packages/durable`) and the launch post (earendil.com/posts/pi-durable).

### 1.1 Version and stability

- **Latest:** `@earendil-works/pi-durable` 1.3.0, published 2026-10-15. 1.0.0 came out around 2026-10-02, and the run continued 1.0.3/1.0.4 (10-05), 1.1.0 (10-07), 1.2.0 (10-12) and 1.3.0 (10-15). (Section 0 of `pip-parity.md` saw 0.0.1 → 1.2.0 in three weeks.)
- **Exact dependency pins:** it pins `@earendil-works/pi-ai`, `@earendil-works/chord` and `@earendil-works/pi-codemode` to exactly 1.3.0, so the four move together. Other dependencies are `typebox` 1.3.x, `diff` and `@silvia-odwyer/photon`.
- **Stability:** the README still opens with "Experimental. The API changes without notice between releases." There is no semver policy; 1.x doesn't mean stable.
- **Breaking changes:**
  - 1.0.3: `FileSystem`/`BinaryReader` contracts.
  - 1.0.4: watch behaviour.
  - 1.1.0: `order` on `Storage`; `TaskRuntime.context`.
  - 1.2.0: tagged unions; tool result `content` → `output`; storage errors; `StorageRejected` removed.
  - 1.3.0: none listed.
- **Open upstream changes that affect us:** #10858 (`ToolControl` `terminate` type change in progress) and #11014 (storage commit errors missing from summaries).
- **Runtime requirements:** Node `>=22.19.0` and ESM only. Colony is ESM and this PC runs Node 22.23.2, but Colony's `engines` and `scripts/install.ps1` say 22.13, so both need raising. MIT licence.

### 1.2 The Node/TypeScript API (1.3.0)

| Area | API |
|---|---|
| Open | `openNodeSqliteStorage(path)` (uses `node:sqlite` `DatabaseSync`, the same driver as `colony.db`); then `Harness.open(storage, options, context)`. `HarnessOptions`: `models`, `registry`, `settings`, `env`, `conversationCreated`, `now`, `onReport`. |
| Conversations | `harness.createConversation(options, ctx)`, `harness.conversation(id, ctx)`, `harness.resume()` restarts durable work after open. |
| Turns | `conversation.submit({ type: "input", content, whenBusy: "steer" \| "followUp" \| "reject", requestId? }, ctx)`. Resubmitting the same `requestId` finds the existing submission. |
| Model | Agent state: `ModelRef = { provider, modelId }` plus the thinking level, set with `conversation.configure(change, ctx)` and read on every generation. |
| Tools | `defineTool({ name, description, parameters /* TypeBox */, execute(args, api, ctx), replay?: "safe" \| "unsafe", executionMode?, structuredOutputSchema? })`. The result `output` is pi-ai `(TextContent \| ImageContent)[]`, so images can go back to the model in a tool result. `api` offers `createTask`, `waitForTask`, `output(chunk)`, `details(...)`. |
| Hooks | `beforeTool` can block a call with a message. `beforeRequest` can replace the messages sent to the model. |
| Steering | A busy `submit` goes to the `pi.inbox` document. Steers are placed after tool results, before the next model call (`postTools`), and at the final answer. Follow-ups wait for the end of the turn. |
| Events | `watchEvents(harness, conversationId, ctx)` (marked experimental) produces `message_update` (`text_delta`, `thinking_delta`, `toolcall_delta`) and `usage_changed`. Events are derived from commits. Partial output is committed at most every `progress.partialIntervalMs` (default 100 ms). |
| Usage | `Usage { input, output, cacheRead, cacheWrite, cost }` per assistant message; `harness.usage(ctx)` gives totals per model and per tool. |
| Abort | `submission.abort`, `conversation.abort`, `harness.abortSubmission`, `harness.abortTask`. Tools get an `AbortSignal`. |
| Tasks | Durable state machines (`pending → running → waiting → completing`, with terminal `faulted` and `orphaned`). A tool can start child tasks and wait on them. Sub-agents are child tasks. On restart, `running` tasks go back to `pending` and continue from their checkpoint. |
| Forks | `prepareForkDocumentCopies(storage, parentId, at, childId, ctx)` copies a conversation's documents at a point in its transcript. |
| Compaction | `createCompaction` and `selectCut(view, keepRecentTokens)`. Older entries stay in storage. |
| Deferred | Provider batch responses (`stopReason: "deferred"`), polled with a window of 15 m, 1 h or 24 h. |
| Context | Every call takes a chord `Context` (`abortSignal`, `value(key)`). Use `BACKGROUND_CONTEXT` as the root and derive per-request contexts with `withAbortSignal`. |

### 1.3 Crash and resume semantics

- **Tool calls** are checkpointed in phases:
  - A call cut off before it ran is resolved again and not executed.
  - A call cut off while it ran is re-run if `replay: "safe"` (the default is `"unsafe"`).
  - Otherwise the call is settled as interrupted, "may have partially run", and the model sees that.
- **A model call** cut off mid-stream keeps its committed partial output as an aborted entry, and the request is sent again.
- **Storage:** one process owns a storage at a time, with no cross-process lock. SQLite runs in WAL with `synchronous = NORMAL`. The schema is versioned (`durableSchema`, with migrations in one transaction), and an older library refuses to open a newer file.

### 1.4 pi-ai, the provider layer

- **Providers:** `createProvider({ id, baseUrl, auth, models, api })`, where `api` is `anthropicMessagesApi()`, `openAICompletionsApi()`, `openAIResponsesApi()` and others. Model ids are free strings. A `Models` collection holds providers and is changed with `setProvider`. OpenAI-compatible endpoints are tuned with compat flags (`supportsDeveloperRole`, `maxTokensField`, `thinkingFormat`…).
- **API keys:** in pi-ai, a per-call `apiKey` wins over the provider's own auth. Pi durable's generation never passes one, though. It passes only `settings.stream` (harness-wide), `signal`, `sessionId` and `reasoning`, and it doesn't pass the conversation id to `Models`. So **a key can only be chosen per provider**, through the provider's `auth.apiKey.resolve`.
- **Anthropic:** thinking (budget, interleaved), prompt caching (`cacheRetention`), images, and beta headers set automatically. Server or provider-defined tools aren't supported at all: there's no computer use and no `web_search`. pi-ai has `onPayload` for raw payload edits, but durable doesn't pass it through.
- **Cost:** per-million prices come from static JSON bundled in the package, and `calculateCost(model, usage)` uses them.

---

## 2. What we'd gain

Measured against what Colony already has in-house:

| Today (in-house) | With pi durable | Gain |
|---|---|---|
| Steering via `prepareStep` + `inbox`, queue via `followUp` | `whenBusy: "steer" \| "followUp"`, persisted in `pi.inbox` | Small. Same placement (before the next model call). Steers survive a crash; today a steer in the inbox at crash time is lost. |
| Checkpoint per step in `runs`; a crash mid-model-call loses that step's partial text | Partial output committed every 100 ms and the request re-sent | Small. |
| `SAFE_TO_REPEAT` name list + `restore()` classification | `replay` per tool, with interrupted calls settled by the harness | Small. We'd keep our ledger for approvals anyway (section 3.4). |
| `consult()` nests a run with `depth + 1`; on restart the asking Bot's `message_bot` call is cut off and gets "check before retrying" | `message_bot` becomes a durable child task: both sides resume and the answer arrives | **Real.** Bot-to-Bot help survives restarts. |
| `historyMessages: 40`, a fixed window | Compaction (`selectCut`) | Real, but only if pi owns history (deferred; see section 3.1). |
| Nothing | Forks at a transcript point | New feature option: "branch this topic from here". |
| Nothing | Deferred (batch) responses | Cheaper routines that don't need an answer within minutes. |
| ~600 lines in `run.ts` we maintain | Upstream maintains the loop | Less code of ours, but we'd now track an experimental API that changes every few days. |
| AI SDK (`ai` 7, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`) | pi-ai | Image tool results on every provider, which would remove the "screenshot as a separate user message" workaround for OpenAI-compatible models (to verify in Phase 0). |

Bottom line: the durable parts we needed are already built. The gains that are actually new are durable Bot-to-Bot calls, compaction, forks and batch responses.

---

## 3. Feature by feature

### 3.1 Shape of the port

Three decisions shape the rest:

- **One pi conversation per run, not per chat.**
  - Colony's `messages` table stays the source of truth for the transcript, the UI, topics, groups, people, hand-over and visibility. Each run builds its history the same way it does now (`historyFor`) and seeds a fresh pi conversation with it: through conversation creation options if they allow it, otherwise through a `beforeRequest` hook (Phase 0 decides).
  - This matches today's `runs` row (one checkpoint per run). It keeps group topics simple (other Bots' and people's messages are already attributed in `historyFor`), and the system prompt is rebuilt every turn as now.
  - The cost: no compaction or forks yet. "Conversation per chat" can come later (section 6, "later").
- **One pi-ai provider per Colony provider row.** The provider id is `colony:<providerId>`. `auth.apiKey.resolve` reads that row's key from `colony.db`. The Bot's resolved model becomes `ModelRef { provider: "colony:<id>", modelId }`. Shared and personal keys are then just different providers, so the per-provider key hook is enough.
- **Colony keeps its own wire protocol.** The web app keeps consuming SSE `ServerEvent`/`EphemeralEvent`. An event bridge maps harness events onto `message.delta`, `message.upserted` and steps. Neither the web app nor the desktop app changes, apart from Phase 5's desktop work.

### 3.2 Mapping

| Feature | Today | On pi durable | Lost or changed |
|---|---|---|---|
| **Streaming deltas** | `fullStream` `text-delta` / `reasoning-delta` → ephemeral `message.delta` (`run.ts:417-473`) | `watchEvents` `message_update` → the same `message.delta`. If 100 ms is too coarse, a `Models` wrapper can tap pi-ai's event stream before the harness. | Deltas batched at ≤100 ms. `watchEvents` is experimental. |
| **Steps** (step log) | `tool-call` / `tool-result` parts → `Step` rows in `messages.steps` | Tool-call entries and tool execution start/settle → the same `Step`s. `interrupted` comes from the harness's interrupted settlement. | None expected. |
| **Steering** | `deliver` → `inbox` → `prepareStep` (`run.ts:364-386`); a steer splits the reply | `deliver` → `submit({ whenBusy: "steer" })`. Inbox consumption drives the reply split and `steered_at`. | Pickup now happens only after a tool round or at the final answer. Today `prepareStep` also runs before the first step, so a steer that arrives during the first model call (before any tool) waits for that call. Same in practice. |
| **Queue / Steer now / Cancel** | Colony `delivery: "queued"` + `followUp` | Keep Colony's queue. Queued messages are only submitted when the run ends. "Steer now" submits with `"steer"`. | None. |
| **Stop, turn timeout** | `AbortController`, `"stopped"` / `"timeout"` | `conversation.abort` plus a Colony timer. The reason is kept on the Colony side for the error text. | None. |
| **Step cap** (`maxSteps` 25 / desktop 80) | `stopWhen: stepCountIs` | A `beforeTool` hook counts tool rounds and blocks past the cap, then the model is told to finish. Phase 0 confirms the model then answers. | Possibly one extra model call at the cap. |
| **Checkpoint / resume** | `runs` rows, `resumeAll`, `restore()` | `harness.resume()` on boot. Colony's `runs` table becomes `pi_runs(run_id, conversation_id, message_id, …)` linking a run to its conversation. | The "Colony restarted · picked up at step N" note stays, driven by Colony on boot. |
| **Re-run flags** | `SAFE_TO_REPEAT` set (`run.ts:57-60`) | `ColonyTool.replay: "safe" \| "check"` (as `pip-parity.md` 2.3 meant) → `replay: "safe" \| "unsafe"`. Phase 1 also moves `artifact_read` and `chat_files` (read) to safe. | None. |
| **Approvals** (`ApprovalGate`, `approverId`) | `gate.request` awaits inside `execute`. On restart `adopt` reattaches by messageId + tool + detail and keeps the deadline. | Gated tools become `replay: "safe"` and stay idempotent through an **effect ledger** (section 3.4): on re-run they find the pending approval and wait again, or return the recorded result. `approverId` routing, the 6 h timeout, push and the cards stay Colony code. | None if the ledger works. This is a Phase 0 go/no-go check. |
| **Per-person models** (shared vs own keys) | `resolveModel(ref, { ownerId })` → `defaultModelFactory` | `resolveModel` unchanged. A factory registers or updates `colony:<id>` providers in one `Models` whenever providers change. | The key is chosen per provider row rather than per call. This is equivalent, because a person's key is its own row. |
| **Usage and cost** (`spending.ts`) | `finish-step` → `usageEntry(LanguageModelUsage)` → `usage` row with `payerId` | Each settled assistant message's `Usage` → `usageEntry`. Map `input`/`cacheRead`/`cacheWrite`/`output`: pi-ai's `input` excludes cache reads, the AI SDK's includes them, so the mapping is tested. Prices stay Colony's (`prices.ts`, editable); pi-ai's catalog cost is ignored. | None. |
| **Monthly limit** | Checked at turn start (`run.ts:323-327`) | Same check before `submit`. | None. |
| **Anthropic provider** | `@ai-sdk/anthropic` + `anthropicCompat.ts` fetch patch; adaptive thinking with `drop_block` | `anthropicMessagesApi()` with thinking and `cacheRetention`. The `toolset_name` patch goes away with the computer toolset. | `prefixMismatchBehavior: "drop_block"` has no direct option. pi-ai drops thinking blocks when the model changes, which covers the case we added it for. |
| **OpenAI-compatible** | `@ai-sdk/openai-compatible` `chatModel` | `openAICompletionsApi()` with compat flags per provider; "Responses" as an option later | Some endpoints may need compat flags set (Ollama, LM Studio, OpenRouter). Phase 2 tests each kind we list. |
| **Desktop / computer use** (the Bot's Linux computer) | Claude: `anthropic.tools.computerToolset_20260801` (provider-defined). Others: `desktop_*` tools + screenshot as an extra user message (`prepareDesktopMessages`) | Every model uses the `desktop_*` tools, with screenshots as image tool results. `prepareDesktopMessages` becomes a `beforeRequest` hook (keeps the newest two images). | **Loss:** Claude no longer uses Anthropic's trained computer-use tool, so precision may drop. Phase 5 measures it with `desktopCheck`. The workaround (a custom provider injecting the toolset) is fragile and not planned. |
| **Computer tools** (`shell`, files), **browser tools** | AI SDK `tool()` via `toToolSet` | `toPiTools`: zod → JSON Schema (`z.toJSONSchema`) wrapped as TypeBox `Type.Unsafe`. Execute parses with the same zod schema and scrubs secrets as now. | None. |
| **PC tools over the node hub** (`nodes.ts`) | `pcToolsFor` builds tools with `toModelOutput` for screenshots; approvals go to the PC's owner | Same tools through `toPiTools`. Screenshots become image output. The 120 s call timeout and "The PC disconnected" stay. `replay` follows the table in `pip-parity.md` 2.3. | None. |
| **`message_bot` / consult** | `consult()` starts a nested run and awaits `onFinish` | Phase 3: the same nested Colony run. Phase 4: the asking side waits on the answering run durably (a child task, or a ledger entry keyed by tool call id that reattaches to the thread run on restart). Depth limit 1 stays. | None. This is a gain after Phase 4. |
| **Voice calls** (`voice.ts`) | `sendUserMessage(via: "voice")` → a normal run; barge-in = steer | Unchanged: it goes through `send.ts`. Sentences for TTS come from the same `message.delta` stream. | The 100 ms batching may add up to 100 ms before the first sentence. |
| **`call_user`** | Tool that rings and ends the turn | Through `toPiTools`. | None. |
| **Routines** (`routines.ts`) | `start` with a hidden prompt; `onFinish` sets `lastStatus` | Unchanged API (`AgentRunner.start`). Later: deferred responses for routines marked "not urgent". | None. |
| **Hand-over** (`transfers.ts`) | `stopBot`, move, reset grants, switch model if on the giver's key | Unchanged: `stopBot` aborts the pi conversation. Pending approvals expire with it, as now. | None. |
| **Desktop check** (`desktopCheck.ts`) | `generateText` with an image | `models.complete` (pi-ai) with an image part. | None. |
| **Provider connection check** | Plain `GET /models` | Unchanged. | None. |
| **Photos in chat** | `ImagePart` for vision models | pi-ai `ImageContent` in seeded history | None. |

### 3.3 What would be lost, in one place

1. Anthropic's native computer-use toolset for Claude on the Bot's computer (section 3.2, desktop row).
2. Token-by-token deltas: they'd arrive in batches of up to 100 ms, unless we tap pi-ai's stream in a `Models` wrapper.
3. `drop_block` thinking behaviour on Anthropic (expected harmless).
4. A stable dependency: we'd be tracking an experimental package by pinned versions.

### 3.4 The effect ledger (approvals and "check" tools)

Pi durable either re-runs a cut-off tool (`safe`) or settles it as interrupted (`unsafe`). Colony needs a third case: a tool waiting on a person hasn't done anything yet, so after a restart it should ask again, not report "may have partially run".

- **Migration:** `tool_effects(call_id PK, run_id, tool, phase TEXT, result TEXT, updated_at)`, where `phase` is `approval | acting | done`.
- Gated tools (`shell`, `mail_send`, `calendar_*`, `vault_save`, `browser_login`, PC tools that ask) are declared `replay: "safe"` and wrapped:
  1. If the ledger says `done`, return the stored result. Don't run it again.
  2. If it says `acting`, return "Colony restarted while this was running. It may or may not have happened; check before trying again." This is today's text.
  3. Otherwise go to the approval step. `gate.request` already reattaches to the pending approval (`adopt`) and keeps its deadline.
  4. On approval, write `acting`, run the effect, then write `done` with the result.
- This needs a stable tool call id inside `execute`. If 1.3.0 doesn't expose one, the ledger keys on run id + tool + a hash of the arguments, the same as `adopt` does today. Phase 0 checks which.

---

## 4. Storage

- **Where:** a separate file `data/agent.db` next to `colony.db`, opened with `openNodeSqliteStorage`.
  - Not inside `colony.db`: pi runs its own schema migrations and refuses newer files, and keeping it separate means rollback is "delete one file".
  - Both use `node:sqlite`, so there's no new native module.
- **Ownership:** one process owns `agent.db`. The server opens the harness in `index.ts` after `openDb` and closes it on shutdown. The updater's restart (`updates.ts`) must close the old process's harness before the new one opens it. The launcher already starts the new version only after the old one exits, and Phase 3 adds a test for this order.
- **Backups:** the updater's pre-update backup includes `agent.db` as well as `colony.db`.
- **Growth:** finished conversations are deleted 24 h after the run ends, like `runs` rows today. If 1.3.0 has no delete, the fallback is to rotate `agent.db` when no run is active (checked in Phase 0).
- **Durability:** `synchronous = NORMAL` can lose the last commits on power loss (not on a process crash). That's acceptable for a home server, and the same as `colony.db`.
- **Changes to `colony.db`** are additive only, so an older Colony can still open it:
  - `pi_runs(run_id PK, conversation_id, chat_id, bot_id, message_id, options TEXT, started_at)`;
  - `tool_effects` (section 3.4).
  - The old `runs` table stays until Phase 7.

### 4.1 Moving runs that are in flight at install time

Colony is live, so the release that switches the runtime has to handle runs that were going when it was installed:

1. The updater already lets runs finish or offers "Update now; Bots will pick up where they left off". Nothing changes here.
2. On first boot of the pi version, each remaining `runs` row (AI SDK `ModelMessage[]` snapshot) goes through today's `restore()` classification first: safe calls re-run, others are marked interrupted, approvals are re-asked. It is then converted (`ModelMessage` → pi-ai `Message`, images re-attached as placeholders the way checkpoints store them now) and seeded into a new pi conversation that continues the same reply message.
3. A row that fails to convert is marked stopped with the existing "Colony restarted while this reply was running." text. Its pending approval expires, which is fail-closed.
4. Converted rows are deleted from `runs`. The table is dropped in Phase 7.

The converter is tested against fixture checkpoints captured from the AI SDK runtime: text, tool calls, images, an approval wait and a steered message.

---

## 5. Phases

Rules for every phase:

- One commit per phase on `pi-durable`; no pushes.
- Each commit is gated by `npm run check` (root) and `npx vitest run` in `server`. The 145 existing server tests keep passing at every phase. Tests whose subject changes (for example the `.provider` string asserted in `settings.test.ts`) are updated in the same commit to assert the new equivalent, and the count never drops.
- Manual checks run against a sandbox: `COLONY_DATA_DIR` set to a temp folder, `COLONY_PORT` set to a free port so it can't clash with the live server, and `COLONY_DESKTOP_DATA` for the desktop app. The real `colony\data`, `%APPDATA%\Colony` and the installed server are never touched. The Bot computer for tests is a fresh sandbox container, not `colony-13b2aaec`.
- Pin `@earendil-works/pi-durable`, `pi-ai` and `chord` to exact versions (no `^`).

### Phase 0: Spike and go/no-go

The Phase 0 code (`server/src/agent/pi/spike.test.ts`) stays only while it earns its keep. It answers each question with a passing or failing test, using a scripted fake pi-ai provider (a custom `api` whose `stream` yields scripted events) and, where it matters, a real provider with a sandbox key.

1. **Keys:** two `colony:<id>` providers with different keys, two concurrent conversations, and each request carries the right key. *(go/no-go)*
2. **Approvals:** a `replay: "safe"` tool waiting on a promise, with the harness closed and reopened. The tool re-runs, finds the ledger entry, and waits again without a duplicate effect. A stable tool call id is or isn't available in `execute`. *(go/no-go)*
3. **History:** a new conversation can be seeded with prior user/assistant/tool messages (creation options or `beforeRequest`).
4. **Steering:** a steer submitted during a tool lands before the next model call.
5. **Streaming:** `watchEvents` gives text deltas with run-to-run latency ≤100 ms; tapping a `Models` wrapper gives raw deltas.
6. **Images:** image tool results reach Anthropic and an OpenAI-compatible endpoint.
7. **Step cap:** a `beforeTool` block past N rounds ends the turn with a final answer.
8. **Storage:** conversations can be deleted; `node:sqlite` on Windows with `agent.db` beside a WAL `colony.db`; harness close/reopen order.
9. **Schemas:** zod → `z.toJSONSchema` → `Type.Unsafe` is accepted, and invalid arguments are rejected.

Exit check: a short "Phase 0 findings" section appended to this file with each answer, and a go or no-go from you before Phase 1. If 1 or 2 fails, stop: section 0 of `pip-parity.md` stands and this branch keeps only the plan.

### Phase 1: A runtime seam (no behaviour change)

- Split `AgentRunner` (`run.ts`) into the public runner (the same methods: `start`, `deliver`, `steerNow`, `unqueue`, `stop`, `stopBot`, `consult`, `resume`, `resumeAll`) and a `Runtime` interface. The current code moves to `agent/runtime/aiSdk.ts`.
- `ColonyTool` gets `replay: "safe" | "check"`, replacing `SAFE_TO_REPEAT`. Adapters stay per runtime (`toToolSet` for the AI SDK).
- A runtime switch: `COLONY_RUNTIME=ai-sdk|pi` (env, default `ai-sdk`).

Exit check: the 145 tests pass untouched, and the sandbox server chats, steers and resumes after a kill exactly as before.

### Phase 2: Provider layer on pi-ai

- `agent/pi/models.ts`: one `Models` with a `colony:<id>` provider per provider row (Anthropic → `anthropicMessagesApi`, OpenAI-compatible → `openAICompletionsApi` plus compat flags). It is kept in sync when providers are added, edited, removed or handed over, and keys are read on each request.
- `usageEntry` accepts pi-ai `Usage` as well as AI SDK usage.
- `desktopCheck` runs through pi-ai when `COLONY_RUNTIME=pi`.
- Bump `engines` and `install.ps1` to Node 22.19.

Exit check: new tests for provider sync, key isolation (person A's Bot never sends person B's key), and the usage mapping (cache reads and writes priced as today). Existing tests pass.

### Phase 3: Pi runtime core, behind the switch

- `agent/runtime/pi.ts`:
  - harness on `data/agent.db`, one conversation per run, seeded history;
  - `toPiTools` for the core, doc, computer, browser, mail and vault tools;
  - the event bridge (deltas, steps, presence);
  - stop and timeout, step cap, steering, Colony's queue;
  - usage rows and the monthly-limit check;
  - `consult` as a nested run.
- `run.test.ts` is parameterized over both runtimes: the AI SDK mock as now, and the fake pi-ai provider for pi.

Exit check:
- `run.test.ts` passes on both runtimes.
- On the sandbox with `COLONY_RUNTIME=pi`: a chat with tool steps streams, steer mid-run changes course, a queued message runs after, Stop stops it, and a shared-key Bot over the limit is stopped before the model call.

### Phase 4: Durability and approvals on pi

- `tool_effects` ledger and gated-tool wrapper (section 3.4).
- `resumeAll` → `harness.resume()` plus the restart notes.
- Durable consult (section 3.2).
- The legacy `runs` → pi converter (section 4.1).

Exit check: the `pip-parity.md` phase 2 check, repeated on pi. Kill the sandbox server:
- during a read: it re-runs;
- during a write: the model is told to check;
- while waiting on an approval: the same card is still answerable, and approving runs the action once;
- during a `message_bot` consult: the answer still arrives.

Also, a fixture AI SDK checkpoint converts and continues. Automated equivalents go in `run.test.ts`.

### Phase 5: Desktop, computer and PC tools

- The `desktop_*` tools for all models, with image tool results.
- `prepareDesktopMessages` as a `beforeRequest` hook.
- PC tools from `nodes.ts` through `toPiTools`.
- `anthropicCompat.ts` is no longer used by the pi runtime.

Exit check:
- `desktop.test.ts` and `nodes.test.ts` pass on both runtimes.
- `desktopCheck` passes for Claude and one OpenAI-compatible vision model.
- On the sandbox, a Bot on its sandbox computer completes the click-through task we used for 0.2.0, and a dev desktop app (`COLONY_DESKTOP_DATA`) lends the PC: browser, screenshot and shell, with each approval going to the PC's owner.
- Claude's success on the desktop task is recorded against the AI SDK runtime. If it's clearly worse, stop and decide before Phase 6.

### Phase 6: Everything else end to end; pi becomes the default

- Voice call with barge-in, `call_user`, a routine (scheduled and mail-triggered), hand-over (accept with a pending approval: it expires), and family approval routing (mail → account owner, PC → PC owner, Bot computer → Bot owner), all on the sandbox with two logins.
- The default switches to `COLONY_RUNTIME=pi`. The AI SDK runtime stays in the build as the fallback for one release.

Exit check: the whole `family.md` section 11 list passes on pi, plus a release candidate installed into a sandbox `COLONY_HOME` and updated from 0.2.0 while a run is in flight.

### Phase 7: Remove the AI SDK (a later release, after a clean week on pi)

- Delete `runtime/aiSdk.ts`, `anthropicCompat.ts`, `ai`, `@ai-sdk/*` and the `runs` table (a migration drops it after the converter has run).
- Port the tests that used `MockLanguageModelV4` to the fake pi-ai provider, keeping each assertion. The server test count stays at or above 145 plus what earlier phases added.

Exit check: no `ai`/`@ai-sdk` imports remain, and all tests pass.

### Later (not in this plan)

- Conversation per chat with compaction, instead of a fixed `historyMessages` window.
- "Branch from here" for topics using forks.
- Deferred (batch) responses for non-urgent routines.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Upstream breaks the API again (4 of 8 recent releases did) | High | Exact pins, upgrades on purpose only, and the Phase 0 spike tests kept as a contract suite run on each upgrade. All pi calls stay in `agent/pi/` and `runtime/pi.ts`. |
| Wrong key used for a person (billing someone else) | Low, high impact | One provider per key row; isolation test in Phase 2; concurrency test in Phase 0. |
| Approvals duplicate or vanish across restarts | Medium | Effect ledger (3.4); Phase 0 go/no-go; Phase 4 kill tests. |
| Claude computer use gets worse without the native toolset | Medium | Measured in Phase 5 before the default flips. |
| `watchEvents` (experimental) changes or lags | Medium | The event bridge is one file. The `Models`-wrapper tap is the fallback. |
| Two stores disagree (`messages` vs `agent.db`) | Medium | `messages` is the only source of truth for what people see. `agent.db` holds only in-flight runs and is disposable. |
| Two processes open `agent.db` during an update | Low | Close-before-open order in the launcher, with a test. |
| `agent.db` grows | Low | Delete finished conversations after 24 h, with rotation as the fallback. |
| Node version | Low | Engines and installer raised to 22.19. This PC has 22.23.2. |

## 7. Rollback

- **Phases 1–6:** set `COLONY_RUNTIME=ai-sdk` and restart. `colony.db` only gained additive tables, and the AI SDK runtime ignores `agent.db`. Runs in flight on pi at that moment are marked stopped with the restart text, and their approvals expire (fail-closed).
- **After Phase 7:** install the previous version from `%LOCALAPPDATA%\Colony\versions` (versions sit side by side). `colony.db` still opens because the changes are additive, apart from the dropped `runs` table, which the old version recreates empty. `agent.db` is ignored and can be deleted. If needed, restore the updater's pre-update backup.
- **Before any phase ships:** the branch can be abandoned with nothing merged. `main` stays on the AI SDK.

## Open questions

1. Is a ~100 ms delta cadence acceptable for chat and voice, or should Phase 3 tap the raw stream from the start?
2. If Claude is measurably worse on the Bot computer without the native toolset (Phase 5), do we stop, or accept it for the durability gains?
3. Is "conversation per run" fine for v1, with compaction and forks left for later?
