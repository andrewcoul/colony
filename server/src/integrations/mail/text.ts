const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™" };

export function decodeEntities(text: string) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Email HTML → readable plain text: paragraphs and list items kept, links as "text (url)". */
export function htmlToText(html: string) {
  const text = html
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return !label || label === href || href.startsWith("mailto:") ? label || href.replace(/^mailto:/, "") : `${label} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article)>/gi, "\n\n")
    .replace(/<\/td>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keeps a body to a size a model can read, noting what was cut. */
export function clip(text: string, max = 20_000) {
  return text.length > max ? `${text.slice(0, max)}\n\n[… ${text.length - max} more characters not shown]` : text;
}

/** Splits an address header ("A <a@x.com>, b@y.com") into addresses, respecting quoted names. */
export function splitAddresses(header: string) {
  return (header.match(/(?:"[^"]*"|[^,])+/g) ?? []).map((part) => part.trim()).filter(Boolean);
}

/** Just the address from "Name <a@x.com>". */
export const bareAddress = (value: string) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();

/** Local YYYY-MM-DD → a Date at local midnight. */
export function localDay(day: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) throw new Error(`Couldn't read the date "${day}". Use YYYY-MM-DD.`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** A Date's local YYYY-MM-DD. */
export const ymd = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** The day before a YYYY-MM-DD (calendars store all-day events as ending the day after). */
export const dayBefore = (day: string) => { const date = localDay(day); return ymd(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1)); };
