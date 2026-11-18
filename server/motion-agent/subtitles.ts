import { transcribeMedia, type TranscriptSegment } from "../ai/provider.js";
import type { MediaAsset, MediaClip, Project } from "../../src/shared/schema.js";
import { buildSubtitleComponentCode } from "../../src/shared/motionTemplates.js";
import { HttpError } from "../util/fs.js";
import type { ProjectSemanticDNA } from "../agent/semanticDNA.js";

/**
 * Subtítulos generados a partir del audio real del video.
 *
 * El texto y los tiempos salen SIEMPRE de Whisper (local o proveedor): nunca de
 * la imaginación del LLM. Lo que sí es abierto es el diseño: hay un catálogo de
 * estilos (TikTok, cinemático, minimal, neón, impacto, karaoke) y, si el usuario
 * pide algo fuera del catálogo, el agente escribe el componente Remotion con el
 * contrato de `props.captions`. No hay una única plantilla cerrada.
 */

export interface CaptionWord {
  text: string;
  /** Frame relativo al inicio del overlay. */
  start: number;
  end: number;
  highlight?: boolean;
}

export interface CaptionCue {
  start: number;
  end: number;
  words: CaptionWord[];
  zone?: "lower-third" | "hero-top" | "center" | "keyword-float";
  suppressed?: boolean;
  cueType?: "standard" | "keyword_callout" | "narrative_minimal" | "retention_punch";
  positionY?: number;
  accentColor?: string;
  keywordText?: string;
}

export interface CaptionSource {
  clip: MediaClip;
  /** Todos los segmentos del mismo asset en la pista (p.ej. tras corte de silencios) ordenados por startFrame */
  clips?: MediaClip[];
  asset: MediaAsset;
  /** Frame del timeline donde empieza el primer segmento. */
  startFrame: number;
  /** Duración total en el timeline desde el inicio del primer segmento hasta el final del último. */
  durationFrames: number;
  fps: number;
}

// ---------------------------------------------------------------------------
// Catálogo de estilos
// ---------------------------------------------------------------------------

export type SubtitleStyleId =
  | "tiktok"
  | "hormozi"
  | "cinematic"
  | "minimal"
  | "neon"
  | "impact"
  | "karaoke"
  | "custom";

export interface SubtitleStyleInfo {
  id: SubtitleStyleId;
  label: string;
  description: string;
}

export const SUBTITLE_STYLES: SubtitleStyleInfo[] = [
  {
    id: "tiktok",
    label: "TikTok / viral",
    description:
      "Palabras grandes en mayúsculas sobre píldoras de color que rebotan y cambian de color en cada palabra.",
  },
  {
    id: "hormozi",
    label: "Hormozi / Viral MrBeast",
    description: "Palabras con spring pop, resaltado amarillo neón y emojis animados automáticos (💰, 🚀, 🔥).",
  },
  {
    id: "cinematic",
    label: "Cinemático",
    description:
      "Tipografía serif elegante, interletrado amplio, barra fina de acento, fundidos suaves. Profesional y sobrio.",
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Sans-serif limpia y ligera, sombra sutil, la palabra activa se enciende. Muy discreto.",
  },
  {
    id: "neon",
    label: "Neón",
    description: "Resplandores cian y magenta sobre fondo oscuro, glow intenso, alto contraste.",
  },
  {
    id: "impact",
    label: "Impacto",
    description: "Bloques tipo noticiario: caja negra rotunda, texto blanco, palabra activa en amarillo.",
  },
  {
    id: "karaoke",
    label: "Karaoke",
    description: "Barra de progreso bajo la palabra activa que se rellena con el tiempo.",
  },
  {
    id: "custom",
    label: "Libre (el agente lo escribe)",
    description:
      "El código Remotion se escribe desde cero siguiendo el brief del usuario. Úsalo solo si ninguna otra opción encaja.",
  },
];

const STYLE_IDS = new Set<string>(SUBTITLE_STYLES.map((style) => style.id));

export function styleCatalogForPrompt(): string {
  return SUBTITLE_STYLES.map((style) => `- "${style.id}": ${style.description}`).join("\n");
}

/** Normaliza el estilo que devuelve el planner (o lo adivina por palabras clave). */
export function resolveSubtitleStyle(value: unknown, brief = ""): SubtitleStyleId {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (STYLE_IDS.has(raw)) return raw as SubtitleStyleId;

  const text = `${raw} ${brief.toLowerCase()}`;
  if (/hormozi|mrbeast|viral|emoji|emojis/.test(text)) return "hormozi";
  if (/minimal|editorial|limpio|discret|sutil|simple|sans/.test(text)) return "minimal";
  if (/cinemat|elegant|profesional|serif|premium/.test(text)) return "cinematic";
  if (/ne[oó]n|glow|respland|cyber|synthwave/.test(text)) return "neon";
  if (/karaoke|barra de progreso|progreso bajo/.test(text)) return "karaoke";
  if (/impact|noticiario|bloque|bold|roadblock/.test(text)) return "impact";
  if (/tiktok|viral|reels|shorts|modern/.test(text)) return "tiktok";
  // Por defecto: Estilo Visual Editorial Minimalista (Sans-serif geométrica + karaoke limpio).
  return "minimal";
}

const CAPTIONS_PREAMBLE = `import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";

type CaptionWord = { text: string; start: number; end: number; highlight?: boolean };
type CaptionCue = {
  start: number;
  end: number;
  words: CaptionWord[];
  zone?: "lower-third" | "hero-top" | "center" | "keyword-float";
  suppressed?: boolean;
  cueType?: "standard" | "keyword_callout" | "narrative_minimal" | "retention_punch";
  positionY?: number;
  accentColor?: string;
  keywordText?: string;
};
`;

/** Cabecera común a todas las plantillas: resuelve el cue activo, supresión inteligente y zonas seguras anti-colisión. */
function cueFinder(component: string): string {
  return `  const frame = useCurrentFrame() + (props.offset ?? 0);
  const { fps, width, height } = useVideoConfig();
  const captions = props.captions ?? [];
  const index = captions.findIndex((cue) => frame >= cue.start && frame < cue.end);
  if (index === -1) return null;
  const cue = captions[index];
  if (cue.suppressed) return null;
  const local = Math.max(0, frame - cue.start);
  const duration = Math.max(1, cue.end - cue.start);
  const rawScale = typeof (props as any).fontScale === "number" && (props as any).fontScale > 0 ? (props as any).fontScale : 1;
  const scaleMult = rawScale > 5 ? rawScale / 100 : rawScale;
  const unit = Math.min(width, height) * scaleMult;
  const isVertical = height > width;
  const cueZone = cue.zone || "lower-third";
  const isTop = cueZone === "hero-top" || cueZone === "top-right-hud" || cueZone === "top-left-hud";
  const isCenter = cueZone === "center" || cueZone === "keyword-float";
  const defaultPosY = isTop ? (isVertical ? 0.16 : 0.14) : isCenter ? 0.5 : (isVertical ? 0.74 : 0.86);
  const rawPosY = typeof (cue as any).positionY === "number" ? (cue as any).positionY : (typeof (props as any).positionY === "number" ? (props as any).positionY : defaultPosY);
  const posY = rawPosY > 1.5 ? rawPosY / 100 : rawPosY;
  const topPad = isTop ? (isVertical ? 160 : 88) : 0;
  const bottomPad = isTop || isCenter ? 0 : Math.max(height * 0.04, Math.min(height * 0.85, height * (1 - posY)));
  const maxSafeWidth = isVertical ? width * 0.82 : width * 0.88;
  const safeMarginRight = isVertical ? width * 0.04 : 0;
  const verticalJustify = isTop ? "flex-start" : isCenter ? "center" : "flex-end";
`;
}

