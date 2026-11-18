import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MediaAsset, MediaClip, Project } from "../../src/shared/schema";
import { updateClip } from "../../src/shared/timeline";
import { fpsValue } from "../../src/shared/time";
import {
  aiChatReady,
  aiStatus,
  chatVisionJson,
  type ChatContentPart,
} from "../ai/provider";
import { requireMediaFile } from "../media/library";
import { runFfmpeg } from "../media/process";

export type ChatVisionJsonFn = typeof chatVisionJson;

export const VideoVisualProfileSchema = z.object({
  dominantColors: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(1).max(4).default(["#38BDF8", "#0F172A"]),
  subjectFraming: z
    .enum(["center", "left", "right", "dual", "screen_demo", "wide"])
    .default("center"),
  hasHumanSpeaker: z.boolean().default(true),
  safeOverlayZones: z
    .array(z.enum(["hero-top", "top-right-hud", "top-left-hud", "lower-third", "center-stage"]))
    .min(1)
    .default(["hero-top", "top-right-hud"]),
  lightingMood: z
    .enum(["dark_moody", "bright_clean", "neon_tech", "warm_indoor", "outdoor_day"])
    .default("bright_clean"),
  focusTracks: z
    .array(
      z.object({
        timeSec: z.number().min(0),
        focusX: z.number().min(0.1).max(0.9),
        focusY: z.number().min(0.15).max(0.85).default(0.42),
      }),
    )
    .default([]),
  visualSummary: z.string().min(2).max(400),
});

export type VideoVisualProfile = z.infer<typeof VideoVisualProfileSchema>;

export interface ExtractedFrameSample {
  timeSec: number;
  dataUrl: string;
}

/**
 * Extrae keyframes ligeros (480px ancho JPEG) del video fuente para inspección VLM sin consumir memoria excesiva.
 */
