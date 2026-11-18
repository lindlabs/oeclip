import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { normalizeHandle, userStore } from "../auth/store";
import {
  agentMessageSchema,
  exportRecordSchema,
  projectSchema,
  type AgentMessage,
  type AgentPlan,
  type ExportRecord,
  type MediaAsset,
  type Project,
  type ProjectSettings,
} from "../../src/shared/schema";
import { createProject, ensureTrack, firstVideoTrack, makeMediaClip, timelineDurationFrames } from "../../src/shared/project";
import { HttpError, assertProjectId, atomicWriteJson, pathExists, readJson, resolveInside } from "../util/fs";
import { z } from "zod";

export const brandKitSchema = z.object({
  brandName: z.string().max(120).optional(),
  tagline: z.string().max(240).optional(),
  logoUrlOrMediaId: z.string().max(240).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#38BDF8"),
  secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#818CF8"),
  surfaceColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#090D18"),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F8FAFC"),
  headingFont: z.string().max(80).default("Space Grotesk"),
  bodyFont: z.string().max(80).default("Inter"),
  tone: z.string().max(120).default("corporativo limpio y tecnológico"),
  ctaDefault: z.string().max(120).optional(),
  updatedAt: z.string().datetime().optional(),
});
export type BrandKit = z.infer<typeof brandKitSchema>;

const undoHistorySchema = z.object({
  undoStack: z.array(z.string()).max(60).default([]),
  redoStack: z.array(z.string()).max(60).default([]),
});

const snapshotSchema = z.object({
  label: z.string().max(200),
  createdAt: z.string().datetime(),
  revision: z.number().int().min(0),
  project: projectSchema,
});
type Snapshot = z.infer<typeof snapshotSchema>;

const exportsSchema = z.array(exportRecordSchema).max(100);
const messagesSchema = z.array(agentMessageSchema).max(300);

export const motionPersistedStateSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().default(() => `msg-${Date.now()}`),
        role: z.enum(["user", "assistant", "system"]).default("assistant"),
        type: z.enum(["text", "component", "preview", "inserted", "error"]).default("text"),
        content: z.string().default(""),
        data: z.any().optional(),
        timestamp: z.number().default(() => Date.now()),
      }),
    )
    .max(60)
    .default([]),
  lastComponent: z
    .object({
      code: z.string().default(""),
      name: z.string().default("MotionComponent"),
      compositionId: z.string().default("MotionComp"),
      durationInFrames: z.number().nullable().optional().transform((v) => v ?? undefined),
      props: z.any().optional(),
      reasoning: z.string().nullable().optional().transform((v) => v ?? undefined),
      startFrame: z.number().nullable().optional().transform((v) => v ?? undefined),
      renderKey: z.string().nullable().optional().transform((v) => v ?? undefined),
    })
    .nullable()
    .optional(),
  lastBrief: z.string().nullable().optional().transform((v) => v ?? undefined),
  conversation: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .max(20)
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
});
export type MotionPersistedState = z.infer<typeof motionPersistedStateSchema>;

async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

export interface ProjectListItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  durationFrames: number;
  mediaCount: number;
  thumbnailMediaId: string | null;
}

export interface ProjectBundle {
  project: Project;
  exports: ExportRecord[];
  agentMessages: AgentMessage[];
}

export function projectDirectory(id: string): string {
  assertProjectId(id);
  return resolveInside(path.join(config.dataDir, "projects"), id);
}

export function projectMediaDirectory(id: string): string {
  return path.join(projectDirectory(id), "media");
}

export function projectCacheDirectory(id: string): string {
  return path.join(projectDirectory(id), "cache");
}

export function projectExportDirectory(id: string): string {
  return path.join(projectDirectory(id), "exports");
}

export function projectProxyDirectory(id: string): string {
  return path.join(projectDirectory(id), "proxies");
}

export function projectHistoryDirectory(id: string): string {
  return path.join(projectDirectory(id), "history");
}

