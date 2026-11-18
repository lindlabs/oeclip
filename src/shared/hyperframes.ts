export interface HyperFrameCompiledSpec {
  componentName: string;
  code: string;
  props: Record<string, unknown>;
}

/**
 * HYPERFRAMES ENGINE FOR OECLIP (Inspired by HeyGen's HyperFrames Architecture)
 * -----------------------------------------------------------------------------
 * Deterministic, frame-seekable HTML/CSS/SVG/Canvas video-as-code engine designed
 * specifically for Autonomous Agent Swarms.
 *
 * Key architectural pillars:
 * 1. Sub-frame deterministic physics (`--hf-progress`, cubic-bezier & critically-damped springs)
 * 2. Context-aware spatial zones (`lower-third`, `top-right-hud`, `hero-top`, `full-transition`)
 *    so overlays enhance talking-head videos without obscuring the speaker's face.
 * 3. Optical Cut Transitions (`whip-blur`, `prism-wipe`, `flash-shutter`, `glitch-slice`)
 *    placed across segment cuts (`cutFrame - 7` to `cutFrame + 9`) to mask jump cuts
 *    and blend audio/visual splices naturally.
 * 4. Transcript-Grounded Data HUDs (SVG ring gauges, animated counters, chapter callouts)
 *    driven directly by spoken metrics (e.g., "65%", "35%", "88%") and key phrases.
 */

export type HyperFrameZone =
  | "lower-third"
  | "top-right-hud"
  | "top-left-hud"
  | "hero-top"
  | "center-stage"
  | "full-transition";

export type HyperFrameTransitionVariant =
  | "whip-blur"
  | "prism-wipe"
  | "flash-shutter"
  | "cyber-sweep";

export interface HyperFramePalette {
  accent: string;
  secondary: string;
  surface: string;
  text: string;
}

