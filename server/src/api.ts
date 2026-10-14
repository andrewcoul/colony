import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config, resolveModel } from "./config.js";
import type { EventLog } from "./events.js";
import * as files from "./files.js";
import type { ApprovalGate } from "./agent/approvals.js";
import type { AgentRunner } from "./agent/run.js";
import type { ComputerService } from "./computer/docker.js";
import type { PushService } from "./push.js";
import type { RoutineScheduler } from "./routines.js";
import { MIN_INTERVAL_MINUTES, parseTime } from "./shared/schedule.js";
import * as ws from "./computer/workspace.js";
import type { Store } from "./store.js";
import type { AppState } from "./shared/types.js";

export type Services = {
  store: Store; events: EventLog; gate: ApprovalGate; runner: AgentRunner;
  computer?: ComputerService; routines?: RoutineScheduler; push?: PushService;
};

const schedule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily"), time: z.string().refine((time) => parseTime(time) !== null, "Pick a time."), days: z.array(z.number().int().min(0).max(6)).max(7) }),
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(7 * 1440) }),
  z.object({ type: z.literal("once"), at: z.number().int().refine((at) => at > Date.now(), "That time has already passed.") }),
]);
const routineInput = z.object({
  title: z.string().trim().min(1, "Give the routine a name.").max(80),
  prompt: z.string().trim().min(1, "Say what the Bot should do.").max(4000),
  schedule,
  enabled: z.boolean().optional(),
});
const pushSubscription = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });

const botInput = z.object({
  name: z.string().trim().min(1).max(40),
  title: z.string().trim().max(60).default(""),
  description: z.string().trim().max(4000).default(""),
  faceSeed: z.string().trim().max(60).optional(),
  model: z.string().max(200).optional(),
  computer: z.boolean().default(false),
});

const INTRO_PROMPT = "(System: you were just created. Greet the user in one or two short sentences, in your own voice: who you are and what you can take off their plate. Don't use tools.)";

