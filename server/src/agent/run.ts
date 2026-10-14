import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, type LanguageModel, type ModelMessage } from "ai";
import { config, modelConfigured, resolveModel } from "../config.js";
import type { EventLog } from "../events.js";
import type { Store } from "../store.js";
import type { Card, Message, Step } from "../shared/types.js";
import type { ApprovalGate } from "./approvals.js";
import { historyFor, stripNotes, systemPrompt } from "./prompt.js";
import { coreTools, toToolSet, type ToolContext, type ToolRegistry } from "./tools.js";

/** `sessionId` groups one chat's requests; some providers (OpenCode Go) require it. */
export type ModelFactory = (modelId: string, sessionId: string) => LanguageModel;

export const defaultModelFactory: ModelFactory = (modelId, sessionId) => createOpenAICompatible({
  name: config.model.providerName,
  baseURL: config.model.baseURL,
  apiKey: config.model.apiKey,
  headers: {
    "User-Agent": "colony/0.2",
    ...(new URL(config.model.baseURL).hostname.endsWith("opencode.ai") ? { "x-opencode-session": sessionId } : {}),
  },
}).chatModel(modelId);

type StartOptions = {
  /** Extra user-turn text that is sent to the model but not shown in the chat. */
  hiddenPrompt?: string;
  /** Cards the reply starts with, e.g. the routine that triggered it. */
  cards?: Card[];
  /** How many Bots deep this turn is (another Bot asking = 1). */
  depth?: number;
  /** Called with the finished reply (used by groups and routines). */
  onFinish?: (message: Message) => void;
};

type ActiveRun = { controller: AbortController; botId: string; chatId: string; messageId: string };

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
  ) {}

  isRunning(chatId: string, botId?: string) {
    return [...this.active.values()].some((run) => run.chatId === chatId && (!botId || run.botId === botId));
  }

  stop(chatId: string) {
    for (const run of this.active.values()) if (run.chatId === chatId) run.controller.abort("stopped");
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
      ?? this.store.createChat({ kind: "thread", title: `${from.name} & ${to.name}`, memberIds: [fromId, toId], coordinatorId: null });
    if (this.isRunning(thread.id, toId)) throw new Error(`${to.name} is still answering an earlier message.`);
    this.store.createMessage({ chatId: thread.id, author: fromId, text });
    const reply = await new Promise<Message>((resolve, reject) => {
      let messageId: string;
      try {
        messageId = this.start(thread.id, toId, { depth: depth + 1, onFinish: resolve });
      } catch (error) { reject(error); return; }
      const key = `${thread.id}:${toId}`;
      signal.addEventListener("abort", () => { if (this.active.get(key)?.messageId === messageId) this.active.get(key)!.controller.abort("stopped"); }, { once: true });
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
    this.active.set(key, { controller, botId, chatId, messageId: message.id });
    clearTimeout(this.idleTimers.get(botId));
    const asker = options.depth ? this.store.listBots().find((item) => item.id !== botId && chat.memberIds.includes(item.id)) : undefined;
    this.store.setPresence(botId, "thinking", asker ? `Helping ${asker.name}` : "Thinking");

    void this.execute(message.id, chatId, botId, controller, options).finally(() => this.active.delete(key));
    return message.id;
  }

  private async execute(messageId: string, chatId: string, botId: string, controller: AbortController, options: StartOptions) {
    const bot = this.store.getBot(botId)!;
    const chat = this.store.getChat(chatId)!;
    const timeout = setTimeout(() => controller.abort("timeout"), config.limits.turnTimeoutMs);

    let text = "";
    let reasoning = "";
    const steps: Step[] = [];
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

    try {
      if (!modelConfigured()) throw new Error("No model is configured. Set COLONY_API_BASE_URL, COLONY_API_KEY and COLONY_MODELS in .env.");
      const bots = this.store.listBots();
      const names = new Map(bots.map((item) => [item.id, item.name]));
      const others = bots.filter((item) => chat.memberIds.includes(item.id) && item.id !== botId);
      const history: ModelMessage[] = historyFor(bot, this.store.listMessages(chatId, { limit: config.limits.historyMessages }), names);
      if (options.hiddenPrompt) history.push({ role: "user", content: options.hiddenPrompt });
      if (!history.length) throw new Error("Nothing to reply to.");

      // A Bot answering another Bot can't pass the work on again.
      const { message_bot: _, ...withoutMessaging } = this.tools(botId);
      const registry = options.depth ? withoutMessaging : this.tools(botId);
      const depth = options.depth ?? 0;
      const ctx: ToolContext = {
        botId, botName: bot.name, chatId, messageId, signal: controller.signal, gate: this.gate, store: this.store, depth,
        consult: (toId, message) => this.consult(botId, toId, message, controller.signal, depth),
      };
      const result = streamText({
        model: this.modelFactory(resolveModel(bot.model), `${chatId}:${botId}`),
        system: systemPrompt(bot, chat, others, this.store.listRoutines(botId), options.depth ? [] : bots.filter((item) => item.id !== botId)),
        messages: history,
        tools: toToolSet(registry, ctx),
        stopWhen: stepCountIs(config.limits.maxSteps),
        maxOutputTokens: config.limits.maxOutputTokens,
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
            const step = steps.find((item) => item.id === part.toolCallId);
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
            const step = steps.find((item) => item.id === part.toolCallId);
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
        error = failure instanceof Error && /configured|Nothing to reply/.test(failure.message) ? failure.message : "The model couldn't finish this reply. Check the model settings and try again.";
      }
    } finally {
      clearTimeout(timeout);
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
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

