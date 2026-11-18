import type { AgentPlan, AgentStepResult, Project } from "../../src/shared/schema";
import { newId } from "../../src/shared/time";
import { createAgentMessage } from "../../src/shared/project";
import { projectStore } from "../projects/store";
import { eventBus } from "../events";
import { jobQueue, type JobContext } from "../jobs";
import { HttpError } from "../util/fs";
import { getTool, validateToolArgs } from "./tools";
import type { AgentPlan as PlanType } from "../../src/shared/schema";

export async function startPlanExecution(projectId: string, planId: string): Promise<{ jobId: string; planId: string }> {
  const bundle = await projectStore.get(projectId);
  const message = bundle.agentMessages.find((item) => item.plan?.id === planId);
  if (!message?.plan) throw new HttpError(404, "El plan no existe en este proyecto.", "plan_not_found");
  const plan = message.plan;
  if (plan.status !== "proposed") {
    throw new HttpError(409, "Este plan ya se ejecutó o está en curso.", "plan_not_executable");
  }
  if (plan.steps.length === 0) throw new HttpError(422, "El plan no contiene pasos.", "empty_plan");
  for (const step of plan.steps) {
    const validation = validateToolArgs(step.tool, step.args);
    if (!validation.ok) throw new HttpError(422, validation.error, "invalid_plan_args");
  }
  await projectStore.createSnapshot(projectId, `Antes del agente: ${plan.instruction.slice(0, 120)}`);
  const job = jobQueue.enqueue({
    type: "agent",
    projectId,
    label: `Agente: ${plan.summary.slice(0, 80)}`,
    cancellable: true,
    run: (context) => runPlan(projectId, planId, context),
  });
  return { jobId: job.id, planId };
}

async function persistPlan(projectId: string, plan: AgentPlan): Promise<void> {
  await projectStore.updateAgentPlan(projectId, plan);
}

function emitStep(projectId: string, planId: string, step: AgentPlan["steps"][number]): void {
  eventBus.publish(projectId, {
    type: "agent-step",
    projectId,
    planId,
    step: { ...step },
  });
}

function emitPlanStatus(projectId: string, planId: string, status: AgentPlan["status"]): void {
  eventBus.publish(projectId, {
    type: "agent-plan",
    projectId,
    planId,
    status,
  });
}