/** Bots named with @Name in a group message; falls back to the coordinator. */
function addressedBots(text: string, memberIds: string[], store: Store, coordinatorId: string | null) {
  const members = memberIds.map((id) => store.getBot(id)).filter((bot) => bot !== null);
  const mentioned = members.filter((bot) => new RegExp(`@${bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  if (mentioned.length) return mentioned.map((bot) => bot.id);
  return coordinatorId && memberIds.includes(coordinatorId) ? [coordinatorId] : memberIds.slice(0, 1);
}

export function createApi({ store, events, gate, runner, computer, routines, push }: Services) {
  const api = new Hono();

  api.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map((issue) => issue.message).join("; ") }, 400);
    console.warn("[colony] request failed:", error.message);
    return c.json({ error: error.message || "Something went wrong." }, 500);
  });

  api.get("/state", (c) => c.json<AppState>({
    bots: store.listBots(),
    chats: store.listChats(),
    // Recent approvals of every status, so old cards can show "Approved"/"Denied".
    approvals: store.listApprovals(),
    routines: store.listRoutines(),
    models: [...config.model.models],
    defaultModel: config.model.defaultModel,
    seq: events.latestSeq(),
  }));

  // ---------- Bots ----------
  api.post("/bots", async (c) => {
    const input = botInput.parse(await c.req.json());
    const bot = store.createBot({ ...input, model: resolveModel(input.model) });
    files.initBotFolder(bot);
    try { runner.start(bot.chatId, bot.id, { hiddenPrompt: INTRO_PROMPT }); } catch { /* no model yet: the Bot still exists */ }
    return c.json(bot, 201);
  });

  api.patch("/bots/:id", async (c) => {
    const patch = botInput.partial().parse(await c.req.json());
    const bot = store.updateBot(c.req.param("id"), { ...patch, ...(patch.model ? { model: resolveModel(patch.model) } : {}) });
    return bot ? c.json(bot) : c.json({ error: "Bot not found." }, 404);
  });

  api.delete("/bots/:id", async (c) => {
    const id = c.req.param("id");
    runner.stopBot(id);
    store.deleteBot(id);
    await computer?.remove(id);
    files.removeBotFolder(id);
    return c.body(null, 204);
  });

  // ---------- Computer ----------
  api.get("/bots/:id/terminal", (c) => c.json({ text: computer?.readLog(c.req.param("id")) ?? "" }));
  api.get("/bots/:id/files", (c) => c.json(ws.listWorkspace(c.req.param("id"), c.req.query("path") ?? "", 1)));
  api.get("/bots/:id/file", (c) => {
    const file = ws.readWorkspaceFile(c.req.param("id"), c.req.query("path") ?? "", 0, 200_000);
    return c.json(file);
  });
  api.post("/bots/:id/computer/stop", async (c) => {
    await computer?.stop(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/bots/:id/soul", (c) => c.json({ content: files.readSoul(c.req.param("id")) }));
  api.put("/bots/:id/soul", async (c) => {
    const { content } = z.object({ content: z.string().max(20_000) }).parse(await c.req.json());
    files.writeSoul(c.req.param("id"), content);
    return c.body(null, 204);
  });
  api.get("/bots/:id/memory", (c) => {
    const id = c.req.param("id");
    return c.json({ memory: files.readEntries(id, "memory"), user: files.readEntries(id, "user"), skills: files.listSkills(id) });
  });

  // ---------- Chats ----------
  api.post("/groups", async (c) => {
    const input = z.object({
      title: z.string().trim().min(1).max(60),
      memberIds: z.array(z.string()).min(2).max(6),
      coordinatorId: z.string().optional(),
    }).parse(await c.req.json());
    if (input.memberIds.some((id) => !store.getBot(id))) return c.json({ error: "Unknown Bot in group." }, 400);
    const coordinatorId = input.coordinatorId && input.memberIds.includes(input.coordinatorId) ? input.coordinatorId : input.memberIds[0];
    return c.json(store.createChat({ kind: "group", title: input.title, memberIds: input.memberIds, coordinatorId }), 201);
  });

  api.delete("/chats/:id", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "Chat not found." }, 404);
    if (chat.kind !== "group") return c.json({ error: "A Bot's own chat can't be deleted; delete the Bot instead." }, 400);
    runner.stop(chat.id);
    store.deleteChat(chat.id);
    return c.body(null, 204);
  });

  api.get("/chats/:id/messages", (c) => {
    const before = Number(c.req.query("before")) || undefined;
    return c.json(store.listMessages(c.req.param("id"), { before, limit: 50 }));
  });

  api.post("/chats/:id/messages", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "Chat not found." }, 404);
    const { text } = z.object({ text: z.string().trim().min(1).max(32_000) }).parse(await c.req.json());
    const message = store.createMessage({ chatId: chat.id, author: "user", text });
    const targets = chat.kind === "bot" ? chat.memberIds : addressedBots(text, chat.memberIds, store, chat.coordinatorId);
    const started: string[] = [];
    for (const botId of targets) {
      if (runner.isRunning(chat.id, botId)) continue; // The Bot will see this message on its next turn.
      started.push(runner.start(chat.id, botId));
    }
    store.markRead(chat.id);
    return c.json({ message, replies: started }, 201);
  });

  api.post("/chats/:id/stop", (c) => {
    runner.stop(c.req.param("id"));
    return c.body(null, 204);
  });

  api.post("/chats/:id/read", (c) => {
    store.markRead(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- Routines ----------
  api.post("/bots/:id/routines", async (c) => {
    const bot = store.getBot(c.req.param("id"));
    if (!bot) return c.json({ error: "Bot not found." }, 404);
    const input = routineInput.parse(await c.req.json());
    const routine = store.createRoutine({ botId: bot.id, chatId: bot.chatId, title: input.title, prompt: input.prompt, schedule: input.schedule });
    return c.json(input.enabled === false ? store.updateRoutine(routine.id, { enabled: false }) : routine, 201);
  });

  api.patch("/routines/:id", async (c) => {
    const routine = store.updateRoutine(c.req.param("id"), routineInput.partial().parse(await c.req.json()));
    return routine ? c.json(routine) : c.json({ error: "Routine not found." }, 404);
  });

  api.delete("/routines/:id", (c) => {
    store.deleteRoutine(c.req.param("id"));
    return c.body(null, 204);
  });

  api.post("/routines/:id/run", (c) => {
    const routine = store.getRoutine(c.req.param("id"));
    if (!routine) return c.json({ error: "Routine not found." }, 404);
    if (runner.isRunning(routine.chatId, routine.botId)) return c.json({ error: "That Bot is busy in this chat right now." }, 409);
    const messageId = routines?.run(routine.id, { manual: true });
    return messageId ? c.json({ messageId }) : c.json({ error: "Couldn't start the routine." }, 500);
  });

  // ---------- Notifications ----------
  api.get("/push/key", (c) => push ? c.json({ publicKey: push.publicKey }) : c.json({ error: "Notifications are off." }, 503));
  api.post("/push/subscribe", async (c) => {
    push?.subscribe(pushSubscription.parse(await c.req.json()));
    return c.body(null, 204);
  });
  api.post("/push/unsubscribe", async (c) => {
    push?.unsubscribe(z.object({ endpoint: z.string() }).parse(await c.req.json()).endpoint);
    return c.body(null, 204);
  });
  api.post("/push/status", async (c) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(await c.req.json());
    return c.json({ subscribed: push?.isSubscribed(endpoint) ?? false });
  });
  api.post("/push/test", async (c) => {
    const delivered = await push?.notify({ title: "Colony", body: "Notifications are on. Your Bots will ping you here.", chatId: null, tag: "test" }, { force: true }) ?? 0;
    return c.json({ delivered });
  });
  api.post("/focus", async (c) => {
    const input = z.object({ clientId: z.string().max(80), chatId: z.string().max(80).nullable(), visible: z.boolean() }).parse(await c.req.json());
    push?.setFocus(input.clientId, input.chatId, input.visible);
    return c.body(null, 204);
  });

  // ---------- Approvals ----------
  api.post("/approvals/:id", async (c) => {
    const { approve } = z.object({ approve: z.boolean() }).parse(await c.req.json());
    if (!gate.resolve(c.req.param("id"), approve)) return c.json({ error: "This approval is no longer waiting." }, 409);
    return c.body(null, 204);
  });

  // ---------- Live events (SSE, resumable via Last-Event-ID or ?since=) ----------
  api.get("/events", (c) => streamSSE(c, async (stream) => {
    const since = Number(c.req.header("Last-Event-ID") ?? c.req.query("since") ?? events.latestSeq());
    const clientId = c.req.query("client")?.slice(0, 80);
    const release = clientId && push ? push.attachClient(clientId) : null;
    let released = false;
    const detach = () => { if (!released) { released = true; release?.(); } };
    const queue: { seq: number | null; event: unknown }[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = events.subscribe((item) => { queue.push(item); wake?.(); });
    stream.onAbort(() => { unsubscribe(); detach(); wake?.(); });

    const backlog = events.since(since);
    if (backlog === null) await stream.writeSSE({ event: "reset", data: "{}" });
    else for (const item of backlog) await stream.writeSSE({ id: String(item.seq), event: "event", data: JSON.stringify(item.event) });
    let last = backlog?.at(-1)?.seq ?? since;
    // Flush headers right away so the client sees the connection open.
    await stream.writeSSE({ event: "ready", data: String(last) });

    const heartbeat = setInterval(() => { void stream.writeSSE({ event: "ping", data: "" }); }, 15_000);
    try {
      while (!stream.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
        for (const item of queue.splice(0)) {
          if (item.seq !== null && item.seq <= last) continue;
          if (item.seq !== null) last = item.seq;
          await stream.writeSSE({ ...(item.seq !== null ? { id: String(item.seq) } : {}), event: item.seq === null ? "ephemeral" : "event", data: JSON.stringify(item.event) });
        }
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
      detach();
    }
  }));

  return api;
}
