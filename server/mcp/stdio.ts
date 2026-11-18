import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server";
import { apiBaseUrl } from "./client";

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the MCP protocol: logs must go to stderr.
  console.error(`[oeclip-mcp] servidor listo (stdio) · API ${apiBaseUrl()}`);

  const shutdown = async (signal: string) => {
    console.error(`[oeclip-mcp] cerrando (${signal})`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[oeclip-mcp] error fatal:", error);
  process.exit(1);
});
