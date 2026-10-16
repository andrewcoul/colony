// Colony's desktop app: a window onto your Colony server (on this PC, or another one over
// Tailscale), with updates from GitHub Releases. The app itself is served by the server, so it
// always matches the server's version; this shell only handles connecting and updating.
import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from "electron";
import { autoUpdater } from "electron-updater";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultNodeSettings, PcNode, type NodeSettings } from "./node.js";

type Config = { server: string | null; bounds?: Rectangle; maximized?: boolean; node?: NodeSettings };
type UpdateState = {
  status: "unsupported" | "idle" | "checking" | "downloading" | "ready" | "current" | "error";
  version: string | null;
  progress: number | null;
  error: string | null;
};

// A dev copy (e.g. against a test server) keeps its settings apart from the real app's.
if (process.env.COLONY_DESKTOP_DATA) app.setPath("userData", path.resolve(process.env.COLONY_DESKTOP_DATA));

/** Where a Colony on this PC listens by default. */
const LOCAL = "http://127.0.0.1:8787";
const CONNECT_PAGE = pathToFileURL(path.join(__dirname, "..", "connect.html")).href;
const CHECK_EVERY = 60 * 60_000;

let config: Config = { server: null };
let win: BrowserWindow | null = null;
let update: UpdateState = { status: app.isPackaged ? "idle" : "unsupported", version: null, progress: null, error: null };
/** This PC, lent to Bots (Settings › This PC). */
let node: PcNode | null = null;
const nodeView = () => (node ? { settings: node.settings, status: node.status, home: app.getPath("home") } : null);