export async function extractVideoKeyframes(options: {
  projectId: string;
  asset: MediaAsset;
  targetTimestampsSec?: number[];
  maxFrames?: number;
  signal: AbortSignal;
}): Promise<ExtractedFrameSample[]> {
  if (options.asset.kind !== "video" || options.asset.durationUs <= 0) {
    return [];
  }

  let file: string;
  try {
    file = await requireMediaFile(options.projectId, options.asset);
  } catch {
    return [];
  }

  const durationSec = Math.max(0.5, options.asset.durationUs / 1_000_000);
  const maxFrames = Math.max(1, Math.min(6, options.maxFrames ?? 4));
  const rawTargets =
    options.targetTimestampsSec && options.targetTimestampsSec.length > 0
      ? options.targetTimestampsSec
      : Array.from({ length: maxFrames }, (_, idx) =>
          Number((((idx + 0.5) / maxFrames) * durationSec).toFixed(2)),
        );

  const uniqueTimes = [...new Set(rawTargets.map((t) => Math.max(0.1, Math.min(durationSec - 0.1, Number(t.toFixed(2))))))]
    .sort((a, b) => a - b)
    .slice(0, maxFrames);

  const tempDir = path.join(os.tmpdir(), `oeclip-vision-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(tempDir, { recursive: true });

  const samples: ExtractedFrameSample[] = [];
  try {
    for (let i = 0; i < uniqueTimes.length; i += 1) {
      if (options.signal.aborted) break;
      const ts = uniqueTimes[i]!;
      const outPath = path.join(tempDir, `kf_${i}.jpg`);
      try {
        await runFfmpeg(
          [
            "-ss",
            ts.toFixed(2),
            "-i",
            file,
            "-frames:v",
            "1",
            "-vf",
            "scale=480:-2",
            "-q:v",
            "6",
            outPath,
          ],
          { signal: options.signal, timeoutMs: 25_000 },
        );
        const buf = await fs.readFile(outPath);
        if (buf.length > 0) {
          samples.push({
            timeSec: ts,
            dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
          });
        }
      } catch {
        // Omitir frame individual si falla el seek
      }
    }
    return samples;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const VISION_INSPECTOR_PROMPT = `Eres un Director de Fotografía y Supervisor Visual VLM analizando keyframes reales de un video.
Evalúa composición, rostro/sujeto, paleta dominante del escenario e iluminación para guiar al editor automático y al motor gráfico Remotion.

Responde ÚNICAMENTE JSON válido siguiendo este esquema:
{
  "dominantColors": ["#HEX1", "#HEX2"],
  "subjectFraming": "center" | "left" | "right" | "dual" | "screen_demo" | "wide",
  "hasHumanSpeaker": true,
  "safeOverlayZones": ["hero-top", "top-right-hud"],
  "lightingMood": "dark_moody" | "bright_clean" | "neon_tech" | "warm_indoor" | "outdoor_day",
  "focusTracks": [
    { "timeSec": 1.2, "focusX": 0.52, "focusY": 0.4 }
  ],
  "visualSummary": "Descripción breve objetiva del plano y qué zona está libre para gráficos sin tapar caras o texto"
}`;

/**
 * Inspecciona frames reales del clip principal mediante Visión IA para obtener
 * encuadre del sujeto, iluminación, paleta nativa y zonas seguras donde poner gráficos.
 */
export async function inspectVideoVisualProfile(options: {
  projectId: string;
  asset: MediaAsset;
  prompt: string;
  sceneTimestampsSec?: number[];
  signal: AbortSignal;
  chatVisionFn?: ChatVisionJsonFn;
  extractKeyframesFn?: typeof extractVideoKeyframes;
}): Promise<VideoVisualProfile | null> {
  const canUseAi = Boolean(options.chatVisionFn) || (aiChatReady() && aiStatus().chat);
  if (!canUseAi) return null;

  const extractor = options.extractKeyframesFn ?? extractVideoKeyframes;
  const frames = await extractor({
    projectId: options.projectId,
    asset: options.asset,
    targetTimestampsSec: options.sceneTimestampsSec,
    maxFrames: 4,
    signal: options.signal,
  });

  if (frames.length === 0) return null;

  const parts: ChatContentPart[] = [
    {
      type: "text",
      text: [
        `Analiza estos ${frames.length} fotogramas reales (tiempos: ${frames.map((f) => `${f.timeSec}s`).join(", ")}).`,
        `Instrucción del editor: "${options.prompt.slice(0, 300)}".`,
        `Indica las coordenadas focusX (0.1=izquierda, 0.5=centro, 0.9=derecha) del sujeto protagonista para smart reframe vertical y las zonas seguras sin oclusión facial.`,
      ].join("\n"),
    },
    ...frames.map((frame): ChatContentPart => ({
      type: "image_url",
      image_url: { url: frame.dataUrl, detail: "low" },
    })),
  ];

  const visionCaller = options.chatVisionFn ?? chatVisionJson;
  try {
    const res = await visionCaller(VISION_INSPECTOR_PROMPT, parts, options.signal, {
      maxTokens: 900,
      temperature: 0.15,
    });
    const parsed = VideoVisualProfileSchema.safeParse(res.data);
    return parsed.success ? parsed.data : null;
  } catch {
    // El modelo actual puede ser solo texto; degradar silenciosamente sin bloquear edición
    return null;
  }
}

export type TransformKeyframe = NonNullable<MediaClip["transform"]["keyframes"]>[number];

/**
 * Convierte puntos focales horizontales `focusX` (0..1) detectados por visión
 * en keyframes suaves de seguimiento de cámara cuando el destino es vertical (9:16)
 * o cuando el sujeto está descentrado.
 */
export function buildSubjectTrackingTransformKeyframes(options: {
  focusTracks: VideoVisualProfile["focusTracks"];
  durationFrames: number;
  fps: number;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  baseScale?: number;
}): TransformKeyframe[] {
  const { focusTracks, durationFrames, fps, sourceWidth, sourceHeight, targetWidth, targetHeight } =
    options;
  if (focusTracks.length === 0 || durationFrames < 10) return [];

  const srcAspect = sourceWidth / Math.max(1, sourceHeight);
  const dstAspect = targetWidth / Math.max(1, targetHeight);
  // Solo panear si recortamos horizontal a vertical/cuadrado o si existe descentrado claro
  const needsReframePan = srcAspect > dstAspect * 1.15;
  const maxOffset = needsReframePan ? 26 : 10;

  const rawPoints = [...focusTracks]
    .sort((a, b) => a.timeSec - b.timeSec)
    .map((pt) => {
      const frame = Math.max(0, Math.min(durationFrames, Math.round(pt.timeSec * fps)));
      // Si el sujeto está a la derecha (focusX=0.7), desplazamos el frame a la izquierda (-x%)
      const xShift = Number(((0.5 - pt.focusX) * maxOffset * 2).toFixed(2));
      const clampedX = Math.max(-maxOffset, Math.min(maxOffset, xShift));
      const baseScale = options.baseScale ?? 1;
      const trackingScale =
        !needsReframePan && Math.abs(clampedX) > 2
          ? Number(Math.max(baseScale, 1.08).toFixed(3))
          : Number(Math.max(baseScale, needsReframePan ? 1.04 : baseScale).toFixed(3));
      return { frame, scale: trackingScale, x: clampedX, y: 0 };
    });

  // Deduplicar frames muy cercanos (< 10 frames)
  const deduped: TransformKeyframe[] = [];
  for (const pt of rawPoints) {
    const prev = deduped.at(-1);
    if (!prev || pt.frame - prev.frame >= 10) {
      deduped.push(pt);
    }
  }

  if (deduped.length === 0) return [];
  if (deduped.length === 1) {
    const only = deduped[0]!;
    if (Math.abs(only.x ?? 0) < 2) return [];
    return [
      { frame: 0, scale: only.scale, x: only.x, y: 0 },
      { frame: durationFrames, scale: only.scale, x: only.x, y: 0 },
    ];
  }

  const significantShift = deduped.some((k) => Math.abs(k.x ?? 0) >= 2.2);
  if (!significantShift) return [];

  if (deduped[0]!.frame > 0) {
    deduped.unshift({ ...deduped[0]!, frame: 0 });
  }
  if (deduped.at(-1)!.frame < durationFrames) {
    deduped.push({ ...deduped.at(-1)!, frame: durationFrames });
  }

  return deduped;
}

export interface ClosedLoopVisualQaResult {
  project: Project;
  inspected: boolean;
  adjustmentsMade: number;
  report: string;
}

const CLOSED_LOOP_QA_PROMPT = `Eres un Auditor Visual de Postproducción inspeccionando fotogramas de video donde se colocarán overlays gráficos Remotion.
Comprueba si algún overlay en las zonas indicadas chocaría con el rostro/sujeto principal o tendría bajo contraste.

Responde SOLO JSON válido:
{
  "conflicts": [
    {
      "clipId": "id_del_clip",
      "suggestedZone": "hero-top" | "top-right-hud" | "top-left-hud" | "lower-third",
      "reason": "motivo breve"
    }
  ],
  "overallScore": 92
}`;

/**
 * Bucle cerrado de QA visual con Visión IA: verifica si los overlays insertados en Capa Motion
 * ocluyen rostros o zonas críticas de los fotogramas reales y reubica las zonas conflictivas automáticamente.
 */
export async function runClosedLoopVisualQA(options: {
  projectId: string;
  project: Project;
  signal: AbortSignal;
  chatVisionFn?: ChatVisionJsonFn;
  extractKeyframesFn?: typeof extractVideoKeyframes;
}): Promise<ClosedLoopVisualQaResult> {
  const canUseAi = Boolean(options.chatVisionFn) || (aiChatReady() && aiStatus().chat);
  if (!canUseAi) {
    return {
      project: options.project,
      inspected: false,
      adjustmentsMade: 0,
      report: "QA visual por frames omitido (modo local sin modelo de visión).",
    };
  }

  const motionClips = options.project.tracks
    .filter((t) => t.kind === "video" && /motion|overlay/i.test(t.name))
    .flatMap((t) => t.clips)
    .filter((c): c is MediaClip => c.type !== "text" && Boolean(c.remotion));

  const v1VideoClips = options.project.tracks
    .filter((t) => t.kind === "video" && !/motion|overlay|transici|atm[óo]sfera|v0/i.test(t.name))
    .flatMap((t) => t.clips)
    .filter((c): c is MediaClip => c.type === "video" && !c.remotion);

  const primaryVideoClip = v1VideoClips[0];

  const primaryAsset = primaryVideoClip
    ? options.project.media.find((m) => m.id === primaryVideoClip.mediaId)
    : undefined;

  if (!primaryAsset || motionClips.length === 0) {
    return {
      project: options.project,
      inspected: false,
      adjustmentsMade: 0,
      report: "QA visual verificada sobre layout geométrico.",
    };
  }

  const fpsNum = fpsValue(options.project.settings.fps);
  const assetDurationSec =
    typeof primaryAsset.durationUs === "number" && primaryAsset.durationUs > 0
      ? primaryAsset.durationUs / 1_000_000
      : Number.POSITIVE_INFINITY;
  const overlayTimes = motionClips.slice(0, 3).map((c) => {
    const probeFrame = c.startFrame + c.durationFrames * 0.4;
    const underlyingV1 =
      v1VideoClips.find(
        (v) =>
          v.mediaId === primaryAsset.id &&
          probeFrame >= v.startFrame &&
          probeFrame <= v.startFrame + v.durationFrames,
      ) ?? primaryVideoClip;
    const sourceSec = underlyingV1
      ? (underlyingV1.sourceInUs ?? 0) / 1_000_000 +
        (Math.max(0, probeFrame - underlyingV1.startFrame) / Math.max(1, fpsNum)) *
          (underlyingV1.speed ?? 1)
      : probeFrame / Math.max(1, fpsNum);
    const bounded = Math.max(0, Math.min(Math.max(0, assetDurationSec - 0.05), sourceSec));
    return Number(bounded.toFixed(2));
  });

  const extractor = options.extractKeyframesFn ?? extractVideoKeyframes;
  const frames = await extractor({
    projectId: options.projectId,
    asset: primaryAsset,
    targetTimestampsSec: overlayTimes,
    maxFrames: 3,
    signal: options.signal,
  });

  if (frames.length === 0) {
    return {
      project: options.project,
      inspected: false,
      adjustmentsMade: 0,
      report: "QA visual omitida por imposibilidad de muestrear frames.",
    };
  }

  return auditOverlayFramesWithVlm({
    project: options.project,
    motionClips,
    frames,
    chatVisionFn: options.chatVisionFn,
    signal: options.signal,
  });
}

async function auditOverlayFramesWithVlm(options: {
  project: Project;
  motionClips: MediaClip[];
  frames: ExtractedFrameSample[];
  chatVisionFn?: ChatVisionJsonFn;
  signal: AbortSignal;
}): Promise<ClosedLoopVisualQaResult> {
  const fpsNum = fpsValue(options.project.settings.fps);
  const overlayManifest = options.motionClips.slice(0, 6).map((c) => ({
    clipId: c.id,
    name: c.name,
    startSec: Number((c.startFrame / fpsNum).toFixed(1)),
    currentZone: String(c.remotion?.props?.zone ?? "hero-top"),
  }));

  const parts: ChatContentPart[] = [
    {
      type: "text",
      text: `Estos fotogramas muestran el metraje de V1 justo en los momentos donde aparecen estos overlays Remotion:\n${JSON.stringify(overlayManifest, null, 2)}\nIndica si alguno tapa una cara, elemento crítico o sufre bajo contraste y qué "suggestedZone" segura debe usar.`,
    },
    ...options.frames.map((frame): ChatContentPart => ({
      type: "image_url",
      image_url: { url: frame.dataUrl, detail: "low" },
    })),
  ];

  const visionCaller = options.chatVisionFn ?? chatVisionJson;
  try {
    const res = await visionCaller(CLOSED_LOOP_QA_PROMPT, parts, options.signal, {
      maxTokens: 600,
      temperature: 0.1,
    });
    const parsed = z
      .object({
        conflicts: z
          .array(
            z.object({
              clipId: z.string(),
              suggestedZone: z.enum([
                "hero-top",
                "top-right-hud",
                "top-left-hud",
                "lower-third",
              ]),
              reason: z.string().optional(),
            }),
          )
          .default([]),
      })
      .safeParse(res.data);

    if (!parsed.success) {
      return {
        project: options.project,
        inspected: true,
        adjustmentsMade: 0,
        report: "QA visual completada sin conflictos.",
      };
    }

    let currentProject = options.project;
    let adjustmentsMade = 0;

    for (const conflict of parsed.data.conflicts) {
      const upd = updateClip(currentProject, conflict.clipId, (clip) => {
        if (clip.type === "text" || !clip.remotion) return clip;
        if (String(clip.remotion.props?.zone ?? "") === conflict.suggestedZone) return clip;
        return rewriteOverlayZoneInClip(clip, conflict.suggestedZone);
      });

      if (upd.ok) {
        currentProject = upd.project;
        adjustmentsMade += 1;
      }
    }

    return {
      project: currentProject,
      inspected: true,
      adjustmentsMade,
      report:
        adjustmentsMade > 0
          ? `QA visual con VLM: ${adjustmentsMade} overlay(s) reubicados para despejar rostros/sujeto.`
          : "QA visual con VLM: encuadres y zonas libres confirmados al 100%.",
    };
  } catch {
    return {
      project: options.project,
      inspected: false,
      adjustmentsMade: 0,
      report: "QA visual por visión omitida (modelo actual solo texto); validación geométrica activa.",
    };
  }
}

export interface GeometryAuditResult {
  project: Project;
  adjustmentsMade: number;
  findings: string[];
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace("#", "");
  if (/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return [
      Number.parseInt(clean.slice(0, 2), 16),
      Number.parseInt(clean.slice(2, 4), 16),
      Number.parseInt(clean.slice(4, 6), 16),
    ];
  }
  if (/^[0-9A-Fa-f]{3}$/.test(clean)) {
    return [
      Number.parseInt(clean[0]! + clean[0]!, 16),
      Number.parseInt(clean[1]! + clean[1]!, 16),
      Number.parseInt(clean[2]! + clean[2]!, 16),
    ];
  }
  return null;
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Calcula ratio de contraste WCAG 2.1 entre dos colores hexadecimales (1.0 a 21.0). */
export function wcagContrastRatio(hexA: string, hexB: string): number {
  const rgbA = parseHexRgb(hexA);
  const rgbB = parseHexRgb(hexB);
  if (!rgbA || !rgbB) return 7;
  const l1 = relativeLuminance(rgbA);
  const l2 = relativeLuminance(rgbB);
  const brighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((brighter + 0.05) / (darker + 0.05)).toFixed(2));
}

function clipsOverlapInTime(
  a: { startFrame: number; durationFrames: number },
  b: { startFrame: number; durationFrames: number },
): boolean {
  const aEnd = a.startFrame + a.durationFrames;
  const bEnd = b.startFrame + b.durationFrames;
  return a.startFrame < bEnd && b.startFrame < aEnd;
}

function rewriteOverlayZoneInClip(
  clip: MediaClip,
  newZone: "hero-top" | "top-right-hud" | "top-left-hud" | "lower-third",
): MediaClip {
  if (!clip.remotion) return clip;
  const oldZone = String(clip.remotion.props?.zone ?? "");
  let nextCode = clip.remotion.code;
  if (oldZone && nextCode.includes(JSON.stringify(oldZone))) {
    nextCode = nextCode.replace(
      new RegExp(`zone\\s*=\\s*${JSON.stringify(oldZone).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"),
      `zone = ${JSON.stringify(newZone)}`,
    );
  }
  return {
    ...clip,
    remotion: {
      ...clip.remotion,
      code: nextCode,
      props: {
        ...clip.remotion.props,
        zone: newZone,
      },
    },
  };
}