// ---------------------------------------------------------------------------
// Plantillas de estilo
// ---------------------------------------------------------------------------

const TIKTOK_TEMPLATE = `${CAPTIONS_PREAMBLE}
const PALETTE = ["#C9FF4D", "#FF4D9D", "#4DE8FF", "#FFD166", "#B98CFF", "#FF7A45"];

export const __NAME__ = (props: { captions?: CaptionCue[]; offset?: number }) => {
${cueFinder("")}  const fontSize = unit * 0.085;
  const enter = spring({ frame: local, fps, config: { damping: 14, stiffness: 190, mass: 0.7 } });
  const outro = interpolate(frame, [cue.end - 5, cue.end], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: verticalJustify,
        alignItems: "center",
        paddingTop: topPad,
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
          gap: unit * 0.012,
          maxWidth: maxSafeWidth,
          width: maxSafeWidth,
          opacity: Math.min(1, enter) * outro,
          transform: "scale(" + (0.92 + 0.08 * enter) + ")",
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const pop = active
            ? spring({ frame: frame - word.start, fps, config: { damping: 10, stiffness: 260, mass: 0.45 } })
            : 0;
          const color = PALETTE[(index + i) % PALETTE.length];
          return (
            <span
              key={i}
              style={{
                fontFamily: '"Arial Black", "Segoe UI Black", Impact, sans-serif',
                fontSize,
                lineHeight: 1.05,
                letterSpacing: -fontSize * 0.02,
                textTransform: "uppercase",
                color: active ? "#101014" : "#FFFFFF",
                backgroundColor: active ? color : "transparent",
                borderRadius: fontSize * 0.22,
                padding: (active ? fontSize * 0.05 : fontSize * 0.05) + "px " + (active ? fontSize * 0.18 : fontSize * 0.02) + "px",
                textShadow: active
                  ? "none"
                  : "0 0.04em 0 rgba(0,0,0,0.65), 0 0 0.35em rgba(0,0,0,0.55)",
                boxShadow: active ? "0 " + fontSize * 0.07 + "px 0 rgba(0,0,0,0.35)" : "none",
                transform:
                  "translateY(" +
                  (active ? -fontSize * 0.08 * pop : 0) +
                  "px) scale(" +
                  (active ? 1 + 0.16 * pop : 1) +
                  ") rotate(" +
                  (active ? -2.5 + (i % 3) * 2.5 : 0) +
                  "deg)",
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
`;

const CINEMATIC_TEMPLATE = `${CAPTIONS_PREAMBLE}
const ACCENT = "#E8C07A";

export const __NAME__ = (props: { captions?: CaptionCue[]; offset?: number }) => {
${cueFinder("")}  const fontSize = unit * 0.062;
  // Entrada y salida cinematográficas: fundido largo y desplazamiento corto.
  const inProgress = interpolate(local, [0, 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const outProgress = interpolate(local, [duration - 12, duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const enter = Math.min(inProgress, outProgress);
  const ruleWidth = width * 0.22 * inProgress;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: verticalJustify,
        alignItems: "center",
        paddingTop: topPad,
        paddingBottom: bottomPad,
        paddingRight: safeMarginRight,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: unit * 0.03,
          opacity: enter,
          transform: "translateY(" + (1 - inProgress) * unit * 0.03 + "px)",
        }}
      >
        <div
          style={{
            width: ruleWidth,
            height: Math.max(1, unit * 0.0035),
            backgroundColor: ACCENT,
            opacity: 0.9,
          }}
        />
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: maxSafeWidth,
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize,
            lineHeight: 1.25,
            letterSpacing: fontSize * 0.06,
            textTransform: "uppercase",
            color: "#F2EDE3",
            textShadow: "0 0.02em 0 rgba(0,0,0,0.55), 0 0 0.5em rgba(0,0,0,0.55)",
            textAlign: "center",
          }}
        >
          {cue.words.map((word, i) => {
            const active = frame >= word.start && frame < word.end;
            const glow = active
              ? interpolate(frame - word.start, [0, 8], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })
              : 0;
            return (
              <span
                key={i}
                style={{
                  margin: "0 " + fontSize * 0.08 + "px",
                  color: active ? "#FFFFFF" : "rgba(242,237,227,0.82)",
                  textShadow: active
                    ? "0 0 " + 0.5 * glow + "em " + ACCENT + ", 0 0.02em 0 rgba(0,0,0,0.6)"
                    : "0 0.02em 0 rgba(0,0,0,0.55), 0 0 0.5em rgba(0,0,0,0.5)",
                  transform: "scale(" + (1 + 0.03 * glow) + ")",
                  display: "inline-block",
                }}
              >
                {word.text}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
`;

const MINIMAL_TEMPLATE = `${CAPTIONS_PREAMBLE}
const AMBER_ACCENT = "#F59E0B";

export const __NAME__ = (props: { captions?: CaptionCue[]; offset?: number }) => {
${cueFinder("")}  const fontSize = unit * 0.056;
  const inProgress = interpolate(local, [0, 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const outProgress = interpolate(local, [Math.max(0, duration - 4), duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const enter = Math.min(inProgress, outProgress);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: verticalJustify,
        alignItems: "center",
        paddingTop: topPad,
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
          backgroundColor: "rgba(12, 14, 17, 0.56)",
          backdropFilter: "blur(8px)",
          borderRadius: fontSize * 0.36,
          padding: (fontSize * 0.24) + "px " + (fontSize * 0.48) + "px",
          boxShadow: "0 8px 28px rgba(0,0,0,0.42), 0 1px 0 rgba(255,255,255,0.08) inset",
          fontFamily: '"Inter", "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize,
          fontWeight: 700,
          lineHeight: 1.24,
          letterSpacing: -fontSize * 0.015,
          textAlign: "center",
          opacity: enter,
          transform: "translateY(" + (1 - inProgress) * unit * 0.014 + "px)",
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const cleanToken = word.text.replace(/[.,!?;:¡¿"']/g, "");
          const isKeyword = cleanToken.length >= 6 || /\\d/.test(cleanToken);
          const activeColor = isKeyword ? AMBER_ACCENT : "#FFFFFF";
          return (
            <span
              key={i}
              style={{
                margin: "0 " + fontSize * 0.09 + "px",
                color: active
                  ? activeColor
                  : frame >= word.end
                    ? "rgba(255,255,255,0.88)"
                    : "rgba(255,255,255,0.46)",
                textShadow: active
                  ? "0 2px 14px rgba(0,0,0,0.75)"
                  : "0 2px 6px rgba(0,0,0,0.55)",
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
`;

