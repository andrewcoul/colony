import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { VERSION } from "../../version.js";

/*
 * Signing in to OpenCode: the console's device flow (RFC 8628), the one OpenCode documents
 * for other apps. You open opencode.ai/console/device, pick a workspace and approve; the
 * token is bound to that workspace and pays for Zen and Go requests as a bearer token.
 * https://opencode.ai/v2/docs/console/api
 */

const CONSOLE = "https://opencode.ai/console";
const CLIENT_ID = "colony";
/** Refresh this long before the token really expires, so a request never starts with one about to. */
const MARGIN_MS = 60_000;

type Fetch = typeof fetch;

async function post(fetchImpl: Fetch, path: string, fields: Record<string, string>, signal?: AbortSignal) {
  const response = await fetchImpl(`${CONSOLE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": `colony/${VERSION}` },
    body: new URLSearchParams(fields),
    signal,
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, body };
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Sign-in cancelled.")); }, { once: true });
});

function credentialFrom(body: Record<string, unknown>, previous?: OAuthCredential): OAuthCredential {
  const access = body.access_token;
  const refresh = body.refresh_token;
  if (typeof access !== "string" || !access) throw new Error("OpenCode didn't send a token.");
  const expiresIn = Number(body.expires_in);
  return {
    type: "oauth",
    access,
    // Each refresh token works once; a new one comes with every refresh.
    refresh: typeof refresh === "string" && refresh ? refresh : previous?.refresh ?? "",
    expires: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000) - MARGIN_MS,
    ...(typeof body.org_id === "string" ? { orgId: body.org_id } : previous?.orgId ? { orgId: previous.orgId } : {}),
  };
}

const explain = (body: Record<string, unknown>, fallback: string) =>
  String(body.error_description ?? body.message ?? body.error ?? fallback);

/** OpenCode's console sign-in as a pi-ai OAuth method. */
export function opencodeConsoleOAuth(fetchImpl: Fetch = fetch): OAuthAuth {
  return {
    name: "OpenCode",
    isSubscription: true,
    loginLabel: "Sign in to OpenCode",
    async login(interaction: ProviderAuthInteraction) {
      const start = await post(fetchImpl, "/auth/device/code", { client_id: CLIENT_ID, supports_org_scope: "true" }, interaction.signal);
      if (!start.ok || typeof start.body.device_code !== "string") throw new Error(`OpenCode didn't start the sign-in: ${explain(start.body, `HTTP ${start.status}`)}`);
      const page = String(start.body.verification_uri_complete ?? start.body.verification_uri ?? "/console/device");
      interaction.notify({
        type: "device_code",
        userCode: String(start.body.user_code ?? ""),
        verificationUri: new URL(page, "https://opencode.ai").toString(),
        intervalSeconds: Number(start.body.interval ?? 5),
        expiresInSeconds: Number(start.body.expires_in ?? 600),
      });
      let interval = Number(start.body.interval ?? 5);
      const deadline = Date.now() + Number(start.body.expires_in ?? 600) * 1000;
      while (Date.now() < deadline) {
        await wait(interval * 1000, interaction.signal);
        const answer = await post(fetchImpl, "/auth/device/token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.body.device_code, client_id: CLIENT_ID,
        }, interaction.signal);
        if (answer.ok) return credentialFrom(answer.body);
        const code = String(answer.body.error ?? "");
        if (code === "authorization_pending") continue;
        if (code === "slow_down") { interval += 5; continue; }
        throw new Error(code === "access_denied" ? "The OpenCode sign-in was declined."
          : code === "expired_token" ? "The code expired. Start again."
          : `OpenCode said: ${explain(answer.body, `HTTP ${answer.status}`)}`);
      }
      throw new Error("The code expired. Start again.");
    },
    async refresh(credential, signal) {
      const answer = await post(fetchImpl, "/auth/device/token", { grant_type: "refresh_token", refresh_token: credential.refresh, client_id: CLIENT_ID }, signal);
      if (!answer.ok) throw new Error(`OpenCode wouldn't renew the sign-in (${explain(answer.body, `HTTP ${answer.status}`)}). Sign in again in Settings.`);
      return credentialFrom(answer.body, credential);
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}
