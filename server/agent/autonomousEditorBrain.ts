import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { MediaAsset, MediaClip, Project } from "../../src/shared/schema";
import { fpsValue, framesToSeconds, newId } from "../../src/shared/time";
import { touchProject } from "../../src/shared/project";
import { aiChatReady, aiStatus, chatJson, type TranscriptSegment } from "../ai/provider";
import {
  cleanEmojis,
  sanitizeComponentCode,
  validateTsx,
} from "../motion-agent/code-guard";
import { MOTION_REPAIR_PROMPT } from "../motion-agent/prompts";
import type { ProjectSemanticDNA } from "./semanticDNA";
import type { VideoVisualProfile } from "./visionInspector";
import type { AudioAnalysisProfile } from "./audioDirector";
import type { HyperFrameLookPreset } from "../../src/shared/hyperframes";

export type ToolRunnerFn = (name: string) => Promise<{
  argsSchema: z.ZodTypeAny;
  execute: (
    context: {
      projectId: string;
      project: Project;
      signal: AbortSignal;
      setProgress: (progress: number, message?: string) => void;
    },
    args: unknown,
  ) => Promise<{ summary: string; project?: Project; data?: unknown }>;
}>;

export type ChatJsonFn = typeof chatJson;

export const SurgicalToolActionSchema = z.object({
  tool: z.enum([
    "apply_color_adjustment",
    "set_clip_speed",
    "adjust_audio",
    "enhance_voice",
    "set_clip_fade",
    "set_clip_animation",
    "trim_clip",
    "split_clip",
    "cut_time_range",
    "keep_time_ranges",
    "remove_silences",
    "select_highlights",
    "change_aspect_ratio",
    "set_clip_zoom_keyframes",
    "set_clip_opacity",
    "set_clip_crop",
  ]),
  clipTarget: z.string().optional(),
  args: z.record(z.unknown()).default({}),
  reason: z.string().optional(),
});

export type SurgicalToolAction = z.infer<typeof SurgicalToolActionSchema>;

export const BespokeSceneBriefSchema = z.object({
  id: z.string().default(() => randomUUID().slice(0, 8)),
  title: z.string().min(2).max(120),
  startSec: z.number().min(0).max(3600),
  durationSec: z.number().min(1.5).max(30).default(4.2),
  zone: z
    .enum(["hero-top", "top-right-hud", "top-left-hud", "lower-third", "center-stage"])
    .default("hero-top"),
  layerRole: z.enum(["overlay", "full-scene", "background-v1"]).default("overlay"),
  visualConcept: z.string().min(4).max(600),
  animationChoreography: z.string().min(4).max(400).default("Spring entrance, staggered SVG draw, smooth exit"),
  svgMetaphorIdea: z.string().max(300).optional(),
  headline: z.string().max(120),
  subheadline: z.string().max(220).default(""),
  ctaText: z.string().max(100).optional(),
  allLiterals: z.array(z.string().max(200)).optional(),
  sceneArchetype: z.enum(["neural-hook", "timeline-demo", "cta-close", "general"]).optional(),
  metricValue: z.string().max(32).optional(),
  sfxType: z.enum(["whoosh", "pop", "ding", "riser", "subhit", "glitch"]).default("whoosh"),
  hideSubtitlesDuringScene: z.boolean().default(false),
  fontFamilyHint: z
    .enum(["inter", "grandstander", "anton", "bebas", "playfair", "space-grotesk"])
    .optional(),
});

export type BespokeSceneBrief = z.infer<typeof BespokeSceneBriefSchema>;

export const EditorialDensityTierSchema = z.enum(["restraint", "curated", "kinetic"]);
export type EditorialDensityTier = z.infer<typeof EditorialDensityTierSchema>;

export const EditorialPlanSchema = z.object({
  densityTier: EditorialDensityTierSchema.default("curated"),
  decisionRationale: z.string().max(500).default("Equilibrio editorial: respiro visual y énfasis solo en momentos clave."),
  maxOverlays: z.number().int().min(0).max(10).optional(),
  minOverlayGapSec: z.number().min(0.5).max(30).optional(),
  maxZoomPunches: z.number().int().min(0).max(14).optional(),
  minPunchGapSec: z.number().min(1).max(30).optional(),
  maxSfx: z.number().int().min(0).max(16).optional(),
  minSfxGapSec: z.number().min(0.5).max(20).optional(),
  maxOpticalTransitions: z.number().int().min(0).max(12).optional(),
  minTransitionGapSec: z.number().min(1).max(30).optional(),
  applyAtmosphereLayer: z.boolean().optional(),
  applyOpticalTransitionsOnJumpCuts: z.boolean().optional(),
});

export interface EditorialBudget {
  densityTier: EditorialDensityTier;
  decisionRationale: string;
  maxOverlays: number;
  minOverlayGapSec: number;
  maxScreenCoverageRatio: number;
  maxZoomPunches: number;
  minPunchGapSec: number;
  maxSfx: number;
  minSfxGapSec: number;
  maxOpticalTransitions: number;
  minTransitionGapSec: number;
  applyAtmosphereLayer: boolean;
  applyOpticalTransitionsOnJumpCuts: boolean;
  allowFallbackNoTranscriptOverlays: boolean;
}

export const AutonomousEditDirectiveSchema = z.object({
  artDirection: z.object({
    palette: z.object({
      accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#38BDF8"),
      secondary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#818CF8"),
      surface: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#090D18"),
      text: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F8FAFC"),
    }),
    visualTheme: z.string().min(2).max(120),
    typographyStyle: z
      .enum(["editorial_serif", "bold_kinetic", "tech_mono", "clean_geometric"])
      .default("clean_geometric"),
    editingPace: z
      .enum(["rapid_viral", "balanced_editorial", "slow_cinematic"])
      .default("balanced_editorial"),
    cameraStyle: z
      .enum(["whip_energetic", "slow_cinema_push", "subtle_editorial", "static_clean"])
      .default("subtle_editorial"),
    colorMood: z.string().max(100).default("Balanced Cinema"),
  }),
  editorialPlan: EditorialPlanSchema.optional(),
  timelineToolCalls: z.array(SurgicalToolActionSchema).max(12).default([]),
  subtitleDirective: z.object({
    enabled: z.boolean().default(true),
    style: z
      .enum(["minimal", "tiktok", "hormozi", "cinematic", "neon", "impact"])
      .default("minimal"),
    hideDuringFullScreenScenes: z.boolean().default(true),
    placement: z.enum(["bottom", "top", "adaptive"]).default("adaptive"),
  }),
  atmosphereLook: z.object({
    enabled: z.boolean().default(true),
    lookPreset: z
      .enum(["cinema-teal-orange", "noir-contrast", "neon-cyber", "warm-film", "editorial-clean"])
      .default("editorial-clean"),
    customTintHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    letterboxRatio: z.number().min(0).max(0.14).default(0),
    vignetteIntensity: z.number().min(0).max(0.85).default(0.35),
    grainOpacity: z.number().min(0).max(0.15).default(0.03),
    glowIntensity: z.number().min(0).max(0.75).default(0.2),
  }),
  customScenes: z.array(BespokeSceneBriefSchema).max(14).default([]),
  narrativeSummary: z.string().min(4).max(500),
});

export type AutonomousEditDirective = z.infer<typeof AutonomousEditDirectiveSchema> & {
  source: "ai_director" | "local_heuristic";
  resolvedBudget?: EditorialBudget;
};

export interface ProjectTelemetrySummary {
  aspectRatioLabel: string;
  width: number;
  height: number;
  fps: number;
  totalDurationSec: number;
  hasRealVideoFootage: boolean;
  primaryVideoClips: Array<{
    id: string;
    name: string;
    startSec: number;
    durationSec: number;
    speed: number;
    volume: number;
  }>;
  transcriptExcerpt: string;
  silenceCount: number;
}

export function buildProjectTelemetrySummary(
  project: Project,
  transcriptSegments?: TranscriptSegment[],
  silenceIntervals?: Array<{ startUs: number; endUs: number }>,
): ProjectTelemetrySummary {
  const fps = fpsValue(project.settings.fps);
  const width = project.settings.width;
  const height = project.settings.height;
  const ratio = width / Math.max(1, height);
  const aspectRatioLabel =
    Math.abs(ratio - 9 / 16) < 0.08
      ? "9:16 Vertical"
      : Math.abs(ratio - 1) < 0.08
        ? "1:1 Square"
        : "16:9 Horizontal";

  const visualClips: ProjectTelemetrySummary["primaryVideoClips"] = [];
  let maxEndFrame = 0;

  for (const track of project.tracks) {
    if (/motion|overlay|subt|transici|atm[óo]sfera/i.test(track.name)) continue;
    for (const clip of track.clips) {
      maxEndFrame = Math.max(maxEndFrame, clip.startFrame + clip.durationFrames);
      if (clip.type === "video" && !clip.remotion && !clip.name.startsWith("Escena Fondo")) {
        visualClips.push({
          id: clip.id,
          name: clip.name,
          startSec: Number(framesToSeconds(clip.startFrame, project.settings.fps).toFixed(2)),
          durationSec: Number(framesToSeconds(clip.durationFrames, project.settings.fps).toFixed(2)),
          speed: clip.speed,
          volume: clip.volume,
        });
      }
    }
  }

  const transcriptExcerpt = (transcriptSegments ?? [])
    .slice(0, 75)
    .map((s) => `[${(s.startUs / 1_000_000).toFixed(1)}s -> ${(s.endUs / 1_000_000).toFixed(1)}s] ${s.text.trim()}`)
    .join("\n")
    .slice(0, 4200);

  return {
    aspectRatioLabel,
    width,
    height,
    fps,
    totalDurationSec: Number(framesToSeconds(maxEndFrame, project.settings.fps).toFixed(2)),
    hasRealVideoFootage: visualClips.length > 0,
    primaryVideoClips: visualClips,
    transcriptExcerpt,
    silenceCount: silenceIntervals?.length ?? 0,
  };
}

export interface TimeRangeSeconds {
  startSeconds: number;
  endSeconds: number;
}

export interface UserEditingConstraints {
  noSilenceCut: boolean;
  noSubs: boolean;
  noZooms: boolean;
  noGraphics: boolean;
  noMusic: boolean;
  noSfx: boolean;
  noLetterbox: boolean;
  noColorFilter: boolean;
  cutRanges: TimeRangeSeconds[];
  keepRanges: TimeRangeSeconds[];
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  targetHighlightsSec?: number;
  customTintHex?: string;
}

function parseClockOrSeconds(token: string): number | null {
  const clean = token.trim().replace(",", ".");
  const clock = clean.match(/^(\d{1,3}):([0-5]\d(?:\.\d+)?)$/);
  if (clock?.[1] && clock[2]) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }
  const num = Number.parseFloat(clean);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

/**
 * Extrae restricciones negativas, rangos temporales explícitos (corte/conservación)
 * y matices visuales libres directamente desde la petición del usuario.
 */
export function parseUserEditingConstraints(prompt: string): UserEditingConstraints {
  const lower = prompt.toLowerCase();

  const noSilenceCut = /\b(sin\s+cortar\s+(?:silencios?|pausas?)|no\s+cortes?\s+(?:los\s+)?(?:silencios?|pausas?)|deja\s+(?:los\s+)?silencios|mant[eé]n\s+el\s+audio\s+original\s+intacto)\b/i.test(lower);
  const noSubs = /\b(sin\s+subt[íi]tulos?|no\s+(?:pongas?|quiero|a[ñn]adas?)\s+subt[íi]tulos?|quita(?:r)?\s+(?:los\s+)?subt[íi]tulos?|elimina(?:r)?\s+(?:los\s+)?subt[íi]tulos?|cero\s+subt[íi]tulos?)\b/i.test(lower);
  const noZooms = /\b(sin\s+zooms?|no\s+(?:hagas?|apliques?|quiero)\s+zooms?|c[áa]mara\s+fija|sin\s+acercamientos?)\b/i.test(lower);
  const noGraphics = /\b(sin\s+gr[áa]ficos?|sin\s+overlays?|sin\s+tarjetas?|solo\s+(?:el\s+)?video\s+limpio|sin\s+b-?roll)\b/i.test(lower);
  const noMusic = /\b(sin\s+m[úu]sica|no\s+(?:pongas?|quiero)\s+m[úu]sica|solo\s+voz)\b/i.test(lower);
  const noSfx = /\b(sin\s+(?:efectos?\s+de\s+sonido|sfx|sonidos?)|no\s+sfx)\b/i.test(lower);
  const noLetterbox = /\b(sin\s+barras\s+negras|sin\s+letterbox)\b/i.test(lower);
  const noColorFilter = /\b(color\s+natural|sin\s+filtros?\s+de\s+color|sin\s+lut|no\s+toques?\s+el\s+color)\b/i.test(lower);

  const timeTok = String.raw`(\d{1,3}:[0-5]\d(?:\.\d+)?|\d+(?:[.,]\d+)?)`;
  const cutRanges: TimeRangeSeconds[] = [];
  const cutRegex = new RegExp(
    `\\b(?:corta|quita|elimina|borra|suprime|remueve)\\b[^\\n.;]{0,36}?\\b(?:desde\\s+el\\s+|del\\s+|de\\s+)?(?:segundo\\s+|minuto\\s+)?${timeTok}\\s*(?:s\\b|seg(?:undos?)?\\b)?\\s*(?:al|a|hasta|-)\\s*(?:el\\s+)?(?:segundo\\s+|minuto\\s+)?${timeTok}\\s*(?:s\\b|seg(?:undos?)?\\b)?`,
    "gi",
  );
  for (const m of lower.matchAll(cutRegex)) {
    const start = m[1] ? parseClockOrSeconds(m[1]) : null;
    const end = m[2] ? parseClockOrSeconds(m[2]) : null;
    if (start !== null && end !== null && end > start + 0.15) {
      cutRanges.push({ startSeconds: start, endSeconds: end });
    }
  }

  const keepRanges: TimeRangeSeconds[] = [];
  const keepRegex = new RegExp(
    `\\b(?:qu[eé]date\\s+(?:solo\\s+)?con|deja\\s+(?:solo|[uú]nicamente)|conserva\\s+(?:solo|[uú]nicamente)|solo\\s+de)\\b[^\\n.;]{0,36}?\\b(?:del\\s+|desde\\s+|de\\s+)?(?:segundo\\s+|minuto\\s+)?${timeTok}\\s*(?:s\\b|seg(?:undos?)?\\b)?\\s*(?:al|a|hasta|-)\\s*(?:el\\s+)?(?:segundo\\s+|minuto\\s+)?${timeTok}\\s*(?:s\\b|seg(?:undos?)?\\b)?`,
    "gi",
  );
  for (const m of lower.matchAll(keepRegex)) {
    const start = m[1] ? parseClockOrSeconds(m[1]) : null;
    const end = m[2] ? parseClockOrSeconds(m[2]) : null;
    if (start !== null && end !== null && end > start + 0.15) {
      keepRanges.push({ startSeconds: start, endSeconds: end });
    }
  }

  const trimStartMatch = lower.match(/\b(?:corta|quita|elimina|recorta)\s+(?:los?\s+)?primeros?\s+(\d+(?:[.,]\d+)?)\s*(?:seg|s\b)/i);
  const trimStartSeconds = trimStartMatch?.[1]
    ? Number.parseFloat(trimStartMatch[1].replace(",", "."))
    : undefined;

  const trimEndMatch = lower.match(/\b(?:corta|quita|elimina|recorta)\s+(?:los?\s+)?[uú]ltimos?\s+(\d+(?:[.,]\d+)?)\s*(?:seg|s\b)/i);
  const trimEndSeconds = trimEndMatch?.[1]
    ? Number.parseFloat(trimEndMatch[1].replace(",", "."))
    : undefined;

  let targetHighlightsSec: number | undefined;
  const hlMatch = lower.match(/\b(?:resumen|highlights?|mejores\s+momentos|condensa|extracto)[^\d]{0,20}(\d{1,3})\s*(?:s\b|seg(?:undos?)?)\b/i);
  if (hlMatch?.[1]) {
    targetHighlightsSec = Math.max(8, Math.min(300, Number.parseInt(hlMatch[1], 10)));
  } else if (/\b(mejores\s+momentos|highlights?|resumen\s+(?:corto|din[áa]mico)|partes?\s+claves?)\b/i.test(lower)) {
    targetHighlightsSec = 45;
  }

  let customTintHex: string | undefined;
  const explicitHexMatch = prompt.match(/#([0-9A-Fa-f]{6})\b/);
  if (explicitHexMatch?.[0]) {
    customTintHex = explicitHexMatch[0].toUpperCase();
  } else if (/\b(verde|esmeralda|matrix|biotecnolog)\b/i.test(lower)) {
    customTintHex = "#10B981";
  } else if (/\b(rojo|carmes[íi]|peligro|terror|alerta)\b/i.test(lower)) {
    customTintHex = "#EF4444";
  } else if (/\b(violeta|morado|p[uú]rpura|ne[óo]n|magenta)\b/i.test(lower)) {
    customTintHex = "#A855F7";
  } else if (/\b(azul|fr[íi]o|cyan|oce[áa]nico|el[ée]ctrico)\b/i.test(lower)) {
    customTintHex = "#0EA5E9";
  } else if (/\b(dorado|c[áa]lido|sepia|sunset|atardecer)\b/i.test(lower)) {
    customTintHex = "#F59E0B";
  }

  return {
    noSilenceCut,
    noSubs,
    noZooms,
    noGraphics,
    noMusic,
    noSfx,
    noLetterbox,
    noColorFilter,
    cutRanges,
    keepRanges,
    ...(Number.isFinite(trimStartSeconds) && trimStartSeconds! > 0 && trimStartSeconds! < 300
      ? { trimStartSeconds }
      : {}),
    ...(Number.isFinite(trimEndSeconds) && trimEndSeconds! > 0 && trimEndSeconds! < 300
      ? { trimEndSeconds }
      : {}),
    targetHighlightsSec,
    customTintHex,
  };
}

export interface ExtractedPromptTitles {
  introTitle?: string;
  introSubtitle?: string;
  outroTitle?: string;
  outroSubtitle?: string;
  isCleanMinimal: boolean;
  wantsIntroTitle?: boolean;
  wantsOutroTitle?: boolean;
  wantsCorporateCleanStyle?: boolean;
}

/**
 * Detecta si un fragmento de texto es una orden o petición conversacional dirigida al agente
 * (y no un contenido literal para mostrar en pantalla).
 */
export function isConversationalInstructionText(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return false;
  if (
    /\b(quiero|quisiera|necesito|deseo|me\s+gustar[ií]a|puedes|podr[ií]as|por\s+favor|ay[uú]dame)\b/i.test(
      clean,
    )
  ) {
    return true;
  }
  if (
    /^(?:pon(?:er|gas|le|me|lo|la)?|pogue(?:s)?|coloca(?:r|s)?|agrega(?:r|s)?|a[ñn]ad(?:e|ir|as)?|edita(?:r|s)?|limpia(?:r|s)?|corta(?:r|s)?|quita(?:r|s)?|elimina(?:r|s)?|aplica(?:r|s)?|inserta(?:r|s)?|cambia(?:r|s)?|modifica(?:r|s)?|ajusta(?:r|s)?)\b/i.test(
      clean,
    )
  ) {
    return true;
  }
  if (
    /^(?:crea(?:r|s)?|genera(?:r|s)?|haz(?:me|lo|la)?|usa(?:r|s)?|mant[eé]n|deja(?:r|s)?)\b/i.test(clean) &&
    /\b(?:un\s+(?:video|v[ií]deo|reel|corto|proyecto|t[ií]tulo|titulo|subt[ií]tulo|cierre|bot[óo]n|efecto|clip|montaje)|una\s+(?:escena|pista|transici[óo]n|animaci[óo]n)|este\s+(?:video|v[ií]deo|clip|audio)|los\s+(?:silencios|subt[ií]tulos)|la\s+(?:edici[óo]n|pantalla|voz|m[úu]sica)|subt[ií]tulos\s+din[áa]micos)\b/i.test(
      clean,
    )
  ) {
    return true;
  }
  if (
    /\b(al\s+(?:inicio|incio|principio|comienzo|final|cierre)|en\s+el\s+(?:inicio|incio|principio|final|cierre|video|v[ií]deo)|un\s+(?:t[ií]tulo|titulo|subt[ií]tulo|subtitulo|r[óo]tulo|rotulo|cierre|cta|gr[áa]fico|grafico|efecto|zoom)|mismo(?:s)?\s+estilo(?:s)?|o\s*sea|muy\s+corporativ|coorporativ|\bcoorpo\b|profesioanl|sin\s+recargar|sin\s+saturar)\b/i.test(
      clean,
    )
  ) {
    return true;
  }
  return false;
}

function splitTitleAndSubtitle(raw: string): { title: string; subtitle?: string } {
  const clean = raw.replace(/\s+/g, " ").trim();
  const sepMatch = clean.match(/^(.{2,42}?)\s*(?:·|—|–|:|\s-\s)\s*(.{2,64})$/);
  if (sepMatch?.[1] && sepMatch?.[2]) {
    return { title: sepMatch[1].trim(), subtitle: sepMatch[2].trim() };
  }
  return { title: clean };
}

/**
 * Extrae títulos explícitos de apertura y cierre entre comillas (o tras «que diga...»)
 * y detecta intención de edición limpia/corporativa.
 */
export function extractExplicitPromptTitles(prompt: string): ExtractedPromptTitles {
  const wantsIntroTitle =
    /\b(al\s+(?:inicio|incio|principio|comienzo)|en\s+el\s+(?:inicio|incio|principio|comienzo)|portada|apertura|intro)\b/i.test(
      prompt,
    ) && /\b(t[ií]tulo|titulo|r[óo]tulo|rotulo|portada|intro|apertura|texto)\b/i.test(prompt);
  const wantsOutroTitle = /\b(al\s+final|en\s+el\s+final|cierre|outro|despedida|cta)\b/i.test(prompt);
  const wantsCorporateCleanStyle =
    /\b(profesional|profesioanl|corporativ[oa]|coorporativ[oa]|coorpo|ejecutiv[oa]|mismo(?:s)?\s+estilo(?:s)?|sobri[oa]|limpi[oa]|minimal(?:ista)?|elegante)\b/i.test(
      prompt,
    );
  const isCleanMinimal =
    /\b(limpi[oa]|sin\s+recargar|minimal|minimalista|sutil|org[áa]nic|sobri[oa]|discreto|sin\s+saturar|no\s+(?:lo\s+)?cargues|menos\s+es\s+m[áa]s)\b/i.test(
      prompt,
    ) ||
    (wantsCorporateCleanStyle &&
      /\b(t[ií]tulo|titulo|r[óo]tulo|rotulo|edici[oó]n|estilo(?:s)?)\b/i.test(prompt));

  const quoteMatches = Array.from(prompt.matchAll(/["“”'«]([^"“”'»\n]{2,90})["“”'»]/g));
  let rawIntro: string | undefined;
  let rawOutro: string | undefined;
  const uncategorized: string[] = [];

  for (const m of quoteMatches) {
    const quoted = (m[1] ?? "").trim();
    if (!quoted) continue;
    const idx = m.index ?? 0;
    const before = prompt.slice(Math.max(0, idx - 64), idx).toLowerCase();
    const introMatch = before.match(/(?:al\s+inicio|al\s+incio|inicio|incio|comienzo|apertura|portada|intro|empezar|empiece|primer[ao]?|t[ií]tulo)/gi);
    const outroMatch = before.match(/(?:al\s+final|final|cierre|despedida|terminar|termine|cta|outro)/gi);
    const lastIntroPos = introMatch ? before.lastIndexOf(introMatch[introMatch.length - 1]!) : -1;
    const lastOutroPos = outroMatch ? before.lastIndexOf(outroMatch[outroMatch.length - 1]!) : -1;

    if (lastOutroPos > lastIntroPos) {
      rawOutro = quoted;
    } else if (lastIntroPos >= 0) {
      rawIntro = quoted;
    } else {
      uncategorized.push(quoted);
    }
  }

  for (const item of uncategorized) {
    if (!rawIntro) {
      rawIntro = item;
    } else if (!rawOutro) {
      rawOutro = item;
    }
  }

  if (!rawIntro) {
    const literalAfterVerb = prompt.match(
      /(?:que\s+(?:diga|ponga|muestre|lea)|con\s+el\s+texto|con\s+la\s+frase|titulado|llamado)\s*:?\s*([^.,;\n"“”'«»]{2,70})/i,
    );
    const candidate = literalAfterVerb?.[1]
      ?.replace(/\s+(?:y\s+al\s+final|con\s+estilo|en\s+formato).*$/i, "")
      .trim();
    if (candidate && candidate.length >= 2 && !isConversationalInstructionText(candidate)) {
      rawIntro = candidate;
    }
  }

  const introSplit = rawIntro ? splitTitleAndSubtitle(rawIntro) : undefined;
  const outroSplit = rawOutro ? splitTitleAndSubtitle(rawOutro) : undefined;

  return {
    introTitle: introSplit?.title,
    introSubtitle: introSplit?.subtitle,
    outroTitle: outroSplit?.title,
    outroSubtitle: outroSplit?.subtitle,
    isCleanMinimal,
    wantsIntroTitle,
    wantsOutroTitle,
    wantsCorporateCleanStyle,
  };
}

/**
 * Elimina órdenes técnicas de edición y frases conversacionales (cortes, silencios, zooms, subtítulos, formato)
 * para evitar que el TTS las lea en voz alta o aparezcan como texto literal en pantalla.
 */
export function stripEditingMetaInstructions(prompt: string): string {
  let cleaned = prompt
    .replace(/(?:y\s+)?(?:al\s+(?:inicio|incio|principio|comienzo|final|cierre)\s+)?(?:agrega|a[ñn]ade|pon(?:gas|er|le)?|pogue(?:s)?|coloca(?:r|s)?|incluye)\s+(?:al\s+(?:inicio|incio|principio|final|cierre)\s+)?(?:un\s+|una\s+)?(?:t[ií]tulo|titulo|cierre|cta|subt[ií]tulo|subtitulo|r[óo]tulo|rotulo)[^.!\n]*?(?:["“”'«][^"“”'»\n]*["“”'»])?/gi, " ")
    .replace(/["“”'«][^"“”'»\n]{2,90}["“”'»]/g, " ")
    .replace(/\b(?:quiero\s+que|quisiera\s+que|necesito\s+que|deseo\s+que|me\s+gustar[ií]a\s+que|puedes|podr[ií]as|por\s+favor|ay[uú]dame\s+a)\b/gi, " ")
    .replace(/\bcon\s+(?:los?\s+)?mismo(?:s)?\s+estilo(?:s)?\b[^.,;\n]*/gi, " ")
    .replace(/\bo\s*sea\s+(?:profesional|profesioanl|corporativ[oa]|coorporativ[oa]|coorpo|limpi[oa]|elegante)\b[^.,;\n]*/gi, " ")
    .replace(/\b(?:muy\s+)?(?:corporativ[oa]|coorporativ[oa]|coorpo|profesional|profesioanl)(?:\s+y\s+(?:muy\s+)?(?:corporativ[oa]|coorporativ[oa]|coorpo|profesional|profesioanl|limpi[oa]|elegante))*/gi, " ")
    .replace(/\ben\s+formato\s+\d+\s*:\s*\d+\b/gi, " ")
    .replace(/\b\d+\s*:\s*\d+\b/g, " ")
    .replace(/\b(?:limpia|elimina|quita|corta|poda|suprime)\s+(?:los\s+)?(?:silencios?|pausas?)\b[^,;.\n]*/gi, " ")
    .replace(/\b(?:aplica|a[ñn]ade|agrega|pon)\s+(?:unos?\s+)?zooms?\b[^,;.\n]*/gi, " ")
    .replace(/\b(?:genera|crea|a[ñn]ade|agrega|pon)\s+(?:unos?\s+)?subt[ií]tulos?\b[^,;.\n]*/gi, " ")
    .replace(/\b(?:mant[eé]n|deja|haz)\s+(?:la\s+|una\s+)?edici[oó]n\s+(?:limpia|profesional|sutil|minimal(?:ista)?)\b[^.\n]*/gi, " ")
    .replace(/\bsin\s+recargar(?:\s+la\s+pantalla)?\b[^.\n]*/gi, " ")
    .replace(/^(?:hazme|genera(?:r)?|crea(?:r)?|edita(?:r)?|monta(?:r)?)\s+(?:un\s+|este\s+|el\s+)?(?:video|v[ií]deo|reel|clip|short|tr[aá]iler)\s*(?:completo|din[áa]mico|profesional)?\s*(?:para|de|sobre)?\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,:;.-]+|[\s,:;.-]+$/g, "")
    .trim();

  if (cleaned.length < 3 || isConversationalInstructionText(cleaned)) {
    cleaned = "";
  }
  return cleaned;
}

/**
 * Elimina muletillas y saludos iniciales de una transcripción hablada para extraer el tema real.
 */
export function cleanSpokenGreetingFiller(text: string): string {
  let cleaned = text.replace(/\s+/g, " ").trim();
  const greetingPattern =
    /^(?:bueno|buen[íi]simo|buenisimo|excelente|genial|perfecto|hola|buenas|buenos\s+d[íi]as|buenas\s+tardes|buenas\s+noches|saludos|bienvenidos?|bien|entonces|ok|okay|oye|mira|miren|y\s+bien|a\s+ver|qu[ée]\s+tal|amigos|gente|equipo|chicos|chicas|compañeros|este)\b[\s,.:;!-]*/i;
  const fillerLeadPattern =
    /^(?:hoy\s+les\s+(?:vengo\s+a\s+)?contar\s+(?:sobre|que)?|les\s+(?:cuento|digo|presento|muestro)\s+que|en\s+este\s+v[ií]deo\s+(?:vamos\s+a\s+ver|veremos|hablaremos\s+de)|vamos\s+a\s+(?:hablar\s+de|ver))\b[\s,.:;!-]*/i;

  for (let i = 0; i < 6; i += 1) {
    const prev = cleaned;
    cleaned = cleaned.replace(greetingPattern, "").replace(fillerLeadPattern, "").trim();
    if (cleaned === prev) break;
  }
  return cleaned.replace(/^[\s,.:;!-]+|[\s,.:;!-]+$/g, "").trim();
}

export function collectTranscriptTextsFromProject(project?: Project | null): string[] {
  if (!project) return [];
  const cues: Array<{ start: number; text: string }> = [];
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (Array.isArray((clip as MediaClip).remotion?.props?.captions)) {
        const captions = (clip as MediaClip).remotion!.props!.captions as Array<{
          start?: number;
          text?: string;
          words?: Array<{ text?: string }>;
        }>;
        for (const cue of captions) {
          const text = Array.isArray(cue.words)
            ? cue.words.map((w) => String(w.text ?? "")).join(" ").trim()
            : typeof cue.text === "string"
              ? cue.text.trim()
              : "";
          if (text) cues.push({ start: Number(cue.start ?? clip.startFrame ?? 0), text });
        }
      } else if (
        clip.type === "text" &&
        (clip.role === "subtitle" || clip.role === "caption" || /subt|caption/i.test(track.name))
      ) {
        const text = clip.text?.trim();
        if (text) cues.push({ start: clip.startFrame, text });
      }
    }
  }
  return cues.sort((a, b) => a.start - b.start).map((c) => c.text);
}

