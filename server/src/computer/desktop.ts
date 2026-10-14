import type { ComputerService } from "./docker.js";

// The Cua SDK sends anonymous usage data unless told not to; Colony never does.
process.env.DO_NOT_TRACK = "1";
process.env.CUA_TELEMETRY = "0";

type Spacesd = Awaited<ReturnType<ReturnType<typeof import("@trycua/cua").embedded>["spacesd"]>>;
type Connection = { url: string; token: string; client: Spacesd };

export type DesktopShot = { data: string; mediaType: "image/jpeg" | "image/png"; width: number; height: number };

/** The desktop's size. Screenshots and clicks share this pixel space (scale 1). */
export const SCREEN = { width: 1280, height: 800 };

// Models name keys the xdotool way ("Return", "ctrl+l", "Page_Down"); Cua takes these names.
const KEY_NAMES: Record<string, string> = {
  return: "enter", enter: "enter", kp_enter: "enter", escape: "escape", esc: "escape", backspace: "backspace",
  tab: "tab", space: "space", delete: "delete", del: "delete", insert: "insert", home: "home", end: "end",
  page_up: "pageup", pageup: "pageup", prior: "pageup", page_down: "pagedown", pagedown: "pagedown", next: "pagedown",
  up: "up", down: "down", left: "left", right: "right",
  ctrl: "ctrl", control: "ctrl", control_l: "ctrl", control_r: "ctrl", alt: "alt", alt_l: "alt", alt_r: "alt",
  shift: "shift", shift_l: "shift", shift_r: "shift", super: "cmd", super_l: "cmd", win: "cmd", meta: "cmd", cmd: "cmd",
};
export const keysOf = (combo: string) => combo.split("+").map((key) => key.trim()).filter(Boolean)
  .map((key) => KEY_NAMES[key.toLowerCase()] ?? (key.length === 1 ? key : key.toLowerCase()));

/**
 * Each Bot's desktop (Cua's Ubuntu + XFCE, served by cua-spacesd inside its computer):
 * screenshots, mouse and keyboard for the Bot, and short-lived viewer links for you.
 */
export class DesktopService {
  private connections = new Map<string, Promise<Connection>>();

  constructor(private computer: ComputerService) {}

  private async connect(botId: string): Promise<Connection> {
    const { url, token } = await this.computer.desktopEndpoint(botId);
    const { embedded } = await import("@trycua/cua");
    return { url, token, client: await embedded().spacesd(url, token) };
  }

  /** The Bot's desktop client; reconnects if the computer restarted on a new port. */
  private async client(botId: string) {
    let connection = this.connections.get(botId);
    if (!connection) {
      connection = this.connect(botId);
      this.connections.set(botId, connection);
      connection.catch(() => this.connections.delete(botId));
    }
    return (await connection).client;
  }

  private async withClient<T>(botId: string, action: (client: Spacesd) => Promise<T>): Promise<T> {
    this.computer.onUse(botId);
    try {
      return await action(await this.client(botId));
    } catch (error) {
      // A stopped or recreated computer: connect again once.
      this.connections.delete(botId);
      try { return await action(await this.client(botId)); } catch { throw error; }
    }
  }

  forget(botId: string) {
    this.connections.delete(botId);
  }

  async screenshot(botId: string): Promise<DesktopShot> {
    const shot = await this.withClient(botId, (client) => client.screenshot({ includeCursor: true, format: 1 /* JPEG */, quality: 80 } as never));
    return {
      data: Buffer.from(shot.image).toString("base64"),
      mediaType: shot.format === 1 ? "image/jpeg" : "image/png",
      width: shot.width,
      height: shot.height,
    };
  }

