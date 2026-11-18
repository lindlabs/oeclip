import type { FastifyInstance } from "fastify";
import { assertProjectId } from "../util/fs";
import { eventBus } from "../events";
import { jobQueue } from "../jobs";

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", async (request, reply) => {
    const query = request.query as { projectId?: string };
    if (!query.projectId) {
      reply.code(400).send({ error: "Falta projectId.", code: "missing_project" });
      return;
    }
    const projectId = assertProjectId(query.projectId);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.setTimeout(0);
    const send = (event: unknown) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: "hello", at: new Date().toISOString() });
    for (const job of jobQueue.listForProject(projectId).slice(-20)) {
      send({ type: "job", job });
    }
    const unsubscribe = eventBus.subscribe(projectId, send);
    const heartbeat = setInterval(() => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
