import { isPublicWebUrl } from "@shared/urlPolicy";

export function isWebUrl(href: string | undefined): href is string {
  return Boolean(href && isPublicWebUrl(href));
}

/** Opens public http(s) links in a new tab. Anything else is ignored. */
export async function openExternal(href: string) {
  if (isWebUrl(href)) window.open(href, "_blank", "noopener,noreferrer");
}

export function hostname(href: string) {
  try { return new URL(href).hostname.replace(/^www\./, ""); } catch { return href; }
}