const NEON_TEMPLATE = `${CAPTIONS_PREAMBLE}
const CYAN = "#4DE8FF";
const MAGENTA = "#FF4D9D";

export const __NAME__ = (props: { captions?: CaptionCue[]; offset?: number }) => {
${cueFinder("")}  const fontSize = unit * 0.078;
  const enter = interpolate(local, [0, 11], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const outro = interpolate(local, [duration - 10, duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const flicker = 0.85 + 0.15 * Math.sin(local * 0.9);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: verticalJustify,
        alignItems: "center",
        paddingTop: topPad,
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
          width: width * 0.88,
          opacity: enter * outro * flicker,
          transform: "scale(" + (0.94 + 0.06 * enter) + ")",
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const glow = active
            ? interpolate(frame - word.start, [0, 7], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            : 0;
          const hue = (index + i) % 2 === 0 ? CYAN : MAGENTA;
          return (
            <span
              key={i}
              style={{
                fontFamily: '"Arial Black", "Segoe UI Black", Impact, sans-serif',
                fontSize,
                lineHeight: 1.05,
                letterSpacing: fontSize * 0.03,
                textTransform: "uppercase",
                color: "#F2FEFF",
                margin: "0 " + fontSize * 0.05 + "px",
                textShadow: active
                  ? "0 0 " + 0.35 * glow + "em " + hue + ", 0 0 " + 0.9 * glow + "em " + hue +
                    ", 0 0 " + 1.8 * glow + "em " + hue
                  : "0 0 0.35em " + CYAN + ", 0 0.03em 0 rgba(0,0,0,0.6)",
                WebkitTextStroke: active ? 0.012 * glow + "em " + hue : undefined,
                transform: "scale(" + (1 + 0.05 * glow) + ")",
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
`;

const IMPACT_TEMPLATE = `${CAPTIONS_PREAMBLE}
export const __NAME__ = (props: { captions?: CaptionCue[]; offset?: number }) => {
${cueFinder("")}  const fontSize = unit * 0.072;
  const enter = spring({ frame: local, fps, config: { damping: 16, stiffness: 210, mass: 0.7 } });
  const outro = interpolate(local, [duration - 7, duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const blockEnter = spring({
    frame: local,
    fps,
    config: { damping: 18, stiffness: 160, mass: 0.8 },
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: verticalJustify,
        alignItems: "center",
        paddingTop: topPad,
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
          gap: unit * 0.01,
          width: width * 0.9,
          opacity: Math.min(1, enter) * outro,
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          return (
            <span
              key={i}
              style={{
                fontFamily: '"Arial Black", "Segoe UI Black", Impact, sans-serif',
                fontSize,
                lineHeight: 1.02,
                letterSpacing: -fontSize * 0.015,
                textTransform: "uppercase",
                color: active ? "#111111" : "#FFFFFF",
                backgroundColor: active ? "#FFD44A" : "rgba(0,0,0,0.78)",
                borderRadius: fontSize * 0.1,
                padding: fontSize * 0.07 + "px " + fontSize * 0.16 + "px",
                transform: "scale(" + (0.9 + 0.1 * (active ? Math.min(1, blockEnter) : 1)) + ")",
                boxShadow: "0 " + fontSize * 0.05 + "px 0 rgba(0,0,0,0.45)",
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
`;

const KARAOKE_TEMPLATE = `${CAPTIONS_PREAMBLE}
const PALETTE = ["#FF4D6D", "#4DE8FF", "#FFD166", "#7CFF6B", "#B98CFF", "#FF7A45"];

export const __NAME__ = (props: { captions?: CaptionCue[]; offset?: number }) => {
${cueFinder("")}  const fontSize = unit * 0.075;
  const enter = interpolate(local, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const outro = interpolate(local, [duration - 8, duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: verticalJustify,
        alignItems: "center",
        paddingTop: topPad,
        paddingBottom: bottomPad,
        paddingRight: safeMarginRight,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "flex-end",
          gap: unit * 0.02,
          width: width * 0.88,
          opacity: enter * outro,
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const wordDuration = Math.max(1, word.end - word.start);
          const progress = active
            ? Math.max(0, Math.min(1, (frame - word.start) / wordDuration))
            : frame >= word.end
              ? 1
              : 0;
          const color = PALETTE[(index + i) % PALETTE.length];
          return (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: unit * 0.008,
              }}
            >
              <span
                style={{
                  fontFamily: '"Arial Black", "Segoe UI Black", Impact, sans-serif',
                  fontSize,
                  lineHeight: 1.05,
                  letterSpacing: -fontSize * 0.02,
                  textTransform: "uppercase",
                  color: "#FFFFFF",
                  textShadow: "0 0.04em 0 rgba(0,0,0,0.75), 0 0 0.4em rgba(0,0,0,0.6)",
                  WebkitTextStroke: "0.014em rgba(0,0,0,0.55)",
                  display: "inline-block",
                  whiteSpace: "nowrap",
                }}
              >
                {word.text}
              </span>
              <div
                style={{
                  width: fontSize * 0.9,
                  height: Math.max(2, fontSize * 0.075),
                  borderRadius: 999,
                  backgroundColor: "rgba(255,255,255,0.22)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: (progress * 100).toFixed(1) + "%",
                    height: "100%",
                    backgroundColor: color,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
`;

const HORMOZI_TEMPLATE = `${CAPTIONS_PREAMBLE}
const EMOJI_MAP: Record<string, string> = {
  dinero: "💰", plata: "💰", cash: "💵", dolar: "💵", dolares: "💵", precio: "🏷️", costo: "🏷️", ventas: "📈", ingresos: "📈", ganancia: "🤑", billon: "💎", millon: "💎",
  crecimiento: "🚀", escala: "🚀", escalar: "🚀", crecer: "📈", subir: "📈", arriba: "🔝", exito: "🏆", ganador: "🥇", ganar: "🏆", meta: "🎯", objetivo: "🎯", record: "⚡",
  viral: "🔥", fuego: "🔥", brutal: "💥", impacto: "⚡", increible: "🤯", loco: "🤯", boom: "💥", secreto: "🤫", clave: "🔑", hack: "💡", truco: "🪄", magia: "✨",
  tiempo: "⏱️", hora: "⏳", rapido: "⚡", ya: "🚨", ahora: "⚡", urgente: "🚨", atencion: "⚠️", cuidado: "⚠️", error: "❌", peligro: "🛑", stop: "🛑",
  negocio: "💼", empresa: "🏢", trabajo: "💼", cliente: "🤝", clientes: "👥", equipo: "🤝", robot: "🤖", bot: "🤖", ai: "🧠", ia: "🧠", cerebro: "🧠", idea: "💡",
  amor: "❤️", corazon: "❤️", top: "⭐", mejor: "⭐", perfecto: "✨", pro: "👑", rey: "👑"
};

export const __NAME__ = (props: { captions?: CaptionCue[]; offset?: number }) => {
${cueFinder("")}  const fontSize = unit * 0.082;
  const enter = spring({ frame: local, fps, config: { damping: 12, stiffness: 220, mass: 0.6 } });
  const outro = interpolate(frame, [Math.max(cue.start, cue.end - 5), cue.end], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  let cueEmoji = "";
  for (const w of cue.words) {
    const clean = (w.text || "").toLowerCase().replace(/[^a-záéíóúñ]/g, "");
    if (EMOJI_MAP[clean]) {
      cueEmoji = EMOJI_MAP[clean];
      break;
    }
  }

  const emojiSpring = cueEmoji
    ? spring({ frame: local, fps, config: { damping: 9, stiffness: 280, mass: 0.4 } })
    : 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: verticalJustify,
        alignItems: "center",
        paddingTop: topPad,
        paddingBottom: bottomPad,
        paddingRight: safeMarginRight,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: fontSize * 0.14,
          opacity: Math.min(1, enter) * outro,
          transform: "scale(" + (0.92 + 0.08 * enter) + ")",
        }}
      >
        {cueEmoji && (
          <div
            style={{
              fontSize: fontSize * 1.35,
              lineHeight: 1,
              transform: "scale(" + emojiSpring + ") translateY(" + (-fontSize * 0.18 * emojiSpring) + "px)",
              filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.75))",
            }}
          >
            {cueEmoji}
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            gap: fontSize * 0.12,
            maxWidth: maxSafeWidth,
          }}
        >
          {cue.words.map((word, i) => {
            const active = frame >= word.start && frame < word.end;
            const pop = active
              ? spring({ frame: Math.max(0, frame - word.start), fps, config: { damping: 10, stiffness: 320, mass: 0.35 } })
              : 0;
            const cleanWord = (word.text || "").toLowerCase().replace(/[^a-záéíóúñ]/g, "");
            const hasOwnEmoji = Boolean(EMOJI_MAP[cleanWord]);
            const isSpecial = hasOwnEmoji || word.text.length >= 7 || /\\d/.test(word.text);
            const activeColor = "#FFE600";

            return (
              <span
                key={i}
                style={{
                  fontFamily: '"Montserrat", "Arial Black", Impact, system-ui, sans-serif',
                  fontWeight: 900,
                  fontSize,
                  lineHeight: 1.08,
                  letterSpacing: -fontSize * 0.02,
                  textTransform: "uppercase",
                  color: active ? activeColor : isSpecial ? "#22C55E" : "#FFFFFF",
                  padding: (fontSize * 0.04) + "px " + (fontSize * 0.1) + "px",
                  borderRadius: fontSize * 0.18,
                  backgroundColor: active ? "rgba(0,0,0,0.55)" : "transparent",
                  textShadow: active
                    ? "0 0 20px " + activeColor + ", 0 4px 12px rgba(0,0,0,0.95), 0 0 35px rgba(255,230,0,0.4)"
                    : "0 3px 10px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.8)",
                  transform: "translateY(" + (active ? -fontSize * 0.08 * pop : 0) + "px) scale(" + (active ? 1 + 0.15 * pop : 1) + ")",
                  display: "inline-block",
                  whiteSpace: "nowrap",
                }}
              >
                {word.text}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
`;

