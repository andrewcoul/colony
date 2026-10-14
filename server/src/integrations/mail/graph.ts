import { callApi, type Fetch } from "../http.js";
import { bareAddress, dayBefore, localDay, ymd } from "./text.js";
import type { CalEvent, CalendarProvider, Draft, DraftInput, EventInput, EventResponse, MailChanges, MailMessage, MailProvider, MailQuery, MailSummary, OrganizeOp } from "./types.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TEXT_BODY = { Prefer: "outlook.body-content-type=\"text\"" };
const SUMMARY_FIELDS = "id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead";

type Recipient = { emailAddress?: { name?: string; address?: string } };
type GraphMessage = {
  id: string; conversationId?: string; subject?: string; from?: Recipient; toRecipients?: Recipient[]; ccRecipients?: Recipient[];
  receivedDateTime?: string; bodyPreview?: string; isRead?: boolean; isDraft?: boolean; hasAttachments?: boolean;
  body?: { contentType?: string; content?: string }; categories?: string[];
};

const address = (recipient: Recipient | undefined) => {
  const { name, address: email } = recipient?.emailAddress ?? {};
  return name && email && name !== email ? `${name} <${email}>` : email || name || "";
};
const addresses = (list: Recipient[] | undefined) => (list ?? []).map(address).filter(Boolean);

