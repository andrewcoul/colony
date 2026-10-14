/** A mail search, the same for every provider. Dates are local YYYY-MM-DD. */
export type MailQuery = {
  from?: string;
  to?: string;
  subject?: string;
  /** Words anywhere in the message. */
  text?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  /** Only the inbox (default: all mail except trash and spam). */
  inbox?: boolean;
};

export type MailSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  /** ISO time. */
  date: string;
  snippet: string;
  unread: boolean;
};

export type MailMessage = MailSummary & { cc: string; body: string; attachments: { name: string; size: number }[] };

export type DraftInput = { to: string[]; cc: string[]; subject: string; body: string; replyToId?: string };
export type Draft = { id: string; to: string[]; cc: string[]; subject: string; body: string };

export type OrganizeOp = { archive?: boolean; read?: boolean; addLabel?: string; removeLabel?: string };

/** New mail since `cursor`; a null cursor only establishes where to start. */
export type MailChanges = { added: MailSummary[]; cursor: string };

export interface MailProvider {
  search(query: MailQuery, limit: number): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage>;
  thread(threadId: string): Promise<MailMessage[]>;
  createDraft(input: DraftInput): Promise<Draft>;
  updateDraft(id: string, input: DraftInput): Promise<Draft>;
  getDraft(id: string): Promise<Draft>;
  sendDraft(id: string): Promise<void>;
  organize(ids: string[], op: OrganizeOp): Promise<void>;
  changes(cursor: string | null): Promise<MailChanges>;
}

export type Attendee = { email: string; name?: string; response?: string };

export type CalEvent = {
  id: string;
  title: string;
  /** ISO times; all-day events use YYYY-MM-DD. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  attendees: Attendee[];
  organizer: string;
  isOrganizer: boolean;
  /** Your answer to an invite: accepted, tentative, declined, or needsAction. */
  myResponse: string | null;
  link: string | null;
};

export type EventInput = {
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
};

export type EventResponse = "accept" | "tentative" | "decline";

export interface CalendarProvider {
  list(from: Date, to: Date): Promise<CalEvent[]>;
  get(id: string): Promise<CalEvent>;
  create(input: EventInput): Promise<CalEvent>;
  update(id: string, patch: Partial<EventInput>): Promise<CalEvent>;
  respond(id: string, response: EventResponse, comment?: string): Promise<void>;
}