const TEMPLATES: Record<Exclude<SubtitleStyleId, "custom">, (name: string) => string> = {
  tiktok: (name) => TIKTOK_TEMPLATE.replace("__NAME__", name),
  hormozi: (name) => HORMOZI_TEMPLATE.replace("__NAME__", name),
  cinematic: (name) => CINEMATIC_TEMPLATE.replace("__NAME__", name),
  minimal: (name) => MINIMAL_TEMPLATE.replace("__NAME__", name),
  neon: (name) => NEON_TEMPLATE.replace("__NAME__", name),
  impact: (name) => IMPACT_TEMPLATE.replace("__NAME__", name),
  karaoke: (name) => KARAOKE_TEMPLATE.replace("__NAME__", name),
};

function componentNameForStyle(style: Exclude<SubtitleStyleId, "custom">): string {
  switch (style) {
    case "cinematic":
      return "CinematicSubtitles";
    case "hormozi":
      return "HormoziSubtitles";
    case "minimal":
      return "MinimalSubtitles";
    case "neon":
      return "NeonSubtitles";
    case "impact":
      return "ImpactSubtitles";
    case "karaoke":
      return "KaraokeSubtitles";
    default:
      return "TikTokSubtitles";
  }
}

/** Código del componente para un estilo del catálogo (sincronizado a 0ms de entrada con motionTemplates). */
export function subtitleComponentCode(
  style: Exclude<SubtitleStyleId, "custom">,
  name = componentNameForStyle(style),
): string {
  return buildSubtitleComponentCode(style, name).code || TEMPLATES[style](name);
}

// ---------------------------------------------------------------------------
// Construcción del overlay
// ---------------------------------------------------------------------------

export interface SubtitleBuild {
  code: string;
  name: string;
  compositionId: string;
  durationInFrames: number;
  startFrame: number;
  props: Record<string, unknown>;
  cueCount: number;
  wordCount: number;
  style: SubtitleStyleId;
  model: string;
  /** Clave del clip de audio usado (para reutilizar la transcripción). */
  sourceKey: string;
  /** Segmentos crudos de Whisper (se cachean junto al overlay). */
  segments: TranscriptSegment[];
  /** Informe de gobernanza y decisiones espaciales autónomas. */
  governance?: SubtitleGovernanceReport;
}

function projectFps(project: Project): number {
  const num = Number(project.settings.fps.num ?? 30);
  const den = Number(project.settings.fps.den ?? 1);
  const fps = den > 0 ? num / den : 30;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function assetForClip(project: Project, clip: MediaClip): MediaAsset | undefined {
  return project.media.find((asset) => asset.id === clip.mediaId);
}

/**
 * Elige el clip de video (o audio) que aporta la voz: el que está bajo el cabezal de
 * reproducción y, si no hay ninguno, el clip con audio más largo.
 * Si la pista contiene múltiples fragmentos del mismo MediaAsset (p.ej. tras eliminar
 * silencios), agrupa todos los fragmentos ordenados para cubrir el timeline completo.
 */
export function findCaptionSource(project: Project, currentFrame: number): CaptionSource | null {
  const fps = projectFps(project);
  const videoCandidates = project.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is MediaClip => clip.type === "video")
        .map((clip) => ({ clip, asset: assetForClip(project, clip), trackId: track.id })),
    )
    .filter(
      (item): item is { clip: MediaClip; asset: MediaAsset; trackId: string } =>
        Boolean(item.asset && item.asset.kind === "video" && item.asset.audioCodec),
    );

  const audioCandidates = project.tracks
    .filter((track) => track.kind === "audio" && track.name !== "SFX")
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is MediaClip => clip.type === "audio")
        .map((clip) => ({ clip, asset: assetForClip(project, clip), trackId: track.id })),
    )
    .filter(
      (item): item is { clip: MediaClip; asset: MediaAsset; trackId: string } =>
        Boolean(item.asset && item.asset.kind === "audio"),
    );

  const candidates = videoCandidates.length > 0 ? videoCandidates : audioCandidates;
  if (candidates.length === 0) return null;

  const underPlayhead = candidates.find(
    (item) =>
      currentFrame >= item.clip.startFrame &&
      currentFrame < item.clip.startFrame + item.clip.durationFrames,
  );
  // Priorizar el clip más temprano de la línea de tiempo en vez de uno arbitrario en el medio
  const chosen =
    underPlayhead ?? [...candidates].sort((a, b) => a.clip.startFrame - b.clip.startFrame)[0]!;

  // Agrupar todos los fragmentos que provienen del mismo asset y la MISMA pista (p.ej. cortes por silencios de V1)
  const siblingClips = candidates
    .filter((item) => item.asset.id === chosen.asset.id && item.trackId === chosen.trackId)
    .map((item) => item.clip)
    .sort((a, b) => a.startFrame - b.startFrame);

  const firstClip = siblingClips[0] ?? chosen.clip;
  const lastClip = siblingClips[siblingClips.length - 1] ?? chosen.clip;
  const totalStartFrame = firstClip.startFrame;
  const totalEndFrame = Math.max(
    totalStartFrame + 1,
    ...siblingClips.map((c) => c.startFrame + c.durationFrames),
  );

  return {
    clip: firstClip,
    clips: siblingClips.length > 0 ? siblingClips : [chosen.clip],
    asset: chosen.asset,
    startFrame: totalStartFrame,
    durationFrames: totalEndFrame - totalStartFrame,
    fps,
  };
}

/**
 * Sanea y corrige alucinaciones fonéticas comunes de Whisper/ASR:
 * - "se vota" -> "se bota" / "se desecha"
 * - "toda la comida" -> "toda la comunidad"
 * - "ahorro perativo" / "perativo" -> "ahorro operativo" / "operativo"
 */
