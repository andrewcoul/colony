import { createAnthropic } from "@ai-sdk/anthropic";
import { restoreToolsetNames } from "./anthropicCompat.js";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import fs from "node:fs";
import { APICallError, stepCountIs, streamText, type ImagePart, type LanguageModel, type ModelMessage } from "ai";
import { chatFilePath, isImage } from "../chatFiles.js";
import { config } from "../config.js";
import type { DesktopService, DesktopShot } from "../computer/desktop.js";
import { canDriveDesktop, resolveModel, type ModelTarget } from "../settings.js";
import { claudeComputer, genericDesktopTools, prepareDesktopMessages, type DesktopMode } from "./desktopTools.js";
import type { EventLog } from "../events.js";
import type { RunCheckpoint, Store } from "../store.js";
import type { Card, Message, Step } from "../shared/types.js";
import type { ApprovalGate } from "./approvals.js";
import { authorOf, isHuman, isShared, peopleIn } from "../people.js";
import { historyFor, peopleNote, steerNote, stripNotes, systemPrompt } from "./prompt.js";
import { Scrubber } from "./scrub.js";
import type { Integrations } from "../integrations/index.js";
import { coreTools, toToolSet, type ToolContext, type ToolRegistry } from "./tools.js";

/** `sessionId` groups one chat's requests; some providers (OpenCode Go) require it. */
export type ModelFactory = (target: ModelTarget, sessionId: string) => LanguageModel;

export const defaultModelFactory: ModelFactory = ({ provider, model }, sessionId) => {
  const headers = {
    "User-Agent": "colony/0.2",
    ...(new URL(provider.baseURL).hostname.endsWith("opencode.ai") ? { "x-opencode-session": sessionId } : {}),
  };
  // Claude speaks Anthropic's Messages API; everything else here is OpenAI-compatible.
  if (provider.protocol === "anthropic") {
    // restoreToolsetNames: some gateways drop the field that routes computer actions to the computer tool.
    return createAnthropic({ baseURL: provider.baseURL, apiKey: provider.apiKey, headers, fetch: restoreToolsetNames }).languageModel(model);
  }
  return createOpenAICompatible({
    name: provider.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider",
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    headers,
  }).chatModel(model);
};

type StartOptions = {
  /** Extra user-turn text that is sent to the model but not shown in the chat. */
  hiddenPrompt?: string;
  /** Cards the reply starts with, e.g. the routine that triggered it. */
  cards?: Card[];
  /** How many Bots deep this turn is (another Bot asking = 1). */
  depth?: number;
  /** Called with the finished reply (used by groups and routines). */
  onFinish?: (message: Message) => void;
  /** Pick the turn back up from this checkpoint (after a restart) instead of starting fresh. */
  resume?: RunCheckpoint;
};

/** Tools that only read: if a restart cuts one off, running it again is harmless. */
const SAFE_TO_REPEAT = new Set([
  "web_search", "web_read", "skill_read", "read_file", "list_files", "browser_read",
  "mail_search", "mail_read", "calendar_list", "vault_list", "desktop_screenshot",
]);

/** What a checkpoint holds: the conversation for the next model step, and the reply as it stood then. */
type Snapshot = { conversation: ModelMessage[]; text: string; reasoning: string; steps: number };

/** Checkpoints leave out screenshots and files: they're big, and stale by the time a run resumes. */
const BINARY = new Set(["image", "file", "media", "image-data", "file-data", "image-url", "file-url"]);
const snapshotJSON = (snapshot: Snapshot) => JSON.stringify(snapshot, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value) && BINARY.has(value.type) ? { type: "text", text: "[screenshot omitted]" } : value);

/** Connected accounts, when Colony has them: what each Bot can use, for its prompt and tools. */
export type RunnerExtras = { integrations?: Integrations; guidance?: (botId: string) => string };

type ActiveRun = {
  /** The turn's first reply message: its checkpoint's id. */
  id: string;
  controller: AbortController;
  botId: string;
  chatId: string;
  messageId: string;
  /** User messages to steer into this turn at its next step. */
  inbox: string[];
  /** User messages waiting for this turn to finish (Alt+Enter). */
  queued: string[];
  /** Message ids the model has already seen, so nothing is added twice. */
  seen: Set<string>;
};