function isGenericMediaOrProjectName(name?: string | null): boolean {
  const clean = (name ?? "").trim();
  if (!clean || clean.length < 3) return true;
  return /^(mi\s+nuevo\s+montaje|mi-nuevo-montaje|proyecto\s+sin\s+t[íi]tulo|untitled|nuevo\s+proyecto|demo|video|v[ií]deo|presentador|entrevista|plano|clip|grabaci[óo]n|media_|whatsapp|vid_|img_|\d{4}-\d{2}-\d{2})/i.test(
    clean,
  );
}

export type SceneVisualArchetype = "neural-hook" | "timeline-demo" | "cta-close" | "general";

export interface ExtractedAllLiteralSceneCopy {
  badge?: string;
  headline?: string;
  subheadline?: string;
  ctaText?: string;
  allLiterals: string[];
  sceneArchetype: SceneVisualArchetype;
  wantsCorporateCleanStyle: boolean;
}

/**
 * Detecta etiquetas internas estructurales de clip/escena (ej. "Escena 1 · Gancho",
 * "Escena 2 · Demo", "Escena 3 · Cierre CTA", "Intro", "Gancho", "Outtro")
 * que sirven para organizar el timeline pero JAMÁS deben mostrarse como titular en pantalla
 * cuando el usuario pidió textos o contenido real.
 */
export function isStructuralSceneLabel(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return false;
  if (/^(?:escena|scene|clip|acto|bloque|parte|segmento|pieza|toma|shot)\s*\d*(?:\s*[·:\-–—]\s*.*)?$/i.test(clean)) {
    return true;
  }
  if (/^(?:gancho|demo|cierre|intro|outro|apertura|cta|hook|cierre\s+cta|motion\s+ia(?:\s*[·:\-–—].*)?)$/i.test(clean)) {
    return true;
  }
  if (/(?:^|\s)[·:\-–—]\s*(?:gancho|demo|cierre|intro|outro|cta|hook)\s*$/i.test(clean)) {
    return true;
  }
  return false;
}

export function detectSceneVisualArchetype(prompt: string): SceneVisualArchetype {
  const lower = prompt.toLowerCase();
  if (/\b(bot[óo]n|cta|llamado\s+a\s+la\s+acci[óo]n|pru[ée]balo|reg[íi]strate|descarga|visita|escena\s+de\s+cierre|cierre)\b/i.test(lower)) {
    return "cta-close";
  }
  if (/\b(l[ií]nea\s+de\s+tiempo|timeline|cortes\s+inteligentes|onda\s+de\s+voz|karaoke|multipista|playhead|demostraci[óo]n\s+visual|subt[ií]tulos\s+din[áa]micos|motion\s+ia)\b/i.test(lower)) {
    return "timeline-demo";
  }
  if (/\b(red\s+neuronal|neural\s+net|neuronas?|red\s+en\s+cian|sinapsis|ai\s+brain)\b/i.test(lower)) {
    return "neural-hook";
  }
  return "general";
}

/**
 * Extrae TODOS los textos literales entrecomillados del prompt (p. ej. logotipo, mensaje, cierre, CTA)
 * y clasifica su rol visual sin truncar ni reemplazarlos por nombres estructurales de clip.
 */
export function extractAllLiteralSceneCopy(prompt: string, explicitTitle?: string): ExtractedAllLiteralSceneCopy {
  const wantsCorporateCleanStyle =
    /\b(profesional|profesioanl|corporativ[oa]|coorporativ[oa]|coorpo|ejecutiv[oa]|mismo(?:s)?\s+estilo(?:s)?|sobri[oa]|limpi[oa]|minimal(?:ista)?|elegante|empresa|marca|lanzamiento)\b/i.test(
      prompt,
    );
  const sceneArchetype = detectSceneVisualArchetype(prompt);
  const quoteMatches = Array.from(prompt.matchAll(/["“«']([^"”»'\n]{2,160})["”»']/g));

  const allLiterals: string[] = [];
  const seenLitLower = new Set<string>();
  let badge: string | undefined;
  let headline: string | undefined;
  let subheadline: string | undefined;
  let ctaText: string | undefined;

  for (const m of quoteMatches) {
    const rawQuoted = (m[1] ?? "").replace(/\s+/g, " ").trim();
    const quotedLower = rawQuoted.toLowerCase();
    if (
      !rawQuoted ||
      seenLitLower.has(quotedLower) ||
      isConversationalInstructionText(rawQuoted) ||
      isStructuralSceneLabel(rawQuoted)
    ) {
      continue;
    }
    seenLitLower.add(quotedLower);
    allLiterals.push(rawQuoted);

    const idx = m.index ?? 0;
    const before = prompt.slice(Math.max(0, idx - 32), idx).toLowerCase();
    const tailBefore = before.slice(-24);

    const isCtaCue =
      /\b(?:bot[óo]n(?:\s+prominente|\s+con|\s+cta)?|cta)\s*(?:que\s+diga|con|[:=])?\s*$/i.test(tailBefore) ||
      /^(pru[ée]balo|prueba|descubre|empieza|comienza|reg[íi]strate|descarga|visita)\b/i.test(rawQuoted);
    const isLogoCue = /\b(?:logo(?:tipo)?|marca|kicker|badge|etiqueta|estudio)\s*(?:con|:)?\s*$/i.test(tailBefore);
    const isMessageCue = /\b(?:mensaje|subt[ií]tulo|descripci[óo]n|texto|copia|copy|bajada)\s*(?:con|:)?\s*$/i.test(tailBefore);

    if (isCtaCue && !ctaText) {
      ctaText = rawQuoted;
    } else if (isLogoCue && !badge) {
      badge = rawQuoted;
      if (!headline && rawQuoted.length >= 4) {
        headline = rawQuoted;
      }
    } else if (isMessageCue) {
      if (!headline) {
        headline = rawQuoted;
      } else if (!subheadline && quotedLower !== headline.toLowerCase()) {
        subheadline = rawQuoted;
      }
    } else if (!headline) {
      headline = rawQuoted;
    } else if (!subheadline && quotedLower !== headline.toLowerCase()) {
      subheadline = rawQuoted;
    } else if (!ctaText && rawQuoted.length <= 42) {
      ctaText = rawQuoted;
    }
  }

  // Caso habitual: logotipo corto como primer literal y frase de mensaje como segundo literal
  if (badge && headline === badge && subheadline) {
    // Mantener badge como logotipo completo y promover si subheadline es la frase principal solo si se prefiere ambos visibles:
    // ambos (`headline` = logotipo completo si tiene "·", `subheadline` = mensaje) estarán visibles en pantalla.
  } else if (!badge && allLiterals.length >= 2) {
    // Si el primer literal contiene el nombre de marca, extraer marca corta para el badge sin perder el literal completo
    const first = allLiterals[0]!;
    if (first.includes("·")) {
      const parts = first.split("·").map((p) => p.trim()).filter(Boolean);
      if (parts[0]) badge = parts[0];
    }
  }

  const cleanExplicit = explicitTitle?.replace(/\s+/g, " ").trim();
  if (
    !headline &&
    cleanExplicit &&
    !isStructuralSceneLabel(cleanExplicit) &&
    !isConversationalInstructionText(cleanExplicit)
  ) {
    headline = cleanExplicit;
  }

  return {
    badge,
    headline,
    subheadline,
    ctaText,
    allLiterals,
    sceneArchetype,
    wantsCorporateCleanStyle,
  };
}

/**
 * Resuelve titular, subtítulo y badge editoriales contextuales SIN filtrar jamás el prompt
 * conversacional del usuario sobre el video ni usar nombres internos de clip cuando hay copy real.
 */
