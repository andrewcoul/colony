// This PC: lends this computer to your Bots. The app connects to the Colony server's
// /api/nodes/connect and answers as an MCP server (JSON-RPC 2.0: initialize, tools/list,
// tools/call). Every switch lives here and is checked here on each call, so the server can't
// give a Bot more than this PC allows. While a Bot is using the PC, a border and a
// "<Bot> is using this PC · Stop" pill show on screen.
import { BrowserWindow, desktopCapturer, screen } from "electron";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type NodeSettings = {
  /** Lend this PC to Bots at all. */
  enabled: boolean;
  id: string;
  name: string;
  browser: boolean;
  screen: boolean;
  shell: boolean;
  files: boolean;
  /** Files outside the home folder too. */
  fullDisk: boolean;
  /** Where terminal commands run (the home folder if unset). */
  shellFolder: string | null;
};
export type NodeStatus = "off" | "connecting" | "connected" | "offline";

export const defaultNodeSettings = (): NodeSettings => ({
  enabled: false, id: randomUUID(), name: `${os.userInfo().username}'s PC`,
  browser: true, screen: false, shell: false, files: false, fullDisk: false, shellFolder: null,
});

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Meta = { botId?: string; botName?: string; ownerName?: string | null };

const MAX_TEXT = 20_000;
const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

/** Which switch each tool needs. */
const NEEDS: Record<string, keyof NodeSettings> = {
  pc_browser_open: "browser", pc_browser_read: "browser", pc_browser_click: "browser", pc_browser_type: "browser",
  pc_screenshot: "screen", pc_shell: "shell", pc_list_files: "files", pc_read_file: "files", pc_write_file: "files",
};

export class PcNode {
  status: NodeStatus = "off";
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private delay = 1000;
  private windows = new Map<number, BrowserWindow>();
  private nextWindow = 1;
  private lastWindow: number | null = null;
  private indicator: { border: BrowserWindow; pill: BrowserWindow } | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = 0;

  constructor(
    private server: () => string | null,
    public settings: NodeSettings,
    private onChange: (settings: NodeSettings, status: NodeStatus) => void,
  ) {}

