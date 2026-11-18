import React, { Component, type ReactNode } from "react";
import * as RemotionModule from "remotion";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type {
  LiveRemotionExportSpec,
  OverlayFontSpec,
  OverlayGraphicSpec,
  OverlaySpec,
} from "../src/shared/remotionSpec";

/**
 * Composición de la capa de gráficos de NOVACUT. Renderiza las capas de texto
 * del proyecto y los componentes Remotion en vivo (subtítulos y gráficos IA)
 * con DOM/CSS sobre fondo transparente; el video base lo compone FFmpeg después.
 */

export interface NovacutOverlaysProps {
  overlays: OverlaySpec[];
  fonts: OverlayFontSpec[];
  liveClips?: LiveRemotionExportSpec[];
  [key: string]: unknown;
}

/** Extrae el primer nombre de familia de una pila CSS ("Inter, sans-serif" → Inter). */
function primaryFamily(stack: string): string {
  const match = stack.match(/^\s*"?([^",]+)"?\s*(?:,|$)/);
  return (match?.[1] ?? stack).trim();
}

function rgbaFromHex(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const parsed = Number.parseInt(value.length === 3 ? value.split("").map((c) => c + c).join("") : value, 16);
  if (!Number.isFinite(parsed)) return `rgba(0, 0, 0, ${alpha})`;
  const r = (parsed >> 16) & 255;
  const g = (parsed >> 8) & 255;
  const b = parsed & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

interface OverlayState {
  alpha: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

/** Estado animado de un overlay en el fotograma actual (paridad con el preview). */
function overlayState(
  spec: OverlaySpec,
  frame: number,
  pageWidth: number,
  pageHeight: number,
  fps: number,
): OverlayState | null {
  const local = frame - spec.startFrame;
  if (local < 0 || local >= spec.durationFrames) return null;

  const inFrames = spec.animationInFrames;
  const outFrames = spec.animationOutFrames;
  const rawIn = inFrames > 0 ? Math.min(1, Math.max(0, local / inFrames)) : 1;
  const rawOut =
    outFrames > 0 ? Math.min(1, Math.max(0, (spec.durationFrames - local) / outFrames)) : 1;

  let alpha = spec.opacity;
  let offsetX = 0;
  let offsetY = 0;
  let scale = 1;

  // Envolvente de fundido (igual que el preview: fadeFrames a cada extremo).
  if (spec.fadeFrames > 0) {
    alpha *= Math.min(1, Math.max(0, local / spec.fadeFrames));
    alpha *= Math.min(1, Math.max(0, (spec.durationFrames - local) / spec.fadeFrames));
  }

  const enter = (from: number, to: number) =>
    inFrames > 0
      ? interpolate(local, [0, inFrames], [from, to], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        })
      : to;
  const exit = (from: number, to: number) =>
    outFrames > 0
      ? interpolate(spec.durationFrames - local, [0, outFrames], [from, to], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.in(Easing.cubic),
        })
      : to;

  switch (spec.animationIn) {
    case "fade-in":
      alpha *= rawIn;
      break;
    case "slide-left":
      offsetX = enter(-(pageWidth + spec.estWidestPx), 0);
      break;
    case "slide-right":
      offsetX = enter(pageWidth + spec.estWidestPx, 0);
      break;
    case "slide-up":
      offsetY = enter(pageHeight + spec.blockHeightPx, 0);
      break;
    case "slide-down":
      offsetY = enter(-(pageHeight + spec.blockHeightPx), 0);
      break;
    case "zoom-in":
      scale = enter(0.5, 1);
      break;
    case "bounce-in":
      scale =
        inFrames > 0
          ? interpolate(
              spring({
                frame: local,
                fps,
                config: { damping: 11, stiffness: 170, mass: 0.6 },
                durationInFrames: inFrames,
              }),
              [0, 1],
              [0.55, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            )
          : 1;
      break;
    default:
      break;
  }

  switch (spec.animationOut) {
    case "fade-out":
      alpha *= rawOut;
      break;
    case "slide-left":
      offsetX += exit(0, -(pageWidth + spec.estWidestPx));
      break;
    case "slide-right":
      offsetX += exit(0, pageWidth + spec.estWidestPx);
      break;
    case "slide-up":
      offsetY += exit(0, pageHeight + spec.blockHeightPx);
      break;
    case "slide-down":
      offsetY += exit(0, -(pageHeight + spec.blockHeightPx));
      break;
    case "zoom-out":
      // Sale creciendo y fundiendo: corte suave en vez de salto seco.
      scale *= exit(1, 1.5);
      alpha *= rawOut;
      break;
    case "bounce-out":
      scale *= interpolate(
        spring({
          frame: spec.durationFrames - local,
          fps,
          config: { damping: 10, stiffness: 200, mass: 0.5 },
          durationInFrames: outFrames > 0 ? outFrames : undefined,
        }),
        [0, 1],
        [1, 1.35],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      alpha *= rawOut;
      break;
    default:
      break;
  }

  if (alpha <= 0.002) return null;
  return { alpha, offsetX, offsetY, scale };
}

function dataNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(Math.min(3, Math.max(0, decimals)));
  return decimals > 0 ? fixed.replace(".", ",") : fixed;
}

function useGraphicProgress(startFrame: number, durationFrames: number): number {
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - startFrame);
  const window = Math.max(1, Math.min(18, Math.floor(durationFrames * 0.55)));
  return interpolate(local, [0, window], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}

function GraphicBackdrop({
  graphic,
  fontCss,
  startFrame,
  durationFrames,
}: {
  graphic: OverlayGraphicSpec;
  fontCss: string;
  startFrame: number;
  durationFrames: number;
}) {
  const progress = useGraphicProgress(startFrame, durationFrames);
  const size = Math.min(graphic.widthPx, graphic.heightPx);
  const style: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: graphic.widthPx,
    height: graphic.heightPx,
    transform: `translate(-50%, -50%) scale(${0.82 + 0.18 * progress})`,
    borderRadius: graphic.shape === "circle" ? "50%" : graphic.shape === "square" ? size * 0.14 : size * 0.04,
    background: graphic.background ? rgbaFromHex(graphic.color, 0.14) : undefined,
    border: `2px solid ${rgbaFromHex(graphic.color, 0.45)}`,
    boxSizing: "border-box",
    fontFamily: fontCss,
  };
  if (graphic.shape === "line") {
    style.height = Math.max(4, graphic.heightPx * 0.08);
    style.borderRadius = 999;
    style.background = rgbaFromHex(graphic.color, 0.55);
    style.border = "none";
  }
  return <div style={style} />;
}