export function resolveContextualOverlayCopy(options: {
  prompt: string;
  explicitTitle?: string;
  project?: Project | null;
  transcriptTexts?: string[];
  dna?: ProjectSemanticDNA;
}): {
  headline: string;
  subheadline: string;
  badge: string;
  ctaText?: string;
  allLiterals: string[];
  sceneArchetype: SceneVisualArchetype;
  wantsCorporateCleanStyle: boolean;
  usedFallbackCopy: boolean;
} {
  const literalCopy = extractAllLiteralSceneCopy(options.prompt, options.explicitTitle);
  const explicitTitles = extractExplicitPromptTitles(options.prompt);
  const wantsCorporateCleanStyle = Boolean(
    explicitTitles.wantsCorporateCleanStyle || literalCopy.wantsCorporateCleanStyle,
  );
  const strippedPrompt = stripEditingMetaInstructions(options.prompt);
  const dna = options.dna;

  const rawKicker = dna?.themeKicker?.trim() ?? "";
  const isStructuralKicker =
    !rawKicker ||
    rawKicker.length < 2 ||
    rawKicker.toUpperCase() === "CORE" ||
    /^(?:escena|scene|acto|bloque|parte)\s*\d*(?:\s*·|\b)/i.test(rawKicker);
  const fallbackBadge = !isStructuralKicker
    ? rawKicker.toUpperCase()
    : /\boeclip\b/i.test(options.prompt)
      ? "OECLIP · STUDIO"
      : wantsCorporateCleanStyle
        ? "ESTUDIO IA"
        : (dna?.categoryLabel || "EDICIÓN PRO").toUpperCase();
  const badge = (literalCopy.badge || fallbackBadge).slice(0, 44);

  // 1. Textos literales entrecomillados en el prompt (SIEMPRE prioritarios sobre nombres estructurales como "Escena 1 · Gancho")
  if (literalCopy.allLiterals.length > 0 && literalCopy.headline) {
    const cleanSub = (literalCopy.subheadline ?? "").slice(0, 220);
    return {
      headline: literalCopy.headline.slice(0, 120),
      subheadline: cleanSub.toLowerCase() === literalCopy.headline.trim().toLowerCase() ? "" : cleanSub,
      badge: literalCopy.headline.toUpperCase() === badge.toUpperCase() ? "OECLIP STUDIO" : badge,
      ...(literalCopy.ctaText ? { ctaText: literalCopy.ctaText.slice(0, 100) } : {}),
      allLiterals: literalCopy.allLiterals,
      sceneArchetype: literalCopy.sceneArchetype,
      wantsCorporateCleanStyle,
      usedFallbackCopy: false,
    };
  }

  // 2. Título explícito pasado por herramienta SOLO si NO es una etiqueta interna estructural ("Escena 1 · Gancho", etc.)
  const explicitArg = options.explicitTitle?.trim();
  if (
    explicitArg &&
    !isConversationalInstructionText(explicitArg) &&
    !isStructuralSceneLabel(explicitArg)
  ) {
    const cleanSub =
      !wantsCorporateCleanStyle &&
      strippedPrompt &&
      strippedPrompt.toUpperCase() !== explicitArg.toUpperCase()
        ? strippedPrompt.slice(0, 96)
        : "";
    return {
      headline: explicitArg.slice(0, 90),
      subheadline: cleanSub,
      badge: explicitArg.toUpperCase() === badge.toUpperCase() ? "PRESENTACIÓN" : badge,
      allLiterals: [explicitArg],
      sceneArchetype: literalCopy.sceneArchetype,
      wantsCorporateCleanStyle,
      usedFallbackCopy: false,
    };
  }

  // 3. Título explícito tras «que diga...» en el prompt
  const promptLiteral = explicitTitles.wantsOutroTitle && !explicitTitles.introTitle
    ? explicitTitles.outroTitle
    : explicitTitles.introTitle ?? explicitTitles.outroTitle;
  const promptLiteralSub = explicitTitles.wantsOutroTitle && !explicitTitles.introTitle
    ? explicitTitles.outroSubtitle
    : explicitTitles.introSubtitle ?? explicitTitles.outroSubtitle;
  if (
    promptLiteral &&
    !isConversationalInstructionText(promptLiteral) &&
    !isStructuralSceneLabel(promptLiteral)
  ) {
    return {
      headline: promptLiteral.slice(0, 90),
      subheadline: promptLiteralSub?.slice(0, 120) ?? "",
      badge: promptLiteral.toUpperCase() === badge.toUpperCase() ? "PRESENTACIÓN" : badge,
      allLiterals: [promptLiteral, ...(promptLiteralSub ? [promptLiteralSub] : [])],
      sceneArchetype: literalCopy.sceneArchetype,
      wantsCorporateCleanStyle,
      usedFallbackCopy: false,
    };
  }

  // 4. Concepto descriptivo directo del prompt (para escenas visuales sin comillas como Escena 2 Demo)
  if (strippedPrompt && strippedPrompt.length >= 3 && !isConversationalInstructionText(strippedPrompt)) {
    const cleanDesc = strippedPrompt
      .replace(/^(?:fondo\s+[\wáéíóúñ\s]+(?:con|de)\s+|escena\s+\d+\s*[·:\-–—]?\s*)/i, "")
      .trim();
    const parts = cleanDesc.split(/[.;]+|\s+con\s+(?=cortes|capas|subt)/i).map((p) => p.trim()).filter(Boolean);
    const hl = (parts[0] || cleanDesc).slice(0, 68);
    const sub = parts[1] ? parts.slice(1).join(" · ").slice(0, 140) : cleanDesc.slice(0, 140);
    if (hl.length >= 3 && !isStructuralSceneLabel(hl)) {
      return {
        headline: hl.charAt(0).toUpperCase() + hl.slice(1),
        subheadline: sub !== hl ? sub : "",
        badge: hl.toUpperCase() === badge.toUpperCase() ? "EDICIÓN IA" : badge,
        allLiterals: [],
        sceneArchetype: literalCopy.sceneArchetype,
        wantsCorporateCleanStyle,
        usedFallbackCopy: false,
      };
    }
  }

  // 5. Tema real extraído de la transcripción hablada (ignorando saludos y muletillas iniciales)
  const mergedTranscript = [
    ...(options.transcriptTexts ?? []),
    ...collectTranscriptTextsFromProject(options.project),
  ];
  const dedupedSegments: string[] = [];
  for (const seg of mergedTranscript) {
    const norm = seg.replace(/\s+/g, " ").trim();
    if (norm && !dedupedSegments.includes(norm)) dedupedSegments.push(norm);
  }

  const substantiveSegments: string[] = [];
  for (const seg of dedupedSegments) {
    const cleanedSeg = cleanSpokenGreetingFiller(seg);
    if (cleanedSeg.length >= 8) {
      substantiveSegments.push(cleanedSeg);
    }
  }
  const combinedTranscript = cleanSpokenGreetingFiller(dedupedSegments.join(" "));
  const firstMeaningful = substantiveSegments[0] ?? (combinedTranscript.length >= 8 ? combinedTranscript : "");

  if (firstMeaningful) {
    const clause = firstMeaningful.split(/[.!?;\n]+/)[0]?.trim() || firstMeaningful;
    const words = clause.split(/\s+/).filter(Boolean);
    const stopTrailing = /^(de|del|la|el|los|las|con|en|para|por|que|y|o|a|un|una|al)$/i;
    const headSlice = words.slice(0, Math.min(6, Math.max(3, words.length)));
    while (headSlice.length > 2 && stopTrailing.test(headSlice[headSlice.length - 1]!)) {
      headSlice.pop();
    }
    const headline = headSlice.join(" ").replace(/[.,:;!?]+$/, "").toUpperCase().slice(0, 56);
    const remainingWords = words.slice(headSlice.length, headSlice.length + 10);
    const subheadline =
      !wantsCorporateCleanStyle && remainingWords.length >= 2
        ? remainingWords.join(" ").replace(/[.,:;!?]+$/, "")
        : "";
    if (headline.length >= 3) {
      return {
        headline,
        subheadline,
        badge: headline === badge ? "ENFOQUE CLAVE" : badge,
        allLiterals: [],
        sceneArchetype: literalCopy.sceneArchetype,
        wantsCorporateCleanStyle,
        usedFallbackCopy: false,
      };
    }
  }

  // 6. Nombre significativo del proyecto o del primer medio importado
  const candidates: string[] = [];
  if (options.project?.name) candidates.push(options.project.name);
  for (const m of options.project?.media ?? []) {
    if (m.origin === "import" && (m.kind === "video" || m.kind === "image")) {
      candidates.push(m.name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " "));
    }
  }
  for (const cand of candidates) {
    const cleanCand = cand.replace(/\s+/g, " ").trim();
    if (
      !isGenericMediaOrProjectName(cleanCand) &&
      !isConversationalInstructionText(cleanCand) &&
      !isStructuralSceneLabel(cleanCand)
    ) {
      const hl = cleanCand.toUpperCase().slice(0, 48);
      return {
        headline: hl,
        subheadline: "",
        badge: hl === badge ? "PRESENTACIÓN" : badge,
        allLiterals: [],
        sceneArchetype: literalCopy.sceneArchetype,
        wantsCorporateCleanStyle,
        usedFallbackCopy: false,
      };
    }
  }

  // 7. Respaldo ejecutivo (marcando usedFallbackCopy: true para que herramientas reporten status: "fallback")
  const defaultHeadline = wantsCorporateCleanStyle
    ? "VISIÓN & ESTRATEGIA"
    : dna?.category === "luxury_editorial"
      ? "DISEÑO & PRECISIÓN"
      : dna?.category === "finance_business"
        ? "IMPACTO & RESULTADOS"
        : "INNOVACIÓN EN ACCIÓN";
  return {
    headline: defaultHeadline,
    subheadline: "",
    badge: defaultHeadline === badge ? "PRESENTACIÓN" : badge,
    allLiterals: [],
    sceneArchetype: literalCopy.sceneArchetype,
    wantsCorporateCleanStyle,
    usedFallbackCopy: true,
  };
}

/**
 * Evalúa intención, duración real, habla, densidad acústica y encuadre visual para decidir
 * un presupuesto editorial con criterio cinematográfico: "menos elementos = mayor impacto".
 * Impide sobrecargar vídeos reales con gráficos continuos, zooms epilépticos o SFX redundantes.
 */
export function computeEditorialBudget(options: {
  prompt: string;
  project: Project;
  hasRealVideoFootage?: boolean;
  totalDurationSec?: number;
  transcriptSegments?: TranscriptSegment[];
  audioProfile?: AudioAnalysisProfile | null;
  visualProfile?: VideoVisualProfile | null;
  constraints?: UserEditingConstraints;
  cameraStyle?: "whip_energetic" | "slow_cinema_push" | "subtle_editorial" | "static_clean";
  lookPreset?: HyperFrameLookPreset;
  letterboxRatio?: number;
}): EditorialBudget {
  const constraints = options.constraints ?? parseUserEditingConstraints(options.prompt);
  const lower = options.prompt.toLowerCase();

  let maxEndFrame = 0;
  let detectedRealVideo = false;
  for (const track of options.project.tracks) {
    if (/motion|overlay|subt|transici|atm[óo]sfera/i.test(track.name)) continue;
    for (const clip of track.clips) {
      maxEndFrame = Math.max(maxEndFrame, clip.startFrame + clip.durationFrames);
      if (clip.type === "video" && !clip.remotion && !clip.name.startsWith("Escena Fondo")) {
        detectedRealVideo = true;
      }
    }
  }

  const hasRealVideoFootage = options.hasRealVideoFootage ?? detectedRealVideo;
  const totalSec = Math.max(
    4,
    options.totalDurationSec ?? framesToSeconds(maxEndFrame, options.project.settings.fps),
  );

  const minimalistIntent =
    /\b(edici[oó]n\s+limpia|estilo\s+limpio|video\s+limpio|minimal|minimalista|sutil|org[áa]nico|sobri[oa]|discreto|sin\s+saturar|sin\s+recargar|no\s+(?:lo\s+)?cargues|menos\s+es\s+m[áa]s|entrevista|podcast|testimonial|puro\s+relato)\b/i.test(
      lower,
    );
  const maximalistIntent =
    /\b(saturado|mrbeast|hormozi|ultra\s*din[áa]mico|fren[ée]tico|muchos?\s+gr[áa]ficos?|lleno\s+de\s+efectos|hiper\s*din[áa]mico|virales?\s+agresiv)\b/i.test(
      lower,
    );
  const explicitComplexGraphicsRequested =
    /\b(gr[áa]ficos?|huds?|tarjetas?|b-?roll|part[íi]culas|3d|diagrama|infograf|visualizaci[óo]n|remotion|hyperframes|datos\s+en\s+pantalla|estad[íi]sticas|m[ée]tricas)\b/i.test(
      lower,
    );
  const explicitTitleRequested = /\b(t[íi]tulo|portada|cierre|cta)\b/i.test(lower);
  const explicitGraphicsRequested =
    explicitComplexGraphicsRequested || (!minimalistIntent && explicitTitleRequested);
  const explicitTransitionsRequested =
    /\b(transiciones?|transici[óo]n|whip|prism|shutter|cortes?\s+[óo]pticos)\b/i.test(lower);
  const slowNarrativeIntent =
    /\b(documental|cinematogr[áa]fic|cine|pel[íi]cula|apple|narrativa|historia|sereno|calma)\b/i.test(
      lower,
    ) || options.cameraStyle === "slow_cinema_push";
  const viralKineticIntent =
    /\b(viral|tik\s*tok|shorts|reel\s+din[áa]mico|ritmo\s+alto|r[áa]pido|energ[ée]tic)\b/i.test(lower) ||
    options.cameraStyle === "whip_energetic";

  let densityTier: EditorialDensityTier = "curated";
  if (minimalistIntent || (constraints.noGraphics && constraints.noZooms)) {
    densityTier = "restraint";
  } else if (maximalistIntent || (viralKineticIntent && !slowNarrativeIntent)) {
    densityTier = "kinetic";
  } else if (slowNarrativeIntent && !explicitGraphicsRequested && totalSec >= 18) {
    densityTier = "restraint";
  }

  const transcriptCount = (options.transcriptSegments ?? []).filter((s) => s.text.trim().length >= 3).length;
  const metricSegmentCount = (options.transcriptSegments ?? []).filter((s) =>
    /\d+(?:[.,]\d+)?\s*(?:%|por\s*ciento|x|k|m|millones|mil|€|\$|usd)/i.test(s.text),
  ).length;

  let maxOverlays = 0;
  let minOverlayGapSec = 4.2;
  let maxScreenCoverageRatio = 0.4;
  if (!constraints.noGraphics) {
    if (!hasRealVideoFootage) {
      maxOverlays = densityTier === "restraint" ? 2 : densityTier === "kinetic" ? 7 : 5;
      minOverlayGapSec = densityTier === "kinetic" ? 2.0 : 3.2;
      maxScreenCoverageRatio = 0.65;
    } else if (densityTier === "restraint") {
      if (minimalistIntent && !explicitGraphicsRequested && metricSegmentCount === 0) {
        maxOverlays = 0;
      } else {
        maxOverlays = totalSec < 16 ? 1 : totalSec < 38 ? 2 : 3;
      }
      minOverlayGapSec = totalSec >= 35 ? 9.0 : 6.2;
      maxScreenCoverageRatio = 0.28;
    } else if (densityTier === "kinetic") {
      maxOverlays = Math.min(7, Math.max(2, Math.ceil(totalSec / 7.5)));
      minOverlayGapSec = 2.4;
      maxScreenCoverageRatio = 0.56;
    } else {
      const baseCurated = totalSec < 12 ? 1 : totalSec < 22 ? 2 : totalSec < 40 ? 3 : Math.min(5, Math.floor(totalSec / 11));
      const bonusForRichData = metricSegmentCount >= 2 && totalSec >= 24 ? 1 : 0;
      maxOverlays = Math.min(5, baseCurated + bonusForRichData);
      minOverlayGapSec = totalSec >= 35 ? 5.5 : 3.6;
      maxScreenCoverageRatio = 0.42;
    }
  }

  let maxZoomPunches = 0;
  let minPunchGapSec = 6.5;
  if (!constraints.noZooms && options.cameraStyle !== "static_clean") {
    if (densityTier === "restraint") {
      maxZoomPunches = totalSec < 10 ? 1 : Math.min(3, Math.max(1, Math.floor(totalSec / 14)));
      minPunchGapSec = 10.5;
    } else if (densityTier === "kinetic") {
      maxZoomPunches = Math.min(8, Math.max(2, Math.ceil(totalSec / 5)));
      minPunchGapSec = 3.8;
    } else {
      maxZoomPunches =
        options.cameraStyle === "slow_cinema_push"
          ? Math.min(4, Math.max(1, Math.floor(totalSec / 10)))
          : Math.min(5, Math.max(1, Math.floor(totalSec / 7.5)));
      minPunchGapSec = options.cameraStyle === "slow_cinema_push" ? 8.5 : 6.0;
    }
  }

  let maxSfx = 0;
  let minSfxGapSec = 3.0;
  if (!constraints.noSfx) {
    if (densityTier === "restraint") {
      maxSfx = Math.min(3, Math.max(1, Math.floor(totalSec / 12)));
      minSfxGapSec = 4.5;
    } else if (densityTier === "kinetic") {
      maxSfx = Math.min(10, Math.max(3, Math.ceil(totalSec / 4)));
      minSfxGapSec = 1.6;
    } else {
      maxSfx = Math.min(6, Math.max(2, Math.floor(totalSec / 7.5)));
      minSfxGapSec = 2.8;
    }
  }

  const maxOpticalTransitions = !hasRealVideoFootage
    ? Math.min(6, Math.max(1, Math.floor(totalSec / 5)))
    : explicitTransitionsRequested
      ? Math.min(5, Math.max(1, Math.floor(totalSec / 6.5)))
      : densityTier === "kinetic"
        ? Math.min(4, Math.floor(totalSec / 8))
        : densityTier === "restraint"
          ? 0
          : Math.min(2, Math.floor(totalSec / 18));

  const minTransitionGapSec = densityTier === "kinetic" ? 4.8 : 9.0;
  const applyOpticalTransitionsOnJumpCuts = !hasRealVideoFootage || explicitTransitionsRequested || densityTier === "kinetic";

  const hasStylizedAtmosphereIntent =
    Boolean(constraints.customTintHex) ||
    (options.letterboxRatio ?? 0) > 0 ||
    (options.lookPreset !== undefined && options.lookPreset !== "editorial-clean") ||
    (!minimalistIntent &&
      /\b(grano|grain|vi[ñn]eta|vignette|atm[óo]sfera|glow|brillo\s+[óo]ptico|cine|documental|retro|vintage|noir|cyber|matrix)\b/i.test(
        lower,
      ));
  const applyAtmosphereLayer =
    !constraints.noColorFilter && !minimalistIntent && (!hasRealVideoFootage || hasStylizedAtmosphereIntent);

  const allowFallbackNoTranscriptOverlays =
    !hasRealVideoFootage ||
    (!constraints.noGraphics &&
      (explicitGraphicsRequested ||
        (!minimalistIntent && transcriptCount === 0 && /\b(titulo|portada|gancho|hook)\b/i.test(lower))));

  const rationaleParts = [
    `Modo editorial ${densityTier.toUpperCase()} (${Math.round(totalSec)}s${hasRealVideoFootage ? ", metraje real" : ", generativo"})`,
    maxOverlays === 0
      ? "lienzo visual limpio sin gráficos invasivos"
      : `máx. ${maxOverlays} overlays con ≥${minOverlayGapSec}s de respiro`,
    maxZoomPunches === 0
      ? "cámara fija"
      : `máx. ${maxZoomPunches} zooms de énfasis (cada ≥${minPunchGapSec}s)`,
    maxOpticalTransitions === 0
      ? "cortes limpios sin flashes ópticos"
      : `máx. ${maxOpticalTransitions} transiciones ópticas en cambios de acto`,
  ];

  return {
    densityTier,
    decisionRationale: rationaleParts.join(" · "),
    maxOverlays,
    minOverlayGapSec,
    maxScreenCoverageRatio,
    maxZoomPunches,
    minPunchGapSec,
    maxSfx,
    minSfxGapSec,
    maxOpticalTransitions,
    minTransitionGapSec,
    applyAtmosphereLayer,
    applyOpticalTransitionsOnJumpCuts,
    allowFallbackNoTranscriptOverlays,
  };
}

function scoreOverlayCandidate(
  scene: BespokeSceneBrief,
  promptLower: string,
): number {
  const combined = `${scene.headline} ${scene.subheadline} ${scene.visualConcept}`;
  // Penalizar fragmentos literales de órdenes de edición ("sin zooms", "edita este video")
  if (/\b(edita\s+este|sin\s+subt[íi]tulos|sin\s+zooms?|no\s+cortes\s+silencios)\b/i.test(combined)) {
    return -10;
  }
  let score = 1.0;
  if (scene.metricValue || /\d+(?:[.,]\d+)?\s*(?:%|x|k|m|€|\$|usd|años|días)/i.test(combined)) {
    score += 4.2;
  }
  if (/\b(clave|secreto|importante|resultado|crec|error|nunca|soluci[óo]n|ahorro|impacto|conclusi[óo]n)\b/i.test(combined)) {
    score += 2.2;
  }
  if (scene.layerRole === "full-scene" || scene.zone === "center-stage") {
    score += 1.5;
  }
  if (scene.startSec <= 3.0) {
    score += 1.4;
  }
  const headlineWords = scene.headline.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
  if (headlineWords.some((w) => promptLower.includes(w))) {
    score += 1.2;
  }
  return score;
}

/**
 * Filtra y selecciona las escenas overlay respetando presupuesto máximo,
 * distancia mínima de respiro entre apariciones y porcentaje máximo de pantalla cubierta.
 * Preserva íntegramente las escenas de fondo `background-v1` en generación desde cero.
 */
