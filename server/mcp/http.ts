import http from "node:http";
import process from "node:process";
import { apiBaseUrl } from "./client";
import { handleMcpHttp, handleMcpHttpError, mcpAuthEnabled, mcpSessionCount } from "./handler";

const port = Number(process.env.NOVACUT_MCP_PORT?.trim() || 4332);
const host = process.env.NOVACUT_MCP_HOST?.trim() || "127.0.0.1";

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const httpServer = http.createServer((request, res) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      name: "oeclip",
      version: "0.1.0",
      transport: "streamable-http",
      endpoint: "/mcp",
      sessions: mcpSessionCount(),
      api: apiBaseUrl(),
      auth: mcpAuthEnabled() ? "bearer" : "none",
    });
    return;
  }
  if (url.pathname !== "/mcp" && url.pathname !== "/") {
    json(res, 404, { error: "Ruta no encontrada. Usa /mcp." });
    return;
  }
  void handleMcpHttp(request, res).catch((error) => handleMcpHttpError(res, error));
});

httpServer.listen(port, host, () => {
  console.error(`[oeclip-mcp] servidor HTTP listo en http://${host}:${port}/mcp · API ${apiBaseUrl()}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error("[oeclip-mcp] Aviso: escuchando fuera de localhost. Configura NOVACUT_MCP_TOKEN y usa HTTPS/túnel.");
  }
});

const shutdown = () => {
  console.error("[oeclip-mcp] cerrando servidor HTTP");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