  /** A close-up of part of the screen (for small text), when the desktop supports region capture. */
  async zoom(botId: string, [x0, y0, x1, y1]: [number, number, number, number]): Promise<DesktopShot> {
    const region = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0) || 1, height: Math.abs(y1 - y0) || 1 };
    try {
      const answer = await this.withClient(botId, (client) => client.callJson("/cua.env.v1.ComputerService/Screenshot", JSON.stringify({ displayId: "primary", region, format: "IMAGE_FORMAT_JPEG", quality: 85, includeCursor: false })));
      const parsed = JSON.parse(answer) as { image?: string; imageSize?: { width?: number; height?: number } };
      if (parsed.image) return { data: parsed.image, mediaType: "image/jpeg", width: parsed.imageSize?.width ?? region.width, height: parsed.imageSize?.height ?? region.height };
    } catch { /* fall back to the whole screen */ }
    return this.screenshot(botId);
  }

  click(botId: string, x: number, y: number, button: "left" | "right" | "middle" = "left", count = 1) {
    return this.withClient(botId, async (client) => {
      if (button === "right") return void await client.rightClick(x, y);
      if (button === "left" && count === 2) return void await client.doubleClick(x, y);
      if (button === "left" && count === 1) return void await client.click(x, y);
      await client.pointerJson(JSON.stringify({
        target: { space: "COORDINATE_SPACE_SCREEN" },
        click: { position: { x, y }, button: button === "middle" ? "MOUSE_BUTTON_MIDDLE" : "MOUSE_BUTTON_LEFT", count },
      }));
    });
  }

  move(botId: string, x: number, y: number) {
    return this.withClient(botId, async (client) => void await client.moveTo(x, y));
  }

  drag(botId: string, from: [number, number], to: [number, number]) {
    return this.withClient(botId, async (client) => void await client.drag(from[0], from[1], to[0], to[1]));
  }

  mouseButton(botId: string, state: "down" | "up", x?: number, y?: number) {
    return this.withClient(botId, async (client) => void await client.pointerJson(JSON.stringify({
      target: { space: "COORDINATE_SPACE_SCREEN" },
      [state]: { ...(x !== undefined && y !== undefined ? { position: { x, y } } : {}), button: "MOUSE_BUTTON_LEFT" },
    })));
  }

  /** Scrolls by notches (one notch is a typical mouse-wheel step) at a point, if given. */
  scroll(botId: string, direction: "up" | "down" | "left" | "right", notches = 3, at?: [number, number]) {
    return this.withClient(botId, async (client) => {
      if (at) await client.moveTo(at[0], at[1]);
      const amount = Math.max(1, Math.min(30, notches)) * 100;
      await client.scroll(direction === "left" ? -amount : direction === "right" ? amount : 0, direction === "up" ? -amount : direction === "down" ? amount : 0);
    });
  }

  type(botId: string, text: string) {
    return this.withClient(botId, async (client) => void await client.typeText(text));
  }

  /** One key or a chord ("ctrl+l", "Return"), optionally repeated. */
  key(botId: string, combo: string, repeat = 1) {
    return this.withClient(botId, async (client) => {
      const keys = keysOf(combo);
      for (let i = 0; i < Math.max(1, Math.min(50, repeat)); i++) {
        if (keys.length === 1) await client.press(keys[0]);
        else await client.hotkey(keys);
      }
    });
  }

  holdKey(botId: string, combo: string, seconds: number) {
    return this.withClient(botId, async (client) => {
      const keys = keysOf(combo);
      for (const key of keys) await client.keyboardJson(JSON.stringify({ down: { key: { character: key.length === 1 ? key : undefined, named: key.length > 1 ? `KEY_${key.toUpperCase()}` : undefined } } }));
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(0, seconds)) * 1000));
      for (const key of [...keys].reverse()) await client.keyboardJson(JSON.stringify({ up: { key: { character: key.length === 1 ? key : undefined, named: key.length > 1 ? `KEY_${key.toUpperCase()}` : undefined } } }));
    });
  }

  async cursor(botId: string) {
    const position = await this.withClient(botId, (client) => client.cursorPosition()) as unknown as { x: number; y: number };
    return { x: Math.round(position.x), y: Math.round(position.y) };
  }

  /**
   * A viewer link for you: Cua's live desktop viewer, served through Colony under
   * /api/bots/<id>/screen/. The ticket lives in the URL fragment, which browsers never send.
   */
  async viewerLink(botId: string, { viewOnly = false } = {}) {
    const { url, token } = await this.computer.desktopEndpoint(botId);
    const { embedded } = await import("@trycua/cua");
    const sandbox = await embedded().sandboxes().connectUrl(url, token, `colony-${botId.slice(0, 8)}`);
    const link = await sandbox.viewerUrl({ ttlSeconds: 4 * 3600, viewOnly, clipboard: !viewOnly, filesRoot: "/workspace" } as never);
    const fragment = link.url.slice(link.url.indexOf("#"));
    return { url: `/api/bots/${botId}/screen/viewer/${fragment}`, expiresAt: Number(link.expiresAtUnix) * 1000 };
  }
}