/** "Name <a@x.com>" or "a@x.com" → a Graph recipient. */
const recipient = (value: string): Recipient => {
  const email = bareAddress(value);
  const name = value.includes("<") ? value.slice(0, value.indexOf("<")).replace(/"/g, "").trim() : "";
  return { emailAddress: { address: email, ...(name ? { name } : {}) } };
};

const summary = (message: GraphMessage): MailSummary => ({
  id: message.id,
  threadId: message.conversationId ?? "",
  from: address(message.from),
  to: addresses(message.toRecipients).join(", "),
  subject: message.subject ?? "",
  date: message.receivedDateTime ?? "",
  snippet: (message.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
  unread: message.isRead === false,
});

const full = (message: GraphMessage, attachments: MailMessage["attachments"] = []): MailMessage => ({
  ...summary(message),
  cc: addresses(message.ccRecipients).join(", "),
  body: (message.body?.content ?? "").replace(/\r\n/g, "\n").trim(),
  attachments,
});

/** Keyword search syntax for Graph's $search (quotes inside values aren't allowed). */
export function graphSearch(query: MailQuery) {
  const clean = (value: string) => value.replace(/"/g, "").trim();
  const terms = [
    query.from && `from:${clean(query.from)}`,
    query.to && `to:${clean(query.to)}`,
    query.subject && `subject:${/\s/.test(query.subject) ? `'${clean(query.subject)}'` : clean(query.subject)}`,
    query.text && clean(query.text),
  ].filter(Boolean);
  return terms.length ? `"${terms.join(" ")}"` : "";
}

export class GraphMail implements MailProvider {
  constructor(private token: () => Promise<string>, private fetchImpl: Fetch = fetch) {}

  private call<T>(path: string, init?: Parameters<typeof callApi>[3]) {
    return callApi<T>(this.fetchImpl, this.token, `${GRAPH}${path}`, init);
  }

  async search(query: MailQuery, limit: number) {
    const folder = query.inbox ? "/me/mailFolders/inbox/messages" : "/me/messages";
    const search = graphSearch(query);
    const after = query.after ? localDay(query.after) : null;
    const before = query.before ? localDay(query.before) : null;
    let messages: GraphMessage[];
    if (search) {
      // $search can't be combined with $filter, so dates and unread are applied here.
      const narrowed = Boolean(after || before || query.unread);
      const params = new URLSearchParams({ $search: search, $top: String(narrowed ? 100 : limit), $select: SUMMARY_FIELDS });
      messages = ((await this.call<{ value: GraphMessage[] }>(`${folder}?${params}`)).value ?? []).filter((message) => {
        const at = new Date(message.receivedDateTime ?? 0);
        return (!after || at >= after) && (!before || at < before) && (!query.unread || message.isRead === false);
      });
    } else {
      const filters = [
        after && `receivedDateTime ge ${after.toISOString()}`,
        before && `receivedDateTime lt ${before.toISOString()}`,
        query.unread && "isRead eq false",
      ].filter(Boolean);
      const params = new URLSearchParams({ $top: String(limit), $select: SUMMARY_FIELDS, $orderby: "receivedDateTime desc", ...(filters.length ? { $filter: filters.join(" and ") } : {}) });
      messages = (await this.call<{ value: GraphMessage[] }>(`${folder}?${params}`)).value ?? [];
    }
    return messages.slice(0, limit).map(summary);
  }

  async read(id: string) {
    const path = `/me/messages/${encodeURIComponent(id)}`;
    const message = await this.call<GraphMessage>(`${path}?$select=${SUMMARY_FIELDS},ccRecipients,body,hasAttachments`, { headers: TEXT_BODY });
    const attachments = message.hasAttachments
      ? ((await this.call<{ value: { name: string; size: number }[] }>(`${path}/attachments?$select=name,size`)).value ?? []).map(({ name, size }) => ({ name, size }))
      : [];
    return full(message, attachments);
  }

  async thread(threadId: string) {
    const params = new URLSearchParams({ $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`, $top: "50", $select: `${SUMMARY_FIELDS},ccRecipients,body` });
    const { value = [] } = await this.call<{ value: GraphMessage[] }>(`/me/messages?${params}`, { headers: TEXT_BODY });
    return value.map((message) => full(message)).sort((a, b) => a.date.localeCompare(b.date));
  }

  private fields(input: DraftInput) {
    return {
      ...(input.subject ? { subject: input.subject } : {}),
      body: { contentType: "Text", content: input.body },
      ...(input.to.length ? { toRecipients: input.to.map(recipient) } : {}),
      ccRecipients: input.cc.map(recipient),
    };
  }

  async createDraft(input: DraftInput) {
    if (input.replyToId) {
      // createReply keeps the thread and quotes the original under the comment.
      const draft = await this.call<GraphMessage>(`/me/messages/${encodeURIComponent(input.replyToId)}/createReply`, { body: { comment: input.body } });
      const { body: _, ...rest } = this.fields(input);
      if (input.to.length || input.cc.length || input.subject) await this.call(`/me/messages/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: rest });
      return this.getDraft(draft.id);
    }
    const draft = await this.call<GraphMessage>("/me/messages", { body: this.fields(input) });
    return this.getDraft(draft.id);
  }

  async updateDraft(id: string, input: DraftInput) {
    await this.getDraft(id);
    await this.call(`/me/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: this.fields(input) });
    return this.getDraft(id);
  }

  async getDraft(id: string): Promise<Draft> {
    const message = await this.call<GraphMessage>(`/me/messages/${encodeURIComponent(id)}?$select=id,subject,toRecipients,ccRecipients,body,isDraft`, { headers: TEXT_BODY });
    if (!message.isDraft) throw new Error("That message isn't a draft.");
    return { id: message.id, to: addresses(message.toRecipients), cc: addresses(message.ccRecipients), subject: message.subject ?? "", body: (message.body?.content ?? "").replace(/\r\n/g, "\n").trim() };
  }

  async sendDraft(id: string) {
    await this.call(`/me/messages/${encodeURIComponent(id)}/send`, { method: "POST" });
  }

  async organize(ids: string[], op: OrganizeOp) {
    for (const id of ids) {
      const path = `/me/messages/${encodeURIComponent(id)}`;
      const patch: Record<string, unknown> = {};
      if (op.read !== undefined) patch.isRead = op.read;
      if (op.addLabel || op.removeLabel) {
        // Outlook's labels are categories.
        const { categories = [] } = await this.call<GraphMessage>(`${path}?$select=categories`);
        const next = categories.filter((name) => name.toLowerCase() !== op.removeLabel?.toLowerCase());
        if (op.addLabel && !next.some((name) => name.toLowerCase() === op.addLabel!.toLowerCase())) next.push(op.addLabel);
        patch.categories = next;
      }
      if (Object.keys(patch).length) await this.call(path, { method: "PATCH", body: patch });
      // Moving gives the message a new id, so it goes last.
      if (op.archive) await this.call(`${path}/move`, { body: { destinationId: "archive" } });
    }
  }

  /** New inbox mail since the last check. The cursor is the newest time seen plus the ids at that time. */
  async changes(cursor: string | null): Promise<MailChanges> {
    if (!cursor) return { added: [], cursor: JSON.stringify({ t: new Date().toISOString(), ids: [] }) };
    const seen = JSON.parse(cursor) as { t: string; ids: string[] };
    const params = new URLSearchParams({ $filter: `receivedDateTime ge ${seen.t}`, $orderby: "receivedDateTime asc", $top: "50", $select: SUMMARY_FIELDS });
    const { value = [] } = await this.call<{ value: GraphMessage[] }>(`/me/mailFolders/inbox/messages?${params}`);
    const added = value.filter((message) => !seen.ids.includes(message.id)).map(summary);
    const newest = value.reduce((latest, message) => (message.receivedDateTime && message.receivedDateTime > latest ? message.receivedDateTime : latest), seen.t);
    const atNewest = value.filter((message) => message.receivedDateTime === newest).map((message) => message.id);
    const ids = newest === seen.t ? [...new Set([...seen.ids, ...atNewest])] : atNewest;
    return { added: added.slice(0, 20), cursor: JSON.stringify({ t: newest, ids }) };
  }
}

type GraphEvent = {
  id: string; subject?: string; isAllDay?: boolean; webLink?: string; bodyPreview?: string; body?: { content?: string };
  start?: { dateTime: string; timeZone?: string }; end?: { dateTime: string; timeZone?: string };
  location?: { displayName?: string };
  attendees?: { emailAddress?: { name?: string; address?: string }; status?: { response?: string } }[];
  organizer?: Recipient; isOrganizer?: boolean; responseStatus?: { response?: string };
};

const RESPONSES: Record<string, string | null> = { accepted: "accepted", tentativelyAccepted: "tentative", declined: "declined", notResponded: "needsAction", none: "needsAction", organizer: null };
const EVENT_FIELDS = "id,subject,isAllDay,webLink,bodyPreview,start,end,location,attendees,organizer,isOrganizer,responseStatus";
const UTC = { Prefer: "outlook.timezone=\"UTC\"" };

/** Graph's UTC times have no zone mark; all-day events use their date. */
const utc = (value: string | undefined) => (value ? `${value.replace(/\.\d+$/, "")}Z` : "");

function toEvent(event: GraphEvent): CalEvent {
  const allDay = Boolean(event.isAllDay);
  return {
    id: event.id,
    title: event.subject || "(no title)",
    start: allDay ? (event.start?.dateTime ?? "").slice(0, 10) : utc(event.start?.dateTime),
    end: allDay ? dayBefore((event.end?.dateTime ?? "").slice(0, 10)) : utc(event.end?.dateTime),
    allDay,
    location: event.location?.displayName ?? "",
    description: (event.body?.content ?? event.bodyPreview ?? "").trim(),
    attendees: (event.attendees ?? []).map((item) => ({
      email: item.emailAddress?.address ?? "", name: item.emailAddress?.name, response: RESPONSES[item.status?.response ?? ""] ?? item.status?.response,
    })),
    organizer: event.organizer?.emailAddress?.address ?? "",
    isOrganizer: Boolean(event.isOrganizer),
    myResponse: RESPONSES[event.responseStatus?.response ?? ""] ?? null,
    link: event.webLink ?? null,
  };
}

/** Graph's event body. Timed events go in UTC; all-day events are whole local days, `end` being the last. */
function eventBody(input: Partial<EventInput>, allDay: boolean) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = (date: Date, end: boolean) => allDay
    ? { dateTime: `${ymd(end ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) : date)}T00:00:00`, timeZone: zone }
    : { dateTime: date.toISOString().replace(/\.\d+Z$/, ""), timeZone: "UTC" };
  return {
    ...(input.title !== undefined ? { subject: input.title } : {}),
    ...(input.description !== undefined ? { body: { contentType: "Text", content: input.description } } : {}),
    ...(input.location !== undefined ? { location: { displayName: input.location } } : {}),
    ...(input.allDay !== undefined ? { isAllDay: input.allDay } : {}),
    ...(input.start ? { start: when(input.start, false) } : {}),
    ...(input.end ? { end: when(input.end, true) } : {}),
    ...(input.attendees ? { attendees: input.attendees.map((email) => ({ ...recipient(email), type: "required" })) } : {}),
  };
}

export class GraphCalendar implements CalendarProvider {
  constructor(private token: () => Promise<string>, private fetchImpl: Fetch = fetch) {}

  private call<T>(path: string, init?: Parameters<typeof callApi>[3]) {
    return callApi<T>(this.fetchImpl, this.token, `${GRAPH}${path}`, init);
  }

  async list(from: Date, to: Date) {
    const params = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: "100", $orderby: "start/dateTime", $select: EVENT_FIELDS });
    const { value = [] } = await this.call<{ value: GraphEvent[] }>(`/me/calendarView?${params}`, { headers: UTC });
    return value.map(toEvent);
  }

  async get(id: string) {
    return toEvent(await this.call<GraphEvent>(`/me/events/${encodeURIComponent(id)}?$select=${EVENT_FIELDS},body`, { headers: { Prefer: `${UTC.Prefer}, ${TEXT_BODY.Prefer}` } }));
  }

  async create(input: EventInput) {
    return toEvent(await this.call<GraphEvent>("/me/events", { body: eventBody(input, Boolean(input.allDay)), headers: UTC }));
  }

  async update(id: string, patch: Partial<EventInput>) {
    const allDay = patch.allDay ?? (await this.get(id)).allDay;
    return toEvent(await this.call<GraphEvent>(`/me/events/${encodeURIComponent(id)}`, { method: "PATCH", body: eventBody(patch, allDay), headers: UTC }));
  }

  async respond(id: string, response: EventResponse, comment?: string) {
    const action = { accept: "accept", tentative: "tentativelyAccept", decline: "decline" }[response];
    await this.call(`/me/events/${encodeURIComponent(id)}/${action}`, { body: { comment: comment ?? "", sendResponse: true } });
  }
}
