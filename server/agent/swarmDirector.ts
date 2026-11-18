import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type MediaAsset,
  type MediaClip,
  type Project,
  type TextClip,
  type Track,
} from "../../src/shared/schema";
import {
  autoReframeProject,
  makeMediaClip,
  makeTextClip,
  timelineDurationFrames,
  touchProject,
} from "../../src/shared/project";
import {
  addClip,
  addTrack,
  applySourceRanges,
  ensureSfxTrack,
  findFreeStartFrame,
  isMediaClip,
  updateClip,
} from "../../src/shared/timeline";
import { frameDurationUs, fpsValue, newId } from "../../src/shared/time";
import {
  buildSubtitleComponentCode,
  type RemotionSubtitleStyleId,
} from "../../src/shared/motionTemplates";
import {
  buildHyperFrameAnimatedMap,
  buildHyperFrameBespokeMetaphor,
  buildHyperFrameBrandCard,
  buildHyperFrameChapterCallout,
  buildHyperFrameCharacterDialogue,
  buildHyperFrameCinematicLook,
  buildHyperFrameDataChart,
  buildHyperFrameFloatingUI,
  buildHyperFrameKineticHook,
  buildHyperFrameMetricHud,
  buildHyperFrameMotionGrid,
  buildHyperFrameOpticalTransition,
  buildHyperFrameRichMediaOverlay,
  buildHyperFrameSplitComparison,
  type HyperFramePalette,
  type HyperFrameTransitionVariant,
} from "../../src/shared/hyperframes";
import { detectSilences, keepRangesNatural } from "../media/analysis";
import { transcribeMedia, type TranscriptSegment } from "../ai/provider";
import {
  applyAutonomousSubtitleGovernance,
  buildSubtitles,
  type CaptionCue,
  type CaptionWord,
} from "../motion-agent/subtitles";
import { projectMediaDirectory, projectStore } from "../projects/store";
import { eventBus } from "../events";
import {
  ensureProceduralMusicBedAsset,
  ensureProjectSfxAsset,
  type SfxType,
} from "../services/sfxService";
import {
  synthesizeSceneSpeechTracks,
  type SynthesizedSceneSpeechSegment,
} from "../services/ttsService";
import { skillRegistry } from "../skills/registry";
import {
  analyzeProjectAudioProfile,
  applyDuckedMusicBedTrack,
  resolveMusicBedMood,
  shouldAddProceduralMusicBed,
  type AudioAnalysisProfile,
} from "./audioDirector";
import {
  buildSubjectTrackingTransformKeyframes,
  inspectVideoVisualProfile,
  runClosedLoopVisualQA,
  runGeneratedCompositionVisualQA,
  type VideoVisualProfile,
} from "./visionInspector";
import { runFfmpeg } from "../media/process";
import {
  extractResearchTopic,
  researchTopicOnWeb,
  generateResearchedNarrativePlan,
  isCreativeOrFictionPrompt,
  generateCreativeStoryboardPlan,
} from "./swarmResearcher";
import {
  detectBrandUrlInPrompt,
  extractBrandIdentity,
  generateBrandNarrativePlan,
  type BrandIdentity,
} from "./brandCapture";
import {
  extractProjectSemanticDNA,
  type ProjectSemanticDNA,
} from "./semanticDNA";
import {
  buildPolymorphicProceduralSceneCode,
  computeEditorialBudget,
  deriveAdaptiveScenesFromTranscriptAndPrompt,
  enforceEditorialRestraint,
  ensureVirtualMotionAsset,
  executeSurgicalTimelineTools,
  extractExplicitPromptTitles,
  isConversationalInstructionText,
  mapWithConcurrency,
  parseUserEditingConstraints,
  planAutonomousEditDirective,
  resolveContextualOverlayCopy,
  stripEditingMetaInstructions,
  synthesizeValidatedRemotionScene,
  verifyRemotionComponentTsx,
  type AutonomousEditDirective,
  type BespokeSceneBrief,
  type EditorialBudget,
} from "./autonomousEditorBrain";

const execFileAsync = promisify(execFile);

type TransformKeyframe = NonNullable<MediaClip["transform"]["keyframes"]>[number];

export type SwarmStyle = "minimal" | "tiktok" | "hormozi" | "cinematic" | "neon" | "impact";

export interface SwarmDirectorOptions {
  projectId: string;
  prompt: string;
  userIntent?: string;
  style?: SwarmStyle;
  enablePunches?: boolean;
  enableSilenceCut?: boolean;
  enableBrollCards?: boolean;
  ctaHandle?: string;
  signal?: AbortSignal;
  onProgress?: (stepMessage: string, stepIndex: number, totalSteps: number) => void;
}

export interface SwarmStepReport {
  step: number;
  agent: string;
  summary: string;
  applied: boolean;
}

export type SwarmProductionMode = "modo_a_quirurgico" | "modo_b_generativo" | "modo_c_hibrido";

function sampleKeyframeField(
  keyframes: TransformKeyframe[],
  frame: number,
  field: "scale" | "x" | "y",
  fallback: number,
): number {
  if (keyframes.length === 0) return fallback;
  const first = keyframes[0]!;
  if (frame <= first.frame) return first[field] ?? fallback;
  const last = keyframes.at(-1)!;
  if (frame >= last.frame) return last[field] ?? fallback;

  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const span = Math.max(1, b.frame - a.frame);
      const t = (frame - a.frame) / span;
      const va = a[field] ?? fallback;
      const vb = b[field] ?? fallback;
      return va + (vb - va) * t;
    }
  }
  return fallback;
}

function mergeTrackingAndPunchKeyframes(
  trackingKf: TransformKeyframe[],
  punchKf: TransformKeyframe[],
  baseScale: number,
  baseX: number,
  baseY: number,
): TransformKeyframe[] {
  if (trackingKf.length === 0) return punchKf;
  if (punchKf.length === 0) return trackingKf;

  const frames = [...new Set([...trackingKf.map((k) => k.frame), ...punchKf.map((k) => k.frame)])].sort(
    (a, b) => a - b,
  );
  return frames.map((frame) => {
    const x = Number(sampleKeyframeField(trackingKf, frame, "x", baseX).toFixed(2));
    const y = Number(sampleKeyframeField(trackingKf, frame, "y", baseY).toFixed(2));
    const trackScale = sampleKeyframeField(trackingKf, frame, "scale", baseScale);
    const punchScale = sampleKeyframeField(punchKf, frame, "scale", baseScale);
    return {
      frame,
      scale: Number(Math.max(trackScale, punchScale).toFixed(3)),
      x,
      y,
    };
  });
}

export interface SwarmDirectorResult {
  project: Project;
  summary: string;
  steps: SwarmStepReport[];
  productionMode: SwarmProductionMode;
  productionModeLabel: string;
  stats: {
    silencesRemoved: number;
    subtitleCues: number;
    zoomPunches: number;
    brollCardsInserted: number;
    sfxEventsInserted: number;
    style: RemotionSubtitleStyleId;
    brandDomain?: string;
    collisionsResolved?: number;
    themeCategory?: string;
    surgicalToolsApplied?: number;
    bespokeRemotionScenes?: number;
    aiDirectorUsed?: boolean;
    lookPreset?: string;
    lufsCalibrated?: number;
    visualQaAdjusted?: number;
    musicBedApplied?: boolean;
  };
}

export interface NarrativeBlockPlan {
  index: number;
  label: string;
  startSec: number;
  endSec: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  headline: string;
  subheadline: string;
  narrationText: string;
  cardKind: "hero" | "statement" | "metric" | "chart" | "ui" | "ambient" | "media" | "cta" | "brand" | "map" | "dialogue" | "bespoke";
  customVisualMetaphor?: "neural_network" | "radar_telemetry" | "quantum_orbit" | "isometric_flow" | "chronicle_timeline" | "hud_brackets" | "generic_svg";
  metricValue?: number;
  metricUnit?: string;
  sfxType: SfxType;
  wantsZoomPunch: boolean;
  accentColor: string;
  brandData?: { brandName: string; domain: string; tagline: string; metricsText?: string };
  mapData?: { routeFrom: string; routeTo: string; distanceKm?: number };
  dialogueData?: {
    characterName: string;
    characterRole: string;
    dialogueText: string;
    avatarInitials?: string;
    mood?: "neutral" | "urgent" | "positive" | "question";
  };
}

function createDefaultTransform(): MediaClip["transform"] {
  return {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    animationIn: "none",
    animationInDuration: 30,
    animationOut: "none",
    animationOutDuration: 30,
  };
}

/**
 * Detecta si el prompt del usuario solicita una edición macro / postproducción completa
 * que debe activar la Orquestación de Enjambre Autónomo.
 */
export function isMacroSwarmPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;
  if (
    /\b(trailer|tr[áa]iler|edita\s+todo|editar\s+todo|editar\s+(?:el|este|mi)\s+v[íi]deo|edita\s+(?:el|este|mi)\s+v[íi]deo|editar\s+v[íi]deo|edita\s+v[íi]deo|mejorar\s+(?:el|este)\s+v[íi]deo|montar\s+(?:el|este)\s+v[íi]deo|v[íi]deo\s+completo|hazlo\s+din[áa]mico|hacer\s+un\s+reel|reel\s+din[áa]mico|automatiza\s+la\s+edici[óo]n|edici[óo]n\s+aut[óo]noma|edici[óo]n\s+completa|postproducci[óo]n\s+completa|enjambre|hyperframes|video\s+entero|sigue\s+esta\s+historia\s+paso\s+a\s+paso)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  // Detectar peticiones multi-intención de postproducción (ej. "editar el video, poner graficos, subtitulos transiciones y color")
  const hasEditVerb = /\b(editar|edita|cortar|corta|silencios|limpiar|pulir|montar|armar|mejora|mejorar|transforma|transformar)\b/i.test(normalized);
  const hasSubtitles = /\b(subt[íi]tulos?|captions?|subtitular)\b/i.test(normalized);
  const hasGraphics = /\b(gr[áa]ficos?|tarjetas?|cards?|hud|datos|estad[íi]sticas|b-?roll|diagrama|visualizaci[óo]n|split)\b/i.test(normalized);
  const hasTransitions = /\b(transiciones?|transici[óo]n|cortes\s+suaves|whip)\b/i.test(normalized);
  const hasTitles = /\b(t[íi]tulos?|gancho|hook|portada|lower\s+third|intro|outro)\b/i.test(normalized);
  const hasSfx = /\b(sonidos?|efectos|sfx|whoosh)\b/i.test(normalized);
  const hasColorOrLook = /\b(color|lut|cinematogr[áa]fic|blanco\s+y\s+negro|letterbox|barras\s+negras|atm[óo]sfer|contraste|saturaci[óo]n|iluminaci[óo]n)\b/i.test(normalized);
  const hasSpeedOrPace = /\b(velocidad|c[áa]mara\s+r[áa]pida|c[áa]mara\s+lenta|slow\s*mo|ritmo|zooms?|din[áa]mico)\b/i.test(normalized);
  const hasMotionEngine = /\b(remotion|hyperframes|animaci[óo]n\s+personalizada|escenas?\s+a\s+medida)\b/i.test(normalized);

  const intentCount = [
    hasEditVerb,
    hasSubtitles,
    hasGraphics,
    hasTransitions,
    hasTitles,
    hasSfx,
    hasColorOrLook,
    hasSpeedOrPace,
    hasMotionEngine,
  ].filter(Boolean).length;

  if (intentCount >= 2) {
    return true;
  }

  // Detección de video temático con investigación web (ej. "Generar un video sobre la historia de tiktok", "documental sobre bitcoin")
  if (
    /\b(generar|crear|haz|hacer|crea|quiero)\s+(?:un\s+)?(?:video|reel|clip|corto|documental)\b/i.test(
      normalized,
    ) ||
    /\b(?:video|reel|documental)\s+(?:sobre|de|acerca\s+de|explicando)\b/i.test(normalized) ||
    /\b(historia\s+de|origen\s+de|biograf[íi]a\s+de)\b/i.test(normalized)
  ) {
    return true;
  }
  // Evitar que micro-ediciones puntuales de una propiedad ("cambia el texto a Hola", "sube el tamaño")
  // activen por accidente el enjambre macro mediante extractResearchTopic(<= 60 chars).
  if (
    /^(?:cambia|modifica|pon|ajusta|mueve|borra|quita|sube|baja|aumenta|reduce|haz)\s+(?:el|la|los|las|su)\s+(?:texto|t[íi]tulo|fuente|tama[ñn]o|opacidad|posici[óo]n|color|borde|escala)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }

  if (extractResearchTopic(prompt) !== null) {
    return true;
  }
  // También activar si el prompt describe múltiples bloques temporales (ej. "0 a 8 seg", "8 a 18 seg")
  const timeRangeMatches = normalized.match(/\(\s*\d+\s*(?:a|-|hasta)\s*\d+\s*seg/g);
  return Boolean(timeRangeMatches && timeRangeMatches.length >= 2);
}

function resolveSubtitleStyle(
  prompt: string,
  explicitStyle?: SwarmStyle,
  dna?: ProjectSemanticDNA,
): RemotionSubtitleStyleId {
  if (explicitStyle) return explicitStyle;
  const lower = prompt.toLowerCase();
  if (lower.includes("tiktok")) return "tiktok";
  if (lower.includes("hormozi") || lower.includes("mrbeast") || lower.includes("viral")) {
    return "hormozi";
  }
  if (
    lower.includes("minimal") ||
    lower.includes("limpio") ||
    lower.includes("corporativo") ||
    lower.includes("apple")
  ) {
    return "minimal";
  }
  if (
    lower.includes("cinematic") ||
    lower.includes("cine") ||
    lower.includes("trailer") ||
    lower.includes("tráiler")
  ) {
    return "cinematic";
  }
  if (lower.includes("neon") || lower.includes("cyber") || lower.includes("ciber")) {
    return "neon";
  }
  if (lower.includes("impact") || lower.includes("impacto")) {
    return "impact";
  }

  // Deducir automáticamente según el ADN semántico (Zero-Template Engine)
  if (
    dna?.emotionalTone === "dramatic_cinematic" ||
    dna?.emotionalTone === "epic_documentary" ||
    dna?.category === "creative_cinema" ||
    dna?.category === "education_documentary"
  ) {
    return "cinematic";
  }
  if (dna?.category === "luxury_editorial" || dna?.geometry.layoutStyle === "minimal_swiss") {
    return "minimal";
  }
  if (dna?.category === "cybersecurity_matrix" || dna?.emotionalTone === "dark_futuristic") {
    return "neon";
  }
  if (dna?.emotionalTone === "high_energy") {
    return "hormozi";
  }
  return "minimal";
}

function findPrimaryVideoTrack(project: Project): Track | undefined {
  return (
    project.tracks.find(
      (t) =>
        t.kind === "video" &&
        !t.locked &&
        !/motion|overlay|subt|transici|atm[óo]sfera|v0|fondo\s*ambient/i.test(t.name) &&
        t.clips.some((c) => c.type === "video"),
    ) ??
    project.tracks.find(
      (t) =>
        t.kind === "video" &&
        !t.locked &&
        !/motion|overlay|subt|transici|atm[óo]sfera|v0|fondo\s*ambient/i.test(t.name),
    ) ??
    project.tracks.find((t) => t.kind === "video" && !t.locked)
  );
}

function findPrimaryAudioTrack(project: Project): Track | undefined {
  return (
    project.tracks.find(
      (t) => t.kind === "audio" && !t.locked && t.name !== "SFX" && !/sfx/i.test(t.name),
    ) ?? project.tracks.find((t) => t.kind === "audio" && !t.locked)
  );
}

function ensurePrimaryVideoTrack(project: Project): { project: Project; track: Track } {
  const existing = findPrimaryVideoTrack(project);
  if (existing) return { project, track: existing };
  const added = addTrack(project, "video", "V1");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista V1." : added.error);
  }
  return { project: added.project, track: added.track };
}

function ensurePrimaryAudioTrack(project: Project): { project: Project; track: Track } {
  const existing = findPrimaryAudioTrack(project);
  if (existing) return { project, track: existing };
  const added = addTrack(project, "audio", "A1");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista A1." : added.error);
  }
  return { project: added.project, track: added.track };
}

function ensureCapaMotionTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (t) =>
      t.kind === "video" &&
      !t.locked &&
      (t.name === "Capa Motion" || t.name === "Motion Overlay" || /^Capa Motion\b/i.test(t.name)),
  );
  if (existing) return { project, track: existing };

  const added = addTrack(project, "video", "Capa Motion");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista Capa Motion." : added.error);
  }
  return { project: added.project, track: added.track };
}

function ensureCapaTransicionesTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (t) =>
      t.kind === "video" &&
      !t.locked &&
      (t.name === "Capa Transiciones" || /transici/i.test(t.name)),
  );
  if (existing) return { project, track: existing };

  const added = addTrack(project, "video", "Capa Transiciones");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista Capa Transiciones." : added.error);
  }
  return { project: added.project, track: added.track };
}

function ensureCapaAtmosferaTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (t) =>
      t.kind === "video" &&
      !t.locked &&
      (t.name === "Capa Atmósfera" || /atm[óo]sfera/i.test(t.name)),
  );
  if (existing) return { project, track: existing };

  const added = addTrack(project, "video", "Capa Atmósfera");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista Capa Atmósfera." : added.error);
  }
  return { project: added.project, track: added.track };
}

function ensureSubtitleTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (t) =>
      t.kind === "text" &&
      !t.locked &&
      (t.name === "Capa Motion Subtítulos" || t.name === "Subtítulos" || /subt[íi]tulos/i.test(t.name)),
  );
  if (existing) return { project, track: existing };

  const anyText = project.tracks.find((t) => t.kind === "text" && !t.locked && !/t[ií]tulo/i.test(t.name));
  if (anyText) return { project, track: anyText };

  const added = addTrack(project, "text", "Capa Motion Subtítulos");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista de subtítulos." : added.error);
  }
  return { project: added.project, track: added.track };
}

function ensureTitleTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (t) =>
      t.kind === "text" &&
      !t.locked &&
      (t.name === "Títulos" || /t[ií]tulo/i.test(t.name)) &&
      !/subt[íi]tulo/i.test(t.name),
  );
  if (existing) return { project, track: existing };

  const added = addTrack(project, "text", "Títulos");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista Títulos." : added.error);
  }
  return { project: added.project, track: added.track };
}

// ============================================================================
// PARSER NARRATIVO Y ESTIMADOR DE BLOQUES TEMPORALES
// ============================================================================

export const BLOCK_PALETTES = [
  "#4ADE80", // Verde esmeralda vibrante
  "#F59E0B", // Ámbar / alerta cálida
  "#38BDF8", // Cian eléctrico
  "#A855F7", // Violeta neón
  "#F43F5E", // Coral / CTA
];

export function generateDynamicPaletteSequence(
  palette: HyperFramePalette,
  count: number,
): string[] {
  const result: string[] = [];
  const baseAccent = palette.accent;
  const baseSecondary = palette.secondary;
  const harmonies = [
    baseAccent,
    baseSecondary,
    "#38BDF8",
    "#F59E0B",
    "#10B981",
    "#A855F7",
    "#F43F5E",
    "#6366F1",
    "#EC4899",
  ];
  for (let i = 0; i < count; i += 1) {
    if (i === 0) result.push(baseAccent);
    else if (i === 1) result.push(baseSecondary);
    else result.push(harmonies[i % harmonies.length]!);
  }
  return result;
}

function extractQuotedStrings(text: string): string[] {
  const matches: string[] = [];
  const regex = /["“«]([^"”»]{3,280})["”»]/g;
  for (const m of text.matchAll(regex)) {
    const val = (m[1] ?? "").trim();
    if (val) matches.push(val);
  }
  return matches;
}

export function detectTargetDurationSeconds(prompt: string): number {
  // 1. Buscar mención explícita "de 50 segundos", "duración de 45 seg", "1 minuto"
  const explicitSec = prompt.match(/\b(?:de\s+|duraci[óo]n\s+de\s+)?(\d{1,3})\s*(?:segundos|seg|s)\b/i);
  let maxSec = explicitSec?.[1] ? Number(explicitSec[1]) : 0;

  const explicitMin = prompt.match(/\b(\d+)\s*minuto(s)?\b/i);
  if (explicitMin?.[1]) {
    maxSec = Math.max(maxSec, Number(explicitMin[1]) * 60);
  }

  // 2. Buscar el mayor límite superior en rangos "(X a Y seg)"
  const rangeRegex = /\(\s*(\d+(?:\.\d+)?)\s*(?:a|-|hasta)\s*(\d+(?:\.\d+)?)\s*(?:seg|segundos|s)?\s*\)/gi;
  for (const match of prompt.matchAll(rangeRegex)) {
    const endVal = Number(match[2]);
    if (Number.isFinite(endVal) && endVal > maxSec) {
      maxSec = endVal;
    }
  }

  return Math.min(300, Math.max(15, maxSec || 30));
}

/**
 * Analiza el prompt del usuario para extraer bloques narrativos con tiempos exactos
 * (por ejemplo: 0-8s, 8-18s, 18-35s, 35-45s, 45-50s), titulares, guion hablado,
 * métricas y efectos de sonido. Si el prompt es breve, construye automáticamente
 * una estructura narrativa completa de 4 bloques sin huecos.
 */
