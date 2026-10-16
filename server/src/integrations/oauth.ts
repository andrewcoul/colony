import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Account } from "../shared/types.js";
import type { Accounts } from "./accounts.js";
import { callApi, postForm, ReauthError, type Fetch } from "./http.js";

export const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  gmailScope: "https://www.googleapis.com/auth/gmail.modify",
  calendarScope: "https://www.googleapis.com/auth/calendar.events",
};
const GOOGLE_SCOPES = ["openid", "email", GOOGLE.gmailScope, GOOGLE.calendarScope];

export const MICROSOFT = {
  base: "https://login.microsoftonline.com/common/oauth2/v2.0",
  scopes: "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite",
};

/** How long a sign-in waits for you to finish it. */
const SESSION_MS = 15 * 60_000;

/**
 * Access tokens for connected Google and Microsoft accounts, refreshed shortly before they
 * expire. A refresh token that stops working marks the account for reconnecting.
 */
export class Tokens {
  private cache = new Map<string, { token: string; expiresAt: number }>();
  private pending = new Map<string, Promise<string>>();

  constructor(private accounts: Accounts, private fetchImpl: Fetch = fetch) {}

  get(accountId: string): Promise<string> {
    const cached = this.cache.get(accountId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return Promise.resolve(cached.token);
    // One refresh at a time per account: Microsoft rotates refresh tokens on use.
    let refresh = this.pending.get(accountId);
    if (!refresh) {
      refresh = this.refresh(accountId).finally(() => this.pending.delete(accountId));
      this.pending.set(accountId, refresh);
    }
    return refresh;
  }

  /** Remembers a token from a sign-in so the first call doesn't refresh. */
  seed(accountId: string, token: string, expiresIn: number) {
    this.cache.set(accountId, { token, expiresAt: Date.now() + expiresIn * 1000 });
  }

  forget(accountId: string) {
    this.cache.delete(accountId);
  }

  private async refresh(accountId: string): Promise<string> {
    const account = this.accounts.get(accountId);
    const secret = this.accounts.secret(accountId);
    if (!account || !secret || secret.kind === "onepassword") throw new Error("That account isn't connected.");
    if (account.status === "needs_reauth") throw new ReauthError(reconnectMessage(account));
    const answer = secret.kind === "google"
      ? await postForm(this.fetchImpl, GOOGLE.token, { grant_type: "refresh_token", client_id: secret.clientId, client_secret: secret.clientSecret, refresh_token: secret.refreshToken })
      : await postForm(this.fetchImpl, `${MICROSOFT.base}/token`, { grant_type: "refresh_token", client_id: secret.clientId, refresh_token: secret.refreshToken, scope: MICROSOFT.scopes });
    if (!answer.ok) {
      // invalid_grant: expired, revoked, or the password changed. Anything else may be temporary.
      if (answer.body.error === "invalid_grant" || answer.body.error === "unauthorized_client" || answer.body.error === "invalid_client") {
        this.accounts.setStatus(accountId, "needs_reauth");
        throw new ReauthError(reconnectMessage(account));
      }
      throw new Error(`Couldn't refresh ${account.label} sign-in: ${answer.error}`);
    }
    const token = String(answer.body.access_token);
    // Microsoft hands out a new refresh token each time; keep the latest.
    if (typeof answer.body.refresh_token === "string" && answer.body.refresh_token !== secret.refreshToken) {
      this.accounts.updateSecret(accountId, { ...secret, refreshToken: answer.body.refresh_token });
    }
    this.cache.set(accountId, { token, expiresAt: Date.now() + Number(answer.body.expires_in ?? 3600) * 1000 });
    return token;
  }
}

const reconnectMessage = (account: Account) =>
  `${account.label} (${account.email}) needs reconnecting: its sign-in expired or was revoked. Ask the user to reconnect it in Settings → Accounts.`;

export type SignInStatus = { status: "pending" | "done" | "error"; error?: string; account?: Account };

/** A sign-in in progress, and whose: the account it makes is theirs. */
type Session = SignInStatus & { id: string; expiresAt: number; close: () => void; finish?: (url: URL) => Promise<void> };

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/**
 * Connecting accounts. Gmail: Google's sign-in page, which hands back to a one-off listener
 * on this PC (or, from a phone, to the address you paste back). Outlook: a device code you
 * enter at microsoft.com/devicelogin from any device.
 */
export class SignIns {
  private sessions = new Map<string, Session>();

  constructor(private accounts: Accounts, private tokens: Tokens, private fetchImpl: Fetch = fetch) {}

  status(id: string): SignInStatus | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return { status: session.status, error: session.error, account: session.account };
  }

  private open(close: () => void) {
    for (const [id, old] of this.sessions) if (old.expiresAt < Date.now()) { old.close(); this.sessions.delete(id); }
    const session: Session = { id: randomUUID(), status: "pending", expiresAt: Date.now() + SESSION_MS, close };
    this.sessions.set(session.id, session);
    const timer = setTimeout(() => {
      if (session.status === "pending") { session.status = "error"; session.error = "The sign-in timed out. Start again."; }
      session.close();
    }, SESSION_MS);
    timer.unref?.();
    return session;
  }

  private fail(session: Session, error: unknown) {
    session.status = "error";
    session.error = error instanceof Error ? error.message : String(error);
    session.close();
  }