export function sanitizeTranscriptionText(text: string): string {
  if (!text) return "";
  let s = text;
  s = s.replace(/\bse\s+vota\b/gi, "se bota");
  s = s.replace(/\bse\s+votó\b/gi, "se botó");
  s = s.replace(/\bse\s+votan\b/gi, "se botan");
  s = s.replace(/\btoda\s+la\s+comida\b/gi, "toda la comunidad");
  s = s.replace(/\bahorro\s+perativo\b/gi, "ahorro operativo");
  s = s.replace(/\bperativo\b/gi, "operativo");
  s = s.replace(/\bperativos\b/gi, "operativos");
  s = s.replace(/\bperativa\b/gi, "operativa");
  s = s.replace(/\bperativas\b/gi, "operativas");
  return s;
}

/** Peso fonético silábico para respaldos cuando el proveedor no envía timestamps por palabra. */
function syllableWeight(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-záéíóúüñ0-9]/gi, "");
  if (!clean) return 1;
  const vowelGroups = clean.match(/[aeiouáéíóúü]+/gi);
  const syllables = vowelGroups ? vowelGroups.length : Math.max(1, Math.ceil(clean.length / 3));
  const punctBonus = /[,.;:!?…]$/.test(word) ? 0.35 : 0;
  return Math.max(0.8, syllables + clean.length * 0.1 + punctBonus);
}

