import { invoke, isTauri } from "@tauri-apps/api/core";
import { isPublicWebUrl } from "../../convex/urlPolicy";

export type SearchResult = { title: string; url: string; description: string };

function parseRpc(body: string, id: number): Record<string, unknown> {
  try {
    const value = JSON.parse(body);
    if (value.id === id && value.result) return value.result;
    if (value.error) throw new Error("MCP request failed");
  } catch { /* Streamable HTTP may use SSE instead of a single JSON object. */ }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const value = JSON.parse(line.slice(5).trim());
      if (value.id === id && value.result) return value.result;
    } catch { /* Ignore SSE control frames. */ }
  }
  throw new Error("Invalid MCP response");
}

export function normalizeSearch(raw: unknown): SearchResult[] {
  if (!raw || typeof raw !== "object") throw new Error("Invalid search response");
  const result = raw as { isError?: boolean; content?: { type: string; text?: string }[] };
  if (result.isError) throw new Error("Firecrawl search unavailable");
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Empty MCP response");
  const data = JSON.parse(text);
  const items = Array.isArray(data) ? data : data.web || data.data?.web || [];
  if (!Array.isArray(items)) throw new Error("Invalid search results");
  return items.filter((item) => typeof item?.url === "string" && isPublicWebUrl(item.url)).slice(0, 5).map((item) => ({
    title: String(item.title || item.url).slice(0, 300),
    url: String(item.url).slice(0, 2000),
    description: String(item.description || item.snippet || "").slice(0, 1500),
  }));
}

export async function searchWithMcp(query: string): Promise<SearchResult[]> {
  if (isTauri()) return normalizeSearch(await invoke("firecrawl_search", { query }));
  if (!import.meta.env.DEV) throw new Error("Local search requires the desktop app");
  // Vite provides a same-origin development proxy. Installed apps use the native command.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    async function request(message: unknown) {
      const response = await fetch("/firecrawl-mcp", { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal });
      if (!response.ok) throw new Error("MCP unavailable");
      const session = response.headers.get("mcp-session-id");
      if (session) headers["mcp-session-id"] = session;
      return response.text();
    }
    parseRpc(await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "colony-desktop", version: "0.1.0" } } }), 1);
    headers["MCP-Protocol-Version"] = "2025-06-18";
    await request({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = parseRpc(await request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "firecrawl_search", arguments: { query, limit: 5 } } }), 2);
    return normalizeSearch(result);
  } finally { clearTimeout(timeout); }
}

