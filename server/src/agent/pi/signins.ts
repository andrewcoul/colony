import { randomUUID } from "node:crypto";
import type { AuthPrompt, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { installationId, type SignInId } from "../../settings.js";
import { SIGN_IN_PROVIDER, type ColonyModels } from "./models.js";

/** How a sign-in continues in your browser. */
export type SignInStart =
  /** ChatGPT: open `url`. It hands back to this PC; from another device, paste the address it ends on. */
  | { id: string; kind: "browser"; url: string }
  /** OpenCode: open `verificationUri` on any device and approve `userCode`. */
  | { id: string; kind: "code"; userCode: string; verificationUri: string };
export type SignInStatus = { status: "pending" | "done" | "error"; error?: string };

type Session = SignInStatus & { signIn: SignInId; controller: AbortController; paste?: (input: string) => void };

const SESSION_MS = 15 * 60_000;

/** Signing in to ChatGPT and OpenCode with pi-ai's login flows; tokens land in the credential store. */
export class ModelSignIns {
  private sessions = new Map<string, Session>();

  constructor(private source: ColonyModels) {}

  /** Starts a sign-in (ending any other one for the same service: they'd fight over the callback port). */
  start(signIn: SignInId): Promise<SignInStart> {
    for (const [id, session] of this.sessions) {
      if (session.signIn === signIn || session.status !== "pending") { session.controller.abort(); this.sessions.delete(id); }
    }
    const id = randomUUID();
    const controller = new AbortController();
    const session: Session = { signIn, status: "pending", controller };
    this.sessions.set(id, session);
    const timer = setTimeout(() => controller.abort(), SESSION_MS);
    timer.unref?.();

    return new Promise<SignInStart>((started, failed) => {
      const interaction: ProviderAuthInteraction = {
        signal: controller.signal,
        notify: (event) => {
          if (event.type === "auth_url") started({ id, kind: "browser", url: event.url });
          if (event.type === "device_code") started({ id, kind: "code", userCode: event.userCode, verificationUri: event.verificationUri });
        },
        prompt: (prompt: AuthPrompt) => {
          if (prompt.type === "select") return Promise.resolve(prompt.options[0]?.id ?? "");
          if (prompt.type !== "manual_code") return Promise.reject(new Error("Colony can't answer that sign-in question."));
          // The address the browser ends on, pasted back from another device.
          return new Promise<string>((resolve, reject) => {
            session.paste = resolve;
            const stop = () => reject(new Error("Sign-in cancelled."));
            if (prompt.signal?.aborted) stop(); else prompt.signal?.addEventListener("abort", stop, { once: true });
          });
        },
      };
      this.source.models.login(SIGN_IN_PROVIDER[signIn], "oauth", interaction, { getDeviceId: installationId, agentName: "Colony" })
        .then(() => { session.status = "done"; })
        .catch((error: unknown) => {
          session.status = "error";
          session.error = controller.signal.aborted ? "The sign-in was cancelled or timed out. Start again." : error instanceof Error ? error.message : String(error);
          failed(new Error(session.error));
        })
        .finally(() => { clearTimeout(timer); session.paste = undefined; });
    });
  }

  status(id: string): SignInStatus | null {
    const session = this.sessions.get(id);
    return session ? { status: session.status, ...(session.error ? { error: session.error } : {}) } : null;
  }

  /** Finishes a ChatGPT sign-in with the address the browser ended on (for a browser on another device). */
  finish(id: string, input: string) {
    const session = this.sessions.get(id);
    if (!session || session.status !== "pending") throw new Error("That sign-in has ended. Start again.");
    if (!session.paste) throw new Error("This sign-in finishes in the browser.");
    session.paste(input);
  }

  cancel(id: string) {
    this.sessions.get(id)?.controller.abort();
  }

  /** Forgets a sign-in's tokens; Bots on its models switch to the default model. */
  async signOut(signIn: SignInId) {
    for (const session of this.sessions.values()) if (session.signIn === signIn) session.controller.abort();
    await this.source.models.logout(SIGN_IN_PROVIDER[signIn]);
  }
}
