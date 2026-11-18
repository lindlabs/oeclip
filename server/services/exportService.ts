import fs from "node:fs/promises";
import path from "node:path";
import type { ExportRecord, ExportSettings, Project, TimelineClip } from "../../src/shared/schema";
import { newId } from "../../src/shared/time";
import { exportSettingsSchema } from "../../src/shared/schema";
import { timelineDurationFrames } from "../../src/shared/project";
import { isLiveRemotionClip } from "../../src/shared/timeline";
import { HttpError, sanitizeFileName, uniqueFileName } from "../util/fs";
import { projectDirectory, projectExportDirectory, projectStore, projectTempDirectory } from "../projects/store";
import { config } from "../config";
import { jobQueue, type JobContext, type JobState } from "../jobs";
import { buildCompositeArgs, buildExport, trimProjectToSeconds, type BuiltExport } from "../media/export";
import { renderOverlaySequence, remotionEngineAvailable } from "../media/remotion";
import { probeMedia, verifyVideoFile, type ExportVerificationResult } from "../media/probe";
import { selectEncoder } from "../system";
import { framesToSeconds } from "../../src/shared/time";
import { dimensionsFor } from "../../src/shared/presets";

function validateProjectForExport(project: Project): void {
  if (timelineDurationFrames(project) <= 0) {
    throw new HttpError(422, "La línea de tiempo está vacía.", "empty_timeline");
  }
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type === "text") continue;
      if (Boolean(clip.remotion?.code)) continue;
      const asset = project.media.find((item) => item.id === clip.mediaId);
      if (!asset || asset.missing) {
        throw new HttpError(
          409,
          `El recurso "${clip.name}" no está disponible. Reimpórtalo antes de exportar.`,
          "media_missing",
        );
      }
    }
  }
}

export function normalizeFileName(input: string): string {
  const base = sanitizeFileName(input, "oeclip-export")
    .replace(/\.mp4$/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/[-.]+$/, "")
    .slice(0, 100);
  return `${base || "oeclip-export"}.mp4`;
}

export async function startExport(
  projectId: string,
  settingsInput: ExportSettings,
): Promise<{ record: ExportRecord; job: JobState }> {
  const settings = exportSettingsSchema.parse(settingsInput);
  const bundle = await projectStore.get(projectId);
  validateProjectForExport(bundle.project);
  const record: ExportRecord = {
    id: newId("exp"),
    status: "queued",
    progress: 0,
    settings: { ...settings, fileName: normalizeFileName(settings.fileName) },
    startedAt: new Date().toISOString(),
  };
  await projectStore.addExport(projectId, record);
  const job = jobQueue.enqueue({
    type: "export",
    projectId,
    label: `Exportar ${record.settings.fileName}`,
    cancellable: true,
    run: (context) => runExport(projectId, record.id, context),
  });
  return { record, job };
}

async function safeUpdateRecord(projectId: string, exportId: string, patch: Partial<ExportRecord>): Promise<void> {
  try {
    await projectStore.updateExport(projectId, exportId, patch);
  } catch (error) {
    console.warn("[oeclip] No se pudo actualizar el registro de exportación:", error instanceof Error ? error.message : error);
  }
}

const STALE_TEMP_MS = 30 * 60_000;

/**
 * Purga carpetas temporales huérfanas (export-*, remotion-*, tmp-*). Solo elimina las que
 * llevan más de 30 minutos sin modificarse, para no destruir exportaciones en curso del
 * mismo proyecto (antes un segundo export borraba el directorio del primero).
 */