  // ---------- Google ----------
  async startGoogle(app: { clientId: string; clientSecret: string }): Promise<{ id: string; url: string; redirectUri: string }> {
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString("base64url");
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.unref();
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = this.open(() => server.close());

    session.finish = async (url: URL) => {
      if (session.status !== "pending") return;
      if (url.searchParams.get("state") !== state) throw new Error("That address is from a different sign-in. Start again.");
      const denied = url.searchParams.get("error");
      if (denied) throw new Error(denied === "access_denied" ? "Google sign-in was cancelled." : `Google said: ${denied}`);
      const code = url.searchParams.get("code");
      if (!code) throw new Error("That address doesn't contain a sign-in code. Copy the whole address from the address bar.");
      const answer = await postForm(this.fetchImpl, GOOGLE.token, {
        grant_type: "authorization_code", code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, code_verifier: verifier,
      });
      if (!answer.ok) throw new Error(`Google didn't accept the sign-in: ${answer.error}`);
      const scopes = String(answer.body.scope ?? "").split(" ");
      if (!scopes.includes(GOOGLE.gmailScope)) throw new Error("Google didn't grant access to Gmail. Start again and tick every box on Google's screen.");
      if (typeof answer.body.refresh_token !== "string") throw new Error("Google didn't send a lasting sign-in. Remove Colony's access at myaccount.google.com/permissions and try again.");
      const accessToken = String(answer.body.access_token);
      const profile = await callApi<{ emailAddress: string }>(this.fetchImpl, async () => accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
      const account = this.accounts.connect({ kind: "google", label: "Gmail", email: profile.emailAddress },
        { kind: "google", clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: answer.body.refresh_token, scopes });
      this.tokens.seed(account.id, accessToken, Number(answer.body.expires_in ?? 3600));
      session.status = "done";
      session.account = account;
      session.close();
    };

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/" || (!url.searchParams.has("code") && !url.searchParams.has("error"))) { response.writeHead(404).end(); return; }
      void session.finish!(url).then(
        () => page(response, "Gmail is connected", "You can close this tab and go back to Colony."),
        (error) => { this.fail(session, error); page(response, "Couldn't connect Gmail", session.error ?? ""); },
      );
    });

    const params = new URLSearchParams({
      client_id: app.clientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      code_challenge: challenge, code_challenge_method: "S256", state,
    });
    return { id: session.id, url: `${GOOGLE.auth}?${params}`, redirectUri };
  }

  /** From a phone: the address Google sent the browser to (which didn't load) carries the code. */
  async finishGoogle(id: string, pasted: string): Promise<SignInStatus> {
    const session = this.sessions.get(id);
    if (!session?.finish) throw new Error("That sign-in has ended. Start again.");
    let url: URL;
    try { url = new URL(pasted.trim()); } catch { throw new Error("Paste the whole address from the address bar, starting with http://127.0.0.1."); }
    try { await session.finish(url); } catch (error) {
      // A mistyped paste can be retried; anything Google rejected can't.
      if (/different sign-in|doesn't contain/.test(String(error))) throw error;
      this.fail(session, error);
    }
    return this.status(id)!;
  }

  // ---------- Microsoft ----------
  async startMicrosoft(app: { clientId: string }): Promise<{ id: string; userCode: string; verificationUri: string; expiresIn: number }> {
    const start = await postForm(this.fetchImpl, `${MICROSOFT.base}/devicecode`, { client_id: app.clientId, scope: MICROSOFT.scopes });
    if (!start.ok) throw new Error(`Microsoft didn't start the sign-in: ${start.error}`);
    const deviceCode = String(start.body.device_code);
    let interval = Number(start.body.interval ?? 5);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const session = this.open(() => { stopped = true; clearTimeout(timer); });

    const poll = async () => {
      if (stopped) return;
      try {
        const answer = await postForm(this.fetchImpl, `${MICROSOFT.base}/token`, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: app.clientId, device_code: deviceCode,
        });
        if (!answer.ok) {
          const code = String(answer.body.error ?? "");
          if (code === "authorization_pending" || code === "slow_down") {
            if (code === "slow_down") interval += 5;
            timer = setTimeout(() => void poll(), interval * 1000);
            return;
          }
          throw new Error(code === "authorization_declined" ? "Microsoft sign-in was cancelled."
            : code === "expired_token" ? "The code expired. Start again."
            : `Microsoft said: ${answer.error}`);
        }
        const accessToken = String(answer.body.access_token);
        const me = await callApi<{ mail?: string | null; userPrincipalName?: string }>(this.fetchImpl, async () => accessToken, "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName");
        const account = this.accounts.connect({ kind: "microsoft", label: "Outlook", email: me.mail || me.userPrincipalName || "Outlook" },
          { kind: "microsoft", clientId: app.clientId, refreshToken: String(answer.body.refresh_token ?? "") });
        this.tokens.seed(account.id, accessToken, Number(answer.body.expires_in ?? 3600));
        session.status = "done";
        session.account = account;
        session.close();
      } catch (error) {
        this.fail(session, error);
      }
    };
    timer = setTimeout(() => void poll(), interval * 1000);

    return {
      id: session.id,
      userCode: String(start.body.user_code),
      verificationUri: String(start.body.verification_uri ?? "https://microsoft.com/devicelogin"),
      expiresIn: Number(start.body.expires_in ?? 900),
    };
  }

  cancel(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.status === "pending") { session.status = "error"; session.error = "Cancelled."; }
    session.close();
  }
}

/** A plain page for the browser tab Google sends back to. */
function page(response: http.ServerResponse, title: string, body: string) {
  const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>` +
    `<body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh;margin:0">` +
    `<div style="max-width:28rem;text-align:center"><h1 style="font-size:20px">${escape(title)}</h1><p style="color:#aaa">${escape(body)}</p></div>`);
}

/** Best-effort: tells the provider to forget Colony's sign-in when you remove an account. */
export async function revoke(fetchImpl: Fetch, secret: ReturnType<Accounts["secret"]>) {
  if (secret?.kind !== "google") return; // Microsoft has no per-token revoke for personal accounts.
  await postForm(fetchImpl, GOOGLE.revoke, { token: secret.refreshToken }).catch(() => {});
}
