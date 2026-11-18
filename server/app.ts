import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { config, ensureBaseDirs } from "./config";
import { HttpError } from "./util/fs";
import { registerProjectRoutes } from "./routes/projects";
import { registerMediaRoutes } from "./routes/media";
import { registerExportRoutes } from "./routes/exports";
import { registerAgentRoutes } from "./routes/agent";
import { registerSkillRoutes } from "./routes/skills";
import { registerMotionAgentRoutes } from "./routes/motion";
import { registerAiRoutes } from "./routes/ai";
import { registerEventRoutes } from "./routes/events";
import { registerSystemRoutes } from "./routes/system";
import { userStore } from "./auth/store";
import { extractAuthToken, registerAuthRoutes } from "./routes/auth";
import { handleMcpHttp, handleMcpHttpError } from "./mcp/handler";
import { runWithAiSession } from "./ai/settings";
import { purgeStaleTempDirs } from "./services/exportService";

export async function buildServer(): Promise<FastifyInstance> {
  ensureBaseDirs();
  void purgeStaleTempDirs();
  const app = Fastify({
    logger: {
      level: process.env.NOVACUT_LOG_LEVEL?.trim() || "info",
    },
    bodyLimit: 32 * 1024 * 1024,
    routerOptions: { maxParamLength: 2048 },
    requestTimeout: 30 * 60_000,
    trustProxy: true,
  });
  app.server.requestTimeout = 30 * 60_000;
  app.server.headersTimeout = 120_000;

  app.addHook("onRequest", (request, _reply, done) => {
    delete request.headers["x-user-handle"];
    delete request.headers["x-authenticated-user-id"];

    const token = extractAuthToken(request);
    const verified = token ? userStore.verifySession(token) : null;
    let effectiveSessionId: string | undefined;

    if (verified) {
      request.headers["x-user-handle"] = verified.user.handle;
      request.headers["x-authenticated-user-id"] = verified.user.id;
      request.headers["x-session-id"] = verified.sessionId;
      effectiveSessionId = verified.sessionId;
    } else {
      const raw = request.headers["x-session-id"];
      effectiveSessionId = typeof raw === "string" && /^[a-zA-Z0-9_-]{4,80}$/.test(raw) ? raw : undefined;
    }

    runWithAiSession(effectiveSessionId, done, verified?.user.id);
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 8,
      parts: 12,
    },
  });

  const distIndex = path.join(config.distDir, "index.html");
  const hasBuild = fs.existsSync(distIndex);
  if (hasBuild) {
    await app.register(fastifyStatic, {
      root: config.distDir,
      prefix: "/",
      serve: false,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // index.html siempre se revalida: si no, una actualización deja la
        // interfaz antigua en caché hasta una hora. Los assets llevan hash en
        // el nombre y pueden cachearse de forma inmutable.
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }
        res.setHeader("Cache-Control", "public, max-age=3600");
      },
    });
  }

  await registerSystemRoutes(app);
  await registerAuthRoutes(app);
  await registerProjectRoutes(app);
  await registerMediaRoutes(app);
  await registerExportRoutes(app);
  await registerAiRoutes(app);
  await registerAgentRoutes(app);
  await registerSkillRoutes(app);
  await registerMotionAgentRoutes(app);
  await registerEventRoutes(app);

  const mcpRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    try {
      await handleMcpHttp(request.raw, reply.raw, { parsedBody: request.body });
    } catch (error) {
      handleMcpHttpError(reply.raw, error);
    }
  };
  app.post("/mcp", mcpRoute);
  app.get("/mcp", mcpRoute);
  app.delete("/mcp", mcpRoute);
  app.options("/mcp", mcpRoute);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(422).send({
        error: "Los datos enviados no son validos.",
        code: "validation_error",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof HttpError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, "request failed");
      reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413 || (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      reply.code(413).send({
        error: `El archivo supera el limite de ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB.`,
        code: "upload_too_large",
      });
      return;
    }
    if (status === 415) {
      reply.code(415).send({ error: "Tipo de contenido no soportado.", code: "unsupported_media_type" });
      return;
    }
    request.log.error({ err: error }, "unhandled error");
    reply.code(status && status >= 400 && status < 600 ? status : 500).send({
      error: error instanceof Error ? error.message : "Error interno del servidor.",
      code: "internal_error",
    });
  });

  app.setNotFoundHandler((request, reply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      reply.code(400).send({ error: "La ruta solicitada no es valida.", code: "invalid_path" });
      return;
    }
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    const isPageRoute = path.extname(pathname) === "";
    if (request.method === "GET" && hasBuild) {
      const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "").replaceAll("/", path.sep);
      const filePath = path.resolve(config.distDir, requestedPath);
      const relativePath = path.relative(config.distDir, filePath);
      const isInsideDist =
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath);
      if (isInsideDist && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return reply.sendFile(relativePath);
      }
      if (!pathname.startsWith("/api/") && acceptsHtml && isPageRoute) {
        return reply.sendFile("index.html");
      }
    }
    if (request.method === "GET" && !pathname.startsWith("/api/") && hasBuild) {
      reply.code(404).send({ error: "Archivo no encontrado.", code: "asset_not_found" });
      return;
    }
    reply.code(404).send({ error: "Ruta no encontrada.", code: "not_found" });
  });

  return app;
}
