import { ApiError, callApi, type Fetch } from "../http.js";
import { bareAddress, dayBefore, decodeEntities, htmlToText, localDay, splitAddresses, ymd } from "./text.js";
import type { CalEvent, CalendarProvider, Draft, DraftInput, EventInput, EventResponse, MailChanges, MailMessage, MailProvider, MailQuery, MailSummary, OrganizeOp } from "./types.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
type GmailMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };

const header = (message: GmailMessage, name: string) =>
  message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** Walks a MIME tree for its text (plain preferred) and attachment names. */
function bodyOf(part: Part | undefined) {
  let plain = "";
  let html = "";
  const attachments: { name: string; size: number }[] = [];
  const walk = (node: Part | undefined) => {
    if (!node) return;
    if (node.filename) { attachments.push({ name: node.filename, size: node.body?.size ?? 0 }); return; }
    if (node.body?.data) {
      if (node.mimeType === "text/plain" && !plain) plain = decode(node.body.data);
      else if (node.mimeType === "text/html" && !html) html = decode(node.body.data);
    }
    node.parts?.forEach(walk);
  };
  walk(part);
  return { body: (plain || htmlToText(html)).replace(/\r\n/g, "\n").trim(), attachments };
}

function summary(message: GmailMessage): MailSummary {
  return {
    id: message.id,
    threadId: message.threadId,
    from: header(message, "From"),
    to: header(message, "To"),
    subject: header(message, "Subject"),
    date: new Date(Number(message.internalDate ?? 0)).toISOString(),
    snippet: decodeEntities(message.snippet ?? ""),
    unread: message.labelIds?.includes("UNREAD") ?? false,
  };
}

const full = (message: GmailMessage): MailMessage => ({ ...summary(message), cc: header(message, "Cc"), ...bodyOf(message.payload) });

