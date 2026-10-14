/**
 * Secret values Colony typed into a page during one run (passwords, one-time codes). Every
 * tool result and error passes through here on its way to the model and the step log, so a
 * page that echoes a secret back never puts it in front of the model.
 *
 * A second line of defence: tools never return secrets in the first place.
 */
export class Scrubber {
  private secrets: string[] = [];

  add(value: string | null | undefined) {
    // Very short values would blank out ordinary words.
    if (!value || value.length < 4 || this.secrets.includes(value)) return;
    this.secrets.push(value);
    this.secrets.sort((a, b) => b.length - a.length);
  }

  text(value: string): string {
    let out = value;
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join("[secret]");
    return out;
  }

  /** Scrubs every string inside a tool result. */
  deep<T>(value: T): T {
    if (!this.secrets.length) return value;
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.deep(item)) as T;
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.deep(item)])) as T;
    }
    return value;
  }
}
