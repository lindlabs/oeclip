import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import type { MediaAsset, MediaClip, Project, TextClip } from "../../src/shared/schema";
import { getMediaById, timelineDurationFrames } from "../../src/shared/project";
import { framesToSeconds, fpsValue } from "../../src/shared/time";
import { even } from "../../src/shared/presets";
import { projectDirectory } from "../projects/store";
import { config } from "../config";
import { pathExists } from "../util/fs";
import { runFfmpeg } from "../media/process";
import { remotionEngineAvailable, renderTimelineStillFrames } from "../media/remotion";
import { buildSignedDownloadPath } from "../services/downloadTokenService";
import { wcagContrastRatio } from "./visionInspector";
import { extractAllLiteralSceneCopy, isStructuralSceneLabel } from "./autonomousEditorBrain";

export interface SceneVisualElement {
  clipId: string;
  trackName: string;
  kind: "video" | "image" | "remotion" | "text" | "subtitle";
  label: string;
  zone?: string;
  startSec: number;
  endSec: number;
  visibleTexts: string[];
  contrastRatio: number;
  safeZoneOk: boolean;
}

export interface LowResSourceWarning {
  mediaId: string;
  name: string;
  sourceWidth: number;
  sourceHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  scaleFactor: number;
  message: string;
}

export interface ActiveSceneSnapshot {
  timeSec: number;
  frame: number;
  hasVisualContent: boolean;
  elements: SceneVisualElement[];
  visibleTexts: string[];
  minContrastRatio: number;
  contrastPassed: boolean;
  safeZonePassed: boolean;
  lowResSources: LowResSourceWarning[];
}

export interface RenderedFrameInfo {
  time: number;
  path: string;
  relPath: string;
  fileName: string;
  imageUrl: string;
  renderSource: "remotion" | "ffmpeg" | "synthetic";
  width: number;
  height: number;
  visibleTexts: string[];
  activeClips: string[];
  contrastRatio: number;
  safeZonePassed: boolean;
}

export interface QaCheckItem {
  name: string;
  passed: boolean;
  severity: "critical" | "warning" | "info";
  detail: string;
}