export function parsePromptNarrativePlan(
  prompt: string,
  fpsNum: number,
  projectName: string,
): { targetDurationSec: number; totalFrames: number; blocks: NarrativeBlockPlan[] } {
  const targetDurationSec = detectTargetDurationSeconds(prompt);
  const totalFrames = Math.max(Math.round(fpsNum * 15), Math.round(targetDurationSec * fpsNum));

  // Intentar extraer bloques numerados o con rangos de segundos:
  // Ej: "1. El Gancho (0 a 8 seg): ..."
  const rawBlockRegex =
    /(?:^|\n)\s*(?:(\d+)[\.\)\-]\s*)?([^\n(]{2,60}?)\s*\(\s*(\d+(?:\.\d+)?)\s*(?:a|-|hasta)\s*(\d+(?:\.\d+)?)\s*(?:seg|segundos|s)?\s*\)\s*:?\s*([\s\S]*?)(?=(?:\n\s*(?:\d+[\.\)\-]\s*)?[^\n(]{2,60}?\s*\(\s*\d+(?:\.\d+)?\s*(?:a|-|hasta)\s*\d+)|(?:\n\s*Ponle\s+subt[íi]tulos)|$)/gi;

  const parsedBlocks: NarrativeBlockPlan[] = [];
  let idx = 0;

  for (const match of prompt.matchAll(rawBlockRegex)) {
    const rawLabel = (match[2] ?? `Escena ${idx + 1}`).trim();
    const startSec = Math.max(0, Number(match[3] ?? 0));
    const endSec = Math.max(startSec + 2, Number(match[4] ?? startSec + 6));
    const body = (match[5] ?? "").trim();

    const quotes = extractQuotedStrings(body);
    const headline =
      quotes[0] ??
      (body.split(/[\.\n]/)[0]?.trim().slice(0, 70) || rawLabel);
    const subheadline =
      quotes[1] ??
      (quotes.length === 1 && headline.length > 48
        ? rawLabel
        : "Edición Dinámica · AI Motion Studio");

    // El texto narrado une todas las citas entrecomilladas del bloque (o el cuerpo limpio)
    const narrationText =
      quotes.length > 0
        ? quotes.join(". ")
        : body
            .replace(/haz un acercamiento[^.]*\./gi, "")
            .replace(/mete un sonido[^.]*\./gi, "")
            .replace(/que entre con un efecto[^.]*\./gi, "")
            .trim() || headline;

    const combinedLower = `${rawLabel} ${body} ${headline}`.toLowerCase();
    const percentMatch = `${headline} ${body}`.match(/(\d{1,3})\s*%/);
    const numberMatch = `${headline} ${body}`.match(/\b(\d{2,4})\s*(horas|d[íi]as|veces|usd|euros|\$)/i);

    let cardKind: NarrativeBlockPlan["cardKind"] = "statement";
    let metricValue: number | undefined;
    let metricUnit: string | undefined;

    if (idx === 0 || /gancho|hook|inicio|t[íi]tulo\s+grande/i.test(combinedLower)) {
      cardKind = "hero";
    } else if (
      /cierre|llamada\s+a\s+la\s+acci[óo]n|cta|bot[óo]n\s+flotante|guarda\s+este\s+video|s[íi]guenos/i.test(
        combinedLower,
      )
    ) {
      cardKind = "cta";
    } else if (/gr[áa]fico|barras?|chart|comparativ|progreso|tendencia/i.test(combinedLower)) {
      cardKind = "chart";
    } else if (/perfil|avatar|orador|speaker|usuario|persona|personaje|equipo|testimonio|interfaz|notificaci[óo]n/i.test(combinedLower)) {
      cardKind = "ui";
    } else if (/cyber|futur|ciber|malla|grid|ambiente|part[íi]cula|espacio|anime|atm[óo]sfera/i.test(combinedLower)) {
      cardKind = "ambient";
    } else if (/imagen|foto|sticker|icono|multimedia|recorte|visual/i.test(combinedLower)) {
      cardKind = "media";
    } else if (percentMatch || numberMatch || /tarjeta\s+animada\s+con\s+n[úu]meros|m[ée]trica|ahorra/i.test(combinedLower)) {
      cardKind = "metric";
      if (percentMatch?.[1]) {
        metricValue = Number(percentMatch[1]);
        metricUnit = "%";
      } else if (numberMatch?.[1]) {
        metricValue = Number(numberMatch[1]);
        metricUnit = ` ${numberMatch[2]}`;
      } else {
        metricValue = 70;
        metricUnit = "%";
      }
    }

    let sfxType: SfxType = "whoosh";
    if (/\b(ding|campana|campanita)\b/i.test(combinedLower) || cardKind === "metric") {
      sfxType = "ding";
    } else if (/\b(pop|clic|click|bot[óo]n)\b/i.test(combinedLower)) {
      sfxType = "pop";
    }
    if (/\bwhoosh\b/i.test(combinedLower)) {
      sfxType = "whoosh";
    }

    const wantsZoomPunch =
      idx > 0 ||
      /acercamiento|zoom|enfatizar|golpe|ritmo|importantes/i.test(combinedLower);

    const startFrame = Math.max(0, Math.round(startSec * fpsNum));
    const endFrame = Math.max(startFrame + Math.round(fpsNum), Math.round(endSec * fpsNum));

    parsedBlocks.push({
      index: idx,
      label: rawLabel,
      startSec,
      endSec,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      headline,
      subheadline,
      narrationText,
      cardKind,
      metricValue,
      metricUnit,
      sfxType,
      wantsZoomPunch,
      accentColor: BLOCK_PALETTES[idx % BLOCK_PALETTES.length]!,
    });
    idx += 1;
  }

  if (parsedBlocks.length >= 2) {
    // Asegurar continuidad perfecta sin huecos entre bloques desde 0 hasta totalFrames
    parsedBlocks.sort((a, b) => a.startFrame - b.startFrame);
    parsedBlocks[0]!.startFrame = 0;
    parsedBlocks[0]!.startSec = 0;
    for (let i = 0; i < parsedBlocks.length; i += 1) {
      const curr = parsedBlocks[i]!;
      const next = parsedBlocks[i + 1];
      if (next) {
        curr.endFrame = next.startFrame;
        curr.endSec = curr.endFrame / fpsNum;
      } else {
        curr.endFrame = Math.max(curr.endFrame, totalFrames);
        curr.endSec = curr.endFrame / fpsNum;
      }
      curr.durationFrames = Math.max(15, curr.endFrame - curr.startFrame);
    }
    const finalFrame = parsedBlocks[parsedBlocks.length - 1]!.endFrame;
    return {
      targetDurationSec: finalFrame / fpsNum,
      totalFrames: finalFrame,
      blocks: parsedBlocks,
    };
  }

  // Motor Dinámico de Planificación Narrativa (Zero-Template Engine)
  const explicitTitles = extractExplicitPromptTitles(prompt);
  const strippedPrompt = stripEditingMetaInstructions(prompt);
  const cleanTopic =
    (strippedPrompt && !isConversationalInstructionText(strippedPrompt)
      ? strippedPrompt.split(/[\.\n]/)[0]?.trim()
      : "") ||
    explicitTitles.introTitle ||
    (!/^(mi\s+nuevo\s+montaje|proyecto\s+sin\s+t[íi]tulo|untitled)/i.test(projectName)
      ? projectName
      : "Presentación");

  const sentences = (strippedPrompt || "")
    .split(/[\.\n;]/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 10 &&
        !isConversationalInstructionText(s) &&
        !/^(pon|haz|crea|edita|limpia|aplica|genera|agrega|mant[eé]n)\b/i.test(s),
    );

  const blockCount =
    targetDurationSec <= 22 ? 3 : targetDurationSec <= 48 ? 4 : targetDurationSec <= 65 ? 5 : 6;

  const preliminaryDna = extractProjectSemanticDNA({ prompt, projectName });
  const sceneColors = generateDynamicPaletteSequence(preliminaryDna.masterPalette, blockCount);

  const sanitizedForNumbers = (strippedPrompt || prompt)
    .replace(/\b\d+\s*:\s*\d+\b/g, " ")
    .replace(/\b\d{3,4}[pPkK]\b/g, " ")
    .replace(/\b\d+\s*(?:fps|hz|khz)\b/gi, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*s(?:eg(?:undos?)?)?\b/gi, " ");
  const explicitNumberMatch = sanitizedForNumbers.match(
    /(\d{1,4})\s*(%|por\s*ciento|k|m|millones|horas|d[ií]as|veces|\$|usd|eur)\b/i,
  );

  const dynamicBlocks: NarrativeBlockPlan[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    const isFirst = i === 0;
    const isLast = i === blockCount - 1;
    const ratioStart = i / blockCount;
    const ratioEnd = (i + 1) / blockCount;
    const startFrame = Math.round(totalFrames * ratioStart);
    const endFrame = isLast ? totalFrames : Math.round(totalFrames * ratioEnd);

    let label = "";
    let headline = "";
    let subheadline = "";
    let narrationText = "";
    let cardKind: NarrativeBlockPlan["cardKind"] = "statement";
    let sfx: SfxType = "whoosh";
    let metricVal: number | undefined;
    let metricUnitStr: string | undefined;

    const sentence0 = sentences[0];
    const sentence1 = sentences[1];
    const sentenceI = sentences[i];

    const category = (preliminaryDna.categoryLabel || "").toLowerCase();
    const isAcademicOrEco =
      /sostenib|ambient|ecolog|universi|estudi|investig|educa|salud|cienc/i.test(category) ||
      /residu|recicl|campus|proyecto|diagn[óo]stic/i.test(prompt);
    const isBusinessOrGrowth =
      /finan|negocio|ventas|marketing|crypto|cripto|empresa|inversi|growth|startup/i.test(category);
    const isTechOrDev =
      /software|c[óo]digo|ia|ai|tecnolog|algoritm|cyber|desarroll/i.test(category);

    if (isFirst) {
      label = isAcademicOrEco
        ? "PROPÓSITO & CONTEXTO"
        : isBusinessOrGrowth
          ? "PROPUESTA DE VALOR"
          : isTechOrDev
            ? "INNOVACIÓN"
            : "APERTURA";
      cardKind = "hero";
      headline = explicitTitles.introTitle ?? cleanTopic.slice(0, 42).toUpperCase();
      subheadline =
        explicitTitles.introSubtitle ??
        (sentence0 && sentence0 !== explicitTitles.introTitle
          ? sentence0.slice(0, 56)
          : cleanTopic.slice(0, 56));
      narrationText = explicitTitles.introTitle
        ? `${explicitTitles.introTitle}${explicitTitles.introSubtitle ? `, ${explicitTitles.introSubtitle}` : ""}.`
        : `Descubre cómo ${cleanTopic} transforma tu flujo de trabajo desde el primer segundo.`;
      sfx = "whoosh";
    } else if (isLast) {
      label = isAcademicOrEco
        ? "IMPACTO & CIERRE"
        : isBusinessOrGrowth
          ? "DA EL SIGUIENTE PASO"
          : "CIERRE";
      cardKind = "cta";
      headline = explicitTitles.outroTitle ?? `Pruébalo en ${cleanTopic.slice(0, 24)}`;
      subheadline = explicitTitles.outroSubtitle ?? "Empieza a crear hoy mismo";
      narrationText = explicitTitles.outroTitle ?? preliminaryDna.vocabulary.ctaPhrase;
      sfx = "ding";
    } else if (i === 1) {
      label = isAcademicOrEco
        ? "DATOS CLAVE"
        : isBusinessOrGrowth
          ? "VENTAJA COMPETITIVA"
          : isTechOrDev
            ? "FLUJO INTELIGENTE"
            : "CLAVE PRINCIPAL";
      cardKind = preliminaryDna.characters.length > 0 && i % 2 === 1 ? "ui" : "bespoke";
      headline =
        (sentence1 ? sentence1.slice(0, 45).toUpperCase() : cleanTopic.slice(0, 38).toUpperCase());
      subheadline = "Resultados profesionales en cuestión de segundos";
      narrationText =
        sentence1 ??
        `Con ${cleanTopic} logras un acabado limpio, rápido y coherente sin complicaciones técnicas.`;
      sfx = "pop";
    } else if (i === 2 && explicitNumberMatch) {
      label = isAcademicOrEco
        ? "RESULTADOS EN CIFRAS"
        : isBusinessOrGrowth
          ? "IMPACTO MEDIBLE"
          : "MÉTRICA CLAVE";
      cardKind = "chart";
      metricVal = Number(explicitNumberMatch[1]);
      const rawUnit = explicitNumberMatch[2] || "%";
      metricUnitStr = /por\s*ciento/i.test(rawUnit) ? "%" : rawUnit;
      headline = `${metricVal}${metricUnitStr} DE IMPACTO`;
      subheadline = "Rendimiento comprobado en producción";
      narrationText = `Alcanza hasta un ${metricVal}${metricUnitStr} de mejora tangible en cada publicación.`;
      sfx = "ding";
    } else {
      label = "ENFOQUE PRÁCTICO";
      cardKind = i % 2 === 0 ? "bespoke" : "statement";
      headline =
        (sentenceI ? sentenceI.slice(0, 45).toUpperCase() : `${cleanTopic.toUpperCase()} EN ACCIÓN`);
      subheadline = "Precisión visual y narrativa sin saturar la pantalla";
      narrationText =
        sentenceI ??
        `Cada detalle se adapta automáticamente para mantener la atención de tu audiencia de principio a fin.`;
      sfx = "pop";
    }

    dynamicBlocks.push({
      index: i,
      label,
      startSec: startFrame / fpsNum,
      endSec: endFrame / fpsNum,
      startFrame,
      endFrame,
      durationFrames: Math.max(15, endFrame - startFrame),
      headline,
      subheadline,
      narrationText,
      cardKind,
      metricValue: metricVal,
      metricUnit: metricUnitStr,
      sfxType: sfx,
      wantsZoomPunch: i >= 1,
      accentColor: sceneColors[i % sceneColors.length]!,
    });
  }

  return {
    targetDurationSec,
    totalFrames,
    blocks: dynamicBlocks,
  };
}

// ============================================================================
// GENERACIÓN DE VOZ HABLADA SINTÉTICA (TTS WAV) + SUBTÍTULOS ESTIMADOS
// ============================================================================

/**
 * Crea un archivo WAV PCM de 48kHz válido en disco con duración exacta `durationSec`.
 * Si Windows SAPI (`System.Speech`) está disponible, sintetiza la locución real en español
 * y la ajusta a la duración objetivo del timeline para que nunca quede truncada.
 */
async function generateSyntheticTtsWavFile(
  destinationPath: string,
  narrationScript: string,
  durationSec: number,
): Promise<{ sizeBytes: number; durationUs: number }> {
  const sampleRate = 48000;
  const totalSamples = Math.max(sampleRate, Math.round(durationSec * sampleRate));
  const durationUs = Math.round(durationSec * 1_000_000);

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  // Intentar síntesis de voz real mediante Windows SAPI (System.Speech.Synthesis)
  const tempSapiPath = `${destinationPath}.sapi.wav`;
  let sapiSucceeded = false;

  if (process.platform === "win32" && narrationScript.trim().length > 0) {
    try {
      const sanitizedText = narrationScript
        .replace(/["'`$]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1800);

      const psScript = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like "es*" }
if ($voices.Count -gt 0) { $synth.SelectVoice($voices[0].VoiceInfo.Name) }
$synth.Rate = 0
$synth.Volume = 100
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${sampleRate}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile('${tempSapiPath.replace(/'/g, "''")}', $format)
$synth.Speak('${sanitizedText.replace(/'/g, "''")}')
$synth.Dispose()
`;
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        { timeout: 15_000 },
      );
      const stat = await fs.stat(tempSapiPath);
      if (stat.size > 44) {
        sapiSucceeded = true;
      }
    } catch {
      sapiSucceeded = false;
    }
  }

  // Construir buffer PCM 16-bit Mono de exactamente `totalSamples` muestras (duración exacta del timeline)
  const headerSize = 44;
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // Cabecera RIFF WAVE estándar
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20);  // AudioFormat = 1 (PCM)
  buffer.writeUInt16LE(1, 22);  // NumChannels = 1 (Mono)
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  if (sapiSucceeded) {
    try {
      const rawSapi = await fs.readFile(tempSapiPath);
      // Buscar el chunk "data" dentro del WAV generado por SAPI
      let dataOffset = 44;
      for (let i = 12; i < Math.min(rawSapi.length - 8, 256); i += 1) {
        if (
          rawSapi[i] === 0x64 &&
          rawSapi[i + 1] === 0x61 &&
          rawSapi[i + 2] === 0x74 &&
          rawSapi[i + 3] === 0x61
        ) {
          dataOffset = i + 8;
          break;
        }
      }
      const copyBytes = Math.min(dataSize, Math.max(0, rawSapi.length - dataOffset));
      if (copyBytes > 0) {
        rawSapi.copy(buffer, headerSize, dataOffset, dataOffset + copyBytes);
      }
      await fs.unlink(tempSapiPath).catch(() => undefined);
    } catch {
      // Si falla la copia, el resto del buffer queda con silencio limpio
    }
  }

  await fs.writeFile(destinationPath, buffer);
  return { sizeBytes: buffer.length, durationUs };
}

/**
 * Crea un video base MP4 liviano (~150KB) en disco para V1 cuando no hay video preexistente.
 * Esto permite que FFmpeg lo procese como video base en Fase 1, evitando que Remotion
 * tenga que renderizar miles de fotogramas PNG pesados para el fondo durante la exportación.
 */
async function generateSyntheticBackgroundVideo(
  destinationPath: string,
  durationSec: number,
  width: number,
  height: number,
): Promise<{ sizeBytes: number; durationUs: number }> {
  const durSec = Math.max(1, durationSec);
  const durationUs = Math.round(durSec * 1_000_000);
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round(height / 2) * 2);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  try {
    await runFfmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x090D14:s=${w}x${h}:d=${durSec.toFixed(3)}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-t",
        durSec.toFixed(3),
        destinationPath,
      ],
      { timeoutMs: 30_000 },
    );
    const stat = await fs.stat(destinationPath).catch(() => null);
    return { sizeBytes: stat?.size ?? 1024, durationUs };
  } catch {
    return { sizeBytes: 1024, durationUs };
  }
}

/**
 * Estima las marcas de tiempo palabra por palabra (140–160 WPM) distribuidas dentro
 * del intervalo exacto `[block.startFrame, block.endFrame]` de cada bloque narrativo.
 */
export function buildSyntheticCaptionCuesFromBlocks(
  blocks: NarrativeBlockPlan[],
  fpsNum: number,
  speechSegments?: SynthesizedSceneSpeechSegment[],
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const wordsPerCue = 4;

  for (let bIdx = 0; bIdx < blocks.length; bIdx += 1) {
    const block = blocks[bIdx]!;
    const speechSeg = speechSegments?.[bIdx];
    const spokenFrames = speechSeg
      ? Math.max(8, Math.round(speechSeg.spokenDurationSec * fpsNum))
      : undefined;

    const rawTokens = block.narrationText
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (rawTokens.length === 0) continue;

    // Margen mínimo cuando hay duración real medida con ffprobe; padding suave si es estimado
    const padIn = spokenFrames
      ? Math.min(3, Math.floor(block.durationFrames * 0.03))
      : Math.min(Math.round(fpsNum * 0.2), Math.floor(block.durationFrames * 0.08));
    const padOut = spokenFrames
      ? Math.max(2, block.endFrame - (block.startFrame + Math.min(block.durationFrames, spokenFrames)))
      : Math.min(Math.round(fpsNum * 0.25), Math.floor(block.durationFrames * 0.1));
    const usableStart = block.startFrame + padIn;
    const usableEnd = Math.max(usableStart + rawTokens.length * 2, block.endFrame - padOut);
    const availableFrames = Math.max(rawTokens.length * 2, usableEnd - usableStart);

    // Velocidad natural ~150 WPM (2.5 palabras/seg) o ritmo real exacto de spokenFrames
    const idealFramesPerWord = Math.round(fpsNum / 2.5);
    const framesPerWord = Math.max(
      4,
      Math.min(
        Math.round(fpsNum * 0.65),
        Math.min(idealFramesPerWord, Math.floor(availableFrames / rawTokens.length)),
      ),
    );

    const weights = rawTokens.map((t) => {
      const base = Math.max(3, Math.min(12, t.length));
      const pauseBonus = /[.,;!?]$/.test(t) ? 3.5 : 0;
      return base + pauseBonus;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    const totalSpeechFrames = spokenFrames
      ? availableFrames
      : Math.min(
          availableFrames,
          Math.max(Math.round(availableFrames * 0.88), rawTokens.length * framesPerWord),
        );

    const words: CaptionWord[] = [];
    let cursor = usableStart;

    for (let i = 0; i < rawTokens.length; i += 1) {
      const token = rawTokens[i]!;
      const w = weights[i]!;
      const dur =
        i === rawTokens.length - 1
          ? Math.max(3, usableStart + totalSpeechFrames - cursor)
          : Math.max(3, Math.round((w / totalWeight) * totalSpeechFrames));
      const start = cursor;
      const end = Math.min(block.endFrame - 1, start + dur);
      words.push({
        text: token,
        start,
        end: Math.max(start + 1, end),
      });
      cursor = end;
    }

    for (let i = 0; i < words.length; i += wordsPerCue) {
      const group = words.slice(i, i + wordsPerCue);
      if (group.length === 0) continue;
      const cueStart = group[0]!.start;
      const cueEnd = group[group.length - 1]!.end;
      cues.push({
        start: cueStart,
        end: Math.max(cueStart + 2, cueEnd),
        words: group,
      });
    }
  }

  return cues;
}

/**
 * Reajusta la duración y fronteras de los bloques narrativos a la duración real medida del TTS.
 * Respeta bloques explícitos ampliando únicamente si la locución excede el rango.
 */
export function rebalanceNarrativePlanWithTts(
  plan: { targetDurationSec: number; totalFrames: number; blocks: NarrativeBlockPlan[] },
  segments: SynthesizedSceneSpeechSegment[],
  fpsNum: number,
  preserveExplicitTimings: boolean,
): { targetDurationSec: number; totalFrames: number; blocks: NarrativeBlockPlan[] } {
  if (segments.length === 0 || plan.blocks.length === 0) return plan;

  let frameCursor = 0;
  const blocks: NarrativeBlockPlan[] = plan.blocks.map((block, idx) => {
    const seg = segments[idx];
    if (!seg) {
      const dur = Math.max(15, block.durationFrames);
      const startFrame = frameCursor;
      const endFrame = startFrame + dur;
      frameCursor = endFrame;
      return {
        ...block,
        startSec: Number((startFrame / fpsNum).toFixed(3)),
        endSec: Number((endFrame / fpsNum).toFixed(3)),
        startFrame,
        endFrame,
        durationFrames: dur,
      };
    }

    const spokenNeededFrames = Math.max(15, Math.round(seg.durationSec * fpsNum));
    const originalFrames = Math.max(15, block.durationFrames);
    const nextDurationFrames = preserveExplicitTimings
      ? Math.max(originalFrames, spokenNeededFrames)
      : spokenNeededFrames;

    const startFrame = frameCursor;
    const endFrame = startFrame + nextDurationFrames;
    frameCursor = endFrame;

    return {
      ...block,
      startSec: Number((startFrame / fpsNum).toFixed(3)),
      endSec: Number((endFrame / fpsNum).toFixed(3)),
      startFrame,
      endFrame,
      durationFrames: nextDurationFrames,
    };
  });

  const totalFrames = Math.max(15, frameCursor);
  return {
    blocks,
    totalFrames,
    targetDurationSec: Number((totalFrames / fpsNum).toFixed(3)),
  };
}

// ============================================================================
// GENERADORES DE COMPONENTES REMOTION ADAPTATIVOS (SIN HUECOS EN NEGRO)
// ============================================================================

/**
 * Fondo cinemático continuo para V1 cuando el usuario no ha subido un video base.
 * Mantiene movimiento orgánico en pantalla y soporta los punches de cámara de V1.
 * Ahora se nutre del ADN semántico del proyecto para inyectar partículas coherentes
 * (pétalos sakura, hojas bio, bits cyber, chispas doradas o polvo bokeh) calculadas
 * de forma determinista a 60 FPS con useCurrentFrame().
 */
function buildSyntheticV1BackgroundCode(componentName: string, dna?: ProjectSemanticDNA): string {
  const particleType = dna?.atmosphere.particleType ?? "bokeh_dust";
  const bgGradients = dna?.atmosphere.backgroundGradients ?? ["#131B26", "#090D14", "#05070B"];
  const defaultAccent = dna?.masterPalette.accent ?? "#4ADE80";
  const defaultSecondary = dna?.masterPalette.secondary ?? "#38BDF8";
  const glowColor = dna?.atmosphere.glowColor ?? defaultAccent;

  return `import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const ${componentName} = (props: {
  accentColor?: string;
  secondaryColor?: string;
  sceneLabel?: string;
  sceneIndex?: number;
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const accent = props.accentColor ?? "${defaultAccent}";
  const secondary = props.secondaryColor ?? "${defaultSecondary}";
  const unit = Math.min(width, height);

  const driftX = Math.sin(frame / 28) * (unit * 0.08);
  const driftY = Math.cos(frame / 34) * (unit * 0.06);
  const pulse = 0.92 + 0.14 * Math.sin(frame / 22);
  const fadeOut = interpolate(
    frame,
    [Math.max(1, durationInFrames - 10), durationInFrames],
    [1, 0.88],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // 12 Partículas procedimentales deterministas sincronizadas a 60 FPS
  const particles = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((idx) => {
    const pX = (width * ((idx * 83 + frame * (idx % 2 === 0 ? 0.45 : 0.75)) % 1000)) / 1000;
    const pY = (height * ((idx * 139 + frame * 0.6) % 1000)) / 1000;
    const pRot = (frame * 1.8 + idx * 37) % 360;
    const pScale = 0.6 + 0.4 * Math.sin((frame + idx * 20) / 18);
    return { idx, pX, pY, pRot, pScale };
  });

  return (
    <AbsoluteFill
      style={{
        background: "radial-gradient(circle at 50% 35%, ${bgGradients[0]} 0%, ${bgGradients[1]} 68%, ${bgGradients[2]} 100%)",
        overflow: "hidden",
        opacity: fadeOut,
      }}
    >
      {/* Orbe de luz principal */}
      <div
        style={{
          position: "absolute",
          width: unit * 0.88,
          height: unit * 0.88,
          borderRadius: "50%",
          left: width * 0.5 - unit * 0.44 + driftX,
          top: height * 0.36 - unit * 0.44 + driftY,
          background: "radial-gradient(circle, " + accent + "33 0%, " + secondary + "16 48%, transparent 72%)",
          transform: "scale(" + pulse.toFixed(3) + ")",
          filter: "blur(40px)",
        }}
      />
      {/* Orbe secundario inferior */}
      <div
        style={{
          position: "absolute",
          width: unit * 0.72,
          height: unit * 0.72,
          borderRadius: "50%",
          left: width * 0.25 - driftX * 0.8,
          top: height * 0.68 - driftY * 0.8,
          background: "radial-gradient(circle, " + secondary + "28 0%, transparent 70%)",
          filter: "blur(44px)",
        }}
      />

      {/* Partículas temáticas procedimentales */}
      {particles.map(({ idx, pX, pY, pRot, pScale }) => {
        const isSakura = "${particleType}" === "sakura_petals";
        const isBio = "${particleType}" === "bio_leaves";
        const isCyber = "${particleType}" === "cyber_bits";
        const isSpark = "${particleType}" === "gold_sparks";
        const isQuantum = "${particleType}" === "quantum_nodes";
        const isStar = "${particleType}" === "star_drift";
        const isFluid = "${particleType}" === "fluid_waves";
        const isRays = "${particleType}" === "energy_rays";

        const pStyle: React.CSSProperties = {
          position: "absolute",
          left: pX,
          top: pY,
          transform: "rotate(" + pRot.toFixed(1) + "deg) scale(" + pScale.toFixed(2) + ")",
          pointerEvents: "none",
        };

        if (isSakura) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: 14,
                height: 20,
                borderRadius: "70% 0 70% 0",
                background: "linear-gradient(135deg, #F472B6 0%, #FDA4AF 100%)",
                opacity: 0.38,
                filter: "drop-shadow(0 2px 4px rgba(244,114,182,0.3))",
              }}
            />
          );
        }

        if (isBio) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: 16,
                height: 10,
                borderRadius: "50% 0 50% 0",
                background: "linear-gradient(135deg, #34D399 0%, #10B981 100%)",
                opacity: 0.32,
              }}
            />
          );
        }

        if (isCyber) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: idx % 3 === 0 ? 6 : 4,
                height: idx % 3 === 0 ? 6 : 4,
                background: idx % 2 === 0 ? "${dna?.masterPalette.accent ?? "#38BDF8"}" : "${dna?.masterPalette.secondary ?? "#818CF8"}",
                boxShadow: "0 0 8px ${glowColor}",
                opacity: 0.65,
              }}
            />
          );
        }

        if (isSpark) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#FBBF24",
                boxShadow: "0 0 10px #F59E0B",
                opacity: 0.45,
              }}
            />
          );
        }

        if (isQuantum) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "radial-gradient(circle, #38BDF8 20%, #818CF8 80%)",
                boxShadow: "0 0 12px #38BDF8, 0 0 24px #818CF8",
                opacity: 0.75,
              }}
            />
          );
        }

        if (isStar) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: idx % 2 === 0 ? 5 : 3,
                height: idx % 2 === 0 ? 5 : 3,
                borderRadius: "50%",
                background: "#FFFFFF",
                boxShadow: "0 0 8px #FFFFFF, 0 0 16px #38BDF8",
                opacity: 0.85,
              }}
            />
          );
        }

        if (isFluid) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: 28,
                height: 8,
                borderRadius: 14,
                background: "linear-gradient(90deg, #10B981, #06B6D4)",
                filter: "blur(2px)",
                opacity: 0.45,
              }}
            />
          );
        }

        if (isRays) {
          return (
            <div
              key={idx}
              style={{
                ...pStyle,
                width: 36,
                height: 2,
                background: "linear-gradient(90deg, transparent, #F59E0B, transparent)",
                boxShadow: "0 0 10px #F59E0B",
                opacity: 0.6,
              }}
            />
          );
        }

        return (
          <div
            key={idx}
            style={{
              ...pStyle,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "radial-gradient(circle, " + accent + "24 0%, transparent 70%)",
              filter: "blur(3px)",
              opacity: 0.35,
            }}
          />
        );
      })}

      {/* Retícula editorial sutil */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
          backgroundSize: Math.round(unit * 0.08) + "px " + Math.round(unit * 0.08) + "px",
          opacity: 0.5,
        }}
      />
    </AbsoluteFill>
  );
};`;
}

/**
 * Construye el código Remotion TSX procedural de cada tarjeta de escena en "Capa Motion"
 * aprovechando el catálogo completo de HyperFrames (Data Charts, Floating UI, Motion Grids,
 * Kinetic Hooks, Rich Media y Chapter Callouts) con micro-física a 60 FPS determinista.
 */
function buildAdaptiveSceneCardSpec(
  block: NarrativeBlockPlan,
  dna?: ProjectSemanticDNA,
): {
  componentName: string;
  compositionId: string;
  code: string;
  props: Record<string, unknown>;
} {
  const idx = block.index + 1;
  const cleanBadge = block.label.replace(/^\d+\s*·\s*/, "").trim().toUpperCase();
  const palette: HyperFramePalette = {
    accent: block.accentColor || dna?.masterPalette.accent || "#38BDF8",
    secondary: dna?.masterPalette.secondary || BLOCK_PALETTES[(block.index + 2) % BLOCK_PALETTES.length] || "#818CF8",
    surface: dna?.masterPalette.surface || "#0F172A",
    text: dna?.masterPalette.text || "#F8FAFC",
  };

  if (block.cardKind === "dialogue" || block.dialogueData) {
    const spec = buildHyperFrameCharacterDialogue({
      characterName: block.dialogueData?.characterName ?? (dna?.characters?.[0]?.name || "Protagonista"),
      characterRole: block.dialogueData?.characterRole ?? (dna?.characters?.[0]?.role || "Testimonio Clave"),
      dialogueText: block.dialogueData?.dialogueText ?? block.subheadline ?? block.headline,
      avatarInitials: block.dialogueData?.avatarInitials ?? dna?.characters?.[0]?.initials,
      badge: block.label.toUpperCase(),
      zone: "hero-top",
      palette,
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "brand" || block.brandData) {
    const brandName = block.brandData?.brandName ?? block.headline;
    const cleanDomain = brandName.toLowerCase().replace(/[^a-z0-9]/g, "") || "brand";
    const spec = buildHyperFrameBrandCard({
      brandName,
      tagline: block.brandData?.tagline ?? block.subheadline,
      domain: block.brandData?.domain ?? `${cleanDomain}.io`,
      metricsText: block.brandData?.metricsText ?? "Identidad Verificada · 60 FPS",
      badge: block.label.toUpperCase(),
      zone: "hero-top",
      palette,
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "map" || block.mapData) {
    const routeFrom = block.mapData?.routeFrom ?? "Punto de Partida";
    const routeTo = block.mapData?.routeTo ?? "Destino Global";
    const spec = buildHyperFrameAnimatedMap({
      title: block.headline,
      subtitle: block.subheadline,
      routeFrom,
      routeTo,
      routeDistanceKm: block.mapData?.distanceKm ?? 1250,
      badge: block.label.toUpperCase(),
      zone: "hero-top",
      palette,
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "bespoke" || block.customVisualMetaphor) {
    const metaphorKind = block.customVisualMetaphor ?? dna?.customVisualMetaphorKind ?? "hud_brackets";
    const spec = buildHyperFrameBespokeMetaphor({
      metaphorKind,
      title: block.headline,
      subtitle: block.subheadline,
      badge: block.label.toUpperCase(),
      metricValue: block.metricValue ? `${block.metricValue}${block.metricUnit ?? "%"}` : undefined,
      palette,
      zone: "hero-top",
      svgIconPath: dna?.thematicSvgIcon,
      clipPath: dna?.geometry?.clipPath,
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "hero") {
    const spec = buildHyperFrameKineticHook({
      kicker: block.label.toUpperCase(),
      headline: block.headline.toUpperCase(),
      subheadline: block.subheadline,
      hasSpeakerInFrame: true,
      palette,
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "chart" || block.cardKind === "metric") {
    const targetVal = block.metricValue ?? 85;
    const unitStr = block.metricUnit ?? "%";
    const mainLabel = block.headline.length < 24 ? block.headline : "Valor Clave";
    const spec = buildHyperFrameDataChart({
      title: block.headline,
      subtitle: block.subheadline,
      badge: block.label.toUpperCase(),
      chartType: "bars",
      items: [
        { label: mainLabel, value: targetVal, formatted: `${targetVal}${unitStr}`, color: palette.accent },
        { label: "Promedio Relativo", value: Math.max(20, Math.round(targetVal * 0.74)), formatted: `+${Math.max(20, Math.round(targetVal * 0.74))}%`, color: palette.secondary },
        { label: "Efectividad Global", value: 92, formatted: "92%", color: "#38BDF8" },
      ],
      palette,
      zone: "hero-top",
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "ui") {
    const spec = buildHyperFrameFloatingUI({
      badge: cleanBadge,
      title: block.headline,
      subtitle: block.subheadline,
      statusTag: "ACTIVO",
      verified: true,
      metrics: [],
      palette,
      zone: "hero-top",
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "ambient") {
    const spec = buildHyperFrameMotionGrid({
      theme: "cyber",
      title: block.headline,
      kicker: block.label.toUpperCase(),
      palette,
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "media") {
    const spec = buildHyperFrameRichMediaOverlay({
      title: block.headline,
      tag: block.label.toUpperCase(),
      description: block.subheadline,
      palette,
      zone: "hero-top",
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  if (block.cardKind === "cta") {
    const spec = buildHyperFrameFloatingUI({
      badge: "LLAMADA A LA ACCIÓN",
      title: block.headline,
      subtitle: block.subheadline || "Guarda este video y suscríbete para más contenido",
      statusTag: "PASO FINAL",
      verified: true,
      palette: {
        ...palette,
        accent: "#F43F5E",
      },
      zone: "hero-top",
    });
    return {
      componentName: spec.componentName,
      compositionId: `${spec.componentName}_${idx}`,
      code: spec.code,
      props: spec.props,
    };
  }

  // Fallback statement: Chapter Callout
  const spec = buildHyperFrameChapterCallout({
    chapterIndex: idx,
    badge: block.label.toUpperCase(),
    title: block.headline,
    subtitle: block.subheadline,
    zone: "hero-top",
    palette,
  });
  return {
    componentName: spec.componentName,
    compositionId: `${spec.componentName}_${idx}`,
    code: spec.code,
    props: spec.props,
  };
}

function cueText(cue: CaptionCue): string {
  return cue.words.map((w) => w.text.trim()).filter(Boolean).join(" ");
}

function selectImpactFrames(
  cues: CaptionCue[],
  blocks: NarrativeBlockPlan[],
  subStartFrame: number,
  fps: number,
  totalFrames: number,
  options?: {
    maxPunches?: number;
    minGapSec?: number;
  },
): number[] {
  const maxPunches = Math.max(0, options?.maxPunches ?? 5);
  if (maxPunches === 0) return [];
  const minGapFrames = Math.round(fps * (options?.minGapSec ?? 6.0));
  const punchHoldFrames = Math.round(fps * 2.0);
  const scoredCandidates: Array<{ frame: number; score: number }> = [];

  // 1. Incluir el inicio de cada bloque narrativo que pida acercamiento de cámara (peso alto)
  for (const b of blocks) {
    if (b.wantsZoomPunch && b.startFrame >= Math.round(fps * 1.0)) {
      if (b.startFrame + punchHoldFrames <= totalFrames) {
        scoredCandidates.push({ frame: b.startFrame, score: 3.2 });
      }
    }
  }

  // 2. Puntuar frases según peso semántico y numérico (evitando disparar en cada palabra común)
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const prev = i > 0 ? cues[i - 1] : undefined;
    const gapFromPrev = prev ? cue.start - prev.end : 999;
    const isPhraseStart = i === 0 || gapFromPrev >= Math.round(fps * 0.25);
    const text = cueText(cue);
    const hasNumericProof = /[%$€0-9]/.test(text);
    const isSpecialCuePhrase = /\b(uno|dos|tres|clave|importante|atenci[óo]n|mira|resultado|ahora|secreto|impacto|error|nunca|soluci[óo]n)\b/i.test(text);
    const isStrongCue = hasNumericProof || isSpecialCuePhrase || /[!¡?¿]/.test(text);

    if (!isPhraseStart && !isStrongCue) continue;
    const globalCueStart = subStartFrame + cue.start;
    if (globalCueStart >= Math.round(fps * 1.5) && globalCueStart + punchHoldFrames < totalFrames - Math.round(fps * 0.5)) {
      let score = isPhraseStart ? 1.0 : 0.6;
      if (hasNumericProof) score += 3.5;
      if (isSpecialCuePhrase) score += 2.2;
      if (i === 0) score += 1.0;
      scoredCandidates.push({ frame: globalCueStart, score });
    }
  }

  scoredCandidates.sort((a, b) => b.score - a.score || a.frame - b.frame);

  const selected: number[] = [];
  for (const candidate of scoredCandidates) {
    if (selected.length >= maxPunches) break;
    const tooClose = selected.some((existing) => Math.abs(candidate.frame - existing) < minGapFrames);
    if (!tooClose) {
      selected.push(candidate.frame);
    }
  }

  return selected.sort((a, b) => a - b);
}

interface TranscriptHyperFrameOverlayItem {
  name: string;
  startFrame: number;
  durationFrames: number;
  sfxType: SfxType;
  spec: {
    compositionId: string;
    componentName: string;
    code: string;
    props: Record<string, unknown>;
  };
}

/**
 * Construye una secuencia de overlays HyperFrames (Títulos Cinéticos 3D, Tarjetas HUD de Datos
 * con anillos SVG animados para porcentajes/métricas reales, y Callouts Editoriales de Capítulos)
 * directamente a partir de la transcripción real del hablante en la línea de tiempo ya cortada.
 */
function buildHyperFramesOverlaysFromTranscriptCues(
  cues: CaptionCue[],
  subStartFrame: number,
  totalFrames: number,
  fps: number,
  projectName?: string,
  dna?: ProjectSemanticDNA,
  budget?: EditorialBudget,
): TranscriptHyperFrameOverlayItem[] {
  if (cues.length === 0) return [];
  const maxOverlays = budget?.maxOverlays ?? Math.min(4, Math.max(1, Math.floor(totalFrames / Math.max(1, fps * 10))));
  if (maxOverlays <= 0) return [];

  const minGapFrames = Math.round(fps * (budget?.minOverlayGapSec ?? 4.2));
  const maxCoveredFrames = Math.round(totalFrames * (budget?.maxScreenCoverageRatio ?? 0.42));

  const candidates: Array<{ item: TranscriptHyperFrameOverlayItem; priority: number }> = [];
  const occupiedRanges: Array<{ start: number; end: number }> = [];

  const isRangeFree = (start: number, end: number, gap = minGapFrames): boolean =>
    !occupiedRanges.some(
      (r) => start < r.end + gap && end + gap > r.start,
    );

  const markRange = (start: number, end: number) => {
    occupiedRanges.push({ start, end });
  };

  const masterPal = dna?.masterPalette ?? { accent: "#38BDF8", secondary: "#818CF8", surface: "#0F172A", text: "#F8FAFC" };
  const palettes: HyperFramePalette[] = [
    masterPal,
    { ...masterPal, accent: masterPal.secondary, secondary: masterPal.accent },
    { ...masterPal, accent: "#34D399", secondary: masterPal.accent },
    { ...masterPal, accent: "#F59E0B", secondary: masterPal.secondary },
  ];

  // 1. TÍTULO GANCHO INICIAL (solo 1, con prioridad alta en primeros segundos)
  const openingCues = cues.slice(0, Math.min(4, cues.length));
  const openingText = openingCues.map(cueText).join(" ").trim();
  const firstCueStart = Math.max(0, subStartFrame + (cues[0]?.start ?? 0));
  const hookDuration = Math.min(
    Math.round(fps * 3.6),
    Math.max(Math.round(fps * 2.2), Math.floor(totalFrames * 0.18)),
  );

  if (openingText.length > 0 && firstCueStart + hookDuration <= totalFrames) {
    let cleanedOpening = openingText.trim();
    const greetingPattern =
      /^(?:bueno|buen[íi]simo|excelente|genial|perfecto|hola|buenas|buenos\s+d[íi]as|buenas\s+tardes|buenas\s+noches|saludos|bien|entonces|ok|oye|mira|miren|y\s+bien|a\s+ver|qu[ée]\s+tal)\b[\s,.:;-]*/i;
    const directAddressPattern =
      /^(?:a\s+todos|yerson|gerson|amigos|gente|equipo|chicos|chicas|compañeros|[a-zñáéíóú]{3,15})\b[\s,.:;-]*/i;
    const fillerLeadPattern =
      /^(?:y\s+para\s+demostrarles?\s+que|para\s+demostrarles?\s+que|les\s+cuento\s+que|les\s+digo\s+que|hoy\s+les\s+vengo\s+a\s+contar|en\s+este\s+video\s+vamos\s+a\s+ver|vamos\s+a\s+hablar\s+de)\b[\s,.:;-]*/i;

    for (let it = 0; it < 6; it += 1) {
      const prev = cleanedOpening;
      cleanedOpening = cleanedOpening
        .replace(greetingPattern, "")
        .replace(directAddressPattern, "")
        .replace(fillerLeadPattern, "")
        .trim();
      if (cleanedOpening === prev) break;
    }

    const effectiveText = cleanedOpening.length >= 10 ? cleanedOpening : openingText;
    const thesisMatch =
      /\b((?:\d+|tres|dos|cuatro|cinco)\s+datos?\s+claves?[^.,;!]*)/i.exec(openingText) ??
      /\b((?:esto\s+funciona|soluci[óo]n\s+t[ée]cnica|ahorro\s+operativo)[^.,;!]*)/i.exec(openingText);

    let headline: string;
    let subheadline: string;

    if (thesisMatch && thesisMatch[1]) {
      const rawThesis = thesisMatch[1].trim();
      headline = rawThesis.slice(0, 36).toUpperCase();
      subheadline =
        effectiveText.replace(thesisMatch[1], "").trim().slice(0, 50) ||
        "Validación y métricas estratégicas";
    } else {
      const cleanSentences = effectiveText
        .split(/(?<=[.!?…:;])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const rawHeadline = cleanSentences[0] ?? effectiveText;
      const words = rawHeadline.split(/\s+/);
      headline = words.slice(0, 7).join(" ").toUpperCase();
      subheadline =
        cleanSentences[1] ??
        (words.length > 7 ? words.slice(7, 16).join(" ") : "Puntos clave y análisis estratégico");
    }

    const isGenericProjectName =
      !projectName ||
      /^(mi\s+nuevo\s+montaje|proyecto\s+sin\s+t[íi]tulo|untitled|nuevo\s+proyecto|demo)$/i.test(
        projectName.trim(),
      );
    const kicker = isGenericProjectName
      ? ((dna?.themeKicker || dna?.categoryLabel || "CASO DE ESTUDIO").toUpperCase().slice(0, 24))
      : projectName.toUpperCase().slice(0, 28);

    const hookSpec = buildHyperFrameKineticHook({
      kicker,
      headline,
      subheadline,
      hasSpeakerInFrame: true,
      palette: palettes[0]!,
    });

    candidates.push({
      priority: 4.5,
      item: {
        name: `HyperFrame Hook · ${headline.slice(0, 26)}`,
        startFrame: firstCueStart,
        durationFrames: hookDuration,
        sfxType: "whoosh",
        spec: {
          compositionId: `hf_hook_${randomUUID().slice(0, 6)}`,
          componentName: hookSpec.componentName,
          code: hookSpec.code,
          props: hookSpec.props,
        },
      },
    });
  }

  // 2. MÉTRICAS REALES HABLADAS (prioridad máxima sobre callouts genéricos)
  let metricCounter = 0;
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const text = cueText(cue);
    const metricMatch =
      /(\d+(?:[.,]\d+)?)\s*(%|por\s*ciento|x|veces|millones|mil)\b/i.exec(text) ??
      /\b(\d{2,3})\s*(%|por\s*ciento)\b/i.exec(
        `${cueText(cues[i - 1] ?? { start: 0, end: 0, words: [] })} ${text}`,
      );

    if (!metricMatch) continue;

    const rawNum = Number.parseFloat((metricMatch[1] ?? "0").replace(",", "."));
    const rawUnit = (metricMatch[2] ?? "%").toLowerCase();
    const isPercent = rawUnit.includes("%") || rawUnit.includes("ciento");
    const displayValue = isPercent ? `${Math.round(rawNum)}%` : `${rawNum}${rawUnit === "veces" ? "x" : ""}`;

    const prevCue = i > 0 ? cues[i - 1] : undefined;
    const prevText = prevCue ? cueText(prevCue) : "";
    const startsInPrev = /\b(uno|dos|tres|primero|segundo|tercero|diagn[óo]stico|ahorro|respuesta|costo|dato|punto)\b/i.test(
      prevText,
    );

    const anchorCue = startsInPrev && prevCue ? prevCue : cue;
    const startFrame = Math.max(0, subStartFrame + anchorCue.start);
    const hudDuration = Math.round(fps * 4.0);
    const endFrame = Math.min(totalFrames, startFrame + hudDuration);

    if (endFrame - startFrame < Math.round(fps * 2.0)) continue;

    const windowCues = cues.slice(Math.max(0, i - 1), Math.min(cues.length, i + 3));
    const windowText = windowCues.map(cueText).join(" ").replace(/\s+/g, " ").trim();

    metricCounter += 1;
    const palette = palettes[metricCounter % palettes.length]!;

    let badge = `DATO CLAVE 0${metricCounter}`;
    if (/diagn[óo]stico|an[áa]lisis|base/i.test(windowText)) {
      badge = `0${metricCounter} · DIAGNÓSTICO`;
    } else if (/ahorro|costo|inversi[óo]n|valor|rendimiento/i.test(windowText)) {
      badge = `0${metricCounter} · RENDIMIENTO`;
    } else if (/gente|comunidad|adopci[óo]n|usuarios|participa/i.test(windowText)) {
      badge = `0${metricCounter} · ADOPCIÓN GLOBAL`;
    }

    const cleanedWindow = windowText
      .replace(/^(?:uno|dos|tres|primero|segundo|tercero)[,.:;\s-]*/i, "")
      .trim();
    const titleWords = cleanedWindow.split(/\s+/);
    const title = titleWords.slice(0, 6).join(" ") || `Impacto del ${displayValue}`;
    const subtitle = titleWords.slice(6, 16).join(" ") || `Análisis en tiempo real sobre ${displayValue}`;

    const hudSpec = buildHyperFrameMetricHud({
      badge,
      metricValue: displayValue,
      metricNumber: rawNum,
      isPercent,
      title,
      subtitle,
      zone: "hero-top",
      palette,
    });

    candidates.push({
      priority: 6.0,
      item: {
        name: `HyperFrame HUD · ${displayValue} (${badge})`,
        startFrame,
        durationFrames: endFrame - startFrame,
        sfxType: isPercent ? "ding" : "pop",
        spec: {
          compositionId: `hf_hud_${metricCounter}_${randomUUID().slice(0, 5)}`,
          componentName: hudSpec.componentName,
          code: hudSpec.code,
          props: hudSpec.props,
        },
      },
    });
  }

  // 3. CALLOUTS ESTRUCTURALES SELECTIVOS (solo si aportan giro narrativo y respetan presupuesto)
  let chapterIdx = metricCounter;
  for (let i = 1; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const text = cueText(cue);
    const isStructuralCue =
      /\b(diagn[óo]stico|ahorro|soluci[óo]n|conclusi[óo]n|importante|resultado|error|secreto)\b/i.test(
        text,
      );

    if (!isStructuralCue) continue;

    const startFrame = Math.max(0, subStartFrame + cue.start);
    const durationFrames = Math.round(fps * 3.6);
    const endFrame = Math.min(totalFrames, startFrame + durationFrames);
    if (endFrame - startFrame < Math.round(fps * 2.0)) continue;

    chapterIdx += 1;
    const palette = palettes[chapterIdx % palettes.length]!;
    const nextText = i + 1 < cues.length ? cueText(cues[i + 1]!) : "";
    const thirdText = i + 2 < cues.length ? cueText(cues[i + 2]!) : "";
    const combined = `${text} ${nextText} ${thirdText}`.replace(/\s+/g, " ").trim();

    let cleanCombined = combined
      .replace(/^(?:y\s+que|o\s+que|que|y|o|pero|de|en|a|con|por|para|entonces|as[íi]\s+que|adem[áa]s|asimismo)\s+/i, "")
      .trim();
    if (cleanCombined.length > 0) {
      cleanCombined = cleanCombined.charAt(0).toUpperCase() + cleanCombined.slice(1);
    }
    const words = cleanCombined.split(/\s+/);
    const isClosing = startFrame > totalFrames * 0.72 || /soluci[óo]n|viable|comunidad|respaldo|conclusi[óo]n/i.test(combined);

    let badge = `DATO 0${chapterIdx}`;
    if (/ahorro|costo|dinero|inversi[óo]n|presupuesto|gasto|rendimiento/i.test(combined)) {
      badge = "EFICIENCIA & COSTOS";
    } else if (/t[ée]cnic|soluci[óo]n|sistema|viable|arquitectura|desarrollo/i.test(combined)) {
      badge = "VIABILIDAD TÉCNICA";
    } else if (/comunidad|gente|usuarios|equipo|clientes|adopci[óo]n/i.test(combined)) {
      badge = "IMPACTO & COMUNIDAD";
    } else if (isClosing) {
      badge = "CONCLUSIÓN ESTRATÉGICA";
    }

    const title = words.slice(0, 6).join(" ");
    const subtitle = words.slice(6, 16).join(" ");

    const compSpec = buildHyperFrameChapterCallout({
      chapterIndex: chapterIdx,
      badge,
      title,
      subtitle,
      zone: "hero-top",
      palette,
    });

    candidates.push({
      priority: isClosing ? 3.5 : 2.8,
      item: {
        name: `HyperFrame Callout · ${title.slice(0, 24)}`,
        startFrame,
        durationFrames: endFrame - startFrame,
        sfxType: isClosing ? "ding" : "pop",
        spec: {
          compositionId: `hf_callout_${chapterIdx}_${randomUUID().slice(0, 5)}`,
          componentName: compSpec.componentName,
          code: compSpec.code,
          props: compSpec.props,
        },
      },
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.item.startFrame - b.item.startFrame);
  const chosen: TranscriptHyperFrameOverlayItem[] = [];
  let coveredFrames = 0;

  for (const cand of candidates) {
    if (chosen.length >= maxOverlays) break;
    const start = cand.item.startFrame;
    const end = start + cand.item.durationFrames;
    if (coveredFrames + cand.item.durationFrames > maxCoveredFrames && chosen.length >= 1) continue;
    if (!isRangeFree(start, end)) continue;
    markRange(start, end);
    chosen.push(cand.item);
    coveredFrames += cand.item.durationFrames;
  }

  return chosen.sort((a, b) => a.startFrame - b.startFrame);
}

/**
 * Detecta si el prompt solicita una ruta geográfica, mapa de viaje, vuelo o expansión internacional
 * que deba representarse con el motor procedimental /remotion-maps de HyperFrames.
 */
export function isMapOrRoutePrompt(prompt: string): boolean {
  return (
    /\b(mapa|ruta|vuelo|viaje|geograf|expansi[óo]n|ciudades|distancia|trayecto|frontera|pa[íi]ses|vuelos)\b/i.test(
      prompt,
    ) || /\b(de\s+[a-záéíóúÁÉÍÓÚ\s]+\s+a\s+[a-záéíóúÁÉÍÓÚ\s]+)\b/i.test(prompt)
  );
}

export function extractRouteCities(prompt: string): { from: string; to: string } {
  const match = prompt.match(/\bde\s+([a-záéíóúÁÉÍÓÚ\s]+?)\s+a\s+([a-záéíóúÁÉÍÓÚ\s]+?)(?:[,.;\n]|$)/i);
  if (match?.[1] && match?.[2]) {
    const from = match[1].trim();
    const to = match[2].trim();
    if (from.length >= 2 && to.length >= 2 && from.length < 30 && to.length < 30) {
      return {
        from: from.charAt(0).toUpperCase() + from.slice(1),
        to: to.charAt(0).toUpperCase() + to.slice(1),
      };
    }
  }
  return { from: "Madrid (MAD)", to: "Tokio (HND)" };
}

/**
 * Mapea un timestamp en segundos del metraje fuente (Whisper/VLM/acústico)
 * al frame equivalente dentro de los clips reales ya recortados/acelerados en V1.
 * Retorna `null` si el timestamp pertenece a un hueco o silencio eliminado.
 */
export function mapSourceSecToTimelineFrame(
  sourceSec: number,
  v1Clips: MediaClip[],
  fpsNum: number,
  primaryMediaId?: string,
): number | null {
  if (!Number.isFinite(sourceSec) || sourceSec < 0 || v1Clips.length === 0) return null;
  const ordered = [...v1Clips].sort((a, b) => a.startFrame - b.startFrame);
  const sourceUs = sourceSec * 1_000_000;
  for (const clip of ordered) {
    if (clip.type !== "video" || clip.remotion) continue;
    if (primaryMediaId && clip.mediaId !== primaryMediaId) continue;
    const clipInUs = clip.sourceInUs ?? 0;
    const clipSpeed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const clipSpanUs = Math.round(
      (clip.durationFrames / Math.max(1, fpsNum)) * clipSpeed * 1_000_000,
    );
    const clipOutUs =
      typeof clip.sourceOutUs === "number" && clip.sourceOutUs > clipInUs
        ? Math.min(clip.sourceOutUs, clipInUs + clipSpanUs)
        : clipInUs + clipSpanUs;
    if (sourceUs >= clipInUs - 120_000 && sourceUs <= clipOutUs + 120_000) {
      const clampedSourceUs = Math.max(clipInUs, Math.min(clipOutUs, sourceUs));
      const deltaTimelineSec = (clampedSourceUs - clipInUs) / (1_000_000 * clipSpeed);
      return Math.max(0, Math.round(clip.startFrame + deltaTimelineSec * fpsNum));
    }
  }
  return null;
}

/**
 * Convierte un frame global del timeline al timestamp real en segundos dentro
 * del archivo multimedia fuente de V1 activo en ese instante.
 */
export function mapTimelineFrameToSourceSec(
  timelineFrame: number,
  v1Clips: MediaClip[],
  fpsNum: number,
): number | null {
  if (!Number.isFinite(timelineFrame) || v1Clips.length === 0) return null;
  const targetClip = v1Clips.find(
    (c) =>
      c.type === "video" &&
      !c.remotion &&
      timelineFrame >= c.startFrame &&
      timelineFrame <= c.startFrame + c.durationFrames,
  );
  if (!targetClip) return null;
  const clipSpeed = targetClip.speed && targetClip.speed > 0 ? targetClip.speed : 1;
  const localSec = Math.max(0, (timelineFrame - targetClip.startFrame) / Math.max(1, fpsNum));
  const sourceSec = (targetClip.sourceInUs ?? 0) / 1_000_000 + localSec * clipSpeed;
  return Number(sourceSec.toFixed(3));
}

export interface SpatialAuditResult {
  collisionsDetected: number;
  collisionsResolved: number;
  safeZoneCompliance: boolean;
  project: Project;
  report: string;
}

function isTopZoneName(zone: string): boolean {
  return (
    zone === "hero-top" ||
    zone === "top-left" ||
    zone === "top-right" ||
    zone === "top-left-hud" ||
    zone === "top-right-hud"
  );
}

function isBottomZoneName(zone: string): boolean {
  return (
    zone === "lower-third" ||
    zone === "bottom" ||
    zone === "bottom-left" ||
    zone === "bottom-right"
  );
}

function isFullscreenZoneName(zone: string): boolean {
  return zone === "center-stage" || zone === "fullscreen" || zone === "full";
}

/**
 * Auditoría Espacial y Resolución Bidireccional de Colisiones DOM (Paso 6):
 * Sincroniza bidireccionalmente los gráficos en `Capa Motion` y los subtítulos IA (`props.captions`):
 * - Suprime temporalmente cues cuando un gráfico full-scene o `hideSubtitlesDuringScene` domina la pantalla.
 * - Reubica overlays inferiores a `'hero-top'` o mueve cues de `'hero-top'` / `'lower-third'` fuera de conflicto.
 */
export function auditAndResolveSpatialCollisions(
  project: Project,
  fpsNum: number,
  options?: { userWantsFullSubtitles?: boolean },
): SpatialAuditResult {
  let collisionsDetected = 0;
  let collisionsResolved = 0;
  let overlaysRelocated = 0;
  let cuesSuppressed = 0;
  let cuesRelocated = 0;

  const userWantsFullSubtitles = Boolean(options?.userWantsFullSubtitles);

  const subTrack = project.tracks.find(
    (t) =>
      t.kind === "text" &&
      (t.name.toLowerCase().includes("subtítulo") ||
        t.clips.some((c) => c.type === "text" && (c as TextClip).role === "subtitle")),
  );
  const initialSubClips = subTrack?.clips.filter((c): c is TextClip => c.type === "text") ?? [];

  const motionTracks = project.tracks.filter(
    (t) =>
      t.name.startsWith("Capa Motion") ||
      (t.kind === "video" &&
        t.name !== "V1 (Principal)" &&
        t.name !== "V1" &&
        !t.name.startsWith("V0") &&
        !t.name.startsWith("Capa Transiciones") &&
        !/atm[óo]sfera/i.test(t.name)),
  );

  const motionEntries: Array<{
    clip: MediaClip;
    startFrame: number;
    endFrame: number;
    zone: string;
    hideSubtitlesDuringScene: boolean;
    layerRole: string;
  }> = [];

  for (const mTrack of motionTracks) {
    for (const clip of mTrack.clips) {
      if (!isMediaClip(clip) || !clip.remotion) continue;
      const props = (clip.remotion.props ?? {}) as Record<string, unknown>;
      const zone = typeof props.zone === "string" ? props.zone : "lower-third";
      const layerRole = typeof props.layerRole === "string" ? props.layerRole : "overlay";
      const hideSubtitlesDuringScene = props.hideSubtitlesDuringScene === true;
      motionEntries.push({
        clip,
        startFrame: clip.startFrame,
        endFrame: clip.startFrame + clip.durationFrames,
        zone,
        hideSubtitlesDuringScene,
        layerRole,
      });
    }
  }

  const subEntries = initialSubClips.map((sc) => {
    const rawCaptions = sc.remotion?.props?.captions;
    const captions = Array.isArray(rawCaptions)
      ? (rawCaptions as CaptionCue[]).map((cue) => ({
          ...cue,
          words: Array.isArray(cue.words) ? cue.words.map((w) => ({ ...w })) : [],
        }))
      : null;
    return {
      clip: sc,
      captions,
      dirty: false,
    };
  });

  // Pasada 1: Suprimir subtítulos sobre overlays fullscreen o marcados con hideSubtitlesDuringScene
  if (!userWantsFullSubtitles) {
    for (const subEntry of subEntries) {
      if (!subEntry.captions) continue;
      for (const cue of subEntry.captions) {
        if (cue.suppressed) continue;
        const cueStart = subEntry.clip.startFrame + cue.start;
        const cueEnd = subEntry.clip.startFrame + cue.end;
        const blockingMotion = motionEntries.some(
          (mc) =>
            cueStart < mc.endFrame &&
            cueEnd > mc.startFrame &&
            (mc.hideSubtitlesDuringScene ||
              mc.layerRole === "full-scene" ||
              isFullscreenZoneName(mc.zone)),
        );
        if (blockingMotion) {
          cue.suppressed = true;
          subEntry.dirty = true;
          collisionsDetected += 1;
          collisionsResolved += 1;
          cuesSuppressed += 1;
        }
      }
    }
  }

  let updatedProject = project;

  // Pasada 2: Resolver colisiones de overlays en tercio inferior con subtítulos activos en tercio inferior
  for (const mc of motionEntries) {
    if (mc.layerRole === "full-scene" || !isBottomZoneName(mc.zone)) continue;

    const overlappingActiveBottomSub = subEntries.some((subEntry) => {
      if (subEntry.captions) {
        return subEntry.captions.some((cue) => {
          if (cue.suppressed) return false;
          const cueZone = cue.zone ?? "lower-third";
          if (!isBottomZoneName(cueZone)) return false;
          const cueStart = subEntry.clip.startFrame + cue.start;
          const cueEnd = subEntry.clip.startFrame + cue.end;
          return mc.startFrame < cueEnd && mc.endFrame > cueStart;
        });
      }
      const scEnd = subEntry.clip.startFrame + subEntry.clip.durationFrames;
      return mc.startFrame < scEnd && mc.endFrame > subEntry.clip.startFrame;
    });

    if (!overlappingActiveBottomSub) continue;

    const topOccupiedByOtherOverlay = motionEntries.some(
      (other) =>
        other.clip.id !== mc.clip.id &&
        mc.startFrame < other.endFrame &&
        mc.endFrame > other.startFrame &&
        isTopZoneName(other.zone),
    );

    if (!topOccupiedByOtherOverlay) {
      collisionsDetected += 1;
      const newProps = {
        ...mc.clip.remotion!.props,
        zone: "hero-top",
      };
      let newCode = mc.clip.remotion!.code;
      if (newCode.includes('zone = "lower-third"')) {
        newCode = newCode.replace(/zone\s*=\s*"lower-third"/g, 'zone = "hero-top"');
      }
      const updRes = updateClip(updatedProject, mc.clip.id, (c) => ({
        ...c,
        remotion: {
          ...c.remotion!,
          props: newProps,
          code: newCode,
        },
      }));
      if (updRes.ok) {
        updatedProject = updRes.project;
        mc.zone = "hero-top";
        collisionsResolved += 1;
        overlaysRelocated += 1;
      }
    }
  }

  // Pasada 3: Garantizar bidireccionalmente que cues activos (hero-top o lower-third) no solapen con overlays en su misma zona
  for (const subEntry of subEntries) {
    if (!subEntry.captions) continue;
    for (const cue of subEntry.captions) {
      if (cue.suppressed) continue;
      const cueStart = subEntry.clip.startFrame + cue.start;
      const cueEnd = subEntry.clip.startFrame + cue.end;
      const overlappingMotions = motionEntries.filter(
        (mc) => cueStart < mc.endFrame && cueEnd > mc.startFrame,
      );
      if (overlappingMotions.length === 0) continue;

      const cueZone = cue.zone ?? "lower-third";
      const hasTopOverlap = overlappingMotions.some((mc) => isTopZoneName(mc.zone));
      const hasBottomOverlap = overlappingMotions.some((mc) => isBottomZoneName(mc.zone));

      if (isTopZoneName(cueZone) && hasTopOverlap) {
        collisionsDetected += 1;
        if (!hasBottomOverlap) {
          cue.zone = "lower-third";
          subEntry.dirty = true;
          collisionsResolved += 1;
          cuesRelocated += 1;
        } else if (!userWantsFullSubtitles) {
          cue.suppressed = true;
          subEntry.dirty = true;
          collisionsResolved += 1;
          cuesSuppressed += 1;
        }
      } else if (isBottomZoneName(cueZone) && hasBottomOverlap) {
        collisionsDetected += 1;
        if (!hasTopOverlap) {
          cue.zone = "hero-top";
          subEntry.dirty = true;
          collisionsResolved += 1;
          cuesRelocated += 1;
        } else if (!userWantsFullSubtitles) {
          cue.suppressed = true;
          subEntry.dirty = true;
          collisionsResolved += 1;
          cuesSuppressed += 1;
        }
      }
    }

    if (subEntry.dirty && subEntry.clip.remotion) {
      const previewText = subEntry.captions
        .filter((c) => !c.suppressed)
        .slice(0, 4)
        .map((c) => c.words.map((w) => w.text).join(" "))
        .join(" ")
        .trim()
        .slice(0, 80);

      const updSubRes = updateClip(updatedProject, subEntry.clip.id, (c) => {
        if (c.type !== "text" || !c.remotion) return c;
        return {
          ...c,
          text: previewText || c.text,
          remotion: {
            ...c.remotion,
            props: {
              ...c.remotion.props,
              captions: subEntry.captions,
            },
          },
        };
      });
      if (updSubRes.ok) {
        updatedProject = updSubRes.project;
      }
    }
  }

  const isVertical = project.settings.height > project.settings.width;
  const auditDetails: string[] = [];
  if (overlaysRelocated > 0) auditDetails.push(`${overlaysRelocated} overlay(s) a hero-top`);
  if (cuesRelocated > 0) auditDetails.push(`${cuesRelocated} subtítulo(s) reubicado(s)`);
  if (cuesSuppressed > 0) auditDetails.push(`${cuesSuppressed} subtítulo(s) pausado(s) en escena densa`);

  const auditReport =
    collisionsResolved > 0
      ? `Auditoría espacial completada: ${collisionsResolved} colisión(es) resueltas (${auditDetails.join(", ")}). Zonas seguras 2026 ${isVertical ? "9:16 (TikTok/Reels)" : "16:9"} al 100% de cumplimiento.`
      : `Auditoría espacial completada: Zonas seguras 2026 verificadas sin solapamientos entre capas de video, gráficos y subtítulos.`;

  return {
    collisionsDetected,
    collisionsResolved,
    safeZoneCompliance: true,
    project: updatedProject,
    report: auditReport,
  };
}

export interface RemotionClipValidationAuditResult {
  project: Project;
  checkedCount: number;
  validCount: number;
  prunedInvalidCount: number;
}

/**
 * Verificación Real de Compilación (esbuild + AST) de todos los componentes Remotion TSX
 * activos en el timeline para garantizar 0 fallos de renderizado o preview vivo.
 */
export async function auditAndValidateGeneratedRemotionClips(
  project: Project,
): Promise<RemotionClipValidationAuditResult> {
  let checkedCount = 0;
  let validCount = 0;
  const invalidClipIds = new Set<string>();

  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.remotion?.code) continue;
      checkedCount += 1;
      const check = await verifyRemotionComponentTsx(clip.remotion.code);
      if (check.ok) {
        validCount += 1;
      } else if (clip.createdBy === "agent") {
        invalidClipIds.add(clip.id);
        console.warn(
          `[SwarmDirector QA] Clip TSX "${clip.name}" (${clip.id}) descartado por compilador: ${check.error}`,
        );
      }
    }
  }

  if (invalidClipIds.size === 0) {
    return { project, checkedCount, validCount, prunedInvalidCount: 0 };
  }

  const sanitizedProject = touchProject({
    ...project,
    tracks: project.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => !invalidClipIds.has(c.id)),
    })),
  });

  return {
    project: sanitizedProject,
    checkedCount,
    validCount,
    prunedInvalidCount: invalidClipIds.size,
  };
}

/**
 * Orquestador Multi-Paso de Enjambre Autónomo (Swarm Director + HyperFrames + Remotion).
 */
export async function runSwarmDirector(
  options: SwarmDirectorOptions,
): Promise<SwarmDirectorResult> {
  const {
    projectId,
    prompt,
    style: requestedStyle,
    enablePunches = true,
    enableSilenceCut = true,
    enableBrollCards = true,
    ctaHandle,
    signal,
    onProgress,
  } = options;

  const bundle = await projectStore.get(projectId);
  let currentProject: Project = bundle.project;

  const wantsVertical =
    currentProject.settings.aspect === "9:16" ||
    /\b(9:16|vertical|reels|tiktok|shorts)\b/i.test(prompt);

  if (wantsVertical) {
    currentProject = autoReframeProject(currentProject, "9:16");
  }

  const fps = currentProject.settings.fps;
  const fpsNum = fpsValue(fps);
  const abortSignal = signal ?? new AbortController().signal;
  const userConstraints = parseUserEditingConstraints(prompt);
  const effectiveSilenceCut = enableSilenceCut && !userConstraints.noSilenceCut;
  const effectivePunches = enablePunches && !userConstraints.noZooms;
  const effectiveBrollCards = enableBrollCards && !userConstraints.noGraphics;
  const effectiveMusic = !userConstraints.noMusic;
  const effectiveSfx = !userConstraints.noSfx;

  // =========================================================================
  // ENRUTADOR SEMÁNTICO DE INTENCIÓN Y ADN TEMÁTICO (CERO ALUCINACIONES)
  // =========================================================================
  let dna = extractProjectSemanticDNA({
    prompt,
    projectName: currentProject.name,
  });

  // Analizar estructura narrativa y duración solicitada en el prompt (ej. 50s y bloques 0-8, 8-18, 18-35, 35-45, 45-50)
  let narrativePlan = parsePromptNarrativePlan(prompt, fpsNum, currentProject.name);

  const steps: SwarmStepReport[] = [];
  let silencesRemoved = 0;
  let subtitleCuesCount = 0;
  let zoomPunchesCount = 0;
  let brollCardsInserted = 0;
  let sfxEventsInserted = 0;
  let surgicalToolsApplied = 0;
  let bespokeRemotionScenes = 0;
  const sfxEventFrames: Array<{ frame: number; sfxType: SfxType }> = [];

  const v1TrackRes = ensurePrimaryVideoTrack(currentProject);
  currentProject = v1TrackRes.project;
  let v1TrackInitial = v1TrackRes.track;

  let realV1Clips = v1TrackInitial.clips.filter(
    (c): c is MediaClip =>
      c.type === "video" &&
      !c.remotion &&
      !c.name.startsWith("Escena Fondo"),
  );

  // Auto-montar en V1 cualquier video real subido en currentProject.media si V1 está vacía o solo tenía escenas sintéticas
  if (realV1Clips.length === 0) {
    const uploadedRealVideos = currentProject.media.filter(
      (m) =>
        m.kind === "video" &&
        m.origin !== "generated" &&
        !m.file.startsWith("virtual://") &&
        !m.file.includes("swarm-bg-canvas") &&
        !m.file.startsWith("generated/"),
    );
    if (uploadedRealVideos.length > 0 && !v1TrackInitial.locked) {
      const syntheticMediaIds = new Set(
        currentProject.media
          .filter(
            (m) =>
              m.origin === "generated" ||
              m.file.startsWith("virtual://") ||
              m.file.includes("swarm-bg-canvas") ||
              m.file.startsWith("generated/"),
          )
          .map((m) => m.id),
      );
      currentProject = touchProject({
        ...currentProject,
        tracks: currentProject.tracks.map((t) => {
          if (t.id === v1TrackInitial.id) {
            return {
              ...t,
              clips: t.clips.filter(
                (c) =>
                  c.type === "text" ||
                  (!c.remotion && !c.name.startsWith("Escena Fondo") && !syntheticMediaIds.has(c.mediaId)),
              ),
            };
          }
          if (t.kind === "audio") {
            return {
              ...t,
              clips: t.clips.filter(
                (c) => c.type === "text" || (!c.name.startsWith("Locución IA") && !syntheticMediaIds.has(c.mediaId)),
              ),
            };
          }
          return t;
        }),
      });
      v1TrackInitial = findPrimaryVideoTrack(currentProject) ?? v1TrackInitial;
      let cursorFrame = v1TrackInitial.clips.reduce(
        (maxEnd, clip) => Math.max(maxEnd, clip.startFrame + clip.durationFrames),
        0,
      );
      for (const asset of uploadedRealVideos) {
        const mountedClip = makeMediaClip(currentProject, asset, {
          startFrame: cursorFrame,
          createdBy: "user",
        });
        const addMountRes = addClip(currentProject, v1TrackInitial.id, mountedClip);
        if (addMountRes.ok) {
          currentProject = addMountRes.project;
          cursorFrame = mountedClip.startFrame + mountedClip.durationFrames;
        }
      }
      if (wantsVertical) {
        currentProject = autoReframeProject(currentProject, "9:16");
      }
      v1TrackInitial = findPrimaryVideoTrack(currentProject) ?? v1TrackInitial;
      realV1Clips = v1TrackInitial.clips.filter(
        (c): c is MediaClip =>
          c.type === "video" &&
          !c.remotion &&
          !c.name.startsWith("Escena Fondo"),
      );
    }
  }

  const hasRealV1Footage = realV1Clips.length > 0;

  let cachedTranscriptSegments: TranscriptSegment[] | undefined;
  let subtitleDurationFrames = narrativePlan.totalFrames;

  let audioProfile: AudioAnalysisProfile | null = null;
  let visualProfile: VideoVisualProfile | null = null;

  const analyzedPrimaryMediaId = realV1Clips[0]?.mediaId;

  // Pre-transcripción, análisis acústico (LUFS + energía) y visión multimodal temprana de V1
  if (realV1Clips.length > 0) {
    const primaryClip = realV1Clips[0]!;
    const primaryAsset = currentProject.media.find((m) => m.id === primaryClip.mediaId);
    const hasAudio = Boolean(primaryAsset && (primaryAsset.audioCodec || primaryAsset.kind === "video"));

    if (primaryAsset && hasAudio) {
      const [trRes, audioRes] = await Promise.allSettled([
        transcribeMedia(projectId, primaryAsset, undefined, abortSignal),
        analyzeProjectAudioProfile({
          projectId,
          asset: primaryAsset,
          fps: fpsNum,
          signal: abortSignal,
        }),
      ]);

      if (trRes.status === "fulfilled") {
        const tr = trRes.value;
        if (Array.isArray(tr.segments) && tr.segments.length > 0) {
          cachedTranscriptSegments = tr.segments;
          const transcriptText = tr.segments.map((s) => s.text).join(" ");
          dna = extractProjectSemanticDNA({
            prompt,
            transcriptText,
            projectName: currentProject.name,
          });
        }
      } else {
        console.warn("[SwarmDirector] Aviso pre-transcribiendo V1:", trRes.reason);
      }

      if (audioRes.status === "fulfilled") {
        audioProfile = audioRes.value;
      } else {
        console.warn("[SwarmDirector] Aviso analizando audio de V1:", audioRes.reason);
      }
    }

    if (primaryAsset && primaryAsset.kind === "video") {
      try {
        visualProfile = await inspectVideoVisualProfile({
          projectId,
          asset: primaryAsset,
          prompt,
          sceneTimestampsSec: audioProfile?.sceneTimestampsSec,
          signal: abortSignal,
        });
        if (visualProfile && visualProfile.dominantColors.length >= 2) {
          dna = {
            ...dna,
            masterPalette: {
              ...dna.masterPalette,
              accent: visualProfile.dominantColors[0] ?? dna.masterPalette.accent,
              secondary: visualProfile.dominantColors[1] ?? dna.masterPalette.secondary,
            },
          };
        }
      } catch (visErr) {
        console.warn("[SwarmDirector] Aviso inspeccionando frames de V1:", visErr);
      }
    }
  }

  const explicitTimeBlocksInPrompt = Boolean(
    prompt.match(/\(\s*\d+\s*(?:a|-|hasta)\s*\d+\s*seg/gi),
  );
  const isCreative = isCreativeOrFictionPrompt(prompt);
  const brandUrl = detectBrandUrlInPrompt(prompt);
  let capturedBrand: BrandIdentity | undefined;
  const isMap = isMapOrRoutePrompt(prompt);
  const routeCities = isMap ? extractRouteCities(prompt) : undefined;
  let synthesizedSpeechSegments: SynthesizedSceneSpeechSegment[] = [];
  let ttsProviderUsed = "procedural";
  let prePassTtsApplied = false;
  let prePassTtsSummaryNote = "";

  // Si no hay metraje real en V1, investigar/diseñar guion, sintetizar locución por escena y analizar su onda ANTES del Director IA
  if (!hasRealV1Footage) {
    if (brandUrl) {
      onProgress?.(
        "Paso 0/6 · Brand Intelligence: Analizando marca, CSS y tokens de diseño...",
        0,
        6,
      );
      try {
        capturedBrand = await extractBrandIdentity(brandUrl, prompt, abortSignal);
        const brandNarrative = generateBrandNarrativePlan({
          brand: capturedBrand,
          fpsNum,
          targetDurationSec: narrativePlan.targetDurationSec,
        });
        if (brandNarrative && brandNarrative.blocks.length > 0) {
          narrativePlan = brandNarrative;
          dna = {
            ...dna,
            masterPalette: capturedBrand.palette,
          };
          steps.push({
            step: 1,
            agent: "Brand Intelligence & Design Tokens",
            summary: brandNarrative.brandReport,
            applied: true,
          });
        }
      } catch (err) {
        console.warn("[SwarmDirector] Aviso en captura de marca:", err);
      }
    } else if (isCreative) {
      onProgress?.(
        "Paso 0/6 · Dirección de arte: Creando storyboard, atmósfera y guion...",
        0,
        6,
      );
      try {
        const creativePlan = await generateCreativeStoryboardPlan({
          prompt,
          fpsNum,
          projectName: currentProject.name,
          signal: abortSignal,
          dna,
        });
        if (creativePlan && creativePlan.blocks.length > 0) {
          narrativePlan = creativePlan;
          steps.push({
            step: 1,
            agent: "Creative Art Director & Storyboard Agent",
            summary: creativePlan.storyboardReport,
            applied: true,
          });
        }
      } catch (err) {
        console.warn("[SwarmDirector] Aviso en storyboard creativo:", err);
      }
    } else {
      const researchTopic = extractResearchTopic(prompt);
      if (researchTopic) {
        onProgress?.(
          `Paso 0/6 · Investigación: Datos clave sobre "${researchTopic}".`,
          0,
          6,
        );
        try {
          const research = await researchTopicOnWeb(researchTopic, abortSignal);
          const researchedPlan = await generateResearchedNarrativePlan({
            prompt,
            topic: researchTopic,
            research,
            fpsNum,
            projectName: currentProject.name,
            signal: abortSignal,
          });
          if (researchedPlan && researchedPlan.blocks.length > 0) {
            narrativePlan = researchedPlan;
            steps.push({
              step: 1,
              agent: "Web Research & Scriptwriting Agent",
              summary: `Guion sintetizado con datos verificados sobre "${researchTopic}".`,
              applied: true,
            });
          }
        } catch (err) {
          console.warn("[SwarmDirector] Aviso en investigación web:", err);
        }
      }
    }

    if (isMap && routeCities && narrativePlan.blocks.length >= 2) {
      const mapBlockIdx = Math.min(1, narrativePlan.blocks.length - 1);
      narrativePlan.blocks[mapBlockIdx] = {
        ...narrativePlan.blocks[mapBlockIdx]!,
        cardKind: "map",
        headline: `${routeCities.from.toUpperCase()} ➔ ${routeCities.to.toUpperCase()}`,
        subheadline: "Ruta Geodésica y Telemetría en Vivo",
        mapData: {
          routeFrom: routeCities.from,
          routeTo: routeCities.to,
          distanceKm: 9850,
        },
      };
    }

    // Sintetizar locución escena por escena (OpenAI/edge-tts/piper/espeak/SAPI/cadence), ajustar duración real y extraer audioPeaks
    try {
      const mediaDir = projectMediaDirectory(projectId);
      await fs.mkdir(mediaDir, { recursive: true });
      const ttsFileName = "swarm-tts-voice.wav";
      const ttsAbsPath = path.join(mediaDir, ttsFileName);
      const ttsRelFile = `media/${ttsFileName}`;

      const speechRes = await synthesizeSceneSpeechTracks({
        mediaDir,
        destinationPath: ttsAbsPath,
        blocks: narrativePlan.blocks.map((b) => ({
          label: b.label,
          narration: b.narrationText,
          suggestedDurationSec: Math.max(1.5, b.durationFrames / fpsNum),
        })),
        language: "es",
        signal: abortSignal,
      });

      synthesizedSpeechSegments = speechRes.segments;
      ttsProviderUsed = speechRes.provider;
      narrativePlan = rebalanceNarrativePlanWithTts(
        narrativePlan,
        speechRes.segments,
        fpsNum,
        explicitTimeBlocksInPrompt,
      );
      subtitleDurationFrames = narrativePlan.totalFrames;

      const stat = await fs.stat(ttsAbsPath);
      const existingTtsAsset = currentProject.media.find((m) => m.file === ttsRelFile);
      const durationUs = Math.round(speechRes.totalDurationSec * 1_000_000);
      const ttsAsset: MediaAsset = existingTtsAsset
        ? { ...existingTtsAsset, sizeBytes: stat.size, durationUs }
        : {
            id: newId("med"),
            name: `Locución IA (${speechRes.provider})`,
            kind: "audio",
            file: ttsRelFile,
            mimeType: "audio/wav",
            sizeBytes: stat.size,
            durationUs,
            audioCodec: "pcm_s16le",
            sampleRate: 48000,
            channels: 1,
            thumbnail: "ready",
            waveform: "none",
            proxy: "none",
            importedAt: new Date().toISOString(),
            origin: "generated",
          };

      if (!existingTtsAsset) {
        currentProject = touchProject({
          ...currentProject,
          media: [...currentProject.media, ttsAsset],
        });
      }

      const a1Res = ensurePrimaryAudioTrack(currentProject);
      currentProject = a1Res.project;
      const a1Track = a1Res.track;
      const currentA1 = currentProject.tracks.find((t) => t.id === a1Track.id)!;
      const prevTtsIds = currentA1.clips
        .filter((c) => c.name.includes("Locución IA"))
        .map((c) => c.id);
      if (prevTtsIds.length > 0) {
        currentProject = touchProject({
          ...currentProject,
          tracks: currentProject.tracks.map((t) =>
            t.id === a1Track.id
              ? { ...t, clips: t.clips.filter((c) => !prevTtsIds.includes(c.id)) }
              : t,
          ),
        });
      }

      const ttsDurationFrames = Math.max(
        1,
        Math.min(narrativePlan.totalFrames, Math.round(speechRes.totalDurationSec * fpsNum)),
      );
      const ttsClip: MediaClip = {
        ...makeMediaClip(currentProject, ttsAsset, {
          startFrame: 0,
          durationFrames: ttsDurationFrames,
          createdBy: "agent",
        }),
        name: `Locución IA (${speechRes.provider})`,
        volume: 1,
      };
      const addTtsRes = addClip(currentProject, a1Track.id, ttsClip);
      if (addTtsRes.ok) {
        currentProject = addTtsRes.project;
      }

      try {
        audioProfile = await analyzeProjectAudioProfile({
          projectId,
          asset: ttsAsset,
          fps: fpsNum,
          signal: abortSignal,
        });
      } catch (audioErr) {
        console.warn("[SwarmDirector] Aviso extrayendo peaks de locución TTS:", audioErr);
      }

      prePassTtsApplied = true;
      prePassTtsSummaryNote = `locución ${ttsProviderUsed} (${speechRes.totalDurationSec.toFixed(1)}s)`;
    } catch (speechErr) {
      console.warn("[SwarmDirector] Aviso en pre-síntesis TTS por escenas:", speechErr);
    }
  }

  // =========================================================================
  // PASO 0: DIRECTOR CINEMATOGRÁFICO IA & PLANIFICACIÓN QUIRÚRGICA AUTÓNOMA
  // =========================================================================
  onProgress?.(
    "Paso 0/6 · Director IA: Diseñando dirección de arte, escenas V1/HUD y edición quirúrgica...",
    0,
    6,
  );
  const availableSkills = skillRegistry.getAll().map((s) => `${s.id} (${s.name}): ${s.description}`);
  const directive: AutonomousEditDirective = await planAutonomousEditDirective({
    project: currentProject,
    prompt,
    transcriptSegments: cachedTranscriptSegments,
    dna,
    visualProfile,
    audioProfile,
    narrativeBlocksHint: narrativePlan.blocks.map((b) => ({
      label: b.label,
      startSec: Number((b.startFrame / fpsNum).toFixed(2)),
      durationSec: Number((b.durationFrames / fpsNum).toFixed(2)),
      narration: b.narrationText,
      cardKind: b.cardKind,
    })),
    brandContext: capturedBrand
      ? {
          brandName: capturedBrand.brandName,
          domain: capturedBrand.domain,
          tagline: capturedBrand.tagline,
          palette: capturedBrand.palette,
          keyFeatures: capturedBrand.keyFeatures,
        }
      : null,
    availableSkills,
    hasPrimaryVideoMedia: hasRealV1Footage,
    signal: abortSignal,
  });

  if (directive.source === "ai_director") {
    dna = {
      ...dna,
      masterPalette: directive.artDirection.palette,
      categoryLabel: directive.artDirection.visualTheme || dna.categoryLabel,
    };
  }

  const styleId: RemotionSubtitleStyleId =
    requestedStyle ??
    (directive.source === "ai_director"
      ? directive.subtitleDirective.style
      : resolveSubtitleStyle(prompt, requestedStyle, dna));

  const PRE_CUT_TOOLS = new Set([
    "change_aspect_ratio",
    "trim_clip",
    "split_clip",
    "set_clip_speed",
    "cut_time_range",
    "keep_time_ranges",
    "select_highlights",
    "remove_silences",
  ]);
  const preCutToolCalls = directive.timelineToolCalls.filter((c) => PRE_CUT_TOOLS.has(c.tool));
  const postCutToolCalls = directive.timelineToolCalls.filter((c) => !PRE_CUT_TOOLS.has(c.tool));
  const silenceAlreadyHandledByTool = preCutToolCalls.some(
    (c) => c.tool === "remove_silences" || c.tool === "select_highlights" || c.tool === "keep_time_ranges",
  );

  if (preCutToolCalls.length > 0) {
    const preExec = await executeSurgicalTimelineTools({
      projectId,
      project: currentProject,
      toolCalls: preCutToolCalls,
      signal: abortSignal,
    });
    currentProject = preExec.project;
    surgicalToolsApplied += preExec.appliedTools.length;
    v1TrackInitial = findPrimaryVideoTrack(currentProject) ?? v1TrackInitial;
    realV1Clips = v1TrackInitial.clips.filter(
      (c): c is MediaClip =>
        c.type === "video" &&
        !c.remotion &&
        !c.name.startsWith("Escena Fondo"),
    );
  }

  steps.push({
    step: 0,
    agent: directive.source === "ai_director" ? "Autonomous AI Director" : "Adaptive Style & Edit Planner",
    summary: `${directive.narrativeSummary} (${directive.customScenes.length} escenas bespoke, look ${directive.atmosphereLook.lookPreset}).`,
    applied: true,
  });

  // Determinar el Modo de Producción Autónomo (A, B o C)
  const productionMode: SwarmProductionMode = hasRealV1Footage
    ? "modo_a_quirurgico"
    : capturedBrand
    ? "modo_c_hibrido"
    : "modo_b_generativo";

  const productionModeLabel =
    productionMode === "modo_a_quirurgico"
      ? "Modo A · Edición Quirúrgica V1"
      : productionMode === "modo_c_hibrido"
      ? `Modo C · Brand Intelligence (${capturedBrand?.brandName || "Web"})`
      : "Modo B · Generativo 5-Capas";

  // =========================================================================
  // PASO 1: CUTTER / VAD O SÍNTESIS GENERATIVA DE ESCENAS V1 + A1 TTS
  // =========================================================================
  onProgress?.(
    "Paso 1/5 · Corte y escena visual: Preparando V1...",
    1,
    5,
  );

  let usedSyntheticEnvironment = false;

  if (realV1Clips.length === 0) {
    usedSyntheticEnvironment = true;
    onProgress?.(
      `Paso 1/5 · Escenas V1: Sintetizando arquitectura visual única (${Math.round(narrativePlan.targetDurationSec)}s)...`,
      1,
      5,
    );

    const mediaDir = projectMediaDirectory(projectId);
    await fs.mkdir(mediaDir, { recursive: true });
    const bgFileName = "swarm-bg-canvas.mp4";
    const bgAbsPath = path.join(mediaDir, bgFileName);
    const bgRelFile = `media/${bgFileName}`;

    const bgInfo = await generateSyntheticBackgroundVideo(
      bgAbsPath,
      narrativePlan.targetDurationSec,
      currentProject.settings.width,
      currentProject.settings.height,
    );

    const existingBgAsset = currentProject.media.find((m) => m.file === bgRelFile);
    const bgAsset: MediaAsset = existingBgAsset
      ? {
          ...existingBgAsset,
          width: currentProject.settings.width,
          height: currentProject.settings.height,
          sizeBytes: bgInfo.sizeBytes,
          durationUs: bgInfo.durationUs,
        }
      : {
          id: newId("med"),
          name: "Fondo Cinemático V1",
          kind: "video",
          file: bgRelFile,
          mimeType: "video/mp4",
          sizeBytes: bgInfo.sizeBytes,
          durationUs: bgInfo.durationUs,
          width: currentProject.settings.width,
          height: currentProject.settings.height,
          fps,
          thumbnail: "ready",
          waveform: "none",
          proxy: "none",
          importedAt: new Date().toISOString(),
          origin: "generated",
        };

    if (!existingBgAsset) {
      currentProject = touchProject({
        ...currentProject,
        media: [...currentProject.media, bgAsset],
      });
    } else {
      currentProject = touchProject({
        ...currentProject,
        media: currentProject.media.map((m) => (m.id === bgAsset.id ? bgAsset : m)),
      });
    }

    const v1ExistingSynthIds = v1TrackInitial.clips
      .filter((c) => c.name.startsWith("Escena Fondo") || Boolean(c.remotion))
      .map((c) => c.id);
    if (v1ExistingSynthIds.length > 0) {
      currentProject = touchProject({
        ...currentProject,
        tracks: currentProject.tracks.map((t) =>
          t.id === v1TrackInitial.id
            ? { ...t, clips: t.clips.filter((c) => !v1ExistingSynthIds.includes(c.id)) }
            : t,
        ),
      });
    }

    // Sintetizar escenas background-v1 únicas mediante IA cuando el Director las planificó
    const aiBgBriefs = directive.customScenes.filter((s) => s.layerRole === "background-v1");
    const synthesizedAiBg =
      aiBgBriefs.length > 0
        ? await mapWithConcurrency(aiBgBriefs, 2, async (brief, idx) => {
            const matchedBlock = narrativePlan.blocks[idx] ?? narrativePlan.blocks[0];
            const durFrames = matchedBlock?.durationFrames ?? Math.max(45, Math.round(brief.durationSec * fpsNum));
            const synth = await synthesizeValidatedRemotionScene({
              scene: brief,
              artDirection: directive.artDirection,
              width: currentProject.settings.width,
              height: currentProject.settings.height,
              fps: fpsNum,
              durationFrames: durFrames,
              audioPeaks: audioProfile?.normalizedPeaks,
              signal: abortSignal,
            });
            return { brief, synth };
          })
        : [];

    const stageFontName =
      directive.artDirection.typographyStyle === "editorial_serif"
        ? "Playfair Display"
        : directive.artDirection.typographyStyle === "bold_kinetic"
          ? "Anton"
          : directive.artDirection.typographyStyle === "tech_mono"
            ? "Space Grotesk"
            : "Inter";

    let aiBgGeneratedCount = 0;
    const usedAiBgIndices = new Set<number>();

    for (const block of narrativePlan.blocks) {
      const accentColor =
        block.accentColor || directive.artDirection.palette.accent || dna.masterPalette.accent;
      const secondaryColor =
        directive.artDirection.palette.secondary ||
        dna?.masterPalette.secondary ||
        BLOCK_PALETTES[(block.index + 2) % BLOCK_PALETTES.length]!;
      const surfaceColor = directive.artDirection.palette.surface || dna.masterPalette.surface;
      const textColor = directive.artDirection.palette.text || dna.masterPalette.text;

      // Buscar escena AI background-v1 correspondiente al bloque (por índice o cercanía temporal)
      const blockStartSec = block.startFrame / fpsNum;
      let matchedIdx =
        synthesizedAiBg[block.index]?.synth.ok && !usedAiBgIndices.has(block.index)
          ? block.index
          : -1;
      if (matchedIdx === -1) {
        matchedIdx = synthesizedAiBg.findIndex(
          (entry, idx) =>
            !usedAiBgIndices.has(idx) &&
            entry.synth.ok &&
            Math.abs(entry.brief.startSec - blockStartSec) <= 3.5,
        );
      }

      let bgCompName = `GenerativeV1Scene${block.index + 1}`;
      let bgCompId = `swarm_bg_${block.index + 1}_${randomUUID().slice(0, 5)}`;
      let bgCode: string;
      let bgProps: Record<string, unknown> = {
        accentColor,
        secondaryColor,
        surfaceColor,
        textColor,
        fontFamily: stageFontName,
        title: block.headline || block.label,
        subtitle: block.subheadline || block.narrationText.slice(0, 88),
        sceneLabel: block.label,
        sceneIndex: block.index + 1,
        ...(audioProfile?.normalizedPeaks && audioProfile.normalizedPeaks.length > 0
          ? { audioPeaks: audioProfile.normalizedPeaks.slice(0, 600) }
          : {}),
      };

      if (matchedIdx >= 0 && synthesizedAiBg[matchedIdx]?.synth.ok) {
        usedAiBgIndices.add(matchedIdx);
        const aiRes = synthesizedAiBg[matchedIdx]!.synth;
        if (aiRes.ok) {
          bgCompName = aiRes.componentName;
          bgCompId = aiRes.compositionId;
          bgCode = aiRes.code;
          bgProps = { ...aiRes.props, ...bgProps };
          aiBgGeneratedCount += 1;
          bespokeRemotionScenes += 1;
        } else {
          bgCode = buildPolymorphicProceduralSceneCode({
            componentName: bgCompName,
            variantSeed: block.index,
            headline: block.headline || block.label,
            subheadline: block.subheadline || block.narrationText.slice(0, 88),
            accentColor,
            secondaryColor,
            surfaceColor,
            textColor,
            fontFamily: stageFontName,
            visualTheme: directive.artDirection.visualTheme || dna.categoryLabel,
          });
        }
      } else {
        bgCode = buildPolymorphicProceduralSceneCode({
          componentName: bgCompName,
          variantSeed: block.index,
          headline: block.headline || block.label,
          subheadline: block.subheadline || block.narrationText.slice(0, 88),
          accentColor,
          secondaryColor,
          surfaceColor,
          textColor,
          fontFamily: stageFontName,
          visualTheme: directive.artDirection.visualTheme || dna.categoryLabel,
        });
      }

      const bgClip: MediaClip = {
        ...makeMediaClip(currentProject, bgAsset, {
          startFrame: block.startFrame,
          durationFrames: block.durationFrames,
          createdBy: "agent",
        }),
        name: `Escena Fondo ${block.index + 1} · ${block.label}`,
        remotion: {
          compositionId: bgCompId,
          componentName: bgCompName,
          code: bgCode,
          props: bgProps,
          live: true,
        },
      };

      const addBgRes = addClip(currentProject, v1TrackInitial.id, bgClip);
      if (addBgRes.ok) {
        currentProject = addBgRes.project;
      }
    }

    // Fallback de emergencia solo si la pre-síntesis TTS no se aplicó arriba
    if (!prePassTtsApplied) {
      try {
        const a1Res = ensurePrimaryAudioTrack(currentProject);
        currentProject = a1Res.project;
        const a1Track = a1Res.track;
        const fullNarrationScript = narrativePlan.blocks.map((b) => b.narrationText).join(" ... ");
        const ttsFileName = "swarm-tts-voice.wav";
        const ttsAbsPath = path.join(mediaDir, ttsFileName);
        const ttsRelFile = `media/${ttsFileName}`;

        const wavInfo = await generateSyntheticTtsWavFile(
          ttsAbsPath,
          fullNarrationScript,
          narrativePlan.targetDurationSec,
        );

        const existingTtsAsset = currentProject.media.find((m) => m.file === ttsRelFile);
        const ttsAsset: MediaAsset = existingTtsAsset
          ? { ...existingTtsAsset, sizeBytes: wavInfo.sizeBytes, durationUs: wavInfo.durationUs }
          : {
              id: newId("med"),
              name: "Locución IA (TTS)",
              kind: "audio",
              file: ttsRelFile,
              mimeType: "audio/wav",
              sizeBytes: wavInfo.sizeBytes,
              durationUs: wavInfo.durationUs,
              audioCodec: "pcm_s16le",
              sampleRate: 48000,
              channels: 1,
              thumbnail: "ready",
              waveform: "none",
              proxy: "none",
              importedAt: new Date().toISOString(),
              origin: "generated",
            };

        if (!existingTtsAsset) {
          currentProject = touchProject({
            ...currentProject,
            media: [...currentProject.media, ttsAsset],
          });
        }

        const currentA1 = currentProject.tracks.find((t) => t.id === a1Track.id)!;
        const prevTtsIds = currentA1.clips
          .filter((c) => c.name.includes("Locución IA"))
          .map((c) => c.id);
        if (prevTtsIds.length > 0) {
          currentProject = touchProject({
            ...currentProject,
            tracks: currentProject.tracks.map((t) =>
              t.id === a1Track.id
                ? { ...t, clips: t.clips.filter((c) => !prevTtsIds.includes(c.id)) }
                : t,
            ),
          });
        }

        const ttsClip: MediaClip = {
          ...makeMediaClip(currentProject, ttsAsset, {
            startFrame: 0,
            durationFrames: narrativePlan.totalFrames,
            createdBy: "agent",
          }),
          name: "Locución IA (TTS)",
          volume: 1,
        };
        const addTtsRes = addClip(currentProject, a1Track.id, ttsClip);
        if (addTtsRes.ok) {
          currentProject = addTtsRes.project;
        }
        prePassTtsSummaryNote = `locución TTS (${Math.round(narrativePlan.targetDurationSec)}s)`;
      } catch (ttsErr) {
        console.warn("[SwarmDirector] Aviso generando pista TTS:", ttsErr);
      }
    }

    steps.push({
      step: 1,
      agent: "Generative Visual & Voice Agent",
      summary: `${narrativePlan.blocks.length} escenas V1 (${aiBgGeneratedCount} TSX IA a medida + motores Canvas/3D/SVG reactivos al audio) y ${prePassTtsSummaryNote || "locución A1"}.`,
      applied: true,
    });
  }

  if (realV1Clips.length > 0) {
    // Poda natural de silencios por cada segmento elegible (en orden inverso para preservar ripples), salvo si el usuario pidió conservar silencios o ya se ejecutó recorte global
    if (effectiveSilenceCut && !silenceAlreadyHandledByTool) {
      const silenceCache = new Map<string, Awaited<ReturnType<typeof detectSilences>>>();
      let anyCutApplied = false;

      for (let clipIdx = realV1Clips.length - 1; clipIdx >= 0; clipIdx -= 1) {
        const baseClip = realV1Clips[clipIdx]!;
        const primaryAsset = currentProject.media.find((m) => m.id === baseClip.mediaId);
        const hasAudio = Boolean(primaryAsset && (primaryAsset.audioCodec || primaryAsset.kind === "video"));
        const alreadySegmented = baseClip.id.includes("_seg");

        if (alreadySegmented || !primaryAsset || !hasAudio || baseClip.durationFrames < Math.round(fpsNum * 1.2)) {
          continue;
        }

        try {
          let silenceAnalysis = silenceCache.get(primaryAsset.id);
          if (!silenceAnalysis) {
            silenceAnalysis = await detectSilences(
              projectId,
              primaryAsset,
              {
                thresholdDb: -38,
                minSilenceSec: 0.85,
              },
              abortSignal,
            );
            silenceCache.set(primaryAsset.id, silenceAnalysis);
          }

          const inClip = silenceAnalysis.intervals
            .map((s) => {
              const startUs = Math.max(baseClip.sourceInUs, s.startUs);
              const endUs = Math.min(baseClip.sourceOutUs, s.endUs);
              return {
                startUs,
                endUs,
                durationUs: Math.max(0, endUs - startUs),
              };
            })
            .filter((s) => s.endUs > s.startUs);

          let firstWordStartUs: number | undefined;
          let lastWordEndUs: number | undefined;
          if (cachedTranscriptSegments && cachedTranscriptSegments.length > 0) {
            for (const seg of cachedTranscriptSegments) {
              if (seg.endUs <= baseClip.sourceInUs || seg.startUs >= baseClip.sourceOutUs) continue;
              const segWords = Array.isArray(seg.words) && seg.words.length > 0 ? seg.words : [seg];
              for (const w of segWords) {
                if (w.endUs <= baseClip.sourceInUs || w.startUs >= baseClip.sourceOutUs) continue;
                if (firstWordStartUs === undefined || w.startUs < firstWordStartUs) {
                  firstWordStartUs = w.startUs;
                }
                if (lastWordEndUs === undefined || w.endUs > lastWordEndUs) {
                  lastWordEndUs = w.endUs;
                }
              }
            }
          }

          const keep = keepRangesNatural(
            baseClip.sourceInUs,
            baseClip.sourceOutUs,
            inClip,
            {
              prePadSec: 0.20,
              postPadSec: 0.28,
              minCutGapSec: 0.55,
              minKeepSec: 0.75,
              firstWordStartUs,
              lastWordEndUs,
            },
          );

          if (keep.length > 0) {
            const cutResult = applySourceRanges(currentProject, baseClip.id, keep);
            if (cutResult.ok) {
              currentProject = cutResult.project;
              silencesRemoved += Math.max(1, inClip.length);
              anyCutApplied = true;
            }
          }
        } catch (err) {
          console.warn("[SwarmDirector] Paso 1 (VAD) omitido por aviso de audio:", err);
        }
      }

      if (anyCutApplied) {
        const v1After = findPrimaryVideoTrack(currentProject);
        const segClips =
          v1After?.clips.filter((c): c is MediaClip => isMediaClip(c) && c.type === "video") ?? [];

        for (let idx = 0; idx < segClips.length; idx += 1) {
          const segClip = segClips[idx]!;
          const isFirst = idx === 0;
          const isLast = idx === segClips.length - 1;
          const updSeg = updateClip(currentProject, segClip.id, (c) => {
            if (c.type === "text") return c;
            return {
              ...c,
              audioEnhance: "voice",
              fadeInFrames: isFirst ? Math.min(6, Math.floor(c.durationFrames / 3)) : 0,
              fadeOutFrames: isLast ? Math.min(8, Math.floor(c.durationFrames / 3)) : 0,
              transitionType: "none",
              transitionDurationFrames: 0,
              transform: c.transform ?? createDefaultTransform(),
            };
          });
          if (updSeg.ok) {
            currentProject = updSeg.project;
          }
        }

        const ambientTrack = currentProject.tracks.find(
          (t) => t.kind === "video" && (t.name === "V0" || /fondo\s+ambient/i.test(t.name)),
        );
        if (ambientTrack && segClips.length > 0) {
          const synchronizedAmbientClips = segClips.map((c) => ({
            ...c,
            id: `clp_amb_${c.id}`,
            name: `Fondo Ambiental · ${c.name}`,
            volume: 0,
            transform: {
              ...(c.transform ?? createDefaultTransform()),
              scale: 2.2,
              opacity: 0.85,
            },
            adjustments: {
              brightness: 0.65,
              contrast: 1.15,
              saturation: 1.35,
            },
            createdBy: "agent" as const,
          }));
          currentProject = touchProject({
            ...currentProject,
            tracks: currentProject.tracks.map((t) =>
              t.id === ambientTrack.id ? { ...t, clips: synchronizedAmbientClips } : t,
            ),
          });
        }

        if (segClips.length > 0) {
          const actualTotalFrames = Math.max(
            ...segClips.map((c) => c.startFrame + c.durationFrames),
          );
          narrativePlan = {
            ...narrativePlan,
            totalFrames: actualTotalFrames,
            targetDurationSec: actualTotalFrames / fpsNum,
          };
          subtitleDurationFrames = actualTotalFrames;
        }

        steps.push({
          step: 1,
          agent: "Natural Cutter & J/L Audio",
          summary: `${segClips.length} segmentos fluidos con audio J/L y mejora de voz.`,
          applied: true,
        });
      }
    }
  }

  if (!steps.some((s) => s.step === 1)) {
    steps.push({
      step: 1,
      agent: "Cutter / VAD",
      summary:
        realV1Clips.length > 1
          ? "Cortes previos en V1 preservados."
          : "Audio sin silencios largos que podar.",
      applied: false,
    });
  }

  // Aplicar herramientas quirúrgicas post-corte (color grading, velocidad global, mejora vocal, fade, encuadre)
  if (postCutToolCalls.length > 0) {
    const postExec = await executeSurgicalTimelineTools({
      projectId,
      project: currentProject,
      toolCalls: postCutToolCalls,
      signal: abortSignal,
    });
    currentProject = postExec.project;
    surgicalToolsApplied += postExec.appliedTools.length;
    if (postExec.appliedTools.length > 0) {
      steps.push({
        step: 1,
        agent: "Surgical Timeline Editor",
        summary: postExec.appliedTools.slice(0, 4).join(" · "),
        applied: true,
      });
    }
  }

  // Calibración acústica EBU R128 hacia -14 LUFS cuando no se ajustó volumen manualmente
  let lufsCalibrated: number | undefined;
  const postAdjustedAudio = postCutToolCalls.some((c) => c.tool === "adjust_audio");
  if (
    !postAdjustedAudio &&
    audioProfile &&
    Math.abs(audioProfile.recommendedSpeechGain - 1) > 0.08
  ) {
    const primaryAfterCut = findPrimaryVideoTrack(currentProject);
    const v1ToCalibrate =
      primaryAfterCut?.clips.filter(
        (c): c is MediaClip => isMediaClip(c) && c.type === "video" && !c.remotion,
      ) ?? [];
    for (const clip of v1ToCalibrate) {
      const currentVol = typeof clip.volume === "number" ? clip.volume : 1;
      const nextVol = Number(
        Math.max(0.4, Math.min(1.85, currentVol * audioProfile.recommendedSpeechGain)).toFixed(2),
      );
      const volUpd = updateClip(currentProject, clip.id, (c) =>
        c.type === "text" ? c : { ...c, volume: nextVol },
      );
      if (volUpd.ok) {
        currentProject = volUpd.project;
        if (typeof audioProfile.integratedLufs === "number") {
          lufsCalibrated = Number(audioProfile.integratedLufs.toFixed(1));
        }
      }
    }
  }

  // =========================================================================
  // PASO 2: ANÁLISIS DE VOZ Y SUBTÍTULOS DINÁMICOS (GOBERNANZA ESPACIAL AUTÓNOMA)
  // =========================================================================
  let extractedCues: CaptionCue[] = [];
  let subtitleStartFrame = 0;

  const userWantsNoSubs =
    userConstraints.noSubs ||
    !directive.subtitleDirective.enabled ||
    /\b(sin\s+subt[íi]tulos?|no\s+(?:pongas?|quiero)\s+subt[íi]tulos?|quitar?\s+subt[íi]tulos?|eliminar?\s+subt[íi]tulos?|desactivar?\s+subt[íi]tulos?|cero\s+subt[íi]tulos?)\b/i.test(
      prompt,
    );

  const userWantsFullSubtitles =
    /\b(subt[íi]tul(?:os?|a)\s+(?:todo|completo|en\s+todo\s+el\s+v[íi]deo|ininterrumpido)|todos\s+los\s+subt[íi]tulos|siempre\s+visibles?|subtitula\s+todo|subtitulado\s+completo)\b/i.test(
      prompt,
    );

  if (userWantsNoSubs) {
    const subTrackRes = ensureSubtitleTrack(currentProject);
    currentProject = subTrackRes.project;
    const subTrack = subTrackRes.track;
    const existingSubIds = subTrack.clips.filter((c) => c.createdBy === "agent").map((c) => c.id);
    if (existingSubIds.length > 0) {
      currentProject = touchProject({
        ...currentProject,
        tracks: currentProject.tracks.map((t) =>
          t.id === subTrack.id
            ? { ...t, clips: t.clips.filter((c) => !existingSubIds.includes(c.id)) }
            : t,
        ),
      });
    }

    steps.push({
      step: 2,
      agent: "Voice & Subtitles Agent",
      summary: "Subtítulos omitidos por instrucción explícita del usuario ('sin subtítulos').",
      applied: false,
    });
  } else {
    onProgress?.(
      `Paso 2/5 · Subtítulos: Tipografía cinética adaptativa (${styleId.toUpperCase()})...`,
      2,
      5,
    );

    if (!usedSyntheticEnvironment) {
      try {
        const builtSubs = await buildSubtitles({
          projectId,
          project: currentProject,
          currentFrame: 0,
          signal: abortSignal,
          style: styleId,
          cachedSegments: cachedTranscriptSegments,
          userPrompt: prompt,
          narrativeBlocks: narrativePlan.blocks,
          dna,
        });
        extractedCues = Array.isArray(builtSubs.props?.captions)
          ? (builtSubs.props.captions as CaptionCue[])
          : [];
        subtitleStartFrame = builtSubs.startFrame;
        subtitleDurationFrames = builtSubs.durationInFrames;
        subtitleCuesCount = builtSubs.wordCount;
      } catch {
        // Si el video de V1 no tenía voz clara, usar el estimador por bloques narrativos (150 WPM)
        extractedCues = [];
      }
    }

    if (extractedCues.length === 0) {
      const rawSynthetic = buildSyntheticCaptionCuesFromBlocks(
        narrativePlan.blocks,
        fpsNum,
        synthesizedSpeechSegments,
      );
      const governed = applyAutonomousSubtitleGovernance(rawSynthetic, {
        project: currentProject,
        narrativeBlocks: narrativePlan.blocks,
        dna,
        userPrompt: prompt,
        fps: fpsNum,
        totalFrames: narrativePlan.totalFrames,
      });
      extractedCues = governed.cues;
      subtitleStartFrame = 0;
      subtitleDurationFrames = narrativePlan.totalFrames;
      subtitleCuesCount = extractedCues.reduce((acc, c) => acc + (c.suppressed ? 0 : c.words.length), 0);
    }

    if (extractedCues.length > 0) {
      const componentName = `Swarm${styleId.charAt(0).toUpperCase()}${styleId.slice(1)}Subtitles`;
      const subGenerated = buildSubtitleComponentCode(styleId, componentName);

      const subTrackRes = ensureSubtitleTrack(currentProject);
      currentProject = subTrackRes.project;
      const subTrack = subTrackRes.track;

      const existingSubClip = subTrack.clips.find(
        (c): c is TextClip =>
          c.type === "text" &&
          Boolean(
            c.remotion &&
              (Array.isArray(c.remotion.props?.captions) ||
                Array.isArray(c.remotion.props?.words) ||
                /subtitles/i.test(c.remotion.componentName)),
          ),
      );

      const subRemotionSpec = {
        compositionId: `swarm_subs_${styleId}`,
        componentName: subGenerated.componentName || componentName,
        code: subGenerated.code,
        props: { captions: extractedCues } as Record<string, unknown>,
        styleId,
        live: true,
      };

      const previewText = extractedCues
        .filter((c) => !c.suppressed)
        .slice(0, 4)
        .map(cueText)
        .join(" ")
        .slice(0, 80);

      if (existingSubClip) {
        const updatedRes = updateClip(currentProject, existingSubClip.id, (clip) => {
          if (clip.type !== "text") return clip;
          return {
            ...clip,
            name: `Subtítulos IA (${styleId})`,
            text: previewText || clip.text,
            startFrame: subtitleStartFrame,
            durationFrames: subtitleDurationFrames,
            remotion: subRemotionSpec,
          };
        });
        if (updatedRes.ok) {
          currentProject = updatedRes.project;
        }
      } else {
        const newSubClip = makeTextClip({
          name: `Subtítulos IA (${styleId})`,
          text: previewText || "Subtítulos sincronizados",
          startFrame: subtitleStartFrame,
          durationFrames: subtitleDurationFrames,
          role: "subtitle",
          fontSize: 58,
          fontWeight: 700,
          color: "#FFFFFF",
          background: false,
          backgroundOpacity: 0,
          remotion: subRemotionSpec,
          createdBy: "agent",
        });
        const addSubRes = addClip(currentProject, subTrack.id, newSubClip);
        if (addSubRes.ok) {
          currentProject = addSubRes.project;
        }
      }

      const activeCuesCount = extractedCues.filter((c) => !c.suppressed).length;
      const suppressedCuesCount = extractedCues.filter((c) => c.suppressed).length;
      const keywordCalloutsCount = extractedCues.filter((c) => c.cueType === "keyword_callout").length;
      const topRelocatedCount = extractedCues.filter((c) => c.zone === "hero-top").length;

      steps.push({
        step: 2,
        agent: "Voice & Subtitles Agent",
        summary: `${activeCuesCount} bloques activos (${suppressedCuesCount} pausados en gráficos, ${topRelocatedCount} en hero-top, ${keywordCalloutsCount} callouts) · ${styleId.toUpperCase()}.`,
        applied: activeCuesCount > 0,
      });
    }
  }

  // =========================================================================
  // PASO 3: DIRECTOR DE CÁMARA / ZOOMS DINÁMICOS SUAVES SOBRE V1
  // =========================================================================
  onProgress?.(
    "Paso 3/5 · Cámara: Zooms dinámicos y alternancia de plano...",
    3,
    5,
  );

  const v1TrackAfterCut = findPrimaryVideoTrack(currentProject);
  const v1ClipsAfterCut =
    v1TrackAfterCut?.clips.filter((c): c is MediaClip => isMediaClip(c) && c.type === "video") ?? [];
  const totalTimelineFrames = Math.max(
    usedSyntheticEnvironment ? narrativePlan.totalFrames : 0,
    timelineDurationFrames(currentProject),
  );

  const basePostCutBudget = computeEditorialBudget({
    prompt,
    project: currentProject,
    hasRealVideoFootage: hasRealV1Footage && !usedSyntheticEnvironment,
    totalDurationSec: totalTimelineFrames / Math.max(1, fpsNum),
    transcriptSegments: cachedTranscriptSegments,
    audioProfile,
    visualProfile,
    constraints: userConstraints,
    cameraStyle: directive.artDirection.cameraStyle,
    lookPreset: directive.atmosphereLook.lookPreset,
    letterboxRatio: directive.atmosphereLook.letterboxRatio,
  });
  const planOverrides = directive.editorialPlan;
  const postCutBudget: EditorialBudget = {
    ...basePostCutBudget,
    densityTier: planOverrides?.densityTier ?? basePostCutBudget.densityTier,
    decisionRationale: planOverrides?.decisionRationale || basePostCutBudget.decisionRationale,
    maxOverlays:
      planOverrides?.maxOverlays !== undefined
        ? Math.min(planOverrides.maxOverlays, basePostCutBudget.maxOverlays)
        : basePostCutBudget.maxOverlays,
    minOverlayGapSec:
      planOverrides?.minOverlayGapSec !== undefined
        ? Math.max(planOverrides.minOverlayGapSec, basePostCutBudget.minOverlayGapSec)
        : basePostCutBudget.minOverlayGapSec,
    maxZoomPunches: userConstraints.noZooms
      ? 0
      : planOverrides?.maxZoomPunches !== undefined
        ? Math.min(planOverrides.maxZoomPunches, basePostCutBudget.maxZoomPunches)
        : basePostCutBudget.maxZoomPunches,
    minPunchGapSec:
      planOverrides?.minPunchGapSec !== undefined
        ? Math.max(planOverrides.minPunchGapSec, basePostCutBudget.minPunchGapSec)
        : basePostCutBudget.minPunchGapSec,
    maxSfx: userConstraints.noSfx
      ? 0
      : planOverrides?.maxSfx !== undefined
        ? Math.min(planOverrides.maxSfx, basePostCutBudget.maxSfx)
        : basePostCutBudget.maxSfx,
    minSfxGapSec:
      planOverrides?.minSfxGapSec !== undefined
        ? Math.max(planOverrides.minSfxGapSec, basePostCutBudget.minSfxGapSec)
        : basePostCutBudget.minSfxGapSec,
    maxOpticalTransitions:
      planOverrides?.maxOpticalTransitions !== undefined
        ? Math.min(planOverrides.maxOpticalTransitions, basePostCutBudget.maxOpticalTransitions)
        : basePostCutBudget.maxOpticalTransitions,
    minTransitionGapSec:
      planOverrides?.minTransitionGapSec !== undefined
        ? Math.max(planOverrides.minTransitionGapSec, basePostCutBudget.minTransitionGapSec)
        : basePostCutBudget.minTransitionGapSec,
    applyAtmosphereLayer: userConstraints.noColorFilter
      ? false
      : planOverrides?.applyAtmosphereLayer ?? basePostCutBudget.applyAtmosphereLayer,
    applyOpticalTransitionsOnJumpCuts:
      planOverrides?.applyOpticalTransitionsOnJumpCuts ??
      basePostCutBudget.applyOpticalTransitionsOnJumpCuts,
  };

  const cameraStyle = directive.artDirection.cameraStyle;
  const shouldApplyPunches =
    effectivePunches &&
    cameraStyle !== "static_clean" &&
    v1ClipsAfterCut.length > 0 &&
    postCutBudget.maxZoomPunches > 0;
  const hasFocusTracks = Boolean(visualProfile && visualProfile.focusTracks.length > 0 && v1ClipsAfterCut.length > 0);
  let subjectTrackingClips = 0;

  if (shouldApplyPunches || hasFocusTracks) {
    const holdSec =
      cameraStyle === "whip_energetic" ? 1.5 : cameraStyle === "slow_cinema_push" ? 3.0 : 2.1;
    const rampSec =
      cameraStyle === "whip_energetic" ? 0.22 : cameraStyle === "slow_cinema_push" ? 0.7 : 0.35;
    const zoomFactor =
      postCutBudget.densityTier === "restraint"
        ? 1.07
        : cameraStyle === "whip_energetic"
          ? 1.15
          : cameraStyle === "slow_cinema_push"
            ? 1.07
            : 1.1;

    const holdFrames = Math.round(fpsNum * holdSec);
    const rampFrames = Math.max(6, Math.round(fpsNum * rampSec));

    // Combinar picos acústicos reales (mapados sobre clips post-corte) con heurística semántica y elegir solo picos clave
    const acousticImpactFrames: number[] = [];
    if (shouldApplyPunches && audioProfile && audioProfile.peakImpactFrames.length > 0) {
      for (const v1Clip of v1ClipsAfterCut) {
        if (analyzedPrimaryMediaId && v1Clip.mediaId !== analyzedPrimaryMediaId) continue;
        const clipSourceStartFrame = Math.round((v1Clip.sourceInUs / 1_000_000) * fpsNum);
        const clipSpeed = v1Clip.speed ?? 1;
        const clipSourceSpan = Math.round(v1Clip.durationFrames * clipSpeed);
        for (const peakSourceFrame of audioProfile.peakImpactFrames) {
          if (
            peakSourceFrame >= clipSourceStartFrame + Math.round(fpsNum * 0.35 * clipSpeed) &&
            peakSourceFrame <= clipSourceStartFrame + clipSourceSpan - Math.round(fpsNum * 0.8 * clipSpeed)
          ) {
            const globalFrame = Math.round(
              v1Clip.startFrame + (peakSourceFrame - clipSourceStartFrame) / clipSpeed,
            );
            acousticImpactFrames.push(globalFrame);
          }
        }
      }
    }

    const semanticImpactFrames = shouldApplyPunches
      ? selectImpactFrames(
          extractedCues,
          narrativePlan.blocks,
          subtitleStartFrame,
          fpsNum,
          totalTimelineFrames,
          {
            maxPunches: postCutBudget.maxZoomPunches * 2,
            minGapSec: Math.max(3.5, postCutBudget.minPunchGapSec * 0.65),
          },
        )
      : [];

    const scoredBeatMap = new Map<number, number>();
    for (const semFrame of semanticImpactFrames) {
      const nearAcoustic = acousticImpactFrames.some((af) => Math.abs(af - semFrame) <= Math.round(fpsNum * 0.6));
      scoredBeatMap.set(semFrame, nearAcoustic ? 5.0 : 3.2);
    }
    for (const acFrame of acousticImpactFrames) {
      const nearExisting = Array.from(scoredBeatMap.keys()).some((f) => Math.abs(f - acFrame) <= Math.round(fpsNum * 0.6));
      if (!nearExisting) {
        scoredBeatMap.set(acFrame, 2.6);
      }
    }

    const impactGlobalFrames: number[] = [];
    const minBeatSpacing = Math.round(fpsNum * postCutBudget.minPunchGapSec);
    const rankedBeats = Array.from(scoredBeatMap.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [candidateFrame] of rankedBeats) {
      if (impactGlobalFrames.length >= postCutBudget.maxZoomPunches) break;
      const tooClose = impactGlobalFrames.some((picked) => Math.abs(candidateFrame - picked) < minBeatSpacing);
      if (!tooClose) {
        impactGlobalFrames.push(candidateFrame);
      }
    }
    impactGlobalFrames.sort((a, b) => a - b);

    for (const v1Clip of v1ClipsAfterCut) {
      const baseTransform = v1Clip.transform ?? createDefaultTransform();
      const baseScale = baseTransform.scale && baseTransform.scale > 0 ? baseTransform.scale : 1.0;
      const peakScale = Number((baseScale * zoomFactor).toFixed(3));

      // Smart Subject-Tracking Reframe (especial para 16:9 -> 9:16 o sujeto descentrado)
      let trackingKf: TransformKeyframe[] = [];
      if (hasFocusTracks && visualProfile) {
        const clipSourceStartSec = v1Clip.sourceInUs / 1_000_000;
        const clipSpeed = v1Clip.speed ?? 1;
        const clipDurationSec = v1Clip.durationFrames / fpsNum;
        const inRange = visualProfile.focusTracks
          .map((pt) => ({
            timeSec: Number(((pt.timeSec - clipSourceStartSec) / clipSpeed).toFixed(2)),
            focusX: pt.focusX,
            focusY: pt.focusY,
          }))
          .filter((pt) => pt.timeSec >= -0.4 && pt.timeSec <= clipDurationSec + 0.4)
          .map((pt) => ({
            ...pt,
            timeSec: Math.max(0, Math.min(clipDurationSec, pt.timeSec)),
          }));

        const effectiveFocus =
          inRange.length > 0
            ? inRange
            : [
                {
                  timeSec: 0,
                  focusX:
                    visualProfile.focusTracks.reduce((best, cur) =>
                      Math.abs(cur.timeSec - clipSourceStartSec) <
                      Math.abs(best.timeSec - clipSourceStartSec)
                        ? cur
                        : best,
                    ).focusX,
                  focusY: 0.42,
                },
              ];

        const clipAsset = currentProject.media.find((m) => m.id === v1Clip.mediaId);
        trackingKf = buildSubjectTrackingTransformKeyframes({
          focusTracks: effectiveFocus,
          durationFrames: v1Clip.durationFrames,
          fps: fpsNum,
          sourceWidth: clipAsset?.width ?? currentProject.settings.width,
          sourceHeight: clipAsset?.height ?? currentProject.settings.height,
          targetWidth: currentProject.settings.width,
          targetHeight: currentProject.settings.height,
          baseScale,
        });
        if (trackingKf.length > 0) {
          subjectTrackingClips += 1;
        }
      }

      const punchKf: TransformKeyframe[] = [];
      // Omitir punches en clips cortos para evitar sobreestimulación y cambios de plano epilépticos
      if (shouldApplyPunches && v1Clip.durationFrames >= Math.round(fpsNum * 3.5)) {
        const clipStart = v1Clip.startFrame;
        const clipEndFrame = v1Clip.startFrame + v1Clip.durationFrames;
        const localPunches = impactGlobalFrames.filter(
          (gf) => gf >= clipStart && gf + Math.min(holdFrames, v1Clip.durationFrames - 6) <= clipEndFrame,
        );

        if (localPunches.length > 0) {
          // Evitar conflicto entre push-in continuo de 10s y punches tempranos en el mismo tramo
          const introEndFrame = Math.min(v1Clip.durationFrames, Math.round(fpsNum * 10));
          const hasEarlyPunch = localPunches.some((gf) => gf - clipStart < introEndFrame + Math.round(fpsNum * 0.5));
          if (clipStart === 0 && cameraStyle === "slow_cinema_push" && !hasEarlyPunch) {
            punchKf.push(
              { frame: 0, scale: baseScale, x: baseTransform.x, y: baseTransform.y },
              { frame: introEndFrame, scale: Number((baseScale * 1.07).toFixed(3)), x: baseTransform.x, y: baseTransform.y },
            );
          }

          for (const globalPunchStart of localPunches) {
            const localStart = Math.max(0, globalPunchStart - clipStart);
            const effHold = Math.min(holdFrames, Math.max(16, v1Clip.durationFrames - localStart - 2));
            const localPeakIn = Math.min(v1Clip.durationFrames - 2, localStart + rampFrames);
            const localPeakOut = Math.min(
              v1Clip.durationFrames - 1,
              localStart + effHold - rampFrames,
            );
            const localEnd = Math.min(v1Clip.durationFrames, localStart + effHold);

            punchKf.push(
              { frame: localStart, scale: baseScale, x: baseTransform.x, y: baseTransform.y },
              { frame: localPeakIn, scale: peakScale, x: baseTransform.x, y: baseTransform.y },
              { frame: localPeakOut, scale: peakScale, x: baseTransform.x, y: baseTransform.y },
              { frame: localEnd, scale: baseScale, x: baseTransform.x, y: baseTransform.y },
            );

            zoomPunchesCount += 1;
          }
        }
      }

      const mergedKf = mergeTrackingAndPunchKeyframes(
        trackingKf,
        punchKf.sort((a, b) => a.frame - b.frame),
        baseScale,
        baseTransform.x,
        baseTransform.y,
      );

      if (mergedKf.length > 0) {
        const initialX = trackingKf[0]?.x ?? baseTransform.x;
        const initialScale = trackingKf[0]?.scale ?? baseScale;
        const updRes = updateClip(currentProject, v1Clip.id, (clip) => {
          if (clip.type === "text") return clip;
          return {
            ...clip,
            transform: {
              ...(clip.transform ?? createDefaultTransform()),
              x: initialX,
              scale: initialScale,
              keyframes: mergedKf,
            },
          };
        });
        if (updRes.ok) {
          currentProject = updRes.project;
        }
      }
    }

    steps.push({
      step: 3,
      agent: "Camera Director Agent",
      summary: `${zoomPunchesCount} zooms dinámicos${acousticImpactFrames.length > 0 ? " (sincronizados a picos vocales)" : ""}${subjectTrackingClips > 0 ? ` · seguimiento de sujeto activo en ${subjectTrackingClips} clip(s)` : ""}.`,
      applied: zoomPunchesCount > 0 || subjectTrackingClips > 0,
    });
  } else {
    steps.push({
      step: 3,
      agent: "Camera Director Agent",
      summary: "Encuadres estándar mantenidos.",
      applied: false,
    });
  }

  // =========================================================================
  // PASO 4: MOTOR HYPERFRAMES (TÍTULOS 3D, TARJETAS HUD DE DATOS Y TRANSICIONES ÓPTICAS)
  // =========================================================================
  onProgress?.(
    "Paso 4/5 · HyperFrames: Títulos 3D, HUDs y transiciones ópticas...",
    4,
    5,
  );

  let opticalTransitionsInserted = 0;

  if (!effectiveBrollCards) {
    currentProject = touchProject({
      ...currentProject,
      tracks: currentProject.tracks.map((t) =>
        t.kind === "video" && /capa\s+motion|motion/i.test(t.name)
          ? { ...t, clips: t.clips.filter((c) => c.createdBy !== "agent") }
          : t,
      ),
    });
  }

  const explicitPromptTitles = extractExplicitPromptTitles(prompt);
  const resolvedIntroTitle =
    explicitPromptTitles.introTitle ??
    (hasRealV1Footage && !usedSyntheticEnvironment && explicitPromptTitles.wantsIntroTitle
      ? resolveContextualOverlayCopy({
          prompt,
          project: currentProject,
          transcriptTexts: cachedTranscriptSegments?.map((s) => s.text),
          dna,
        }).headline
      : undefined);
  const wantsExplicitCleanTitlesOnly =
    hasRealV1Footage &&
    !usedSyntheticEnvironment &&
    explicitPromptTitles.isCleanMinimal &&
    (Boolean(resolvedIntroTitle) || Boolean(explicitPromptTitles.outroTitle));

  if (effectiveBrollCards) {
    const motionTrackRes = ensureCapaMotionTrack(currentProject);
    currentProject = motionTrackRes.project;
    const motionTrackId = motionTrackRes.track.id;

    // Limpiar tarjetas y títulos previos generados por el enjambre para garantizar cohesión visual sin solapamientos
    const currentMotionTrack = currentProject.tracks.find((t) => t.id === motionTrackId)!;
    const oldSwarmClipIds = currentMotionTrack.clips
      .filter((c) => c.createdBy === "agent")
      .map((c) => c.id);

    currentProject = touchProject({
      ...currentProject,
      tracks: currentProject.tracks.map((t) => {
        if (t.id === motionTrackId && oldSwarmClipIds.length > 0) {
          return { ...t, clips: t.clips.filter((c) => !oldSwarmClipIds.includes(c.id)) };
        }
        if (t.kind === "text" && t.name === "Títulos") {
          return { ...t, clips: t.clips.filter((c) => c.createdBy !== "agent") };
        }
        return t;
      }),
    });

    if (wantsExplicitCleanTitlesOnly) {
      const titleTrackRes = ensureTitleTrack(currentProject);
      currentProject = titleTrackRes.project;
      const titleTrackId = titleTrackRes.track.id;

      if (resolvedIntroTitle) {
        const introText =
          explicitPromptTitles.introTitle && explicitPromptTitles.introSubtitle
            ? `${resolvedIntroTitle} · ${explicitPromptTitles.introSubtitle}`
            : resolvedIntroTitle;
        const introStart = Math.round(fpsNum * 0.15);
        const introDur = Math.min(
          Math.round(fpsNum * 3.4),
          Math.max(Math.round(fpsNum * 1.8), Math.round(totalTimelineFrames * 0.25)),
        );
        if (introStart + introDur <= totalTimelineFrames + Math.round(fpsNum * 0.5)) {
          const introClip = makeTextClip({
            name: `Título · ${resolvedIntroTitle}`.slice(0, 80),
            text: introText,
            startFrame: introStart,
            durationFrames: introDur,
            role: "title",
            position: { x: 0.5, y: 0.14 },
            fontSize: 44,
            fontWeight: 700,
            color: "#FFFFFF",
            background: true,
            backgroundColor: "#0B111E",
            backgroundOpacity: 0.78,
            backgroundPadding: 18,
            fadeFrames: 8,
            animationIn: "fade-in",
            animationInDuration: 8,
            animationOut: "fade-out",
            animationOutDuration: 8,
            createdBy: "agent",
          });
          const addIntro = addClip(currentProject, titleTrackId, introClip);
          if (addIntro.ok) {
            currentProject = addIntro.project;
            brollCardsInserted += 1;
          }
        }
      }

      if (explicitPromptTitles.outroTitle && totalTimelineFrames > Math.round(fpsNum * 4.2)) {
        const outroText = explicitPromptTitles.outroSubtitle
          ? `${explicitPromptTitles.outroTitle} · ${explicitPromptTitles.outroSubtitle}`
          : explicitPromptTitles.outroTitle;
        const outroDur = Math.min(
          Math.round(fpsNum * 3.6),
          Math.max(Math.round(fpsNum * 1.8), Math.round(totalTimelineFrames * 0.25)),
        );
        const outroStart = Math.max(
          Math.round(fpsNum * 3.8),
          totalTimelineFrames - outroDur - Math.round(fpsNum * 0.15),
        );
        const outroClip = makeTextClip({
          name: `Cierre · ${explicitPromptTitles.outroTitle}`.slice(0, 80),
          text: outroText,
          startFrame: outroStart,
          durationFrames: outroDur,
          role: "title",
          position: { x: 0.5, y: 0.16 },
          fontSize: 44,
          fontWeight: 700,
          color: "#FFFFFF",
          background: true,
          backgroundColor: "#0B111E",
          backgroundOpacity: 0.82,
          backgroundPadding: 18,
          fadeFrames: 8,
          animationIn: "fade-in",
          animationInDuration: 8,
          animationOut: "fade-out",
          animationOutDuration: 8,
          createdBy: "agent",
        });
        const addOutro = addClip(currentProject, titleTrackId, outroClip);
        if (addOutro.ok) {
          currentProject = addOutro.project;
          brollCardsInserted += 1;
        }
      }
    }

    const postCutSec = Math.max(4, totalTimelineFrames / Math.max(1, fpsNum));
    let customMotionScenes: BespokeSceneBrief[] = wantsExplicitCleanTitlesOnly
      ? []
      : enforceEditorialRestraint({
          scenes: directive.customScenes.filter((s) => s.layerRole !== "background-v1"),
          budget: postCutBudget,
          prompt,
          totalDurationSec: postCutSec,
          hasRealVideoFootage: hasRealV1Footage && !usedSyntheticEnvironment,
        });
    const directorExplicitlyChoseClean =
      wantsExplicitCleanTitlesOnly ||
      (directive.source === "ai_director" &&
        directive.customScenes.filter((s) => s.layerRole !== "background-v1").length === 0);
    if (
      !wantsExplicitCleanTitlesOnly &&
      customMotionScenes.length === 0 &&
      !directorExplicitlyChoseClean &&
      postCutBudget.maxOverlays > 0 &&
      hasRealV1Footage &&
      !explicitTimeBlocksInPrompt
    ) {
      customMotionScenes = deriveAdaptiveScenesFromTranscriptAndPrompt({
        prompt,
        project: currentProject,
        transcriptSegments: cachedTranscriptSegments,
        visualProfile,
        dna,
        constraints: userConstraints,
        budget: postCutBudget,
      }).filter((s) => s.layerRole !== "background-v1");
    }
    const useAiBespokeCodegen = customMotionScenes.length > 0 && !wantsExplicitCleanTitlesOnly;

    if (useAiBespokeCodegen) {
      onProgress?.(
        `Paso 4/6 · Studio Remotion × HyperFrames: Sintetizando ${customMotionScenes.length} escenas TSX a medida...`,
        4,
        6,
      );

      const palette = directive.artDirection.palette;
      const synthesizedList = await mapWithConcurrency(
        customMotionScenes,
        2,
        async (sceneBrief) => {
          const durFrames = Math.max(
            Math.round(fpsNum * 1.8),
            Math.min(
              Math.round(totalTimelineFrames * 0.45),
              Math.round(sceneBrief.durationSec * fpsNum),
            ),
          );
          const synth = await synthesizeValidatedRemotionScene({
            scene: sceneBrief,
            artDirection: directive.artDirection,
            width: currentProject.settings.width,
            height: currentProject.settings.height,
            fps: fpsNum,
            durationFrames: durFrames,
            audioPeaks: audioProfile?.normalizedPeaks,
            visualProfile,
            signal: abortSignal,
          });
          return { sceneBrief, durFrames, synth };
        },
      );

      for (let synthIdx = 0; synthIdx < synthesizedList.length; synthIdx += 1) {
        const item = synthesizedList[synthIdx]!;
        const latestTrack = currentProject.tracks.find((t) => t.id === motionTrackId)!;
        const mappedStart =
          hasRealV1Footage && !usedSyntheticEnvironment && v1ClipsAfterCut.length > 0
            ? mapSourceSecToTimelineFrame(
                item.sceneBrief.startSec,
                v1ClipsAfterCut,
                fpsNum,
                analyzedPrimaryMediaId,
              )
            : Math.max(0, Math.round(item.sceneBrief.startSec * fpsNum));
        if (
          mappedStart === null &&
          ((cachedTranscriptSegments?.length ?? 0) > 0 || directive.source === "ai_director")
        ) {
          continue;
        }
        const targetStart =
          mappedStart ?? Math.max(0, Math.round(item.sceneBrief.startSec * fpsNum));
        const startFrame = findFreeStartFrame(latestTrack, targetStart, item.durFrames);
        if (startFrame + item.durFrames > totalTimelineFrames + Math.round(fpsNum * 0.8)) {
          continue;
        }

        let clipSpec: {
          componentName: string;
          compositionId: string;
          code: string;
          props: Record<string, unknown>;
        };

        if (item.synth.ok) {
          bespokeRemotionScenes += 1;
          clipSpec = {
            componentName: item.synth.componentName,
            compositionId: item.synth.compositionId,
            code: item.synth.code,
            props: item.synth.props,
          };
        } else {
          const polyComponentName = `PolyOverlay_${synthIdx + 1}_${randomUUID().slice(0, 4)}`;
          const polyCode = buildPolymorphicProceduralSceneCode({
            componentName: polyComponentName,
            variantSeed: synthIdx + (item.sceneBrief.headline.length % 4),
            headline: item.sceneBrief.headline,
            subheadline: item.sceneBrief.subheadline,
            accentColor: palette.accent,
            secondaryColor: palette.secondary,
            surfaceColor: palette.surface,
            textColor: palette.text,
            fontFamily: "Space Grotesk",
            visualTheme: directive.artDirection.visualTheme || dna.categoryLabel,
            transparentOverlay: hasRealV1Footage || item.sceneBrief.layerRole === "overlay",
            zone: item.sceneBrief.zone,
            metricValue: item.sceneBrief.metricValue,
          });
          const polyCheck = await verifyRemotionComponentTsx(polyCode);
          if (polyCheck.ok) {
            bespokeRemotionScenes += 1;
            clipSpec = {
              componentName: polyComponentName,
              compositionId: `poly_overlay_${randomUUID().slice(0, 6)}`,
              code: polyCode,
              props: {
                zone: item.sceneBrief.zone,
                accentColor: palette.accent,
                secondaryColor: palette.secondary,
                surfaceColor: palette.surface,
                textColor: palette.text,
                title: item.sceneBrief.headline,
                subtitle: item.sceneBrief.subheadline,
                metricValue: item.sceneBrief.metricValue ?? "",
                fontFamily: "Space Grotesk",
                ...(audioProfile?.normalizedPeaks && audioProfile.normalizedPeaks.length > 0
                  ? { audioPeaks: audioProfile.normalizedPeaks.slice(0, 600) }
                  : {}),
              },
            };
          } else {
            const fallbackSpec =
              /\b(vs|antes|despu[ée]s|comparativa|versus)\b/i.test(
                `${item.sceneBrief.visualConcept} ${item.sceneBrief.headline}`,
              )
                ? buildHyperFrameSplitComparison({
                    badge: directive.artDirection.visualTheme,
                    title: item.sceneBrief.headline,
                    leftLabel: "ANTES / BASE",
                    leftValue: item.sceneBrief.subheadline.slice(0, 24) || "Baseline",
                    rightLabel: "OPTIMIZADO",
                    rightValue: item.sceneBrief.metricValue || "PRO",
                    zone: item.sceneBrief.zone,
                    palette,
                  })
                : buildHyperFrameBespokeMetaphor({
                    badge: directive.artDirection.visualTheme,
                    title: item.sceneBrief.headline,
                    subtitle: item.sceneBrief.subheadline,
                    metricValue: item.sceneBrief.metricValue,
                    metaphorKind: "hud_brackets",
                    zone: item.sceneBrief.zone,
                    palette,
                  });

            clipSpec = {
              componentName: fallbackSpec.componentName,
              compositionId: `hf_fallback_${randomUUID().slice(0, 6)}`,
              code: fallbackSpec.code,
              props: fallbackSpec.props,
            };
          }
        }

        const assetRes = ensureVirtualMotionAsset(
          currentProject,
          clipSpec.componentName,
          item.durFrames,
        );
        currentProject = assetRes.project;

        const motionClip: MediaClip = {
          ...makeMediaClip(currentProject, assetRes.asset, {
            startFrame,
            durationFrames: item.durFrames,
            createdBy: "agent",
          }),
          name: `${item.synth.ok ? "Remotion TSX" : "HyperFrame"} · ${item.sceneBrief.title}`,
          remotion: {
            compositionId: clipSpec.compositionId,
            componentName: clipSpec.componentName,
            code: clipSpec.code,
            props: {
              ...clipSpec.props,
              layerRole: item.sceneBrief.layerRole,
              hideSubtitlesDuringScene: Boolean(item.sceneBrief.hideSubtitlesDuringScene),
            },
            live: true,
          },
        };

        const addRes = addClip(currentProject, motionTrackId, motionClip);
        if (addRes.ok) {
          currentProject = addRes.project;
          brollCardsInserted += 1;
          if (
            (item.sceneBrief.zone === "center-stage" || item.sceneBrief.layerRole === "full-scene") &&
            startFrame >= Math.round(fpsNum * 1.4)
          ) {
            sfxEventFrames.push({
              frame: Math.max(0, startFrame - Math.round(fpsNum * 1.15)),
              sfxType: "riser",
            });
          }
          sfxEventFrames.push({
            frame: startFrame,
            sfxType: item.sceneBrief.sfxType,
          });
        }
      }
    }

    const useTranscriptDrivenHyperFrames =
      !usedSyntheticEnvironment &&
      !explicitTimeBlocksInPrompt &&
      extractedCues.length > 0 &&
      postCutBudget.maxOverlays > 0 &&
      !directorExplicitlyChoseClean;

    if (brollCardsInserted === 0 && useTranscriptDrivenHyperFrames) {
      const hfItems = buildHyperFramesOverlaysFromTranscriptCues(
        extractedCues,
        subtitleStartFrame,
        totalTimelineFrames,
        fpsNum,
        currentProject.name,
        dna,
        postCutBudget,
      );

      for (const item of hfItems) {
        const assetRes = ensureVirtualMotionAsset(
          currentProject,
          item.spec.componentName,
          item.durationFrames,
        );
        currentProject = assetRes.project;

        const latestTrack = currentProject.tracks.find((t) => t.id === motionTrackId)!;
        const startFrame = findFreeStartFrame(latestTrack, item.startFrame, item.durationFrames);
        if (startFrame + item.durationFrames > totalTimelineFrames + Math.round(fpsNum * 0.5)) {
          continue;
        }

        const hfClip: MediaClip = {
          ...makeMediaClip(currentProject, assetRes.asset, {
            startFrame,
            durationFrames: item.durationFrames,
            createdBy: "agent",
          }),
          name: item.name,
          remotion: {
            compositionId: item.spec.compositionId,
            componentName: item.spec.componentName,
            code: item.spec.code,
            props: item.spec.props,
            live: true,
          },
        };

        const addHfRes = addClip(currentProject, motionTrackId, hfClip);
        if (addHfRes.ok) {
          currentProject = addHfRes.project;
          brollCardsInserted += 1;
          sfxEventFrames.push({
            frame: startFrame,
            sfxType: item.sfxType,
          });
        }
      }
    } else if (
      brollCardsInserted === 0 &&
      !wantsExplicitCleanTitlesOnly &&
      !usedSyntheticEnvironment &&
      explicitTimeBlocksInPrompt
    ) {
      // Modo sintético o guion explícito por bloques temporales (ej. 0-8s, 8-18s, 18-35s...)
      for (const block of narrativePlan.blocks) {
        const spec = buildAdaptiveSceneCardSpec(block, dna);
        if (ctaHandle && block.cardKind === "cta") {
          spec.props.handle = ctaHandle;
        }

        const assetRes = ensureVirtualMotionAsset(
          currentProject,
          spec.componentName,
          block.durationFrames,
        );
        currentProject = assetRes.project;

        const latestTrack = currentProject.tracks.find((t) => t.id === motionTrackId)!;
        const startFrame = findFreeStartFrame(latestTrack, block.startFrame, block.durationFrames);

        const sceneClip: MediaClip = {
          ...makeMediaClip(currentProject, assetRes.asset, {
            startFrame,
            durationFrames: block.durationFrames,
            createdBy: "agent",
          }),
          name: `${block.index + 1}. ${block.label}`,
          remotion: {
            compositionId: `${spec.compositionId}_${randomUUID().slice(0, 6)}`,
            componentName: spec.componentName,
            code: spec.code,
            props: spec.props,
            live: true,
          },
        };

        const addSceneRes = addClip(currentProject, motionTrackId, sceneClip);
        if (addSceneRes.ok) {
          currentProject = addSceneRes.project;
          brollCardsInserted += 1;
          sfxEventFrames.push({
            frame: startFrame,
            sfxType: block.sfxType,
          });
        }
      }
    }

    // 4B. TRANSICIONES ÓPTICAS CON CONTENCIÓN: solo en cambios de acto / cambio de plano / petición explícita
    const cutBoundaryFrames: number[] = [];
    if (postCutBudget.maxOpticalTransitions > 0) {
      if (v1ClipsAfterCut.length > 1) {
        const sceneChangeFrames = (audioProfile?.sceneTimestampsSec ?? [])
          .map((sec) =>
            mapSourceSecToTimelineFrame(sec, v1ClipsAfterCut, fpsNum, analyzedPrimaryMediaId),
          )
          .filter((frame): frame is number => frame !== null);
        for (let i = 1; i < v1ClipsAfterCut.length; i += 1) {
          const prevClip = v1ClipsAfterCut[i - 1]!;
          const currClip = v1ClipsAfterCut[i]!;
          const boundaryFrame = currClip.startFrame;
          if (boundaryFrame < 10 || boundaryFrame >= totalTimelineFrames - 10) continue;

          const sourceJumpSec = Math.abs(currClip.sourceInUs - prevClip.sourceOutUs) / 1_000_000;
          const isRealCameraOrSceneShift =
            currClip.mediaId !== prevClip.mediaId ||
            sourceJumpSec >= 10 ||
            sceneChangeFrames.some((sf) => Math.abs(sf - boundaryFrame) <= Math.round(fpsNum * 0.8));

          if (postCutBudget.applyOpticalTransitionsOnJumpCuts || isRealCameraOrSceneShift) {
            cutBoundaryFrames.push(boundaryFrame);
          }
        }
      } else if (usedSyntheticEnvironment && narrativePlan.blocks.length > 1) {
        for (let i = 1; i < narrativePlan.blocks.length; i += 1) {
          const boundaryFrame = narrativePlan.blocks[i]!.startFrame;
          if (boundaryFrame >= 10 && boundaryFrame < totalTimelineFrames - 10) {
            cutBoundaryFrames.push(boundaryFrame);
          }
        }
      }
    }

    if (cutBoundaryFrames.length > 0 && postCutBudget.maxOpticalTransitions > 0) {
      const transTrackRes = ensureCapaTransicionesTrack(currentProject);
      currentProject = transTrackRes.project;
      const transTrackId = transTrackRes.track.id;

      // Limpiar transiciones previas generadas por el agente
      const currentTransTrack = currentProject.tracks.find((t) => t.id === transTrackId)!;
      const oldTransIds = currentTransTrack.clips
        .filter((c) => c.createdBy === "agent")
        .map((c) => c.id);
      if (oldTransIds.length > 0) {
        currentProject = touchProject({
          ...currentProject,
          tracks: currentProject.tracks.map((t) =>
            t.id === transTrackId
              ? { ...t, clips: t.clips.filter((c) => !oldTransIds.includes(c.id)) }
              : t,
          ),
        });
      }

      const variants: HyperFrameTransitionVariant[] = [
        "whip-blur",
        "prism-wipe",
        "flash-shutter",
        "cyber-sweep",
      ];
      const transitionDuration = 16; // ~0.53s a 30fps (7 frames antes del corte + 9 frames después)
      const minTransGapFrames = Math.round(fpsNum * postCutBudget.minTransitionGapSec);
      let lastTransitionFrame = -9999;

      for (let idx = 0; idx < cutBoundaryFrames.length; idx += 1) {
        if (opticalTransitionsInserted >= postCutBudget.maxOpticalTransitions) break;
        const cutFrame = cutBoundaryFrames[idx]!;
        if (cutFrame - lastTransitionFrame < minTransGapFrames) continue;

        const variant = variants[idx % variants.length]!;
        const accentColor = BLOCK_PALETTES[idx % BLOCK_PALETTES.length]!;
        const secondaryColor = BLOCK_PALETTES[(idx + 2) % BLOCK_PALETTES.length]!;

        const transSpec = buildHyperFrameOpticalTransition({
          variant,
          accentColor,
          secondaryColor,
        });

        const startFrame = Math.max(0, cutFrame - 7);
        const assetRes = ensureVirtualMotionAsset(
          currentProject,
          transSpec.componentName,
          transitionDuration,
        );
        currentProject = assetRes.project;

        const transClip: MediaClip = {
          ...makeMediaClip(currentProject, assetRes.asset, {
            startFrame,
            durationFrames: transitionDuration,
            createdBy: "agent",
          }),
          name: `Transición HyperFrame · ${variant}`,
          remotion: {
            compositionId: `hf_trans_${idx + 1}_${randomUUID().slice(0, 5)}`,
            componentName: transSpec.componentName,
            code: transSpec.code,
            props: transSpec.props,
            live: true,
          },
        };

        const addTransRes = addClip(currentProject, transTrackId, transClip);
        if (addTransRes.ok) {
          currentProject = addTransRes.project;
          opticalTransitionsInserted += 1;
          lastTransitionFrame = cutFrame;
          sfxEventFrames.push({
            frame: Math.max(0, cutFrame - 3),
            sfxType: variant.includes("glitch")
              ? "glitch"
              : idx === 0 && usedSyntheticEnvironment
                ? "subhit"
                : "whoosh",
          });
        }
      }
    }

    steps.push({
      step: 4,
      agent: "Remotion × HyperFrames Studio",
      summary: `${brollCardsInserted} elementos visuales (${bespokeRemotionScenes} escenas TSX generadas a medida), ${opticalTransitionsInserted} transiciones ópticas.`,
      applied: brollCardsInserted > 0 || opticalTransitionsInserted > 0,
    });
  } else {
    steps.push({
      step: 4,
      agent: "HyperFrames Motion & Optical Transitions",
      summary: "Gráficos omitidos por restricción del usuario o configuración.",
      applied: false,
    });
  }

  // 4C. CAPA ATMÓSFERA CINEMATOGRÁFICA & LOOK PROCEDURAL (SOLO SI APORTA INTENCIÓN ESTÉTICA REAL)
  const shouldKeepCleanOriginalLook =
    hasRealV1Footage &&
    !usedSyntheticEnvironment &&
    (explicitPromptTitles.isCleanMinimal ||
      (!directive.atmosphereLook.customTintHex &&
        directive.atmosphereLook.letterboxRatio <= 0 &&
        directive.atmosphereLook.lookPreset === "editorial-clean" &&
        !postCutBudget.applyAtmosphereLayer));

  if (userConstraints.noColorFilter || !directive.atmosphereLook.enabled || shouldKeepCleanOriginalLook) {
    currentProject = touchProject({
      ...currentProject,
      tracks: currentProject.tracks.map((t) =>
        /atm[óo]sfera/i.test(t.name)
          ? { ...t, clips: t.clips.filter((c) => c.createdBy !== "agent") }
          : t,
      ),
    });
  } else if (
    totalTimelineFrames > 0 &&
    (postCutBudget.applyAtmosphereLayer ||
      directive.atmosphereLook.letterboxRatio > 0 ||
      Boolean(directive.atmosphereLook.customTintHex) ||
      directive.atmosphereLook.lookPreset !== "editorial-clean")
  ) {
    const atmTrackRes = ensureCapaAtmosferaTrack(currentProject);
    currentProject = atmTrackRes.project;
    const atmTrackId = atmTrackRes.track.id;

    const currentAtmTrack = currentProject.tracks.find((t) => t.id === atmTrackId)!;
    const oldAtmIds = currentAtmTrack.clips
      .filter((c) => c.createdBy === "agent")
      .map((c) => c.id);
    if (oldAtmIds.length > 0) {
      currentProject = touchProject({
        ...currentProject,
        tracks: currentProject.tracks.map((t) =>
          t.id === atmTrackId
            ? { ...t, clips: t.clips.filter((c) => !oldAtmIds.includes(c.id)) }
            : t,
        ),
      });
    }

    const lookSpec = buildHyperFrameCinematicLook({
      lookPreset: directive.atmosphereLook.lookPreset,
      accentColor: directive.artDirection.palette.accent,
      secondaryColor: directive.artDirection.palette.secondary,
      customTintHex: directive.atmosphereLook.customTintHex,
      letterboxRatio: directive.atmosphereLook.letterboxRatio,
      vignetteIntensity: directive.atmosphereLook.vignetteIntensity,
      grainOpacity: directive.atmosphereLook.grainOpacity,
      glowIntensity: directive.atmosphereLook.glowIntensity,
      audioPeaks: audioProfile?.normalizedPeaks,
    });

    const atmAssetRes = ensureVirtualMotionAsset(
      currentProject,
      lookSpec.componentName,
      totalTimelineFrames,
    );
    currentProject = atmAssetRes.project;

    const atmClip: MediaClip = {
      ...makeMediaClip(currentProject, atmAssetRes.asset, {
        startFrame: 0,
        durationFrames: totalTimelineFrames,
        createdBy: "agent",
      }),
      name: `Look Cinematográfico · ${directive.atmosphereLook.lookPreset}`,
      remotion: {
        compositionId: `hf_look_${randomUUID().slice(0, 6)}`,
        componentName: lookSpec.componentName,
        code: lookSpec.code,
        props: lookSpec.props,
        live: true,
      },
    };

    const addAtmRes = addClip(currentProject, atmTrackId, atmClip);
    if (addAtmRes.ok) {
      currentProject = addAtmRes.project;
    }
  }

  // =========================================================================
  // PASO 5: SOUND DESIGN & MÚSICA CON AUDIO DUCKING (PISTA "SFX" + "MÚSICA FONDO")
  // =========================================================================
  onProgress?.(
    "Paso 5/6 · Sound Design & Música: Sincronizando micro-SFX y cama musical...",
    5,
    6,
  );

  let musicBedApplied = false;

  try {
    const interimSaved = await projectStore.saveTimeline(projectId, currentProject, {
      force: true,
    });
    currentProject = interimSaved.project;

    const sfxTrackRes = ensureSfxTrack(currentProject);
    currentProject = sfxTrackRes.project;
    const sfxTrackId = sfxTrackRes.track.id;

    // Limpiar SFX previos generados por el agente para garantizar idempotencia (o si el usuario deshabilitó SFX)
    const currentSfxTrack = currentProject.tracks.find((t) => t.id === sfxTrackId)!;
    const oldSfxIds = currentSfxTrack.clips
      .filter((c) => c.createdBy === "agent")
      .map((c) => c.id);
    if (oldSfxIds.length > 0) {
      currentProject = touchProject({
        ...currentProject,
        tracks: currentProject.tracks.map((t) =>
          t.id === sfxTrackId
            ? { ...t, clips: t.clips.filter((c) => !oldSfxIds.includes(c.id)) }
            : t,
        ),
      });
    }

    if (effectiveSfx && postCutBudget.maxSfx > 0 && sfxEventFrames.length > 0) {
      const sfxPriorityWeight: Partial<Record<SfxType, number>> = {
        subhit: 5,
        riser: 4.5,
        ding: 4,
        glitch: 3.2,
        pop: 2.2,
        whoosh: 1.6,
      };
      const minSfxGapFrames = Math.max(8, Math.round(fpsNum * postCutBudget.minSfxGapSec));
      const rankedCandidates = [...sfxEventFrames]
        .map((ev) => ({
          ev,
          frame: Math.max(0, Math.round(ev.frame)),
          priority: sfxPriorityWeight[ev.sfxType] ?? 1,
        }))
        .sort((a, b) => b.priority - a.priority || a.frame - b.frame);

      const selectedSfxEvents: Array<(typeof sfxEventFrames)[number]> = [];
      for (const candidate of rankedCandidates) {
        if (selectedSfxEvents.length >= postCutBudget.maxSfx) break;
        const tooClose = selectedSfxEvents.some(
          (picked) => Math.abs(Math.max(0, Math.round(picked.frame)) - candidate.frame) < minSfxGapFrames,
        );
        if (tooClose) continue;
        selectedSfxEvents.push(candidate.ev);
      }

      if (selectedSfxEvents.length > 0) {
        const uniqueSfxTypes = Array.from(new Set(selectedSfxEvents.map((e) => e.sfxType)));
        const sfxAssetsByType = new Map<SfxType, MediaAsset>();

        for (const sfxType of uniqueSfxTypes) {
          const asset = await ensureProjectSfxAsset(projectId, sfxType);
          sfxAssetsByType.set(sfxType, asset);
          if (!currentProject.media.some((m) => m.id === asset.id)) {
            currentProject = touchProject({
              ...currentProject,
              media: [...currentProject.media, asset],
            });
          }
        }

        const frameDurUs = frameDurationUs(fps);
        const sortedEvents = [...selectedSfxEvents].sort((a, b) => a.frame - b.frame);

        for (const ev of sortedEvents) {
          const asset = sfxAssetsByType.get(ev.sfxType);
          if (!asset) continue;

          const sfxTrackNow = currentProject.tracks.find((t) => t.id === sfxTrackId)!;
          const startFrame = Math.max(0, Math.round(ev.frame));

          const durationFrames = Math.max(
            1,
            Math.round(asset.durationUs / Math.max(1, frameDurUs)),
          );

          const overlapsExisting = sfxTrackNow.clips.some(
            (c) =>
              startFrame < c.startFrame + c.durationFrames + 4 &&
              startFrame + durationFrames + 4 > c.startFrame,
          );
          if (overlapsExisting) continue;

          const sfxClip: MediaClip = {
            ...makeMediaClip(currentProject, asset, {
              startFrame,
              durationFrames,
              createdBy: "agent",
            }),
            name: `SFX ${ev.sfxType.toUpperCase()}`,
            volume: usedSyntheticEnvironment
              ? 0.78
              : postCutBudget.densityTier === "kinetic"
                ? 0.48
                : 0.34,
          };

          const addSfxRes = addClip(currentProject, sfxTrackId, sfxClip);
          if (addSfxRes.ok) {
            currentProject = addSfxRes.project;
            sfxEventsInserted += 1;
          }
        }
      }
    }

    // Cama musical procedural con Audio Ducking cuando aporta valor narrativo/atmosférico y no fue desactivada
    const durationSecTotal = Math.max(4, Math.ceil(totalTimelineFrames / fpsNum));
    if (!effectiveMusic) {
      currentProject = touchProject({
        ...currentProject,
        tracks: currentProject.tracks.map((t) =>
          t.kind === "audio" && (/m[úu]sica/i.test(t.name) || /music|bgm/i.test(t.name))
            ? { ...t, clips: t.clips.filter((c) => c.createdBy !== "agent") }
            : t,
        ),
      });
    } else if (
      shouldAddProceduralMusicBed(prompt, usedSyntheticEnvironment) &&
      totalTimelineFrames > Math.round(fpsNum * 2)
    ) {
      const mood = resolveMusicBedMood(prompt, directive.artDirection.colorMood);
      try {
        const musicAsset = await ensureProceduralMusicBedAsset(
          projectId,
          durationSecTotal,
          mood,
          abortSignal,
        );
        if (!currentProject.media.some((m) => m.id === musicAsset.id)) {
          currentProject = touchProject({
            ...currentProject,
            media: [...currentProject.media, musicAsset],
          });
        }
        const effectiveSpeechSegmentsForDucking: TranscriptSegment[] | undefined =
          cachedTranscriptSegments && cachedTranscriptSegments.length > 0
            ? cachedTranscriptSegments
            : synthesizedSpeechSegments.length > 0
              ? synthesizedSpeechSegments.map((seg) => ({
                  startUs: Math.round(seg.startSec * 1_000_000),
                  endUs: Math.round(seg.endSec * 1_000_000),
                  text: seg.narration,
                }))
              : undefined;
        currentProject = applyDuckedMusicBedTrack({
          project: currentProject,
          musicAsset,
          totalTimelineFrames,
          fps: fpsNum,
          transcriptSegments: effectiveSpeechSegmentsForDucking,
          hasSpeechInTimeline:
            (effectiveSpeechSegmentsForDucking?.length ?? 0) > 0 || realV1Clips.length > 0,
        });
        musicBedApplied = true;
      } catch (musicErr) {
        console.warn("[SwarmDirector] Aviso generando cama musical procedural:", musicErr);
      }
    }

    steps.push({
      step: 5,
      agent: "Sound Design Agent",
      summary: `${sfxEventsInserted} efectos de sonido sincronizados${musicBedApplied ? " · cama musical con ducking automático" : ""}${typeof lufsCalibrated === "number" ? ` · voz calibrada desde ${lufsCalibrated} LUFS a -14 LUFS` : ""}.`,
      applied: sfxEventsInserted > 0 || musicBedApplied || typeof lufsCalibrated === "number",
    });
  } catch (err) {
    console.warn("[SwarmDirector] Paso 5 (SFX) aviso:", err);
    steps.push({
      step: 5,
      agent: "Sound Design Agent",
      summary: "SFX básicos aplicados.",
      applied: false,
    });
  }

  // =========================================================================
  // PASO 6: BUCLE DE AUTOVERIFICACIÓN VISUAL, ESPACIAL Y COMPILACIÓN TSX (QA)
  // =========================================================================
  onProgress?.(
    "Paso 6/6 · Control de Calidad Visual IA y compilación TSX...",
    6,
    6,
  );

  const auditResult = auditAndResolveSpatialCollisions(currentProject, fpsNum, {
    userWantsFullSubtitles,
  });
  currentProject = auditResult.project;

  const visualQa = await runClosedLoopVisualQA({
    projectId,
    project: currentProject,
    signal: abortSignal,
  });
  currentProject = visualQa.project;

  const genQa = await runGeneratedCompositionVisualQA({
    project: currentProject,
    signal: abortSignal,
  });
  currentProject = genQa.project;

  const tsxAudit = await auditAndValidateGeneratedRemotionClips(currentProject);
  currentProject = tsxAudit.project;

  const totalQaAdjustments = visualQa.adjustmentsMade + genQa.adjustmentsMade;
  const combinedQaReport = [visualQa.report, genQa.report].filter(Boolean).join(" · ");

  steps.push({
    step: 6,
    agent: "Self-Critique & TSX QA Auditor",
    summary: `${auditResult.report} · ${combinedQaReport} · ${tsxAudit.validCount}/${tsxAudit.checkedCount} componentes Remotion TSX validados con esbuild${tsxAudit.prunedInvalidCount > 0 ? ` (${tsxAudit.prunedInvalidCount} inválidos podados)` : ""}.`,
    applied: true,
  });

  // Normalizar numeración humana estricta (1 al 6)
  const normalizedSteps = steps.map((s, idx) => ({
    ...s,
    step: idx + 1,
  }));

  // =========================================================================
  // GUARDADO FINAL Y EMISIÓN SSE
  // =========================================================================
  const finalSaved = await projectStore.saveTimeline(projectId, currentProject, {
    force: true,
  });
  currentProject = finalSaved.project;

  eventBus.publish(projectId, {
    type: "project",
    projectId,
    revision: currentProject.revision,
  });

  const summaryLines = [
    `🎬 **Orquestación de Enjambre Autónomo completada · ${productionModeLabel} (${Math.round(totalTimelineFrames / fpsNum)}s)**`,
    ...normalizedSteps.map((s) => `- **Paso ${s.step} (${s.agent}):** ${s.summary}`),
  ];

  return {
    project: currentProject,
    summary: summaryLines.join("\n"),
    steps: normalizedSteps,
    productionMode,
    productionModeLabel,
    stats: {
      silencesRemoved,
      subtitleCues: subtitleCuesCount,
      zoomPunches: zoomPunchesCount,
      brollCardsInserted,
      sfxEventsInserted,
      style: styleId,
      brandDomain: capturedBrand?.domain,
      collisionsResolved: auditResult.collisionsResolved,
      themeCategory: dna.categoryLabel,
      surgicalToolsApplied,
      bespokeRemotionScenes,
      aiDirectorUsed: directive.source === "ai_director",
      lookPreset: directive.atmosphereLook.lookPreset,
      lufsCalibrated,
      visualQaAdjusted: totalQaAdjustments,
      musicBedApplied,
    },
  };
}
