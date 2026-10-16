import fs from "node:fs";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Type, type Api, type AssistantMessage, type ImageContent, type Message as PiMessage, type TextContent, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry, createRegistry, defineExtension, GenerationTask, Harness, hook, UserEntry, watchEvents,
  type AgentEvent, type AgentEventStream, type Conversation, type ConversationId, type Registry, type Storage, type Submission, type SubmissionId,
  type ModelRef, type ToolExecutionApi, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { z } from "zod";
import { chatFilePath, isImage } from "../../chatFiles.js";
import { config } from "../../config.js";
import type { DesktopService, DesktopShot } from "../../computer/desktop.js";
import type { EventLog } from "../../events.js";
import type { Integrations } from "../../integrations/index.js";
import { isHuman } from "../../people.js";
import { canDriveDesktop, priceOf, resolveModel, type ModelTarget } from "../../settings.js";
import type { Message, Step } from "../../shared/types.js";
import { usageEntry } from "../../spending.js";
import type { RunCheckpoint, Store } from "../../store.js";
import type { ApprovalGate } from "../approvals.js";
import { genericDesktopTools, type DesktopMode } from "../desktopTools.js";
import { historyFor, steerNote, stripNotes, systemPrompt, type ImagePart, type ModelMessage } from "../prompt.js";
import { replayOf, type Runner, type StartOptions } from "../runner.js";
import { Scrubber } from "../scrub.js";
import { coreTools, type ColonyTool, type ToolContext, type ToolRegistry } from "../tools.js";
import { ColonyModels, tokensOf, type ModelSource } from "./models.js";

/*
 * The pi durable runtime. Each Bot keeps one persistent conversation per chat in data/agent.db.
 * Colony's messages table stays the record of what you see; the conversation is what the model
 * sees. A turn takes in the chat messages the conversation hasn't seen yet, then answers; pi
 * durable commits every step, compacts the conversation when it nears the model's context
 * window, and picks up a turn the process was in the middle of.
 */

const RESTARTED_ACTING = "Colony restarted while this was running. It may or may not have happened; check before trying again.";
/** How many screenshots stay in what the model is sent: the rest become a short note. */
const KEEP_IMAGES = 2;

/** One turn in progress: a Bot answering in a chat, into one reply (a steered turn moves to a new reply). */
type PiRun = {
  /** The turn's first reply message: its id in the runs table. */
  id: string;
  chatId: string;
  botId: string;
  conversationId: ConversationId;
  /** The reply being written now. */
  messageId: string;
  messageIds: string[];
  text: string;
  reasoning: string;
  steps: Step[];
  /** Steps in earlier parts of a steered reply. */
  stepsBefore: number;
  afterTool: boolean;
  startedAt: number;
  controller: AbortController;
  options: StartOptions;
  target: ModelTarget;
  /** The Colony tools this turn offers, by name, bound to this turn. */
  registry: ToolRegistry;
  ctx: ToolContext;
  /** User messages waiting for this turn to finish (Alt+Enter). */
  queued: string[];
  /** Steer submissions placed, or waiting to be, and the chat message each carries. */
  steers: Map<SubmissionId, string>;
  /** Raw tool results by call id, for the step's summary line. */
  outputs: Map<string, unknown>;
  /** Text and thinking of the response being written, by kind and content block, as shown so far. */
  shown: Map<string, string>;
  submission?: Submission;
  stream?: AgentEventStream;
  /** Settles when the turn's run ends (or fails to start). */
  done: Promise<void>;
  finish: () => void;
  lastSave: number;
};

export type PiRunnerOptions = {
  /** data/agent.db, or a storage to use instead (tests). */
  storage: string | Storage;
  /** Colony's providers (default), or a scripted provider in tests. */
  models?: ModelSource;
  desktop?: DesktopService;
  integrations?: Integrations;
  guidance?: (botId: string) => string;
  /** Overrides pi durable's settings (tests make compaction kick in early). */
  settings?: Parameters<typeof Harness.open>[1]["settings"];
};

export class PiRunner implements Runner {
  private active = new Map<string, PiRun>();
  private byConversation = new Map<ConversationId, PiRun>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private registrations = new Map<string, { registration: ToolRegistration; signature: string }>();
  /** Runs the restart is still rebuilding; tool calls for them wait for this. */
  private resumed: Promise<void> = Promise.resolve();
  private readonly context: Context = BACKGROUND_CONTEXT;

  private constructor(
    private store: Store,
    private events: EventLog,
    private gate: ApprovalGate,
    private tools: (botId: string) => ToolRegistry,
    private harness: Harness,
    private registry: Registry,
    private models: ModelSource,
    private options: PiRunnerOptions,
  ) {}

  static async open(store: Store, events: EventLog, gate: ApprovalGate, tools: (botId: string) => ToolRegistry = () => coreTools, options: PiRunnerOptions) {
    const storage = typeof options.storage === "string" ? await openNodeSqliteStorage(options.storage) : options.storage;
    const models = options.models ?? new ColonyModels();
    const registry = createRegistry();
    let runner: PiRunner | undefined;
    const harness = await Harness.open(storage, {
      models: models.models,
      registry,
      settings: options.settings,
      onReport: (error) => console.warn("[colony] agent:", error instanceof Error ? error.message : error),
    }, BACKGROUND_CONTEXT);
    runner = new PiRunner(store, events, gate, tools, harness, registry, models, options);
    runner.install();
    return runner;
  }

  async close() {
    for (const run of this.active.values()) run.controller.abort("closing");
    await this.harness.close(this.context);
  }

