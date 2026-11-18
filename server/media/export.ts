import fs from "node:fs/promises";
import path from "node:path";
import type { ExportSettings, Project, TextClip } from "../../src/shared/schema";
import { framesToSeconds } from "../../src/shared/time";
import { dimensionsFor, even } from "../../src/shared/presets";
import { clipEnd, isLiveRemotionClip, visualLayerWeight } from "../../src/shared/timeline";
import { timelineDurationFrames, touchProject } from "../../src/shared/project";
import { frameDurationUs } from "../../src/shared/time";
import { wrapText } from "../../src/shared/srt";
import { fontFamily, transformText } from "../../src/shared/subtitles";
import { config } from "../config";
import { filterScriptOption } from "../system";
import { HttpError } from "../util/fs";

export interface BuiltExport {
  args: string[];
  filterFile: string;
  textFiles: string[];
  durationFrames: number;
  durationUs: number;
  width: number;
  height: number;
  expectedAudio: boolean;
}

export interface BuildOptions {
  outputFile: string;
  projectDir: string;
  tempDir: string;
  encoder: "libx264" | "h264_nvenc";
  /** Omite el quemado de texto (el motor Remotion compone la capa aparte). */
  skipText?: boolean;
  /** Base intermedia casi sin pérdida para componer encima sin degradar. */
  intermediate?: boolean;
  /** Aplica sidechain ducking automático sobre pistas de música cuando hay voz/diálogo activo. */
  smartDucking?: boolean;
}

type AudioTrackRole = "speech" | "music" | "sfx";

function classifyAudioTrackRole(trackName: string): AudioTrackRole {
  const name = trackName.trim().toLowerCase();
  if (/(m[úu]sica|music|\bbgm\b|soundtrack|cama|banda\s*sonora|ambient\s*bed)/i.test(name)) {
    return "music";
  }
  if (/(\bsfx\b|efecto|\bfx\b|foley)/i.test(name)) {
    return "sfx";
  }
  return "speech";
}

// Presets pensados para CPU compartida (Cloud Run 2 vCPU) + garantía de bitrate en "high".
const QUALITY = {
  draft: { cpuPreset: "ultrafast", crf: 28, nvencCq: 28 },
  standard: { cpuPreset: "veryfast", crf: 21, nvencCq: 22 },
  high: { cpuPreset: "fast", crf: 16, nvencCq: 17 },
} as const;

function buildVideoCodecArgs(
  encoder: "libx264" | "h264_nvenc",
  qualityKey: ExportSettings["quality"],
  settings: Pick<ExportSettings, "resolution">,
  intermediate = false,
): string[] {
  const q = intermediate ? { cpuPreset: "veryfast", crf: 16, nvencCq: 16 } : QUALITY[qualityKey];
  if (encoder === "h264_nvenc") {
    return ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(q.nvencCq), "-b:v", "0"];
  }
  if (!intermediate && qualityKey === "high") {
    const isFullHdOrHigher = settings.resolution >= 1080;
    const target = isFullHdOrHigher ? "10M" : "5M";
    const floor = isFullHdOrHigher ? "8M" : "4M";
    const ceiling = isFullHdOrHigher ? "10M" : "5M";
    const buf = isFullHdOrHigher ? "10M" : "5M";
    return [
      "-preset",
      q.cpuPreset,
      "-b:v",
      target,
      "-minrate",
      floor,
      "-maxrate",
      ceiling,
      "-bufsize",
      buf,
      "-x264-params",
      "nal-hrd=cbr",
      "-profile:v",
      "high",
    ];
  }
  return ["-preset", q.cpuPreset, "-crf", String(q.crf), "-profile:v", "high"];
}

function sec(frames: number, project: Project): string {
  return framesToSeconds(frames, project.settings.fps).toFixed(6);
}

function atempoChain(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0001) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.4999) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 0.0001) filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(",");
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function ffmpegColor(hex: string, alpha = 1): string {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return alpha >= 1 ? "white" : `white@${alpha.toFixed(3)}`;
  return alpha >= 1 ? `0x${clean}` : `0x${clean}@${Math.min(1, Math.max(0, alpha)).toFixed(3)}`;
}

function fontFileFor(clip: TextClip): string {
  return path.join(config.assetsDir, "fonts", fontFamily(clip.fontFamily).file);
}

function textPosition(clip: TextClip): { x: string; y: string } {
  const align = clip.align;
  const alignment = align === "left" ? "0" : align === "right" ? "text_w" : "text_w/2";
  return {
    x: `(W*${clip.position.x.toFixed(4)})-(${alignment})`,
    y: `(H*${clip.position.y.toFixed(4)})-(text_h/2)`,
  };
}

type CaptionWordLike = { text?: unknown; start?: unknown; end?: unknown; highlight?: unknown };
type CaptionCueLike = {
  start?: unknown;
  end?: unknown;
  words?: CaptionWordLike[];
  zone?: string;
  suppressed?: boolean;
  positionY?: unknown;
  accentColor?: unknown;
};