export function enforceEditorialRestraint(options: {
  scenes: BespokeSceneBrief[];
  budget: EditorialBudget;
  prompt: string;
  totalDurationSec: number;
  hasRealVideoFootage: boolean;
}): BespokeSceneBrief[] {
  const backgroundScenes = options.scenes.filter((s) => s.layerRole === "background-v1");
  const overlayCandidates = options.scenes.filter((s) => s.layerRole !== "background-v1");

  if (options.budget.maxOverlays <= 0 || overlayCandidates.length === 0) {
    return backgroundScenes;
  }

  const promptLower = options.prompt.toLowerCase();
  const maxCoverageSec = options.hasRealVideoFootage
    ? Math.max(3.0, options.totalDurationSec * options.budget.maxScreenCoverageRatio)
    : options.totalDurationSec;

  const ranked = overlayCandidates
    .map((scene, idx) => ({
      scene,
      idx,
      score: scoreOverlayCandidate(scene, promptLower),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.scene.startSec - b.scene.startSec);

  const chosen: BespokeSceneBrief[] = [];
  let coveredSec = 0;

  for (const candidate of ranked) {
    if (chosen.length >= options.budget.maxOverlays) break;
    const dur = Math.min(candidate.scene.durationSec, Math.max(1.8, options.totalDurationSec - candidate.scene.startSec));
    if (dur < 1.5) continue;
    if (options.hasRealVideoFootage && coveredSec + dur > maxCoverageSec && chosen.length >= 1) {
      continue;
    }

    const start = candidate.scene.startSec;
    const end = start + dur;
    const collidesWithChosen = chosen.some((prev) => {
      const prevEnd = prev.startSec + prev.durationSec;
      return start < prevEnd + options.budget.minOverlayGapSec && end + options.budget.minOverlayGapSec > prev.startSec;
    });
    if (collidesWithChosen) continue;

    chosen.push({
      ...candidate.scene,
      durationSec: Number(dur.toFixed(2)),
    });
    coveredSec += dur;
  }

  return [
    ...backgroundScenes,
    ...chosen.sort((a, b) => a.startSec - b.startSec),
  ];
}

/**
 * Sintetiza un conjunto selecto y con respiro editorial de escenas/gráficos dinámicos
 * adaptados al contenido real de la transcripción, métricas mencionadas y zonas libres,
 * priorizando calidad e impacto sobre saturación visual.
 */
export function deriveAdaptiveScenesFromTranscriptAndPrompt(options: {
  prompt: string;
  project: Project;
  transcriptSegments?: TranscriptSegment[];
  visualProfile?: VideoVisualProfile | null;
  dna?: ProjectSemanticDNA;
  constraints?: UserEditingConstraints;
  budget?: EditorialBudget;
}): BespokeSceneBrief[] {
  const constraints = options.constraints ?? parseUserEditingConstraints(options.prompt);
  if (constraints.noGraphics) return [];

  let maxEndFrame = 0;
  let hasRealVideoFootage = false;
  for (const track of options.project.tracks) {
    if (/motion|overlay|subt|transici|atm[óo]sfera/i.test(track.name)) continue;
    for (const clip of track.clips) {
      maxEndFrame = Math.max(maxEndFrame, clip.startFrame + clip.durationFrames);
      if (clip.type === "video" && !clip.remotion && !clip.name.startsWith("Escena Fondo")) {
        hasRealVideoFootage = true;
      }
    }
  }

  const totalSec = Math.max(4, framesToSeconds(maxEndFrame, options.project.settings.fps));
  const budget =
    options.budget ??
    computeEditorialBudget({
      prompt: options.prompt,
      project: options.project,
      hasRealVideoFootage,
      totalDurationSec: totalSec,
      transcriptSegments: options.transcriptSegments,
      visualProfile: options.visualProfile,
      constraints,
    });

  if (budget.maxOverlays <= 0) return [];

  const safeZonesPool: BespokeSceneBrief["zone"][] =
    options.visualProfile?.safeOverlayZones && options.visualProfile.safeOverlayZones.length > 0
      ? options.visualProfile.safeOverlayZones.filter(
          (z): z is BespokeSceneBrief["zone"] =>
            z === "hero-top" || z === "top-right-hud" || z === "top-left-hud" || z === "center-stage" || z === "lower-third",
        )
      : ["hero-top", "top-right-hud", "top-left-hud"];
  const usableZones: BespokeSceneBrief["zone"][] =
    safeZonesPool.length > 0 ? safeZonesPool : ["hero-top", "top-right-hud", "top-left-hud"];

  const segments = (options.transcriptSegments ?? []).filter((s) => s.text.trim().length >= 3);
  const candidates: BespokeSceneBrief[] = [];
  const sfxCycle: Array<BespokeSceneBrief["sfxType"]> = ["whoosh", "pop", "ding", "subhit"];
  const fontCycle: Array<BespokeSceneBrief["fontFamilyHint"]> = [
    "space-grotesk",
    "anton",
    "playfair",
    "bebas",
    "grandstander",
  ];

  const extractShortHeadline = (raw: string, index: number): { headline: string; subheadline: string; metricValue?: string } => {
    const clean = (cleanSpokenGreetingFiller(raw) || raw).replace(/\s+/g, " ").trim();
    const metricMatch = clean.match(/(?:\$|€)?\d+(?:[.,]\d+)?\s*(?:%|x|k|m|s|ms|€|\$|usd|años|dias|días)?/i);
    const words = clean.split(/\s+/).filter((w) => w.length > 0);
    const headWords = words.slice(0, 4).join(" ").toUpperCase();
    const rest = words.slice(4, 12).join(" ");
    return {
      headline: headWords || `PUNTO CLAVE ${index + 1}`,
      subheadline: rest || options.dna?.categoryLabel || "Edición autónoma contextual",
      metricValue: metricMatch?.[0]?.trim(),
    };
  };

  const explicitTitles = extractExplicitPromptTitles(options.prompt);
  if (
    hasRealVideoFootage &&
    (explicitTitles.introTitle ||
      explicitTitles.outroTitle ||
      explicitTitles.isCleanMinimal ||
      explicitTitles.wantsIntroTitle)
  ) {
    const cleanScenes: BespokeSceneBrief[] = [];
    if (explicitTitles.introTitle) {
      cleanScenes.push({
        id: "adaptive_scene_intro",
        title: explicitTitles.introTitle.slice(0, 32),
        startSec: 0.15,
        durationSec: Number(Math.min(3.4, Math.max(1.8, totalSec * 0.25)).toFixed(2)),
        zone: "hero-top",
        layerRole: "overlay",
        visualConcept: `Título de apertura limpio: ${explicitTitles.introTitle}`,
        animationChoreography: "Entrada sutil superior tipo píldora editorial sin saturar el cuadro",
        svgMetaphorIdea: "Acento lineal limpio",
        headline: explicitTitles.introTitle,
        subheadline: explicitTitles.introSubtitle ?? "",
        fontFamilyHint: "space-grotesk",
        sfxType: "whoosh",
        hideSubtitlesDuringScene: false,
      });
    } else if (explicitTitles.wantsIntroTitle || (!explicitTitles.isCleanMinimal && segments.length > 0)) {
      const contextual = resolveContextualOverlayCopy({
        prompt: options.prompt,
        project: options.project,
        transcriptTexts: segments.map((s) => s.text),
        dna: options.dna,
      });
      cleanScenes.push({
        id: "adaptive_scene_intro",
        title: contextual.headline.slice(0, 32),
        startSec: 0.15,
        durationSec: Number(Math.min(3.4, Math.max(1.8, totalSec * 0.25)).toFixed(2)),
        zone: "hero-top",
        layerRole: "overlay",
        visualConcept: `Título de apertura limpio: ${contextual.headline}`,
        animationChoreography: "Entrada sutil superior corporativa sin saturar el cuadro",
        svgMetaphorIdea: "Acento lineal limpio",
        headline: contextual.headline,
        subheadline: contextual.wantsCorporateCleanStyle ? "" : contextual.subheadline,
        fontFamilyHint: "space-grotesk",
        sfxType: "whoosh",
        hideSubtitlesDuringScene: false,
      });
    }

    if (explicitTitles.outroTitle && totalSec > 4.2) {
      const outroStart = Number(Math.max(3.6, totalSec - 3.4).toFixed(2));
      const outroDur = Number(Math.min(3.25, Math.max(1.8, totalSec - outroStart - 0.15)).toFixed(2));
      cleanScenes.push({
        id: "adaptive_scene_outro",
        title: explicitTitles.outroTitle.slice(0, 32),
        startSec: outroStart,
        durationSec: outroDur,
        zone: "hero-top",
        layerRole: "overlay",
        visualConcept: `Cierre limpio CTA: ${explicitTitles.outroTitle}`,
        animationChoreography: "Cierre elegante superior sincronizado con la despedida",
        svgMetaphorIdea: "Botón de cierre editorial",
        headline: explicitTitles.outroTitle,
        subheadline: explicitTitles.outroSubtitle ?? "",
        fontFamilyHint: "space-grotesk",
        sfxType: "ding",
        hideSubtitlesDuringScene: false,
      });
    }

    return cleanScenes;
  }

  if (segments.length > 0) {
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      const startSec = Number((seg.startUs / 1_000_000).toFixed(2));
      const segDur = Math.max(2.0, (seg.endUs - seg.startUs) / 1_000_000);
      const isRich =
        /\d|%|\$|€|clave|secreto|importante|resultado|crec|error|nunca|siempre|ahora|soluci[óo]n|ahorro/i.test(seg.text) ||
        i === 0 ||
        i === Math.floor(segments.length / 2);
      if (startSec < 0.25 || startSec >= totalSec - 1.2) continue;
      if (!isRich && segments.length > 4) continue;

      const idx = candidates.length;
      const durationSec = Number(Math.min(4.0, Math.max(2.3, segDur), Math.max(1.8, totalSec - startSec)).toFixed(2));
      const { headline, subheadline, metricValue } = extractShortHeadline(seg.text, idx);
      const zone =
        hasRealVideoFootage && options.visualProfile?.hasHumanSpeaker && usableZones[idx % usableZones.length] === "center-stage"
          ? "hero-top"
          : usableZones[idx % usableZones.length]!;

      candidates.push({
        id: `adaptive_scene_${idx + 1}`,
        title: headline.slice(0, 32),
        startSec,
        durationSec,
        zone,
        layerRole: hasRealVideoFootage ? "overlay" : "background-v1",
        visualConcept: `HUD procedural tema ${options.dna?.categoryLabel ?? "editorial"} enfocado en "${headline}"`,
        animationChoreography: "Entrada spring elastica con trazos SVG reactivos al audio y barrido luminoso",
        svgMetaphorIdea: metricValue ? `Anillo telemetrico destacando ${metricValue}` : "Diagrama vectorial modular dinamico",
        headline,
        subheadline,
        metricValue,
        fontFamilyHint: fontCycle[idx % fontCycle.length],
        sfxType: sfxCycle[idx % sfxCycle.length] ?? "whoosh",
        hideSubtitlesDuringScene: !hasRealVideoFootage,
      });
    }
  }

  if (candidates.length === 0 && budget.allowFallbackNoTranscriptOverlays) {
    const cleanedFallbackTopic = stripEditingMetaInstructions(options.prompt);
    const clauses = cleanedFallbackTopic
      .split(/[,.;]+|\s+y\s+/i)
      .map((c) => c.trim())
      .filter(
        (c) =>
          c.length >= 6 &&
          !isConversationalInstructionText(c) &&
          !/^(sin|no|pon|haz|edita|crea|genera|con)\b/i.test(c) &&
          !/\b(subt[íi]tulos?|zooms?|silencios?|tintes?|color|aspecto|vertical|horizontal)\b/i.test(c),
      )
      .slice(0, Math.min(2, budget.maxOverlays));
    const seeds = clauses.length > 0 ? clauses : [];

    for (let i = 0; i < seeds.length; i += 1) {
      const startSec = Number(Math.min(Math.max(0.6, i * Math.max(4.5, totalSec * 0.4) + 0.6), Math.max(0.6, totalSec - 2.2)).toFixed(2));
      const durationSec = Number(Math.min(3.5, Math.max(2.0, totalSec - startSec)).toFixed(2));
      const { headline, subheadline, metricValue } = extractShortHeadline(seeds[i]!, i);
      candidates.push({
        id: `adaptive_scene_${i + 1}`,
        title: headline.slice(0, 32),
        startSec,
        durationSec,
        zone: usableZones[i % usableZones.length]!,
        layerRole: hasRealVideoFootage ? "overlay" : "background-v1",
        visualConcept: `Gráfico transparente contextual para "${headline}"`,
        animationChoreography: "Entrada spring minimalista y limpia sin obstruir la toma",
        svgMetaphorIdea: metricValue ? `Indicador vectorial ${metricValue}` : "Trazo geométrico minimalista",
        headline,
        subheadline,
        metricValue,
        fontFamilyHint: fontCycle[i % fontCycle.length],
        sfxType: sfxCycle[i % sfxCycle.length] ?? "whoosh",
        hideSubtitlesDuringScene: false,
      });
    }
  }

  return enforceEditorialRestraint({
    scenes: candidates,
    budget,
    prompt: options.prompt,
    totalDurationSec: totalSec,
    hasRealVideoFootage,
  });
}

/**
 * Analizador heurístico local instantáneo: traduce intenciones explícitas de color,
 * velocidad, formato, recorte temporal, audio, restricciones negativas y look cinematográfico.
 */
export function deriveLocalEditDirective(
  project: Project,
  prompt: string,
  dna?: ProjectSemanticDNA,
  context?: {
    transcriptSegments?: TranscriptSegment[];
    visualProfile?: VideoVisualProfile | null;
    audioProfile?: AudioAnalysisProfile | null;
    hasPrimaryVideoMedia?: boolean;
  },
): AutonomousEditDirective {
  const lower = prompt.toLowerCase();
  const isHorizontal = project.settings.width > project.settings.height;
  const constraints = parseUserEditingConstraints(prompt);
  const toolCalls: SurgicalToolAction[] = [];

  // 1. Aspect Ratio explícito
  if (
    /\b(9:16|formato\s+vertical|para\s+tiktok|para\s+reels|para\s+shorts)\b/i.test(lower) &&
    isHorizontal
  ) {
    toolCalls.push({
      tool: "change_aspect_ratio",
      args: { aspectRatio: "9:16", autoReframe: true },
      reason: "Ajustar formato a vertical 9:16 con auto-reframe",
    });
  } else if (/\b(16:9|horizontal|para\s+youtube)\b/i.test(lower) && !isHorizontal) {
    toolCalls.push({
      tool: "change_aspect_ratio",
      args: { aspectRatio: "16:9", autoReframe: true },
      reason: "Ajustar formato a horizontal 16:9",
    });
  } else if (/\b(1:1|cuadrado)\b/i.test(lower)) {
    toolCalls.push({
      tool: "change_aspect_ratio",
      args: { aspectRatio: "1:1", autoReframe: true },
      reason: "Ajustar formato cuadrado 1:1",
    });
  }

  // 2. Gradación de color y look atmosférico (respetando restricción noColorFilter / noLetterbox / customTintHex)
  let lookPreset: HyperFrameLookPreset = "editorial-clean";
  let colorArgs: { brightness?: number; contrast?: number; saturation?: number } | null = null;
  let letterboxRatio = 0;

  if (!constraints.noColorFilter) {
    if (/\b(blanco\s+y\s+negro|monocrom|noir|b\/n)\b/i.test(lower)) {
      lookPreset = "noir-contrast";
      colorArgs = { brightness: 0.96, contrast: 1.28, saturation: 0.05 };
    } else if (/\b(cyber|ne[óo]n|futurist|matrix|hologr)\b/i.test(lower)) {
      lookPreset = "neon-cyber";
      colorArgs = { brightness: 0.95, contrast: 1.18, saturation: 1.22 };
    } else if (/\b(c[áa]lido|golden|vintage|retro|dorado)\b/i.test(lower)) {
      lookPreset = "warm-film";
      colorArgs = { brightness: 1.03, contrast: 1.1, saturation: 1.12 };
    } else if (/\b(cinematogr[áa]fico|cine|pel[íi]cula|trailer|tr[áa]iler|documental|teal|oscuro|dram[áa]tico)\b/i.test(lower)) {
      lookPreset = "cinema-teal-orange";
      colorArgs = { brightness: 0.96, contrast: 1.15, saturation: 1.08 };
      if (/\b(anam[óo]rf|barras\s+negras|letterbox|pel[íi]cula|trailer|tr[áa]iler|cine)\b/i.test(lower)) {
        letterboxRatio = isHorizontal ? 0.08 : 0.04;
      }
    } else if (/\b(brillante|vibrante|color\s+vivo|saturado|mrbeast|energi)\b/i.test(lower)) {
      lookPreset = "editorial-clean";
      colorArgs = { brightness: 1.05, contrast: 1.12, saturation: 1.24 };
    }
  }

  if (constraints.noLetterbox || constraints.noColorFilter) {
    letterboxRatio = 0;
  }

  if (colorArgs) {
    toolCalls.push({
      tool: "apply_color_adjustment",
      clipTarget: "all_visual",
      args: colorArgs,
      reason: `Gradación cromática adaptada al look "${lookPreset}"`,
    });
  }

  // 3. Velocidad explícita (ej. "1.25x", "cámara lenta", "más rápido")
  const explicitSpeed = lower.match(/\b(?:velocidad\s*(?:a|de)?\s*|a\s+)?(0\.[3-9]\d?|1\.[1-9]\d?|2(?:\.[05])?)\s*x\b/);
  if (explicitSpeed?.[1]) {
    const speedVal = Math.max(0.25, Math.min(4, Number.parseFloat(explicitSpeed[1])));
    if (Number.isFinite(speedVal) && Math.abs(speedVal - 1) > 0.04) {
      toolCalls.push({
        tool: "set_clip_speed",
        clipTarget: "primary",
        args: { speed: speedVal },
        reason: `Velocidad solicitada (${speedVal}x)`,
      });
    }
  } else if (/\b(c[áa]mara\s+lenta|slow\s*mo|ralentiza)\b/i.test(lower)) {
    toolCalls.push({
      tool: "set_clip_speed",
      clipTarget: "primary",
      args: { speed: 0.75 },
      reason: "Efecto cámara lenta cinematográfica",
    });
  } else if (/\b(r[áa]pido|acelera|din[áa]mico\s+al\s+m[áa]ximo|hyper\s*pace)\b/i.test(lower)) {
    toolCalls.push({
      tool: "set_clip_speed",
      clipTarget: "all_visual",
      args: { speed: 1.15 },
      reason: "Ritmo ágil (+15% velocidad)",
    });
  }

  // 4. Recortes explícitos, rangos temporales y highlights
  if (constraints.trimStartSeconds || constraints.trimEndSeconds) {
    toolCalls.push({
      tool: "trim_clip",
      clipTarget: "primary",
      args: {
        ...(constraints.trimStartSeconds ? { trimStartSeconds: constraints.trimStartSeconds } : {}),
        ...(constraints.trimEndSeconds ? { trimEndSeconds: constraints.trimEndSeconds } : {}),
      },
      reason: "Recorte de inicio/final solicitado por el usuario",
    });
  }

  if (constraints.keepRanges.length > 0) {
    toolCalls.push({
      tool: "keep_time_ranges",
      args: { ranges: constraints.keepRanges },
      reason: `Conservar solo ${constraints.keepRanges.length} rango(s) seleccionado(s)`,
    });
  } else if (constraints.cutRanges.length > 0) {
    // Ordenar descendente por inicio para evitar desplazamiento de índices cuando hay varios cortes
    const sortedCuts = [...constraints.cutRanges].sort((a, b) => b.startSeconds - a.startSeconds);
    for (const range of sortedCuts) {
      toolCalls.push({
        tool: "cut_time_range",
        args: {
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
          ripple: true,
        },
        reason: `Cortar segmento de ${range.startSeconds}s a ${range.endSeconds}s`,
      });
    }
  } else if (constraints.targetHighlightsSec) {
    toolCalls.push({
      tool: "select_highlights",
      args: { targetSeconds: constraints.targetHighlightsSec },
      reason: `Condensar mejores momentos (~${constraints.targetHighlightsSec}s)`,
    });
  }

  // 5. Mejora de voz
  if (/\b(voz|audio|sonido|claro|limpia\s+el\s+audio|podcast|ruido)\b/i.test(lower)) {
    toolCalls.push({
      tool: "enhance_voice",
      clipTarget: "primary",
      args: { enabled: true },
      reason: "Realce vocal para claridad editorial",
    });
  }

  // 6. Ritmo de cámara y estilo de subtítulos
  const cameraStyle = constraints.noZooms
    ? "static_clean"
    : /\b(viral|hormozi|mrbeast|fren[ée]tico|r[áa]pido|tik\s*tok|shorts)\b/i.test(lower)
      ? "whip_energetic"
      : /\b(cinematogr[áa]fico|documental|suave|lento|apple|lujo)\b/i.test(lower)
        ? "slow_cinema_push"
        : "subtle_editorial";

  const editingPace =
    cameraStyle === "whip_energetic"
      ? "rapid_viral"
      : cameraStyle === "slow_cinema_push"
        ? "slow_cinematic"
        : "balanced_editorial";

  const subtitleDisabled = constraints.noSubs;
  const subStyle =
    /\bhormozi\b/i.test(lower)
      ? "hormozi"
      : /\btiktok\b/i.test(lower)
        ? "tiktok"
        : /\b(neon|cyber)\b/i.test(lower)
          ? "neon"
          : /\b(cine|cinematic|documental|trailer)\b/i.test(lower)
            ? "cinematic"
            : /\bimpact/i.test(lower)
              ? "impact"
              : "minimal";

  const accent = constraints.customTintHex ?? dna?.masterPalette.accent ?? "#38BDF8";
  const secondary = dna?.masterPalette.secondary ?? "#818CF8";
  const surface = dna?.masterPalette.surface ?? "#090D18";
  const text = dna?.masterPalette.text ?? "#F8FAFC";

  const budget = computeEditorialBudget({
    prompt,
    project,
    hasRealVideoFootage: context?.hasPrimaryVideoMedia,
    transcriptSegments: context?.transcriptSegments,
    audioProfile: context?.audioProfile,
    visualProfile: context?.visualProfile,
    constraints,
    cameraStyle,
    lookPreset,
    letterboxRatio,
  });

  const customScenes = constraints.noGraphics
    ? []
    : deriveAdaptiveScenesFromTranscriptAndPrompt({
        prompt,
        project,
        transcriptSegments: context?.transcriptSegments,
        visualProfile: context?.visualProfile,
        dna,
        constraints,
        budget,
      });

  return {
    source: "local_heuristic",
    resolvedBudget: budget,
    editorialPlan: {
      densityTier: budget.densityTier,
      decisionRationale: budget.decisionRationale,
      maxOverlays: budget.maxOverlays,
      minOverlayGapSec: budget.minOverlayGapSec,
      maxZoomPunches: budget.maxZoomPunches,
      minPunchGapSec: budget.minPunchGapSec,
      maxSfx: budget.maxSfx,
      minSfxGapSec: budget.minSfxGapSec,
      maxOpticalTransitions: budget.maxOpticalTransitions,
      minTransitionGapSec: budget.minTransitionGapSec,
      applyAtmosphereLayer: budget.applyAtmosphereLayer,
      applyOpticalTransitionsOnJumpCuts: budget.applyOpticalTransitionsOnJumpCuts,
    },
    artDirection: {
      palette: { accent, secondary, surface, text },
      visualTheme: dna?.categoryLabel ?? "Editorial Pro",
      typographyStyle:
        lookPreset === "neon-cyber"
          ? "tech_mono"
          : editingPace === "rapid_viral"
            ? "bold_kinetic"
            : lookPreset === "warm-film"
              ? "editorial_serif"
              : "clean_geometric",
      editingPace,
      cameraStyle,
      colorMood: constraints.customTintHex ? `${lookPreset} (${constraints.customTintHex})` : lookPreset,
    },
    timelineToolCalls: toolCalls,
    subtitleDirective: {
      enabled: !subtitleDisabled,
      style: subStyle,
      hideDuringFullScreenScenes: true,
      placement: "adaptive",
    },
    atmosphereLook: {
      enabled: !constraints.noColorFilter && budget.applyAtmosphereLayer,
      lookPreset,
      letterboxRatio,
      vignetteIntensity: lookPreset === "editorial-clean" ? 0.25 : 0.44,
      grainOpacity: lookPreset === "warm-film" || lookPreset === "noir-contrast" ? 0.055 : 0.025,
      glowIntensity: lookPreset === "neon-cyber" ? 0.38 : 0.2,
      ...(constraints.customTintHex && !constraints.noColorFilter ? { customTintHex: constraints.customTintHex } : {}),
    },
    customScenes,
    narrativeSummary: `${budget.decisionRationale}. Look ${lookPreset}, ritmo ${editingPace}.`,
  };
}

const AUTONOMOUS_DIRECTOR_PROMPT = `Eres un Director Cinematográfico, Editor Senior de Postproducción y Arquitecto de Motion Graphics en Remotion v4 × HyperFrames.
Analizas un proyecto real de video + su transcripción con timestamps [startSec -> endSec] + la petición del usuario y generas un PLAN DE EDICIÓN AUTÓNOMO EXTRAORDINARIO y 100% personalizado (CERO plantillas repetitivas).

REGLAS CRÍTICAS:
1. NUNCA uses siempre los mismos colores o layouts: deduce una dirección de arte única según el tema exacto (ej. ciencia/cuántica, finanzas/banca, lujo/arquitectura, cine/documental, gaming/cyber, fitness/viral, cocina/orgánico) o cualquier color hexadecimal que pida el usuario.
2. RESPETO ABSOLUTO A RESTRICCIONES DEL USUARIO:
   - Si pide "sin subtítulos" -> subtitleDirective.enabled = false.
   - Si pide "sin zooms" / "cámara fija" -> artDirection.cameraStyle = "static_clean".
   - Si pide "sin gráficos" / "solo video limpio" -> customScenes = [].
   - Si pide "sin barras negras" -> atmosphereLook.letterboxRatio = 0.
   - Si pide "color natural" / "sin filtros" -> NO uses apply_color_adjustment y atmosphereLook.enabled = false.
   - Si menciona un rango temporal o segmento hablado para cortar o conservar, USA cut_time_range o keep_time_ranges sobre los timestamps reales de transcriptExcerpt!
3. ACCIONES QUIRÚRGICAS EN TIMELINE ("timelineToolCalls"):
   - Herramientas permitidas y sus argumentos EXACTOS:
     * cut_time_range: args: { startSeconds: number, endSeconds: number, ripple?: boolean } — CORTA un intervalo exacto de tiempo (muletillas, errores, intros aburridas, repeticiones detectadas en [startSec -> endSec]). Si emites varios cortes, ordénalos de mayor a menor startSeconds.
     * keep_time_ranges: args: { ranges: [{ startSeconds: number, endSeconds: number }] } — Conserva ÚNICAMENTE los mejores segmentos/momentos y elimina todo lo demás limpiamente.
     * select_highlights: args: { targetSeconds: number } — Condensación inteligente de los mejores momentos si el usuario pide un resumen o versión corta.
     * remove_silences: args: { minSilenceMs?: number, paddingMs?: number } — Elimina silencios muertos (no la llames si pidió NO cortar silencios).
     * split_clip: clipTarget="primary" | clipId, args: { atSeconds?: number, atFrame?: number }
     * apply_color_adjustment: clipTarget="all_visual" | clipId, args: { brightness?: 0.5..1.6, contrast?: 0.6..1.6, saturation?: 0..1.7 }
     * set_clip_speed: clipTarget="primary" | clipId, args: { speed: 0.4..3.0 }
     * adjust_audio: clipTarget="primary" | clipId, args: { volume?: 0..1.5, enhanceVoice?: boolean, fadeInFrames?: number, fadeOutFrames?: number }
     * enhance_voice: clipTarget="primary", args: { enabled: true }
     * change_aspect_ratio: args: { aspectRatio: "9:16"|"16:9"|"1:1", autoReframe: true }
     * trim_clip: clipTarget="primary" | clipId, args: { trimStartSeconds?: number, trimEndSeconds?: number }
     * set_clip_animation: clipTarget="primary" | clipId, args: { animationIn?: "fade-in"|"zoom-in"|"slide-up", animationOut?: "fade-out" }
4. CRITERIO EDITORIAL, CONTENCIÓN Y CONTRASTE ("MENOS ELEMENTOS = MAYOR IMPACTO"):
   - Libre edición NO significa saturar cada segundo con gráficos, zooms y sonidos. Un editor humano de primer nivel ANALIZA qué aporta valor emocional o informativo y DECIDE cuándo dejar el plano limpio para que los momentos clave realmente golpeen al espectador!
   - Evita el "ruido visual": deja tramos limpios sin overlays ni zooms para crear contraste, tensión y relajación.
   - Incluye el bloque "editorialPlan" explicando tu decisión artística ("densityTier": "restraint" | "curated" | "kinetic", "decisionRationale", "maxOverlays", "maxZoomPunches", "maxSfx", "applyAtmosphereLayer").
   - Respeta estrictamente el PRESUPUESTO EDITORIAL indicado en el payload: en vídeos con presentador real ("hasRealVideoFootage": true), elige SOLO los picos más altos (ej. una cifra clave, una tesis central o un giro narrativo) usando layerRole="overlay" en zona segura ("hero-top", "top-right-hud", "top-left-hud"). Si un metraje no tiene locución ni pide gráficos explícitos y funciona mejor puro, devuelve customScenes = []!
   - En videos generativos DESDE CERO sin metraje real ("hasRealVideoFootage": false), ERES EL DIRECTOR VISUAL TOTAL:
     * Diseña UNA ESCENA "layerRole": "background-v1" única y continua por cada acto o bloque narrativo (empezando desde t=0 y cubriendo toda la duración sin huecos negros!), combinando Canvas 2D generativo, geometría 3D en perspectiva, ondas SVG reactivas al audio y diseño editorial de estudio!
     * Añade overlays "layerRole": "overlay" únicamente en momentos de alto impacto dentro del presupuesto, sin colisionar con la franja inferior de subtítulos.
     * PROHIBIDO repetir el mismo patrón visual entre escenas consecutivas: varía metáforas, composiciones, tipografía ("Inter", "Grandstander", "Anton", "Bebas Neue", "Playfair Display", "Space Grotesk") y movimiento de cámara.
   - Describe "visualConcept", "animationChoreography" y "svgMetaphorIdea" con extrema riqueza visual cuando decidas incluir una escena.
5. SUBTÍTULOS CONTEXTUALES ("subtitleDirective"):
   - Evalúa estilo ("minimal" | "tiktok" | "hormozi" | "cinematic" | "neon" | "impact") y activa "hideDuringFullScreenScenes": true para ocultar subtítulos cuando un gráfico central protagonice la pantalla.
6. ATMÓSFERA Y LOOK ("atmosphereLook"):
   - Ajusta "lookPreset" ("cinema-teal-orange" | "noir-contrast" | "neon-cyber" | "warm-film" | "editorial-clean"), "customTintHex" ("#HEX" opcional si el usuario pide un color/ambiente específico como verde Matrix, rojo alarma, dorado, cyan eléctrico), barras "letterboxRatio" (0 para editorial/vertical puro, 0.06..0.10 para trailers/documentales/cine), viñeta y glow.

Responde ÚNICAMENTE con un objeto JSON válido siguiendo exactamente este esquema:
{
  "artDirection": {
    "palette": { "accent": "#HEX", "secondary": "#HEX", "surface": "#HEX", "text": "#HEX" },
    "visualTheme": "nombre breve único del tema visual",
    "typographyStyle": "editorial_serif" | "bold_kinetic" | "tech_mono" | "clean_geometric",
    "editingPace": "rapid_viral" | "balanced_editorial" | "slow_cinematic",
    "cameraStyle": "whip_energetic" | "slow_cinema_push" | "subtle_editorial" | "static_clean",
    "colorMood": "descripción corta del tono de color"
  },
  "editorialPlan": {
    "densityTier": "curated",
    "decisionRationale": "Por qué elegiste estos momentos concretos y dejaste el resto limpio para maximizar el impacto",
    "maxOverlays": 3,
    "maxZoomPunches": 3,
    "maxSfx": 4,
    "applyAtmosphereLayer": true
  },
  "timelineToolCalls": [ ... ],
  "subtitleDirective": {
    "enabled": true,
    "style": "cinematic",
    "hideDuringFullScreenScenes": true,
    "placement": "adaptive"
  },
  "atmosphereLook": {
    "enabled": true,
    "lookPreset": "cinema-teal-orange",
    "customTintHex": "#0EA5E9",
    "letterboxRatio": 0.08,
    "vignetteIntensity": 0.42,
    "grainOpacity": 0.035,
    "glowIntensity": 0.25
  },
  "customScenes": [
    {
      "id": "scene_1",
      "title": "Nombre de escena",
      "startSec": 0.5,
      "durationSec": 4.2,
      "zone": "hero-top",
      "layerRole": "overlay",
      "visualConcept": "Concepto visual único...",
      "animationChoreography": "Spring d=14 + SVG path stroke-dashoffset + stagger...",
      "svgMetaphorIdea": "Diagrama vectorial concreto...",
      "headline": "TITULAR CORTO",
      "subheadline": "Subtítulo o dato de apoyo",
      "metricValue": "+84%",
      "sfxType": "whoosh",
      "hideSubtitlesDuringScene": false
    }
  ],
  "narrativeSummary": "Resumen en 1 frase de tu visión de edición"
}`;

export interface NarrativeBlockHint {
  label: string;
  startSec: number;
  durationSec: number;
  narration?: string;
  cardKind?: string;
}

export interface BrandContextHint {
  brandName: string;
  domain: string;
  tagline: string;
  palette: { accent: string; secondary: string; surface: string; text: string } | Record<string, string>;
  keyFeatures?: string[];
}

export async function planAutonomousEditDirective(options: {
  project: Project;
  prompt: string;
  transcriptSegments?: TranscriptSegment[];
  silenceIntervals?: Array<{ startUs: number; endUs: number }>;
  visualProfile?: VideoVisualProfile | null;
  audioProfile?: AudioAnalysisProfile | null;
  dna?: ProjectSemanticDNA;
  narrativeBlocksHint?: NarrativeBlockHint[];
  brandContext?: BrandContextHint | null;
  availableSkills?: string[];
  hasPrimaryVideoMedia?: boolean;
  signal: AbortSignal;
  chatJsonFn?: ChatJsonFn;
}): Promise<AutonomousEditDirective> {
  const constraints = parseUserEditingConstraints(options.prompt);
  const baseline = deriveLocalEditDirective(options.project, options.prompt, options.dna, {
    transcriptSegments: options.transcriptSegments,
    visualProfile: options.visualProfile,
    audioProfile: options.audioProfile,
    hasPrimaryVideoMedia: options.hasPrimaryVideoMedia,
  });

  const canUseAi = Boolean(options.chatJsonFn) || (aiChatReady() && aiStatus().chat);
  if (!canUseAi) {
    return baseline;
  }

  const telemetry = buildProjectTelemetrySummary(
    options.project,
    options.transcriptSegments,
    options.silenceIntervals,
  );
  if (options.hasPrimaryVideoMedia === false) {
    telemetry.hasRealVideoFootage = false;
  }

  const baselineBudget =
    baseline.resolvedBudget ??
    computeEditorialBudget({
      prompt: options.prompt,
      project: options.project,
      hasRealVideoFootage: telemetry.hasRealVideoFootage,
      totalDurationSec: telemetry.totalDurationSec,
      transcriptSegments: options.transcriptSegments,
      audioProfile: options.audioProfile,
      visualProfile: options.visualProfile,
      constraints,
      cameraStyle: baseline.artDirection.cameraStyle,
      lookPreset: baseline.atmosphereLook.lookPreset,
      letterboxRatio: baseline.atmosphereLook.letterboxRatio,
    });

  const visualContextBlock = options.visualProfile
    ? `INSPECCIÓN VISUAL REAL DE KEYFRAMES (VLM):\n- Encuadre sujeto: ${options.visualProfile.subjectFraming} (presentador=${options.visualProfile.hasHumanSpeaker})\n- Iluminación real: ${options.visualProfile.lightingMood}\n- Colores dominantes en toma: ${options.visualProfile.dominantColors.join(", ")}\n- Zonas seguras recomendadas sin oclusión: ${options.visualProfile.safeOverlayZones.join(", ")}\n- Notas visuales: ${options.visualProfile.visualSummary}`
    : "";

  const audioContextBlock = options.audioProfile
    ? `TELEMETRÍA ACÚSTICA REAL:\n- ${options.audioProfile.report}\n- Picos de energía vocal (seg): ${options.audioProfile.peakImpactFrames.map((f) => Number((f / Math.max(1, telemetry.fps)).toFixed(1))).join(", ") || "continuo"}\n- Cortes de plano visual detectados (seg): ${options.audioProfile.sceneTimestampsSec.slice(0, 12).join(", ") || "plano continuo"}`
    : "";

  const blocksContext =
    options.narrativeBlocksHint && options.narrativeBlocksHint.length > 0
      ? `BLOQUES NARRATIVOS / TIMINGS REALES DE LOCUCIÓN (cubre TODOS los bloques con escenas background-v1 únicas + overlays):\n${JSON.stringify(options.narrativeBlocksHint, null, 2)}`
      : "";

  const brandBlock = options.brandContext
    ? `IDENTIDAD DE MARCA EXTRAÍDA:\n${JSON.stringify(options.brandContext, null, 2)}`
    : "";

  const skillsBlock =
    options.availableSkills && options.availableSkills.length > 0
      ? `SKILLS DISPONIBLES EN EL ESTUDIO:\n${options.availableSkills.join(", ")}`
      : "";

  const editorialGuidanceBlock = [
    `PRESUPUESTO Y CRITERIO EDITORIAL (CONTENCIÓN = IMPACTO):`,
    `- Nivel recomendado: ${baselineBudget.densityTier} (${baselineBudget.decisionRationale})`,
    `- Tope de overlays HUD: <= ${baselineBudget.maxOverlays} (espacio libre mínimo entre ellos: ${baselineBudget.minOverlayGapSec}s; cobertura máx. ${Math.round(baselineBudget.maxScreenCoverageRatio * 100)}% del vídeo)`,
    `- Tope de zooms de énfasis: <= ${baselineBudget.maxZoomPunches} (espaciados >= ${baselineBudget.minPunchGapSec}s)`,
    `- Tope de micro-SFX: <= ${baselineBudget.maxSfx} (espaciados >= ${baselineBudget.minSfxGapSec}s)`,
    `- Tope de transiciones ópticas: <= ${baselineBudget.maxOpticalTransitions} (solo cambios de acto/tema, NO flashes sobre cortes de silencio)`,
    `- Toma decisiones conscientes: deja aire visual antes y después de cada momento fuerte para provocar verdadero impacto en el espectador final.`,
  ].join("\n");

  const userPayload = [
    `PETICIÓN DEL USUARIO:\n"${options.prompt}"`,
    `TELEMETRÍA DEL PROYECTO:\n${JSON.stringify(telemetry, null, 2)}`,
    editorialGuidanceBlock,
    visualContextBlock,
    audioContextBlock,
    blocksContext,
    brandBlock,
    skillsBlock,
    options.dna
      ? `ADN SEMÁNTICO INICIAL:\nCategoría=${options.dna.categoryLabel}, Tono=${options.dna.emotionalTone}, Paleta=${JSON.stringify(options.dna.masterPalette)}`
      : "",
    `IMPORTANTE: Limita timelineToolCalls a cambios reales útiles (${telemetry.hasRealVideoFootage ? "hay video real en V1; alinea color/encuadre con la inspección visual y respeta respiro visual sin saturar" : "NO hay video cámara en V1: genera escenas 'background-v1' completas y distintas para cada bloque + overlays HUD selectos"}), aprovecha sfxType ("whoosh", "pop", "ding", "riser", "subhit", "glitch") solo en picos y crea customScenes acordes a la duración real (~${Math.max(8, Math.round(telemetry.totalDurationSec || 25))}s).`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const caller = options.chatJsonFn ?? chatJson;

  try {
    const res = await caller(AUTONOMOUS_DIRECTOR_PROMPT, userPayload, options.signal, {
      maxTokens: 2800,
      temperature: 0.38,
    });

    const parsed = AutonomousEditDirectiveSchema.safeParse(res.data);
    if (!parsed.success) {
      console.warn("[AutonomousEditorBrain] Respuesta LLM no cumple esquema completo:", parsed.error.issues[0]?.message);
      return baseline;
    }

    // Combinar llamadas explícitas locales que el modelo haya podido omitir y respetar restricciones negativas
    const aiToolNames = new Set(parsed.data.timelineToolCalls.map((c) => c.tool));
    let mergedTools = parsed.data.timelineToolCalls.filter((call) => {
      if (constraints.noSilenceCut && call.tool === "remove_silences") return false;
      if (constraints.noColorFilter && call.tool === "apply_color_adjustment") return false;
      return true;
    });
    for (const localCall of baseline.timelineToolCalls) {
      if (localCall.tool === "cut_time_range" || !aiToolNames.has(localCall.tool)) {
        const alreadySameCut =
          localCall.tool === "cut_time_range" &&
          mergedTools.some(
            (m) =>
              m.tool === "cut_time_range" &&
              Math.abs(Number(m.args.startSeconds) - Number(localCall.args.startSeconds)) < 0.4,
          );
        if (!alreadySameCut) {
          mergedTools.push(localCall);
        }
      }
    }
    if (constraints.noColorFilter) {
      mergedTools = mergedTools.filter((t) => t.tool !== "apply_color_adjustment");
    }

    const effectiveCameraStyle = constraints.noZooms ? ("static_clean" as const) : parsed.data.artDirection.cameraStyle;
    const effectiveLetterboxRatio =
      constraints.noLetterbox || constraints.noColorFilter ? 0 : parsed.data.atmosphereLook.letterboxRatio;
    const postAiBudget = computeEditorialBudget({
      prompt: options.prompt,
      project: options.project,
      hasRealVideoFootage: telemetry.hasRealVideoFootage,
      totalDurationSec: telemetry.totalDurationSec,
      transcriptSegments: options.transcriptSegments,
      audioProfile: options.audioProfile,
      visualProfile: options.visualProfile,
      constraints,
      cameraStyle: effectiveCameraStyle,
      lookPreset: parsed.data.atmosphereLook.lookPreset,
      letterboxRatio: effectiveLetterboxRatio,
    });

    // El modelo puede decidir ser AÚN MÁS contenido que el tope seguro, nunca más saturado que las cotas seguras
    const tierRank: Record<EditorialDensityTier, number> = {
      restraint: 0,
      curated: 1,
      kinetic: 2,
    };
    const aiPlan = parsed.data.editorialPlan;
    const clampedDensityTier: EditorialDensityTier =
      aiPlan?.densityTier && tierRank[aiPlan.densityTier] <= tierRank[postAiBudget.densityTier]
        ? aiPlan.densityTier
        : postAiBudget.densityTier;
    const mergedBudget: EditorialBudget = {
      ...postAiBudget,
      densityTier: clampedDensityTier,
      decisionRationale: aiPlan?.decisionRationale || postAiBudget.decisionRationale,
      maxOverlays:
        aiPlan?.maxOverlays !== undefined
          ? Math.min(aiPlan.maxOverlays, postAiBudget.maxOverlays)
          : postAiBudget.maxOverlays,
      minOverlayGapSec:
        aiPlan?.minOverlayGapSec !== undefined
          ? Math.max(aiPlan.minOverlayGapSec, postAiBudget.minOverlayGapSec)
          : postAiBudget.minOverlayGapSec,
      maxZoomPunches:
        constraints.noZooms
          ? 0
          : aiPlan?.maxZoomPunches !== undefined
            ? Math.min(aiPlan.maxZoomPunches, postAiBudget.maxZoomPunches)
            : postAiBudget.maxZoomPunches,
      minPunchGapSec:
        aiPlan?.minPunchGapSec !== undefined
          ? Math.max(aiPlan.minPunchGapSec, postAiBudget.minPunchGapSec)
          : postAiBudget.minPunchGapSec,
      maxSfx:
        constraints.noSfx
          ? 0
          : aiPlan?.maxSfx !== undefined
            ? Math.min(aiPlan.maxSfx, postAiBudget.maxSfx)
            : postAiBudget.maxSfx,
      minSfxGapSec:
        aiPlan?.minSfxGapSec !== undefined
          ? Math.max(aiPlan.minSfxGapSec, postAiBudget.minSfxGapSec)
          : postAiBudget.minSfxGapSec,
      maxOpticalTransitions:
        aiPlan?.maxOpticalTransitions !== undefined
          ? Math.min(aiPlan.maxOpticalTransitions, postAiBudget.maxOpticalTransitions)
          : postAiBudget.maxOpticalTransitions,
      minTransitionGapSec:
        aiPlan?.minTransitionGapSec !== undefined
          ? Math.max(aiPlan.minTransitionGapSec, postAiBudget.minTransitionGapSec)
          : postAiBudget.minTransitionGapSec,
      applyAtmosphereLayer:
        constraints.noColorFilter
          ? false
          : aiPlan?.applyAtmosphereLayer ?? postAiBudget.applyAtmosphereLayer,
      applyOpticalTransitionsOnJumpCuts:
        aiPlan?.applyOpticalTransitionsOnJumpCuts ?? postAiBudget.applyOpticalTransitionsOnJumpCuts,
    };

    const explicitTitles = extractExplicitPromptTitles(options.prompt);
    const shouldUseBaselineCleanTitles =
      telemetry.hasRealVideoFootage &&
      explicitTitles.isCleanMinimal &&
      (Boolean(explicitTitles.introTitle) || Boolean(explicitTitles.outroTitle)) &&
      baseline.customScenes.length > 0;

    const effectiveCustomScenes = constraints.noGraphics
      ? []
      : shouldUseBaselineCleanTitles
        ? baseline.customScenes
        : enforceEditorialRestraint({
            scenes: parsed.data.customScenes,
            budget: mergedBudget,
            prompt: options.prompt,
            totalDurationSec: telemetry.totalDurationSec,
            hasRealVideoFootage: telemetry.hasRealVideoFootage,
          });

    const effectiveAtmosphereEnabled =
      !constraints.noColorFilter &&
      !explicitTitles.isCleanMinimal &&
      parsed.data.atmosphereLook.enabled &&
      (Boolean(constraints.customTintHex) ||
        Boolean(parsed.data.atmosphereLook.customTintHex) ||
        effectiveLetterboxRatio > 0 ||
        parsed.data.atmosphereLook.lookPreset !== "editorial-clean" ||
        mergedBudget.applyAtmosphereLayer);

    return {
      ...parsed.data,
      resolvedBudget: mergedBudget,
      editorialPlan: {
        densityTier: mergedBudget.densityTier,
        decisionRationale: mergedBudget.decisionRationale,
        maxOverlays: mergedBudget.maxOverlays,
        minOverlayGapSec: mergedBudget.minOverlayGapSec,
        maxZoomPunches: mergedBudget.maxZoomPunches,
        minPunchGapSec: mergedBudget.minPunchGapSec,
        maxSfx: mergedBudget.maxSfx,
        minSfxGapSec: mergedBudget.minSfxGapSec,
        maxOpticalTransitions: mergedBudget.maxOpticalTransitions,
        minTransitionGapSec: mergedBudget.minTransitionGapSec,
        applyAtmosphereLayer: mergedBudget.applyAtmosphereLayer,
        applyOpticalTransitionsOnJumpCuts: mergedBudget.applyOpticalTransitionsOnJumpCuts,
      },
      artDirection: {
        ...parsed.data.artDirection,
        cameraStyle: effectiveCameraStyle,
        ...(constraints.customTintHex && !constraints.noColorFilter
          ? {
              palette: {
                ...parsed.data.artDirection.palette,
                accent: constraints.customTintHex,
              },
            }
          : {}),
      },
      subtitleDirective: {
        ...parsed.data.subtitleDirective,
        enabled: constraints.noSubs ? false : parsed.data.subtitleDirective.enabled,
      },
      atmosphereLook: {
        ...parsed.data.atmosphereLook,
        enabled: effectiveAtmosphereEnabled,
        letterboxRatio: effectiveLetterboxRatio,
        ...(constraints.customTintHex && !constraints.noColorFilter
          ? { customTintHex: parsed.data.atmosphereLook.customTintHex ?? constraints.customTintHex }
          : {}),
      },
      customScenes: effectiveCustomScenes,
      timelineToolCalls: mergedTools.slice(0, 14),
      source: "ai_director",
    };
  } catch (err) {
    console.warn("[AutonomousEditorBrain] Fallback al analizador local:", err);
    return baseline;
  }
}

function clampArgNumber(value: unknown, min: number, max: number): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(min, Math.min(max, num));
}

function resolveTargetClipIds(
  project: Project,
  clipTarget: string | undefined,
  toolName: string,
): string[] {
  const allMediaClips: MediaClip[] = [];
  for (const track of project.tracks) {
    if (/motion|overlay|subt|transici|atm[óo]sfera/i.test(track.name)) continue;
    for (const clip of track.clips) {
      if (clip.type !== "text") {
        allMediaClips.push(clip);
      }
    }
  }

  const isAudioTool = toolName === "adjust_audio" || toolName === "enhance_voice";
  const visualClips = allMediaClips.filter((c) => c.type === "video" || c.type === "image");
  const audioCapableClips = allMediaClips.filter((c) => c.type === "audio" || c.type === "video");

  if (!clipTarget || clipTarget === "primary") {
    const first = isAudioTool ? audioCapableClips[0] : visualClips[0];
    return first ? [first.id] : [];
  }

  if (clipTarget === "all_visual") {
    return visualClips.map((c) => c.id);
  }

  if (clipTarget === "all_audio") {
    return audioCapableClips.map((c) => c.id);
  }

  const exactExists = allMediaClips.some((c) => c.id === clipTarget);
  if (exactExists) return [clipTarget];

  // Si la IA inventó un clipId inexistente, caemos de forma segura al clip principal
  const fallback = isAudioTool ? audioCapableClips[0] : visualClips[0];
  return fallback ? [fallback.id] : [];
}

function sanitizeToolArgs(
  toolName: string,
  rawArgs: Record<string, unknown>,
  resolvedClipId?: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...rawArgs };
  if (resolvedClipId && toolName !== "change_aspect_ratio") {
    args.clipId = resolvedClipId;
  }

  if (toolName === "apply_color_adjustment") {
    if (args.brightness !== undefined) args.brightness = clampArgNumber(args.brightness, 0.2, 2);
    if (args.contrast !== undefined) args.contrast = clampArgNumber(args.contrast, 0.2, 2);
    if (args.saturation !== undefined) args.saturation = clampArgNumber(args.saturation, 0, 2);
  } else if (toolName === "set_clip_speed") {
    args.speed = clampArgNumber(args.speed ?? 1, 0.25, 4) ?? 1;
  } else if (toolName === "adjust_audio") {
    if (args.volume !== undefined) args.volume = clampArgNumber(args.volume, 0, 2);
  } else if (toolName === "set_clip_opacity") {
    args.opacity = clampArgNumber(args.opacity ?? 1, 0, 1) ?? 1;
  }

  return args;
}