export function projectTempDirectory(id: string): string {
  return path.join(config.tmpDir, id);
}

function projectFile(id: string): string {
  return path.join(projectDirectory(id), "project.json");
}

function exportsFile(id: string): string {
  return path.join(projectDirectory(id), "exports.json");
}

function messagesFile(id: string): string {
  return path.join(projectDirectory(id), "agent.json");
}

function motionFile(id: string): string {
  return path.join(projectDirectory(id), "motion.json");
}

function sessionFile(id: string): string {
  return path.join(projectDirectory(id), "session.json");
}

function brandKitFile(id: string): string {
  return path.join(projectDirectory(id), "brand-kit.json");
}

function runTraceFile(id: string): string {
  return path.join(projectDirectory(id), "run-trace.json");
}

function undoHistoryFile(id: string): string {
  return path.join(projectHistoryDirectory(id), "cursor.json");
}

function stripTransient(project: Project): Project {
  return {
    ...project,
    media: project.media.map((asset) => {
      const next = { ...asset };
      delete next.missing;
      return next;
    }),
    exports: [],
    agentMessages: [],
  };
}

class ProjectStore {
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    assertProjectId(id);
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.locks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readExports(id: string): Promise<ExportRecord[]> {
    const file = exportsFile(id);
    if (!(await pathExists(file))) return [];
    const parsed = exportsSchema.safeParse(await readJson(file));
    if (!parsed.success) throw new HttpError(500, "El registro de exportaciones está corrupto.", "exports_corrupt");
    return parsed.data;
  }

  private async readMessages(id: string): Promise<AgentMessage[]> {
    const file = messagesFile(id);
    if (!(await pathExists(file))) return [];
    const parsed = messagesSchema.safeParse(await readJson(file));
    if (!parsed.success) throw new HttpError(500, "El historial del agente está corrupto.", "agent_corrupt");
    return parsed.data;
  }

  private async readProjectRaw(id: string): Promise<Project> {
    const file = projectFile(id);
    if (!(await pathExists(file))) throw new HttpError(404, "El proyecto no existe.", "project_not_found");
    const parsed = projectSchema.safeParse(await readJson(file));
    if (!parsed.success) {
      throw new HttpError(500, "El archivo del proyecto no es válido.", "project_corrupt", parsed.error.issues);
    }
    return parsed.data;
  }