export async function purgeStaleTempDirs(projectId?: string): Promise<void> {
  try {
    const tmpRoot = config.tmpDir;
    const exists = await fs.access(tmpRoot).then(() => true).catch(() => false);
    if (!exists) return;

    const projectDirs = projectId
      ? [path.join(tmpRoot, projectId)]
      : await fs.readdir(tmpRoot).then((dirs) => dirs.map((d) => path.join(tmpRoot, d))).catch(() => []);

    const now = Date.now();
    for (const pDir of projectDirs) {
      try {
        const stat = await fs.stat(pDir).catch(() => null);
        if (!stat?.isDirectory()) continue;
        const entries = await fs.readdir(pDir).catch(() => []);
        for (const entry of entries) {
          if (!(entry.startsWith("export-") || entry.startsWith("remotion-") || entry.startsWith("tmp-"))) continue;
          const targetPath = path.join(pDir, entry);
          const entryStat = await fs.stat(targetPath).catch(() => null);
          if (!entryStat || now - entryStat.mtimeMs < STALE_TEMP_MS) continue;
          for (let i = 0; i < 3; i++) {
            try {
              await fs.rm(targetPath, { recursive: true, force: true });
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 150));
            }
          }
        }
      } catch {
        // Ignorar errores al acceder a subdirectorios
      }
    }
  } catch (err) {
    console.warn("[exportService] Falló purga de temporales:", err);
  }
}

/** Mueve un archivo entre discos distintos (EXDEV): copia a un nombre parcial y renombra al final. */
async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const partial = `${destination}.partial`;
  await fs.copyFile(source, partial);
  await fs.rename(partial, destination);
  await fs.rm(source, { force: true }).catch(() => undefined);
}

