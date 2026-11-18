import type { TextClip } from "./schema";

export type FontFamily = "inter" | "grandstander" | "anton" | "bebas" | "playfair" | "space-grotesk";
export type TextTransform = "none" | "upper" | "lower";

export interface SubtitleStyle {
  id: string;
  label: string;
  description: string;
  fontFamily: FontFamily;
  fontWeight: TextClip["fontWeight"];
  fontSize: number;
  color: string;
  textTransform: TextTransform;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundPadding: number;
  strokeWidth: number;
  strokeColor: string;
  shadow: number;
  shadowColor: string;
  position: { x: number; y: number };
  align: "left" | "center" | "right";
  maxWidth: number;
  lineHeight: number;
}

/** Familias disponibles en el visor y en FFmpeg. */
export const FONT_FAMILIES: Array<{ id: FontFamily; label: string; css: string; file: string; charsPerEm: number }> = [
  {
    id: "inter",
    label: "Inter",
    css: 'Inter, "Segoe UI", sans-serif',
    file: "Inter-Variable.ttf",
    charsPerEm: 0.52,
  },
  {
    id: "grandstander",
    label: "Grandstander",
    css: 'Grandstander, Inter, "Segoe UI", sans-serif',
    file: "Grandstander-Variable.ttf",
    charsPerEm: 0.56,
  },
  {
    id: "anton",
    label: "Anton",
    css: 'Anton, "Arial Narrow", Impact, sans-serif',
    file: "Anton-Regular.ttf",
    charsPerEm: 0.43,
  },
  {
    id: "bebas",
    label: "Bebas Neue",
    css: '"Bebas Neue", "Arial Narrow", Impact, sans-serif',
    file: "BebasNeue-Regular.ttf",
    charsPerEm: 0.4,
  },
  {
    id: "playfair",
    label: "Playfair",
    css: '"Playfair Display", Georgia, serif',
    file: "PlayfairDisplay-Variable.ttf",
    charsPerEm: 0.5,
  },
  {
    id: "space-grotesk",
    label: "Space Grotesk",
    css: '"Space Grotesk", Inter, "Segoe UI", sans-serif',
    file: "SpaceGrotesk-Variable.ttf",
    charsPerEm: 0.53,
  },
];

export function fontFamily(id: string | undefined): (typeof FONT_FAMILIES)[number] {
  return FONT_FAMILIES.find((item) => item.id === id) ?? FONT_FAMILIES[0]!;
}

export function subtitleColorFromText(text: string): string | undefined {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/blanc/.test(normalized)) return "#FFFFFF";
  if (/rojo|roja|rojos|rojas/.test(normalized)) return "#FF3030";
  if (/amarill/.test(normalized)) return "#FFD44A";
  if (/azul|celeste|cian|turquesa/.test(normalized)) return "#38BDF8";
  if (/verde/.test(normalized)) return "#22C55E";
  if (/negro|negra/.test(normalized)) return "#111111";
  if (/morado|purpura|lila/.test(normalized)) return "#A855F7";
  if (/naranja/.test(normalized)) return "#F97316";
  if (/rosa/.test(normalized)) return "#EC4899";
  if (/gris/.test(normalized)) return "#D1D5DB";
  return undefined;
}

const BASE = {
  position: { x: 0.5, y: 0.86 },
  align: "center" as const,
  maxWidth: 0.82,
  lineHeight: 1.25,
  background: false,
  backgroundColor: "#101813",
  backgroundOpacity: 0.72,
  backgroundPadding: 16,
  strokeWidth: 0,
  strokeColor: "#000000",
  shadow: 6,
  shadowColor: "#000000",
  textTransform: "none" as TextTransform,
};

