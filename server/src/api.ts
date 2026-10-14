import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import * as settings from "./settings.js";
import type { EventLog } from "./events.js";
import * as files from "./files.js";
import type { ApprovalGate } from "./agent/approvals.js";
import { checkDesktop, type DesktopVerdict } from "./agent/desktopCheck.js";
import { defaultModelFactory, type AgentRunner, type ModelFactory } from "./agent/run.js";
import type { BrowserService } from "./computer/browser.js";
import type { DesktopService } from "./computer/desktop.js";
import type { ComputerService } from "./computer/docker.js";
import type { PushService } from "./push.js";
import type { RoutineScheduler } from "./routines.js";
import { MIN_INTERVAL_MINUTES, parseTime } from "./shared/schedule.js";
import * as ws from "./computer/workspace.js";
import type { Store } from "./store.js";
import type { AppState } from "./shared/types.js";

export type Services = {
  store: Store; events: EventLog; gate: ApprovalGate; runner: AgentRunner;
  computer?: ComputerService; browser?: BrowserService; desktop?: DesktopService; routines?: RoutineScheduler; push?: PushService;
  /** The model client used by the desktop check (tests pass a scripted one). */
  modelFactory?: ModelFactory;
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

const botFields = {
  name: z.string().trim().min(1).max(40),
  title: z.string().trim().max(60),
  description: z.string().trim().max(4000),
  faceSeed: z.string().trim().max(60),
  model: z.string().max(200),
  computer: z.boolean(),
  desktop: z.boolean(),
};
const botInput = z.object({
  ...botFields,
  title: botFields.title.default(""),
  description: botFields.description.default(""),
  faceSeed: botFields.faceSeed.optional(),
  model: botFields.model.optional(),
  computer: botFields.computer.default(false),
  desktop: botFields.desktop.default(false),
});

/** Why this combination can't drive a desktop, if it can't. */
function desktopProblem(computer: boolean, desktop: boolean, model: string | undefined) {
  if (!desktop) return null;
  if (!computer) return "The desktop needs the Bot's own computer.";
  if (!settings.canDriveDesktop(settings.resolveModel(model))) {
    return "That model can't drive a desktop. Pick one marked for desktop use, or run the desktop check in Settings.";
  }
  return null;
}
// No defaults here: a patch must only change the fields it names.
const botPatch = z.object(botFields).partial();

const INTRO_PROMPT = "(System: you were just created. Greet the user in one or two short sentences, in your own voice: who you are and what you can take off their plate. Don't use tools.)";

/** Bots named with @Name in a group message; falls back to the coordinator. */
function addressedBots(text: string, memberIds: string[], store: Store, coordinatorId: string | null) {
  const members = memberIds.map((id) => store.getBot(id)).filter((bot) => bot !== null);
  const mentioned = members.filter((bot) => new RegExp(`@${bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  if (mentioned.length) return mentioned.map((bot) => bot.id);
  return coordinatorId && memberIds.includes(coordinatorId) ? [coordinatorId] : memberIds.slice(0, 1);
}

export function createApi({ store, events, gate, runner, computer, browser, desktop, routines, push, modelFactory = defaultModelFactory }: Services) {
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
    models: settings.modelOptions(),
    defaultModel: settings.defaultModel(),
    configured: settings.modelConfigured(),
    seq: events.latestSeq(),
  }));

  // Bot ids become folder names, so every per-Bot route must name a Bot that exists.
  api.use("/bots/:id/*", async (c, next) => {
    if (!store.getBot(c.req.param("id"))) return c.json({ error: "Bot not found." }, 404);
    await next();
  });

  // ---------- Bots ----------
  api.post("/bots", async (c) => {
    const input = botInput.parse(await c.req.json());
    const problem = desktopProblem(input.computer, input.desktop, input.model);
    if (problem) return c.json({ error: problem }, 400);
    const bot = store.createBot({ ...input, model: settings.resolveModel(input.model)?.ref ?? "" });
    files.initBotFolder(bot);
    try { runner.start(bot.chatId, bot.id, { hiddenPrompt: INTRO_PROMPT }); } catch { /* no model yet: the Bot still exists */ }
    return c.json(bot, 201);
  });

  api.patch("/bots/:id", async (c) => {
    const patch = botPatch.parse(await c.req.json());
    if (patch.model && !settings.resolveModel(patch.model, { fallback: false })) return c.json({ error: "That model isn't in Settings." }, 400);
    const current = store.getBot(c.req.param("id"))!;
    const computerOn = patch.computer ?? current.computer;
    const problem = desktopProblem(computerOn, computerOn && (patch.desktop ?? current.desktop), patch.model ?? current.model);
    if (problem) return c.json({ error: problem }, 400);
    const bot = store.updateBot(c.req.param("id"), { ...patch, ...(patch.model ? { model: settings.resolveModel(patch.model)!.ref } : {}) });
    return bot ? c.json(bot) : c.json({ error: "Bot not found." }, 404);
  });

  api.delete("/bots/:id", async (c) => {
    const id = c.req.param("id");
    runner.stopBot(id);
    store.deleteBot(id);
    await browser?.close(id);
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
    await browser?.close(c.req.param("id"));
    await computer?.stop(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- Screen: the Bot's desktop, live in Cua's viewer ----------
  /** A fresh viewer link (starts the computer if needed). The ticket is in the URL fragment. */
  api.get("/bots/:id/screen-link", async (c) => {
    const bot = store.getBot(c.req.param("id"))!;
    if (!bot.computer || !desktop) return c.json({ error: "This Bot has no computer." }, 400);
    return c.json(await desktop.viewerLink(bot.id));
  });
  /** The viewer page and its gRPC-Web calls, proxied to the desktop. (Its video WebSocket is proxied in index.ts.) */
  api.all("/bots/:id/screen/*", async (c) => {
    const bot = store.getBot(c.req.param("id"))!;
    const port = bot.computer ? await computer?.runningDesktopPort(bot.id) : null;
    if (!port) return c.json({ error: "The computer is off. Open the Screen tab to start it." }, 503);
    const url = new URL(c.req.url);
    const rest = /\/screen(\/.*)$/.exec(url.pathname)?.[1] ?? "/";
    const headers = new Headers(c.req.raw.headers);
    for (const name of ["host", "connection", "cookie", "origin", "referer"]) headers.delete(name);
    const upstream = await fetch(`http://127.0.0.1:${port}${rest}${url.search}`, {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
      ...({ duplex: "half" } as object),
    });
    const answer = new Headers(upstream.headers);
    // fetch already decoded the body.
    answer.delete("content-encoding");
    answer.delete("content-length");
    // The viewer forbids all framing; it's served from Colony's own origin, so let Colony's Screen tab
    // (and only Colony) embed it. The rest of its security policy is kept as is.
    const policy = answer.get("content-security-policy");
    if (policy) answer.set("content-security-policy", policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(upstream.body, { status: upstream.status, headers: answer });
  });

  // ---------- Browser: live view and takeover ----------
  const botWithComputer = (id: string) => {
    const bot = store.getBot(id);
    return bot?.computer && browser ? bot : null;
  };
  api.get("/bots/:id/browser", (c) => c.json({ open: browser?.isOpen(c.req.param("id")) ?? false, url: browser?.currentUrl(c.req.param("id")) ?? null }));
  api.post("/bots/:id/browser/open", async (c) => {
    const bot = botWithComputer(c.req.param("id"));
    if (!bot) return c.json({ error: "This Bot has no computer." }, 400);
    await browser!.open(bot.id);
    return c.json({ open: true, url: browser!.currentUrl(bot.id) });
  });
  api.post("/bots/:id/browser/input", async (c) => {
    const bot = botWithComputer(c.req.param("id"));
    if (!bot) return c.json({ error: "This Bot has no computer." }, 400);
    const input = z.discriminatedUnion("type", [
      z.object({ type: z.literal("click"), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
      z.object({ type: z.literal("type"), text: z.string().min(1).max(2000) }),
      z.object({ type: z.literal("key"), key: z.string().max(20) }),
      z.object({ type: z.literal("scroll"), dy: z.number().min(-3000).max(3000) }),
      z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2000) }),
      z.object({ type: z.literal("back") }),
      z.object({ type: z.literal("viewport"), mobile: z.boolean() }),
    ]).parse(await c.req.json());
    try { await browser!.input(bot.id, input); }
    catch (failure) { return c.json({ error: failure instanceof Error ? failure.message.split("\n")[0] : "That didn't work." }, 400); }
    return c.body(null, 204);
  });
  /** Screencast frames for one viewer, on their own stream so chat events stay light. */
  api.get("/bots/:id/browser/live", (c) => streamSSE(c, async (stream) => {
    const id = c.req.param("id");
    if (!botWithComputer(id)) { await stream.writeSSE({ event: "closed", data: "{}" }); return; }
    let pending: Promise<unknown> = Promise.resolve();
    let latest: string | null = null;
    // Drop frames the connection can't keep up with; always deliver the newest.
    const send = (event: string, data: string) => {
      latest = data;
      pending = pending.then(async () => {
        if (latest === null || stream.aborted) return;
        const next = latest;
        latest = null;
        await stream.writeSSE({ event, data: next });
      });
    };
    const stop = browser!.watch(id, (event) => {
      if (event.type === "frame") send("frame", JSON.stringify(event));
      else void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    });
    await stream.writeSSE({ event: browser!.isOpen(id) ? "open" : "closed", data: JSON.stringify({ url: browser!.currentUrl(id) }) });
    const heartbeat = setInterval(() => { void stream.writeSSE({ event: "ping", data: "" }); }, 15_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(heartbeat);
    stop();
  }));

  // ---------- Profile: persona, memory, skills ----------
  api.get("/bots/:id/soul", (c) => c.json({ content: files.readSoul(c.req.param("id")) }));
  api.put("/bots/:id/soul", async (c) => {
    const { content } = z.object({ content: z.string().max(20_000) }).parse(await c.req.json());
    files.writeSoul(c.req.param("id"), content);
    return c.body(null, 204);
  });
  const memoryView = (id: string) => ({
    memory: files.readEntries(id, "memory"),
    user: files.readEntries(id, "user"),
    usage: { memory: files.memoryUsage(id, "memory"), user: files.memoryUsage(id, "user") },
    skills: files.listSkills(id),
  });
  api.get("/bots/:id/memory", (c) => c.json(memoryView(c.req.param("id"))));
  const memoryEdit = z.object({ target: z.enum(["memory", "user"]), entry: z.string().trim().min(1).max(500) });
  api.post("/bots/:id/memory", async (c) => {
    const { target, entry } = memoryEdit.parse(await c.req.json());
    files.addEntry(c.req.param("id"), target, entry);
    return c.json(memoryView(c.req.param("id")));
  });
  api.post("/bots/:id/memory/remove", async (c) => {
    const { target, entry } = memoryEdit.parse(await c.req.json());
    files.removeExactEntry(c.req.param("id"), target, entry);
    return c.json(memoryView(c.req.param("id")));
  });
  api.get("/bots/:id/skills/:slug", (c) => {
    const content = files.readSkill(c.req.param("id"), c.req.param("slug"));
    return content === null ? c.json({ error: "Skill not found." }, 404) : c.json({ content });
  });
  api.delete("/bots/:id/skills/:slug", (c) => {
    files.deleteSkill(c.req.param("id"), c.req.param("slug"));
    return c.body(null, 204);
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
    if (chat.kind === "bot") return c.json({ error: "A Bot's own chat can't be deleted; delete the Bot instead." }, 400);
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
    if (chat.kind === "thread") return c.json({ error: "This is a private thread between two Bots; message one of them directly." }, 400);
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

  // ---------- Settings: model providers, switchable any time ----------
  const providerURL = z.string().trim().url().max(500).refine((url) => /^https?:\/\//i.test(url), "Use an http(s) address.");
  const providerInput = z.object({
    name: z.string().trim().max(40).default(""),
    baseURL: providerURL,
    protocol: z.enum(["openai", "anthropic"]).optional(),
    apiKey: z.string().max(500).optional(),
    models: z.array(z.string().trim().min(1).max(200)).min(1, "Add at least one model.").max(60),
    /** Models that can drive a desktop (set by the desktop check or by hand). */
    desktop: z.array(z.string().trim().min(1).max(200)).max(60).optional(),
  });
  const settingsChanged = () => {
    const view = settings.settingsView();
    events.emit({ type: "settings.updated", models: settings.modelOptions(), defaultModel: view.defaultModel, configured: view.configured });
    return view;
  };
  api.get("/settings", (c) => c.json(settings.settingsView()));
  api.post("/settings/providers", async (c) => {
    settings.saveProvider(null, providerInput.parse(await c.req.json()));
    return c.json(settingsChanged(), 201);
  });
  api.put("/settings/providers/:id", async (c) => {
    try { settings.saveProvider(c.req.param("id"), providerInput.parse(await c.req.json())); }
    catch (failure) { if (failure instanceof z.ZodError) throw failure; return c.json({ error: (failure as Error).message }, 404); }
    return c.json(settingsChanged());
  });
  api.delete("/settings/providers/:id", (c) => {
    settings.deleteProvider(c.req.param("id"));
    return c.json(settingsChanged());
  });
  api.put("/settings/default-model", async (c) => {
    const { model } = z.object({ model: z.string().max(300) }).parse(await c.req.json());
    try { settings.setDefaultModel(model); } catch (failure) { return c.json({ error: (failure as Error).message }, 400); }
    return c.json(settingsChanged());
  });
  /** Tests which of a provider's models can drive a desktop, and records the verdicts. */
  api.post("/settings/providers/:id/desktop-check", async (c) => {
    const id = c.req.param("id");
    const provider = settings.providerById(id);
    if (!provider) return c.json({ error: "That provider no longer exists." }, 404);
    const { models } = z.object({ models: z.array(z.string().max(200)).max(60).optional() }).parse(await c.req.json().catch(() => ({})));
    const queue = (models ?? provider.models).filter((model) => provider.models.includes(model));
    const results: DesktopVerdict[] = [];
    for (let start = 0; start < queue.length; start += 4) {
      results.push(...await Promise.all(queue.slice(start, start + 4).map((model) =>
        checkDesktop(settings.resolveModel(settings.modelRef(id, model), { fallback: false })!, modelFactory))));
    }
    settings.setDesktopModels(id, Object.fromEntries(results.filter((result) => !result.error).map((result) => [result.model, result.canDrive])));
    return c.json({ results, settings: settingsChanged() });
  });

  api.post("/settings/providers/check", async (c) => {
    const { providerId, baseURL, protocol, apiKey } = z.object({
      providerId: z.string().max(40).optional(),
      baseURL: providerURL,
      protocol: z.enum(["openai", "anthropic"]).default("openai"),
      apiKey: z.string().max(500).optional(),
    }).parse(await c.req.json());
    try {
      return c.json({ models: await settings.listProviderModels(baseURL, settings.keyFor(providerId, baseURL, apiKey), protocol) });
    } catch (failure) {
      return c.json({ error: failure instanceof Error ? failure.message : "Couldn't connect." }, 400);
    }
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
