import crypto from "node:crypto";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { resolver, standardSources, type WebSession } from "./access.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { People, type Person } from "./people.js";
import { Store } from "./store.js";
import { decideUpgrade, refuseUpgrade } from "./upgrades.js";

/*
 * Refused WebSocket upgrades get a real HTTP answer (401, 403 or 404, JSON) before the socket closes,
 * so the colony-site Worker passes it on rather than showing "Colony is offline" for a broken connection.
 */

const SITE = "https://colony.example";
const team = "team.cloudflareaccess.com";
const aud = "origin-aud";
const SERVICE = "svc.access";
const signer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const cloudflare = { teamDomain: team, aud, serviceClientId: SERVICE, keys: async () => [{ ...signer.publicKey.export({ format: "jwk" }), kid: "k1" }] };
const serviceJwt = () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${part({ alg: "RS256", kid: "k1" })}.${part({ aud: [aud], iss: `https://${team}`, common_name: SERVICE, iat: now, exp: now + 600 })}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), signer.privateKey).toString("base64url")}`;
};

const db = openDb(":memory:");
const store = new Store(db, new EventLog(db));
const people = new People(store, { adminEmails: [] });
const ana = people.byEmail("ana@example.com") as Person;
const bo = people.byEmail("bo@example.com") as Person;
const anaBot = store.createBot({ name: "Ana's", title: "", description: "", model: "", computer: true, ownerId: ana.id });
const turnedOff = { ...bo, disabled: true };
/** Sessions as cookies: "session=ana" is Ana, "session=off" a turned-off member. */
const web: WebSession = async (header) => {
  const who = /(?:^|;\s*)session=(\w+)/.exec(header("Cookie") ?? "")?.[1];
  return who === "ana" ? ana : who === "bo" ? bo : who === "off" ? (turnedOff.disabled ? "disabled" : null) : null;
};
const resolve = resolver(standardSources({ allowed: [], login: () => null, claim: () => {} }, cloudflare), people, web);

/** Serves upgrades the way index.ts does: refused ones answered; allowed ones switch (and close, here). */
let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer();
  server.on("upgrade", (request, socket) => {
    const header = (name: string) => { const value = request.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; };
    void decideUpgrade(resolve, header, [SITE], store, request.url ?? "").then((decided) => {
      if ("status" in decided) { refuseUpgrade(socket, decided); return; }
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Kind: ${decided.upgrade.kind}\r\n\r\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

/** A raw upgrade request: the status line, headers and body that came back. */
function upgrade(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; reason: string; headers: Record<string, string>; body: string }>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      const [head, body = ""] = raw.split("\r\n\r\n");
      const [statusLine, ...lines] = head.split("\r\n");
      const [, status, reason] = /^HTTP\/1\.1 (\d{3}) (.*)$/.exec(statusLine) ?? [];
      resolve({ status: Number(status), reason, body, headers: Object.fromEntries(lines.map((line) => [line.split(":")[0].toLowerCase(), line.slice(line.indexOf(":") + 1).trim()])) });
    });
    const all = { Host: "colony-origin.example", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", ...headers };
    socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(all).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
  });
}
const site = (cookie?: string, extra: Record<string, string> = {}) => ({
  "Cf-Connecting-Ip": "203.0.113.7", "Cf-Ray": "8abc-LHR", "Cf-Access-Jwt-Assertion": serviceJwt(), Origin: SITE, ...(cookie ? { Cookie: cookie } : {}), ...extra,
});

test("through the website without a sign-in: 401, as JSON, and the connection closes", async () => {
  const response = await upgrade(`/api/chats/${anaBot.chatId}/call`, site());
  expect(response).toMatchObject({ status: 401, reason: "Unauthorized" });
  expect(response.headers["content-type"]).toBe("application/json");
  expect(response.headers.connection).toBe("close");
  expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(response.body));
  expect(JSON.parse(response.body)).toEqual({ error: "Sign in to Colony." });
});

test("refused, turned off, from another page, or not yours: 403", async () => {
  const cases: [string, Record<string, string>][] = [
    // No origin token at all.
    [`/api/chats/${anaBot.chatId}/call`, { "Cf-Connecting-Ip": "203.0.113.7", Cookie: "session=ana", Origin: SITE }],
    [`/api/chats/${anaBot.chatId}/call`, site("session=off")],
    [`/api/chats/${anaBot.chatId}/call`, site("session=ana", { Origin: "https://evil.example" })],
    // Bo's sign-in, Ana's chat and screen; and lending a PC (the admin's).
    [`/api/chats/${anaBot.chatId}/call`, site("session=bo")],
    [`/api/bots/${anaBot.id}/screen/media`, site("session=bo")],
    ["/api/nodes/connect", site("session=ana")],
  ];
  for (const [path, headers] of cases) {
    const response = await upgrade(path, headers);
    expect(response.status, `${path} ${JSON.stringify(headers.Cookie)}`).toBe(403);
    expect(response.reason).toBe("Forbidden");
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers.connection).toBe("close");
    expect(JSON.parse(response.body)).toHaveProperty("error");
  }
});

test("an upgrade Colony doesn't take: 404, whoever asks", async () => {
  for (const headers of [site("session=ana"), site(), {}]) {
    const response = await upgrade("/api/events", headers);
    expect(response).toMatchObject({ status: 404, reason: "Not Found" });
    expect(JSON.parse(response.body)).toEqual({ error: "Not found." });
  }
});

test("the owner's upgrade goes through, from the website and from this PC", async () => {
  expect(await upgrade(`/api/chats/${anaBot.chatId}/call`, site("session=ana"))).toMatchObject({ status: 101, headers: { "x-kind": "call" } });
  expect(await upgrade(`/api/bots/${anaBot.id}/screen/media?x=1`, site("session=ana"))).toMatchObject({ status: 101, headers: { "x-kind": "screen" } });
  expect(await upgrade("/api/nodes/connect")).toMatchObject({ status: 101, headers: { "x-kind": "nodes" } });
});
