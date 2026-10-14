// What the desktop app offers Colony's web page (window.colonyDesktop): its version, its
// updates, and switching servers. The main process only answers Colony and the connect page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Info = { version: string; server: string | null } | null;
const info = ipcRenderer.sendSync("colony:info") as Info;

if (info) {
  contextBridge.exposeInMainWorld("colonyDesktop", {
    version: info.version,
    server: info.server,
    getUpdate: () => ipcRenderer.invoke("colony:update:get"),
    onUpdate: (listener: (state: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
      ipcRenderer.on("colony:update", handler);
      return () => { ipcRenderer.removeListener("colony:update", handler); };
    },
    checkForUpdates: () => ipcRenderer.invoke("colony:update:check"),
    installUpdate: () => ipcRenderer.invoke("colony:update:install"),
    changeServer: () => ipcRenderer.invoke("colony:server:change"),
    connect: (address: string) => ipcRenderer.invoke("colony:connect", address) as Promise<{ error?: string }>,
  });
}
