import type { Account } from "../shared/types.js";
import type { Accounts } from "./accounts.js";
import { GmailMail, GoogleCalendar } from "./mail/gmail.js";
import { GraphCalendar, GraphMail } from "./mail/graph.js";
import type { CalendarProvider, MailProvider } from "./mail/types.js";
import type { Fetch } from "./http.js";
import type { Tokens } from "./oauth.js";
import type { Vaults } from "./onepassword.js";

export type ProviderFactory = {
  mail: (account: Account) => MailProvider;
  calendar: (account: Account) => CalendarProvider;
};

/** The accounts Bots can use and a client for each. Tests pass their own providers. */
export class Integrations {
  readonly providers: ProviderFactory;

  constructor(readonly accounts: Accounts, readonly tokens: Tokens, readonly vaults: Vaults, providers?: Partial<ProviderFactory>, fetchImpl: Fetch = fetch) {
    const token = (account: Account) => () => tokens.get(account.id);
    this.providers = {
      mail: providers?.mail ?? ((account) => account.kind === "google" ? new GmailMail(token(account), fetchImpl) : new GraphMail(token(account), fetchImpl)),
      calendar: providers?.calendar ?? ((account) => account.kind === "google" ? new GoogleCalendar(token(account), fetchImpl) : new GraphCalendar(token(account), fetchImpl)),
    };
  }

  mail(account: Account) {
    return this.providers.mail(account);
  }

  calendar(account: Account) {
    return this.providers.calendar(account);
  }
}
