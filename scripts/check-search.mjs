import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "colony-verification", version: "0.1.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3003/mcp")));
  const result = await client.callTool({ name: "firecrawl_search", arguments: { query: "Tauri 2 documentation", limit: 2 } });
  if (result.isError) throw new Error("Search failed");
  const part = result.content.find((item) => item.type === "text");
  const data = JSON.parse(part.text);
  if (!data.web?.length) throw new Error("Search returned no results");
  console.log("Self-hosted Firecrawl MCP is connected.");
  for (const item of data.web) console.log(`${item.title}: ${item.url}`);
} finally { await client.close(); }
