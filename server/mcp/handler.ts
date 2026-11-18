import type http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import process from "node:process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { runWithMcpRequestAuth, type McpRequestAuthContext } from "./client";
import { buildMcpServer } from "./server";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  authContext: McpRequestAuthContext;
}

const maxBodyBytes = 4 * 1024 * 1024;
const sessions = new Map<string, Session>();

export function mcpSessionCount(): number {
  return sessions.size;
}

export function mcpAuthEnabled(): boolean {
  return Boolean(process.env.NOVACUT_MCP_TOKEN?.trim());
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseRequestUrl(request: http.IncomingMessage): URL {
  return new URL(request.url || "/mcp", "http://localhost");
}

function extractBearerToken(request: http.IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

function resolvePublicBaseUrl(request: http.IncomingMessage): string | undefined {
  const explicit = process.env.OECLIP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const protoRaw = request.headers["x-forwarded-proto"];
  const hostRaw = request.headers["x-forwarded-host"] ?? request.headers.host;
  const protoCandidate = (Array.isArray(protoRaw) ? protoRaw[0] : protoRaw)?.split(",")[0]?.trim().toLowerCase();
  const hostCandidate = (Array.isArray(hostRaw) ? hostRaw[0] : hostRaw)?.split(",")[0]?.trim();
  if (!hostCandidate || /[\s\r\n/\\]/.test(hostCandidate)) return undefined;
  const proto =
    protoCandidate === "https" || protoCandidate === "http"
      ? protoCandidate
      : /\.run\.app(?::\d+)?$/i.test(hostCandidate)
        ? "https"
        : "http";
  return `${proto}://${hostCandidate}`.replace(/\/+$/, "");
}

function extractRequestAuthContext(request: http.IncomingMessage): McpRequestAuthContext {
  const url = parseRequestUrl(request);
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const bearer = extractBearerToken(request);
  const token = queryToken.startsWith("tok_")
    ? queryToken
    : bearer.startsWith("tok_")
      ? bearer
      : undefined;
  const userHandle = url.searchParams.get("user")?.trim() || url.searchParams.get("handle")?.trim() || undefined;
  const publicBaseUrl = resolvePublicBaseUrl(request);
  return { token, userHandle, publicBaseUrl };
}

function isInitializePayload(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body)) {
    return body.some(
      (item) => Boolean(item && typeof item === "object" && (item as { method?: unknown }).method === "initialize"),
    );
  }
  return (body as { method?: unknown }).method === "initialize";
}

function authorized(request: http.IncomingMessage): boolean {
  const token = process.env.NOVACUT_MCP_TOKEN?.trim();
  if (!token) return true;
  const bearer = extractBearerToken(request);
  const queryToken = parseRequestUrl(request).searchParams.get("token")?.trim() ?? "";
  const provided = bearer || queryToken;
  const expected = Buffer.from(token);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("El cuerpo de la petición MCP supera 4 MB.");
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("El cuerpo de la petición MCP no es JSON válido.");
  }
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

export interface McpHttpOptions {
  /** Cuerpo ya parseado por Fastify u otro framework. Si se omite, se lee del stream. */
  parsedBody?: unknown;
}

function normalizeAcceptHeaderForPost(request: http.IncomingMessage): void {
  const raw = String(request.headers.accept ?? "").toLowerCase();
  if (!raw || !raw.includes("application/json") || !raw.includes("text/event-stream")) {
    request.headers.accept = "application/json, text/event-stream";
  }
}

function openStandaloneSseStream(
  request: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId?: string,
): void {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  res.writeHead(200, headers);
  res.write(": connected\n\n");
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": keepalive\n\n");
    }
  }, 20_000);
  timer.unref?.();
  const cleanup = () => clearInterval(timer);
  request.on("close", cleanup);
  res.on("close", cleanup);
}

export async function handleMcpHttp(
  request: http.IncomingMessage,
  res: http.ServerResponse,
  options: McpHttpOptions = {},
): Promise<void> {
  setCors(res);
  if (request.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!authorized(request)) {
    json(res, 401, { error: "No autorizado. Configura NOVACUT_MCP_TOKEN y envía Authorization: Bearer <token>." });
    return;
  }

  const rawSession = request.headers["mcp-session-id"];
  const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  const authContext = extractRequestAuthContext(request);

  if (request.method === "POST") {
    normalizeAcceptHeaderForPost(request);
    const body =
      options.parsedBody !== undefined ? options.parsedBody : await readJsonBody(request);
    const isInit = isInitializePayload(body);

    if (existing && !isInit) {
      existing.authContext = {
        token: authContext.token ?? existing.authContext.token,
        userHandle: authContext.userHandle ?? existing.authContext.userHandle,
        publicBaseUrl: authContext.publicBaseUrl ?? existing.authContext.publicBaseUrl,
      };
      await runWithMcpRequestAuth(existing.authContext, () => existing.transport.handleRequest(request, res, body));
      return;
    }

    // initialize crea sesión JSON-response reutilizable localmente; cualquier otro método sin sesión previa
    // (p. ej. rotación de réplicas en Cloud Run) usa transporte stateless por petición SIN guardarlo en sessions.
    const server = buildMcpServer();
    let session: Session;
    const transport = isInit
      ? new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId || randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, session);
          },
        })
      : new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
    session = { transport, server, authContext };

    if (!isInit && sessionId && !res.headersSent) {
      res.setHeader("Mcp-Session-Id", sessionId);
    }

    transport.onclose = () => {
      if (isInit) {
        const id = transport.sessionId;
        if (id && sessions.get(id) === session) sessions.delete(id);
      }
      void server.close();
    };
    await server.connect(transport);
    await runWithMcpRequestAuth(session.authContext, () => transport.handleRequest(request, res, body));
    if (!isInit) {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "GET") {
    const accept = String(request.headers.accept ?? "").toLowerCase();
    if (accept.includes("text/event-stream")) {
      openStandaloneSseStream(request, res, sessionId);
      return;
    }
    json(res, 200, {
      ok: true,
      name: "oeclip",
      version: "0.1.0",
      transport: "streamable-http",
      endpoint: "/mcp",
      publicUrl: authContext.publicBaseUrl ? `${authContext.publicBaseUrl}/mcp` : undefined,
    });
    return;
  }

  if (request.method === "DELETE") {
    if (sessionId && existing) {
      sessions.delete(sessionId);
      await existing.transport.close().catch(() => undefined);
    }
    json(res, 200, { ok: true });
    return;
  }

  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
  json(res, 405, { error: "Método no permitido." });
}

export function handleMcpHttpError(res: http.ServerResponse, error: unknown): void {
  console.error("[oeclip-mcp] error:", error);
  if (!res.headersSent) {
    json(res, 500, { error: error instanceof Error ? error.message : "Error interno MCP." });
  } else {
    res.end();
  }
}
