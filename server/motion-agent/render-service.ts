import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectCacheDirectory, projectStore } from "../projects/store.js";
import { importMediaFile } from "../media/import.js";
import { getTrackById, makeMediaClip } from "../../src/shared/project.js";
import {
  addClip,
  addTrack,
  ensureMotionOverlayTrack,
  findFreeStartFrame,
  MOTION_OVERLAY_TRACK_NAME,
  timelineDurationFrames,
} from "../../src/shared/timeline.js";
import { HttpError } from "../util/fs.js";
import { renderPool } from "./worker/pool.js";
import type { RenderProgress } from "./worker/types.js";

/**
 * Servicio de render de overlays.
 *
 * Objetivo: que "Render + Insertar" sea instantáneo siempre que sea posible.
 *
 *  1. El render se lanza en segundo plano en cuanto la pieza está lista
 *     (prewarm), así que al pulsar el botón normalmente ya está hecho.
 *  2. El resultado se identifica por hash de (código + props + tamaño), de modo
 *     que repetir la inserción o volver al mismo estilo es instantáneo.
 *  3. El bundle de webpack se cachea por componente: preview y render final
 *     comparten bundle y no se vuelve a compilar.
 *  4. El encoder VP9 usa el preset `realtime` (≈3x más rápido con alfa).
 *  5. Si el render aún no ha terminado, el cliente recibe progreso real en
 *     lugar de un botón bloqueado sin información.
 */

export interface OverlayComponent {
  code: string;
  name: string;
  compositionId: string;
  durationInFrames: number;
  props?: Record<string, unknown>;
  startFrame?: number;
}

export type OverlayStatus = "rendering" | "done" | "error" | "cancelled";

export interface OverlayJob {
  key: string;
  projectId: string;
  name: string;
  status: OverlayStatus;
  /** 0..1 */
  progress: number;
  stage: "bundle" | "render";
  /** Progreso dentro de la etapa actual (0..1). */
  stageProgress: number;
  stageStartedAt: number;
  error?: string;
  assetId?: string;
  filePath?: string;
  startedAt: number;
  finishedAt?: number;
  origin: "prewarm" | "user";
  cancel?: () => void;
  promise?: Promise<string>;
}

interface CacheEntry {
  key: string;
  name: string;
  assetId?: string;
  /** Archivo temporal del render todavía no importado al proyecto. */
  file?: string;
  bytes?: number;
  /** Duración de la composición (frames del proyecto). */
  durationFrames: number;
  isSubtitles: boolean;
  component?: {
    code: string;
    name: string;
    compositionId: string;
    props?: Record<string, unknown>;
  };
  createdAt: number;
}

const jobs = new Map<string, OverlayJob>();
const prewarmTimers = new Map<string, NodeJS.Timeout>();
const projectPrewarm = new Map<string, string>();
const indexLocks = new Map<string, Promise<unknown>>();

const RENDER_CACHE_DIR = path.join(os.tmpdir(), "novacut-motion", "renders");
const MIN_FREE_BYTES_TEMP = 400 * 1024 * 1024;
const MIN_FREE_BYTES_DATA = 60 * 1024 * 1024;
const MAX_TEMP_RENDERS_PER_PROJECT = 3;

