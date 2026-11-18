import type { FastifyInstance, FastifyRequest } from "fastify";
import { spawn } from "node:child_process";
import { z } from "zod";
import { projectSchema, aspectSchema } from "../../src/shared/schema";
import { dimensionsFor } from "../../src/shared/presets";
import { projectDirectory, projectStore } from "../projects/store";
import { HttpError, assertProjectId } from "../util/fs";
import { createDemoProject } from "../services/demoService";

const createProjectSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  aspect: aspectSchema.optional(),
  height: z.union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional(),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
});

interface VerifiedAuthContext {
  userHandle: string;
  userId?: string;
  sessionId: string;
}

function getVerifiedAuth(request: FastifyRequest): VerifiedAuthContext | null {
  const userHandle =
    typeof request.headers["x-user-handle"] === "string" ? request.headers["x-user-handle"].trim() : "";
  if (!userHandle) return null;
  const userId =
    typeof request.headers["x-authenticated-user-id"] === "string"
      ? request.headers["x-authenticated-user-id"].trim() || undefined
      : undefined;
  const rawSession =
    typeof request.headers["x-session-id"] === "string" ? request.headers["x-session-id"].trim() : "";
  return {
    userHandle,
    userId,
    sessionId: rawSession || `ses_${userHandle}`,
  };
}

function requireAuthHandle(request: FastifyRequest): VerifiedAuthContext {
  const auth = getVerifiedAuth(request);
  if (!auth) {
    throw new HttpError(401, "Debes iniciar sesión o crear una cuenta para usar OECLIP.", "auth_required");
  }
  return auth;
}

async function assertProjectOwnership(id: string, auth: VerifiedAuthContext): Promise<void> {
  const allowed = await projectStore.canAccess(id, auth.userHandle, auth.sessionId);
  if (!allowed) {
    throw new HttpError(403, "No tienes acceso a este proyecto.", "forbidden");
  }
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/projects", async (request) => {
    const auth = getVerifiedAuth(request);
    if (!auth) {
      return { projects: [] };
    }
    return {
      projects: await projectStore.list(auth.sessionId, auth.userHandle),
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const auth = requireAuthHandle(request);
    const body = createProjectSchema.parse(request.body ?? {});
    const dims = dimensionsFor(body.aspect ?? "16:9", body.height ?? 1080);
    const fps = body.fps ?? 30;
    const bundle = await projectStore.create(body.name, {
      width: dims.width,
      height: dims.height,
      aspect: body.aspect ?? "16:9",
      fps: { num: fps, den: 1 },
      sampleRate: 48000,
    });
    await projectStore.setSessionOwner(bundle.project.id, auth.sessionId, auth.userHandle, auth.userId);
    reply.code(201);
    return bundle;
  });

  app.post("/api/projects/demo", async (request, reply) => {
    const auth = requireAuthHandle(request);
    const bundle = await createDemoProject();
    await projectStore.setSessionOwner(bundle.project.id, auth.sessionId, auth.userHandle, auth.userId);
    reply.code(201);
    return bundle;
  });

  app.get("/api/projects/:id", async (request) => {
    const auth = requireAuthHandle(request);
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    return projectStore.get(id);
  });

  app.put("/api/projects/:id", async (request) => {
    const auth = requireAuthHandle(request);
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    const body = z
      .object({
        project: z.unknown(),
        baseRevision: z.number().int().min(0).optional(),
      })
      .parse(request.body ?? {});
    const parsed = projectSchema.safeParse(body.project);
    if (!parsed.success) {
      throw new HttpError(422, "El proyecto enviado no es válido.", "invalid_project", parsed.error.issues);
    }
    if (parsed.data.id !== id) throw new HttpError(400, "ID de proyecto incoherente.", "id_mismatch");
    return projectStore.saveTimeline(id, parsed.data, { baseRevision: body.baseRevision });
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const auth = requireAuthHandle(request);
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    await projectStore.delete(id);
    reply.code(204);
    return null;
  });

  app.post("/api/projects/:id/duplicate", async (request, reply) => {
    const auth = requireAuthHandle(request);
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    const bundle = await projectStore.duplicate(id);
    await projectStore.setSessionOwner(bundle.project.id, auth.sessionId, auth.userHandle, auth.userId);
    reply.code(201);
    return bundle;
  });

  app.post("/api/projects/:id/snapshot", async (request, reply) => {
    const auth = requireAuthHandle(request);
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    const body = z.object({ label: z.string().min(1).max(200).optional() }).parse(request.body ?? {});
    const result = await projectStore.createSnapshot(id, body.label ?? "Instantánea manual");
    reply.code(201);
    return result;
  });

  app.get("/api/projects/:id/history", async (request) => {
    const auth = requireAuthHandle(request);
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    return { snapshots: await projectStore.listSnapshots(id) };
  });

  app.post("/api/projects/:id/history/:fileName/restore", async (request) => {
    const auth = requireAuthHandle(request);
    const { id, fileName } = request.params as { id: string; fileName: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    return projectStore.restoreSnapshot(id, fileName);
  });

  app.post("/api/projects/:id/reveal", async (request) => {
    const auth = requireAuthHandle(request);
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await assertProjectOwnership(id, auth);
    const dir = projectDirectory(id);
    if (process.platform === "win32") {
      spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [dir], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
    }
    return { opened: true, path: dir };
  });
}