export interface SurgicalExecutionResult {
  project: Project;
  appliedTools: string[];
  skippedTools: Array<{ tool: string; reason: string }>;
}

const GLOBAL_TIMELINE_TOOLS = new Set([
  "change_aspect_ratio",
  "cut_time_range",
  "keep_time_ranges",
  "remove_silences",
  "select_highlights",
]);

/**
 * Ejecuta acciones quirúrgicas reales del catálogo `tools.ts` sobre la línea de tiempo,
 * resolviendo targets simbólicos ("primary", "all_visual") y aislando fallos individuales.
 */
export async function executeSurgicalTimelineTools(options: {
  projectId: string;
  project: Project;
  toolCalls: SurgicalToolAction[];
  signal: AbortSignal;
  resolveTool?: ToolRunnerFn;
}): Promise<SurgicalExecutionResult> {
  let currentProject = options.project;
  const appliedTools: string[] = [];
  const skippedTools: Array<{ tool: string; reason: string }> = [];

  if (options.toolCalls.length === 0) {
    return { project: currentProject, appliedTools, skippedTools };
  }

  const getToolDef: ToolRunnerFn =
    options.resolveTool ??
    (async (name: string) => {
      const mod = await import("./tools");
      return mod.getTool(name);
    });

  for (const call of options.toolCalls) {
    if (options.signal.aborted) break;

    try {
      const def = await getToolDef(call.tool);

      if (GLOBAL_TIMELINE_TOOLS.has(call.tool)) {
        const parsed = def.argsSchema.parse(call.args);
        const res = await def.execute(
          {
            projectId: options.projectId,
            project: currentProject,
            signal: options.signal,
            setProgress: () => undefined,
          },
          parsed,
        );
        if (res.project) currentProject = res.project;
        appliedTools.push(`${call.tool}: ${res.summary}`);
        continue;
      }

      const targetIds = resolveTargetClipIds(currentProject, call.clipTarget, call.tool);
      if (targetIds.length === 0) {
        if (call.tool === "apply_color_adjustment" && Object.keys(call.args).length > 0) {
          // apply_color_adjustment permite clipId opcional sobre visuales existentes
          skippedTools.push({ tool: call.tool, reason: "Sin clips objetivo aún en V1" });
        } else {
          skippedTools.push({ tool: call.tool, reason: "No hay clip objetivo compatible" });
        }
        continue;
      }

      for (const clipId of targetIds) {
        const cleanArgs = sanitizeToolArgs(call.tool, call.args, clipId);
        const parsed = def.argsSchema.parse(cleanArgs);
        const res = await def.execute(
          {
            projectId: options.projectId,
            project: currentProject,
            signal: options.signal,
            setProgress: () => undefined,
          },
          parsed,
        );
        if (res.project) currentProject = res.project;
        appliedTools.push(`${call.tool}: ${res.summary}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skippedTools.push({ tool: call.tool, reason: message });
    }
  }

  return {
    project: currentProject,
    appliedTools,
    skippedTools,
  };
}

/**
 * Auditoría estática de seguridad sobre el TSX generado antes o junto con esbuild:
 * impide APIs destructivas del navegador/Node y garantiza React/Remotion puro y determinista.
 */
export function auditRemotionComponentSafety(code: string): { ok: boolean; error?: string } {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: "El código generado está vacío." };
  }

  const forbiddenPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bfetch\s*\(/, reason: "Prohibido usar fetch() dentro de un componente Remotion determinista." },
    { pattern: /\bXMLHttpRequest\b/, reason: "Prohibido XMLHttpRequest dentro de componentes Remotion." },
    { pattern: /\b(localStorage|sessionStorage|indexedDB)\b/, reason: "Prohibido acceso a Storage en tiempo de render." },
    { pattern: /\b(eval|new\s+Function)\s*\(/, reason: "Prohibida evaluación dinámica eval/Function." },
    { pattern: /\brequestAnimationFrame\b/, reason: "Prohibido requestAnimationFrame; toda animación debe derivarse de useCurrentFrame()." },
    { pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(/, reason: "Prohibido timers mutables setTimeout/setInterval; usa frames." },
    { pattern: /Date\.now\s*\(\)|Math\.random\s*\(\)/, reason: "Usa random(seed) o matemática determinista con frame en lugar de Date.now()/Math.random()." },
  ];

  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(trimmed)) {
      return { ok: false, error: rule.reason };
    }
  }

  if (!/useCurrentFrame\s*\(/.test(trimmed) && !/AbsoluteFill/.test(trimmed)) {
    return {
      ok: false,
      error: "El componente debe usar Remotion (`AbsoluteFill` y `useCurrentFrame()`).",
    };
  }

  return { ok: true };
}

export async function verifyRemotionComponentTsx(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const safety = auditRemotionComponentSafety(code);
  if (!safety.ok) return safety;
  return validateTsx(code);
}

const HYPERFRAMES_STUDIO_CODEGEN_PROMPT = `Eres un Director de Motion Graphics Senior especializado en Remotion v4 + arquitectura HyperFrames.
Debes escribir UN componente React + Remotion TSX 100% original, visualmente extraordinario y determinista a 60fps para una escena concreta.

REGLAS TÉCNICAS ESTRICTAS:
1. Imports permitidos ÚNICAMENTE de "react" y "remotion":
   \`import React, { useRef, useEffect } from "react";\` (u otros hooks puros de react)
   \`import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing, random } from "remotion";\`
2. PROHIBIDO usar paquetes externos, fetch, Date.now(), Math.random(), setTimeout o requestAnimationFrame. Usa matemática determinista o \`random("seed")\` de remotion.
3. Si usas \`interpolate\`, SIEMPRE pasa 3er argumento outputRange y mantén inputRange estrictamente creciente: \`interpolate(frame, [0, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })\`.
4. Tipografías locales garantizadas en el runtime y exportador: "Inter", "Grandstander", "Anton", "Bebas Neue", "Playfair Display", "Space Grotesk". Úsalas directamente en \`fontFamily\` según el carácter visual.
5. Propiedad \`zone\` y TRANSPARENCIA:
   - Si \`layerRole === "overlay"\`, el \`<AbsoluteFill>\` raíz DEBE tener \`backgroundColor: "transparent"\` y \`pointerEvents: "none"\`, confinando el card/gráfico a su zona segura:
     * "hero-top": alineado arriba (\`justifyContent: "flex-start", padding: "7% 6% 0"\`) dejando libre el centro y el tercio inferior para subtítulos/sujeto.
     * "top-right-hud" / "top-left-hud": esquina superior compacta sin tapar el rostro central.
     * "lower-third": barra elegante en la zona baja con margen seguro.
     * "center-stage": composición protagonista centrada (solo si es momento sin rostro).
   - Si \`layerRole === "background-v1"\` o \`"full-scene"\`, eres la ESCENA VISUAL PROTAGONISTA A PANTALLA COMPLETA (100% width/height, fondo opaco rico en atmósfera): construye múltiples capas visuales reales (gradientes cinematográficos dinámicos, HTML5 \`<canvas>\` 2D determinista vía \`useRef\` + \`useEffect\` en función de \`frame\`, mallas SVG vectoriales con \`strokeDashoffset\`, CSS 3D con \`perspective: 1100px\` y profundidad parallax), ¡NUNCA un simple cuadro estático!
6. TÉCNICA HYPERFRAMES AVANZADA (combina varias según la escena):
   - Canvas 2D generativo determinista (\`useRef<HTMLCanvasElement>\` + \`useEffect\` redibujado en cada \`frame\` con \`random(seed)\`, partículas conectadas, ondas o topografía 3D).
   - SVG personalizados complejos con animación real de trazo (\`strokeDasharray\` / \`strokeDashoffset\`), nodos pulsantes, ondas de frecuencia, gráficos de área o diagramas vectoriales creados a medida.
   - CSS 3D (\`perspective: 1100px\`, \`rotateX\`, \`rotateY\`, \`transformStyle: "preserve-3d"\`) impulsado por \`spring()\`.
   - Tipografía cinética con \`letterSpacing\`, badges tipo píldora glassmorphism (\`backdropFilter: "blur(16px)"\`, bordes lumínicos sutiles \`rgba(..., 0.35)\`), contadores animados con \`Math.round()\`.
   - Entradas con \`spring({ frame, fps, config: { damping: 16, stiffness: 135 } })\` y salidas limpias en los últimos 14 frames.
   - Audio-reactividad real: \`props.audioPeaks\` contiene un array \`number[]\` (valores 0..1 muestreados a 4Hz, es decir \`Math.floor((frame / fps) * 4)\`). Úsalo de forma segura con fallback (\`const peak = Array.isArray(props.audioPeaks) ? (props.audioPeaks[Math.min(props.audioPeaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4))] ?? 0.35) : 0.35\`) para modular glows, pulsos SVG, barras de espectro o micro-escala al ritmo real de la voz/música.

RESPONDE ÚNICAMENTE CON JSON VÁLIDO:
{
  "componentName": "NombrePascalCaseSinEspacios",
  "compositionId": "nombreComp",
  "reasoning": "Breve explicación de la técnica visual aplicada",
  "code": "código TSX completo compilable"
}`;

export interface SynthesizedRemotionScene {
  ok: true;
  componentName: string;
  compositionId: string;
  code: string;
  props: Record<string, unknown>;
  repairedAttempts: number;
}

export interface FailedRemotionSynthesis {
  ok: false;
  error: string;
}

export async function synthesizeValidatedRemotionScene(options: {
  scene: BespokeSceneBrief;
  artDirection: AutonomousEditDirective["artDirection"];
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  signal: AbortSignal;
  maxRepairAttempts?: number;
  chatJsonFn?: ChatJsonFn;
  audioPeaks?: number[];
  visualProfile?: VideoVisualProfile | null;
}): Promise<SynthesizedRemotionScene | FailedRemotionSynthesis> {
  const canUseAi = Boolean(options.chatJsonFn) || (aiChatReady() && aiStatus().chat);
  if (!canUseAi) {
    return { ok: false, error: "Proveedor de IA no disponible" };
  }

  const caller = options.chatJsonFn ?? chatJson;
  const maxRepairs = options.maxRepairAttempts ?? 2;
  const safeBaseName =
    "HFScene" +
    options.scene.id
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 10)
      .replace(/^[^a-zA-Z]/, "X");

  const fontForStyle =
    options.scene.fontFamilyHint === "playfair"
      ? "Playfair Display"
      : options.scene.fontFamilyHint === "anton"
        ? "Anton"
        : options.scene.fontFamilyHint === "bebas"
          ? "Bebas Neue"
          : options.scene.fontFamilyHint === "grandstander"
            ? "Grandstander"
            : options.scene.fontFamilyHint === "space-grotesk"
              ? "Space Grotesk"
              : options.artDirection.typographyStyle === "editorial_serif"
                ? "Playfair Display"
                : options.artDirection.typographyStyle === "bold_kinetic"
                  ? "Anton"
                  : options.artDirection.typographyStyle === "tech_mono"
                    ? "Space Grotesk"
                    : "Inter";

  const briefPrompt = [
    `ESPECIFICACIÓN DE ESCENA BESPOKE:`,
    `- Title / ID: ${options.scene.title} (${safeBaseName})`,
    `- Canvas: ${options.width}x${options.height} @ ${options.fps}fps, Duración exacta: ${options.durationFrames} frames (${options.scene.durationSec.toFixed(1)}s)`,
    `- Zona Espacial: ${options.scene.zone} | Rol de capa: ${options.scene.layerRole}`,
    `- Concepto Visual: ${options.scene.visualConcept}`,
    `- Coreografía HyperFrames: ${options.scene.animationChoreography}`,
    options.scene.svgMetaphorIdea ? `- Idea SVG: ${options.scene.svgMetaphorIdea}` : "",
    `- Textos OBLIGATORIOS en pantalla (en español, cero emojis): Titular="${options.scene.headline}", Subtítulo="${options.scene.subheadline}"${options.scene.ctaText ? `, Botón CTA="${options.scene.ctaText}"` : ""}${options.scene.metricValue ? `, Métrica="${options.scene.metricValue}"` : ""}`,
    options.scene.allLiterals && options.scene.allLiterals.length > 0
      ? `- TODOS los textos literales exactos que DEBEN verse en el render: ${options.scene.allLiterals.map((l) => JSON.stringify(l)).join(", ")}`
      : "",
    `DIRECCIÓN DE ARTE:`,
    `- Tema: ${options.artDirection.visualTheme} | Tipografía preferida: "${fontForStyle}" (${options.artDirection.typographyStyle}) | Ritmo: ${options.artDirection.editingPace}`,
    `- Paleta: accent=${options.artDirection.palette.accent}, secondary=${options.artDirection.palette.secondary}, surface=${options.artDirection.palette.surface}, text=${options.artDirection.palette.text}`,
    options.visualProfile
      ? `CONTEXTO VISUAL DEL VIDEO REAL: Iluminación=${options.visualProfile.lightingMood}, Zonas seguras libres=${options.visualProfile.safeOverlayZones.join(", ") || "upper/hero-top"}, Escena=${options.visualProfile.visualSummary}. Evita tapar al sujeto.`
      : "",
    options.audioPeaks && options.audioPeaks.length > 0
      ? `AUDIO-REACTIVIDAD: props.audioPeaks incluye ${Math.min(options.audioPeaks.length, 600)} muestras (0..1 a 4Hz). Sincroniza glows, pulsos o trazos SVG con props.audioPeaks.`
      : "",
    `Devuelve props por defecto en el propio componente si quieres, y recuerda usar export const ${safeBaseName}: React.FC<Record<string, any>> y export default ${safeBaseName}.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const initial = await caller(HYPERFRAMES_STUDIO_CODEGEN_PROMPT, briefPrompt, options.signal, {
      maxTokens: 6000,
      temperature: 0.4,
    });
    const cleaned = cleanEmojis(initial.data) as Record<string, unknown>;
    const rawCode = typeof cleaned?.code === "string" ? cleaned.code : "";
    if (!rawCode.trim()) {
      return { ok: false, error: "La IA devolvió código vacío" };
    }

    let sanitized = sanitizeComponentCode(rawCode);
    let validation = await verifyRemotionComponentTsx(sanitized.code);
    let repairs = 0;

    while (!validation.ok && repairs < maxRepairs) {
      repairs += 1;
      const repairUserPrompt = [
        `BRIEF ORIGINAL:\n${briefPrompt}`,
        `CONTEXTO: ${options.width}x${options.height}, ${options.fps} fps, ${options.durationFrames} frames.`,
        `ERROR REAL DETECTADO POR COMPILADOR ESBUILD / AST:\n${validation.error}`,
        `CÓDIGO CON ERROR (mantén export "${sanitized.name}"):\n\`\`\`tsx\n${sanitized.code}\n\`\`\``,
      ].join("\n\n");

      const fixed = await caller(MOTION_REPAIR_PROMPT, repairUserPrompt, options.signal, {
        maxTokens: 6000,
        temperature: 0.1,
      });
      const fixedData = cleanEmojis(fixed.data) as Record<string, unknown>;
      const fixedRaw = typeof fixedData?.code === "string" ? fixedData.code : "";
      if (!fixedRaw.trim()) break;
      sanitized = sanitizeComponentCode(fixedRaw);
      validation = await verifyRemotionComponentTsx(sanitized.code);
    }

    if (!validation.ok) {
      return {
        ok: false,
        error: `TSX no válido tras ${repairs} intento(s) de reparación: ${validation.error}`,
      };
    }

    // Verificar que el código TSX o sus props conserven todos los textos literales solicitados
    if (options.scene.allLiterals && options.scene.allLiterals.length > 0) {
      const codeNorm = sanitized.code.toLowerCase();
      const missingFromCode = options.scene.allLiterals.filter((lit) => {
        const l = lit.toLowerCase();
        return (
          !codeNorm.includes(l) &&
          !codeNorm.includes("props.title") &&
          !codeNorm.includes("props.subtitle") &&
          !codeNorm.includes("props.ctatext") &&
          !codeNorm.includes("props.badge")
        );
      });
      if (missingFromCode.length > 0 && sanitized.code.indexOf(options.scene.headline) === -1) {
        return {
          ok: false,
          error: `La escena TSX generada omitió textos literales obligatorios: ${missingFromCode.join(", ")}`,
        };
      }
    }

    const compIdBase =
      typeof cleaned?.compositionId === "string" && cleaned.compositionId.trim()
        ? cleaned.compositionId.trim().replace(/[^a-zA-Z0-9_-]/g, "")
        : `${sanitized.name}Comp`;

    return {
      ok: true,
      componentName: sanitized.name || safeBaseName,
      compositionId: `${compIdBase}_${randomUUID().slice(0, 5)}`,
      code: sanitized.code,
      props: {
        zone: options.scene.zone,
        accentColor: options.artDirection.palette.accent,
        secondaryColor: options.artDirection.palette.secondary,
        title: options.scene.headline,
        subtitle: options.scene.subheadline,
        badge: options.artDirection.visualTheme,
        ...(options.scene.ctaText ? { ctaText: options.scene.ctaText } : {}),
        ...(options.scene.allLiterals && options.scene.allLiterals.length > 0
          ? { allLiterals: options.scene.allLiterals }
          : {}),
        fontFamily: fontForStyle,
        ...(options.audioPeaks && options.audioPeaks.length > 0
          ? { audioPeaks: options.audioPeaks.slice(0, 600) }
          : {}),
      },
      repairedAttempts: repairs,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Generador procedural polimórfico para fondos V1 y overlays HUD transparentes sin plantillas repetitivas.
 * Produce 4 motores visuales distintos (Canvas 2D neuronal, Retícula/Anillo orbital 3D,
 * Ondas/Espectro SVG audio-reactivo, Monolito editorial glassmorphism) según `variantSeed`.
 * Con `transparentOverlay: true` compone HUDs flotantes en zonas seguras sobre metraje real.
 */
export function buildPolymorphicProceduralSceneCode(options: {
  componentName: string;
  variantSeed: number;
  headline: string;
  subheadline: string;
  accentColor: string;
  secondaryColor: string;
  surfaceColor: string;
  textColor: string;
  fontFamily: string;
  visualTheme: string;
  transparentOverlay?: boolean;
  zone?: string;
  metricValue?: string;
  ctaText?: string;
  allLiterals?: string[];
  sceneArchetype?: SceneVisualArchetype;
}): string {
  const name = options.componentName.replace(/[^a-zA-Z0-9]/g, "") || "ProceduralStage";
  const archetype = options.sceneArchetype ?? "general";
  const engineIndex =
    archetype === "neural-hook"
      ? 0
      : ((options.variantSeed % 4) + 4) % 4;
  const accentLit = JSON.stringify(options.accentColor || "#38BDF8");
  const secondaryLit = JSON.stringify(options.secondaryColor || "#818CF8");
  const surfaceLit = JSON.stringify(options.surfaceColor || "#090D18");
  const textLit = JSON.stringify(options.textColor || "#F8FAFC");
  const fontLit = JSON.stringify(options.fontFamily || "Inter");
  const headlineLit = JSON.stringify(options.headline || "ESCENA");
  const safeSubheadline = isConversationalInstructionText(options.subheadline || "")
    ? ""
    : (options.subheadline || "");
  const subLit = JSON.stringify(safeSubheadline);
  const themeLit = JSON.stringify(options.visualTheme || "STUDIO");
  const zoneLit = JSON.stringify(options.zone || "hero-top");
  const metricLit = JSON.stringify(options.metricValue || "");
  const ctaLit = JSON.stringify(options.ctaText || "");
  const extraLiterals = (options.allLiterals ?? []).filter((lit) => {
    const l = lit.trim().toLowerCase();
    return (
      l !== (options.headline || "").trim().toLowerCase() &&
      l !== safeSubheadline.trim().toLowerCase() &&
      l !== (options.ctaText || "").trim().toLowerCase() &&
      l !== (options.visualTheme || "").trim().toLowerCase()
    );
  });
  const extraLit = JSON.stringify(extraLiterals);

  // Arquetipo dedicado 1: Demo de línea de tiempo simulada con cortes inteligentes, capa Remotion y onda karaoke (Escena 2 Demo)
  if (!options.transparentOverlay && archetype === "timeline-demo") {
    return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const surface = String(props.surfaceColor || ${surfaceLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const badgeText = String(props.badge || ${themeLit});
  const ctaText = String(props.ctaText || ${ctaLit});
  const rawExtras: unknown[] = Array.isArray(props.extraItems) ? props.extraItems : Array.isArray(props.extraLiterals) ? props.extraLiterals : ${extraLit};
  const extraItems = rawExtras.map((v) => String(v)).filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase());

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 125 } });
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 12), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const playheadPct = interpolate(frame, [0, Math.max(1, durationInFrames)], [8, 92], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);
  const karaokeWords = ["Edita", "ideas", "y", "clips", "en", "segundos", "con", "IA"];
  const activeWordIdx = Math.floor((frame / Math.max(6, Math.floor(durationInFrames / karaokeWords.length))) % karaokeWords.length);
  const waveBars = Array.from({ length: 28 }, (_, i) => {
    const amp = 0.25 + 0.75 * Math.abs(Math.sin(frame * 0.16 + i * 0.45));
    return Math.max(8, Math.round(amp * unit * 0.055));
  });

  return (
    <AbsoluteFill style={{ backgroundColor: surface, overflow: "hidden", opacity: enter * fadeOut }}>
      <AbsoluteFill style={{ background: \`radial-gradient(circle at 50% 18%, \${accent}34 0%, transparent 56%), radial-gradient(circle at 80% 82%, \${secondary}2C 0%, transparent 50%)\` }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "8% 7% 22%" }}>
        <div style={{ width: "92%", display: "flex", flexDirection: "column", gap: unit * 0.025, transform: \`translateY(\${(1 - enter) * 24}px)\` }}>
          <div style={{ textAlign: "center" }}>
            {badgeText && badgeText.toUpperCase() !== headline.toUpperCase() ? (
              <div style={{ display: "inline-block", padding: "5px 14px", borderRadius: 999, backgroundColor: \`\${accent}24\`, border: \`1px solid \${accent}70\`, color: accent, fontFamily, fontSize: Math.max(12, unit * 0.02), fontWeight: 800, letterSpacing: "0.14em", marginBottom: unit * 0.014 }}>
                {badgeText.toUpperCase()}
              </div>
            ) : null}
            <div style={{ fontFamily, fontSize: Math.max(26, unit * 0.054), fontWeight: 900, color: text, lineHeight: 1.08 }}>{headline}</div>
            {subtitle ? <div style={{ marginTop: unit * 0.012, fontFamily, fontSize: Math.max(14, unit * 0.024), color: "rgba(226,232,240,0.88)", lineHeight: 1.35 }}>{subtitle}</div> : null}
          </div>

          <div style={{ position: "relative", borderRadius: unit * 0.026, padding: unit * 0.026, backgroundColor: "rgba(9, 15, 30, 0.9)", border: \`1px solid \${accent}55\`, boxShadow: "0 20px 52px rgba(0,0,0,0.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: unit * 0.016, fontFamily, fontSize: Math.max(11, unit * 0.018), color: "rgba(148,163,184,0.9)" }}>
              <span>TIMELINE IA · CORTES INTELIGENTES</span>
              <span style={{ color: accent, fontWeight: 700 }}>REMOTION + SUBTÍTULOS</span>
            </div>
            <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: unit * 0.012 }}>
              <div style={{ height: unit * 0.044, borderRadius: 8, backgroundColor: "rgba(30,41,59,0.7)", display: "flex", alignItems: "center", padding: "0 10px", gap: 6 }}>
                <span style={{ fontFamily, fontSize: Math.max(10, unit * 0.016), color: accent, fontWeight: 800, width: 54 }}>MOTION</span>
                <div style={{ flex: 1, height: "64%", borderRadius: 6, background: \`linear-gradient(90deg, \${accent}99, \${secondary}99)\` }} />
              </div>
              <div style={{ height: unit * 0.048, borderRadius: 8, backgroundColor: "rgba(30,41,59,0.7)", display: "flex", alignItems: "center", padding: "0 10px", gap: 6 }}>
                <span style={{ fontFamily, fontSize: Math.max(10, unit * 0.016), color: "#E2E8F0", fontWeight: 800, width: 54 }}>V1</span>
                <div style={{ width: "30%", height: "66%", borderRadius: 6, backgroundColor: \`\${accent}66\`, border: \`1px solid \${accent}\` }} />
                <div style={{ width: "36%", height: "66%", borderRadius: 6, backgroundColor: \`\${secondary}66\`, border: \`1px solid \${secondary}\` }} />
                <div style={{ flex: 1, height: "66%", borderRadius: 6, backgroundColor: \`\${accent}55\`, border: \`1px solid \${accent}\` }} />
              </div>
              <div style={{ height: unit * 0.06, borderRadius: 8, backgroundColor: "rgba(15,23,42,0.85)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", gap: 3 }}>
                {waveBars.map((h, idx) => (
                  <div key={idx} style={{ width: Math.max(3, unit * 0.006), height: h, borderRadius: 4, backgroundColor: idx / waveBars.length <= playheadPct / 100 ? accent : "rgba(148,163,184,0.35)" }} />
                ))}
              </div>
              <div style={{ position: "absolute", top: -6, bottom: -6, left: \`\${playheadPct}%\`, width: 2.5, backgroundColor: "#F8FAFC", boxShadow: \`0 0 12px \${accent}\` }} />
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, padding: "12px 16px", borderRadius: 14, backgroundColor: "rgba(9,13,24,0.88)", border: \`1px solid \${accent}45\` }}>
            {karaokeWords.map((w, idx) => (
              <span key={idx} style={{ fontFamily, fontSize: Math.max(16, unit * 0.03), fontWeight: 900, padding: "2px 7px", borderRadius: 6, backgroundColor: idx === activeWordIdx ? accent : "transparent", color: idx === activeWordIdx ? "#090D18" : "#F8FAFC" }}>{w}</span>
            ))}
          </div>
          {extraItems.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
              {extraItems.map((item, idx) => (
                <div key={idx} style={{ padding: "6px 12px", borderRadius: 999, backgroundColor: \`\${secondary}28\`, border: \`1px solid \${secondary}66\`, fontFamily, fontSize: Math.max(12, unit * 0.02), color: text }}>{item}</div>
              ))}
            </div>
          ) : null}
          {ctaText ? (
            <div style={{ display: "inline-block", alignSelf: "center", padding: "10px 22px", borderRadius: 999, background: \`linear-gradient(90deg, \${accent}, \${secondary})\`, color: "#060B16", fontFamily, fontSize: Math.max(15, unit * 0.026), fontWeight: 900 }}>{ctaText}</div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export default ${name};
`;
  }

  // Arquetipo dedicado 2: Cierre CTA limpio con botón prominente y marca (Escena 3/6 Cierre CTA)
  if (!options.transparentOverlay && (archetype === "cta-close" || Boolean(options.ctaText))) {
    return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const surface = String(props.surfaceColor || ${surfaceLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const ctaText = String(props.ctaText || ${ctaLit});
  const badgeText = String(props.badge || ${themeLit});
  const rawExtras: unknown[] = Array.isArray(props.extraItems) ? props.extraItems : Array.isArray(props.extraLiterals) ? props.extraLiterals : ${extraLit};
  const extraItems = rawExtras.map((v) => String(v)).filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase());

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 120 } });
  const pulse = 1 + 0.03 * Math.sin(frame * 0.14);
  const sheenX = interpolate(frame % 110, [0, 110], [-45, 145], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 10), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);

  return (
    <AbsoluteFill style={{ backgroundColor: surface, overflow: "hidden", opacity: enter * fadeOut }}>
      <AbsoluteFill style={{ background: \`radial-gradient(circle at 50% 35%, \${accent}3A 0%, transparent 56%), radial-gradient(circle at 30% 75%, \${secondary}32 0%, transparent 55%)\` }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "8% 7% 22%", textAlign: "center" }}>
        <div style={{ position: "relative", overflow: "hidden", width: "90%", padding: \`\${unit * 0.055}px \${unit * 0.05}px\`, borderRadius: unit * 0.036, backgroundColor: "rgba(10, 17, 34, 0.88)", border: \`1px solid \${accent}66\`, boxShadow: \`0 24px 64px rgba(0,0,0,0.58), 0 0 38px \${accent}26\`, transform: \`translateY(\${(1 - enter) * 24}px)\`, display: "flex", flexDirection: "column", alignItems: "center", gap: unit * 0.024 }}>
          <div style={{ position: "absolute", top: "-40%", bottom: "-40%", left: \`\${sheenX}%\`, width: "26%", transform: "skewX(-22deg)", background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)", pointerEvents: "none" }} />
          {badgeText && badgeText.toUpperCase() !== headline.toUpperCase() ? (
            <div style={{ padding: "6px 18px", borderRadius: 999, backgroundColor: \`\${accent}22\`, border: \`1px solid \${accent}70\`, color: accent, fontFamily, fontSize: Math.max(13, unit * 0.022), fontWeight: 800, letterSpacing: "0.14em" }}>
              {badgeText.toUpperCase()}
            </div>
          ) : null}
          <div style={{ fontFamily, fontSize: Math.max(26, unit * 0.058), fontWeight: 900, color: text, lineHeight: 1.08 }}>
            {headline}
          </div>
          {subtitle ? (
            <div style={{ fontFamily, fontSize: Math.max(15, unit * 0.027), fontWeight: 500, color: "rgba(226,232,240,0.9)", lineHeight: 1.38 }}>
              {subtitle}
            </div>
          ) : null}
          {extraItems.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
              {extraItems.map((item, idx) => (
                <div key={idx} style={{ padding: "5px 12px", borderRadius: 8, backgroundColor: "rgba(255,255,255,0.07)", fontFamily, fontSize: Math.max(13, unit * 0.022), color: text }}>{item}</div>
              ))}
            </div>
          ) : null}
          {ctaText ? (
            <div style={{ position: "relative", overflow: "hidden", marginTop: unit * 0.012, padding: \`\${Math.max(13, unit * 0.022)}px \${Math.max(26, unit * 0.046)}px\`, borderRadius: 999, background: \`linear-gradient(90deg, \${accent}, \${secondary})\`, color: "#060B16", fontFamily, fontSize: Math.max(17, unit * 0.032), fontWeight: 900, boxShadow: \`0 12px 32px \${accent}55\`, transform: \`scale(\${pulse})\` }}>
              {ctaText}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export default ${name};
`;
  }

  if (options.transparentOverlay) {
    const anchorHelper = `const zone = String(props.zone || ${zoneLit});
  const anchorStyle: React.CSSProperties =
    zone === "top-left-hud"
      ? { top: "6%", left: "5%", alignItems: "flex-start", textAlign: "left" }
      : zone === "top-right-hud"
        ? { top: "6%", right: "5%", alignItems: "flex-end", textAlign: "right" }
        : zone === "lower-third" || zone === "bottom-third"
          ? { bottom: "19%", left: "6%", alignItems: "flex-start", textAlign: "left" }
          : zone === "center-stage"
            ? { top: "50%", left: "50%", transform: "translate(-50%, -50%)", alignItems: "center", textAlign: "center" }
            : { top: "6%", left: "50%", transform: "translateX(-50%)", alignItems: "center", textAlign: "center" };`;

    if (engineIndex === 0) {
      return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, random } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const metric = String(props.metricValue || ${metricLit});
  const peaks = Array.isArray(props.audioPeaks) ? props.audioPeaks : [];
  const pIdx = peaks.length > 0 ? Math.min(peaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4)) : 0;
  const peak = peaks.length > 0 ? Number(peaks[pIdx] ?? 0.35) : 0.3 + 0.16 * Math.sin(frame * 0.12);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pts: Array<{ x: number; y: number; r: number }> = [];
    for (let i = 0; i < 14; i++) {
      const x = ((random("ox-" + i) * canvas.width + frame * ((random("ovx-" + i) - 0.5) * 1.4) + canvas.width * 2) % canvas.width);
      const y = ((random("oy-" + i) * canvas.height + frame * ((random("ovy-" + i) - 0.5) * 1.1) + canvas.height * 2) % canvas.height);
      pts.push({ x, y, r: 1.6 + random("or-" + i) * 2.4 + peak * 2 });
    }
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dist = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (dist < canvas.width * 0.28) {
          ctx.strokeStyle = accent;
          ctx.globalAlpha = (1 - dist / (canvas.width * 0.28)) * 0.4;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pts[i]!.x, pts[i]!.y);
          ctx.lineTo(pts[j]!.x, pts[j]!.y);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = i % 2 === 0 ? accent : secondary;
      ctx.beginPath();
      ctx.arc(pts[i]!.x, pts[i]!.y, pts[i]!.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [frame, accent, secondary, peak]);

  const enter = spring({ frame, fps, config: { damping: 15, stiffness: 135 } });
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 10), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);
  ${anchorHelper}

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", pointerEvents: "none", overflow: "hidden", opacity: enter * fadeOut }}>
      <div style={{ position: "absolute", display: "flex", flexDirection: "column", maxWidth: width > height ? "46%" : "86%", ...anchorStyle }}>
        <div style={{
          position: "relative",
          overflow: "hidden",
          padding: \`\${Math.max(12, unit * 0.022)}px \${Math.max(16, unit * 0.03)}px\`,
          borderRadius: Math.max(14, unit * 0.024),
          background: "rgba(9, 13, 24, 0.74)",
          border: \`1px solid \${accent}66\`,
          boxShadow: \`0 14px 36px rgba(0,0,0,0.45), 0 0 24px \${accent}22\`,
          transform: \`translateY(\${(1 - enter) * 18}px) scale(\${0.94 + enter * 0.06})\`,
        }}>
          <canvas ref={canvasRef} width={360} height={150} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.45, pointerEvents: "none" }} />
          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              {String(${themeLit}).trim().toUpperCase() !== headline.trim().toUpperCase() ? <span style={{ fontFamily, fontSize: Math.max(10, unit * 0.017), fontWeight: 800, letterSpacing: "0.14em", color: accent }}>{${themeLit}.toUpperCase()}</span> : null}
              {metric ? <span style={{ padding: "2px 8px", borderRadius: 999, backgroundColor: \`\${secondary}33\`, color: text, fontFamily, fontSize: Math.max(11, unit * 0.018), fontWeight: 800 }}>{metric}</span> : null}
            </div>
            <div style={{ fontFamily, fontSize: Math.max(18, unit * 0.036), fontWeight: 900, lineHeight: 1.08, color: text }}>{headline}</div>
            {subtitle ? <div style={{ marginTop: 4, fontFamily, fontSize: Math.max(12, unit * 0.02), fontWeight: 500, color: "rgba(226,232,240,0.88)", lineHeight: 1.3 }}>{subtitle}</div> : null}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${name};
`;
    }

    if (engineIndex === 1) {
      return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const metric = String(props.metricValue || ${metricLit});
  const peaks = Array.isArray(props.audioPeaks) ? props.audioPeaks : [];
  const pIdx = peaks.length > 0 ? Math.min(peaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4)) : 0;
  const peak = peaks.length > 0 ? Number(peaks[pIdx] ?? 0.35) : 0.34 + 0.16 * Math.sin(frame * 0.14);

  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 125 } });
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 10), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);
  ${anchorHelper}

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", pointerEvents: "none", overflow: "hidden", opacity: enter * fadeOut }}>
      <div style={{ position: "absolute", display: "flex", flexDirection: "column", maxWidth: width > height ? "48%" : "88%", ...anchorStyle }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: Math.max(12, unit * 0.02),
          padding: \`\${Math.max(12, unit * 0.02)}px \${Math.max(16, unit * 0.028)}px\`,
          borderRadius: Math.max(14, unit * 0.024),
          background: "linear-gradient(135deg, rgba(10,16,30,0.8) 0%, rgba(15,23,42,0.68) 100%)",
          border: \`1px solid \${accent}70\`,
          boxShadow: \`0 14px 38px rgba(0,0,0,0.48)\`,
          transform: \`translateY(\${(1 - enter) * 16}px)\`,
        }}>
          <svg width={Math.max(44, unit * 0.08)} height={Math.max(44, unit * 0.08)} viewBox="0 0 100 100" style={{ flexShrink: 0, transform: \`rotate(\${frame * 1.4}deg) scale(\${0.94 + peak * 0.12})\` }}>
            <circle cx="50" cy="50" r="42" fill="none" stroke={accent} strokeWidth="3.5" strokeDasharray="18 9" />
            <circle cx="50" cy="50" r="28" fill="none" stroke={secondary} strokeWidth="3" strokeDasharray="30 12" />
            <circle cx="50" cy="50" r="8" fill={accent} />
          </svg>
          <div>
            {metric ? <div style={{ fontFamily, fontSize: Math.max(16, unit * 0.032), fontWeight: 900, color: accent, lineHeight: 1 }}>{metric}</div> : null}
            <div style={{ fontFamily, fontSize: Math.max(17, unit * 0.033), fontWeight: 900, color: text, lineHeight: 1.08, marginTop: metric ? 3 : 0 }}>{headline}</div>
            {subtitle ? <div style={{ marginTop: 3, fontFamily, fontSize: Math.max(12, unit * 0.019), fontWeight: 500, color: "rgba(226,232,240,0.86)", lineHeight: 1.3 }}>{subtitle}</div> : null}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${name};
`;
    }

    if (engineIndex === 2) {
      return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const badgeText = String(props.badge || ${themeLit});
  const ctaText = String(props.ctaText || ${ctaLit});
  const extraItems: string[] = Array.isArray(props.extraItems) ? props.extraItems : Array.isArray(props.extraLiterals) ? props.extraLiterals : ${extraLit};
  const filteredExtras = extraItems.filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase());
  const peaks = Array.isArray(props.audioPeaks) ? props.audioPeaks : [];
  const pIdx = peaks.length > 0 ? Math.min(peaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4)) : 0;
  const peak = peaks.length > 0 ? Number(peaks[pIdx] ?? 0.35) : 0.35 + 0.18 * Math.sin(frame * 0.12);

  const enter = spring({ frame, fps, config: { damping: 15, stiffness: 135 } });
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 10), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);
  const bars = Array.from({ length: 12 }, (_, idx) => {
    const wave = 0.3 + 0.7 * Math.abs(Math.sin(frame * 0.14 + idx * 0.52));
    return Math.max(8, Math.round((10 + 26 * wave) * (0.7 + peak * 0.75)));
  });
  ${anchorHelper}

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", pointerEvents: "none", overflow: "hidden", opacity: enter * fadeOut }}>
      <div style={{ position: "absolute", display: "flex", flexDirection: "column", maxWidth: width > height ? "46%" : "86%", ...anchorStyle }}>
        <div style={{
          padding: \`\${Math.max(12, unit * 0.02)}px \${Math.max(16, unit * 0.028)}px\`,
          borderRadius: Math.max(14, unit * 0.024),
          background: "rgba(9, 13, 24, 0.76)",
          borderLeft: \`4px solid \${accent}\`,
          borderTop: \`1px solid rgba(255,255,255,0.12)\`,
          boxShadow: "0 14px 36px rgba(0,0,0,0.46)",
          transform: \`scale(\${0.94 + enter * 0.06})\`,
        }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 24, marginBottom: 8 }}>
            {bars.map((h, i) => (
              <div key={i} style={{ width: 4, height: Math.min(24, h * 0.65), borderRadius: 4, background: i % 2 === 0 ? accent : secondary }} />
            ))}
          </div>
          <div style={{ fontFamily, fontSize: Math.max(18, unit * 0.035), fontWeight: 900, color: text, lineHeight: 1.08 }}>{headline}</div>
          {subtitle ? <div style={{ marginTop: 4, fontFamily, fontSize: Math.max(12, unit * 0.02), fontWeight: 500, color: "rgba(241,245,249,0.86)", lineHeight: 1.32 }}>{subtitle}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${name};
`;
    }

    return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const metric = String(props.metricValue || ${metricLit});

  const enter = spring({ frame, fps, config: { damping: 17, stiffness: 120 } });
  const sheenX = interpolate(frame % 120, [0, 120], [-40, 140], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 10), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);
  ${anchorHelper}

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", pointerEvents: "none", overflow: "hidden", opacity: enter * fadeOut }}>
      <div style={{ position: "absolute", display: "flex", flexDirection: "column", maxWidth: width > height ? "46%" : "86%", ...anchorStyle }}>
        <div style={{
          position: "relative",
          overflow: "hidden",
          padding: \`\${Math.max(13, unit * 0.022)}px \${Math.max(17, unit * 0.03)}px\`,
          borderRadius: Math.max(14, unit * 0.024),
          background: "rgba(15, 23, 42, 0.78)",
          border: \`1px solid \${accent}55\`,
          boxShadow: \`0 18px 44px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.14)\`,
          transform: \`perspective(900px) rotateY(\${Math.sin(frame * 0.03) * 3.5}deg) translateY(\${(1 - enter) * 18}px)\`,
        }}>
          <div style={{ position: "absolute", top: "-30%", bottom: "-30%", left: \`\${sheenX}%\`, width: "28%", transform: "skewX(-24deg)", background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)", pointerEvents: "none" }} />
          <div style={{ width: Math.max(32, unit * 0.06), height: 3, borderRadius: 4, background: \`linear-gradient(90deg, \${accent}, \${secondary})\`, marginBottom: 8 }} />
          {metric ? <div style={{ fontFamily, fontSize: Math.max(14, unit * 0.024), fontWeight: 800, color: accent, marginBottom: 2 }}>{metric}</div> : null}
          <div style={{ fontFamily, fontSize: Math.max(18, unit * 0.034), fontWeight: 900, color: text, lineHeight: 1.08 }}>{headline}</div>
          {subtitle ? <div style={{ marginTop: 4, fontFamily, fontSize: Math.max(12, unit * 0.02), color: "rgba(226,232,240,0.88)", lineHeight: 1.32 }}>{subtitle}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
export default ${name};
`;
  }

  if (engineIndex === 0) {
    // Motor 0: Canvas 2D generativo neuronal + pulsos audio-reactivos + stage atmosférico
    return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, random } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const surface = String(props.surfaceColor || ${surfaceLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const badgeText = String(props.badge || ${themeLit});
  const ctaText = String(props.ctaText || ${ctaLit});
  const extraItems: string[] = Array.isArray(props.extraItems) ? props.extraItems : Array.isArray(props.extraLiterals) ? props.extraLiterals : ${extraLit};
  const filteredExtras = extraItems.filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase());
  const peaks = Array.isArray(props.audioPeaks) ? props.audioPeaks : [];
  const pIdx = peaks.length > 0 ? Math.min(peaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4)) : 0;
  const peak = peaks.length > 0 ? Number(peaks[pIdx] ?? 0.35) : 0.3 + 0.15 * Math.sin(frame * 0.11);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const count = 26;
    const pts: Array<{ x: number; y: number; r: number }> = [];
    for (let i = 0; i < count; i++) {
      const rx = random("px-" + i);
      const ry = random("py-" + i);
      const vx = (random("vx-" + i) - 0.5) * 2.1;
      const vy = (random("vy-" + i) - 0.5) * 1.6;
      const x = ((rx * width + frame * vx + width * 4) % width);
      const y = ((ry * height + frame * vy + height * 4) % height);
      pts.push({ x, y, r: 2.2 + random("pr-" + i) * 3.8 + peak * 3.2 });
    }
    ctx.lineWidth = 1.2;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i]!.x - pts[j]!.x;
        const dy = pts[i]!.y - pts[j]!.y;
        const dist = Math.hypot(dx, dy);
        const maxDist = Math.min(width, height) * 0.28;
        if (dist < maxDist) {
          ctx.strokeStyle = accent;
          ctx.globalAlpha = (1 - dist / maxDist) * (0.28 + peak * 0.35);
          ctx.beginPath();
          ctx.moveTo(pts[i]!.x, pts[i]!.y);
          ctx.lineTo(pts[j]!.x, pts[j]!.y);
          ctx.stroke();
        }
      }
    }
    for (let i = 0; i < pts.length; i++) {
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = i % 3 === 0 ? secondary : accent;
      ctx.beginPath();
      ctx.arc(pts[i]!.x, pts[i]!.y, pts[i]!.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [frame, width, height, accent, secondary, peak]);

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 130 } });
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 14), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);

  return (
    <AbsoluteFill style={{ backgroundColor: surface, overflow: "hidden", opacity: enter * fadeOut }}>
      <AbsoluteFill style={{ background: \`radial-gradient(circle at \${32 + Math.sin(frame * 0.02) * 14}% \${34 + Math.cos(frame * 0.015) * 10}%, \${accent}42 0%, transparent 55%), radial-gradient(circle at 75% 70%, \${secondary}33 0%, transparent 52%)\` }} />
      <canvas ref={canvasRef} width={width} height={height} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "8% 7% 22%", textAlign: "center" }}>
        <div style={{ transform: \`translateY(\${(1 - enter) * 24}px) scale(\${0.97 + peak * 0.04})\`, maxWidth: "88%" }}>
          {badgeText && badgeText.toUpperCase() !== headline.toUpperCase() ? (
            <div style={{ display: "inline-block", padding: "6px 16px", borderRadius: 999, backgroundColor: \`\${accent}22\`, border: \`1px solid \${accent}66\`, color: accent, fontFamily, fontSize: Math.max(13, unit * 0.022), fontWeight: 700, letterSpacing: "0.14em", marginBottom: unit * 0.025 }}>
              {badgeText.toUpperCase()}
            </div>
          ) : null}
          <div style={{ fontFamily, fontSize: Math.max(28, unit * 0.068), fontWeight: 900, lineHeight: 1.06, color: text, textShadow: "0 12px 38px rgba(0,0,0,0.65)" }}>
            {headline}
          </div>
          {subtitle ? (
            <div style={{ marginTop: unit * 0.022, fontFamily, fontSize: Math.max(15, unit * 0.028), fontWeight: 500, color: "rgba(241,245,249,0.86)", lineHeight: 1.38 }}>
              {subtitle}
            </div>
          ) : null}
          {extraItems.filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase()).length > 0 ? (
            <div style={{ marginTop: unit * 0.02, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
              {extraItems.filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase()).map((item, idx) => (
                <div key={idx} style={{ padding: "5px 12px", borderRadius: 8, backgroundColor: "rgba(15,23,42,0.7)", border: \`1px solid \${accent}45\`, fontFamily, fontSize: Math.max(13, unit * 0.022), color: text }}>{item}</div>
              ))}
            </div>
          ) : null}
          {ctaText ? (
            <div style={{ display: "inline-block", marginTop: unit * 0.026, padding: "12px 26px", borderRadius: 999, background: \`linear-gradient(90deg, \${accent}, \${secondary})\`, color: "#060B16", fontFamily, fontSize: Math.max(16, unit * 0.028), fontWeight: 900 }}>
              {ctaText}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export default ${name};
`;
  }

  if (engineIndex === 1) {
    // Motor 1: Retícula 3D en perspectiva + horizonte futurista + núcleo orbital SVG
    return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const surface = String(props.surfaceColor || ${surfaceLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const badgeText = String(props.badge || ${themeLit});
  const ctaText = String(props.ctaText || ${ctaLit});
  const extraItems: string[] = Array.isArray(props.extraItems) ? props.extraItems : Array.isArray(props.extraLiterals) ? props.extraLiterals : ${extraLit};
  const filteredExtras = extraItems.filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase());
  const peaks = Array.isArray(props.audioPeaks) ? props.audioPeaks : [];
  const pIdx = peaks.length > 0 ? Math.min(peaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4)) : 0;
  const peak = peaks.length > 0 ? Number(peaks[pIdx] ?? 0.35) : 0.32 + 0.16 * Math.sin(frame * 0.14);

  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  const gridScroll = (frame * 2.4) % 80;
  const unit = Math.min(width, height);
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 12), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: surface, overflow: "hidden", opacity: enter * fadeOut }}>
      <AbsoluteFill style={{ background: \`linear-gradient(180deg, \${surface} 0%, \${accent}22 52%, \${secondary}28 100%)\` }} />
      <div style={{ position: "absolute", inset: 0, perspective: "920px", overflow: "hidden" }}>
        <div style={{
          position: "absolute",
          left: "-30%",
          right: "-30%",
          bottom: "-18%",
          height: "68%",
          transform: "rotateX(68deg)",
          transformOrigin: "center top",
          backgroundImage: \`linear-gradient(to right, \${accent}45 1.5px, transparent 1.5px), linear-gradient(to bottom, \${secondary}45 1.5px, transparent 1.5px)\`,
          backgroundSize: "72px 80px",
          backgroundPosition: \`0px \${gridScroll}px\`,
          maskImage: "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.9) 35%, rgba(0,0,0,1) 100%)",
        }} />
      </div>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", pointerEvents: "none" }}>
        <svg width={unit * 0.72} height={unit * 0.72} viewBox="0 0 260 260" style={{ opacity: 0.42 + peak * 0.35, transform: \`rotate(\${frame * 0.45}deg) scale(\${0.94 + peak * 0.14})\` }}>
          <circle cx="130" cy="130" r="108" fill="none" stroke={accent} strokeWidth="2" strokeDasharray="16 10" />
          <circle cx="130" cy="130" r="78" fill="none" stroke={secondary} strokeWidth="2.5" strokeDasharray="44 18" />
        </svg>
      </AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "8% 8% 22%", textAlign: "center" }}>
        <div style={{ transform: \`translateY(\${(1 - enter) * 28}px)\`, maxWidth: "86%" }}>
          {badgeText && badgeText.toUpperCase() !== headline.toUpperCase() ? (
            <div style={{ display: "inline-block", padding: "6px 16px", borderRadius: 999, backgroundColor: \`\${accent}22\`, border: \`1px solid \${accent}66\`, color: accent, fontFamily, fontSize: Math.max(13, unit * 0.022), fontWeight: 700, letterSpacing: "0.14em", marginBottom: unit * 0.022 }}>
              {badgeText.toUpperCase()}
            </div>
          ) : null}
          <div style={{ fontFamily, fontSize: Math.max(30, unit * 0.072), fontWeight: 900, letterSpacing: "-0.02em", color: text, lineHeight: 1.05, textShadow: \`0 8px 30px \${accent}55\` }}>
            {headline}
          </div>
          {subtitle ? (
            <div style={{ marginTop: unit * 0.024, fontFamily, fontSize: Math.max(15, unit * 0.028), fontWeight: 500, color: "rgba(226,232,240,0.9)" }}>
              {subtitle}
            </div>
          ) : null}
          {filteredExtras.length > 0 ? (
            <div style={{ marginTop: unit * 0.02, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
              {filteredExtras.map((item, idx) => (
                <div key={idx} style={{ padding: "5px 12px", borderRadius: 8, backgroundColor: "rgba(15,23,42,0.72)", border: \`1px solid \${accent}45\`, fontFamily, fontSize: Math.max(13, unit * 0.022), color: text }}>{item}</div>
              ))}
            </div>
          ) : null}
          {ctaText ? (
            <div style={{ display: "inline-block", marginTop: unit * 0.026, padding: "12px 26px", borderRadius: 999, background: \`linear-gradient(90deg, \${accent}, \${secondary})\`, color: "#060B16", fontFamily, fontSize: Math.max(16, unit * 0.028), fontWeight: 900 }}>{ctaText}</div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export default ${name};
`;
  }

  if (engineIndex === 2) {
    // Motor 2: Ondas Bézier SVG multicapa + espectro rítmico audio-reactivo
    return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const surface = String(props.surfaceColor || ${surfaceLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const badgeText = String(props.badge || ${themeLit});
  const ctaText = String(props.ctaText || ${ctaLit});
  const extraItems: string[] = Array.isArray(props.extraItems) ? props.extraItems : Array.isArray(props.extraLiterals) ? props.extraLiterals : ${extraLit};
  const filteredExtras = extraItems.filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase());
  const peaks = Array.isArray(props.audioPeaks) ? props.audioPeaks : [];
  const pIdx = peaks.length > 0 ? Math.min(peaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4)) : 0;
  const peak = peaks.length > 0 ? Number(peaks[pIdx] ?? 0.35) : 0.35 + 0.18 * Math.sin(frame * 0.12);

  const enter = spring({ frame, fps, config: { damping: 15, stiffness: 135 } });
  const unit = Math.min(width, height);
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 12), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const bars = Array.from({ length: 24 }, (_, idx) => {
    const wave = 0.35 + 0.65 * Math.abs(Math.sin(frame * 0.09 + idx * 0.42));
    return Math.max(12, Math.round((22 + 95 * wave) * (0.65 + peak * 0.9)));
  });

  const shift1 = Math.sin(frame * 0.04) * 45;
  const shift2 = Math.cos(frame * 0.03) * 55;

  return (
    <AbsoluteFill style={{ backgroundColor: surface, overflow: "hidden", opacity: enter * fadeOut }}>
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.55 }}>
        <path d={\`M0,560 C260,\${420 + shift1} 680,\${690 - shift1} 1000,490 L1000,1000 L0,1000 Z\`} fill={accent} fillOpacity="0.22" />
        <path d={\`M0,650 C310,\${520 - shift2} 720,\${760 + shift2} 1000,590 L1000,1000 L0,1000 Z\`} fill={secondary} fillOpacity="0.26" />
      </svg>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "8% 8% 22%", textAlign: "center" }}>
        <div style={{ transform: \`scale(\${0.94 + enter * 0.06})\`, maxWidth: "88%" }}>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", gap: Math.max(4, unit * 0.008), height: unit * 0.14, marginBottom: unit * 0.03 }}>
            {bars.map((h, i) => (
              <div key={i} style={{ width: Math.max(4, unit * 0.01), height: Math.min(unit * 0.14, h * 0.9), borderRadius: 999, background: i % 2 === 0 ? accent : secondary, opacity: 0.82 }} />
            ))}
          </div>
          {badgeText && badgeText.toUpperCase() !== headline.toUpperCase() ? (
            <div style={{ display: "inline-block", padding: "6px 16px", borderRadius: 999, backgroundColor: \`\${accent}22\`, border: \`1px solid \${accent}66\`, color: accent, fontFamily, fontSize: Math.max(13, unit * 0.022), fontWeight: 700, letterSpacing: "0.14em", marginBottom: unit * 0.018 }}>
              {badgeText.toUpperCase()}
            </div>
          ) : null}
          <div style={{ fontFamily, fontSize: Math.max(28, unit * 0.068), fontWeight: 900, color: text, lineHeight: 1.08 }}>
            {headline}
          </div>
          {subtitle ? (
            <div style={{ marginTop: unit * 0.02, fontFamily, fontSize: Math.max(15, unit * 0.027), color: "rgba(248,250,252,0.85)", fontWeight: 500 }}>
              {subtitle}
            </div>
          ) : null}
          {filteredExtras.length > 0 ? (
            <div style={{ marginTop: unit * 0.02, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
              {filteredExtras.map((item, idx) => (
                <div key={idx} style={{ padding: "5px 12px", borderRadius: 8, backgroundColor: "rgba(15,23,42,0.72)", border: \`1px solid \${accent}45\`, fontFamily, fontSize: Math.max(13, unit * 0.022), color: text }}>{item}</div>
              ))}
            </div>
          ) : null}
          {ctaText ? (
            <div style={{ display: "inline-block", marginTop: unit * 0.026, padding: "12px 26px", borderRadius: 999, background: \`linear-gradient(90deg, \${accent}, \${secondary})\`, color: "#060B16", fontFamily, fontSize: Math.max(16, unit * 0.028), fontWeight: 900 }}>{ctaText}</div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export default ${name};
`;
  }

  // Motor 3: Monolito editorial arquitectónico + barrido de luz + panel 3D glassmorphism
  return `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

export const ${name}: React.FC<Record<string, any>> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const accent = String(props.accentColor || ${accentLit});
  const secondary = String(props.secondaryColor || ${secondaryLit});
  const surface = String(props.surfaceColor || ${surfaceLit});
  const text = String(props.textColor || ${textLit});
  const fontFamily = String(props.fontFamily || ${fontLit});
  const headline = String(props.title || ${headlineLit});
  const subtitle = String(props.subtitle || ${subLit});
  const badgeText = String(props.badge || ${themeLit});
  const ctaText = String(props.ctaText || ${ctaLit});
  const rawExtras: unknown[] = Array.isArray(props.extraItems) ? props.extraItems : Array.isArray(props.extraLiterals) ? props.extraLiterals : ${extraLit};
  const filteredExtras = rawExtras.map((v) => String(v)).filter((s) => s && s.toLowerCase() !== headline.toLowerCase() && s.toLowerCase() !== subtitle.toLowerCase() && s.toLowerCase() !== ctaText.toLowerCase());

  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 115 } });
  const sheenX = interpolate(frame % 150, [0, 150], [-40, 140], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const unit = Math.min(width, height);
  const fadeOut = interpolate(frame, [Math.max(1, durationInFrames - 12), Math.max(2, durationInFrames)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: surface, overflow: "hidden", opacity: enter * fadeOut }}>
      <AbsoluteFill style={{ background: \`conic-gradient(from \${frame * 0.6}deg at 50% 50%, \${surface} 0deg, \${accent}2C 110deg, \${surface} 220deg, \${secondary}26 310deg, \${surface} 360deg)\` }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "8% 7% 22%" }}>
        <div style={{
          position: "relative",
          width: "90%",
          padding: \`\${unit * 0.055}px \${unit * 0.06}px\`,
          borderRadius: unit * 0.035,
          backgroundColor: "rgba(15, 23, 42, 0.78)",
          border: \`1px solid \${accent}5A\`,
          boxShadow: \`0 24px 64px rgba(0,0,0,0.58), inset 0 1px 0 rgba(255,255,255,0.14)\`,
          transform: \`perspective(1100px) rotateY(\${Math.sin(frame * 0.025) * 4}deg) translateY(\${(1 - enter) * 26}px)\`,
          overflow: "hidden",
        }}>
          <div style={{
            position: "absolute",
            top: "-40%",
            bottom: "-40%",
            left: \`\${sheenX}%\`,
            width: "28%",
            transform: "skewX(-24deg)",
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.09), transparent)",
            pointerEvents: "none",
          }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: unit * 0.024 }}>
            <div style={{ width: unit * 0.09, height: 4, borderRadius: 4, background: \`linear-gradient(90deg, \${accent}, \${secondary})\` }} />
            {badgeText && badgeText.toUpperCase() !== headline.toUpperCase() ? (
              <div style={{ padding: "4px 12px", borderRadius: 999, backgroundColor: \`\${accent}22\`, border: \`1px solid \${accent}66\`, color: accent, fontFamily, fontSize: Math.max(12, unit * 0.019), fontWeight: 800, letterSpacing: "0.14em" }}>
                {badgeText.toUpperCase()}
              </div>
            ) : null}
          </div>
          <div style={{ fontFamily, fontSize: Math.max(28, unit * 0.062), fontWeight: 900, color: text, lineHeight: 1.08 }}>
            {headline}
          </div>
          {subtitle ? (
            <div style={{ marginTop: unit * 0.02, fontFamily, fontSize: Math.max(15, unit * 0.026), color: "rgba(226,232,240,0.9)", lineHeight: 1.42 }}>
              {subtitle}
            </div>
          ) : null}
          {filteredExtras.length > 0 ? (
            <div style={{ marginTop: unit * 0.022, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {filteredExtras.map((item, idx) => (
                <div key={idx} style={{ padding: "5px 12px", borderRadius: 8, backgroundColor: "rgba(30,41,59,0.75)", border: \`1px solid \${accent}45\`, fontFamily, fontSize: Math.max(13, unit * 0.022), color: text }}>{item}</div>
              ))}
            </div>
          ) : null}
          {ctaText ? (
            <div style={{ display: "inline-block", marginTop: unit * 0.024, padding: "12px 26px", borderRadius: 999, background: \`linear-gradient(90deg, \${accent}, \${secondary})\`, color: "#060B16", fontFamily, fontSize: Math.max(16, unit * 0.028), fontWeight: 900 }}>{ctaText}</div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export default ${name};
`;
}

