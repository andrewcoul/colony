import { useSyncExternalStore } from "react";
import { api, type SystemInfo } from "./api";
import { desktopApp, type DesktopUpdate } from "./desktop";

/** The version of this page's build. After the server updates, open pages are a version behind. */
export const WEB_VERSION = __COLONY_VERSION__;

export type UpdatesState = {
  system: SystemInfo | null;
  desktop: DesktopUpdate | null;
  /** The server is restarting into this version; the page reloads once it's back. */
  waitingFor: string | null;
  error: string;
};

let state: UpdatesState = { system: null, desktop: null, waitingFor: null, error: "" };
const listeners = new Set<() => void>();
function set(next: Partial<UpdatesState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const useUpdates = () => useSyncExternalStore(subscribe, () => state);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inProgress = (info: SystemInfo) => ["downloading", "installing", "restarting"].includes(info.update.status);

/** What's worth a nudge: a server update, a desktop update ready to install, or a stale page. */
export function pending(current: UpdatesState) {
  const { system, desktop } = current;
  return {
    server: Boolean(system?.managed && system.available),
    desktop: desktop?.status === "ready",
    reload: Boolean(system && system.version !== WEB_VERSION && !current.waitingFor),
  };
}

let lastRefresh = 0;
async function refresh() {
  lastRefresh = Date.now();
  try {
    const info = await api.system();
    set({ system: info });
    if (inProgress(info) && !state.waitingFor && info.update.target) void follow(info.update.target);
  } catch { /* an older server, or it's restarting */ }
}

let started = false;
/** Keeps update news current: now, every half hour, and when you come back to the app. */
export function startUpdates() {
  if (started) return;
  started = true;
  void refresh();
  setInterval(() => void refresh(), 30 * 60_000);
  window.addEventListener("focus", () => { if (Date.now() - lastRefresh > 5 * 60_000) void refresh(); });
  if (desktopApp) {
    void desktopApp.getUpdate().then((desktop) => set({ desktop }));
    desktopApp.onUpdate((desktop) => set({ desktop }));
  }
}

export async function checkNow() {
  set({ error: "" });
  if (desktopApp) void desktopApp.checkForUpdates().then((desktop) => set({ desktop }));
  try { set({ system: await api.checkUpdates() }); } catch (failure) { set({ error: failure instanceof Error ? failure.message : "Couldn't check for updates." }); }
}

/** Starts the server update. Returns who's busy if Bots are mid-reply (ask, then force). */
export async function updateServer(force = false): Promise<{ busy: string[]; message: string } | null> {
  set({ error: "" });
  try {
    const result = await api.updateServer(force);
    if ("busy" in result) return result;
    set({ system: result });
    if (result.update.target) void follow(result.update.target);
  } catch (failure) {
    set({ error: failure instanceof Error ? failure.message : "Couldn't update." });
  }
  return null;
}

/** Waits while the server downloads, installs and restarts, then loads the new version. */
async function follow(target: string) {
  set({ waitingFor: target });
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    await sleep(1500);
    let info: SystemInfo;
    try { info = await api.system(); } catch { continue; } // Restarting.
    if (info.version === target) { window.location.reload(); return; }
    set({ system: info });
    if (info.update.status === "failed") { set({ waitingFor: null, error: info.update.error ?? "The update failed." }); return; }
    // Back on the old version: the new one didn't start, so the launcher went back.
    if (!inProgress(info) && info.failed?.version === target) { set({ waitingFor: null }); return; }
  }
  set({ waitingFor: null, error: "Colony hasn't come back yet. Check the computer it runs on." });
}
