/** The desktop app's update state (desktop/src/main.ts). */
export type DesktopUpdate = {
  status: "unsupported" | "idle" | "checking" | "downloading" | "ready" | "current" | "error";
  version: string | null;
  progress: number | null;
  error: string | null;
};

/** What Colony's desktop app adds to the page (desktop/src/preload.ts). */
export type ColonyDesktop = {
  version: string;
  server: string | null;
  getUpdate: () => Promise<DesktopUpdate | null>;
  onUpdate: (listener: (state: DesktopUpdate) => void) => () => void;
  checkForUpdates: () => Promise<DesktopUpdate>;
  installUpdate: () => Promise<void>;
  changeServer: () => Promise<void>;
};

/** Set when Colony runs inside its desktop app. */
export const desktopApp = (window as unknown as { colonyDesktop?: ColonyDesktop }).colonyDesktop;