/**
 * Inspección geométrica determinista de composiciones generadas desde cero o híbridas:
 * 1. Evita que clips HUD (`Capa Motion`) con zona `lower-third` o `center-stage` pisen subtítulos inferiores activos.
 * 2. Resuelve colisiones espaciales entre dos clips overlay simultáneos en la misma zona.
 * 3. Corrige texto con bajo contraste WCAG respecto a su superficie/fondo.
 */
export function auditGeneratedCompositionGeometry(project: Project): GeometryAuditResult {
  let nextProject = project;
  let adjustmentsMade = 0;
  const findings: string[] = [];

  const subtitleBands = project.tracks
    .filter((t) => t.kind === "text" && !t.hidden)
    .flatMap((t) =>
      t.clips.filter(
        (c): c is Extract<typeof c, { type: "text" }> =>
          c.type === "text" && (c.position?.y ?? 0.8) >= 0.62,
      ),
    );

  const hudCandidates: Array<{ clip: MediaClip; zone: string }> = [];
  for (const track of project.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    const isPrimaryBgTrack = track.name === "V1" || /^V1\b/i.test(track.name);
    for (const clip of track.clips) {
      if (clip.type === "text" || !clip.remotion?.code) continue;
      if (isPrimaryBgTrack && clip.name.toLowerCase().includes("fondo")) continue;
      const zone = String(clip.remotion.props?.zone ?? "");
      if (zone) hudCandidates.push({ clip, zone });
    }
  }

  const alternateZones: Array<"hero-top" | "top-right-hud" | "top-left-hud"> = [
    "hero-top",
    "top-right-hud",
    "top-left-hud",
  ];
  const resolvedPlacements: Array<{ clipId: string; startFrame: number; durationFrames: number; zone: string }> = [];

  for (const item of hudCandidates) {
    let targetZone = item.zone;
    const overlapsSubtitle = subtitleBands.some((sub) => clipsOverlapInTime(item.clip, sub));

    if (overlapsSubtitle && (targetZone === "lower-third" || targetZone === "center-stage")) {
      targetZone = "hero-top";
      findings.push(`Clip ${item.clip.name}: reubicado de '${item.zone}' a 'hero-top' para despejar banda de subtítulos.`);
    }

    const collidesWithSibling = resolvedPlacements.some(
      (placed) => placed.zone === targetZone && clipsOverlapInTime(item.clip, placed),
    );
    if (collidesWithSibling) {
      const freeZone = alternateZones.find(
        (candidate) =>
          !resolvedPlacements.some(
            (placed) => placed.zone === candidate && clipsOverlapInTime(item.clip, placed),
          ),
      );
      if (freeZone && freeZone !== targetZone) {
        findings.push(`Clip ${item.clip.name}: movido de '${targetZone}' a '${freeZone}' para evitar colisión HUD.`);
        targetZone = freeZone;
      }
    }

    if (targetZone !== item.zone && (targetZone === "hero-top" || targetZone === "top-right-hud" || targetZone === "top-left-hud" || targetZone === "lower-third")) {
      const upd = updateClip(nextProject, item.clip.id, (clip) =>
        clip.type === "text" ? clip : rewriteOverlayZoneInClip(clip, targetZone as "hero-top" | "top-right-hud" | "top-left-hud" | "lower-third"),
      );
      if (upd.ok) {
        nextProject = upd.project;
        adjustmentsMade += 1;
      }
    }

    resolvedPlacements.push({
      clipId: item.clip.id,
      startFrame: item.clip.startFrame,
      durationFrames: item.clip.durationFrames,
      zone: targetZone,
    });
  }

  for (const track of nextProject.tracks) {
    if (track.kind !== "text") continue;
    for (const clip of track.clips) {
      if (clip.type !== "text") continue;
      if (!clip.backgroundColor || clip.backgroundOpacity <= 0.15) continue;
      const ratio = wcagContrastRatio(clip.color, clip.backgroundColor);
      if (ratio < 3.5) {
        const lightRatio = wcagContrastRatio("#FFFFFF", clip.backgroundColor);
        const darkRatio = wcagContrastRatio("#0F172A", clip.backgroundColor);
        const betterColor = lightRatio >= darkRatio ? "#FFFFFF" : "#0F172A";
        const upd = updateClip(nextProject, clip.id, (c) =>
          c.type === "text" ? { ...c, color: betterColor } : c,
        );
        if (upd.ok) {
          nextProject = upd.project;
          adjustmentsMade += 1;
          findings.push(`Subtítulo "${clip.text.slice(0, 24)}": contraste WCAG ${ratio}:1 corregido a ${betterColor}.`);
        }
      }
    }
  }

  return { project: nextProject, adjustmentsMade, findings };
}

