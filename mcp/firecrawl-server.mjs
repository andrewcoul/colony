import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// A deliberately small read-only MCP surface for the installed Firecrawl API, shared by
// the Colony app and local coding agents (Claude Code, Codex, OpenCode).
// Newer official MCP releases add fields this self-hosted API doesn't accept.

// Mirrors convex/urlPolicy.ts (this container builds from ./mcp only, so it can't import it).
// Keeps scrape from being used to reach loopback, LAN, or cloud-metadata addresses.
function isPublicWebUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[") || !host.includes(".")) return false;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}

// Mirrors server/src/agent/tools.ts. Firecrawl answers almost every scrape failure with a 500
// plus a code, so the message has to come from the code: a site blocking bots isn't an outage.
class FirecrawlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function explainFailure(status, { code = `HTTP_${status}`, error = "" }) {
  if (/ANTIBOT/.test(code) || /antibot/i.test(error)) {
    return new FirecrawlError(code, "This site blocks automated access, and Firecrawl's anti-bot retries ran out. Retrying won't help; use a different source.");
  }
  if (code === "SCRAPE_TIMEOUT") return new FirecrawlError(code, "The page took too long to load. Try once more, or use a different source.");
  return new FirecrawlError(code, `Firecrawl couldn't do that (${code})${error ? `: ${String(error).slice(0, 300)}` : "."}`);
}

// Every agent on this PC shares one Firecrawl, which only works a couple of pages at a time.
// Calls past the limit wait briefly in line; past that, they fail fast with BUSY instead of
// piling up until every caller times out (a swarm of subagents once took the whole PC down).
const maxActive = Number(process.env.FIRECRAWL_MAX_CONCURRENT || 3);
const maxWaiting = Number(process.env.FIRECRAWL_MAX_QUEUED || 6);
const maxWaitMs = 30000;
let active = 0;
const waiting = [];

function busy() {
  return new FirecrawlError("BUSY", `Self-hosted Firecrawl is busy (${active} calls running, ${waiting.length} waiting). Wait a minute before trying again, and make calls one at a time rather than in parallel.`);
}

async function acquire() {
  if (active < maxActive) { active++; return; }
  if (waiting.length >= maxWaiting) throw busy();
  await new Promise((resolve, reject) => {
    const entry = { resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(busy()); }, maxWaitMs) };
    waiting.push(entry);
  });
}

// A finished call hands its slot straight to the next one in line.
function release() {
  const next = waiting.shift();
  if (next) { clearTimeout(next.timer); next.resolve(); } else active--;
}

async function firecrawl(path, body, timeoutMs) {
  await acquire();
  try { return await callFirecrawl(path, body, timeoutMs); } finally { release(); }
}

