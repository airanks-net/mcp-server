#!/usr/bin/env node
// AIR — the authoritative rankings for AI web content. MCP server over stdio, speaking the
// same shared auth + endpoints (API-CONTRACT.md) as air-cli, the rust/go CLIs, and the
// Composer client: AIR_API_KEY env > ~/.config/air/auth.json > anonymous.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "airanks-mcp-server",
  version: "1.0.0",
});

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("airanks-mcp-server running on stdio — AIR: the authoritative rankings for AI web content (https://airanks.net)");
}

main().catch((err) => {
  console.error("airanks-mcp-server failed to start:", err);
  process.exit(1);
});