export interface HyperFrameMetricHudOptions {
  badge: string;
  metricValue: string;
  metricNumber?: number; // 0-100 for radial ring gauge if percentage, or target number
  isPercent?: boolean;
  title: string;
  subtitle: string;
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

export interface HyperFrameChapterOptions {
  chapterIndex: number;
  badge: string;
  title: string;
  subtitle: string;
  zone?: "lower-third" | "hero-top";
  palette: HyperFramePalette;
}

export interface HyperFrameKineticHookOptions {
  kicker: string;
  headline: string;
  subheadline: string;
  hasSpeakerInFrame?: boolean;
  palette: HyperFramePalette;
}

export interface HyperFrameOpticalTransitionOptions {
  variant: HyperFrameTransitionVariant;
  accentColor: string;
  secondaryColor: string;
  label?: string;
}

/**
 * Generates a HyperFrames Optical Transition component that straddles a video cut boundary
 * (e.g. starts 7 frames before the cut, peaks at the exact cut frame, and resolves 9 frames after).
 * This transforms harsh jump cuts into smooth, intentional editorial transitions.
 */
export function buildHyperFrameOpticalTransition(
  options: HyperFrameOpticalTransitionOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameOpticalTransition";
  const props: Record<string, unknown> = {
    variant: options.variant,
    accentColor: options.accentColor,
    secondaryColor: options.secondaryColor,
    label: options.label ?? "",
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  variant = ${JSON.stringify(options.variant)},
  accentColor = ${JSON.stringify(options.accentColor)},
  secondaryColor = ${JSON.stringify(options.secondaryColor)},
  label = ${JSON.stringify(options.label ?? "")},
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const peakFrame = Math.max(4, Math.floor(durationInFrames * 0.45));

  // Smooth bell curve peaking right at the cut point (0 -> 1 -> 0)
  const intensity = frame <= peakFrame
    ? interpolate(frame, [0, peakFrame], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : interpolate(frame, [peakFrame, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Cubic ease for whip motion (-100% -> 0% -> +100%)
  const rawProgress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cubicSweep = rawProgress < 0.5
    ? 4 * rawProgress * rawProgress * rawProgress
    : 1 - Math.pow(-2 * rawProgress + 2, 3) / 2;

  const sweepX = interpolate(cubicSweep, [0, 1], [-115, 115]);
  const prismSpread = intensity * 36;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        overflow: "hidden",
        "--hf-progress": rawProgress.toFixed(4),
        "--hf-intensity": intensity.toFixed(4),
      } as React.CSSProperties}
    >
      {/* 1. Optical Anamorphic Light Leak & Chromatic Veil */}
      <div
        style={{
          position: "absolute",
          inset: "-10%",
          opacity: intensity * 0.62,
          background:
            variant === "flash-shutter"
              ? \`radial-gradient(circle at 50% 50%, rgba(255,255,255,0.78) 0%, \${accentColor}55 42%, transparent 78%)\`
              : \`linear-gradient(105deg, transparent 15%, \${accentColor}66 46%, rgba(255,255,255,0.72) 50%, \${secondaryColor}66 54%, transparent 85%)\`,
          transform: \`translateX(\${variant === "flash-shutter" ? 0 : sweepX * 0.55}%) scale(\${1 + intensity * 0.14}) skewX(-12deg)\`,
          filter: \`blur(\${Math.round(8 + intensity * 22)}px)\`,
          mixBlendMode: "screen",
        }}
      />

      {/* 2. HyperFrames Kinetic Razor Wipe */}
      <div
        style={{
          position: "absolute",
          top: "-15%",
          bottom: "-15%",
          left: "50%",
          width: variant === "prism-wipe" ? "44%" : "28%",
          transform: \`translateX(\${sweepX * 1.45}%) rotate(-14deg)\`,
          background: \`linear-gradient(90deg, transparent, \${accentColor}aa, rgba(255,255,255,0.92), \${secondaryColor}aa, transparent)\`,
          opacity: intensity * 0.85,
          filter: \`blur(\${Math.round(2 + (1 - intensity) * 10)}px)\`,
          boxShadow: \`0 0 \${Math.round(30 + prismSpread)}px \${accentColor}88\`,
        }}
      />

      {/* 3. Subtle Horizontal Velocity Streaks (Whip-Pan Optical Cue) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: intensity * 0.45,
          backgroundImage: \`repeating-linear-gradient(0deg, transparent 0px, transparent 18px, \${accentColor}22 19px, transparent 20px)\`,
          transform: \`translateX(\${sweepX * 0.35}%) scaleX(\${1 + intensity * 0.4})\`,
        }}
      />
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

/**
 * Generates a HyperFrames Floating Metric HUD (Glassmorphic Card + Animated SVG Radial Gauge + Counter).
 * Specifically engineered for talking-head or B-roll videos when the speaker mentions a key statistic
 * (e.g., "65% de los residuos son reciclables", "35% de ahorro operativo", "88% participará").
 */
export function buildHyperFrameMetricHud(
  options: HyperFrameMetricHudOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameMetricHud";
  const zone = options.zone ?? "lower-third";
  const numericTarget =
    typeof options.metricNumber === "number" && Number.isFinite(options.metricNumber)
      ? options.metricNumber
      : Number.parseFloat(options.metricValue.replace(/[^0-9.]/g, "")) || 75;
  const isPercent =
    options.isPercent ?? (options.metricValue.includes("%") || numericTarget <= 100);

  const props: Record<string, unknown> = {
    badge: options.badge,
    metricValue: options.metricValue,
    numericTarget,
    isPercent,
    title: options.title,
    subtitle: options.subtitle,
    zone,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    surfaceColor: options.palette.surface,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  badge = ${JSON.stringify(options.badge)},
  metricValue = ${JSON.stringify(options.metricValue)},
  numericTarget = ${numericTarget},
  isPercent = ${isPercent},
  title = ${JSON.stringify(options.title)},
  subtitle = ${JSON.stringify(options.subtitle)},
  zone = ${JSON.stringify(zone)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  surfaceColor = ${JSON.stringify(options.palette.surface)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  // Critically damped spring entrance + smooth exit
  const enter = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 150, mass: 0.75 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;

  // Deterministic HyperFrames counter & ring progress
  const countProgress = interpolate(frame, [4, Math.min(34, Math.max(12, durationInFrames - 14))], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const easedCount = 1 - Math.pow(1 - countProgress, 3);
  const currentNum = Math.round(numericTarget * easedCount);

  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const gaugeRatio = Math.min(1, Math.max(0.12, (isPercent ? numericTarget : 82) / 100)) * easedCount;
  const strokeDashoffset = circumference * (1 - gaugeRatio);

  const isTopRight = zone === "top-right-hud";
  const isTopLeft = zone === "top-left-hud";
  const isHeroTop = zone === "hero-top";
  const isTop = isTopRight || isTopLeft || isHeroTop;
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isTop ? "flex-start" : "flex-end",
        alignItems: isTopRight ? "flex-end" : isTopLeft ? "flex-start" : "center",
        paddingTop: isTop ? (isVertical ? 160 : 88) : 0,
        paddingBottom: isTop ? 0 : 230,
        paddingLeft: 44,
        paddingRight: 44,
      }}
    >
      <div
        style={{
          width: isTopRight || isTopLeft ? "min(560px, 86%)" : "min(860px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [36, 0])}px) scale(\${interpolate(visibility, [0, 1], [0.92, 1])})\`,
          background: "linear-gradient(135deg, rgba(10, 15, 28, 0.88) 0%, rgba(15, 23, 42, 0.78) 100%)",
          backdropFilter: "blur(20px)",
          borderRadius: 28,
          border: \`1.5px solid \${accentColor}66\`,
          boxShadow: \`0 24px 60px rgba(0, 0, 0, 0.55), 0 0 36px \${accentColor}33, inset 0 1px 0 rgba(255, 255, 255, 0.16)\`,
          padding: "22px 28px",
          display: "flex",
          alignItems: "center",
          gap: 24,
          fontFamily: "'Inter', 'Plus Jakarta Sans', system-ui, sans-serif",
          color: textColor,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Top Accent Laser Line */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            height: 3,
            width: \`\${Math.round(easedCount * 100)}%\`,
            background: \`linear-gradient(90deg, \${accentColor}, \${secondaryColor})\`,
            boxShadow: \`0 0 16px \${accentColor}\`,
          }}
        />

        {/* SVG Radial HyperFrames Gauge */}
        <div
          style={{
            position: "relative",
            width: 96,
            height: 96,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width={96} height={96} style={{ transform: "rotate(-90deg)" }}>
            <circle
              cx={48}
              cy={48}
              r={radius}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={8}
              fill="transparent"
            />
            <circle
              cx={48}
              cy={48}
              r={radius}
              stroke={accentColor}
              strokeWidth={8}
              strokeLinecap="round"
              fill="transparent"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
            />
          </svg>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 900,
              fontSize: 25,
              letterSpacing: "-0.03em",
              color: "#ffffff",
              textShadow: \`0 0 18px \${accentColor}88\`,
            }}
          >
            {isPercent ? \`\${currentNum}%\` : metricValue}
          </div>
        </div>

        {/* Editorial Data Copy */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: accentColor,
                boxShadow: \`0 0 10px \${accentColor}\`,
              }}
            />
            <span
              style={{
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: accentColor,
              }}
            >
              {badge}
            </span>
          </div>

          <div
            style={{
              fontSize: 24,
              fontWeight: 800,
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
              color: "#ffffff",
            }}
          >
            {title}
          </div>

          {subtitle ? (
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                lineHeight: 1.32,
                color: "rgba(226, 232, 240, 0.88)",
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

/**
 * Generates a HyperFrames Editorial Chapter / Key Point Callout
 * (e.g., "PUNTO 01 · EL DIAGNÓSTICO", "PUNTO 02 · AHORRO OPERATIVO").
 * Positioned safely so the speaker remains visible while anchoring the narrative structure.
 */
export function buildHyperFrameChapterCallout(
  options: HyperFrameChapterOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameChapterCallout";
  const zone = options.zone ?? "lower-third";
  const chapterNum = String(options.chapterIndex).padStart(2, "0");

  const props: Record<string, unknown> = {
    chapterNum,
    badge: options.badge,
    title: options.title,
    subtitle: options.subtitle,
    zone,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  chapterNum = ${JSON.stringify(chapterNum)},
  badge = ${JSON.stringify(options.badge)},
  title = ${JSON.stringify(options.title)},
  subtitle = ${JSON.stringify(options.subtitle)},
  zone = ${JSON.stringify(zone)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 165, mass: 0.72 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 11), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;
  const isTop = zone === "hero-top";
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isTop ? "flex-start" : "flex-end",
        alignItems: "center",
        paddingTop: isTop ? (isVertical ? 160 : 92) : 0,
        paddingBottom: isTop ? 0 : isVertical ? 240 : 80,
        paddingLeft: 44,
        paddingRight: 44,
      }}
    >
      <div
        style={{
          width: "min(860px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [isTop ? -34 : 34, 0])}px) scale(\${interpolate(visibility, [0, 1], [0.94, 1])})\`,
          background: "linear-gradient(135deg, rgba(9, 13, 24, 0.90) 0%, rgba(15, 23, 42, 0.80) 100%)",
          backdropFilter: "blur(18px)",
          borderRadius: 24,
          border: \`1.5px solid \${accentColor}55\`,
          boxShadow: \`0 22px 54px rgba(0,0,0,0.52), 0 0 28px \${accentColor}29\`,
          padding: "20px 26px",
          display: "flex",
          alignItems: "center",
          gap: 20,
          fontFamily: "'Inter', 'Plus Jakarta Sans', system-ui, sans-serif",
          color: textColor,
        }}
      >
        {/* Number Pill */}
        <div
          style={{
            width: 68,
            height: 68,
            borderRadius: 18,
            background: \`linear-gradient(135deg, \${accentColor}, \${secondaryColor})\`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 900,
            fontSize: 28,
            color: "#060913",
            boxShadow: \`0 10px 26px \${accentColor}55\`,
            flexShrink: 0,
          }}
        >
          {chapterNum}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: accentColor,
            }}
          >
            {badge}
          </div>
          <div
            style={{
              fontSize: 25,
              fontWeight: 800,
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
              color: "#ffffff",
            }}
          >
            {title}
          </div>
          {subtitle ? (
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                lineHeight: 1.3,
                color: "rgba(226, 232, 240, 0.86)",
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

/**
 * Generates a HyperFrames 3D Kinetic Hook Title for the opening seconds of a video.
 * When `hasSpeakerInFrame` is true, it docks in the upper editorial zone (`hero-top`)
 * with glassmorphic contrast so it grabs attention without covering the speaker's face.
 */
export function buildHyperFrameKineticHook(
  options: HyperFrameKineticHookOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameKineticHook";
  const hasSpeaker = options.hasSpeakerInFrame ?? true;

  const props: Record<string, unknown> = {
    kicker: options.kicker,
    headline: options.headline,
    subheadline: options.subheadline,
    hasSpeaker,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  kicker = ${JSON.stringify(options.kicker)},
  headline = ${JSON.stringify(options.headline)},
  subheadline = ${JSON.stringify(options.subheadline)},
  hasSpeaker = ${hasSpeaker},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 155, mass: 0.78 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;
  const words = String(headline || "").split(/\\s+/).filter(Boolean);

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: hasSpeaker ? "flex-start" : "center",
        alignItems: "center",
        paddingTop: hasSpeaker ? 86 : 0,
        paddingLeft: 44,
        paddingRight: 44,
      }}
    >
      <div
        style={{
          width: "min(880px, 95%)",
          opacity: visibility,
          transform: \`perspective(900px) rotateX(\${interpolate(visibility, [0, 1], [14, 0])}deg) translateY(\${interpolate(visibility, [0, 1], [-28, 0])}px) scale(\${interpolate(visibility, [0, 1], [0.92, 1])})\`,
          background: "linear-gradient(145deg, rgba(8, 12, 22, 0.90) 0%, rgba(15, 23, 42, 0.80) 100%)",
          backdropFilter: "blur(20px)",
          borderRadius: 28,
          border: \`1.5px solid \${accentColor}66\`,
          boxShadow: \`0 26px 68px rgba(0, 0, 0, 0.58), 0 0 42px \${accentColor}33\`,
          padding: "24px 30px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 12,
          fontFamily: "'Inter', 'Plus Jakarta Sans', system-ui, sans-serif",
          color: textColor,
        }}
      >
        <div
          style={{
            padding: "6px 16px",
            borderRadius: 999,
            background: \`linear-gradient(90deg, \${accentColor}28, \${secondaryColor}28)\`,
            border: \`1px solid \${accentColor}88\`,
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: accentColor,
          }}
        >
          {kicker}
        </div>

        {/* Staggered Word Reveal */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "8px 10px",
            fontSize: hasSpeaker ? 34 : 44,
            fontWeight: 900,
            lineHeight: 1.12,
            letterSpacing: "-0.025em",
          }}
        >
          {words.map((word, idx) => {
            const wSpring = spring({
              frame: Math.max(0, frame - idx * 2),
              fps,
              config: { damping: 14, stiffness: 180, mass: 0.65 },
            });
            const isHighlight = idx === words.length - 1 || /\\d+%?/.test(word);
            return (
              <span
                key={idx}
                style={{
                  display: "inline-block",
                  opacity: wSpring,
                  transform: \`translateY(\${interpolate(wSpring, [0, 1], [16, 0])}px)\`,
                  color: isHighlight ? accentColor : "#ffffff",
                  textShadow: isHighlight ? \`0 0 22px \${accentColor}66\` : "none",
                }}
              >
                {word}
              </span>
            );
          })}
        </div>

        {subheadline ? (
          <div
            style={{
              fontSize: 17,
              fontWeight: 500,
              color: "rgba(226, 232, 240, 0.88)",
              maxWidth: "90%",
              lineHeight: 1.32,
            }}
          >
            {subheadline}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

// ============================================================================
// EXPANDED HYPERFRAMES COMPONENT CATALOG (Procedural Remotion v4)
// ============================================================================

export interface HyperFrameDataChartItem {
  label: string;
  value: number;
  formatted?: string;
  color?: string;
}

export interface HyperFrameDataChartOptions {
  title: string;
  subtitle?: string;
  badge?: string;
  chartType?: "bars" | "line" | "progress-ring";
  items: HyperFrameDataChartItem[];
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

export interface HyperFrameFloatingUIOptions {
  badge?: string;
  title: string;
  subtitle?: string;
  avatarText?: string;
  avatarUrl?: string;
  statusTag?: string;
  verified?: boolean;
  metrics?: Array<{ label: string; value: string }>;
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

export interface HyperFrameMotionGridOptions {
  theme?: "cyber" | "ambient" | "matrix" | "synthwave";
  title?: string;
  kicker?: string;
  palette: HyperFramePalette;
}

export interface HyperFrameRichMediaOverlayOptions {
  title: string;
  tag?: string;
  description?: string;
  imageUrl?: string;
  fallbackIcon?: "chart" | "user" | "sparkles" | "flame" | "target";
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

/**
 * Procedural Remotion Data Chart Component (Animated Bar Chart / Progress Line / SVG Ring).
 * Generates deterministic 60 FPS spring animations without external charts libraries.
 */
export function buildHyperFrameDataChart(
  options: HyperFrameDataChartOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameDataChart";
  const zone = options.zone ?? "lower-third";
  const chartType = options.chartType ?? "bars";
  const items = options.items.length > 0
    ? options.items
    : [
        { label: "Rendimiento", value: 85, formatted: "+85%" },
        { label: "Retención", value: 68, formatted: "68%" },
        { label: "Conversión", value: 92, formatted: "+92%" },
      ];

  const props: Record<string, unknown> = {
    title: options.title,
    subtitle: options.subtitle ?? "",
    badge: options.badge ?? "MÉTRICA EN VIVO",
    chartType,
    items,
    zone,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    surfaceColor: options.palette.surface,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  title = ${JSON.stringify(options.title)},
  subtitle = ${JSON.stringify(options.subtitle ?? "")},
  badge = ${JSON.stringify(options.badge ?? "MÉTRICA EN VIVO")},
  chartType = ${JSON.stringify(chartType)},
  items = ${JSON.stringify(items)},
  zone = ${JSON.stringify(zone)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  surfaceColor = ${JSON.stringify(options.palette.surface)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 150, mass: 0.8 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 14), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;

  const isVertical = height > width;
  const isTopRight = zone === "top-right-hud";
  const isTopLeft = zone === "top-left-hud";
  const isHero = zone === "hero-top";

  const maxValue = Math.max(...items.map((i: any) => Number(i.value) || 1), 100);

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isHero ? "flex-start" : isTopRight || isTopLeft ? "flex-start" : "flex-end",
        alignItems: isTopRight ? "flex-end" : isTopLeft ? "flex-start" : "center",
        paddingTop: isHero ? (isVertical ? 180 : 90) : isTopRight || isTopLeft ? 84 : 0,
        paddingBottom: isHero || isTopRight || isTopLeft ? 0 : isVertical ? 240 : 80,
        paddingLeft: 36,
        paddingRight: 36,
      }}
    >
      <div
        style={{
          width: isTopRight || isTopLeft ? "min(560px, 90%)" : "min(780px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [32, 0])}px) scale(\${interpolate(visibility, [0, 1], [0.93, 1])})\`,
          background: "linear-gradient(135deg, rgba(15, 23, 42, 0.92) 0%, rgba(30, 41, 59, 0.85) 100%)",
          backdropFilter: "blur(20px)",
          borderRadius: 24,
          border: \`1.5px solid \${accentColor}55\`,
          boxShadow: \`0 24px 60px rgba(0,0,0,0.6), 0 0 40px \${accentColor}25, inset 0 1px 0 rgba(255,255,255,0.18)\`,
          padding: "20px 24px",
          fontFamily: "'Inter', system-ui, sans-serif",
          color: textColor,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Laser line top */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: \`linear-gradient(90deg, \${accentColor}, \${secondaryColor}, transparent)\`,
          }}
        />

        {/* Header con badge y título */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <span
              style={{
                display: "inline-block",
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                padding: "3px 10px",
                borderRadius: 999,
                background: \`\${accentColor}25\`,
                color: accentColor,
                border: \`1px solid \${accentColor}44\`,
                marginBottom: 6,
              }}
            >
              {badge}
            </span>
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2, color: "#FFFFFF" }}>
              {title}
            </div>
            {subtitle ? (
              <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.65)", marginTop: 2 }}>
                {subtitle}
              </div>
            ) : null}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 800,
              color: accentColor,
              background: "rgba(255,255,255,0.06)",
              padding: "4px 8px",
              borderRadius: 8,
            }}
          >
            <span>▲</span>
            <span>EN VIVO</span>
          </div>
        </div>

        {/* Gráfico de barras animadas */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {items.map((item: any, idx: number) => {
            const barSpring = spring({
              frame: Math.max(0, frame - 5 - idx * 4),
              fps,
              config: { damping: 13, stiffness: 140, mass: 0.7 },
            });
            const pct = Math.min(100, Math.max(6, Math.round((item.value / maxValue) * 100)));
            const barWidth = pct * barSpring;
            const barColor = item.color || (idx === 0 ? accentColor : secondaryColor);

            return (
              <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, fontWeight: 700 }}>
                  <span style={{ color: "rgba(255,255,255,0.85)" }}>{item.label}</span>
                  <span style={{ color: barColor, fontWeight: 900 }}>
                    {item.formatted || \`\${Math.round(item.value * barSpring)}%\`}
                  </span>
                </div>
                <div
                  style={{
                    height: 9,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.1)",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: \`\${barWidth.toFixed(1)}%\`,
                      background: \`linear-gradient(90deg, \${barColor}, \${secondaryColor})\`,
                      borderRadius: 999,
                      boxShadow: \`0 0 14px \${barColor}88\`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

/**
 * Procedural Remotion Floating UI Component (Glassmorphism Card + Avatar + Status Pill + Metrics).
 * Ideal for speaker intro, testimonials, brand features, profile tags, and high-tech notifications.
 */
export function buildHyperFrameFloatingUI(
  options: HyperFrameFloatingUIOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameFloatingUI";
  const zone = options.zone ?? "lower-third";
  const avatarInitials = options.avatarText || (options.title ? options.title.slice(0, 2).toUpperCase() : "AI");
  const metrics = options.metrics ?? [
    { label: "ESTADO", value: "Activo" },
    { label: "VERSIÓN", value: "v4.0" },
  ];

  const props: Record<string, unknown> = {
    badge: options.badge ?? "PERFIL VERIFICADO",
    title: options.title,
    subtitle: options.subtitle ?? "",
    avatarText: avatarInitials,
    statusTag: options.statusTag ?? "EN LÍNEA",
    verified: options.verified ?? true,
    metrics,
    zone,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    surfaceColor: options.palette.surface,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  badge = ${JSON.stringify(options.badge ?? "PERFIL VERIFICADO")},
  title = ${JSON.stringify(options.title)},
  subtitle = ${JSON.stringify(options.subtitle ?? "")},
  avatarText = ${JSON.stringify(avatarInitials)},
  statusTag = ${JSON.stringify(options.statusTag ?? "EN LÍNEA")},
  verified = ${options.verified ?? true},
  metrics = ${JSON.stringify(metrics)},
  zone = ${JSON.stringify(zone)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 13, stiffness: 160, mass: 0.75 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;

  const isVertical = height > width;
  const isTop = zone === "hero-top" || zone === "top-right-hud" || zone === "top-left-hud";

  // Sheen light sweep reflection across card
  const sheenProgress = interpolate(frame, [8, 38], [-120, 220], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isTop ? "flex-start" : "flex-end",
        alignItems: "center",
        paddingTop: isTop ? (isVertical ? 180 : 90) : 0,
        paddingBottom: isTop ? 0 : isVertical ? 230 : 80,
        paddingLeft: 32,
        paddingRight: 32,
      }}
    >
      <div
        style={{
          width: "min(720px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [30, 0])}px) scale(\${interpolate(visibility, [0, 1], [0.94, 1])})\`,
          background: "linear-gradient(135deg, rgba(15, 23, 42, 0.90) 0%, rgba(2, 6, 23, 0.82) 100%)",
          backdropFilter: "blur(22px)",
          borderRadius: 24,
          border: \`1.5px solid \${accentColor}66\`,
          boxShadow: \`0 24px 60px rgba(0,0,0,0.65), 0 0 35px \${accentColor}25, inset 0 1px 0 rgba(255,255,255,0.2)\`,
          padding: "18px 24px",
          fontFamily: "'Inter', system-ui, sans-serif",
          color: textColor,
          display: "flex",
          alignItems: "center",
          gap: 20,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Reflective Sheen Sweep */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "35%",
            transform: \`translateX(\${sheenProgress}%)\`,
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)",
            pointerEvents: "none",
          }}
        />

        {/* Avatar Ring */}
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: \`linear-gradient(135deg, \${accentColor}, \${secondaryColor})\`,
            padding: 2.5,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            boxShadow: \`0 0 20px \${accentColor}66\`,
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              background: "#0F172A",
              display: "grid",
              placeItems: "center",
              fontSize: 22,
              fontWeight: 900,
              color: "#FFFFFF",
              letterSpacing: "0.05em",
            }}
          >
            {avatarText}
          </div>
        </div>

        {/* Content Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 900,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                padding: "2px 8px",
                borderRadius: 999,
                background: \`\${accentColor}25\`,
                color: accentColor,
                border: \`1px solid \${accentColor}44\`,
              }}
            >
              {badge}
            </span>
            {statusTag ? (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  color: "#10B981",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10B981", display: "inline-block" }} />
                {statusTag}
              </span>
            ) : null}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 19, fontWeight: 900, color: "#FFFFFF", lineHeight: 1.2 }}>
              {title}
            </span>
            {verified ? (
              <svg width={18} height={18} viewBox="0 0 24 24" fill={accentColor}>
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            ) : null}
          </div>

          {subtitle ? (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.72)", marginTop: 2, lineHeight: 1.3 }}>
              {subtitle}
            </div>
          ) : null}
        </div>

        {/* Mini stats */}
        {metrics && metrics.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              borderLeft: "1px solid rgba(255,255,255,0.12)",
              paddingLeft: 16,
              flexShrink: 0,
            }}
          >
            {metrics.map((m: any, idx: number) => (
              <div key={idx} style={{ textAlign: "right" }}>
                <div style={{ fontSize: 8.5, fontWeight: 800, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em" }}>
                  {m.label}
                </div>
                <div style={{ fontSize: 13, fontWeight: 900, color: accentColor }}>
                  {m.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

/**
 * Procedural Remotion Motion Grid Component (3D Perspective Cyber-Mesh + Ambient Glow).
 * Creates a futuristic, atmospheric background/ambient layer calculated dynamically at 60 FPS.
 */
export function buildHyperFrameMotionGrid(
  options: HyperFrameMotionGridOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameMotionGrid";
  const theme = options.theme ?? "cyber";

  const props: Record<string, unknown> = {
    theme,
    title: options.title ?? "",
    kicker: options.kicker ?? "",
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  theme = ${JSON.stringify(theme)},
  title = ${JSON.stringify(options.title ?? "")},
  kicker = ${JSON.stringify(options.kicker ?? "")},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 120, mass: 1 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 15), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const opacity = enter * exit * 0.75;

  // Grid motion cycle
  const gridOffsetY = (frame * 1.8) % 40;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        overflow: "hidden",
        opacity,
      }}
    >
      {/* Radial ambient glow */}
      <div
        style={{
          position: "absolute",
          top: "20%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: width * 0.9,
          height: height * 0.6,
          background: \`radial-gradient(ellipse at center, \${accentColor}33 0%, \${secondaryColor}15 45%, transparent 75%)\`,
          filter: "blur(40px)",
        }}
      />

      {/* 3D Perspective Ground Grid */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: "-25%",
          width: "150%",
          height: "55%",
          perspective: 400,
          perspectiveOrigin: "50% 0%",
          overflow: "hidden",
          maskImage: "linear-gradient(to top, rgba(0,0,0,1) 15%, transparent 95%)",
          WebkitMaskImage: "linear-gradient(to top, rgba(0,0,0,1) 15%, transparent 95%)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: "rotateX(68deg)",
            transformOrigin: "50% 0%",
            backgroundImage: \`
              linear-gradient(to right, \${accentColor}44 1px, transparent 1px),
              linear-gradient(to bottom, \${accentColor}44 1px, transparent 1px)
            \`,
            backgroundSize: "40px 40px",
            backgroundPosition: \`0px \${gridOffsetY}px\`,
          }}
        />
      </div>

      {/* Cyber Horizon Line */}
      <div
        style={{
          position: "absolute",
          top: "45%",
          left: 0,
          right: 0,
          height: 2,
          background: \`linear-gradient(90deg, transparent, \${accentColor}, \${secondaryColor}, transparent)\`,
          boxShadow: \`0 0 20px \${accentColor}\`,
        }}
      />

      {/* Optional Central Title if provided */}
      {title ? (
        <div
          style={{
            position: "absolute",
            top: "30%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            textAlign: "center",
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          {kicker ? (
            <div
              style={{
                fontSize: 12,
                fontWeight: 900,
                letterSpacing: "0.2em",
                color: accentColor,
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              {kicker}
            </div>
          ) : null}
          <div
            style={{
              fontSize: 36,
              fontWeight: 900,
              color: "#FFFFFF",
              letterSpacing: "-0.02em",
              textShadow: \`0 0 30px \${accentColor}88\`,
            }}
          >
            {title}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

/**
 * Procedural Remotion Rich Media Overlay Component (Supports <Img>, frame masks, stickers, drop-shadows).
 * Composes dynamic visual stickers and imagery layered smoothly onto the timeline.
 */
export function buildHyperFrameRichMediaOverlay(
  options: HyperFrameRichMediaOverlayOptions
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameRichMediaOverlay";
  const zone = options.zone ?? "lower-third";
  const icon = options.fallbackIcon ?? "sparkles";

  const props: Record<string, unknown> = {
    title: options.title,
    tag: options.tag ?? "DESTACADO",
    description: options.description ?? "",
    imageUrl: options.imageUrl ?? "",
    fallbackIcon: icon,
    zone,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  title = ${JSON.stringify(options.title)},
  tag = ${JSON.stringify(options.tag ?? "DESTACADO")},
  description = ${JSON.stringify(options.description ?? "")},
  imageUrl = ${JSON.stringify(options.imageUrl ?? "")},
  fallbackIcon = ${JSON.stringify(icon)},
  zone = ${JSON.stringify(zone)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 13, stiffness: 155, mass: 0.8 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: isVertical ? 240 : 80,
        paddingLeft: 32,
        paddingRight: 32,
      }}
    >
      <div
        style={{
          width: "min(680px, 92%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [36, 0])}px) scale(\${interpolate(visibility, [0, 1], [0.92, 1])})\`,
          background: "linear-gradient(135deg, rgba(15, 23, 42, 0.92) 0%, rgba(30, 41, 59, 0.84) 100%)",
          backdropFilter: "blur(20px)",
          borderRadius: 24,
          border: \`1.5px solid \${accentColor}66\`,
          boxShadow: \`0 24px 60px rgba(0,0,0,0.65), 0 0 35px \${accentColor}25\`,
          padding: 18,
          display: "flex",
          alignItems: "center",
          gap: 18,
          fontFamily: "'Inter', system-ui, sans-serif",
          color: textColor,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Media Frame Thumbnail or Procedural Badge */}
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 18,
            overflow: "hidden",
            background: \`linear-gradient(135deg, \${accentColor}44, \${secondaryColor}44)\`,
            border: \`1.5px solid \${accentColor}88\`,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            position: "relative",
          }}
        >
          {imageUrl ? (
            <Img src={imageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <svg width={36} height={36} viewBox="0 0 24 24" fill={accentColor}>
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
          )}
        </div>

        {/* Text and Tag Details */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 900,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              padding: "2px 8px",
              borderRadius: 999,
              background: \`\${accentColor}25\`,
              color: accentColor,
              border: \`1px solid \${accentColor}44\`,
              display: "inline-block",
              marginBottom: 4,
            }}
          >
            {tag}
          </span>
          <div style={{ fontSize: 18, fontWeight: 900, color: "#FFFFFF", lineHeight: 1.2 }}>
            {title}
          </div>
          {description ? (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>
              {description}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

export interface HyperFrameAnimatedMapOptions {
  title: string;
  subtitle: string;
  routeFrom: string;
  routeTo: string;
  routeDistanceKm?: number;
  badge?: string;
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

/**
 * Genera un mapa procedimental vectorial animado (Remotion Maps / HyperFrames)
 * con ruta geodésica curva, faro de pulso en origen/destino, rastreador de viaje
 * y telemetría de coordenadas para narrativas de viajes, expansión o geopolítica.
 */
export function buildHyperFrameAnimatedMap(
  options: HyperFrameAnimatedMapOptions,
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameAnimatedMap";
  const props: Record<string, unknown> = {
    title: options.title,
    subtitle: options.subtitle,
    routeFrom: options.routeFrom,
    routeTo: options.routeTo,
    routeDistanceKm: options.routeDistanceKm ?? 9450,
    badge: options.badge ?? "RUTA GLOBAL",
    zone: options.zone ?? "hero-top",
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  title = ${JSON.stringify(options.title)},
  subtitle = ${JSON.stringify(options.subtitle)},
  routeFrom = ${JSON.stringify(options.routeFrom)},
  routeTo = ${JSON.stringify(options.routeTo)},
  routeDistanceKm = ${options.routeDistanceKm ?? 9450},
  badge = ${JSON.stringify(options.badge ?? "RUTA GLOBAL")},
  zone = ${JSON.stringify(options.zone ?? "hero-top")},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 150, mass: 0.8 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;
  const isVertical = height > width;
  const isTop = zone === "hero-top" || zone === "top-right-hud" || zone === "top-left-hud";

  // Distancia progresiva animada
  const currentDist = Math.round(
    interpolate(frame, [10, 42], [0, routeDistanceKm], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );

  // Progreso de trazado geodésico (0 -> 1)
  const arcProgress = interpolate(frame, [10, 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Trayectoria Bezier Cuadrática: P0(110, 210) -> Control(320, 70) -> P1(530, 190)
  const p0x = 110;
  const p0y = 210;
  const cx = 320;
  const cy = 70;
  const p1x = 530;
  const p1y = 190;

  const t = arcProgress;
  const markerX = (1 - t) * (1 - t) * p0x + 2 * (1 - t) * t * cx + t * t * p1x;
  const markerY = (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * cy + t * t * p1y;

  // Radar ping en punto de origen
  const pingPhase = (frame % 28) / 28;
  const pingR = interpolate(pingPhase, [0, 1], [5, 24]);
  const pingOpacity = interpolate(pingPhase, [0, 1], [0.85, 0]);

  // Respiración sutil en eje Y
  const breathY = Math.sin(frame / (fps * 0.8)) * 3;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isTop ? "flex-start" : "center",
        alignItems: "center",
        paddingTop: isTop ? (isVertical ? 160 : 88) : 0,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div
        style={{
          width: "min(680px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [30, 0]) + breathY}px) scale(\${interpolate(visibility, [0, 1], [0.93, 1])})\`,
          background: "linear-gradient(145deg, rgba(15, 23, 42, 0.94) 0%, rgba(2, 6, 23, 0.90) 100%)",
          backdropFilter: "blur(22px)",
          borderRadius: 24,
          border: \`1.5px solid \${accentColor}66\`,
          boxShadow: \`0 24px 60px rgba(0,0,0,0.7), 0 0 35px \${accentColor}25, inset 0 1px 0 rgba(255,255,255,0.2)\`,
          padding: "18px 22px",
          fontFamily: "'Inter', system-ui, sans-serif",
          color: textColor,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Cabecera del HUD de Mapa */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 9,
                fontWeight: 900,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                padding: "2px 8px",
                borderRadius: 999,
                background: \`\${accentColor}25\`,
                color: accentColor,
                border: \`1px solid \${accentColor}55\`,
              }}
            >
              {badge}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 800, color: "#FFFFFF" }}>
              <span>{routeFrom}</span>
              <span style={{ color: accentColor, fontSize: 14 }}>➔</span>
              <span>{routeTo}</span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: "#38BDF8", fontVariantNumeric: "tabular-nums" }}>
              {currentDist.toLocaleString()} KM
            </div>
            <div style={{ fontSize: 8.5, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em" }}>
              DISTANCIA EN RUTA
            </div>
          </div>
        </div>

        {/* Lienzo SVG del Mapa Procedimental */}
        <div
          style={{
            width: "100%",
            height: isVertical ? 220 : 180,
            borderRadius: 16,
            background: "radial-gradient(ellipse at 50% 50%, rgba(30, 41, 59, 0.6) 0%, rgba(15, 23, 42, 0.95) 100%)",
            border: "1px solid rgba(255,255,255,0.08)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <svg viewBox="0 0 640 280" style={{ width: "100%", height: "100%", display: "block" }}>
            {/* Grilla de Coordenadas Lat/Lon */}
            <defs>
              <pattern id="hf-map-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.8" />
              </pattern>
            </defs>
            <rect width="640" height="280" fill="url(#hf-map-grid)" />

            {/* Siluetas Geográficas Estilizadas (Continentes / Masas de Tierra) */}
            <path
              d="M 50 120 Q 90 90 140 110 T 210 160 T 170 240 T 100 230 T 40 170 Z"
              fill="rgba(255,255,255,0.04)"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
            <path
              d="M 280 80 Q 340 60 410 75 T 480 130 T 460 210 T 360 230 T 290 170 Z"
              fill="rgba(255,255,255,0.04)"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
            <path
              d="M 500 140 Q 560 110 610 130 T 620 220 T 540 240 T 490 190 Z"
              fill="rgba(255,255,255,0.04)"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />

            {/* Arco Geodésico Curvo */}
            <path
              d="M 110 210 Q 320 70 530 190"
              fill="none"
              stroke={accentColor}
              strokeWidth="3.5"
              strokeDasharray="480"
              strokeDashoffset={interpolate(arcProgress, [0, 1], [480, 0])}
              strokeLinecap="round"
              style={{ filter: \`drop-shadow(0 0 10px \${accentColor})\` }}
            />

            {/* Trayectoria Punteada Guía */}
            <path
              d="M 110 210 Q 320 70 530 190"
              fill="none"
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />

            {/* Faro y Radar en Origen */}
            <circle cx={p0x} cy={p0y} r={pingR} fill="none" stroke={accentColor} strokeWidth="1.5" opacity={pingOpacity} />
            <circle cx={p0x} cy={p0y} r="6" fill={accentColor} />
            <circle cx={p0x} cy={p0y} r="2.5" fill="#FFFFFF" />

            {/* Faro y Diana en Destino */}
            <circle cx={p1x} cy={p1y} r="10" fill="none" stroke={secondaryColor} strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={p1x} cy={p1y} r="5" fill={secondaryColor} />
            <circle cx={p1x} cy={p1y} r="2" fill="#FFFFFF" />

            {/* Rastreador Móvil en Vuelo / Ruta */}
            <g transform={\`translate(\${markerX}, \${markerY})\`}>
              <circle r="9" fill={accentColor} opacity="0.35" />
              <circle r="4.5" fill="#FFFFFF" style={{ filter: "drop-shadow(0 0 6px #FFFFFF)" }} />
            </g>
          </svg>
        </div>

        {/* Título y Coordenadas Inferiores */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#FFFFFF", lineHeight: 1.2 }}>
              {title}
            </div>
            <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>
              {subtitle}
            </div>
          </div>
          <div style={{ fontSize: 8.5, fontFamily: "monospace", color: "rgba(255,255,255,0.5)", textAlign: "right" }}>
            LAT: 35.6762° N<br />LON: 139.6503° E
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

export interface HyperFrameBrandCardOptions {
  brandName: string;
  tagline: string;
  domain: string;
  metricsText?: string;
  badge?: string;
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

/**
 * Genera una tarjeta de Identidad de Marca (Brand Intelligence / HyperFrames)
 * para showcases ejecutivos, demostraciones de producto y videos con URL de marca.
 */
export function buildHyperFrameBrandCard(
  options: HyperFrameBrandCardOptions,
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameBrandCard";
  const props: Record<string, unknown> = {
    brandName: options.brandName,
    tagline: options.tagline,
    domain: options.domain,
    metricsText: options.metricsText ?? "Plataforma Verificada",
    badge: options.badge ?? "BRAND INTELLIGENCE",
    zone: options.zone ?? "hero-top",
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  brandName = ${JSON.stringify(options.brandName)},
  tagline = ${JSON.stringify(options.tagline)},
  domain = ${JSON.stringify(options.domain)},
  metricsText = ${JSON.stringify(options.metricsText ?? "Plataforma Verificada")},
  badge = ${JSON.stringify(options.badge ?? "BRAND INTELLIGENCE")},
  zone = ${JSON.stringify(options.zone ?? "hero-top")},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 13, stiffness: 160, mass: 0.75 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;
  const isVertical = height > width;
  const isTop = zone === "hero-top" || zone === "top-right-hud" || zone === "top-left-hud";

  // Destello reflejante animado
  const sheen = interpolate(frame, [8, 38], [-120, 220], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const breathY = Math.sin(frame / (fps * 0.8)) * 3;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isTop ? "flex-start" : "center",
        alignItems: "center",
        paddingTop: isTop ? (isVertical ? 160 : 88) : 0,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div
        style={{
          width: "min(680px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [30, 0]) + breathY}px) scale(\${interpolate(visibility, [0, 1], [0.94, 1])})\`,
          background: "linear-gradient(135deg, rgba(15, 23, 42, 0.94) 0%, rgba(2, 6, 23, 0.88) 100%)",
          backdropFilter: "blur(22px)",
          borderRadius: 24,
          border: \`1.5px solid \${accentColor}77\`,
          boxShadow: \`0 24px 60px rgba(0,0,0,0.7), 0 0 40px \${accentColor}30, inset 0 1px 0 rgba(255,255,255,0.2)\`,
          padding: "18px 24px",
          fontFamily: "'Inter', system-ui, sans-serif",
          color: textColor,
          display: "flex",
          alignItems: "center",
          gap: 20,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Destello Sheen */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "35%",
            transform: \`translateX(\${sheen}%)\`,
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)",
            pointerEvents: "none",
          }}
        />

        {/* Monograma de Marca con Anillo Gradiente */}
        <div
          style={{
            width: 68,
            height: 68,
            borderRadius: 20,
            background: \`linear-gradient(135deg, \${accentColor}, \${secondaryColor})\`,
            padding: 2.5,
            flexShrink: 0,
            boxShadow: \`0 0 25px \${accentColor}66\`,
            display: "grid",
            placeItems: "center",
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: 18,
              background: "#0F172A",
              display: "grid",
              placeItems: "center",
              fontSize: 26,
              fontWeight: 900,
              color: "#FFFFFF",
              letterSpacing: "0.05em",
            }}
          >
            {brandName.slice(0, 2).toUpperCase()}
          </div>
        </div>

        {/* Detalles de Marca y Dominio */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span
              style={{
                fontSize: 8.5,
                fontWeight: 900,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                padding: "2px 8px",
                borderRadius: 999,
                background: \`\${accentColor}25\`,
                color: accentColor,
                border: \`1px solid \${accentColor}55\`,
              }}
            >
              {badge}
            </span>
            <div
              style={{
                fontSize: 9.5,
                fontFamily: "monospace",
                color: "#10B981",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10B981", display: "inline-block" }} />
              {domain}
            </div>
          </div>

          <div style={{ fontSize: 20, fontWeight: 900, color: "#FFFFFF", lineHeight: 1.15 }}>
            {brandName}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.72)", marginTop: 3 }}>
            {tagline}
          </div>
          {metricsText && (
            <div style={{ fontSize: 9.5, fontWeight: 700, color: "#38BDF8", marginTop: 5 }}>
              ⚡ {metricsText}
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

export interface HyperFrameCharacterDialogueOptions {
  characterName: string;
  characterRole: string;
  dialogueText: string;
  sceneTitle?: string;
  badge?: string;
  avatarInitials?: string;
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

/**
 * Genera un componente de diálogo y personaje procedural (HyperFrames Character Dialogue).
 * Sincroniza la identidad visual de personajes (nombre, rol, avatar, ondas de voz activas)
 * con el guion hablado o narrativo para máxima coherencia de storytelling.
 */
export function buildHyperFrameCharacterDialogue(
  options: HyperFrameCharacterDialogueOptions,
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameCharacterDialogue";
  const props: Record<string, unknown> = {
    characterName: options.characterName,
    characterRole: options.characterRole,
    dialogueText: options.dialogueText,
    sceneTitle: options.sceneTitle ?? "",
    badge: options.badge ?? "DIÁLOGO",
    avatarInitials: options.avatarInitials ?? options.characterName.slice(0, 2).toUpperCase(),
    zone: options.zone ?? "hero-top",
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    textColor: options.palette.text,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  characterName = ${JSON.stringify(options.characterName)},
  characterRole = ${JSON.stringify(options.characterRole)},
  dialogueText = ${JSON.stringify(options.dialogueText)},
  sceneTitle = ${JSON.stringify(options.sceneTitle ?? "")},
  badge = ${JSON.stringify(options.badge ?? "DIÁLOGO")},
  avatarInitials = ${JSON.stringify(options.avatarInitials ?? options.characterName.slice(0, 2).toUpperCase())},
  zone = ${JSON.stringify(options.zone ?? "hero-top")},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  textColor = ${JSON.stringify(options.palette.text)},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 155, mass: 0.8 },
  });
  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const visibility = enter * exit;
  const isVertical = height > width;
  const isTop = zone === "hero-top" || zone === "top-right-hud" || zone === "top-left-hud";

  // Barras animadas de voz activa
  const bar1 = 5 + Math.abs(Math.sin(frame * 0.45)) * 14;
  const bar2 = 5 + Math.abs(Math.cos(frame * 0.38)) * 16;
  const bar3 = 5 + Math.abs(Math.sin(frame * 0.52 + 1)) * 13;
  const bar4 = 5 + Math.abs(Math.cos(frame * 0.42 + 2)) * 15;

  const breathY = Math.sin(frame / (fps * 0.8)) * 3;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isTop ? "flex-start" : "center",
        alignItems: "center",
        paddingTop: isTop ? (isVertical ? 160 : 88) : 0,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div
        style={{
          width: "min(680px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [32, 0]) + breathY}px) scale(\${interpolate(visibility, [0, 1], [0.93, 1])})\`,
          background: "linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(2, 6, 23, 0.90) 100%)",
          backdropFilter: "blur(22px)",
          borderRadius: 24,
          border: \`1.5px solid \${accentColor}77\`,
          boxShadow: \`0 24px 60px rgba(0,0,0,0.7), 0 0 35px \${accentColor}25, inset 0 1px 0 rgba(255,255,255,0.2)\`,
          padding: "18px 22px",
          fontFamily: "'Inter', system-ui, sans-serif",
          color: textColor,
          display: "flex",
          alignItems: "flex-start",
          gap: 18,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Avatar del Personaje con Anillo y Pulso */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div
            style={{
              width: 62,
              height: 62,
              borderRadius: "50%",
              background: \`linear-gradient(135deg, \${accentColor}, \${secondaryColor})\`,
              padding: 2.5,
              display: "grid",
              placeItems: "center",
              boxShadow: \`0 0 20px \${accentColor}55\`,
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                background: "#0F172A",
                display: "grid",
                placeItems: "center",
                fontSize: 22,
                fontWeight: 900,
                color: "#FFFFFF",
                letterSpacing: "0.05em",
              }}
            >
              {avatarInitials}
            </div>
          </div>

          {/* Ondas de voz animadas */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2.5, height: 18 }}>
            <span style={{ width: 2.5, height: bar1, borderRadius: 2, background: accentColor }} />
            <span style={{ width: 2.5, height: bar2, borderRadius: 2, background: secondaryColor }} />
            <span style={{ width: 2.5, height: bar3, borderRadius: 2, background: accentColor }} />
            <span style={{ width: 2.5, height: bar4, borderRadius: 2, background: secondaryColor }} />
          </div>
        </div>

        {/* Contenido del Diálogo */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontSize: 8.5,
                  fontWeight: 900,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: \`\${accentColor}25\`,
                  color: accentColor,
                  border: \`1px solid \${accentColor}55\`,
                }}
              >
                {badge}
              </span>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,0.6)" }}>
                {characterRole}
              </span>
            </div>
          </div>

          <div style={{ fontSize: 16, fontWeight: 900, color: "#FFFFFF", marginBottom: 6 }}>
            {characterName}
          </div>

          {/* Texto del diálogo entrecomillado */}
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.92)",
              background: "rgba(255,255,255,0.05)",
              padding: "10px 14px",
              borderRadius: 14,
              borderLeft: \`3px solid \${accentColor}\`,
              fontStyle: "italic",
            }}
          >
            "{dialogueText}"
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}
export interface HyperFrameBespokeMetaphorOptions {
  metaphorKind:
    | "neural_network"
    | "radar_telemetry"
    | "quantum_orbit"
    | "isometric_flow"
    | "chronicle_timeline"
    | "hud_brackets"
    | "generic_svg";
  title: string;
  subtitle: string;
  badge?: string;
  metricValue?: string;
  palette: HyperFramePalette;
  zone?: HyperFrameZone;
  svgIconPath?: string;
  clipPath?: string;
}

/**
 * Procedural Remotion Bespoke Metaphor Component (Zero-Template Engine).
 * Synthesizes dynamic SVG/Canvas visual metaphors on the fly from fundamental Remotion primitives.
 */
export function buildHyperFrameBespokeMetaphor(
  options: HyperFrameBespokeMetaphorOptions,
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameBespokeMetaphor";
  const zone = options.zone ?? "hero-top";
  const badge = options.badge ?? "ANÁLISIS EN VIVO";

  const props: Record<string, unknown> = {
    metaphorKind: options.metaphorKind,
    title: options.title,
    subtitle: options.subtitle,
    badge,
    metricValue: options.metricValue ?? "",
    zone,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    surfaceColor: options.palette.surface,
    textColor: options.palette.text,
    svgIconPath: options.svgIconPath ?? "",
    clipPath: options.clipPath ?? "",
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  metaphorKind = ${JSON.stringify(options.metaphorKind)},
  title = ${JSON.stringify(options.title)},
  subtitle = ${JSON.stringify(options.subtitle)},
  badge = ${JSON.stringify(badge)},
  metricValue = ${JSON.stringify(options.metricValue ?? "")},
  zone = ${JSON.stringify(zone)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  surfaceColor = ${JSON.stringify(options.palette.surface)},
  textColor = ${JSON.stringify(options.palette.text)},
  svgIconPath = ${JSON.stringify(options.svgIconPath ?? "")},
  clipPath = ${JSON.stringify(options.clipPath ?? "")},
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  // Física de resortes Remotion a 60 FPS determinista
  const enterSpring = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 140, mass: 0.85 },
  });

  const exit = interpolate(
    frame,
    [Math.max(0, durationInFrames - 12), Math.max(1, durationInFrames - 1)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const visibility = enterSpring * exit;
  const isVertical = height > width;
  const isTop = zone === "hero-top" || zone === "top-right-hud" || zone === "top-left-hud";

  // Micro-movimiento continuo en reposo (idle breathing)
  const idleOsc = Math.sin(frame / (fps * 0.75)) * 3;
  const pulse = 0.94 + 0.08 * Math.sin(frame / 18);

  // Staggering de capas
  const iconEnter = spring({ frame: Math.max(0, frame - 3), fps, config: { damping: 12, stiffness: 160 } });
  const textEnter = spring({ frame: Math.max(0, frame - 6), fps, config: { damping: 15, stiffness: 130 } });
  const metricEnter = spring({ frame: Math.max(0, frame - 9), fps, config: { damping: 14, stiffness: 150 } });

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: isTop ? "flex-start" : "center",
        alignItems: "center",
        paddingTop: isTop ? (isVertical ? 160 : 88) : 0,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div
        style={{
          width: "min(720px, 94%)",
          opacity: visibility,
          transform: \`translateY(\${interpolate(visibility, [0, 1], [35, 0]) + idleOsc}px) scale(\${interpolate(visibility, [0, 1], [0.92, 1])})\`,
          background: "linear-gradient(135deg, rgba(15, 23, 42, 0.94) 0%, rgba(2, 6, 23, 0.90) 100%)",
          backdropFilter: "blur(24px)",
          borderRadius: clipPath ? 0 : 22,
          clipPath: clipPath || undefined,
          border: \`1.5px solid \${accentColor}77\`,
          boxShadow: \`0 24px 60px rgba(0,0,0,0.7), 0 0 40px \${accentColor}25, inset 0 1px 0 rgba(255,255,255,0.2)\`,
          padding: "20px 24px",
          fontFamily: "'Inter', system-ui, sans-serif",
          color: textColor,
          display: "flex",
          alignItems: "center",
          gap: 20,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Metáfora Visual Procedimental SVG */}
        <div
          style={{
            width: 76,
            height: 76,
            flexShrink: 0,
            borderRadius: 18,
            background: \`radial-gradient(circle, \${accentColor}25 0%, transparent 70%)\`,
            border: \`1px solid \${accentColor}44\`,
            display: "grid",
            placeItems: "center",
            transform: \`scale(\${iconEnter})\`,
            position: "relative",
          }}
        >
          {metaphorKind === "quantum_orbit" ? (
            <svg width="60" height="60" viewBox="0 0 60 60" style={{ transform: \`rotate(\${frame * 1.5}deg)\` }}>
              <ellipse cx="30" cy="30" rx="24" ry="9" fill="none" stroke={accentColor} strokeWidth="1.5" strokeDasharray="4 2" />
              <ellipse cx="30" cy="30" rx="9" ry="24" fill="none" stroke={secondaryColor} strokeWidth="1.5" strokeDasharray="4 2" />
              <circle cx="30" cy="30" r="6" fill={accentColor} style={{ filter: \`drop-shadow(0 0 8px \${accentColor})\` }} />
              <circle cx="54" cy="30" r="3" fill="#FFFFFF" />
            </svg>
          ) : metaphorKind === "radar_telemetry" ? (
            <svg width="60" height="60" viewBox="0 0 60 60">
              <circle cx="30" cy="30" r="26" fill="none" stroke={accentColor} strokeWidth="1" opacity="0.4" />
              <circle cx="30" cy="30" r="16" fill="none" stroke={secondaryColor} strokeWidth="1" opacity="0.6" />
              <line x1="30" y1="30" x2={30 + Math.cos(frame * 0.08) * 26} y2={30 + Math.sin(frame * 0.08) * 26} stroke={accentColor} strokeWidth="2" />
              <circle cx="30" cy="30" r="3" fill="#FFFFFF" />
            </svg>
          ) : metaphorKind === "neural_network" ? (
            <svg width="60" height="60" viewBox="0 0 60 60">
              <line x1="15" y1="20" x2="45" y2="20" stroke={secondaryColor} strokeWidth="1.5" opacity={0.4 + 0.4 * pulse} />
              <line x1="15" y1="40" x2="45" y2="40" stroke={secondaryColor} strokeWidth="1.5" opacity={0.4 + 0.4 * pulse} />
              <line x1="15" y1="20" x2="45" y2="40" stroke={accentColor} strokeWidth="1.5" />
              <line x1="15" y1="40" x2="45" y2="20" stroke={accentColor} strokeWidth="1.5" />
              <circle cx="15" cy="20" r="4.5" fill={accentColor} />
              <circle cx="15" cy="40" r="4.5" fill={accentColor} />
              <circle cx="45" cy="20" r="4.5" fill={secondaryColor} />
              <circle cx="45" cy="40" r="4.5" fill={secondaryColor} />
            </svg>
          ) : metaphorKind === "chronicle_timeline" ? (
            <svg width="60" height="60" viewBox="0 0 60 60">
              <line x1="10" y1="30" x2="50" y2="30" stroke={secondaryColor} strokeWidth="2" strokeDasharray="3 3" />
              <circle cx="15" cy="30" r="4" fill={accentColor} />
              <circle cx="30" cy="30" r="5" fill="#FFFFFF" style={{ filter: \`drop-shadow(0 0 6px \${accentColor})\` }} />
              <circle cx="45" cy="30" r="4" fill={secondaryColor} />
            </svg>
          ) : (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={svgIconPath || "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"} />
            </svg>
          )}
        </div>

        {/* Textos y jerarquía */}
        <div style={{ flex: 1, minWidth: 0, opacity: textEnter }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span
              style={{
                fontSize: 9,
                fontWeight: 900,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                padding: "2.5px 8px",
                borderRadius: 999,
                background: \`\${accentColor}25\`,
                color: accentColor,
                border: \`1px solid \${accentColor}55\`,
              }}
            >
              {badge}
            </span>
          </div>

          <div style={{ fontSize: 17, fontWeight: 900, color: "#FFFFFF", letterSpacing: "-0.01em", marginBottom: 3 }}>
            {title}
          </div>

          <div style={{ fontSize: 12.5, color: "rgba(255, 255, 255, 0.72)", lineHeight: 1.35 }}>
            {subtitle}
          </div>
        </div>

        {/* Métrica opcional de alto impacto */}
        {metricValue ? (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 14,
              background: \`\${accentColor}18\`,
              border: \`1px solid \${accentColor}44\`,
              textAlign: "right",
              flexShrink: 0,
              transform: \`scale(\${metricEnter})\`,
            }}
          >
            <div style={{ fontSize: 9, fontWeight: 800, color: secondaryColor, textTransform: "uppercase" }}>
              TELEMETRÍA
            </div>
            <div style={{ fontSize: 18, fontWeight: 900, color: "#FFFFFF" }}>
              {metricValue}
            </div>
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}



export type HyperFrameLookPreset =
  | "cinema-teal-orange"
  | "noir-contrast"
  | "neon-cyber"
  | "warm-film"
  | "editorial-clean";

export interface HyperFrameCinematicLookOptions {
  lookPreset: HyperFrameLookPreset;
  accentColor: string;
  secondaryColor: string;
  customTintHex?: string;
  letterboxRatio?: number;
  vignetteIntensity?: number;
  grainOpacity?: number;
  glowIntensity?: number;
  audioPeaks?: number[];
}

/**
 * Capa de Atmósfera Cinematográfica & Look Procedural (Remotion × HyperFrames).
 * Se superpone en modo no bloqueante (`pointerEvents: "none"`) para dar grado tonal,
 * viñeta óptica adaptativa audio-reactiva, barras anamórficas animadas y grano orgánico de película.
 */
export function buildHyperFrameCinematicLook(
  options: HyperFrameCinematicLookOptions,
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameCinematicLook";
  const letterboxRatio = Math.max(0, Math.min(0.16, options.letterboxRatio ?? 0));
  const vignetteIntensity = Math.max(0, Math.min(0.95, options.vignetteIntensity ?? 0.42));
  const grainOpacity = Math.max(0, Math.min(0.18, options.grainOpacity ?? 0.045));
  const glowIntensity = Math.max(0, Math.min(0.85, options.glowIntensity ?? 0.25));
  const audioPeaks = Array.isArray(options.audioPeaks) ? options.audioPeaks.slice(0, 600) : [];

  const props: Record<string, unknown> = {
    lookPreset: options.lookPreset,
    accentColor: options.accentColor,
    secondaryColor: options.secondaryColor,
    customTintHex: options.customTintHex ?? "",
    letterboxRatio,
    vignetteIntensity,
    grainOpacity,
    glowIntensity,
    audioPeaks,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  lookPreset = ${JSON.stringify(options.lookPreset)},
  accentColor = ${JSON.stringify(options.accentColor)},
  secondaryColor = ${JSON.stringify(options.secondaryColor)},
  customTintHex = ${JSON.stringify(options.customTintHex ?? "")},
  letterboxRatio = ${JSON.stringify(letterboxRatio)},
  vignetteIntensity = ${JSON.stringify(vignetteIntensity)},
  grainOpacity = ${JSON.stringify(grainOpacity)},
  glowIntensity = ${JSON.stringify(glowIntensity)},
  audioPeaks = ${JSON.stringify(audioPeaks)},
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const barEnter = spring({
    frame,
    fps,
    config: { damping: 24, stiffness: 120, mass: 0.9 },
  });
  const barOut = durationInFrames > 24
    ? interpolate(frame, [durationInFrames - 18, durationInFrames - 1], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  const barHeightPct = Math.max(0, Number(letterboxRatio) * 100 * barEnter * barOut);

  const audioBucket =
    Array.isArray(audioPeaks) && audioPeaks.length > 0
      ? Number(
          audioPeaks[
            Math.min(audioPeaks.length - 1, Math.max(0, Math.floor((frame / Math.max(1, fps)) * 4)))
          ] ?? 0.35,
        )
      : 0.35;
  const pulse = 0.72 + 0.14 * Math.sin(frame * 0.04) + audioBucket * 0.42;
  const driftX = Math.sin(frame * 0.018) * 12;
  const driftY = Math.cos(frame * 0.014) * 10;

  const customTint = typeof customTintHex === "string" && /^#[0-9A-Fa-f]{6}$/.test(customTintHex)
    ? customTintHex
    : "";

  const topWash = customTint
    ? \`\${customTint}24\`
    : lookPreset === "cinema-teal-orange"
      ? "rgba(14, 116, 144, 0.16)"
      : lookPreset === "noir-contrast"
        ? "rgba(15, 23, 42, 0.24)"
        : lookPreset === "neon-cyber"
          ? \`\${accentColor}24\`
          : lookPreset === "warm-film"
            ? "rgba(217, 119, 6, 0.14)"
            : "rgba(255, 255, 255, 0.03)";

  const bottomWash = customTint
    ? \`\${secondaryColor}22\`
    : lookPreset === "cinema-teal-orange"
      ? "rgba(234, 88, 12, 0.14)"
      : lookPreset === "neon-cyber"
        ? \`\${secondaryColor}22\`
        : "rgba(0, 0, 0, 0.18)";

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden", backgroundColor: "transparent" }}>
      {/* Degradado atmosférico de gradación tonal */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: \`linear-gradient(155deg, \${topWash} 0%, transparent 45%, \${bottomWash} 100%)\`,
          opacity: Math.max(0.25, Number(glowIntensity) * 2.2),
        }}
      />

      {/* Destello óptico lateral suave */}
      <div
        style={{
          position: "absolute",
          top: \`calc(-18% + \${driftY}px)\`,
          right: \`calc(-14% + \${driftX}px)\`,
          width: "52%",
          height: "52%",
          borderRadius: "9999px",
          background: \`radial-gradient(circle, \${accentColor}26 0%, \${accentColor}0d 45%, transparent 72%)\`,
          opacity: Number(glowIntensity) * pulse,
        }}
      />

      {/* Viñeta cinematográfica perimetral */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: \`radial-gradient(ellipse at center, transparent 52%, rgba(0, 0, 0, \${Number(vignetteIntensity).toFixed(2)}) 100%)\`,
        }}
      />

      {/* Textura orgánica sutil sin bloquear la nitidez del sujeto */}
      {Number(grainOpacity) > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: Number(grainOpacity),
            backgroundImage: \`repeating-linear-gradient(0deg, rgba(255,255,255,0.06) 0px, transparent 1px, transparent 3px), repeating-linear-gradient(90deg, rgba(0,0,0,0.08) 0px, transparent 1px, transparent 4px)\`,
            transform: \`translate(\${((frame * 7) % 5) - 2}px, \${((frame * 11) % 5) - 2}px)\`,
          }}
        />
      ) : null}

      {/* Barras anamórficas de cine (solo cuando letterboxRatio > 0) */}
      {barHeightPct > 0.1 ? (
        <>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: \`\${barHeightPct.toFixed(2)}%\`,
              background: "#04060A",
              boxShadow: "0 6px 24px rgba(0,0,0,0.65)",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: \`\${barHeightPct.toFixed(2)}%\`,
              background: "#04060A",
              boxShadow: "0 -6px 24px rgba(0,0,0,0.65)",
            }}
          />
        </>
      ) : null}
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}

export interface HyperFrameSplitComparisonOptions {
  badge: string;
  title: string;
  leftLabel: string;
  leftValue: string;
  rightLabel: string;
  rightValue: string;
  zone?: HyperFrameZone;
  palette: HyperFramePalette;
}

/**
 * Comparativa Split-Screen Interactiva HyperFrames (Antes vs Después / A vs B)
 * con cortina SVG animada por spring y haz divisor luminoso.
 */
export function buildHyperFrameSplitComparison(
  options: HyperFrameSplitComparisonOptions,
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameSplitComparison";
  const zone = options.zone ?? "hero-top";
  const props: Record<string, unknown> = {
    badge: options.badge,
    title: options.title,
    leftLabel: options.leftLabel,
    leftValue: options.leftValue,
    rightLabel: options.rightLabel,
    rightValue: options.rightValue,
    zone,
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  badge = ${JSON.stringify(options.badge)},
  title = ${JSON.stringify(options.title)},
  leftLabel = ${JSON.stringify(options.leftLabel)},
  leftValue = ${JSON.stringify(options.leftValue)},
  rightLabel = ${JSON.stringify(options.rightLabel)},
  rightValue = ${JSON.stringify(options.rightValue)},
  zone = ${JSON.stringify(zone)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 135, mass: 0.8 } });
  const exitStart = Math.max(20, durationInFrames - 14);
  const exit = durationInFrames > 24
    ? interpolate(frame, [exitStart, durationInFrames - 1], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  const vis = Math.min(enter, exit);
  const sweep = 42 + 16 * Math.sin(Math.min(1, frame / Math.max(24, durationInFrames * 0.65)) * Math.PI);
  const isTop = zone === "hero-top" || zone === "top-left-hud" || zone === "top-right-hud";

  return (
    <AbsoluteFill
      style={{
        justifyContent: isTop ? "flex-start" : "flex-end",
        alignItems: "center",
        padding: isTop ? "8% 7%" : "0 7% 22%",
        pointerEvents: "none",
        backgroundColor: "transparent",
      }}
    >
      <div
        style={{
          width: "min(92%, 720px)",
          borderRadius: 22,
          overflow: "hidden",
          position: "relative",
          background: "rgba(9, 13, 24, 0.88)",
          border: \`1px solid \${accentColor}55\`,
          boxShadow: \`0 24px 60px rgba(0, 0, 0, 0.65), 0 0 32px \${accentColor}22\`,
          backdropFilter: "blur(16px)",
          transform: \`translateY(\${(1 - vis) * 28}px) scale(\${0.94 + vis * 0.06})\`,
          opacity: vis,
          fontFamily: '"Inter", system-ui, sans-serif',
        }}
      >
        {/* Cabecera */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 800, color: "#F8FAFC" }}>{title}</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: accentColor,
              padding: "3px 9px",
              borderRadius: 999,
              background: \`\${accentColor}22\`,
              border: \`1px solid \${accentColor}55\`,
            }}
          >
            {badge}
          </span>
        </div>

        {/* Zona comparativa dual */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", position: "relative" }}>
          <div style={{ padding: "18px 20px", background: "rgba(15, 23, 42, 0.6)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(226,232,240,0.65)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {leftLabel}
            </div>
            <div style={{ fontSize: 28, fontWeight: 900, color: "#CBD5E1", marginTop: 4 }}>
              {leftValue}
            </div>
          </div>

          <div
            style={{
              padding: "18px 20px",
              background: \`linear-gradient(135deg, \${accentColor}24, \${secondaryColor}24)\`,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: accentColor, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {rightLabel}
            </div>
            <div style={{ fontSize: 28, fontWeight: 900, color: "#FFFFFF", marginTop: 4 }}>
              {rightValue}
            </div>
          </div>

          {/* Línea divisora luminosa animada */}
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: \`\${sweep.toFixed(1)}%\`,
              width: 2,
              background: \`linear-gradient(180deg, \${accentColor}, #FFFFFF, \${secondaryColor})\`,
              boxShadow: \`0 0 14px \${accentColor}\`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}


export interface HyperFrameKineticStatementOptions {
  kicker: string;
  headline: string;
  subheadline: string;
  palette: HyperFramePalette;
  audioPeaks?: number[];
}

/**
 * Tipografía Cinética Full-Frame de Alto Impacto (estilo documental moderno / keynote).
 * Ideal para frases tesis o clímax donde el gráfico toma el protagonismo con stagger palabra por palabra.
 */
export function buildHyperFrameKineticStatementFull(
  options: HyperFrameKineticStatementOptions,
): HyperFrameCompiledSpec {
  const componentName = "HyperFrameKineticStatementFull";
  const audioPeaks = Array.isArray(options.audioPeaks) ? options.audioPeaks.slice(0, 600) : [];
  const props: Record<string, unknown> = {
    kicker: options.kicker,
    headline: options.headline,
    subheadline: options.subheadline,
    zone: "center-stage",
    accentColor: options.palette.accent,
    secondaryColor: options.palette.secondary,
    audioPeaks,
  };

  const code = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName}: React.FC<Record<string, any>> = ({
  kicker = ${JSON.stringify(options.kicker)},
  headline = ${JSON.stringify(options.headline)},
  subheadline = ${JSON.stringify(options.subheadline)},
  accentColor = ${JSON.stringify(options.palette.accent)},
  secondaryColor = ${JSON.stringify(options.palette.secondary)},
  audioPeaks = ${JSON.stringify(audioPeaks)},
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const exitStart = Math.max(24, durationInFrames - 14);
  const vis = durationInFrames > 28
    ? Math.min(
        spring({ frame, fps, config: { damping: 18, stiffness: 130 } }),
        interpolate(frame, [exitStart, durationInFrames - 1], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
      )
    : 1;

  const bucket =
    Array.isArray(audioPeaks) && audioPeaks.length > 0
      ? Number(
          audioPeaks[
            Math.min(audioPeaks.length - 1, Math.max(0, Math.floor((frame / Math.max(1, fps)) * 4)))
          ] ?? 0.35,
        )
      : 0.35;

  const words = String(headline).split(/\\s+/).filter(Boolean).slice(0, 10);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: "10%",
        background: \`radial-gradient(circle at center, rgba(6,10,19,0.88) 0%, rgba(4,6,14,0.68) 70%, transparent 100%)\`,
        backdropFilter: \`blur(\${Math.round(8 * vis)}px)\`,
        opacity: vis,
        pointerEvents: "none",
        fontFamily: '"Inter", system-ui, sans-serif',
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          maxWidth: "88%",
          transform: \`scale(\${0.94 + vis * 0.06 + bucket * 0.025})\`,
        }}
      >
        <div
          style={{
            padding: "5px 14px",
            borderRadius: 999,
            border: \`1px solid \${accentColor}66\`,
            background: \`\${accentColor}1E\`,
            color: accentColor,
            fontSize: 12,
            fontWeight: 900,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            marginBottom: 18,
          }}
        >
          {kicker}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "8px 14px",
            marginBottom: 18,
          }}
        >
          {words.map((word, idx) => {
            const wSpring = spring({
              frame: Math.max(0, frame - idx * 3),
              fps,
              config: { damping: 14, stiffness: 165, mass: 0.7 },
            });
            const isHighlight = idx === words.length - 1 || idx === 0;
            return (
              <span
                key={idx}
                style={{
                  fontSize: "clamp(32px, 5.2vw, 68px)",
                  fontWeight: 900,
                  lineHeight: 1.05,
                  letterSpacing: "-0.025em",
                  color: isHighlight ? accentColor : "#FFFFFF",
                  textShadow: isHighlight ? \`0 0 28px \${accentColor}55\` : "0 8px 24px rgba(0,0,0,0.6)",
                  transform: \`translateY(\${(1 - wSpring) * 26}px)\`,
                  opacity: wSpring,
                }}
              >
                {word}
              </span>
            );
          })}
        </div>

        <div
          style={{
            width: \`\${Math.round(140 * vis)}px\`,
            height: 3,
            borderRadius: 999,
            background: \`linear-gradient(90deg, \${accentColor}, \${secondaryColor})\`,
            boxShadow: \`0 0 18px \${accentColor}88\`,
            marginBottom: 14,
          }}
        />

        {subheadline ? (
          <div
            style={{
              fontSize: "clamp(15px, 2vw, 22px)",
              fontWeight: 500,
              color: "rgba(241, 245, 249, 0.84)",
              maxWidth: "74%",
              lineHeight: 1.35,
            }}
          >
            {subheadline}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
export default ${componentName};`;

  return {
    componentName,
    code,
    props,
  };
}
