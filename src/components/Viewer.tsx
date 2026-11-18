import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaClip, Project, TextClip, TimelineClip, Track } from "../shared/schema";
import { fontFamily, transformText } from "../shared/subtitles";
import { fpsValue, frameDurationUs, formatTimecode, framesToSeconds } from "../shared/time";
import { autoReframeProject, getClipById } from "../shared/project";
import { removeClips, updateClip } from "../shared/timeline";
import { ASPECT_PRESETS, type AspectRatio } from "../shared/presets";
import { api } from "../api";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { RemotionLiveOverlay, isLiveRemotionClip } from "./RemotionLiveOverlay";

/** Clip seleccionable en el preview: mapea a un clip del timeline */
export interface SelectableClip {
  id: string;
  type: "video" | "audio" | "text" | "image";
  trackId: string;
  trackName: string;
  trackKind: "video" | "audio" | "text";
  startFrame: number;
  durationFrames: number;
  mediaId?: string;
  /** Nombre amigable para mostrar en la barra flotante */
  displayName?: string;
  /** Escala porcentual actual (ej. 100) */
  scalePct?: number;
  /** Si es un componente IA de Remotion o subtítulo */
  isRemotion?: boolean;
  isSubtitle?: boolean;
  /** Props extra según tipo */
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  /** Bounding box en coordenadas normalizadas 0..1 del canvas */
  bounds: { x: number; y: number; width: number; height: number };
}

function computeRemotionClipBounds(
  clip: TimelineClip,
  project: Project,
): { bounds: { x: number; y: number; width: number; height: number }; scalePct: number; isSubtitle: boolean } {
  const isVertical = project.settings.height > project.settings.width;
  const rawName = (clip.remotion?.componentName || clip.name || "").toLowerCase();
  const isSubs =
    Array.isArray(clip.remotion?.props?.captions) ||
    (clip.type === "text" && clip.role === "subtitle") ||
    /subtit|caption|subs|hormozi|minimal|cinematic|neon|karaoke|tiktok|impact/i.test(rawName);

  if (isSubs) {
    const rawScale = Number(clip.remotion?.props?.fontScale ?? 1);
    const scaleMult = Math.max(0.35, Math.min(2.5, rawScale > 5 ? rawScale / 100 : rawScale));
    const defaultPosY = isVertical ? 0.74 : 0.86;
    const rawPosY = Number(clip.remotion?.props?.positionY ?? defaultPosY);
    const posY = Math.max(0.12, Math.min(0.96, rawPosY > 1.5 ? rawPosY / 100 : rawPosY));
    const offsetX = Number(clip.remotion?.props?.offsetX ?? 0);
    const w = Math.min(0.90, Math.max(0.32, 0.70 * scaleMult));
    const h = Math.min(0.18, Math.max(0.06, 0.10 * scaleMult));
    const cx = Math.max(w / 2, Math.min(1 - w / 2, 0.5 + offsetX / 100));
    const cy = Math.max(h / 2, Math.min(1 - h / 2, posY - h * 0.4));
    return {
      bounds: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
      scalePct: Math.round(scaleMult * 100),
      isSubtitle: true,
    };
  }

  let baseCx = 0.5;
  let baseCy = 0.5;
  let baseW = 0.62;
  let baseH = 0.34;

  if (/lower|brand|identi|speaker|rotulo/.test(rawName)) {
    baseCx = isVertical ? 0.5 : 0.32;
    baseCy = isVertical ? 0.72 : 0.82;
    baseW = isVertical ? 0.78 : 0.48;
    baseH = 0.18;
  } else if (/stat|broll|metric|kpi|growth|dinero|ventas/.test(rawName)) {
    baseCx = isVertical ? 0.5 : 0.72;
    baseCy = isVertical ? 0.32 : 0.28;
    baseW = isVertical ? 0.74 : 0.4;
    baseH = 0.32;
  }

  const tx = clip.type !== "text" ? clip.transform.x / 100 : Number(clip.remotion?.props?.offsetX ?? 0) / 100;
  const ty = clip.type !== "text" ? clip.transform.y / 100 : Number(clip.remotion?.props?.offsetY ?? 0) / 100;
  const sc = Math.max(
    0.2,
    Math.min(
      3,
      clip.type !== "text"
        ? clip.transform.scale
        : Number(clip.remotion?.props?.scale ?? clip.remotion?.props?.fontScale ?? 1),
    ),
  );

  const w = Math.min(0.96, Math.max(0.12, baseW * sc));
  const h = Math.min(0.96, Math.max(0.08, baseH * sc));
  const cx = 0.5 + (baseCx - 0.5) * sc + tx;
  const cy = 0.5 + (baseCy - 0.5) * sc + ty;

  return {
    bounds: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
    scalePct: Math.round(sc * 100),
    isSubtitle: false,
  };
}

interface PreviewCanvasProps {
  project: Project;
  frame: number;
  playing: boolean;
  frameSize: { width: number; height: number } | null;
  onMediaError?: (message: string) => void;
  zoomLevel?: number;
  showSafeGuides?: boolean;
  /** Volumen maestro 0..1 */
  masterVolume?: number;
  /** Si está muteado globalmente */
  masterMuted?: boolean;
  /** Clip seleccionado actualmente */
  selectedClipId?: string;
  /** Clip bajo el cursor (hover) */
  hoveredClipId?: string;
  /** Callback cuando se hace click en un clip */
  onClipSelect?: (clipId: string | null) => void;
  /** Callback cuando cambia el hover */
  onClipHover?: (clipId: string | null) => void;
  /** Callback cuando se modifica el proyecto (mover, escalar, eliminar desde el monitor) */
  onProjectChange?: (project: Project, options?: { history?: boolean; save?: boolean; label?: string }) => void;
  /** Callback para adjuntar el elemento seleccionado directamente al chat de IA Motion */
  onAttachToChat?: (clipId: string, promptHint?: string) => void;
  /** Callback para abrir el Inspector del elemento seleccionado */
  onOpenInspector?: (clipId: string) => void;
}

type MediaElement = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

function isMediaElement(element: MediaElement): element is HTMLVideoElement | HTMLAudioElement {
  return element instanceof HTMLVideoElement || element instanceof HTMLAudioElement;
}

function clipFadeAlpha(clip: TimelineClip, frame: number): number {
  const local = frame - clip.startFrame;
  if (local < 0 || local >= clip.durationFrames) return 0;
  const fadeIn = clip.type === "text" ? clip.fadeFrames : clip.fadeInFrames;
  const fadeOut = clip.type === "text" ? clip.fadeFrames : clip.fadeOutFrames;
  let alpha = 1;
  if (fadeIn > 0) alpha = Math.min(alpha, Math.max(0, local / fadeIn));
  if (fadeOut > 0) {
    alpha = Math.min(alpha, Math.max(0, (clip.durationFrames - local) / fadeOut));
  }
  return Math.min(1, Math.max(0, alpha));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Estado de los keyframes de zoom en un fotograma local del clip. */
function mediaKeyframeState(clip: MediaClip, localFrame: number): { scale: number; x: number; y: number } {
  const keyframes = clip.transform.keyframes;
  if (!keyframes || keyframes.length < 2) return { scale: 1, x: 0, y: 0 };
  const points = [...keyframes].sort((a, b) => a.frame - b.frame);
  const first = points[0]!;
  if (localFrame <= first.frame) return { scale: first.scale, x: first.x ?? 0, y: first.y ?? 0 };
  const last = points[points.length - 1]!;
  if (localFrame >= last.frame) return { scale: last.scale, x: last.x ?? 0, y: last.y ?? 0 };
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    if (localFrame >= start.frame && localFrame <= end.frame) {
      const progress = (localFrame - start.frame) / Math.max(1, end.frame - start.frame);
      return {
        scale: start.scale + (end.scale - start.scale) * progress,
        x: (start.x ?? 0) + ((end.x ?? 0) - (start.x ?? 0)) * progress,
        y: (start.y ?? 0) + ((end.y ?? 0) - (start.y ?? 0)) * progress,
      };
    }
  }
  return { scale: 1, x: 0, y: 0 };
}

/** Animaciones de entrada/salida en fracciones del lienzo. */
function mediaAnimationState(
  clip: MediaClip,
  localFrame: number,
): { scale: number; offsetX: number; offsetY: number; alpha: number } {
  const transform = clip.transform;
  const inDuration = transform.animationInDuration;
  const outDuration = transform.animationOutDuration;
  const inProgress = inDuration > 0 ? clamp01(localFrame / inDuration) : 1;
  const outProgress = outDuration > 0 ? clamp01((clip.durationFrames - localFrame) / outDuration) : 1;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let alpha = 1;

  switch (transform.animationIn) {
    case "fade-in": alpha *= inProgress; break;
    case "slide-left": offsetX -= 1 - inProgress; break;
    case "slide-right": offsetX += 1 - inProgress; break;
    case "slide-up": offsetY += 1 - inProgress; break;
    case "slide-down": offsetY -= 1 - inProgress; break;
    case "zoom-in": scale *= 0.5 + 0.5 * inProgress; break;
    case "bounce-in": scale *= 1 + 0.4 * Math.sin(inProgress * Math.PI * 2) * (1 - inProgress); break;
  }

  switch (transform.animationOut) {
    case "fade-out": alpha *= outProgress; break;
    case "slide-left": offsetX -= 1 - outProgress; break;
    case "slide-right": offsetX += 1 - outProgress; break;
    case "slide-up": offsetY += 1 - outProgress; break;
    case "slide-down": offsetY -= 1 - outProgress; break;
    case "zoom-out": scale *= 1 + 0.5 * (1 - outProgress); break;
    case "bounce-out": scale *= 1 + 0.4 * Math.sin((1 - outProgress) * Math.PI * 2) * outProgress; break;
  }

  return { scale, offsetX, offsetY, alpha };
}

function wrapCanvasLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) { lines.push(line); line = word; }
      else line = candidate;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  const parsed = Number.parseInt(full, 16);
  if (!Number.isFinite(parsed)) return `rgba(0, 0, 0, ${alpha})`;
  const r = (parsed >> 16) & 255;
  const g = (parsed >> 8) & 255;
  const b = parsed & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

function drawGraphicBackdrop(
  ctx: CanvasRenderingContext2D,
  clip: TextClip,
  frame: number,
  width: number,
  height: number,
): void {
  const g = clip.graphic;
  if (!g || (g.kind !== "title-card" && g.kind !== "accent")) return;
  const local = Math.max(0, frame - clip.startFrame);
  const progress = Math.min(1, local / Math.max(1, Math.min(18, clip.durationFrames * 0.55)));
  const ease = 1 - Math.pow(1 - progress, 3);
  const bw = width * g.width;
  const bh = height * g.height;
  const cx = width * g.position.x;
  const cy = height * g.position.y;
  ctx.save();
  ctx.globalAlpha = clipFadeAlpha(clip, frame);
  const scale = 0.82 + 0.18 * ease;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  const radius = g.shape === "circle" ? Math.min(bw, bh) / 2 : g.shape === "square" ? Math.min(bw, bh) * 0.14 : Math.min(bw, bh) * 0.04;
  ctx.fillStyle = rgba(g.color, g.background ? 0.14 : 0);
  ctx.strokeStyle = rgba(g.color, 0.45);
  ctx.lineWidth = Math.max(2, width * 0.0025);
  ctx.beginPath();
  ctx.roundRect(-bw / 2, -bh / 2, bw, g.shape === "line" ? Math.max(6, bh * 0.08) : bh, radius);
  if (g.background) ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawDataGraphic(
  ctx: CanvasRenderingContext2D,
  clip: TextClip,
  frame: number,
  width: number,
  height: number,
): boolean {
  const g = clip.graphic;
  if (!g || (g.kind !== "bars" && g.kind !== "counter" && g.kind !== "progress")) return false;
  const local = Math.max(0, frame - clip.startFrame);
  const progress = Math.min(1, local / Math.max(1, Math.min(18, clip.durationFrames * 0.55)));
  const ease = 1 - Math.pow(1 - progress, 3);
  const bw = width * g.width;
  const bh = height * g.height;
  const left = width * g.position.x - bw / 2;
  const top = height * g.position.y - bh / 2;
  const pad = Math.max(18, Math.min(bw, bh) * 0.09);
  const titleSize = Math.max(20, Math.min(46, bw * 0.055));
  const labelSize = Math.max(15, Math.min(30, bw * 0.036));
  const family = fontFamily(clip.fontFamily);
  const baseAlpha = clipFadeAlpha(clip, frame);

  ctx.save();
  ctx.globalAlpha = baseAlpha;
  if (g.background) {
    ctx.fillStyle = rgba("#0C1A13", g.backgroundOpacity);
    ctx.beginPath();
    ctx.roundRect(left, top, bw, bh, Math.max(12, bw * 0.03));
    ctx.fill();
    ctx.strokeStyle = rgba(g.trackColor, 0.18);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  let y = top + pad;
  const title = g.title ?? clip.text;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  if (title) {
    ctx.font = `800 ${titleSize}px ${family.css}`;
    ctx.fillStyle = g.trackColor;
    ctx.fillText(title, left + pad, y, bw - pad * 2);
    y += titleSize * 1.25;
  }
  if (g.subtitle) {
    ctx.font = `500 ${labelSize}px ${family.css}`;
    ctx.fillStyle = rgba(g.trackColor, 0.72);
    ctx.fillText(g.subtitle, left + pad, y, bw - pad * 2);
    y += labelSize * 1.4;
  }
  y += pad * 0.35;

  if (g.kind === "counter") {
    const target = g.value ?? 87;
    const eased = target * ease;
    const big = Math.min(bh * 0.42, bw * 0.18);
    ctx.font = `900 ${big}px ${family.css}`;
    ctx.fillStyle = g.color;
    const suffix = g.unit ?? "";
    const valueText = `${g.decimals > 0 ? eased.toFixed(g.decimals).replace(".", ",") : Math.round(eased)}${suffix}`;
    ctx.fillText(valueText, left + pad, y, bw - pad * 2);
    const trackY = y + big * 1.15;
    const trackH = Math.max(6, bh * 0.035);
    ctx.fillStyle = rgba(g.trackColor, 0.16);
    ctx.beginPath();
    ctx.roundRect(left + pad, trackY, bw - pad * 2, trackH, trackH / 2);
    ctx.fill();
    ctx.fillStyle = g.color;
    ctx.beginPath();
    ctx.roundRect(left + pad, trackY, (bw - pad * 2) * Math.min(1, eased / Math.max(target, 1)), trackH, trackH / 2);
    ctx.fill();
    ctx.restore();
    return true;
  }

  if (g.kind === "progress") {
    const target = Math.max(0, Math.min(100, g.value ?? 72));
    const eased = target * ease;
    const big = Math.min(bh * 0.3, bw * 0.1);
    ctx.font = `900 ${big}px ${family.css}`;
    ctx.fillStyle = g.color;
    const suffix = g.unit ?? "%";
    ctx.fillText(`${g.decimals > 0 ? eased.toFixed(g.decimals).replace(".", ",") : Math.round(eased)}${suffix}`, left + pad, y);
    y += big * 1.2;
    const trackH = Math.max(10, bh * 0.08);
    ctx.fillStyle = rgba(g.trackColor, 0.18);
    ctx.beginPath();
    ctx.roundRect(left + pad, y, bw - pad * 2, trackH, trackH / 2);
    ctx.fill();
    ctx.fillStyle = g.color;
    ctx.beginPath();
    ctx.roundRect(left + pad, y, ((bw - pad * 2) * Math.min(100, eased)) / 100, trackH, trackH / 2);
    ctx.fill();
    ctx.restore();
    return true;
  }

  const items = g.items ?? [];
  const max = g.maxValue ?? Math.max(1, ...items.map((item) => Math.abs(item.value)));
  const rowGap = Math.max(8, bh * 0.035);
  const available = top + bh - pad - y;
  const rowHeight = Math.max(18, (available - rowGap * Math.max(0, items.length - 1)) / Math.max(1, items.length));
  const labelWidth = (bw - pad * 2) * 0.26;
  const valueWidth = (bw - pad * 2) * 0.18;
  items.forEach((item, index) => {
    const ownStart = index * 3;
    const own = Math.min(1, Math.max(0, (local - ownStart) / 14));
    const ownEase = 1 - Math.pow(1 - own, 3);
    const fraction = Math.max(0, Math.min(1, item.value / max));
    const rowY = y + index * (rowHeight + rowGap);
    const barLeft = left + pad + labelWidth + labelSize * 0.55;
    const barWidth = bw - pad * 2 - labelWidth - valueWidth - labelSize * 1.1;
    const barHeight = Math.max(8, rowHeight * 0.42);
    ctx.font = `600 ${labelSize}px ${family.css}`;
    ctx.fillStyle = rgba(g.trackColor, 0.86);
    ctx.textBaseline = "middle";
    ctx.fillText(item.label, left + pad, rowY + barHeight / 2, labelWidth);
    ctx.fillStyle = rgba(g.trackColor, 0.14);
    ctx.beginPath();
    ctx.roundRect(barLeft, rowY, barWidth, barHeight, barHeight / 2);
    ctx.fill();
    ctx.fillStyle = item.color ?? g.color;
    ctx.beginPath();
    ctx.roundRect(barLeft, rowY, barWidth * fraction * ownEase, barHeight, barHeight / 2);
    ctx.fill();
    ctx.fillStyle = g.color;
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(item.value * ownEase)}${g.unit ?? ""}`, left + bw - pad, rowY + barHeight / 2, valueWidth);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  });
  ctx.restore();
  return true;
}

function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: TextClip,
  frame: number,
  width: number,
  height: number,
) {
  const baseAlpha = clipFadeAlpha(clip, frame);
  if (baseAlpha <= 0) return;
  if (drawDataGraphic(ctx, clip, frame, width, height)) return;
  drawGraphicBackdrop(ctx, clip, frame, width, height);
  const scale = height / 1080;
  const fontSize = Math.max(8, clip.fontSize * scale);
  const weight = clip.fontWeight >= 700 ? 900 : clip.fontWeight >= 600 ? 700 : clip.fontWeight;
  const family = fontFamily(clip.fontFamily);
  const text = transformText(clip.text, clip.textTransform);
  ctx.save();
  ctx.font = `${weight} ${fontSize}px ${family.css}`;
  ctx.textBaseline = "top";
  const maxWidth = width * clip.maxWidth;
  const lines = wrapCanvasLines(ctx, text, maxWidth);
  const lineHeight = fontSize * clip.lineHeight;
  const totalHeight = lines.length * lineHeight;
  const measured = lines.map((line) => ctx.measureText(line).width);
  const widest = measured.reduce((max, value) => Math.max(max, value), 0);
  const anchorX = width * clip.position.x;
  const startY = height * clip.position.y - totalHeight / 2;
  let left = anchorX - widest / 2;
  if (clip.align === "left") left = anchorX;
  if (clip.align === "right") left = anchorX - widest;
  const paddingX = clip.backgroundPadding * scale;
  const paddingY = clip.backgroundPadding * 0.72 * scale;

  const localFrame = frame - clip.startFrame;
  const inProgress = clip.animationInDuration > 0 ? Math.min(1, Math.max(0, localFrame / clip.animationInDuration)) : 1;
  const outProgress = clip.animationOutDuration > 0 ? Math.min(1, Math.max(0, (clip.durationFrames - localFrame) / clip.animationOutDuration)) : 1;

  let alpha = baseAlpha;
  let offsetX = 0;
  let offsetY = 0;
  let animScale = 1;

  if (clip.animationIn === "fade-in") alpha *= inProgress;
  else if (clip.animationIn === "slide-left") offsetX -= widest * (1 - inProgress);
  else if (clip.animationIn === "slide-right") offsetX += widest * (1 - inProgress);
  else if (clip.animationIn === "slide-up") offsetY += totalHeight * (1 - inProgress);
  else if (clip.animationIn === "slide-down") offsetY -= totalHeight * (1 - inProgress);
  else if (clip.animationIn === "zoom-in") animScale = 0.5 + 0.5 * inProgress;
  else if (clip.animationIn === "bounce-in") animScale = 1 + 0.4 * Math.sin(inProgress * Math.PI * 2) * (1 - inProgress);

  if (clip.animationOut === "fade-out") alpha *= outProgress;
  else if (clip.animationOut === "slide-left") offsetX -= widest * (1 - outProgress);
  else if (clip.animationOut === "slide-right") offsetX += widest * (1 - outProgress);
  else if (clip.animationOut === "slide-up") offsetY += totalHeight * (1 - outProgress);
  else if (clip.animationOut === "slide-down") offsetY -= totalHeight * (1 - outProgress);
  else if (clip.animationOut === "zoom-out") animScale = 1 + 0.5 * (1 - outProgress);
  else if (clip.animationOut === "bounce-out") animScale = 1 + 0.4 * Math.sin((1 - outProgress) * Math.PI * 2) * outProgress;

  if (alpha <= 0) return;

  const animFontSize = fontSize * animScale;
  const animPaddingX = paddingX * animScale;
  const animPaddingY = paddingY * animScale;
  const animRadius = animFontSize * 0.18;

  ctx.font = `${weight} ${animFontSize}px ${family.css}`;
  ctx.textBaseline = "top";
  left += offsetX;
  const animStartY = startY + offsetY;

  if (clip.background) {
    ctx.globalAlpha = alpha * clip.backgroundOpacity;
    ctx.fillStyle = clip.backgroundColor;
    const bx = left - animPaddingX;
    const by = animStartY - animPaddingY;
    const bw = widest * animScale + animPaddingX * 2;
    const bh = totalHeight * animScale + animPaddingY * 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, animRadius);
    ctx.fill();
  }

  if (clip.shadow > 0 && !clip.background) {
    ctx.shadowColor = rgba(clip.shadowColor, 0.72 * alpha);
    ctx.shadowBlur = Math.max(1, clip.shadow * scale);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(1, clip.shadow * 0.22 * scale);
  }

  ctx.globalAlpha = alpha;
  ctx.fillStyle = clip.color;
  if (clip.strokeWidth > 0) {
    ctx.lineWidth = Math.max(1, clip.strokeWidth * scale * 2 * animScale);
    ctx.strokeStyle = clip.strokeColor;
    ctx.lineJoin = "round";
  }
  lines.forEach((line, index) => {
    const lineWidth = (measured[index] ?? 0) * animScale;
    let x = left;
    if (clip.align === "center") x = anchorX + offsetX - lineWidth / 2;
    if (clip.align === "right") x = anchorX + offsetX - lineWidth;
    const y = animStartY + index * lineHeight * animScale;
    if (clip.strokeWidth > 0) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

function drawMediaClip(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  element: MediaElement,
  frame: number,
  width: number,
  height: number,
) {
  if (clip.type === "text") return;
  if (element instanceof HTMLAudioElement) return;
  const naturalWidth = element instanceof HTMLImageElement ? element.naturalWidth : element.videoWidth;
  const naturalHeight = element instanceof HTMLImageElement ? element.naturalHeight : element.videoHeight;
  if (!naturalWidth || !naturalHeight) return;
  if (element instanceof HTMLVideoElement && element.readyState < 2) return;
  if (element instanceof HTMLImageElement && !element.complete) return;

  const crop = clip.crop;
  const cropW = Math.max(0.01, 1 - crop.left - crop.right);
  const cropH = Math.max(0.01, 1 - crop.top - crop.bottom);
  const sx = naturalWidth * crop.left;
  const sy = naturalHeight * crop.top;
  const sw = naturalWidth * cropW;
  const sh = naturalHeight * cropH;
  const localFrame = frame - clip.startFrame;
  const keyframe = mediaKeyframeState(clip, localFrame);
  const animation = mediaAnimationState(clip, localFrame);
  const fit = Math.min(width / sw, height / sh);
  const scale = fit * Math.max(0.05, clip.transform.scale) * keyframe.scale * animation.scale;
  const dw = sw * scale;
  const dh = sh * scale;
  const cx = width / 2 + ((clip.transform.x + keyframe.x) / 100) * width + animation.offsetX * width;
  const cy = height / 2 + ((clip.transform.y + keyframe.y) / 100) * height + animation.offsetY * height;
  const alpha = Math.min(1, Math.max(0, clip.opacity * clipFadeAlpha(clip, frame) * animation.alpha));
  if (alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  const { brightness, contrast, saturation } = clip.adjustments;
  if (brightness !== 1 || contrast !== 1 || saturation !== 1) {
    ctx.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
  }
  ctx.translate(cx, cy);
  if (Math.abs(clip.transform.rotation) > 0.01) ctx.rotate((clip.transform.rotation * Math.PI) / 180);
  ctx.drawImage(element, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

export function PreviewCanvas({
  project,
  frame,
  playing,
  frameSize,
  onMediaError,
  zoomLevel,
  showSafeGuides = false,
  masterVolume = 1,
  masterMuted = false,
  selectedClipId,
  hoveredClipId,
  onClipSelect,
  onClipHover,
  onProjectChange,
  onAttachToChat,
  onOpenInspector,
}: PreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const elementsRef = useRef(new Map<string, MediaElement>());
  const pendingSeekRef = useRef(new Map<string, number>());
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const [liveAudioFrame, setLiveAudioFrame] = useState<number | null>(null);
  const [mediaTick, setMediaTick] = useState(0);
  const errorRef = useRef(onMediaError);
  errorRef.current = onMediaError;
  const userGestureRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);

  const ensureAudioContext = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!audioContextRef.current) {
      try { audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch { }
    }
    if (audioContextRef.current && audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume().catch(() => undefined);
    }
  }, []);

  const attemptPlay = useCallback((element: HTMLMediaElement) => {
    if (!userGestureRef.current) { ensureAudioContext(); userGestureRef.current = true; }
    const playPromise = element.play();
    if (playPromise) playPromise.catch((err) => { if (err.name === "NotAllowedError" || err.name === "AbortError") { } });
  }, [ensureAudioContext]);

  const canvasSize = useMemo(() => {
    const ratio = project.settings.width / project.settings.height;
    const width = Math.min(1280, project.settings.width);
    const height = Math.max(2, Math.round(width / ratio / 2) * 2);
    return { width, height };
  }, [project.settings.width, project.settings.height]);

  const trackByClip = useMemo(() => {
    const map = new Map<string, Track>();
    for (const track of project.tracks) for (const clip of track.clips) map.set(clip.id, track);
    return map;
  }, [project.tracks]);

  useEffect(() => {
    const map = elementsRef.current;
    const alive = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.type === "text") continue;
        if (isLiveRemotionClip(clip)) continue;
        const asset = project.media.find((item) => item.id === clip.mediaId);
        if (!asset || asset.missing) continue;
        alive.add(clip.id);
        const existing = map.get(clip.id);
        const useProxy = clip.type === "video" && asset.proxy === "ready";
        const sourceUrl = api.mediaFileUrl(project.id, asset.id, useProxy);
        const absoluteSource = new URL(sourceUrl, window.location.href).href;
        if (existing) {
          if (existing.src === absoluteSource) continue;
          if (isMediaElement(existing)) existing.pause();
        }
        if (clip.type === "image") {
          const image = new Image();
          image.decoding = "async";
          image.onload = () => setMediaTick((v) => v + 1);
          image.onerror = () => errorRef.current?.(`No se pudo cargar la imagen "${asset.name}".`);
          image.src = sourceUrl;
          map.set(clip.id, image);
        } else if (clip.type === "audio") {
          const audio = new Audio();
          audio.preload = "auto";
          audio.src = sourceUrl;
          audio.onloadeddata = () => setMediaTick((v) => v + 1);
          audio.onseeked = () => setMediaTick((v) => v + 1);
          audio.onerror = () => errorRef.current?.(`No se pudo cargar el audio "${asset.name}".`);
          audio.load();
          map.set(clip.id, audio);
        } else {
          const video = document.createElement("video");
          video.preload = "auto";
          video.playsInline = true;
          video.crossOrigin = "anonymous";
          video.src = sourceUrl;
          video.onloadeddata = () => setMediaTick((v) => v + 1);
          video.onseeked = () => {
            const nextSeek = pendingSeekRef.current.get(clip.id);
            if (nextSeek !== undefined) {
              pendingSeekRef.current.delete(clip.id);
              if (Math.abs(video.currentTime - nextSeek) > 0.02) {
                try {
                  video.currentTime = nextSeek;
                  return;
                } catch {
                  // Ignorar
                }
              }
            }
            setMediaTick((v) => v + 1);
          };
          video.onerror = () => errorRef.current?.(`No se pudo cargar el vídeo "${asset.name}".`);
          video.load();
          map.set(clip.id, video);
        }
      }
    }
    for (const [clipId, element] of map) {
      if (alive.has(clipId)) continue;
      if (isMediaElement(element)) element.pause();
      map.delete(clipId);
    }
  }, [project.id, project.media, project.tracks]);

  useEffect(() => () => { for (const el of elementsRef.current.values()) if (isMediaElement(el)) el.pause(); elementsRef.current.clear(); }, []);

  useEffect(() => {
    const fps = project.settings.fps;
    const frameUs = frameDurationUs(fps);
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.type === "text") continue;
        if (isLiveRemotionClip(clip)) continue;
        const element = elementsRef.current.get(clip.id);
        if (!element || !isMediaElement(element)) continue;
        const active = frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames;
        if (!active) { if (!element.paused) element.pause(); continue; }
        const sourceUs = clip.sourceInUs + (frame - clip.startFrame) * frameUs * clip.speed;
        const target = Math.max(0, sourceUs / 1_000_000);
        const asset = project.media.find((item) => item.id === clip.mediaId);
        const volume = Math.min(1, Math.max(0, clip.volume * track.volume * (masterVolume ?? 1) * (asset?.kind === "video" ? 1 : 1)));
        element.volume = volume;
        element.muted = track.muted || (masterMuted ?? false) || volume <= 0.001;
        const desiredRate = Math.max(0.25, Math.min(4, clip.speed || 1));
        if (Math.abs(element.playbackRate - desiredRate) > 0.01) {
          element.playbackRate = desiredRate;
        }
        if (playing) {
          pendingSeekRef.current.delete(clip.id);
          if (element.readyState >= 1 && !element.seeking && Math.abs(element.currentTime - target) > 0.16) {
            try { element.currentTime = target; } catch { }
          }
          if (element.paused) attemptPlay(element);
        } else {
          if (!element.paused) element.pause();
          if (element.readyState >= 1 && Number.isFinite(target) && Math.abs(element.currentTime - target) > 0.02) {
            if (element instanceof HTMLVideoElement && element.seeking) {
              pendingSeekRef.current.set(clip.id, target);
            } else {
              pendingSeekRef.current.delete(clip.id);
              try { element.currentTime = target; } catch { }
            }
          }
        }
      }
    }
  }, [frame, playing, project, mediaTick, masterVolume, masterMuted, attemptPlay]);

  const selectableClips = useMemo((): SelectableClip[] => {
    // Durante la reproducción activa y sin selección/hover en el lienzo, evitamos recalcular geometrías en cada fotograma
    if (playing && !selectedClipId && !hoveredClipId) return [];
    const clips: SelectableClip[] = [];
    const visualTracks = [...project.tracks]
      .filter((t) => t.kind === "video" && !t.hidden)
      .sort((a, b) => {
        const getWeight = (t: typeof a) => {
          const n = t.name.toLowerCase();
          if (/v0|fondo|ambient|background|canvas/i.test(n)) return 0;
          if (/transici/i.test(n)) return 30;
          if (/motion|overlay|hud|b-?roll/i.test(n)) return 20;
          return 10;
        };
        return getWeight(a) - getWeight(b);
      });
    for (const track of visualTracks) {
      for (const clip of track.clips) {
        if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
        if (clip.type === "text" || clip.type === "audio") continue;
        if (clip.remotion) {
          const isSubs = Array.isArray(clip.remotion.props?.captions);
          const remBounds = computeRemotionClipBounds(clip, project);
          clips.push({
            id: clip.id,
            type: "video",
            trackId: track.id,
            trackName: track.name.replace("Motion Overlay", "Capa Motion"),
            trackKind: track.kind,
            startFrame: clip.startFrame,
            durationFrames: clip.durationFrames,
            mediaId: clip.mediaId,
            displayName: clip.name || clip.remotion.compositionId || track.name,
            scalePct: remBounds.scalePct,
            isRemotion: true,
            isSubtitle: isSubs,
            bounds: remBounds.bounds,
          });
          continue;
        }
        const element = elementsRef.current.get(clip.id);
        if (!element) continue;
        // estrechamos el tipo: en tracks de video solo hay video/image
        const videoEl = element as HTMLVideoElement | HTMLImageElement;
        const asset = project.media.find((m) => m.id === clip.mediaId);
        if (!asset) continue;
        const crop = clip.crop;
        const cropW = Math.max(0.01, 1 - crop.left - crop.right);
        const cropH = Math.max(0.01, 1 - crop.top - crop.bottom);
        const naturalWidth = videoEl instanceof HTMLImageElement ? videoEl.naturalWidth : videoEl.videoWidth;
        const naturalHeight = videoEl instanceof HTMLImageElement ? videoEl.naturalHeight : videoEl.videoHeight;
        if (!naturalWidth || !naturalHeight) continue;
        const localFrame = frame - clip.startFrame;
        const keyframe = mediaKeyframeState(clip, localFrame);
        const animation = mediaAnimationState(clip, localFrame);
        const sw = naturalWidth * cropW;
        const sh = naturalHeight * cropH;
        const fit = Math.min(project.settings.width / sw, project.settings.height / sh);
        const scale = fit * Math.max(0.05, clip.transform.scale) * keyframe.scale * animation.scale;
        const dw = sw * scale;
        const dh = sh * scale;
        const cx = project.settings.width / 2 + ((clip.transform.x + keyframe.x) / 100) * project.settings.width + animation.offsetX * project.settings.width;
        const cy = project.settings.height / 2 + ((clip.transform.y + keyframe.y) / 100) * project.settings.height + animation.offsetY * project.settings.height;
        clips.push({
          id: clip.id,
          type: clip.type as "video" | "image",
          trackId: track.id,
          trackName: track.name,
          trackKind: track.kind,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          mediaId: clip.mediaId,
          displayName: clip.name || asset.name || track.name,
          scalePct: Math.round((clip.transform.scale || 1) * 100),
          bounds: { x: (cx - dw / 2) / project.settings.width, y: (cy - dh / 2) / project.settings.height, width: dw / project.settings.width, height: dh / project.settings.height },
        });
      }
    }

    const textTracks = project.tracks.filter((t) => t.kind === "text" && !t.hidden);
    for (const track of textTracks) {
      for (const clip of track.clips) {
        if (clip.type !== "text") continue;
        if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
        if (clip.remotion) {
          const isSubs = Array.isArray(clip.remotion.props?.captions);
          const remBounds = computeRemotionClipBounds(clip, project);
          clips.push({
            id: clip.id,
            type: "text",
            trackId: track.id,
            trackName: track.name,
            trackKind: "text",
            startFrame: clip.startFrame,
            durationFrames: clip.durationFrames,
            text: clip.name || clip.text,
            fontSize: clip.fontSize,
            fontFamily: clip.fontFamily,
            displayName: clip.name || clip.remotion.compositionId || "Subtítulos IA",
            scalePct: remBounds.scalePct,
            isRemotion: true,
            isSubtitle: isSubs,
            bounds: remBounds.bounds,
          });
          continue;
        }
        const scale = project.settings.height / 1080;
        const fontSize = Math.max(8, clip.fontSize * scale);
        const text = transformText(clip.text, clip.textTransform);
        const estimatedWidth = text.length * fontSize * 0.6;
        const estimatedHeight = fontSize * 1.5;
        clips.push({
          id: clip.id,
          type: "text",
          trackId: track.id,
          trackName: track.name,
          trackKind: "text",
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          text: clip.text,
          fontSize: clip.fontSize,
          fontFamily: clip.fontFamily,
          displayName: clip.name || clip.text || track.name,
          scalePct: 100,
          bounds: { x: clip.position.x - estimatedWidth / (2 * project.settings.width), y: clip.position.y - estimatedHeight / project.settings.height, width: estimatedWidth / project.settings.width, height: estimatedHeight / project.settings.height },
        });
      }
    }
    return clips;
  }, [frame, project, mediaTick, zoomLevel, playing, selectedClipId, hoveredClipId]);

  const selectedSelectableClip = useMemo(
    () => selectableClips.find((c) => c.id === selectedClipId) ?? null,
    [selectableClips, selectedClipId],
  );

  const dragStateRef = useRef<{
    mode: "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";
    clipId: string;
    startClientX: number;
    startClientY: number;
    initialClip: TimelineClip;
    moved: boolean;
  } | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const onProjectChangeRef = useRef(onProjectChange);
  onProjectChangeRef.current = onProjectChange;

  const applyClipTransformStep = useCallback(
    (clipId: string, updater: (clip: TimelineClip) => TimelineClip, commitLabel: string) => {
      if (!onProjectChangeRef.current) return;
      const res = updateClip(projectRef.current, clipId, updater);
      if (res.ok) {
        onProjectChangeRef.current(res.project, { history: true, save: true, label: commitLabel });
      }
    },
    [],
  );

  const startPointerInteraction = useCallback(
    (
      e: React.PointerEvent,
      clipId: string,
      mode: "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se",
    ) => {
      if (!onProjectChangeRef.current) return;
      const found = getClipById(projectRef.current, clipId);
      if (!found) return;
      e.stopPropagation();
      e.preventDefault();
      onClipSelect?.(clipId);
      dragStateRef.current = {
        mode,
        clipId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        initialClip: structuredClone(found.clip),
        moved: false,
      };

      const handleWindowPointerMove = (moveEvt: PointerEvent) => {
        const state = dragStateRef.current;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!state || !rect || !onProjectChangeRef.current) return;
        const dxNorm = (moveEvt.clientX - state.startClientX) / Math.max(1, rect.width);
        const dyNorm = (moveEvt.clientY - state.startClientY) / Math.max(1, rect.height);
        if (Math.abs(dxNorm) > 0.002 || Math.abs(dyNorm) > 0.002) {
          state.moved = true;
        }
        if (!state.moved) return;

        const init = state.initialClip;
        const res = updateClip(projectRef.current, state.clipId, (current) => {
          if (state.mode === "move") {
            if (init.type === "text" && current.type === "text" && init.remotion) {
              const defaultPosY =
                projectRef.current.settings.height > projectRef.current.settings.width ? 0.74 : 0.86;
              const rawInitPosY = Number(init.remotion.props?.positionY ?? defaultPosY);
              const initPosY = rawInitPosY > 1.5 ? rawInitPosY / 100 : rawInitPosY;
              const initOffX = Number(init.remotion.props?.offsetX ?? 0);
              const nextPosY = Math.max(0.15, Math.min(0.95, Number((initPosY + dyNorm).toFixed(3))));
              const nextOffX = Math.max(-45, Math.min(45, Math.round(initOffX + dxNorm * 100)));
              return {
                ...current,
                remotion: current.remotion
                  ? {
                      ...current.remotion,
                      props: {
                        ...(current.remotion.props || {}),
                        positionY: nextPosY,
                        offsetX: nextOffX,
                      },
                    }
                  : current.remotion,
              };
            }
            if (init.type !== "text" && current.type !== "text") {
              const nextX = Math.max(-85, Math.min(85, Number((init.transform.x + dxNorm * 100).toFixed(1))));
              const nextY = Math.max(-85, Math.min(85, Number((init.transform.y + dyNorm * 100).toFixed(1))));
              return {
                ...current,
                transform: { ...current.transform, x: nextX, y: nextY },
              };
            }
            if (init.type === "text" && current.type === "text") {
              return {
                ...current,
                position: {
                  x: Math.max(0.05, Math.min(0.95, Number((init.position.x + dxNorm).toFixed(3)))),
                  y: Math.max(0.05, Math.min(0.95, Number((init.position.y + dyNorm).toFixed(3)))),
                },
              };
            }
            return current;
          } else {
            // Resize from corners
            const signX = state.mode.endsWith("e") ? 1 : -1;
            const signY = state.mode.includes("s") ? 1 : -1;
            const scaleDelta = (dxNorm * signX + dyNorm * signY) * 1.15;
            if (init.type === "text" && current.type === "text" && init.remotion) {
              const rawInitScale = Number(init.remotion.props?.fontScale ?? 1);
              const initScale = rawInitScale > 5 ? rawInitScale / 100 : rawInitScale;
              const nextScale = Math.max(0.4, Math.min(2.4, Number((initScale * (1 + scaleDelta)).toFixed(2))));
              return {
                ...current,
                remotion: current.remotion
                  ? {
                      ...current.remotion,
                      props: {
                        ...(current.remotion.props || {}),
                        fontScale: nextScale,
                      },
                    }
                  : current.remotion,
              };
            }
            if (init.type !== "text" && current.type !== "text") {
              const initScale = init.transform.scale || 1;
              const nextScale = Math.max(0.2, Math.min(3, Number((initScale * (1 + scaleDelta)).toFixed(2))));
              return {
                ...current,
                transform: { ...current.transform, scale: nextScale },
              };
            }
            if (init.type === "text" && current.type === "text") {
              return {
                ...current,
                fontSize: Math.max(14, Math.min(220, Math.round(init.fontSize * (1 + scaleDelta)))),
              };
            }
            return current;
          }
        });
        if (res.ok) {
          onProjectChangeRef.current(res.project, { history: false, save: false });
        }
      };

      const handleWindowPointerUp = () => {
        window.removeEventListener("pointermove", handleWindowPointerMove);
        window.removeEventListener("pointerup", handleWindowPointerUp);
        const state = dragStateRef.current;
        dragStateRef.current = null;
        if (state?.moved && onProjectChangeRef.current) {
          onProjectChangeRef.current(projectRef.current, {
            history: true,
            save: true,
            label: state.mode === "move" ? "Mover elemento en monitor" : "Redimensionar elemento en monitor",
          });
        }
      };

      window.addEventListener("pointermove", handleWindowPointerMove);
      window.addEventListener("pointerup", handleWindowPointerUp);
    },
    [onClipSelect],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragStateRef.current || !onClipHover) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    let found: SelectableClip | null = null;
    for (const clip of [...selectableClips].reverse()) {
      if (x >= clip.bounds.x && x <= clip.bounds.x + clip.bounds.width && y >= clip.bounds.y && y <= clip.bounds.y + clip.bounds.height) { found = clip; break; }
    }
    onClipHover(found?.id ?? null);
  }, [selectableClips, onClipHover]);

  const handleMouseLeave = useCallback(() => onClipHover?.(null), [onClipHover]);

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    let found: SelectableClip | null = null;
    for (const clip of [...selectableClips].reverse()) {
      if (x >= clip.bounds.x && x <= clip.bounds.x + clip.bounds.width && y >= clip.bounds.y && y <= clip.bounds.y + clip.bounds.height) { found = clip; break; }
    }
    if (found) {
      startPointerInteraction(e, found.id, "move");
    } else {
      onClipSelect?.(null);
    }
  }, [selectableClips, onClipSelect, startPointerInteraction]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = "#0b0f0c";
    ctx.fillRect(0, 0, width, height);

    const zoom = zoomLevel ?? 1;
    if (zoom !== 1) { ctx.translate(width / 2, height / 2); ctx.scale(zoom, zoom); ctx.translate(-width / 2, -height / 2); }

    const visualTracks = [...project.tracks]
      .filter((t) => t.kind === "video" && !t.hidden)
      .sort((a, b) => {
        const getWeight = (t: typeof a) => {
          const n = t.name.toLowerCase();
          if (/v0|fondo|ambient|background|canvas/i.test(n)) return 0;
          if (/transici/i.test(n)) return 30;
          if (/motion|overlay|hud|b-?roll/i.test(n)) return 20;
          return 10;
        };
        return getWeight(a) - getWeight(b);
      });
    for (const track of visualTracks) {
      for (const clip of track.clips) {
        if (clip.type === "text") continue;
        if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
        if (isLiveRemotionClip(clip)) continue;
        const element = elementsRef.current.get(clip.id);
        if (!element) continue;
        drawMediaClip(ctx, clip, element, frame, width, height);
      }
    }
    const textTracks = project.tracks.filter((t) => t.kind === "text" && !t.hidden);
    for (const track of textTracks) {
      for (const clip of track.clips) {
        if (clip.type !== "text") continue;
        if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
        if (isLiveRemotionClip(clip)) continue;
        drawTextClip(ctx, clip, frame, width, height);
      }
    }

    for (const clip of selectableClips) {
      const isSelected = clip.id === selectedClipId;
      const isHovered = clip.id === hoveredClipId;
      if (isSelected || !isHovered) continue;
      const x = clip.bounds.x * width;
      const y = clip.bounds.y * height;
      const w = clip.bounds.width * width;
      const h = clip.bounds.height * height;
      ctx.save();
      ctx.strokeStyle = "#FFE66D";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.font = "500 10px Inter, system-ui, sans-serif";
      const isMotionTrack = clip.trackName.includes("Motion") || clip.trackName.includes("Overlay");
      const label = isMotionTrack
        ? `${clip.displayName || clip.trackName} · Click para editar o arrastrar`
        : `${clip.displayName || clip.trackName} · Click para seleccionar`;
      const metrics = ctx.measureText(label);
      const lw = metrics.width + 8;
      const lh = 18;
      const lx = Math.max(0, Math.min(x, width - lw));
      const ly = Math.max(lh + 2, y - 2);
      ctx.fillStyle = "rgba(255, 230, 109, 0.95)";
      ctx.beginPath(); ctx.roundRect(lx, ly - lh, lw, lh, 3); ctx.fill();
      ctx.fillStyle = "#0b0f0c";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + 4, ly - lh / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.filter = "none";
  }, [frame, project, mediaTick, playing, trackByClip, zoomLevel, selectableClips, selectedClipId, hoveredClipId]);

  const empty = project.tracks.every((t) => t.clips.length === 0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedClipId) {
        onClipSelect?.(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedClipId, onClipSelect]);

  // Reloj maestro de audio en vivo (60Hz): sincroniza RemotionLiveOverlay (subtítulos y gráficos)
  // directamente con el `currentTime` real del hardware de audio/video activo sin desfase.
  useEffect(() => {
    if (!playing) {
      setLiveAudioFrame(null);
      return;
    }
    let rafId = 0;
    const fpsVal = Math.max(1, project.settings.fps.num / Math.max(1, project.settings.fps.den));
    const frameUs = frameDurationUs(project.settings.fps);

    const syncToHardwareClock = () => {
      let resolvedFrame: number | null = null;
      const curF = frameRef.current;

      for (const track of project.tracks) {
        if (track.muted) continue;
        for (const clip of track.clips) {
          if (clip.type === "text" || isLiveRemotionClip(clip)) continue;
          if (curF < clip.startFrame || curF >= clip.startFrame + clip.durationFrames) continue;
          const el = elementsRef.current.get(clip.id);
          if (!el || !isMediaElement(el) || el.paused || el.readyState < 2) continue;
          const mediaUs = el.currentTime * 1_000_000;
          const exactFrame =
            clip.startFrame + (mediaUs - clip.sourceInUs) / (frameUs * Math.max(0.05, clip.speed || 1));
          if (Number.isFinite(exactFrame) && Math.abs(exactFrame - curF) <= fpsVal * 0.65) {
            resolvedFrame = Math.max(
              clip.startFrame,
              Math.min(clip.startFrame + clip.durationFrames - 1, Math.round(exactFrame)),
            );
            break;
          }
        }
        if (resolvedFrame !== null) break;
      }

      setLiveAudioFrame((prev) => (prev === resolvedFrame ? prev : resolvedFrame));
      rafId = window.requestAnimationFrame(syncToHardwareClock);
    };

    rafId = window.requestAnimationFrame(syncToHardwareClock);
    return () => window.cancelAnimationFrame(rafId);
  }, [playing, project.tracks, project.settings.fps]);

  const effectiveOverlayFrame = playing && liveAudioFrame !== null ? liveAudioFrame : frame;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded-[14px] bg-[#0c0f0d]">
      <canvas ref={canvasRef} width={canvasSize.width} height={canvasSize.height} aria-label={`Previsualización en el fotograma ${frame}`} className="absolute inset-0 w-full h-full" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} onPointerDown={handleCanvasPointerDown} style={{ cursor: hoveredClipId ? "move" : "crosshair" }} />
      <RemotionLiveOverlay project={project} frame={effectiveOverlayFrame} zoomLevel={zoomLevel} />

      {/* Capa interactiva en vivo: durante la reproducción se oculta automáticamente para dejar ver el video 100% limpio */}
      {!playing && selectedSelectableClip && (
        <div className="absolute inset-0 pointer-events-none z-20 select-none">
          {/* Caja delimitadora transparente con 4 tiradores sutiles de esquina */}
          <div
            onPointerDown={(e) => startPointerInteraction(e, selectedSelectableClip.id, "move")}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onAttachToChat?.(selectedSelectableClip.id);
            }}
            className="absolute pointer-events-auto border border-dashed border-[#4ECDC4] bg-transparent hover:border-[#4ECDC4]/90 transition-colors rounded-lg shadow-[0_0_0_1px_rgba(0,0,0,0.4)] cursor-move group"
            style={{
              left: `${selectedSelectableClip.bounds.x * 100}%`,
              top: `${selectedSelectableClip.bounds.y * 100}%`,
              width: `${selectedSelectableClip.bounds.width * 100}%`,
              height: `${selectedSelectableClip.bounds.height * 100}%`,
            }}
            title="Arrastra para mover · Arrastra esquinas para cambiar tamaño · Doble clic para adjuntar al Chat IA"
          >
            {/* 4 tiradores de esquina sutiles */}
            <div
              onPointerDown={(e) => startPointerInteraction(e, selectedSelectableClip.id, "resize-nw")}
              className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full border border-black bg-[#4ECDC4] shadow cursor-nwse-resize hover:scale-125 transition-transform"
              title="Cambiar tamaño"
            />
            <div
              onPointerDown={(e) => startPointerInteraction(e, selectedSelectableClip.id, "resize-ne")}
              className="absolute -right-1.5 -top-1.5 h-3 w-3 rounded-full border border-black bg-[#4ECDC4] shadow cursor-nesw-resize hover:scale-125 transition-transform"
              title="Cambiar tamaño"
            />
            <div
              onPointerDown={(e) => startPointerInteraction(e, selectedSelectableClip.id, "resize-sw")}
              className="absolute -left-1.5 -bottom-1.5 h-3 w-3 rounded-full border border-black bg-[#4ECDC4] shadow cursor-nesw-resize hover:scale-125 transition-transform"
              title="Cambiar tamaño"
            />
            <div
              onPointerDown={(e) => startPointerInteraction(e, selectedSelectableClip.id, "resize-se")}
              className="absolute -right-1.5 -bottom-1.5 h-3 w-3 rounded-full border border-black bg-[#4ECDC4] shadow cursor-nwse-resize hover:scale-125 transition-transform"
              title="Cambiar tamaño"
            />

            {/* Botón pequeño y elegante para adjuntar al Chat IA */}
            {onAttachToChat && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className={`absolute left-1/2 -translate-x-1/2 pointer-events-auto z-30 ${
                  selectedSelectableClip.bounds.y < 0.08 ? "-bottom-7" : "-top-7"
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAttachToChat(selectedSelectableClip.id);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--ink)] bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--sage-100)] px-2.5 py-0.5 text-[10px] font-bold shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-all cursor-pointer whitespace-nowrap active:scale-95"
                  title="Adjuntar al Chat IA para que el agente lo mejore o modifique"
                >
                  <Icon name="wand" size={10} className="text-learn-green" />
                  <span>Adjuntar</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {empty && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center p-8 text-[var(--viewer-muted)]">
          <strong className="text-sm font-bold text-[var(--viewer-ink)]">Tu lienzo está listo</strong>
          <span className="text-xs">Importa un vídeo o usa el proyecto de demostración para empezar.</span>
        </div>
      )}
      {showSafeGuides && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden select-none" aria-hidden="true">
          {project.settings.height > project.settings.width ? (
            <div className="relative h-full w-full font-sans text-white">
              {/* Zona Segura Central con borde neón */}
              <div
                className="absolute border-2 border-dashed border-[#22c55e] rounded-xl shadow-[0_0_15px_rgba(34,197,94,0.35)] flex flex-col justify-between p-2 pointer-events-none"
                style={{
                  top: "10%",
                  bottom: "22%",
                  left: "4%",
                  right: "18%",
                }}
              >
                <div className="self-center bg-[#22c55e] text-black text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded shadow">
                  Zona Segura TikTok / Reels
                </div>
                <div className="self-center bg-black/70 text-[#4ade80] text-[8.5px] font-mono px-2 py-0.5 rounded backdrop-blur">
                  Subtítulos &amp; Motion Protegidos
                </div>
              </div>

              {/* Zona Superior Simulada: Pestañas Siguiendo | Para ti */}
              <div className="absolute top-0 inset-x-0 h-[10%] flex items-center justify-between px-3 bg-gradient-to-b from-black/70 to-transparent">
                <span className="text-[9.5px] font-black text-rose-500 uppercase tracking-widest bg-black/50 px-1.5 py-0.5 rounded border border-rose-500/30">LIVE</span>
                <div className="flex items-center gap-3 text-[11px] font-bold">
                  <span className="text-white/60">Siguiendo</span>
                  <span className="text-white border-b-2 border-white pb-0.5">Para ti</span>
                </div>
                <Icon name="search" size={13} className="text-white/80" />
              </div>

              {/* Barra Lateral Derecha Simulada (TikTok Actions: Avatar, Like, Comentarios, Guardar, Compartir) */}
              <div
                className="absolute right-0 top-[18%] bottom-[22%] w-[18%] flex flex-col items-center justify-end gap-3 pr-1.5 bg-gradient-to-l from-black/60 via-black/25 to-transparent"
              >
                <div className="relative mb-1">
                  <div className="w-8 h-8 rounded-full border-2 border-white bg-gradient-to-tr from-amber-400 to-rose-500 flex items-center justify-center text-[10px] font-bold text-white shadow">
                    IA
                  </div>
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-rose-500 rounded-full text-[9px] text-white flex items-center justify-center font-bold shadow">+</span>
                </div>
                <div className="flex flex-col items-center">
                  <Icon name="heart" size={15} className="text-rose-500" />
                  <span className="text-[9px] font-bold text-white/90 mt-0.5">248K</span>
                </div>
                <div className="flex flex-col items-center">
                  <Icon name="message" size={15} className="text-white" />
                  <span className="text-[9px] font-bold text-white/90 mt-0.5">3.4K</span>
                </div>
                <div className="flex flex-col items-center">
                  <Icon name="bookmark" size={14} className="text-white" />
                  <span className="text-[9px] font-bold text-white/90 mt-0.5">18K</span>
                </div>
                <div className="flex flex-col items-center">
                  <Icon name="share" size={14} className="text-white" />
                  <span className="text-[9px] font-bold text-white/90 mt-0.5">6.1K</span>
                </div>
                <div className="w-6 h-6 rounded-full bg-stone-900 border border-stone-600 flex items-center justify-center animate-spin mt-1" style={{ animationDuration: "4s" }}>
                  <Icon name="music" size={10} className="text-white" />
                </div>
              </div>

              {/* Zona Inferior Simulada (Nombre, Descripción, Audio) */}
              <div
                className="absolute bottom-0 inset-x-0 h-[22%] flex flex-col justify-end p-2.5 bg-gradient-to-t from-black/80 via-black/45 to-transparent text-[10px]"
                style={{ paddingRight: "20%" }}
              >
                <div className="font-bold text-white flex items-center gap-1">
                  @oeclip.ia <span className="text-[9px] text-sky-400">✓</span>
                </div>
                <p className="text-white/85 line-clamp-2 text-[9.5px] leading-tight my-1">
                  Auto-Reframe inteligente y subtítulos centrados sin solapar la interfaz viral <Icon name="sparkles" size={10} className="inline text-learn-green" /> #OECLIP #Remotion
                </p>
                <div className="flex items-center gap-1 text-[9px] text-white/70">
                  <Icon name="music" size={10} className="shrink-0" />
                  <span className="truncate">Sonido original - OECLIP Studio AI</span>
                </div>
              </div>
            </div>
          ) : (
            <>
              <span className="absolute top-2 left-2 px-2 py-0.5 rounded border border-[var(--ink)] bg-[var(--viewer)] text-[var(--ink)] text-[10px] font-bold">
                Zona segura (Action 90% · Title 80%)
              </span>
              <span className="absolute inset-[5%] border border-[var(--ink)]/[0.4] rounded-sm pointer-events-none" />
              <span className="absolute inset-[10%] border-2 border-dashed border-[var(--ink)]/[0.7] rounded-sm pointer-events-none" />
              <span className="absolute left-1/2 top-[5%] bottom-[5%] w-[1px] bg-[var(--ink)]/[0.3] pointer-events-none" />
              <span className="absolute right-[5%] left-[5%] top-1/2 h-[1px] bg-[var(--ink)]/[0.3] pointer-events-none" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

import type { IconName } from "./Icon";

interface ViewerProps {
  project: Project;
  frame: number;
  playing: boolean;
  onFrameChange: (frame: number) => void;
  onTogglePlay: () => void;
  onError: (message: string) => void;
  /** ID del clip seleccionado en el viewer (para sincronizar con IA Motion) */
  selectedClipId?: string | null;
  /** Callback cuando se selecciona un clip en el viewer */
  onClipSelect?: (clipId: string | null) => void;
  /** Callback cuando se actualiza el proyecto (por ejemplo con Auto-Reframe o edición en monitor) */
  onProjectChange?: (project: Project, options?: { history?: boolean; save?: boolean; label?: string }) => void;
  /** Callback cuando el usuario hace click en "Editar en Chat IA" desde el monitor */
  onAttachToChat?: (clipId: string, promptHint?: string) => void;
  /** Callback para abrir el Inspector del clip seleccionado */
  onOpenInspector?: (clipId: string) => void;
  /** Subida rápida directa desde el estado vacío del monitor */
  onQuickImportFiles?: (files: File[]) => void;
  /** Abrir asistente IA directamente cuando no hay clips aún */
  onOpenAiAssistant?: () => void;
  /** Bloquear acciones mientras el agente trabaja */
  disabled?: boolean;
}

const ASPECT_OPTIONS: Array<{
  aspect: AspectRatio;
  label: string;
  desc: string;
  icon: IconName;
}> = [
  { aspect: "16:9", label: "Horizontal (16:9)", desc: "1920×1080 · YouTube / TV", icon: "monitor" },
  { aspect: "9:16", label: "Vertical (9:16)", desc: "1080×1920 · TikTok / Shorts / Reels", icon: "target" },
  { aspect: "1:1", label: "Cuadrado (1:1)", desc: "1080×1080 · Instagram Feed", icon: "duplicate" },
  { aspect: "4:5", label: "Retrato (4:5)", desc: "1080×1350 · Feed vertical", icon: "sparkles" },
  { aspect: "21:9", label: "Cinemático (21:9)", desc: "2560×1080 · Ultra-wide", icon: "film" },
];

export function Viewer({
  project,
  frame,
  playing,
  onFrameChange,
  onTogglePlay,
  onError,
  selectedClipId: externalSelectedClipId,
  onClipSelect: externalOnClipSelect,
  onProjectChange,
  onAttachToChat,
  onOpenInspector,
  onQuickImportFiles,
  onOpenAiAssistant,
  disabled,
}: ViewerProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const aspectMenuRef = useRef<HTMLDivElement | null>(null);
  const quickUploadRef = useRef<HTMLInputElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showSafeGuides, setShowSafeGuides] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1);
  const [masterMuted, setMasterMuted] = useState(false);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const [internalSelectedClipId, setInternalSelectedClipId] = useState<string | null>(null);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const selectedClipId = externalSelectedClipId !== undefined ? externalSelectedClipId : internalSelectedClipId;
  const setSelectedClipId = useCallback(
    (id: string | null) => {
      setInternalSelectedClipId(id);
      externalOnClipSelect?.(id);
    },
    [externalOnClipSelect],
  );
  const ratio = project.settings.width / project.settings.height;

  useEffect(() => {
    if (!aspectMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (aspectMenuRef.current && !aspectMenuRef.current.contains(e.target as Node)) {
        setAspectMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [aspectMenuOpen]);

  const handleReframe = useCallback(
    (targetAspect: AspectRatio) => {
      setAspectMenuOpen(false);
      if (!onProjectChange) return;
      if (project.settings.aspect === targetAspect) return;
      const nextProject = autoReframeProject(project, targetAspect, 1080);
      onProjectChange(nextProject, {
        history: true,
        save: true,
        label: `Auto-Reframe a ${targetAspect}`,
      });
    },
    [project, onProjectChange],
  );

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const update = () => setStageSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        e.preventDefault(); setMasterMuted((m) => !m);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const frameSize = useMemo(() => {
    if (stageSize.width <= 0 || stageSize.height <= 0) return null;
    const padX = stageSize.width < 460 ? 12 : 36;
    const padY = stageSize.height < 260 ? 12 : 36;
    const availableWidth = Math.max(80, stageSize.width - padX);
    const availableHeight = Math.max(45, stageSize.height - padY);
    const scale = Math.min(availableWidth / ratio, availableHeight);
    const height = Math.max(45, Math.round(scale));
    return { width: Math.max(25, Math.round(height * ratio)), height };
  }, [stageSize, ratio]);

  const duration = project.tracks.reduce((max, track) => Math.max(max, ...track.clips.map((c) => c.startFrame + c.durationFrames), 0), 0);
  const fps = project.settings.fps;
  const fpsNum = Math.max(1, Math.round(fpsValue(fps)));
  const go = (next: number) => onFrameChange(Math.max(0, Math.min(duration, Math.round(next))));

  return (
    <section ref={shellRef} className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 sm:gap-2 p-1.5 sm:p-2.5 h-full overflow-hidden" aria-label="Monitor de previsualización">
      <div className="viewer-shell flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] sm:rounded-[22px] border-2 border-[var(--ink)] bg-[var(--viewer)] shadow-[var(--shadow-hard)]">
        <div className="flex h-10 sm:h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--viewer-line)] px-2.5 sm:px-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-learn-green shadow-[0_0_0_3px_rgba(74,222,128,0.18)]" />
            <span className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--viewer-ink)]">
              <span className="hidden sm:inline">Monitor de programa</span>
              <span className="sm:hidden">Monitor</span>
            </span>
            <span className="viewer-chip !hidden md:!inline-flex">{project.settings.width}×{project.settings.height}</span>
            <div className="relative" ref={aspectMenuRef}>
              <button
                type="button"
                onClick={() => setAspectMenuOpen((open) => !open)}
                className="viewer-chip inline-flex items-center gap-1 cursor-pointer hover:border-[var(--ink)] hover:bg-[var(--sage-100)] transition-colors"
                title="Cambiar formato con Auto-Reframe inteligente"
                aria-haspopup="true"
                aria-expanded={aspectMenuOpen}
              >
                <Icon name="refresh" size={10} className="text-[var(--ink-soft)]" />
                <span className="font-bold">{project.settings.aspect}</span>
                <Icon name="chevron-down" size={9} className="opacity-70" />
              </button>
              {aspectMenuOpen && (
                <div
                  className="absolute left-0 top-full mt-1.5 z-50 w-60 max-w-[calc(100vw-24px)] rounded-xl border border-[var(--ink)] bg-[var(--paper)] p-1.5 shadow-[var(--shadow-hard)]"
                  role="menu"
                >
                  <div className="px-2 py-1 text-[9.5px] font-bold uppercase tracking-wider text-[var(--muted)] border-b border-[var(--line)] mb-1 flex items-center justify-between">
                    <span>Auto-Reframe Inteligente</span>
                    <span className="text-[8.5px] text-learn-green font-bold">REMOTION</span>
                  </div>
                  {ASPECT_OPTIONS.map((opt) => (
                    <button
                      key={opt.aspect}
                      type="button"
                      role="menuitem"
                      onClick={() => handleReframe(opt.aspect)}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-[11px] transition-colors ${
                        project.settings.aspect === opt.aspect
                          ? "bg-[var(--ink)] text-[var(--paper)] font-bold"
                          : "text-[var(--ink)] hover:bg-[var(--sage-100)]"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="grid h-5 w-5 place-items-center rounded bg-[var(--sage-100)] text-[var(--sage-800)] shrink-0">
                          <Icon name={opt.icon} size={11} />
                        </span>
                        <div className="min-w-0">
                          <div className="font-semibold truncate">{opt.label}</div>
                          <div className={`text-[9.5px] truncate ${project.settings.aspect === opt.aspect ? "text-[var(--paper)]/80" : "text-[var(--muted)]"}`}>
                            {opt.desc}
                          </div>
                        </div>
                      </div>
                      {project.settings.aspect === opt.aspect && (
                        <Icon name="check" size={12} className="shrink-0 ml-1 text-learn-green" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton icon="crosshair" label={showSafeGuides ? "Ocultar guías de encuadre" : "Mostrar guías de encuadre"} className={`viewer-tool${showSafeGuides ? " is-active" : ""}`} aria-pressed={showSafeGuides} onClick={() => setShowSafeGuides((v) => !v)} />
            <div className="viewer-zoom !hidden sm:!flex">
              <button className="viewer-tool" onClick={() => setZoomLevel((z) => Math.max(0.25, z - 0.25))} title="Zoom menos" aria-label="Zoom menos"><Icon name="zoom-out" size={12} /></button>
              <span className="tabular-nums">{Math.round(zoomLevel * 100)}%</span>
              <button className="viewer-tool" onClick={() => setZoomLevel((z) => Math.min(4, z + 0.25))} title="Zoom más" aria-label="Zoom más"><Icon name="zoom-in" size={12} /></button>
            </div>
            <IconButton icon="maximize" className="viewer-tool" label="Pantalla completa" onClick={async () => { const n = shellRef.current; if (!n) return; try { if (document.fullscreenElement) await document.exitFullscreen(); else await n.requestFullscreen(); } catch { onError("No se pudo cambiar el monitor a pantalla completa."); } }} />
          </div>
        </div>
        <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 sm:p-3.5">
          <div className={frameSize ? "viewer-frame" : "viewer-frame h-full w-full"} style={frameSize ? { width: frameSize.width, height: frameSize.height } : undefined}>
            <PreviewCanvas project={project} frame={frame} playing={playing} frameSize={frameSize} onMediaError={onError} zoomLevel={zoomLevel} showSafeGuides={showSafeGuides} masterVolume={masterVolume} masterMuted={masterMuted} selectedClipId={selectedClipId ?? undefined} hoveredClipId={hoveredClipId ?? undefined} onClipSelect={setSelectedClipId} onClipHover={setHoveredClipId} onProjectChange={onProjectChange} onAttachToChat={onAttachToChat} onOpenInspector={onOpenInspector} />
          </div>
          {duration === 0 && (onQuickImportFiles || onOpenAiAssistant) && (
            <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center p-2 sm:p-3 overflow-y-auto">
              <div className="w-full max-w-[300px] max-h-full overflow-y-auto rounded-[18px] sm:rounded-[20px] border-2 border-white/20 bg-[rgba(19,24,21,0.9)] p-3 sm:p-4 text-center text-[var(--viewer-ink)] shadow-2xl backdrop-blur-md">
                <span className="mx-auto mb-1.5 sm:mb-2 grid h-8 w-8 sm:h-10 sm:w-10 place-items-center rounded-xl bg-learn-green/20 text-learn-green">
                  <Icon name="film" size={16} />
                </span>
                <p className="font-display text-[13px] sm:text-[14px] font-bold tracking-tight text-white">
                  Empieza en 1 toque
                </p>
                <p className="mt-0.5 sm:mt-1 text-[11px] sm:text-[11.5px] leading-snug text-white/75">
                  Sube tu clip para editarlo al instante o genera un video completo con IA.
                </p>
                <div className="mt-2.5 sm:mt-3 flex flex-col gap-1.5 sm:gap-2">
                  {onQuickImportFiles && (
                    <>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => quickUploadRef.current?.click()}
                        className="btn btn-primary w-full justify-center !min-h-[40px] text-[12.5px] font-bold"
                      >
                        <Icon name="upload" size={14} />
                        Subir video o foto
                      </button>
                      <input
                        ref={quickUploadRef}
                        type="file"
                        className="sr-only"
                        multiple
                        accept="video/*,audio/*,image/*,.mp4,.mov,.mkv,.webm,.m4v,.avi,.mp3,.wav,.m4a,.aac,.flac,.ogg,.png,.jpg,.jpeg,.webp"
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          event.target.value = "";
                          if (files.length > 0) onQuickImportFiles(files);
                        }}
                      />
                    </>
                  )}
                  {onOpenAiAssistant && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={onOpenAiAssistant}
                      className="btn w-full justify-center !min-h-[38px] rounded-xl border border-white/25 bg-white/10 text-[12px] font-bold text-white hover:bg-white/20"
                    >
                      <Icon name="sparkles" size={14} className="text-learn-green" />
                      Crear video con IA desde cero
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-1.5 border-t border-[var(--viewer-line)] px-2 sm:px-3 py-1.5 sm:py-2">
          <div className="flex items-center gap-0.5 sm:gap-1">
            <button className="viewer-tool" onClick={() => go(0)} aria-label="Ir al inicio" title="Ir al inicio"><Icon name="skip-start" size={13} /></button>
            <button className="viewer-tool hidden sm:inline-flex" onClick={() => go(frame - 1)} aria-label="Fotograma anterior" title="Fotograma anterior"><Icon name="step-back" size={13} /></button>
            <button className="viewer-tool inline-flex sm:hidden !w-auto !px-1.5 text-[10px] font-bold tabular-nums" onClick={() => go(frame - fpsNum * 3)} aria-label="Retroceder 3 segundos" title="Retroceder 3 segundos">-3s</button>
            <button className="viewer-play !w-9 !h-9 sm:!w-[34px] sm:!h-[34px]" onClick={onTogglePlay} aria-label={playing ? "Pausar" : "Reproducir"} title="Reproducir / pausar (Espacio)">{playing ? <Icon name="pause" size={16} /> : <Icon name="play" size={17} />}</button>
            <button className="viewer-tool inline-flex sm:hidden !w-auto !px-1.5 text-[10px] font-bold tabular-nums" onClick={() => go(frame + fpsNum * 3)} aria-label="Adelantar 3 segundos" title="Adelantar 3 segundos">+3s</button>
            <button className="viewer-tool hidden sm:inline-flex" onClick={() => go(frame + 1)} aria-label="Fotograma siguiente" title="Fotograma siguiente"><Icon name="step-forward" size={13} /></button>
            <button className="viewer-tool" onClick={() => go(duration)} aria-label="Ir al final" title="Ir al final"><Icon name="skip-end" size={13} /></button>
          </div>
          <div className="flex items-center gap-1">
            <div className="relative group">
              <button className="viewer-tool" onClick={() => setMasterMuted((m) => !m)} aria-label={masterMuted ? "Activar audio" : "Silenciar"} title={masterMuted ? "Activar audio (M)" : "Silenciar (M)"}>{masterMuted || masterVolume === 0 ? <Icon name="mute" size={14} /> : <Icon name="volume" size={14} />}</button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-all duration-150 pointer-events-none">
                <div className="bg-[var(--viewer)] border border-[var(--viewer-line)] rounded-lg p-2 shadow-[var(--shadow-hard)]">
                  <input type="range" min="0" max="100" step="1" value={Math.round(masterVolume * 100)} onChange={(e) => { const v = Math.max(0, Math.min(1, Number(e.target.value) / 100)); setMasterVolume(v); if (v > 0) setMasterMuted(false); }} className="w-24 h-1.5 accent-[var(--ink)] cursor-pointer" aria-label="Volumen" />
                  <span className="text-[10px] text-[var(--viewer-muted)] ml-1">{Math.round(masterVolume * 100)}%</span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 font-mono text-[10.5px] sm:text-[11.5px] tabular-nums text-[var(--viewer-ink)]"><span className="rounded-md bg-white/10 px-1.5 py-0.5">{formatTimecode(frame, fps)}</span><span className="text-[var(--viewer-muted)]">/</span><span className="text-[var(--viewer-muted)]">{formatTimecode(duration, fps)}</span></div>
          <div className="ml-auto hidden sm:flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--viewer-muted)]"><span className="tabular-nums">{framesToSeconds(duration, fps).toFixed(1)} s</span><span className="h-3 w-px bg-[var(--viewer-line)]" /><span className={playing ? "text-learn-green" : ""}>{playing ? "Reproduciendo" : "En pausa"}</span></div>
        </div>
      </div>
      <div className="viewer-shortcuts flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10.5px] text-[var(--muted)]">
        <span className="inline-flex items-center gap-1"><kbd className="viewer-kbd">Espacio</kbd> reproducir</span>
        <span className="inline-flex items-center gap-1"><kbd className="viewer-kbd">←</kbd><kbd className="viewer-kbd">→</kbd> fotograma</span>
        <span className="inline-flex items-center gap-1"><kbd className="viewer-kbd">M</kbd> silenciar</span>
        <span className="inline-flex items-center gap-1"><kbd className="viewer-kbd">Click</kbd> seleccionar clip</span>
      </div>
    </section>
  );
}