  private async markMissing(project: Project): Promise<Project> {
    const liveMediaIds = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.type !== "text" && Boolean(clip.remotion?.code)) {
          liveMediaIds.add(clip.mediaId);
        }
      }
    }
    const media = await Promise.all(
      project.media.map(async (asset) => {
        if (liveMediaIds.has(asset.id) || asset.file.startsWith("generated/")) {
          return { ...asset, missing: false };
        }
        const file = path.join(projectDirectory(project.id), asset.file);
        const exists = await pathExists(file);
        if (!exists) return { ...asset, missing: true };
        let proxy = asset.proxy;
        let proxyFile = asset.proxyFile;
        if (asset.proxy === "ready" && asset.proxyFile) {
          const proxyExists = await pathExists(path.join(projectDirectory(project.id), asset.proxyFile));
          if (!proxyExists) {
            proxy = "none";
            proxyFile = undefined;
          }
        }
        return { ...asset, missing: false, proxy, proxyFile };
      }),
    );
    return { ...project, media };
  }

  async get(id: string): Promise<ProjectBundle> {
    assertProjectId(id);
    return this.withLock(id, async () => {
      const raw = await this.readProjectRaw(id);
      const [exports, agentMessages] = await Promise.all([this.readExports(id), this.readMessages(id)]);
      const project = await this.markMissing({ ...raw, exports, agentMessages });
      return { project, exports, agentMessages };
    });
  }

  async setSessionOwner(id: string, sessionId?: string, userHandle?: string, userId?: string): Promise<void> {
    const cleanSession = sessionId?.trim();
    const rawHandle = userHandle?.trim() || (cleanSession ? cleanSession.replace(/^ses_/, "") : "");
    const cleanHandle = rawHandle ? normalizeHandle(rawHandle) : "";
    if (!cleanSession && !cleanHandle) return;
    if (cleanHandle) {
      userStore.setProjectOwner(id, cleanHandle, cleanSession ?? `ses_${cleanHandle}`, userId);
    }
    try {
      await atomicWriteJson(sessionFile(id), {
        sessionId: cleanSession || `ses_${cleanHandle}`,
        userHandle: cleanHandle || rawHandle,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // No bloquear si falla metadato de sesión
    }
  }

  async canAccess(id: string, userHandle?: string, sessionId?: string): Promise<boolean> {
    const cleanUserHandle = userHandle ? normalizeHandle(userHandle) : "";
    const cleanSession = sessionId?.trim();
    const dbOwner = userStore.getProjectOwner(id);
    if (dbOwner) {
      if (cleanUserHandle && dbOwner.userHandle === cleanUserHandle) return true;
      if (cleanSession && dbOwner.sessionId && dbOwner.sessionId === cleanSession) return true;
      return false;
    }

    const sFile = sessionFile(id);
    if (await pathExists(sFile)) {
      const meta = (await readJson(sFile)) as { sessionId?: string; userHandle?: string; isPublicDemo?: boolean } | null;
      if (meta?.isPublicDemo) return true;
      if (cleanUserHandle && meta?.userHandle && normalizeHandle(meta.userHandle) === cleanUserHandle) return true;
      if (cleanSession && meta?.sessionId && meta.sessionId === cleanSession) return true;
      return false;
    }

    return id.toLowerCase().includes("demo");
  }

  async list(sessionId?: string, userHandle?: string): Promise<ProjectListItem[]> {
    const cleanSession = sessionId?.trim();
    const cleanUserHandle = userHandle ? normalizeHandle(userHandle) : "";
    const root = path.join(config.dataDir, "projects");
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true });
    const items: ProjectListItem[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        if (cleanUserHandle || cleanSession) {
          const allowed = await this.canAccess(entry.name, cleanUserHandle || undefined, cleanSession);
          if (!allowed) continue;
        }
        const project = await this.readProjectRaw(entry.name);
        items.push({
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          revision: project.revision,
          durationFrames: timelineDurationFrames(project),
          mediaCount: project.media.length,
          thumbnailMediaId: project.media.find((asset) => asset.kind !== "audio")?.id ?? null,
        });
      } catch (error) {
        console.warn(`[oeclip] Proyecto ignorado ${entry.name}:`, error instanceof Error ? error.message : error);
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(name?: string, settings?: ProjectSettings): Promise<ProjectBundle> {
    const project = createProject(name?.trim() || "Proyecto sin título", settings);
    await this.withLock(project.id, async () => {
      await fs.mkdir(projectMediaDirectory(project.id), { recursive: true });
      await fs.mkdir(projectCacheDirectory(project.id), { recursive: true });
      await fs.mkdir(projectExportDirectory(project.id), { recursive: true });
      await fs.mkdir(projectProxyDirectory(project.id), { recursive: true });
      await fs.mkdir(projectHistoryDirectory(project.id), { recursive: true });
      await atomicWriteJson(projectFile(project.id), stripTransient(project));
    });
    return { project, exports: [], agentMessages: [] };
  }

  async saveTimeline(
    id: string,
    incoming: Project,
    options: { baseRevision?: number; force?: boolean } = {},
  ): Promise<ProjectBundle> {
    return this.withLock(id, async () => {
      const currentRaw = await this.readProjectRaw(id);
      if (
        !options.force &&
        options.baseRevision !== undefined &&
        options.baseRevision !== currentRaw.revision
      ) {
        throw new HttpError(
          409,
          "El proyecto cambio en el servidor. Recarga para continuar sin perder cambios.",
          "revision_conflict",
          { currentRevision: currentRaw.revision },
        );
      }
      if (incoming.id !== id) throw new HttpError(400, "El identificador del proyecto no coincide.", "id_mismatch");
      const current = stripTransient(currentRaw);
      const currentMedia = new Map(current.media.map((asset) => [asset.id, asset]));
      const incomingMedia = new Map(incoming.media.map((asset) => [asset.id, asset]));
      // Merge media: keep all from current, update with incoming
      const allMediaIds = new Set([...currentMedia.keys(), ...incomingMedia.keys()]);
      const mergedMedia = Array.from(allMediaIds).map((id) => {
        const currentAsset = currentMedia.get(id);
        const incomingAsset = incomingMedia.get(id);
        if (!incomingAsset) return currentAsset!; // Keep media that only exists in current
        if (!currentAsset) return incomingAsset; // New media from incoming
        // Merge: keep incoming asset but preserve proxy/thumbnail from current
        return {
          ...incomingAsset,
          proxy: currentAsset.proxy,
          proxyFile: currentAsset.proxyFile,
          thumbnail: currentAsset.thumbnail,
          waveform: currentAsset.waveform,
          missing: undefined,
        };
      });
      const merged: Project = {
        ...incoming,
        id,
        revision: currentRaw.revision + 1,
        createdAt: currentRaw.createdAt,
        updatedAt: new Date().toISOString(),
        media: mergedMedia,
        exports: [],
        agentMessages: [],
      };
      const parsed = projectSchema.safeParse(merged);
      if (!parsed.success) {
        throw new HttpError(422, "El proyecto no cumple el esquema de edición.", "invalid_project", parsed.error.issues);
      }
      await this.pushAutoUndoUnlocked(id, currentRaw, `Antes de revisión ${merged.revision}`);
      await atomicWriteJson(projectFile(id), stripTransient(parsed.data));
      const [exports, agentMessages] = await Promise.all([this.readExports(id), this.readMessages(id)]);
      const project = await this.markMissing({ ...parsed.data, exports, agentMessages });
      return { project, exports, agentMessages };
    });
  }

  async addMedia(id: string, asset: MediaAsset): Promise<{ project: Project; revision: number }> {
    return this.withLock(id, async () => {
      const current = await this.readProjectRaw(id);
      const exists = current.media.some((item) => item.id === asset.id);
      const nextMedia = exists
        ? current.media.map((item) => (item.id === asset.id ? asset : item))
        : [...current.media, asset];
      const project: Project = {
        ...current,
        media: nextMedia,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const parsed = projectSchema.safeParse(project);
      if (!parsed.success) {
        throw new HttpError(500, "No se pudo registrar el recurso.", "invalid_project", parsed.error.issues);
      }
      await atomicWriteJson(projectFile(id), stripTransient(parsed.data));
      return { project: await this.markMissing(parsed.data), revision: parsed.data.revision };
    });
  }

  async updateMedia(id: string, mediaId: string, patch: Partial<MediaAsset>): Promise<MediaAsset> {
    return this.withLock(id, async () => {
      const current = await this.readProjectRaw(id);
      const asset = current.media.find((item) => item.id === mediaId);
      if (!asset) throw new HttpError(404, "El recurso no existe.", "media_not_found");
      const updated = { ...asset, ...patch, id: asset.id };
      const project = {
        ...current,
        media: current.media.map((item) => (item.id === mediaId ? updated : item)),
      };
      const parsed = projectSchema.safeParse(project);
      if (!parsed.success) throw new HttpError(500, "No se pudo actualizar el recurso.", "invalid_project");
      await atomicWriteJson(projectFile(id), stripTransient(parsed.data));
      return updated;
    });
  }

  async removeMedia(id: string, mediaId: string): Promise<Project> {
    return this.withLock(id, async () => {
      const current = await this.readProjectRaw(id);
      const used = current.tracks.some((track) => track.clips.some((clip) => clip.type !== "text" && clip.mediaId === mediaId));
      if (used) {
        throw new HttpError(409, "El recurso está en uso en la línea de tiempo.", "media_in_use");
      }
      const project = {
        ...current,
        media: current.media.filter((item) => item.id !== mediaId),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(projectFile(id), stripTransient(project));
      return project;
    });
  }

  async addExport(id: string, record: ExportRecord): Promise<ExportRecord> {
    return this.withLock(id, async () => {
      const current = await this.readProjectRaw(id);
      if (!(await pathExists(projectFile(id)))) throw new HttpError(404, "El proyecto no existe.", "project_not_found");
      void current;
      const exports = await this.readExports(id);
      const next = [...exports, record].slice(-100);
      await atomicWriteJson(exportsFile(id), next);
      return record;
    });
  }

  async updateExport(id: string, exportId: string, patch: Partial<ExportRecord>): Promise<ExportRecord> {
    return this.withLock(id, async () => {
      const exports = await this.readExports(id);
      const index = exports.findIndex((item) => item.id === exportId);
      if (index < 0) throw new HttpError(404, "La exportación no existe.", "export_not_found");
      const updated = { ...exports[index]!, ...patch, id: exportId };
      const parsed = exportRecordSchema.safeParse(updated);
      if (!parsed.success) throw new HttpError(500, "El registro de exportación no es válido.", "export_invalid");
      const next = exports.map((item, i) => (i === index ? parsed.data : item));
      await atomicWriteJson(exportsFile(id), next);
      return parsed.data;
    });
  }

  async recoverInterruptedExports(): Promise<void> {
    const projects = await this.list();
    for (const item of projects) {
      try {
        await this.withLock(item.id, async () => {
          const exports = await this.readExports(item.id);
          let changed = false;
          const next = exports.map((record) => {
            if (record.status !== "queued" && record.status !== "running") return record;
            changed = true;
            return {
              ...record,
              status: "failed" as const,
              finishedAt: new Date().toISOString(),
              etaSeconds: 0,
              error: "La exportación se interrumpió porque el servidor se reinició.",
            };
          });
          if (changed) await atomicWriteJson(exportsFile(item.id), next);
        });
      } catch (error) {
        console.warn(
          `[oeclip] No se pudieron recuperar exportaciones de ${item.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  async appendAgentMessage(id: string, message: AgentMessage): Promise<AgentMessage> {
    return this.withLock(id, async () => {
      await this.readProjectRaw(id);
      const messages = await this.readMessages(id);
      const parsed = agentMessageSchema.safeParse(message);
      if (!parsed.success) throw new HttpError(500, "Mensaje de agente inválido.", "agent_invalid");
      const next = [...messages, parsed.data].slice(-300);
      await atomicWriteJson(messagesFile(id), next);
      return parsed.data;
    });
  }

  async updateAgentPlan(id: string, plan: AgentPlan, extraMessage?: AgentMessage): Promise<void> {
    return this.withLock(id, async () => {
      await this.readProjectRaw(id);
      const messages = await this.readMessages(id);
      let found = false;
      const next = messages.map((message) => {
        if (message.plan?.id === plan.id) {
          found = true;
          return { ...message, plan };
        }
        return message;
      });
      if (extraMessage) next.push(extraMessage);
      await atomicWriteJson(messagesFile(id), next.slice(-300));
      void found;
    });
  }

  async clearAgentMessages(id: string): Promise<void> {
    return this.withLock(id, async () => {
      await atomicWriteJson(messagesFile(id), []);
    });
  }

  async readMotionState(id: string): Promise<MotionPersistedState> {
    assertProjectId(id);
    const file = motionFile(id);
    if (!(await pathExists(file))) {
      return { messages: [], lastComponent: null };
    }
    try {
      const parsed = motionPersistedStateSchema.safeParse(await readJson(file));
      if (!parsed.success) return { messages: [], lastComponent: null };
      return parsed.data;
    } catch {
      return { messages: [], lastComponent: null };
    }
  }

  async saveMotionState(id: string, state: Partial<MotionPersistedState>): Promise<MotionPersistedState> {
    return this.withLock(id, async () => {
      await this.readProjectRaw(id);
      const current = await this.readMotionState(id);
      const merged: MotionPersistedState = {
        messages: (state.messages ?? current.messages ?? []).slice(-60),
        lastComponent: state.lastComponent !== undefined ? state.lastComponent : current.lastComponent,
        lastBrief: state.lastBrief !== undefined ? state.lastBrief : current.lastBrief,
        conversation: (state.conversation ?? current.conversation ?? []).slice(-20),
      };
      const parsed = motionPersistedStateSchema.safeParse(merged);
      const finalState: MotionPersistedState = parsed.success ? parsed.data : merged;
      await atomicWriteJson(motionFile(id), finalState);
      return finalState;
    });
  }

  async clearMotionState(id: string): Promise<void> {
    return this.withLock(id, async () => {
      const file = motionFile(id);
      if (await pathExists(file)) {
        await atomicWriteJson(file, { messages: [], lastComponent: null, lastBrief: "", conversation: [] });
      }
    });
  }

  async saveRunTrace(id: string, trace: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withLock(id, async () => {
      await this.readProjectRaw(id);
      const next = { ...trace, projectId: id, savedAt: new Date().toISOString() };
      await atomicWriteJson(runTraceFile(id), next);
      return next;
    });
  }

  async readRunTrace(id: string): Promise<Record<string, unknown> | null> {
    assertProjectId(id);
    const file = runTraceFile(id);
    if (!(await pathExists(file))) return null;
    try {
      const raw = await readJson(file);
      return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async listSnapshots(id: string): Promise<Array<{ fileName: string; label: string; createdAt: string; revision: number }>> {
    const dir = projectHistoryDirectory(id);
    try {
      const files = (await fs.readdir(dir)).filter((file) => /^snap-[a-zA-Z0-9-]+\.json$/.test(file));
      const result: Array<{ fileName: string; label: string; createdAt: string; revision: number }> = [];
      for (const file of files) {
        try {
          const snapshot = snapshotSchema.parse(await readJson(path.join(dir, file)));
          result.push({
            fileName: file,
            label: snapshot.label,
            createdAt: snapshot.createdAt,
            revision: snapshot.revision,
          });
        } catch {
          // instantánea corrupta: se ignora
        }
      }
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  async createSnapshot(id: string, label: string): Promise<{ fileName: string }> {
    return this.withLock(id, async () => {
      const project = await this.readProjectRaw(id);
      const dir = projectHistoryDirectory(id);
      await fs.mkdir(dir, { recursive: true });
      const fileName = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const snapshot: Snapshot = {
        label: label.slice(0, 200),
        createdAt: new Date().toISOString(),
        revision: project.revision,
        project: stripTransient(project),
      };
      await atomicWriteJson(path.join(dir, fileName), snapshot);
      const files = (await fs.readdir(dir))
        .filter((file) => file.endsWith(".json"))
        .sort()
        .reverse();
      for (const stale of files.slice(40)) {
        await fs.rm(path.join(dir, stale), { force: true });
      }
      return { fileName };
    });
  }

  private async readUndoCursorUnlocked(id: string): Promise<{ undoStack: string[]; redoStack: string[] }> {
    const file = undoHistoryFile(id);
    if (!(await pathExists(file))) return { undoStack: [], redoStack: [] };
    try {
      return undoHistorySchema.parse(await readJson(file));
    } catch {
      return { undoStack: [], redoStack: [] };
    }
  }

  private async writeAutoSnapshotFileUnlocked(
    id: string,
    project: Project,
    label: string,
  ): Promise<string> {
    const dir = projectHistoryDirectory(id);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const snapshot: Snapshot = {
      label: label.slice(0, 200),
      createdAt: new Date().toISOString(),
      revision: project.revision,
      project: stripTransient(project),
    };
    await atomicWriteJson(path.join(dir, fileName), snapshot);
    return fileName;
  }

  private async pushAutoUndoUnlocked(id: string, prevProject: Project, label: string): Promise<void> {
    try {
      const fileName = await this.writeAutoSnapshotFileUnlocked(id, prevProject, label);
      const cursor = await this.readUndoCursorUnlocked(id);
      const nextUndo = [...cursor.undoStack, fileName].slice(-40);
      await atomicWriteJson(undoHistoryFile(id), { undoStack: nextUndo, redoStack: [] });
    } catch {
      // No bloquear saveTimeline si falla el historial auxiliar
    }
  }

  async readBrandKit(id: string): Promise<BrandKit | null> {
    assertProjectId(id);
    const file = brandKitFile(id);
    if (!(await pathExists(file))) return null;
    try {
      return brandKitSchema.parse(await readJson(file));
    } catch {
      return null;
    }
  }

  async saveBrandKit(id: string, patch: Partial<BrandKit>): Promise<BrandKit> {
    return this.withLock(id, async () => {
      await this.readProjectRaw(id);
      const current = await this.readBrandKit(id);
      const merged = brandKitSchema.parse({
        ...(current ?? {}),
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await atomicWriteJson(brandKitFile(id), merged);
      return merged;
    });
  }

  async readSnapshot(id: string, fileName: string): Promise<Snapshot> {
    if (!/^snap-[a-zA-Z0-9-]+\.json$/.test(fileName)) {
      throw new HttpError(400, "Instantánea inválida.", "invalid_snapshot");
    }
    const file = resolveInside(projectHistoryDirectory(id), fileName);
    if (!(await pathExists(file))) throw new HttpError(404, "La instantánea no existe.", "snapshot_not_found");
    return snapshotSchema.parse(await readJson(file));
  }

  async undo(id: string): Promise<ProjectBundle> {
    return this.withLock(id, async () => {
      const current = await this.readProjectRaw(id);
      const cursor = await this.readUndoCursorUnlocked(id);
      let targetFile = cursor.undoStack[cursor.undoStack.length - 1];
      let nextUndo = cursor.undoStack.slice(0, -1);

      if (!targetFile) {
        const snaps = await this.listSnapshots(id);
        const prior = snaps.find((s) => s.revision < current.revision) ?? snaps[0];
        if (!prior) {
          throw new HttpError(409, "No hay cambios previos para deshacer.", "nothing_to_undo");
        }
        targetFile = prior.fileName;
      }

      const targetSnap = await this.readSnapshot(id, targetFile);
      const redoFile = await this.writeAutoSnapshotFileUnlocked(id, current, `Redo rev ${current.revision}`);
      const nextRedo = [...cursor.redoStack, redoFile].slice(-40);
      await atomicWriteJson(undoHistoryFile(id), { undoStack: nextUndo, redoStack: nextRedo });

      const restored: Project = {
        ...targetSnap.project,
        id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        exports: [],
        agentMessages: [],
      };
      await atomicWriteJson(projectFile(id), stripTransient(restored));
      const [exports, agentMessages] = await Promise.all([this.readExports(id), this.readMessages(id)]);
      const project = await this.markMissing({ ...restored, exports, agentMessages });
      return { project, exports, agentMessages };
    });
  }

  async redo(id: string): Promise<ProjectBundle> {
    return this.withLock(id, async () => {
      const current = await this.readProjectRaw(id);
      const cursor = await this.readUndoCursorUnlocked(id);
      const targetFile = cursor.redoStack[cursor.redoStack.length - 1];
      if (!targetFile) {
        throw new HttpError(409, "No hay acciones para rehacer.", "nothing_to_redo");
      }
      const nextRedo = cursor.redoStack.slice(0, -1);
      const targetSnap = await this.readSnapshot(id, targetFile);
      const undoFile = await this.writeAutoSnapshotFileUnlocked(id, current, `Antes de rehacer rev ${current.revision}`);
      const nextUndo = [...cursor.undoStack, undoFile].slice(-40);
      await atomicWriteJson(undoHistoryFile(id), { undoStack: nextUndo, redoStack: nextRedo });

      const restored: Project = {
        ...targetSnap.project,
        id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        exports: [],
        agentMessages: [],
      };
      await atomicWriteJson(projectFile(id), stripTransient(restored));
      const [exports, agentMessages] = await Promise.all([this.readExports(id), this.readMessages(id)]);
      const project = await this.markMissing({ ...restored, exports, agentMessages });
      return { project, exports, agentMessages };
    });
  }

  async restoreRevision(id: string, targetRevision: number): Promise<ProjectBundle> {
    const snaps = await this.listSnapshots(id);
    const exact = snaps.find((s) => s.revision === targetRevision) ??
      snaps.slice().sort((a, b) => Math.abs(a.revision - targetRevision) - Math.abs(b.revision - targetRevision))[0];
    if (!exact) {
      throw new HttpError(404, `No se encontró ninguna instantánea cercana a la revisión ${targetRevision}.`, "snapshot_not_found");
    }
    return this.restoreSnapshot(id, exact.fileName);
  }

  async restoreSnapshot(id: string, fileName: string): Promise<ProjectBundle> {
    if (!/^snap-[a-zA-Z0-9-]+\.json$/.test(fileName)) {
      throw new HttpError(400, "Instantánea inválida.", "invalid_snapshot");
    }
    const file = resolveInside(projectHistoryDirectory(id), fileName);
    if (!(await pathExists(file))) throw new HttpError(404, "La instantánea no existe.", "snapshot_not_found");
    const snapshot = snapshotSchema.parse(await readJson(file));
    await this.createSnapshot(id, "Antes de restaurar una instantánea");
    const restored: Project = {
      ...snapshot.project,
      id,
      revision: (await this.readProjectRaw(id)).revision + 1,
      updatedAt: new Date().toISOString(),
    };
    return this.saveTimeline(id, restored, { force: true });
  }

  async delete(id: string): Promise<void> {
    const dir = projectDirectory(id);
    if (!(await pathExists(dir))) throw new HttpError(404, "El proyecto no existe.", "project_not_found");
    if (process.env.K_SERVICE) {
      // En GCSFuse (Cloud Run), rename de directorios con múltiples subcarpetas dispara
      // errores RenameOp "too many open files". Eliminamos directamente con reintentos seguros.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
      userStore.deleteProjectOwner(id);
      return;
    }
    const trash = path.join(config.dataDir, "trash");
    await fs.mkdir(trash, { recursive: true });
    const target = path.join(trash, `${id}-${Date.now()}`);
    try {
      await renameWithRetry(dir, target);
    } catch {
      // En Windows, OneDrive o el antivirus pueden bloquear el renombrado del
      // directorio unos instantes. Copiamos al historial y borramos el original.
      await fs.cp(dir, target, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    userStore.deleteProjectOwner(id);
  }

  async duplicate(id: string): Promise<ProjectBundle> {
    const bundle = await this.get(id);
    const now = new Date().toISOString();
    const copy: Project = {
      ...bundle.project,
      id: `prj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name: `${bundle.project.name} (copia)`,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    const newMediaDir = projectMediaDirectory(copy.id);
    await fs.mkdir(newMediaDir, { recursive: true });
    for (const asset of copy.media) {
      const source = path.join(projectDirectory(id), asset.file);
      if (await pathExists(source)) {
        await fs.copyFile(source, path.join(projectDirectory(copy.id), asset.file));
      }
    }
    await fs.mkdir(projectCacheDirectory(copy.id), { recursive: true });
    await fs.mkdir(projectExportDirectory(copy.id), { recursive: true });
    await fs.mkdir(projectProxyDirectory(copy.id), { recursive: true });
    await fs.mkdir(projectHistoryDirectory(copy.id), { recursive: true });
    await atomicWriteJson(projectFile(copy.id), stripTransient(copy));
    return { project: copy, exports: [], agentMessages: [] };
  }
}

export const projectStore = new ProjectStore();