const configFile = () => path.join(app.getPath("userData"), "config.json");
function loadConfig(): Config {
  try { return { server: null, ...JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<Config> }; } catch { return { server: null }; }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

/** "my-pc.tailnet.ts.net" or "http://127.0.0.1:8787/" → an origin. */
function normalize(input: string) {
  const text = input.trim();
  const url = new URL(/^https?:\/\//i.test(text) ? text : `${/\.ts\.net\b/i.test(text) ? "https" : "http"}://${text}`);
  return url.origin;
}

const sameOrigin = (url: string, origin: string | null) => {
  if (!origin) return false;
  try { return new URL(url).origin === origin; } catch { return false; }
};
const isConnectPage = (url: string) => url.split(/[?#]/)[0] === CONNECT_PAGE;
const allowed = (url: string) => isConnectPage(url) || sameOrigin(url, config.server);
/** IPC only answers the main window, and only while it shows Colony or the connect page. */
const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === win?.webContents && allowed(event.senderFrame?.url ?? "");

/** Null if Colony answers at `origin`, otherwise why not. */
async function probe(origin: string): Promise<string | null> {
  try {
    const response = await net.fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(6000) });
    if (response.ok && (response.headers.get("content-type") ?? "").includes("json")) return null;
    if (response.status === 403) return `${origin} turned this device away: it belongs to another Tailscale login. Sign in to Tailscale as its owner, or add your login to COLONY_ALLOWED_USERS on that PC.`;
    return `Something answered at ${origin}, but it isn't Colony (${response.status}).`;
  } catch {
    return `Couldn't reach Colony at ${origin}. Check that it's running, and that this PC is on your tailnet if it's on another computer.`;
  }
}

function showConnect(error?: string) {
  const query = new URLSearchParams({ server: config.server ?? LOCAL, error: error ?? "", version: app.getVersion() });
  void win?.loadURL(`${CONNECT_PAGE}?${query}`);
}

function openServer() {
  if (config.server) void win?.loadURL(config.server);
}

function createWindow() {
  const bounds = config.bounds;
  win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 380,
    minHeight: 500,
    title: "Colony",
    backgroundColor: "#141414",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (config.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());

  const contents = win.webContents;
  contents.on("will-navigate", (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    // Colony's own pages (e.g. a Bot's screen in its own window) open here; links out open in the browser.
    if (sameOrigin(url, config.server)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#141414" } };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && sameOrigin(url, config.server)) showConnect(`Couldn't reach Colony at ${config.server} (${description}).`);
  });
  // Pass update news to the page whenever it (re)loads.
  contents.on("did-finish-load", () => { contents.send("colony:update", update); contents.send("colony:node", nodeView()); });

  win.on("close", () => {
    if (!win) return;
    config.maximized = win.isMaximized();
    if (!config.maximized) config.bounds = win.getBounds();
    saveConfig();
  });
  // Closing Colony closes the windows Bots opened on this PC too.
  win.on("closed", () => { win = null; app.quit(); });
}

// ---------- Updates (electron-updater reads latest.yml from the latest GitHub release) ----------
function setUpdate(next: Partial<UpdateState>) {
  update = { ...update, ...next };
  win?.webContents.send("colony:update", update);
}

function checkForUpdates() {
  if (!app.isPackaged || update.status === "downloading" || update.status === "ready") return;
  autoUpdater.checkForUpdates().catch(() => { /* reported through the "error" event */ });
}

function setupUpdates() {
  if (!app.isPackaged) return; // Running from source: nothing to update.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => setUpdate({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) => setUpdate({ status: "downloading", version: info.version, progress: 0 }));
  autoUpdater.on("download-progress", (progress) => setUpdate({ status: "downloading", progress: progress.percent / 100 }));
  autoUpdater.on("update-downloaded", (info) => setUpdate({ status: "ready", version: info.version, progress: null }));
  autoUpdater.on("update-not-available", () => setUpdate({ status: "current", version: null, progress: null }));
  autoUpdater.on("error", (error) => setUpdate({ status: "error", progress: null, error: (error?.message ?? String(error)).split("\n")[0].slice(0, 200) }));
  setTimeout(checkForUpdates, 15_000);
  setInterval(checkForUpdates, CHECK_EVERY);
}

ipcMain.on("colony:info", (event) => {
  event.returnValue = trusted(event) ? { version: app.getVersion(), server: config.server } : null;
});
ipcMain.handle("colony:update:get", (event) => (trusted(event) ? update : null));
ipcMain.handle("colony:update:check", (event) => {
  if (trusted(event)) checkForUpdates();
  return update;
});
ipcMain.handle("colony:update:install", (event) => {
  if (trusted(event) && update.status === "ready") setImmediate(() => autoUpdater.quitAndInstall(true, true));
});
ipcMain.handle("colony:node:get", (event) => (trusted(event) ? nodeView() : null));
ipcMain.handle("colony:node:set", (event, patch: unknown) => {
  if (!trusted(event) || !node || !patch || typeof patch !== "object") return nodeView();
  const input = patch as Partial<NodeSettings>;
  const next: Partial<NodeSettings> = {};
  for (const key of ["enabled", "browser", "screen", "shell", "files", "fullDisk"] as const) if (typeof input[key] === "boolean") next[key] = input[key];
  if (typeof input.name === "string" && input.name.trim()) next.name = input.name.trim().slice(0, 60);
  if (input.shellFolder === null) next.shellFolder = null;
  node.update(next);
  return nodeView();
});
/** Picks the folder terminal commands run in (a native dialog, so the page never names a path). */
ipcMain.handle("colony:node:folder", async (event) => {
  if (!trusted(event) || !node || !win) return nodeView();
  const picked = await dialog.showOpenDialog(win, { title: "Folder for Bots' terminal commands", properties: ["openDirectory", "createDirectory"], defaultPath: node.settings.shellFolder ?? app.getPath("home") });
  if (!picked.canceled && picked.filePaths[0]) node.update({ shellFolder: picked.filePaths[0] });
  return nodeView();
});
ipcMain.handle("colony:server:change", (event) => {
  if (trusted(event)) showConnect();
});
ipcMain.handle("colony:connect", async (event, input: unknown) => {
  if (!trusted(event) || typeof input !== "string") return { error: "Not allowed." };
  let origin: string;
  try { origin = normalize(input); } catch { return { error: "That doesn't look like an address." }; }
  const problem = await probe(origin);
  if (problem) return { error: problem };
  config.server = origin;
  saveConfig();
  openServer();
  node?.restart();
  return {};
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(async () => {
    config = loadConfig();
    // Colony's own pages may show notifications and use the clipboard; nothing else.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"].includes(permission) && sameOrigin(details.requestingUrl, config.server));
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Colony", submenu: [
        { label: "Change server…", click: () => showConnect() },
        { label: "Check for updates", click: () => checkForUpdates(), enabled: app.isPackaged },
        { type: "separator" },
        { role: "quit" },
      ] },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]));
    createWindow();
    // First run: if Colony is on this PC, go straight to it.
    if (!config.server && !(await probe(LOCAL))) { config.server = LOCAL; saveConfig(); }
    if (config.server) openServer();
    else showConnect();
    setupUpdates();
    config.node = { ...defaultNodeSettings(), ...config.node };
    saveConfig();
    node = new PcNode(() => config.server, config.node, (settings) => {
      config.node = settings;
      saveConfig();
      win?.webContents.send("colony:node", nodeView());
    });
    node.sync();
  });

  app.on("window-all-closed", () => app.quit());
}
