import type { FastifyInstance } from "fastify";
import { transform } from "esbuild";
import { z } from "zod";
import { getMotionAgent, getMotionAgentLiveStatus, resetMotionAgent } from "../motion-agent/index.js";
import { sanitizeComponentCode } from "../motion-agent/code-guard.js";
import {
  projectStore,
  motionPersistedStateSchema,
} from "../projects/store.js";
import { HttpError, assertProjectId } from "../util/fs.js";
import { renderPool } from "../motion-agent/worker/pool.js";
import {
  getOverlayJob,
  insertOverlay,
  jobPublic,
  listOverlayJobs,
  overlayBundleKey,
  renderAndInsertOverlay,
  startOverlayRender,
  type OverlayComponent,
} from "../motion-agent/render-service.js";
import { isMacroSwarmPrompt, runSwarmDirector } from "../agent/swarmDirector.js";

const messageSchema = z.object({
  message: z.string().min(1).max(8000),
  componentCode: z.string().optional(),
  componentName: z.string().optional(),
  compositionId: z.string().optional(),
  durationInFrames: z.number().min(1).optional(),
  props: z.record(z.unknown()).optional(),
  selectedClipId: z.string().optional(),
});

const contextSchema = z.object({
  projectId: z.string().optional(),
  currentFrame: z.coerce.number().min(0).default(0),
});

const componentSchema = z.object({
  componentCode: z.string().min(1),
  componentName: z.string().min(1).max(120),
  compositionId: z.string().min(1).max(160),
  durationInFrames: z.number().min(1),
  props: z.record(z.unknown()).optional(),
  startFrame: z.number().min(0).optional(),
});

const keySchema = z.string().regex(/^[a-f0-9]{8,40}$/);

function componentFrom(body: z.infer<typeof componentSchema>): OverlayComponent {
  return {
    code: body.componentCode,
    name: body.componentName,
    compositionId: body.compositionId,
    durationInFrames: Math.max(1, Math.round(body.durationInFrames)),
    props: body.props,
    startFrame: body.startFrame,
  };
}

const projectFpsOf = (project: any) => {
  const num = Number(project?.settings?.fps?.num ?? 30);
  const den = Number(project?.settings?.fps?.den ?? 1);
  const fps = den > 0 ? num / den : 30;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
};

// Control de tasa en memoria por IP/Sesión para proteger créditos de IA ante picos de tráfico viral
const aiRateMap = new Map<string, { count: number; resetAt: number }>();
const AI_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const AI_RATE_MAX_REQUESTS = 30;

