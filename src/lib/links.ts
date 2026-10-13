import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPublicWebUrl } from "../../convex/urlPolicy";

export function isWebUrl(href: string | undefined): href is string {
  return Boolean(href && isPublicWebUrl(href));
}

/** Opens public http(s) links in the system browser. Anything else is ignored. */
export async function openExternal(href: string) {
  if (!isWebUrl(href)) return;
  if (isTauri()) await openUrl(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

export function hostname(href: string) {
  try { return new URL(href).hostname.replace(/^www\./, ""); } catch { return href; }
}

/** Web search runs through the desktop app (or the Vite dev proxy). */
export const searchAvailable = isTauri() || import.meta.env.DEV;