/** Parte una frase en palabras con tiempos proporcionales a su peso silábico/fonético. */
function timeWords(
  text: string,
  startSeconds: number,
  endSeconds: number,
): Array<{ text: string; start: number; end: number }> {
  const sanitized = sanitizeTranscriptionText(text);
  const words = sanitized
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return [];

  const weights = words.map(syllableWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(0.08, endSeconds - startSeconds);

  let cursor = startSeconds;
  return words.map((word, index) => {
    const duration = (weights[index]! / totalWeight) * span;
    const start = cursor;
    const end = index === words.length - 1 ? startSeconds + span : start + duration;
    cursor = end;
    return { text: word, start, end };
  });
}

/**
 * Agrupa palabras en cues cortos de máximo 3 a 4 palabras por línea (Estilo
 * Editorial Minimalista de alta retención). El corte respeta la puntuación y
 * las pausas naturales del habla (>= 180ms) para que el subtítulo aparezca y
 * desaparezca simultáneamente con la voz.
 */
function groupWords(
  words: Array<{ text: string; start: number; end: number }>,
): Array<Array<{ text: string; start: number; end: number }>> {
  const maxWords = 4;
  const maxChars = 26;
  const maxSpan = 1.85;
  const naturalPauseGap = 0.18;
  const cues: Array<Array<{ text: string; start: number; end: number }>> = [];
  let current: Array<{ text: string; start: number; end: number }> = [];

  const flush = () => {
    if (current.length > 0) {
      cues.push(current);
      current = [];
    }
  };

  for (const word of words) {
    const chars = current.reduce((sum, item) => sum + item.text.length + 1, 0);
    const span = current.length > 0 ? word.end - current[0]!.start : 0;
    const prevWord = current[current.length - 1];
    const pauseGap = prevWord ? word.start - prevWord.end : 0;
    const wouldOverflow =
      current.length >= maxWords ||
      chars + word.text.length > maxChars ||
      span > maxSpan ||
      pauseGap >= naturalPauseGap;

    if (current.length > 0 && wouldOverflow) flush();
    current.push(word);
    if (/[.!?…;:]$/.test(word.text)) {
      flush();
    } else if (/[,]$/.test(word.text) && current.length >= 2) {
      flush();
    }
  }
  flush();

  if (cues.length > 1) {
    const last = cues[cues.length - 1]!;
    const prev = cues[cues.length - 2]!;
    const gapBetween = last[0]!.start - prev[prev.length - 1]!.end;
    if (last.length === 1 && prev.length < 4 && gapBetween < 0.15 && last[0]!.end - last[0]!.start < 0.28) {
      prev.push(last[0]!);
      cues.pop();
    }
  }

  return cues;
}

/** Convierte la transcripción (tiempo del archivo fuente) a cues del overlay con bloqueo al milisegundo. */
export function buildCaptionCues(
  segments: TranscriptSegment[],
  source: CaptionSource,
): CaptionCue[] {
  const fps = source.fps;
  const activeClips =
    Array.isArray(source.clips) && source.clips.length > 0 ? source.clips : [source.clip];
  const totalSeconds = source.durationFrames / fps;

  // 1. Recolectar flujo continuo y cronológico de todas las palabras a través de todos los segmentos cortados
  const allTimedWords: Array<{ text: string; start: number; end: number }> = [];

  for (const clip of activeClips) {
    const speed = clip.speed > 0 ? clip.speed : 1;
    const clipSeconds = clip.durationFrames / fps;
    const clipOffsetSec = Math.max(0, (clip.startFrame - source.startFrame) / fps);
    const inSeconds = clip.sourceInUs / 1_000_000;
    const outSeconds = clip.sourceOutUs / 1_000_000;

    for (const segment of segments) {
      const start = segment.startUs / 1_000_000;
      const end = segment.endUs / 1_000_000;
      if (end <= inSeconds || start >= outSeconds) continue;

      let segWords: Array<{ text: string; start: number; end: number }> = [];
      if (Array.isArray(segment.words) && segment.words.length > 0) {
        for (const w of segment.words) {
          const wStart = w.startUs / 1_000_000;
          const wEnd = w.endUs / 1_000_000;
          if (wEnd <= inSeconds || wStart >= outSeconds) continue;
          const clampedStart = Math.max(wStart, inSeconds);
          const clampedEnd = Math.min(wEnd, outSeconds);
          const relWStart = (clampedStart - inSeconds) / speed;
          const relWEnd = Math.min(clipSeconds, (clampedEnd - inSeconds) / speed);
          if (relWStart >= clipSeconds || relWEnd <= relWStart) continue;
          const cleanText = sanitizeTranscriptionText(w.text.trim());
          if (!cleanText) continue;
          const timelineStart = clipOffsetSec + relWStart;
          const timelineEnd = Math.min(totalSeconds, clipOffsetSec + Math.max(relWStart + 0.04, relWEnd));
          if (cleanText.includes(" ")) {
            segWords.push(...timeWords(cleanText, timelineStart, timelineEnd));
          } else {
            segWords.push({
              text: cleanText,
              start: timelineStart,
              end: timelineEnd,
            });
          }
        }
      }

      // Respaldo fonético si el segmento no trajo desglose word-level
      if (segWords.length === 0) {
        const visibleStart = Math.max(start, inSeconds);
        const visibleEnd = Math.min(end, outSeconds);
        if (visibleEnd - visibleStart < 0.06) continue;

        let text = segment.text;
        if (start < inSeconds && end > inSeconds) {
          const fraction = (inSeconds - start) / Math.max(0.001, end - start);
          const words = text.split(/\s+/);
          const drop = Math.min(words.length - 1, Math.floor(words.length * fraction));
          text = words.slice(drop).join(" ");
        }
        if (end > outSeconds && start < outSeconds) {
          const fraction = (outSeconds - start) / Math.max(0.001, end - start);
          const words = text.split(/\s+/);
          const keep = Math.max(1, Math.ceil(words.length * fraction));
          text = words.slice(0, keep).join(" ");
        }

        const relStart = (visibleStart - inSeconds) / speed;
        const relEnd = (visibleEnd - inSeconds) / speed;
        if (relStart >= clipSeconds) continue;

        segWords = timeWords(
          text,
          clipOffsetSec + relStart,
          Math.min(totalSeconds, clipOffsetSec + Math.min(relEnd, clipSeconds)),
        );
      }

      allTimedWords.push(...segWords);
    }
  }

  if (allTimedWords.length === 0) return [];

  // 2. Ordenar cronológicamente y evitar solapamientos entre palabras consecutivas
  allTimedWords.sort((a, b) => a.start - b.start);
  for (let i = 0; i < allTimedWords.length - 1; i++) {
    const curr = allTimedWords[i]!;
    const next = allTimedWords[i + 1]!;
    if (curr.end > next.start) {
      curr.end = Math.max(curr.start + 0.03, next.start);
    }
  }

  // 3. Agrupar en cues respetando pausas reales del habla y convertir a fotogramas exactos
  const cues: CaptionCue[] = [];
  const maxBridgeFrames = Math.max(1, Math.ceil(fps * 0.14));

  for (const group of groupWords(allTimedWords)) {
    if (group.length === 0) continue;

    const frameWords: CaptionWord[] = group.map((word) => {
      const wStart = Math.max(0, Math.round(word.start * fps));
      const wEnd = Math.min(
        source.durationFrames,
        Math.max(wStart + 1, Math.round(word.end * fps)),
      );
      return {
        text: word.text,
        start: wStart,
        end: wEnd,
      };
    });

    // Asegurar continuidad monotónica palabra a palabra dentro del mismo cue:
    // - Sin solapamientos (nunca 2 palabras activas a la vez)
    // - Sin micro-huecos vacíos entre palabras seguidas de la misma frase
    for (let i = 0; i < frameWords.length - 1; i++) {
      const currW = frameWords[i]!;
      const nextW = frameWords[i + 1]!;
      if (nextW.start <= currW.start) {
        nextW.start = currW.start + 1;
      }
      if (nextW.end <= nextW.start) {
        nextW.end = nextW.start + 1;
      }
      const gap = nextW.start - currW.end;
      if (gap < 0 || (gap > 0 && gap <= maxBridgeFrames)) {
        currW.end = nextW.start;
      }
    }

    const startFrame = frameWords[0]!.start;
    const lastWordEnd = frameWords[frameWords.length - 1]!.end;
    const endFrame = Math.min(source.durationFrames, Math.max(startFrame + 1, lastWordEnd));
    if (endFrame <= startFrame) continue;

    cues.push({
      start: startFrame,
      end: endFrame,
      words: frameWords,
    });
  }

  // 4. Garantizar que ningún cue anterior invada el frame exacto de inicio del siguiente cue
  for (let index = 0; index < cues.length - 1; index += 1) {
    const current = cues[index]!;
    const next = cues[index + 1]!;
    if (current.end > next.start) {
      current.end = Math.max(current.start + 1, next.start);
      const lastWord = current.words[current.words.length - 1];
      if (lastWord && lastWord.end > current.end) {
        lastWord.end = Math.max(lastWord.start + 1, current.end);
      }
    }
  }

  return cues;
}

export interface VisualLayerInterval {
  startFrame: number;
  endFrame: number;
  type: string;
  zone: "hero-top" | "lower-third" | "center" | "fullscreen";
  isHeavyOrFullScreen: boolean;
  title?: string;
}

export interface SubtitleGovernanceOptions {
  project?: Project;
  narrativeBlocks?: Array<{
    startFrame: number;
    endFrame: number;
    label: string;
    cardKind?: string;
    headline?: string;
    subheadline?: string;
    customVisualMetaphor?: string;
    index?: number;
  }>;
  dna?: ProjectSemanticDNA;
  userPrompt?: string;
  fps: number;
  totalFrames?: number;
  isRealFootage?: boolean;
}

export interface SubtitleGovernanceReport {
  cues: CaptionCue[];
  stats: {
    totalOriginalCues: number;
    activeCues: number;
    suppressedCues: number;
    relocatedTopCues: number;
    keywordCalloutCues: number;
    narrativeMinimalCues: number;
  };
  explanation: string;
}

/**
 * Motor Autónomo de Tipografía Cinética y Gobernanza Espacial (Claude Fable 5.2):
 * Erradica el subtitulado plano e ininterrumpido. Decide cuándo mostrar subtítulos,
 * cuándo pausarlos para dejar brillar gráficos/escenas densas, cuándo sintetizar
 * 'Keyword Callouts' de alto impacto y cuándo reubicarlos dinámicamente fuera de zonas de colisión.
 */
export function applyAutonomousSubtitleGovernance(
  cues: CaptionCue[],
  options: SubtitleGovernanceOptions,
): SubtitleGovernanceReport {
  const prompt = (options.userPrompt || "").trim().toLowerCase();

  // 1. REGLA DE PRIORIDAD DE USUARIO (OVERRIDE TOTAL)
  const userWantsNoSubs =
    /\b(sin\s+subt[íi]tulos?|no\s+(?:pongas?|quiero)\s+subt[íi]tulos?|quitar?\s+subt[íi]tulos?|eliminar?\s+subt[íi]tulos?|desactivar?\s+subt[íi]tulos?|cero\s+subt[íi]tulos?)\b/i.test(
      prompt,
    );
  if (userWantsNoSubs) {
    return {
      cues: [],
      stats: {
        totalOriginalCues: cues.length,
        activeCues: 0,
        suppressedCues: cues.length,
        relocatedTopCues: 0,
        keywordCalloutCues: 0,
        narrativeMinimalCues: 0,
      },
      explanation: "Subtítulos omitidos por orden explícita del usuario ('sin subtítulos').",
    };
  }

  const userWantsFullSubtitles =
    /\b(subt[íi]tul(?:os?|a)\s+(?:todo|completo|en\s+todo\s+el\s+v[íi]deo|ininterrumpido)|todos\s+los\s+subt[íi]tulos|siempre\s+visibles?|subtitula\s+todo|subtitulado\s+completo)\b/i.test(
      prompt,
    );

  // 2. CONSTRUIR MAPA DE OCUPACIÓN ESPACIAL Y DENSIDAD VISUAL
  const visualIntervals: VisualLayerInterval[] = [];

  if (options.project?.tracks) {
    for (const track of options.project.tracks) {
      const isMotionTrack =
        track.name === "Capa Motion" ||
        track.name === "Capa Transiciones" ||
        /motion|gr[áa]fico|overlay/i.test(track.name);
      if (!isMotionTrack) continue;

      for (const clip of track.clips ?? []) {
        const name = (clip.name || "").toLowerCase();
        const remotionComp = (clip.remotion?.componentName || "").toLowerCase();
        const remotionProps = (clip.remotion?.props ?? {}) as Record<string, any>;
        const rawZone = remotionProps.zone || (name.includes("lower") ? "lower-third" : "hero-top");

        const isMap = name.includes("map") || remotionComp.includes("map");
        const isChart =
          name.includes("chart") ||
          name.includes("hud") ||
          name.includes("métrica") ||
          remotionComp.includes("chart") ||
          remotionComp.includes("hud");
        const isBespoke =
          name.includes("bespoke") ||
          remotionComp.includes("bespoke") ||
          name.includes("metaphor") ||
          name.includes("orbit") ||
          name.includes("radar") ||
          name.includes("neural");
        const isGrid = name.includes("grid") || remotionComp.includes("grid") || name.includes("ambient");
        const isHero =
          name.includes("hero") ||
          name.includes("hook") ||
          name.includes("título") ||
          name.includes("intro") ||
          remotionComp.includes("hook") ||
          remotionComp.includes("title");
        const isMedia = name.includes("media") || remotionComp.includes("richmedia");

        const isHeavyOrFullScreen = isMap || isChart || isBespoke || isGrid || isHero || isMedia;
        const zone: VisualLayerInterval["zone"] =
          isMap || isGrid || isBespoke ? "fullscreen" : rawZone === "lower-third" ? "lower-third" : "hero-top";

        visualIntervals.push({
          startFrame: clip.startFrame,
          endFrame: clip.startFrame + clip.durationFrames,
          type: isMap ? "map" : isChart ? "chart" : isBespoke ? "bespoke" : isHero ? "hero" : isGrid ? "grid" : isMedia ? "media" : "graphic",
          zone,
          isHeavyOrFullScreen,
          title: clip.name,
        });
      }
    }
  }

  if (options.narrativeBlocks && options.narrativeBlocks.length > 0) {
    for (let blockIdx = 0; blockIdx < options.narrativeBlocks.length; blockIdx += 1) {
      const b = options.narrativeBlocks[blockIdx]!;
      const kind = (b.cardKind || "").toLowerCase();
      const isMap = kind === "map";
      const isChart = kind === "chart" || kind === "metric";
      const isBespoke = kind === "bespoke" || Boolean(b.customVisualMetaphor);
      const isAmbient = kind === "ambient";
      const isHero = kind === "hero" || b.index === 0 || blockIdx === 0;
      const isMedia = kind === "media";
      const isHeavy = isMap || isChart || isBespoke || isAmbient || isHero || isMedia;

      visualIntervals.push({
        startFrame: b.startFrame,
        endFrame: b.endFrame,
        type: kind || "block",
        zone: isMap || isAmbient || isBespoke ? "fullscreen" : isChart || isMedia ? "lower-third" : "hero-top",
        isHeavyOrFullScreen: isHeavy,
        title: b.label || b.headline,
      });
    }
  }

  const isCinematicDNA =
    options.dna?.emotionalTone === "dramatic_cinematic" ||
    options.dna?.emotionalTone === "epic_documentary" ||
    options.dna?.category === "anime_fiction" ||
    options.dna?.category === "luxury_editorial" ||
    options.dna?.category === "documentary";

  let activeCount = 0;
  let suppressedCount = 0;
  let relocatedTopCount = 0;
  let keywordCalloutCount = 0;
  let narrativeMinimalCount = 0;

  const governedCues: CaptionCue[] = cues.map((originalCue) => {
    const cue: CaptionCue = {
      ...originalCue,
      words: originalCue.words.map((w) => ({ ...w })),
      zone: originalCue.zone ?? "lower-third",
      suppressed: false,
      cueType: isCinematicDNA ? "narrative_minimal" : "standard",
    };

    const cueMid = (cue.start + cue.end) / 2;
    const overlapping = visualIntervals.filter(
      (vi) => cueMid >= vi.startFrame && cueMid < vi.endFrame,
    );

    // Caso A: El usuario exigió subtítulos completos e ininterrumpidos en todo el video
    if (userWantsFullSubtitles) {
      const hasLowerCollision = overlapping.some((vi) => vi.zone === "lower-third");
      if (hasLowerCollision) {
        cue.zone = "hero-top";
        relocatedTopCount += 1;
      }
      activeCount += 1;
      return cue;
    }

    // Caso B: Motor Autónomo de Tipografía Cinética (Decisión Inteligente)
    const hasHeroHook = overlapping.some((vi) => vi.type === "hero" && vi.isHeavyOrFullScreen);
    const hasMapOrMetaphor = overlapping.some((vi) => vi.type === "map" || vi.type === "bespoke" || vi.type === "grid");
    const chartItem = overlapping.find((vi) => vi.type === "chart" || vi.type === "metric");
    const hasLowerThirdElement = overlapping.some((vi) => vi.zone === "lower-third");

    // 1. Hook de apertura con Título Cinético 3D (primeros 2.8s / 84 frames):
    // En video real hablado NUNCA suprimimos la voz inicial del locutor, solo reubicamos si colisiona
    if (hasHeroHook && cue.start <= Math.round(options.fps * 2.8)) {
      if (options.isRealFootage) {
        cue.zone = "lower-third";
      } else {
        cue.suppressed = true;
        suppressedCount += 1;
        return cue;
      }
    }

    // 2. Mapas interactivos, metáforas cuánticas/radar y mallas 3D complejas:
    // Suprimir para permitir concentración 100% en la telemetría e ilustración
    if (hasMapOrMetaphor) {
      cue.suppressed = true;
      suppressedCount += 1;
      return cue;
    }

    // 3. Gráficos de Datos, Barras y Métricas HUD:
    // Modo Énfasis Selectivo (Keyword Callouts) si hay un número o métrica clave
    if (chartItem) {
      const cueText = cue.words.map((w) => w.text).join(" ");
      const hasNumberOrMetric = /(\+|-)?\d+(?:[.,]\d+)?%?|\$|ahorro|recicla|crecimiento|ventas|impacto|kpi/i.test(cueText);

      if (hasNumberOrMetric) {
        const punchToken =
          cue.words.find((w) => /(\+|-)?\d+|%|\$/i.test(w.text))?.text ||
          cue.words.find((w) => w.text.length >= 6)?.text ||
          cue.words[0]?.text ||
          "DATO CLAVE";

        cue.cueType = "keyword_callout";
        cue.zone = "hero-top";
        cue.keywordText = punchToken.toUpperCase();
        cue.suppressed = false;
        keywordCalloutCount += 1;
        relocatedTopCount += 1;
        activeCount += 1;
        return cue;
      } else {
        cue.suppressed = true;
        suppressedCount += 1;
        return cue;
      }
    }

    // 4. Elementos en Tercio Inferior (Evitar colisión):
    // Reubicar dinámicamente al tercio superior seguro (hero-top)
    if (hasLowerThirdElement) {
      cue.zone = "hero-top";
      relocatedTopCount += 1;
    } else {
      cue.zone = "lower-third";
    }

    // 5. Estilizado según el tono de la narrativa
    if (isCinematicDNA) {
      cue.cueType = "narrative_minimal";
      narrativeMinimalCount += 1;
    } else {
      cue.cueType = "retention_punch";
      const candidateWord = [...cue.words].sort((a, b) => b.text.length - a.text.length)[0];
      if (candidateWord && candidateWord.text.length >= 5) {
        candidateWord.highlight = true;
      }
    }

    cue.suppressed = false;
    activeCount += 1;
    return cue;
  });

  const explanation = [
    `GOBERNANZA AUTÓNOMA DE SUBTÍTULOS (${activeCount} activos, ${suppressedCount} suprimidos por gráficos, ${relocatedTopCount} reubicados a hero-top, ${keywordCalloutCount} callouts de énfasis):`,
    suppressedCount > 0
      ? `• Supresión Inteligente: Pausados ${suppressedCount} subtítulos durante títulos intro, mapas y gráficos pesados para garantizar 0% saturación visual.`
      : "• Cobertura continua en planos abiertos.",
    relocatedTopCount > 0
      ? `• Reubicación Anti-Colisión: ${relocatedTopCount} bloques redirigidos automáticamente al tercio superior seguro (hero-top, 160px) para no colisionar con activos inferiores.`
      : "• Sin colisiones en tercio inferior.",
    keywordCalloutCount > 0
      ? `• Énfasis Selectivo: ${keywordCalloutCount} cifras clave convertidas en pastillas flotantes kinéticas en lugar de bloques de texto largos.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    cues: governedCues,
    stats: {
      totalOriginalCues: cues.length,
      activeCues: activeCount,
      suppressedCues: suppressedCount,
      relocatedTopCues: relocatedTopCount,
      keywordCalloutCues: keywordCalloutCount,
      narrativeMinimalCues: narrativeMinimalCount,
    },
    explanation,
  };
}

export interface BuildSubtitlesOptions {
  projectId: string;
  project: Project;
  currentFrame: number;
  signal: AbortSignal;
  onProgress?: (progress: number, message?: string) => void;
  /** Estilo visual pedido (id del catálogo o "custom"). */
  style?: SubtitleStyleId;
  /** Segmentos ya transcritos: evita volver a invocar Whisper. */
  cachedSegments?: TranscriptSegment[];
  /** Código ya resuelto: permite reconstruir sin transcripción ni LLM. */
  code?: string;
  name?: string;
  compositionId?: string;
  userPrompt?: string;
  narrativeBlocks?: Array<{
    startFrame: number;
    endFrame: number;
    label: string;
    cardKind?: string;
    headline?: string;
    subheadline?: string;
    customVisualMetaphor?: string;
    index?: number;
  }>;
  dna?: ProjectSemanticDNA;
}

/** Transcribe el audio del clip y construye el overlay de subtítulos. */
export async function buildSubtitles(options: BuildSubtitlesOptions): Promise<SubtitleBuild> {
  const {
    projectId,
    project,
    currentFrame,
    signal,
    onProgress,
    style,
    cachedSegments,
    userPrompt,
    narrativeBlocks,
    dna,
  } = options;

  const source = findCaptionSource(project, currentFrame);
  if (!source) {
    throw new HttpError(
      422,
      "No encuentro un clip de video con audio en el timeline. Añade el video con su sonido y vuelve a pedir los subtítulos.",
      "no_audio_source",
    );
  }

  const segments =
    cachedSegments ??
    (await transcribeMedia(projectId, source.asset, undefined, signal, onProgress)).segments;

  const rawCues = buildCaptionCues(segments, source);
  if (rawCues.length === 0) {
    throw new HttpError(
      422,
      "La transcripción no produjo frases dentro del clip. Comprueba que el audio tiene voz audible.",
      "no_captions",
    );
  }

  // APLICAR GOBERNANZA AUTÓNOMA DE TIPOGRAFÍA CINÉTICA Y ANTI-COLISIÓN
  const governance = applyAutonomousSubtitleGovernance(rawCues, {
    project,
    narrativeBlocks,
    dna,
    userPrompt,
    fps: source.fps,
    totalFrames: source.durationFrames,
    isRealFootage: source.clip.type === "video",
  });
  const cues = governance.cues;

  const resolvedStyle: SubtitleStyleId = style ?? (dna?.emotionalTone === "dramatic_cinematic" ? "cinematic" : "minimal");
  const wordCount = cues.reduce((sum, cue) => sum + (cue.suppressed ? 0 : cue.words.length), 0);
  const name =
    options.name ?? (resolvedStyle === "custom" ? "CustomSubtitles" : componentNameForStyle(resolvedStyle));

  return {
    code:
      options.code ??
      (resolvedStyle === "custom" ? "" : subtitleComponentCode(resolvedStyle, name)),
    name,
    compositionId: options.compositionId ?? `${name}Comp`,
    durationInFrames: source.durationFrames,
    startFrame: source.startFrame,
    props: { captions: cues },
    cueCount: cues.filter((c) => !c.suppressed).length,
    wordCount,
    style: resolvedStyle,
    model: "whisper",
    sourceKey: `${source.clip.mediaId}:${source.clip.sourceInUs}:${source.clip.sourceOutUs}:${source.clip.speed}`,
    segments,
    governance,
  };
}

function formatTimestampExact(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

/**
 * Genera el Guion Técnico Senior de Subtitulado y Sincronización (Timestamp Locking + Verbatim)
 * para mostrar en el chat de AI Motion Studio.
 */
export function formatTechnicalSubtitleScript(
  cues: CaptionCue[],
  fps: number,
  style: SubtitleStyleId,
  maxScenes = 10,
  governance?: SubtitleGovernanceReport,
): string {
  const safeFps = fps > 0 ? fps : 30;
  const shown = cues.slice(0, maxScenes);
  const lines: string[] = [
    `DIRECTOR AUTÓNOMO DE TIPOGRAFÍA CINÉTICA (${cues.length} bloques · ${safeFps} fps · Estilo: ${style.toUpperCase()})`,
  ];

  if (governance?.explanation) {
    lines.push(governance.explanation);
    lines.push("");
  }

  shown.forEach((cue) => {
    const tStart = formatTimestampExact(cue.start / safeFps);
    const tEnd = formatTimestampExact(cue.end / safeFps);
    const literalText = cue.words.map((w) => w.text).join(" ");

    if (cue.suppressed) {
      lines.push(
        `• [${tStart} - ${tEnd} | F:${cue.start}-${cue.end}] 🔇 SUPRIMIDO (Foco 100% en elemento visual activo sin saturación tipográfica)\n  ↳ "${literalText}"`,
      );
    } else if (cue.cueType === "keyword_callout") {
      lines.push(
        `• [${tStart} - ${tEnd} | F:${cue.start}-${cue.end}] 💎 ÉNFASIS SELECTIVO · Callout Kinético: "${cue.keywordText || literalText}"\n  ↳ Posición: ${cue.zone?.toUpperCase()} (Píldora flotante con física spring() sobre espacio libre)`,
      );
    } else if (cue.zone === "hero-top") {
      lines.push(
        `• [${tStart} - ${tEnd} | F:${cue.start}-${cue.end}] ⬆️ REUBICACIÓN ANTI-COLISIÓN (Tercio Superior Seguro, 160px)\n  ↳ "${literalText}"`,
      );
    } else if (cue.cueType === "narrative_minimal") {
      lines.push(
        `• [${tStart} - ${tEnd} | F:${cue.start}-${cue.end}] 🎬 MODO NARRATIVO EDITORIAL (Fundido suave y baja interferencia)\n  ↳ "${literalText}"`,
      );
    } else {
      const keyWord =
        cue.words.find((w) => w.highlight)?.text ??
        cue.words.find((w) => w.text.replace(/[.,!?;:¡¿"']/g, "").length >= 6)?.text ??
        cue.words[cue.words.length - 1]?.text ??
        "";
      lines.push(
        `• [${tStart} - ${tEnd} | F:${cue.start}-${cue.end}] 💬 RETENCIÓN DINÁMICA (Tercio Inferior)\n  ↳ "${literalText}" · Acento: "${keyWord}"`,
      );
    }
  });

  if (cues.length > maxScenes) {
    lines.push(`• [... +${cues.length - maxScenes} bloques adicionales gestionados con gobernanza espacial]`);
  }

  return lines.join("\n");
}
export function previewWindow(
  cues: CaptionCue[],
  currentFrameRelative: number,
  fps: number,
  durationInFrames: number,
  seconds = 8,
): { offset: number; durationInFrames: number } {
  const windowFrames = Math.max(30, Math.round(seconds * fps));
  const active = cues.find(
    (cue) => currentFrameRelative >= cue.start && currentFrameRelative < cue.end,
  );
  const anchor = active ? active.start : cues[0]?.start ?? 0;
  const offset = Math.max(
    0,
    Math.min(anchor, Math.max(0, durationInFrames - windowFrames)),
  );
  return {
    offset,
    durationInFrames: Math.max(1, Math.min(windowFrames, durationInFrames - offset)),
  };
}
