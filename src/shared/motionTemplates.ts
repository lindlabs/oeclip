import type { RemotionComponentSpec } from "./schema";

export type RemotionSubtitleStyleId =
  | "minimal"
  | "tiktok"
  | "hormozi"
  | "cinematic"
  | "neon"
  | "impact"
  | "karaoke";

export interface RemotionSubtitleStyleMeta {
  id: RemotionSubtitleStyleId;
  label: string;
  badge: string;
  description: string;
  accentColor: string;
  previewBg: string;
  previewText: string;
}

export const REMOTION_SUBTITLE_STYLES: RemotionSubtitleStyleMeta[] = [
  {
    id: "minimal",
    label: "Editorial Minimal",
    badge: "Vlog Pro",
    description: "Sans-serif geométrica con caja translúcida y acento ámbar en palabras clave.",
    accentColor: "#F59E0B",
    previewBg: "rgba(12, 14, 17, 0.78)",
    previewText: "#FFFFFF",
  },
  {
    id: "tiktok",
    label: "Pop Karaoke",
    badge: "Viral",
    description: "Píldoras dinámicas con resorte spring en la palabra activa estilo Reels/TikTok.",
    accentColor: "#C9FF4D",
    previewBg: "#C9FF4D",
    previewText: "#101014",
  },
  {
    id: "hormozi",
    label: "Viral Hormozi / MrBeast",
    badge: "Viral",
    description: "Palabras con spring pop y resaltado amarillo neón en cada palabra hablada.",
    accentColor: "#FFE600",
    previewBg: "rgba(10, 10, 15, 0.92)",
    previewText: "#FFE600",
  },
  {
    id: "impact",
    label: "Caja Impacto",
    badge: "Bold",
    description: "Bloques rotundos en alto contraste con palabra activa resaltada en amarillo.",
    accentColor: "#FFD44A",
    previewBg: "#111111",
    previewText: "#FFD44A",
  },
  {
    id: "cinematic",
    label: "Cinemático",
    badge: "Film",
    description: "Tipografía editorial con filete superior dorado y fundido suave.",
    accentColor: "#E8C07A",
    previewBg: "rgba(20, 18, 15, 0.72)",
    previewText: "#F2EDE3",
  },
  {
    id: "neon",
    label: "Neón Glow",
    badge: "Cyber",
    description: "Resplandor cian/magenta de alto contraste sobre la palabra pronunciada.",
    accentColor: "#4DE8FF",
    previewBg: "rgba(10, 14, 24, 0.85)",
    previewText: "#4DE8FF",
  },
  {
    id: "karaoke",
    label: "Barra Karaoke",
    badge: "Rítmico",
    description: "Indicador de progreso inferior sincronizado al fonema de cada palabra.",
    accentColor: "#FF4D6D",
    previewBg: "rgba(16, 18, 22, 0.8)",
    previewText: "#FFFFFF",
  },
];

export interface CaptionWordItem {
  text: string;
  start: number;
  end: number;
  highlight?: boolean;
}

export interface CaptionCueItem {
  start: number;
  end: number;
  words: CaptionWordItem[];
  zone?: "lower-third" | "hero-top" | "center" | "keyword-float";
  suppressed?: boolean;
  cueType?: "standard" | "keyword_callout" | "narrative_minimal" | "retention_punch";
  positionY?: number;
  accentColor?: string;
  keywordText?: string;
}

export function buildSubtitleComponentName(styleId: RemotionSubtitleStyleId): string {
  switch (styleId) {
    case "tiktok":
      return "TikTokSubtitles";
    case "hormozi":
      return "HormoziSubtitles";
    case "cinematic":
      return "CinematicSubtitles";
    case "neon":
      return "NeonSubtitles";
    case "impact":
      return "ImpactSubtitles";
    case "karaoke":
      return "KaraokeSubtitles";
    case "minimal":
    default:
      return "MinimalSubtitles";
  }
}

/**
 * Genera el código TSX de Remotion para subtítulos parametrizados en vivo.
 * Lee `props.captions`, `props.accentColor`, `props.textColor`, `props.fontScale`,
 * `props.positionY` y `props.bgOpacity` para que cualquier ajuste en el Inspector
 * se refleje a 60fps sin recompilar el componente.
 */
export function buildSubtitleComponentCode(
  styleId: RemotionSubtitleStyleId,
  customName?: string,
): { code: string; componentName: string } {
  const componentName = customName || buildSubtitleComponentName(styleId);

  const header = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";

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
type SubtitleProps = {
  captions?: CaptionCue[];
  offset?: number;
  accentColor?: string;
  textColor?: string;
  fontScale?: number;
  positionY?: number;
  bgOpacity?: number;
};
`;

  const commonBody = `  const frame = useCurrentFrame() + (props.offset ?? 0);
  const { fps, width, height } = useVideoConfig();
  const captions = Array.isArray(props.captions) ? props.captions : [];
  const index = captions.findIndex((cue) => frame >= cue.start && frame < cue.end);
  if (index === -1) return null;
  const cue = captions[index];
  if (cue.suppressed) return null;
  const local = Math.max(0, frame - cue.start);
  const duration = Math.max(1, cue.end - cue.start);
  const unit = Math.min(width, height);
  const isVertical = height > width;
  const rawScale = typeof props.fontScale === "number" && props.fontScale > 0 ? props.fontScale : 1;
  const scaleMult = rawScale > 5 ? rawScale / 100 : rawScale;
  const cueZone = cue.zone || "lower-third";
  const isTop = cueZone === "hero-top" || cueZone === "top-right-hud" || cueZone === "top-left-hud";
  const isCenter = cueZone === "center" || cueZone === "keyword-float";
  const defaultPosY = isTop ? (isVertical ? 0.16 : 0.14) : isCenter ? 0.5 : (isVertical ? 0.74 : 0.86);
  const rawPosY = typeof (cue as any).positionY === "number" ? (cue as any).positionY : (typeof props.positionY === "number" ? props.positionY : defaultPosY);
  const posY = rawPosY > 1.5 ? rawPosY / 100 : rawPosY;
  const topPad = isTop ? (isVertical ? 160 : 88) : 0;
  const bottomPad = isTop || isCenter ? 0 : Math.max(height * 0.04, Math.min(height * 0.85, height * (1 - posY)));
  const maxSafeWidth = isVertical ? width * 0.82 : width * 0.88;
  const safeMarginRight = isVertical ? width * 0.04 : 0;
  const verticalJustify = isTop ? "flex-start" : isCenter ? "center" : "flex-end";
`;

  const keywordCalloutSnippet = `  if (cue.cueType === "keyword_callout") {
    const keyWord = cue.keywordText || (cue.words.find((w: any) => w.highlight)?.text) || cue.words[0]?.text || "";
    const pop = spring({ frame: local + 1, fps, config: { damping: 11, stiffness: 240, mass: 0.55 } });
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "transparent",
          justifyContent: verticalJustify,
          alignItems: "center",
          paddingTop: topPad,
          paddingBottom: bottomPad,
          paddingRight: safeMarginRight,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 22px",
            background: "linear-gradient(135deg, rgba(15, 23, 42, 0.94) 0%, rgba(2, 6, 23, 0.90) 100%)",
            backdropFilter: "blur(20px)",
            borderRadius: 999,
            border: "1.5px solid " + accent,
            boxShadow: "0 12px 36px rgba(0,0,0,0.7), 0 0 25px " + accent + "55",
            transform: "scale(" + pop + ")",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: accent, display: "inline-block" }} />
          <span
            style={{
              fontFamily: '"Inter", "Arial Black", Impact, sans-serif',
              fontWeight: 900,
              fontSize: unit * 0.052 * scaleMult,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "#FFFFFF",
              textShadow: "0 2px 8px rgba(0,0,0,0.8)",
            }}
          >
            {keyWord}
          </span>
        </div>
      </AbsoluteFill>
    );
  }
