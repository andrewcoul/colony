import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-providers-"));
process.env.COLONY_DATA_DIR = dataDir;

const { openDb } = await import("../db.js");
const { EventLog } = await import("../events.js");
const { Accounts } = await import("./accounts.js");
const { Tokens } = await import("./oauth.js");
const { GmailMail, GoogleCalendar, gmailQuery, rawMessage } = await import("./mail/gmail.js");
const { GraphMail, graphSearch } = await import("./mail/graph.js");
const { htmlToText, splitAddresses } = await import("./mail/text.js");
const { originMatches, generatePassword } = await import("./onepassword.js");
const { Scrubber } = await import("../agent/scrub.js");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown } | undefined;

/** A fetch that answers from `route` and records every request. */
function fakeFetch(route: Route) {
  const calls: { url: URL; method: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? (init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });
    const answer = route(url, init) ?? { status: 404, body: { error: { message: "not found" } } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const token = async () => "token";
const b64 = (text: string) => Buffer.from(text).toString("base64url");

describe("mail text", () => {
  test("email HTML becomes readable text", () => {
    const html = `<html><head><style>p{}</style></head><body><p>Hi &amp; welcome</p><ul><li>One</li><li>Two</li></ul><a href="https://x.com/a">the link</a><br>Bye&nbsp;now</body></html>`;
    expect(htmlToText(html)).toBe("Hi & welcome\n\n- One\n- Two\n\nthe link (https://x.com/a)\nBye now");
  });

  test("address lists respect quoted names", () => {
    expect(splitAddresses(`"Smith, Ann" <ann@x.com>, bob@y.com`)).toEqual([`"Smith, Ann" <ann@x.com>`, "bob@y.com"]);
  });
});

describe("Gmail", () => {
  test("searches translate to Gmail operators with exact local midnights", () => {
    const q = gmailQuery({ from: "alice@x.com", subject: "Q3 numbers", after: "2026-10-01", unread: true, inbox: true, text: "invoice" });
    expect(q).toBe(`from:alice@x.com subject:"Q3 numbers" after:${new Date(2026, 9, 1).getTime() / 1000} is:unread in:inbox invoice`);
  });

  test("drafts are plain-text messages with encoded non-ASCII subjects", () => {
    const raw = Buffer.from(rawMessage({ to: ["a@x.com"], cc: [], subject: "Café plans", body: "See you\nthere", inReplyTo: "<m1@x>" }), "base64url").toString();
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Café plans").toString("base64")}?=`);
    expect(raw).toContain("In-Reply-To: <m1@x>\r\nReferences: <m1@x>");
    expect(Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString()).toBe("See you\r\nthere");
  });

  test("reads the plain-text part and lists attachments", async () => {
    const { fetchImpl } = fakeFetch((url) => url.pathname.endsWith("/messages/m1") ? { body: {
      id: "m1", threadId: "t1", labelIds: ["UNREAD"], snippet: "Hi &amp; hello", internalDate: "1760000000000",
      payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "Ann <ann@x.com>" }, { name: "Subject", value: "Hello" }], parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Plain body") } }, { mimeType: "text/html", body: { data: b64("<p>HTML body</p>") } }] },
        { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "a1", size: 2048 } },
      ] },
    } } : undefined);
    const message = await new GmailMail(token, fetchImpl).read("m1");
    expect(message).toMatchObject({ from: "Ann <ann@x.com>", subject: "Hello", body: "Plain body", unread: true, snippet: "Hi & hello", attachments: [{ name: "report.pdf", size: 2048 }] });
  });

  test("new mail: starts from now, then reports inbox arrivals; an expired position starts again", async () => {
    let historyStatus = 200;
    const { fetchImpl } = fakeFetch((url) => {
      if (url.pathname.endsWith("/profile")) return { body: { historyId: "100" } };
      if (url.pathname.endsWith("/history")) return historyStatus === 404 ? { status: 404, body: { error: { message: "Requested entity was not found." } } } : { body: {
        historyId: "120",
        history: [{ messagesAdded: [{ message: { id: "new1", labelIds: ["INBOX", "UNREAD"] } }, { message: { id: "sent1", labelIds: ["SENT", "INBOX"] } }] }],
      } };
      if (url.pathname.endsWith("/messages/new1")) return { body: { id: "new1", threadId: "t", internalDate: "0", payload: { headers: [{ name: "From", value: "bank@x.com" }, { name: "Subject", value: "Statement" }] } } };
      return undefined;
    });
    const gmail = new GmailMail(token, fetchImpl);
    expect(await gmail.changes(null)).toEqual({ added: [], cursor: "100" });
    const next = await gmail.changes("100");
    expect(next.cursor).toBe("120");
    expect(next.added.map((item) => [item.id, item.from, item.subject])).toEqual([["new1", "bank@x.com", "Statement"]]);
    historyStatus = 404;
    expect(await gmail.changes("5")).toEqual({ added: [], cursor: "100" });
  });

  test("answering an invitation sets only your own response", async () => {
    const { fetchImpl, calls } = fakeFetch((url, init) => url.pathname.endsWith("/events/e1") && (init.method ?? "GET") === "GET"
      ? { body: { id: "e1", attendees: [{ email: "me@x.com", self: true, responseStatus: "needsAction" }, { email: "boss@x.com", responseStatus: "accepted" }] } }
      : { body: { id: "e1" } });
    await new GoogleCalendar(token, fetchImpl).respond("e1", "decline", "Clash");
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("all");
    expect(patch.body).toEqual({ attendees: [{ email: "me@x.com", self: true, responseStatus: "declined", comment: "Clash" }, { email: "boss@x.com", responseStatus: "accepted" }] });
  });

  test("all-day events show their last day, and are saved ending the day after", async () => {
    const { fetchImpl, calls } = fakeFetch((_url, init) => (init.method === "POST" ? { body: { id: "e2", start: { date: "2026-10-20" }, end: { date: "2026-10-22" } } } : undefined));
    const event = await new GoogleCalendar(token, fetchImpl).create({ title: "Offsite", start: new Date(2026, 9, 20), end: new Date(2026, 9, 21), allDay: true });
    expect(calls[0].body).toMatchObject({ start: { date: "2026-10-20" }, end: { date: "2026-10-22" } });
    expect(event).toMatchObject({ start: "2026-10-20", end: "2026-10-21", allDay: true });
  });
});