export interface TimelineQaReport {
  passed: boolean;
  status: "verified" | "fallback" | "failed";
  score: number;
  durationFrames: number;
  durationSeconds: number;
  targetDurationSeconds?: number;
  resolution: string;
  aspect: string;
  fps: number;
  checks: QaCheckItem[];
  visibleTextsByScene: Array<{
    clipId: string;
    clipName: string;
    trackName: string;
    startSec: number;
    endSec: number;
    texts: string[];
    usesInternalPlaceholderOnly: boolean;
  }>;
  lowResWarnings: LowResSourceWarning[];
  warnings: string[];
  criticalFailures: string[];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function parseHexToRgb(hex?: string, fallback: [number, number, number] = [9, 13, 24]): [number, number, number] {
  const clean = (hex || "").trim().replace(/^#/, "");
  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) return fallback;
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

/** Genera un PNG RGBA auténtico en Node puro cuando FFmpeg no está disponible o falla en contenedores mínimos. */
async function writePurePngFrame(
  outputPath: string,
  width: number,
  height: number,
  surfaceHex: string,
  accentHex: string,
): Promise<void> {
  const bg = parseHexToRgb(surfaceHex, [9, 13, 24]);
  const acc = parseHexToRgb(accentHex, [56, 189, 248]);
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  const bannerEnd = Math.max(8, Math.round(height * 0.14));
  const cardTop = Math.round(height * 0.25);
  const cardBottom = Math.round(height * 0.72);
  const cardLeft = Math.round(width * 0.1);
  const cardRight = Math.round(width * 0.9);

  for (let y = 0; y < height; y += 1) {
    const rowOff = y * rowSize;
    raw[rowOff] = 0;
    for (let x = 0; x < width; x += 1) {
      const pxOff = rowOff + 1 + x * 3;
      const inBanner = y < bannerEnd;
      const inCardBorder =
        (y === cardTop || y === cardBottom) && x >= cardLeft && x <= cardRight ||
        (x === cardLeft || x === cardRight) && y >= cardTop && y <= cardBottom;
      if (inBanner || inCardBorder) {
        raw[pxOff] = acc[0];
        raw[pxOff + 1] = acc[1];
        raw[pxOff + 2] = acc[2];
      } else {
        raw[pxOff] = bg[0];
        raw[pxOff + 1] = bg[1];
        raw[pxOff + 2] = bg[2];
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  await fs.writeFile(outputPath, png);
}

function stripJsComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Verifica si el TSX sin comentarios realmente renderiza sus props o texto JSX tangible. */
function jsxCodeRendersPropOrLiteral(codeWithoutComments: string, literal: string): boolean {
  const lower = literal.toLowerCase().trim();
  if (!lower) return false;
  if (codeWithoutComments.toLowerCase().includes(lower)) return true;
  // Si el código referencia props dinámicas reales en JSX (e.g. props.headline, {headline}, {ctaText}, {title}, {items}),
  // entonces las props declaradas sí viajan al árbol JSX renderizado.
  return /\{\s*(?:props\.)?(?:headline|title|subtitle|subheadline|ctaText|badge|metricValue|allLiterals|extraLiterals|captions)\b/i.test(
    codeWithoutComments,
  );
}

/** Extrae todos los textos visibles declarados por un clip Remotion a partir de sus props y JSX sin comentarios. */
export function extractRemotionClipVisibleTexts(clip: MediaClip, timeSec?: number): string[] {
  if (!clip.remotion) return [];
  const props = clip.remotion.props ?? {};
  const rawCode = clip.remotion.code ?? "";
  const codeNoComments = rawCode ? stripJsComments(rawCode) : "";
  const texts: string[] = [];
  const pushText = (val: unknown, verifyAgainstJsx = true) => {
    if (typeof val !== "string") return;
    const clean = val.replace(/\s+/g, " ").trim();
    if (!clean) return;
    if (verifyAgainstJsx && codeNoComments && !jsxCodeRendersPropOrLiteral(codeNoComments, clean)) {
      return;
    }
    if (!texts.includes(clean)) {
      texts.push(clean);
    }
  };

  pushText(props.badge);
  pushText(props.title);
  pushText(props.headline);
  pushText(props.subtitle);
  pushText(props.subheadline);
  pushText(props.ctaText);
  pushText(props.metricValue);

  if (Array.isArray(props.allLiterals)) {
    for (const item of props.allLiterals) pushText(item);
  }
  if (Array.isArray(props.extraLiterals)) {
    for (const item of props.extraLiterals) pushText(item);
  }

  if (Array.isArray(props.captions)) {
    for (const cap of props.captions as Array<{ text?: unknown; start?: unknown; end?: unknown; words?: Array<{ text?: unknown }> }>) {
      const capStart = typeof cap.start === "number" ? cap.start : undefined;
      const capEnd = typeof cap.end === "number" ? cap.end : undefined;
      if (timeSec !== undefined && capStart !== undefined && capEnd !== undefined) {
        if (timeSec < capStart || timeSec > capEnd) continue;
      }
      if (typeof cap.text === "string") {
        pushText(cap.text, false);
      } else if (Array.isArray(cap.words)) {
        const joined = cap.words.map((w) => String(w.text ?? "")).join(" ").trim();
        pushText(joined, false);
      }
    }
  }

  // Extraer nodos JSX renderizados directamente en TSX (descartando comentarios // Verified literal copy)
  if (codeNoComments) {
    for (const m of codeNoComments.matchAll(
      /(?:headline|subtitle|title|ctaText|badge)\s*=\s*String\(props\.[a-zA-Z0-9_]+\s*\|\|\s*(["'`])([^"'`\n]{2,140})\1\)/g,
    )) {
      pushText(m[2], false);
    }
    for (const m of codeNoComments.matchAll(/>([^<>{}\n]{2,140})</g)) {
      const candidate = (m[1] ?? "").replace(/\s+/g, " ").trim();
      if (candidate && /[a-zA-ZáéíóúñÁÉÍÓÚÑ0-9]/.test(candidate)) {
        pushText(candidate, false);
      }
    }
  }

  return texts;
}

/** Evalúa si las fuentes de medios usadas en el proyecto tienen resolución sensiblemente inferior al lienzo. */
export function detectLowResolutionSources(project: Project): LowResSourceWarning[] {
  const canvasW = project.settings.width;
  const canvasH = project.settings.height;
  const usedMediaIds = new Set<string>();
  for (const track of project.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== "text" && !clip.remotion) {
        usedMediaIds.add(clip.mediaId);
      }
    }
  }

  const warnings: LowResSourceWarning[] = [];
  for (const mediaId of usedMediaIds) {
    const asset = getMediaById(project, mediaId);
    if (!asset || asset.origin === "generated") continue;
    if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) continue;

    const minDimRatio = Math.max(canvasW / asset.width, canvasH / asset.height);
    const isLowRes =
      (Math.min(canvasW, canvasH) >= 1000 && Math.max(asset.width, asset.height) < 900) ||
      minDimRatio >= 1.65;
    if (isLowRes) {
      const scaleFactor = Number(minDimRatio.toFixed(2));
      warnings.push({
        mediaId: asset.id,
        name: asset.name,
        sourceWidth: asset.width,
        sourceHeight: asset.height,
        canvasWidth: canvasW,
        canvasHeight: canvasH,
        scaleFactor,
        message: `El recurso "${asset.name}" tiene resolución baja (${asset.width}x${asset.height}) para un lienzo de ${canvasW}x${canvasH} (reescalado ${scaleFactor}x; puede verse pixelado).`,
      });
    }
  }
  return warnings;
}

/** Captura la semántica visual y textual activa en un instante `timeSec` del timeline. */
export function collectActiveSceneSemanticsAtTime(project: Project, timeSec: number): ActiveSceneSnapshot {
  const fps = fpsValue(project.settings.fps);
  const clampedSec = Math.max(0, timeSec);
  const frame = Math.round(clampedSec * fps);

  const elements: SceneVisualElement[] = [];
  const visibleTexts: string[] = [];
  let minContrastRatio = 21;
  let safeZonePassed = true;

  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const endFrame = clip.startFrame + clip.durationFrames;
      if (frame < clip.startFrame || frame >= endFrame) continue;

      const startSec = Number((clip.startFrame / fps).toFixed(2));
      const endSec = Number((endFrame / fps).toFixed(2));

      if (clip.type === "text") {
        const text = clip.text.trim();
        if (text && !visibleTexts.includes(text)) visibleTexts.push(text);
        const bgHex = clip.backgroundOpacity > 0.15 ? (clip.backgroundColor || "#090D18") : "#090D18";
        const contrastRatio = wcagContrastRatio(clip.color || "#FFFFFF", bgHex);
        if (contrastRatio < minContrastRatio) minContrastRatio = contrastRatio;

        const isSubtitle = clip.role === "subtitle" || clip.role === "caption" || /subt|caption/i.test(track.name);
        const y = clip.position?.y ?? 0.5;
        const safeOk = isSubtitle ? y >= 0.1 && y <= 0.88 : y >= 0.08 && y <= 0.86;
        if (!safeOk) safeZonePassed = false;

        elements.push({
          clipId: clip.id,
          trackName: track.name,
          kind: isSubtitle ? "subtitle" : "text",
          label: clip.name,
          startSec,
          endSec,
          visibleTexts: text ? [text] : [],
          contrastRatio,
          safeZoneOk: safeOk,
        });
      } else if (clip.remotion) {
        const clipTexts = extractRemotionClipVisibleTexts(clip, clampedSec);
        for (const t of clipTexts) {
          if (!visibleTexts.includes(t)) visibleTexts.push(t);
        }
        const fg = String(clip.remotion.props?.textColor ?? "#F8FAFC");
        const bg = String(clip.remotion.props?.surfaceColor ?? "#090D18");
        const contrastRatio = wcagContrastRatio(fg, bg);
        if (contrastRatio < minContrastRatio) minContrastRatio = contrastRatio;
        const zone = String(clip.remotion.props?.zone ?? "center-stage");

        elements.push({
          clipId: clip.id,
          trackName: track.name,
          kind: "remotion",
          label: clip.name,
          zone,
          startSec,
          endSec,
          visibleTexts: clipTexts,
          contrastRatio,
          safeZoneOk: true,
        });
      } else if (clip.type === "video" || clip.type === "image") {
        elements.push({
          clipId: clip.id,
          trackName: track.name,
          kind: clip.type,
          label: clip.name,
          startSec,
          endSec,
          visibleTexts: [],
          contrastRatio: 7,
          safeZoneOk: true,
        });
      }
    }
  }

  return {
    timeSec: Number(clampedSec.toFixed(2)),
    frame,
    hasVisualContent: elements.length > 0,
    elements,
    visibleTexts,
    minContrastRatio: elements.length > 0 ? minContrastRatio : 21,
    contrastPassed: elements.length === 0 || minContrastRatio >= 4.5,
    safeZonePassed,
    lowResSources: detectLowResolutionSources(project),
  };
}

function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}

async function resolveClipDiskSourceAtTime(
  projectId: string,
  project: Project,
  timeSec: number,
): Promise<{ file: string; seekSec: number; kind: "video" | "image" } | null> {
  const fps = fpsValue(project.settings.fps);
  const frame = Math.round(timeSec * fps);
  for (const track of project.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type === "text" || clip.remotion) continue;
      if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
      const asset = getMediaById(project, clip.mediaId);
      if (!asset || asset.origin === "generated") continue;
      const file = path.join(projectDirectory(projectId), asset.file);
      if (!(await pathExists(file))) continue;
      const offsetSec = ((frame - clip.startFrame) / fps) * (clip.speed ?? 1);
      const seekSec = Math.max(0, clip.sourceInUs / 1_000_000 + offsetSec);
      return { file, seekSec, kind: asset.kind === "image" ? "image" : "video" };
    }
  }
  return null;
}

async function decodePngToSmallRgb(pngPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      config.ffmpeg,
      ["-v", "error", "-i", pngPath, "-vf", "scale=160:90,format=rgb24", "-f", "rawvideo", "pipe:1"],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 5_000);
    proc.stdout?.on("data", (d) => chunks.push(Buffer.from(d)));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) resolve(null);
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Calcula el porcentaje de diferencia visual real (0..100%) entre dos PNG consecutivos. */
export async function measureFramePairMotionDiffPercent(pngA: string, pngB: string): Promise<number | null> {
  const [bufA, bufB] = await Promise.all([decodePngToSmallRgb(pngA), decodePngToSmallRgb(pngB)]);
  if (!bufA || !bufB || bufA.length === 0 || bufA.length !== bufB.length) return null;
  let sumDiff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    sumDiff += Math.abs(bufA[i]! - bufB[i]!);
  }
  const meanDiff = (sumDiff / (bufA.length * 255)) * 100;
  return Number(meanDiff.toFixed(3));
}

