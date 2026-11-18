import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { aiStatus } from "../ai/provider";
import { getCapabilities } from "../system";
import { cleanOrphanRendersAndTemps } from "../services/janitorService";
import { buildMcpServer } from "../mcp/server";
import { mcpSessionCount } from "../mcp/handler";

async function buildHealthPayload() {
  const capabilities = await getCapabilities();
  let mcpHealthy = true;
  let mcpError: string | undefined;
  try {
    const server = buildMcpServer();
    await server.close().catch(() => undefined);
  } catch (err) {
    mcpHealthy = false;
    mcpError = err instanceof Error ? err.message : String(err);
  }
  return {
    ok: mcpHealthy,
    brand: config.brand,
    version: "0.1.0",
    uptimeSeconds: Math.round(process.uptime()),
    platform: process.platform,
    node: process.version,
    mcp: {
      ok: mcpHealthy,
      endpoint: "/mcp",
      transport: "streamable-http",
      activeSessions: mcpSessionCount(),
      ...(mcpError ? { error: mcpError } : {}),
    },
    capabilities,
    ai: aiStatus(),
    dataDir: config.dataDir,
  };
}

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async (_req, reply) => {
    const payload = await buildHealthPayload();
    if (!payload.ok) reply.code(503);
    return payload;
  });

  app.get("/healthz", async (_req, reply) => {
    const payload = await buildHealthPayload();
    if (!payload.ok) reply.code(503);
    return {
      ok: payload.ok,
      brand: payload.brand,
      version: payload.version,
      mcp: payload.mcp,
    };
  });

  app.get("/api/config", async () => ({
    brand: config.brand,
    ai: aiStatus(),
    capabilities: await getCapabilities(),
    maxUploadMb: Math.round(config.maxUploadBytes / (1024 * 1024)),
  }));

  app.post("/api/system/cleanup", async () => {
    const result = await cleanOrphanRendersAndTemps();
    return {
      ok: true,
      ...result,
    };
  });
}
