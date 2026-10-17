import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins/email-otp";
import { publicOrigin, type HeaderLookup } from "./access.js";
import { codeMail, linkMail, type Mailer } from "./mailer.js";
import { normalEmail } from "./invites.js";
import { SignUpRefused, type WebAccounts, type WebSessions } from "./webauth.js";

/*
 * Colony's sign-in service: Better Auth, at /api/auth/*. Email and password accounts; sign-up only
 * with an invite (checked by WebAccounts in the user-creation hooks); sessions in a cookie that's
 * Secure, HttpOnly, SameSite=Lax and host-only. Password resets and sign-in codes by email only
 * when Colony can send email. Accounts, sessions and password hashes live in data/auth.db, a
 * database of their own (readable only by Colony): a copy of colony.db never carries them, and
 * Better Auth's transactions never take in Colony's own writes.
 */

export const AUTH_BASE_PATH = "/api/auth";
const MIN_PASSWORD = 10;
/** How a sign-in or sign-up can be tried, per client, per minute. */
const TRIES = { window: 60, max: 5 };

export type WebAuth = {
  sessions: WebSessions;
  /** Answers an /api/auth/* request. `via`: where it came in (links in emails use its web origin). */
  handler(request: Request, via: string | undefined): Promise<Response>;
  close(): void;
};

/** The request being answered, for what Better Auth calls back with (email links need its origin). */
const current = new AsyncLocalStorage<{ request: Request; via: string | undefined }>();

/** Opens data/auth.db (made readable only by Colony), or `file` (":memory:" in tests). */
function openAuthDb(file: string) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "w", 0o600));
    fs.chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * Starts Better Auth (running its migrations first) and returns the sessions Colony asks about.
 * `accounts` decides who may sign up (invites) and who each account is.
 */
export async function startWebAuth({ file, secret, origins, mailer, accounts }: {
  file: string; secret: string; origins: readonly string[]; mailer: Mailer; accounts: WebAccounts;
}): Promise<WebAuth> {
  const db = openAuthDb(file);
  /** Admin emails being set up from Settings right now (the only way an admin account is made). */
  const settingUp = new Set<string>();
  const refuse = (error: unknown): never => {
    if (error instanceof SignUpRefused) throw new APIError("FORBIDDEN", { message: error.message });
    throw error;
  };
  /** The web origin the request being answered is on, for links in emails. */
  const originNow = () => {
    const scope = current.getStore();
    const header: HeaderLookup = (name) => scope?.request.headers.get(name) ?? undefined;
    return publicOrigin(header, scope?.via, origins) ?? origins[0] ?? "";
  };

  const options = {
    appName: "Colony",
    secret,
    baseURL: origins[0],
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [...origins],
    database: db,
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD,
      autoSignIn: true,
      // Resets by email only when Colony can send email.
      ...(mailer.enabled ? {
        sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
          const link = `${originNow()}/reset?token=${encodeURIComponent(token)}`;
          await mailer.send(linkMail(user.email, {
            subject: "Reset your Colony password", intro: "Someone (hopefully you) asked to reset your Colony password.",
            action: "Choose a new password", link, outro: "The link works once, for an hour. If you didn't ask, ignore this email: your password stays as it is.",
          }));
        },
      } : {}),
    },
    user: {
      // "admin" only for the admin's own account, made from Settings; everyone else is a member.
      additionalFields: { role: { type: "string", required: false, defaultValue: "member", input: false } },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const email = normalEmail(user.email);
            if (settingUp.has(email) && !context) return;
            // The only other way in: signing up with an invite for this email.
            if (context?.path !== "/sign-up/email") throw new APIError("FORBIDDEN", { message: "Colony is invite-only. Ask the person who runs it for an invite." });
            const invite = (context.body as { invite?: unknown } | undefined)?.invite;
            try { accounts.beforeSignUp(email, typeof invite === "string" ? invite : undefined); } catch (error) { refuse(error); }
          },
          after: async (user, context) => {
            if (!context) return; // The admin's own account, from Settings.
            const invite = (context.body as { invite?: string }).invite!;
            try { accounts.afterSignUp(normalEmail(user.email), invite); } catch (error) {
              // Someone else used the invite at the same moment: no account without it.
              await context.context.internalAdapter.deleteUser(user.id).catch(() => {});
              refuse(error);
            }
          },
        },
      },
      session: {
        create: {
          // A member who's been turned off can't start a session.
          before: async (session) => {
            const user = await (await auth.$context).internalAdapter.findUserById(session.userId);
            if (user && accounts.isTurnedOff(user.email)) throw new APIError("FORBIDDEN", { message: "Your account on this Colony is turned off. Ask the person who runs it." });
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": TRIES,
        "/sign-up/email": TRIES,
        "/sign-in/email-otp": TRIES,
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": TRIES,
      },
    },
    advanced: {
      useSecureCookies: true,
      // No Domain: the cookie stays on the host it was set for.
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax" },
      // Through the tunnel, Cloudflare says who the client is.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: mailer.enabled ? [emailOTP({
      disableSignUp: true,
      sendVerificationOTP: async ({ email, otp }) => { await mailer.send(codeMail(email, otp)); },
    })] : [],
  } satisfies BetterAuthOptions;

  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);

  const userByEmail = async (email: string) => (await (await auth.$context).internalAdapter.findUserByEmail(normalEmail(email)))?.user ?? null;

  const sessions: WebSessions = {
    async emailFor(header) {
      const cookie = header("Cookie");
      if (!cookie) return null;
      const found = await auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
      const user = found?.user as ({ email: string; role?: string | null } | undefined);
      if (!user) return null;
      // An admin email counts only for the admin's own account (made from Settings).
      if (accounts.isAdminEmail(user.email) && user.role !== "admin") return null;
      return normalEmail(user.email);
    },
    async revoke(email) {
      const user = await userByEmail(email);
      if (user) await (await auth.$context).internalAdapter.deleteUserSessions(user.id);
    },
    async deleteAccount(email) {
      const user = await userByEmail(email);
      if (!user) return;
      const internal = (await auth.$context).internalAdapter;
      await internal.deleteUserSessions(user.id);
      await internal.deleteAccounts(user.id);
      await internal.deleteUser(user.id);
    },
    async setUpAdmin(email, password) {
      const context = await auth.$context;
      if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
      const address = normalEmail(email);
      settingUp.add(address);
      try {
        let user = await userByEmail(address);
        if (user) await context.internalAdapter.updateUser(user.id, { role: "admin" });
        else user = await context.internalAdapter.createUser({ email: address, name: "Admin", emailVerified: true, role: "admin" }, { method: "admin" });
        const hash = await context.password.hash(password);
        const credential = (await context.internalAdapter.findAccounts(user!.id)).find((account) => account.providerId === "credential");
        if (credential) await context.internalAdapter.updatePassword(user!.id, hash);
        else await context.internalAdapter.linkAccount({ userId: user!.id, providerId: "credential", accountId: user!.id, password: hash });
        // A new password ends the sessions signed in with the old one.
        await context.internalAdapter.deleteUserSessions(user!.id);
      } finally {
        settingUp.delete(address);
      }
    },
  };

  return {
    sessions,
    handler: (request, via) => current.run({ request, via }, () => auth.handler(request)),
    close: () => db.close(),
  };
}
