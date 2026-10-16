import { authorOf, canSee, eventFor, HOST_ID, identify, isHost, readAbout, readHousehold, refusal, writeAbout, writeHousehold } from "./people.js";
import type { NodeHub } from "./nodes.js";
import { speak, type Calls } from "./voice.js";
import { sendUserMessage } from "./send.js";
import fs from "node:fs";
import { chatFilePath, isImage, isPdf, MAX_FILE_BYTES, removeChatFile, safeName, shareWithComputers, writeChatFile } from "./chatFiles.js";
import { isPublicWebUrl } from "./shared/urlPolicy.js";
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
import { BusyError, type Updater } from "./updates.js";
import type { AppState, Chat, Person, TopicIcon } from "./shared/types.js";
import { TOPIC_ICONS } from "./shared/types.js";
import type { Integrations } from "./integrations/index.js";
import { revoke, type SignIns } from "./integrations/oauth.js";
import { connectOnePassword, type VaultConnector } from "./integrations/onepassword.js";

export type Services = {
  store: Store; events: EventLog; gate: ApprovalGate; runner: AgentRunner;
  computer?: ComputerService; browser?: BrowserService; desktop?: DesktopService; routines?: RoutineScheduler; push?: PushService;
  updater?: Updater;
  /** The model client used by the desktop check (tests pass a scripted one). */
  modelFactory?: ModelFactory;
  /** Connected accounts (mail, calendar, 1Password) and signing in to them. */
  integrations?: Integrations;
  signIns?: SignIns;
  /** Signs in to 1Password (tests pass a fake). */
  connectVault?: VaultConnector;
  /** Voice calls and Bots ringing you. */
  calls?: Calls;
  /** PCs lent through the desktop app. */
  nodes?: NodeHub;
};

const schedule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily"), time: z.string().refine((time) => parseTime(time) !== null, "Pick a time."), days: z.array(z.number().int().min(0).max(6)).max(7) }),
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(7 * 1440) }),
  z.object({ type: z.literal("once"), at: z.number().int().refine((at) => at > Date.now(), "That time has already passed.") }),
  z.object({ type: z.literal("mail"), accountId: z.string().min(1).max(80), from: z.string().trim().max(200).optional(), subject: z.string().trim().max(200).optional() }),
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
function desktopProblem(computer: boolean, desktop: boolean, model: string | undefined, ownerId: string) {
  if (!desktop) return null;
  if (!computer) return "The desktop needs the Bot's own computer.";
  if (!settings.canDriveDesktop(settings.resolveModel(model, { ownerId }))) {
    return "That model can't drive a desktop. Pick one marked for desktop use, or run the desktop check in Settings.";
  }
  return null;
}
// No defaults here: a patch must only change the fields it names.
const botPatch = z.object(botFields).partial();

const INTRO_PROMPT = "(System: you were just created. Greet the user in one or two short sentences, in your own voice: who you are and what you can take off their plate. Don't use tools.)";

/** Images a Doc shows, fetched once and kept in memory (up to 200, each under 4 MB). */
const imageCache = new Map<string, { type: string; bytes: ArrayBuffer }>();
async function fetchImage(url: string) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "colony/0.2" } });
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !/^image\/(png|jpe?g|gif|webp|avif|svg\+xml)/.test(type)) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 4 * 1024 * 1024) return null;
  if (imageCache.size >= 200) imageCache.delete(imageCache.keys().next().value!);
  return { type: type.startsWith("image/svg") ? "image/svg+xml" : type, bytes };
}