describe("Outlook (Microsoft Graph)", () => {
  test("words become $search; dates and unread alone become $filter", async () => {
    expect(graphSearch({ from: "ann@x.com", subject: "Q3 numbers", text: "invoice" })).toBe(`"from:ann@x.com subject:'Q3 numbers' invoice"`);
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { value: [
      { id: "1", receivedDateTime: "2026-10-02T10:00:00Z", isRead: false, from: { emailAddress: { name: "Ann", address: "ann@x.com" } } },
      { id: "2", receivedDateTime: "2026-09-02T10:00:00Z", isRead: false },
    ] } }));
    const mail = new GraphMail(token, fetchImpl);
    const found = await mail.search({ from: "ann@x.com", after: "2026-10-01" }, 10);
    expect(calls[0].url.searchParams.get("$search")).toBe(`"from:ann@x.com"`);
    expect(found.map((item) => [item.id, item.from])).toEqual([["1", "Ann <ann@x.com>"]]);
    await mail.search({ unread: true, inbox: true }, 5);
    expect(calls[1].url.pathname).toBe("/v1.0/me/mailFolders/inbox/messages");
    expect(calls[1].url.searchParams.get("$filter")).toBe("isRead eq false");
  });

  test("new mail: reports each message once, even ones sharing a timestamp", async () => {
    let inbox = [{ id: "a", receivedDateTime: "2026-10-14T09:00:00Z" }];
    const { fetchImpl } = fakeFetch(() => ({ body: { value: inbox } }));
    const mail = new GraphMail(token, fetchImpl);
    const start = await mail.changes(null);
    expect(start.added).toEqual([]);
    const first = await mail.changes(JSON.stringify({ t: "2026-10-14T08:00:00Z", ids: [] }));
    expect(first.added.map((item) => item.id)).toEqual(["a"]);
    inbox = [{ id: "a", receivedDateTime: "2026-10-14T09:00:00Z" }, { id: "b", receivedDateTime: "2026-10-14T09:00:00Z" }];
    const second = await mail.changes(first.cursor);
    expect(second.added.map((item) => item.id)).toEqual(["b"]);
    expect(JSON.parse(second.cursor)).toEqual({ t: "2026-10-14T09:00:00Z", ids: ["a", "b"] });
  });

  test("a reply draft keeps the quote and only patches recipients you name", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith("/createReply")) return { body: { id: "d1" } };
      if (url.pathname.endsWith("/messages/d1")) return { body: { id: "d1", isDraft: true, subject: "RE: Hi", toRecipients: [{ emailAddress: { address: "ann@x.com" } }], body: { content: "Sounds good\r\n\r\n> quote" } } };
      return undefined;
    });
    const draft = await new GraphMail(token, fetchImpl).createDraft({ to: [], cc: [], subject: "", body: "Sounds good", replyToId: "m1" });
    expect(calls[0].body).toEqual({ comment: "Sounds good" });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(draft).toEqual({ id: "d1", to: ["ann@x.com"], cc: [], subject: "RE: Hi", body: "Sounds good\n\n> quote" });
  });
});