/**
 * Ejecuta tareas asíncronas en paralelo con límite de concurrencia fijo.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]!, idx);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Crea o reutiliza un MediaAsset virtual para renderizar clips de escenas Remotion sin metraje externo.
 */
export function ensureVirtualMotionAsset(
  project: Project,
  componentName: string,
  durationFrames: number,
): { project: Project; asset: MediaAsset } {
  const fps = project.settings.fps;
  const fpsNum = fpsValue(fps);
  const durationUs = Math.max(100_000, Math.round((durationFrames / fpsNum) * 1_000_000));
  const safeSlug =
    componentName.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase() || "motion";
  const file = `generated/swarm_${safeSlug}_${durationFrames}f.webm`;
  const existing = project.media.find((m) => m.file === file);
  if (existing) {
    return { project, asset: existing };
  }

  const asset: MediaAsset = {
    id: newId("med"),
    name: `${componentName}.webm`,
    kind: "video",
    file,
    mimeType: "video/webm",
    sizeBytes: 0,
    durationUs,
    width: project.settings.width,
    height: project.settings.height,
    fps,
    thumbnail: "ready",
    waveform: "none",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "generated",
  };

  return {
    project: touchProject({
      ...project,
      media: [...project.media, asset],
    }),
    asset,
  };
}

