/*
 * colony-site: the Cloudflare Worker in front of Colony.
 * - Serves Colony's web app (web/dist, embedded at build time) with a fallback to index.html for
 *   the app's own routes, and long caching for the hashed files in /assets/.
 * - Passes /api/* (sign-in at /api/auth/* too) and WebSocket upgrades to the origin (ORIGIN_URL, a
 *   Cloudflare Tunnel behind its own Access app), signed in to that app with a service token. What
 *   the client sent as CF-Access-* or X-Forwarded-* is dropped first; cookies pass both ways untouched.
 * - When the PC (the origin) can't be reached, API calls get {offline: true} and pages a short note.
 */

/** One embedded file: its bytes (base64) and type. */
export type Asset = { body: string; type: string };
export type Env = {
  /** The origin, e.g. https://colony-origin.werdna.xyz. */
  ORIGIN_URL: string;
  /** The origin Access app's service token (Worker secrets). */
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
};
type Fetcher = (request: Request) => Promise<Response>;

const IMMUTABLE = "public, max-age=31536000, immutable";
const OFFLINE_MESSAGE = "Colony is offline — your PC isn't reachable right now.";

/** A small page with nothing to load: shown when the PC is off or its tunnel is down. */
export const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Colony is offline</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1012;color:#e8e6e1;font:16px/1.5 system-ui,-apple-system,sans-serif;text-align:center}main{max-width:26rem;padding:2rem}h1{font-size:1.3rem;margin:0 0 .5rem}p{margin:0;color:#a7a39b}button{margin-top:1.25rem;font:inherit;padding:.5rem 1.1rem;border-radius:999px;border:1px solid #3a3a3f;background:#1b1c1f;color:inherit;cursor:pointer}</style>
</head><body><main><h1>Colony is offline — your PC isn't reachable right now.</h1><p>Your Bots and chats are safe on your PC. Check that it's on and connected, then try again.</p><button onclick="location.reload()">Try again</button></main></body></html>`;

/** Whether the origin's answer means it isn't there: a tunnel or gateway error, not Colony answering. */
function unreachable(response: Response) {
  // 530 is Cloudflare's "origin unreachable" (error 1033: tunnel not connected). Colony itself answers
  // its own errors in JSON, so a 502/503/504 that isn't JSON came from Cloudflare.
  if (response.status === 530) return true;
  if (![502, 503, 504].includes(response.status)) return false;
  return !(response.headers.get("content-type") ?? "").includes("application/json");
}

const isNavigation = (request: Request) =>
  request.headers.get("Sec-Fetch-Mode") === "navigate" || (request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html"));

function offline(request: Request, path: string) {
  if (path.startsWith("/api/") && !isNavigation(request)) {
    return Response.json({ offline: true, error: OFFLINE_MESSAGE }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(OFFLINE_PAGE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * The request as the origin should get it: the client's own CF-Access-*, X-Forwarded-* and
 * X-Colony-Client-Ip dropped, the Worker's added. The origin sees the Worker's address as
 * Cf-Connecting-Ip, so the visitor's (Cloudflare's CF-Connecting-IP on the incoming request) goes
 * along as X-Colony-Client-Ip, for Colony's sign-in rate limits.
 */
export function originRequest(request: Request, env: Env): Request {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.ORIGIN_URL);
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("cf-access-") || lower.startsWith("x-forwarded-") || lower === "x-colony-client-ip" || lower === "host") return;
    headers.append(name, value);
  });
  if (env.ACCESS_CLIENT_ID) headers.set("CF-Access-Client-Id", env.ACCESS_CLIENT_ID);
  if (env.ACCESS_CLIENT_SECRET) headers.set("CF-Access-Client-Secret", env.ACCESS_CLIENT_SECRET);
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", url.protocol.replace(/:$/, ""));
  const visitor = request.headers.get("CF-Connecting-IP")?.trim();
  if (visitor) headers.set("X-Colony-Client-Ip", visitor);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  return new Request(target.toString(), { method: request.method, headers, body, redirect: "manual", ...({ duplex: "half" } as object) });
}

async function proxy(request: Request, env: Env, fetcher: Fetcher, path: string) {
  let response: Response;
  try { response = await fetcher(originRequest(request, env)); } catch { return offline(request, path); }
  // A WebSocket the origin accepted: handing its answer straight back connects the two.
  if (response.status === 101) return response;
  if (unreachable(response)) return offline(request, path);
  // Passed back as it came (Set-Cookie included).
  return response;
}

const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
function bytesOf(path: string, asset: Asset) {
  let bytes = decoded.get(path);
  if (!bytes) {
    const binary = atob(asset.body);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    decoded.set(path, bytes);
  }
  return bytes;
}

function serve(request: Request, assets: Record<string, Asset>, path: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  let key = path === "/" ? "/index.html" : path;
  let asset = assets[key];
  // The app's own routes (no file extension) are index.html; a missing file is a 404.
  if (!asset && !/\.[a-z0-9]+$/i.test(path)) { key = "/index.html"; asset = assets[key]; }
  if (!asset) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const headers = new Headers({
    "Content-Type": asset.type,
    "Cache-Control": key.startsWith("/assets/") ? IMMUTABLE : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(request.method === "HEAD" ? null : bytesOf(key, asset), { status: 200, headers });
}

/** The Worker, around these embedded files. `fetcher` replaces fetch (tests). */
export function createWorker(assets: Record<string, Asset>, fetcher: Fetcher = (request) => fetch(request)) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/api" || path.startsWith("/api/")) return proxy(request, env, fetcher, path);
      return serve(request, assets, path);
    },
  };
}