export const SUBTITLE_STYLES: SubtitleStyle[] = [
  {
    ...BASE,
    id: "clean",
    label: "Limpio",
    description: "Inter blanca con sombra suave. Legible en cualquier fondo.",
    fontFamily: "inter",
    fontWeight: 600,
    fontSize: 52,
    color: "#FFFFFF",
    maxWidth: 0.84,
    lineHeight: 1.28,
    shadow: 8,
  },
  {
    ...BASE,
    id: "impact",
    label: "Impacto",
    description: "Mayúsculas amarillas con contorno negro. Energía de directo.",
    fontFamily: "anton",
    fontWeight: 400,
    fontSize: 62,
    color: "#FFD44A",
    textTransform: "upper",
    strokeWidth: 8,
    strokeColor: "#0B0B0B",
    shadow: 6,
    maxWidth: 0.86,
    lineHeight: 1.12,
  },
  {
    ...BASE,
    id: "card",
    label: "Tarjeta",
    description: "Caja oscura redondeada con texto blanco. Estilo documental.",
    fontFamily: "inter",
    fontWeight: 600,
    fontSize: 46,
    color: "#FFFFFF",
    background: true,
    backgroundColor: "#101813",
    backgroundOpacity: 0.76,
    backgroundPadding: 22,
    maxWidth: 0.78,
    lineHeight: 1.3,
    shadow: 0,
  },
  {
    ...BASE,
    id: "viral",
    label: "Viral",
    description: "Mayúsculas blancas sobre caja negra. El clásico de TikTok y Reels.",
    fontFamily: "inter",
    fontWeight: 900,
    fontSize: 54,
    color: "#FFFFFF",
    textTransform: "upper",
    background: true,
    backgroundColor: "#000000",
    backgroundOpacity: 0.9,
    backgroundPadding: 15,
    maxWidth: 0.74,
    lineHeight: 1.16,
    shadow: 0,
  },
  {
    ...BASE,
    id: "neon",
    label: "Neón",
    description: "Menta luminosa con brillo verde. Para música y gaming.",
    fontFamily: "grandstander",
    fontWeight: 700,
    fontSize: 54,
    color: "#C9FFE8",
    strokeWidth: 2,
    strokeColor: "#0B3B2E",
    shadow: 22,
    shadowColor: "#25F5B0",
    maxWidth: 0.8,
    lineHeight: 1.2,
  },
  {
    ...BASE,
    id: "cinema",
    label: "Cine",
    description: "Bebas Neue condensada con contorno. Tráiler y deporte.",
    fontFamily: "bebas",
    fontWeight: 400,
    fontSize: 68,
    color: "#FFFFFF",
    textTransform: "upper",
    strokeWidth: 4,
    strokeColor: "#000000",
    shadow: 4,
    maxWidth: 0.84,
    lineHeight: 1.06,
  },
  {
    ...BASE,
    id: "editorial",
    label: "Editorial",
    description: "Playfair con aire de revista. Entrevistas y marca personal.",
    fontFamily: "playfair",
    fontWeight: 600,
    fontSize: 48,
    color: "#FFF4DE",
    shadow: 12,
    maxWidth: 0.74,
    lineHeight: 1.22,
  },
  {
    ...BASE,
    id: "highlight",
    label: "Resaltado",
    description: "Texto oscuro sobre bloque lima. Alto contraste y moderno.",
    fontFamily: "inter",
    fontWeight: 700,
    fontSize: 46,
    color: "#102015",
    textTransform: "upper",
    background: true,
    backgroundColor: "#E8FF6A",
    backgroundOpacity: 1,
    backgroundPadding: 17,
    maxWidth: 0.72,
    lineHeight: 1.2,
    shadow: 0,
  },
  {
    ...BASE,
    id: "minimal",
    label: "Minimal",
    description: "Inter fina y discreta. Documental y lifestyle.",
    fontFamily: "inter",
    fontWeight: 500,
    fontSize: 40,
    color: "#FFFFFF",
    shadow: 4,
    maxWidth: 0.68,
    lineHeight: 1.35,
  },
  {
    ...BASE,
    id: "modern",
    label: "Moderno",
    description: "Space Grotesk geométrica con peso marcado y lectura limpia.",
    fontFamily: "space-grotesk",
    fontWeight: 700,
    fontSize: 54,
    color: "#FFFFFF",
    strokeWidth: 2,
    strokeColor: "#14251D",
    shadow: 8,
    maxWidth: 0.82,
  },
  {
    ...BASE,
    id: "real-estate",
    label: "Real Estate",
    description: "Anton grande, amarillo de alto contraste y rebote breve por frase.",
    fontFamily: "anton",
    fontWeight: 400,
    fontSize: 70,
    color: "#FFD44A",
    textTransform: "upper",
    strokeWidth: 8,
    strokeColor: "#111111",
    shadow: 8,
    maxWidth: 0.9,
    lineHeight: 1.08,
  },
  {
    ...BASE,
    id: "phrase-highlight",
    label: "Frase resaltada",
    description: "Bloque lima de lectura rápida para destacar cada frase.",
    fontFamily: "space-grotesk",
    fontWeight: 700,
    fontSize: 58,
    color: "#102015",
    background: true,
    backgroundColor: "#E8FF6A",
    backgroundOpacity: 1,
    backgroundPadding: 20,
    shadow: 0,
    maxWidth: 0.86,
    lineHeight: 1.12,
  },
  {
    ...BASE,
    id: "clean-pop",
    label: "Moderno Pop",
    description: "Space Grotesk blanca con contorno y entrada de zoom discreta.",
    fontFamily: "space-grotesk",
    fontWeight: 700,
    fontSize: 58,
    color: "#FFFFFF",
    strokeWidth: 3,
    strokeColor: "#14251D",
    shadow: 8,
    maxWidth: 0.86,
    lineHeight: 1.12,
  },
];

