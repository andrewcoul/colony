import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { ColonyTool, ToolContext, ToolRegistry } from "./agent/tools.js";
import type { EventLog } from "./events.js";
import type { PcCapability, PcNode, Person } from "./shared/types.js";
import type { Store } from "./store.js";

/*
 * This PC: the Colony desktop app lends a Bot the person's own computer. The app connects to
 * /api/nodes/connect and acts as an MCP server over that socket (JSON-RPC 2.0: initialize,
 * tools/list, tools/call); Colony is the client. Each switch (browser windows, screen, terminal,
 * files) is turned on in the desktop app and enforced there, so Colony can't grant itself more
 * than the PC allows. Here, each Bot gets the tools the PC offers up to the level you gave it,
 * and anything that acts on the PC asks you first.
 */

const CAPABILITIES: PcCapability[] = ["browser", "screen", "shell", "files", "fullDisk"];
const CALL_TIMEOUT_MS = 120_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Connection = { ws: WebSocket; tools: Set<string>; pending: Map<number, Pending>; nextId: number; driving: string | null };

/** MCP tool results: text and images. */
type CallResult = { content?: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

export class NodeHub {
  private connections = new Map<string, Connection>();
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  /** Stops a Bot's work (set by index.ts): the PC's Stop button. */
  stopBot: (botId: string) => void = () => {};

  constructor(private store: Store, private events: EventLog) {}

  list(): PcNode[] {
    return this.store.listNodes().map((node) => ({ ...node, online: this.connections.has(node.id) }));
  }

  get(id: string) {
    return this.list().find((node) => node.id === id) ?? null;
  }

  changed() {
    this.events.emit({ type: "nodes.updated", nodes: this.list() });
  }

  /** Tools a PC offers right now (what its switches allow). */
  offered(nodeId: string) {
    return this.connections.get(nodeId)?.tools ?? new Set<string>();
  }

  /** A PC connecting: it belongs to whoever's login lent it. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, person: Person) {
    this.sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws, person));
  }

  private accept(ws: WebSocket, person: Person) {
    let nodeId: string | null = null;
    const connection: Connection = { ws, tools: new Set(), pending: new Map(), nextId: 1, driving: null };
    // A PC that never says who it is gets dropped.
    const hello = setTimeout(() => { if (!nodeId) ws.close(); }, 10_000);

    ws.on("message", (data) => {
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(String(data)); } catch { return; }
      // A reply to one of our requests.
      if (typeof message.id === "number" && !message.method) {
        const pending = connection.pending.get(message.id);
        if (!pending) return;
        connection.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? "The PC couldn't do that."));
        else pending.resolve(message.result);
        return;
      }
      // The PC says who it is (again, whenever its switches change).
      if (message.method === "node/hello") {
        const params = parseHello(message.params);
        if (!params) { ws.close(1008, "Bad hello"); return; }
        clearTimeout(hello);
        if (nodeId && nodeId !== params.id) { ws.close(1008, "One PC per connection"); return; }
        // A PC can't be taken over by someone else's login.
        const known = this.store.listNodes().find((node) => node.id === params.id);
        if (known && known.personId !== person.id) { ws.close(1008, "That PC is someone else's"); return; }
        if (!nodeId) {
          nodeId = params.id;
          // A newer connection from the same PC replaces the old one.
          this.connections.get(nodeId)?.ws.close(1000, "Replaced");
          this.connections.set(nodeId, connection);
        }
        this.store.saveNode({ ...params, personId: person.id });
        void this.refresh(nodeId, connection);
        return;
      }
      if (message.method === "notifications/tools/list_changed" && nodeId) { void this.refresh(nodeId, connection); return; }
      // The person pressed Stop on the PC's "using this PC" pill.
      if (message.method === "node/stop" && connection.driving) this.stopBot(connection.driving);
    });

    ws.on("close", () => {
      clearTimeout(hello);
      for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The PC disconnected.")); }
      if (nodeId && this.connections.get(nodeId) === connection) {
        this.connections.delete(nodeId);
        this.changed();
      }
    });
  }

  private async refresh(_nodeId: string, connection: Connection) {
    try {
      if (!connection.tools.size) await this.request(connection, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "colony", version: "1" } });
      const listed = await this.request(connection, "tools/list", {}) as { tools?: { name: string }[] };
      connection.tools = new Set((listed.tools ?? []).map((item) => item.name).filter((name) => name in PC_TOOLS));
    } catch {
      connection.tools = new Set();
    }
    this.changed();
  }

  private request(connection: Connection, method: string, params: unknown, signal?: AbortSignal) {
    const id = connection.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(id); reject(new Error("The PC didn't answer in time.")); }, CALL_TIMEOUT_MS);
      connection.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => { clearTimeout(timer); connection.pending.delete(id); reject(new Error("Stopped.")); }, { once: true });
      connection.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Runs one tool on a PC, on behalf of a Bot (its name shows on the PC while it drives). */
  async call(nodeId: string, name: string, args: Record<string, unknown>, bot: { id: string; name: string; owner?: string | null }, signal?: AbortSignal): Promise<CallResult> {
    const connection = this.connections.get(nodeId);
    if (!connection) throw new Error("That PC isn't connected right now. Its Colony app needs to be open.");
    if (!connection.tools.has(name)) throw new Error("That's switched off on the PC.");
    connection.driving = bot.id;
    const result = await this.request(connection, "tools/call", { name, arguments: args, _meta: { botId: bot.id, botName: bot.name, ownerName: bot.owner ?? null } }, signal) as CallResult;
    if (result?.isError) throw new Error(textOf(result) || "The PC couldn't do that.");
    return result ?? {};
  }
}

function parseHello(params: unknown) {
  const parsed = z.object({
    id: z.string().regex(/^[\w-]{8,64}$/),
    name: z.string().trim().min(1).max(60),
    platform: z.string().max(20),
    capabilities: z.array(z.string()),
  }).safeParse(params);
  if (!parsed.success) return null;
  return { ...parsed.data, capabilities: parsed.data.capabilities.filter((item): item is PcCapability => CAPABILITIES.includes(item as PcCapability)) };
}

const textOf = (result: CallResult) => (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();

// ---------- The tools Bots get ----------

/** When each tool asks first: once per turn, every time, or not at all (reading files you switched on). */
type Ask = "once" | "always" | "never";
type PcTool = { ask: Ask; spec: Omit<ColonyTool, "execute" | "describe"> & { describe: (input: any) => string; action: (input: any) => string } };

const windowField = z.number().int().min(1).optional().describe("Which window (from pc_browser_open); the last one if left out.");

/** Defined here so Colony, not the PC, decides how each tool is described to models. */
export const PC_TOOLS: Record<string, PcTool> = {
  pc_browser_open: { ask: "once", spec: {
    description: "Open a page in a browser window on the user's own PC (signed in where they've signed in before, in Colony's own browser profile). Use it for sites that need the user's logins or their network. Returns the window number and the page's text.",
    inputSchema: z.object({ url: z.string().url() }),
    describe: ({ url }) => `Opened ${host(url)} on the PC`,
    action: ({ url }) => `Open ${url} in a browser window`,
  } },
  pc_browser_read: { ask: "never", spec: {
    description: "Read the text of a browser window you opened on the user's PC (its URL, title and visible text).",
    inputSchema: z.object({ window: windowField }),
    describe: () => "Read a page on the PC",
    action: () => "Read a page",
  } },
  pc_browser_click: { ask: "once", spec: {
    description: "Click a link or button in a browser window on the user's PC, by its visible text or a CSS selector.",
    inputSchema: z.object({ window: windowField, text: z.string().max(200).optional(), selector: z.string().max(300).optional() }),
    describe: ({ text, selector }) => `Clicked ${text ? `"${text}"` : selector ?? "on a page"} on the PC`,
    action: ({ text, selector }) => `Click ${text ? `"${text}"` : selector}`,
  } },
  pc_browser_type: { ask: "once", spec: {
    description: "Type into a field in a browser window on the user's PC (the focused field, or one found by CSS selector), optionally pressing Enter after.",
    inputSchema: z.object({ window: windowField, selector: z.string().max(300).optional(), text: z.string().max(5000), submit: z.boolean().optional() }),
    describe: () => "Typed on a page on the PC",
    action: ({ text }) => `Type "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`,
  } },
  pc_screenshot: { ask: "always", spec: {
    description: "See the user's PC screen as it is now (all its monitors' main display).",
    inputSchema: z.object({}),
    describe: () => "Looked at the PC's screen",
    action: () => "See your screen",
  } },
  pc_shell: { ask: "always", spec: {
    description: "Run a command in the user's own terminal on their PC, in the folder they chose for Bots. Returns its output. Prefer your own computer for anything that doesn't need theirs.",
    inputSchema: z.object({ command: z.string().min(1).max(4000) }),
    describe: ({ command }) => `Ran \`${command.length > 50 ? `${command.slice(0, 50)}…` : command}\` on the PC`,
    action: ({ command }) => `Run: ${command}`,
  } },
  pc_list_files: { ask: "never", spec: {
    description: "List a folder on the user's PC (paths start from their home folder, e.g. \"Documents\").",
    inputSchema: z.object({ path: z.string().max(1000).default(".") }),
    describe: ({ path }) => `Listed ${path || "home"} on the PC`,
    action: ({ path }) => `List ${path}`,
  } },
  pc_read_file: { ask: "never", spec: {
    description: "Read a text file on the user's PC (path from their home folder).",
    inputSchema: z.object({ path: z.string().min(1).max(1000) }),
    describe: ({ path }) => `Read ${path} on the PC`,
    action: ({ path }) => `Read ${path}`,
  } },
  pc_write_file: { ask: "always", spec: {
    description: "Write a text file on the user's PC (path from their home folder). Replaces the file if it exists.",
    inputSchema: z.object({ path: z.string().min(1).max(1000), content: z.string().max(500_000) }),
    describe: ({ path }) => `Wrote ${path} on the PC`,
    action: ({ path, content }) => `Write ${path} (${content.length.toLocaleString()} characters)`,
  } },
};

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** Picks the PC for a call: the one named, else the Bot's owner's own, else the only one there is. */
function choosePc(offering: PcNode[], ownerId: string, pc: string | undefined) {
  if (pc) {
    const named = offering.find((node) => node.name.toLowerCase() === pc.trim().toLowerCase());
    if (!named) throw new Error(`No PC called "${pc}" allows this. These do: ${offering.map((node) => node.name).join(", ")}.`);
    return named;
  }
  const own = offering.find((node) => node.personId === ownerId);
  if (own) return own;
  if (offering.length === 1) return offering[0];
  throw new Error(`Say which PC with "pc": ${offering.map((node) => node.name).join(", ")}.`);
}

/**
 * The PC tools a Bot has. Being family is the permission: any lent PC that's online, within
 * what its owner switched on there. Each call names its PC (or uses the Bot's owner's own),
 * and anything that acts on a PC asks that PC's owner.
 */
export function pcToolsFor(hub: NodeHub, store: Store, botId: string): ToolRegistry {
  const bot = store.getBot(botId);
  const online = hub.list().filter((node) => node.online);
  if (!bot || !online.length) return {};
  const names = new Map(store.listPeople().map((person) => [person.id, person.name]));
  const whose = (node: PcNode) => (node.personId === bot.ownerId ? "your owner's" : `${names.get(node.personId) ?? "someone"}'s`);
  // Tools are built fresh for each turn, so this is "they said yes to the browser on this PC this turn".
  const browserAllowed = new Set<string>();
  const registry: ToolRegistry = {};
  for (const [name, { ask, spec }] of Object.entries(PC_TOOLS)) {
    const offering = online.filter((node) => hub.offered(node.id).has(name));
    if (!offering.length) continue;
    const pcField = z.string().max(60).optional().describe(`Which PC (by name). Leave out to use your owner's own PC${offering.length === 1 ? ` (here: ${offering[0].name})` : ""}.`);
    registry[name] = {
      ...spec,
      inputSchema: (spec.inputSchema as z.ZodObject<z.ZodRawShape>).extend({ pc: pcField }),
      description: `${spec.description} PCs that allow this: ${offering.map((node) => `${node.name} (${whose(node)})`).join("; ")}.`,
      execute: async ({ pc, ...input }: Record<string, unknown>, ctx: ToolContext) => {
        const node = choosePc(offering, bot.ownerId, pc as string | undefined);
        const asker = node.personId === bot.ownerId ? ctx.botName : `${ctx.botName} (${names.get(bot.ownerId) ?? "someone"}'s)`;
        if (ask === "always" || (ask === "once" && !browserAllowed.has(node.id))) {
          const ok = await ctx.gate.request({
            botId: ctx.botId, chatId: ctx.chatId, messageId: ctx.messageId, tool: name,
            // The PC's owner decides what happens on it, whoever's Bot is asking.
            approverId: node.personId,
            summary: ask === "once" ? `${asker} wants to use the browser on ${node.name}` : `${asker} wants to use ${node.name}`,
            detail: spec.action(input) + (ask === "once" ? "\n\nAllowing this lets it keep using browser windows on this PC for the rest of this task." : ""),
            reason: "Acts on your own PC",
          }, ctx.signal);
          if (!ok) throw new Error(`${names.get(node.personId) ?? "The PC's owner"} said no.`);
          if (ask === "once") browserAllowed.add(node.id);
        }
        const result = await hub.call(node.id, name, input, { id: ctx.botId, name: ctx.botName, owner: node.personId === bot.ownerId ? null : names.get(bot.ownerId) ?? null }, ctx.signal);
        const image = result.content?.find((part) => part.type === "image");
        if (image?.type === "image") return { shot: { data: image.data, mediaType: image.mimeType }, text: textOf(result) };
        return textOf(result) || "Done.";
      },
      toModelOutput: (output: unknown) => {
        const shot = (output as { shot?: { data: string; mediaType: string }; text?: string })?.shot;
        if (shot) return { type: "content", value: [{ type: "text", text: (output as { text?: string }).text || "The screen:" }, { type: "file", data: { type: "data", data: shot.data }, mediaType: shot.mediaType }] };
        return { type: "text", value: typeof output === "string" ? output : JSON.stringify(output) };
      },
    };
  }
  return registry;
}