/** Runs Bot turns: streams the model, records steps, and drives presence. */
export class AgentRunner {
  private active = new Map<string, ActiveRun>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private store: Store,
    private events: EventLog,
    private gate: ApprovalGate,
    private tools: (botId: string) => ToolRegistry = () => coreTools,
    private modelFactory: ModelFactory = defaultModelFactory,
    private desktop?: DesktopService,
    private extras: RunnerExtras = {},
  ) {}

  /** How this Bot drives its desktop on this model, or null when it doesn't. */
  private desktopMode(bot: { desktop: boolean; computer: boolean }, target: ModelTarget | null): DesktopMode | null {
    if (!this.desktop || !bot.computer || !bot.desktop || !target || !canDriveDesktop(target)) return null;
    return target.provider.protocol === "anthropic" && /claude/i.test(target.model) ? "claude" : "generic";
  }

  isRunning(chatId: string, botId?: string) {
    return [...this.active.values()].some((run) => run.chatId === chatId && (!botId || run.botId === botId));
  }

  stop(chatId: string) {
    for (const run of this.active.values()) if (run.chatId === chatId) run.controller.abort("stopped");
  }

  /**
   * Hands a user message to a Bot that's already working in this chat.
   * "steer" reaches the running turn before its next step; "queue" waits until the turn ends.
   * Returns false when the Bot isn't working, so the caller should start a turn instead.
   */
  deliver(chatId: string, botId: string, messageId: string, mode: "steer" | "queue") {
    const run = this.active.get(`${chatId}:${botId}`);
    if (!run || run.controller.signal.aborted) return false;
    if (mode === "queue") {
      run.queued.push(messageId);
      this.store.updateMessage(messageId, { delivery: "queued" });
    } else {
      run.inbox.push(messageId);
      this.store.updateMessage(messageId, { delivery: "steer" });
      this.store.setPresence(botId, "thinking", "Reading your message");
    }
    return true;
  }

  /** "Steer now" on a queued message: give it to the running turn instead of waiting. */
  steerNow(messageId: string) {
    for (const run of this.active.values()) {
      const index = run.queued.indexOf(messageId);
      if (index < 0) continue;
      run.queued.splice(index, 1);
      run.inbox.push(messageId);
      this.store.updateMessage(messageId, { delivery: "steer" });
      return true;
    }
    return false;
  }

  /** Takes a queued message back before the Bot sees it. */
  unqueue(messageId: string) {
    for (const run of this.active.values()) {
      const index = run.queued.indexOf(messageId);
      if (index >= 0) { run.queued.splice(index, 1); return true; }
    }
    return false;
  }

  /** Whether the Bot is working on a reply in any chat. */
  isBotRunning(botId: string) {
    return [...this.active.values()].some((run) => run.botId === botId);
  }

  stopBot(botId: string) {
    for (const run of this.active.values()) if (run.botId === botId) run.controller.abort("stopped");
  }

  /**
   * One Bot messages another in their private thread and waits for the reply.
   * Stopping the asker stops the answer too.
   */
  async consult(fromId: string, toId: string, text: string, signal: AbortSignal, depth: number) {
    const from = this.store.getBot(fromId);
    const to = this.store.getBot(toId);
    if (!from || !to) throw new Error("That Bot no longer exists.");
    const thread = this.store.findThread(fromId, toId)
      ?? this.store.createChat({ kind: "thread", title: `${from.name} & ${to.name}`, memberIds: [fromId, toId], coordinatorId: null, ownerId: from.ownerId });
    if (this.isRunning(thread.id, toId)) throw new Error(`${to.name} is still answering an earlier message.`);
    this.store.createMessage({ chatId: thread.id, author: fromId, text });
    const reply = await new Promise<Message>((resolve, reject) => {
      const key = `${thread.id}:${toId}`;
      try {
        this.start(thread.id, toId, { depth: depth + 1, onFinish: resolve });
      } catch (error) { reject(error); return; }
      const run = this.active.get(key);
      signal.addEventListener("abort", () => { if (run && this.active.get(key) === run) run.controller.abort("stopped"); }, { once: true });
    });
    return { chatId: thread.id, reply };
  }

  /** Starts a turn for `botId` in `chatId` and returns the reply message id immediately. */
  start(chatId: string, botId: string, options: StartOptions = {}): string {
    const bot = this.store.getBot(botId);
    const chat = this.store.getChat(chatId);
    if (!bot || !chat) throw new Error("Bot or chat not found.");
    const key = `${chatId}:${botId}`;
    if (this.active.has(key)) throw new Error(`${bot.name} is already working in this chat.`);

    const message = this.store.createMessage({ chatId, author: botId, status: "streaming", cards: options.cards });
    const controller = new AbortController();
    const run: ActiveRun = { id: message.id, controller, botId, chatId, messageId: message.id, inbox: [], queued: [], seen: new Set() };
    this.active.set(key, run);
    clearTimeout(this.idleTimers.get(botId));
    const asker = options.depth ? this.store.listBots().find((item) => item.id !== botId && chat.memberIds.includes(item.id)) : undefined;
    this.store.setPresence(botId, "thinking", asker ? `Helping ${asker.name}` : "Thinking");

    void this.execute(message.id, chatId, botId, controller, options, run).finally(() => {
      this.active.delete(key);
      this.followUp(run);
    });
    return message.id;
  }

  /**
   * Picks a turn back up after a restart, from its last checkpoint, in the same reply.
   * Messages sent before the restart that hadn't reached the turn yet go back in its inbox.
   */
  resume(checkpoint: RunCheckpoint) {
    const { chatId, botId } = checkpoint;
    const key = `${chatId}:${botId}`;
    if (this.active.has(key) || !this.store.getBot(botId) || !this.store.getChat(chatId)) return false;
    const controller = new AbortController();
    const run: ActiveRun = { id: checkpoint.id, controller, botId, chatId, messageId: checkpoint.messageId, inbox: [], queued: [], seen: new Set() };
    for (const message of this.store.listMessages(chatId, { limit: 200 })) {
      if (isHuman(message.author) && message.createdAt > checkpoint.startedAt && message.delivery === "queued") run.queued.push(message.id);
      else if (isHuman(message.author) && message.createdAt > checkpoint.startedAt && message.delivery === "steer" && message.steeredAt === null) run.inbox.push(message.id);
      else run.seen.add(message.id);
    }
    this.active.set(key, run);
    this.store.setPresence(botId, "working", "Picking up where it left off");
    const options: StartOptions = { hiddenPrompt: checkpoint.options.hiddenPrompt, depth: checkpoint.options.depth, resume: checkpoint };
    void this.execute(checkpoint.messageId, chatId, botId, controller, options, run).finally(() => {
      this.active.delete(key);
      this.followUp(run);
    });
    return true;
  }

  /** Resumes turns after a restart, one at a time, so a restart doesn't hit every provider at once. */
  resumeAll(checkpoints: RunCheckpoint[], gapMs = 2000) {
    checkpoints.forEach((checkpoint, index) => {
      const timer = setTimeout(() => this.resume(checkpoint), index * gapMs);
      timer.unref?.();
    });
  }

  /**
   * After a turn: messages that arrived too late to steer (during the final model call), and
   * queued ones, get a turn of their own. Stop means stop, so a stopped turn starts nothing.
   */
  private followUp(run: ActiveRun) {
    const waiting = [...run.inbox, ...run.queued].filter((id) => !run.seen.has(id));
    if (!waiting.length) return;
    for (const id of waiting) this.store.updateMessage(id, { delivery: null, steeredAt: null });
    if (run.controller.signal.reason === "stopped") return;
    try { this.start(run.chatId, run.botId); } catch { /* the Bot was deleted, or a new turn already began */ }
  }

  private async execute(firstMessageId: string, chatId: string, botId: string, controller: AbortController, options: StartOptions, run: ActiveRun) {
    const bot = this.store.getBot(botId)!;
    const chat = this.store.getChat(chatId)!;
    const timeout = setTimeout(() => controller.abort("timeout"), config.limits.turnTimeoutMs);

    // A steered turn continues in a new reply below your message, so these move with it.
    let messageId = firstMessageId;
    let text = "";
    let reasoning = "";
    let steps: Step[] = [];
    let stepsBefore = 0;
    let error: string | null = null;
    let lastSave = 0;
    let afterTool = false;

    const save = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSave < 750) return;
      lastSave = now;
      // Persist quietly; streamed text reaches clients through ephemeral deltas.
      this.store.updateMessage(messageId, { text, reasoning, steps }, { emit: false });
    };
    const emitSteps = () => this.store.updateMessage(messageId, { text, reasoning, steps });

    // Durable runs: before every model step the conversation is checkpointed, so a restart can
    // carry on from there (see resume). The checkpoint goes when the turn ends, however it ends.
    const startedAt = options.resume?.startedAt ?? Date.now();
    const messageIds = [firstMessageId];
    const checkpoint = (conversation: ModelMessage[]) => this.store.saveRun({
      id: run.id, chatId, botId, messageId, stepsBefore, startedAt, updatedAt: Date.now(),
      messages: snapshotJSON({ conversation, text, reasoning, steps: steps.length }),
      options: { hiddenPrompt: options.hiddenPrompt, depth: options.depth },
    });

    // Shared models or the owner's own key; never someone else's.
    const target = resolveModel(bot.model, { ownerId: bot.ownerId });
    try {
      if (!target) throw new Error("No model is configured yet. Open Settings (the gear on the Bots screen) and add your API key.");
      const bots = this.store.listBots();
      const names = new Map(bots.map((item) => [item.id, item.name]));
      // In a topic shared with people, each person's messages carry their name.
      const people = isShared(chat) ? peopleIn(this.store, chat) : [];
      const speakers = people.length ? new Map(people.map((person) => [authorOf(person), person.name])) : undefined;
      const others = bots.filter((item) => chat.memberIds.includes(item.id) && item.id !== botId);
      let history: ModelMessage[];
      if (options.resume) {
        history = this.restore(options.resume, (restored) => { ({ text, reasoning, steps, stepsBefore } = restored); });
        emitSteps();
      } else {
        const recent = this.store.listMessages(chatId, { limit: config.limits.historyMessages });
        for (const item of recent) run.seen.add(item.id);
        // Photos you attached go to models that can see, for your last few messages.
        const seeing = canDriveDesktop(target) || (target.provider.protocol === "anthropic" && /claude/i.test(target.model));
        const recentPhotos = new Set(recent.filter((item) => isHuman(item.author) && item.attachments.length).slice(-4).map((item) => item.id));
        history = historyFor(bot, recent, names, seeing ? (message) => recentPhotos.has(message.id) ? photosOf(message, this.store) : [] : undefined, speakers);
        if (options.hiddenPrompt) history.push({ role: "user", content: options.hiddenPrompt });
        if (!history.length) throw new Error("Nothing to reply to.");
      }
      checkpoint(history);

      // A Bot answering another Bot can't pass the work on again.
      const { message_bot: _, ...withoutMessaging } = this.tools(botId);
      const registry = options.depth ? withoutMessaging : this.tools(botId);
      const depth = options.depth ?? 0;
      let latestShot: DesktopShot | null = null;
      const ctx: ToolContext = {
        botId, botName: bot.name, chatId, messageId, signal: controller.signal, gate: this.gate, store: this.store, depth,
        consult: (toId, message) => this.consult(botId, toId, message, controller.signal, depth),
        attachScreenshot: (shot) => { latestShot = shot; },
        secrets: new Scrubber(),
        integrations: this.extras.integrations,
      };
      // Steering: user messages that arrived since the last step join the conversation here.
      const pickUp = (): ModelMessage[] => {
        const added: ModelMessage[] = [];
        for (const id of run.inbox.splice(0)) {
          if (run.seen.has(id)) continue;
          run.seen.add(id);
          const steered = this.store.updateMessage(id, { delivery: "steer", steeredAt: stepsBefore + steps.length });
          if (steered?.text.trim()) added.push({ role: "user", content: steerNote(steered.text) });
        }
        if (!added.length) return added;
        this.store.setPresence(botId, "thinking", "Changing course");
        // Close the reply where you cut in; the rest of the turn continues in a new reply below your message.
        if (text.trim() || steps.length) {
          this.store.updateMessage(messageId, { text: stripNotes(text), reasoning, steps, status: "done" });
          stepsBefore += steps.length;
          const next = this.store.createMessage({ chatId, author: botId, status: "streaming" });
          messageId = next.id;
          messageIds.push(next.id);
          ctx.messageId = next.id;
          run.messageId = next.id;
          text = ""; reasoning = ""; steps = []; afterTool = false;
        }
        return added;
      };
      // Tool call ids can repeat (a resumed turn may reuse one), so results go to the latest running step with that id.
      const stepFor = (id: string) => steps.findLast((item) => item.id === id && item.status === "running") ?? steps.findLast((item) => item.id === id);
      const desktopMode = this.desktopMode(bot, target);
      if (desktopMode === "claude") registry.computer = claudeComputer(this.desktop!, ctx);
      if (desktopMode === "generic") Object.assign(registry, genericDesktopTools(this.desktop!, ctx));
      const result = streamText({
        model: this.modelFactory(target, `${chatId}:${botId}`),
        system: systemPrompt(bot, chat, others, this.store.listRoutines(botId), options.depth ? [] : bots.filter((item) => item.id !== botId && item.ownerId === bot.ownerId), desktopMode, this.extras.guidance?.(botId) ?? "", (id) => this.store.getFolder(id)?.title, peopleNote(this.store, chat)),
        messages: history,
        tools: toToolSet(registry, ctx),
        // Before each step: add any steering messages (the override carries into later steps), and
        // on the desktop prune old screenshots so the many small steps stay affordable.
        prepareStep: ({ messages }: { messages: ModelMessage[] }) => {
          const added = pickUp();
          let next = added.length ? [...messages, ...added] : messages;
          if (desktopMode) next = prepareDesktopMessages(next, latestShot);
          checkpoint(next);
          return next !== messages ? { messages: next } : {};
        },
        stopWhen: stepCountIs(desktopMode ? config.limits.maxDesktopSteps : config.limits.maxSteps),
        maxOutputTokens: config.limits.maxOutputTokens,
        // Gateways can route steps of one run to different upstream accounts, which invalidates
        // Claude's signed thinking blocks; drop a mismatched block instead of failing the reply.
        ...(target?.provider.protocol === "anthropic"
          ? { providerOptions: { anthropic: { thinking: { type: "adaptive", blockBinding: { prefixMismatchBehavior: "drop_block" } } } } }
          : {}),
        maxRetries: 2,
        abortSignal: controller.signal,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta": {
            // Text written after a tool call starts a new paragraph, not the same sentence.
            const delta = afterTool && text && !text.endsWith("\n") && part.text.trim() ? `\n\n${part.text.trimStart()}` : part.text;
            if (part.text.trim()) afterTool = false;
            text += delta;
            this.store.setPresence(botId, "working", "Writing a reply");
            this.events.broadcast({ type: "message.delta", messageId, chatId, text: delta });
            save();
            break;
          }
          case "reasoning-delta":
            reasoning += part.text;
            this.events.broadcast({ type: "message.delta", messageId, chatId, text: "", reasoning: part.text });
            save();
            break;
          case "tool-call": {
            afterTool = true;
            const spec = registry[part.toolName];
            const title = spec ? safe(() => spec.describe(part.input), part.toolName) : part.toolName;
            steps.push({ id: part.toolCallId, tool: part.toolName, title, status: "running", startedAt: Date.now() });
            this.store.setPresence(botId, "working", title);
            emitSteps();
            break;
          }
          case "tool-result": {
            const step = stepFor(part.toolCallId);
            if (step) {
              const spec = registry[part.toolName];
              step.status = "done";
              step.endedAt = Date.now();
              step.detail = spec?.summarize ? safe(() => spec.summarize!(part.output), undefined) : undefined;
              emitSteps();
            }
            this.store.setPresence(botId, "thinking", "Thinking");
            break;
          }
          case "tool-error": {
            const step = stepFor(part.toolCallId);
            if (step) {
              const message = part.error instanceof Error ? part.error.message : String(part.error);
              step.status = /denied/i.test(message) ? "denied" : "error";
              step.endedAt = Date.now();
              step.detail = message.slice(0, 160);
              emitSteps();
            }
            break;
          }
          case "error":
            throw part.error;
        }
      }
      if (!text.trim() && !steps.length) error = "The model returned an empty reply.";
    } catch (failure) {
      if (controller.signal.aborted) {
        error = controller.signal.reason === "timeout" ? "This turn ran too long and was stopped." : null;
      } else {
        // Provider errors can echo request details; log only the shape.
        console.warn(`[colony] ${bot.name} run failed:`, failure instanceof Error ? `${failure.name}: ${failure.message.slice(0, 300)}` : "unknown error");
        // Say what the provider said (e.g. a model that needs another protocol), without request details.
        const said = APICallError.isInstance(failure) ? failure.message.replace(/\s+/g, " ").trim().slice(0, 160) : "";
        error = failure instanceof Error && /configured|Nothing to reply/.test(failure.message)
          ? failure.message
          : `The model couldn't finish this reply${said && target ? ` (${target.provider.name} said: “${said}”)` : ""}. Check this Bot's model in its profile or in Settings.`;
      }
    } finally {
      clearTimeout(timeout);
      this.store.deleteRun(run.id);
      // An approval left waiting from before a restart that this turn never asked for again.
      this.gate.expireUnclaimed(messageIds);
    }

    for (const step of steps) if (step.status === "running" || step.status === "waiting") { step.status = "error"; step.endedAt = Date.now(); }
    const stopped = controller.signal.aborted && controller.signal.reason !== "timeout";
    text = stripNotes(text);
    const final = this.store.updateMessage(messageId, {
      text, reasoning, steps,
      status: stopped ? "stopped" : error ? "failed" : "done",
      error,
    });

    if (error && !stopped) this.store.setPresence(botId, "blocked", error);
    else {
      this.store.setPresence(botId, "done", null);
      this.idleTimers.set(botId, setTimeout(() => {
        if (![...this.active.values()].some((run) => run.botId === botId)) this.store.setPresence(botId, "idle", null);
      }, 4000));
    }
    if (final) options.onFinish?.(final);
  }

  /**
   * Rebuilds a turn from its checkpoint. The reply goes back to how it stood at the checkpoint;
   * anything after that the model never saw, so each later step is marked and explained to it:
   * read-only steps can simply run again, but a step that changes things may already have
   * happened and must not be repeated blindly.
   */
  private restore(checkpoint: RunCheckpoint, apply: (state: { text: string; reasoning: string; steps: Step[]; stepsBefore: number }) => void) {
    const snapshot = JSON.parse(checkpoint.messages) as Snapshot;
    const reply = this.store.getMessage(checkpoint.messageId);
    const steps = (reply?.steps ?? []).map((step) => ({ ...step }));
    const notes: string[] = [];
    // A step held at an approval shows as running; the approval still waiting says which it was.
    const askedFor = new Set(this.store.listApprovals("pending").filter((approval) => approval.messageId === checkpoint.messageId).map((approval) => approval.tool));
    for (const step of steps.slice(snapshot.steps)) {
      const wasDone = step.status === "done";
      const asked = step.status === "waiting" || (step.status === "running" && askedFor.has(step.tool));
      step.endedAt ??= Date.now();
      if (asked) {
        step.status = "interrupted";
        step.detail = "Asking again";
        notes.push(`"${step.title}" was waiting for the user's approval and did not run. If it's still needed, call the tool again; the user will be asked again.`);
      } else if (SAFE_TO_REPEAT.has(step.tool)) {
        if (!wasDone) { step.status = "interrupted"; step.detail = "Running again"; }
        notes.push(`"${step.title}" only reads; you never saw its result, so run it again if you still need it.`);
      } else if (wasDone) {
        notes.push(`"${step.title}" finished just before the restart${step.detail ? ` (${step.detail})` : ""}, but you never saw its result. It happened: don't do it again.`);
      } else if (step.status === "running") {
        step.status = "interrupted";
        step.detail = "May not have finished";
        notes.push(`"${step.title}" was cut off and may or may not have happened. Check before trying it again.`);
      }
    }
    const pickedUp = checkpoint.stepsBefore + snapshot.steps;
    const now = Date.now();
    steps.push({ id: `restart-${now}`, tool: "colony.restart", title: `Colony restarted · picked up ${pickedUp ? `after step ${pickedUp}` : "from the start"}`, status: "done", startedAt: now, endedAt: now });
    apply({ text: snapshot.text, reasoning: snapshot.reasoning, steps, stepsBefore: checkpoint.stepsBefore });
    const note = `[System note: Colony restarted while you were working on this, and you're picking up where you left off.${notes.length ? ` ${notes.join(" ")}` : ""} Carry on with the task.]`;
    return [...snapshot.conversation, { role: "user", content: note } as ModelMessage];
  }
}

/** A message's attached photos as image parts (skipping any that are gone or huge). */
function photosOf(message: Message, store: Store): ImagePart[] {
  return message.attachments.flatMap((attachment) => {
    const file = store.getFile(attachment.id);
    if (!file || !isImage(file) || file.size > 8 * 1024 * 1024) return [];
    try { return [{ type: "image" as const, image: fs.readFileSync(chatFilePath(file)), mediaType: file.mime }]; } catch { return []; }
  });
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