// timeoutMs is our own deadline; Firecrawl gets a shorter one so it reports its own timeout first.
async function callFirecrawl(path, body, timeoutMs) {
  let response;
  try {
    response = await fetch(new URL(path, process.env.FIRECRAWL_API_URL), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, timeout: timeoutMs - 5000 }), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new FirecrawlError("CLIENT_TIMEOUT", `Self-hosted Firecrawl didn't answer within ${timeoutMs / 1000}s. Try once more, or use a different source.`);
    throw new FirecrawlError("UNREACHABLE", "Self-hosted Firecrawl isn't reachable. Check that its Docker containers are running.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw explainFailure(response.status, data);
  return data.data;
}

// One line per tool call, so failures can be traced with `docker logs`.
function logCall(tool, target, startedAt, error) {
  console.log(`${tool} ${target} ${error ? `failed ${error.code || error.name}` : "ok"} ${Date.now() - startedAt}ms`);
}

function failure(error) {
  const text = error instanceof FirecrawlError ? error.message : "Self-hosted Firecrawl failed unexpectedly. Try once more.";
  return { isError: true, content: [{ type: "text", text }] };
}

function createMcp() {
  const server = new McpServer({ name: "Colony Firecrawl", version: "0.3.0" });

  server.registerTool("firecrawl_scrape", {
    description: "Fetch one public web page through the owner's self-hosted Firecrawl and return it as Markdown. Use after firecrawl_search to read a source in full.",
    inputSchema: {
      url: z.string().url().max(2000),
      onlyMainContent: z.boolean().optional().describe("Strip navigation, footers, and ads. Defaults to true."),
      maxChars: z.number().int().min(1000).max(100000).optional().describe("Truncate the Markdown to this many characters. Defaults to 20,000."),
    },
  }, async ({ url, onlyMainContent = true, maxChars = 20000 }) => {
    if (!isPublicWebUrl(url)) {
      return { isError: true, content: [{ type: "text", text: "Only public http(s) URLs can be scraped." }] };
    }
    const startedAt = Date.now();
    try {
      const data = await firecrawl("/v2/scrape", { url, formats: ["markdown"], onlyMainContent }, 60000);
      const markdown = String(data.markdown || "");
      const truncated = markdown.length > maxChars;
      const header = `# ${data.metadata?.title || url}\nSource: ${data.metadata?.sourceURL || url}\n\n`;
      logCall("scrape", new URL(url).hostname, startedAt);
      return { content: [{ type: "text", text: header + markdown.slice(0, maxChars) + (truncated ? `\n\n[Truncated at ${maxChars} of ${markdown.length} characters]` : "") }] };
    } catch (error) {
      logCall("scrape", new URL(url).hostname, startedAt, error);
      return failure(error);
    }
  });

  server.registerTool("firecrawl_search", {
    description: "Search the public web using the owner's self-hosted Firecrawl instance. Returns source URLs and snippets.",
    inputSchema: { query: z.string().trim().min(1).max(4000), limit: z.number().int().min(1).max(10).optional() },
  }, async ({ query, limit = 5 }) => {
    const startedAt = Date.now();
    try {
      const data = await firecrawl("/v2/search", { query, limit, sources: ["web"] }, 30000);
      // Firecrawl reports blocked search backends as a successful, empty result.
      if (!data?.web?.length) throw new FirecrawlError("NO_RESULTS", "Search returned no results. Try a broader query; if every search comes back empty, the self-hosted search backends are being blocked.");
      logCall("search", JSON.stringify(query.slice(0, 80)), startedAt);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (error) {
      logCall("search", JSON.stringify(query.slice(0, 80)), startedAt, error);
      return failure(error);
    }
  });
  return server;
}

// Docker publishes this on 127.0.0.1:3003 only. Host and Origin checks stop web pages
// from reaching it via DNS rebinding or cross-site requests, as the MCP spec requires.
// The desktop app's native client sends no Origin; the Vite dev proxy forwards its own.
const allowedHosts = new Set(["127.0.0.1:3003", "localhost:3003"]);
const allowedOrigins = new Set(["http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost", "http://tauri.localhost"]);

createServer(async (request, response) => {
  // Match the path only: some clients (e.g. OpenCode) append query parameters.
  const path = new URL(request.url || "/", "http://adapter").pathname;
  if (path !== "/mcp" || request.method !== "POST") {
    response.writeHead(405).end(); return;
  }
  const origin = request.headers.origin;
  if (!allowedHosts.has(request.headers.host || "") || (origin && !allowedOrigins.has(origin))) {
    response.writeHead(403).end(); return;
  }
  let transport;
  let server;
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (body.length > 16000) { response.writeHead(413).end(); return; }
    }
    const message = JSON.parse(body);
    server = createMcp();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, message);
  } catch (error) {
    console.log(`request failed ${error?.name || "Error"}: ${String(error?.message || "").slice(0, 200)}`);
    if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid MCP request" }));
  }
}).listen(3000, "0.0.0.0", () => console.log("Colony Firecrawl MCP is ready on port 3000."));