export function subtitleStyle(id: string | undefined): SubtitleStyle {
  return SUBTITLE_STYLES.find((style) => style.id === id) ?? SUBTITLE_STYLES[0]!;
}

/** Aplica un preset conservando el contenido y el tiempo del clip. */
export function withSubtitleStyle(clip: TextClip, styleId: string): TextClip {
  const style = subtitleStyle(styleId);
  return {
    ...clip,
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontSize: style.fontSize,
    color: style.color,
    textTransform: style.textTransform,
    background: style.background,
    backgroundColor: style.backgroundColor,
    backgroundOpacity: style.backgroundOpacity,
    backgroundPadding: style.backgroundPadding,
    strokeWidth: style.strokeWidth,
    strokeColor: style.strokeColor,
    shadow: style.shadow,
    shadowColor: style.shadowColor,
    align: style.align,
    maxWidth: style.maxWidth,
    lineHeight: style.lineHeight,
  };
}

/** Contraste WCAG entre dos colores hex (#RRGGBB). */
function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function colorContrast(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Garantiza que un subtítulo se pueda leer. Si el color pedido no contrasta con
 * su fondo (rojo sobre lima, por ejemplo) se sustituye por negro o blanco.
 * Devuelve también si hubo corrección para poder avisar en el resumen.
 */
export function ensureReadableText(clip: TextClip): { clip: TextClip; adjusted: boolean } {
  if (!clip.background) return { clip, adjusted: false };
  if (colorContrast(clip.color, clip.backgroundColor) >= 4.5) {
    return { clip, adjusted: false };
  }
  const dark = "#0B0F0C";
  const light = "#FFFFFF";
  const replacement =
    colorContrast(dark, clip.backgroundColor) >= colorContrast(light, clip.backgroundColor) ? dark : light;
  return { clip: { ...clip, color: replacement }, adjusted: true };
}

/** Texto tal y como se dibuja (mayúsculas/minúsculas). */
export function transformText(text: string, transform: TextTransform | undefined): string {
  if (transform === "upper") return text.toLocaleUpperCase("es-ES");
  if (transform === "lower") return text.toLocaleLowerCase("es-ES");
  return text;
}
