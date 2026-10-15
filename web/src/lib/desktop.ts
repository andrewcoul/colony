/** The desktop app's update state (desktop/src/main.ts). */
export type DesktopUpdate = {
  status: "unsupported" | "idle" | "checking" | "downloading" | "ready" | "current" | "error";
  version: string | null;
  progress: number | null;
  error: string | null;
};

/** This PC, lent to Bots (desktop/src/node.ts). */
export type NodeSettings = {
  enabled: boolean;
  id: string;
  name: string;
  browser: boolean;
  screen: boolean;
  shell: boolean;
  files: boolean;
  fullDisk: boolean;
  shellFolder: string | null;
};
export type NodeView = { settings: NodeSettings; status: "off" | "connecting" | "connected" | "offline"; home: string };

/** What Colony's desktop app adds to the page (desktop/src/preload.ts). */
export type ColonyDesktop = {
  version: string;
  server: string | null;
  getUpdate: () => Promise<DesktopUpdate | null>;
  onUpdate: (listener: (state: DesktopUpdate) => void) => () => void;
  checkForUpdates: () => Promise<DesktopUpdate>;
  installUpdate: () => Promise<void>;
  changeServer: () => Promise<void>;
  /** Missing in desktop apps from before This PC. */
  node?: {
    get: () => Promise<NodeView | null>;
    set: (patch: Partial<NodeSettings>) => Promise<NodeView | null>;
    pickFolder: () => Promise<NodeView | null>;
    onChange: (listener: (view: NodeView | null) => void) => () => void;
  };
};

/** Set when Colony runs inside its desktop app. */
export const desktopApp = (window as unknown as { colonyDesktop?: ColonyDesktop }).colonyDesktop;