function projectFps(project: any): number {
  const num = Number(project?.settings?.fps?.num ?? 30);
  const den = Number(project?.settings?.fps?.den ?? 1);
  const fps = den > 0 ? num / den : 30;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function projectWidth(project: any): number {
  return Math.max(2, Math.round(Number(project?.settings?.width ?? 1920)));
}

function projectHeight(project: any): number {
  return Math.max(2, Math.round(Number(project?.settings?.height ?? 1080)));
}

function isSubtitleComponent(component: OverlayComponent): boolean {
  return Array.isArray((component.props as Record<string, unknown> | undefined)?.captions);
}

/** Props exactas con las que se renderiza (y que entran en el hash). */
export function overlayRenderProps(
  component: OverlayComponent,
  project: any,
): Record<string, unknown> {
  const width = projectWidth(project);
  const height = projectHeight(project);
  const fps = projectFps(project);
  return {
    ...(component.props ?? {}),
    width,
    height,
    fps,
    durationInFrames: component.durationInFrames,
  };
}

/**
 * Clave del bundle: depende del código y de la forma de la composición, no de
 * los props. Así el preview (media resolución, ventana) y el render final
 * reutilizan el mismo bundle.
 */
export function overlayBundleKey(component: OverlayComponent, project: any): string {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        v: 3,
        code: component.code,
        name: component.name,
        compositionId: component.compositionId,
        width: projectWidth(project),
        height: projectHeight(project),
        fps: projectFps(project),
        frames: component.durationInFrames,
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

/** Clave del render: cambia si cambia cualquier cosa que afecte al píxel. */
export function overlayRenderKey(component: OverlayComponent, project: any): string {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        v: 3,
        code: component.code,
        width: projectWidth(project),
        height: projectHeight(project),
        fps: projectFps(project),
        frames: component.durationInFrames,
        props: overlayRenderProps(component, project),
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function indexFile(projectId: string): string {
  return path.join(projectCacheDirectory(projectId), "motion-renders.json");
}

async function readIndex(projectId: string): Promise<Record<string, CacheEntry>> {
  try {
    const raw = await fs.readFile(indexFile(projectId), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeIndex(
  projectId: string,
  index: Record<string, CacheEntry>,
): Promise<void> {
  await fs.mkdir(path.dirname(indexFile(projectId)), { recursive: true });
  await fs.writeFile(indexFile(projectId), JSON.stringify(index, null, 2), "utf-8");
}

/** Serializa las escrituras del índice por proyecto. */
function withIndex<T>(
  projectId: string,
  update: (index: Record<string, CacheEntry>) => Promise<T> | T,
): Promise<T> {
  const previous = indexLocks.get(projectId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const index = await readIndex(projectId);
      const result = await update(index);
      await writeIndex(projectId, index);
      return result;
    });
  indexLocks.set(projectId, next);
  return next;
}

async function freeBytes(target: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function ensureSpace(target: string, minBytes: number, label: string): Promise<void> {
  const free = await freeBytes(target);
  if (free !== null && free < minBytes) {
    throw new HttpError(
      507,
      `No hay espacio suficiente en ${label} para el render (libres ${(free / 1073741824).toFixed(2)} GB). Libera espacio y vuelve a intentarlo.`,
      "no_disk_space",
    );
  }
}

export function jobPublic(job: OverlayJob): Record<string, unknown> {
  const elapsed = Date.now() - job.startedAt;
  const stageElapsed = Date.now() - (job.stageStartedAt ?? job.startedAt);
  // La ETA solo tiene sentido durante el render: durante el bundle el avance
  // de webpack no es lineal y la estimación se dispararía.
  const etaMs =
    job.status === "rendering" && job.stage === "render" && job.stageProgress > 0.03
      ? Math.max(0, Math.round((stageElapsed / job.stageProgress) * (1 - job.stageProgress)))
      : undefined;
  return {
    key: job.key,
    name: job.name,
    status: job.status,
    progress: Number(job.progress.toFixed(4)),
    stage: job.stage,
    error: job.error,
    assetId: job.assetId,
    etaMs,
    elapsedMs: elapsed,
  };
}

export function getOverlayJob(key: string): OverlayJob | undefined {
  return jobs.get(key);
}

export function listOverlayJobs(projectId: string): Array<Record<string, unknown>> {
  return [...jobs.values()]
    .filter((job) => job.projectId === projectId)
    .map((job) => jobPublic(job));
}

function tempRenderPath(projectId: string, key: string): string {
  return path.join(RENDER_CACHE_DIR, projectId, `${key}.webm`);
}

async function pruneTempRenders(projectId: string, keepKey: string): Promise<void> {
  const dir = path.join(RENDER_CACHE_DIR, projectId);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const files: Array<{ name: string; mtime: number }> = [];
  for (const name of entries) {
    if (!name.endsWith(".webm")) continue;
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (stat) files.push({ name, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    if (file.name === `${keepKey}.webm`) continue;
    if (index >= MAX_TEMP_RENDERS_PER_PROJECT) {
      await fs.rm(path.join(dir, file.name), { force: true }).catch(() => undefined);
    }
  }
}

async function runJob(
  job: OverlayJob,
  component: OverlayComponent,
  project: any,
): Promise<string> {
  const projectId = job.projectId;
  const outputPath = tempRenderPath(projectId, job.key);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await ensureSpace(path.dirname(outputPath), MIN_FREE_BYTES_TEMP, "el disco temporal");

  job.status = "rendering";
  job.startedAt = Date.now();
  job.progress = 0;
  job.stage = "bundle";
  job.stageProgress = 0;
  job.stageStartedAt = job.startedAt;

  const handle = renderPool.renderWithProgress(
    {
      id: `overlay-${job.key}`,
      type: "final",
      componentCode: component.code,
      componentName: component.name,
      compositionId: component.compositionId,
      width: projectWidth(project),
      height: projectHeight(project),
      fps: projectFps(project),
      durationInFrames: component.durationInFrames,
      props: overlayRenderProps(component, project),
      outputPath,
      transparentBackground: true,
      bundleKey: overlayBundleKey(component, project),
      crf: 36,
    },
    (progress: RenderProgress) => {
      if (progress.stage !== job.stage) {
        job.stage = progress.stage;
        job.stageStartedAt = Date.now();
      }
      job.stageProgress = Math.max(0, Math.min(1, progress.progress));
      job.progress =
        progress.stage === "bundle"
          ? job.stageProgress * 0.12
          : 0.12 + job.stageProgress * 0.88;
    },
  );
  job.cancel = handle.cancel;

  const result = await handle.promise;
  if (!result.success || !result.videoPath) {
    if (result.error === "cancelled") {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      throw new Error("cancelled");
    }
    job.status = "error";
    job.error = result.error ?? "Error desconocido";
    job.finishedAt = Date.now();
    throw new Error(job.error);
  }

  const stat = await fs.stat(result.videoPath).catch(() => null);
  console.log(
    `[Motion] ${component.name}: bundle ${result.bundleMs ?? 0}ms` +
      `${result.bundleCached ? " (cache)" : ""} · render ${result.renderMs ?? 0}ms · ${(
        (stat?.size ?? 0) / 1048576
      ).toFixed(1)} MB`,
  );
  job.status = "done";
  job.progress = 1;
  job.filePath = result.videoPath;
  job.finishedAt = Date.now();

  await withIndex(projectId, (index) => {
    index[job.key] = {
      key: job.key,
      name: component.name,
      file: result.videoPath,
      bytes: stat?.size ?? 0,
      durationFrames: component.durationInFrames,
      isSubtitles: isSubtitleComponent(component),
      component: {
        code: component.code,
        name: component.name,
        compositionId: component.compositionId,
        props: component.props,
      },
      createdAt: Date.now(),
    };
  });
  void pruneTempRenders(projectId, job.key);
  return result.videoPath;
}

export interface StartRenderOptions {
  projectId: string;
  project: any;
  component: OverlayComponent;
  origin?: "prewarm" | "user";
}

/**
 * Arranca (o reutiliza) el render del overlay. Devuelve inmediatamente un job
 * con su estado; si ya existe el asset importado, el estado es "done" sin
 * renderizar nada.
 */
export async function startOverlayRender(options: StartRenderOptions): Promise<OverlayJob> {
  const { projectId, project, component } = options;
  const origin = options.origin ?? "user";
  const key = overlayRenderKey(component, project);

  const existing = jobs.get(key);
  if (existing) {
    if (existing.status === "error" || existing.status === "cancelled") {
      // Un intento fallido no debe bloquear para siempre la misma pieza.
      jobs.delete(key);
    } else {
      if (origin === "user") existing.origin = "user";
      return existing;
    }
  }

  // ¿Ya está importado en el proyecto? Entonces no hay nada que renderizar.
  const index = await readIndex(projectId);
  const cached = index[key];
  if (cached?.assetId && project.media?.some((asset: any) => asset.id === cached.assetId)) {
    const done: OverlayJob = {
      key,
      projectId,
      name: component.name,
      status: "done",
      progress: 1,
      stage: "render",
      stageProgress: 1,
      stageStartedAt: Date.now(),
      assetId: cached.assetId,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      origin,
    };
    jobs.set(key, done);
    return done;
  }

  // El render ya existe en disco pero aún no se importó (p. ej. el servidor se
  // reinició entre renderizar e insertar): se reutiliza tal cual.
  if (cached?.file) {
    const stat = await fs.stat(cached.file).catch(() => null);
    if (stat) {
      const done: OverlayJob = {
        key,
        projectId,
        name: component.name,
        status: "done",
        progress: 1,
        stage: "render",
        stageProgress: 1,
        stageStartedAt: Date.now(),
        filePath: cached.file,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        origin,
      };
      jobs.set(key, done);
      return done;
    }
  }

  const job: OverlayJob = {
    key,
    projectId,
    name: component.name,
    status: "rendering",
    progress: 0,
    stage: "bundle",
    stageProgress: 0,
    stageStartedAt: Date.now(),
    startedAt: Date.now(),
    origin,
  };
  jobs.set(key, job);
  projectPrewarm.set(projectId, key);

  job.promise = runJob(job, component, project)
    .catch((error) => {
      if (job.status !== "cancelled") {
        console.error(
          "[Motion] Render falló:",
          error instanceof Error ? error.message : error,
        );
      }
      throw error;
    })
    .finally(() => {
      if (projectPrewarm.get(projectId) === key && job.status !== "done") {
        projectPrewarm.delete(projectId);
      }
    });

  // Evita un unhandled rejection: el cliente consulta el estado del job.
  void job.promise.catch(() => undefined);

  return job;
}

/**
 * Pre-render en segundo plano: cuando la pieza está lista se empieza a
 * renderizar sola. Si el usuario pulsa "Render + Insertar" después, solo hay
 * que insertar el archivo.
 */
export function schedulePrewarm(
  projectId: string,
  project: any,
  component: OverlayComponent,
  delayMs = 1500,
): void {
  cancelPrewarm(projectId);
  const timer = setTimeout(() => {
    prewarmTimers.delete(projectId);
    void startOverlayRender({ projectId, project, component, origin: "prewarm" }).catch(
      () => undefined,
    );
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  prewarmTimers.set(projectId, timer);
}

export function cancelPrewarm(projectId: string): void {
  const timer = prewarmTimers.get(projectId);
  if (timer) {
    clearTimeout(timer);
    prewarmTimers.delete(projectId);
  }
  // Cancela únicamente renders de fondo; un render pedido por el usuario se
  // respeta aunque llegue una pieza nueva.
  for (const job of jobs.values()) {
    if (
      job.projectId === projectId &&
      job.origin === "prewarm" &&
      job.status === "rendering"
    ) {
      job.cancel?.();
    }
  }
}

function isSubtitleAsset(project: any, mediaId: string): boolean {
  const asset = project.media?.find((item: any) => item.id === mediaId);
  return /subtit|caption|subs\b/i.test(asset?.name ?? "");
}

/**
 * Quita overlays de subtítulos antiguos que se solapen con el nuevo. Así,
 * cambiar de estilo reemplaza los subtítulos en vez de apilar dos capas de
 * texto (o empujar la nueva fuera del vídeo).
 */
function removeOverlappingSubtitles(
  project: any,
  start: number,
  frames: number,
): any {
  const end = start + frames;
  let changed = false;
  const tracks = project.tracks.map((track: any) => {
    if (
      track.kind !== "video" ||
      !String(track.name ?? "").startsWith(MOTION_OVERLAY_TRACK_NAME)
    ) {
      return track;
    }
    const clips = track.clips.filter((clip: any) => {
      const overlaps =
        start < clip.startFrame + clip.durationFrames && end > clip.startFrame;
      const subtitle =
        clip.type === "video" && isSubtitleAsset(project, clip.mediaId);
      if (subtitle && overlaps) {
        changed = true;
        return false;
      }
      return true;
    });
    return clips.length === track.clips.length ? track : { ...track, clips };
  });
  return changed ? { ...project, tracks } : project;
}

export interface InsertOverlayOptions {
  key: string;
  startFrame?: number;
  insertAtEnd?: boolean;
  currentFrame?: number;
}

export interface InsertOverlayResult {
  assetId: string;
  clipFrames: number;
  startFrame: number;
  trackId: string;
  revision: number;
  videoPath?: string;
  sfxType?: string;
}

export async function insertOverlay(
  projectId: string,
  options: InsertOverlayOptions,
): Promise<InsertOverlayResult> {
  const job = jobs.get(options.key);
  if (job && job.status === "rendering") {
    throw new HttpError(
      409,
      "El render todavía se está preparando. Espera a que termine e inténtalo de nuevo.",
      "render_not_ready",
    );
  }
  if (job?.status === "error") {
    throw new HttpError(
      500,
      `El render falló: ${job.error ?? "sin detalle"}`,
      "render_failed",
    );
  }

  const bundle = await projectStore.get(projectId);
  const project = bundle.project;
  const index = await readIndex(projectId);
  const entry = index[options.key];
  if (!entry) {
    throw new HttpError(
      404,
      "No encuentro el render de esta pieza. Vuelve a generarla.",
      "render_missing",
    );
  }

  let asset = entry.assetId
    ? project.media.find((item: any) => item.id === entry.assetId)
    : undefined;

  if (!asset) {
    if (!entry.file) {
      throw new HttpError(
        410,
        "El archivo del render ya no está disponible. Vuelve a generarlo.",
        "render_file_missing",
      );
    }
    const stat = await fs.stat(entry.file).catch(() => null);
    if (!stat) {
      throw new HttpError(
        410,
        "El archivo del render ya no está disponible. Vuelve a generarlo.",
        "render_file_missing",
      );
    }
    const dataDir = path.dirname(projectCacheDirectory(projectId));
    await ensureSpace(dataDir, stat.size + MIN_FREE_BYTES_DATA, "el disco del proyecto");
    asset = await importMediaFile(projectId, entry.file, `${entry.name}.webm`);
    await withIndex(projectId, (current) => {
      current[options.key] = {
        ...entry,
        assetId: asset!.id,
        file: undefined,
        bytes: stat.size,
        createdAt: Date.now(),
      };
    });
    if (job) job.assetId = asset.id;
  }

  const fps = projectFps(project);
  const baseOverlay = ensureMotionOverlayTrack(project);
  let updatedProject = baseOverlay.project;
  let targetTrack =
    getTrackById(updatedProject, baseOverlay.track.id) ?? baseOverlay.track;

  const clipFrames =
    asset.durationUs > 0
      ? Math.max(1, Math.round((asset.durationUs / 1_000_000) * fps))
      : Math.max(1, entry.durationFrames);

  // Los subtítulos van SIEMPRE alineados al clip de video que los originó:
  // sus tiempos son relativos a ese clip. Sin esto el overlay caería al final
  // del timeline (fuera del video) y no se vería nada.
  const subtitleOverlay =
    entry.isSubtitles === true || /subtit|caption|subs\b/i.test(entry.name);
  const desiredStart = subtitleOverlay
    ? options.startFrame ?? 0
    : options.insertAtEnd
      ? timelineDurationFrames(updatedProject)
      : options.startFrame ?? Math.max(0, Math.round(options.currentFrame ?? 0));

  // Un subtítulo nuevo reemplaza al anterior del mismo tramo: nunca debe quedar
  // texto duplicado ni acabar empujado más allá del final del vídeo.
  if (subtitleOverlay) {
    updatedProject = removeOverlappingSubtitles(updatedProject, desiredStart, clipFrames);
    targetTrack =
      getTrackById(updatedProject, targetTrack.id) ?? targetTrack;
  }

  let startFrame = findFreeStartFrame(targetTrack, desiredStart, clipFrames);

  // Si el hueco está ocupado (p. ej. ya hay subtítulos o un overlay largo), se
  // crea una pista de overlay encima en vez de mover la pieza fuera del vídeo.
  const overlayTrackCount = updatedProject.tracks.filter(
    (track: any) =>
      track.kind === "video" &&
      String(track.name ?? "").startsWith(MOTION_OVERLAY_TRACK_NAME),
  ).length;
  if (startFrame !== desiredStart && overlayTrackCount < 4) {
    const added = addTrack(
      updatedProject,
      "video",
      `${MOTION_OVERLAY_TRACK_NAME} ${overlayTrackCount + 1}`,
    );
    if (added.ok && added.track) {
      updatedProject = added.project;
      targetTrack = added.track;
      startFrame = desiredStart;
    }
  }

  const cleanComponentName = entry.name.replace(/\.webm$/i, "");
  const mediaClip = {
    ...makeMediaClip(updatedProject, asset, {
      startFrame,
      durationFrames: clipFrames,
      createdBy: "agent",
    }),
    name: cleanComponentName,
    ...(entry.component
      ? {
          remotion: {
            code: entry.component.code,
            componentName: cleanComponentName,
            compositionId: entry.component.compositionId || cleanComponentName,
            props: entry.component.props ?? {},
            styleId: subtitleOverlay ? "minimal" : undefined,
            live: false,
          },
        }
      : {}),
  };

  const addResult = addClip(updatedProject, targetTrack.id, mediaClip);
  if (!addResult.ok) {
    throw new HttpError(422, addResult.error, "clip_insert_failed");
  }
  updatedProject = addResult.project;
  const saved = await projectStore.saveTimeline(projectId, updatedProject, {
    force: true,
  });

  console.log(
    `[Motion] Insertado "${entry.name}" en "${targetTrack.name}" @ frame ${startFrame}` +
      ` (${clipFrames} frames, rev ${saved.project.revision})`,
  );

  let finalRevision = saved.project.revision;
  let syncedSfxType: string | undefined;

  // Sound Design Sincronizado: Emparejamiento automático de micro-efecto de sonido en pista SFX
  if (!subtitleOverlay) {
    try {
      const { syncMotionSoundEffect } = await import("../services/sfxService.js");
      const sfxResult = await syncMotionSoundEffect(projectId, {
        startFrame,
        componentName: cleanComponentName,
        code: entry.component?.code,
      });
      if (sfxResult.ok) {
        syncedSfxType = sfxResult.sfxType;
        const fresh = await projectStore.get(projectId);
        finalRevision = fresh.project.revision;
      }
    } catch (sfxErr) {
      console.warn("[Motion] Error al sincronizar micro-SFX:", sfxErr);
    }
  }

  return {
    assetId: asset.id,
    clipFrames,
    startFrame,
    trackId: targetTrack.id,
    revision: finalRevision,
    videoPath: entry.file,
    sfxType: syncedSfxType,
  };
}

/** Render + insertar en una sola llamada (compatibilidad y automatizaciones). */
export async function renderAndInsertOverlay(
  options: StartRenderOptions & {
    startFrame?: number;
    insertAtEnd?: boolean;
    currentFrame?: number;
  },
): Promise<InsertOverlayResult & { renderMs: number }> {
  const job = await startOverlayRender({ ...options, origin: "user" });
  if (job.promise && job.status !== "done") {
    await job.promise.catch(() => undefined);
  }
  if (job.status !== "done") {
    throw new HttpError(
      500,
      `El render no terminó: ${job.error ?? "cancelado"}`,
      "render_failed",
    );
  }
  const result = await insertOverlay(options.projectId, {
    key: job.key,
    startFrame: options.startFrame,
    insertAtEnd: options.insertAtEnd,
    currentFrame: options.currentFrame,
  });
  return {
    ...result,
    assetId: job.assetId ?? result.assetId,
    renderMs: job.finishedAt ? job.finishedAt - job.startedAt : 0,
  };
}
