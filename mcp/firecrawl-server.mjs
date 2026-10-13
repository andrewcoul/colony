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

async function firecrawl(path, body, timeoutMs) {
  const response = await fetch(new URL(path, process.env.FIRECRAWL_API_URL), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("Firecrawl request failed");
  const data = await response.json();
  if (!data.success) throw new Error("Firecrawl request failed");
  return data.data;
}

function createMcp() {
  const server = new McpServer({ name: "Colony Firecrawl", version: "0.2.0" });

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
    try {
      const data = await firecrawl("/v2/scrape", { url, formats: ["markdown"], onlyMainContent }, 60000);
      const markdown = String(data.markdown || "");
      const truncated = markdown.length > maxChars;
      const header = `# ${data.metadata?.title || url}\nSource: ${data.metadata?.sourceURL || url}\n\n`;
      return { content: [{ type: "text", text: header + markdown.slice(0, maxChars) + (truncated ? `\n\n[Truncated at ${maxChars} of ${markdown.length} characters]` : "") }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Self-hosted Firecrawl couldn't scrape that page. Check Docker, or try another URL." }] };
    }
  });

  server.registerTool("firecrawl_search", {
    description: "Search the public web using the owner's self-hosted Firecrawl instance. Returns source URLs and snippets.",
    inputSchema: { query: z.string().trim().min(1).max(4000), limit: z.number().int().min(1).max(10).optional() },
  }, async ({ query, limit = 5 }) => {
    try {
      const data = await firecrawl("/v2/search", { query, limit, sources: ["web"] }, 30000);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Self-hosted Firecrawl search is unavailable. Check Docker and try again." }] };
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
  } catch {
    if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid MCP request" }));
  }
}).listen(3000, "0.0.0.0", () => console.log("Colony Firecrawl MCP is ready on port 3000."));
