import type { NodeHub } from "./nodes.js";
import { speak, type Calls } from "./voice.js";
import { sendUserMessage } from "./send.js";
import fs from "node:fs";
import { chatFilePath, isImage, isPdf, MAX_FILE_BYTES, removeChatFile, safeName, shareWithComputers, writeChatFile } from "./chatFiles.js";
import { isPublicWebUrl } from "./shared/urlPolicy.js";
import { Hono, type Handler, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import * as settings from "./settings.js";
import { visibleTo, type EventLog, type Item } from "./events.js";
import * as files from "./files.js";
import type { ApprovalGate } from "./agent/approvals.js";
import { checkDesktop, type DesktopVerdict } from "./agent/desktopCheck.js";
import type { ModelSource } from "./agent/pi/models.js";
import type { ModelSignIns } from "./agent/pi/signins.js";
import type { Runner } from "./agent/runner.js";
import type { BrowserService } from "./computer/browser.js";
import type { DesktopService } from "./computer/desktop.js";
import { ComputerLimitError, type ComputerService } from "./computer/docker.js";
import type { PushService } from "./push.js";
import type { RoutineScheduler } from "./routines.js";
import { MIN_INTERVAL_MINUTES, parseTime } from "./shared/schedule.js";
import * as ws from "./computer/workspace.js";
import type { Store } from "./store.js";
import { BusyError, type Updater } from "./updates.js";
import type { AppState, Chat, PersonSummary, ServerEvent, TopicIcon } from "./shared/types.js";
import { monthSpend, spendingFor, spendLimitProblem } from "./spending.js";
import { TOPIC_ICONS } from "./shared/types.js";
import type { Integrations } from "./integrations/index.js";
import { revoke, type SignIns } from "./integrations/oauth.js";
import { connectOnePassword, type VaultConnector } from "./integrations/onepassword.js";
import { localOnly, publicOrigin, requirePerson, type AccessEnv, type Resolver } from "./access.js";
import { looksLikeEmail, normalEmail, type Invites } from "./invites.js";
import { inviteMail, type Mailer } from "./mailer.js";
import type { WebAccounts } from "./webauth.js";
import type { WebAuth } from "./betterAuth.js";
import { config } from "./config.js";
import { isAdmin, meOf, People, readAbout, removeAbout, writeAbout, type Person } from "./people.js";

export type Services = {
  store: Store; events: EventLog; gate: ApprovalGate; runner: Runner;
  computer?: ComputerService; browser?: BrowserService; desktop?: DesktopService; routines?: RoutineScheduler; push?: PushService;
  updater?: Updater;
  /** Who's asking (see access.ts). Without one, only requests made on this PC get in, as the admin. */
  access?: Resolver;
  /** The models the desktop check asks (tests pass scripted ones). */
  models?: ModelSource;
  /** Signing in to ChatGPT and OpenCode. */
  modelSignIns?: ModelSignIns;
  /** The OpenCode API key members' Bots run on (kept in the credential store; never sent out). */
  memberKey?: { set(key: string): Promise<void>; clear(): Promise<void> };
  /** Connected accounts (mail, calendar, 1Password) and signing in to them. */
  integrations?: Integrations;
  signIns?: SignIns;
  /** Signs in to 1Password (tests pass a fake). */
  connectVault?: VaultConnector;
  /** Voice calls and Bots ringing you. */
  calls?: Calls;
  /** PCs lent through the desktop app. */
  nodes?: NodeHub;
  /** Web sign-in: accounts, invites, the email they go out by, and Colony's own web origins. */
  web?: { accounts: WebAccounts; invites: Invites; mailer: Mailer; origins: readonly string[]; auth?: Pick<WebAuth, "handler"> | null };
};

/** API paths anyone through the website may reach before signing in: signing in itself, and checking an invite. */
export const isPublicApi = (path: string) => {
  const route = path.replace(/^\/api(?=\/)/, "");
  return route === "/auth-status" || route === "/invites/check" || route.startsWith("/auth/");
};

/**
 * Who may make a request. Everyone is signed in (see access.ts); then:
 * - anyone: any person; the route only ever reads or changes the asker's own things.
 * - admin: the admin alone (Settings, sign-ins, accounts, PCs, updates). Members get 403.
 * - bot, chat, folder, message, file, routine, approval, call: `:id` must be the asker's own
 *   (their Bot, their chat, …; an approval waiting for them, a call ringing them). Anything else
 *   is "not found" (404), so nobody learns what others have.
 * - admin-bot: the admin, on one of their own Bots.
 * - public: anyone, signed in or not (only isPublicApi paths): the website's sign-in status, invite checks.
 */
export type Policy = "anyone" | "admin" | "bot" | "chat" | "folder" | "message" | "file" | "routine" | "approval" | "call" | "admin-bot" | "public";
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";
export type RouteSpec = { method: Method; path: string; policy: Policy };

const tables = new WeakMap<object, RouteSpec[]>();
/** Every route an API serves, with its policy (the isolation tests check each one). */
export const routesOf = (api: object): readonly RouteSpec[] => tables.get(api) ?? [];

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

const ADMIN_ONLY = { error: "Only this Colony's admin can do that." };

export function createApi({ store, events, gate, runner, computer, browser, desktop, routines, push, updater, access, models, modelSignIns, memberKey, integrations, signIns, connectVault = connectOnePassword, calls, nodes, web }: Services) {
  const api = new Hono<AccessEnv>();
  const table: RouteSpec[] = [];
  tables.set(api, table);

  api.use("*", requirePerson(access ?? localOnly(new People(store, { adminEmails: config.adminEmails })), { origins: web?.origins ?? [], isPublic: isPublicApi }));

  /** Whose each kind of thing is (undefined: there's no such thing). */
  const ownerOf: Record<Exclude<Policy, "anyone" | "admin" | "admin-bot" | "public">, (id: string) => string | null | undefined> = {
    bot: (id) => store.getBot(id)?.ownerId,
    chat: (id) => store.getChat(id)?.ownerId,
    folder: (id) => store.getFolder(id)?.ownerId,
    message: (id) => { const message = store.getMessage(id); return message && store.getChat(message.chatId)?.ownerId; },
    file: (id) => { const file = store.getFile(id); return file && store.getChat(file.chatId)?.ownerId; },
    routine: (id) => { const routine = store.getRoutine(id); return routine && store.getBot(routine.botId)?.ownerId; },
    approval: (id) => store.getApproval(id)?.approverId,
    call: (id) => calls?.ownerOf(id),
  };
  const missing: Record<keyof typeof ownerOf, string> = {
    bot: "Bot not found.", chat: "Chat not found.", folder: "Folder not found.", message: "Message not found.", file: "File not found.",
    routine: "Routine not found.", approval: "This approval is no longer waiting.", call: "That call has ended.",
  };
  const guard = (policy: Policy): MiddlewareHandler<AccessEnv> => async (c, next) => {
    if (policy === "public") return next();
    const person = c.get("person");
    // Only public paths get here with nobody signed in (requirePerson answers 401 elsewhere).
    if (!person) return c.json({ error: "Sign in to Colony.", signIn: true }, 401);
    if ((policy === "admin" || policy === "admin-bot") && !isAdmin(person)) return c.json(ADMIN_ONLY, 403);
    const kind = policy === "admin-bot" ? "bot" : policy;
    if (kind !== "anyone" && kind !== "admin" && ownerOf[kind](c.req.param("id") ?? "") !== person.id) return c.json({ error: missing[kind] }, 404);
    await next();
  };
  /** Adds a route behind its policy. Every route goes through here, so none can skip a check. */
  const route = <P extends string>(method: Method, path: P, policy: Policy, handler: Handler<AccessEnv, P>) => {
    table.push({ method, path, policy });
    if (method === "ALL") api.all(path, guard(policy), handler as Handler);
    else api.on(method, path, guard(policy), handler as Handler);
  };

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
    if (error instanceof ComputerLimitError) return c.json({ error: error.message }, 409);
    console.warn("[colony] request failed:", error.message);
    return c.json({ error: error.message || "Something went wrong." }, 500);
  });

  /** Whether this person's Bots have a model to use. */
  const configuredFor = (person: Person) => settings.configuredFor(person);
  /** Why this person's Bots can't take a new turn now (a member with no models set up, or at their cap), with a status. */
  const runRefusal = (person: Person): { error: string; status: 402 | 503 } | null => {
    if (isAdmin(person)) return null;
    if (!settings.memberKeyStatus().set) return { error: settings.NO_MEMBER_MODELS, status: 503 };
    const limit = spendLimitProblem(store, person);
    return limit ? { error: limit, status: 402 } : null;
  };

  /** Everything the app shows: the asker's own things (and, for the admin, what runs this Colony). */
  route("GET", "/state", "anyone", (c) => {
    const person = c.get("person");
    const admin = isAdmin(person);
    return c.json<AppState>({
      me: meOf(person),
      bots: store.listBots(person.id),
      chats: store.listChats(person.id),
      folders: store.listFolders(person.id),
      // Recent approvals of every status, so old cards can show "Approved"/"Denied".
      approvals: store.approvalsFor(person.id),
      routines: store.routinesOf(person.id),
      models: settings.modelOptionsFor(person),
      defaultModel: settings.defaultModelFor(person),
      configured: configuredFor(person),
      accounts: admin ? integrations?.accounts.list() ?? [] : [],
      access: admin ? integrations?.accounts.listAccess() ?? [] : [],
      nodes: admin ? nodes?.list() ?? [] : [],
      persistent: Boolean(runner.compact),
      seq: events.latestSeq(),
    });
  });

  // ---------- You: who you are here, and what your Bots know about you ----------
  route("GET", "/me", "anyone", (c) => c.json({ me: meOf(c.get("person")), about: readAbout(c.get("person").id) }));
  route("PUT", "/me/about", "anyone", async (c) => {
    const { text } = z.object({ text: z.string().max(config.limits.userChars) }).parse(await c.req.json());
    writeAbout(c.get("person").id, text);
    return c.json({ about: readAbout(c.get("person").id) });
  });

  // ---------- Version and updates (the admin's) ----------
  route("GET", "/system", "admin", (c) => updater ? c.json(updater.info()) : c.json({ error: "Updates aren't available here." }, 404));

  route("POST", "/system/check", "admin", async (c) => {
    if (!updater) return c.json({ error: "Updates aren't available here." }, 404);
    try { await updater.check(); } catch (error) { return c.json({ error: `Couldn't check for updates: ${error instanceof Error ? error.message : error}` }, 502); }
    return c.json(updater.info());
  });

  route("POST", "/system/update", "admin", async (c) => {
    if (!updater) return c.json({ error: "Updates aren't available here." }, 404);
    const { force } = z.object({ force: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    try { await updater.install({ force }); } catch (error) {
      if (error instanceof BusyError) return c.json({ error: error.message, busy: error.names }, 409);
      return c.json({ error: error instanceof Error ? error.message : "Couldn't update." }, 400);
    }
    return c.json(updater.info(), 202);
  });

  // ---------- Bots ----------
  route("POST", "/bots", "anyone", async (c) => {
    const person = c.get("person");
    const input = botInput.parse(await c.req.json());
    // A model you may use: the one asked for, or your default. A member asking for another is refused.
    if (!isAdmin(person) && input.model && !settings.resolveModelFor(person, input.model, { fallback: false })) {
      return c.json({ error: "That model isn't one members may use." }, 400);
    }
    const target = settings.resolveModelFor(person, input.model);
    const problem = desktopProblem(input.computer, input.desktop, target?.ref);
    if (problem) return c.json({ error: problem }, 400);
    const bot = store.createBot({ ...input, model: target?.ref ?? "", ownerId: person.id });
    files.initBotFolder(bot);
    try { runner.start(bot.chatId, bot.id, { hiddenPrompt: INTRO_PROMPT }); } catch { /* no model yet: the Bot still exists */ }
    return c.json(bot, 201);
  });

  route("PATCH", "/bots/:id", "bot", async (c) => {
    const person = c.get("person");
    const patch = botPatch.parse(await c.req.json());
    const current = store.getBot(c.req.param("id"))!;
    const target = patch.model ? settings.resolveModelFor(person, patch.model, { fallback: false }) : null;
    if (patch.model && !target) return c.json({ error: "That model isn't in Settings." }, 400);
    const computerOn = patch.computer ?? current.computer;
    const problem = desktopProblem(computerOn, computerOn && (patch.desktop ?? current.desktop), target?.ref ?? current.model);
    if (problem) return c.json({ error: problem }, 400);
    const bot = store.updateBot(current.id, { ...patch, ...(target ? { model: target.ref } : {}) });
    return bot ? c.json(bot) : c.json({ error: "Bot not found." }, 404);
  });

  route("DELETE", "/bots/:id", "bot", async (c) => {
    const id = c.req.param("id");
    runner.stopBot(id);
    store.deleteBot(id);
    await browser?.close(id);
    await computer?.remove(id);
    files.removeBotFolder(id);
    return c.body(null, 204);
  });

  // ---------- Computer ----------
  route("GET", "/bots/:id/terminal", "bot", (c) => c.json({ text: computer?.readLog(c.req.param("id")) ?? "" }));
  route("GET", "/bots/:id/files", "bot", (c) => c.json(ws.listWorkspace(c.req.param("id"), c.req.query("path") ?? "", 1)));
  route("GET", "/bots/:id/file", "bot", (c) => {
    const file = ws.readWorkspaceFile(c.req.param("id"), c.req.query("path") ?? "", 0, 200_000);
    return c.json(file);
  });
  route("POST", "/bots/:id/computer/stop", "bot", async (c) => {
    await browser?.close(c.req.param("id"));
    await computer?.stop(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- Screen: the Bot's desktop, live in Cua's viewer ----------
  /** A fresh viewer link (starts the computer if needed). The ticket is in the URL fragment. */
  route("GET", "/bots/:id/screen-link", "bot", async (c) => {
    const bot = store.getBot(c.req.param("id"))!;
    if (!bot.computer || !desktop) return c.json({ error: "This Bot has no computer." }, 400);
    return c.json(await desktop.viewerLink(bot.id));
  });
  /** The viewer page and its gRPC-Web calls, proxied to the desktop. (Its video WebSocket is proxied in index.ts.) */
  route("ALL", "/bots/:id/screen/*", "bot", async (c) => {
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
  route("GET", "/bots/:id/browser", "bot", (c) => c.json({ open: browser?.isOpen(c.req.param("id")) ?? false, url: browser?.currentUrl(c.req.param("id")) ?? null }));
  route("POST", "/bots/:id/browser/open", "bot", async (c) => {
    const bot = botWithComputer(c.req.param("id"));
    if (!bot) return c.json({ error: "This Bot has no computer." }, 400);
    await browser!.open(bot.id);
    return c.json({ open: true, url: browser!.currentUrl(bot.id) });
  });
  route("POST", "/bots/:id/browser/input", "bot", async (c) => {
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
  route("GET", "/bots/:id/browser/live", "bot", (c) => streamSSE(c, async (stream) => {
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
  route("GET", "/bots/:id/soul", "bot", (c) => c.json({ content: files.readSoul(c.req.param("id")) }));
  route("PUT", "/bots/:id/soul", "bot", async (c) => {
    const { content } = z.object({ content: z.string().max(20_000) }).parse(await c.req.json());
    files.writeSoul(c.req.param("id"), content);
    return c.body(null, 204);
  });
  /** A Bot's memory, and what it (with its owner's other Bots) knows about its owner. */
  const memoryView = (id: string) => {
    const bot = store.getBot(id)!;
    return {
      memory: files.readEntries(bot, "memory"),
      user: files.readEntries(bot, "user"),
      usage: { memory: files.memoryUsage(bot, "memory"), user: files.memoryUsage(bot, "user") },
      skills: files.listSkills(id),
    };
  };
  route("GET", "/bots/:id/memory", "bot", (c) => c.json(memoryView(c.req.param("id"))));
  const memoryEdit = z.object({ target: z.enum(["memory", "user"]), entry: z.string().trim().min(1).max(500) });
  route("POST", "/bots/:id/memory", "bot", async (c) => {
    const { target, entry } = memoryEdit.parse(await c.req.json());
    files.addEntry(store.getBot(c.req.param("id"))!, target, entry);
    return c.json(memoryView(c.req.param("id")));
  });
  route("POST", "/bots/:id/memory/remove", "bot", async (c) => {
    const { target, entry } = memoryEdit.parse(await c.req.json());
    files.removeExactEntry(store.getBot(c.req.param("id"))!, target, entry);
    return c.json(memoryView(c.req.param("id")));
  });
  route("GET", "/bots/:id/skills/:slug", "bot", (c) => {
    const content = files.readSkill(c.req.param("id"), c.req.param("slug"));
    return content === null ? c.json({ error: "Skill not found." }, 404) : c.json({ content });
  });
  route("DELETE", "/bots/:id/skills/:slug", "bot", (c) => {
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
  /** Checks a topic's Bots and folder: only your own (topics are never shared). Returns an error message, or null. */
  const topicProblem = (person: Person, input: { memberIds?: string[]; folderId?: string | null }) => {
    if (input.memberIds?.some((id) => store.getBot(id)?.ownerId !== person.id)) return "Unknown Bot in this topic.";
    if (input.folderId && store.getFolder(input.folderId)?.ownerId !== person.id) return "That folder doesn't exist.";
    return null;
  };
  const createTopic = (person: Person, input: { title: string; icon?: TopicIcon; brief?: string; folderId?: string | null; memberIds: string[]; coordinatorId?: string }) => {
    const coordinatorId = input.coordinatorId && input.memberIds.includes(input.coordinatorId) ? input.coordinatorId : input.memberIds[0];
    return store.createChat({ kind: "topic", title: input.title, icon: input.icon ?? "chat", brief: input.brief ?? "", folderId: input.folderId ?? null, memberIds: input.memberIds, coordinatorId, ownerId: person.id });
  };

  route("POST", "/topics", "anyone", async (c) => {
    const input = z.object({ ...topicFields, icon: topicFields.icon.default("chat"), brief: topicFields.brief.default(""), folderId: topicFields.folderId.default(null) }).parse(await c.req.json());
    const problem = topicProblem(c.get("person"), input);
    if (problem) return c.json({ error: problem }, 400);
    return c.json(createTopic(c.get("person"), input), 201);
  });

  route("PATCH", "/chats/:id", "chat", async (c) => {
    const chat = store.getChat(c.req.param("id"))!;
    if (chat.kind !== "topic") return c.json({ error: "Only topics can be renamed, filed or archived." }, 400);
    const patch = z.object({ ...topicFields, archived: z.boolean(), coordinatorId: z.string().nullable() }).partial().parse(await c.req.json());
    const problem = topicProblem(c.get("person"), patch);
    if (problem) return c.json({ error: problem }, 400);
    if (patch.memberIds && !patch.memberIds.length) return c.json({ error: "A topic needs at least one Bot." }, 400);
    const members = patch.memberIds ?? chat.memberIds;
    const coordinatorId = patch.coordinatorId !== undefined || patch.memberIds
      ? (patch.coordinatorId && members.includes(patch.coordinatorId) ? patch.coordinatorId : members.includes(chat.coordinatorId ?? "") ? chat.coordinatorId : members[0])
      : undefined;
    return c.json(store.updateTopic(chat.id, { ...patch, coordinatorId }));
  });

  route("POST", "/folders", "anyone", async (c) => {
    const { title } = z.object({ title: z.string().trim().min(1).max(40) }).parse(await c.req.json());
    return c.json(store.createFolder(title, c.get("person").id), 201);
  });
  route("PATCH", "/folders/:id", "folder", async (c) => {
    const patch = z.object({ title: z.string().trim().min(1).max(40), position: z.number().int().min(0).max(10_000) }).partial().parse(await c.req.json());
    const folder = store.updateFolder(c.req.param("id"), patch);
    return folder ? c.json(folder) : c.json({ error: "Folder not found." }, 404);
  });
  route("DELETE", "/folders/:id", "folder", (c) => {
    store.deleteFolder(c.req.param("id"));
    return c.body(null, 204);
  });

  /** A topic a Bot suggested: Create makes it, Not now just closes the card. */
  route("POST", "/messages/:id/topics/:proposalId", "message", async (c) => {
    const person = c.get("person");
    const { accept } = z.object({ accept: z.boolean() }).parse(await c.req.json());
    const message = store.getMessage(c.req.param("id"));
    const card = message?.cards.find((item) => item.type === "topic" && item.proposalId === c.req.param("proposalId"));
    if (!message || card?.type !== "topic") return c.json({ error: "That suggestion is gone." }, 404);
    if (card.chatId || card.dismissed) return c.json({ error: "That suggestion was already answered." }, 409);
    let chat: Chat | null = null;
    if (accept) {
      // Only your own Bots and folders make it in.
      const proposal = { ...card.proposal, memberIds: card.proposal.memberIds.filter((id) => store.getBot(id)?.ownerId === person.id) };
      if (!proposal.memberIds.length) return c.json({ error: "The Bots in that suggestion are gone." }, 400);
      if (proposal.folderId && store.getFolder(proposal.folderId)?.ownerId !== person.id) proposal.folderId = null;
      chat = createTopic(person, proposal);
    }
    store.updateMessage(message.id, { cards: message.cards.map((item) => item === card ? { ...card, chatId: chat?.id ?? null, dismissed: !accept } : item) });
    return chat ? c.json(chat, 201) : c.body(null, 204);
  });

  route("DELETE", "/chats/:id", "chat", (c) => {
    const chat = store.getChat(c.req.param("id"))!;
    if (chat.kind === "bot") return c.json({ error: "A Bot's own chat can't be deleted; delete the Bot instead." }, 400);
    runner.stop(chat.id);
    store.deleteChat(chat.id);
    return c.body(null, 204);
  });

  route("GET", "/chats/:id/messages", "chat", (c) => {
    const before = Number(c.req.query("before")) || undefined;
    return c.json(store.listMessages(c.req.param("id"), { before, limit: 50 }));
  });

  route("POST", "/chats/:id/messages", "chat", async (c) => {
    const chat = store.getChat(c.req.param("id"))!;
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
    // Say so now, rather than in a failed reply.
    const refusal = runRefusal(c.get("person"));
    if (refusal) return c.json({ error: refusal.error }, refusal.status);
    const attachments = attached.map((file) => ({ id: file!.id, name: file!.name, mime: file!.mime, size: file!.size }));
    return c.json(sendUserMessage(store, runner, chat, { text, mode, attachments }), 201);
  });

  // ---------- A topic's Doc ----------
  route("GET", "/chats/:id/artifact", "chat", (c) => {
    const artifact = store.getArtifact(c.req.param("id"));
    // History without the bodies: each version's body loads when you open it.
    const versions = artifact ? store.listArtifactVersions(artifact.id).map(({ body: _, ...version }) => version) : [];
    return c.json({ artifact, versions });
  });
  route("GET", "/chats/:id/artifact/versions/:version", "chat", (c) => {
    const artifact = store.getArtifact(c.req.param("id"));
    const version = artifact && store.listArtifactVersions(artifact.id).find((item) => item.version === Number(c.req.param("version")));
    return version ? c.json(version) : c.json({ error: "No such version." }, 404);
  });
  /** Restoring writes the old version again as a new one, so nothing is ever lost. */
  route("POST", "/chats/:id/artifact/restore", "chat", async (c) => {
    const { version } = z.object({ version: z.number().int().min(1) }).parse(await c.req.json());
    const artifact = store.getArtifact(c.req.param("id"));
    const old = artifact && store.listArtifactVersions(artifact.id).find((item) => item.version === version);
    if (!old) return c.json({ error: "No such version." }, 404);
    return c.json(store.saveArtifact(artifact.chatId, { title: old.title, status: old.status, body: old.body, note: `Restored v${version}`, by: "user" }));
  });

  // ---------- Files in a chat ----------
  route("GET", "/chats/:id/files", "chat", (c) => c.json(store.listFiles(c.req.param("id"))));
  route("POST", "/chats/:id/files", "chat", async (c) => {
    const chat = store.getChat(c.req.param("id"))!;
    if (chat.kind === "thread") return c.json({ error: "Files go in a Bot's chat or a topic." }, 404);
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!(upload instanceof File)) return c.json({ error: "No file in that upload." }, 400);
    if (upload.size > MAX_FILE_BYTES) return c.json({ error: "That file is over 25 MB." }, 413);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const file = store.addFile({ chatId: chat.id, name: safeName(upload.name), mime: upload.type || "application/octet-stream", size: bytes.byteLength, addedBy: "user" });
    writeChatFile(file, bytes);
    shareWithComputers(file, chat, chat.memberIds.filter((id) => store.getBot(id)?.computer));
    return c.json(file, 201);
  });
  /** Downloads a file. Only photos and PDFs open in the browser; anything else downloads, so a page can't run as Colony. */
  route("GET", "/files/:id", "file", (c) => {
    const file = store.getFile(c.req.param("id"));
    if (!file || !fs.existsSync(chatFilePath(file))) return c.json({ error: "File not found." }, 404);
    const inline = isImage(file) || isPdf(file);
    c.header("Content-Type", inline ? file.mime : "application/octet-stream");
    c.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, max-age=86400");
    return c.body(fs.readFileSync(chatFilePath(file)));
  });
  route("DELETE", "/files/:id", "file", (c) => {
    const file = store.deleteFile(c.req.param("id"));
    if (file) removeChatFile(file);
    return c.body(null, 204);
  });

  /**
   * Images in a Doc come from the web. The phone loads them through here, so third-party sites
   * see Colony's request instead of your device, and each image is fetched once.
   */
  route("GET", "/img", "anyone", async (c) => {
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

  /** A new topic that carries a Bot's conversation up to this reply. */
  route("POST", "/messages/:id/branch", "message", async (c) => {
    if (!runner.branch) return c.json({ error: "Bots here don't keep persistent conversations." }, 400);
    const input = z.object({ title: z.string().trim().min(1).max(60), folderId: z.string().max(80).nullable().default(null) }).parse(await c.req.json());
    if (input.folderId && store.getFolder(input.folderId)?.ownerId !== c.get("person").id) return c.json({ error: "That folder doesn't exist." }, 400);
    try { return c.json({ chatId: await runner.branch(c.req.param("id"), input) }, 201); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "Couldn't branch." }, 400); }
  });

  /** A queued message, sent to the running turn now instead of after it. */
  route("POST", "/messages/:id/steer", "message", (c) => {
    if (!runner.steerNow(c.req.param("id"))) return c.json({ error: "That message isn't waiting any more." }, 409);
    return c.body(null, 204);
  });

  /** Takes back a queued message before the Bot sees it. */
  route("DELETE", "/messages/:id", "message", (c) => {
    const message = store.getMessage(c.req.param("id"))!;
    if (message.delivery !== "queued" || !runner.unqueue(message.id)) {
      return c.json({ error: "Only a message that's still waiting can be taken back." }, 409);
    }
    store.deleteMessage(message.id);
    return c.body(null, 204);
  });

  /** Which of a chat's Bots a conversation action is for: the one named, or the chat's lead. */
  const botIn = (chat: Chat, botId?: string) => (botId && chat.memberIds.includes(botId) ? botId : chat.coordinatorId && chat.memberIds.includes(chat.coordinatorId) ? chat.coordinatorId : chat.memberIds[0]);
  route("POST", "/chats/:id/compact", "chat", async (c) => {
    const chat = store.getChat(c.req.param("id"))!;
    if (!runner.compact) return c.json({ error: "Bots here don't keep persistent conversations." }, 400);
    const { botId } = z.object({ botId: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const bot = botIn(chat, botId);
    if (!bot) return c.json({ error: "There's no Bot in this chat." }, 400);
    try { await runner.compact(chat.id, bot); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Couldn't compact." }, 409); }
    return c.body(null, 204);
  });
  route("POST", "/chats/:id/fresh", "chat", async (c) => {
    const chat = store.getChat(c.req.param("id"))!;
    if (!runner.startFresh) return c.json({ error: "Bots here don't keep persistent conversations." }, 400);
    const { botId } = z.object({ botId: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const bot = botIn(chat, botId);
    if (!bot) return c.json({ error: "There's no Bot in this chat." }, 400);
    if (runner.isRunning(chat.id, bot)) return c.json({ error: "Stop the Bot first." }, 409);
    await runner.startFresh(chat.id, bot);
    return c.body(null, 204);
  });

  route("POST", "/chats/:id/stop", "chat", (c) => {
    runner.stop(c.req.param("id"));
    return c.body(null, 204);
  });

  route("POST", "/chats/:id/read", "chat", (c) => {
    store.markRead(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- Settings: sign-ins and the models picked from each, switchable any time (the admin's) ----------
  const price = z.object({ input: z.number().min(0).max(10_000), output: z.number().min(0).max(10_000), cached: z.number().min(0).max(10_000).optional() });
  const providerInput = z.object({
    models: z.array(z.string().trim().min(1).max(200)).max(100),
    /** Models that can drive a desktop (set by the desktop check or by hand). */
    desktop: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    /** Dollars per million tokens per model; null puts one back to the built-in price. */
    prices: z.record(z.string().max(200), price.nullable()).optional(),
  });
  /** Tells the app the models changed (each person's stream narrows them to theirs), and returns the new settings. */
  const settingsChanged = () => {
    events.emit({ type: "settings.updated", models: settings.modelOptions(), defaultModel: settings.defaultModel(), configured: settings.modelConfigured() }, null);
    return settings.settingsView();
  };
  /** The admin sees all of Settings; a member, the models they may use, their spending and cap, and whether voice is on. */
  route("GET", "/settings", "anyone", (c) => {
    const person = c.get("person");
    if (isAdmin(person)) return c.json(settings.settingsView());
    return c.json({ ...settings.memberSettingsView(person), spent: monthSpend(store, person.id), cap: settings.spendCapOf(person.id).cap });
  });

  // ---------- Spending ----------
  /** Your spending: this month by Bot and the last 30 days (and a member's cap). */
  route("GET", "/spending", "anyone", (c) => {
    const person = c.get("person");
    return c.json(spendingFor(store, person.id, Date.now(), isAdmin(person) ? null : settings.spendCapOf(person.id).cap));
  });

  // ---------- Members' models (the admin's): the members' OpenCode API key, and what members may use ----------
  /** Sets or replaces the members' key. Only whether it's set, and its last four characters, ever come back. */
  route("PUT", "/settings/members/key", "admin", async (c) => {
    if (!memberKey) return c.json({ error: "Models aren't available here." }, 503);
    const { key } = z.object({ key: z.string().trim().min(8, "Paste the whole OpenCode API key.").max(500).regex(/^\S+$/, "An API key has no spaces.") }).parse(await c.req.json());
    await memberKey.set(key);
    return c.json(settingsChanged());
  });
  route("DELETE", "/settings/members/key", "admin", async (c) => {
    if (!memberKey) return c.json({ error: "Models aren't available here." }, 503);
    await memberKey.clear();
    return c.json(settingsChanged());
  });
  const capInput = z.number().min(0).max(100_000).nullable();
  /** The OpenCode Go models members may use, their default, and the cap for members without their own. */
  route("PUT", "/settings/members", "admin", async (c) => {
    const patch = z.object({ models: z.array(z.string().trim().min(1).max(200)).max(50), defaultModel: z.string().max(200), defaultCap: capInput }).partial().parse(await c.req.json());
    try { settings.setMemberPolicy(patch); } catch (failure) { return c.json({ error: (failure as Error).message }, 400); }
    return c.json(settingsChanged());
  });

  // ---------- People (the admin's): everyone's spending, caps and computers; turning members off or removing them ----------
  const summary = (person: Person): PersonSummary => {
    const bots = store.listBots(person.id);
    const { cap, own } = isAdmin(person) ? { cap: null, own: false } : settings.spendCapOf(person.id);
    return {
      ...meOf(person), disabled: person.disabled, createdAt: person.createdAt,
      spent: monthSpend(store, person.id), cap, capOwn: own, bots: bots.length,
      computers: bots.filter((bot) => bot.computerState === "on" || bot.computerState === "starting").length,
    };
  };
  /** A member by id (the admin has no cap and can't be turned off or removed). */
  const memberById = (id: string) => { const person = store.getPerson(id); return person && !isAdmin(person) ? person : null; };
  /** Stops a member's Bots and switches their computers off. */
  const stopEverything = async (personId: string) => {
    for (const bot of store.listBots(personId)) {
      runner.stopBot(bot.id);
      await browser?.close(bot.id);
      desktop?.forget(bot.id);
      if (bot.computer) await computer?.stop(bot.id).catch(() => {});
    }
  };
  route("GET", "/people", "admin", (c) => c.json(store.listPeople().map(summary)));
  route("PUT", "/people/:id", "admin", async (c) => {
    const person = memberById(c.req.param("id"));
    if (!person) return c.json({ error: "That isn't a member." }, 404);
    const patch = z.object({ cap: z.union([capInput, z.literal("default")]), disabled: z.boolean() }).partial().parse(await c.req.json());
    if (patch.cap !== undefined) settings.setSpendCap(person.id, patch.cap);
    if (patch.disabled === true) {
      // Their web sessions end too, and they can't sign in again until turned back on.
      if (web) await web.accounts.disable(person.id); else store.setPersonDisabled(person.id, true);
      await stopEverything(person.id);
    } else if (patch.disabled === false) {
      store.setPersonDisabled(person.id, false);
    }
    return c.json(summary(store.getPerson(person.id)!));
  });
  /**
   * Removes a member's web account: they're turned off and can't sign in, and their Colony things
   * stay (to look at later, or to remove). With ?data=delete, everything of theirs goes too, and
   * nobody else's things change.
   */
  route("DELETE", "/people/:id", "admin", async (c) => {
    const person = memberById(c.req.param("id"));
    if (!person) return c.json({ error: "That isn't a member." }, 404);
    const deleteData = c.req.query("data") === "delete";
    if (web) { await web.accounts.disable(person.id); await web.accounts.deleteAccount(person.id); }
    else store.setPersonDisabled(person.id, true);
    await stopEverything(person.id);
    if (!deleteData) return c.json(summary(store.getPerson(person.id)!));
    for (const botId of store.removePerson(person.id)) {
      await computer?.remove(botId).catch(() => {});
      files.removeBotFolder(botId);
    }
    removeAbout(person.id);
    settings.setSpendCap(person.id, "default");
    return c.body(null, 204);
  });

  // ---------- Web sign-in: its status (public), the admin's own sign-in, and invites ----------
  const noWeb = { error: "Web sign-in isn't available here." };
  /** Signing in, signing up (with an invite), signing out, resets and codes: the sign-in service answers. */
  route("ALL", "/auth/*", "public", (c) => web?.auth ? web.auth.handler(c.req.raw, c.get("via")) : c.json({ error: "Web sign-in is off on this Colony." }, 404));
  /** What the website needs before anyone signs in: whether web sign-in is on, and whether email works. */
  route("GET", "/auth-status", "public", (c) => {
    const person = c.get("person");
    return c.json({ webSignIn: web?.accounts.enabled ?? false, email: web?.mailer.enabled ?? false, signedIn: Boolean(person), via: c.get("via") ?? null });
  });
  /** Whether an invite link works, and for which email (the signup page fills it in and locks it). */
  route("GET", "/invites/check", "public", (c) => {
    if (!web) return c.json(noWeb, 503);
    const checked = web.invites.check(c.req.query("invite") ?? "");
    return c.json("problem" in checked ? { valid: false, error: checked.problem } : { valid: true, email: checked.invite.email, expiresAt: checked.invite.expiresAt });
  });
  route("GET", "/web-signin", "admin", (c) => c.json({
    enabled: web?.accounts.enabled ?? false, email: web?.mailer.enabled ?? false, adminEmails: web?.accounts.adminEmails ?? [], origins: web?.origins ?? [],
  }));
  /** The admin sets up their own web sign-in (from the tailnet or this PC): no invite, and never from an open sign-up. */
  route("POST", "/web-signin/admin", "admin", async (c) => {
    if (!web) return c.json(noWeb, 503);
    const { email, password } = z.object({ email: z.string().trim().max(320), password: z.string().min(10, "Use at least 10 characters.").max(256) }).parse(await c.req.json());
    try { await web.accounts.setUpAdmin(email, password); } catch (failure) { return c.json({ error: (failure as Error).message }, 400); }
    return c.body(null, 204);
  });

  /** The link an invite's token makes, on the website the admin is on (else the first of Colony's origins). */
  const inviteLink = (c: { req: { header(name: string): string | undefined; url: string } }, via: string | undefined, token: string) => {
    const origin = publicOrigin((name) => c.req.header(name), via, web?.origins ?? []) ?? new URL(c.req.url).origin;
    return `${origin}/signup?invite=${encodeURIComponent(token)}`;
  };
  /** Emails an invite's link, or hands it back to copy when email isn't set up (or didn't work). */
  const deliver = async (email: string, inviteId: string, link: string) => {
    if (!web!.mailer.enabled) return { emailed: false, link };
    try {
      await web!.mailer.send(inviteMail(email, link, config.inviteTtlDays));
      web!.invites.markSent(inviteId);
      return { emailed: true };
    } catch (failure) {
      return { emailed: false, link, error: `Couldn't email it: ${(failure as Error).message} Copy the link instead.` };
    }
  };
  route("GET", "/invites", "admin", (c) => web ? c.json(web.invites.list()) : c.json(noWeb, 503));
  route("POST", "/invites", "admin", async (c) => {
    if (!web) return c.json(noWeb, 503);
    const { email } = z.object({ email: z.string().trim().max(320) }).parse(await c.req.json());
    const address = normalEmail(email);
    if (!looksLikeEmail(address)) return c.json({ error: "That isn't an email address." }, 400);
    if (web.accounts.isAdminEmail(address)) return c.json({ error: "That's an admin email: set up its web sign-in instead." }, 400);
    const { invite, token } = web.invites.create(address);
    const sent = await deliver(address, invite.id, inviteLink(c, c.get("via"), token));
    return c.json({ invite: web.invites.get(invite.id), ...sent }, 201);
  });
  /** A fresh link for an invite (the old one stops working), emailed again. */
  route("POST", "/invites/:id/resend", "admin", async (c) => {
    if (!web) return c.json(noWeb, 503);
    let rotated: ReturnType<Invites["resend"]>;
    try { rotated = web.invites.resend(c.req.param("id")); } catch (failure) { return c.json({ error: (failure as Error).message }, 409); }
    const sent = await deliver(rotated.invite.email, rotated.invite.id, inviteLink(c, c.get("via"), rotated.token));
    return c.json({ invite: web.invites.get(rotated.invite.id), ...sent });
  });
  route("DELETE", "/invites/:id", "admin", (c) => {
    if (!web) return c.json(noWeb, 503);
    return web.invites.revoke(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "That invite isn't waiting any more." }, 409);
  });

  // ---------- Voice (the admin's) ----------
  const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 22:00.");
  const voicePatch = z.object({
    /** OpenAI-compatible audio endpoints; "" turns voice off. */
    baseURL: z.union([z.literal(""), z.string().trim().url().max(500).refine((url) => /^https?:\/\//i.test(url), "Use an http(s) address.")]),
    /** A new key; "" removes it; left out keeps it. */
    apiKey: z.string().trim().max(500),
    transcribeModel: z.string().trim().min(1).max(120),
    speechModel: z.string().trim().min(1).max(120),
    voice: z.string().trim().min(1).max(60),
    botVoices: z.record(z.string(), z.string().trim().max(60)),
    allowCalls: z.boolean(),
    quietFrom: hhmm,
    quietTo: hhmm,
  }).partial();
  route("PUT", "/settings/voice", "admin", async (c) => {
    const patch = voicePatch.safeParse(await c.req.json());
    if (!patch.success) return c.json({ error: patch.error.issues[0]?.message ?? "Check the voice settings." }, 400);
    settings.setVoiceSettings(Object.fromEntries(Object.entries(patch.data).filter(([, value]) => value !== undefined)));
    return c.json(settings.settingsView());
  });
  /** Says a line in a voice, to try it out in Settings. */
  route("POST", "/settings/voice/try", "admin", async (c) => {
    const { voice } = z.object({ voice: z.string().trim().min(1).max(60) }).parse(await c.req.json());
    try {
      const audio = await speak("Hi! This is how I'll sound when we talk.", voice);
      return c.body(audio, 200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Couldn't speak." }, 400);
    }
  });
  // ---------- This PC (the admin's) ----------
  /** Forgets a PC (it comes back if its app connects again). */
  route("DELETE", "/nodes/:id", "admin", (c) => {
    store.deleteNode(c.req.param("id"));
    nodes?.changed();
    return c.json({ ok: true });
  });

  route("POST", "/calls/:id/decline", "call", (c) => {
    calls?.miss(c.req.param("id"));
    return c.json({ ok: true });
  });
  /** Picks a provider's models. */
  route("PUT", "/settings/providers/:id", "admin", async (c) => {
    try { settings.saveProvider(c.req.param("id"), providerInput.parse(await c.req.json())); }
    catch (failure) { if (failure instanceof z.ZodError) throw failure; return c.json({ error: (failure as Error).message }, 404); }
    return c.json(settingsChanged());
  });
  /** The default for new Bots. */
  route("PUT", "/settings/default-model", "admin", async (c) => {
    const { model } = z.object({ model: z.string().max(300) }).parse(await c.req.json());
    try { settings.setDefaultModel(model); } catch (failure) { return c.json({ error: (failure as Error).message }, 400); }
    return c.json(settingsChanged());
  });
  /** Tests which of a provider's models can drive a desktop, and records the verdicts. */
  route("POST", "/settings/providers/:id/desktop-check", "admin", async (c) => {
    const id = c.req.param("id");
    const provider = settings.providerById(id);
    if (!provider) return c.json({ error: "That provider doesn't exist." }, 404);
    if (!models) return c.json({ error: "Models aren't available here." }, 503);
    const { models: chosen } = z.object({ models: z.array(z.string().max(200)).max(100).optional() }).parse(await c.req.json().catch(() => ({})));
    const queue = (chosen ?? provider.models).filter((model) => provider.models.includes(model));
    const targets = queue.map((model) => settings.resolveModel(settings.modelRef(provider.id, model), { fallback: false }));
    if (targets.some((target) => !target)) return c.json({ error: `Sign in to ${provider.name} first.` }, 400);
    const results: DesktopVerdict[] = [];
    for (let start = 0; start < targets.length; start += 4) {
      results.push(...await Promise.all(targets.slice(start, start + 4).map((target) => checkDesktop(target!, models))));
    }
    settings.setDesktopModels(provider.id, Object.fromEntries(results.filter((result) => !result.error).map((result) => [result.model, result.canDrive])));
    return c.json({ results, settings: settingsChanged() });
  });

  // ---------- Sign-ins: ChatGPT and OpenCode (the admin's) ----------
  const signInId = z.enum(["chatgpt", "opencode"]);
  const noSignIns = { error: "Sign-ins aren't available here." };
  /** Starts a sign-in: an address to open (ChatGPT) or a code to approve (OpenCode). */
  route("POST", "/settings/signins/:id/start", "admin", async (c) => {
    if (!modelSignIns) return c.json(noSignIns, 503);
    const id = signInId.parse(c.req.param("id"));
    try { return c.json(await modelSignIns.start(id)); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Couldn't start the sign-in." }, 502); }
  });
  route("GET", "/settings/signins/session/:session", "admin", (c) => {
    const status = modelSignIns?.status(c.req.param("session"));
    return status ? c.json(status) : c.json({ error: "That sign-in has ended." }, 404);
  });
  /** Finishes a ChatGPT sign-in from another device: the address the browser ended on. */
  route("POST", "/settings/signins/session/:session/finish", "admin", async (c) => {
    if (!modelSignIns) return c.json(noSignIns, 503);
    const { url } = z.object({ url: z.string().trim().min(1, "Paste the address.").max(4000) }).parse(await c.req.json());
    try { modelSignIns.finish(c.req.param("session"), url); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Couldn't finish." }, 400); }
    return c.body(null, 204);
  });
  route("POST", "/settings/signins/session/:session/cancel", "admin", (c) => {
    modelSignIns?.cancel(c.req.param("session"));
    return c.body(null, 204);
  });
  /** Signs out: forgets the tokens. Bots on its models switch to the default model. */
  route("DELETE", "/settings/signins/:id", "admin", async (c) => {
    if (!modelSignIns) return c.json(noSignIns, 503);
    await modelSignIns.signOut(signInId.parse(c.req.param("id")));
    return c.json(settingsChanged());
  });

  // ---------- Accounts: mail, calendars, 1Password (the admin's) ----------
  const unavailable = { error: "Accounts aren't available here." };
  const failure = (error: unknown, fallback: string) => ({ error: error instanceof Error ? error.message : fallback });
  route("GET", "/accounts", "admin", (c) => {
    if (!integrations) return c.json(unavailable, 503);
    const apps = integrations.accounts.apps();
    return c.json({
      accounts: integrations.accounts.list(),
      access: integrations.accounts.listAccess(),
      // Client ids aren't secret; the Google client secret stays here.
      apps: { google: apps.google ? { clientId: apps.google.clientId } : null, microsoft: apps.microsoft ? { clientId: apps.microsoft.clientId } : null },
    });
  });
  const clientId = z.string().trim().min(10, "Paste the client ID.").max(300);
  route("POST", "/accounts/google/start", "admin", async (c) => {
    if (!integrations || !signIns) return c.json(unavailable, 503);
    const input = z.object({ clientId: clientId.optional(), clientSecret: z.string().trim().max(300).optional() }).parse(await c.req.json().catch(() => ({})));
    const saved = integrations.accounts.apps().google;
    const app = input.clientId
      ? { clientId: input.clientId, clientSecret: input.clientSecret || (saved?.clientId === input.clientId ? saved.clientSecret : "") }
      : saved;
    if (!app?.clientId || !app.clientSecret) return c.json({ error: "Paste your Google client ID and client secret." }, 400);
    integrations.accounts.saveApp("google", app);
    try { return c.json(await signIns.startGoogle(app)); } catch (error) { return c.json(failure(error, "Couldn't start the sign-in."), 500); }
  });
  route("POST", "/accounts/google/finish", "admin", async (c) => {
    if (!signIns) return c.json(unavailable, 503);
    const { id, url } = z.object({ id: z.string().max(80), url: z.string().trim().min(1).max(4000) }).parse(await c.req.json());
    try { return c.json(await signIns.finishGoogle(id, url)); } catch (error) { return c.json(failure(error, "Couldn't finish the sign-in."), 400); }
  });
  route("POST", "/accounts/microsoft/start", "admin", async (c) => {
    if (!integrations || !signIns) return c.json(unavailable, 503);
    const input = z.object({ clientId: clientId.optional() }).parse(await c.req.json().catch(() => ({})));
    const saved = integrations.accounts.apps().microsoft;
    const app = input.clientId ? { clientId: input.clientId } : saved;
    if (!app?.clientId) return c.json({ error: "Paste your Microsoft application (client) ID." }, 400);
    integrations.accounts.saveApp("microsoft", app);
    try { return c.json(await signIns.startMicrosoft(app)); } catch (error) { return c.json(failure(error, "Couldn't start the sign-in."), 502); }
  });
  route("GET", "/accounts/signin/:id", "admin", (c) => {
    const status = signIns?.status(c.req.param("id"));
    return status ? c.json(status) : c.json({ error: "That sign-in has ended." }, 404);
  });
  route("POST", "/accounts/signin/:id/cancel", "admin", (c) => {
    if (signIns?.status(c.req.param("id"))) signIns.cancel(c.req.param("id"));
    return c.body(null, 204);
  });
  route("POST", "/accounts/onepassword", "admin", async (c) => {
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
    const account = integrations.accounts.connect({ kind: "onepassword", label: "1Password", email },
      { kind: "onepassword", ...input, saveVaultId: vaults[0].id });
    integrations.vaults.forget(account.id);
    return c.json(account, 201);
  });
  route("DELETE", "/accounts/:id", "admin", async (c) => {
    if (!integrations) return c.json(unavailable, 503);
    const id = c.req.param("id");
    if (!integrations.accounts.get(id)) return c.json({ error: "That account isn't connected." }, 404);
    await revoke(fetch, integrations.accounts.secret(id));
    // Routines watching this mailbox have nothing left to watch.
    for (const routine of store.listRoutines()) if (routine.schedule.type === "mail" && routine.schedule.accountId === id) store.deleteRoutine(routine.id);
    integrations.accounts.remove(id);
    integrations.tokens.forget(id);
    integrations.vaults.forget(id);
    return c.body(null, 204);
  });
  /** What one of the admin's Bots may do with one of the admin's accounts. */
  route("PUT", "/bots/:id/access/:accountId", "admin-bot", async (c) => {
    if (!integrations) return c.json(unavailable, 503);
    const patch = z.object({
      mail: z.enum(["none", "read", "draft", "send"]).optional(),
      calendar: z.enum(["none", "read", "write"]).optional(),
      vault: z.enum(["none", "use", "save"]).optional(),
    }).parse(await c.req.json());
    try { return c.json(integrations.accounts.setAccess(c.req.param("id"), c.req.param("accountId"), patch)); }
    catch (error) { return c.json(failure(error, "Couldn't change access."), 404); }
  });

  // ---------- Routines ----------
  route("POST", "/bots/:id/routines", "bot", async (c) => {
    const bot = store.getBot(c.req.param("id"))!;
    const body = await c.req.json();
    const input = routineInput.parse(body);
    // A routine posts to the Bot's own chat, or to a topic of yours it's in (the topic's Schedule tab).
    const { chatId = bot.chatId } = z.object({ chatId: z.string().optional() }).parse(body);
    const chat = store.getChat(chatId);
    if (chatId !== bot.chatId && !(chat?.ownerId === c.get("person").id && chat.memberIds.includes(bot.id))) return c.json({ error: "That Bot isn't in that topic." }, 400);
    const problem = mailProblem(bot.id, input.schedule);
    if (problem) return c.json({ error: problem }, 400);
    const routine = store.createRoutine({ botId: bot.id, chatId, title: input.title, prompt: input.prompt, schedule: input.schedule });
    return c.json(input.enabled === false ? store.updateRoutine(routine.id, { enabled: false }) : routine, 201);
  });

  route("PATCH", "/routines/:id", "routine", async (c) => {
    const patch = routineInput.partial().parse(await c.req.json());
    const current = store.getRoutine(c.req.param("id"));
    const problem = current && patch.schedule ? mailProblem(current.botId, patch.schedule) : null;
    if (problem) return c.json({ error: problem }, 400);
    const routine = store.updateRoutine(c.req.param("id"), patch);
    return routine ? c.json(routine) : c.json({ error: "Routine not found." }, 404);
  });

  route("DELETE", "/routines/:id", "routine", (c) => {
    store.deleteRoutine(c.req.param("id"));
    return c.body(null, 204);
  });

  route("POST", "/routines/:id/run", "routine", (c) => {
    const routine = store.getRoutine(c.req.param("id"))!;
    if (runner.isRunning(routine.chatId, routine.botId)) return c.json({ error: "That Bot is busy in this chat right now." }, 409);
    const messageId = routines?.run(routine.id, { manual: true });
    return messageId ? c.json({ messageId }) : c.json({ error: "Couldn't start the routine." }, 500);
  });

  // ---------- Notifications (to your own devices) ----------
  route("GET", "/push/key", "anyone", (c) => push ? c.json({ publicKey: push.publicKey }) : c.json({ error: "Notifications are off." }, 503));
  route("POST", "/push/subscribe", "anyone", async (c) => {
    push?.subscribe(pushSubscription.parse(await c.req.json()), c.get("person").id);
    return c.body(null, 204);
  });
  route("POST", "/push/unsubscribe", "anyone", async (c) => {
    push?.unsubscribe(z.object({ endpoint: z.string() }).parse(await c.req.json()).endpoint, c.get("person").id);
    return c.body(null, 204);
  });
  route("POST", "/push/status", "anyone", async (c) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(await c.req.json());
    return c.json({ subscribed: push?.isSubscribed(endpoint, c.get("person").id) ?? false });
  });
  route("POST", "/push/test", "anyone", async (c) => {
    const delivered = await push?.notify({ title: "Colony", body: "Notifications are on. Your Bots will ping you here.", chatId: null, tag: "test" }, { force: true, personId: c.get("person").id }) ?? 0;
    return c.json({ delivered });
  });
  route("POST", "/focus", "anyone", async (c) => {
    const input = z.object({ clientId: z.string().max(80), chatId: z.string().max(80).nullable(), visible: z.boolean() }).parse(await c.req.json());
    push?.setFocus(c.get("person").id, input.clientId, input.chatId, input.visible);
    return c.body(null, 204);
  });

  // ---------- Approvals (only the person it waits for answers it) ----------
  route("POST", "/approvals/:id", "approval", async (c) => {
    const { approve } = z.object({ approve: z.boolean() }).parse(await c.req.json());
    if (!gate.resolve(c.req.param("id"), approve)) return c.json({ error: "This approval is no longer waiting." }, 409);
    return c.body(null, 204);
  });

  /** An event as this person's stream carries it: theirs or everyone's, with models narrowed to theirs. */
  const eventFor = (person: Person, item: Pick<Item, "event" | "personId">) => {
    if (!visibleTo(person.id, item)) return null;
    if (item.event.type === "settings.updated" && !isAdmin(person)) {
      return { ...item.event, models: settings.modelOptionsFor(person), defaultModel: settings.defaultModelFor(person), configured: configuredFor(person) } satisfies ServerEvent;
    }
    return item.event;
  };

  // ---------- Live events (SSE, resumable via Last-Event-ID or ?since=): yours only ----------
  route("GET", "/events", "anyone", (c) => streamSSE(c, async (stream) => {
    const person = c.get("person");
    const since = Number(c.req.header("Last-Event-ID") ?? c.req.query("since") ?? events.latestSeq());
    const clientId = c.req.query("client")?.slice(0, 80);
    const release = clientId && push ? push.attachClient(person.id, clientId) : null;
    let released = false;
    const detach = () => { if (!released) { released = true; release?.(); } };
    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = events.subscribe((item) => { if (visibleTo(person.id, item)) { queue.push(item); wake?.(); } });
    stream.onAbort(() => { unsubscribe(); detach(); wake?.(); });

    const backlog = events.since(since);
    if (backlog === null) await stream.writeSSE({ event: "reset", data: "{}" });
    else for (const item of backlog) {
      const event = eventFor(person, item);
      if (event) await stream.writeSSE({ id: String(item.seq), event: "event", data: JSON.stringify(event) });
    }
    let last = backlog?.at(-1)?.seq ?? since;
    // Flush headers right away so the client sees the connection open.
    await stream.writeSSE({ event: "ready", data: String(last) });

    const heartbeat = setInterval(() => {
      // A member turned off or removed meanwhile loses their stream.
      const now = store.getPerson(person.id);
      if (!now || now.disabled) { stream.abort(); wake?.(); return; }
      void stream.writeSSE({ event: "ping", data: "" });
    }, 15_000);
    try {
      while (!stream.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
        for (const item of queue.splice(0)) {
          if (item.seq !== null && item.seq <= last) continue;
          if (item.seq !== null) last = item.seq;
          const event = eventFor(person, item);
          if (!event) continue;
          await stream.writeSSE({ ...(item.seq !== null ? { id: String(item.seq) } : {}), event: item.seq === null ? "ephemeral" : "event", data: JSON.stringify(event) });
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
