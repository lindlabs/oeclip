import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentMessageSchema } from "../../src/shared/schema";
import { createAgentMessage } from "../../src/shared/project";
import { assertProjectId, HttpError } from "../util/fs";
import { projectStore } from "../projects/store";
import { aiStatus } from "../ai/provider";
import { buildPlan, detectTextIntent, isGenerativeFromScratchInstruction, type PlannerSelection } from "../agent/planner";
import { startPlanExecution } from "../agent/executor";
import { normalizeToolResponse, toolDefinitions, validateToolArgs } from "../agent/tools";
import { runDirectorAgent } from "../agent/directorAgent";
import { eventBus } from "../events";

const planRequestSchema = z.object({
  instruction: z.string().min(1).max(4000),
  selection: z
    .object({
      clipIds: z.array(z.string()).max(100).optional(),
      mediaId: z.string().optional(),
    })
    .optional(),
  preferLocal: z.boolean().optional(),
});

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tools", async () => ({
    tools: toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      argsHint: tool.argsHint,
      risk: tool.risk,
    })),
  }));

  app.post("/api/projects/:id/tools/:tool", async (request) => {
    const { id, tool } = request.params as { id: string; tool: string };
    assertProjectId(id);
    const body = z.object({ args: z.record(z.unknown()).optional() }).parse(request.body ?? {});
    const validation = validateToolArgs(tool, body.args ?? {});
    if (!validation.ok) throw new HttpError(422, validation.error, "invalid_tool_args");
    const bundle = await projectStore.get(id);
    const controller = new AbortController();
    const result = await validation.definition.execute(
      {
        projectId: id,
        project: bundle.project,
        signal: controller.signal,
        setProgress: () => undefined,
      },
      validation.data,
    );
    let revision = bundle.project.revision;
    if (result.project) {
      const saved = await projectStore.saveTimeline(id, result.project, { force: true });
      revision = saved.project.revision;
      eventBus.publish(id, { type: "project", projectId: id, revision });
    } else if (
      result.data &&
      typeof result.data === "object" &&
      "revision" in result.data &&
      typeof (result.data as { revision?: unknown }).revision === "number"
    ) {
      revision = (result.data as { revision: number }).revision;
    }
    return normalizeToolResponse(tool, result, revision);
  });

  app.post("/api/projects/:id/agent/director", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const body = z
      .object({
        request: z.string().min(1).max(6000),
        autonomy: z.enum(["assisted", "semi", "autonomous"]).optional(),
        exportOnComplete: z.boolean().optional(),
        allowFallback: z.boolean().optional(),
        strict: z.boolean().optional(),
        quality: z.enum(["draft", "standard", "high"]).optional(),
        storyboard: z.unknown().optional(),
      })
      .parse(request.body ?? {});

    await projectStore.get(id);
    const userMsg = createAgentMessage("user", body.request);
    await projectStore.appendAgentMessage(id, userMsg);

    const controller = new AbortController();
    const out = await runDirectorAgent({
      projectId: id,
      request: body.request,
      autonomy: body.autonomy ?? "autonomous",
      exportOnComplete: body.exportOnComplete ?? false,
      allowFallback: body.strict ? false : body.allowFallback,
      quality: body.quality,
      storyboard: body.storyboard as Parameters<typeof runDirectorAgent>[0]["storyboard"],
      signal: controller.signal,
    });

    const assistantMsg = agentMessageSchema.parse(
      createAgentMessage("assistant", out.summary, {
        kind: out.status === "failed" ? "error" : "info",
      }),
    );
    await projectStore.appendAgentMessage(id, assistantMsg);
    eventBus.publish(id, { type: "project", projectId: id, revision: out.revision });

    return normalizeToolResponse(
      "ask_director",
      {
        status: out.status,
        warnings: out.warnings,
        verification: out.verification,
        summary: out.summary,
        data: out,
      },
      out.revision,
    );
  });

  app.post("/api/projects/:id/agent/plan", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const body = planRequestSchema.parse(request.body ?? {});
    const bundle = await projectStore.get(id);
    if (
      bundle.project.media.length === 0 &&
      !isGenerativeFromScratchInstruction(body.instruction) &&
      !detectTextIntent(body.instruction).wantsText
    ) {
      throw new HttpError(422, "Importa al menos un recurso antes de pedir una edición al agente.", "no_media");
    }

    const userMessage = createAgentMessage("user", body.instruction);
    await projectStore.appendAgentMessage(id, userMessage);

    let plan;
    let source: "llm" | "local";
    let model: string | undefined;
    try {
      const history = bundle.agentMessages
        .filter((message) => message.role !== "system")
        .slice(-8)
        .map((message) => ({ role: message.role, text: message.text }));
      const result = await buildPlan(bundle.project, body.instruction, {
        selection: body.selection as PlannerSelection | undefined,
        preferLocal: body.preferLocal,
        history,
      });
      plan = result.plan;
      source = result.source;
      model = result.model;
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : "No se pudo preparar el plan de edición. Revisa la configuración del proveedor de IA.";
      await projectStore.appendAgentMessage(id, createAgentMessage("assistant", message, { kind: "error" }));
      throw error;
    }

    const assistantMessage = createAgentMessage("assistant", plan.summary, {
      kind: "plan",
      plan,
    });
    const parsedMessage = agentMessageSchema.parse(assistantMessage);
    await projectStore.appendAgentMessage(id, parsedMessage);
    return {
      plan,
      message: parsedMessage,
      source,
      model,
      ai: aiStatus(),
      projectRevision: bundle.project.revision,
    };
  });

  app.post("/api/projects/:id/agent/execute", async (request, reply) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const body = z.object({ planId: z.string().min(3).max(80) }).parse(request.body ?? {});
    const result = await startPlanExecution(id, body.planId);
    reply.code(202);
    return result;
  });

  app.get("/api/projects/:id/agent/messages", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const bundle = await projectStore.get(id);
    return { messages: bundle.agentMessages };
  });

  app.post("/api/projects/:id/agent/clear", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await projectStore.clearAgentMessages(id);
    return { cleared: true };
  });
}