`;

  if (styleId === "tiktok") {
    return {
      componentName,
      code: `${header}
const PALETTE = ["#C9FF4D", "#FF4D9D", "#4DE8FF", "#FFD166", "#B98CFF", "#FF7A45"];

export const ${componentName} = (props: SubtitleProps) => {
${commonBody}  const fontSize = unit * 0.072 * scaleMult;
  const accent = props.accentColor || "#C9FF4D";
  const baseText = props.textColor || "#FFFFFF";
  const enter = spring({ frame: local + 1, fps, config: { damping: 14, stiffness: 260, mass: 0.5 } });

${keywordCalloutSnippet}  return (
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
          opacity: 1,
          transform: "scale(" + (0.95 + 0.05 * Math.min(1, enter)) + ")",
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const pop = active
            ? spring({ frame: Math.max(0, frame - word.start) + 1, fps, config: { damping: 10, stiffness: 320, mass: 0.35 } })
            : 0;
          const pillColor = i === 0 || word.highlight ? accent : PALETTE[(index + i) % PALETTE.length];
          return (
            <span
              key={i}
              style={{
                fontFamily: '"Inter", "Arial Black", Impact, sans-serif',
                fontWeight: 900,
                fontSize,
                lineHeight: 1.05,
                letterSpacing: -fontSize * 0.02,
                textTransform: "uppercase",
                color: active ? "#101014" : baseText,
                backgroundColor: active ? pillColor : "transparent",
                borderRadius: fontSize * 0.22,
                padding: (fontSize * 0.06) + "px " + (active ? fontSize * 0.18 : fontSize * 0.06) + "px",
                textShadow: active ? "none" : "0 2px 10px rgba(0,0,0,0.75)",
                transform: "translateY(" + (active ? -fontSize * 0.07 * pop : 0) + "px) scale(" + (active ? 1 + 0.12 * pop : 1) + ")",
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
`,
    };
  }

  if (styleId === "hormozi") {
    return {
      componentName,
      code: `${header}
const EMOJI_MAP: Record<string, string> = {
  dinero: "💰", plata: "💰", cash: "💵", dolar: "💵", dolares: "💵", precio: "🏷️", costo: "🏷️", ventas: "📈", ingresos: "📈", ganancia: "🤑", billon: "💎", millon: "💎",
  crecimiento: "🚀", escala: "🚀", escalar: "🚀", crecer: "📈", subir: "📈", arriba: "🔝", exito: "🏆", ganador: "🥇", ganar: "🏆", meta: "🎯", objetivo: "🎯", record: "⚡",
  viral: "🔥", fuego: "🔥", brutal: "💥", impacto: "⚡", increible: "🤯", loco: "🤯", boom: "💥", secreto: "🤫", clave: "🔑", hack: "💡", truco: "🪄", magia: "✨",
  tiempo: "⏱️", hora: "⏳", rapido: "⚡", ya: "🚨", ahora: "⚡", urgente: "🚨", atencion: "⚠️", cuidado: "⚠️", error: "❌", peligro: "🛑", stop: "🛑",
  negocio: "💼", empresa: "🏢", trabajo: "💼", cliente: "🤝", clientes: "👥", equipo: "🤝", robot: "🤖", bot: "🤖", ai: "🧠", ia: "🧠", cerebro: "🧠", idea: "💡",
  amor: "❤️", corazon: "❤️", top: "⭐", mejor: "⭐", perfecto: "✨", pro: "👑", rey: "👑"
};

export const ${componentName} = (props: SubtitleProps) => {
${commonBody}  const fontSize = unit * 0.082 * scaleMult;
  const accent = props.accentColor || "#FFE600";
  const baseText = props.textColor || "#FFFFFF";
  const enter = spring({ frame: local + 1, fps, config: { damping: 12, stiffness: 280, mass: 0.45 } });

  let cueEmoji = "";
  for (const w of cue.words) {
    const clean = (w.text || "").toLowerCase().replace(/[^a-záéíóúñ]/g, "");
    if (EMOJI_MAP[clean]) {
      cueEmoji = EMOJI_MAP[clean];
      break;
    }
  }

  const emojiSpring = cueEmoji
    ? spring({ frame: local + 1, fps, config: { damping: 9, stiffness: 320, mass: 0.35 } })
    : 0;

${keywordCalloutSnippet}  return (
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
          opacity: 1,
          transform: "scale(" + (0.95 + 0.05 * Math.min(1, enter)) + ")",
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
              ? spring({ frame: Math.max(0, frame - word.start) + 1, fps, config: { damping: 10, stiffness: 360, mass: 0.3 } })
              : 0;
            const cleanWord = (word.text || "").toLowerCase().replace(/[^a-záéíóúñ]/g, "");
            const hasOwnEmoji = Boolean(EMOJI_MAP[cleanWord]);
            const isSpecial = Boolean(word.highlight) || hasOwnEmoji || word.text.length >= 7 || /\\d/.test(word.text);
            const activeColor = accent;

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
                  color: active ? activeColor : isSpecial ? "#22C55E" : baseText,
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
`,
    };
  }

  if (styleId === "cinematic") {
    return {
      componentName,
      code: `${header}
export const ${componentName} = (props: SubtitleProps) => {
${commonBody}  const fontSize = unit * 0.054 * scaleMult;
  const accent = props.accentColor || "#E8C07A";
  const baseText = props.textColor || "#F2EDE3";
  const inProgress = interpolate(local, [0, 3], [0.88, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const ruleWidth = width * 0.18 * inProgress;

${keywordCalloutSnippet}  return (
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
          gap: unit * 0.018,
          opacity: inProgress,
          transform: "translateY(" + (1 - inProgress) * unit * 0.012 + "px)",
        }}
      >
        <div
          style={{
            width: ruleWidth,
            height: Math.max(2, unit * 0.003),
            backgroundColor: accent,
            opacity: 0.9,
          }}
        />
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: maxSafeWidth,
            fontFamily: 'Georgia, "Playfair Display", serif',
            fontSize,
            fontWeight: 600,
            lineHeight: 1.25,
            letterSpacing: fontSize * 0.05,
            textTransform: "uppercase",
            color: baseText,
            textAlign: "center",
          }}
        >
          {cue.words.map((word, i) => {
            const active = frame >= word.start && frame < word.end;
            return (
              <span
                key={i}
                style={{
                  margin: "0 " + fontSize * 0.09 + "px",
                  color: active || word.highlight ? accent : baseText,
                  textShadow: active
                    ? "0 0 18px " + accent + ", 0 2px 8px rgba(0,0,0,0.8)"
                    : "0 2px 8px rgba(0,0,0,0.75)",
                  transform: active ? "scale(1.05)" : "scale(1)",
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
`,
    };
  }


  if (styleId === "neon") {
    return {
      componentName,
      code: `${header}
export const ${componentName} = (props: SubtitleProps) => {
${commonBody}  const fontSize = unit * 0.068 * scaleMult;
  const accent = props.accentColor || "#4DE8FF";
  const baseText = props.textColor || "#F2FEFF";
  const enter = interpolate(local, [0, 2], [0.9, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

${keywordCalloutSnippet}  return (
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
          width: maxSafeWidth,
          opacity: 1,
          transform: "scale(" + (0.96 + 0.04 * enter) + ")",
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const hue = word.highlight || i % 2 === 0 ? accent : "#FF4D9D";
          return (
            <span
              key={i}
              style={{
                fontFamily: '"Inter", "Arial Black", Impact, sans-serif',
                fontWeight: 900,
                fontSize,
                lineHeight: 1.08,
                letterSpacing: fontSize * 0.025,
                textTransform: "uppercase",
                color: active ? "#FFFFFF" : baseText,
                margin: "0 " + fontSize * 0.08 + "px",
                textShadow: active
                  ? "0 0 12px " + hue + ", 0 0 28px " + hue + ", 0 2px 6px rgba(0,0,0,0.9)"
                  : "0 0 8px " + accent + ", 0 2px 6px rgba(0,0,0,0.8)",
                transform: active ? "scale(1.07)" : "scale(1)",
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
`,
    };
  }


  if (styleId === "impact") {
    return {
      componentName,
      code: `${header}
export const ${componentName} = (props: SubtitleProps) => {
${commonBody}  const fontSize = unit * 0.064 * scaleMult;
  const accent = props.accentColor || "#FFD44A";
  const baseText = props.textColor || "#FFFFFF";
  const bgAlpha = typeof props.bgOpacity === "number" ? props.bgOpacity : 0.82;

${keywordCalloutSnippet}  return (
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
          maxWidth: maxSafeWidth,
          width: maxSafeWidth,
          opacity: 1,
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          return (
            <span
              key={i}
              style={{
                fontFamily: '"Inter", "Arial Black", Impact, sans-serif',
                fontWeight: 900,
                fontSize,
                lineHeight: 1.04,
                textTransform: "uppercase",
                color: active ? "#111111" : baseText,
                backgroundColor: active ? accent : "rgba(12, 14, 18, " + bgAlpha + ")",
                borderRadius: fontSize * 0.14,
                padding: (fontSize * 0.08) + "px " + (fontSize * 0.18) + "px",
                transform: active ? "scale(1.06)" : "scale(1)",
                boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
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
`,
    };
  }


  if (styleId === "karaoke") {
    return {
      componentName,
      code: `${header}
export const ${componentName} = (props: SubtitleProps) => {
${commonBody}  const fontSize = unit * 0.064 * scaleMult;
  const accent = props.accentColor || "#FF4D6D";
  const baseText = props.textColor || "#FFFFFF";

${keywordCalloutSnippet}  return (
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
          gap: unit * 0.018,
          maxWidth: maxSafeWidth,
          width: maxSafeWidth,
          opacity: 1,
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const wordDuration = Math.max(1, word.end - word.start);
          const progress = active
            ? Math.max(0.15, Math.min(1, (frame - word.start + 1) / wordDuration))
            : frame >= word.end
              ? 1
              : 0;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: unit * 0.006,
              }}
            >
              <span
                style={{
                  fontFamily: '"Inter", system-ui, sans-serif',
                  fontWeight: 800,
                  fontSize,
                  lineHeight: 1.06,
                  color: active ? accent : baseText,
                  textShadow: "0 2px 10px rgba(0,0,0,0.75)",
                  display: "inline-block",
                  whiteSpace: "nowrap",
                }}
              >
                {word.text}
              </span>
              <div
                style={{
                  width: "100%",
                  minWidth: fontSize * 0.7,
                  height: Math.max(3, fontSize * 0.08),
                  borderRadius: 999,
                  backgroundColor: "rgba(255,255,255,0.22)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: (progress * 100).toFixed(1) + "%",
                    height: "100%",
                    backgroundColor: accent,
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
`,
    };
  }


  // Default: minimal (Editorial Minimalista)
  return {
    componentName,
    code: `${header}
export const ${componentName} = (props: SubtitleProps) => {
${commonBody}  const fontSize = unit * 0.056 * scaleMult;
  const accent = props.accentColor || "#F59E0B";
  const baseText = props.textColor || "#FFFFFF";
  const bgAlpha = typeof props.bgOpacity === "number" ? props.bgOpacity : 0.56;
  const inProgress = interpolate(local, [0, 2], [0.92, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

${keywordCalloutSnippet}  return (
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
          backgroundColor: "rgba(12, 14, 17, " + bgAlpha + ")",
          backdropFilter: bgAlpha > 0.05 ? "blur(8px)" : "none",
          borderRadius: fontSize * 0.36,
          padding: (fontSize * 0.24) + "px " + (fontSize * 0.48) + "px",
          boxShadow: bgAlpha > 0.05 ? "0 8px 28px rgba(0,0,0,0.42), 0 1px 0 rgba(255,255,255,0.08) inset" : "none",
          fontFamily: '"Inter", "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize,
          fontWeight: 700,
          lineHeight: 1.24,
          letterSpacing: -fontSize * 0.015,
          textAlign: "center",
          opacity: 1,
          transform: "translateY(" + (1 - inProgress) * unit * 0.008 + "px)",
        }}
      >
        {cue.words.map((word, i) => {
          const active = frame >= word.start && frame < word.end;
          const cleanToken = word.text.replace(/[.,!?;:¡¿"']/g, "");
          const isKeyword = Boolean(word.highlight) || cleanToken.length >= 6 || /\\d/.test(cleanToken);
          const activeColor = isKeyword ? accent : baseText;
          return (
            <span
              key={i}
              style={{
                margin: "0 " + fontSize * 0.09 + "px",
                color: active
                  ? activeColor
                  : frame >= word.end
                    ? baseText
                    : "rgba(255,255,255,0.46)",
                opacity: active ? 1 : frame >= word.end ? 0.88 : 1,
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
`,
  };
}

// ---------------------------------------------------------------------------
// Catálogo de Plantillas Motion (CapCut-Style Presets en 0ms)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transiciones Cinemáticas Procedurales (0ms de descarga · 100% Vector & Shader)
// ---------------------------------------------------------------------------

export type RemotionTransitionId = "whip-pan" | "zoom-punch" | "glitch-svg" | "light-leak";

export interface RemotionTransitionMeta {
  id: RemotionTransitionId;
  label: string;
  icon: string;
  badge: string;
  description: string;
  durationFrames: number;
  componentName: string;
  code: string;
}

export const REMOTION_TRANSITION_TEMPLATES: RemotionTransitionMeta[] = [
  {
    id: "whip-pan",
    label: "Whip Pan",
    icon: "zap",
    badge: "0ms · 4K",
    description: "Barrido de cámara ultrarrápido con motion blur direccional y líneas de velocidad vectoriales.",
    durationFrames: 24,
    componentName: "WhipPanTransition",
    code: `import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig, Easing } from "remotion";

export const WhipPanTransition = (props: { direction?: "left" | "right" | "up" | "down" }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const half = Math.floor(durationInFrames / 2);
  const dir = props.direction || "left";

  const progress = interpolate(frame, [0, durationInFrames], [-1, 1], {
    easing: Easing.bezier(0.7, 0, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const translateX = dir === "left" ? progress * width : dir === "right" ? -progress * width : 0;
  const translateY = dir === "up" ? progress * height : dir === "down" ? -progress * height : 0;

  const flash = interpolate(frame, [half - 3, half, half + 3], [0, 0.55, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const blurAmount = interpolate(frame, [0, half - 2, half, half + 2, durationInFrames], [0, 16, 28, 16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", overflow: "hidden", pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          backgroundColor: "rgba(255, 255, 255, " + flash + ")",
          backdropFilter: "blur(" + blurAmount + "px)",
          WebkitBackdropFilter: "blur(" + blurAmount + "px)",
          transform: "translate3d(" + (translateX * 0.15) + "px, " + (translateY * 0.15) + "px, 0)",
        }}
      />
      <svg
        width={width}
        height={height}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          opacity: interpolate(frame, [half - 5, half, half + 5], [0, 0.8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          transform: "translate3d(" + (translateX * 0.5) + "px, " + (translateY * 0.5) + "px, 0)",
        }}
      >
        <defs>
          <linearGradient id="whipGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.7)" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>
        {Array.from({ length: 12 }).map((_, i) => (
          <line
            key={i}
            x1={0}
            y1={(height / 12) * i + ((i * 19) % 25)}
            x2={width}
            y2={(height / 12) * i + ((i * 19) % 25)}
            stroke="url(#whipGrad)"
            strokeWidth={1 + (i % 3) * 2}
          />
        ))}
      </svg>
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "zoom-punch",
    label: "Zoom Punch",
    icon: "maximize",
    badge: "0ms · 4K",
    description: "Impacto de zoom elástico con onda expansiva radial y destello cinemático en el corte.",
    durationFrames: 24,
    componentName: "ZoomPunchTransition",
    code: `import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig, Easing } from "remotion";

export const ZoomPunchTransition = () => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const half = Math.floor(durationInFrames / 2);

  const scalePunch = interpolate(frame, [0, half, durationInFrames], [1, 1.38, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const shockwaveProgress = interpolate(frame, [half - 2, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const shockwaveRadius = shockwaveProgress * Math.max(width, height) * 0.8;
  const shockwaveOpacity = interpolate(shockwaveProgress, [0, 0.3, 1], [0, 0.85, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const impactFlash = interpolate(frame, [half - 2, half, half + 3], [0, 0.45, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", pointerEvents: "none", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          backgroundColor: "rgba(255, 255, 255, " + impactFlash + ")",
          backdropFilter: "blur(" + interpolate(frame, [half - 3, half, half + 3], [0, 14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) + "px)",
          WebkitBackdropFilter: "blur(" + interpolate(frame, [half - 3, half, half + 3], [0, 14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) + "px)",
          transform: "scale(" + scalePunch + ")",
          transformOrigin: "center center",
        }}
      />
      {shockwaveOpacity > 0.01 && (
        <svg width={width} height={height} style={{ position: "absolute", top: 0, left: 0 }}>
          <circle
            cx={width / 2}
            cy={height / 2}
            r={shockwaveRadius}
            fill="none"
            stroke="#38BDF8"
            strokeWidth={interpolate(shockwaveProgress, [0, 1], [18, 2])}
            opacity={shockwaveOpacity}
            style={{ filter: "drop-shadow(0 0 16px #0EA5E9)" }}
          />
        </svg>
      )}
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "glitch-svg",
    label: "Glitch Digital SVG",
    icon: "cpu",
    badge: "0ms · Vector",
    description: "Glitch digital procedimental en SVG con aberración cromática RGB y scanlines tipo monitor CRT.",
    durationFrames: 20,
    componentName: "GlitchSvgTransition",
    code: `import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const GlitchSvgTransition = () => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const half = Math.floor(durationInFrames / 2);

  const intensity = interpolate(frame, [0, half, durationInFrames], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const shiftX = Math.sin(frame * 4.7) * 28 * intensity;
  const shiftY = Math.cos(frame * 3.3) * 12 * intensity;
  const sliceHeight = height / 14;
  const activeSlices = [1, 3, 6, 8, 11].filter((idx) => ((frame * 7 + idx) % 3) === 0);

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", pointerEvents: "none", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: "translate3d(" + shiftX + "px, 0, 0)",
          backgroundColor: "rgba(255, 0, 80, " + (0.28 * intensity) + ")",
          mixBlendMode: "screen",
        }}
      />
      <AbsoluteFill
        style={{
          transform: "translate3d(" + (-shiftX * 0.8) + "px, " + shiftY + "px, 0)",
          backgroundColor: "rgba(0, 240, 255, " + (0.28 * intensity) + ")",
          mixBlendMode: "screen",
        }}
      />
      {intensity > 0.1 && (
        <svg width={width} height={height} style={{ position: "absolute", top: 0, left: 0 }}>
          {activeSlices.map((idx) => {
            const y = idx * sliceHeight;
            const sliceShift = ((idx % 2 === 0 ? 1 : -1) * (20 + (idx * 11) % 40)) * intensity;
            return (
              <rect
                key={idx}
                x={sliceShift}
                y={y}
                width={width}
                height={sliceHeight * 0.85}
                fill="rgba(255, 255, 255, 0.22)"
                style={{ mixBlendMode: "overlay" }}
              />
            );
          })}
        </svg>
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.18) 3px, rgba(0,0,0,0.18) 4px)",
          opacity: intensity * 0.65,
        }}
      />
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "light-leak",
    label: "Light Leak Analógico",
    icon: "sun",
    badge: "0ms · 35mm",
    description: "Fuga de luz analógica cálida estilo película 35mm con destellos radiales y quemadura de exposición.",
    durationFrames: 30,
    componentName: "LightLeakTransition",
    code: `import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig, Easing } from "remotion";

export const LightLeakTransition = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const half = Math.floor(durationInFrames / 2);

  const leakOpacity = interpolate(frame, [0, half - 4, half, half + 4, durationInFrames], [0, 0.85, 1, 0.85, 0], {
    easing: Easing.bezier(0.4, 0, 0.2, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const posX = interpolate(frame, [0, durationInFrames], [15, 85], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const posY = interpolate(frame, [0, durationInFrames], [20, 60], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const flashBurn = interpolate(frame, [half - 2, half, half + 2], [0, 0.45, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", pointerEvents: "none", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: "-20%",
          background: "radial-gradient(circle at " + posX + "% " + posY + "%, rgba(255, 125, 45, 0.95) 0%, rgba(255, 45, 110, 0.72) 35%, rgba(255, 195, 60, 0.38) 60%, transparent 85%)",
          mixBlendMode: "screen",
          opacity: leakOpacity,
          transform: "scale(" + (1 + 0.1 * Math.sin(frame * 0.15)) + ")",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: "-10%",
          background: "radial-gradient(circle at " + (100 - posX) + "% " + (100 - posY) + "%, rgba(255, 220, 100, 0.8) 0%, rgba(255, 100, 50, 0.4) 45%, transparent 75%)",
          mixBlendMode: "screen",
          opacity: leakOpacity * 0.75,
        }}
      />
      {flashBurn > 0.01 && (
        <AbsoluteFill
          style={{
            backgroundColor: "rgba(255, 235, 210, " + flashBurn + ")",
            mixBlendMode: "screen",
          }}
        />
      )}
    </AbsoluteFill>
  );
};`,
  },
];

export function buildProceduralTransition(id: RemotionTransitionId): {
  code: string;
  componentName: string;
  compositionId: string;
  durationInFrames: number;
} {
  const match = REMOTION_TRANSITION_TEMPLATES.find((t) => t.id === id) || REMOTION_TRANSITION_TEMPLATES[0]!;
  return {
    code: match.code,
    componentName: match.componentName,
    compositionId: `${match.componentName}Comp`,
    durationInFrames: match.durationFrames,
  };
}



// ---------------------------------------------------------------------------
// Plantillas Prediseñadas para AI Motion Studio
// ---------------------------------------------------------------------------

export interface MotionPresetTemplate {
  id: string;
  label: string;
  category: "lower-third" | "title" | "data" | "callout" | "social" | "transition";
  badge: string;
  description: string;
  durationFrames: number;
  componentName: string;
  compositionId: string;
  defaultProps: Record<string, unknown>;
  code: string;
}

export const MOTION_PRESET_TEMPLATES: MotionPresetTemplate[] = [
  {
    id: "brand-identity-lower-third",
    label: "Rótulo Brand Kit (Cristal + SFX)",
    category: "lower-third",
    badge: "Brand Kit ⭐",
    description: "Rótulo de orador con degradados de cristal (backdropFilter: blur), avatar corporativo y sound design sincronizado.",
    durationFrames: 150,
    componentName: "BrandIdentityLowerThird",
    compositionId: "BrandIdentityLowerThird",
    defaultProps: {
      name: "Alex Rivera",
      role: "Especialista en Growth & Meta Ads",
      company: "BRAND KIT IA",
      handle: "@alexrivera.ai",
      initials: "AR",
      accentColor: "#10B981",
      accentSecondary: "#06B6D4",
      textColor: "#FFFFFF",
      bgOpacity: 0.85,
    },
    code: `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const BrandIdentityLowerThird = (props: {
  name?: string;
  role?: string;
  company?: string;
  handle?: string;
  initials?: string;
  accentColor?: string;
  accentSecondary?: string;
  textColor?: string;
  bgOpacity?: number;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const name = props.name ?? "Alex Rivera";
  const role = props.role ?? "Especialista en Growth & Meta Ads";
  const company = props.company ?? "BRAND KIT IA";
  const handle = props.handle ?? "@alexrivera.ai";
  const initials = props.initials ?? (name.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "AI");
  const accentColor = props.accentColor ?? "#10B981";
  const accentSecondary = props.accentSecondary ?? "#06B6D4";
  const textColor = props.textColor ?? "#FFFFFF";
  const bgOpacity = typeof props.bgOpacity === "number" ? props.bgOpacity : 0.85;

  const unit = Math.min(width, height);
  const isVertical = height > width;

  // Safe area adaptativa: en 9:16 (TikTok/Reels) sube al 22% para no tapar descripción ni botones nativos
  const bottomPad = isVertical ? height * 0.22 : height * 0.08;
  const leftPad = isVertical ? width * 0.06 : width * 0.06;

  // Física de animación con spring suave
  const enterSpring = spring({ frame, fps, config: { damping: 14, stiffness: 150, mass: 0.8 } });
  const exitFade = interpolate(frame, [125, 150], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const progress = Math.min(enterSpring, exitFade);

  // Efecto de barrido de luz (sheen / rayo de cristal)
  const sheenProgress = interpolate(frame, [10, 42], [-120, 220], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: "flex-end",
        alignItems: "flex-start",
        paddingBottom: bottomPad,
        paddingLeft: leftPad,
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: unit * 0.02,
          padding: (unit * 0.018) + "px " + (unit * 0.028) + "px",
          borderRadius: unit * 0.024,
          background: "linear-gradient(135deg, rgba(255,255,255," + (0.16 * bgOpacity) + ") 0%, rgba(15,23,42," + bgOpacity + ") 100%)",
          backdropFilter: "blur(24px) saturate(180%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
          border: "1px solid rgba(255,255,255,0.22)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.35)",
          maxWidth: isVertical ? width * 0.88 : width * 0.72,
          opacity: progress,
          transform: "translate3d(" + ((1 - progress) * -40) + "px, " + ((1 - progress) * 20) + "px, 0) scale(" + (0.92 + 0.08 * progress) + ")",
          overflow: "hidden",
        }}
      >
        {/* Rayo de luz de cristal (sheen reflex) */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: unit * 0.12,
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent)",
            transform: "translateX(" + sheenProgress + "%) skewX(-20deg)",
            pointerEvents: "none",
          }}
        />

        {/* Monograma / Avatar Brand Kit con halo neón */}
        <div
          style={{
            position: "relative",
            width: unit * 0.08,
            height: unit * 0.08,
            borderRadius: unit * 0.018,
            background: "linear-gradient(135deg, " + accentColor + " 0%, " + accentSecondary + " 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 8px 24px " + accentColor + "66",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
              fontWeight: 900,
              fontSize: unit * 0.034,
              color: "#0B120E",
              letterSpacing: "-0.04em",
            }}
          >
            {initials}
          </span>
          <div
            style={{
              position: "absolute",
              inset: -2,
              borderRadius: unit * 0.02,
              border: "1.5px solid rgba(255,255,255,0.45)",
            }}
          />
        </div>

        {/* Jerarquía de Información */}
        <div style={{ display: "flex", flexDirection: "column", gap: unit * 0.004 }}>
          {/* Fila superior: Badge corporativo + Handle */}
          <div style={{ display: "flex", alignItems: "center", gap: unit * 0.012 }}>
            <span
              style={{
                fontFamily: '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
                fontSize: Math.max(10, unit * 0.016),
                fontWeight: 800,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "#FFFFFF",
                background: "linear-gradient(90deg, " + accentColor + ", " + accentSecondary + ")",
                padding: "2px 8px",
                borderRadius: 999,
                boxShadow: "0 2px 8px " + accentColor + "44",
              }}
            >
              {company}
            </span>
            {handle ? (
              <span
                style={{
                  fontFamily: '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
                  fontSize: Math.max(10, unit * 0.017),
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.65)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {handle}
              </span>
            ) : null}
          </div>

          {/* Nombre del orador */}
          <div
            style={{
              fontFamily: '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
              fontSize: Math.max(16, unit * 0.044),
              fontWeight: 800,
              color: textColor,
              letterSpacing: "-0.025em",
              lineHeight: 1.15,
              textShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}
          >
            {name}
          </div>

          {/* Cargo o rol */}
          <div
            style={{
              fontFamily: '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
              fontSize: Math.max(11, unit * 0.022),
              fontWeight: 500,
              color: "rgba(255,255,255,0.85)",
              lineHeight: 1.2,
            }}
          >
            {role}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "editorial-lower-third",
    label: "Lower Third Editorial",
    category: "lower-third",
    badge: "Pro",
    description: "Tercio inferior limpio con barra de acento, nombre y cargo animados con spring.",
    durationFrames: 120,
    componentName: "EditorialLowerThird",
    compositionId: "EditorialLowerThird",
    defaultProps: {
      title: "Ana Torres",
      subtitle: "Directora Creativa · OECLIP",
      tag: "ENTREVISTA",
      accentColor: "#F59E0B",
      textColor: "#FFFFFF",
    },
    code: `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const EditorialLowerThird = (props: {
  title?: string;
  subtitle?: string;
  tag?: string;
  accentColor?: string;
  textColor?: string;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const title = props.title ?? "Ana Torres";
  const subtitle = props.subtitle ?? "Directora Creativa · OECLIP";
  const tag = props.tag ?? "ENTREVISTA";
  const accentColor = props.accentColor ?? "#F59E0B";
  const textColor = props.textColor ?? "#FFFFFF";

  const enter = spring({ frame, fps, config: { damping: 15, stiffness: 160, mass: 0.8 } });
  const exit = interpolate(frame, [95, 120], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const progress = Math.min(enter, exit);
  const unit = Math.min(width, height);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", padding: unit * 0.07 }}>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: unit * 0.016,
          backgroundColor: "rgba(12, 15, 19, 0.84)",
          backdropFilter: "blur(12px)",
          borderRadius: unit * 0.018,
          padding: (unit * 0.02) + "px " + (unit * 0.032) + "px",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
          opacity: progress,
          transform: "translateX(" + (1 - progress) * -60 + "px)",
        }}
      >
        <div
          style={{
            width: Math.max(5, unit * 0.006),
            borderRadius: 999,
            backgroundColor: accentColor,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: unit * 0.005 }}>
          {tag ? (
            <span
              style={{
                alignSelf: "flex-start",
                fontFamily: '"Inter", system-ui, sans-serif',
                fontSize: unit * 0.017,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#0C0F13",
                backgroundColor: accentColor,
                padding: "2px 8px",
                borderRadius: 6,
              }}
            >
              {tag}
            </span>
          ) : null}
          <div
            style={{
              fontFamily: '"Inter", system-ui, sans-serif',
              fontSize: unit * 0.042,
              fontWeight: 800,
              color: textColor,
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontFamily: '"Inter", system-ui, sans-serif',
              fontSize: unit * 0.024,
              fontWeight: 500,
              color: "rgba(255,255,255,0.74)",
              lineHeight: 1.2,
            }}
          >
            {subtitle}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "kinetic-hero-title",
    label: "Título Cinético Impacto",
    category: "title",
    badge: "Hero",
    description: "Titular central de alto impacto con píldora superior y subtítulo editorial.",
    durationFrames: 120,
    componentName: "KineticHeroTitle",
    compositionId: "KineticHeroTitle",
    defaultProps: {
      badge: "CAPÍTULO 01",
      title: "EL FUTURO DE LA EDICIÓN",
      subtitle: "Diseño asistido por inteligencia artificial en tiempo real",
      accentColor: "#4ADE80",
      textColor: "#FFFFFF",
    },
    code: `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const KineticHeroTitle = (props: {
  badge?: string;
  title?: string;
  subtitle?: string;
  accentColor?: string;
  textColor?: string;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const badge = props.badge ?? "CAPÍTULO 01";
  const title = props.title ?? "EL FUTURO DE LA EDICIÓN";
  const subtitle = props.subtitle ?? "Diseño asistido por inteligencia artificial en tiempo real";
  const accentColor = props.accentColor ?? "#4ADE80";
  const textColor = props.textColor ?? "#FFFFFF";

  const enter = spring({ frame, fps, config: { damping: 13, stiffness: 170, mass: 0.75 } });
  const subEnter = spring({ frame: Math.max(0, frame - 8), fps, config: { damping: 16, stiffness: 150 } });
  const exit = interpolate(frame, [95, 120], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          maxWidth: width * 0.84,
          gap: unit * 0.018,
          opacity: exit,
          transform: "scale(" + (0.9 + 0.1 * enter) + ")",
        }}
      >
        {badge ? (
          <span
            style={{
              fontFamily: '"Inter", system-ui, sans-serif',
              fontSize: unit * 0.022,
              fontWeight: 800,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "#0B120E",
              backgroundColor: accentColor,
              padding: (unit * 0.008) + "px " + (unit * 0.022) + "px",
              borderRadius: 999,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            }}
          >
            {badge}
          </span>
        ) : null}
        <div
          style={{
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: unit * 0.078,
            fontWeight: 900,
            color: textColor,
            lineHeight: 1.02,
            letterSpacing: "-0.03em",
            textShadow: "0 10px 32px rgba(0,0,0,0.65)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: unit * 0.03,
            fontWeight: 600,
            color: "rgba(255,255,255,0.85)",
            backgroundColor: "rgba(12, 15, 19, 0.65)",
            padding: (unit * 0.01) + "px " + (unit * 0.026) + "px",
            borderRadius: unit * 0.014,
            opacity: subEnter,
            transform: "translateY(" + (1 - subEnter) * 18 + "px)",
          }}
        >
          {subtitle}
        </div>
      </div>
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "animated-metric-card",
    label: "Contador KPI / Métrica",
    category: "data",
    badge: "Datos",
    description: "Tarjeta animada con contador numérico progresivo, unidad y barra de avance.",
    durationFrames: 120,
    componentName: "AnimatedMetricCard",
    compositionId: "AnimatedMetricCard",
    defaultProps: {
      label: "CRECIMIENTO MENSUAL",
      targetValue: 128,
      unit: "%",
      caption: "+42% respecto al trimestre anterior",
      accentColor: "#F59E0B",
      textColor: "#FFFFFF",
    },
    code: `import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const AnimatedMetricCard = (props: {
  label?: string;
  targetValue?: number;
  unit?: string;
  caption?: string;
  accentColor?: string;
  textColor?: string;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const label = props.label ?? "CRECIMIENTO MENSUAL";
  const targetValue = Number(props.targetValue ?? 128);
  const unitText = props.unit ?? "%";
  const caption = props.caption ?? "+42% respecto al trimestre anterior";
  const accentColor = props.accentColor ?? "#F59E0B";
  const textColor = props.textColor ?? "#FFFFFF";

  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 165 } });
  const exit = interpolate(frame, [95, 120], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const countProgress = interpolate(frame, [0, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const currentVal = Math.round(targetValue * countProgress);
  const unit = Math.min(width, height);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-end", padding: unit * 0.06 }}>
      <div
        style={{
          width: unit * 0.44,
          backgroundColor: "rgba(12, 16, 20, 0.88)",
          backdropFilter: "blur(14px)",
          borderRadius: unit * 0.024,
          padding: unit * 0.032,
          border: "1px solid rgba(255,255,255,0.14)",
          boxShadow: "0 20px 48px rgba(0,0,0,0.5)",
          opacity: Math.min(enter, exit),
          transform: "translateY(" + (1 - enter) * -30 + "px) scale(" + (0.94 + 0.06 * enter) + ")",
          fontFamily: '"Inter", system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: unit * 0.018, fontWeight: 800, letterSpacing: "0.12em", color: "rgba(255,255,255,0.65)" }}>
          {label}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginTop: unit * 0.008 }}>
          <span style={{ fontSize: unit * 0.095, fontWeight: 900, color: accentColor, lineHeight: 1, letterSpacing: "-0.03em" }}>
            {currentVal}
          </span>
          <span style={{ fontSize: unit * 0.045, fontWeight: 800, color: textColor }}>{unitText}</span>
        </div>
        <div
          style={{
            marginTop: unit * 0.016,
            height: Math.max(6, unit * 0.009),
            borderRadius: 999,
            backgroundColor: "rgba(255,255,255,0.14)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: (countProgress * 100).toFixed(1) + "%",
              height: "100%",
              backgroundColor: accentColor,
              borderRadius: 999,
            }}
          />
        </div>
        <div style={{ marginTop: unit * 0.012, fontSize: unit * 0.02, fontWeight: 500, color: "rgba(255,255,255,0.78)" }}>
          {caption}
        </div>
      </div>
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "social-cta-pill",
    label: "Píldora Call-To-Action",
    category: "social",
    badge: "Social",
    description: "Banner flotante animado para redes sociales, enlaces o recordatorios.",
    durationFrames: 105,
    componentName: "SocialCtaPill",
    compositionId: "SocialCtaPill",
    defaultProps: {
      handle: "@oeclip.ai",
      actionText: "Síguenos para más tutoriales",
      accentColor: "#38BDF8",
      textColor: "#FFFFFF",
    },
    code: `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const SocialCtaPill = (props: {
  handle?: string;
  actionText?: string;
  accentColor?: string;
  textColor?: string;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const handle = props.handle ?? "@oeclip.ai";
  const actionText = props.actionText ?? "Síguenos para más tutoriales";
  const accentColor = props.accentColor ?? "#38BDF8";
  const textColor = props.textColor ?? "#FFFFFF";

  const enter = spring({ frame, fps, config: { damping: 12, stiffness: 180, mass: 0.7 } });
  const exit = interpolate(frame, [82, 105], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: unit * 0.06 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: unit * 0.016,
          backgroundColor: "rgba(12, 15, 20, 0.88)",
          backdropFilter: "blur(12px)",
          padding: (unit * 0.012) + "px " + (unit * 0.026) + "px",
          borderRadius: 999,
          border: "1.5px solid " + accentColor,
          boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          opacity: Math.min(enter, exit),
          transform: "translateY(" + (1 - enter) * -28 + "px) scale(" + (0.9 + 0.1 * enter) + ")",
          fontFamily: '"Inter", system-ui, sans-serif',
        }}
      >
        <span
          style={{
            backgroundColor: accentColor,
            color: "#090D12",
            fontWeight: 800,
            fontSize: unit * 0.022,
            padding: "4px 12px",
            borderRadius: 999,
          }}
        >
          {handle}
        </span>
        <span style={{ color: textColor, fontWeight: 600, fontSize: unit * 0.023 }}>
          {actionText}
        </span>
      </div>
    </AbsoluteFill>
  );
};`,
  },
  {
    id: "whip-pan-transition",
    label: "Transición Whip Pan",
    category: "transition",
    badge: "0ms · 4K",
    description: "Barrido veloz de cámara con motion blur direccional y líneas cinéticas.",
    durationFrames: 24,
    componentName: "WhipPanTransition",
    compositionId: "WhipPanTransitionComp",
    defaultProps: { direction: "left" },
    code: REMOTION_TRANSITION_TEMPLATES[0]!.code,
  },
  {
    id: "zoom-punch-transition",
    label: "Transición Zoom Punch",
    category: "transition",
    badge: "0ms · Impacto",
    description: "Golpe de zoom elástico con onda expansiva SVG y flash óptico de impacto.",
    durationFrames: 20,
    componentName: "ZoomPunchTransition",
    compositionId: "ZoomPunchTransitionComp",
    defaultProps: {},
    code: REMOTION_TRANSITION_TEMPLATES[1]!.code,
  },
  {
    id: "glitch-svg-transition",
    label: "Transición Glitch Digital SVG",
    category: "transition",
    badge: "0ms · Vector",
    description: "Distorsión cromática RGB con desplazamiento de píxeles y líneas de escaneo CRT.",
    durationFrames: 22,
    componentName: "GlitchSvgTransition",
    compositionId: "GlitchSvgTransitionComp",
    defaultProps: {},
    code: REMOTION_TRANSITION_TEMPLATES[2]!.code,
  },
  {
    id: "light-leak-transition",
    label: "Transición Light Leak Analógico",
    category: "transition",
    badge: "0ms · 35mm",
    description: "Quemadura de película cálida 35mm con destellos analógicos y gradientes radiales.",
    durationFrames: 28,
    componentName: "LightLeakTransition",
    compositionId: "LightLeakTransitionComp",
    defaultProps: {},
    code: REMOTION_TRANSITION_TEMPLATES[3]!.code,
  },
];

// ---------------------------------------------------------------------------
// Introspección y edición en vivo de Props para el Inspector (CapCut Style)
// ---------------------------------------------------------------------------

export interface EditableRemotionField {
  key: string;
  label: string;
  type: "text" | "color" | "number";
  value: string | number;
  min?: number;
  max?: number;
  step?: number;
  /** Si el valor proviene de un literal en el código TSX (cuando el LLM no usó props) */
  isCodeLiteral?: boolean;
  originalLiteral?: string;
}

const INTERNAL_PROP_KEYS = new Set([
  "width",
  "height",
  "fps",
  "durationInFrames",
  "captions",
  "offset",
]);

const PRETTY_LABELS: Record<string, string> = {
  name: "Nombre del orador",
  role: "Cargo o rol profesional",
  company: "Empresa / Marca",
  initials: "Iniciales de avatar",
  title: "Título principal",
  subtitle: "Subtítulo",
  tag: "Etiqueta / Categoría",
  badge: "Insignia superior",
  label: "Etiqueta",
  caption: "Nota / Pie",
  handle: "Usuario / Canal",
  actionText: "Texto de acción",
  targetValue: "Valor objetivo",
  value: "Valor",
  unit: "Unidad",
  accentColor: "Color de acento",
  accentSecondary: "Color de acento secundario",
  primaryColor: "Color primario",
  secondaryColor: "Color secundario",
  textColor: "Color de texto",
  backgroundColor: "Color de fondo",
  fontScale: "Escala de fuente",
  positionY: "Posición vertical",
  bgOpacity: "Opacidad de fondo",
};

function humanizePropKey(key: string): string {
  if (PRETTY_LABELS[key]) return PRETTY_LABELS[key]!;
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

/**
 * Extrae las propiedades editables de un `RemotionComponentSpec`:
 * 1. Lee `remotion.props` explícitos.
 * 2. Lee valores por defecto en el destructuring o `props.xxx ?? "valor"` del código TSX.
 * 3. Si es un componente generado por IA con textos/colores literales en el código,
 *    también los expone para que el usuario pueda editarlos sin re-promptear.
 */
export function extractEditableFields(remotion: RemotionComponentSpec): EditableRemotionField[] {
  const fields: EditableRemotionField[] = [];
  const seenKeys = new Set<string>();
  const props = remotion.props ?? {};

  const addField = (
    key: string,
    rawVal: unknown,
    extra?: Partial<EditableRemotionField>,
  ) => {
    if (INTERNAL_PROP_KEYS.has(key) || seenKeys.has(key)) return;
    if (typeof rawVal === "string") {
      seenKeys.add(key);
      fields.push({
        key,
        label: humanizePropKey(key),
        type: isHexColor(rawVal) || /color/i.test(key) ? "color" : "text",
        value: isHexColor(rawVal) ? rawVal.toUpperCase() : rawVal,
        ...extra,
      });
    } else if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
      seenKeys.add(key);
      const isNormalized = rawVal >= 0 && rawVal <= 2 && /scale|opacity|position/i.test(key);
      fields.push({
        key,
        label: humanizePropKey(key),
        type: "number",
        value: rawVal,
        min: isNormalized ? 0 : 0,
        max: isNormalized ? (key === "fontScale" ? 2 : 1) : Math.max(100, rawVal * 3),
        step: isNormalized ? 0.02 : 1,
        ...extra,
      });
    }
  };

  // 1. Propiedades ya presentes en remotion.props
  for (const [key, value] of Object.entries(props)) {
    addField(key, value);
  }

  // 2. Patrones `props.foo ?? "bar"` o `props.foo || "bar"` en el código TSX
  const code = remotion.code || "";
  const nullishPattern = /props\.([a-zA-Z0-9_]+)\s*(?:\?\?|\|\|)\s*(?:"([^"\n]{1,140})"|'([^'\n]{1,140})'|(-?\d+(?:\.\d+)?))/g;
  for (const match of code.matchAll(nullishPattern)) {
    const key = match[1]!;
    const strVal = match[2] ?? match[3];
    const numVal = match[4];
    if (strVal !== undefined) addField(key, strVal);
    else if (numVal !== undefined) addField(key, Number(numVal));
  }

  // 3. Patrones de destructuring `({ title = "Hola", color = "#FF0000" })`
  const defaultParamPattern = /\b([a-zA-Z0-9_]+)\s*=\s*(?:"([^"\n]{1,140})"|'([^'\n]{1,140})'|(-?\d+(?:\.\d+)?))/g;
  for (const match of code.matchAll(defaultParamPattern)) {
    const key = match[1]!;
    if (["frame", "fps", "width", "height", "local", "duration", "index", "unit"].includes(key)) continue;
    const strVal = match[2] ?? match[3];
    const numVal = match[4];
    if (strVal !== undefined && !strVal.includes("{") && !strVal.includes("px")) {
      addField(key, strVal);
    } else if (numVal !== undefined && /value|count|target|number|year|price/i.test(key)) {
      addField(key, Number(numVal));
    }
  }

  // 4. Si no es de subtítulos y todavía hay pocos campos de texto/color, extraer constantes y textos JSX del código IA
  const isSubtitle = Array.isArray(props.captions);
  if (!isSubtitle && fields.filter((f) => f.type === "text").length === 0) {
    let textIdx = 1;
    const jsxTextPattern = />\s*([^<>{}\n]{2,90}?)\s*</g;
    for (const match of code.matchAll(jsxTextPattern)) {
      const candidate = (match[1] ?? "").trim();
      if (
        !candidate ||
        /^[0-9.,%+\-*/\s]+$/.test(candidate) ||
        /^(div|span|p|h1|h2|h3|svg|path|return|const|let)$/i.test(candidate)
      ) {
        continue;
      }
      const key = `__jsx_text_${textIdx}`;
      if (!seenKeys.has(key) && textIdx <= 5) {
        seenKeys.add(key);
        fields.push({
          key,
          label: `Texto en pantalla ${textIdx}`,
          type: "text",
          value: candidate,
          isCodeLiteral: true,
          originalLiteral: candidate,
        });
        textIdx += 1;
      }
    }
  }

  if (!isSubtitle && fields.filter((f) => f.type === "color").length === 0) {
    const hexMatches = [...new Set((code.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toUpperCase()))];
    hexMatches.slice(0, 4).forEach((hex, idx) => {
      const key = `__hex_color_${idx + 1}`;
      seenKeys.add(key);
      fields.push({
        key,
        label: idx === 0 ? "Color principal" : `Color de acento ${idx}`,
        type: "color",
        value: hex,
        isCodeLiteral: true,
        originalLiteral: hex,
      });
    });
  }

  return fields;
}

/**
 * Aplica el cambio de un campo editable sobre `RemotionComponentSpec`,
 * actualizando `props` o el literal en `code` y activando `live: true`.
 */
export function applyEditableFieldChange(
  remotion: RemotionComponentSpec,
  field: EditableRemotionField,
  newValue: string | number,
): RemotionComponentSpec {
  let nextCode = remotion.code;
  const nextProps: Record<string, unknown> = { ...(remotion.props ?? {}) };

  if (field.isCodeLiteral && field.originalLiteral && typeof newValue === "string") {
    if (field.type === "color") {
      const regex = new RegExp(field.originalLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      nextCode = nextCode.replace(regex, newValue);
    } else {
      const escaped = field.originalLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const jsxRegex = new RegExp(`(>\\s*)${escaped}(\\s*<)`, "g");
      nextCode = nextCode.replace(jsxRegex, `$1${newValue}$2`);
    }
  } else {
    nextProps[field.key] = newValue;
  }

  return {
    ...remotion,
    code: nextCode,
    props: nextProps,
    live: true,
  };
}