function checkAiRateLimit(clientKey: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = aiRateMap.get(clientKey);
  if (!entry || now >= entry.resetAt) {
    aiRateMap.set(clientKey, { count: 1, resetAt: now + AI_RATE_WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= AI_RATE_MAX_REQUESTS) {
    return { allowed: false, retryAfterSec: Math.max(5, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

function friendlyAiErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota") || lower.includes("insufficient")) {
    return "Hay una alta demanda de creadores usando OECLIP en este momento ⚡. Por favor intenta de nuevo en unos segundos o aplica cualquiera de nuestras **+ Plantillas** instantáneas en el botón superior.";
  }
  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("network") || lower.includes("fetch")) {
    return "La conexión con el motor de IA tardó más de lo esperado. Intenta enviar tu instrucción nuevamente o usa el catálogo de **+ Plantillas**.";
  }
  return raw;
}

function syncAgentFromSwarmResult(
  agent: Awaited<ReturnType<typeof getMotionAgent>>,
  userMessage: string,
  swarmResult: Awaited<ReturnType<typeof runSwarmDirector>>,
): {
  lastComponent: ReturnType<typeof agent.getAgentMemorySnapshot>["lastComponent"];
  lastBrief: string;
  conversation: ReturnType<typeof agent.getAgentMemorySnapshot>["conversation"];
} {
  const tracks = swarmResult.project?.tracks ?? [];
  const prioritizedTracks = [
    ...tracks.filter((t) => /capa\s+motion/i.test(t.name)),
    ...tracks.filter((t) => !/capa\s+motion/i.test(t.name)),
  ];
  const primaryClip = prioritizedTracks
    .flatMap((t) => t.clips)
    .find((c) => c.createdBy === "agent" && Boolean(c.remotion?.code));

  agent.recordExternalTurn(
    userMessage,
    swarmResult.summary,
    primaryClip?.remotion
      ? {
          code: primaryClip.remotion.code,
          name: primaryClip.remotion.componentName,
          compositionId: primaryClip.remotion.compositionId,
          durationInFrames: primaryClip.durationFrames,
          props: primaryClip.remotion.props,
          startFrame: primaryClip.startFrame,
        }
      : null,
  );
  return agent.getAgentMemorySnapshot();
}

export async function registerMotionAgentRoutes(app: FastifyInstance): Promise<void> {
  // Chat conversacional: el agente entiende el brief y genera con Remotion.
  app.post("/api/projects/:id/motion/chat", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);

    const body = messageSchema.parse(request.body ?? {});
    const query = contextSchema.parse(request.query ?? {});

    const bundle = await projectStore.get(id);
    const project = bundle.project;

    const agent = await getMotionAgent({
      projectId: id,
      project,
      currentFrame: query.currentFrame,
      mediaAssets: project.media,
    });

    // Restaura la pieza activa si el cliente la tenía (por ejemplo tras
    // recargar la página o reiniciar el servidor).
    if (body.componentCode && body.componentName && body.compositionId) {
      agent.setLastComponent({
        code: body.componentCode,
        name: body.componentName,
        compositionId: body.compositionId,
        durationInFrames: body.durationInFrames,
        props: body.props,
      });
    }

    const clientKey = String(request.headers["x-session-id"] || request.ip || "anon");
    const rate = checkAiRateLimit(clientKey);
    if (!rate.allowed) {
      return {
        responses: [
          {
            type: "error",
            content: `Has alcanzado el límite de peticiones rápidas por minuto. Espera ${rate.retryAfterSec}s o explora el catálogo de **+ Plantillas** instantáneas.`,
          },
        ],
      };
    }

    if (isMacroSwarmPrompt(body.message)) {
      const swarmResult = await runSwarmDirector({
        projectId: id,
        prompt: body.message,
      });
      const snap = syncAgentFromSwarmResult(agent, body.message, swarmResult);
      void projectStore
        .saveMotionState(id, {
          lastComponent: snap.lastComponent,
          lastBrief: snap.lastBrief,
          conversation: snap.conversation,
        })
        .catch(() => undefined);
      return {
        responses: [
          {
            type: "SWARM_EDIT_COMPLETE",
            content: swarmResult.summary,
            project: swarmResult.project,
            data: {
              type: "SWARM_EDIT_COMPLETE",
              project: swarmResult.project,
              steps: swarmResult.steps,
              stats: swarmResult.stats,
              productionMode: swarmResult.productionMode,
              productionModeLabel: swarmResult.productionModeLabel,
            },
          },
        ],
      };
    }

    const responses = await agent.processMessage(body.message, body.selectedClipId);
    for (const r of responses) {
      if (r.type === "error" && typeof r.content === "string") {
        r.content = friendlyAiErrorMessage(r.content);
      }
    }
    const snap = agent.getAgentMemorySnapshot();
    void projectStore
      .saveMotionState(id, {
        lastComponent: snap.lastComponent,
        lastBrief: snap.lastBrief,
        conversation: snap.conversation,
      })
      .catch(() => undefined);

    return { responses };
  });

  // Chat conversacional con streaming en tiempo real (SSE)
  app.post("/api/projects/:id/motion/chat-stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);

    const body = messageSchema.parse(request.body ?? {});
    const query = contextSchema.parse(request.query ?? {});

    const bundle = await projectStore.get(id);
    const project = bundle.project;

    const agent = await getMotionAgent({
      projectId: id,
      project,
      currentFrame: query.currentFrame,
      mediaAssets: project.media,
    });

    if (body.componentCode && body.componentName && body.compositionId) {
      agent.setLastComponent({
        code: body.componentCode,
        name: body.componentName,
        compositionId: body.compositionId,
        durationInFrames: body.durationInFrames,
        props: body.props,
      });
    }

    reply.hijack();
    request.raw.socket?.setNoDelay(true);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.setTimeout(0);
    reply.raw.flushHeaders?.();
    // 2KB de comentario inicial fuerza el vaciado del buffer del proxy (Vite http-proxy)
    reply.raw.write(`: ${" ".repeat(2048)}\n\n`);

    const sendEvent = (event: string, payload: unknown) => {
      try {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // Ignorar si el socket se cerró
      }
    };

    try {
      const clientKey = String(request.headers["x-session-id"] || request.ip || "anon");
      const rate = checkAiRateLimit(clientKey);
      if (!rate.allowed) {
        sendEvent("message", {
          type: "error",
          content: `Has alcanzado el límite de peticiones rápidas por minuto. Espera ${rate.retryAfterSec}s o explora el catálogo de **+ Plantillas** instantáneas.`,
        });
        sendEvent("done", { ok: false });
        return;
      }

      if (isMacroSwarmPrompt(body.message)) {
        sendEvent("message", {
          type: "text",
          content: "Activando Orquestación de Enjambre Autónomo + Motor HyperFrames (Postproducción Integral)...",
          data: { isStep: true },
        });

        const swarmResult = await runSwarmDirector({
          projectId: id,
          prompt: body.message,
          onProgress: (stepMessage) => {
            sendEvent("message", {
              type: "text",
              content: stepMessage,
              data: { isStep: true },
            });
          },
        });

        const snap = syncAgentFromSwarmResult(agent, body.message, swarmResult);
        void projectStore
          .saveMotionState(id, {
            lastComponent: snap.lastComponent,
            lastBrief: snap.lastBrief,
            conversation: snap.conversation,
          })
          .catch(() => undefined);

        sendEvent("SWARM_EDIT_COMPLETE", {
          type: "SWARM_EDIT_COMPLETE",
          content: swarmResult.summary,
          project: swarmResult.project,
          data: {
            type: "SWARM_EDIT_COMPLETE",
            project: swarmResult.project,
            steps: swarmResult.steps,
            stats: swarmResult.stats,
            productionMode: swarmResult.productionMode,
            productionModeLabel: swarmResult.productionModeLabel,
          },
        });
        sendEvent("message", {
          type: "SWARM_EDIT_COMPLETE",
          content: swarmResult.summary,
          project: swarmResult.project,
          data: {
            type: "SWARM_EDIT_COMPLETE",
            project: swarmResult.project,
            steps: swarmResult.steps,
            stats: swarmResult.stats,
            productionMode: swarmResult.productionMode,
            productionModeLabel: swarmResult.productionModeLabel,
          },
        });
        sendEvent("done", { ok: true });
        return;
      }

      await agent.processMessage(body.message, body.selectedClipId, (resp) => {
        if (resp.type === "error" && typeof resp.content === "string") {
          sendEvent("message", { ...resp, content: friendlyAiErrorMessage(resp.content) });
        } else {
          sendEvent("message", resp);
        }
      });
      const snap = agent.getAgentMemorySnapshot();
      void projectStore
        .saveMotionState(id, {
          lastComponent: snap.lastComponent,
          lastBrief: snap.lastBrief,
          conversation: snap.conversation,
        })
        .catch(() => undefined);
      sendEvent("done", { ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendEvent("message", { type: "error", content: friendlyAiErrorMessage(msg) });
      sendEvent("done", { ok: false });
    } finally {
      reply.raw.end();
    }
  });

  // Estado en vivo del agente autónomo (respaldo de polling rápido)
  app.get("/api/projects/:id/motion/status", async (request) => {
    try {
      const { id } = (request.params ?? {}) as { id?: string };
      if (!id) return { active: false, steps: [], currentStep: "" };
      assertProjectId(id);
      return getMotionAgentLiveStatus(id);
    } catch {
      return { active: false, steps: [], currentStep: "" };
    }
  });

  // Limpia la memoria conversacional del proyecto y su persistencia en disco.
  app.post("/api/projects/:id/motion/reset", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    resetMotionAgent(id);
    await projectStore.clearMotionState(id).catch(() => undefined);
    return { ok: true };
  });

  // Lee el historial persistente de chat y última pieza Motion del proyecto
  app.get("/api/projects/:id/motion/history", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    return projectStore.readMotionState(id);
  });

  // Guarda el historial de chat y última pieza Motion del proyecto en disco
  app.put("/api/projects/:id/motion/history", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const parsed = motionPersistedStateSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) {
      return { messages: [], lastComponent: null };
    }
    return projectStore.saveMotionState(id, parsed.data);
  });

  // Preview sin chat (re-renderizar la pieza actual a media resolución).
  app.post("/api/projects/:id/motion/preview", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);

    const body = componentSchema
      .extend({
        width: z.number().optional(),
        height: z.number().optional(),
        fps: z.number().optional(),
      })
      .parse(request.body ?? {});

    const bundle = await projectStore.get(id);
    const project = bundle.project;
    const fps = body.fps ?? projectFpsOf(project);
    const width = Math.max(2, Math.round(body.width ?? project.settings.width));
    const height = Math.max(2, Math.round(body.height ?? project.settings.height));
    const component = componentFrom(body);

    const result = await renderPool.preview(
      body.componentCode,
      body.componentName,
      body.compositionId,
      width,
      height,
      fps,
      body.durationInFrames,
      {
        ...(body.props ?? {}),
        width,
        height,
        fps,
        durationInFrames: body.durationInFrames,
      },
      {
        compositionDurationInFrames: body.durationInFrames,
        scale: 0.5,
        bundleKey: overlayBundleKey(component, project),
      },
    );

    if (!result.success) {
      throw new HttpError(500, `Preview failed: ${result.error}`, "preview_failed");
    }

    return result;
  });

  // Arranca (o reutiliza) el render del overlay. Responde de inmediato.
  app.post("/api/projects/:id/motion/render", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);

    const body = componentSchema
      .extend({ prewarm: z.boolean().optional() })
      .parse(request.body ?? {});
    const bundle = await projectStore.get(id);

    const job = await startOverlayRender({
      projectId: id,
      project: bundle.project,
      component: componentFrom(body),
      origin: body.prewarm ? "prewarm" : "user",
    });

    return jobPublic(job);
  });

  // Estado del render: el cliente hace polling aquí mientras se cocina.
  app.get("/api/projects/:id/motion/render/:key", async (request) => {
    const { id, key } = request.params as { id: string; key: string };
    assertProjectId(id);
    keySchema.parse(key);

    const job = getOverlayJob(key);
    if (!job || job.projectId !== id) {
      throw new HttpError(404, "Ese render no existe o ya expiró.", "render_not_found");
    }
    return jobPublic(job);
  });

  // Lista de renders del proyecto (útil para depurar y para la UI).
  app.get("/api/projects/:id/motion/jobs", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    return { jobs: listOverlayJobs(id) };
  });

  // Inserta un render ya terminado. Es la operación rápida (<200 ms).
  app.post("/api/projects/:id/motion/insert", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);

    const body = z
      .object({
        key: keySchema,
        startFrame: z.number().min(0).optional(),
        insertAtEnd: z.boolean().optional(),
        currentFrame: z.number().min(0).optional(),
      })
      .parse(request.body ?? {});

    const result = await insertOverlay(id, {
      key: body.key,
      startFrame: body.startFrame,
      insertAtEnd: body.insertAtEnd,
      currentFrame: body.currentFrame,
    });

    return {
      ok: true,
      assetId: result.assetId,
      clipFrames: result.clipFrames,
      startFrame: result.startFrame,
      trackId: result.trackId,
      videoPath: result.videoPath,
      revision: result.revision,
    };
  });

  // Compatibilidad: render + insertar en una sola llamada. Internamente usa el
  // mismo servicio (con caché y prewarm), así que tampoco re-renderiza de más.
  app.post("/api/projects/:id/motion/render-and-insert", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);

    const body = componentSchema
      .extend({
        insertAtEnd: z.boolean().optional(),
        currentFrame: z.number().min(0).optional(),
      })
      .parse(request.body ?? {});

    const bundle = await projectStore.get(id);
    const result = await renderAndInsertOverlay({
      projectId: id,
      project: bundle.project,
      component: componentFrom(body),
      origin: "user",
      startFrame: body.startFrame,
      insertAtEnd: body.insertAtEnd,
      currentFrame: body.currentFrame,
    });

    return {
      ok: true,
      assetId: result.assetId,
      clipFrames: result.clipFrames,
      startFrame: result.startFrame,
      trackId: result.trackId,
      videoPath: result.videoPath,
      revision: result.revision,
      renderMs: result.renderMs,
    };
  });

  // Compila código TSX de Remotion a CommonJS listo para evaluación en vivo en el navegador (<2ms)
  const compileHandler = async (request: any) => {
    const body = z
      .object({
        code: z.string().min(1).max(300_000),
        componentName: z.string().min(1).max(160).optional(),
      })
      .parse(request.body ?? {});

    const sanitized = sanitizeComponentCode(body.code);
    try {
      const result = await transform(sanitized.code, {
        loader: "tsx",
        jsx: "transform",
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
        format: "cjs",
        target: "es2020",
      });
      return {
        ok: true,
        cjs: result.code,
        exportedName: sanitized.name || body.componentName || "MotionComp",
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: msg.slice(0, 1200),
      };
    }
  };

  // Sincronización automática de micro-efectos de sonido (whoosh, pop, ding)
  app.post("/api/projects/:id/motion/sync-sfx", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const body = z
      .object({
        startFrame: z.number().int().min(0),
        componentName: z.string().optional(),
        sfxType: z.enum(["whoosh", "pop", "ding"]).optional(),
        code: z.string().optional(),
      })
      .parse(request.body ?? {});

    const { syncMotionSoundEffect } = await import("../services/sfxService.js");
    const result = await syncMotionSoundEffect(id, {
      startFrame: body.startFrame,
      componentName: body.componentName,
      sfxType: body.sfxType,
      code: body.code,
    });

    const bundle = await projectStore.get(id);
    return { ok: result.ok, sfxType: result.sfxType, project: bundle.project };
  });

  app.post("/api/motion/compile", compileHandler);
  app.post("/api/projects/:id/motion/compile", compileHandler);

  // Get worker pool stats
  app.get("/api/motion/stats", async () => {
    return renderPool.getStats();
  });
}