export function createApi({ store, events, gate, runner, computer, browser, desktop, routines, push, updater, modelFactory = defaultModelFactory, integrations, signIns, connectVault = connectOnePassword, calls, nodes }: Services) {
  const api = new Hono<{ Variables: { person: Person } }>();

  // Who's asking (from their Tailscale login), and whether it's theirs to touch: their own Bots,
  // topics they can see, and (for the host) what the whole Colony shares.
  api.use("*", async (c, next) => {
    const person = identify(store, c.req.header("Tailscale-User-Login")?.toLowerCase());
    c.set("person", person);
    const why = refusal(store, person, c.req.method, c.req.path.replace(/^\/api(?=\/)/, ""));
    return why ? c.json({ error: why }, 403) : next();
  });

  /** A mail-triggered routine must watch a mailbox its Bot can read. */
  const mailProblem = (botId: string, when: z.infer<typeof schedule>) => {
    if (when.type !== "mail") return null;
    const account = integrations?.accounts.get(when.accountId);
    if (!account || account.kind === "onepassword") return "That mailbox isn't connected.";
    if (integrations!.accounts.access(botId, account.id).mail === "none") return "This Bot can't read that mailbox. Give it mail access in its profile first.";
    return null;
  };

  api.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map((issue) => issue.message).join("; ") }, 400);
    console.warn("[colony] request failed:", error.message);
    return c.json({ error: error.message || "Something went wrong." }, 500);
  });

  /** Who you are to this Colony, and who runs it. */
  api.get("/me", (c) => c.json({ me: c.get("person"), host: store.getPerson(HOST_ID)!.name }));

  /** Everything this person can see: their own Bots, the topics they're in, and what they own. */
  api.get("/state", (c) => {
    const person = c.get("person");
    const chats = store.listChats().filter((chat) => canSee(person, chat));
    const visibleChats = new Set(chats.map((chat) => chat.id));
    const bots = store.listBots().filter((bot) => bot.ownerId === person.id || chats.some((chat) => chat.memberIds.includes(bot.id)));
    const mine = new Set(bots.filter((bot) => bot.ownerId === person.id).map((bot) => bot.id));
    return c.json<AppState>({
      bots, chats,
      folders: store.listFolders().filter((folder) => folder.ownerId === person.id),
      // Recent approvals of every status in chats you can see, so old cards can show "Approved"/"Denied".
      approvals: store.listApprovals().filter((approval) => visibleChats.has(approval.chatId)),
      routines: store.listRoutines().filter((routine) => mine.has(routine.botId) || visibleChats.has(routine.chatId)),
      models: settings.modelOptions(person.id),
      defaultModel: settings.defaultModel(person.id),
      configured: settings.modelConfigured(person.id),
      accounts: integrations?.accounts.list().filter((account) => account.personId === person.id) ?? [],
      access: integrations?.accounts.listAccess().filter((grant) => mine.has(grant.botId)) ?? [],
      nodes: nodes?.list() ?? [],
      people: store.listPeople(),
      me: person,
      seq: events.latestSeq(),
    });
  });

  /** Who's in the family, how many Bots each has (counts only: the Bots stay private) and which PCs they've lent. */
  api.get("/family", (c) => {
    const bots = store.listBots();
    const pcs = nodes?.list() ?? [];
    return c.json(store.listPeople().map((person) => ({
      person, bots: bots.filter((bot) => bot.ownerId === person.id).length,
      pcs: pcs.filter((node) => node.personId === person.id).map(({ name, capabilities, online }) => ({ name, capabilities, online })),
    })));
  });

  // ---------- You (name, color, what Bots know about you) ----------
  const personPatch = z.object({
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).partial();
  api.patch("/people/:id", async (c) => {
    const person = store.updatePerson(c.req.param("id"), personPatch.parse(await c.req.json()));
    return person ? c.json(person) : c.json({ error: "Not found." }, 404);
  });
  /** What Bots know about a person (their USER.md), and about the household (HOUSEHOLD.md). */
  api.get("/people/:id/about", (c) => store.getPerson(c.req.param("id")) ? c.json({ text: readAbout(c.req.param("id")) }) : c.json({ error: "Not found." }, 404));
  api.put("/people/:id/about", async (c) => {
    if (!store.getPerson(c.req.param("id"))) return c.json({ error: "Not found." }, 404);
    writeAbout(c.req.param("id"), z.object({ text: z.string().max(8000) }).parse(await c.req.json()).text);
    return c.body(null, 204);
  });
  api.get("/household", (c) => c.json({ text: readHousehold() }));
  api.put("/household", async (c) => {
    writeHousehold(z.object({ text: z.string().max(8000) }).parse(await c.req.json()).text);
    return c.body(null, 204);
  });

  // ---------- Version and updates ----------
  api.get("/system", (c) => updater ? c.json(updater.info()) : c.json({ error: "Updates aren't available here." }, 404));

  api.post("/system/check", async (c) => {
    if (!updater) return c.json({ error: "Updates aren't available here." }, 404);
    try { await updater.check(); } catch (error) { return c.json({ error: `Couldn't check for updates: ${error instanceof Error ? error.message : error}` }, 502); }
    return c.json(updater.info());
  });

  api.post("/system/update", async (c) => {
    if (!updater) return c.json({ error: "Updates aren't available here." }, 404);
    const { force } = z.object({ force: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    try { await updater.install({ force }); } catch (error) {
      if (error instanceof BusyError) return c.json({ error: error.message, busy: error.names }, 409);
      return c.json({ error: error instanceof Error ? error.message : "Couldn't update." }, 400);
    }
    return c.json(updater.info(), 202);
  });

  // Bot ids become folder names, so every per-Bot route must name a Bot that exists.
  api.use("/bots/:id/*", async (c, next) => {
    if (!store.getBot(c.req.param("id"))) return c.json({ error: "Bot not found." }, 404);
    await next();
  });

  // ---------- Bots ----------
  api.post("/bots", async (c) => {
    const input = botInput.parse(await c.req.json());
    const problem = desktopProblem(input.computer, input.desktop, input.model, c.get("person").id);
    if (problem) return c.json({ error: problem }, 400);
    const ownerId = c.get("person").id;
    const bot = store.createBot({ ...input, model: settings.resolveModel(input.model, { ownerId })?.ref ?? "", ownerId });
    files.initBotFolder(bot);
    try { runner.start(bot.chatId, bot.id, { hiddenPrompt: INTRO_PROMPT }); } catch { /* no model yet: the Bot still exists */ }
    return c.json(bot, 201);
  });

  api.patch("/bots/:id", async (c) => {
    const patch = botPatch.parse(await c.req.json());
    const current = store.getBot(c.req.param("id"))!;
    // A Bot runs on shared models or its owner's own; nobody else's key.
    const ownerId = current.ownerId;
    if (patch.model && !settings.resolveModel(patch.model, { fallback: false, ownerId })) return c.json({ error: "That model isn't in Settings." }, 400);
    const computerOn = patch.computer ?? current.computer;
    const problem = desktopProblem(computerOn, computerOn && (patch.desktop ?? current.desktop), patch.model ?? current.model, ownerId);
    if (problem) return c.json({ error: problem }, 400);
    const bot = store.updateBot(c.req.param("id"), { ...patch, ...(patch.model ? { model: settings.resolveModel(patch.model, { ownerId })!.ref } : {}) });
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

  // ---------- Chats, topics and folders ----------
  const topicFields = {
    title: z.string().trim().min(1).max(60),
    icon: z.enum(TOPIC_ICONS),
    brief: z.string().trim().max(2000),
    folderId: z.string().max(80).nullable(),
    memberIds: z.array(z.string()).min(1).max(6),
    coordinatorId: z.string().optional(),
  };
  /** Checks a topic's Bots and folder for this person; returns an error message, or null when they're fine. */
  const topicProblem = (person: Person, input: { memberIds?: string[]; folderId?: string | null }, before: string[] = [], ownsTopic = true) => {
    if (input.memberIds?.some((id) => !store.getBot(id))) return "Unknown Bot in this topic.";
    // You bring in only your own Bots. You take out your own, or anyone's from a topic you started.
    const added = (input.memberIds ?? []).filter((id) => !before.includes(id));
    const removed = input.memberIds ? before.filter((id) => !input.memberIds!.includes(id)) : [];
    if (added.some((id) => store.getBot(id)?.ownerId !== person.id)) return "You can only add your own Bots.";
    if (!ownsTopic && removed.some((id) => store.getBot(id)?.ownerId !== person.id)) return "You can only take out your own Bots.";
    if (input.folderId && store.getFolder(input.folderId)?.ownerId !== person.id) return "That folder doesn't exist.";
    return null;
  };
  const createTopic = (person: Person, input: { title: string; icon?: TopicIcon; brief?: string; folderId?: string | null; memberIds: string[]; coordinatorId?: string }) => {
    const coordinatorId = input.coordinatorId && input.memberIds.includes(input.coordinatorId) ? input.coordinatorId : input.memberIds[0];
    return store.createChat({ kind: "topic", title: input.title, icon: input.icon ?? "chat", brief: input.brief ?? "", folderId: input.folderId ?? null, memberIds: input.memberIds, coordinatorId, ownerId: person.id });
  };

  api.post("/topics", async (c) => {
    const input = z.object({ ...topicFields, icon: topicFields.icon.default("chat"), brief: topicFields.brief.default(""), folderId: topicFields.folderId.default(null) }).parse(await c.req.json());
    const problem = topicProblem(c.get("person"), input);
    if (problem) return c.json({ error: problem }, 400);
    return c.json(createTopic(c.get("person"), input), 201);
  });

  api.patch("/chats/:id", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "Chat not found." }, 404);
    if (chat.kind !== "topic") return c.json({ error: "Only topics can be renamed, filed or archived." }, 400);
    const patch = z.object({ ...topicFields, archived: z.boolean(), coordinatorId: z.string().nullable(), peopleIds: z.array(z.string()).max(20), everyone: z.boolean() }).partial().parse(await c.req.json());
    // Anyone in a topic can bring their own Bots in or take them out; the rest is its owner's.
    if (chat.ownerId !== c.get("person").id && Object.keys(patch).some((key) => key !== "memberIds")) return c.json({ error: "Only the person who started this topic can change that." }, 403);
    const problem = topicProblem(c.get("person"), patch, chat.memberIds, chat.ownerId === c.get("person").id);
    if (problem) return c.json({ error: problem }, 400);
    if (patch.memberIds && !patch.memberIds.length) return c.json({ error: "A topic needs at least one Bot." }, 400);
    const members = patch.memberIds ?? chat.memberIds;
    const coordinatorId = patch.coordinatorId !== undefined || patch.memberIds
      ? (patch.coordinatorId && members.includes(patch.coordinatorId) ? patch.coordinatorId : members.includes(chat.coordinatorId ?? "") ? chat.coordinatorId : members[0])
      : undefined;
    return c.json(store.updateTopic(chat.id, { ...patch, coordinatorId }));
  });

  api.post("/folders", async (c) => {
    const { title } = z.object({ title: z.string().trim().min(1).max(40) }).parse(await c.req.json());
    return c.json(store.createFolder(title, c.get("person").id), 201);
  });
  api.patch("/folders/:id", async (c) => {
    const patch = z.object({ title: z.string().trim().min(1).max(40), position: z.number().int().min(0).max(10_000) }).partial().parse(await c.req.json());
    const folder = store.updateFolder(c.req.param("id"), patch);
    return folder ? c.json(folder) : c.json({ error: "Folder not found." }, 404);
  });
  api.delete("/folders/:id", (c) => {
    store.deleteFolder(c.req.param("id"));
    return c.body(null, 204);
  });

  /** A topic a Bot suggested: Create makes it, Not now just closes the card. */
  api.post("/messages/:id/topics/:proposalId", async (c) => {
    const { accept } = z.object({ accept: z.boolean() }).parse(await c.req.json());
    const message = store.getMessage(c.req.param("id"));
    const card = message?.cards.find((item) => item.type === "topic" && item.proposalId === c.req.param("proposalId"));
    if (!message || card?.type !== "topic") return c.json({ error: "That suggestion is gone." }, 404);
    if (card.chatId || card.dismissed) return c.json({ error: "That suggestion was already answered." }, 409);
    let chat: Chat | null = null;
    if (accept) {
      const proposal = { ...card.proposal, memberIds: card.proposal.memberIds.filter((id) => store.getBot(id)) };
      if (!proposal.memberIds.length) return c.json({ error: "The Bots in that suggestion are gone." }, 400);
      if (proposal.folderId && store.getFolder(proposal.folderId)?.ownerId !== c.get("person").id) proposal.folderId = null;
      proposal.memberIds = proposal.memberIds.filter((id) => store.getBot(id)?.ownerId === c.get("person").id);
      chat = createTopic(c.get("person"), proposal);
    }
    store.updateMessage(message.id, { cards: message.cards.map((item) => item === card ? { ...card, chatId: chat?.id ?? null, dismissed: !accept } : item) });
    return chat ? c.json(chat, 201) : c.body(null, 204);
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
    const { text, mode, attachments: attachmentIds } = z.object({
      text: z.string().trim().max(32_000),
      // A Bot that's already working gets the message at its next step (steer) or after it finishes (queue).
      mode: z.enum(["steer", "queue"]).default("steer"),
      /** Files already uploaded to this chat (POST /chats/:id/files) to send with the message. */
      attachments: z.array(z.string()).max(10).default([]),
    }).parse(await c.req.json());
    const attached = attachmentIds.map((id) => store.getFile(id)).filter((file) => file?.chatId === chat.id);
    if (attached.length !== attachmentIds.length) return c.json({ error: "One of those files isn't in this chat any more." }, 400);
    if (!text && !attached.length) return c.json({ error: "Write something, or attach a file." }, 400);
    const attachments = attached.map((file) => ({ id: file!.id, name: file!.name, mime: file!.mime, size: file!.size }));
    return c.json(sendUserMessage(store, runner, chat, { text, mode, attachments, author: authorOf(c.get("person")) }), 201);
  });

  // ---------- A topic's Doc ----------
  api.get("/chats/:id/artifact", (c) => {
    const artifact = store.getArtifact(c.req.param("id"));
    // History without the bodies: each version's body loads when you open it.
    const versions = artifact ? store.listArtifactVersions(artifact.id).map(({ body: _, ...version }) => version) : [];
    return c.json({ artifact, versions });
  });
  api.get("/chats/:id/artifact/versions/:version", (c) => {
    const artifact = store.getArtifact(c.req.param("id"));
    const version = artifact && store.listArtifactVersions(artifact.id).find((item) => item.version === Number(c.req.param("version")));
    return version ? c.json(version) : c.json({ error: "No such version." }, 404);
  });
  /** Restoring writes the old version again as a new one, so nothing is ever lost. */
  api.post("/chats/:id/artifact/restore", async (c) => {
    const { version } = z.object({ version: z.number().int().min(1) }).parse(await c.req.json());
    const artifact = store.getArtifact(c.req.param("id"));
    const old = artifact && store.listArtifactVersions(artifact.id).find((item) => item.version === version);
    if (!old) return c.json({ error: "No such version." }, 404);
    return c.json(store.saveArtifact(artifact.chatId, { title: old.title, status: old.status, body: old.body, note: `Restored v${version}`, by: "user" }));
  });

  // ---------- Files in a chat ----------
  api.get("/chats/:id/files", (c) => c.json(store.listFiles(c.req.param("id"))));
  api.post("/chats/:id/files", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat || chat.kind === "thread") return c.json({ error: "Files go in a Bot's chat or a topic." }, 404);
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!(upload instanceof File)) return c.json({ error: "No file in that upload." }, 400);
    if (upload.size > MAX_FILE_BYTES) return c.json({ error: "That file is over 25 MB." }, 413);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const file = store.addFile({ chatId: chat.id, name: safeName(upload.name), mime: upload.type || "application/octet-stream", size: bytes.byteLength, addedBy: authorOf(c.get("person")) });
    writeChatFile(file, bytes);
    shareWithComputers(file, chat, chat.memberIds.filter((id) => store.getBot(id)?.computer));
    return c.json(file, 201);
  });
  /** Downloads a file. Only photos and PDFs open in the browser; anything else downloads, so a page can't run as Colony. */
  api.get("/files/:id", (c) => {
    const file = store.getFile(c.req.param("id"));
    if (!file || !fs.existsSync(chatFilePath(file))) return c.json({ error: "File not found." }, 404);
    const inline = isImage(file) || isPdf(file);
    c.header("Content-Type", inline ? file.mime : "application/octet-stream");
    c.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, max-age=86400");
    return c.body(fs.readFileSync(chatFilePath(file)));
  });
  api.delete("/files/:id", (c) => {
    const file = store.deleteFile(c.req.param("id"));
    if (file) removeChatFile(file);
    return c.body(null, 204);
  });

  /**
   * Images in a Doc come from the web. The phone loads them through here, so third-party sites
   * see Colony's request instead of your device, and each image is fetched once.
   */
  api.get("/img", async (c) => {
    const url = c.req.query("u") ?? "";
    if (!isPublicWebUrl(url)) return c.json({ error: "Only public web images." }, 400);
    const cached = imageCache.get(url);
    const hit = cached ?? await fetchImage(url).catch(() => null);
    if (!hit) return c.json({ error: "Couldn't load that image." }, 502);
    if (!cached) imageCache.set(url, hit);
    c.header("Content-Type", hit.type);
    c.header("Cache-Control", "private, max-age=604800");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(hit.bytes);
  });

  /** A queued message, sent to the running turn now instead of after it. */
  api.post("/messages/:id/steer", (c) => {
    if (!runner.steerNow(c.req.param("id"))) return c.json({ error: "That message isn't waiting any more." }, 409);
    return c.body(null, 204);
  });

  /** Takes back a queued message before the Bot sees it. */
  api.delete("/messages/:id", (c) => {
    const message = store.getMessage(c.req.param("id"));
    if (!message) return c.json({ error: "Message not found." }, 404);
    if (message.delivery !== "queued" || !runner.unqueue(message.id)) {
      return c.json({ error: "Only a message that's still waiting can be taken back." }, 409);
    }
    store.deleteMessage(message.id);
    return c.body(null, 204);
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
  /** Tells everyone's apps the models changed (each sees their own list), and returns this person's view. */
  const settingsChanged = (personId: string) => {
    events.emit({ type: "settings.updated", models: settings.modelOptions(), defaultModel: settings.defaultModel(), configured: settings.modelConfigured() });
    return settings.settingsView(personId);
  };
  api.get("/settings", (c) => c.json(settings.settingsView(c.get("person").id)));
  /** A provider this person may change: their own, or (the host) a shared one. */
  const editable = (personId: string, providerId: string) => {
    const provider = settings.providerById(providerId);
    return provider && settings.canEditProvider(provider, personId) ? provider : null;
  };

  // ---------- Voice ----------
  const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 22:00.");
  const voicePatch = z.object({
    providerId: z.string().max(80).nullable(),
    transcribeModel: z.string().trim().min(1).max(120),
    speechModel: z.string().trim().min(1).max(120),
    voice: z.string().trim().min(1).max(60),
    botVoices: z.record(z.string(), z.string().trim().max(60)),
    allowCalls: z.boolean(),
    quietFrom: hhmm,
    quietTo: hhmm,
  }).partial();
  api.put("/settings/voice", async (c) => {
    const patch = voicePatch.safeParse(await c.req.json());
    if (!patch.success) return c.json({ error: patch.error.issues[0]?.message ?? "Check the voice settings." }, 400);
    if (patch.data.providerId && settings.providerById(patch.data.providerId)?.protocol !== "openai") {
      return c.json({ error: "Voice needs an OpenAI-compatible provider." }, 400);
    }
    settings.setVoiceSettings(patch.data);
    return c.json(settings.settingsView(c.get("person").id));
  });
  /** Says a line in a voice, to try it out in Settings. */
  api.post("/settings/voice/try", async (c) => {
    const { voice } = z.object({ voice: z.string().trim().min(1).max(60) }).parse(await c.req.json());
    try {
      const audio = await speak("Hi! This is how I'll sound when we talk.", voice);
      return c.body(audio, 200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Couldn't speak." }, 400);
    }
  });
  // ---------- This PC ----------
  /** Forgets one of your PCs (it comes back if its app connects again). */
  api.delete("/nodes/:id", (c) => {
    store.deleteNode(c.req.param("id"));
    nodes?.changed();
    return c.json({ ok: true });
  });

  api.post("/calls/:id/decline", (c) => {
    calls?.miss(c.req.param("id"), c.get("person").id);
    return c.json({ ok: true });
  });
  /** Adds a provider: your own, or (the host, with shared: true) one everyone's Bots can use. */
  api.post("/settings/providers", async (c) => {
    const person = c.get("person");
    // The host's providers are shared unless they say otherwise; everyone else's are their own.
    const { shared: asked, ...input } = providerInput.extend({ shared: z.boolean().optional() }).parse(await c.req.json());
    const shared = asked ?? isHost(person);
    if (shared && !isHost(person)) return c.json({ error: "Only the person who runs this Colony can add shared models." }, 403);
    settings.saveProvider(null, input, shared ? null : person.id);
    return c.json(settingsChanged(person.id), 201);
  });
  api.put("/settings/providers/:id", async (c) => {
    if (settings.providerById(c.req.param("id")) && !editable(c.get("person").id, c.req.param("id"))) return c.json({ error: "That isn't yours to change." }, 403);
    try { settings.saveProvider(c.req.param("id"), providerInput.parse(await c.req.json())); }
    catch (failure) { if (failure instanceof z.ZodError) throw failure; return c.json({ error: (failure as Error).message }, 404); }
    return c.json(settingsChanged(c.get("person").id));
  });
  api.delete("/settings/providers/:id", (c) => {
    if (!editable(c.get("person").id, c.req.param("id"))) return c.json({ error: "That isn't yours to change." }, 403);
    settings.deleteProvider(c.req.param("id"));
    return c.json(settingsChanged(c.get("person").id));
  });
  /** Your default for new Bots (the host's is the shared default everyone falls back to). */
  api.put("/settings/default-model", async (c) => {
    const { model } = z.object({ model: z.string().max(300) }).parse(await c.req.json());
    try { settings.setDefaultModel(model, c.get("person").id); } catch (failure) { return c.json({ error: (failure as Error).message }, 400); }
    return c.json(settingsChanged(c.get("person").id));
  });
  /** Tests which of a provider's models can drive a desktop, and records the verdicts. */
  api.post("/settings/providers/:id/desktop-check", async (c) => {
    const id = c.req.param("id");
    const provider = editable(c.get("person").id, id);
    if (!provider) return c.json({ error: "That provider no longer exists." }, 404);
    const { models } = z.object({ models: z.array(z.string().max(200)).max(60).optional() }).parse(await c.req.json().catch(() => ({})));
    const queue = (models ?? provider.models).filter((model) => provider.models.includes(model));
    const results: DesktopVerdict[] = [];
    for (let start = 0; start < queue.length; start += 4) {
      results.push(...await Promise.all(queue.slice(start, start + 4).map((model) =>
        checkDesktop(settings.resolveModel(settings.modelRef(id, model), { fallback: false, ownerId: provider.ownerId ?? HOST_ID })!, modelFactory))));
    }
    settings.setDesktopModels(id, Object.fromEntries(results.filter((result) => !result.error).map((result) => [result.model, result.canDrive])));
    return c.json({ results, settings: settingsChanged(c.get("person").id) });
  });

  api.post("/settings/providers/check", async (c) => {
    const { providerId, baseURL, protocol, apiKey } = z.object({
      providerId: z.string().max(40).optional(),
      baseURL: providerURL,
      protocol: z.enum(["openai", "anthropic"]).default("openai"),
      apiKey: z.string().max(500).optional(),
    }).parse(await c.req.json());
    // A saved key is only reused for a provider you may change.
    const savedFor = providerId && editable(c.get("person").id, providerId) ? providerId : undefined;
    try {
      return c.json({ models: await settings.listProviderModels(baseURL, settings.keyFor(savedFor, baseURL, apiKey), protocol) });
    } catch (failure) {
      return c.json({ error: failure instanceof Error ? failure.message : "Couldn't connect." }, 400);
    }
  });

  // ---------- Accounts: mail, calendars, 1Password ----------
  const unavailable = { error: "Accounts aren't available here." };
  const failure = (error: unknown, fallback: string) => ({ error: error instanceof Error ? error.message : fallback });
  api.get("/accounts", (c) => {
    if (!integrations) return c.json(unavailable, 503);
    const apps = integrations.accounts.apps();
    const person = c.get("person");
    return c.json({
      // Your accounts, and what your Bots may do with them.
      accounts: integrations.accounts.list().filter((account) => account.personId === person.id),
      access: integrations.accounts.listAccess().filter((grant) => store.getBot(grant.botId)?.ownerId === person.id),
      // Client ids aren't secret; the Google client secret stays here.
      apps: { google: apps.google ? { clientId: apps.google.clientId } : null, microsoft: apps.microsoft ? { clientId: apps.microsoft.clientId } : null },
    });
  });
  const clientId = z.string().trim().min(10, "Paste the client ID.").max(300);
  api.post("/accounts/google/start", async (c) => {
    if (!integrations || !signIns) return c.json(unavailable, 503);
    const input = z.object({ clientId: clientId.optional(), clientSecret: z.string().trim().max(300).optional() }).parse(await c.req.json().catch(() => ({})));
    const saved = integrations.accounts.apps().google;
    const app = input.clientId
      ? { clientId: input.clientId, clientSecret: input.clientSecret || (saved?.clientId === input.clientId ? saved.clientSecret : "") }
      : saved;
    if (!app?.clientId || !app.clientSecret) return c.json({ error: "Paste your Google client ID and client secret." }, 400);
    // The app registration is shared; only the host replaces one that's already saved.
    if (!saved || isHost(c.get("person"))) integrations.accounts.saveApp("google", app);
    try { return c.json(await signIns.startGoogle(app, c.get("person").id)); } catch (error) { return c.json(failure(error, "Couldn't start the sign-in."), 500); }
  });
  api.post("/accounts/google/finish", async (c) => {
    if (!signIns) return c.json(unavailable, 503);
    const { id, url } = z.object({ id: z.string().max(80), url: z.string().trim().min(1).max(4000) }).parse(await c.req.json());
    try { return c.json(await signIns.finishGoogle(id, url, c.get("person").id)); } catch (error) { return c.json(failure(error, "Couldn't finish the sign-in."), 400); }
  });
  api.post("/accounts/microsoft/start", async (c) => {
    if (!integrations || !signIns) return c.json(unavailable, 503);
    const input = z.object({ clientId: clientId.optional() }).parse(await c.req.json().catch(() => ({})));
    const saved = integrations.accounts.apps().microsoft;
    const app = input.clientId ? { clientId: input.clientId } : saved;
    if (!app?.clientId) return c.json({ error: "Paste your Microsoft application (client) ID." }, 400);
    if (!saved || isHost(c.get("person"))) integrations.accounts.saveApp("microsoft", app);
    try { return c.json(await signIns.startMicrosoft(app, c.get("person").id)); } catch (error) { return c.json(failure(error, "Couldn't start the sign-in."), 502); }
  });
  api.get("/accounts/signin/:id", (c) => {
    const status = signIns?.status(c.req.param("id"), c.get("person").id);
    return status ? c.json(status) : c.json({ error: "That sign-in has ended." }, 404);
  });
  api.post("/accounts/signin/:id/cancel", (c) => {
    if (signIns?.status(c.req.param("id"), c.get("person").id)) signIns.cancel(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/accounts/onepassword", async (c) => {
    if (!integrations) return c.json(unavailable, 503);
    const input = z.union([
      z.object({ token: z.string().trim().startsWith("ops_", "Service account tokens start with ops_.").max(4000) }),
      z.object({ desktopAccount: z.string().trim().min(1, "Type your 1Password account name.").max(200) }),
    ]).parse(await c.req.json());
    // Sign in once now, so a wrong token or a locked app says so here rather than mid-task.
    let vaults: { id: string; title: string }[];
    try { vaults = await (await connectVault(input)).vaults(); }
    catch (error) { return c.json({ error: `1Password didn't accept that: ${error instanceof Error ? error.message : error}` }, 400); }
    if (!vaults.length) return c.json({ error: "1Password connected, but it reaches no vaults. Give the service account access to the vault your Bots should use." }, 400);
    const email = "token" in input ? vaults.map((vault) => vault.title).join(", ") : input.desktopAccount;
    const account = integrations.accounts.connect({ kind: "onepassword", label: "1Password", email, personId: c.get("person").id },
      { kind: "onepassword", ...input, saveVaultId: vaults[0].id });
    integrations.vaults.forget(account.id);
    return c.json(account, 201);
  });
  api.delete("/accounts/:id", async (c) => {
    if (!integrations) return c.json(unavailable, 503);
    const id = c.req.param("id");
    if (integrations.accounts.get(id)?.personId !== c.get("person").id) return c.json({ error: "That isn't yours." }, 403);
    await revoke(fetch, integrations.accounts.secret(id));
    // Routines watching this mailbox have nothing left to watch.
    for (const routine of store.listRoutines()) if (routine.schedule.type === "mail" && routine.schedule.accountId === id) store.deleteRoutine(routine.id);
    integrations.accounts.remove(id);
    integrations.tokens.forget(id);
    integrations.vaults.forget(id);
    return c.body(null, 204);
  });
  api.put("/bots/:id/access/:accountId", async (c) => {
    if (!integrations) return c.json(unavailable, 503);
    const patch = z.object({
      mail: z.enum(["none", "read", "draft", "send"]).optional(),
      calendar: z.enum(["none", "read", "write"]).optional(),
      vault: z.enum(["none", "use", "save"]).optional(),
    }).parse(await c.req.json());
    // Your Bots (checked by the route rules) and your accounts only.
    if (integrations.accounts.get(c.req.param("accountId"))?.personId !== c.get("person").id) return c.json({ error: "That account isn't yours." }, 403);
    try { return c.json(integrations.accounts.setAccess(c.req.param("id"), c.req.param("accountId"), patch)); }
    catch (error) { return c.json(failure(error, "Couldn't change access."), 404); }
  });

  // ---------- Routines ----------
  api.post("/bots/:id/routines", async (c) => {
    const bot = store.getBot(c.req.param("id"));
    if (!bot) return c.json({ error: "Bot not found." }, 404);
    const body = await c.req.json();
    const input = routineInput.parse(body);
    // A routine posts to the Bot's own chat, or to a topic it's in (the topic's Schedule tab).
    const { chatId = bot.chatId } = z.object({ chatId: z.string().optional() }).parse(body);
    if (chatId !== bot.chatId && !store.getChat(chatId)?.memberIds.includes(bot.id)) return c.json({ error: "That Bot isn't in that topic." }, 400);
    const problem = mailProblem(bot.id, input.schedule);
    if (problem) return c.json({ error: problem }, 400);
    const routine = store.createRoutine({ botId: bot.id, chatId, title: input.title, prompt: input.prompt, schedule: input.schedule });
    return c.json(input.enabled === false ? store.updateRoutine(routine.id, { enabled: false }) : routine, 201);
  });

  api.patch("/routines/:id", async (c) => {
    const patch = routineInput.partial().parse(await c.req.json());
    const current = store.getRoutine(c.req.param("id"));
    const problem = current && patch.schedule ? mailProblem(current.botId, patch.schedule) : null;
    if (problem) return c.json({ error: problem }, 400);
    const routine = store.updateRoutine(c.req.param("id"), patch);
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
    push?.subscribe(pushSubscription.parse(await c.req.json()), c.get("person").id);
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
    const delivered = await push?.notify({ title: "Colony", body: "Notifications are on. Your Bots will ping you here.", chatId: null, tag: "test" }, { force: true, personId: c.get("person").id }) ?? 0;
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
    // Members only hear about the topics shared with them.
    const person = c.get("person");
    const unsubscribe = events.subscribe((item) => {
      const event = eventFor(person, item.event, store);
      if (event) { queue.push({ ...item, event }); wake?.(); }
    });
    stream.onAbort(() => { unsubscribe(); detach(); wake?.(); });

    const backlog = events.since(since);
    if (backlog === null) await stream.writeSSE({ event: "reset", data: "{}" });
    else for (const item of backlog) {
      const event = eventFor(person, item.event, store);
      if (event) await stream.writeSSE({ id: String(item.seq), event: "event", data: JSON.stringify(event) });
    }
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
