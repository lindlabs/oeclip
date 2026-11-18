import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { MediaAsset, MediaClip, Project } from "../../src/shared/schema";
import { projectSchema, exportSettingsSchema } from "../../src/shared/schema";
import {
  addClip,
  applySourceRanges,
  clipEnd,
  ensureMotionOverlayTrack,
  findFreeStartFrame,
  moveClip,
  removeClips,
  rippleShiftAfter,
  setClipSpeed,
  splitClipAt,
  trimClipBy,
  updateClip,
  addTextClip,
  addTrack,
  sortClips,
} from "../../src/shared/timeline";
import { runSkillTool, listSkillsTool, getSkillTool, createSkillTool } from "../skills/tools";
import {
  firstTextTrack,
  firstVideoTrack,
  getClipById,
  getMediaById,
  makeMediaClip,
  makeTextClip,
  timelineDurationFrames,
  touchProject,
  projectSummary,
} from "../../src/shared/project";
import { framesToSeconds, frameDurationUs, newId } from "../../src/shared/time";
import { ASPECT_PRESETS, dimensionsFor, even, type AspectRatio } from "../../src/shared/presets";
import { wrapText } from "../../src/shared/srt";
import { SUBTITLE_STYLES, ensureReadableText, withSubtitleStyle } from "../../src/shared/subtitles";
import { config } from "../config";
import { HttpError } from "../util/fs";
import { requireMediaFile, analyzeAudioEnvelope, generateProxy } from "../media/library";
import {
  detectScenes,
  detectSilences,
  findHighlights,
  keepRangesFromSilences,
  measureLoudness,
} from "../media/analysis";
import { probeMedia } from "../media/probe";
import { aiStatus, transcribeMedia } from "../ai/provider";
import { verifyExport, startExport } from "../services/exportService";
import { trimProjectToSeconds } from "../media/export";
import { projectDirectory, projectMediaDirectory, projectStore } from "../projects/store";
import { computeSafeRemotionConcurrency, remotionEngineAvailable } from "../media/remotion";
import {
  buildTimelineQaReport,
  detectLowResolutionSources,
  extractRemotionClipVisibleTexts,
  generateContactSheet,
  inspectTimelineFrame,
  renderTimelineFrames,
} from "./perception";
import { runSwarmDirector } from "./swarmDirector";

export type ToolExecutionStatus = "verified" | "unverified" | "fallback" | "failed";

export interface ToolVerification {
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  evidence: string[];
}

export interface ToolContext {
  projectId: string;
  project: Project;
  signal: AbortSignal;
  setProgress: (progress: number, message?: string) => void;
}

export interface ToolResult {
  summary: string;
  project?: Project;
  data?: unknown;
  status?: ToolExecutionStatus;
  warnings?: string[];
  verification?: ToolVerification;
}

