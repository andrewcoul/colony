import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { isPublicWebUrl } from "../shared/urlPolicy.js";
import type { ComputerService } from "./docker.js";

export const VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 412, height: 780 };

export type PageSnapshot = { url: string; title: string; elements: string[]; text: string };
export type BrowserEvent =
  | { type: "frame"; data: string; url: string; width: number; height: number }
  | { type: "open"; url: string }
  | { type: "closed" };
export type UserInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  /** Phone-sized while you take over from a phone, so sites show their mobile layout. */
  | { type: "viewport"; mobile: boolean };
/** What an element does, so risky clicks can wait for approval. */
export type ElementIntent = { label: string; posts: boolean; risky: boolean; host: string };

type Session = { browser: Browser; page: Page };

/** Bots may only browse the public web; your PC and network stay off-limits. */
const allowed = (url: string) => /^(about|data|blob):/i.test(url) || isPublicWebUrl(url);

const KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"]);

// The scripts below run inside the page. They're plain JavaScript strings on purpose: the dev
// server compiles TypeScript functions with helpers (like __name) that don't exist in the page.

/** Numbers the visible interactive elements (data-colony-ref="e1"…) and returns them with the page text. */
const SNAPSHOT = String.raw`(() => {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  for (const el of document.querySelectorAll("[data-colony-ref]")) el.removeAttribute("data-colony-ref");
  const selector = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [contenteditable=''], [contenteditable=true]";
  const elements = [];
  let count = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (count >= 150) break;
    if (!visible(el)) continue;
    const ref = "e" + (++count);
    el.setAttribute("data-colony-ref", ref);
    const tag = el.tagName.toLowerCase();
    const field = tag === "input" || tag === "textarea";
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? "input " + (el.type || "text") : tag);
    const label = (el.getAttribute("aria-label") || el.innerText || (tag === "input" && el.type !== "password" ? el.value : "") || el.placeholder || el.title || el.getAttribute("name") || "")
      .replace(/\s+/g, " ").trim().slice(0, 80);
    let extra = "";
    if (field && el.value && el.type !== "password") extra += ' value="' + el.value.slice(0, 40) + '"';
    if (field && el.placeholder) extra += ' placeholder="' + el.placeholder.slice(0, 40) + '"';
    if (tag === "a") extra += " → " + (el.getAttribute("href") || "").slice(0, 80);
    elements.push("[" + ref + "] " + role + ' "' + label + '"' + extra);
  }
  const text = ((document.body && document.body.innerText) || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
  return { elements, text };
})()`;

/** Would acting on this element send something? (form POST, or a label like Send/Buy/Delete) */
const intentScript = (ref: string, submit: boolean) => String.raw`((el, submit) => {
  if (!el) return null;
  const form = el.form || el.closest("form");
  const type = (el.getAttribute("type") || "").toLowerCase();
  const tag = el.tagName.toLowerCase();
  const submits = submit || type === "submit" || (tag === "button" && !type && Boolean(form));
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    label,
    posts: Boolean(submits && form && (form.getAttribute("method") || "get").toLowerCase() === "post"),
    risky: /\b(send|post|publish|submit|buy|purchase|pay|place order|checkout|delete|remove|confirm|tweet|reply|share|transfer|subscribe|sign up|register)\b/i.test(label),
    host: location.hostname,
  };
})(document.querySelector('[data-colony-ref="${ref}"]'), ${submit})`;

/**
 * Drives each Bot's Chromium (running inside its computer) over the DevTools protocol,
 * streams a live screencast to whoever is watching, and forwards your input on takeover.
 */
export class BrowserService {
  private sessions = new Map<string, Promise<Session>>();
  private live = new Map<string, Session>();
  private watchers = new Map<string, Set<(event: BrowserEvent) => void>>();
  private casts = new Map<string, { cdp: CDPSession; page: Page }>();

  constructor(private computer: ComputerService) {}

  isOpen(botId: string) {
    return this.live.has(botId);
  }

  currentUrl(botId: string) {
    return this.live.get(botId)?.page.url() ?? null;
  }

  /** Connects to the Bot's browser, starting its computer and Chromium if needed. */
  open(botId: string): Promise<Session> {
    let session = this.sessions.get(botId);
    if (!session) {
      session = this.connect(botId);
      this.sessions.set(botId, session);
      session.catch(() => this.sessions.delete(botId));
    }
    return session;
  }