function GraphicData({ spec, graphic }: { spec: OverlaySpec; graphic: OverlayGraphicSpec }) {
  const progress = useGraphicProgress(spec.startFrame, spec.durationFrames);
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - spec.startFrame);
  const width = graphic.widthPx;
  const height = graphic.heightPx;
  const pad = Math.max(18, Math.min(width, height) * 0.09);
  const titleSize = Math.max(20, Math.min(46, width * 0.055));
  const labelSize = Math.max(15, Math.min(30, width * 0.036));
  const card: React.CSSProperties = {
    position: "relative",
    width,
    height,
    boxSizing: "border-box",
    padding: pad,
    borderRadius: Math.max(12, width * 0.03),
    background: graphic.background ? rgbaFromHex("#0C1A13", graphic.backgroundOpacity) : "transparent",
    border: graphic.background ? `1px solid ${rgbaFromHex(graphic.trackColor, 0.18)}` : "none",
    fontFamily: spec.fontCss,
    color: graphic.trackColor,
    overflow: "hidden",
  };
  const title = graphic.title ?? spec.lines.join(" ");
  const subtitle = graphic.subtitle;
  const head = (
    <div style={{ marginBottom: pad * 0.6 }}>
      {title ? (
        <div style={{ fontSize: titleSize, fontWeight: 800, lineHeight: 1.1, color: graphic.trackColor }}>
          {title}
        </div>
      ) : null}
      {subtitle ? (
        <div style={{ marginTop: titleSize * 0.22, fontSize: labelSize, opacity: 0.72 }}>{subtitle}</div>
      ) : null}
    </div>
  );

  if (graphic.kind === "counter") {
    const target = graphic.value ?? 87;
    const eased = interpolate(local, [0, Math.max(8, spec.durationFrames * 0.72)], [0, target], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
    return (
      <div style={card}>
        {head}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: titleSize * 0.12,
            fontSize: Math.min(height * 0.42, width * 0.18),
            fontWeight: 900,
            color: graphic.color,
            lineHeight: 1,
            letterSpacing: "-0.02em",
          }}
        >
          <span>{dataNumber(eased, graphic.decimals)}</span>
          {graphic.unit ? (
            <span style={{ fontSize: "0.42em", fontWeight: 700, color: graphic.trackColor }}>
              {graphic.unit}
            </span>
          ) : null}
        </div>
        <div
          style={{
            marginTop: pad * 0.5,
            height: Math.max(6, height * 0.035),
            borderRadius: 999,
            background: rgbaFromHex(graphic.trackColor, 0.16),
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, (eased / Math.max(target, 1)) * 100)}%`,
              height: "100%",
              borderRadius: 999,
              background: graphic.color,
            }}
          />
        </div>
      </div>
    );
  }

  if (graphic.kind === "progress") {
    const target = Math.max(0, Math.min(100, graphic.value ?? 72));
    const eased = target * progress;
    return (
      <div style={card}>
        {head}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: pad * 0.45,
          }}
        >
          <span style={{ fontSize: Math.min(height * 0.3, width * 0.1), fontWeight: 900, color: graphic.color }}>
            {dataNumber(eased, graphic.decimals)}
            {graphic.unit ?? "%"}
          </span>
        </div>
        <div
          style={{
            height: Math.max(10, height * 0.08),
            borderRadius: 999,
            background: rgbaFromHex(graphic.trackColor, 0.18),
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${eased}%`,
              height: "100%",
              borderRadius: 999,
              background: `linear-gradient(90deg, ${rgbaFromHex(graphic.color, 0.65)}, ${graphic.color})`,
            }}
          />
        </div>
      </div>
    );
  }

  const items = graphic.items ?? [];
  const max = graphic.maxValue ?? Math.max(1, ...items.map((item) => Math.abs(item.value)));
  const rowGap = Math.max(8, height * 0.035);
  const available = height - pad * 2 - titleSize * (graphic.title ? 1.45 : 0.2) - (subtitle ? labelSize * 1.4 : 0);
  const rowHeight = Math.max(18, (available - rowGap * Math.max(0, items.length - 1)) / Math.max(1, items.length));
  return (
    <div style={card}>
      {head}
      <div style={{ display: "flex", flexDirection: "column", gap: rowGap }}>
        {items.map((item, index) => {
          const own = interpolate(local, [index * 3, index * 3 + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.cubic),
          });
          const fraction = Math.max(0, Math.min(1, item.value / max));
          return (
            <div key={`${item.label}-${index}`} style={{ display: "flex", alignItems: "center", gap: labelSize * 0.55 }}>
              <span style={{ width: "26%", fontSize: labelSize, opacity: 0.86, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.label}
              </span>
              <span
                style={{
                  position: "relative",
                  flex: 1,
                  height: Math.max(8, rowHeight * 0.42),
                  borderRadius: 999,
                  background: rgbaFromHex(graphic.trackColor, 0.14),
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: `${fraction * own * 100}%`,
                    borderRadius: 999,
                    background: item.color ?? graphic.color,
                  }}
                />
              </span>
              <span style={{ width: "18%", textAlign: "right", fontSize: labelSize, fontWeight: 800, color: graphic.color }}>
                {dataNumber(item.value * own, graphic.decimals)}
                {graphic.unit ?? ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverlayView({ spec }: { spec: OverlaySpec }) {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const state = overlayState(spec, frame, width, height, fps);
  if (!state) return null;

  const dataGraphic =
    spec.graphic && ["bars", "counter", "progress"].includes(spec.graphic.kind)
      ? spec.graphic
      : null;
  const decorativeGraphic =
    spec.graphic && !dataGraphic ? spec.graphic : null;

  const anchorX = spec.align === "left" ? "0%" : spec.align === "right" ? "-100%" : "-50%";
  const background = spec.background;
  const shadow = spec.shadow;
  const stroke = spec.stroke;

  const lineStyle: React.CSSProperties = {
    fontFamily: spec.fontCss,
    fontWeight: spec.fontWeight,
    fontSize: spec.fontSizePx,
    lineHeight: `${spec.lineHeightPx}px`,
    color: spec.color,
    textAlign: spec.align,
    whiteSpace: "pre",
  };
  if (stroke) {
    lineStyle.WebkitTextStrokeWidth = `${stroke.widthPx}px`;
    lineStyle.WebkitTextStrokeColor = stroke.color;
    lineStyle.paintOrder = "stroke fill";
  }
  if (shadow && !background) {
    lineStyle.textShadow = `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${rgbaFromHex(shadow.color, shadow.alpha)}`;
  }

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        zIndex: 350,
        opacity: state.alpha,
        transform: `translate(${spec.anchorX * width + state.offsetX}px, ${
          spec.anchorY * height + state.offsetY
        }px)`,
        willChange: "transform, opacity",
      }}
    >
      {decorativeGraphic ? (
        <GraphicBackdrop
          graphic={decorativeGraphic}
          fontCss={spec.fontCss}
          startFrame={spec.startFrame}
          durationFrames={spec.durationFrames}
        />
      ) : null}
      <div
        style={{
          display: "inline-block",
          transform: `translateX(${anchorX}) translateY(-50%) scale(${state.scale})`,
          transformOrigin: "center",
          background: background ? rgbaFromHex(background.color, background.opacity) : undefined,
          padding: background ? `${background.paddingY}px ${background.paddingX}px` : undefined,
          borderRadius: background ? background.radius : undefined,
        }}
      >
        {dataGraphic ? (
          <GraphicData spec={spec} graphic={dataGraphic} />
        ) : (
          spec.lines.map((line, index) => (
            <div key={`${spec.id}-${index}`} style={lineStyle}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const runtimeModuleMap: Record<string, unknown> = {
  react: React,
  remotion: RemotionModule,
};

const compiledExportCache = new Map<string, React.ComponentType<any>>();

function instantiateExportComponent(
  cjsCode: string,
  componentName: string,
): React.ComponentType<any> | null {
  const cacheKey = `${componentName}::${cjsCode}`;
  const cached = compiledExportCache.get(cacheKey);
  if (cached) return cached;
  try {
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    const customRequire = (id: string): unknown => {
      if (id in runtimeModuleMap) return runtimeModuleMap[id];
      if (id === "react/jsx-runtime") return React;
      return {};
    };
    const factory = new Function("require", "module", "exports", "React", cjsCode);
    factory(customRequire, moduleObj, exportsObj, React);
    const allExports = (moduleObj.exports ?? exportsObj) as Record<string, unknown>;
    const candidate =
      allExports[componentName] ??
      allExports.default ??
      Object.values(allExports).find((val) => typeof val === "function");
    if (typeof candidate === "function") {
      const comp = candidate as React.ComponentType<any>;
      compiledExportCache.set(cacheKey, comp);
      return comp;
    }
    return null;
  } catch (err) {
    console.warn("[NovacutOverlays] Error instanciando componente exportado:", err);
    return null;
  }
}

class ExportClipErrorBoundary extends Component<
  { fallback?: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false };
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override render(): ReactNode {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}

const ExportSubtitleFallback: React.FC<{ props: Record<string, unknown> }> = ({ props }) => {
  const frame = useCurrentFrame() + Number(props.offset ?? 0);
  const { width, height } = useVideoConfig();
  const captions = Array.isArray(props.captions)
    ? (props.captions as Array<{
        start: number;
        end: number;
        words: Array<{ text: string; start: number; end: number; highlight?: boolean }>;
      }>)
    : [];
  const cue = captions.find((c) => frame >= c.start && frame < c.end);
  if (!cue) return null;

  const unit = Math.min(width, height);
  const isVertical = height > width;
  const scaleMult = typeof props.fontScale === "number" && props.fontScale > 0 ? props.fontScale : 1;
  const fontSize = unit * (isVertical ? 0.052 : 0.056) * scaleMult;
  const accent = typeof props.accentColor === "string" ? props.accentColor : "#F59E0B";
  const baseText = typeof props.textColor === "string" ? props.textColor : "#FFFFFF";
  const bgAlpha = typeof props.bgOpacity === "number" ? props.bgOpacity : 0.56;
  const defaultPosY = isVertical ? 0.74 : 0.88;
  const posY = typeof props.positionY === "number" ? props.positionY : defaultPosY;
  const bottomPad = isVertical
    ? Math.max(height * 0.22, height * (1 - posY))
    : Math.max(height * 0.04, height * (1 - posY));
  const maxSafeWidth = isVertical ? width * 0.82 : width * 0.88;
  const safeMarginRight = isVertical ? width * 0.04 : 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: bottomPad,
        paddingRight: safeMarginRight,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          maxWidth: maxSafeWidth,
          backgroundColor: `rgba(12, 14, 17, ${bgAlpha})`,
          borderRadius: fontSize * 0.36,
          padding: `${fontSize * 0.24}px ${fontSize * 0.48}px`,
          boxShadow: bgAlpha > 0.05 ? "0 8px 28px rgba(0,0,0,0.42)" : "none",
          fontFamily: '"Inter", "Plus Jakarta Sans", system-ui, sans-serif',
          fontSize,
          fontWeight: 700,
          lineHeight: 1.24,
          textAlign: "center",
        }}
      >
        {cue.words.map((word, idx) => {
          const active = frame >= word.start && frame < word.end;
          const cleanToken = word.text.replace(/[.,!?;:¡¿"']/g, "");
          const isKeyword = Boolean(word.highlight) || cleanToken.length >= 6 || /\d/.test(cleanToken);
          return (
            <span
              key={idx}
              style={{
                margin: `0 ${fontSize * 0.09}px`,
                color: active
                  ? isKeyword
                    ? accent
                    : baseText
                  : frame >= word.end
                    ? baseText
                    : "rgba(255,255,255,0.46)",
                transform: active ? "scale(1.05)" : "scale(1)",
                display: "inline-block",
                whiteSpace: "nowrap",
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

function LiveExportClipView({ spec }: { spec: LiveRemotionExportSpec }) {
  const { width, height, fps } = useVideoConfig();
  const Comp = instantiateExportComponent(spec.cjsCode, spec.componentName);
  const isSubtitle = Array.isArray(spec.props?.captions);
  const mergedProps = {
    ...(spec.props ?? {}),
    width,
    height,
    fps,
    durationInFrames: spec.durationFrames,
  };

  return (
    <Sequence from={spec.startFrame} durationInFrames={spec.durationFrames} layout="none">
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: spec.zIndex ?? 200,
          opacity: spec.opacity ?? 1,
          transform: spec.transformStyle || undefined,
          transformOrigin: spec.transformOrigin || "center center",
          pointerEvents: "none",
        }}
      >
        <ExportClipErrorBoundary
          fallback={isSubtitle ? <ExportSubtitleFallback props={mergedProps} /> : null}
        >
          {Comp ? (
            <Comp {...mergedProps} />
          ) : isSubtitle ? (
            <ExportSubtitleFallback props={mergedProps} />
          ) : null}
        </ExportClipErrorBoundary>
      </div>
    </Sequence>
  );
}

export const NovacutOverlays: React.FC<NovacutOverlaysProps> = ({
  overlays,
  fonts,
  liveClips = [],
}) => {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <style>
        {fonts
          .map(
            (font) =>
              `@font-face { font-family: "${primaryFamily(font.css)}"; src: url("${staticFile(
                font.file,
              )}") format("truetype"); font-weight: 100 900; font-display: block; }`,
          )
          .join("\n")}
      </style>
      {overlays.map((spec) => (
        <OverlayView key={spec.id} spec={spec} />
      ))}
      {liveClips.map((spec) => (
        <LiveExportClipView key={spec.id} spec={spec} />
      ))}
    </div>
  );
};
