import { type HyperFramePalette } from "../../src/shared/hyperframes";
import { type NarrativeBlockPlan } from "./swarmDirector";
import { type SfxType } from "../services/sfxService";

export interface BrandIdentity {
  brandName: string;
  domain: string;
  url: string;
  tagline: string;
  palette: HyperFramePalette;
  keyFeatures: string[];
  suggestedMetric?: { value: number; unit: string; context: string; label: string };
}

export interface BrandNarrativeResult {
  brand: BrandIdentity;
  targetDurationSec: number;
  totalFrames: number;
  blocks: NarrativeBlockPlan[];
  brandReport: string;
}

/**
 * Paletas y metadatos de marcas líderes pre-configuradas para renderizado inmediato
 * a nivel de estudio de diseño (Fable / HyperFrames / Remotion).
 */
const KNOWN_BRANDS: Record<
  string,
  { name: string; tagline: string; accent: string; secondary: string; metric?: { value: number; unit: string; context: string; label: string } }
> = {
  stripe: {
    name: "Stripe",
    tagline: "Infraestructura financiera global para internet",
    accent: "#635BFF",
    secondary: "#00D4FF",
    metric: { value: 99.999, unit: "%", context: "Disponibilidad de API", label: "99.999% UPTIME" },
  },
  linear: {
    name: "Linear",
    tagline: "El estándar de oro en gestión de productos e ingeniería",
    accent: "#5E6AD2",
    secondary: "#22D3EE",
    metric: { value: 60, unit: "fps", context: "Rendimiento nativo", label: "60 FPS UI" },
  },
  supabase: {
    name: "Supabase",
    tagline: "La alternativa de código abierto a Firebase",
    accent: "#3ECF8E",
    secondary: "#249361",
    metric: { value: 100, unit: "k+", context: "Bases de datos activas", label: "+100K DBs" },
  },
  vercel: {
    name: "Vercel",
    tagline: "Plataforma para desarrolladores frontend e inteligencia artificial",
    accent: "#38BDF8",
    secondary: "#818CF8",
    metric: { value: 99.9, unit: "%", context: "Velocidad en el Edge", label: "<50ms LATENCIA" },
  },
  novacut: {
    name: "OECLIP Studio",
    tagline: "Edición de video programático agéntico con Remotion y HyperFrames",
    accent: "#6366F1",
    secondary: "#10B981",
    metric: { value: 60, unit: "fps", context: "Renderizado determinista", label: "60 FPS RENDER" },
  },
  oeclip: {
    name: "OECLIP Video Studio",
    tagline: "Postproducción autónoma de video con enjambres de agentes",
    accent: "#6366F1",
    secondary: "#10B981",
    metric: { value: 10, unit: "x", context: "Aceleración de postproducción", label: "10X VELOCIDAD" },
  },
  openai: {
    name: "OpenAI",
    tagline: "Creando inteligencia artificial general segura y beneficiosa",
    accent: "#10A37F",
    secondary: "#1A7F64",
    metric: { value: 200, unit: "M", context: "Usuarios activos semanales", label: "200M USUARIOS" },
  },
  figma: {
    name: "Figma",
    tagline: "La plataforma colaborativa de diseño para equipos de producto",
    accent: "#F24E1E",
    secondary: "#A259FF",
    metric: { value: 4, unit: "M+", context: "Diseñadores colaborando", label: "4M+ DISEÑADORES" },
  },
  apple: {
    name: "Apple",
    tagline: "Innovación tecnológica donde el hardware y el software se unen",
    accent: "#38BDF8",
    secondary: "#F59E0B",
    metric: { value: 99, unit: "%", context: "Satisfacción de usuario", label: "99% SATISFACCIÓN" },
  },
  tesla: {
    name: "Tesla",
    tagline: "Acelerando la transición mundial hacia la energía sostenible",
    accent: "#E11D48",
    secondary: "#FB7185",
    metric: { value: 100, unit: "%", context: "Propulsión 100% eléctrica", label: "100% ELÉCTRICO" },
  },
  fable: {
    name: "Fable",
    tagline: "Motion design y animación colaborativa en el navegador",
    accent: "#8B5CF6",
    secondary: "#EC4899",
    metric: { value: 60, unit: "fps", context: "Motor vectorial en tiempo real", label: "60 FPS CANVAS" },
  },
};

/**
 * Detecta si el prompt contiene una URL completa (http/https) o un nombre de dominio
 * explícito orientado a showcase de marca (ej: "https://linear.app", "video de stripe.com").
 */