  /** Connects (or disconnects) to match the settings. */
  sync() {
    if (!this.settings.enabled || !this.server()) { this.disconnect("off"); return; }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) { this.hello(); return; }
    this.connect();
  }

  update(patch: Partial<NodeSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.sync();
    this.onChange(this.settings, this.status);
  }

  private setStatus(status: NodeStatus) {
    this.status = status;
    this.onChange(this.settings, status);
  }

  private connect() {
    const origin = this.server();
    if (!origin) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.setStatus("connecting");
    const url = `${origin.replace(/^http/, "ws")}/api/nodes/connect`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.delay = 1000; this.hello(); this.setStatus("connected"); };
    ws.onmessage = (event) => void this.handle(String(event.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.settings.enabled) { this.setStatus("off"); return; }
      // Keep trying: Colony may be restarting or the tailnet may be down.
      this.setStatus("offline");
      this.retry = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    };
  }

  private disconnect(status: NodeStatus) {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.hideIndicator();
    if (this.status !== status) this.setStatus(status);
  }

  /** Reconnect to a different server. */
  restart() {
    this.disconnect("off");
    this.sync();
  }

  private capabilities() {
    const s = this.settings;
    return [s.browser && "browser", s.screen && "screen", s.shell && "shell", s.files && "files", s.files && s.fullDisk && "fullDisk"].filter(Boolean);
  }

  private send(message: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private hello() {
    this.send({ method: "node/hello", params: { id: this.settings.id, name: this.settings.name, platform: process.platform, capabilities: this.capabilities() } });
  }

  private tools() {
    return Object.entries(NEEDS).filter(([, key]) => this.settings[key]).map(([name]) => ({ name, inputSchema: { type: "object" } }));
  }

  private async handle(raw: string) {
    let message: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Meta } };
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.id !== "number" || !message.method) return;
    const reply = (result: unknown) => this.send({ id: message.id, result });
    const fail = (error: string) => this.send({ id: message.id, error: { code: -32000, message: error } });
    if (message.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "colony-desktop", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: this.tools() });
    if (message.method !== "tools/call") return fail(`Unknown method ${message.method}`);
    const name = message.params?.name ?? "";
    const args = message.params?.arguments ?? {};
    // Checked on every call, whatever the server thinks is on.
    const needs = NEEDS[name];
    if (!needs || !this.settings[needs]) return reply({ isError: true, content: [{ type: "text", text: "That's switched off on this PC." }] });
    // "Luke (Andrew's) is using this PC" when it's someone else's Bot.
    const meta = message.params?._meta;
    this.showIndicator(meta?.ownerName ? `${meta.botName ?? "A Bot"} (${meta.ownerName}'s)` : meta?.botName ?? "A Bot");
    this.busy++;
    try {
      reply({ content: await this.run(name, args, message.params?._meta ?? {}) });
    } catch (error) {
      reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
    } finally {
      this.busy--;
      this.scheduleHide();
    }
  }

  private async run(name: string, args: Record<string, unknown>, meta: Meta): Promise<Content[]> {
    const text = (value: string): Content[] => [{ type: "text", text: value }];
    switch (name) {
      case "pc_browser_open": return text(await this.browserOpen(String(args.url ?? ""), meta.botName ?? "Bot"));
      case "pc_browser_read": return text(await this.browserRead(this.window(args.window)));
      case "pc_browser_click": return text(await this.browserClick(this.window(args.window), args.text as string | undefined, args.selector as string | undefined));
      case "pc_browser_type": return text(await this.browserType(this.window(args.window), String(args.text ?? ""), args.selector as string | undefined, Boolean(args.submit)));
      case "pc_screenshot": return this.screenshot();
      case "pc_shell": return text(await this.shell(String(args.command ?? "")));
      case "pc_list_files": return text(await this.listFiles(String(args.path ?? ".")));
      case "pc_read_file": return text(await this.readFile(String(args.path ?? "")));
      case "pc_write_file": return text(await this.writeFile(String(args.path ?? ""), String(args.content ?? "")));
      default: throw new Error(`Unknown tool ${name}`);
    }
  }

  // ---------- Browser windows ----------
  private window(id: unknown) {
    const key = typeof id === "number" ? id : this.lastWindow;
    const win = key ? this.windows.get(key) : undefined;
    if (!win || win.isDestroyed()) throw new Error("That window is closed. Open the page again with pc_browser_open.");
    this.lastWindow = key;
    return { id: key!, win };
  }

  private async browserOpen(url: string, botName: string) {
    if (!/^https?:\/\//i.test(url)) throw new Error("Only web pages (http or https).");
    const id = this.nextWindow++;
    const win = new BrowserWindow({
      width: 1200, height: 860, show: false, autoHideMenuBar: true, title: `${botName} · Colony`,
      // Its own profile: logins made here stay here, apart from Colony itself.
      webPreferences: { partition: "persist:colony-pc", sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // Windows a Bot opens are labelled with its name.
    win.on("page-title-updated", (event, title) => { event.preventDefault(); win.setTitle(`${botName} · ${title}`); });
    win.webContents.setWindowOpenHandler(({ url: next }) => { void win.loadURL(next); return { action: "deny" }; });
    win.on("closed", () => this.windows.delete(id));
    this.windows.set(id, win);
    this.lastWindow = id;
    await win.loadURL(url);
    win.showInactive();
    return this.browserRead({ id, win });
  }

  private async browserRead({ id, win }: { id: number; win: BrowserWindow }) {
    await settle(win);
    const body = await win.webContents.executeJavaScript("document.body ? document.body.innerText : ''", true) as string;
    return `Window ${id} · ${win.webContents.getTitle()} · ${win.webContents.getURL()}\n\n${clip(body.replace(/\n{3,}/g, "\n\n").trim())}`;
  }

  private async browserClick(target: { id: number; win: BrowserWindow }, text?: string, selector?: string) {
    if (!text && !selector) throw new Error("Say what to click: its text or a CSS selector.");
    const clicked = await target.win.webContents.executeJavaScript(`(() => {
      const text = ${JSON.stringify(text ?? null)}, selector = ${JSON.stringify(selector ?? null)};
      let el = selector ? document.querySelector(selector) : null;
      if (!el && text) {
        const want = text.trim().toLowerCase();
        const candidates = [...document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit], input[type=button], label, summary')];
        const label = (node) => (node.innerText || node.value || node.getAttribute('aria-label') || '').trim().toLowerCase();
        el = candidates.find((node) => label(node) === want) || candidates.find((node) => label(node).includes(want));
      }
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`, true) as boolean;
    if (!clicked) throw new Error(`Couldn't find ${text ? `"${text}"` : selector} on the page.`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    return this.browserRead(target);
  }

  private async browserType(target: { id: number; win: BrowserWindow }, text: string, selector: string | undefined, submit: boolean) {
    const contents = target.win.webContents;
    if (selector) {
      const found = await contents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if ('select' in el) el.select(); return true; })()`, true) as boolean;
      if (!found) throw new Error(`Couldn't find ${selector} on the page.`);
    }
    await contents.insertText(text);
    if (submit) {
      contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      contents.sendInputEvent({ type: "char", keyCode: "\r" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.browserRead(target);
    }
    return `Typed into window ${target.id}.`;
  }

  // ---------- Screen ----------
  private async screenshot(): Promise<Content[]> {
    const display = screen.getPrimaryDisplay();
    const scale = Math.min(1, 1280 / display.size.width);
    const size = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
    // Hide the indicator so the Bot sees the screen, not its own border.
    this.indicator?.border.hide();
    this.indicator?.pill.hide();
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
      const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
      if (!source) throw new Error("Couldn't capture the screen.");
      return [
        { type: "text", text: `The screen (${size.width}×${size.height}).` },
        { type: "image", data: source.thumbnail.toJPEG(70).toString("base64"), mimeType: "image/jpeg" },
      ];
    } finally {
      this.indicator?.border.showInactive();
      this.indicator?.pill.showInactive();
    }
  }

  // ---------- Terminal ----------
  private shell(command: string) {
    const cwd = this.settings.shellFolder ?? os.homedir();
    const shellPath = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
    return new Promise<string>((resolve) => {
      exec(command, { cwd, shell: shellPath, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const output = [stdout.trim(), stderr.trim() && `stderr:\n${stderr.trim()}`].filter(Boolean).join("\n\n");
        resolve(`${error?.killed ? "Stopped after 2 minutes. " : ""}Exit code ${code} (in ${cwd})\n\n${clip(output || "(no output)")}`);
      });
    });
  }

  // ---------- Files ----------
  private resolvePath(input: string) {
    const home = os.homedir();
    const target = path.resolve(home, input.replace(/^~[\\/]?/, ""));
    const relative = path.relative(home, target);
    if (!this.settings.fullDisk && (relative.startsWith("..") || path.isAbsolute(relative))) {
      throw new Error("That's outside the home folder, and this PC only shares its home folder.");
    }
    return target;
  }

  private async listFiles(input: string) {
    const folder = this.resolvePath(input);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const lines = await Promise.all(entries.slice(0, 500).map(async (entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      const stat = await fs.stat(path.join(folder, entry.name)).catch(() => null);
      return `${entry.name}${stat ? `  ${stat.size.toLocaleString()} bytes` : ""}`;
    }));
    return `${folder}\n\n${lines.join("\n") || "(empty)"}${entries.length > 500 ? `\n… and ${entries.length - 500} more` : ""}`;
  }

  private async readFile(input: string) {
    const file = this.resolvePath(input);
    const stat = await fs.stat(file);
    if (stat.size > 1024 * 1024) throw new Error("That file is over 1 MB.");
    return clip(await fs.readFile(file, "utf8"), 200_000);
  }

  private async writeFile(input: string, content: string) {
    const file = this.resolvePath(input);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return `Wrote ${file}.`;
  }

  // ---------- "A Bot is using this PC" ----------
  private showIndicator(botName: string) {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    const area = screen.getPrimaryDisplay().workArea;
    if (!this.indicator || this.indicator.pill.isDestroyed()) {
      const overlay = { frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true };
      const border = new BrowserWindow({ ...overlay, ...area });
      border.setIgnoreMouseEvents(true);
      border.setAlwaysOnTop(true, "screen-saver");
      void border.loadURL(`data:text/html,${encodeURIComponent(BORDER_HTML)}`);
      const pill = new BrowserWindow({ ...overlay, width: 340, height: 52, x: Math.round(area.x + area.width / 2 - 170), y: area.y + area.height - 76 });
      pill.setAlwaysOnTop(true, "screen-saver");
      // The pill's Stop button navigates to colony-stop:, caught here.
      pill.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        if (url.startsWith("colony-stop:")) { this.send({ method: "node/stop" }); this.hideIndicator(); }
      });
      this.indicator = { border, pill };
    }
    const { border, pill } = this.indicator;
    void pill.loadURL(`data:text/html,${encodeURIComponent(pillHtml(botName))}`);
    border.showInactive();
    pill.showInactive();
  }

  /** Hides a few seconds after the Bot's last action, so a run of steps doesn't flicker. */
  private scheduleHide() {
    if (this.busy > 0) return;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideIndicator(), 6000);
  }

  private hideIndicator() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    if (!this.indicator) return;
    if (!this.indicator.border.isDestroyed()) this.indicator.border.destroy();
    if (!this.indicator.pill.isDestroyed()) this.indicator.pill.destroy();
    this.indicator = null;
  }
}

/** Waits for a page to finish loading (or 8 s). */
function settle(win: BrowserWindow) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 8000);
    win.webContents.once("did-stop-loading", () => { clearTimeout(timer); resolve(); });
  });
}

const BORDER_HTML = `<!doctype html><html><body style="margin:0;height:100vh;box-sizing:border-box;border:3px solid #7EE2B8;border-radius:10px;background:transparent"></body></html>`;

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pillHtml = (botName: string) => `<!doctype html><html><body style="margin:0;background:transparent;font:500 13px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="display:flex;align-items:center;gap:10px;background:#1f1f1f;color:#f3f3f3;border:1px solid #333;border-radius:999px;padding:6px 6px 6px 14px;box-shadow:0 6px 24px rgb(0 0 0/.35)">
<span style="width:8px;height:8px;border-radius:50%;background:#7EE2B8;box-shadow:0 0 0 4px rgb(126 226 184/.2)"></span>
<span>${escape(botName)} is using this PC</span>
<a href="colony-stop:" style="background:#F2726B;color:#fff;text-decoration:none;border-radius:999px;padding:6px 12px;font-weight:600">Stop</a>
</div></body></html>`;