  // ---------- Tools ----------

  /** Installs (or reinstalls, when a tool's description or schema changed) the extension every conversation selects. */
  private install() {
    this.registry.install(defineExtension({
      name: "colony",
      tools: [...this.registrations.values()].map((item) => item.registration),
      // On the desktop, only the newest screenshots stay in what the model is sent.
      hooks: [hook(GenerationTask, { beforeRequest: (request) => ({ messages: pruneScreenshots(request.messages) }) })],
    }));
  }

  /** The pi tool for one of a turn's Colony tools. Its execute finds the turn by conversation. */
  private registrationFor(name: string, spec: ColonyTool): ToolRegistration {
    const parameters = z.toJSONSchema(spec.inputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete parameters.$schema;
    const replay = name === "message_bot" ? "safe" : replayOf(name, spec);
    const signature = JSON.stringify([spec.description, parameters, replay]);
    const known = this.registrations.get(name);
    if (known?.signature === signature) return known.registration;
    const registration: ToolRegistration = {
      name,
      description: spec.description,
      parameters: Type.Unsafe(parameters),
      // Read-only tools run again after a restart; ones that ask first run again too, guarded (see gateFor).
      replay: replay === "unsafe" ? "unsafe" : "safe",
      execute: (args, api, context) => this.executeTool(name, args, api, context),
    };
    this.registrations.set(name, { registration, signature });
    this.install();
    return registration;
  }

  private async executeTool(name: string, args: unknown, api: ToolExecutionApi, context: Context) {
    let run = this.byConversation.get(api.conversationId);
    if (!run) { await this.resumed; run = this.byConversation.get(api.conversationId); }
    if (!run) throw new Error("This turn isn't running any more.");
    const spec = run.registry[name];
    if (!spec) throw new Error(`${name} isn't available right now.`);
    const limit = this.desktopMode(run) ? config.limits.maxDesktopSteps : config.limits.maxSteps;
    if (run.stepsBefore + run.steps.filter((step) => !step.tool.startsWith("colony.")).length > limit) {
      throw new Error("You've used all your steps for this turn. Stop here and reply with what you have, saying what's left to do.");
    }
    const signal = AbortSignal.any([context.abortSignal, run.controller.signal].filter((item): item is AbortSignal => Boolean(item)));
    this.shots.delete(run);
    const memo = async <T>(key: string, value?: T) => (value === undefined
      ? await api.memo(`colony.${key}`, context) as T | undefined
      : await api.memo(`colony.${key}`, value as never, context) as T);
    const ctx: ToolContext = {
      ...run.ctx,
      messageId: run.messageId,
      signal,
      gate: replayOf(name, spec) === "gated" ? this.gateFor(memo) : this.gate,
      consult: (toId, text) => this.consult(run!.botId, toId, text, signal, run!.options.depth ?? 0, memo),
      attachScreenshot: (next) => this.attach(run!, next),
    };
    try {
      const input = spec.inputSchema.parse(args);
      const output = run.ctx.secrets.deep(await spec.execute(input, ctx));
      run.outputs.set(api.callId, output);
      const shot = this.shots.get(run) ?? null;
      this.shots.delete(run);
      return { output: contentOf(output, spec, shot) };
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error(`Invalid input: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`);
      throw error instanceof Error ? new Error(run.ctx.secrets.text(error.message)) : error;
    }
  }

  /**
   * The gate for a tool that asks before acting. After a restart the call runs again and asks
   * again; but once you approved and it started acting, a rerun says it may already have happened.
   */
  private gateFor(memo: <T>(key: string, value?: T) => Promise<T | undefined>): Pick<ApprovalGate, "request"> {
    return {
      request: async (input, signal) => {
        if (await memo<boolean>("acting")) throw new Error(RESTARTED_ACTING);
        const approved = await this.gate.request(input, signal);
        if (approved) await memo("acting", true);
        return approved;
      },
    };
  }

  // ---------- Running turns ----------

  private desktopMode(run: Pick<PiRun, "botId" | "target">): DesktopMode | null {
    const bot = this.store.getBot(run.botId);
    if (!this.options.desktop || !bot?.computer || !bot.desktop || !canDriveDesktop(run.target)) return null;
    return "generic";
  }

  isRunning(chatId: string, botId?: string) {
    return [...this.active.values()].some((run) => run.chatId === chatId && (!botId || run.botId === botId));
  }

  isBotRunning(botId: string) {
    return [...this.active.values()].some((run) => run.botId === botId);
  }

  stop(chatId: string) {
    for (const run of this.active.values()) if (run.chatId === chatId) this.abort(run, "stopped");
  }

  stopBot(botId: string) {
    for (const run of this.active.values()) if (run.botId === botId) this.abort(run, "stopped");
  }

  private abort(run: PiRun, reason: "stopped" | "timeout") {
    if (run.controller.signal.aborted) return;
    run.controller.abort(reason);
    void this.conversation(run.conversationId).then((conversation) => conversation?.abort(this.context)).catch(() => {});
  }

  deliver(chatId: string, botId: string, messageId: string, mode: "steer" | "queue") {
    const run = this.active.get(`${chatId}:${botId}`);
    if (!run || run.controller.signal.aborted) return false;
    if (mode === "queue") {
      run.queued.push(messageId);
      this.store.updateMessage(messageId, { delivery: "queued" });
    } else {
      this.steer(run, messageId);
    }
    return true;
  }

  steerNow(messageId: string) {
    for (const run of this.active.values()) {
      const index = run.queued.indexOf(messageId);
      if (index < 0) continue;
      run.queued.splice(index, 1);
      this.steer(run, messageId);
      return true;
    }
    return false;
  }

  unqueue(messageId: string) {
    for (const run of this.active.values()) {
      const index = run.queued.indexOf(messageId);
      if (index >= 0) { run.queued.splice(index, 1); return true; }
    }
    return false;
  }

  /** A message for the running turn: it joins after the current tool round (pi's steer). */
  private steer(run: PiRun, messageId: string) {
    const message = this.store.updateMessage(messageId, { delivery: "steer" });
    this.store.setPresence(run.botId, "thinking", "Reading your message");
    this.store.markSeen(String(run.conversationId), [messageId]);
    if (!message?.text.trim()) return;
    void (async () => {
      const conversation = await this.conversation(run.conversationId);
      const submission = await conversation!.submit({ type: "input", content: steerNote(message.text), whenBusy: "steer", requestId: messageId }, this.context);
      run.steers.set(submission.id, messageId);
    })().catch((error) => console.warn("[colony] couldn't steer:", error instanceof Error ? error.message : error));
  }

  private conversation(id: ConversationId) {
    return this.harness.conversation(id, this.context);
  }

  start(chatId: string, botId: string, options: StartOptions = {}): string {
    const bot = this.store.getBot(botId);
    const chat = this.store.getChat(chatId);
    if (!bot || !chat) throw new Error("Bot or chat not found.");
    const key = `${chatId}:${botId}`;
    if (this.active.has(key)) throw new Error(`${bot.name} is already working in this chat.`);
    const message = this.store.createMessage({ chatId, author: botId, status: "streaming", cards: options.cards });
    const run = this.newRun({ id: message.id, chatId, botId, messageId: message.id, options, startedAt: Date.now() });
    const asker = options.depth ? this.store.listBots().find((item) => item.id !== botId && chat.memberIds.includes(item.id)) : undefined;
    this.store.setPresence(botId, "thinking", asker ? `Helping ${asker.name}` : "Thinking");
    void this.execute(run, false).finally(() => this.finished(run));
    return message.id;
  }

  private newRun(input: { id: string; chatId: string; botId: string; messageId: string; options: StartOptions; startedAt: number; text?: string; reasoning?: string; steps?: Step[]; stepsBefore?: number }): PiRun {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const run: PiRun = {
      id: input.id, chatId: input.chatId, botId: input.botId, conversationId: 0 as ConversationId, messageId: input.messageId, messageIds: [input.messageId],
      text: input.text ?? "", reasoning: input.reasoning ?? "", steps: input.steps ?? [], stepsBefore: input.stepsBefore ?? 0, afterTool: false,
      startedAt: input.startedAt, controller: new AbortController(), options: input.options, target: null as never, registry: {}, ctx: null as never,
      queued: [], steers: new Map(), outputs: new Map(), shown: new Map(), done, finish, lastSave: 0,
    };
    this.active.set(`${run.chatId}:${run.botId}`, run);
    clearTimeout(this.idleTimers.get(run.botId));
    return run;
  }

  /** Where a turn ends, however it ends: queued messages get a turn of their own (unless you pressed Stop). */
  private finished(run: PiRun) {
    this.active.delete(`${run.chatId}:${run.botId}`);
    if (this.byConversation.get(run.conversationId) === run) this.byConversation.delete(run.conversationId);
    void run.stream?.stop().catch(() => {});
    const waiting = run.queued;
    if (!waiting.length) return;
    for (const id of waiting) this.store.updateMessage(id, { delivery: null, steeredAt: null });
    if (run.controller.signal.reason === "stopped") return;
    try { this.start(run.chatId, run.botId); } catch { /* the Bot was deleted, or a new turn already began */ }
  }

  /** The Bot's conversation in this chat, made (and started from the chat's recent history) on first use. */
  private async conversationFor(chatId: string, botId: string) {
    const linked = this.store.conversationOf(chatId, botId);
    const existing = linked ? await this.conversation(Number(linked.conversationId) as ConversationId) : undefined;
    if (existing && linked) return { conversation: existing, createdAt: linked.createdAt, fresh: false };
    const conversation = await this.harness.createConversation({ ownership: { kind: "ownerless" } }, this.context);
    // Messages from before it count as history; it takes in the newest of them on its first turn.
    const createdAt = Date.now();
    this.store.linkConversation(chatId, botId, String(conversation.id), createdAt);
    return { conversation, createdAt, fresh: true };
  }

  /**
   * The chat messages this conversation hasn't taken in yet, as model messages: your messages,
   * and what other Bots said here ("[Name]: …"). A new conversation starts from the chat's recent
   * history, its own earlier replies included.
   */
  private unseen(run: PiRun, conversationId: ConversationId, fresh: boolean, createdAt: number) {
    const bot = this.store.getBot(run.botId)!;
    const recent = this.store.listMessages(run.chatId, { limit: fresh ? config.limits.historyMessages : 200 })
      .filter((message) => message.id !== run.messageId && message.status !== "streaming" && !run.queued.includes(message.id))
      .filter((message) => fresh || (message.createdAt >= createdAt && message.author !== bot.id));
    const seen = this.store.seenBy(String(conversationId), recent.map((message) => message.id));
    const pending = recent.filter((message) => !seen.has(message.id));
    const names = new Map(this.store.listBots().map((item) => [item.id, item.name]));
    const sees = this.models.models.getModel(this.models.ref(run.target).provider, run.target.model)?.input.includes("image") ?? false;
    const photos = new Set(pending.filter((item) => isHuman(item.author) && item.attachments.length).slice(-4).map((item) => item.id));
    const history = historyFor(bot, pending, names, sees ? (message) => (photos.has(message.id) ? photosOf(message, this.store) : []) : undefined);
    const ref = this.models.ref(run.target);
    const api = this.models.models.getModel(ref.provider, ref.modelId)?.api ?? "openai-completions";
    return { ids: pending.map((message) => message.id), messages: history.map((message) => piMessage(message, ref, api)) };
  }

  private async execute(run: PiRun, resuming: boolean) {
    const bot = this.store.getBot(run.botId)!;
    const chat = this.store.getChat(run.chatId)!;
    const timeout = setTimeout(() => this.abort(run, "timeout"), Math.max(1000, config.limits.turnTimeoutMs - (Date.now() - run.startedAt)));
    let error: string | null = null;
    let failure: unknown = null;
    try {
      if (!run.target) this.prepare(run);
      if (resuming) {
        run.conversationId ||= Number(this.store.conversationOf(run.chatId, run.botId)?.conversationId ?? 0) as ConversationId;
        const conversation = run.conversationId ? await this.conversation(run.conversationId) : undefined;
        if (!conversation) throw new Error("This conversation can't be picked up.");
        this.byConversation.set(run.conversationId, run);
        await this.watch(run);
      } else {
        const { conversation, createdAt, fresh } = await this.conversationFor(run.chatId, run.botId);
        run.conversationId = conversation.id;
        this.byConversation.set(conversation.id, run);
        // What it hasn't seen goes in first; the newest message (or a hidden prompt) starts the turn.
        const { ids, messages } = this.unseen(run, conversation.id, fresh, createdAt);
        let input: PiMessage | undefined;
        if (run.options.hiddenPrompt) input = { role: "user", content: run.options.hiddenPrompt, timestamp: Date.now() };
        else if (messages.at(-1)?.role === "user") input = messages.pop();
        if (!input || input.role !== "user") throw new Error("Nothing to reply to.");
        await this.configure(conversation, run, bot, chat);
        if (messages.length) {
          await conversation.commit(async (tx) => {
            for (const message of messages) await tx.appendEntry(message.role === "user" ? UserEntry : AssistantEntry, conversation.id, { model: [message] });
          }, this.context);
        }
        this.store.markSeen(String(conversation.id), ids);
        await this.watch(run);
        run.submission = await conversation.submit({ type: "input", content: input.content, requestId: run.id }, this.context);
        this.checkpoint(run);
      }
      if (resuming && !run.stream!.snapshot.run && (await run.submission!.status(this.context)).status !== "queued") run.finish();
      await Promise.race([run.submission!.wait(this.context), run.done]);
      const record = await run.submission!.status(this.context);
      if (record.status === "unanswered") {
        if (!run.controller.signal.aborted) failure = record;
      } else {
        // Its run may go on after it's answered (a steer that came in at the end joins it).
        await run.done;
      }
      if (!run.text.trim() && !run.steps.length && !failure && !run.controller.signal.aborted) error = "The model returned an empty reply.";
    } catch (caught) {
      failure = caught;
    } finally {
      clearTimeout(timeout);
    }

    const stopped = run.controller.signal.aborted && run.controller.signal.reason !== "timeout";
    if (run.controller.signal.reason === "timeout") error = "This turn ran too long and was stopped.";
    else if (failure && !stopped) error = this.explain(failure, run);
    this.store.deleteRun(run.id);
    // An approval left waiting from before a restart that this turn never asked for again.
    this.gate.expireUnclaimed(run.messageIds);
    for (const step of run.steps) if (step.status === "running" || step.status === "waiting") { step.status = "error"; step.endedAt = Date.now(); }
    const final = this.store.updateMessage(run.messageId, {
      text: stripNotes(run.text), reasoning: run.reasoning, steps: run.steps,
      status: stopped ? "stopped" : error ? "failed" : "done",
      error,
    });
    if (error && !stopped) this.store.setPresence(run.botId, "blocked", error);
    else {
      this.store.setPresence(run.botId, "done", null);
      this.idleTimers.set(run.botId, setTimeout(() => {
        if (!this.isBotRunning(run.botId)) this.store.setPresence(run.botId, "idle", null);
      }, 4000));
    }
    if (final) run.options.onFinish?.(final);
  }

  /** Why a turn failed, in words for the chat (provider errors can echo request details; log only the shape). */
  private explain(failure: unknown, run: PiRun) {
    if (failure instanceof Error) {
      if (/configured|Nothing to reply|picked up/.test(failure.message)) return failure.message;
      console.warn(`[colony] ${run.botId} run failed:`, `${failure.name}: ${failure.message.slice(0, 300)}`);
      return "The model couldn't finish this reply. Check this Bot's model in its profile or in Settings.";
    }
    const settled = failure as { reason?: string; detail?: unknown };
    const said = typeof settled.detail === "string" ? settled.detail : typeof (settled.detail as { message?: unknown })?.message === "string" ? (settled.detail as { message: string }).message : "";
    console.warn(`[colony] ${run.botId} run unanswered:`, settled.reason, said.slice(0, 300));
    const clean = said.replace(/\s+/g, " ").trim().slice(0, 160);
    return `The model couldn't finish this reply${clean && run.target ? ` (${run.target.provider.name} said: “${clean}”)` : ""}. Check this Bot's model in its profile or in Settings.`;
  }

  /** The turn's model, tools, and the context the tools act in. */
  private prepare(run: PiRun) {
    const bot = this.store.getBot(run.botId)!;
    const target = resolveModel(bot.model);
    if (!target) throw new Error("No model yet. Open Settings (the gear on the Bots screen) and sign in to ChatGPT or OpenCode.");
    run.target = target;
    const botName = bot.name;
    const depth = run.options.depth ?? 0;
    run.ctx = {
      botId: run.botId, botName, chatId: run.chatId, messageId: run.messageId, signal: run.controller.signal, gate: this.gate, store: this.store, depth,
      consult: () => Promise.reject(new Error("Not available here.")),
      secrets: new Scrubber(),
      integrations: this.options.integrations,
    };
    // A Bot answering another Bot can't pass the work on again.
    const { message_bot: _, ...withoutMessaging } = this.tools(run.botId);
    run.registry = depth ? withoutMessaging : this.tools(run.botId);
    if (this.desktopMode(run)) Object.assign(run.registry, genericDesktopTools(this.options.desktop!, new Proxy(run.ctx, {
      // Desktop tools hand their screenshot to whichever call is running (see executeTool).
      get: (target, key) => (key === "attachScreenshot" ? (shot: DesktopShot) => this.attach(run, shot) : Reflect.get(target, key)),
    })));
    // pi runs a tool call (a resumed one too) only once its tool is installed.
    for (const [name, spec] of Object.entries(run.registry)) this.registrationFor(name, spec);
  }

  private shots = new Map<PiRun, DesktopShot>();
  private attach(run: PiRun, shot: DesktopShot) { this.shots.set(run, shot); }

  /** The model, tools and system prompt for this turn. */
  private async configure(conversation: Conversation, run: PiRun, bot: NonNullable<ReturnType<Store["getBot"]>>, chat: NonNullable<ReturnType<Store["getChat"]>>) {
    const bots = this.store.listBots();
    const others = bots.filter((item) => chat.memberIds.includes(item.id) && item.id !== bot.id);
    const ref = this.models.ref(run.target);
    const model = this.models.models.getModel(ref.provider, ref.modelId);
    const instructions = systemPrompt(bot, chat, others, this.store.listRoutines(bot.id), run.options.depth ? [] : bots.filter((item) => item.id !== bot.id),
      this.desktopMode(run), this.options.guidance?.(bot.id) ?? "", (id) => this.store.getFolder(id)?.title);
    await conversation.configure({
      model: ref,
      thinkingLevel: model?.reasoning ? "medium" : "off",
      tools: Object.entries(run.registry).map(([name, spec]) => this.registrationFor(name, spec)),
      instructions,
    }, this.context);
  }

  /** Saves where the turn is, so a restart can pick it up in the same reply. */
  private checkpoint(run: PiRun) {
    this.store.saveRun({
      id: run.id, chatId: run.chatId, botId: run.botId, messageId: run.messageId, stepsBefore: run.stepsBefore,
      messages: JSON.stringify({ runtime: "pi", conversationId: run.conversationId, submissionId: run.submission?.id ?? null }),
      options: { hiddenPrompt: run.options.hiddenPrompt, depth: run.options.depth },
      startedAt: run.startedAt, updatedAt: Date.now(),
    });
  }

  // ---------- What the conversation does, as Colony shows it ----------

  private async watch(run: PiRun) {
    const stream = await watchEvents(this.harness, run.conversationId, this.context);
    run.stream = stream;
    stream.start(async (events) => {
      if (process.env.COLONY_DEBUG_EVENTS) fs.appendFileSync(process.env.COLONY_DEBUG_EVENTS, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
      for (const event of events) this.apply(run, event);
    });
    void stream.closed.then(() => run.finish());
  }

  private save(run: PiRun, force = false) {
    const now = Date.now();
    if (!force && now - run.lastSave < 750) return;
    run.lastSave = now;
    // Persist quietly; streamed text reaches clients through ephemeral deltas.
    this.store.updateMessage(run.messageId, { text: run.text, reasoning: run.reasoning, steps: run.steps }, { emit: false });
  }

  private emitSteps(run: PiRun) {
    this.store.updateMessage(run.messageId, { text: run.text, reasoning: run.reasoning, steps: run.steps });
  }

  private apply(run: PiRun, event: AgentEvent) {
    switch (event.type) {
      case "message_start": {
        // A response's first partial arrives with its start.
        if (event.message.role === "assistant") {
          run.shown.clear();
          event.message.content.forEach((block, index) => this.showBlock(run, index, block));
        }
        break;
      }
      case "message_update": {
        for (const change of event.changes) {
          if (change.type === "text_delta" || change.type === "thinking_delta") {
            const kind = change.type === "text_delta" ? "text" : "thinking";
            this.show(run, change.contentIndex, kind, (run.shown.get(`${kind}:${change.contentIndex}`) ?? "") + change.delta);
          }
          else if (change.type === "message") change.message.content.forEach((block, index) => this.showBlock(run, index, block));
          else if ("block" in change) this.showBlock(run, change.contentIndex, change.block);
        }
        break;
      }
      case "message_end": {
        const message = event.entry.model?.[0];
        if (message?.role === "assistant" && AssistantEntry.is(event.entry)) {
          // The finished response: anything the partial updates didn't show yet.
          message.content.forEach((block, index) => this.showBlock(run, index, block));
          run.shown.clear();
          // What this response used and cost.
          this.store.recordUsage(usageEntry(run.target, { id: run.botId }, tokensOf(message.usage), priceOf(run.target.provider, run.target.model)));
          if (message.stopReason !== "toolUse") this.store.setMessageEntry(run.messageId, String(run.conversationId), String(event.entry.id));
        }
        break;
      }
      case "tool_execution_start": {
        if (event.parentToolCallId) break;
        run.afterTool = true;
        const spec = run.registry[event.toolName];
        const title = spec ? safe(() => spec.describe(event.args), event.toolName) : event.toolName;
        run.steps.push({ id: event.toolCallId, tool: event.toolName, title, status: "running", startedAt: Date.now() });
        this.store.setPresence(run.botId, "working", title);
        this.emitSteps(run);
        break;
      }
      case "tool_execution_end": {
        if (event.parentToolCallId) break;
        const step = run.steps.findLast((item) => item.id === event.toolCallId);
        if (!step) break;
        const result = event.entry?.model?.[0] as ToolResultMessage | undefined;
        const text = (result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ").trim();
        const codes = ((event.entry?.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? []).map((item) => item.code);
        step.endedAt = Date.now();
        if (codes.includes("interrupted") || text.includes(RESTARTED_ACTING)) {
          step.status = "interrupted";
          step.detail = "May not have finished";
        } else if (!result || result.isError) {
          // pi wraps a tool's error for the model ("<harness>[error] …</harness>"); you see just the error.
          const said = text.replace(/^<harness>\s*(\[error\]\s*)?/, "").replace(/\s*<\/harness>$/, "").trim();
          step.status = /denied|said no/i.test(said) ? "denied" : "error";
          step.detail = (said || "Didn't finish.").slice(0, 160);
        } else {
          step.status = "done";
          const spec = run.registry[event.toolName];
          step.detail = spec?.summarize ? safe(() => spec.summarize!(run.outputs.get(event.toolCallId)), undefined) : undefined;
        }
        run.outputs.delete(event.toolCallId);
        this.emitSteps(run);
        this.checkpoint(run);
        this.store.setPresence(run.botId, "thinking", "Thinking");
        break;
      }
      case "submission": {
        // A steer you sent mid-turn is placed now: close the reply where you cut in; the rest continues below your message.
        const messageId = run.steers.get(event.record.id);
        if (messageId && event.record.status === "placed") this.pickedUp(run, messageId);
        break;
      }
      case "compaction_end": {
        if (event.error) break;
        const now = Date.now();
        run.steps.push({ id: `compact-${now}`, tool: "colony.compaction", title: "Compacted the earlier conversation", status: "done", startedAt: now, endedAt: now });
        this.emitSteps(run);
        break;
      }
      case "run_end": {
        if (run.submission && event.inputs.includes(run.submission.id)) run.finish();
        break;
      }
      case "snapshot": {
        // Fell behind: pi sent the whole state. No run in it means this turn's run is over.
        if (!event.run && run.submission) run.finish();
        break;
      }
    }
  }

  private showBlock(run: PiRun, index: number, block: AssistantMessage["content"][number]) {
    if (block.type === "text") this.show(run, index, "text", block.text);
    else if (block.type === "thinking") this.show(run, index, "thinking", block.thinking);
  }

  /** Shows a response's text (or thinking) as it grows: whatever is new since it was last shown. */
  private show(run: PiRun, index: number, kind: "text" | "thinking", full: string) {
    const key = `${kind}:${index}`;
    const before = run.shown.get(key) ?? "";
    // Only what's new is shown; a block rewritten from the start (rare) keeps what was shown.
    if (full.length <= before.length || !full.startsWith(before)) return;
    const added = full.slice(before.length);
    run.shown.set(key, full);
    if (kind === "thinking") {
      run.reasoning += added;
      this.events.broadcast({ type: "message.delta", messageId: run.messageId, chatId: run.chatId, text: "", reasoning: added });
      this.save(run);
      return;
    }
    // Text written after a tool call starts a new paragraph, not the same sentence.
    const delta = run.afterTool && run.text && !run.text.endsWith("\n") && added.trim() ? `\n\n${added.trimStart()}` : added;
    if (added.trim()) run.afterTool = false;
    run.text += delta;
    this.store.setPresence(run.botId, "working", "Writing a reply");
    this.events.broadcast({ type: "message.delta", messageId: run.messageId, chatId: run.chatId, text: delta });
    this.save(run);
  }

  private pickedUp(run: PiRun, messageId: string) {
    run.steers.forEach((value, key) => { if (value === messageId) run.steers.delete(key); });
    this.store.updateMessage(messageId, { delivery: "steer", steeredAt: run.stepsBefore + run.steps.length });
    this.store.setPresence(run.botId, "thinking", "Changing course");
    if (!run.text.trim() && !run.steps.length) return;
    this.store.updateMessage(run.messageId, { text: stripNotes(run.text), reasoning: run.reasoning, steps: run.steps, status: "done" });
    run.stepsBefore += run.steps.length;
    const next = this.store.createMessage({ chatId: run.chatId, author: run.botId, status: "streaming" });
    run.messageId = next.id;
    run.messageIds.push(next.id);
    run.text = ""; run.reasoning = ""; run.steps = []; run.afterTool = false;
    this.checkpoint(run);
  }

  // ---------- Compacting and starting fresh ----------

  private async linked(chatId: string, botId: string) {
    const linked = this.store.conversationOf(chatId, botId);
    return linked ? await this.conversation(Number(linked.conversationId) as ConversationId) : undefined;
  }

  /** Summarises the older part of a Bot's conversation in this chat now (it also happens on its own near the context limit). */
  async compact(chatId: string, botId: string) {
    const conversation = await this.linked(chatId, botId);
    if (!conversation) throw new Error("There's no conversation to compact yet.");
    const task = await conversation.compact(undefined, this.context);
    const { state } = await this.harness.waitForTask(task, this.context);
    const outcome = state.outcome as { status: string; result?: { entryId?: unknown; submissionId?: unknown }; error?: unknown };
    if (outcome.status !== "completed") throw new Error("Compacting didn't work this time. Try again in a moment.");
    const compacted = Boolean(outcome.result?.entryId ?? outcome.result?.submissionId);
    const bot = this.store.getBot(botId);
    this.store.createMessage({ chatId, author: "system", text: compacted
      ? `${bot?.name ?? "The Bot"} summarised the earlier conversation. It keeps the summary and the recent messages; the full history stays saved.`
      : `${bot?.name ?? "The Bot"}'s conversation is short enough already.` });
  }

  /** The Bot starts this chat from a clean slate: it no longer sees the conversation so far. Its memory, skills and the chat stay. */
  async startFresh(chatId: string, botId: string) {
    const conversation = await this.linked(chatId, botId);
    if (conversation) await conversation.reset(undefined, this.context);
    // Everything in the chat so far counts as seen, so the clean slate stays clean.
    if (conversation) this.store.markSeen(String(conversation.id), this.store.listMessages(chatId, { limit: 200 }).map((message) => message.id));
    const bot = this.store.getBot(botId);
    this.store.createMessage({ chatId, author: "system", text: `${bot?.name ?? "The Bot"} starts fresh from here. Its memory and skills stay.` });
  }

  /**
   * A new topic that carries a Bot's conversation up to one of its replies (a fork: the history
   * is shared, not copied). The original chat goes on unchanged.
   */
  async branch(messageId: string, topic: { title: string; folderId: string | null }) {
    const message = this.store.getMessage(messageId);
    const bot = message ? this.store.getBot(message.author) : null;
    const source = message ? this.store.getChat(message.chatId) : null;
    const at = this.store.messageEntry(messageId);
    if (!message || !bot || !source) throw new Error("Only a Bot's reply can be branched.");
    if (!at) throw new Error("This reply is from before Bots kept their conversations, so it can't be branched.");
    const conversation = await this.conversation(Number(at.conversationId) as ConversationId);
    if (!conversation) throw new Error("That conversation is gone.");
    const fork = await conversation.fork(Number(at.entryId) as never, { ownership: { kind: "ownerless" } }, this.context);
    const chat = this.store.createChat({
      kind: "topic", title: topic.title, icon: "chat", folderId: topic.folderId, memberIds: [bot.id], coordinatorId: bot.id,
      brief: `Branched from "${source.title}".`,
    });
    this.store.linkConversation(chat.id, bot.id, String(fork.id));
    const when = new Date(message.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    this.store.createMessage({ chatId: chat.id, author: "system", text: `Branched from ${source.title} · ${when}. ${bot.name} remembers the conversation up to there.` });
    return chat.id;
  }

  // ---------- Bots asking each other ----------

  /**
   * One Bot messages another in their private thread and waits for the reply. Stopping the asker
   * stops the answer too. After a restart, the asking call finds the answer it was waiting for.
   */
  async consult(fromId: string, toId: string, text: string, signal: AbortSignal, depth: number, memo?: <T>(key: string, value?: T) => Promise<T | undefined>) {
    const from = this.store.getBot(fromId);
    const to = this.store.getBot(toId);
    if (!from || !to) throw new Error("That Bot no longer exists.");
    const thread = this.store.findThread(fromId, toId)
      ?? this.store.createChat({ kind: "thread", title: `${from.name} & ${to.name}`, memberIds: [fromId, toId], coordinatorId: null });
    const asked = await memo?.<{ replyId: string }>("consult");
    let replyId = asked?.replyId;
    if (!replyId) {
      if (this.isRunning(thread.id, toId)) throw new Error(`${to.name} is still answering an earlier message.`);
      this.store.createMessage({ chatId: thread.id, author: fromId, text });
      replyId = this.start(thread.id, toId, { depth: depth + 1 });
      await memo?.("consult", { replyId });
    }
    const helper = this.active.get(`${thread.id}:${toId}`);
    const onAbort = () => { if (helper && helper.messageIds.includes(replyId!)) this.abort(helper, "stopped"); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const reply = await this.settled(replyId);
      return { chatId: thread.id, reply };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Waits for a reply to finish (the last part of it, if a steer split it). */
  private settled(messageId: string): Promise<Message> {
    return new Promise((resolve) => {
      const check = () => {
        // A steer can split a reply; its last part is the one that ends the turn.
        const run = [...this.active.values()].find((item) => item.messageIds.includes(messageId));
        const message = this.store.getMessage(run?.messageIds.at(-1) ?? messageId);
        if (!message || message.status === "streaming") return false;
        resolve(message);
        return true;
      };
      if (check()) return;
      const stop = this.events.subscribe(({ event }) => {
        if (event.type === "message.upserted" && check()) stop();
      });
    });
  }

  // ---------- After a restart ----------

  /**
   * Picks up the turns that were running when Colony stopped, in the replies they were writing.
   * pi durable continues them where they were; a turn the AI SDK runtime was running starts again
   * here from the chat, told that steps it took may or may not have happened.
   */
  resumeAll(checkpoints: RunCheckpoint[]) {
    let release!: () => void;
    this.resumed = new Promise((resolve) => { release = resolve; });
    const kept = new Set<ConversationId>();
    for (const checkpoint of checkpoints) {
      const saved = (() => { try { return JSON.parse(checkpoint.messages) as Saved; } catch { return {}; } })();
      if (saved.runtime === "pi" && saved.conversationId) kept.add(saved.conversationId);
      this.resume(checkpoint, saved);
    }
    void (async () => {
      // Conversations left running by a turn that won't be picked up (too old, or its Bot is gone) stop.
      const inspection = await this.harness.inspect(this.context);
      for (const conversationId of new Set(inspection.tasks.map((task) => task.record.conversationId))) {
        if (!kept.has(conversationId)) await (await this.conversation(conversationId))?.abort(this.context).catch(() => {});
      }
    })().catch(() => {}).finally(() => { release(); this.harness.resume(); });
  }

  private resume(checkpoint: RunCheckpoint, saved: Saved) {
    const reply = this.store.getMessage(checkpoint.messageId);
    if (this.active.has(`${checkpoint.chatId}:${checkpoint.botId}`) || !reply) return;
    const now = Date.now();
    const steps = reply.steps.map((step) => ({ ...step }));
    const pi = saved.runtime === "pi" && saved.conversationId && saved.submissionId;
    if (!pi) {
      // From the AI SDK runtime: whatever was cut off may or may not have happened.
      for (const step of steps) if (step.status === "running" || step.status === "waiting") { step.status = "interrupted"; step.detail = "May not have finished"; step.endedAt = now; }
    }
    steps.push({ id: `restart-${now}`, tool: "colony.restart", title: "Colony restarted · picking up where it left off", status: "done", startedAt: now, endedAt: now });
    const run = this.newRun({
      id: checkpoint.id, chatId: checkpoint.chatId, botId: checkpoint.botId, messageId: checkpoint.messageId, startedAt: pi ? checkpoint.startedAt : now,
      options: { hiddenPrompt: checkpoint.options.hiddenPrompt, depth: checkpoint.options.depth }, text: reply.text, reasoning: reply.reasoning, steps, stepsBefore: checkpoint.stepsBefore,
    });
    this.store.setPresence(run.botId, "working", "Picking up where it left off");
    this.emitSteps(run);
    if (pi) {
      try { this.prepare(run); } catch { /* execute says why */ }
      run.conversationId = saved.conversationId!;
      this.byConversation.set(run.conversationId, run);
      void (async () => {
        const submission = await this.harness.submission(saved.submissionId!, this.context);
        if (!submission) throw new Error("This conversation can't be picked up.");
        run.submission = submission;
        await this.execute(run, true);
      })().catch(async (error) => {
        this.store.updateMessage(run.messageId, { status: "stopped", error: "Colony restarted while this reply was running." });
        console.warn("[colony] couldn't pick a turn back up:", error instanceof Error ? error.message : error);
        this.store.deleteRun(run.id);
      }).finally(() => this.finished(run));
      return;
    }
    // A fresh pi turn in the same reply, with the cut-off steps explained.
    run.options = {
      ...run.options,
      hiddenPrompt: "[System note: Colony was updated while you were working on your last reply, and you're picking it up here. Steps marked as interrupted may or may not have happened; check before repeating them. Carry on with the task.]",
    };
    this.store.deleteRun(checkpoint.id);
    void this.execute(run, false).finally(() => this.finished(run));
  }
}

/** What the runs table holds for a pi turn. */
type Saved = { runtime?: string; conversationId?: ConversationId; submissionId?: SubmissionId | null };

/** A Colony tool's result as pi content: text, or a screenshot with its caption. */
function contentOf(output: unknown, spec: ColonyTool, shot: DesktopShot | null): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  const shaped = spec.toModelOutput?.(output) as { type: string; value: unknown } | undefined;
  if (shaped?.type === "content" && Array.isArray(shaped.value)) {
    for (const part of shaped.value as { type: string; text?: string; data?: { data?: string }; mediaType?: string }[]) {
      if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
      if (part.type === "file" && part.data?.data) content.push({ type: "image", data: part.data.data, mimeType: part.mediaType ?? "image/png" });
    }
  } else if (shaped?.type === "text" && typeof shaped.value === "string") {
    content.push({ type: "text", text: shaped.value });
  } else {
    content.push({ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? null) });
  }
  if (shot) content.push({ type: "image", data: shot.data, mimeType: shot.mediaType });
  return content;
}

/** Older screenshots in tool results become a note, so long desktop runs stay affordable. */
function pruneScreenshots(messages: readonly PiMessage[]): readonly PiMessage[] {
  let seen = 0;
  let changed = false;
  const pruned = [...messages].reverse().map((message) => {
    if (message.role !== "toolResult" || !message.content.some((part) => part.type === "image")) return message;
    seen += 1;
    if (seen <= KEEP_IMAGES) return message;
    changed = true;
    return { ...message, content: [...message.content.filter((part) => part.type !== "image"), { type: "text" as const, text: "(An earlier screenshot, removed to save space.)" }] };
  }).reverse();
  return changed ? pruned : messages;
}

/** A chat message from the history, as a pi message from this turn's model. */
function piMessage(message: ModelMessage, ref: ModelRef, api: Api): PiMessage {
  const timestamp = Date.now();
  if (message.role === "assistant") {
    return {
      role: "assistant", content: [{ type: "text", text: message.content }], api,
      provider: ref.provider, model: ref.modelId, stopReason: "stop", timestamp,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as AssistantMessage;
  }
  const content = typeof message.content === "string" ? message.content : message.content.map((part): TextContent | ImageContent =>
    part.type === "text" ? { type: "text", text: part.text } : { type: "image", data: Buffer.from(part.image).toString("base64"), mimeType: part.mediaType ?? "image/png" });
  return { role: "user", content, timestamp } as UserMessage;
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