/**
 * Renderiza fotogramas reales PNG del timeline en los instantes pedidos (`times` o cada `every` segundos).
 * Si existen capas Remotion activas, invoca `@remotion/renderer` `renderStill` sobre el componente real;
 * de lo contrario extrae fotogramas FFmpeg del vídeo/imagen fuente.
 */
export async function renderTimelineFrames(
  projectId: string,
  project: Project,
  options: { times?: number[]; every?: number; scale?: number; signal: AbortSignal },
): Promise<{
  frames: RenderedFrameInfo[];
  outputDir: string;
  durationSeconds: number;
  resolution: { width: number; height: number };
}> {
  const durationFrames = timelineDurationFrames(project);
  const durationSeconds = Math.max(0.5, framesToSeconds(durationFrames, project.settings.fps));
  const scale = Math.max(0.2, Math.min(1, options.scale ?? 0.5));
  const width = even(Math.max(160, Math.round(project.settings.width * scale)));
  const height = even(Math.max(160, Math.round(project.settings.height * scale)));

  let requestedTimes: number[] = [];
  if (options.times && options.times.length > 0) {
    requestedTimes = options.times.map((t) => Math.max(0, Math.min(Math.max(0, durationSeconds - 0.04), t)));
  } else {
    const step = Math.max(0.5, options.every ?? Math.max(1, Number((durationSeconds / 5).toFixed(2))));
    for (let t = 0.25; t < durationSeconds; t += step) {
      requestedTimes.push(Number(t.toFixed(2)));
    }
    if (requestedTimes.length === 0) requestedTimes.push(0);
  }
  const uniqueTimes = [...new Set(requestedTimes.map((t) => Number(t.toFixed(2))))]
    .sort((a, b) => a - b)
    .slice(0, 12);

  const outputDir = path.join(projectDirectory(projectId), "renders");
  await fs.mkdir(outputDir, { recursive: true });
  const localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-render-frames-"));

  try {
    const metaByTime = await Promise.all(
      uniqueTimes.map(async (t) => {
        const snapshot = collectActiveSceneSemanticsAtTime(project, t);
        const activeRemotion = snapshot.elements.find((e) => e.kind === "remotion");
        const firstClip = activeRemotion
          ? project.tracks
              .flatMap((tr) => tr.clips)
              .find((c): c is MediaClip => c.id === activeRemotion.clipId && c.type !== "text")
          : undefined;
        const surfaceHex = String(firstClip?.remotion?.props?.surfaceColor ?? "#090D18");
        const accentHex = String(firstClip?.remotion?.props?.accentColor ?? "#38BDF8");
        const fileName = `frame_${String(Math.round(t * 1000)).padStart(7, "0")}ms.png`;
        const relPath = `renders/${fileName}`;
        const outPath = path.join(outputDir, fileName);
        const hasRemotionAtTime = snapshot.elements.some((e) => e.kind === "remotion" || e.kind === "subtitle");
        const sourceMedia = await resolveClipDiskSourceAtTime(projectId, project, t);
        let bgPath: string | undefined;
        if (sourceMedia) {
          const tmpBg = path.join(localTmpDir, `bg_${fileName}`);
          try {
            await runFfmpeg(
              [
                "-y",
                "-ss",
                sourceMedia.seekSec.toFixed(3),
                "-i",
                sourceMedia.file,
                "-frames:v",
                "1",
                "-vf",
                `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
                tmpBg,
              ],
              { signal: options.signal, timeoutMs: 12_000 },
            );
            if (await pathExists(tmpBg)) bgPath = tmpBg;
          } catch {
            bgPath = undefined;
          }
        }
        return {
          t,
          snapshot,
          surfaceHex,
          accentHex,
          fileName,
          relPath,
          outPath,
          hasRemotionAtTime,
          bgPath,
          sourceMedia,
        };
      }),
    );

    const remotionTargets = metaByTime.filter((m) => m.hasRemotionAtTime && remotionEngineAvailable());
    const remotionResultByTime = new Map<number, boolean>();
    if (remotionTargets.length > 0) {
      const stillResults = await renderTimelineStillFrames(
        project,
        remotionTargets.map((m) => ({
          timeSec: m.t,
          outPath: m.outPath,
          backgroundFile: m.bgPath,
          backgroundHex: m.surfaceHex,
        })),
        { scale, signal: options.signal },
      );
      for (const r of stillResults) {
        if (r.ok && (await pathExists(r.outPath))) {
          remotionResultByTime.set(r.timeSec, true);
        }
      }
    }

    const frames: RenderedFrameInfo[] = [];
    for (const item of metaByTime) {
      let renderSource: "remotion" | "ffmpeg" | "synthetic" = "ffmpeg";
      if (remotionResultByTime.get(item.t)) {
        renderSource = "remotion";
      } else if (item.bgPath && (await pathExists(item.bgPath))) {
        await fs.copyFile(item.bgPath, item.outPath);
        renderSource = "ffmpeg";
      } else {
        const headline = item.snapshot.visibleTexts[0] ?? (item.snapshot.hasVisualContent ? "SCENE" : "EMPTY");
        const sub = item.snapshot.visibleTexts[1] ?? "";
        const localFfmpegOut = path.join(localTmpDir, `ff_${item.fileName}`);
        const drawFilters = [
          `drawtext=text='${escapeDrawtext(headline.slice(0, 64))}':fontcolor=white:fontsize=${Math.max(16, Math.round(Math.min(width, height) * 0.05))}:x=(w-text_w)/2:y=${Math.round(height * 0.36)}`,
          ...(sub
            ? [
                `drawtext=text='${escapeDrawtext(sub.slice(0, 90))}':fontcolor=#CBD5E1:fontsize=${Math.max(12, Math.round(Math.min(width, height) * 0.03))}:x=(w-text_w)/2:y=${Math.round(height * 0.48)}`,
              ]
            : []),
        ].join(",");
        let okFfmpeg = false;
        try {
          await runFfmpeg(
            [
              "-y",
              "-f",
              "lavfi",
              "-i",
              `color=c=${item.surfaceHex.replace("#", "0x")}:s=${width}x${height}:d=0.1`,
              "-frames:v",
              "1",
              "-vf",
              drawFilters,
              localFfmpegOut,
            ],
            { signal: options.signal, timeoutMs: 12_000 },
          );
          if (await pathExists(localFfmpegOut)) {
            await fs.copyFile(localFfmpegOut, item.outPath);
            okFfmpeg = true;
            renderSource = "ffmpeg";
          }
        } catch {
          okFfmpeg = false;
        }
        if (!okFfmpeg) {
          await writePurePngFrame(item.outPath, width, height, item.surfaceHex, item.accentHex);
          renderSource = "synthetic";
        }
      }

      const imageUrl = buildSignedDownloadPath({
        kind: "file",
        projectId,
        relPath: item.relPath,
        fileName: item.fileName,
        contentType: "image/png",
        download: false,
      });

      frames.push({
        time: item.t,
        path: item.outPath,
        relPath: item.relPath,
        fileName: item.fileName,
        imageUrl,
        renderSource,
        width,
        height,
        visibleTexts: item.snapshot.visibleTexts,
        activeClips: item.snapshot.elements.map((e) => e.label),
        contrastRatio: item.snapshot.minContrastRatio,
        safeZonePassed: item.snapshot.safeZonePassed,
      });
    }

    return {
      frames,
      outputDir,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      resolution: { width, height },
    };
  } finally {
    await fs.rm(localTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Genera una hoja de contactos (contact sheet) en cuadrícula con los fotogramas clave del proyecto. */
export async function generateContactSheet(
  projectId: string,
  project: Project,
  options: {
    every?: number;
    columns?: number;
    signal: AbortSignal;
    preRenderedFrames?: {
      frames: RenderedFrameInfo[];
      outputDir: string;
      resolution: { width: number; height: number };
    };
  },
): Promise<{
  path: string;
  relPath: string;
  imageUrl: string;
  columns: number;
  rows: number;
  frameCount: number;
  frames: RenderedFrameInfo[];
}> {
  const rendered =
    options.preRenderedFrames && options.preRenderedFrames.frames.length > 0
      ? options.preRenderedFrames
      : await renderTimelineFrames(projectId, project, {
          every: options.every,
          scale: 0.35,
          signal: options.signal,
        });
  const columns = Math.max(1, Math.min(6, options.columns ?? Math.min(3, Math.max(1, rendered.frames.length))));
  const rows = Math.max(1, Math.ceil(rendered.frames.length / columns));
  const sheetFileName = `contact_sheet_${Date.now()}.png`;
  const relPath = `renders/${sheetFileName}`;
  const sheetPath = path.join(rendered.outputDir, sheetFileName);
  const localTmpSheet = path.join(os.tmpdir(), `oeclip-${sheetFileName}`);

  let createdViaFfmpeg = false;
  if (rendered.frames.length === 1) {
    await fs.copyFile(rendered.frames[0]!.path, sheetPath);
    createdViaFfmpeg = true;
  } else if (rendered.frames.length > 1) {
    try {
      const inputs = rendered.frames.flatMap((f) => ["-i", f.path]);
      const filterInputs = rendered.frames.map((_, idx) => `[${idx}:v]`).join("");
      const filter = `${filterInputs}concat=n=${rendered.frames.length}:v=1:a=0,tile=${columns}x${rows}:padding=8:color=#0F172A[out]`;
      await runFfmpeg(
        [...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-y", localTmpSheet],
        { signal: options.signal, timeoutMs: 15_000 },
      );
      if (await pathExists(localTmpSheet)) {
        await fs.copyFile(localTmpSheet, sheetPath);
        createdViaFfmpeg = true;
      }
    } catch {
      createdViaFfmpeg = false;
    } finally {
      await fs.rm(localTmpSheet, { force: true }).catch(() => undefined);
    }
  }

  if (!createdViaFfmpeg) {
    await writePurePngFrame(sheetPath, rendered.resolution.width * columns, rendered.resolution.height * rows, "#090D18", "#38BDF8");
  }

  const imageUrl = buildSignedDownloadPath({
    kind: "file",
    projectId,
    relPath,
    fileName: sheetFileName,
    contentType: "image/png",
    download: false,
  });

  return {
    path: sheetPath,
    relPath,
    imageUrl,
    columns,
    rows,
    frameCount: rendered.frames.length,
    frames: rendered.frames,
  };
}

/** Inspecciona en detalle un instante específico del timeline devolviendo imagen, textos visibles, contraste y márgenes. */
export async function inspectTimelineFrame(
  projectId: string,
  project: Project,
  options: { time: number; signal: AbortSignal },
): Promise<{
  time: number;
  framePath: string;
  frame?: RenderedFrameInfo;
  visibleTexts: string[];
  elements: SceneVisualElement[];
  contrastRatio: number;
  contrastPassed: boolean;
  safeZonePassed: boolean;
  lowResSources: LowResSourceWarning[];
  warnings: string[];
}> {
  const snapshot = collectActiveSceneSemanticsAtTime(project, options.time);
  const rendered = await renderTimelineFrames(projectId, project, {
    times: [options.time],
    scale: 0.5,
    signal: options.signal,
  });
  const frame = rendered.frames[0];
  const framePath = frame?.path ?? "";
  const warnings: string[] = [];
  if (!snapshot.hasVisualContent) {
    warnings.push(`En t=${snapshot.timeSec}s no hay ningún clip visual visible (hueco negro).`);
  }
  if (!snapshot.contrastPassed) {
    warnings.push(`Contraste bajo detectado (${snapshot.minContrastRatio}:1 < 4.5:1) en t=${snapshot.timeSec}s.`);
  }
  if (!snapshot.safeZonePassed) {
    warnings.push(`Texto fuera de zona segura en t=${snapshot.timeSec}s.`);
  }
  for (const lr of snapshot.lowResSources) {
    warnings.push(lr.message);
  }

  return {
    time: snapshot.timeSec,
    framePath,
    frame,
    visibleTexts: snapshot.visibleTexts,
    elements: snapshot.elements,
    contrastRatio: snapshot.minContrastRatio,
    contrastPassed: snapshot.contrastPassed,
    safeZonePassed: snapshot.safeZonePassed,
    lowResSources: snapshot.lowResSources,
    warnings,
  };
}

/**
 * Ejecuta la lista de control automática completa (9 criterios de Sección 6) sobre el proyecto:
 * duración, resolución/aspecto, presencia íntegra de textos literales (cero placeholders internos),
 * ausencia de huecos negros, contraste >= 4.5:1, márgenes seguros, ritmo, audio/niveles,
 * sincronía de subtítulos y resolución de fuentes.
 */
export async function buildTimelineQaReport(
  _projectId: string,
  project: Project,
  options?: {
    expectedLiterals?: string[];
    expectedPrompt?: string;
    targetDurationSec?: number;
    strict?: boolean;
    renderedFrames?: RenderedFrameInfo[];
  },
): Promise<TimelineQaReport> {
  const fps = fpsValue(project.settings.fps);
  const durationFrames = timelineDurationFrames(project);
  const durationSeconds = Number(framesToSeconds(durationFrames, project.settings.fps).toFixed(3));
  const resolution = `${project.settings.width}x${project.settings.height}`;

  const expectedLiterals = new Set<string>(
    (options?.expectedLiterals ?? []).map((s) => s.trim()).filter(Boolean),
  );
  if (options?.expectedPrompt) {
    const extracted = extractAllLiteralSceneCopy(options.expectedPrompt);
    for (const lit of extracted.allLiterals) {
      expectedLiterals.add(lit);
    }
  }

  const checks: QaCheckItem[] = [];
  const warnings: string[] = [];
  const criticalFailures: string[] = [];

  // 1. Duración
  const targetSec = options?.targetDurationSec;
  const durationDiff = targetSec !== undefined ? Math.abs(durationSeconds - targetSec) : 0;
  const durationOk = durationFrames > 0 && (targetSec === undefined || durationDiff <= 0.15);
  checks.push({
    name: "duration_match",
    passed: durationOk,
    severity: "critical",
    detail:
      durationFrames <= 0
        ? "La línea de tiempo está vacía (0 s)."
        : targetSec !== undefined
          ? `Duración real ${durationSeconds}s vs objetivo ${targetSec}s (diferencia ${durationDiff.toFixed(2)}s).`
          : `Duración válida: ${durationSeconds}s (${durationFrames} fotogramas).`,
  });
  if (!durationOk) criticalFailures.push(checks[checks.length - 1]!.detail);

  // 2. Resolución / formato / fps
  const formatOk = project.settings.width >= 320 && project.settings.height >= 320 && fps >= 15;
  checks.push({
    name: "format_valid",
    passed: formatOk,
    severity: "critical",
    detail: `Lienzo ${resolution} (${project.settings.aspect}) @ ${fps.toFixed(2)} fps.`,
  });
  if (!formatOk) criticalFailures.push(checks[checks.length - 1]!.detail);

  // 3. Textos literales solicitados y ausencia de placeholders internos
  const visibleTextsByScene: TimelineQaReport["visibleTextsByScene"] = [];
  const allRenderedTextCorpus: string[] = [];
  const placeholderViolations: string[] = [];

  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const startSec = Number((clip.startFrame / fps).toFixed(2));
      const endSec = Number(((clip.startFrame + clip.durationFrames) / fps).toFixed(2));
      if (clip.type === "text") {
        const clean = clip.text.trim();
        if (clean) allRenderedTextCorpus.push(clean);
        const placeholderOnly = isStructuralSceneLabel(clean);
        if (placeholderOnly) {
          placeholderViolations.push(`Clip de texto "${clip.name}" muestra etiqueta interna "${clean}".`);
        }
        visibleTextsByScene.push({
          clipId: clip.id,
          clipName: clip.name,
          trackName: track.name,
          startSec,
          endSec,
          texts: clean ? [clean] : [],
          usesInternalPlaceholderOnly: placeholderOnly,
        });
      } else if (clip.remotion) {
        const texts = extractRemotionClipVisibleTexts(clip);
        for (const t of texts) allRenderedTextCorpus.push(t);
        const mainHeadline = String(clip.remotion.props?.title ?? texts[0] ?? "").trim();
        const placeholderOnly =
          texts.length === 0 || (isStructuralSceneLabel(mainHeadline) && texts.length <= 1);
        if (placeholderOnly) {
          placeholderViolations.push(
            `Escena Remotion "${clip.name}" muestra etiqueta interna o sin texto real ("${mainHeadline || "vacío"}").`,
          );
        }
        visibleTextsByScene.push({
          clipId: clip.id,
          clipName: clip.name,
          trackName: track.name,
          startSec,
          endSec,
          texts,
          usesInternalPlaceholderOnly: placeholderOnly,
        });
      }
    }
  }

  const corpusLower = allRenderedTextCorpus.join(" \n ").toLowerCase();
  const missingLiterals = Array.from(expectedLiterals).filter(
    (lit) => !corpusLower.includes(lit.toLowerCase()),
  );
  const literalOk = missingLiterals.length === 0 && placeholderViolations.length === 0;
  const literalDetail = [
    missingLiterals.length > 0 ? `Faltan textos literales pedidos: ${missingLiterals.join("; ")}.` : "Todos los textos literales solicitados están presentes.",
    placeholderViolations.length > 0 ? placeholderViolations.join(" ") : "Sin tarjetas placeholder internas.",
  ].join(" ");
  checks.push({
    name: "literal_copy_present",
    passed: literalOk,
    severity: "critical",
    detail: literalDetail,
  });
  checks.push({
    name: "literal_texts_and_no_placeholders",
    passed: literalOk,
    severity: "critical",
    detail: literalDetail,
  });
  if (!literalOk) criticalFailures.push(literalDetail);

  // 4. Huecos negros en pista visual principal
  const visualTracks = project.tracks.filter((t) => t.kind === "video" && !t.hidden);
  const visualIntervals = visualTracks
    .flatMap((t) => t.clips)
    .map((c) => ({ start: c.startFrame, end: c.startFrame + c.durationFrames }))
    .sort((a, b) => a.start - b.start);
  let gapFrames = 0;
  let cursor = 0;
  for (const iv of visualIntervals) {
    if (iv.start > cursor) gapFrames += iv.start - cursor;
    cursor = Math.max(cursor, iv.end);
  }
  const gapSec = Number((gapFrames / fps).toFixed(2));
  const noBlackGaps = visualIntervals.length > 0 && gapSec <= 0.35;
  checks.push({
    name: "no_empty_gaps",
    passed: noBlackGaps,
    severity: "warning",
    detail: noBlackGaps
      ? "Cobertura visual continua sin huecos negros."
      : `Se detectaron ${gapSec}s de huecos sin contenido visual en pistas de vídeo.`,
  });
  if (!noBlackGaps) warnings.push(checks[checks.length - 1]!.detail);

  // 5. Contraste y márgenes seguros
  let minContrast = 21;
  let safeZoneIssues = 0;
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type === "text") {
        const ratio = wcagContrastRatio(
          clip.color || "#FFFFFF",
          clip.backgroundOpacity > 0.15 ? clip.backgroundColor || "#090D18" : "#090D18",
        );
        if (ratio < minContrast) minContrast = ratio;
        const y = clip.position?.y ?? 0.5;
        if (y < 0.08 || y > 0.9) safeZoneIssues += 1;
      } else if (clip.remotion) {
        const fg = String(clip.remotion.props?.textColor ?? "#F8FAFC");
        const bg = String(clip.remotion.props?.surfaceColor ?? "#090D18");
        const ratio = wcagContrastRatio(fg, bg);
        if (ratio < minContrast) minContrast = ratio;
      }
    }
  }
  const legibilityOk = minContrast >= 4.5 && safeZoneIssues === 0;
  checks.push({
    name: "legibility_and_safe_zones",
    passed: legibilityOk,
    severity: "warning",
    detail: legibilityOk
      ? `Contraste mínimo ${minContrast}:1 (>= 4.5:1) y márgenes seguros respetados.`
      : `Contraste mínimo ${minContrast}:1 o ${safeZoneIssues} elemento(s) fuera de márgenes seguros.`,
  });
  if (!legibilityOk) warnings.push(checks[checks.length - 1]!.detail);

  // 6. Ritmo visual (metadatos + diferencia real de píxeles entre frames si fueron renderizados)
  const longStaticClips = visualTracks
    .flatMap((t) => t.clips)
    .filter((c) => {
      if (c.type === "text") return false;
      if (c.remotion) return false;
      const dur = c.durationFrames / fps;
      const hasZoomMotion = Boolean(c.transform?.keyframes && c.transform.keyframes.length >= 2);
      return dur > 6.5 && !hasZoomMotion;
    });
  let staticFramePairs = 0;
  if (options?.renderedFrames && options.renderedFrames.length >= 2) {
    for (let i = 0; i + 1 < options.renderedFrames.length; i += 1) {
      const a = options.renderedFrames[i]!;
      const b = options.renderedFrames[i + 1]!;
      if (b.time - a.time >= 0.4) {
        const diffPct = await measureFramePairMotionDiffPercent(a.path, b.path).catch(() => null);
        if (diffPct !== null && diffPct < 0.08) {
          staticFramePairs += 1;
        }
      }
    }
  }
  const rhythmOk = longStaticClips.length === 0 && staticFramePairs === 0;
  checks.push({
    name: "visual_rhythm",
    passed: rhythmOk,
    severity: "info",
    detail: rhythmOk
      ? "Ritmo visual adecuado con variación real entre fotogramas."
      : [
          longStaticClips.length > 0 ? `${longStaticClips.length} clip(s) superan 6.5s sin movimiento de cámara o cortes.` : "",
          staticFramePairs > 0 ? `${staticFramePairs} par(es) de fotogramas consecutivo(s) sin variación visual (<0.08% píxeles).` : "",
        ]
          .filter(Boolean)
          .join(" "),
  });
  if (!rhythmOk) warnings.push(checks[checks.length - 1]!.detail);

  // 7. Presencia de audio / niveles
  const audioClips = project.tracks
    .filter((t) => t.kind === "audio" && !t.muted)
    .flatMap((t) => t.clips)
    .filter((c): c is MediaClip => c.type !== "text" && c.volume > 0);
  const videoWithAudioClips = visualTracks
    .flatMap((t) => t.clips)
    .filter((c): c is MediaClip => {
      if (c.type === "text" || c.volume <= 0) return false;
      const asset = getMediaById(project, c.mediaId);
      return Boolean(asset?.audioCodec);
    });
  const totalAudioSources = audioClips.length + videoWithAudioClips.length;
  const clippingClips = [...audioClips, ...videoWithAudioClips].filter((c) => c.volume > 1.85);
  const audioOk = totalAudioSources > 0 && clippingClips.length === 0;
  const audioDetail =
    totalAudioSources === 0
      ? "Sin pista de voz ni música (solo visual)."
      : clippingClips.length > 0
        ? `${clippingClips.length} clip(s) de audio con ganancia alta (>185%), posible saturación.`
        : `${totalAudioSources} clip(s) con audio activo dentro de niveles seguros.`;
  checks.push({
    name: "audio_presence_and_levels",
    passed: audioOk,
    severity: totalAudioSources === 0 ? "warning" : "info",
    detail: audioDetail,
  });
  if (!audioOk) warnings.push(audioDetail);

  // 8. Sincronía y líneas de subtítulos
  const subtitleClips = project.tracks
    .filter((t) => t.kind === "text" && !t.hidden)
    .flatMap((t) => t.clips)
    .filter((c): c is TextClip => c.type === "text" && (c.role === "subtitle" || c.role === "caption" || /subt|caption/i.test(c.name)));
  const overTwoLines = subtitleClips.filter((s) => s.text.split("\n").length > 2 || s.text.length > 84);
  const subtitleOk = overTwoLines.length === 0;
  checks.push({
    name: "subtitles_sync_and_lines",
    passed: subtitleOk,
    severity: "warning",
    detail:
      subtitleClips.length === 0
        ? "Sin clips de subtítulos dedicados en T1."
        : subtitleOk
          ? `${subtitleClips.length} subtítulo(s) respetan <= 2 líneas.`
          : `${overTwoLines.length} subtítulo(s) exceden 2 líneas o 84 caracteres.`,
  });
  if (!subtitleOk) warnings.push(checks[checks.length - 1]!.detail);

  // 9. Calidad / resolución de medios origen (F7)
  const lowResWarnings = detectLowResolutionSources(project);
  const resOk = lowResWarnings.length === 0;
  checks.push({
    name: "source_resolution_quality",
    passed: resOk,
    severity: "warning",
    detail: resOk
      ? "Resolución de fuentes adecuada al lienzo."
      : lowResWarnings.map((w) => w.message).join(" "),
  });
  for (const w of lowResWarnings) warnings.push(w.message);

  const passedCount = checks.filter((c) => c.passed).length;
  const score = Math.round((passedCount / checks.length) * 100);
  const allCriticalPass = criticalFailures.length === 0;
  const zeroWarnings = warnings.length === 0;
  const status: TimelineQaReport["status"] = !allCriticalPass
    ? "failed"
    : zeroWarnings
      ? "verified"
      : "fallback";
  const passed = options?.strict ? allCriticalPass && zeroWarnings : allCriticalPass;

  return {
    passed,
    status,
    score,
    durationFrames,
    durationSeconds,
    ...(targetSec !== undefined ? { targetDurationSeconds: targetSec } : {}),
    resolution,
    aspect: project.settings.aspect,
    fps: Number(fps.toFixed(2)),
    checks,
    visibleTextsByScene,
    lowResWarnings,
    warnings,
    criticalFailures,
  };
}
