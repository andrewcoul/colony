/*
 * Email from Colony itself (invites, password resets, sign-in codes), sent through Resend's HTTP API
 * (POST https://api.resend.com/emails). Off unless RESEND_API_KEY is set; then invites show their
 * link to copy instead. The key is only ever sent to Resend, never logged or returned.
 */

export type Mail = { to: string; subject: string; text: string; html?: string };
/** Sends one email as `from` (tests pass a fake that records it). */
export type MailTransport = (mail: Mail & { from: string }) => Promise<void>;

export const DEFAULT_FROM = "Colony <colony@auth.werdna.xyz>";

/** Resend's HTTP API, with this key. Its errors say what Resend said, never the key. */
export function resendTransport(apiKey: string, fetcher: typeof fetch = fetch): MailTransport {
  return async ({ from, to, subject, text, html }) => {
    let response: Response;
    try {
      response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`Couldn't reach Resend (${error instanceof Error ? error.name : "network error"}).`);
    }
    if (response.ok) return;
    const said = await response.json().then((body) => { const text = (body as { message?: unknown })?.message; return typeof text === "string" ? text : ""; }, () => "");
    throw new Error(`Resend didn't send it (${response.status}${said ? `: ${said.replaceAll(apiKey, "…").slice(0, 200)}` : ""}).`);
  };
}

export class Mailer {
  constructor(private transport: MailTransport | null, readonly from = DEFAULT_FROM) {}

  /** Whether Colony can send email (RESEND_API_KEY is set). */
  get enabled() { return this.transport !== null; }

  async send(mail: Mail) {
    if (!this.transport) throw new Error("Email isn't set up on this Colony (RESEND_API_KEY).");
    await this.transport({ ...mail, from: this.from });
  }
}

/** The mailer the environment asks for: Resend when RESEND_API_KEY is set, otherwise none. */
export function mailerFromEnv(env: Record<string, string | undefined> = process.env, fetcher?: typeof fetch) {
  const key = env.RESEND_API_KEY?.trim();
  return new Mailer(key ? resendTransport(key, fetcher) : null, env.COLONY_MAIL_FROM?.trim() || DEFAULT_FROM);
}

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** A short email with one link in it. */
export function linkMail(to: string, { subject, intro, action, link, outro }: { subject: string; intro: string; action: string; link: string; outro: string }): Mail {
  return {
    to, subject,
    text: `${intro}\n\n${action}: ${link}\n\n${outro}\n`,
    html: `<p>${escape(intro)}</p><p><a href="${escape(link)}">${escape(action)}</a></p><p style="color:#666">${escape(outro)}</p>`,
  };
}

/** The invite email. */
export const inviteMail = (to: string, link: string, days: number) => linkMail(to, {
  subject: "You're invited to Colony",
  intro: "You've been invited to Colony, where you'll have your own AI teammates (Bots).",
  action: "Create your account", link,
  outro: `This link works once, for ${to}, for ${days} day${days === 1 ? "" : "s"}. If you weren't expecting it, ignore this email.`,
});
