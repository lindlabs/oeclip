import type { ExportSettings, Project, TextClip } from "./schema";
import { dimensionsFor } from "./presets";
import { wrapText } from "./srt";
import { FONT_FAMILIES, fontFamily, transformText } from "./subtitles";

/**
 * Especificación de una capa de texto lista para renderizar con Remotion.
 * El servidor la calcula de forma pura y determinista (mismas métricas que el
 * export FFmpeg y el preview de canvas) y la composición la dibuja con DOM/CSS.
 */
export interface OverlayGraphicSpec {
  kind: "bars" | "counter" | "progress" | "title-card" | "accent";
  title?: string;
  subtitle?: string;
  unit?: string;
  value?: number;
  decimals: number;
  items?: Array<{ label: string; value: number; color?: string }>;
  maxValue?: number;
  color: string;
  trackColor: string;
  background: boolean;
  backgroundOpacity: number;
  widthPx: number;
  heightPx: number;
  shape: "circle" | "line" | "square";
  animation: "grow" | "fade";
}

export interface OverlaySpec {
  id: string;
  /** Líneas ya partadas con la misma estimación de caracteres que el export. */
  lines: string[];
  /** Ancla horizontal (0..1 del ancho del lienzo). */
  anchorX: number;
  /** Centro vertical del bloque (0..1 del alto del lienzo). */
  anchorY: number;
  align: "left" | "center" | "right";
  fontSizePx: number;
  lineHeightPx: number;
  fontCss: string;
  fontFile: string;
  fontWeight: number;
  color: string;
  opacity: number;
  fadeFrames: number;
  startFrame: number;
  durationFrames: number;
  background: {
    color: string;
    opacity: number;
    paddingX: number;
    paddingY: number;
    radius: number;
  } | null;
  stroke: { widthPx: number; color: string } | null;
  shadow: {
    color: string;
    alpha: number;
    offsetX: number;
    offsetY: number;
    blur: number;
  } | null;
  /** Estimación del ancho de la línea más ancha, para distancias de slide. */
  estWidestPx: number;
  blockHeightPx: number;
  animationIn: string;
  animationInFrames: number;
  animationOut: string;
  animationOutFrames: number;
  graphic: OverlayGraphicSpec | null;
}

export interface OverlayFontSpec {
  css: string;
  file: string;
}

/** Especificación de un componente Remotion TSX compilado en vivo para exportación. */
export interface LiveRemotionExportSpec {
  id: string;
  cjsCode: string;
  componentName: string;
  compositionId: string;
  startFrame: number;
  durationFrames: number;
  props: Record<string, unknown>;
  opacity: number;
  transformStyle?: string;
  transformOrigin?: string;
  zIndex?: number;
}

export const NOVACUT_OVERLAY_COMPOSITION_ID = "novacut-overlays";

function cssWeight(weight: number): number {
  if (weight >= 700) return 900;
  if (weight >= 600) return 700;
  return weight;
}