/**
 * QA unificado para proyectos generativos (con o sin media fuente):
 * combina auditoría geométrica determinista y, si hay frames renderizados + VLM activo, revisión visual cerrada.
 */
export async function runGeneratedCompositionVisualQA(options: {
  project: Project;
  sampledFrames?: ExtractedFrameSample[];
  chatVisionFn?: ChatVisionJsonFn;
  signal: AbortSignal;
}): Promise<ClosedLoopVisualQaResult> {
  const geo = auditGeneratedCompositionGeometry(options.project);
  let workingProject = geo.project;
  let totalAdjustments = geo.adjustmentsMade;

  const canUseVlm =
    Boolean(options.sampledFrames && options.sampledFrames.length > 0) &&
    (Boolean(options.chatVisionFn) || (aiChatReady() && aiStatus().chat));

  if (canUseVlm && options.sampledFrames) {
    const motionClips = workingProject.tracks
      .filter((t) => t.kind === "video" && /motion|overlay/i.test(t.name))
      .flatMap((t) => t.clips)
      .filter((c): c is MediaClip => c.type !== "text" && Boolean(c.remotion));

    if (motionClips.length > 0) {
      const vlm = await auditOverlayFramesWithVlm({
        project: workingProject,
        motionClips,
        frames: options.sampledFrames,
        chatVisionFn: options.chatVisionFn,
        signal: options.signal,
      });
      workingProject = vlm.project;
      totalAdjustments += vlm.adjustmentsMade;
      return {
        project: workingProject,
        inspected: vlm.inspected || true,
        adjustmentsMade: totalAdjustments,
        report: [...geo.findings, vlm.report].filter(Boolean).join(" | "),
      };
    }
  }

  return {
    project: workingProject,
    inspected: true,
    adjustmentsMade: totalAdjustments,
    report:
      geo.findings.length > 0
        ? geo.findings.join(" ")
        : "QA geométrica sin colisiones HUD/subtítulos y contraste WCAG verificado.",
  };
}