describe("sign-in tokens", () => {
  function accountsWith(kind: "google" | "microsoft") {
    const db = openDb(":memory:");
    const accounts = new Accounts(db, new EventLog(db), path.join(dataDir, `accounts-${kind}-${Math.random()}.json`));
    const account = kind === "google"
      ? accounts.connect({ kind, label: "Gmail", email: "me@gmail.com" }, { kind, clientId: "cid", clientSecret: "cs", refreshToken: "r1", scopes: [] })
      : accounts.connect({ kind, label: "Outlook", email: "me@outlook.com" }, { kind, clientId: "cid", refreshToken: "r1" });
    return { accounts, account };
  }

  test("Microsoft's rotated refresh tokens are kept; access tokens are reused until near expiry", async () => {
    const { accounts, account } = accountsWith("microsoft");
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { access_token: "at1", refresh_token: "r2", expires_in: 3600 } }));
    const tokens = new Tokens(accounts, fetchImpl);
    expect(await tokens.get(account.id)).toBe("at1");
    expect(await tokens.get(account.id)).toBe("at1");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1", client_id: "cid" });
    expect(accounts.secret(account.id)).toMatchObject({ refreshToken: "r2" });
  });

  test("a revoked sign-in marks the account for reconnecting and tells you", async () => {
    const { accounts, account } = accountsWith("google");
    const told: string[] = [];
    accounts.onNeedsReauth = (item) => told.push(item.email);
    const { fetchImpl } = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await expect(new Tokens(accounts, fetchImpl).get(account.id)).rejects.toThrow(/needs reconnecting/);
    expect(accounts.get(account.id)!.status).toBe("needs_reauth");
    expect(told).toEqual(["me@gmail.com"]);
    // Reconnecting the same mailbox clears it and keeps the account (and Bots' access).
    const again = accounts.connect({ kind: "google", label: "Gmail", email: "ME@gmail.com" }, { kind: "google", clientId: "cid", clientSecret: "cs", refreshToken: "r9", scopes: [] });
    expect(again).toMatchObject({ id: account.id, status: "ok" });
  });

  test("tokens live in the secrets file, readable only by you, never in the database", () => {
    const { accounts, account } = accountsWith("google");
    const file = (accounts as unknown as { file: string }).file;
    expect(JSON.parse(fs.readFileSync(file, "utf8")).accounts[account.id].refreshToken).toBe("r1");
    expect(JSON.stringify(accounts.list())).not.toContain("r1");
  });
});

describe("1Password safety", () => {
  test("logins only go to their own sites, over https", () => {
    expect(originMatches("https://github.com/login", ["https://github.com"])).toBe(true);
    expect(originMatches("https://www.github.com/login", ["github.com"])).toBe(true);
    expect(originMatches("https://gist.github.com/", ["https://github.com"])).toBe(true);
    expect(originMatches("https://github.com.evil.io/login", ["https://github.com"])).toBe(false);
    expect(originMatches("https://evilgithub.com/", ["https://github.com"])).toBe(false);
    expect(originMatches("http://github.com/login", ["https://github.com"])).toBe(false);
    expect(originMatches("https://github.com/", [])).toBe(false);
  });

  test("generated passwords are long and mixed", () => {
    const password = generatePassword();
    expect(password).toHaveLength(24);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/\d/);
    expect(password).toMatch(/[!@#$%^&*\-_=+?]/);
  });

  test("the scrubber removes secrets anywhere in a result", () => {
    const scrubber = new Scrubber();
    scrubber.add("hunter2-secret");
    scrubber.add("123"); // too short to scrub safely
    expect(scrubber.deep({ page: "value=hunter2-secret", list: ["x hunter2-secret"], n: 123 })).toEqual({ page: "value=[secret]", list: ["x [secret]"], n: 123 });
  });
});