function specFromClip(
  clip: TextClip,
  width: number,
  height: number,
  projectFps: number,
  exportFps: number,
): OverlaySpec {
  const scale = height / 1080;
  const fontSizePx = Math.max(8, Math.round(clip.fontSize * scale));
  const family = fontFamily(clip.fontFamily);
  const maxWidthPx = width * clip.maxWidth;
  const maxChars = Math.max(10, Math.floor(maxWidthPx / (fontSizePx * family.charsPerEm)));
  const wrapped = wrapText(transformText(clip.text, clip.textTransform), maxChars);
  const lines = wrapped.split("\n");
  const lineHeightPx = fontSizePx * clip.lineHeight;
  const estWidestPx = lines.reduce(
    (max, line) => Math.max(max, line.length * fontSizePx * family.charsPerEm),
    fontSizePx,
  );
  const startSec = clip.startFrame / projectFps;
  const durationSec = clip.durationFrames / projectFps;
  const toFrames = (frames: number): number => Math.max(0, Math.round((frames / projectFps) * exportFps));
  const graphic = clip.graphic
    ? {
        kind: clip.graphic.kind,
        title: clip.graphic.title,
        subtitle: clip.graphic.subtitle,
        unit: clip.graphic.unit,
        value: clip.graphic.value,
        decimals: clip.graphic.decimals,
        items: clip.graphic.items,
        maxValue: clip.graphic.maxValue,
        color: clip.graphic.color,
        trackColor: clip.graphic.trackColor,
        background: clip.graphic.background,
        backgroundOpacity: clip.graphic.backgroundOpacity,
        widthPx: width * clip.graphic.width,
        heightPx: height * clip.graphic.height,
        shape: clip.graphic.shape,
        animation: clip.graphic.animation,
      }
    : null;
  return {
    id: clip.id,
    lines,
    anchorX: clip.graphic ? clip.graphic.position.x : clip.position.x,
    anchorY: clip.graphic ? clip.graphic.position.y : clip.position.y,
    align: clip.align,
    fontSizePx,
    lineHeightPx,
    fontCss: family.css,
    fontFile: family.file,
    fontWeight: cssWeight(clip.fontWeight),
    color: clip.color,
    opacity: clip.opacity,
    fadeFrames: toFrames(clip.fadeFrames),
    startFrame: Math.max(0, Math.round(startSec * exportFps)),
    durationFrames: Math.max(1, Math.round(durationSec * exportFps)),
    background: clip.background
      ? {
          color: clip.backgroundColor,
          opacity: clip.backgroundOpacity,
          paddingX: clip.backgroundPadding * scale,
          paddingY: clip.backgroundPadding * 0.72 * scale,
          radius: fontSizePx * 0.18,
        }
      : null,
    stroke: clip.strokeWidth > 0 ? { widthPx: clip.strokeWidth * scale * 2, color: clip.strokeColor } : null,
    shadow:
      clip.shadow > 0 && !clip.background
        ? {
            color: clip.shadowColor,
            alpha: 0.72,
            offsetX: 0,
            offsetY: Math.max(1, clip.shadow * 0.22 * scale),
            blur: Math.max(1, clip.shadow * scale),
          }
        : null,
    estWidestPx,
    blockHeightPx: lines.length * lineHeightPx,
    animationIn: clip.animationIn,
    animationInFrames: toFrames(clip.animationInDuration),
    animationOut: clip.animationOut,
    animationOutFrames: toFrames(clip.animationOutDuration),
    graphic,
  };
}

/** Todas las capas de texto estáticas visibles del proyecto (sin `remotion.code`), listas para Remotion. */
export function buildOverlaySpecs(project: Project, settings: ExportSettings): OverlaySpec[] {
  const { width, height } = dimensionsFor(settings.aspect, settings.resolution);
  const projectFps = project.settings.fps.num / project.settings.fps.den;
  const exportFps = settings.fps;
  return project.tracks
    .filter((track) => track.kind === "text" && !track.hidden)
    .flatMap((track) => track.clips)
    .filter((clip): clip is TextClip => clip.type === "text" && !clip.remotion?.code)
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((clip) => specFromClip(clip, width, height, projectFps, exportFps));
}

/** Catálogo completo de fuentes locales tipográficas disponibles para escenas Remotion IA. */
export function allProjectFonts(): OverlayFontSpec[] {
  return FONT_FAMILIES.map((f) => ({ css: f.css, file: f.file }));
}

/** Fuentes únicas usadas por los overlays (para inyectar @font-face). */
export function overlayFonts(
  specs: OverlaySpec[],
  options: { includeAllFamilies?: boolean } = {},
): OverlayFontSpec[] {
  const seen = new Set<string>();
  const fonts: OverlayFontSpec[] = [];
  for (const spec of specs) {
    if (seen.has(spec.fontCss)) continue;
    seen.add(spec.fontCss);
    fonts.push({ css: spec.fontCss, file: spec.fontFile });
  }
  if (options.includeAllFamilies) {
    for (const font of allProjectFonts()) {
      if (seen.has(font.css)) continue;
      seen.add(font.css);
      fonts.push(font);
    }
  }
  return fonts;
}
