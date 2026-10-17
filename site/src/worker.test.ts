import { describe, expect, test } from "vitest";
import { createWorker, OFFLINE_PAGE, originRequest, type Asset, type Env } from "./worker.js";

const b64 = (text: string) => btoa(text);
const ASSETS: Record<string, Asset> = {
  "/index.html": { body: b64("<!doctype html><div id=root></div>"), type: "text/html; charset=utf-8" },
  "/assets/index-abc123.js": { body: b64("console.log(1)"), type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { body: b64("{}"), type: "application/manifest+json" },
};
const ENV: Env = { ORIGIN_URL: "https://colony-origin.example", ACCESS_CLIENT_ID: "id.access", ACCESS_CLIENT_SECRET: "s3cret" };
const SITE = "https://colony.example";

/** A Worker whose origin answers with `answer`, recording what it was sent. */
function worker(answer: (request: Request) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const sent: Request[] = [];
  const site = createWorker(ASSETS, async (request) => { sent.push(request); return answer(request); });
  return { sent, fetch: (path: string, init?: RequestInit) => site.fetch(new Request(`${SITE}${path}`, init), ENV) };
}

describe("the web app", () => {
  test("serves embedded files, with long caching only for hashed /assets/", async () => {
    const { fetch, sent } = worker();
    const home = await fetch("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(home.headers.get("cache-control")).toBe("no-cache");
    expect(await home.text()).toContain("id=root");
    const script = await fetch("/assets/index-abc123.js");
    expect(await script.text()).toBe("console.log(1)");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json");
    expect(sent).toEqual([]); // Nothing went to the origin.
  });

  test("the app's own routes fall back to index.html; missing files are 404", async () => {
    const { fetch } = worker();
    for (const route of ["/signup", "/signin", "/chat/abc"]) {
      const page = await fetch(`${route}?invite=x`);
      expect(page.status, route).toBe(200);
      expect(await page.text()).toContain("id=root");
    }
    expect((await fetch("/assets/missing-1.js")).status).toBe(404);
    expect((await fetch("/favicon.ico")).status).toBe(404);
    expect((await fetch("/", { method: "POST" })).status).toBe(405);
    const head = await fetch("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("/api goes to the origin", () => {
  test("with the service token and forwarded host added, and the client's own copies dropped", async () => {
    const { fetch, sent } = worker();
    await fetch("/api/state?since=3", {
      headers: {
        "CF-Access-Client-Id": "forged", "cf-access-client-secret": "forged", "Cf-Access-Jwt-Assertion": "forged",
        "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http", "X-Forwarded-For": "1.2.3.4",
        Cookie: "better-auth.session_token=abc.def; other=1", Origin: SITE, "User-Agent": "test",
      },
    });
    const [request] = sent;
    expect(request.url).toBe("https://colony-origin.example/api/state?since=3");
    expect(request.headers.get("cf-access-client-id")).toBe("id.access");
    expect(request.headers.get("cf-access-client-secret")).toBe("s3cret");
    expect(request.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(request.headers.get("x-forwarded-host")).toBe("colony.example");
    expect(request.headers.get("x-forwarded-proto")).toBe("https");
    expect(request.headers.get("x-forwarded-for")).toBeNull();
    // Sign-in cookies and the rest pass unchanged.
    expect(request.headers.get("cookie")).toBe("better-auth.session_token=abc.def; other=1");
    expect(request.headers.get("origin")).toBe(SITE);
    expect(request.headers.get("user-agent")).toBe("test");
  });

  test("passes bodies and methods through, and hands back the origin's answer with its cookies", async () => {
    const { fetch, sent } = worker(() => {
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", "better-auth.session_token=new; Path=/; HttpOnly; Secure; SameSite=Lax");
      headers.append("Set-Cookie", "better-auth.session_data=x; Path=/; HttpOnly; Secure; SameSite=Lax");
      return new Response(JSON.stringify({ user: { email: "a@example.com" } }), { status: 200, headers });
    });
    const response = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@example.com", password: "pw" }) });
    expect(sent[0].method).toBe("POST");
    expect(await sent[0].json()).toEqual({ email: "a@example.com", password: "pw" });
    expect(response.headers.getSetCookie()).toEqual([
      "better-auth.session_token=new; Path=/; HttpOnly; Secure; SameSite=Lax",
      "better-auth.session_data=x; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(await response.json()).toEqual({ user: { email: "a@example.com" } });
  });

  test("Colony's own errors pass through as they are", async () => {
    const { fetch } = worker(() => Response.json({ error: "Notifications are off." }, { status: 503 }));
    const response = await fetch("/api/push/key");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Notifications are off." });
    const { fetch: fetch401 } = worker(() => Response.json({ error: "Sign in." }, { status: 401 }));
    expect((await fetch401("/api/state")).status).toBe(401);
  });

  test("a WebSocket upgrade goes to the origin with its upgrade headers, and the origin's answer comes back", async () => {
    const upgraded = new Response(null, { status: 200 });
    Object.defineProperty(upgraded, "status", { value: 101 });
    const { fetch, sent } = worker(() => upgraded);
    const response = await fetch("/api/chats/c1/call", {
      headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", Origin: SITE, Cookie: "better-auth.session_token=abc" },
    });
    expect(response).toBe(upgraded);
    expect(sent[0].url).toBe("https://colony-origin.example/api/chats/c1/call");
    expect(sent[0].headers.get("upgrade")).toBe("websocket");
    expect(sent[0].headers.get("sec-websocket-key")).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(sent[0].headers.get("cf-access-client-id")).toBe("id.access");
    expect(sent[0].headers.get("cookie")).toBe("better-auth.session_token=abc");
  });
});

describe("when the PC can't be reached", () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ["the fetch fails", () => { throw new TypeError("fetch failed"); }],
    ["the tunnel isn't connected (error 1033, 530)", () => new Response("error code: 1033", { status: 530, headers: { "Content-Type": "text/html" } })],
    ["a gateway error (502)", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })],
    ["the origin is down (503)", () => new Response("unavailable", { status: 503 })],
    ["the origin timed out (504)", () => new Response("timeout", { status: 504, headers: { "Content-Type": "text/html" } })],
  ];
  for (const [name, answer] of cases) {
    test(`${name}: API calls get {offline: true}, pages an offline note`, async () => {
      const { fetch } = worker(answer);
      const api = await fetch("/api/state", { headers: { Accept: "application/json" } });
      expect(api.status).toBe(503);
      expect(await api.json()).toMatchObject({ offline: true });
      const page = await fetch("/api/auth/verify-email?token=x", { headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" } });
      expect(page.status).toBe(503);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toBe(OFFLINE_PAGE);
    });
  }

  test("the offline page loads nothing from anywhere", () => {
    expect(OFFLINE_PAGE).toContain("Colony is offline — your PC isn't reachable right now");
    expect(OFFLINE_PAGE).not.toMatch(/<(script|link|img)\b[^>]*\b(src|href)=/i);
  });
});

test("originRequest keeps the path and query, and nothing else from the site's own address", () => {
  const request = originRequest(new Request(`${SITE}/api/files/f1?download=1`, { headers: { Host: "colony.example" } }), ENV);
  expect(request.url).toBe("https://colony-origin.example/api/files/f1?download=1");
  expect(request.headers.get("host")).toBeNull();
});