async function runExport(projectId: string, exportId: string, context: JobContext): Promise<unknown> {
  await purgeStaleTempDirs(projectId);
  const bundle = await projectStore.get(projectId);
  const project = bundle.project;
  const record = bundle.exports.find((item) => item.id === exportId);
  if (!record) throw new HttpError(404, "El registro de exportación no existe.", "export_not_found");
  validateProjectForExport(project);
  const settings = record.settings;
  const projectDir = projectDirectory(projectId);
  const exportsDir = projectExportDirectory(projectId);
  const tempDir = path.join(projectTempDirectory(projectId), `export-${exportId}`);
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  const finalPath = await uniqueFileName(exportsDir, normalizeFileName(settings.fileName));
  const tempOutput = path.join(tempDir, `${exportId}.mp4`);
  const relativeOutput = path.relative(projectDir, finalPath).replace(/\\/g, "/");
  const startedAt = Date.now();
  const durationSeconds = framesToSeconds(timelineDurationFrames(project), project.settings.fps);

  await safeUpdateRecord(projectId, exportId, {
    status: "running",
    progress: 0,
    startedAt: new Date().toISOString(),
  });
  context.setDetail({ exportId, outputFile: relativeOutput });
  context.setProgress(0.01, "Preparando el grafo de montaje");

  let encoder = await selectEncoder(settings.encoder);
  let built: BuiltExport | null = null;
  let fallbackUsed = false;
  let lastPersist = 0;
  let stderrTail = "";

  const hasTextClips = project.tracks.some(
    (track) => track.kind === "text" && !track.hidden && track.clips.some((clip) => clip.type === "text"),
  );
  // Los gráficos de datos (barras, contadores, progreso) y los componentes en vivo
  // de Remotion (subtítulos IA, lower thirds, gráficos motion) se renderizan con
  // el motor Remotion para paridad 100% con el monitor.
  const hasGraphicClips = project.tracks.some(
    (track) =>
      track.kind === "text" &&
      !track.hidden &&
      track.clips.some((clip) => clip.type === "text" && Boolean(clip.graphic)),
  );
  const requiresHeavyRemotion = (clip: TimelineClip): boolean => {
    if (!isLiveRemotionClip(clip)) return false;
    // Subtítulos dinámicos IA con props.captions se queman nativamente vía libass (.ass) en FFmpeg (ultra-rápido)
    if (
      clip.type === "text" &&
      clip.remotion &&
      (Array.isArray(clip.remotion.props?.captions) ||
        clip.role === "subtitle" ||
        /subt[íi]tulos|subtitles/i.test(clip.name || clip.remotion.componentName || ""))
    ) {
      return false;
    }
    return true;
  };
  const hasLiveRemotionClips = project.tracks.some(
    (track) =>
      !track.hidden &&
      track.clips.some((clip) => requiresHeavyRemotion(clip)),
  );
  const useRemotion =
    (hasTextClips && (settings.engine === "remotion" || hasGraphicClips)) ||
    hasLiveRemotionClips;
  if (settings.engine === "remotion" && !hasTextClips && !hasLiveRemotionClips) {
    stderrTail = "El proyecto no tiene capas de texto ni componentes Motion: se exportó con el motor FFmpeg clásico.";
  }
  if ((hasGraphicClips || hasLiveRemotionClips) && settings.engine !== "remotion") {
    stderrTail = `${stderrTail}\nEl proyecto contiene componentes o subtítulos en vivo de Remotion; se usó Remotion automáticamente.`.trim();
  }
  if (useRemotion && !remotionEngineAvailable()) {
    throw new HttpError(
      409,
      "El motor Remotion no está instalado. Ejecuta npm install o exporta con el motor FFmpeg.",
      "remotion_not_installed",
    );
  }
  const remotionFramesDir = path.join(tempDir, "remotion-frames");
  const compositeOutput = path.join(tempDir, `${exportId}-composite.mp4`);
  let verifyFile = tempOutput;

  const cleanupBuild = async (candidate: BuiltExport | null) => {
    if (!candidate) return;
    await fs.rm(candidate.filterFile, { force: true }).catch(() => undefined);
    for (const file of candidate.textFiles) await fs.rm(file, { force: true }).catch(() => undefined);
  };

  const runOnce = async (
    selectedEncoder: "libx264" | "h264_nvenc",
    build: { skipText?: boolean; intermediate?: boolean },
    progressFrom: number,
    progressTo: number,
  ): Promise<BuiltExport> => {
    const candidate = await buildExport(project, settings, {
      outputFile: tempOutput,
      projectDir,
      tempDir,
      encoder: selectedEncoder,
      skipText: build.skipText,
      intermediate: build.intermediate,
    });
    try {
      context.setProgress(
        progressFrom,
        `Codificando con ${selectedEncoder === "h264_nvenc" ? "NVENC (GPU)" : "CPU"}`,
      );
      await fs.rm(tempOutput, { force: true });
      await runExportProcess(candidate.args, {
        signal: context.signal,
        durationSeconds,
        onProgress: (progress) => {
          const ratio = Math.min(1, Math.max(0, progress.progress));
          const elapsed = (Date.now() - startedAt) / 1000;
          const eta = ratio > 0.01 ? elapsed / ratio - elapsed : undefined;
          context.setProgress(progressFrom + ratio * (progressTo - progressFrom), "Codificando video");
          if (eta !== undefined && Number.isFinite(eta)) context.setDetail({ etaSeconds: Math.max(0, Math.round(eta)) });
          const now = Date.now();
          if (now - lastPersist > 2500) {
            lastPersist = now;
            void safeUpdateRecord(projectId, exportId, {
              progress: Math.min(0.95, progressFrom + ratio * (progressTo - progressFrom)),
              etaSeconds: eta !== undefined && Number.isFinite(eta) ? Math.max(0, Math.round(eta)) : undefined,
            });
          }
        },
        onStderr: (line) => {
          stderrTail = `${stderrTail}\n${line}`.slice(-6000);
        },
      });
      return candidate;
    } catch (error) {
      await cleanupBuild(candidate);
      throw error;
    }
  };

  try {
    if (useRemotion) {
      // Fase 1: video + audio base, sin texto y casi sin pérdida.
      const baseBuild = { skipText: true, intermediate: true };
      try {
        built = await runOnce(encoder, baseBuild, 0.02, 0.42);
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (encoder === "h264_nvenc") {
          fallbackUsed = true;
          encoder = "libx264";
          context.setMessage("NVENC no disponible; se reintenta con CPU");
          await safeUpdateRecord(projectId, exportId, {
            logTail: `El codificador NVENC fallo y se reintento con CPU.\n${error instanceof Error ? error.message : String(error)}`.slice(0, 6000),
          });
          await fs.rm(tempOutput, { force: true });
          built = await runOnce(encoder, baseBuild, 0.02, 0.42);
        } else {
          throw error;
        }
      }

      // Fase 2: capa de gráficos con Remotion (PNG con alfa).
      const overlay = await renderOverlaySequence(project, settings, remotionFramesDir, {
        onProgress: (ratio) => context.setProgress(0.42 + ratio * 0.44, "Renderizando gráficos con Remotion"),
        onMessage: (message) => context.setMessage(message),
        signal: context.signal,
      });
      if (context.signal.aborted) throw new HttpError(499, "Exportación cancelada.", "job_cancelled");
      if (overlay.frameCount === 0) {
        throw new HttpError(500, "Remotion no generó fotogramas de gráficos.", "remotion_frames_missing");
      }

      // Fase 3: composición final sobre la base, con el audio intacto.
      const compositeArgs = buildCompositeArgs({
        baseFile: tempOutput,
        framesDir: overlay.framesDir,
        frameCount: overlay.frameCount,
        overlayFps: overlay.overlayFps,
        settings,
        encoder,
        outputFile: compositeOutput,
        durationSeconds,
      });
      await runExportProcess(compositeArgs, {
        signal: context.signal,
        durationSeconds,
        onProgress: (progress) => {
          const ratio = Math.min(1, Math.max(0, progress.progress));
          context.setProgress(0.86 + ratio * 0.08, "Componiendo video y gráficos");
        },
        onStderr: (line) => {
          stderrTail = `${stderrTail}\n${line}`.slice(-6000);
        },
      });
      verifyFile = compositeOutput;
    } else {
      try {
        built = await runOnce(encoder, {}, 0.02, 0.9);
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (encoder === "h264_nvenc") {
          fallbackUsed = true;
          encoder = "libx264";
          context.setMessage("NVENC no disponible; se reintenta con CPU");
          await safeUpdateRecord(projectId, exportId, {
            logTail: `El codificador NVENC fallo y se reintento con CPU.\n${error instanceof Error ? error.message : String(error)}`.slice(0, 6000),
          });
          await fs.rm(tempOutput, { force: true });
          built = await runOnce(encoder, {}, 0.02, 0.9);
        } else {
          throw error;
        }
      }
    }

    context.setProgress(0.92, "Verificando el archivo exportado");
    if (!built) throw new HttpError(500, "No se generó ningún archivo.", "export_missing");
    const completed = built;
    const verification = await verifyVideoFile(verifyFile, {
      durationUs: completed.durationUs,
      width: completed.width,
      height: completed.height,
      hasAudio: completed.expectedAudio,
    });
    if (!verification.valid) {
      const message = `La exportación no superó la verificación: ${verification.message}`;
      await safeUpdateRecord(projectId, exportId, {
        status: "failed",
        progress: 1,
        error: message,
        finishedAt: new Date().toISOString(),
        logTail: stderrTail.slice(-6000),
      });
      throw new HttpError(500, message, "export_verification_failed");
    }
    await moveFile(verifyFile, finalPath);
    const stat = await fs.stat(finalPath);
    const verificationWithSize: ExportVerificationResult = { ...verification, sizeBytes: stat.size };
    await safeUpdateRecord(projectId, exportId, {
      status: "done",
      progress: 1,
      outputFile: relativeOutput,
      finishedAt: new Date().toISOString(),
      verification: {
        durationUs: verificationWithSize.durationUs,
        width: verificationWithSize.width,
        height: verificationWithSize.height,
        videoCodec: verificationWithSize.videoCodec,
        audioCodec: verificationWithSize.audioCodec,
        fps: verificationWithSize.fps,
        sizeBytes: verificationWithSize.sizeBytes,
      },
      logTail: fallbackUsed
        ? "Exportado con CPU tras fallo de NVENC."
        : useRemotion
          ? "Capa de gráficos renderizada con Remotion y compuesta sobre el video base."
          : stderrTail || undefined,
      error: undefined,
      etaSeconds: 0,
    });
    context.setProgress(1, "Exportación verificada");
    context.setDetail({ outputFile: relativeOutput, verification: verificationWithSize, encoder });
    return {
      exportId,
      outputFile: relativeOutput,
      verification: verificationWithSize,
      encoder,
      durationSeconds,
    };
  } catch (error) {
    const aborted = context.signal.aborted;
    const message = aborted
      ? "Exportación cancelada por el usuario."
      : error instanceof HttpError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    await safeUpdateRecord(projectId, exportId, {
      status: aborted ? "cancelled" : "failed",
      progress: aborted ? 1 : context.getProgress(),
      error: message.slice(0, 4000),
      finishedAt: new Date().toISOString(),
      logTail: stderrTail.slice(-6000),
    });
    await fs.rm(tempOutput, { force: true }).catch(() => undefined);
    await fs.rm(compositeOutput, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await cleanupBuild(built);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

async function runExportProcess(
  args: string[],
  options: {
    signal: AbortSignal;
    durationSeconds: number;
    onProgress: (progress: { progress: number; seconds: number }) => void;
    onStderr: (line: string) => void;
  },
): Promise<void> {
  const { runFfmpeg } = await import("../media/process");
  await runFfmpeg(args, {
    signal: options.signal,
    durationSeconds: options.durationSeconds,
    timeoutMs: 6 * 60 * 60_000,
    onProgress: (progress) => options.onProgress(progress),
    onStderrLine: options.onStderr,
  });
}

export async function verifyExport(projectId: string, exportId: string): Promise<{
  record: ExportRecord;
  verification: ExportVerificationResult;
}> {
  const bundle = await projectStore.get(projectId);
  const record = bundle.exports.find((item) => item.id === exportId);
  if (!record) throw new HttpError(404, "La exportación no existe.", "export_not_found");
  if (!record.outputFile) throw new HttpError(409, "La exportación no tiene archivo final.", "export_not_ready");
  const file = path.join(projectDirectory(projectId), record.outputFile);
  await fs.access(file).catch(() => {
    throw new HttpError(404, "El archivo exportado ya no está en disco.", "export_file_missing");
  });
  const probe = await probeMedia(file);
  const stat = await fs.stat(file);
  const dimensions = dimensionsFor(record.settings.aspect, record.settings.resolution);
  const issues: string[] = [];
  if (probe.kind !== "video") issues.push("El archivo no contiene video.");
  if (probe.width !== dimensions.width || probe.height !== dimensions.height) {
    issues.push(`Dimensiones ${probe.width}x${probe.height} frente a ${dimensions.width}x${dimensions.height}.`);
  }
  if (record.verification && Math.abs(probe.durationUs - record.verification.durationUs) > 1_000_000) {
    issues.push("La duración del archivo no coincide con la registrada.");
  }
  if (probe.sizeBytes <= 0) issues.push("El archivo está vacío.");
  const verification: ExportVerificationResult = {
    valid: issues.length === 0,
    message: issues.length === 0 ? "Exportación verificada con FFprobe." : issues.join(" "),
    durationUs: probe.durationUs,
    width: probe.width ?? 0,
    height: probe.height ?? 0,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    fps: probe.fps ? probe.fps.num / probe.fps.den : undefined,
    sizeBytes: stat.size,
  };
  const updated = await projectStore.updateExport(projectId, exportId, {
    verification: {
      durationUs: verification.durationUs,
      width: verification.width,
      height: verification.height,
      videoCodec: verification.videoCodec,
      audioCodec: verification.audioCodec,
      fps: verification.fps,
      sizeBytes: stat.size,
    },
    status: verification.valid ? "done" : "failed",
    error: verification.valid ? undefined : verification.message,
  });
  return { record: updated, verification };
}

export function exportDownloadPath(projectId: string, record: ExportRecord): string {
  if (!record.outputFile) throw new HttpError(409, "La exportación aún no tiene archivo.", "export_not_ready");
  return path.join(projectDirectory(projectId), record.outputFile);
}

export { trimProjectToSeconds };