  private async connect(botId: string): Promise<Session> {
    const endpoint = await this.computer.browserEndpoint(botId);
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
    const context = browser.contexts()[0] ?? await browser.newContext();
    await context.route("**/*", (route) => (allowed(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
    const session: Session = { browser, page: context.pages()[0] ?? await context.newPage() };
    await session.page.setViewportSize(VIEWPORT);
    // New tabs (target=_blank, popups) become the page the Bot and you are looking at.
    context.on("page", (page) => {
      session.page = page;
      void page.setViewportSize(VIEWPORT).catch(() => {});
      page.on("close", () => {
        const pages = context.pages();
        if (session.page === page && pages.length) { session.page = pages.at(-1)!; void this.restartCast(botId); }
      });
      void this.restartCast(botId);
    });
    browser.on("disconnected", () => {
      this.sessions.delete(botId);
      this.live.delete(botId);
      this.casts.delete(botId);
      this.emit(botId, { type: "closed" });
    });
    this.live.set(botId, session);
    this.emit(botId, { type: "open", url: session.page.url() });
    if (this.watchers.get(botId)?.size) void this.startCast(botId);
    return session;
  }

  /** Disconnects (e.g. before the computer stops). Chromium itself stops with the container. */
  async close(botId: string) {
    const session = this.live.get(botId);
    this.sessions.delete(botId);
    this.live.delete(botId);
    this.casts.delete(botId);
    await session?.browser.close().catch(() => {});
  }

  // ---------- What the Bot does ----------
  async snapshot(botId: string): Promise<PageSnapshot> {
    const { page } = await this.open(botId);
    let result: { elements: string[]; text: string };
    try {
      result = await page.evaluate<{ elements: string[]; text: string }>(SNAPSHOT);
    } catch {
      // Usually the page was mid-navigation; read it once it has settled.
      await settle(page);
      result = await page.evaluate<{ elements: string[]; text: string }>(SNAPSHOT);
    }
    return { url: page.url(), title: await page.title().catch(() => ""), ...result };
  }

  async goto(botId: string, url: string) {
    if (!allowed(url)) throw new Error("Only public http(s) pages can be opened.");
    const { page } = await this.open(botId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await settle(page);
  }

  /** Describes what acting on an element would do, for the approval check. */
  async intent(botId: string, ref: string, submit = false): Promise<ElementIntent> {
    await this.element(botId, ref); // Clear error if the ref is stale.
    const { page } = await this.open(botId);
    const intent = await page.evaluate<ElementIntent | null>(intentScript(ref, submit));
    if (!intent) throw new Error(`Element ${ref} is no longer on the page; call browser_read for fresh refs.`);
    return intent;
  }

  async click(botId: string, ref: string) {
    const element = await this.element(botId, ref);
    await element.click({ timeout: 10_000 });
    await settle((await this.open(botId)).page);
  }

  async type(botId: string, ref: string, text: string, submit: boolean) {
    const element = await this.element(botId, ref);
    const { page } = await this.open(botId);
    await element.fill(text, { timeout: 10_000 }).catch(async () => {
      await element.click({ timeout: 10_000 });
      await page.keyboard.type(text, { delay: 10 });
    });
    if (submit) { await element.press("Enter"); await settle(page); }
  }

  async press(botId: string, key: string) {
    const { page } = await this.open(botId);
    await page.keyboard.press(key === "Space" ? " " : key);
    await settle(page);
  }

  async scroll(botId: string, direction: "up" | "down") {
    const { page } = await this.open(botId);
    await page.mouse.wheel(0, direction === "down" ? 700 : -700);
    await page.waitForTimeout(300);
  }

  async back(botId: string) {
    const { page } = await this.open(botId);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await settle(page);
  }

  private async element(botId: string, ref: string) {
    const { page } = await this.open(botId);
    if (!/^e\d+$/.test(ref)) throw new Error(`"${ref}" isn't an element ref; use one like e12 from browser_read.`);
    const element = page.locator(`[data-colony-ref="${ref}"]`).first();
    if (!(await element.count())) throw new Error(`Element ${ref} is no longer on the page; call browser_read for fresh refs.`);
    return element;
  }

  // ---------- What you see and do ----------
  /** Live frames for one viewer. Starts the screencast for the first viewer, stops after the last. */
  watch(botId: string, listener: (event: BrowserEvent) => void) {
    const set = this.watchers.get(botId) ?? new Set();
    set.add(listener);
    this.watchers.set(botId, set);
    if (this.live.has(botId)) void this.startCast(botId);
    return () => {
      set.delete(listener);
      if (set.size === 0) { this.watchers.delete(botId); void this.stopCast(botId); }
    };
  }

  /** Your taps and typing during takeover. Coordinates are 0–1 across the frame. */
  async input(botId: string, input: UserInput) {
    const { page } = await this.open(botId);
    switch (input.type) {
      case "click": {
        const size = page.viewportSize() ?? VIEWPORT;
        await page.mouse.click(clamp(input.x) * size.width, clamp(input.y) * size.height);
        break;
      }
      case "viewport": await page.setViewportSize(input.mobile ? MOBILE_VIEWPORT : VIEWPORT); break;
      case "type": await page.keyboard.type(input.text, { delay: 15 }); break;
      case "key": if (KEYS.has(input.key)) await page.keyboard.press(input.key === "Space" ? " " : input.key); break;
      case "scroll": await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, input.dy))); break;
      case "navigate": await this.goto(botId, /^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`); break;
      case "back": await page.goBack({ timeout: 15_000 }).catch(() => {}); break;
    }
  }

  private emit(botId: string, event: BrowserEvent) {
    for (const listener of this.watchers.get(botId) ?? []) listener(event);
  }

  private async startCast(botId: string) {
    const session = this.live.get(botId);
    if (!session || this.casts.has(botId)) return;
    const page = session.page;
    const cdp = await page.context().newCDPSession(page);
    this.casts.set(botId, { cdp, page });
    cdp.on("Page.screencastFrame", (frame) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      this.emit(botId, { type: "frame", data: frame.data, url: page.url(), width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 }).catch(() => this.casts.delete(botId));
  }

  private async stopCast(botId: string) {
    const cast = this.casts.get(botId);
    this.casts.delete(botId);
    await cast?.cdp.send("Page.stopScreencast").catch(() => {});
    await cast?.cdp.detach().catch(() => {});
  }

  private async restartCast(botId: string) {
    if (!this.casts.has(botId)) return;
    await this.stopCast(botId);
    if (this.watchers.get(botId)?.size) await this.startCast(botId);
  }
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Gives a page a moment to react: navigation, then a short quiet period. */
async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
}
