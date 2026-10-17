import type { HeaderLookup } from "./access.js";
import { normalEmail, type Invites } from "./invites.js";
import { ADMIN_ID, type People, type Person } from "./people.js";
import type { Store } from "./store.js";

/*
 * Web sign-in: people who open Colony through its website (the colony-site Worker, then the origin's
 * Cloudflare Access app) sign in with an email and password. Sign-up is invite-only: an account can
 * only be made for an email with a pending invite, using that invite. The sign-in service (Better
 * Auth) keeps accounts, passwords and sessions; this is Colony's side of it: who each account is,
 * who may sign up, and turning accounts off.
 */

/** What the sign-in service does for Colony. */
export interface WebSessions {
  /** The email of the account signed in on this request (from its session cookie), or null. */
  emailFor(header: HeaderLookup): Promise<string | null>;
  /** Ends every session of this account. */
  revoke(email: string): Promise<void>;
  /** Deletes this account (its password and sessions). Colony's own data for the person is separate. */
  deleteAccount(email: string): Promise<void>;
  /** Makes (or resets the password of) the admin's own account. */
  setUpAdmin(email: string, password: string): Promise<void>;
}

/** A sign-up that isn't allowed, with why (the sign-in service turns this into its error). */
export class SignUpRefused extends Error {
  constructor(message: string) { super(message); this.name = "SignUpRefused"; }
}

export class WebAccounts {
  constructor(private store: Store, private people: People, private invites: Invites, readonly sessions: WebSessions | null) {}

  /** Whether web sign-in is on (BETTER_AUTH_SECRET is set and the sign-in service runs). */
  get enabled() { return this.sessions !== null; }

  /** The emails that sign in as the admin (never invited). */
  get adminEmails() { return this.people.listAdminEmails(); }
  isAdminEmail(email: string) { return this.people.isAdminEmail(email); }

  /** Who's signed in on the web on this request: a person, "disabled" (turned off), or null (nobody). */
  async personFor(header: HeaderLookup): Promise<Person | "disabled" | null> {
    const email = await this.sessions?.emailFor(header);
    if (!email) return null;
    if (this.people.isAdminEmail(email)) return this.people.admin();
    const person = this.store.personByLogin(email);
    // An account whose email is the admin's tailnet login, but not an admin email, is nobody.
    if (!person || person.id === ADMIN_ID || person.role === "admin") return null;
    return person.disabled ? "disabled" : person;
  }

  /**
   * Before an account is made (the sign-in service's user-creation hook): only for an email with a
   * pending invite, using that invite, and never for an admin email (the admin sets theirs up from
   * Settings). Throws SignUpRefused with why.
   */
  beforeSignUp(email: string, invite: string | undefined) {
    if (this.people.isAdminEmail(email)) throw new SignUpRefused("This email signs in as the admin: set it up from Colony's Settings on your PC.");
    if (!invite) throw new SignUpRefused("Colony is invite-only. Ask the person who runs it for an invite.");
    const checked = this.invites.check(invite, email);
    if ("problem" in checked) throw new SignUpRefused(checked.problem);
    const known = this.store.personByLogin(normalEmail(email));
    if (known?.disabled) throw new SignUpRefused("This account is turned off. Ask the person who runs this Colony.");
  }

  /**
   * After the account is made: it's a member (with the members' defaults: their models and the
   * default cap), and the invite is used up. A member who was here before keeps their things.
   */
  afterSignUp(email: string, invite: string): Person {
    this.beforeSignUp(email, invite);
    const person = this.people.byEmail(normalEmail(email));
    if ("refused" in person) throw new SignUpRefused(person.refused);
    const used = this.invites.consume(invite, email, person.id);
    if ("problem" in used) throw new SignUpRefused(used.problem);
    return person;
  }

  /** Turns a member off: their sessions end, and they can't sign in (or sign up again) until turned on. */
  async disable(personId: string) {
    const person = this.store.setPersonDisabled(personId, true);
    if (person?.login) await this.sessions?.revoke(person.login);
  }

  /** Deletes a member's web account (they can't sign in). Their Colony data is kept unless removed separately. */
  async deleteAccount(personId: string) {
    const login = this.store.getPerson(personId)?.login;
    if (login) await this.sessions?.deleteAccount(login);
  }

  /** The admin's own web sign-in, for one of the admin's emails. */
  async setUpAdmin(email: string, password: string) {
    if (!this.sessions) throw new Error("Web sign-in is off. Set BETTER_AUTH_SECRET and restart Colony.");
    if (!this.people.isAdminEmail(email)) throw new Error("That isn't one of the admin's emails (COLONY_ADMIN_EMAILS).");
    await this.sessions.setUpAdmin(normalEmail(email), password);
  }
}

/**
 * The sign-in service the environment asks for. Web sign-in needs BETTER_AUTH_SECRET; without it,
 * every request through the website is asked to sign in, and nobody can.
 */
export function webSessionsFromEnv(env: Record<string, string | undefined> = process.env): WebSessions | null {
  if (!env.BETTER_AUTH_SECRET?.trim()) {
    console.log("[colony] Web sign-in is off: set BETTER_AUTH_SECRET to turn it on.");
    return null;
  }
  console.log("[colony] Web sign-in is off: this build of Colony doesn't include its sign-in service (Better Auth) yet.");
  return null;
}