/** Contrato uniforme de respuesta para todas las herramientas (Sección 5.4). */
export function normalizeToolResponse(toolName: string, result: ToolResult, revision: number) {
  const dataObj = (result.data && typeof result.data === "object" ? result.data : {}) as Record<string, unknown>;
  const warnings = Array.isArray(result.warnings)
    ? result.warnings
    : Array.isArray(dataObj.warnings)
      ? (dataObj.warnings as unknown[]).map((w) => String(w))
      : [];
  const status: ToolExecutionStatus =
    result.status ??
    (dataObj.status === "fallback" || dataObj.status === "unverified" || dataObj.status === "failed" || dataObj.status === "verified"
      ? (dataObj.status as ToolExecutionStatus)
      : "verified");
  const verification: ToolVerification = result.verification ?? {
    checks: [],
    evidence: [],
  };
  return {
    ok: status !== "failed",
    status,
    tool: toolName,
    summary: result.summary,
    data: result.data ?? null,
    warnings,
    verification,
    revision,
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  argsSchema: z.ZodTypeAny;
  argsHint: string;
  risk: "low" | "medium" | "high";
  execute: (context: ToolContext, args: unknown) => Promise<ToolResult>;
}

function requireClip(project: Project, clipId: string): { project: Project; clip: MediaClip; trackId: string } {
  const found = getClipById(project, clipId);
  if (!found) throw new HttpError(404, `El clip ${clipId} no existe.`, "clip_not_found");
  if (found.clip.type === "text") {
    throw new HttpError(422, "Esta herramienta necesita un clip de video o audio.", "clip_type_invalid");
  }
  return { project, clip: found.clip, trackId: found.track.id };
}

function requireAsset(project: Project, mediaId?: string): MediaAsset {
  if (mediaId) {
    const asset = getMediaById(project, mediaId);
    if (!asset) throw new HttpError(404, "El recurso indicado no existe.", "media_not_found");
    return asset;
  }
  const fromClip = project.tracks
    .flatMap((track) => track.clips)
    .find((clip): clip is MediaClip => clip.type !== "text");
  if (fromClip) {
    const asset = getMediaById(project, fromClip.mediaId);
    if (asset) return asset;
  }
  const first = project.media.find((asset) => asset.kind !== "image");
  if (!first) throw new HttpError(422, "El proyecto no contiene recursos multimedia.", "no_media");
  return first;
}

function requireTimelineClipForMedia(project: Project, asset: MediaAsset): { clip: MediaClip; trackId: string } {
  const preferred = project.tracks.find(
    (track) =>
      track.kind === "video" &&
      !/motion|overlay|transici|v0|fondo\s*ambient/i.test(track.name),
  );
  const pools = [preferred, ...project.tracks.filter((t) => t !== preferred)].filter(Boolean);
  for (const track of pools) {
    if (!track) continue;
    const clip = track.clips.find((item) => item.type !== "text" && item.mediaId === asset.id);
    if (clip && clip.type !== "text") return { clip, trackId: track.id };
  }
  throw new HttpError(
    422,
    `El recurso "${asset.name}" no está colocado en la línea de tiempo. Añádelo antes de usar esta herramienta.`,
    "media_not_on_timeline",
  );
}

function ensureTextTrack(project: Project): { project: Project; trackId: string } {
  const existing = firstTextTrack(project);
  if (existing) return { project, trackId: existing.id };
  const result = addTrack(project, "text", "Subtitulos");
  if (!result.ok || !result.track) throw new HttpError(500, "No se pudo crear una pista de texto.", "track_failed");
  return { project: result.project, trackId: result.track.id };
}

const SUBTITLE_STYLE_IDS = SUBTITLE_STYLES.map((style) => style.id) as [string, ...string[]];

export function chunkSubtitleText(text: string, maxChars = 32, maxWords = 4): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let phrase: string[] = [];
  for (const word of words) {
    const candidate = [...phrase, word];
    if (phrase.length > 0 && (candidate.join(" ").length > maxChars || phrase.length >= maxWords)) {
      chunks.push(phrase.join(" "));
      phrase = [word];
    } else {
      phrase = candidate;
    }
    if (/[.!?][”’"')\]]*$/.test(word) && phrase.length > 1) {
      chunks.push(phrase.join(" "));
      phrase = [];
    } else if (/[.!?][”’"')\]]*$/.test(word) && phrase.length === 1 && chunks.length > 0) {
      const previous = chunks.at(-1)!.split(/\s+/);
      if (previous.length > 2) {
        phrase.unshift(previous.pop()!);
        chunks[chunks.length - 1] = previous.join(" ");
      }
      chunks.push(phrase.join(" "));
      phrase = [];
    }
  }
  if (phrase.length > 0) chunks.push(phrase.join(" "));
  return chunks;
}

/** Agrupa chunks en `target` bloques equilibrados sin perder texto. */
function mergeChunksEvenly(chunks: string[], target: number): string[] {
  if (chunks.length <= target) return chunks;
  const result: string[] = [];
  const base = Math.floor(chunks.length / target);
  const extra = chunks.length % target;
  let index = 0;
  for (let group = 0; group < target; group += 1) {
    const size = base + (group < extra ? 1 : 0);
    result.push(chunks.slice(index, index + size).join(" "));
    index += size;
  }
  return result;
}

function distributeFrames(chunks: string[], durationFrames: number): number[] {
  const extraFrames = durationFrames - chunks.length;
  const weights = chunks.map((chunk) => Math.max(1, chunk.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const extras = weights.map((weight) => Math.floor((extraFrames * weight) / totalWeight));
  const unallocated = extraFrames - extras.reduce((sum, frames) => sum + frames, 0);
  const remainders = weights
    .map((weight, index) => ({ index, fraction: (extraFrames * weight) % totalWeight }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; index < unallocated; index += 1) {
    const target = remainders[index];
    if (target) extras[target.index] = (extras[target.index] ?? 0) + 1;
  }
  return extras.map((frames) => frames + 1);
}

function getClipTransform(project: Project, clipId: string): MediaClip["transform"] | undefined {
  const found = getClipById(project, clipId);
  if (!found || found.clip.type === "text") return undefined;
  return found.clip.transform;
}

function getClipCrop(project: Project, clipId: string): MediaClip["crop"] | undefined {
  const found = getClipById(project, clipId);
  if (!found || found.clip.type === "text") return undefined;
  return found.clip.crop;
}

function cutTimelineInterval(
  project: Project,
  startSeconds: number,
  endSeconds: number,
  ripple: boolean,
): { project: Project; removedClips: number; cutFrames: number } {
  const fps = project.settings.fps.num / Math.max(1, project.settings.fps.den);
  const cutStart = Math.max(0, Math.round(startSeconds * fps));
  const cutEnd = Math.round(endSeconds * fps);
  const cutFrames = cutEnd - cutStart;
  if (cutFrames <= 0) {
    throw new HttpError(422, "El rango temporal de corte debe tener endSeconds > startSeconds.", "invalid_cut_range");
  }

  let current = project;
  let removedClips = 0;
  const primaryVideoId = firstVideoTrack(project)?.id;

  const editableTracks = current.tracks.filter(
    (track) =>
      !track.locked &&
      (track.kind === "video" || track.kind === "audio" || track.kind === "text") &&
      !/motion|overlay|atm[óo]sfera|sfx/i.test(track.name),
  );

  for (const trackSnapshot of editableTracks) {
    const refreshedBeforeStart = current.tracks.find((t) => t.id === trackSnapshot.id);
    if (!refreshedBeforeStart) continue;
    for (const clip of refreshedBeforeStart.clips) {
      if (clip.startFrame < cutStart && clipEnd(clip) > cutStart) {
        const splitRes = splitClipAt(current, clip.id, cutStart);
        if (splitRes.ok) current = splitRes.project;
      }
    }

    const refreshedBeforeEnd = current.tracks.find((t) => t.id === trackSnapshot.id);
    if (!refreshedBeforeEnd) continue;
    for (const clip of refreshedBeforeEnd.clips) {
      if (clip.startFrame < cutEnd && clipEnd(clip) > cutEnd) {
        const splitRes = splitClipAt(current, clip.id, cutEnd);
        if (splitRes.ok) current = splitRes.project;
      }
    }

    const refreshedRemove = current.tracks.find((t) => t.id === trackSnapshot.id);
    if (!refreshedRemove) continue;
    const toRemove = refreshedRemove.clips
      .filter((clip) => clip.startFrame >= cutStart && clipEnd(clip) <= cutEnd)
      .map((clip) => clip.id);

    if (trackSnapshot.id === primaryVideoId && toRemove.length > 0 && toRemove.length >= refreshedRemove.clips.length) {
      throw new HttpError(422, "El corte eliminaría todo el video principal.", "cut_removes_all_media");
    }

    if (toRemove.length > 0) {
      const remRes = removeClips(current, toRemove);
      if (remRes.ok) {
        current = remRes.project;
        removedClips += toRemove.length;
      }
    }

    if (ripple) {
      current = rippleShiftAfter(current, trackSnapshot.id, cutEnd, -cutFrames);
    }
  }

  return { project: current, removedClips, cutFrames };
}

function withGeneratedSubtitles(
  project: Project,
  asset: MediaAsset,
  segments: Array<{ startUs: number; endUs: number; text: string }>,
  maxChars: number,
  styleId?: string,
): Project {
  let current = project;
  current = {
    ...current,
    tracks: current.tracks.map((track) => ({
      ...track,
      clips: track.clips.filter(
        (clip) => !(clip.type === "text" && clip.createdBy === "agent" && clip.sourceMediaId === asset.id),
      ),
    })),
  };
  const trackSetup = ensureTextTrack(current);
  current = trackSetup.project;
  const trackId = trackSetup.trackId;
  const fps = current.settings.fps;
  const frameUs = frameDurationUs(fps);
  let added = 0;
  // Whisper repite el mismo trozo en segmentos consecutivos cuando hay música o
  // ruido de fondo; sin este filtro el texto aparecía duplicado en pantalla
  // (también al cruzar el corte entre dos clips del resumen).
  let lastCue: { text: string; endFrame: number } | null = null;
  const normalizeCue = (value: string) =>
    value
      .toLocaleLowerCase("es")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();

  for (const segment of segments) {
    if (segment.endUs - segment.startUs < 150_000) continue;
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const chunks = chunkSubtitleText(text, maxChars);
    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
    const segmentDurationUs = segment.endUs - segment.startUs;
    // Reparte el tiempo del segmento entre los trozos y fusiona los que durarían
    // menos de 0,35 s (un fogonazo ilegible) con el trozo anterior.
    const cues: Array<{ text: string; startUs: number; endUs: number }> = [];
    let offsetUs = 0;
    for (const chunk of chunks) {
      const chunkDuration = Math.max(
        100_000,
        Math.round((segmentDurationUs * chunk.length) / totalChars),
      );
      const chunkStart = segment.startUs + offsetUs;
      const chunkEnd = Math.min(segment.endUs, chunkStart + chunkDuration);
      offsetUs += chunkDuration;
      const previous = cues.at(-1);
      if (previous && chunkEnd - chunkStart < 350_000) {
        previous.text = `${previous.text} ${chunk}`.replace(/\s+/g, " ").trim();
        previous.endUs = chunkEnd;
        continue;
      }
      cues.push({ text: chunk, startUs: chunkStart, endUs: chunkEnd });
    }

    for (const cueText of cues) {
      if (cueText.endUs - cueText.startUs < 150_000) continue;
      const chunk = cueText.text;
      const targetTracks = current.tracks.filter((t) => t.kind === "video");
      const eligibleTracks = targetTracks.length > 0 ? targetTracks : current.tracks.filter((t) => t.kind === "audio");
      for (const track of eligibleTracks) {
        for (const clip of track.clips) {
          if (clip.type === "text" || clip.mediaId !== asset.id) continue;
          const overlapStart = Math.max(clip.sourceInUs, cueText.startUs);
          const overlapEnd = Math.min(clip.sourceOutUs, cueText.endUs);
          if (overlapEnd - overlapStart < 300_000) continue;
          const startFrame =
            clip.startFrame + Math.max(0, Math.round((overlapStart - clip.sourceInUs) / (frameUs * clip.speed)));
          const durationFrames = Math.max(
            1,
            Math.round((overlapEnd - overlapStart) / (frameUs * clip.speed)),
          );
          const normalized = normalizeCue(chunk);
          if (
            lastCue &&
            normalized &&
            lastCue.text === normalized &&
            Math.abs(startFrame - lastCue.endFrame) <= 5
          ) {
            continue;
          }
          const cue = makeTextClip({
            text: chunk,
            startFrame,
            durationFrames,
            role: "subtitle",
            createdBy: "agent",
            sourceMediaId: asset.id,
            fadeFrames: 2,
            styleId,
          });
          // En vertical el pie de foto sube: el 15% inferior queda tapado por la
          // interfaz de TikTok/Reels. Los tamaños ya se escalan al renderizar.
          const placed =
            current.settings.height > current.settings.width
              ? { ...cue, position: { x: 0.5, y: 0.78 } }
              : cue;
          const result = addClip(current, trackId, placed);
          if (result.ok) {
            current = result.project;
            added += 1;
            lastCue = { text: normalized, endFrame: startFrame + durationFrames };
            if (added >= 800) {
              throw new HttpError(422, "La transcripción supera el límite de 800 subtítulos.", "too_many_subtitles");
            }
          }
        }
      }
    }
  }
  if (added === 0) {
    throw new HttpError(
      422,
      "La transcripción no produjo subtítulos dentro de los clips del recurso en la línea de tiempo.",
      "subtitles_empty",
    );
  }
  return touchProject(current);
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "inspect_media",
    description: "Lee metadatos reales del archivo (FFprobe) o de activos virtuales Remotion generados en el proyecto.",
    argsHint: '{ "mediaId"?: string }',
    risk: "low",
    argsSchema: z.object({ mediaId: z.string().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ mediaId: z.string().optional() }).parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);

      // Activo virtual generado para clips Remotion live sin archivo binario previo en disco
      if (asset.origin === "generated" && asset.file.startsWith("generated/")) {
        const linkedClips = context.project.tracks
          .flatMap((track) => track.clips)
          .filter((clip): clip is MediaClip => clip.type !== "text" && clip.mediaId === asset.id);
        const visibleTexts = linkedClips.flatMap((c) => extractRemotionClipVisibleTexts(c));
        return {
          status: "verified",
          summary: `${asset.name} (activo Remotion virtual): ${asset.width ?? context.project.settings.width}x${asset.height ?? context.project.settings.height}, ${(asset.durationUs / 1_000_000).toFixed(2)} s, ${linkedClips.length} clip(s) vinculados.`,
          data: {
            mediaId: asset.id,
            kind: asset.kind,
            virtual: true,
            durationUs: asset.durationUs,
            width: asset.width ?? context.project.settings.width,
            height: asset.height ?? context.project.settings.height,
            fps: asset.fps ?? context.project.settings.fps,
            videoCodec: asset.videoCodec ?? "remotion-live",
            audioCodec: asset.audioCodec ?? null,
            visibleTexts,
          },
        };
      }

      const file = await requireMediaFile(context.projectId, asset);
      const probe = await probeMedia(file, context.signal);
      const lowRes = detectLowResolutionSources(context.project).filter((w) => w.mediaId === asset.id);
      const warnings = lowRes.map((w) => w.message);
      return {
        status: "verified",
        warnings,
        summary: `${asset.name}: ${probe.kind}, ${probe.width ?? "-"}x${probe.height ?? "-"}, ${
          probe.fps ? (probe.fps.num / probe.fps.den).toFixed(2) : "-"
        } fps, ${(probe.durationUs / 1_000_000).toFixed(2)} s${probe.audioCodec ? `, audio ${probe.audioCodec}` : ", sin audio"}.`,
        data: {
          mediaId: asset.id,
          kind: probe.kind,
          durationUs: probe.durationUs,
          width: probe.width,
          height: probe.height,
          fps: probe.fps,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          sampleRate: probe.sampleRate,
          channels: probe.channels,
          sizeBytes: probe.sizeBytes,
          warnings,
        },
      };
    },
  },
  {
    name: "analyze_audio",
    description: "Analiza la energía del audio por ventanas y la sonoridad integrada (EBU R128).",
    argsHint: '{ "mediaId"?: string }',
    risk: "low",
    argsSchema: z.object({ mediaId: z.string().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ mediaId: z.string().optional() }).parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      if (!asset.audioCodec) throw new HttpError(422, "El recurso no tiene audio.", "no_audio");
      context.setProgress(0.1, "Analizando audio");
      const envelope = await analyzeAudioEnvelope(context.projectId, asset, 0.5, context.signal);
      context.setProgress(0.7, "Midiendo sonoridad");
      const loudness = await measureLoudness(context.projectId, asset, context.signal);
      return {
        summary: `Audio de "${asset.name}": pico ${envelope.peakDb.toFixed(1)} dBFS, media ${envelope.meanDb.toFixed(
          1,
        )} dB, silencio ${Math.round(envelope.silenceRatio * 100)}%${
          loudness.integratedLufs !== null ? `, sonoridad ${loudness.integratedLufs.toFixed(1)} LUFS` : ""
        }.`,
        data: {
          windows: envelope.windows.length,
          peakDb: envelope.peakDb,
          meanDb: envelope.meanDb,
          silenceRatio: envelope.silenceRatio,
          ...loudness,
        },
      };
    },
  },
  {
    name: "transcribe_audio",
    description: "Transcribe el audio con el proveedor de IA configurado. No inventa texto si no hay servicio.",
    argsHint: '{ "mediaId"?: string, "language"?: string }',
    risk: "medium",
    argsSchema: z.object({ mediaId: z.string().optional(), language: z.string().min(2).max(8).optional() }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({ mediaId: z.string().optional(), language: z.string().min(2).max(8).optional() })
        .parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      context.setProgress(0.05, "Extrayendo audio para transcripción");
      const result = await transcribeMedia(context.projectId, asset, args.language, context.signal, (progress, message) =>
        context.setProgress(0.05 + progress * 0.9, message),
      );
      return {
        summary: `Transcripción completada: ${result.segments.length} segmentos${
          result.language ? `, idioma ${result.language}` : ""
        }.`,
        data: {
          language: result.language,
          model: result.model,
          segments: result.segments.slice(0, 40),
          totalSegments: result.segments.length,
        },
      };
    },
  },
  {
    name: "detect_silences",
    description: "Detecta silencios con silencedetect de FFmpeg usando umbral y duración mínima reales.",
    argsHint: '{ "mediaId"?: string, "thresholdDb"?: number, "minSilenceSec"?: number }',
    risk: "low",
    argsSchema: z.object({
      mediaId: z.string().optional(),
      thresholdDb: z.number().min(-80).max(-5).optional(),
      minSilenceSec: z.number().min(0.1).max(30).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          mediaId: z.string().optional(),
          thresholdDb: z.number().min(-80).max(-5).optional(),
          minSilenceSec: z.number().min(0.1).max(30).optional(),
        })
        .parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      if (!asset.audioCodec) throw new HttpError(422, "El recurso no tiene audio.", "no_audio");
      const result = await detectSilences(
        context.projectId,
        asset,
        { thresholdDb: args.thresholdDb ?? -38, minSilenceSec: args.minSilenceSec ?? 0.85 },
        context.signal,
        (progress) => context.setProgress(progress, "Detectando silencios"),
      );
      const total = result.intervals.reduce((sum, interval) => sum + interval.durationUs, 0);
      return {
        summary:
          result.intervals.length > 0
            ? `${result.intervals.length} silencios detectados (${(total / 1_000_000).toFixed(2)} s).`
            : "No se detectaron silencios con esos umbrales.",
        data: { intervals: result.intervals },
      };
    },
  },
  {
    name: "detect_scenes",
    description: "Detecta cambios de escena reales con el filtro scene de FFmpeg.",
    argsHint: '{ "mediaId"?: string, "threshold"?: number }',
    risk: "low",
    argsSchema: z.object({
      mediaId: z.string().optional(),
      threshold: z.number().min(0.05).max(0.9).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({ mediaId: z.string().optional(), threshold: z.number().min(0.05).max(0.9).optional() })
        .parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      const scenes = await detectScenes(
        context.projectId,
        asset,
        { threshold: args.threshold ?? 0.3 },
        context.signal,
        (progress) => context.setProgress(progress, "Detectando escenas"),
      );
      return {
        summary: `${scenes.length} cambios de escena detectados.`,
        data: { times: scenes },
      };
    },
  },
  {
    name: "analyze_video",
    description: "Analiza metadatos y presencia de audio de un video sin procesar el archivo completo.",
    argsHint: '{ "mediaId"?: string }',
    risk: "low",
    argsSchema: z.object({ mediaId: z.string().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ mediaId: z.string().optional() }).parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      const file = await requireMediaFile(context.projectId, asset);
      const probe = await probeMedia(file, context.signal);
      const usage = context.project.tracks.flatMap((track) =>
        track.clips.filter((clip) => clip.type !== "text" && clip.mediaId === asset.id),
      ).length;
      return {
        summary: `"${asset.name}" analizado: ${probe.width ?? 0}x${probe.height ?? 0}, ${(
          probe.durationUs / 1_000_000
        ).toFixed(2)} s, ${usage} clips en la línea de tiempo.`,
        data: {
          width: probe.width,
          height: probe.height,
          fps: probe.fps,
          durationUs: probe.durationUs,
          hasAudio: Boolean(probe.audioCodec),
          rotation: probe.rotation,
          usage,
        },
      };
    },
  },
  {
    name: "find_highlights",
    description: "Selecciona momentos destacados por energía de audio en ventanas de 0,5 s.",
    argsHint: '{ "mediaId"?: string, "targetSeconds"?: number }',
    risk: "low",
    argsSchema: z.object({
      mediaId: z.string().optional(),
      targetSeconds: z.number().min(3).max(600).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({ mediaId: z.string().optional(), targetSeconds: z.number().min(3).max(600).optional() })
        .parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      if (!asset.audioCodec) throw new HttpError(422, "La selección de momentos requiere audio.", "no_audio");
      const result = await findHighlights(
        context.projectId,
        asset,
        args.targetSeconds ?? 30,
        context.signal,
        (progress, message) => context.setProgress(progress, message),
      );
      return {
        summary: `Seleccionados ${(result.totalUs / 1_000_000).toFixed(1)} s en ${result.ranges.length} intervalos (${result.method}).`,
        data: { ranges: result.ranges, method: result.method },
      };
    },
  },
  {
    name: "create_edit_plan",
    description: "Valida una lista de operaciones contra las herramientas disponibles sin ejecutarlas.",
    argsHint: '{ "operations": [{ "tool": string, "args": object }] }',
    risk: "low",
    argsSchema: z.object({
      operations: z
        .array(z.object({ tool: z.string().min(1).max(64), args: z.record(z.unknown()).default({}) }))
        .min(1)
        .max(20),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          operations: z
            .array(z.object({ tool: z.string().min(1).max(64), args: z.record(z.unknown()).default({}) }))
            .min(1)
            .max(20),
        })
        .parse(rawArgs);
      const validated = args.operations.map((operation) => {
        if (operation.tool === "create_edit_plan") {
          throw new HttpError(422, "create_edit_plan no puede anidarse.", "invalid_plan");
        }
        const definition = getTool(operation.tool);
        const parsed = definition.argsSchema.safeParse(operation.args);
        if (!parsed.success) {
          throw new HttpError(422, `Argumentos invalidos para ${operation.tool}.`, "invalid_args", parsed.error.issues);
        }
        return { tool: operation.tool, args: parsed.data };
      });
      void context;
      return {
        summary: `Plan interno validado con ${validated.length} operaciones.`,
        data: { operations: validated },
      };
    },
  },
  {
    name: "move_clip",
    description: "Mueve un clip a una pista y fotograma de inicio, validando solapamientos.",
    argsHint: '{ "clipId": string, "trackId": string, "startFrame": number }',
    risk: "medium",
    argsSchema: z.object({
      clipId: z.string(),
      trackId: z.string(),
      startFrame: z.number().int().min(0),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({ clipId: z.string(), trackId: z.string(), startFrame: z.number().int().min(0) })
        .parse(rawArgs);
      const result = moveClip(context.project, args.clipId, args.trackId, args.startFrame);
      if (!result.ok) throw new HttpError(422, result.error, "move_failed");
      return { summary: `Clip movido a la pista ${args.trackId} en el fotograma ${args.startFrame}.`, project: result.project };
    },
  },
  {
    name: "remove_clip",
    description: "Elimina un clip; opcionalmente cierra el hueco en su pista.",
    argsHint: '{ "clipId": string, "ripple"?: boolean }',
    risk: "medium",
    argsSchema: z.object({ clipId: z.string(), ripple: z.boolean().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ clipId: z.string(), ripple: z.boolean().optional() }).parse(rawArgs);
      const found = getClipById(context.project, args.clipId);
      if (!found) throw new HttpError(404, "El clip no existe.", "clip_not_found");
      const end = clipEnd(found.clip);
      const duration = found.clip.durationFrames;
      const removed = removeClips(context.project, [args.clipId]);
      if (!removed.ok) throw new HttpError(422, removed.error, "remove_failed");
      const project = args.ripple
        ? rippleShiftAfter(removed.project, found.track.id, end, -duration)
        : removed.project;
      return { summary: `Clip eliminado${args.ripple ? " y hueco cerrado" : ""}.`, project };
    },
  },
  {
    name: "set_clip_speed",
    description: "Cambia la velocidad de un clip entre 0,25x y 4x.",
    argsHint: '{ "clipId": string, "speed": number }',
    risk: "medium",
    argsSchema: z.object({ clipId: z.string(), speed: z.number().min(0.25).max(4) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ clipId: z.string(), speed: z.number().min(0.25).max(4) }).parse(rawArgs);
      const result = setClipSpeed(context.project, args.clipId, args.speed);
      if (!result.ok) throw new HttpError(422, result.error, "speed_failed");
      return { summary: `Velocidad ajustada a ${args.speed}x.`, project: result.project };
    },
  },
  {
    name: "adjust_audio",
    description: "Ajusta volumen, fundidos y mejora de voz de un clip.",
    argsHint: '{ "clipId": string, "volume"?: number, "fadeInFrames"?: number, "fadeOutFrames"?: number, "enhanceVoice"?: boolean }',
    risk: "low",
    argsSchema: z.object({
      clipId: z.string(),
      volume: z.number().min(0).max(2).optional(),
      fadeInFrames: z.number().int().min(0).max(100000).optional(),
      fadeOutFrames: z.number().int().min(0).max(100000).optional(),
      enhanceVoice: z.boolean().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          volume: z.number().min(0).max(2).optional(),
          fadeInFrames: z.number().int().min(0).max(100000).optional(),
          fadeOutFrames: z.number().int().min(0).max(100000).optional(),
          enhanceVoice: z.boolean().optional(),
        })
        .parse(rawArgs);
      const result = updateClip(context.project, args.clipId, (clip) => {
        if (clip.type === "text") throw new HttpError(422, "El clip es de texto.", "clip_type_invalid");
        return {
          ...clip,
          volume: args.volume ?? clip.volume,
          fadeInFrames: Math.min(args.fadeInFrames ?? clip.fadeInFrames, Math.floor(clip.durationFrames / 2)),
          fadeOutFrames: Math.min(args.fadeOutFrames ?? clip.fadeOutFrames, Math.floor(clip.durationFrames / 2)),
          audioEnhance: args.enhanceVoice === undefined ? clip.audioEnhance : args.enhanceVoice ? "voice" : "none",
        };
      });
      if (!result.ok) throw new HttpError(422, result.error, "audio_failed");
      return { summary: "Ajustes de audio aplicados.", project: result.project };
    },
  },
  {
    name: "split_subtitles_into_phrases",
    description:
      "Divide los subtítulos existentes en frases cortas de hasta cuatro palabras, conservando el texto completo y el tiempo total de cada cue.",
    argsHint: '{ "mediaId"?: string }',
    risk: "low",
    argsSchema: z.object({ mediaId: z.string().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ mediaId: z.string().optional() }).parse(rawArgs);
      if (args.mediaId && !getMediaById(context.project, args.mediaId)) {
        throw new HttpError(404, "El recurso seleccionado ya no existe en el proyecto.", "media_not_found");
      }

      let changed = 0;
      const tracks = context.project.tracks.map((track) => {
        if (track.kind !== "text") return track;
        const clips = track.clips.flatMap((clip) => {
          if (
            clip.type !== "text" ||
            (clip.role !== "subtitle" && clip.role !== "caption") ||
            (args.mediaId && clip.sourceMediaId !== args.mediaId)
          ) {
            return [clip];
          }

          const maxWords = 4;
          let chunks = chunkSubtitleText(clip.text, 2000, maxWords);
          const fpsValue = context.project.settings.fps.num / context.project.settings.fps.den;
          // Ningún cue debe durar menos de ~0,55 s: es ilegible y suele indicar
          // que el texto se partió demasiadas veces. Se fusionan chunks si hace falta.
          const minFrames = Math.max(2, Math.round(fpsValue * 0.55));
          const maxChunks = Math.max(1, Math.floor(clip.durationFrames / minFrames));
          chunks = mergeChunksEvenly(chunks, maxChunks);
          if (chunks.length <= 1) return [clip];

          const durations = distributeFrames(chunks, clip.durationFrames);
          let startFrame = clip.startFrame;
          changed += 1;
          return chunks.map((text, index) => {
            const durationFrames = durations[index] ?? 1;
            const nextClip = {
              ...clip,
              id: index === 0 ? clip.id : newId("txt"),
              name: `${clip.name} · ${index + 1}`,
              text,
              startFrame,
              durationFrames,
            };
            startFrame += durationFrames;
            return nextClip;
          });
        });
        if (clips.length > 3000) {
          throw new HttpError(422, "La división superaría el límite de clips de la pista.", "too_many_subtitles");
        }
        return { ...track, clips };
      });

      if (changed === 0) {
        throw new HttpError(404, "No hay subtítulos largos para dividir en frases cortas.", "no_long_subtitles");
      }
      return {
        summary: `Se dividieron ${changed} subtítulos en frases de hasta cuatro palabras, conservando el contenido y la duración.`,
        project: touchProject({ ...context.project, tracks }),
        data: { changed },
      };
    },
  },
  {
    name: "remove_subtitles",
    description:
      "Elimina los subtítulos y leyendas existentes de la línea de tiempo (todos o solo los de un recurso). Conserva los títulos y otros textos salvo que se pida incluirlos.",
    argsHint: '{ "mediaId"?: string, "includeTitles"?: boolean }',
    risk: "medium",
    argsSchema: z.object({
      mediaId: z.string().optional(),
      includeTitles: z.boolean().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({ mediaId: z.string().optional(), includeTitles: z.boolean().optional() })
        .parse(rawArgs);
      if (args.mediaId && !getMediaById(context.project, args.mediaId)) {
        throw new HttpError(404, "El recurso indicado no existe en el proyecto.", "media_not_found");
      }
      let removed = 0;
      const tracks = context.project.tracks.map((track) => {
        if (track.kind !== "text") return track;
        const clips = track.clips.filter((clip) => {
          if (clip.type !== "text") return true;
          if (args.mediaId && clip.sourceMediaId !== args.mediaId) return true;
          const isSubtitle = clip.role === "subtitle" || clip.role === "caption";
          if (!isSubtitle && !args.includeTitles) return true;
          removed += 1;
          return false;
        });
        return clips.length === track.clips.length ? track : { ...track, clips };
      });
      if (removed === 0) {
        throw new HttpError(
          404,
          args.mediaId
            ? "No hay subtítulos de ese recurso en la línea de tiempo."
            : "No hay subtítulos en la línea de tiempo.",
          "no_subtitles",
        );
      }
      return {
        summary: `${removed} subtítulo${removed === 1 ? "" : "s"} eliminado${removed === 1 ? "" : "s"} de la línea de tiempo.`,
        project: touchProject({ ...context.project, tracks }),
        data: { removed, mediaId: args.mediaId ?? null, includeTitles: Boolean(args.includeTitles) },
      };
    },
  },
  {
    name: "generate_subtitles",
    description:
      "Transcribe el audio y crea subtítulos sincronizados en una pista de texto. Estilos: clean (limpio), impact (impacto), card (tarjeta), viral, neon (neón), cinema (cine), editorial, highlight (resaltado), minimal, modern (Space Grotesk), real-estate (inmobiliario), phrase-highlight (frase resaltada) y clean-pop (moderno pop).",
    argsHint:
      '{ "mediaId"?: string, "language"?: string, "maxChars"?: number, "style"?: "clean"|"impact"|"card"|"viral"|"neon"|"cinema"|"editorial"|"highlight"|"minimal"|"modern"|"real-estate"|"phrase-highlight"|"clean-pop" }',
    risk: "medium",
    argsSchema: z.object({
      mediaId: z.string().optional(),
      language: z.string().min(2).max(8).optional(),
      maxChars: z.number().int().min(20).max(120).optional(),
      style: z.enum(SUBTITLE_STYLE_IDS).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          mediaId: z.string().optional(),
          language: z.string().min(2).max(8).optional(),
          maxChars: z.number().int().min(20).max(120).optional(),
          style: z.enum(SUBTITLE_STYLE_IDS).optional(),
        })
        .parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      requireTimelineClipForMedia(context.project, asset);
      context.setProgress(0.05, "Transcribiendo para subtítulos");
      const transcript = await transcribeMedia(
        context.projectId,
        asset,
        args.language,
        context.signal,
        (progress, message) => context.setProgress(0.05 + progress * 0.8, message),
      );
      const style = args.style ?? "clean";
      let remotionStyleId: "minimal" | "tiktok" | "hormozi" | "cinematic" | "neon" | "impact" = "minimal";
      if (style === "impact") remotionStyleId = "impact";
      else if (style === "viral") remotionStyleId = "tiktok";
      else if (style === "cinema") remotionStyleId = "cinematic";
      else if (style === "neon") remotionStyleId = "neon";
      else if (style === "clean-pop" || style === "highlight" || style === "phrase-highlight") remotionStyleId = "hormozi";

      try {
        const { buildSubtitles } = await import("../motion-agent/subtitles.js");
        type CaptionCueType = import("../motion-agent/subtitles.js").CaptionCue;
        const { buildSubtitleComponentCode } = await import("../../src/shared/motionTemplates.js");

        const builtSubs = await buildSubtitles({
          projectId: context.projectId,
          project: context.project,
          currentFrame: 0,
          signal: context.signal,
          style: remotionStyleId,
          cachedSegments: transcript.segments,
        });

        const trackSetup = ensureTextTrack(context.project);
        let project = trackSetup.project;
        const trackId = trackSetup.trackId;

        // Limpiar subtítulos previos en la pista para evitar solapamientos o duplicados
        project = {
          ...project,
          tracks: project.tracks.map((t) =>
            t.id === trackId
              ? {
                  ...t,
                  clips: t.clips.filter(
                    (c) =>
                      !(
                        c.type === "text" &&
                        (c.role === "subtitle" ||
                          c.sourceMediaId === asset.id ||
                          Boolean(c.remotion && /subtitles/i.test(c.remotion.componentName)))
                      ),
                  ),
                }
              : t,
          ),
        };

        const captions = (builtSubs.props?.captions ?? []) as CaptionCueType[];
        const componentName = `Remotion${remotionStyleId.charAt(0).toUpperCase()}${remotionStyleId.slice(1)}Subtitles`;
        const subGenerated = buildSubtitleComponentCode(remotionStyleId, componentName);

        const previewText = captions
          .filter((c) => !c.suppressed)
          .slice(0, 4)
          .map((c) => c.words.map((w: { text: string }) => w.text).join(" "))
          .join(" ")
          .slice(0, 80);

        const newSubClip = makeTextClip({
          name: `Subtítulos IA (${remotionStyleId})`,
          text: previewText || "Subtítulos sincronizados",
          startFrame: builtSubs.startFrame,
          durationFrames: builtSubs.durationInFrames,
          role: "subtitle",
          createdBy: "agent",
          sourceMediaId: asset.id,
          fontSize: 58,
          fontWeight: 700,
          color: "#FFFFFF",
          background: false,
          backgroundOpacity: 0,
          remotion: {
            compositionId: `subs_${remotionStyleId}`,
            componentName: subGenerated.componentName || componentName,
            code: subGenerated.code || builtSubs.code,
            props: { captions } as Record<string, unknown>,
            styleId: remotionStyleId,
            live: true,
          },
        });

        const addRes = addClip(project, trackId, newSubClip);
        if (addRes.ok) {
          project = touchProject(addRes.project);
          return {
            summary: `${builtSubs.cueCount} frases (${builtSubs.wordCount} palabras) sincronizadas al fotograma con estilo ${remotionStyleId}.`,
            project,
            data: {
              cues: builtSubs.cueCount,
              words: builtSubs.wordCount,
              language: transcript.language,
              model: transcript.model,
              style: remotionStyleId,
            },
          };
        }
      } catch (remotionErr) {
        console.warn("[Tools] Fallback a subtítulos nativos:", remotionErr);
      }

      const project = withGeneratedSubtitles(
        context.project,
        asset,
        transcript.segments,
        args.maxChars ?? 58,
        style,
      );
      const cues = project.tracks
        .filter((track) => track.kind === "text")
        .flatMap((track) => track.clips)
        .filter((clip) => clip.type === "text" && clip.sourceMediaId === asset.id).length;
      return {
        summary: `${cues} subtítulos generados${transcript.language ? ` en ${transcript.language}` : ""} con estilo ${style}.`,
        project,
        data: { cues, language: transcript.language, model: transcript.model, style },
      };
    },
  },
  {
    name: "add_text_overlay",
    description: "Añade un texto o título sobre el montaje con posición y duración reales.",
    argsHint: '{ "text": string, "role"?: "title"|"caption", "startSeconds"?: number, "durationSeconds"?: number, "position"?: "center"|"top"|"bottom"|"lower-third" }',
    risk: "low",
    argsSchema: z.object({
      text: z.string().min(1).max(500),
      role: z.enum(["title", "caption"]).optional(),
      startSeconds: z.number().min(0).max(36000).optional(),
      durationSeconds: z.number().min(0.5).max(120).optional(),
      position: z.enum(["center", "top", "bottom", "lower-third"]).optional(),
      fontSize: z.number().min(12).max(200).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          text: z.string().min(1).max(500),
          role: z.enum(["title", "caption"]).optional(),
          startSeconds: z.number().min(0).max(36000).optional(),
          durationSeconds: z.number().min(0.5).max(120).optional(),
          position: z.enum(["center", "top", "bottom", "lower-third"]).optional(),
          fontSize: z.number().min(12).max(200).optional(),
        })
        .parse(rawArgs);
      const setup = ensureTextTrack(context.project);
      const fps = setup.project.settings.fps;
      const durationFrames = Math.max(1, Math.round(((args.durationSeconds ?? 3.5) * fps.num) / fps.den));
      // Un overlay fuera del montaje (por ejemplo un CTA "al final" con los
      // segundos del video original) terminaria invisible: se ancla al final real.
      const timelineFrames = timelineDurationFrames(setup.project);
      const requestedFrame = Math.round(((args.startSeconds ?? 0) * fps.num) / fps.den);
      const startFrame = Math.max(
        0,
        Math.min(requestedFrame, Math.max(0, timelineFrames - durationFrames)),
      );
      const position =
        args.position === "top"
          ? { x: 0.5, y: 0.14 }
          : args.position === "bottom"
            ? { x: 0.5, y: 0.86 }
            : args.position === "lower-third"
              ? { x: 0.16, y: 0.78 }
              : { x: 0.5, y: 0.5 };
      const result = addTextClip(setup.project, setup.trackId, {
        text: args.text,
        startFrame,
        durationFrames,
        role: args.role ?? "title",
        position,
        fontSize: args.fontSize ?? (args.role === "caption" ? 48 : 72),
        createdBy: "agent",
      });
      if (!result.ok) throw new HttpError(422, result.error, "text_failed");
      return { summary: `Texto añadido: "${args.text.slice(0, 60)}".`, project: result.project };
    },
  },
  {
    name: "create_motion_graphic",
    description:
      "Crea un título o rótulo animado editable (lower third, título cinético, callout, gancho social, gráfico de barras, contador, progreso, tarjeta de título o acento de forma). Los gráficos de datos admiten valores editables.",
    argsHint:
      '{ "text": string, "preset": "lower-third"|"kinetic-title"|"callout"|"social-hook"|"stat-bars"|"stat-counter"|"stat-progress"|"title-card"|"shape-accent", "startSeconds"?: number, "durationSeconds"?: number, "mediaId"?: string, "data"?: [{"label": string, "value": number}], "value"?: number, "unit"?: string, "color"?: "#RRGGBB" }',
    risk: "low",
    argsSchema: z.object({
      text: z.string().min(1).max(180),
      preset: z.enum([
        "lower-third",
        "kinetic-title",
        "callout",
        "social-hook",
        "stat-bars",
        "stat-counter",
        "stat-progress",
        "title-card",
        "shape-accent",
      ]),
      startSeconds: z.number().min(0).max(36000).optional(),
      durationSeconds: z.number().min(0.8).max(30).optional(),
      mediaId: z.string().optional(),
      data: z
        .array(
          z.object({
            label: z.string().min(1).max(60),
            value: z.number(),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          }),
        )
        .min(1)
        .max(8)
        .optional(),
      value: z.number().optional(),
      unit: z.string().max(12).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      trackColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z.object({
        text: z.string().min(1).max(180),
        preset: z.enum([
          "lower-third",
          "kinetic-title",
          "callout",
          "social-hook",
          "stat-bars",
          "stat-counter",
          "stat-progress",
          "title-card",
          "shape-accent",
        ]),
        startSeconds: z.number().min(0).max(36000).optional(),
        durationSeconds: z.number().min(0.8).max(30).optional(),
        mediaId: z.string().optional(),
        data: z
          .array(
            z.object({
              label: z.string().min(1).max(60),
              value: z.number(),
              color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            }),
          )
          .min(1)
          .max(8)
          .optional(),
        value: z.number().optional(),
        unit: z.string().max(12).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        trackColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      }).parse(rawArgs);
      if (args.mediaId && !getMediaById(context.project, args.mediaId)) {
        throw new HttpError(404, "El recurso seleccionado ya no existe en el proyecto.", "media_not_found");
      }

      const textPresets = {
        "lower-third": {
          fontFamily: "inter" as const,
          fontSize: 44,
          fontWeight: 700 as const,
          color: "#FFFFFF",
          background: true,
          backgroundColor: "#14251D",
          backgroundOpacity: 0.92,
          backgroundPadding: 20,
          position: { x: 0.18, y: 0.78 },
          maxWidth: 0.72,
          animationIn: "slide-left" as const,
          animationOut: "fade-out" as const,
        },
        "kinetic-title": {
          fontFamily: "space-grotesk" as const,
          fontSize: 78,
          fontWeight: 700 as const,
          color: "#FFFFFF",
          background: false,
          strokeWidth: 3,
          strokeColor: "#101813",
          position: { x: 0.5, y: 0.5 },
          maxWidth: 0.88,
          animationIn: "zoom-in" as const,
          animationOut: "fade-out" as const,
        },
        callout: {
          fontFamily: "grandstander" as const,
          fontSize: 48,
          fontWeight: 700 as const,
          color: "#111827",
          background: true,
          backgroundColor: "#E8FF6A",
          backgroundOpacity: 1,
          backgroundPadding: 20,
          position: { x: 0.72, y: 0.28 },
          maxWidth: 0.56,
          animationIn: "bounce-in" as const,
          animationOut: "zoom-out" as const,
        },
        "social-hook": {
          fontFamily: "anton" as const,
          fontSize: 78,
          fontWeight: 400 as const,
          color: "#FFD44A",
          background: false,
          strokeWidth: 4,
          strokeColor: "#101813",
          position: { x: 0.5, y: 0.28 },
          maxWidth: 0.9,
          textTransform: "upper" as const,
          animationIn: "bounce-in" as const,
          animationOut: "fade-out" as const,
        },
        "stat-bars": {
          fontFamily: "space-grotesk" as const,
          fontSize: 44,
          fontWeight: 700 as const,
          color: "#FFFFFF",
          background: false,
          position: { x: 0.5, y: 0.52 },
          maxWidth: 0.86,
          animationIn: "fade-in" as const,
          animationOut: "fade-out" as const,
        },
        "stat-counter": {
          fontFamily: "space-grotesk" as const,
          fontSize: 44,
          fontWeight: 700 as const,
          color: "#FFFFFF",
          background: false,
          position: { x: 0.5, y: 0.52 },
          maxWidth: 0.7,
          animationIn: "fade-in" as const,
          animationOut: "fade-out" as const,
        },
        "stat-progress": {
          fontFamily: "space-grotesk" as const,
          fontSize: 44,
          fontWeight: 700 as const,
          color: "#FFFFFF",
          background: false,
          position: { x: 0.5, y: 0.52 },
          maxWidth: 0.7,
          animationIn: "fade-in" as const,
          animationOut: "fade-out" as const,
        },
        "title-card": {
          fontFamily: "space-grotesk" as const,
          fontSize: 82,
          fontWeight: 700 as const,
          color: "#FFFFFF",
          background: false,
          strokeWidth: 2,
          strokeColor: "#101813",
          position: { x: 0.5, y: 0.5 },
          maxWidth: 0.86,
          animationIn: "zoom-in" as const,
          animationOut: "fade-out" as const,
        },
        "shape-accent": {
          fontFamily: "space-grotesk" as const,
          fontSize: 66,
          fontWeight: 700 as const,
          color: "#FFFFFF",
          background: false,
          position: { x: 0.5, y: 0.5 },
          maxWidth: 0.82,
          animationIn: "fade-in" as const,
          animationOut: "fade-out" as const,
        },
      };
      // DEBUG: Log args before creating graphic
      const dataPreset = args.preset === "stat-bars" || args.preset === "stat-counter" || args.preset === "stat-progress";
      const decorativePreset = args.preset === "title-card" || args.preset === "shape-accent";
      const defaultBars = [
        { label: "Enero", value: 42 },
        { label: "Febrero", value: 58 },
        { label: "Marzo", value: 74 },
        { label: "Abril", value: 91 },
      ];
      const graphic = dataPreset
        ? {
            kind: args.preset === "stat-bars" ? ("bars" as const) : args.preset === "stat-counter" ? ("counter" as const) : ("progress" as const),
            title: args.text,
            unit: args.unit ?? (args.preset === "stat-bars" ? "" : "%"),
            value: args.value ?? 72,
            decimals: 0,
            items: args.data ?? (args.preset === "stat-bars" ? defaultBars : undefined),
            color: args.color ?? "#FFD44A",
            trackColor: args.trackColor ?? "#FFFFFF",
            background: true,
            backgroundOpacity: 0.92,
            position: { x: 0.5, y: args.preset === "stat-bars" ? 0.6 : 0.56 },
            width: args.preset === "stat-bars" ? 0.84 : 0.64,
            height: args.preset === "stat-bars" ? 0.38 : 0.3,
            shape: "square" as const,
            animation: "grow" as const,
          }
        : decorativePreset
          ? {
              kind: (args.preset === "title-card" ? "title-card" : "accent") as "title-card" | "accent",
              title: args.text,
              unit: undefined,
              value: undefined,
              decimals: 0,
              items: undefined,
              color: args.color ?? "#FFD44A",
              trackColor: args.trackColor ?? "#FFFFFF",
              background: args.preset === "title-card",
              backgroundOpacity: 0.16,
              position: { x: 0.5, y: 0.5 },
              width: args.preset === "title-card" ? 0.88 : 0.62,
              height: args.preset === "title-card" ? 0.46 : 0.62,
              shape: (args.preset === "title-card" ? "square" : "circle") as "square" | "circle",
              animation: "grow" as const,
            }
          : undefined;
      const preset = textPresets[args.preset];
      const setup = ensureTextTrack(context.project);
      const fps = setup.project.settings.fps.num / setup.project.settings.fps.den;
      const durationFrames = Math.max(1, Math.round((args.durationSeconds ?? (dataPreset ? 5 : 3.5)) * fps));
      // Si el momento pedido cae fuera del montaje (p. ej. un CTA "al final" con
      // segundos del video original) se ancla al final real de la linea de tiempo.
      const timelineFrames = timelineDurationFrames(setup.project);
      const requestedFrame = Math.round((args.startSeconds ?? 0) * fps);
      const startFrame = Math.max(
        0,
        Math.min(requestedFrame, Math.max(0, timelineFrames - durationFrames)),
      );
      const transitionFrames = Math.max(1, Math.round(fps * 0.35));
      const result = addTextClip(setup.project, setup.trackId, {
        text: args.text,
        startFrame,
        durationFrames,
        role: "title",
        createdBy: "agent",
        sourceMediaId: args.mediaId,
        ...preset,
        ...(graphic ? { graphic } : {}),
        animationInDuration: transitionFrames,
        animationOutDuration: transitionFrames,
        shadow: 8,
      });
      if (!result.ok) throw new HttpError(422, result.error, "motion_graphic_failed");
      const label = {
        "lower-third": "Lower third",
        "kinetic-title": "Título cinético",
        callout: "Callout",
        "social-hook": "Gancho social",
        "stat-bars": "Gráfico de barras",
        "stat-counter": "Contador animado",
        "stat-progress": "Barra de progreso",
        "title-card": "Tarjeta de título",
        "shape-accent": "Acento de forma",
      }[args.preset];
      return {
        summary: `${label} añadido en ${(startFrame / fps).toFixed(1)}s: "${args.text}".`,
        project: result.project,
        data: {
          preset: args.preset,
          startSeconds: startFrame / fps,
          durationSeconds: args.durationSeconds ?? (dataPreset ? 5 : 3.5),
          graphic: graphic?.kind ?? null,
        },
      };
    },
  },
  {
    name: "apply_dynamic_subtitle_preset",
    description:
      "Aplica un preset de subtítulos dinámicos a las frases existentes: texto grande estilo real estate, resaltado por frase o lectura limpia. Conserva sincronización y no inventa palabras.",
    argsHint:
      '{ "preset": "real-estate"|"phrase-highlight"|"clean-pop", "color"?: "#RRGGBB", "mediaId"?: string }',
    risk: "low",
    argsSchema: z.object({
      preset: z.enum(["real-estate", "phrase-highlight", "clean-pop"]),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      mediaId: z.string().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z.object({
        preset: z.enum(["real-estate", "phrase-highlight", "clean-pop"]),
        color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
        mediaId: z.string().optional(),
      }).parse(rawArgs);
      if (args.mediaId && !getMediaById(context.project, args.mediaId)) {
        throw new HttpError(404, "El recurso seleccionado ya no existe en el proyecto.", "media_not_found");
      }

      const presets = {
        "real-estate": {
          style: "real-estate",
          animationIn: "bounce-in" as const,
          animationOut: "fade-out" as const,
          animationInDuration: 9,
          animationOutDuration: 6,
        },
        "phrase-highlight": {
          style: "phrase-highlight",
          animationIn: "zoom-in" as const,
          animationOut: "fade-out" as const,
          animationInDuration: 7,
          animationOutDuration: 5,
        },
        "clean-pop": {
          style: "clean-pop",
          animationIn: "zoom-in" as const,
          animationOut: "fade-out" as const,
          animationInDuration: 8,
          animationOutDuration: 5,
        },
      } as const;
      const preset = presets[args.preset];
      let changed = 0;
      let contrastFixed = 0;
      const project = touchProject({
        ...context.project,
        tracks: context.project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => {
            if (
              track.kind !== "text" ||
              clip.type !== "text" ||
              (clip.role !== "subtitle" && clip.role !== "caption") ||
              (args.mediaId && clip.sourceMediaId !== args.mediaId)
            ) {
              return clip;
            }
            changed += 1;
            const styled = withSubtitleStyle(clip, preset.style);
            const candidate = {
              ...styled,
              ...(args.color ? { color: args.color.toUpperCase() } : {}),
              animationIn: preset.animationIn,
              animationInDuration: preset.animationInDuration,
              animationOut: preset.animationOut,
              animationOutDuration: preset.animationOutDuration,
            };
            const safe = ensureReadableText(candidate);
            if (safe.adjusted) contrastFixed += 1;
            // En vertical, la zona inferior queda tapada por TikTok/Reels. Si el
            // clip venía en el pie clásico (0,86) se sube a la zona segura; un
            // encuadre manual más arriba se respeta.
            const vertical = context.project.settings.height > context.project.settings.width;
            const placed =
              vertical && safe.clip.position.y > 0.8
                ? { ...safe.clip, position: { ...safe.clip.position, y: 0.78 } }
                : safe.clip;
            return placed;
          }),
        })),
      });
      if (changed === 0) {
        throw new HttpError(404, "No hay subtítulos que coincidan en la línea de tiempo.", "no_subtitles");
      }
      const label = args.preset === "real-estate" ? "Real Estate" : args.preset === "phrase-highlight" ? "Resaltado" : "Moderno Pop";
      return {
        summary: `Preset dinámico ${label} aplicado a ${changed} subtítulo${changed === 1 ? "" : "s"}. Las frases y sus tiempos se conservaron; el resaltado se aplica por frase, no palabra individual.${
          contrastFixed > 0 ? ` Se corrigió el color de ${contrastFixed} subtítulo${contrastFixed === 1 ? "" : "s"} para garantizar contraste.` : ""
        }`,
        project,
        data: { preset: args.preset, changed, mediaId: args.mediaId ?? null, contrastFixed },
      };
    },
  },
  {
    name: "change_aspect_ratio",
    description: "Cambia la relación de aspecto y la resolución del proyecto.",
    argsHint: '{ "aspect": "16:9"|"9:16"|"1:1"|"4:5"|"21:9" }',
    risk: "medium",
    argsSchema: z.object({ aspect: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ aspect: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]) }).parse(rawArgs);
      const aspect = args.aspect as AspectRatio;
      const preset = ASPECT_PRESETS[aspect];
      // Resolucion de entrega social: 1080 px en el lado corto (1920x1080,
      // 1080x1920, 1080x1080, 1080x1350). Antes se reutilizaba el lado largo del
      // proyecto y un 16:9 de 1080 acababa exportando 608x1080.
      const dimensions = dimensionsFor(aspect, 1080);
      const width = dimensions.width;
      const height = dimensions.height;
      const targetAspect = width / height;

      // Reencuadre real: se recorta el material para que llene el lienzo en vez
      // de quedar con bandas negras. Se respeta el recorte manual previo.
      let reframed = 0;
      const tracks = context.project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.type === "text") return clip;
          const asset = getMediaById(context.project, clip.mediaId);
          if (!asset || !asset.width || !asset.height) return clip;
          const rotated = Boolean(asset.rotation && Math.abs(asset.rotation % 180) === 90);
          const sourceWidth = rotated ? asset.height! : asset.width;
          const sourceHeight = rotated ? asset.width : asset.height!;
          const baseWidth = 1 - clip.crop.left - clip.crop.right;
          const baseHeight = 1 - clip.crop.top - clip.crop.bottom;
          if (baseWidth <= 0.02 || baseHeight <= 0.02) return clip;
          const currentAspect = (sourceWidth / sourceHeight) * (baseWidth / baseHeight);
          if (Math.abs(currentAspect - targetAspect) < 0.002) {
            return { ...clip, transform: { ...clip.transform, x: 0, y: 0 } };
          }
          const next = { ...clip.crop };
          if (currentAspect > targetAspect) {
            const keep = targetAspect / currentAspect;
            const cut = ((1 - keep) / 2) * baseWidth;
            next.left = Math.min(0.48, clip.crop.left + cut);
            next.right = Math.min(0.48, clip.crop.right + cut);
          } else {
            const keep = currentAspect / targetAspect;
            const cut = ((1 - keep) / 2) * baseHeight;
            next.top = Math.min(0.48, clip.crop.top + cut);
            next.bottom = Math.min(0.48, clip.crop.bottom + cut);
          }
          reframed += 1;
          return {
            ...clip,
            crop: next,
            transform: { ...clip.transform, x: 0, y: 0 },
          };
        }),
      }));
      const project = touchProject({
        ...context.project,
        settings: { ...context.project.settings, aspect, width, height },
        tracks,
      });
      const lowResWarnings = detectLowResolutionSources(project).map((w) => w.message);
      return {
        status: "verified",
        warnings: lowResWarnings,
        summary: `Formato cambiado a ${preset.label} (${width}x${height})${
          reframed > 0 ? ` con reencuadre de ${reframed} clip${reframed === 1 ? "" : "s"} para llenar el lienzo` : ""
        }${lowResWarnings.length > 0 ? `. AVISO: ${lowResWarnings[0]}` : "."}`,
        project,
        data: { aspect, width, height, reframed, warnings: lowResWarnings },
      };
    },
  },
  {
    name: "apply_color_adjustment",
    description: "Aplica brillo, contraste y saturación a uno o todos los clips visuales.",
    argsHint: '{ "clipId"?: string, "brightness"?: number, "contrast"?: number, "saturation"?: number }',
    risk: "low",
    argsSchema: z.object({
      clipId: z.string().optional(),
      brightness: z.number().min(0.2).max(2).optional(),
      contrast: z.number().min(0.2).max(2).optional(),
      saturation: z.number().min(0).max(2).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string().optional(),
          brightness: z.number().min(0.2).max(2).optional(),
          contrast: z.number().min(0.2).max(2).optional(),
          saturation: z.number().min(0).max(2).optional(),
        })
        .parse(rawArgs);
      const targets = context.project.tracks
        .flatMap((track) => track.clips)
        .filter(
          (clip): clip is MediaClip =>
            (clip.type === "video" || clip.type === "image") && (!args.clipId || clip.id === args.clipId),
        );
      if (targets.length === 0) throw new HttpError(404, "No hay clips visuales que ajustar.", "no_visual_clips");
      let project = context.project;
      for (const clip of targets) {
        const result = updateClip(project, clip.id, (current) =>
          current.type === "text"
            ? current
            : {
                ...current,
                adjustments: {
                  brightness: args.brightness ?? current.adjustments.brightness,
                  contrast: args.contrast ?? current.adjustments.contrast,
                  saturation: args.saturation ?? current.adjustments.saturation,
                },
              },
        );
        if (!result.ok) throw new HttpError(422, result.error, "color_failed");
        project = result.project;
      }
      return { summary: `Ajuste de color aplicado a ${targets.length} clips.`, project };
    },
  },
  {
    name: "generate_proxy",
    description: "Genera un proxy H.264 720p para previsualización fluida. El export usa el original.",
    argsHint: '{ "mediaId": string }',
    risk: "medium",
    argsSchema: z.object({ mediaId: z.string() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ mediaId: z.string() }).parse(rawArgs);
      const asset = getMediaById(context.project, args.mediaId);
      if (!asset) throw new HttpError(404, "El recurso no existe.", "media_not_found");
      const file = await generateProxy(context.projectId, asset, context.signal, (progress) =>
        context.setProgress(progress, "Generando proxy"),
      );
      return { summary: `Proxy generado para "${asset.name}".`, data: { proxyFile: file } };
    },
  },
  {
    name: "preview_edit",
    description:
      "Audita la estructura, renderiza fotogramas de muestra reales y ejecuta el QA automático (duración, textos visibles, contraste, audio, subtítulos y advertencias de baja resolución).",
    argsHint: '{ "renderSamples"?: boolean }',
    risk: "low",
    argsSchema: z.object({ renderSamples: z.boolean().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ renderSamples: z.boolean().optional() }).parse(rawArgs);
      const parsed = projectSchema.safeParse(context.project);
      if (!parsed.success) {
        throw new HttpError(422, "El montaje tiene errores de validación.", "invalid_project", parsed.error.issues);
      }

      const qa = await buildTimelineQaReport(context.projectId, context.project);
      const shouldRender = args.renderSamples !== false && timelineDurationFrames(context.project) > 0;
      const rendered = shouldRender
        ? await renderTimelineFrames(context.projectId, context.project, {
            every: Math.max(1, Number((qa.durationSeconds / 3).toFixed(2))),
            scale: 0.35,
            signal: context.signal,
          })
        : null;

      const missingWarnings: string[] = [];
      for (const asset of context.project.media) {
        if (asset.missing && !(asset.origin === "generated" && asset.file.startsWith("generated/"))) {
          missingWarnings.push(`Falta el archivo "${asset.name}".`);
        }
      }
      const allWarnings = [...new Set([...missingWarnings, ...qa.warnings])];
      const finalStatus = !qa.passed
        ? "failed"
        : shouldRender && rendered && rendered.frames.length > 0 && qa.criticalFailures.length === 0
          ? allWarnings.length > 0
            ? "fallback"
            : "verified"
          : "unverified";

      return {
        status: finalStatus,
        warnings: allWarnings,
        verification: {
          checks: qa.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
          evidence: rendered ? rendered.frames.map((f) => f.path) : [],
        },
        summary: `QA ${qa.score}/100: ${qa.durationSeconds}s (${qa.durationFrames} fotogramas), ${context.project.tracks.reduce(
          (sum, track) => sum + track.clips.length,
          0,
        )} clips, ${rendered ? rendered.frames.length : 0} fotogramas verificados${allWarnings.length > 0 ? `, ${allWarnings.length} advertencia(s)` : ""}.`,
        data: {
          warnings: allWarnings,
          durationFrames: qa.durationFrames,
          durationSeconds: qa.durationSeconds,
          qaReport: qa,
          frames: rendered?.frames ?? [],
          summary: projectSummary(context.project),
        },
      };
    },
  },
  {
    name: "render_export",
    description:
      "Inicia una exportación real MP4 H.264/AAC en segundo plano y devuelve su identificador. Con engine \"remotion\" la capa de gráficos se renderiza con Remotion (springs y easing reales) y se compone sobre el video base.",
    argsHint:
      '{ "resolution"?: 720|1080|2160, "aspect"?: string, "quality"?: "draft"|"standard"|"high", "fps"?: 24|25|30|50|60, "engine"?: "ffmpeg"|"remotion" }',
    risk: "high",
    argsSchema: z.object({
      resolution: z.union([z.literal(720), z.literal(1080), z.literal(2160)]).optional(),
      aspect: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]).optional(),
      quality: z.enum(["draft", "standard", "high"]).optional(),
      fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
      engine: z.enum(["ffmpeg", "remotion"]).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          resolution: z.union([z.literal(720), z.literal(1080), z.literal(2160)]).optional(),
          aspect: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]).optional(),
          quality: z.enum(["draft", "standard", "high"]).optional(),
          fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
          engine: z.enum(["ffmpeg", "remotion"]).optional(),
        })
        .parse(rawArgs);
      const baseName = `${context.project.name.replace(/[^\w\- ]+/g, "").trim() || "oeclip"}-${
        args.aspect ?? context.project.settings.aspect
      }`;
      const settings = exportSettingsSchema.parse({
        resolution: args.resolution ?? 1080,
        aspect: args.aspect ?? context.project.settings.aspect,
        fps: args.fps ?? (Math.round(context.project.settings.fps.num / context.project.settings.fps.den) as 30),
        quality: args.quality ?? "standard",
        encoder: "auto",
        engine: args.engine ?? "ffmpeg",
        fileName: `${baseName}.mp4`,
      });
      const { record, job } = await startExport(context.projectId, settings);
      return {
        summary: `Exportación iniciada: ${record.settings.fileName} (${settings.resolution}p, ${settings.aspect}${
          settings.engine === "remotion" ? ", gráficos con Remotion" : ""
        }).`,
        data: { exportId: record.id, jobId: job.id, fileName: record.settings.fileName },
      };
    },
  },
  {
    name: "verify_export",
    description: "Verifica con FFprobe una exportación terminada y actualiza su registro.",
    argsHint: '{ "exportId"?: string }',
    risk: "low",
    argsSchema: z.object({ exportId: z.string().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ exportId: z.string().optional() }).parse(rawArgs);
      const bundle = await projectStore.get(context.projectId);
      const target =
        (args.exportId ? bundle.exports.find((item) => item.id === args.exportId) : bundle.exports.at(-1)) ?? null;
      if (!target) throw new HttpError(404, "No hay exportaciones que verificar.", "export_not_found");
      context.setProgress(0.3, "Verificando archivo con FFprobe");
      const { verification } = await verifyExport(context.projectId, target.id);
      if (!verification.valid) {
        throw new HttpError(422, `La verificación falló: ${verification.message}`, "export_invalid");
      }
      return {
        status: "verified",
        verification: {
          checks: [
            {
              name: "ffprobe_export_valid",
              passed: true,
              detail: `${verification.width}x${verification.height}, ${(verification.durationUs / 1_000_000).toFixed(2)} s`,
            },
          ],
          evidence: target.outputFile ? [target.outputFile] : [],
        },
        summary: `Verificado: ${verification.width}x${verification.height}, ${(verification.durationUs / 1_000_000).toFixed(
          2,
        )} s, ${verification.videoCodec}${verification.audioCodec ? `/${verification.audioCodec}` : ""}.`,
        data: verification,
      };
    },
  },
  {
    name: "remove_silences",
    description: "Detecta silencios y reconstruye el clip con los intervalos de voz, aplicando ripple.",
    argsHint: '{ "clipId"?: string, "mediaId"?: string, "thresholdDb"?: number, "minSilenceSec"?: number, "paddingSec"?: number }',
    risk: "high",
    argsSchema: z.object({
      clipId: z.string().optional(),
      mediaId: z.string().optional(),
      thresholdDb: z.number().min(-80).max(-5).optional(),
      minSilenceSec: z.number().min(0.1).max(10).optional(),
      paddingSec: z.number().min(0).max(1).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string().optional(),
          mediaId: z.string().optional(),
          thresholdDb: z.number().min(-80).max(-5).optional(),
          minSilenceSec: z.number().min(0.1).max(10).optional(),
          paddingSec: z.number().min(0).max(1).optional(),
        })
        .parse(rawArgs);
      let clip: MediaClip;
      let trackId: string;
      if (args.clipId) {
        const found = requireClip(context.project, args.clipId);
        clip = found.clip;
        trackId = found.trackId;
      } else {
        const asset = requireAsset(context.project, args.mediaId);
        const found = requireTimelineClipForMedia(context.project, asset);
        clip = found.clip;
        trackId = found.trackId;
      }
      void trackId;
      const asset = getMediaById(context.project, clip.mediaId);
      if (!asset) throw new HttpError(404, "El recurso del clip no existe.", "media_not_found");
      if (!asset.audioCodec) throw new HttpError(422, "El clip no tiene audio.", "no_audio");
      const analysis = await detectSilences(
        context.projectId,
        asset,
        { thresholdDb: args.thresholdDb ?? -38, minSilenceSec: args.minSilenceSec ?? 0.85 },
        context.signal,
        (progress) => context.setProgress(progress * 0.7, "Detectando silencios"),
      );
      const ranges = keepRangesFromSilences(
        clip.sourceInUs,
        clip.sourceOutUs,
        analysis.intervals,
        args.paddingSec ?? 0.22,
      );
      context.setProgress(0.8, "Reconstruyendo el clip");
      const result = applySourceRanges(context.project, clip.id, ranges);
      if (!result.ok) throw new HttpError(422, result.error, "silence_removal_failed");
      const removedFrames = clip.durationFrames - result.project.tracks
        .flatMap((track) => track.clips)
        .filter((item) => item.id.startsWith(`${clip.id}_seg`))
        .reduce((sum, item) => sum + item.durationFrames, 0);
      const removedSeconds = Math.max(0, framesToSeconds(removedFrames, context.project.settings.fps));
      const percent = clip.durationFrames > 0 ? Math.round((removedFrames / clip.durationFrames) * 100) : 0;
      return {
        summary: `Silencios eliminados: ${analysis.intervals.length} pausas, ${removedSeconds.toFixed(
          2,
        )} s recortados (${percent}% del clip).`,
        project: result.project,
        data: {
          intervals: analysis.intervals.length,
          keptRanges: ranges.length,
          removedFrames,
          removedSeconds: Number(removedSeconds.toFixed(2)),
        },
      };
    },
  },
  {
    name: "fit_duration",
    description: "Recorta el final del montaje para ajustarlo a una duración objetivo.",
    argsHint: '{ "targetSeconds": number }',
    risk: "high",
    argsSchema: z.object({ targetSeconds: z.number().min(1).max(3600) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ targetSeconds: z.number().min(1).max(3600) }).parse(rawArgs);
      const before = timelineDurationFrames(context.project);
      const project = trimProjectToSeconds(context.project, args.targetSeconds);
      const after = timelineDurationFrames(project);
      if (after === before) {
        return { summary: `El montaje ya dura ${(framesToSeconds(before, project.settings.fps)).toFixed(1)} s; no se recorto.`, project };
      }
      return {
        summary: `Duración ajustada de ${framesToSeconds(before, project.settings.fps).toFixed(
          1,
        )} s a ${framesToSeconds(after, project.settings.fps).toFixed(1)} s (recorte determinista del final).`,
        project,
      };
    },
  },
  {
    name: "enhance_voice",
    description: "Activa la cadena de mejora de voz (highpass, reducción de ruido y compresor) en clips con audio.",
    argsHint: '{ "clipId"?: string }',
    risk: "low",
    argsSchema: z.object({ clipId: z.string().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ clipId: z.string().optional() }).parse(rawArgs);
      const targets = context.project.tracks
        .flatMap((track) => track.clips)
        .filter(
          (clip): clip is MediaClip =>
            clip.type !== "text" &&
            (!args.clipId || clip.id === args.clipId) &&
            Boolean(getMediaById(context.project, clip.mediaId)?.audioCodec),
        );
      if (targets.length === 0) throw new HttpError(404, "No hay clips con audio.", "no_audio_clips");
      let project = context.project;
      for (const clip of targets) {
        const result = updateClip(project, clip.id, (current) =>
          current.type === "text" ? current : { ...current, audioEnhance: "voice" },
        );
        if (!result.ok) throw new HttpError(422, result.error, "voice_failed");
        project = result.project;
      }
      return { summary: `Mejora de voz activada en ${targets.length} clips.`, project };
    },
  },
  {
    name: "add_media_to_timeline",
    description: "Coloca un recurso ya importado en una pista de la linea de tiempo, con posicion y duracion opcionales.",
    argsHint:
      '{ "mediaId": "med_...", "trackId"?: "trk_...", "startSeconds"?: 0, "durationSeconds"?: 10 }',
    risk: "medium",
    argsSchema: z.object({
      mediaId: z.string().min(3),
      trackId: z.string().min(3).optional(),
      startSeconds: z.number().min(0).max(21_600).optional(),
      durationSeconds: z.number().min(0.2).max(21_600).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          mediaId: z.string().min(3),
          trackId: z.string().min(3).optional(),
          startSeconds: z.number().min(0).max(21_600).optional(),
          durationSeconds: z.number().min(0.2).max(21_600).optional(),
        })
        .parse(rawArgs);
      const asset = getMediaById(context.project, args.mediaId);
      if (!asset) throw new HttpError(404, "El recurso indicado no existe.", "media_not_found");
      const kind: "video" | "audio" = asset.kind === "audio" ? "audio" : "video";
      let project = context.project;
      let track = args.trackId
        ? project.tracks.find((item) => item.id === args.trackId)
        : project.tracks.find((item) => item.kind === kind);
      if (args.trackId && !track) throw new HttpError(404, "La pista indicada no existe.", "track_not_found");
      if (track && track.kind !== kind) {
        throw new HttpError(422, `La pista "${track.name}" no admite recursos de tipo ${kind}.`, "track_kind_mismatch");
      }
      if (!track) {
        const created = addTrack(project, kind, kind === "audio" ? "Audio" : "Video");
        if (!created.ok || !created.track) {
          throw new HttpError(500, "No se pudo crear una pista para el recurso.", "track_failed");
        }
        project = created.project;
        track = created.track;
      }
      const fps = project.settings.fps;
      const fpsValue = fps.num / fps.den;
      const availableUs = asset.durationUs > 0 ? asset.durationUs : 5_000_000;
      const durationUs = Math.max(
        200_000,
        Math.min(availableUs, Math.round((args.durationSeconds ?? availableUs / 1_000_000) * 1_000_000)),
      );
      const trackEnd = track.clips.reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0);
      const startFrame =
        args.startSeconds !== undefined ? Math.max(0, Math.round(args.startSeconds * fpsValue)) : trackEnd;
      const clip = makeMediaClip(project, asset, {
        startFrame,
        sourceInUs: 0,
        sourceOutUs: durationUs,
        createdBy: "agent",
      });
      const result = addClip(project, track.id, clip);
      if (!result.ok) throw new HttpError(422, result.error, "clip_overlap");
      const nextProject = touchProject(result.project);
      const lowResWarnings = detectLowResolutionSources(nextProject)
        .filter((w) => w.mediaId === asset.id)
        .map((w) => w.message);
      return {
        status: "verified",
        warnings: lowResWarnings,
        summary: `"${asset.name}" colocado en ${track.name} desde ${framesToSeconds(clip.startFrame, fps).toFixed(2)} s durante ${(
          durationUs / 1_000_000
        ).toFixed(2)} s${lowResWarnings.length > 0 ? ` (AVISO baja resolución: ${asset.width}x${asset.height} en ${nextProject.settings.width}x${nextProject.settings.height})` : ""}.`,
        project: nextProject,
        data: {
          clipId: clip.id,
          trackId: track.id,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          warnings: lowResWarnings,
        },
      };
    },
  },
  {
    name: "select_highlights",
    description: "Selecciona momentos por energía de audio y reconstruye la pista de video con ellos.",
    argsHint: '{ "mediaId"?: string, "targetSeconds"?: number }',
    risk: "high",
    argsSchema: z.object({
      mediaId: z.string().optional(),
      targetSeconds: z.number().min(3).max(600).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({ mediaId: z.string().optional(), targetSeconds: z.number().min(3).max(600).optional() })
        .parse(rawArgs);
      const asset = requireAsset(context.project, args.mediaId);
      if (asset.kind !== "video") throw new HttpError(422, "Selecciona un recurso de video.", "not_video");
      const reference = requireTimelineClipForMedia(context.project, asset);
      const targetSeconds = args.targetSeconds ?? 30;
      const highlights = await findHighlights(
        context.projectId,
        asset,
        targetSeconds,
        context.signal,
        (progress, message) => context.setProgress(progress * 0.8, message),
      );
      const usableRanges = highlights.ranges.filter(
        (range) => range.endUs - range.startUs >= 5_000 && range.startUs < asset.durationUs,
      );
      if (usableRanges.length === 0) {
        throw new HttpError(422, "No hay fragmentos utiles para montar el resumen.", "highlights_empty");
      }
      context.setProgress(0.85, "Montando la selección");
      const videoTrack = firstVideoTrack(context.project);
      if (!videoTrack) throw new HttpError(422, "No hay pista de video.", "no_video_track");
      const fps = context.project.settings.fps;
      const frameUs = frameDurationUs(fps);
      const referenceStartFrame = reference.clip.startFrame;
      const referenceInUs = reference.clip.sourceInUs;
      const referenceSpeed = reference.clip.speed;

      // Cada fragmento conserva su duración real y se coloca a continuación del
      // anterior. Además se guarda el tramo antiguo equivalente para poder mover
      // los subtítulos y el audio con el mismo criterio (si no, el texto diría
      // una cosa mientras la imagen muestra otra).
      const mapping: Array<{ oldStart: number; oldEnd: number; newStart: number }> = [];
      const rebuilt: MediaClip[] = [];
      let cursor = 0;
      for (const [index, range] of usableRanges.entries()) {
        const durationFrames = Math.max(
          1,
          Math.round((range.endUs - range.startUs) / (frameUs * referenceSpeed)),
        );
        const oldStart = referenceStartFrame + Math.round((range.startUs - referenceInUs) / (frameUs * referenceSpeed));
        const base = makeMediaClip(context.project, asset, {
          startFrame: cursor,
          sourceInUs: range.startUs,
          sourceOutUs: range.endUs,
          createdBy: "agent",
        });
        // Los keyframes del clip original suelen apuntar a fotogramas que ya no
        // existen en el fragmento (zoom fantasma). Si no encajan, se descartan.
        const referenceTransform = reference.clip.transform;
        const staleKeyframes = (referenceTransform.keyframes ?? []).some(
          (keyframe) => keyframe.frame > durationFrames,
        );
        rebuilt.push({
          ...base,
          // El primer fragmento conserva el ID del clip de referencia para que
          // los pasos que apuntan a ese clip (zoom, silencios, encuadre) sigan
          // encontrándolo después del reensamblado en vez de fallar con 404.
          id: index === 0 ? reference.clip.id : newId("clp"),
          durationFrames,
          name: `${asset.name} · destacado`,
          transform: staleKeyframes ? { ...referenceTransform, keyframes: [] } : referenceTransform,
          crop: reference.clip.crop,
          adjustments: reference.clip.adjustments,
          audioEnhance: reference.clip.audioEnhance,
          opacity: reference.clip.opacity,
          volume: reference.clip.volume,
        });
        mapping.push({ oldStart, oldEnd: oldStart + durationFrames, newStart: cursor });
        cursor += durationFrames;
      }

      // Reubica el resto de pistas (subtítulos, audio, rótulos) sobre el nuevo
      // montaje para que sigan sincronizados con lo que se ve y se oye.
      let remappedClips = 0;
      const tracks = context.project.tracks.map((track) => {
        if (track.id === videoTrack.id) {
          return { ...track, clips: sortClips(rebuilt) };
        }
        const moved: typeof track.clips = [];
        for (const clip of track.clips) {
          const clipEndFrame = clip.startFrame + clip.durationFrames;
          let piece = 0;
          for (const segment of mapping) {
            const from = Math.max(clip.startFrame, segment.oldStart);
            const to = Math.min(clipEndFrame, segment.oldEnd);
            if (to <= from) continue;
            const startFrame = segment.newStart + (from - segment.oldStart);
            const durationFrames = to - from;
            if (durationFrames <= 0) continue;
            piece += 1;
            remappedClips += 1;
            if (clip.type === "text") {
              moved.push({
                ...clip,
                id: newId("txt"),
                startFrame,
                durationFrames,
                fadeFrames: Math.min(clip.fadeFrames, durationFrames),
              });
              continue;
            }
            const sourceInUs = Math.max(
              0,
              clip.sourceInUs + Math.round((from - clip.startFrame) * frameUs * clip.speed),
            );
            const sourceOutUs = Math.max(
              sourceInUs + 1,
              Math.min(
                clip.sourceOutUs,
                sourceInUs + Math.round(durationFrames * frameUs * clip.speed),
              ),
            );
            moved.push({
              ...clip,
              id: `${clip.id}_hl${piece}`,
              startFrame,
              durationFrames,
              sourceInUs,
              sourceOutUs,
            });
          }
        }
        return { ...track, clips: sortClips(moved) };
      });
      const summaryProject = touchProject({ ...context.project, tracks });
      const totalFrames = timelineDurationFrames(summaryProject);
      return {
        summary: `Resumen creado con ${usableRanges.length} fragmentos (${framesToSeconds(
          cursor,
          fps,
        ).toFixed(1)} s). Se reemplazo el contenido de ${videoTrack.name}, se reubicaron ${remappedClips} clips de texto/audio para mantener la sincronizacion y se recorto el resto.`,
        project: summaryProject,
        data: { ranges: usableRanges, targetSeconds, totalFrames, remappedClips },
      };
    },
  },
  {
    name: "change_subtitle_style",
    description:
      "Cambia el estilo tipográfico de todos los subtítulos de un recurso (o de todos los subtítulos de la línea de tiempo si no se indica medio). Permite elegir un estilo predefinido y ajustar el tamaño y el color del texto.",
    argsHint:
      '{ "mediaId"?: string, "style"?: "clean"|"impact"|"card"|"viral"|"neon"|"cinema"|"editorial"|"highlight"|"minimal"|"modern"|"real-estate"|"phrase-highlight"|"clean-pop", "fontSize"?: number, "color"?: "#RRGGBB" }',
    risk: "low",
    argsSchema: z.object({
      mediaId: z.string().optional(),
      style: z.enum(SUBTITLE_STYLE_IDS).optional(),
      fontSize: z.number().min(8).max(400).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    }).refine((args) => args.style !== undefined || args.fontSize !== undefined || args.color !== undefined),
    execute: async (context, rawArgs) => {
      const args = z.object({
        mediaId: z.string().optional(),
        style: z.enum(SUBTITLE_STYLE_IDS).optional(),
        fontSize: z.number().min(8).max(400).optional(),
        color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      }).refine((value) => value.style !== undefined || value.fontSize !== undefined || value.color !== undefined).parse(rawArgs);
      const targets: Array<{ trackId: string; clipId: string }> = [];
      for (const track of context.project.tracks) {
        if (track.kind !== "text") continue;
        for (const clip of track.clips) {
          if (clip.type !== "text" || (clip.role !== "subtitle" && clip.role !== "caption")) continue;
          if (args.mediaId && clip.sourceMediaId !== args.mediaId) continue;
          targets.push({ trackId: track.id, clipId: clip.id });
        }
      }
      if (targets.length === 0) {
        throw new HttpError(
          404,
          args.mediaId ? "No hay subtítulos para este recurso." : "No hay subtítulos en la línea de tiempo.",
          "no_subtitles",
        );
      }
      let project = context.project;
      let changed = 0;
      let contrastFixed = 0;
      for (const { clipId } of targets) {
        const result = updateClip(project, clipId, (current) => {
          if (current.type !== "text") return current;
          const styled = args.style ? withSubtitleStyle(current, args.style) : current;
          const candidate = {
            ...styled,
            ...(args.fontSize !== undefined ? { fontSize: args.fontSize } : {}),
            ...(args.color ? { color: args.color.toUpperCase() } : {}),
          };
          const safe = ensureReadableText(candidate);
          if (safe.adjusted) contrastFixed += 1;
          const vertical = context.project.settings.height > context.project.settings.width;
          if (vertical && safe.clip.position.y > 0.8) {
            return { ...safe.clip, position: { ...safe.clip.position, y: 0.78 } };
          }
          return safe.clip;
        });
        if (!result.ok) throw new HttpError(422, result.error, "subtitle_style_failed");
        project = result.project;
        changed += 1;
      }
      const changes = [
        args.style ? `estilo "${args.style}"` : null,
        args.fontSize !== undefined ? `tamaño ${args.fontSize}` : null,
        args.color ? `color ${args.color.toUpperCase()}` : null,
      ].filter((value): value is string => value !== null);
      return {
        summary: `${changes.join(", ")} aplicado${changes.length === 1 ? "" : "s"} a ${changed} subtítulo${changed === 1 ? "" : "s"}.${
          contrastFixed > 0 ? ` Se ajustó el color de ${contrastFixed} para que se lea sobre el fondo.` : ""
        }`,
        project,
        data: { style: args.style ?? null, fontSize: args.fontSize ?? null, color: args.color?.toUpperCase() ?? null, changed, mediaId: args.mediaId ?? null, contrastFixed },
      };
    },
  },
  {
    name: "apply_social_preset",
    description:
      "Aplica un paquete visual para video corto: formato vertical, estilo de subtítulos y animación de entrada/salida. Agrega textos de gancho o CTA solo si el usuario proporciona sus frases exactas.",
    argsHint:
      '{ "preset": "creator"|"impact"|"clean", "hookText"?: string, "ctaText"?: string }',
    risk: "low",
    argsSchema: z.object({
      preset: z.enum(["creator", "impact", "clean"]),
      hookText: z.string().trim().min(1).max(180).optional(),
      ctaText: z.string().trim().min(1).max(180).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z.object({
        preset: z.enum(["creator", "impact", "clean"]),
        hookText: z.string().trim().min(1).max(180).optional(),
        ctaText: z.string().trim().min(1).max(180).optional(),
      }).parse(rawArgs);
      const hasVideo = context.project.tracks.some(
        (track) => track.kind === "video" && track.clips.some((clip) => clip.type === "video" || clip.type === "image"),
      );
      if (!hasVideo) {
        throw new HttpError(422, "Añade un clip de video a la línea de tiempo antes de preparar el estilo para redes.", "no_video_on_timeline");
      }

      const preset = {
        creator: { style: "viral", animationIn: "bounce-in" as const, color: "#FFFFFF" },
        impact: { style: "impact", animationIn: "zoom-in" as const, color: "#FFD44A" },
        clean: { style: "clean", animationIn: "fade-in" as const, color: "#FFFFFF" },
      }[args.preset];
      const presetLabel = { creator: "Creador dinámico", impact: "Impacto", clean: "Limpio" }[args.preset];
      const dimensions = ASPECT_PRESETS["9:16"];
      const longEdge = Math.min(3840, Math.max(context.project.settings.width, context.project.settings.height));
      const height = dimensions.ratio >= 1 ? even(longEdge / dimensions.ratio) : even(longEdge);
      const width = even(height * dimensions.ratio);
      let project = touchProject({
        ...context.project,
        settings: { ...context.project.settings, aspect: "9:16", width, height },
        tracks: context.project.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => !(
            clip.type === "text" &&
            clip.createdBy === "agent" &&
            (clip.name.startsWith("Gancho · ") || clip.name.startsWith("CTA · "))
          )),
        })),
      });

      const subtitleTargets = project.tracks
        .filter((track) => track.kind === "text")
        .flatMap((track) => track.clips)
        .filter((clip) => clip.type === "text" && clip.role === "subtitle");
      for (const clip of subtitleTargets) {
        const result = updateClip(project, clip.id, (current) => {
          if (current.type !== "text") return current;
          return {
            ...withSubtitleStyle(current, preset.style),
            animationIn: preset.animationIn,
            animationInDuration: 8,
            animationOut: "fade-out",
            animationOutDuration: 6,
          };
        });
        if (!result.ok) throw new HttpError(422, result.error, "social_preset_failed");
        project = result.project;
      }

      const trackSetup = ensureTextTrack(project);
      project = trackSetup.project;
      const fps = project.settings.fps.num / project.settings.fps.den;
      const addAnimatedText = (text: string, label: "Gancho" | "CTA", startSeconds: number) => {
        const durationSeconds = label === "Gancho" ? 2.4 : 3.2;
        const clip = makeTextClip({
          text,
          role: label === "Gancho" ? "title" : "caption",
          startFrame: Math.max(0, Math.round(startSeconds * fps)),
          durationFrames: Math.max(1, Math.round(durationSeconds * fps)),
          position: { x: 0.5, y: label === "Gancho" ? 0.28 : 0.72 },
          fontSize: label === "Gancho" ? 74 : 52,
          fontWeight: 900,
          color: preset.color,
          background: true,
          backgroundColor: "#101813",
          backgroundOpacity: 0.82,
          backgroundPadding: 16,
          maxWidth: 0.82,
          animationIn: preset.animationIn,
          animationInDuration: 10,
          animationOut: "fade-out",
          animationOutDuration: 8,
          createdBy: "agent",
        });
        clip.name = `${label} · ${text.slice(0, 50)}`;
        const result = addTextClip(project, trackSetup.trackId, clip);
        if (!result.ok) throw new HttpError(422, result.error, "social_overlay_failed");
        project = result.project;
      };

      if (args.hookText) addAnimatedText(args.hookText, "Gancho", 0.25);
      if (args.ctaText) {
        const duration = framesToSeconds(timelineDurationFrames(project), project.settings.fps);
        addAnimatedText(args.ctaText, "CTA", Math.max(0, duration - 3.2));
      }

      const additions = [
        "formato vertical 9:16",
        `subtítulos ${preset.style} con animación ${preset.animationIn}`,
        args.hookText ? "gancho animado" : null,
        args.ctaText ? "CTA animado" : null,
      ].filter((item): item is string => item !== null);
      return {
        summary: `Paquete «${presetLabel}» aplicado: ${additions.join(", ")}. No se cortaron ni aceleraron planos; revisa el encuadre vertical antes de exportar.${subtitleTargets.length === 0 ? " No había subtítulos existentes; genera subtítulos si quieres añadirlos." : ""}${!args.hookText || !args.ctaText ? " No inventé texto para el gancho o el CTA; puedes enviarme las frases exactas entre comillas." : ""}`,
        project,
        data: { preset: args.preset, aspect: "9:16", subtitlesChanged: subtitleTargets.length },
      };
    },
  },
  {
    name: "set_clip_transform",
    description:
      "Aplica zoom, escala y reposicionamiento a un clip de video o imagen. Úsalo para hacer zoom al vídeo, encuadrar mejor o mover el contenido dentro del frame.",
    argsHint:
      '{ "clipId": string, "scale"?: number, "x"?: number, "y"?: number }',
    risk: "medium",
    argsSchema: z.object({
      clipId: z.string(),
      scale: z.number().min(0.05).max(5).optional(),
      x: z.number().min(-200).max(200).optional(),
      y: z.number().min(-200).max(200).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          scale: z.number().min(0.05).max(5).optional(),
          x: z.number().min(-200).max(200).optional(),
          y: z.number().min(-200).max(200).optional(),
        })
        .parse(rawArgs);
      const result = updateClip(context.project, args.clipId, (clip) => {
        if (clip.type === "text") throw new HttpError(422, "El clip es de texto.", "clip_type_invalid");
        return {
          ...clip,
          transform: {
            ...clip.transform,
            ...(args.scale !== undefined ? { scale: args.scale } : {}),
            ...(args.x !== undefined ? { x: args.x } : {}),
            ...(args.y !== undefined ? { y: args.y } : {}),
          },
        };
      });
      if (!result.ok) throw new HttpError(422, result.error, "transform_failed");
      return {
        summary: `Transformación aplicada: escala ${args.scale ?? "mant"}, posición (${args.x ?? "mant"}, ${args.y ?? "mant"}).`,
        project: result.project,
        data: {
          clipId: args.clipId,
          transform: getClipTransform(context.project, args.clipId),
        },
      };
    },
  },
  {
    name: "set_clip_crop",
    description:
      "Recorta los bordes de un clip de video o imagen. Úsalo para eliminar zonas no deseadas, cambiar el encuadre o crear efectos de primer plano.",
    argsHint:
      '{ "clipId": string, "top"?: number, "right"?: number, "bottom"?: number, "left"?: number }',
    risk: "medium",
    argsSchema: z.object({
      clipId: z.string(),
      top: z.number().min(0).max(0.48).optional(),
      right: z.number().min(0).max(0.48).optional(),
      bottom: z.number().min(0).max(0.48).optional(),
      left: z.number().min(0).max(0.48).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          top: z.number().min(0).max(0.48).optional(),
          right: z.number().min(0).max(0.48).optional(),
          bottom: z.number().min(0).max(0.48).optional(),
          left: z.number().min(0).max(0.48).optional(),
        })
        .parse(rawArgs);
      const result = updateClip(context.project, args.clipId, (clip) => {
        if (clip.type === "text") throw new HttpError(422, "El clip es de texto.", "clip_type_invalid");
        return {
          ...clip,
          crop: {
            ...clip.crop,
            ...(args.top !== undefined ? { top: args.top } : {}),
            ...(args.right !== undefined ? { right: args.right } : {}),
            ...(args.bottom !== undefined ? { bottom: args.bottom } : {}),
            ...(args.left !== undefined ? { left: args.left } : {}),
          },
        };
      });
      if (!result.ok) throw new HttpError(422, result.error, "crop_failed");
      return {
        summary: `Recorte aplicado: top ${args.top ?? "mant"}, right ${args.right ?? "mant"}, bottom ${args.bottom ?? "mant"}, left ${args.left ?? "mant"}.`,
        project: result.project,
        data: { clipId: args.clipId, crop: getClipCrop(context.project, args.clipId) },
      };
    },
  },
  {
    name: "set_clip_rotation",
    description:
      "Rota un clip de video o imagen en grados. Úsalo para corregir la inclinación de la cámara o crear efectos creativos.",
    argsHint: '{ "clipId": string, "rotation": number }',
    risk: "medium",
    argsSchema: z.object({ clipId: z.string(), rotation: z.number().min(-360).max(360) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ clipId: z.string(), rotation: z.number().min(-360).max(360) }).parse(rawArgs);
      const result = updateClip(context.project, args.clipId, (clip) => {
        if (clip.type === "text") throw new HttpError(422, "El clip es de texto.", "clip_type_invalid");
        return {
          ...clip,
          transform: {
            ...clip.transform,
            rotation: args.rotation,
          },
        };
      });
      if (!result.ok) throw new HttpError(422, result.error, "rotation_failed");
      return {
        summary: `Rotación aplicada: ${args.rotation}°`,
        project: result.project,
        data: { clipId: args.clipId, rotation: args.rotation },
      };
    },
  },
  {
    name: "set_clip_timing",
    description:
      "Cambia el inicio y/o la duración de un clip existente de texto, imagen o video sin mover el resto del montaje. Úsalo para alargar, acortar, igualar o mover un texto ya creado.",
    argsHint: '{ "clipId": string, "startSeconds"?: number, "durationSeconds"?: number }',
    risk: "low",
    argsSchema: z.object({
      clipId: z.string(),
      startSeconds: z.number().min(0).max(36000).optional(),
      durationSeconds: z.number().min(0.2).max(3600).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          startSeconds: z.number().min(0).max(36000).optional(),
          durationSeconds: z.number().min(0.2).max(3600).optional(),
        })
        .parse(rawArgs);
      if (args.startSeconds === undefined && args.durationSeconds === undefined) {
        throw new HttpError(422, "Indica el nuevo inicio o la nueva duración del clip.", "timing_required");
      }
      const found = getClipById(context.project, args.clipId);
      if (!found) throw new HttpError(404, "El clip no existe.", "clip_not_found");
      const fps = context.project.settings.fps.num / context.project.settings.fps.den;
      const startFrame = args.startSeconds !== undefined ? Math.max(0, Math.round(args.startSeconds * fps)) : found.clip.startFrame;
      const durationFrames = args.durationSeconds !== undefined
        ? Math.max(1, Math.round(args.durationSeconds * fps))
        : found.clip.durationFrames;
      const result = updateClip(context.project, args.clipId, (clip) => ({
        ...clip,
        startFrame,
        durationFrames,
        ...(clip.type === "text"
          ? {
              fadeFrames: Math.min(clip.fadeFrames, Math.max(0, Math.floor(durationFrames / 2))),
              animationInDuration: Math.min(clip.animationInDuration, Math.max(0, durationFrames - 1)),
              animationOutDuration: Math.min(clip.animationOutDuration, Math.max(0, durationFrames - 1)),
            }
          : {}),
      }));
      if (!result.ok) throw new HttpError(422, result.error, "timing_failed");
      return {
        summary: `Duración actualizada: ${(durationFrames / fps).toFixed(2)} s desde ${(startFrame / fps).toFixed(2)} s.`,
        project: result.project,
        data: { clipId: args.clipId, startSeconds: startFrame / fps, durationSeconds: durationFrames / fps },
      };
    },
  },
  {
    name: "set_clip_opacity",
    description:
      "Ajusta la opacidad de un clip de video, imagen o texto. Úsalo para superposiciones, efectos de desvanecimiento o capas semitransparentes.",
    argsHint: '{ "clipId": string, "opacity": number }',
    risk: "low",
    argsSchema: z.object({ clipId: z.string(), opacity: z.number().min(0).max(1) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ clipId: z.string(), opacity: z.number().min(0).max(1) }).parse(rawArgs);
      const result = updateClip(context.project, args.clipId, (clip) => {
        if (clip.type === "text") throw new HttpError(422, "El clip es de texto.", "clip_type_invalid");
        return { ...clip, opacity: args.opacity };
      });
      if (!result.ok) throw new HttpError(422, result.error, "opacity_failed");
      return {
        summary: `Opacidad ajustada a ${Math.round(args.opacity * 100)}%.`,
        project: result.project,
        data: { clipId: args.clipId, opacity: args.opacity },
      };
    },
  },
  {
    name: "set_clip_fade",
    description:
      "Ajusta la entrada y salida con desvanecimiento (fade) en un clip de video o imagen. Úsalo para crear transiciones suaves entre clips adyacentes añadiendo fade-out al final del primero y fade-in al inicio del segundo. Soporta tipos: none, fade, crossfade, zoom, slide.",
    argsHint: '{ "clipId": string, "fadeInFrames"?: number, "fadeOutFrames"?: number, "transitionType"?: "none"|"fade"|"crossfade"|"zoom"|"slide" }',
    risk: "low",
    argsSchema: z.object({
      clipId: z.string(),
      fadeInFrames: z.number().int().min(0).max(600).optional(),
      fadeOutFrames: z.number().int().min(0).max(600).optional(),
      transitionType: z.enum(["none", "fade", "crossfade", "zoom", "slide"]).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          fadeInFrames: z.number().int().min(0).max(600).optional(),
          fadeOutFrames: z.number().int().min(0).max(600).optional(),
          transitionType: z.enum(["none", "fade", "crossfade", "zoom", "slide"]).optional(),
        })
        .parse(rawArgs);
      if (args.fadeInFrames === undefined && args.fadeOutFrames === undefined) {
        throw new HttpError(422, "Indica al menos fadeInFrames o fadeOutFrames.", "fade_required");
      }
      const found = getClipById(context.project, args.clipId);
      if (!found) throw new HttpError(404, "El clip no existe.", "clip_not_found");
      if (found.clip.type === "text") throw new HttpError(422, "Usa set_clip_animation para textos.", "clip_type_invalid");
      const maxFade = Math.floor(found.clip.durationFrames / 2);
      const fadeIn = args.fadeInFrames !== undefined ? Math.min(args.fadeInFrames, maxFade) : found.clip.fadeInFrames;
      const fadeOut = args.fadeOutFrames !== undefined ? Math.min(args.fadeOutFrames, maxFade) : found.clip.fadeOutFrames;
      const result = updateClip(context.project, args.clipId, (clip) => {
        const mediaClip = clip as Extract<typeof clip, { type: "video" | "audio" | "image" }>;
        return {
          ...clip,
          fadeInFrames: fadeIn,
          fadeOutFrames: fadeOut,
          transitionType: args.transitionType ?? mediaClip.transitionType ?? "none",
        };
      });
      if (!result.ok) throw new HttpError(422, result.error, "fade_failed");
      return {
        summary: `Fade ajustado: entrada ${fadeIn} frames, salida ${fadeOut} frames (${args.transitionType ?? "none"}).`,
        project: result.project,
        data: { clipId: args.clipId, fadeInFrames: fadeIn, fadeOutFrames: fadeOut, transitionType: args.transitionType ?? "none" },
      };
    },
  },
  {
    name: "trim_clip",
    description:
      "Recorta el inicio y/o el final de un clip de video, imagen o audio por segundos. Úsalo para quitar partes innecesarias al principio o al final sin mover el resto del montaje.",
    argsHint: '{ "clipId": string, "trimStartSeconds"?: number, "trimEndSeconds"?: number }',
    risk: "low",
    argsSchema: z.object({
      clipId: z.string(),
      trimStartSeconds: z.number().min(0).max(3600).optional(),
      trimEndSeconds: z.number().min(0).max(3600).optional(),
    }).refine((data) => data.trimStartSeconds !== undefined || data.trimEndSeconds !== undefined, {
      message: "Indica al menos trimStartSeconds o trimEndSeconds.",
      path: ["trimStartSeconds"],
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          trimStartSeconds: z.number().min(0).max(3600).optional(),
          trimEndSeconds: z.number().min(0).max(3600).optional(),
        })
        .parse(rawArgs);
      if (args.trimStartSeconds === undefined && args.trimEndSeconds === undefined) {
        throw new HttpError(422, "Indica al menos trimStartSeconds o trimEndSeconds.", "trim_required");
      }
      const found = getClipById(context.project, args.clipId);
      if (!found) throw new HttpError(404, "El clip no existe.", "clip_not_found");
      if (found.clip.type === "text") throw new HttpError(422, "Usa set_clip_timing para textos.", "clip_type_invalid");
      const fps = context.project.settings.fps.num / context.project.settings.fps.den;
      const startDeltaFrames = args.trimStartSeconds !== undefined ? Math.round(args.trimStartSeconds * fps) : 0;
      const endDeltaFrames = args.trimEndSeconds !== undefined ? Math.round(args.trimEndSeconds * fps) : 0;
      const project = context.project;
      let updatedProject = project;
      if (startDeltaFrames > 0) {
        const res = trimClipBy(updatedProject, args.clipId, "start", startDeltaFrames);
        if (!res.ok) throw new HttpError(422, res.error, "trim_start_failed");
        updatedProject = res.project;
      }
      if (endDeltaFrames > 0) {
        const res = trimClipBy(updatedProject, args.clipId, "end", -endDeltaFrames);
        if (!res.ok) throw new HttpError(422, res.error, "trim_end_failed");
        updatedProject = res.project;
      }
      return {
        summary: `Clip recortado: inicio ${args.trimStartSeconds ?? 0}s, fin ${args.trimEndSeconds ?? 0}s.`,
        project: updatedProject,
        data: { clipId: args.clipId, trimStartSeconds: args.trimStartSeconds ?? 0, trimEndSeconds: args.trimEndSeconds ?? 0 },
      };
    },
  },
  {
    name: "split_clip",
    description:
      "Divide un clip de video, imagen o audio en dos en un punto específico (atSeconds o atFrame). El clip original se reemplaza por dos clips consecutivos.",
    argsHint: '{ "clipId": string, "atSeconds"?: number, "atFrame"?: number }',
    risk: "low",
    argsSchema: z
      .object({
        clipId: z.string(),
        atSeconds: z.number().min(0.05).max(3600).optional(),
        atFrame: z.number().int().min(1).optional(),
      })
      .refine((v) => v.atSeconds !== undefined || v.atFrame !== undefined, {
        message: "Debes indicar atSeconds o atFrame.",
      }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          atSeconds: z.number().min(0.05).max(3600).optional(),
          atFrame: z.number().int().min(1).optional(),
        })
        .refine((v) => v.atSeconds !== undefined || v.atFrame !== undefined)
        .parse(rawArgs);
      const found = getClipById(context.project, args.clipId);
      if (!found) throw new HttpError(404, "El clip no existe.", "clip_not_found");
      if (found.clip.type === "text") {
        throw new HttpError(422, "No se pueden dividir clips de texto con esta herramienta.", "clip_type_invalid");
      }
      const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
      const atFrame =
        args.atSeconds !== undefined
          ? found.clip.startFrame + Math.round(args.atSeconds * fps)
          : Math.round(args.atFrame ?? 0);
      if (atFrame <= found.clip.startFrame || atFrame >= found.clip.startFrame + found.clip.durationFrames) {
        throw new HttpError(422, "El punto de corte debe estar dentro del clip.", "invalid_split_point");
      }
      const result = splitClipAt(context.project, args.clipId, atFrame);
      if (!result.ok) throw new HttpError(422, result.error, "split_failed");
      const splitSec = (atFrame - found.clip.startFrame) / fps;
      return {
        summary: `Clip dividido en ${splitSec.toFixed(2)}s (frame ${atFrame}).`,
        project: result.project,
        data: { clipId: args.clipId, leftId: result.leftId, rightId: result.rightId, atSeconds: splitSec, atFrame },
      };
    },
  },
  {
    name: "set_clip_zoom_keyframes",
    description:
      "Define puntos clave de zoom (keyframes) en un clip de video con interpolación lineal. Usa fotogramas concretos; si el usuario indica segundos, conviértelos con los FPS del proyecto. No inventes momentos ni clics: sin tiempos explícitos, usa solo un acercamiento progresivo suave con vuelta al encuadre original. El tamaño de salida no cambia y el resto del clip mantiene su encuadre.",
    argsHint:
      '{ "clipId": string, "keyframes": [{"frame": number, "scale": number, "x"?: number, "y"?: number}] }',
    risk: "medium",
    argsSchema: z.object({
      clipId: z.string(),
      keyframes: z.array(
        z.object({
          frame: z.number().int().min(0),
          scale: z.number().min(0.05).max(5),
          x: z.number().min(-200).max(200).optional(),
          y: z.number().min(-200).max(200).optional(),
        }),
      ).min(2),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          keyframes: z.array(
            z.object({
              frame: z.number().int().min(0),
              scale: z.number().min(0.05).max(5),
              x: z.number().min(-200).max(200).optional(),
              y: z.number().min(-200).max(200).optional(),
            }),
          ).min(2),
        })
        .parse(rawArgs);
      // Ordenar keyframes por frame
      const found = getClipById(context.project, args.clipId);
      if (!found) throw new HttpError(404, "El clip no existe.", "clip_not_found");
      if (found.clip.type === "text") throw new HttpError(422, "El clip es de texto.", "clip_type_invalid");
      const durationFrames = Math.max(1, found.clip.durationFrames);
      let normalized = [...args.keyframes]
        .map((keyframe) => ({ ...keyframe, frame: Math.max(0, Math.round(keyframe.frame)) }))
        .sort((a, b) => a.frame - b.frame);
      // Los modelos suelen expresar los fotogramas en la escala del video
      // original (247 s) y no del clip (0,5 s): se reescalan para que el zoom
      // exista de verdad en lugar de caer fuera del clip y desaparecer.
      let rescaled = false;
      const maxFrame = normalized.at(-1)?.frame ?? 0;
      if (maxFrame > durationFrames) {
        const factor = durationFrames / maxFrame;
        normalized = normalized.map((keyframe) => ({
          ...keyframe,
          frame: Math.round(keyframe.frame * factor),
        }));
        rescaled = true;
      }
      const byFrame = new Map<number, (typeof normalized)[number]>();
      for (const keyframe of normalized) {
        byFrame.set(Math.min(durationFrames, keyframe.frame), keyframe);
      }
      let sorted = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
      if (sorted.length < 2) {
        // Sin dos fotogramas distintos no hay interpolación: se reparten los
        // puntos solicitados a lo largo del clip conservando sus escalas.
        const source = args.keyframes.length >= 2 ? args.keyframes : [
          { frame: 0, scale: 1 },
          { frame: 1, scale: 1.1 },
        ];
        sorted = source.map((keyframe, index) => ({
          frame: Math.round((durationFrames * index) / Math.max(1, source.length - 1)),
          scale: keyframe.scale,
          x: keyframe.x,
          y: keyframe.y,
        }));
        rescaled = true;
      }
      const result = updateClip(context.project, args.clipId, (clip) => {
        if (clip.type === "text") throw new HttpError(422, "El clip es de texto.", "clip_type_invalid");
        return {
          ...clip,
          transform: {
            ...clip.transform,
            keyframes: sorted.map((k) => ({
              frame: k.frame,
              scale: k.scale,
              x: k.x ?? clip.transform.x,
              y: k.y ?? clip.transform.y,
            })),
          },
        };
      });
      if (!result.ok) throw new HttpError(422, result.error, "zoom_keyframes_failed");
      return {
        summary: `Keyframes de zoom aplicados: ${sorted.length} puntos clave en ${(durationFrames / (context.project.settings.fps.num / context.project.settings.fps.den)).toFixed(1)} s de clip${
          rescaled ? " (se ajustaron los fotogramas a la duración real del clip)" : ""
        }.`,
        project: result.project,
        data: { clipId: args.clipId, keyframes: sorted, rescaled },
      };
    },
  },
  {
    name: "set_clip_animation",
    description:
      "Aplica animación de entrada y/o salida a un clip de video, imagen o texto. Úsalo para que los elementos entren o salgan de la pantalla con estilo (desvanecimiento, deslizamiento, zoom, rebote).",
    argsHint:
      '{ "clipId": string, "animationIn"?: "fade-in"|"slide-left"|"slide-right"|"slide-up"|"slide-down"|"zoom-in"|"bounce-in", "animationInDuration"?: number, "animationOut"?: "fade-out"|"slide-left"|"slide-right"|"slide-up"|"slide-down"|"zoom-out"|"bounce-out", "animationOutDuration"?: number }',
    risk: "low",
    argsSchema: z.object({
      clipId: z.string(),
      animationIn: z.enum([
        "none", "fade-in", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "bounce-in",
      ]).optional(),
      animationInDuration: z.number().int().min(0).max(600).optional(),
      animationOut: z.enum([
        "none", "fade-out", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-out", "bounce-out",
      ]).optional(),
      animationOutDuration: z.number().int().min(0).max(600).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          clipId: z.string(),
          animationIn: z.enum([
            "none", "fade-in", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "bounce-in",
          ]).optional(),
          animationInDuration: z.number().int().min(0).max(600).optional(),
          animationOut: z.enum([
            "none", "fade-out", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-out", "bounce-out",
          ]).optional(),
          animationOutDuration: z.number().int().min(0).max(600).optional(),
        })
        .parse(rawArgs);
      const result = updateClip(context.project, args.clipId, (clip) => {
        if (clip.type === "text") {
          return {
            ...clip,
            ...(args.animationIn !== undefined ? { animationIn: args.animationIn } : {}),
            ...(args.animationInDuration !== undefined ? { animationInDuration: args.animationInDuration } : {}),
            ...(args.animationOut !== undefined ? { animationOut: args.animationOut } : {}),
            ...(args.animationOutDuration !== undefined ? { animationOutDuration: args.animationOutDuration } : {}),
          };
        }
        return {
          ...clip,
          transform: {
            ...clip.transform,
            ...(args.animationIn !== undefined ? { animationIn: args.animationIn } : {}),
            ...(args.animationInDuration !== undefined ? { animationInDuration: args.animationInDuration } : {}),
            ...(args.animationOut !== undefined ? { animationOut: args.animationOut } : {}),
            ...(args.animationOutDuration !== undefined ? { animationOutDuration: args.animationOutDuration } : {}),
          },
        };
      });
      if (!result.ok) throw new HttpError(422, result.error, "animation_failed");
      return {
        summary: `Animación aplicada: entrada "${args.animationIn ?? "sin cambios"}", salida "${args.animationOut ?? "sin cambios"}".`,
        project: result.project,
        data: { clipId: args.clipId },
      };
    },
  },
  {
    name: "cut_time_range",
    description:
      "Corta y elimina un rango temporal exacto de la línea de tiempo (vídeo, audio y subtítulos sincronizados). Útil para quitar intros, muletillas, errores o tramos concretos.",
    argsHint: '{ "startSeconds": number, "endSeconds": number, "ripple"?: boolean }',
    risk: "medium",
    argsSchema: z.object({
      startSeconds: z.number().min(0),
      endSeconds: z.number().min(0.1),
      ripple: z.boolean().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          startSeconds: z.number().min(0),
          endSeconds: z.number().min(0.1),
          ripple: z.boolean().optional(),
        })
        .parse(rawArgs);
      if (args.endSeconds <= args.startSeconds + 0.05) {
        throw new HttpError(422, "endSeconds debe ser mayor que startSeconds.", "invalid_cut_range");
      }
      const res = cutTimelineInterval(
        context.project,
        args.startSeconds,
        args.endSeconds,
        args.ripple ?? true,
      );
      return {
        summary: `Corte aplicado: eliminado el tramo ${args.startSeconds.toFixed(1)}s–${args.endSeconds.toFixed(1)}s${args.ripple === false ? " (sin ripple)" : " y compactado"}.`,
        project: res.project,
        data: {
          startSeconds: args.startSeconds,
          endSeconds: args.endSeconds,
          removedClips: res.removedClips,
          ripple: args.ripple ?? true,
        },
      };
    },
  },
  {
    name: "keep_time_ranges",
    description:
      "Conserva únicamente los intervalos temporales especificados (ej. mejores momentos o segmentos exactos) eliminando y compactando todo el resto de la línea de tiempo.",
    argsHint: '{ "ranges": [{ "startSeconds": number, "endSeconds": number }] }',
    risk: "medium",
    argsSchema: z.object({
      ranges: z
        .array(
          z.object({
            startSeconds: z.number().min(0),
            endSeconds: z.number().min(0.1),
          }),
        )
        .min(1),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          ranges: z
            .array(
              z.object({
                startSeconds: z.number().min(0),
                endSeconds: z.number().min(0.1),
              }),
            )
            .min(1),
        })
        .parse(rawArgs);

      const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
      const totalSec = framesToSeconds(timelineDurationFrames(context.project), context.project.settings.fps);

      const sorted = args.ranges
        .map((r) => ({
          start: Math.max(0, Math.min(totalSec, r.startSeconds)),
          end: Math.max(0, Math.min(totalSec, r.endSeconds)),
        }))
        .filter((r) => r.end > r.start + 0.08)
        .sort((a, b) => a.start - b.start);

      if (sorted.length === 0) {
        throw new HttpError(422, "Ningún rango válido para conservar dentro de la duración del proyecto.", "invalid_keep_ranges");
      }

      const merged: Array<{ start: number; end: number }> = [];
      for (const item of sorted) {
        const last = merged.at(-1);
        if (last && item.start <= last.end + 0.08) {
          last.end = Math.max(last.end, item.end);
        } else {
          merged.push({ ...item });
        }
      }

      const gapsToCut: Array<{ start: number; end: number }> = [];
      let cursor = 0;
      for (const keep of merged) {
        if (keep.start > cursor + 0.08) {
          gapsToCut.push({ start: cursor, end: keep.start });
        }
        cursor = Math.max(cursor, keep.end);
      }
      if (totalSec > cursor + 0.08) {
        gapsToCut.push({ start: cursor, end: totalSec });
      }

      let current = context.project;
      for (const gap of gapsToCut.sort((a, b) => b.start - a.start)) {
        const cutRes = cutTimelineInterval(current, gap.start, gap.end, true);
        current = cutRes.project;
      }

      const keptSeconds = merged.reduce((sum, r) => sum + (r.end - r.start), 0);
      return {
        summary: `Conservados ${merged.length} tramo(s) clave (${keptSeconds.toFixed(1)}s totales en ${(timelineDurationFrames(current) / fps).toFixed(1)}s).`,
        project: current,
        data: { keptRanges: merged, keptSeconds },
      };
    },
  },
  {
    name: "execute_custom_motion",
    description:
      "Diseña, compila y valida con esbuild un gráfico o escena Remotion TSX 100% personalizada y sin plantillas (Canvas 2D, SVG animado, geometría 3D, HUD cristalino sobre video o escena completa).",
    argsHint:
      '{ "prompt": string, "title"?: string, "literalTexts"?: string[], "ctaText"?: string, "startSeconds"?: number, "durationSeconds"?: number, "zone"?: "hero-top"|"top-right-hud"|"top-left-hud"|"center-stage"|"lower-third", "transparent"?: boolean, "accentColor"?: string }',
    risk: "low",
    argsSchema: z.object({
      prompt: z.string().min(3),
      title: z.string().min(1).max(80).optional(),
      literalTexts: z.array(z.string().min(1).max(200)).max(20).optional(),
      ctaText: z.string().min(1).max(120).optional(),
      startSeconds: z.number().min(0).optional(),
      durationSeconds: z.number().min(0.8).max(30).optional(),
      zone: z.enum(["hero-top", "top-right-hud", "top-left-hud", "center-stage", "lower-third"]).optional(),
      transparent: z.boolean().optional(),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      skipAi: z.boolean().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          prompt: z.string().min(3),
          title: z.string().min(1).max(80).optional(),
          literalTexts: z.array(z.string().min(1).max(200)).max(20).optional(),
          ctaText: z.string().min(1).max(120).optional(),
          startSeconds: z.number().min(0).optional(),
          durationSeconds: z.number().min(0.8).max(30).optional(),
          zone: z.enum(["hero-top", "top-right-hud", "top-left-hud", "center-stage", "lower-third"]).optional(),
          transparent: z.boolean().optional(),
          accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          skipAi: z.boolean().optional(),
        })
        .parse(rawArgs);

      const {
        synthesizeValidatedRemotionScene,
        buildPolymorphicProceduralSceneCode,
        ensureVirtualMotionAsset,
        verifyRemotionComponentTsx,
        resolveContextualOverlayCopy,
        isStructuralSceneLabel,
      } = await import("./autonomousEditorBrain");
      const { extractProjectSemanticDNA } = await import("./semanticDNA");

      const dna = extractProjectSemanticDNA({ prompt: args.prompt, projectName: context.project.name });
      const copy = resolveContextualOverlayCopy({
        prompt: args.prompt,
        explicitTitle: args.title,
        project: context.project,
        dna,
      });
      const brandKit = await projectStore.readBrandKit(context.projectId);
      const hasRealVideo = context.project.tracks.some(
        (t) =>
          t.kind === "video" &&
          !/motion|overlay|atm[óo]sfera/i.test(t.name) &&
          t.clips.some((c) => c.type === "video" && !c.remotion),
      );
      const transparent = args.transparent ?? hasRealVideo;
      const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
      const durSec = args.durationSeconds ?? 4.0;
      const durFrames = Math.max(12, Math.round(durSec * fps));
      const zone = args.zone ?? (transparent ? "hero-top" : "center-stage");

      const explicitLiterals = (args.literalTexts ?? [])
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s) => Boolean(s) && !isStructuralSceneLabel(s));
      const mergedLiterals: string[] = [];
      for (const item of [...explicitLiterals, ...copy.allLiterals, ...(args.ctaText ? [args.ctaText.trim()] : [])]) {
        const clean = item.replace(/\s+/g, " ").trim();
        if (clean && !mergedLiterals.some((x) => x.toLowerCase() === clean.toLowerCase())) {
          mergedLiterals.push(clean);
        }
      }

      const ctaText = args.ctaText?.trim() || copy.ctaText;
      const nonCtaExplicit = explicitLiterals.filter((l) => l.toLowerCase() !== (ctaText ?? "").toLowerCase());
      const headline =
        copy.usedFallbackCopy || isStructuralSceneLabel(copy.headline)
          ? nonCtaExplicit[0] ?? ctaText ?? copy.headline
          : copy.headline;
      const rawSub =
        copy.subheadline ||
        nonCtaExplicit.find((l) => l.toLowerCase() !== headline.toLowerCase()) ||
        "";
      const subheadline =
        rawSub.trim().toLowerCase() === headline.trim().toLowerCase() ? "" : rawSub;
      const allLiterals = mergedLiterals;
      const sceneArchetype =
        ctaText && copy.sceneArchetype === "general" ? "cta-close" : copy.sceneArchetype;
      const lowerPrompt = args.prompt.toLowerCase();
      const accent =
        args.accentColor ??
        (/\bcian\b|\bcyan\b/i.test(lowerPrompt)
          ? "#06B6D4"
          : brandKit?.primaryColor ?? dna.masterPalette.accent ?? "#38BDF8");
      const secondary =
        brandKit?.secondaryColor ??
        (/\bazul\b/i.test(lowerPrompt) ? "#3B82F6" : dna.masterPalette.secondary ?? "#818CF8");
      const surface =
        /\bazul\s+marino\b|\bnavy\b/i.test(lowerPrompt)
          ? "#061024"
          : brandKit?.surfaceColor ?? dna.masterPalette.surface ?? "#090D18";
      const text = brandKit?.textColor ?? dna.masterPalette.text ?? "#F8FAFC";
      const fontFamily =
        brandKit?.headingFont ?? (copy.wantsCorporateCleanStyle ? "Inter" : "Space Grotesk");

      const sceneBrief = {
        id: `custom_${newId("mot").slice(-6)}`,
        title: (args.title?.trim() || headline).slice(0, 48),
        startSec: args.startSeconds ?? 0,
        durationSec: durSec,
        zone,
        layerRole: transparent ? ("overlay" as const) : ("background-v1" as const),
        visualConcept: args.prompt,
        animationChoreography: "Entrada spring elastica + Canvas/SVG reactivo con salida progresiva",
        svgMetaphorIdea: copy.badge,
        headline,
        subheadline,
        ...(ctaText ? { ctaText } : {}),
        ...(allLiterals.length > 0 ? { allLiterals } : {}),
        sceneArchetype,
        sfxType: "whoosh" as const,
        hideSubtitlesDuringScene: !transparent,
      };

      const synth = args.skipAi
        ? { ok: false as const, error: "Síntesis IA omitida tras fallos consecutivos de proveedor en esta ejecución" }
        : await synthesizeValidatedRemotionScene({
            scene: sceneBrief,
            artDirection: {
              palette: { accent, secondary, surface, text },
              visualTheme: copy.badge,
              typographyStyle: "clean_geometric",
              editingPace: "balanced_editorial",
              cameraStyle: "subtle_editorial",
              colorMood: copy.badge,
            },
            width: context.project.settings.width,
            height: context.project.settings.height,
            fps: Math.round(fps),
            durationFrames: durFrames,
            signal: context.signal,
          });

      let componentName: string;
      let compositionId: string;
      let code: string;
      let props: Record<string, unknown>;
      const warnings: string[] = [];

      if (synth.ok) {
        componentName = synth.componentName;
        compositionId = synth.compositionId;
        code = synth.code;
        props = {
          ...synth.props,
          surfaceColor: surface,
          textColor: text,
        };
      } else {
        componentName = `CustomMotion${Date.now().toString(36).slice(-5).toUpperCase()}${Math.floor(Math.random() * 90 + 10)}`;
        compositionId = `custom_${componentName.toLowerCase()}`;
        const rawSeed = Math.abs(args.prompt.split("").reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7));
        const seed = sceneArchetype === "neural-hook" ? 0 : copy.wantsCorporateCleanStyle ? 3 : rawSeed;
        const extraLiterals = allLiterals.filter((lit) => {
          const l = lit.trim().toLowerCase();
          return (
            l !== headline.trim().toLowerCase() &&
            l !== subheadline.trim().toLowerCase() &&
            l !== (ctaText ?? "").trim().toLowerCase() &&
            l !== copy.badge.trim().toLowerCase()
          );
        });
        code = buildPolymorphicProceduralSceneCode({
          componentName,
          variantSeed: seed,
          headline,
          subheadline,
          accentColor: accent,
          secondaryColor: secondary,
          surfaceColor: surface,
          textColor: text,
          fontFamily,
          visualTheme: copy.badge,
          transparentOverlay: transparent,
          zone,
          ctaText,
          allLiterals,
          sceneArchetype,
        });
        const check = await verifyRemotionComponentTsx(code);
        if (!check.ok) {
          throw new HttpError(500, `Error compilando gráfico TSX personalizado: ${check.error}`, "custom_motion_compile_failed");
        }
        props = {
          zone,
          accentColor: accent,
          secondaryColor: secondary,
          surfaceColor: surface,
          textColor: text,
          badge: copy.badge,
          title: headline,
          subtitle: subheadline,
          ...(ctaText ? { ctaText } : {}),
          ...(allLiterals.length > 0 ? { allLiterals } : {}),
          ...(extraLiterals.length > 0 ? { extraLiterals } : {}),
          sceneArchetype,
          fontFamily,
        };
        warnings.push(
          `Síntesis TSX con IA no utilizada (${synth.error}); se generó componente procedural verificable (${sceneArchetype}) con los textos literales del encargo.`,
        );
      }

      if (copy.usedFallbackCopy) {
        warnings.push("No se detectaron textos concretos ni tema claro en el prompt; se usó copy editorial de respaldo.");
      }

      let current = context.project;
      const assetRes = ensureVirtualMotionAsset(current, componentName, durFrames);
      current = assetRes.project;

      let targetTrackId: string;
      if (transparent) {
        const overlay = ensureMotionOverlayTrack(current);
        current = overlay.project;
        targetTrackId = overlay.track.id;
      } else {
        const primary = firstVideoTrack(current);
        if (primary) {
          targetTrackId = primary.id;
        } else {
          const added = addTrack(current, "video", "V1");
          if (!added.ok || !added.track) throw new HttpError(500, "No se pudo crear pista V1.");
          current = added.project;
          targetTrackId = added.track.id;
        }
      }

      const trackObj = current.tracks.find((t) => t.id === targetTrackId)!;
      const desiredFrame = Math.max(0, Math.round((args.startSeconds ?? 0) * fps));
      const startFrame = findFreeStartFrame(trackObj, desiredFrame, durFrames);
      const clipDisplayName = args.title?.trim() ? args.title.trim().slice(0, 64) : `Motion IA · ${headline.slice(0, 26)}`;
      const motionClip: MediaClip = {
        ...makeMediaClip(current, assetRes.asset, {
          startFrame,
          durationFrames: durFrames,
          createdBy: "agent",
        }),
        name: clipDisplayName,
        remotion: {
          compositionId,
          componentName,
          code,
          props,
          live: true,
        },
      };

      const addRes = addClip(current, targetTrackId, motionClip);
      if (!addRes.ok) throw new HttpError(422, addRes.error, "custom_motion_insert_failed");
      current = addRes.project;

      const renderedTexts = extractRemotionClipVisibleTexts(motionClip);
      const renderedCorpus = renderedTexts.join(" \n ").toLowerCase();
      const missingLiterals = allLiterals.filter((lit) => !renderedCorpus.includes(lit.toLowerCase()));
      const internalLabelLeaked = isStructuralSceneLabel(String(props.title ?? headline)) && allLiterals.length === 0;
      const status =
        missingLiterals.length > 0 || internalLabelLeaked
          ? "failed"
          : synth.ok
            ? "verified"
            : "fallback";

      return {
        status,
        warnings,
        verification: {
          checks: [
            {
              name: "literal_copy_present",
              passed: missingLiterals.length === 0,
              detail:
                missingLiterals.length === 0
                  ? `${allLiterals.length} texto(s) literal(es) conservados en escena.`
                  : `Faltan textos literales: ${missingLiterals.join(", ")}`,
            },
            {
              name: "no_internal_clip_label_leak",
              passed: !internalLabelLeaked,
              detail: internalLabelLeaked
                ? `Se usó etiqueta interna "${String(props.title ?? headline)}" en pantalla.`
                : "Sin etiquetas internas como titular visual.",
            },
          ],
          evidence: renderedTexts,
        },
        summary: `Escena Remotion "${clipDisplayName}" (${headline.slice(0, 36)}) creada en ${(startFrame / fps).toFixed(1)}s (${synth.ok ? "IA + esbuild" : `Procedural ${sceneArchetype}`}).`,
        project: current,
        data: {
          clipId: motionClip.id,
          componentName,
          compositionId,
          startSeconds: startFrame / fps,
          durationSeconds: durFrames / fps,
          transparent,
          engine: synth.ok ? "llm-tsx" : "procedural-fallback",
          sceneArchetype,
          visibleTexts: renderedTexts,
          status,
          warnings,
        },
      };
    },
  },
  {
    name: "execute_autonomous_edit_swarm",
    description:
      "Activa la Orquestación de Enjambre Autónomo (Director IA + Remotion × HyperFrames + Herramientas Quirúrgicas): (0) analiza metraje/transcripción y aplica gradación de color, velocidad, audio y recorte real; (1) poda silencios o construye universo V1+TTS; (2) subtítulos contextuales adaptativos; (3) coreografía de cámara; (4) sintetiza escenas y overlays Remotion TSX únicos validados con esbuild + transiciones ópticas y look cinematográfico; (5) SFX sincronizados y (6) auditoría espacial + QA compilador.",
    argsHint:
      '{ "style"?: "minimal" | "tiktok" | "hormozi" | "cinematic" | "neon" | "impact", "enablePunches"?: boolean, "enableSilenceCut"?: boolean, "enableBrollCards"?: boolean, "ctaHandle"?: string, "prompt"?: string }',
    risk: "medium",
    argsSchema: z.object({
      style: z.enum(["minimal", "tiktok", "hormozi", "cinematic", "neon", "impact"]).optional(),
      enablePunches: z.boolean().optional(),
      enableSilenceCut: z.boolean().optional(),
      enableBrollCards: z.boolean().optional(),
      ctaHandle: z.string().optional(),
      prompt: z.string().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          style: z.enum(["minimal", "tiktok", "hormozi", "cinematic", "neon", "impact"]).optional(),
          enablePunches: z.boolean().optional(),
          enableSilenceCut: z.boolean().optional(),
          enableBrollCards: z.boolean().optional(),
          ctaHandle: z.string().optional(),
          prompt: z.string().optional(),
        })
        .parse(rawArgs);

      const swarmResult = await runSwarmDirector({
        projectId: context.projectId,
        prompt: args.prompt ?? "Edición autónoma por enjambre IA",
        style: args.style,
        enablePunches: args.enablePunches ?? true,
        enableSilenceCut: args.enableSilenceCut ?? true,
        enableBrollCards: args.enableBrollCards ?? true,
        ctaHandle: args.ctaHandle,
        signal: context.signal,
        onProgress: (stepMsg, stepIdx, totalSteps) => {
          context.setProgress(Math.round((stepIdx / totalSteps) * 100), stepMsg);
        },
      });

      return {
        summary: swarmResult.summary,
        project: swarmResult.project,
        data: {
          type: "SWARM_EDIT_COMPLETE",
          steps: swarmResult.steps,
          stats: swarmResult.stats,
        },
      };
    },
  },
  {
    name: "get_capabilities",
    description:
      "Informa los motores, proveedores de IA/TTS/STT/música/SFX disponibles y el límite seguro de concurrencia de Remotion.",
    argsHint: "{}",
    risk: "low",
    argsSchema: z.object({}),
    execute: async (_context, rawArgs) => {
      z.object({}).parse(rawArgs);
      const { SkillRegistry } = await import("../../src/shared/skills");
      const { getSkillsDir } = await import("../skills/registry");
      const ai = aiStatus();
      const remotionOk = remotionEngineAvailable();
      const concurrency = computeSafeRemotionConcurrency({ requested: 4 });
      const registry = new SkillRegistry(getSkillsDir());
      await registry.loadAll().catch(() => undefined);
      const hasOpenAiTts = Boolean((process.env.OECLIP_TTS_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim());
      return {
        status: "verified",
        summary: `Capacidades: LLM ${ai.chat ? "activo" : "local-fallback"}, STT ${ai.transcriptionMode}, TTS ${hasOpenAiTts ? "cloud+local" : "local/procedural"}, Remotion ${remotionOk ? "activo" : "no-instalado"} (concurrency=${concurrency.concurrency}/${concurrency.detectedCores} cores), Skills ${registry.getAll().length}.`,
        data: {
          engines: { ffmpeg: true, remotion: remotionOk },
          remotionConcurrency: concurrency,
          providers: {
            llm: { available: ai.chat, model: ai.model, mode: ai.provider },
            stt: { available: ai.transcribe, mode: ai.transcriptionMode, model: ai.transcribeModel },
            tts: { available: true, cloudTts: hasOpenAiTts, fallbackProcedural: true },
            music: { available: true, provider: "procedural-aevalsrc" },
            sfx: { available: true, library: ["whoosh", "pop", "ding", "riser", "subhit", "glitch"] },
          },
          autonomousDirector: true,
          skillsCount: registry.getAll().length,
        },
      };
    },
  },
  {
    name: "get_project_summary",
    description:
      "Resumen compacto del proyecto en segundos: resolución, duración, medios, pistas, textos visibles, Brand Kit y advertencias de calidad.",
    argsHint: "{}",
    risk: "low",
    argsSchema: z.object({}),
    execute: async (context, rawArgs) => {
      z.object({}).parse(rawArgs);
      const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
      const durationFrames = timelineDurationFrames(context.project);
      const durationSeconds = Number(framesToSeconds(durationFrames, context.project.settings.fps).toFixed(2));
      const lowResWarnings = detectLowResolutionSources(context.project);
      const brandKit = await projectStore.readBrandKit(context.projectId);
      const warnings = lowResWarnings.map((w) => w.message);
      return {
        status: "verified",
        warnings,
        summary: `Proyecto "${context.project.name}" (rev ${context.project.revision}): ${context.project.settings.width}x${context.project.settings.height} (${context.project.settings.aspect}) @ ${fps.toFixed(0)} fps, ${durationSeconds}s, ${context.project.media.length} medios, ${context.project.tracks.length} pistas.`,
        data: {
          id: context.project.id,
          name: context.project.name,
          revision: context.project.revision,
          resolution: `${context.project.settings.width}x${context.project.settings.height}`,
          aspect: context.project.settings.aspect,
          fps: Number(fps.toFixed(2)),
          durationSeconds,
          durationFrames,
          mediaCount: context.project.media.length,
          tracksCount: context.project.tracks.length,
          exportsCount: context.project.exports.length,
          brandKit,
          lowResWarnings,
        },
      };
    },
  },
  {
    name: "get_timeline_summary",
    description:
      "Devuelve la línea de tiempo pista por pista en segundos (inicio, fin, duración y textos literales visibles en cada clip).",
    argsHint: "{}",
    risk: "low",
    argsSchema: z.object({}),
    execute: async (context, rawArgs) => {
      z.object({}).parse(rawArgs);
      const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
      const tracks = context.project.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        kind: track.kind,
        muted: track.muted,
        hidden: track.hidden,
        clips: track.clips.map((clip) => {
          const startSec = Number((clip.startFrame / fps).toFixed(2));
          const durationSec = Number((clip.durationFrames / fps).toFixed(2));
          const endSec = Number((startSec + durationSec).toFixed(2));
          const visibleTexts =
            clip.type === "text"
              ? [clip.text]
              : clip.remotion
                ? extractRemotionClipVisibleTexts(clip)
                : [];
          return {
            id: clip.id,
            name: clip.name,
            type: clip.type,
            startSec,
            endSec,
            durationSec,
            visibleTexts,
            hasRemotion: clip.type !== "text" ? Boolean(clip.remotion) : false,
          };
        }),
      }));
      const durationSeconds = Number(framesToSeconds(timelineDurationFrames(context.project), context.project.settings.fps).toFixed(2));
      return {
        status: "verified",
        summary: `Timeline de ${durationSeconds}s en ${tracks.length} pistas.`,
        data: { durationSeconds, fps: Number(fps.toFixed(2)), tracks },
      };
    },
  },
  {
    name: "rename_project",
    description: "Cambia el título visible del proyecto para evitar nombres genéricos o duplicados.",
    argsHint: '{ "name": string }',
    risk: "low",
    argsSchema: z.object({ name: z.string().min(1).max(160) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ name: z.string().min(1).max(160) }).parse(rawArgs);
      const nextName = args.name.trim();
      const project = touchProject({ ...context.project, name: nextName });
      return {
        status: "verified",
        summary: `Proyecto renombrado a "${nextName}".`,
        project,
        data: { name: nextName },
      };
    },
  },
  {
    name: "checkpoint",
    description: "Guarda una instantánea reversible (checkpoint) del estado actual antes de editar.",
    argsHint: '{ "label"?: string }',
    risk: "low",
    argsSchema: z.object({ label: z.string().max(180).optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ label: z.string().max(180).optional() }).parse(rawArgs);
      const label = args.label?.trim() || `Checkpoint rev ${context.project.revision}`;
      const snap = await projectStore.createSnapshot(context.projectId, label);
      return {
        status: "verified",
        summary: `Checkpoint guardado (${snap.fileName}) en revisión ${context.project.revision}.`,
        data: { fileName: snap.fileName, label, revision: context.project.revision },
      };
    },
  },
  {
    name: "undo",
    description: "Deshace el último cambio en la línea de tiempo restaurando el estado previo.",
    argsHint: "{}",
    risk: "medium",
    argsSchema: z.object({}),
    execute: async (context, rawArgs) => {
      z.object({}).parse(rawArgs);
      const { eventBus } = await import("../events");
      const bundle = await projectStore.undo(context.projectId);
      eventBus.publish(context.projectId, {
        type: "project",
        projectId: context.projectId,
        revision: bundle.project.revision,
      });
      return {
        status: "verified",
        summary: `Cambio deshecho. Revisión actual: ${bundle.project.revision}.`,
        data: { revision: bundle.project.revision, durationFrames: timelineDurationFrames(bundle.project) },
      };
    },
  },
  {
    name: "redo",
    description: "Rehace el último cambio deshecho mediante undo.",
    argsHint: "{}",
    risk: "medium",
    argsSchema: z.object({}),
    execute: async (context, rawArgs) => {
      z.object({}).parse(rawArgs);
      const { eventBus } = await import("../events");
      const bundle = await projectStore.redo(context.projectId);
      eventBus.publish(context.projectId, {
        type: "project",
        projectId: context.projectId,
        revision: bundle.project.revision,
      });
      return {
        status: "verified",
        summary: `Cambio rehecho. Revisión actual: ${bundle.project.revision}.`,
        data: { revision: bundle.project.revision, durationFrames: timelineDurationFrames(bundle.project) },
      };
    },
  },
  {
    name: "revert_to_revision",
    description: "Revierte el proyecto a una revisión o checkpoint anterior guardado.",
    argsHint: '{ "revision": number }',
    risk: "medium",
    argsSchema: z.object({ revision: z.number().int().min(0) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ revision: z.number().int().min(0) }).parse(rawArgs);
      const { eventBus } = await import("../events");
      const bundle = await projectStore.restoreRevision(context.projectId, args.revision);
      eventBus.publish(context.projectId, {
        type: "project",
        projectId: context.projectId,
        revision: bundle.project.revision,
      });
      return {
        status: "verified",
        summary: `Proyecto revertido al snapshot más próximo a rev ${args.revision}. Nueva revisión: ${bundle.project.revision}.`,
        data: { targetRevision: args.revision, revision: bundle.project.revision },
      };
    },
  },
  {
    name: "diff_revisions",
    description: "Compara dos revisiones o snapshots del proyecto (duración, pistas y clips modificados).",
    argsHint: '{ "a"?: number, "b"?: number }',
    risk: "low",
    argsSchema: z.object({ a: z.number().int().min(0).optional(), b: z.number().int().min(0).optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ a: z.number().int().min(0).optional(), b: z.number().int().min(0).optional() }).parse(rawArgs);
      const snaps = await projectStore.listSnapshots(context.projectId);
      const pickProject = async (rev?: number): Promise<{ rev: number; proj: Project }> => {
        if (rev === undefined || rev === context.project.revision) {
          return { rev: context.project.revision, proj: context.project };
        }
        const match = snaps.find((s) => s.revision === rev);
        if (!match) {
          return { rev: context.project.revision, proj: context.project };
        }
        const loaded = await projectStore.readSnapshot(context.projectId, match.fileName);
        return { rev: loaded.revision, proj: loaded.project };
      };
      const baseSnap =
        args.a !== undefined
          ? await pickProject(args.a)
          : snaps[0]
            ? await pickProject(snaps[0].revision)
            : { rev: context.project.revision, proj: context.project };
      const nextSnap = await pickProject(args.b);
      const clipIds = (p: Project) => new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      const baseIds = clipIds(baseSnap.proj);
      const nextIds = clipIds(nextSnap.proj);
      const added = Array.from(nextIds).filter((id) => !baseIds.has(id));
      const removed = Array.from(baseIds).filter((id) => !nextIds.has(id));
      const baseDur = Number(framesToSeconds(timelineDurationFrames(baseSnap.proj), baseSnap.proj.settings.fps).toFixed(2));
      const nextDur = Number(framesToSeconds(timelineDurationFrames(nextSnap.proj), nextSnap.proj.settings.fps).toFixed(2));
      return {
        status: "verified",
        summary: `Diff rev ${baseSnap.rev} → rev ${nextSnap.rev}: duración ${baseDur}s → ${nextDur}s, +${added.length} clip(s), -${removed.length} clip(s).`,
        data: {
          fromRevision: baseSnap.rev,
          toRevision: nextSnap.rev,
          durationSecondsFrom: baseDur,
          durationSecondsTo: nextDur,
          addedClips: added,
          removedClips: removed,
          availableSnapshots: snaps.slice(0, 15),
        },
      };
    },
  },
  {
    name: "render_frames",
    description:
      "Renderiza fotogramas reales PNG del timeline en tiempos concretos o intervalos regulares para inspección visual.",
    argsHint: '{ "times"?: number[], "every"?: number, "scale"?: number }',
    risk: "low",
    argsSchema: z.object({
      times: z.array(z.number().min(0)).max(12).optional(),
      every: z.number().min(0.25).max(60).optional(),
      scale: z.number().min(0.2).max(1).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          times: z.array(z.number().min(0)).max(12).optional(),
          every: z.number().min(0.25).max(60).optional(),
          scale: z.number().min(0.2).max(1).optional(),
        })
        .parse(rawArgs);
      const res = await renderTimelineFrames(context.projectId, context.project, {
        times: args.times,
        every: args.every,
        scale: args.scale ?? 0.4,
        signal: context.signal,
      });
      const usesRemotion = context.project.tracks.some((t) => t.clips.some((c) => Boolean(c.remotion)));
      const fallbackFrames = res.frames.filter((f) => f.renderSource !== "remotion");
      const hasFallback = usesRemotion && fallbackFrames.length > 0;
      return {
        status: hasFallback ? "fallback" : "verified",
        ...(hasFallback
          ? {
              warnings: [
                `${fallbackFrames.length}/${res.frames.length} fotograma(s) usaron respaldo (${fallbackFrames[0]?.renderSource ?? "ffmpeg"}) en lugar de render Remotion real.`,
              ],
            }
          : {}),
        verification: {
          checks: [
            { name: "frames_rendered", passed: res.frames.length > 0, detail: `${res.frames.length} fotogramas generados` },
            ...(usesRemotion
              ? [
                  {
                    name: "remotion_still_render",
                    passed: !hasFallback,
                    detail: hasFallback
                      ? `${fallbackFrames.length} fotograma(s) sin render Remotion real`
                      : "Render real con @remotion/renderer",
                  },
                ]
              : []),
          ],
          evidence: res.frames.map((f) => f.path),
        },
        summary: `Renderizados ${res.frames.length} fotogramas (${res.resolution.width}x${res.resolution.height}) en ${res.durationSeconds}s de timeline${hasFallback ? " [con respaldo]" : ""}.`,
        data: res,
      };
    },
  },
  {
    name: "contact_sheet",
    description:
      "Genera una hoja de contactos (contact sheet PNG en cuadrícula) con los momentos clave del montaje.",
    argsHint: '{ "every"?: number, "columns"?: number }',
    risk: "low",
    argsSchema: z.object({
      every: z.number().min(0.5).max(60).optional(),
      columns: z.number().int().min(1).max(6).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          every: z.number().min(0.5).max(60).optional(),
          columns: z.number().int().min(1).max(6).optional(),
        })
        .parse(rawArgs);
      const sheet = await generateContactSheet(context.projectId, context.project, {
        every: args.every,
        columns: args.columns,
        signal: context.signal,
      });
      return {
        status: "verified",
        verification: {
          checks: [{ name: "contact_sheet_generated", passed: Boolean(sheet.path), detail: `${sheet.frameCount} cuadros (${sheet.columns}x${sheet.rows})` }],
          evidence: [sheet.path],
        },
        summary: `Contact sheet generado (${sheet.columns}x${sheet.rows}, ${sheet.frameCount} fotogramas): ${path.basename(sheet.path)}.`,
        data: sheet,
      };
    },
  },
  {
    name: "inspect_frame",
    description:
      "Inspecciona un fotograma exacto en `time` segundos: renderiza la imagen, devuelve los textos visibles, contraste WCAG y zonas seguras.",
    argsHint: '{ "time": number }',
    risk: "low",
    argsSchema: z.object({ time: z.number().min(0) }),
    execute: async (context, rawArgs) => {
      const args = z.object({ time: z.number().min(0) }).parse(rawArgs);
      const info = await inspectTimelineFrame(context.projectId, context.project, {
        time: args.time,
        signal: context.signal,
      });
      return {
        status: info.warnings.length > 0 ? "fallback" : "verified",
        warnings: info.warnings,
        verification: {
          checks: [
            { name: "contrast_wcag", passed: info.contrastPassed, detail: `Ratio ${info.contrastRatio}:1` },
            { name: "safe_zone", passed: info.safeZonePassed, detail: info.safeZonePassed ? "Dentro de márgenes" : "Fuera de márgenes seguros" },
          ],
          evidence: info.framePath ? [info.framePath] : [],
        },
        summary: `Frame @ ${info.time}s: ${info.visibleTexts.length} texto(s) visible(s), contraste ${info.contrastRatio}:1, zona segura ${info.safeZonePassed ? "OK" : "REVISAR"}.`,
        data: info,
      };
    },
  },
  {
    name: "qa_report",
    description:
      "Ejecuta la auditoría automática de 9 criterios sobre el montaje completo (duración, textos literales sin placeholders internos, huecos negros, contraste >= 4.5:1, márgenes, ritmo, audio, subtítulos y resolución de fuentes).",
    argsHint: '{ "expectedLiterals"?: string[], "expectedPrompt"?: string, "targetDurationSec"?: number, "strict"?: boolean }',
    risk: "low",
    argsSchema: z.object({
      expectedLiterals: z.array(z.string()).max(40).optional(),
      expectedPrompt: z.string().max(8000).optional(),
      targetDurationSec: z.number().positive().optional(),
      strict: z.boolean().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          expectedLiterals: z.array(z.string()).max(40).optional(),
          expectedPrompt: z.string().max(8000).optional(),
          targetDurationSec: z.number().positive().optional(),
          strict: z.boolean().optional(),
        })
        .parse(rawArgs);
      const report = await buildTimelineQaReport(context.projectId, context.project, {
        expectedLiterals: args.expectedLiterals,
        expectedPrompt: args.expectedPrompt,
        targetDurationSec: args.targetDurationSec,
        strict: args.strict,
      });
      return {
        status: report.status,
        warnings: report.warnings,
        verification: {
          checks: report.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
          evidence: report.visibleTextsByScene.map((s) => `${s.clipName}: ${s.texts.join(" | ")}`),
        },
        summary: `QA Report ${report.score}/100 (${report.status}): ${report.checks.filter((c) => c.passed).length}/${report.checks.length} checks aprobados${report.criticalFailures.length > 0 ? ` — FALLOS: ${report.criticalFailures.join(" ")}` : ""}.`,
        data: report,
      };
    },
  },
  {
    name: "get_transcript",
    description: "Devuelve la transcripción con marcas de tiempo por frase y palabra (STT real o subtítulos presentes).",
    argsHint: '{ "mediaId"?: string, "language"?: string }',
    risk: "low",
    argsSchema: z.object({ mediaId: z.string().optional(), language: z.string().max(12).optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ mediaId: z.string().optional(), language: z.string().max(12).optional() }).parse(rawArgs);
      const asset = args.mediaId ? requireAsset(context.project, args.mediaId) : context.project.media.find((m) => m.audioCodec);
      if (asset && asset.audioCodec && !(asset.origin === "generated" && asset.file.startsWith("generated/"))) {
        try {
          const t = await transcribeMedia(context.projectId, asset, args.language, context.signal);
          const segments = t.segments.map((s) => ({
            startSec: Number((s.startUs / 1_000_000).toFixed(2)),
            endSec: Number((s.endUs / 1_000_000).toFixed(2)),
            text: s.text,
            words: s.words?.map((w) => ({
              startSec: Number((w.startUs / 1_000_000).toFixed(2)),
              endSec: Number((w.endUs / 1_000_000).toFixed(2)),
              text: w.text,
            })),
          }));
          return {
            status: "verified",
            summary: `Transcripción real (${t.language}): ${segments.length} segmento(s).`,
            data: { language: t.language, source: "stt", segments },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const fallbackTexts = context.project.tracks
            .filter((tr) => tr.kind === "text")
            .flatMap((tr) => tr.clips)
            .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
            .map((c) => {
              const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
              return {
                startSec: Number((c.startFrame / fps).toFixed(2)),
                endSec: Number(((c.startFrame + c.durationFrames) / fps).toFixed(2)),
                text: c.text,
              };
            });
          return {
            status: fallbackTexts.length > 0 ? "fallback" : "unverified",
            warnings: [`No se pudo ejecutar STT sobre "${asset.name}": ${message}`],
            summary: `STT no disponible (${message}); devueltos ${fallbackTexts.length} bloques de texto del timeline.`,
            data: { source: "timeline-fallback", segments: fallbackTexts },
          };
        }
      }
      const existingSubs = context.project.tracks
        .filter((tr) => tr.kind === "text")
        .flatMap((tr) => tr.clips)
        .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
        .map((c) => {
          const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
          return {
            startSec: Number((c.startFrame / fps).toFixed(2)),
            endSec: Number(((c.startFrame + c.durationFrames) / fps).toFixed(2)),
            text: c.text,
          };
        });
      return {
        status: existingSubs.length > 0 ? "verified" : "unverified",
        summary: `Sin medio con audio STT; ${existingSubs.length} segmento(s) de subtítulos en timeline.`,
        data: { source: "timeline", segments: existingSubs },
      };
    },
  },
  {
    name: "audio_metrics",
    description: "Mide LUFS integrado, pico real dBFS, RMS y silencios de un activo con audio o del proyecto.",
    argsHint: '{ "mediaId"?: string }',
    risk: "low",
    argsSchema: z.object({ mediaId: z.string().optional() }),
    execute: async (context, rawArgs) => {
      const args = z.object({ mediaId: z.string().optional() }).parse(rawArgs);
      const asset = args.mediaId
        ? requireAsset(context.project, args.mediaId)
        : context.project.media.find((m) => Boolean(m.audioCodec));
      if (!asset || !asset.audioCodec) {
        return {
          status: "unverified",
          warnings: ["El proyecto no tiene ningún recurso de audio medible."],
          summary: "Sin pista de audio analizable en el proyecto.",
          data: { hasAudio: false, integratedLufs: null, truePeakDb: null, silences: [] },
        };
      }
      const [loudness, envelope, silences] = await Promise.all([
        measureLoudness(context.projectId, asset, context.signal).catch(() => ({ integratedLufs: null, truePeakDb: null })),
        analyzeAudioEnvelope(context.projectId, asset, 0.5, context.signal).catch(() => null),
        detectSilences(context.projectId, asset, { thresholdDb: -38, minSilenceSec: 0.7 }, context.signal).catch(() => ({ intervals: [], analyzedUs: asset.durationUs })),
      ]);
      return {
        status: "verified",
        summary: `Métricas audio "${asset.name}": ${loudness.integratedLufs ?? "-"} LUFS, peak ${loudness.truePeakDb ?? "-"} dBFS, ${silences.intervals.length} silencio(s).`,
        data: {
          hasAudio: true,
          mediaId: asset.id,
          integratedLufs: loudness.integratedLufs,
          truePeakDb: loudness.truePeakDb,
          meanDb: envelope?.meanDb ?? null,
          peakDb: envelope?.peakDb ?? null,
          clipping: loudness.truePeakDb !== null && loudness.truePeakDb > -0.2,
          silences: silences.intervals.map((iv) => ({
            startSec: Number((iv.startUs / 1_000_000).toFixed(2)),
            endSec: Number((iv.endUs / 1_000_000).toFixed(2)),
            durationSec: Number((iv.durationUs / 1_000_000).toFixed(2)),
          })),
        },
      };
    },
  },
  {
    name: "synthesize_voiceover",
    description:
      "Genera locución (TTS cloud u offline, con respaldo procedural marcado explícitamente) e inserta el audio sincronizado y opcionalmente subtítulos en la línea de tiempo.",
    argsHint: '{ "text"?: string, "blocks"?: [{ "label": string, "narration": string, "durationSec"?: number }], "language"?: "es"|"en", "startSeconds"?: number, "addSubtitles"?: boolean }',
    risk: "medium",
    argsSchema: z.object({
      text: z.string().min(2).max(4000).optional(),
      blocks: z
        .array(
          z.object({
            label: z.string().min(1).max(80),
            narration: z.string().min(1).max(1200),
            durationSec: z.number().min(0.8).max(120).optional(),
          }),
        )
        .max(20)
        .optional(),
      language: z.string().max(12).optional(),
      voiceHint: z.string().max(80).optional(),
      startSeconds: z.number().min(0).optional(),
      addSubtitles: z.boolean().optional(),
      alignToBlockDurations: z.boolean().optional(),
      subtitleStyle: z.enum(["minimal", "tiktok", "hormozi", "cinematic", "neon", "impact", "karaoke"]).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          text: z.string().min(2).max(4000).optional(),
          blocks: z
            .array(
              z.object({
                label: z.string().min(1).max(80),
                narration: z.string().min(1).max(1200),
                durationSec: z.number().min(0.8).max(120).optional(),
              }),
            )
            .max(20)
            .optional(),
          language: z.string().max(12).optional(),
          voiceHint: z.string().max(80).optional(),
          startSeconds: z.number().min(0).optional(),
          addSubtitles: z.boolean().optional(),
          alignToBlockDurations: z.boolean().optional(),
          subtitleStyle: z.enum(["minimal", "tiktok", "hormozi", "cinematic", "neon", "impact", "karaoke"]).optional(),
        })
        .parse(rawArgs);

      const { synthesizeSceneSpeechTracks, estimateNarrationDurationSec } = await import("../services/ttsService");
      const blocks =
        args.blocks && args.blocks.length > 0
          ? args.blocks.map((b) => ({
              label: b.label,
              narration: b.narration,
              suggestedDurationSec: b.durationSec ?? estimateNarrationDurationSec(b.narration),
            }))
          : args.text
            ? [
                {
                  label: "Locución",
                  narration: args.text,
                  suggestedDurationSec: estimateNarrationDurationSec(args.text),
                },
              ]
            : [];
      if (blocks.length === 0) {
        throw new HttpError(422, "Debes indicar 'text' o 'blocks' para generar locución.", "missing_narration");
      }

      const mediaDir = projectMediaDirectory(context.projectId);
      const fileName = `voice_${Date.now()}.wav`;
      const destPath = path.join(mediaDir, fileName);
      const speech = await synthesizeSceneSpeechTracks({
        mediaDir,
        destinationPath: destPath,
        blocks,
        language: args.language ?? "es",
        voiceHint: args.voiceHint,
        alignToBlockDurations: args.alignToBlockDurations,
        allowNetworkTts: true,
        signal: context.signal,
      });

      const stat = await fs.stat(destPath);
      const voiceAsset: MediaAsset = {
        id: newId("med"),
        name: `Voz IA (${speech.provider})`,
        kind: "audio",
        file: `media/${fileName}`,
        mimeType: "audio/wav",
        sizeBytes: stat.size,
        durationUs: Math.round(speech.totalDurationSec * 1_000_000),
        audioCodec: "pcm_s16le",
        sampleRate: 48000,
        channels: 1,
        thumbnail: "pending",
        waveform: "none",
        proxy: "none",
        importedAt: new Date().toISOString(),
        origin: "generated",
      };

      let current = touchProject({
        ...context.project,
        media: [...context.project.media, voiceAsset],
      });
      let voiceTrack = current.tracks.find((t) => t.kind === "audio" && /voz|voice|a1/i.test(t.name));
      if (!voiceTrack) {
        const added = addTrack(current, "audio", "Voz IA");
        if (!added.ok || !added.track) throw new HttpError(500, "No se pudo crear pista de Voz IA.");
        current = added.project;
        voiceTrack = added.track;
      }

      const fps = current.settings.fps.num / Math.max(1, current.settings.fps.den);
      const desiredStart = Math.round((args.startSeconds ?? 0) * fps);
      const durFrames = Math.max(12, Math.round(speech.totalDurationSec * fps));
      const startFrame = findFreeStartFrame(voiceTrack, desiredStart, durFrames);
      const voiceClip: MediaClip = {
        ...makeMediaClip(current, voiceAsset, {
          startFrame,
          durationFrames: durFrames,
          createdBy: "agent",
        }),
        name: `Voz IA · ${speech.provider}`,
        volume: 1.0,
      };
      const addVoice = addClip(current, voiceTrack.id, voiceClip);
      if (!addVoice.ok) throw new HttpError(422, addVoice.error, "voice_clip_failed");
      current = addVoice.project;

      let subsAdded = 0;
      let subtitleCuesCount = 0;
      if (args.addSubtitles) {
        const textTrack = firstTextTrack(current);
        let subTrackId = textTrack?.id;
        if (!subTrackId) {
          const addedText = addTrack(current, "text", "T1");
          if (!addedText.ok || !addedText.track) throw new HttpError(500, "No se pudo crear pista T1.");
          current = addedText.project;
          subTrackId = addedText.track.id;
        }
        // Limpiar subtítulos de voz previos generados por el agente para evitar solapes
        current = {
          ...current,
          tracks: current.tracks.map((t) =>
            t.id === subTrackId
              ? {
                  ...t,
                  clips: t.clips.filter(
                    (c) =>
                      !(
                        c.type === "text" &&
                        c.createdBy === "agent" &&
                        (c.role === "subtitle" || /subtitles/i.test(c.remotion?.componentName ?? ""))
                      ),
                  ),
                }
              : t,
          ),
        };

        try {
          const { buildCaptionCues } = await import("../motion-agent/subtitles.js");
          const { buildSubtitleComponentCode } = await import("../../src/shared/motionTemplates.js");
          const syntheticSegments = speech.segments.map((seg, idx) => ({
            id: idx,
            startUs: Math.round(seg.startSec * 1_000_000),
            endUs: Math.round((seg.startSec + Math.max(0.25, seg.spokenDurationSec || seg.durationSec)) * 1_000_000),
            text: seg.narration,
          }));
          const captions = buildCaptionCues(syntheticSegments, {
            clip: voiceClip,
            clips: [voiceClip],
            asset: voiceAsset,
            startFrame: voiceClip.startFrame,
            durationFrames: voiceClip.durationFrames,
            fps,
          });
          if (captions.length > 0) {
            const subStyle = args.subtitleStyle ?? "karaoke";
            const subGenerated = buildSubtitleComponentCode(subStyle, "VoiceoverKaraokeSubtitles");
            const previewText = captions
              .slice(0, 3)
              .map((c) => c.words.map((w) => w.text).join(" "))
              .join(" · ")
              .slice(0, 80);
            const karaokeClip = makeTextClip({
              name: `Subtítulos Karaoke (${subStyle})`,
              text: previewText || "Subtítulos sincronizados",
              startFrame: voiceClip.startFrame,
              durationFrames: voiceClip.durationFrames,
              role: "subtitle",
              createdBy: "agent",
              sourceMediaId: voiceAsset.id,
              position: { x: 0.5, y: 0.8 },
              fontSize: 54,
              fontWeight: 700,
              color: "#FFFFFF",
              background: false,
              backgroundOpacity: 0,
              remotion: {
                compositionId: `subs_voiceover_${subStyle}`,
                componentName: subGenerated.componentName,
                code: subGenerated.code,
                props: {
                  captions,
                  accentColor: "#38BDF8",
                  textColor: "#FFFFFF",
                  positionY: 0.8,
                } as Record<string, unknown>,
                styleId: subStyle,
                live: true,
              },
            });
            const addSub = addClip(current, subTrackId, karaokeClip);
            if (addSub.ok) {
              current = addSub.project;
              subtitleCuesCount = captions.length;
              subsAdded = captions.length;
            }
          }
        } catch (karaokeErr) {
          console.warn("[Tools] Error generando subtítulos karaoke desde voz; usando respaldo:", karaokeErr);
        }

        if (subsAdded === 0) {
          for (const seg of speech.segments) {
            const segStartFrame = startFrame + Math.round(seg.startSec * fps);
            const segDurFrames = Math.max(6, Math.round(seg.durationSec * fps));
            const subRes = addTextClip(current, subTrackId, {
              text: wrapText(seg.narration, 26),
              startFrame: segStartFrame,
              durationFrames: segDurFrames,
              role: "subtitle",
              createdBy: "agent",
              sourceMediaId: voiceAsset.id,
              position: { x: 0.5, y: 0.78 },
              fontSize: 44,
              backgroundColor: "#090D18",
              backgroundOpacity: 0.78,
              color: "#FFFFFF",
            });
            if (subRes.ok) {
              current = subRes.project;
              subsAdded += 1;
            }
          }
        }
      }

      const usedReal = speech.usedRealTts;
      const warnings = usedReal
        ? []
        : [
            "No hay motor TTS neuronal configurado (OPENAI_API_KEY / edge-tts / Windows SAPI); se generó pista de sincronía procedural de respaldo.",
          ];

      return {
        status: usedReal ? "verified" : "fallback",
        warnings,
        verification: {
          checks: [
            { name: "voice_wav_generated", passed: stat.size > 44, detail: `${speech.totalDurationSec.toFixed(2)}s (${speech.provider})` },
          ],
          evidence: [destPath],
        },
        summary: `Locución (${speech.provider}) añadida: ${speech.totalDurationSec.toFixed(2)}s${subsAdded > 0 ? ` con ${subsAdded} cue(s) de subtítulos karaoke sincronizados` : ""}.`,
        project: current,
        data: {
          mediaId: voiceAsset.id,
          clipId: voiceClip.id,
          provider: speech.provider,
          usedRealTts: usedReal,
          durationSeconds: speech.totalDurationSec,
          subtitlesAdded: subsAdded,
          subtitleCuesCount,
          segments: speech.segments,
          status: usedReal ? "verified" : "fallback",
        },
      };
    },
  },
  {
    name: "add_background_music",
    description:
      "Genera e inserta música de fondo adaptada al tono (`cinema` | `tech` | `ambient` | `energetic`) con atenuación (ducking) automática bajo la voz.",
    argsHint: '{ "mood"?: "cinema"|"tech"|"ambient"|"energetic", "durationSeconds"?: number }',
    risk: "low",
    argsSchema: z.object({
      mood: z.enum(["cinema", "tech", "ambient", "energetic"]).optional(),
      durationSeconds: z.number().min(3).max(300).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          mood: z.enum(["cinema", "tech", "ambient", "energetic"]).optional(),
          durationSeconds: z.number().min(3).max(300).optional(),
        })
        .parse(rawArgs);
      const { ensureProceduralMusicBedAsset } = await import("../services/sfxService");
      const { applyDuckedMusicBedTrack } = await import("./audioDirector");

      const fps = context.project.settings.fps.num / Math.max(1, context.project.settings.fps.den);
      const currentDurFrames = timelineDurationFrames(context.project);
      const targetDurSec = Math.max(
        4,
        args.durationSeconds ?? framesToSeconds(Math.max(currentDurFrames, Math.round(fps * 12)), context.project.settings.fps),
      );
      const mood = args.mood ?? "tech";
      const musicAsset = await ensureProceduralMusicBedAsset(context.projectId, targetDurSec, mood, context.signal);

      let workingProject = touchProject({
        ...context.project,
        media: context.project.media.some((m) => m.id === musicAsset.id)
          ? context.project.media
          : [...context.project.media, musicAsset],
      });
      const hasSpeech = workingProject.tracks.some(
        (t) => t.kind === "audio" && /voz|voice|a1/i.test(t.name) && t.clips.length > 0,
      );
      const totalFrames = Math.max(currentDurFrames, Math.round(targetDurSec * fps));
      workingProject = applyDuckedMusicBedTrack({
        project: workingProject,
        musicAsset,
        totalTimelineFrames: totalFrames,
        fps,
        hasSpeechInTimeline: hasSpeech,
      });

      return {
        status: "verified",
        summary: `Cama musical (${mood}, ${targetDurSec.toFixed(1)}s) añadida con ${hasSpeech ? "ducking automático bajo voz" : "mezcla equilibrada"}.`,
        project: workingProject,
        data: { mediaId: musicAsset.id, mood, durationSeconds: targetDurSec, duckedUnderSpeech: hasSpeech },
      };
    },
  },
  {
    name: "add_sound_effect",
    description:
      "Inserta un efecto de sonido integrado (`whoosh`, `pop`, `ding`, `riser`, `subhit`, `glitch`) en la pista SFX sincronizado con `startSeconds`.",
    argsHint: '{ "type": "whoosh"|"pop"|"ding"|"riser"|"subhit"|"glitch", "startSeconds": number, "volume"?: number }',
    risk: "low",
    argsSchema: z.object({
      type: z.enum(["whoosh", "pop", "ding", "riser", "subhit", "glitch"]),
      startSeconds: z.number().min(0),
      volume: z.number().min(0.05).max(1.5).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          type: z.enum(["whoosh", "pop", "ding", "riser", "subhit", "glitch"]),
          startSeconds: z.number().min(0),
          volume: z.number().min(0.05).max(1.5).optional(),
        })
        .parse(rawArgs);
      const { ensureProjectSfxAsset } = await import("../services/sfxService");
      const { ensureSfxTrack } = await import("../../src/shared/timeline");

      const asset = await ensureProjectSfxAsset(context.projectId, args.type);
      let current = touchProject({
        ...context.project,
        media: context.project.media.some((m) => m.id === asset.id)
          ? context.project.media
          : [...context.project.media, asset],
      });
      const sfxRes = ensureSfxTrack(current);
      current = sfxRes.project;
      const fps = current.settings.fps.num / Math.max(1, current.settings.fps.den);
      const durFrames = Math.max(1, Math.round((asset.durationUs / 1_000_000) * fps));
      const startFrame = findFreeStartFrame(sfxRes.track, Math.round(args.startSeconds * fps), durFrames);
      const clip: MediaClip = {
        ...makeMediaClip(current, asset, { startFrame, durationFrames: durFrames, createdBy: "agent" }),
        name: `SFX ${args.type.toUpperCase()}`,
        volume: args.volume ?? 0.75,
      };
      const added = addClip(current, sfxRes.track.id, clip);
      if (!added.ok) throw new HttpError(422, added.error, "sfx_insert_failed");
      current = added.project;
      return {
        status: "verified",
        summary: `Efecto "${args.type}" insertado en ${(startFrame / fps).toFixed(2)}s.`,
        project: current,
        data: { clipId: clip.id, mediaId: asset.id, type: args.type, startSeconds: startFrame / fps },
      };
    },
  },
  {
    name: "set_brand_kit",
    description:
      "Guarda identidad de marca del proyecto (colores primario/secundario/fondo/texto, tipografías, logo, tono y CTA por defecto).",
    argsHint: '{ "brandName"?: string, "primaryColor"?: "#RRGGBB", "secondaryColor"?: "#RRGGBB", "surfaceColor"?: "#RRGGBB", "textColor"?: "#RRGGBB", "headingFont"?: string, "bodyFont"?: string, "ctaDefault"?: string, "tone"?: string }',
    risk: "low",
    argsSchema: z.object({
      brandName: z.string().max(120).optional(),
      tagline: z.string().max(240).optional(),
      logoUrlOrMediaId: z.string().max(240).optional(),
      primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      surfaceColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      headingFont: z.string().max(80).optional(),
      bodyFont: z.string().max(80).optional(),
      tone: z.string().max(120).optional(),
      ctaDefault: z.string().max(120).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          brandName: z.string().max(120).optional(),
          tagline: z.string().max(240).optional(),
          logoUrlOrMediaId: z.string().max(240).optional(),
          primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
          secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
          surfaceColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
          textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
          headingFont: z.string().max(80).optional(),
          bodyFont: z.string().max(80).optional(),
          tone: z.string().max(120).optional(),
          ctaDefault: z.string().max(120).optional(),
        })
        .parse(rawArgs);
      const saved = await projectStore.saveBrandKit(context.projectId, args);
      return {
        status: "verified",
        summary: `Brand Kit actualizado${saved.brandName ? ` para "${saved.brandName}"` : ""} (${saved.primaryColor} / ${saved.surfaceColor}).`,
        data: saved,
      };
    },
  },
  {
    name: "get_brand_kit",
    description: "Devuelve el Brand Kit configurado en el proyecto (colores, fuentes, logo y tono).",
    argsHint: "{}",
    risk: "low",
    argsSchema: z.object({}),
    execute: async (context, rawArgs) => {
      z.object({}).parse(rawArgs);
      const kit = await projectStore.readBrandKit(context.projectId);
      return {
        status: "verified",
        summary: kit
          ? `Brand Kit activo: ${kit.brandName ?? "Sin nombre"} (${kit.primaryColor}, ${kit.headingFont}).`
          : "El proyecto no tiene Brand Kit configurado todavía.",
        data: kit,
      };
    },
  },
  {
    name: "import_media_from_url",
    description:
      "Descarga de forma segura un recurso multimedia (vídeo, audio o imagen) desde una URL HTTP/HTTPS pública e lo importa al proyecto con validación SSRF y tamaño máximo.",
    argsHint: '{ "url": "https://...", "name"?: string }',
    risk: "low",
    argsSchema: z.object({
      url: z.string().url().max(2048),
      name: z.string().min(1).max(255).optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          url: z.string().url().max(2048),
          name: z.string().min(1).max(255).optional(),
        })
        .parse(rawArgs);
      const parsedUrl = new URL(args.url);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new HttpError(422, "Solo se admiten URLs http:// o https://.", "unsupported_url_protocol");
      }

      const allowLocal = process.env.NOVACUT_ALLOW_LOCAL_URLS === "1";
      const isPrivateIp = (ip: string): boolean => {
        if (net.isIP(ip) === 4) {
          const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
          const [a = 0, b = 0] = parts;
          return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127)
          );
        }
        if (net.isIP(ip) === 6) {
          const lower = ip.toLowerCase();
          return lower === "::1" || lower === "::" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
        }
        return false;
      };

      const hostname = parsedUrl.hostname.toLowerCase();
      if (!allowLocal) {
        if (
          hostname === "localhost" ||
          hostname.endsWith(".local") ||
          hostname.endsWith(".internal") ||
          isPrivateIp(hostname)
        ) {
          throw new HttpError(403, "URL privada o interna rechazada por seguridad SSRF.", "ssrf_blocked");
        }
        const resolved = await dns.lookup(hostname, { all: true }).catch(() => []);
        if (resolved.some((entry) => isPrivateIp(entry.address))) {
          throw new HttpError(403, "La IP resuelta apunta a una red privada o metadata interna.", "ssrf_blocked");
        }
      }

      const response = await fetch(parsedUrl.toString(), {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]),
      });
      if (!response.ok) {
        throw new HttpError(502, `No se pudo descargar la URL (HTTP ${response.status}).`, "url_download_failed");
      }

      const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const maxBytes = Math.min(config.maxUploadBytes, 300 * 1024 * 1024);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new HttpError(413, "El archivo remoto excede el límite máximo permitido.", "remote_file_too_large");
      }

      const extFromMime: Record<string, string> = {
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "audio/aac": ".m4a",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
      };

      const urlBase = path.basename(parsedUrl.pathname || "");
      const guessedExt = path.extname(urlBase).toLowerCase() || extFromMime[contentType] || ".mp4";
      const fileName =
        args.name?.trim() ||
        (urlBase && path.extname(urlBase) ? urlBase : `remote-${newId("med")}${guessedExt}`);

      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength === 0) throw new HttpError(400, "El archivo remoto está vacío.", "empty_remote_file");
      if (buf.byteLength > maxBytes) {
        throw new HttpError(413, "El archivo remoto excede el límite máximo permitido.", "remote_file_too_large");
      }

      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-url-import-"));
      const tempFile = path.join(workDir, `download${guessedExt}`);
      try {
        await fs.writeFile(tempFile, buf);
        const { importMediaFile } = await import("../media/import");
        const asset = await importMediaFile(context.projectId, tempFile, fileName);
        const latest = await projectStore.get(context.projectId);
        return {
          status: "verified",
          summary: `Recurso "${asset.name}" descargado e importado (${asset.kind}, ${(asset.durationUs / 1_000_000).toFixed(2)}s).`,
          project: latest.project,
          data: { asset, sourceUrl: args.url, revision: latest.project.revision },
        };
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  },
  {
    name: "get_run_trace",
    description:
      "Devuelve la traza estructurada de ejecución de la última corrida del Director en el proyecto (fases, modelo/fallback de IA, TTS, concurrencia, tiempos, bitrate y checks QA).",
    argsHint: "{}",
    risk: "low",
    argsSchema: z.object({}),
    execute: async (context, rawArgs) => {
      z.object({}).parse(rawArgs);
      const trace = await projectStore.readRunTrace(context.projectId);
      return {
        status: trace ? "verified" : "unverified",
        summary: trace
          ? `Traza recuperada (${String(trace.status ?? "ok")}, ${Array.isArray(trace.phases) ? trace.phases.length : 0} fases).`
          : "Este proyecto aún no tiene traza registrada de ejecución del Director.",
        data: { trace },
      };
    },
  },
  {
    name: "ask_director",
    description:
      "Invoca al Agente Director autónomo de OECLIP: interpreta peticiones en lenguaje natural, carga skills, planifica escenas con textos literales intactos, crea escenas/voz/música/SFX, inspecciona fotogramas con QA y corrige hasta verificar.",
    argsHint: '{ "request": string, "autonomy"?: "assisted"|"semi"|"autonomous", "exportOnComplete"?: boolean, "strict"?: boolean, "allowFallback"?: boolean, "quality"?: "draft"|"standard"|"high", "storyboard"?: object }',
    risk: "medium",
    argsSchema: z.object({
      request: z.string().min(3).max(8000),
      autonomy: z.enum(["assisted", "semi", "autonomous"]).optional(),
      exportOnComplete: z.boolean().optional(),
      allowFallback: z.boolean().optional(),
      strict: z.boolean().optional(),
      quality: z.enum(["draft", "standard", "high"]).optional(),
      storyboard: z.unknown().optional(),
    }),
    execute: async (context, rawArgs) => {
      const args = z
        .object({
          request: z.string().min(3).max(8000),
          autonomy: z.enum(["assisted", "semi", "autonomous"]).optional(),
          exportOnComplete: z.boolean().optional(),
          allowFallback: z.boolean().optional(),
          strict: z.boolean().optional(),
          quality: z.enum(["draft", "standard", "high"]).optional(),
          storyboard: z.unknown().optional(),
        })
        .parse(rawArgs);
      const { runDirectorAgent } = await import("./directorAgent");
      const out = await runDirectorAgent({
        projectId: context.projectId,
        request: args.request,
        autonomy: args.autonomy ?? "autonomous",
        exportOnComplete: args.exportOnComplete ?? false,
        strict: args.strict,
        allowFallback: args.strict ? false : args.allowFallback,
        quality: args.quality,
        storyboard: args.storyboard as Parameters<typeof runDirectorAgent>[0]["storyboard"],
        signal: context.signal,
        onProgress: (p, msg) => context.setProgress(p, msg),
      });
      return {
        status: out.status,
        warnings: out.warnings,
        verification: out.verification,
        summary: out.summary,
        data: out,
      };
    },
  },
  runSkillTool,
  listSkillsTool,
  getSkillTool,
  createSkillTool,
];

const byName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition {
  const tool = byName.get(name);
  if (!tool) throw new HttpError(400, `Herramienta desconocida: ${name}.`, "unknown_tool");
  return tool;
}

export function toolCatalog(): string {
  return toolDefinitions
    .map(
      (tool) =>
        `- ${tool.name} (riesgo ${tool.risk}): ${tool.description} Argumentos: ${tool.argsHint}`,
    )
    .join("\n");
}

export function validateToolArgs(name: string, args: unknown): {
  ok: true;
  data: unknown;
  definition: ToolDefinition;
} | {
  ok: false;
  error: string;
} {
  try {
    const definition = getTool(name);
    const parsed = definition.argsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
      };
    }
    return { ok: true, data: parsed.data, definition };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