async function runPlan(projectId: string, planId: string, context: JobContext): Promise<unknown> {
  const initial = await projectStore.get(projectId);
  const initialMessage = initial.agentMessages.find((item) => item.plan?.id === planId);
  if (!initialMessage?.plan) throw new HttpError(404, "El plan desaparecio del proyecto.", "plan_not_found");
  const plan: AgentPlan = structuredClone(initialMessage.plan);
  plan.status = "running";
  await persistPlan(projectId, plan);
  emitPlanStatus(projectId, planId, "running");
  let project: Project = initial.project;
  let lastSavedRevision = project.revision;
  const results: AgentStepResult[] = [];
  const startedAt = Date.now();

  const skipRemaining = (fromIndex: number, reason: string) => {
    for (const step of plan.steps.slice(fromIndex)) {
      step.status = "skipped";
      step.error = reason;
      emitStep(projectId, planId, step);
    }
  };

  try {
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]!;
      if (context.signal.aborted) {
        plan.status = "cancelled";
        skipRemaining(index, "Cancelado por el usuario");
        await persistPlan(projectId, plan);
        emitPlanStatus(projectId, planId, "cancelled");
        throw new HttpError(499, "Ejecución del agente cancelada.", "cancelled");
      }
      step.status = "running";
      await persistPlan(projectId, plan);
      emitStep(projectId, planId, step);
      context.setProgress(index / plan.steps.length, step.title);
      context.setDetail({ planId, currentStep: step.id, stepIndex: index, totalSteps: plan.steps.length });

      const stepStarted = Date.now();
      try {
        const definition = getTool(step.tool);
        const parsedArgs = definition.argsSchema.parse(step.args);
        if (step.tool === "render_export" && project.revision !== lastSavedRevision) {
          const saved = await projectStore.saveTimeline(projectId, project, { force: true });
          project = saved.project;
          lastSavedRevision = project.revision;
        }
        const result = await definition.execute(
          {
            projectId,
            project,
            signal: context.signal,
            setProgress: (progress, message) => {
              context.setProgress(
                (index + Math.min(0.95, Math.max(0, progress))) / plan.steps.length,
                message ?? step.title,
              );
            },
          },
          parsedArgs,
        );
        if (result.project) {
          const saved = await projectStore.saveTimeline(projectId, result.project, { force: true });
          project = saved.project;
          lastSavedRevision = project.revision;
          eventBus.publish(projectId, { type: "project", projectId, revision: project.revision });
        }
        step.status = "done";
        step.result = result.summary;
        step.durationMs = Date.now() - stepStarted;
        results.push({
          stepId: step.id,
          tool: step.tool,
          status: "done",
          summary: result.summary,
          durationMs: step.durationMs,
        });
        emitStep(projectId, planId, step);
        await persistPlan(projectId, plan);
        context.setProgress((index + 1) / plan.steps.length, step.title);
      } catch (error) {
        const aborted = context.signal.aborted;
        step.status = aborted ? "skipped" : "failed";
        step.error = aborted
          ? "Cancelado por el usuario"
          : error instanceof HttpError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        step.durationMs = Date.now() - stepStarted;
        results.push({
          stepId: step.id,
          tool: step.tool,
          status: aborted ? "skipped" : "failed",
          summary: step.error,
          error: step.error,
          durationMs: step.durationMs,
        });
        if (aborted) {
          plan.status = "cancelled";
          skipRemaining(index + 1, "Cancelado por el usuario");
          await persistPlan(projectId, plan);
          emitStep(projectId, planId, step);
          emitPlanStatus(projectId, planId, "cancelled");
          throw new HttpError(499, "Ejecución del agente cancelada.", "cancelled");
        }
        plan.status = "failed";
        await persistPlan(projectId, plan);
        emitStep(projectId, planId, step);
        emitPlanStatus(projectId, planId, "failed");
        await projectStore.appendAgentMessage(
          projectId,
          createAgentMessage(
            "assistant",
            `El agente se detuvo en "${step.title}": ${step.error}\n\nLos pasos anteriores siguen aplicados. Puedes deshacer con Ctrl+Z si lo necesitas.`,
            { kind: "error", results },
          ),
        );
        throw new HttpError(422, `El paso "${step.title}" fallo: ${step.error}`, "agent_step_failed");
      }
    }

    plan.status = "done";
    await persistPlan(projectId, plan);
    emitPlanStatus(projectId, planId, "done");
    const completed = results.filter((result) => result.status === "done").length;
    const summary = results
      .filter((result) => result.status === "done")
      .map((result, index) => `${index + 1}. ${result.summary}`)
      .join("\n");
    const finalMessage = createAgentMessage(
      "assistant",
      completed === plan.steps.length
        ? `Listo. Apliqué ${completed} ${completed === 1 ? "cambio" : "cambios"}:\n\n${summary}`
        : `Apliqué ${completed} de ${plan.steps.length} cambios:\n\n${summary}`,
      { kind: "result", results },
    );
    await projectStore.updateAgentPlan(projectId, plan, finalMessage);
    context.setProgress(1, "Agente completado");
    context.setDetail({ planId, results, revision: project.revision, totalMs: Date.now() - startedAt });
    return { planId, results, revision: project.revision };
  } catch (error) {
    if (plan.status === "running") {
      plan.status = context.signal.aborted ? "cancelled" : "failed";
      await persistPlan(projectId, plan).catch(() => undefined);
      emitPlanStatus(projectId, planId, plan.status);
    }
    throw error;
  }
}

export async function appendPlanMessage(
  projectId: string,
  plan: PlanType,
  instruction: string,
  source: "llm" | "local",
  model?: string,
): Promise<void> {
  const userMessage = createAgentMessage("user", instruction, { kind: "text" });
  const assistantMessage = createAgentMessage(
    "assistant",
    plan.summary,
    {
      kind: "plan",
      plan,
    },
  );
  await projectStore.appendAgentMessage(projectId, userMessage);
  await projectStore.appendAgentMessage(projectId, assistantMessage);
  void source;
  void model;
}

export async function appendAgentError(projectId: string, message: string): Promise<void> {
  await projectStore.appendAgentMessage(
    projectId,
    createAgentMessage("assistant", message, { kind: "error" }),
  );
}

export function planStepId(): string {
  return newId("stp");
}