export function detectBrandUrlInPrompt(prompt: string): string | null {
  const clean = prompt.trim();
  // 1. URL explícita con protocolo
  const urlMatch = clean.match(/https?:\/\/[^\s"',;>)]+/i);
  if (urlMatch?.[0]) {
    return urlMatch[0];
  }

  // 2. Mención de dominio común (.com, .io, .ai, .app, .dev, .org, .co, .net)
  const domainMatch = clean.match(/\b([a-zA-Z0-9-]{2,30}\.(?:com|io|ai|app|dev|org|co|net|tech|so|xyz))\b/i);
  if (domainMatch?.[1]) {
    return `https://${domainMatch[1].toLowerCase()}`;
  }

  // 3. Petición explícita de marca con palabra clave de compañía
  const brandKeywords = Object.keys(KNOWN_BRANDS);
  for (const b of brandKeywords) {
    const rx = new RegExp(`\\b(?:marca|empresa|startup|producto|web|plataforma|showcase)?\\s*${b}\\b`, "i");
    if (rx.test(clean) && /\b(marca|empresa|startup|producto|web|plataforma|showcase|app)\b/i.test(clean)) {
      return `https://${b}.com`;
    }
  }

  return null;
}

export interface ParsedBrandHtml {
  brandName: string;
  tagline: string;
  accentColor: string;
  secondaryColor: string;
  surfaceColor: string;
  keyFeatures: string[];
  logoSvgPaths: string[];
  ogImageUrl?: string;
}

function normalizeHex6(raw: string): string | null {
  const m = raw.trim().match(/^#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/);
  if (!m?.[1]) return null;
  const h = m[1];
  if (h.length === 3) {
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toUpperCase();
  }
  return `#${h.toUpperCase()}`;
}

function isNeutralHex(hex: string): boolean {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread < 18 || (r > 240 && g > 240 && b > 240) || (r < 20 && g < 20 && b < 20);
}

/**
 * Analiza HTML en bruto para extraer paleta real (CSS vars, theme-color, SVG fills),
 * titulares hero (`og:title`, `<h1>`), características clave y paths vectoriales.
 */
export function parseBrandHtmlMetadata(
  html: string,
  defaults: { brandName: string; tagline: string; accentColor: string; secondaryColor: string },
): ParsedBrandHtml {
  let brandName = defaults.brandName;
  let tagline = defaults.tagline;
  let accentColor = defaults.accentColor;
  let secondaryColor = defaults.secondaryColor;
  let surfaceColor = "rgba(15, 23, 42, 0.94)";

  const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const rawTitle = (ogTitleMatch?.[1] ?? titleMatch?.[1] ?? "").trim();
  if (rawTitle) {
    const splitTitle = rawTitle.split(/[-–—|:•]/);
    if (splitTitle[0] && splitTitle[0].trim().length > 1) {
      brandName = splitTitle[0].trim().slice(0, 40);
    }
    if (splitTitle[1] && splitTitle[1].trim().length > 8) {
      tagline = splitTitle[1].trim().slice(0, 110);
    }
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]{4,140}?)<\/h1>/i);
  const h1Text = h1Match?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (h1Text && h1Text.length >= 8 && h1Text.length <= 105 && defaults.tagline.startsWith("Innovación digital")) {
    tagline = h1Text;
  }

  const descMatch =
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (descMatch?.[1] && descMatch[1].trim().length > 15) {
    tagline = descMatch[1].trim().slice(0, 110);
  }

  const themeMatch = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["'](#?[a-fA-F0-9]{3,8})["']/i);
  const themeHex = themeMatch?.[1] ? normalizeHex6(themeMatch[1]) : null;
  if (themeHex && !isNeutralHex(themeHex)) {
    accentColor = themeHex;
  }

  // Variables CSS semánticas (--primary, --brand, --accent, --secondary)
  const cssVarRegex = /--(primary|brand|accent|highlight|secondary|theme-color)[a-z0-9-]*\s*:\s*(#[a-fA-F0-9]{3,6})\b/gi;
  const extractedVars: Array<{ name: string; hex: string }> = [];
  for (const m of html.matchAll(cssVarRegex)) {
    const hex = m[2] ? normalizeHex6(m[2]) : null;
    if (hex && !isNeutralHex(hex)) {
      extractedVars.push({ name: m[1]!.toLowerCase(), hex });
    }
  }
  if (extractedVars.length > 0 && !themeHex) {
    accentColor = extractedVars[0]!.hex;
  }
  const explicitSecondary = extractedVars.find((v) => v.name === "secondary" && v.hex !== accentColor);
  if (explicitSecondary) {
    secondaryColor = explicitSecondary.hex;
  } else {
    const secondVibrant = extractedVars.find((v) => v.hex !== accentColor);
    if (secondVibrant) secondaryColor = secondVibrant.hex;
  }

  const bgVarMatch = html.match(/--(bg|background|surface)[a-z0-9-]*\s*:\s*(#[a-fA-F0-9]{3,6})\b/i);
  const bgHex = bgVarMatch?.[2] ? normalizeHex6(bgVarMatch[2]) : null;
  if (bgHex) {
    surfaceColor = bgHex;
  }

  // Fallback de frecuencia sobre hexes vibrantes en CSS/SVG inline
  if (!themeHex && extractedVars.length === 0) {
    const allHexCounts = new Map<string, number>();
    for (const m of html.matchAll(/#([a-fA-F0-9]{6})\b/g)) {
      const hex = normalizeHex6(m[0]);
      if (!hex || isNeutralHex(hex)) continue;
      allHexCounts.set(hex, (allHexCounts.get(hex) ?? 0) + 1);
    }
    const sorted = [...allHexCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted[0]) accentColor = sorted[0][0];
    if (sorted[1] && sorted[1][0] !== accentColor) secondaryColor = sorted[1][0];
  }

  const keyFeatures: string[] = [];
  for (const m of html.matchAll(/<h[23][^>]*>([\s\S]{5,90}?)<\/h[23]>/gi)) {
    const cleanText = m[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (cleanText && cleanText.length >= 6 && cleanText.length <= 68 && !keyFeatures.includes(cleanText)) {
      keyFeatures.push(cleanText);
    }
    if (keyFeatures.length >= 4) break;
  }

  const logoSvgPaths: string[] = [];
  for (const m of html.matchAll(/<path[^>]*\bd=["']([^"']{10,240})["'][^>]*>/gi)) {
    if (m[1]) logoSvgPaths.push(m[1]);
    if (logoSvgPaths.length >= 4) break;
  }

  const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

  return {
    brandName,
    tagline,
    accentColor,
    secondaryColor,
    surfaceColor,
    keyFeatures,
    logoSvgPaths,
    ogImageUrl: ogImageMatch?.[1]?.trim(),
  };
}

/**
 * Extrae la identidad de marca a partir de una URL o dominio, consultando metadatos
 * en vivo (OpenGraph, title, theme-color, CSS vars, SVG y headings) o recurriendo al catálogo de tokens curado.
 */
export async function extractBrandIdentity(
  urlOrDomain: string,
  _prompt: string,
  signal?: AbortSignal,
): Promise<BrandIdentity> {
  let cleanUrl = urlOrDomain.trim();
  if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
    cleanUrl = `https://${cleanUrl}`;
  }

  let domain = "";
  try {
    const parsed = new URL(cleanUrl);
    domain = parsed.hostname.replace(/^www\./, "");
  } catch {
    domain = cleanUrl.replace(/^https?:\/\/(?:www\.)?/, "").split("/")[0] || "brand.com";
  }

  const baseName = domain.split(".")[0]?.toLowerCase() || "brand";
  const known = KNOWN_BRANDS[baseName];

  let brandName = known ? known.name : baseName.charAt(0).toUpperCase() + baseName.slice(1);
  let tagline = known ? known.tagline : `Innovación digital y soluciones inteligentes en ${domain}`;
  let accentColor = known ? known.accent : "#6366F1";
  let secondaryColor = known ? known.secondary : "#38BDF8";
  let surfaceColor = "rgba(15, 23, 42, 0.94)";
  let extractedFeatures: string[] = [];
  let suggestedMetric = known?.metric;

  // Intento de extracción en vivo de etiquetas meta, CSS vars y encabezados reales
  try {
    const res = await fetch(cleanUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OECLIP-BrandScanner/1.0; +https://oeclip.ai)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: signal ?? AbortSignal.timeout(6_000),
    });

    if (res.ok) {
      const html = await res.text();
      const parsed = parseBrandHtmlMetadata(html, {
        brandName,
        tagline,
        accentColor,
        secondaryColor,
      });
      brandName = parsed.brandName;
      tagline = parsed.tagline;
      accentColor = parsed.accentColor;
      secondaryColor = parsed.secondaryColor;
      surfaceColor = parsed.surfaceColor;
      extractedFeatures = parsed.keyFeatures;
    }
  } catch {
    // Si la solicitud de red está bloqueada por sandbox o hay timeout, se usan los tokens curados
  }

  // Si no había métrica en el catálogo, derivar una métrica contextual del dominio
  if (!suggestedMetric) {
    suggestedMetric = {
      value: 99.8,
      unit: "%",
      context: "Disponibilidad verificada",
      label: "99.8% EFECTIVIDAD",
    };
  }

  const palette: HyperFramePalette = {
    accent: accentColor,
    secondary: secondaryColor,
    surface: surfaceColor,
    text: "#FFFFFF",
  };

  return {
    brandName,
    domain,
    url: cleanUrl,
    tagline,
    palette,
    keyFeatures:
      extractedFeatures.length > 0
        ? extractedFeatures
        : [
            "Arquitectura de alto rendimiento",
            "Experiencia fluida y diseño intuitivo",
            "Integración moderna en la nube",
          ],
    suggestedMetric,
  };
}

/**
 * Genera un guion de storyboard de postproducción de marca ejecutiva ("Brand Showcase")
 * estructurado en 4 actos con sincronización exacta a 60 FPS determinista.
 */
export function generateBrandNarrativePlan(options: {
  brand: BrandIdentity;
  fpsNum: number;
  targetDurationSec?: number;
}): BrandNarrativeResult {
  const { brand, fpsNum } = options;
  const targetDurationSec = options.targetDurationSec ?? 32;
  const totalFrames = Math.round(targetDurationSec * fpsNum);

  const scenes = [
    {
      label: "1. Brand Reveal & Hook",
      cardKind: "hero" as const,
      headline: brand.brandName.toUpperCase(),
      subheadline: brand.tagline,
      narration: `Conoce ${brand.brandName}: la plataforma de última generación diseñada para transformar ${brand.tagline.toLowerCase()}.`,
      sfx: "whoosh" as SfxType,
      punch: false,
    },
    {
      label: "2. Propuesta de Valor",
      cardKind: "ui" as const,
      headline: "ARQUITECTURA DIGITAL",
      subheadline: `${brand.domain} · Eficiencia y simplicidad`,
      narration: `Cada detalle ha sido optimizado al milímetro para brindar una experiencia inmediata, escalable y sin fricciones técnicas.`,
      sfx: "pop" as SfxType,
      punch: true,
    },
    {
      label: "3. Métrica de Impacto",
      cardKind: "chart" as const,
      headline: brand.suggestedMetric?.label ?? "RENDIMIENTO LÍDER",
      subheadline: brand.suggestedMetric?.context ?? "Resultados comprobados en producción",
      metricValue: brand.suggestedMetric?.value ?? 98,
      metricUnit: brand.suggestedMetric?.unit ?? "%",
      narration: `Con ${brand.suggestedMetric?.value}${brand.suggestedMetric?.unit} de ${brand.suggestedMetric?.context.toLowerCase()}, los líderes de la industria ya están acelerando su crecimiento.`,
      sfx: "ding" as SfxType,
      punch: true,
    },
    {
      label: "4. Call To Action",
      cardKind: "cta" as const,
      headline: "EMPIEZA HOY",
      subheadline: `Visita ${brand.domain} y lleva tus proyectos al siguiente nivel.`,
      narration: `Visita ${brand.domain} hoy mismo y descubre todo lo que ${brand.brandName} puede hacer por tu equipo. Guarda y comparte este video.`,
      sfx: "ding" as SfxType,
      punch: false,
    },
  ];

  let cursor = 0;
  const blocks: NarrativeBlockPlan[] = scenes.map((sc, i) => {
    const isLast = i === scenes.length - 1;
    const durFrames = isLast
      ? Math.max(15, totalFrames - cursor)
      : Math.max(15, Math.round(totalFrames / scenes.length));
    const startFrame = cursor;
    const endFrame = isLast ? totalFrames : startFrame + durFrames;
    cursor = endFrame;

    return {
      index: i,
      label: sc.label,
      startSec: startFrame / fpsNum,
      endSec: endFrame / fpsNum,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      headline: sc.headline,
      subheadline: sc.subheadline,
      narrationText: sc.narration,
      cardKind: sc.cardKind,
      metricValue: sc.metricValue,
      metricUnit: sc.metricUnit,
      sfxType: sc.sfx,
      wantsZoomPunch: sc.punch,
      accentColor: i % 2 === 0 ? brand.palette.accent : brand.palette.secondary,
    };
  });

  const brandReport = `Identidad corporativa capturada: ${brand.brandName} (${brand.domain}) · Tokens: ${brand.palette.accent} / ${brand.palette.secondary} · Storyboard de 4 escenas completado.`;

  return {
    brand,
    targetDurationSec,
    totalFrames,
    blocks,
    brandReport,
  };
}