/** Gmail's search operators for a MailQuery. Dates become exact local midnights. */
export function gmailQuery(query: MailQuery) {
  const quote = (value: string) => (/[\s"()]/.test(value) ? `"${value.replace(/"/g, "")}"` : value);
  return [
    query.from && `from:${quote(query.from)}`,
    query.to && `to:${quote(query.to)}`,
    query.subject && `subject:${quote(query.subject)}`,
    query.after && `after:${Math.floor(localDay(query.after).getTime() / 1000)}`,
    query.before && `before:${Math.floor(localDay(query.before).getTime() / 1000)}`,
    query.unread && "is:unread",
    query.inbox && "in:inbox",
    query.text,
  ].filter(Boolean).join(" ");
}

/** A header value, MIME-encoded when it isn't plain ASCII. */
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`);
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** An RFC 822 message for the Gmail API. */
export function rawMessage(input: { to: string[]; cc: string[]; subject: string; body: string; inReplyTo?: string; references?: string }) {
  const lines = [
    `To: ${input.to.map(oneLine).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(oneLine).join(", ")}`] : []),
    `Subject: ${encodeHeader(oneLine(input.subject))}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${oneLine(input.inReplyTo)}`, `References: ${oneLine(input.references || input.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(input.body.replace(/\r?\n/g, "\r\n")).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export class GmailMail implements MailProvider {
  constructor(private token: () => Promise<string>, private fetchImpl: Fetch = fetch) {}

  private call<T>(path: string, init?: Parameters<typeof callApi>[3]) {
    return callApi<T>(this.fetchImpl, this.token, `${GMAIL}${path}`, init);
  }

  private metadata(id: string) {
    const headers = ["From", "To", "Subject", "Date"].map((name) => `metadataHeaders=${name}`).join("&");
    return this.call<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=metadata&${headers}`);
  }

  async search(query: MailQuery, limit: number) {
    const params = new URLSearchParams({ q: gmailQuery(query), maxResults: String(limit) });
    const list = await this.call<{ messages?: { id: string }[] }>(`/messages?${params}`);
    return Promise.all((list.messages ?? []).map(async (item) => summary(await this.metadata(item.id))));
  }

  async read(id: string) {
    return full(await this.call<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`));
  }

  async thread(threadId: string) {
    const thread = await this.call<{ messages?: GmailMessage[] }>(`/threads/${encodeURIComponent(threadId)}?format=full`);
    return (thread.messages ?? []).map(full);
  }

  /** What a reply needs from the message it answers. */
  private async replyContext(id: string) {
    const headers = ["From", "Reply-To", "Subject", "Message-ID", "References"].map((name) => `metadataHeaders=${name}`).join("&");
    const original = await this.call<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=metadata&${headers}`);
    const messageId = header(original, "Message-ID");
    const subject = header(original, "Subject");
    return {
      threadId: original.threadId,
      inReplyTo: messageId,
      references: [header(original, "References"), messageId].filter(Boolean).join(" "),
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      to: [header(original, "Reply-To") || header(original, "From")].filter(Boolean),
    };
  }

  private async compose(input: DraftInput, keep?: { threadId?: string; inReplyTo?: string; references?: string }) {
    const reply = input.replyToId ? await this.replyContext(input.replyToId) : null;
    const raw = rawMessage({
      to: input.to.length ? input.to : reply?.to ?? [],
      cc: input.cc,
      subject: input.subject || reply?.subject || "",
      body: input.body,
      inReplyTo: reply?.inReplyTo || keep?.inReplyTo,
      references: reply?.references || keep?.references,
    });
    return { raw, threadId: reply?.threadId ?? keep?.threadId };
  }

  async createDraft(input: DraftInput) {
    const draft = await this.call<{ id: string }>("/drafts", { body: { message: await this.compose(input) } });
    return this.getDraft(draft.id);
  }

  async updateDraft(id: string, input: DraftInput) {
    const current = await this.call<{ message: GmailMessage }>(`/drafts/${encodeURIComponent(id)}?format=metadata`);
    const keep = { threadId: current.message.threadId, inReplyTo: header(current.message, "In-Reply-To"), references: header(current.message, "References") };
    await this.call(`/drafts/${encodeURIComponent(id)}`, { method: "PUT", body: { id, message: await this.compose(input, keep) } });
    return this.getDraft(id);
  }

  async getDraft(id: string): Promise<Draft> {
    const draft = await this.call<{ id: string; message: GmailMessage }>(`/drafts/${encodeURIComponent(id)}?format=full`);
    return {
      id: draft.id,
      to: splitAddresses(header(draft.message, "To")),
      cc: splitAddresses(header(draft.message, "Cc")),
      subject: header(draft.message, "Subject"),
      body: bodyOf(draft.message.payload).body,
    };
  }

  async sendDraft(id: string) {
    await this.call("/drafts/send", { body: { id } });
  }

  private async labelId(name: string, create: boolean) {
    const { labels = [] } = await this.call<{ labels?: { id: string; name: string }[] }>("/labels");
    const found = labels.find((label) => label.name.toLowerCase() === name.toLowerCase() || label.id === name.toUpperCase());
    if (found || !create) return found?.id ?? null;
    const made = await this.call<{ id: string }>("/labels", { body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
    return made.id;
  }

  async organize(ids: string[], op: OrganizeOp) {
    const add: string[] = [];
    const remove: string[] = [];
    if (op.archive) remove.push("INBOX");
    if (op.read === true) remove.push("UNREAD");
    if (op.read === false) add.push("UNREAD");
    if (op.addLabel) add.push((await this.labelId(op.addLabel, true))!);
    if (op.removeLabel) { const id = await this.labelId(op.removeLabel, false); if (id) remove.push(id); }
    if (!add.length && !remove.length) return;
    await this.call("/messages/batchModify", { body: { ids, addLabelIds: add, removeLabelIds: remove } });
  }

  async changes(cursor: string | null): Promise<MailChanges> {
    const start = async () => ({ added: [], cursor: (await this.call<{ historyId: string }>("/profile")).historyId });
    if (!cursor) return start();
    const ids = new Set<string>();
    let next = cursor;
    let pageToken: string | undefined;
    try {
      do {
        const params = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded", labelId: "INBOX", ...(pageToken ? { pageToken } : {}) });
        const page = await this.call<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId: string; nextPageToken?: string }>(`/history?${params}`);
        for (const entry of page.history ?? []) {
          for (const { message } of entry.messagesAdded ?? []) {
            const labels = message.labelIds ?? [];
            if (labels.includes("INBOX") && !labels.includes("SENT") && !labels.includes("DRAFT")) ids.add(message.id);
          }
        }
        next = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) {
      // Gmail keeps about a week of history; after a long gap, start again from now.
      if (error instanceof ApiError && error.status === 404) return start();
      throw error;
    }
    const added: MailSummary[] = [];
    for (const id of [...ids].slice(0, 20)) {
      try { added.push(summary(await this.metadata(id))); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    }
    return { added, cursor: next };
  }
}

type GoogleEvent = {
  id: string; summary?: string; location?: string; description?: string; htmlLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  attendees?: { email: string; displayName?: string; responseStatus?: string; self?: boolean; comment?: string }[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
};


function toEvent(event: GoogleEvent): CalEvent {
  const description = event.description ?? "";
  return {
    id: event.id,
    title: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    // All-day events: Google's end is the day after; show the last day.
    end: event.end?.dateTime ?? (event.end?.date ? dayBefore(event.end.date) : ""),
    allDay: Boolean(event.start?.date),
    location: event.location ?? "",
    description: /<[a-z][\s\S]*>/i.test(description) ? htmlToText(description) : description,
    attendees: (event.attendees ?? []).map((item) => ({ email: item.email, name: item.displayName, response: item.responseStatus })),
    organizer: event.organizer?.email ?? "",
    isOrganizer: event.organizer?.self ?? false,
    myResponse: event.attendees?.find((item) => item.self)?.responseStatus ?? null,
    link: event.htmlLink ?? null,
  };
}

/** Google's event body for an input. An all-day event's `end` is its last day; Google wants the day after. */
function eventBody(input: Partial<EventInput>) {
  const when = (date: Date, end: boolean) => input.allDay
    ? { date: ymd(end ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) : date) }
    : { dateTime: date.toISOString() };
  return {
    ...(input.title !== undefined ? { summary: input.title } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.start ? { start: when(input.start, false) } : {}),
    ...(input.end ? { end: when(input.end, true) } : {}),
    ...(input.attendees ? { attendees: input.attendees.map((email) => ({ email: bareAddress(email) })) } : {}),
  };
}

export class GoogleCalendar implements CalendarProvider {
  constructor(private token: () => Promise<string>, private fetchImpl: Fetch = fetch) {}

  private call<T>(path: string, init?: Parameters<typeof callApi>[3]) {
    return callApi<T>(this.fetchImpl, this.token, `${CALENDAR}${path}`, init).catch((error) => {
      if (error instanceof ApiError && error.status === 403 && /scope|permission/i.test(error.message)) {
        throw new Error("This Google account didn't give Colony calendar access. Ask the user to reconnect it in Settings and tick the calendar box.");
      }
      throw error;
    });
  }

  async list(from: Date, to: Date) {
    const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100" });
    const { items = [] } = await this.call<{ items?: GoogleEvent[] }>(`/events?${params}`);
    return items.map(toEvent);
  }

  async get(id: string) {
    return toEvent(await this.call<GoogleEvent>(`/events/${encodeURIComponent(id)}`));
  }

  async create(input: EventInput) {
    return toEvent(await this.call<GoogleEvent>("/events?sendUpdates=all", { body: eventBody(input) }));
  }

  async update(id: string, patch: Partial<EventInput>) {
    // All-day-ness has to match the event when only one end changes.
    const allDay = patch.allDay ?? (await this.get(id)).allDay;
    return toEvent(await this.call<GoogleEvent>(`/events/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", body: eventBody({ ...patch, allDay }) }));
  }

  async respond(id: string, response: EventResponse, comment?: string) {
    const event = await this.call<GoogleEvent>(`/events/${encodeURIComponent(id)}`);
    if (!event.attendees?.some((item) => item.self)) throw new Error("You aren't on this event's guest list, so there's nothing to answer.");
    const status = { accept: "accepted", tentative: "tentative", decline: "declined" }[response];
    const attendees = event.attendees.map((item) => (item.self ? { ...item, responseStatus: status, ...(comment ? { comment } : {}) } : item));
    await this.call(`/events/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", body: { attendees } });
  }
}