function assColorBgr(hex: string, alpha = 0, fallback = "&H00FFFFFF&"): string {
  const clean = String(hex || "").trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
  const r = clean.slice(0, 2).toUpperCase();
  const g = clean.slice(2, 4).toUpperCase();
  const b = clean.slice(4, 6).toUpperCase();
  const aByte = Math.max(0, Math.min(255, Math.round(alpha * 255)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return alpha > 0 ? `&H${aByte}${b}${g}${r}` : `&H00${b}${g}${r}&`;
}

function formatAssTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalCs = Math.round(clamped * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function formatAssCueLine(
  words: Array<{ text: string }>,
  activeIndex: number,
  accentAss: string,
  baseAss: string,
  maxLineChars: number,
): string {
  let lineLen = 0;
  const parts: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const wordText = escapeAssText(words[i]!.text);
    const sep =
      i === 0
        ? ""
        : lineLen + 1 + words[i]!.text.length > maxLineChars
          ? ((lineLen = 0), "\\N")
          : " ";
    lineLen += (sep === " " ? 1 : 0) + words[i]!.text.length;
    if (i === activeIndex) {
      parts.push(`${sep}{\\c${accentAss}\\fscx108\\fscy108}${wordText}{\\c${baseAss}\\fscx100\\fscy100}`);
    } else {
      parts.push(`${sep}${wordText}`);
    }
  }
  return parts.join("");
}

/**
 * Genera un archivo SubStation Alpha (.ass) para renderizar subtítulos dinámicos
 * palabra por palabra directamente en FFmpeg (libass), evitando levantar Chromium.
 */
async function writeAssSubtitlesForProject(
  project: Project,
  settings: ExportSettings,
  width: number,
  height: number,
  assFilePath: string,
): Promise<boolean> {
  const captionClips = project.tracks
    .filter((track) => track.kind === "text" && !track.hidden)
    .flatMap((track) => track.clips)
    .filter(
      (clip): clip is TextClip =>
        clip.type === "text" &&
        Boolean(clip.remotion) &&
        Array.isArray(clip.remotion?.props?.captions),
    )
    .sort((a, b) => a.startFrame - b.startFrame);

  if (captionClips.length === 0) return false;

  const projectFps = Math.max(1, project.settings.fps.num / Math.max(1, project.settings.fps.den));
  const rawProps0 = captionClips[0]?.remotion?.props ?? {};
  const rawFontScale = Number(rawProps0.fontScale ?? 1);
  const fontScale = Math.max(0.6, Math.min(1.8, rawFontScale > 5 ? rawFontScale / 100 : rawFontScale));
  const baseFontSize = Math.max(
    24,
    Math.round((height > width ? width * 0.052 : height * 0.056) * fontScale),
  );
  const baseColorHex = typeof rawProps0.textColor === "string" ? rawProps0.textColor : "#FFFFFF";
  const baseTextAss = assColorBgr(baseColorHex, 0, "&H00FFFFFF&");
  const defaultStyleAccentMap: Record<string, string> = {
    tiktok: "#C9FF4D",
    hormozi: "#FFE600",
    impact: "#FFD44A",
    neon: "#4DE8FF",
    karaoke: "#FF4D6D",
    cinematic: "#E8C07A",
    minimal: "#F59E0B",
  };
  const styleId = String(captionClips[0]?.remotion?.styleId || "minimal").toLowerCase();
  const fallbackAccentHex = defaultStyleAccentMap[styleId] ?? "#F59E0B";
  const maxLineChars = height > width ? 22 : 38;
  const outlinePx = Math.max(2, Math.round(baseFontSize * 0.08));
  const shadowPx = Math.max(1, Math.round(baseFontSize * 0.04));

  const dialogueLines: string[] = [];
  let prevEndSec = 0;

  for (const clip of captionClips) {
    const props = clip.remotion?.props ?? {};
    const clipAccentHex =
      typeof props.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(props.accentColor)
        ? props.accentColor
        : defaultStyleAccentMap[String(clip.remotion?.styleId || styleId).toLowerCase()] ?? fallbackAccentHex;
    const rawClipPosY = Number(props.positionY ?? (height > width ? 0.83 : 0.86));
    const clipPosY = Math.max(0.12, Math.min(0.92, rawClipPosY > 1.5 ? rawClipPosY / 100 : rawClipPosY));
    const oxPct = Number(props.offsetX ?? 0);
    const posX = Math.round(width * (0.5 + oxPct / 100));

    const captions = Array.isArray(props.captions) ? (props.captions as CaptionCueLike[]) : [];
    for (const cue of captions) {
      if (cue.suppressed) continue;
      const cueWords = Array.isArray(cue.words)
        ? cue.words
            .map((w) => ({
              text: String(w.text ?? "").trim(),
              start: Number(w.start ?? 0),
              end: Number(w.end ?? 0),
            }))
            .filter((w) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end))
        : [];
      if (cueWords.length === 0) continue;

      const cueAccentHex =
        typeof cue.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(cue.accentColor)
          ? cue.accentColor
          : clipAccentHex;
      const cueAccentAss = assColorBgr(cueAccentHex, 0, "&H0000E6FF&");
      const rawCuePosY = cue.positionY !== undefined ? Number(cue.positionY) : clipPosY;
      const cuePosY =
        cue.zone === "hero-top"
          ? 0.16
          : cue.zone === "center"
            ? 0.5
            : Math.max(0.12, Math.min(0.92, rawCuePosY > 1.5 ? rawCuePosY / 100 : rawCuePosY));
      const posY = Math.round(height * cuePosY);
      const cueStartFrame = clip.startFrame + Math.max(0, Number(cue.start ?? cueWords[0]!.start));
      const cueEndFrame =
        clip.startFrame + Math.max(Number(cue.end ?? cueWords[cueWords.length - 1]!.end), Number(cue.start ?? 0) + 1);
      const clipMaxEndSec = framesToSeconds(clipEnd(clip), project.settings.fps);

      for (let wIdx = 0; wIdx < cueWords.length; wIdx += 1) {
        const w = cueWords[wIdx]!;
        const nextWord = cueWords[wIdx + 1];
        const wStartFrame = Math.max(cueStartFrame, clip.startFrame + w.start);
        const wEndFrame =
          nextWord !== undefined
            ? clip.startFrame + Math.max(w.end, nextWord.start)
            : Math.max(cueEndFrame, clip.startFrame + w.end);

        let startSec = Math.max(prevEndSec, wStartFrame / projectFps);
        let endSec = Math.min(clipMaxEndSec, Math.max(startSec + 0.04, wEndFrame / projectFps));
        if (endSec <= startSec + 0.01) continue;
        // Cuantizar a centésimas para evitar solapamientos mínimos en libass
        startSec = Math.round(startSec * 100) / 100;
        endSec = Math.max(startSec + 0.03, Math.round(endSec * 100) / 100);
        prevEndSec = endSec;

        const formattedText = formatAssCueLine(
          cueWords,
          wIdx,
          cueAccentAss,
          baseTextAss,
          maxLineChars,
        );
        dialogueLines.push(
          `Dialogue: 0,${formatAssTimestamp(startSec)},${formatAssTimestamp(endSec)},Default,,0,0,0,,{\\an5\\pos(${posX},${posY})}${formattedText}`,
        );
      }
    }
  }

  if (dialogueLines.length === 0) return false;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Inter,${baseFontSize},${baseTextAss},&H0000FFFF&,&H00080A10&,&HA0000000&,-1,0,0,0,100,100,0,0,1,${outlinePx},${shadowPx},2,${Math.round(width * 0.06)},${Math.round(width * 0.06)},${Math.round(height * 0.08)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  await fs.writeFile(assFilePath, `${header.join("\n")}\n${dialogueLines.join("\n")}\n`, "utf8");
  return true;
}

type KeyframePoint = { frame: number; scale: number; x?: number; y?: number };

/** Interpola linealmente una lista de puntos y la convierte en una expresión FFmpeg. */
function piecewiseExpression(points: Array<{ frame: number; value: number }>, variable: string): string {
  if (points.length === 0) return "1";
  if (points.length === 1) return points[0]!.value.toFixed(4);
  let expression = points[points.length - 1]!.value.toFixed(4);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const span = Math.max(1, end.frame - start.frame);
    const segment = `(${start.value.toFixed(4)}+(${(end.value - start.value).toFixed(4)})*(${variable}-${start.frame})/${span})`;
    const clamped =
      index === 0
        ? `if(lt(${variable},${start.frame}),${start.value.toFixed(4)},${segment})`
        : segment;
    expression = `if(lte(${variable},${end.frame}),${clamped},${expression})`;
  }
  return expression;
}

/** Añade puntos en los extremos para que el valor se mantenga antes/después. */
function extendKeyframes(points: KeyframePoint[], durationFrames: number): KeyframePoint[] {
  if (points.length === 0) return points;
  const extended = [...points];
  const first = extended[0]!;
  if (first.frame > 0) extended.unshift({ ...first, frame: 0 });
  const last = extended[extended.length - 1]!;
  if (last.frame < durationFrames) extended.push({ ...last, frame: durationFrames });
  return extended;
}

export async function buildExport(project: Project, settings: ExportSettings, options: BuildOptions): Promise<BuiltExport> {
  const durationFrames = timelineDurationFrames(project);
  if (durationFrames <= 0) {
    throw new HttpError(422, "La línea de tiempo está vacía. Añade clips antes de exportar.", "empty_timeline");
  }
  const dims = dimensionsFor(settings.aspect, settings.resolution);
  const { width, height } = dims;
  const fps = settings.fps;
  const durationSeconds = framesToSeconds(durationFrames, project.settings.fps);
  const inputs: string[] = [];
  const chains: string[] = [];
  const textFiles: string[] = [];
  const audioEntries: Array<{ label: string; role: AudioTrackRole }> = [];
  let inputIndex = 0;

  await fs.mkdir(options.tempDir, { recursive: true });

  // Base de video.
  chains.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${durationSeconds.toFixed(6)},format=rgba[base]`);
  let videoLabel = "base";
  let overlayCount = 0;

  const videoTracks = [...project.tracks]
    .filter((track) => track.kind === "video" && !track.hidden)
    .sort((a, b) => visualLayerWeight(a) - visualLayerWeight(b));
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (clip.type !== "video" && clip.type !== "image") continue;
      // Si el clip se renderiza en vivo mediante la pasada de Remotion, lo omitimos del pase base FFmpeg
      if (options.skipText && isLiveRemotionClip(clip)) continue;
      const asset = project.media.find((item) => item.id === clip.mediaId);
      if (!asset || asset.missing) continue;
      const filePath = path.join(options.projectDir, asset.file);
      const fileExists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      if (!fileExists) continue;
      const spanSeconds = Math.max(0.001, (clip.sourceOutUs - clip.sourceInUs) / 1_000_000);
      if (clip.type === "image") {
        inputs.push("-loop", "1", "-t", sec(clip.durationFrames, project), "-i", filePath);
      } else {
        inputs.push(
          "-accurate_seek",
          "-ss",
          (clip.sourceInUs / 1_000_000).toFixed(6),
          "-t",
          spanSeconds.toFixed(6),
          "-i",
          filePath,
        );
      }
      const index = inputIndex;
      inputIndex += 1;
      const label = `v${overlayCount}`;
      const fpsNum = project.settings.fps.num;
      const fpsDen = project.settings.fps.den;
      const fpsVal = fpsNum / fpsDen;
      const clipDurationSec = clip.durationFrames / fpsVal;
      const startSec = Number(sec(clip.startFrame, project));
      const endSec = Number(sec(clipEnd(clip), project));
      const localT = `(t-${startSec.toFixed(6)})`;

      const crop = clip.crop;
      const cropW = Math.max(0.01, 1 - crop.left - crop.right);
      const cropH = Math.max(0.01, 1 - crop.top - crop.bottom);
      const cropFilter = `crop=trunc(iw*${cropW.toFixed(5)}/2)*2:trunc(ih*${cropH.toFixed(5)}/2)*2:trunc(iw*${crop.left.toFixed(5)}/2)*2:trunc(ih*${crop.top.toFixed(5)}/2)*2`;

      const animIn = clip.transform.animationIn ?? "none";
      const animInDuration = clip.transform.animationInDuration ?? 0;
      const animOut = clip.transform.animationOut ?? "none";
      const animOutDuration = clip.transform.animationOutDuration ?? 0;
      const inSec = Math.max(1e-4, animInDuration / fpsVal);
      const outSec = Math.max(1e-4, animOutDuration / fpsVal);
      const inFrames = Math.max(0, Math.round(animInDuration));
      const outFrames = Math.max(0, Math.round(animOutDuration));
      const outStartFrame = Math.max(0, clip.durationFrames - outFrames);

      // Zoom efectivo (1 = encuadre completo) a partir de keyframes o animaciones.
      const zoomAtFrame = (localFrame: number): number => {
        let zoom = 1;
        if (inFrames > 0 && localFrame <= inFrames) {
          const progress = localFrame / inFrames;
          if (animIn === "zoom-in") zoom *= 0.5 + 0.5 * progress;
          else if (animIn === "bounce-in") {
            zoom *= 1 + 0.4 * Math.sin(progress * Math.PI * 2) * (1 - progress);
          }
        }
        if (outFrames > 0 && localFrame >= outStartFrame) {
          const progress = Math.min(1, (localFrame - outStartFrame) / outFrames);
          if (animOut === "zoom-out") zoom *= 1 + 0.5 * (1 - progress);
          else if (animOut === "bounce-out") {
            zoom *= 1 + 0.4 * Math.sin((1 - progress) * Math.PI * 2) * progress;
          }
        }
        return zoom;
      };

      const keyframePoints = (clip.transform.keyframes ?? [])
        .filter(
          (keyframe) =>
            Number.isFinite(keyframe.frame) &&
            keyframe.frame >= 0 &&
            keyframe.frame <= clip.durationFrames,
        )
        .sort((a, b) => a.frame - b.frame);
      let zoomPoints: Array<{ frame: number; value: number }> = [];
      if (keyframePoints.length >= 2) {
        zoomPoints = keyframePoints.map((keyframe) => ({ frame: keyframe.frame, value: keyframe.scale }));
        const firstPoint = zoomPoints[0]!;
        if (firstPoint.frame > 0) zoomPoints.unshift({ frame: 0, value: firstPoint.value });
        const lastPoint = zoomPoints[zoomPoints.length - 1]!;
        if (lastPoint.frame < clip.durationFrames) {
          zoomPoints.push({ frame: clip.durationFrames, value: lastPoint.value });
        }
      } else if (inFrames > 0 || outFrames > 0) {
        const frames = new Set<number>([0, clip.durationFrames]);
        for (const range of [
          { start: 0, end: inFrames },
          { start: outStartFrame, end: clip.durationFrames },
        ]) {
          if (range.end <= range.start) continue;
          const steps = 8;
          for (let stepIndex = 0; stepIndex <= steps; stepIndex += 1) {
            frames.add(Math.round(range.start + ((range.end - range.start) * stepIndex) / steps));
          }
        }
        zoomPoints = [...frames]
          .sort((a, b) => a - b)
          .map((frame) => ({ frame, value: zoomAtFrame(frame) }));
      }

      const baseScale = clip.transform.scale && clip.transform.scale > 0 ? clip.transform.scale : 1.0;
      const relativeZoomPoints = zoomPoints.map((point) => {
        const normalized =
          baseScale > 1.01 && point.value >= baseScale * 0.9
            ? point.value / baseScale
            : point.value;
        return {
          frame: point.frame,
          value: Math.max(0.5, Math.min(1.4, normalized)),
        };
      });

      const hasZoomMotion =
        relativeZoomPoints.length >= 2 &&
        relativeZoomPoints.some((point) => Math.abs(point.value - 1) > 0.001);
      let stageZoom = 1;
      if (hasZoomMotion) {
        const maxZoom = Math.max(...relativeZoomPoints.map((point) => point.value));
        const minZoom = Math.min(...relativeZoomPoints.map((point) => point.value));
        const maxStage = width >= 3000 || height >= 3000 ? 1.35 : 1.65;
        stageZoom = Math.min(maxStage, Math.max(1, maxZoom, minZoom > 0 ? 1 / minZoom : 1));
      }

      // Encuadre del clip dentro del lienzo, sin deformar la imagen. El recorte
      // (crop) cambia la relacion de aspecto efectiva: si se ignora, el clip
      // recortado se estira o deja bandas negras.
      const rotatedSource = Boolean(asset.rotation && Math.abs(asset.rotation % 180) === 90);
      const sourceWidth = rotatedSource ? asset.height ?? 0 : asset.width ?? 0;
      const sourceHeight = rotatedSource ? asset.width ?? 0 : asset.height ?? 0;
      const sourceAspect = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : width / height;
      const cropWidthRatio = Math.max(0.02, 1 - clip.crop.left - clip.crop.right);
      const cropHeightRatio = Math.max(0.02, 1 - clip.crop.top - clip.crop.bottom);
      const effectiveAspect = sourceAspect * (cropWidthRatio / cropHeightRatio);
      const canvasAspect = width / height;
      const fitWidth = effectiveAspect >= canvasAspect ? even(width) : even(height * effectiveAspect);
      const fitHeight = effectiveAspect >= canvasAspect ? even(width / effectiveAspect) : even(height);

      const filters: string[] = ["setpts=PTS-STARTPTS", cropFilter];
      if (hasZoomMotion) {
        const clampedBaseScale = Math.min(1.85, baseScale);
        const stageWidth = even(fitWidth * stageZoom * clampedBaseScale);
        const stageHeight = even(fitHeight * stageZoom * clampedBaseScale);
        // Procesar zoompan en yuv420p (mucho más rápido que RGBA) y aplicar rgba solo después si hace falta alfa
        filters.push(
          `scale=${stageWidth}:${stageHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          "format=yuv420p",
        );
        const minRel = Math.min(...relativeZoomPoints.map((p) => p.value));
        if (minRel < 0.999) {
          filters.push(`pad=${stageWidth}:${stageHeight}:(ow-iw)/2:(oh-ih)/2:color=black`);
        }
        const frameVariable =
          Math.abs(clip.speed - 1) > 0.0001 ? `(in*${clip.speed.toFixed(4)})` : "in";
        const effectiveStageFactor = minRel < 0.999 ? stageZoom : 1;
        const zoomExpression = piecewiseExpression(
          relativeZoomPoints.map((point) => ({
            frame: point.frame,
            value: Math.max(1, effectiveStageFactor * point.value),
          })),
          frameVariable,
        );
        const panPoints = extendKeyframes(keyframePoints, clip.durationFrames);
        const panX =
          panPoints.length >= 2
            ? piecewiseExpression(
                panPoints.map((point) => ({
                  frame: point.frame,
                  value: (-(point.x ?? 0) / 100) * fitWidth,
                })),
                frameVariable,
              )
            : "0";
        const panY =
          panPoints.length >= 2
            ? piecewiseExpression(
                panPoints.map((point) => ({
                  frame: point.frame,
                  value: (-(point.y ?? 0) / 100) * fitHeight,
                })),
                frameVariable,
              )
            : "0";
        filters.push(
          `zoompan=z='${zoomExpression}':x='iw/2-(iw/zoom/2)+${panX}':y='ih/2-(ih/zoom/2)+${panY}':d=1:s=${fitWidth}x${fitHeight}:fps=${fpsVal}`,
          "setpts=PTS-STARTPTS",
        );
      } else if (Math.abs(baseScale - 1) > 0.005) {
        const scaledWidth = even(fitWidth * baseScale);
        const scaledHeight = even(fitHeight * baseScale);
        filters.push(
          `fps=${fpsVal}`,
          `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          `crop=${fitWidth}:${fitHeight}:(iw-ow)/2:(ih-oh)/2`,
        );
      } else {
        filters.push(
          `fps=${fpsVal}`,
          `scale=${fitWidth}:${fitHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        );
      }
      if (Math.abs(clip.transform.rotation) > 0.01) {
        const degrees = clip.transform.rotation.toFixed(3);
        filters.push(
          `rotate=a=${degrees}*PI/180:c=black@0:ow=rotw(${degrees}*PI/180):oh=roth(${degrees}*PI/180)`,
        );
      }
      if (clip.type !== "image" && Math.abs(clip.speed - 1) > 0.0001) {
        filters.push(`setpts=PTS/${clip.speed.toFixed(4)}`);
      }
      filters.push(
        `eq=brightness=${(clip.adjustments.brightness - 1).toFixed(4)}:contrast=${clip.adjustments.contrast.toFixed(3)}:saturation=${clip.adjustments.saturation.toFixed(3)}`,
        "format=rgba",
        `colorchannelmixer=aa=${clip.opacity.toFixed(4)}`,
      );
      // Fade-in/fade-out usando filtro fade de FFmpeg
      if (animIn === "fade-in" && animInDuration > 0) {
        filters.push(`fade=t=in:st=0:d=${inSec.toFixed(6)}:alpha=1`);
      } else if (clip.fadeInFrames > 0) {
        filters.push(`fade=t=in:st=0:d=${sec(clip.fadeInFrames, project)}:alpha=1`);
      }
      if (animOut === "fade-out" && animOutDuration > 0) {
        const fadeOutStartSec = clipDurationSec - outSec;
        filters.push(`fade=t=out:st=${fadeOutStartSec.toFixed(6)}:d=${outSec.toFixed(6)}:alpha=1`);
      } else if (clip.fadeOutFrames > 0) {
        const fadeStart = Math.max(0, clip.durationFrames - clip.fadeOutFrames);
        filters.push(`fade=t=out:st=${sec(fadeStart, project)}:d=${sec(clip.fadeOutFrames, project)}:alpha=1`);
      }
      filters.push(`setpts=PTS-STARTPTS+${startSec.toFixed(6)}/TB`);
      chains.push(`[${index}:v]${filters.join(",")}[${label}]`);

      const baseX = (width - fitWidth) / 2 + (clip.transform.x / 100) * width;
      const baseY = (height - fitHeight) / 2 + (clip.transform.y / 100) * height;
      let xExpr = baseX.toFixed(2);
      let yExpr = baseY.toFixed(2);
      const outStartSec = clipDurationSec - outSec;

      // --- Animación de entrada ---
      if (animIn === "slide-left") {
        xExpr = `if(lte(${localT},${inSec.toFixed(6)}),${(baseX - fitWidth).toFixed(2)}+(${localT}/${inSec.toFixed(6)})*${fitWidth},${baseX.toFixed(2)})`;
      } else if (animIn === "slide-right") {
        xExpr = `if(lte(${localT},${inSec.toFixed(6)}),${(baseX + width).toFixed(2)}-(${localT}/${inSec.toFixed(6)})*${width},${baseX.toFixed(2)})`;
      } else if (animIn === "slide-up") {
        yExpr = `if(lte(${localT},${inSec.toFixed(6)}),${(baseY + height).toFixed(2)}-(${localT}/${inSec.toFixed(6)})*${height},${baseY.toFixed(2)})`;
      } else if (animIn === "slide-down") {
        yExpr = `if(lte(${localT},${inSec.toFixed(6)}),${(baseY - fitHeight).toFixed(2)}+(${localT}/${inSec.toFixed(6)})*${fitHeight},${baseY.toFixed(2)})`;
      }

      // --- Animación de salida ---
      if (animOut === "slide-left") {
        xExpr = `if(gt(${localT},${outStartSec.toFixed(6)}),${baseX.toFixed(2)}-((${localT}-${outStartSec.toFixed(6)})/${outSec.toFixed(6)})*${fitWidth},${xExpr})`;
      } else if (animOut === "slide-right") {
        xExpr = `if(gt(${localT},${outStartSec.toFixed(6)}),${baseX.toFixed(2)}+((${localT}-${outStartSec.toFixed(6)})/${outSec.toFixed(6)})*${width},${xExpr})`;
      } else if (animOut === "slide-up") {
        yExpr = `if(gt(${localT},${outStartSec.toFixed(6)}),${baseY.toFixed(2)}-((${localT}-${outStartSec.toFixed(6)})/${outSec.toFixed(6)})*${fitHeight},${yExpr})`;
      } else if (animOut === "slide-down") {
        yExpr = `if(gt(${localT},${outStartSec.toFixed(6)}),${baseY.toFixed(2)}+((${localT}-${outStartSec.toFixed(6)})/${outSec.toFixed(6)})*${height},${yExpr})`;
      }

      const next = `ov${overlayCount}`;
      chains.push(
        `[${videoLabel}][${label}]overlay='x=${xExpr}:y=${yExpr}:eof_action=pass:repeatlast=0:enable=between(t,${startSec.toFixed(6)},${endSec.toFixed(6)})'[${next}]`,
      );
      videoLabel = next;
      overlayCount += 1;

      if (clip.type === "video" && asset.audioCodec && !track.muted) {
        const audioFilters = ["asetpts=PTS-STARTPTS"];
        const tempo = atempoChain(clip.speed);
        if (tempo) audioFilters.push(tempo);
        if (clip.audioEnhance === "voice") {
          audioFilters.push("highpass=f=85", "afftdn=nr=10:nf=-30", "acompressor=threshold=0.12:ratio=3:attack=10:release=200");
        }
        audioFilters.push(`volume=${Math.min(2, clip.volume * track.volume).toFixed(4)}`);
        if (clip.fadeInFrames > 0) {
          audioFilters.push(`afade=t=in:st=0:d=${sec(clip.fadeInFrames, project)}`);
        } else if (clipDurationSec > 0.15) {
          audioFilters.push("afade=t=in:st=0:d=0.038");
        }
        if (clip.fadeOutFrames > 0) {
          const fadeStart = Math.max(0, clip.durationFrames - clip.fadeOutFrames);
          audioFilters.push(`afade=t=out:st=${sec(fadeStart, project)}:d=${sec(clip.fadeOutFrames, project)}`);
        } else if (clipDurationSec > 0.15) {
          const microFadeOutStart = Math.max(0, clipDurationSec - 0.045);
          audioFilters.push(`afade=t=out:st=${microFadeOutStart.toFixed(6)}:d=0.045`);
        }
        audioFilters.push(`atrim=0:${sec(clip.durationFrames, project)}`, "asetpts=PTS-STARTPTS");
        const delayMs = Math.round(framesToSeconds(clip.startFrame, project.settings.fps) * 1000);
        audioFilters.push(`adelay=delays=${delayMs}:all=1`);
        const audioLabel = `a${audioEntries.length}`;
        chains.push(`[${index}:a]${audioFilters.join(",")}[${audioLabel}]`);
        audioEntries.push({ label: audioLabel, role: classifyAudioTrackRole(track.name) });
      }
    }
  }

  const audioTracks = project.tracks.filter((track) => track.kind === "audio" && !track.muted && !track.hidden);
  for (const track of audioTracks) {
    for (const clip of track.clips) {
      if (clip.type !== "audio") continue;
      const asset = project.media.find((item) => item.id === clip.mediaId);
      if (!asset || asset.missing) continue;
      const filePath = path.join(options.projectDir, asset.file);
      const spanSeconds = Math.max(0.001, (clip.sourceOutUs - clip.sourceInUs) / 1_000_000);
      inputs.push(
        "-ss",
        (clip.sourceInUs / 1_000_000).toFixed(6),
        "-t",
        spanSeconds.toFixed(6),
        "-i",
        filePath,
      );
      const index = inputIndex;
      inputIndex += 1;
      const audioFilters = ["asetpts=PTS-STARTPTS"];
      const tempo = atempoChain(clip.speed);
      if (tempo) audioFilters.push(tempo);
      if (clip.audioEnhance === "voice") {
        audioFilters.push("highpass=f=85", "afftdn=nr=10:nf=-30", "acompressor=threshold=0.12:ratio=3:attack=10:release=200");
      }
      audioFilters.push(`volume=${Math.min(2, clip.volume * track.volume).toFixed(4)}`);
      if (clip.fadeInFrames > 0) {
        audioFilters.push(`afade=t=in:st=0:d=${sec(clip.fadeInFrames, project)}`);
      }
      if (clip.fadeOutFrames > 0) {
        const fadeStart = Math.max(0, clip.durationFrames - clip.fadeOutFrames);
        audioFilters.push(`afade=t=out:st=${sec(fadeStart, project)}:d=${sec(clip.fadeOutFrames, project)}`);
      }
      audioFilters.push(`atrim=0:${sec(clip.durationFrames, project)}`, "asetpts=PTS-STARTPTS");
      const delayMs = Math.round(framesToSeconds(clip.startFrame, project.settings.fps) * 1000);
      audioFilters.push(`adelay=delays=${delayMs}:all=1`);
      const audioLabel = `a${audioEntries.length}`;
      chains.push(`[${index}:a]${audioFilters.join(",")}[${audioLabel}]`);
      audioEntries.push({ label: audioLabel, role: classifyAudioTrackRole(track.name) });
    }
  }

  // Texto y subtítulos quemados sobre la composición final.
  const textClips = options.skipText
    ? []
    : project.tracks
        .filter((track) => track.kind === "text" && !track.hidden)
        .flatMap((track) => track.clips)
        .filter((clip): clip is TextClip => clip.type === "text" && !clip.remotion?.code)
        .sort((a, b) => a.startFrame - b.startFrame);
  for (const [index, clip] of textClips.entries()) {
    const family = fontFamily(clip.fontFamily);
    const scale = height / 1080;
    const fontSize = Math.max(8, Math.round(clip.fontSize * scale));
    const maxWidthPx = width * clip.maxWidth;
    const maxChars = Math.max(10, Math.floor(maxWidthPx / (fontSize * family.charsPerEm)));
    const wrapped = wrapText(transformText(clip.text, clip.textTransform), maxChars);
    const textFile = path.join(options.tempDir, `text-${index}.txt`);
    await fs.writeFile(textFile, wrapped, "utf8");
    textFiles.push(textFile);
    const position = textPosition(clip);
    const start = Number(sec(clip.startFrame, project));
    const end = Number(sec(clipEnd(clip), project));
    const inDuration = framesToSeconds(clip.animationInDuration, project.settings.fps);
    const outDuration = framesToSeconds(clip.animationOutDuration, project.settings.fps);
    const progressIn = inDuration > 0
      ? `max(0,min(1,(t-${start.toFixed(6)})/${inDuration.toFixed(6)}))`
      : "1";
    const progressOut = outDuration > 0
      ? `max(0,min(1,(${end.toFixed(6)}-t)/${outDuration.toFixed(6)}))`
      : "1";
    const offsetX: string[] = [];
    const offsetY: string[] = [];
    const scaleExpressions: string[] = [];
    const alphaExpressions: string[] = [];
    const horizontalOffset = `(W+text_w)*(1-${progressIn})`;
    const verticalOffset = `(H+text_h)*(1-${progressIn})`;
    const horizontalExitOffset = `(W+text_w)*(1-${progressOut})`;
    const verticalExitOffset = `(H+text_h)*(1-${progressOut})`;
    if (clip.animationIn === "slide-left") offsetX.push(`-${horizontalOffset}`);
    if (clip.animationIn === "slide-right") offsetX.push(horizontalOffset);
    if (clip.animationIn === "slide-up") offsetY.push(verticalOffset);
    if (clip.animationIn === "slide-down") offsetY.push(`-${verticalOffset}`);
    if (clip.animationIn === "zoom-in") scaleExpressions.push(`(0.5+0.5*${progressIn})`);
    if (clip.animationIn === "bounce-in") {
      scaleExpressions.push(`(1+0.4*sin(${progressIn}*PI*2)*(1-${progressIn}))`);
    }
    if (clip.animationIn === "fade-in") alphaExpressions.push(progressIn);

    if (clip.animationOut === "slide-left") offsetX.push(`-${horizontalExitOffset}`);
    if (clip.animationOut === "slide-right") offsetX.push(horizontalExitOffset);
    if (clip.animationOut === "slide-up") offsetY.push(verticalExitOffset);
    if (clip.animationOut === "slide-down") offsetY.push(`-${verticalExitOffset}`);
    if (clip.animationOut === "zoom-out") scaleExpressions.push(`(1+0.5*(1-${progressOut}))`);
    if (clip.animationOut === "bounce-out") {
      scaleExpressions.push(`(1+0.4*sin((1-${progressOut})*PI*2)*${progressOut})`);
    }
    if (clip.animationOut === "fade-out") alphaExpressions.push(progressOut);

    const x = [position.x, ...offsetX].join("+").replace(/\+-/g, "-");
    const y = [position.y, ...offsetY].join("+").replace(/\+-/g, "-");
    const fade = Math.min(clip.fadeFrames, Math.floor(clip.durationFrames / 2));
    const optionsList = [
      `fontfile='${escapeFilterPath(fontFileFor(clip))}'`,
      `textfile='${escapeFilterPath(textFile)}'`,
      `fontsize='max(1,${fontSize}${scaleExpressions.length ? `*${scaleExpressions.join("*")}` : ""})'`,
      `fontcolor=${clip.color}`,
      `x='${x}'`,
      `y='${y}'`,
      `line_spacing=${Math.round(fontSize * (clip.lineHeight - 1))}`,
      `enable='between(t,${start.toFixed(6)},${end.toFixed(6)})'`,
    ];
    const strokeWidth = Math.round(clip.strokeWidth * scale);
    if (strokeWidth > 0) {
      optionsList.push(`borderw=${strokeWidth}`, `bordercolor=${clip.strokeColor}`);
    }
    if (clip.background) {
      optionsList.push(
        "box=1",
        `boxcolor=${ffmpegColor(clip.backgroundColor, clip.backgroundOpacity)}`,
        `boxborderw=${Math.round(clip.backgroundPadding * scale)}`,
      );
    } else if (clip.shadow > 0) {
      optionsList.push(
        `shadowcolor=${ffmpegColor(clip.shadowColor, 0.72)}`,
        "shadowx=0",
        `shadowy=${Math.max(1, Math.round(clip.shadow * 0.22 * scale))}`,
      );
    }
    if (fade > 0) {
      const fadeStart = start;
      const fadeEnd = end;
      const fadeSec = framesToSeconds(fade, project.settings.fps).toFixed(4);
      alphaExpressions.push(
        `if(lt(t,${(fadeStart + Number(fadeSec)).toFixed(6)}),max(0,(t-${fadeStart.toFixed(6)})/${fadeSec}),if(gt(t,${(fadeEnd - Number(fadeSec)).toFixed(6)}),max(0,(${fadeEnd.toFixed(6)}-t)/${fadeSec}),1))`,
      );
    }
    if (alphaExpressions.length > 0) {
      optionsList.push(`alpha='${alphaExpressions.length === 1 ? alphaExpressions[0] : `min(${alphaExpressions.join(",")})`}'`);
    }
    const next = `txt${index}`;
    chains.push(`[${videoLabel}]drawtext=${optionsList.join(":")}[${next}]`);
    videoLabel = next;
  }

  if (!options.skipText) {
    const assFile = path.join(options.tempDir, `subtitles-${Date.now()}.ass`);
    const hasAss = await writeAssSubtitlesForProject(project, settings, width, height, assFile);
    if (hasAss) {
      textFiles.push(assFile);
      const fontsDir = path.join(config.assetsDir, "fonts");
      const next = "subass";
      chains.push(
        `[${videoLabel}]ass=filename='${escapeFilterPath(assFile)}':fontsdir='${escapeFilterPath(fontsDir)}'[${next}]`,
      );
      videoLabel = next;
    }
  }

  chains.push(`[${videoLabel}]format=yuv420p[vfinal]`);

  chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${durationSeconds.toFixed(6)}[abase]`);
  const speechEntries = audioEntries.filter((entry) => entry.role === "speech");
  const musicEntries = audioEntries.filter((entry) => entry.role === "music");
  const sfxEntries = audioEntries.filter((entry) => entry.role === "sfx");

  if (options.smartDucking !== false && speechEntries.length > 0 && musicEntries.length > 0) {
    chains.push("[abase]asplit=3[abase_mix][abase_sc][abase_m]");
    chains.push(
      `[abase_sc]${speechEntries.map((entry) => `[${entry.label}]`).join("")}amix=inputs=${speechEntries.length + 1}:normalize=0:dropout_transition=0,aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[aspeech_mix][aspeech_sc]`,
    );
    chains.push(
      `[abase_m]${musicEntries.map((entry) => `[${entry.label}]`).join("")}amix=inputs=${musicEntries.length + 1}:normalize=0:dropout_transition=0,aformat=sample_rates=48000:channel_layouts=stereo[amusic_raw]`,
    );
    chains.push(
      "[amusic_raw][aspeech_sc]sidechaincompress=threshold=0.025:ratio=4.5:attack=18:release=320[amusic_ducked]",
    );
    const duckedInputs = ["[abase_mix]", "[aspeech_mix]", "[amusic_ducked]", ...sfxEntries.map((entry) => `[${entry.label}]`)];
    chains.push(
      `${duckedInputs.join("")}amix=inputs=${duckedInputs.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`,
    );
  } else if (audioEntries.length > 0) {
    chains.push(
      `[abase]${audioEntries.map((entry) => `[${entry.label}]`).join("")}amix=inputs=${audioEntries.length + 1}:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`,
    );
  } else {
    chains.push("[abase]anull[aout]");
  }

  const filterGraph = `${chains.join(";\n")}`;
  const filterFile = path.join(options.tempDir, `filter-${Date.now()}.txt`);
  await fs.writeFile(filterFile, filterGraph, "utf8");
  const filterOption = await filterScriptOption();

  const durationUs = Math.round(durationSeconds * 1_000_000);
  const args = [
    "-y",
    ...inputs,
    filterOption,
    filterFile,
    "-map",
    "[vfinal]",
    "-map",
    "[aout]",
    "-t",
    durationSeconds.toFixed(6),
    "-c:v",
    options.encoder,
    ...buildVideoCodecArgs(options.encoder, settings.quality, settings, Boolean(options.intermediate)),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "4096",
    options.outputFile,
  ];

  return {
    args,
    filterFile,
    textFiles,
    durationFrames,
    durationUs,
    width,
    height,
    expectedAudio: true,
  };
}

/** Recorta todas las pistas para que el proyecto no supere la duración indicada. */
export function trimProjectToSeconds(project: Project, targetSeconds: number): Project {
  const fps = project.settings.fps;
  const targetFrames = Math.max(1, Math.round((targetSeconds * fps.num) / fps.den));
  const current = timelineDurationFrames(project);
  if (current <= targetFrames) return project;
  const frameUs = frameDurationUs(fps);
  const tracks = project.tracks.map((track) => {
    const clips = track.clips
      .filter((clip) => clip.startFrame < targetFrames)
      .map((clip) => {
        const maxDuration = targetFrames - clip.startFrame;
        if (clip.durationFrames <= maxDuration) return clip;
        const durationFrames = Math.max(1, maxDuration);
        if (clip.type === "text") return { ...clip, durationFrames };
        const asset = project.media.find((item) => item.id === clip.mediaId);
        const maxUs = asset && asset.kind !== "image" ? asset.durationUs : Number.MAX_SAFE_INTEGER;
        const sourceOutUs = Math.min(
          maxUs,
          Math.round(clip.sourceInUs + durationFrames * frameUs * clip.speed),
        );
        return { ...clip, durationFrames, sourceOutUs };
      });
    return { ...track, clips };
  });
  return touchProject({ ...project, tracks });
}

export interface CompositeOptions {
  baseFile: string;
  framesDir: string;
  frameCount: number;
  settings: ExportSettings;
  encoder: "libx264" | "h264_nvenc";
  outputFile: string;
  durationSeconds: number;
  overlayFps?: number;
}

/**
 * Pase final del motor Remotion: compone la secuencia PNG con alfa (gráficos de
 * Remotion) sobre el video base y copia el audio sin recodificarlo.
 */
export function buildCompositeArgs(options: CompositeOptions): string[] {
  if (options.frameCount <= 0) throw new HttpError(500, "No hay fotogramas de gráficos para componer.", "remotion_frames_missing");
  const { width, height } = dimensionsFor(options.settings.aspect, options.settings.resolution);
  return [
    "-y",
    "-i",
    options.baseFile,
    "-framerate",
    String(options.overlayFps ?? options.settings.fps),
    "-start_number",
    "0",
    "-i",
    path.join(options.framesDir, "frame_%06d.png"),
    "-filter_complex",
    `[1:v]scale=${width}:${height}:flags=bicubic,format=rgba[ov];[0:v][ov]overlay=0:0:format=auto[v]`,
    "-map",
    "[v]",
    "-map",
    "0:a?",
    "-c:v",
    options.encoder,
    ...buildVideoCodecArgs(options.encoder, options.settings.quality, options.settings, false),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-t",
    options.durationSeconds.toFixed(6),
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "4096",
    options.outputFile,
  ];
}
