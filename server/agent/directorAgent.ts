import path from "node:path";
import { config } from "../config";
import { eventBus } from "../events";
import { aiStatus } from "../ai/provider";
import { computeSafeRemotionConcurrency, remotionEngineAvailable } from "../media/remotion";
import { jobQueue } from "../jobs";
import { projectStore } from "../projects/store";
import { skillRegistry } from "../skills/registry";
import { buildSignedDownloadPath } from "../services/downloadTokenService";
import { startExport, verifyExport } from "../services/exportService";
import { fpsValue, framesToSeconds, secondsToFrames } from "../../src/shared/time";
import { dimensionsFor } from "../../src/shared/presets";
import { timelineDurationFrames } from "../../src/shared/project";
import type { MediaClip, Project } from "../../src/shared/schema";

type AspectRatio = Project["settings"]["aspect"];
import {
  buildPolymorphicProceduralSceneCode,
  detectSceneVisualArchetype,
  extractAllLiteralSceneCopy,
  isConversationalInstructionText,
  isStructuralSceneLabel,
} from "./autonomousEditorBrain";
import {
  buildTimelineQaReport,
  generateContactSheet,
  renderTimelineFrames,
  type RenderedFrameInfo,
  type TimelineQaReport,
} from "./perception";

/**
 * Prompt de sistema oficial del Agente Director de OECLIP (Apéndice 1, Prompt Maestro v2).
 */
export const DIRECTOR_SYSTEM_PROMPT = `Eres el Agente Director de OECLIP, un estudio de video con IA. Tu trabajo es
crear y editar videos exactamente como los pide el cliente, de forma autónoma,
y entregar un resultado que hayas comprobado tú mismo.

IDENTIDAD Y TONO
- Hablas en el idioma del cliente. Eres claro, cálido y profesional; breve en el
  chat, riguroso en el trabajo. No presumes ni rellenas.
- Tratas al cliente como un adulto capaz. Si algo no es posible o no es buena
  idea, lo dices con respeto y propones una alternativa.

CÓMO TRABAJAS (bucle obligatorio)
1. Entiende el encargo: duración, formato, escenas, textos literales, tono,
   plataforma, material adjunto. Los textos que el cliente da entre comillas o
   como copy exacto se usan SIN modificar.
2. Llama a get_capabilities para saber qué tienes realmente (voz, imágenes,
   transcripción, GPU, skills). No prometas nada que no esté disponible.
3. Si falta algo imprescindible, haz como máximo UNA ronda de preguntas cortas.
   Todo lo demás: asume con criterio y dilo en una línea ("Asumo voz masculina
   neutra y música suave; dime si prefieres otra").
4. Busca skills con list_skills y LEE las relevantes (get_skill) ANTES de usar
   herramientas de edición. Combina varias si hace falta.
5. Escribe un plan visible (tareas) y un storyboard con tiempos y textos
   literales. En modo asistido espera aprobación; en autónomo continúa.
6. Ejecuta con las herramientas. Prefiere lotes transaccionales y crea un
   checkpoint antes de cambios grandes.
7. MIRA Y ESCUCHA lo que produjiste: render_frames/contact_sheet, inspect_frame,
   get_transcript, audio_metrics y qa_report. Compara con el storyboard.
8. Corrige hasta cumplir. Máximo 3 ciclos de corrección; si algo no se logra,
   dilo con claridad en lugar de entregar algo a medias.
9. Exporta, ejecuta verify_export y entrega: el video, un resumen de 2–4 líneas
   de lo que hiciste, lo que asumiste, y 2–3 ajustes que el cliente podría pedir.

REGLAS DE HONESTIDAD (no negociables)
- Nunca digas "listo" sin haber verificado el resultado con evidencia.
- Si una herramienta devuelve status "fallback", "unverified" o "failed", NO lo
  presentes como éxito. Repórtalo y corrígelo o explícalo.
- Nunca entregues placeholders: nombres internos de clips, cajas vacías, lorem
  ipsum, fondos sin contenido donde se esperaba contenido.
- Si cometes un error, lo reconoces en una frase, lo corriges y sigues.
- No inventes capacidades, datos, cifras, citas ni métricas del cliente.

CALIDAD MÍNIMA EN TODA ENTREGA
- Duración y formato exactos a lo pedido. Textos literales presentes y legibles
  en su ventana de tiempo. Contraste suficiente, zonas seguras respetadas.
- Audio sin clipping y a ~ -14 LUFS; música bajo la voz; subtítulos sincronizados
  (≤ 100 ms) y sin palabras inventadas.
- Ritmo: nada estático demasiado tiempo; transiciones coherentes con el estilo.

AUTONOMÍA Y SEGURIDAD
- Respeta el modo de autonomía elegido. En cualquier modo, pide confirmación
  antes de acciones destructivas o irreversibles (borrar proyectos, sobrescribir
  exportaciones, enviar datos a proveedores externos).
- Usa solo música, imágenes y fuentes con licencia verificable o aportadas por el
  cliente. No clones voces ni rostros de personas reales sin consentimiento
  explícito de la persona. Marca contenido sintético cuando corresponda.
- No crees contenido engañoso dañino, de acoso, ni que sexualice a menores.

FORMA DE RESPONDER
- Mientras trabajas, informa de forma escueta qué haces ("Renderizando la escena
  2 y revisando los subtítulos"). Sin párrafos largos.
- Al terminar, muestra la hoja de contactos como evidencia y ofrece ajustes.
- Si el cliente se queja, no te pongas a la defensiva: pregunta qué no cumple,
  corrige y vuelve a verificar.

APRENDIZAJE
- Si un flujo se repite o funciona especialmente bien, ofrece guardarlo como
  skill (create_skill) con descripción, pasos y un caso de prueba que pase.`;

export type DirectorAutonomy = "assisted" | "semi" | "autonomous";
export type DirectorStatus = "verified" | "unverified" | "fallback" | "failed";

export interface DirectorStoryboardScene {
  sceneIndex: number;
  label: string;
  startSec: number;
  durationSec: number;
  visualPrompt: string;
  narration?: string;
  literalTexts: string[];
  ctaText?: string;
}

export interface DirectorTaskItem {
  id: string;
  title: string;
  status: "completed" | "failed" | "skipped" | "pending";
  detail?: string;
}

export interface DirectorStoryboardInputScene {
  sceneIndex?: number;
  label?: string;
  title?: string;
  startSec?: number;
  durationSec?: number;
  visualPrompt?: string;
  prompt?: string;
  narration?: string;
  literalTexts?: string[];
  ctaText?: string;
}

export interface DirectorAgentOptions {
  projectId: string;
  request: string;
  autonomy?: DirectorAutonomy;
  exportOnComplete?: boolean;
  allowFallback?: boolean;
  strict?: boolean;
  quality?: "draft" | "standard" | "high";
  storyboard?: DirectorStoryboardInputScene[];
  signal: AbortSignal;
  onProgress?: (progress: number, message?: string) => void;
}

export interface DirectorAgentResult {
  status: DirectorStatus;
  summary: string;
  warnings: string[];
  verification: {
    checks: Array<{ name: string; passed: boolean; detail?: string }>;
    evidence: string[];
  };
  storyboard: DirectorStoryboardScene[];
  qaReport?: TimelineQaReport;
  frames?: RenderedFrameInfo[];
  contactSheetPath?: string;
  loadedSkills?: Array<{ id: string; version: string; reason: string }>;
  tasks?: DirectorTaskItem[];
  exportResult?: {
    exportId: string;
    status: string;
    outputFile?: string | null;
    downloadUrl?: string;
    verification?: unknown;
  };
  runTrace?: Record<string, unknown>;
  assumptions: string[];
  suggestedAdjustments: string[];
  revision: number;
}

interface ParsedDirectorSpec {
  aspectRatio: AspectRatio;
  targetDurationSec: number | undefined;
  wantsVoiceover: boolean;
  wantsMusic: boolean;
  wantsSubtitles: boolean;
  wantsSilenceRemoval: boolean;
  wantsSfx: boolean;
  musicMood: "cinema" | "tech" | "ambient" | "energetic";
  language: "es" | "en";
  accentColor: string;
  allLiterals: string[];
  ctaText?: string;
  scenes: DirectorStoryboardScene[];
}

function detectRequestedAspect(request: string, current: AspectRatio): AspectRatio {
  const lower = request.toLowerCase();
  if (/\b9\s*:\s*16\b|\bvertical\b|\breel\b|\bshorts\b|\btiktok\b|\b1080\s*x\s*1920\b/i.test(lower)) {
    return "9:16";
  }
  if (/\b16\s*:\s*9\b|\bhorizontal\b|\byoutube\b|\b1920\s*x\s*1080\b/i.test(lower)) {
    return "16:9";
  }
  if (/\b1\s*:\s*1\b|\bcuadrado\b|\b1080\s*x\s*1080\b/i.test(lower)) {
    return "1:1";
  }
  if (/\b4\s*:\s*5\b|\bfeed instagram\b|\b1080\s*x\s*1350\b/i.test(lower)) {
    return "4:5";
  }
  if (/\b21\s*:\s*9\b|\bcinematográfico wide\b/i.test(lower)) {
    return "21:9";
  }
  return current;
}

function detectRequestedDuration(request: string): number | undefined {
  const match = request.match(/\b(\d+(?:[.,]\d+)?)\s*(?:s|seg|segundos|sec|seconds)\b/i);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1]!.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 2 || parsed > 180) return undefined;
  return parsed;
}

function extractBalancedQuotes(text: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const clean = raw.replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 2) return;
    if (isStructuralSceneLabel(clean) || isConversationalInstructionText(clean)) return;
    if (!seen.has(clean)) {
      seen.add(clean);
      results.push(clean);
    }
  };

  for (const m of text.matchAll(/[«"“]([^"”»]{2,180})[»"”]/g)) {
    add(m[1] ?? "");
  }
  for (const m of text.matchAll(/(?:^|[\s:(,])'([^']{2,140})'(?=$|[\s.,;:!?])/g)) {
    add(m[1] ?? "");
  }
  return results;
}

function inferCtaFromStrings(items: string[], rawText: string): string | undefined {
  const ctaPattern = /\b(pru[eé]balo|prueba|descarga|empieza|comienza|reg[ií]strate|visita|compra|agenda|demo|cta|try now|get started|learn more|download)\b/i;
  for (let i = items.length - 1; i >= 0; i--) {
    if (ctaPattern.test(items[i]!)) return items[i];
  }
  const explicitCta = rawText.match(/(?:bot[oó]n|cta|cierre)\s+(?:con|que diga|:)\s+[«"'“]([^«»"'”]{2,100})[»"'”]/i);
  if (explicitCta?.[1]) return explicitCta[1].trim();
  return undefined;
}

function splitPromptSections(request: string): {
  visualText: string;
  audioText: string;
  rulesText: string;
} {
  const visualLines: string[] = [];
  const audioLines: string[] = [];
  const rulesLines: string[] = [];
  let mode: "visual" | "audio" | "rules" = "visual";

  for (const rawLine of request.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (mode === "audio") audioLines.push("");
      else if (mode === "rules") rulesLines.push("");
      else visualLines.push("");
      continue;
    }

    const audioHeader = trimmed.match(
      /^(?:#+\s*)?(?:[-*•]\s*)?(?:audio(?:\s+y\s+subt[ií]tulos)?|locuci[oó]n(?:\s+y\s+m[uú]sica)?|voz\s+en\s+off|m[uú]sica(?:\s+y\s+sfx)?|audio\s*&\s*captions)\s*:(.*)$/i,
    );
    if (audioHeader) {
      mode = "audio";
      if (audioHeader[1]?.trim()) audioLines.push(audioHeader[1].trim());
      continue;
    }

    const rulesHeader = trimmed.match(
      /^(?:#+\s*)?(?:[-*•]\s*)?(?:reglas?(?:\s+estrictas|\s+generales)?|restricciones|requisitos(?:\s+t[eé]cnicos)?|criterios\s+de\s+calidad|entrega|condiciones)\s*:(.*)$/i,
    );
    if (rulesHeader) {
      mode = "rules";
      if (rulesHeader[1]?.trim()) rulesLines.push(rulesHeader[1].trim());
      continue;
    }

    const visualHeader = trimmed.match(
      /^(?:#+\s*)?(?:estructura(?:\s+obligatoria)?|escenas?|guion\s+visual|storyboard|secuencia)\b[^:]*:(.*)$/i,
    );
    if (visualHeader) {
      mode = "visual";
      if (visualHeader[1]?.trim()) visualLines.push(visualHeader[1].trim());
      continue;
    }

    if (mode === "audio") audioLines.push(rawLine);
    else if (mode === "rules") rulesLines.push(rawLine);
    else visualLines.push(rawLine);
  }

  return {
    visualText: visualLines.join("\n").trim(),
    audioText: audioLines.join("\n").trim(),
    rulesText: rulesLines.join("\n").trim(),
  };
}

function splitExplicitSceneSegments(visualText: string): Array<{
  sceneNumber: number;
  label: string;
  startSec?: number;
  durationSec?: number;
  body: string;
}> {
  // 1. Intentar formato clásico explícito ("Escena 1 (0-6 s) · Gancho: ...")
  const sceneHeaderRegex =
    /(?:^|\n|[.;])\s*(?:escena|scene|acto|bloque)\s*(\d+)\s*(?:\(\s*(\d+(?:[.,]\d+)?)\s*[-–a]+\s*(\d+(?:[.,]\d+)?)\s*(?:s|seg|segundos|sec)?\s*\))?\s*(?:[,·:-]\s*([a-zA-ZáéíóúñÁÉÍÓÚÑ0-9 ]{2,24}))?\s*[:.-]/gi;

  const explicitMatches = [...visualText.matchAll(sceneHeaderRegex)];
  if (explicitMatches.length >= 2) {
    const segments: Array<{
      sceneNumber: number;
      label: string;
      startSec?: number;
      durationSec?: number;
      body: string;
    }> = [];

    for (let i = 0; i < explicitMatches.length; i++) {
      const cur = explicitMatches[i]!;
      const startIdx = (cur.index ?? 0) + cur[0].length;
      const endIdx = i + 1 < explicitMatches.length ? (explicitMatches[i + 1]!.index ?? visualText.length) : visualText.length;
      const rawBody = visualText.slice(startIdx, endIdx).trim();
      const num = Number.parseInt(cur[1] ?? `${i + 1}`, 10) || i + 1;
      const t0 = cur[2] ? Number.parseFloat(cur[2].replace(",", ".")) : undefined;
      const t1 = cur[3] ? Number.parseFloat(cur[3].replace(",", ".")) : undefined;
      const tag = cur[4]?.trim();
      const durationSec =
        t0 !== undefined && t1 !== undefined && t1 > t0 ? Number((t1 - t0).toFixed(3)) : undefined;
      segments.push({
        sceneNumber: num,
        label: tag ? `Escena ${num} · ${tag}` : `Escena ${num}`,
        startSec: t0,
        durationSec,
        body: rawBody,
      });
    }
    return segments;
  }

  // 2. Parser de viñetas y sub-beats por rango horario ("- 0–3 s · Gancho:", "· 8–11 s:", etc.)
  type TimedLineSeg = {
    t0: number;
    t1: number;
    tag?: string;
    bodyLines: string[];
  };
  const rangeLineRegex =
    /^\s*(?:[-*•·+]|\d+[.)])?\s*(?:(?:escena|scene|acto|bloque|parte)\s*\d*\s*(?:[:·\-–—]\s*)?)?(?:\(\s*)?(\d+(?:[.,]\d+)?)\s*(?:s|seg|segundos|sec)?\s*(?:[-–—]|a|to)\s*(\d+(?:[.,]\d+)?)\s*(?:s|seg|segundos|sec)\s*\)?(?:\s*[·:\-–—]\s*([^:"“«\n]{2,56}))?(?:\s*[:.-]\s*(.*)|\s+(.*))?$/i;

  const timedItems: TimedLineSeg[] = [];
  for (const rawLine of visualText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const m = trimmed.match(rangeLineRegex);
    if (m) {
      const t0 = Number.parseFloat(m[1]!.replace(",", "."));
      const t1 = Number.parseFloat(m[2]!.replace(",", "."));
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 && t1 <= 600) {
        const rawTag = m[3]?.replace(/\s*\([^)]*\)\s*$/g, "").trim();
        const bodyTail = (m[4] ?? m[5] ?? "").trim();
        timedItems.push({
          t0,
          t1,
          tag: rawTag || undefined,
          bodyLines: bodyTail ? [bodyTail] : [],
        });
        continue;
      }
    }
    if (timedItems.length > 0 && !/^(?:estructura|duraci[oó]n|formato|audiencia)\b[^:]*:/i.test(trimmed)) {
      timedItems[timedItems.length - 1]!.bodyLines.push(trimmed);
    }
  }

  if (timedItems.length >= 2) {
    // Filtrar nodos contenedores padre cuando están subdivididos en >= 2 sub-beats hijos (ej: 8-17 s -> 8-11, 11-14, 14-17)
    const leafItems = timedItems.filter((item, idx) => {
      const children = timedItems.filter(
        (other, otherIdx) =>
          otherIdx !== idx &&
          other.t0 >= item.t0 - 0.05 &&
          other.t1 <= item.t1 + 0.05 &&
          other.t1 - other.t0 < item.t1 - item.t0 - 0.05,
      );
      return children.length < 2;
    });

    leafItems.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
    return leafItems.map((item, idx) => {
      const num = idx + 1;
      const body = item.bodyLines.join(" ").trim();
      const durationSec = Number((item.t1 - item.t0).toFixed(3));
      return {
        sceneNumber: num,
        label: item.tag ? `Escena ${num} · ${item.tag}` : `Escena ${num}`,
        startSec: item.t0,
        durationSec,
        body: item.tag ? `${item.tag}: ${body}`.trim() : body,
      };
    });
  }

  if (explicitMatches.length === 1) {
    const cur = explicitMatches[0]!;
    const startIdx = (cur.index ?? 0) + cur[0].length;
    const t0 = cur[2] ? Number.parseFloat(cur[2].replace(",", ".")) : undefined;
    const t1 = cur[3] ? Number.parseFloat(cur[3].replace(",", ".")) : undefined;
    const tag = cur[4]?.trim();
    return [
      {
        sceneNumber: 1,
        label: tag ? `Escena 1 · ${tag}` : "Escena 1",
        startSec: t0,
        durationSec: t0 !== undefined && t1 !== undefined && t1 > t0 ? Number((t1 - t0).toFixed(3)) : undefined,
        body: visualText.slice(startIdx).trim(),
      },
    ];
  }

  return [];
}

function sanitizeScenePromptForMotion(
  rawBody: string,
  literalTexts: string[],
  ctaText: string | undefined,
  sceneRole: "hook" | "demo" | "close",
  accentColor: string,
): string {
  const cleanDirectives = rawBody.replace(/\s+/g, " ").trim();
  const missingFromDirectives = literalTexts.filter(
    (t) => !cleanDirectives.toLowerCase().includes(t.toLowerCase()),
  );
  const quotedPart = missingFromDirectives.map((t) => `"${t}"`).join(" | ");
  const parts: string[] = [];

  if (cleanDirectives) {
    parts.push(cleanDirectives);
  }
  if (quotedPart) {
    parts.push(`Copy en pantalla: ${quotedPart}.`);
  }
  if (ctaText && !cleanDirectives.toLowerCase().includes(ctaText.toLowerCase())) {
    parts.push(`Botón CTA: "${ctaText}".`);
  }
  if (sceneRole === "hook") {
    parts.push(`Estilo apertura de alto impacto, paleta oscura (${accentColor}), contraste WCAG >= 4.5:1, márgenes seguros 9:16.`);
  } else if (sceneRole === "demo") {
    parts.push(`Estilo demostración animada e interfaz en movimiento, paleta oscura (${accentColor}), contraste WCAG >= 4.5:1, márgenes seguros 9:16.`);
  } else {
    parts.push(`Estilo cierre limpio con propuesta de valor y botón CTA en zona segura, paleta oscura (${accentColor}), contraste WCAG >= 4.5:1.`);
  }
  return parts.join(" ");
}

function trimCleanSentences(text: string, maxWords: number): string {
  const clean = text.replace(/\s+/g, " ").replace(/\.{2,}$/, "").trim();
  if (!clean) return "";
  const words = clean.split(" ");
  if (words.length <= maxWords) return clean;
  // Recortar en frontera de oración o frase sin dejar cortes abruptos ni ".."
  const clauses = clean.split(/(?<=[.!?])\s+/);
  let built = "";
  for (const clause of clauses) {
    const candidate = built ? `${built} ${clause}` : clause;
    if (candidate.split(/\s+/).length <= maxWords) {
      built = candidate;
    } else {
      break;
    }
  }
  if (built) return built.trim();
  return words.slice(0, maxWords).join(" ").replace(/[,;:\-]+$/, "");
}

function buildCompactNarration(
  literalTexts: string[],
  sceneRole: "hook" | "demo" | "close",
  language: "es" | "en",
  durationSec: number,
  body: string,
): string {
  const explicitVoiceMatch = body.match(/(?:voz|locuci[oó]n|narraci[oó]n)\s*:\s*[«"“]([^"”»]{3,220})[»"”]/i);
  if (explicitVoiceMatch?.[1]) {
    return explicitVoiceMatch[1].replace(/\s+/g, " ").trim();
  }

  const maxWords = Math.max(8, Math.ceil(durationSec * 3.1));

  if (literalTexts.length > 0) {
    const cleanItems = literalTexts
      .map((t) => t.replace(/[·•|]+/g, ",").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0 && t.length <= 120);
    if (cleanItems.length > 0) {
      const joined = cleanItems
        .map((s) => (/[.!?]$/.test(s) ? s : `${s}.`))
        .join(" ");
      const trimmed = trimCleanSentences(joined, maxWords);
      if (trimmed) return trimmed;
    }
  }
  if (/l[ií]nea de tiempo|cortes inteligentes|subt[ií]tulos|karaoke|timeline/i.test(body)) {
    return language === "en"
      ? "Smart cuts, Remotion motion and synced captions."
      : "Cortes inteligentes, gráficos en Remotion y subtítulos sincronizados.";
  }
  if (sceneRole === "hook") {
    return language === "en"
      ? "Turn ideas into ready-to-post videos in seconds."
      : "Transforma ideas en videos listos para publicar en segundos.";
  }
  if (sceneRole === "demo") {
    return language === "en"
      ? "Edit effortlessly with AI precision."
      : "Edición fluida con inteligencia artificial y movimiento dinámico.";
  }
  return language === "en" ? "Create without rigid templates. Try it now." : "Crea sin plantillas rígidas. Pruébalo ahora.";
}

function parseDirectorRequest(
  request: string,
  project: Project,
  hasUploadedVideo: boolean,
  overrideStoryboard?: DirectorStoryboardInputScene[],
): ParsedDirectorSpec {
  const lower = request.toLowerCase();
  const sections = splitPromptSections(request);
  const visualSource = sections.visualText || request;
  const aspectRatio = detectRequestedAspect(request, project.settings.aspect);
  const explicitDuration = detectRequestedDuration(request);
  const explicitSegments = splitExplicitSceneSegments(visualSource);

  const wantsNoVoice = /\b(sin voz|sin locución|solo visual|mute|mudo|no voice)\b/i.test(lower);
  const wantsNoMusic = /\b(sin música|sin musica|no music)\b/i.test(lower);
  const wantsVoiceover =
    !wantsNoVoice &&
    (/\b(voz|locuci[oó]n|narraci[oó]n|tts|hablado|hablada|voiceover)\b/i.test(lower) ||
      (/\b(subt[ií]tulos|karaoke|sincronizados)\b/i.test(lower) && !hasUploadedVideo));
  const wantsMusic =
    !wantsNoMusic &&
    (/\b(m[uú]sica|music|beat|banda sonora|lanzamiento|reel|anuncio|spot)\b/i.test(lower) || !hasUploadedVideo);
  const wantsSubtitles =
    /\b(subt[ií]tulos|subtitulos|captions|karaoke|sincronizados)\b/i.test(lower);
  const wantsSilenceRemoval = /\b(silencios|silencio|pausas|muletillas|jump ?cuts)\b/i.test(lower);
  const wantsSfx = !wantsNoMusic && /\b(sfx|efectos de sonido|whoosh|pop|transiciones|reel|lanzamiento)\b/i.test(lower);

  const musicMood: ParsedDirectorSpec["musicMood"] = /\b(cinem|documental|épico|dramát)\b/i.test(lower)
    ? "cinema"
    : /\b(enérg|energetic|deporte|fitness|dinámico rápido|promo)\b/i.test(lower)
      ? "energetic"
      : /\b(suave|ambient|calma|minimal|podcast)\b/i.test(lower)
        ? "ambient"
        : "tech";

  const language: "es" | "en" =
    /\b(in english|english voice|english version)\b/i.test(lower) ||
    (!/[áéíóúñ¿¡]/i.test(request) && /\b(the|and|with|scene|launch|create a)\b/i.test(lower) && !/\b(para|con|escena|crea|video|reel)\b/i.test(lower))
      ? "en"
      : "es";

  const hexMatch = request.match(/#[0-9a-fA-F]{6}\b/);
  const accentColor = hexMatch ? hexMatch[0] : "#22D3EE";

  const globalQuotes = extractBalancedQuotes(visualSource);
  const copySummary = extractAllLiteralSceneCopy(visualSource);
  const allLiterals: string[] = [];
  const seenLit = new Set<string>();
  const addGlobalLit = (text: string) => {
    const c = text.replace(/\s+/g, " ").trim();
    if (!c || c.length < 2 || isStructuralSceneLabel(c) || isConversationalInstructionText(c)) return;
    if (!seenLit.has(c)) {
      seenLit.add(c);
      allLiterals.push(c);
    }
  };
  for (const q of globalQuotes) addGlobalLit(q);
  for (const q of copySummary.allLiterals) addGlobalLit(q);

  let targetDurationSec = explicitDuration;
  const scenes: DirectorStoryboardScene[] = [];

  if (Array.isArray(overrideStoryboard) && overrideStoryboard.length > 0) {
    let cursorSec = 0;
    for (let i = 0; i < overrideStoryboard.length; i++) {
      const item = overrideStoryboard[i]!;
      const dur = Number.isFinite(item.durationSec) && (item.durationSec ?? 0) > 0
        ? Number(item.durationSec)
        : 4;
      const startSec = Number.isFinite(item.startSec) ? Number(item.startSec) : Number(cursorSec.toFixed(3));
      cursorSec = startSec + dur;
      const rawPrompt = (item.visualPrompt ?? item.prompt ?? "").trim();
      const explicitLits = Array.isArray(item.literalTexts)
        ? item.literalTexts.map((s) => String(s).replace(/\s+/g, " ").trim()).filter((s) => Boolean(s) && !isStructuralSceneLabel(s))
        : extractBalancedQuotes(rawPrompt);
      for (const lit of explicitLits) addGlobalLit(lit);
      if (item.ctaText?.trim()) addGlobalLit(item.ctaText.trim());

      const role: "hook" | "demo" | "close" =
        i === 0 ? "hook" : i === overrideStoryboard.length - 1 ? "close" : "demo";
      const label = item.label?.trim() || item.title?.trim() || `Escena ${i + 1}`;
      scenes.push({
        sceneIndex: item.sceneIndex ?? i + 1,
        label,
        startSec,
        durationSec: dur,
        visualPrompt: sanitizeScenePromptForMotion(rawPrompt || label, explicitLits, item.ctaText?.trim(), role, accentColor),
        narration: item.narration?.trim() || (wantsVoiceover ? buildCompactNarration(explicitLits, role, language, dur, rawPrompt) : undefined),
        literalTexts: explicitLits,
        ...(item.ctaText?.trim() ? { ctaText: item.ctaText.trim() } : {}),
      });
    }
    if (!targetDurationSec) {
      targetDurationSec = Number(cursorSec.toFixed(3));
    }
  } else if (explicitSegments.length > 0) {
    const inferredDefaultDur =
      explicitDuration && explicitDuration > 0
        ? Number((explicitDuration / explicitSegments.length).toFixed(3))
        : 6;
    let cursorSec = 0;

    for (let i = 0; i < explicitSegments.length; i++) {
      const seg = explicitSegments[i]!;
      const startSec = seg.startSec !== undefined ? seg.startSec : Number(cursorSec.toFixed(3));
      const durationSec = seg.durationSec ?? inferredDefaultDur;
      cursorSec = startSec + durationSec;

      const segQuotes = extractBalancedQuotes(seg.body);
      const segExtracted = extractAllLiteralSceneCopy(seg.body);
      const sceneLiterals: string[] = [];
      const seenSceneLit = new Set<string>();
      for (const s of [...segQuotes, ...segExtracted.allLiterals]) {
        const clean = s.replace(/\s+/g, " ").trim();
        if (!clean || isStructuralSceneLabel(clean) || isConversationalInstructionText(clean)) continue;
        if (!seenSceneLit.has(clean)) {
          seenSceneLit.add(clean);
          sceneLiterals.push(clean);
          addGlobalLit(clean);
        }
      }

      const role: "hook" | "demo" | "close" =
        i === 0 ? "hook" : i === explicitSegments.length - 1 ? "close" : "demo";
      const ctaText = role === "close" ? inferCtaFromStrings(sceneLiterals, seg.body) : undefined;
      scenes.push({
        sceneIndex: i + 1,
        label: seg.label,
        startSec,
        durationSec,
        visualPrompt: sanitizeScenePromptForMotion(seg.body, sceneLiterals, ctaText, role, accentColor),
        narration: wantsVoiceover ? buildCompactNarration(sceneLiterals, role, language, durationSec, seg.body) : undefined,
        literalTexts: sceneLiterals,
        ctaText,
      });
    }

    if (!targetDurationSec) {
      targetDurationSec = Number(cursorSec.toFixed(3));
    }
  } else if (!hasUploadedVideo) {
    const total = targetDurationSec ?? 18;
    targetDurationSec = total;
    const perScene = Number((total / 3).toFixed(3));
    const s1Dur = perScene;
    const s2Dur = perScene;
    const s3Dur = Number((total - s1Dur - s2Dur).toFixed(3));

    const cta = inferCtaFromStrings(allLiterals, visualSource);
    const nonCta = allLiterals.filter((item) => item !== cta);
    const hookLiterals = nonCta.slice(0, Math.max(1, Math.min(2, nonCta.length)));
    const midLiterals = nonCta.slice(2, Math.max(2, nonCta.length - 1));
    const closeLiterals = [
      ...nonCta.slice(Math.max(hookLiterals.length, nonCta.length - 1)),
      ...(cta ? [cta] : []),
    ].filter((v, idx, arr) => arr.indexOf(v) === idx);

    scenes.push({
      sceneIndex: 1,
      label: "Escena 1 · Gancho",
      startSec: 0,
      durationSec: s1Dur,
      visualPrompt: sanitizeScenePromptForMotion(
        "Fondo tecnológico oscuro con red neuronal en cian y azul, logotipo y titular protagonista.",
        hookLiterals,
        undefined,
        "hook",
        accentColor,
      ),
      narration: wantsVoiceover ? buildCompactNarration(hookLiterals, "hook", language, s1Dur, visualSource) : undefined,
      literalTexts: hookLiterals,
    });
    scenes.push({
      sceneIndex: 2,
      label: "Escena 2 · Demo",
      startSec: s1Dur,
      durationSec: s2Dur,
      visualPrompt: sanitizeScenePromptForMotion(
        "Línea de tiempo animada con cortes inteligentes, capas de diseño en movimiento Remotion y onda de voz dinámica.",
        midLiterals,
        undefined,
        "demo",
        accentColor,
      ),
      narration: wantsVoiceover ? buildCompactNarration(midLiterals, "demo", language, s2Dur, visualSource) : undefined,
      literalTexts: midLiterals,
    });
    scenes.push({
      sceneIndex: 3,
      label: "Escena 3 · Cierre",
      startSec: Number((s1Dur + s2Dur).toFixed(3)),
      durationSec: s3Dur,
      visualPrompt: sanitizeScenePromptForMotion(
        "Cierre corporativo limpio con propuesta de valor, logotipo y botón CTA de alto contraste.",
        closeLiterals,
        cta,
        "close",
        accentColor,
      ),
      narration: wantsVoiceover ? buildCompactNarration(closeLiterals, "close", language, s3Dur, visualSource) : undefined,
      literalTexts: closeLiterals,
      ctaText: cta,
    });
  }

  return {
    aspectRatio,
    targetDurationSec,
    wantsVoiceover,
    wantsMusic,
    wantsSubtitles,
    wantsSilenceRemoval,
    wantsSfx,
    musicMood,
    language,
    accentColor,
    allLiterals,
    ctaText: inferCtaFromStrings(allLiterals, request),
    scenes,
  };
}

function selectRelevantSkills(request: string, hasUploadedVideo: boolean): Array<{ id: string; version: string; reason: string }> {
  const lower = request.toLowerCase();
  const loaded: Array<{ id: string; version: string; reason: string }> = [];
  const allSkills = skillRegistry.getAll();

  const tryPick = (id: string, reason: string) => {
    const found = allSkills.find((s) => s.id === id);
    if (found && !loaded.some((x) => x.id === id)) {
      loaded.push({ id: found.id, version: found.version ?? "1.0.0", reason });
    }
  };

  if (/\b(reel|lanzamiento|corporativo|redes|shorts|tiktok)\b/i.test(lower) || (!hasUploadedVideo && !/\b(anuncio|datos|tutorial|podcast)\b/i.test(lower))) {
    tryPick("reel-corporativo", "Estructura de reel vertical con gancho, demo y cierre CTA");
  }
  if (/\b(anuncio|spot|producto|ecommerce|oferta|compra)\b/i.test(lower)) {
    tryPick("anuncio-de-producto", "Fórmula Problema -> Producto -> Prueba -> CTA");
  }
  if (/\b(educativo|tips|consejos|explica|claves)\b/i.test(lower)) {
    tryPick("reel-educativo", "Narrativa didáctica voice-first y retención visual");
  }
  if (/\b(tutorial|captura|screencast|pantalla|software)\b/i.test(lower)) {
    tryPick("tutorial-con-capturas", "Zooms dirigidos y limpieza de pausas sobre UI");
  }
  if (/\b(podcast|episodio|entrevista)\b/i.test(lower)) {
    tryPick(hasUploadedVideo ? "entrevista-a-vertical" : "clip-de-podcast", "Adaptación a formato vertical y claridad vocal");
  }
  if (/\b(subt[ií]tulos|subtitulos|captions|karaoke)\b/i.test(lower)) {
    tryPick("subtitulos-dinamicos", "Reglas de contraste, zona segura y sincronía <= 100 ms");
  }
  if (/\b(silencio|silencios|audio|ruido|volumen|lufs)\b/i.test(lower)) {
    tryPick("limpieza-de-audio", "Control LUFS, ducking y cortes limpios de pausas");
  }
  if (/\b(brand|marca|colores|identidad|corporativ)\b/i.test(lower)) {
    tryPick("brand-kit", "Consistencia cromática y tipográfica de marca");
  }
  tryPick("qa-visual", "Auditoría cuadro a cuadro y prevención de placeholders obligatoria");

  return loaded;
}

async function runRegisteredTool(
  toolName: string,
  ctx: {
    projectId: string;
    project: Project;
    signal: AbortSignal;
    setProgress: (progress: number, message?: string) => void;
  },
  rawArgs: Record<string, unknown>,
): Promise<{
  ok: boolean;
  status: DirectorStatus;
  summary: string;
  warnings: string[];
  data: unknown;
  project: Project;
}> {
  const { validateToolArgs } = await import("./tools");
  const validation = validateToolArgs(toolName, rawArgs);
  if (!validation.ok) {
    return {
      ok: false,
      status: "failed",
      summary: `Argumentos inválidos para ${toolName}: ${validation.error}`,
      warnings: [validation.error],
      data: null,
      project: ctx.project,
    };
  }
  const result = await validation.definition.execute(ctx, validation.data);
  let nextProject = ctx.project;
  if (result.project) {
    const saved = await projectStore.saveTimeline(ctx.projectId, result.project, { force: true });
    nextProject = saved.project;
    eventBus.publish(ctx.projectId, {
      type: "project",
      projectId: ctx.projectId,
      revision: saved.project.revision,
    });
  } else {
    const reloaded = await projectStore.get(ctx.projectId);
    nextProject = reloaded.project;
  }
  const status: DirectorStatus = result.status ?? "verified";
  return {
    ok: status !== "failed",
    status,
    summary: result.summary,
    warnings: result.warnings ?? [],
    data: result.data ?? null,
    project: nextProject,
  };
}

function normalizeSyntheticSceneTiming(
  project: Project,
  storyboard: DirectorStoryboardScene[],
  targetDurationSec: number,
): { project: Project; adjusted: boolean } {
  if (storyboard.length === 0) return { project, adjusted: false };
  const fps = fpsValue(project.settings.fps);
  const expectedTotalFrames = secondsToFrames(targetDurationSec, project.settings.fps);
  const v1 = project.tracks.find((t) => t.id === "v1" || t.name === "V1") ?? project.tracks.find((t) => t.kind === "video");
  if (!v1 || v1.clips.length === 0) return { project, adjusted: false };

  let adjusted = false;
  const mediaClips = v1.clips.filter((c): c is MediaClip => c.type !== "text");
  if (mediaClips.length > 0 && mediaClips.every((c) => Boolean(c.remotion?.code))) {
    let cursorFrame = 0;
    const nextMediaClips: MediaClip[] = mediaClips.map((clip, idx) => {
      const scene = storyboard[idx];
      const desiredStart = scene ? secondsToFrames(scene.startSec, project.settings.fps) : cursorFrame;
      const startFrame = idx === 0 ? 0 : cursorFrame;
      const isLast = idx === mediaClips.length - 1;
      const desiredDur = isLast
        ? Math.max(fps, expectedTotalFrames - startFrame)
        : scene
          ? Math.max(fps, secondsToFrames(scene.durationSec, project.settings.fps))
          : clip.durationFrames;
      if (clip.startFrame !== startFrame || clip.durationFrames !== desiredDur || startFrame !== desiredStart) {
        if (clip.startFrame !== startFrame || clip.durationFrames !== desiredDur) adjusted = true;
      }
      cursorFrame = startFrame + desiredDur;
      return {
        ...clip,
        startFrame,
        durationFrames: desiredDur,
      };
    });

    const otherClips = project.tracks.map((track) => {
      if (track.id === v1.id) {
        return { ...track, clips: nextMediaClips };
      }
      if (track.kind === "audio" || track.kind === "text") {
        // Garantizar que audio/texto generativo no exceda el cierre exacto del reel (540 frames en 18s)
        const clamped = track.clips.map((c) => {
          if (c.startFrame + c.durationFrames > expectedTotalFrames + Math.round(fps * 0.1)) {
            const nextDur = Math.max(15, expectedTotalFrames - c.startFrame);
            if (nextDur !== c.durationFrames) {
              adjusted = true;
              return { ...c, durationFrames: nextDur };
            }
          }
          return c;
        });
        return { ...track, clips: clamped };
      }
      return track;
    });

    if (adjusted) {
      return {
        project: {
          ...project,
          tracks: otherClips,
          updatedAt: new Date().toISOString(),
        },
        adjusted: true,
      };
    }
  }
  return { project, adjusted: false };
}

function patchMissingLiteralsIntoMotionScene(
  project: Project,
  missingLiterals: string[],
  ctaText: string | undefined,
  storyboard: DirectorStoryboardScene[],
): { project: Project; patched: boolean } {
  if (missingLiterals.length === 0) return { project, patched: false };
  let patched = false;

  const nextTracks = project.tracks.map((track) => {
    if (track.kind !== "video") return track;
    const nextClips = track.clips.map((clip) => {
      if (clip.type === "text" || !clip.remotion) return clip;
      const clipStartSec = framesToSeconds(clip.startFrame, project.settings.fps);
      const matchingScene =
        storyboard.find((s) => Math.abs(s.startSec - clipStartSec) < 1.2) ?? storyboard[0];
      const clipMissing = missingLiterals.filter((lit) => {
        if (matchingScene && matchingScene.literalTexts.length > 0) {
          return matchingScene.literalTexts.some((sl) => sl.toLowerCase().includes(lit.toLowerCase()));
        }
        return true;
      });
      if (clipMissing.length === 0) return clip;

      const props = { ...(clip.remotion.props ?? {}) } as Record<string, unknown>;
      const existingExtra = Array.isArray(props.extraItems)
        ? (props.extraItems as unknown[]).map(String)
        : [];
      const merged = [...existingExtra];
      for (const item of clipMissing) {
        if (item !== props.title && item !== props.subtitle && item !== props.ctaText && !merged.includes(item)) {
          merged.push(item);
        }
      }
      if (!props.title && clipMissing[0]) {
        props.title = clipMissing[0];
      } else if (!props.subtitle && clipMissing.length > 1) {
        props.subtitle = clipMissing[1];
      }
      if (ctaText && (!props.ctaText || !String(props.ctaText).trim()) && matchingScene?.ctaText === ctaText) {
        props.ctaText = ctaText;
      }
      props.extraItems = merged;
      props.extraLiterals = merged;
      props.allLiterals = [...new Set([
        ...(Array.isArray(props.allLiterals) ? (props.allLiterals as unknown[]).map(String) : []),
        ...clipMissing,
        ...(ctaText && matchingScene?.ctaText ? [ctaText] : []),
      ])];

      let nextCode = clip.remotion.code;
      const codeSupportsDynamicExtras =
        /props\.(?:extraItems|extraLiterals)/.test(nextCode) &&
        /props\.title/.test(nextCode);

      if (!codeSupportsDynamicExtras) {
        const headlineStr = String(props.title || clipMissing[0] || matchingScene?.literalTexts[0] || "OECLIP");
        const subtitleStr = String(props.subtitle || "");
        const ctaStr = String(props.ctaText || (matchingScene?.ctaText ?? ""));
        const allList = props.allLiterals as string[];
        nextCode = buildPolymorphicProceduralSceneCode({
          componentName: clip.remotion.componentName,
          variantSeed: matchingScene?.sceneIndex ?? 1,
          headline: headlineStr,
          subheadline: subtitleStr,
          accentColor: String(props.accentColor || "#22D3EE"),
          secondaryColor: String(props.secondaryColor || "#3B82F6"),
          surfaceColor: String(props.surfaceColor || "#090D18"),
          textColor: String(props.textColor || "#F8FAFC"),
          fontFamily: String(props.fontFamily || "Inter"),
          visualTheme: String(props.badge || "OECLIP"),
          ctaText: ctaStr || undefined,
          allLiterals: allList,
          sceneArchetype: detectSceneVisualArchetype(`${clip.name} ${matchingScene?.visualPrompt ?? ""} ${headlineStr} ${ctaStr}`),
        });
      }

      patched = true;
      return {
        ...clip,
        remotion: {
          ...clip.remotion,
          props,
          code: nextCode,
        },
      };
    });
    return { ...track, clips: nextClips };
  });

  return {
    project: patched ? { ...project, tracks: nextTracks, updatedAt: new Date().toISOString() } : project,
    patched,
  };
}

/**
 * Ejecuta el bucle autónomo de 9 pasos del Agente Director sobre un proyecto OECLIP,
 * utilizando exclusivamente herramientas del registro único y verificación perceptiva real.
 */
export async function runDirectorAgent(options: DirectorAgentOptions): Promise<DirectorAgentResult> {
  const startedAt = Date.now();
  const autonomy: DirectorAutonomy = options.autonomy ?? "autonomous";
  const strictMode = Boolean(options.strict || options.allowFallback === false);
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const tasks: DirectorTaskItem[] = [];
  let hadFallback = false;
  let hadFailure = false;
  let usedAiScenes = 0;
  let fallbackAiScenes = 0;
  let ttsProvider: string | null = null;
  let ttsUsedReal: boolean | null = null;

  const reportProgress = (p: number, msg: string) => {
    options.onProgress?.(p, msg);
  };

  reportProgress(0.05, "Entendiendo el encargo y consultando capacidades...");
  const initialBundle = await projectStore.get(options.projectId);
  let project = initialBundle.project;

  const uploadedMedia = project.media.filter(
    (m) => !m.id.startsWith("med_motion_") && (m.kind === "video" || m.kind === "audio" || m.kind === "image"),
  );
  const hasUploadedVideo = uploadedMedia.some((m) => m.kind === "video");

  const ctx = () => ({
    projectId: options.projectId,
    project,
    signal: options.signal,
    setProgress: (p: number, msg?: string) => reportProgress(p, msg ?? "Procesando..."),
  });

  // 1. Entender encargo
  const spec = parseDirectorRequest(options.request, project, hasUploadedVideo, options.storyboard);
  tasks.push({
    id: "understand",
    title: "Analizar encargo, formato, duración y copy literal",
    status: "completed",
    detail: `${spec.aspectRatio}, ${spec.targetDurationSec ?? "auto"} s, ${spec.scenes.length} escenas, ${spec.allLiterals.length} textos literales`,
  });

  if (!spec.wantsVoiceover) {
    assumptions.push("Asumo pieza sin locución TTS según el encargo (si quieres voz en off, pídemela).");
  } else {
    assumptions.push(`Asumo locución en ${spec.language === "es" ? "español neutro" : "inglés"} y música ${spec.musicMood} con atenuación (ducking).`);
  }

  // 2. Consultar capacidades reales
  const capsRes = await runRegisteredTool("get_capabilities", ctx(), {});
  project = capsRes.project;
  const ai = aiStatus();
  const remotionReady = remotionEngineAvailable();
  const concurrencyCheck = computeSafeRemotionConcurrency({ requested: 4 });
  if (!ai.configured) {
    warnings.push("LLM externo no configurado: se usará síntesis local y render procedural marcado como fallback si aplica.");
  }
  if (!remotionReady) {
    warnings.push("Remotion CLI/renderer no disponible en este entorno.");
  }
  if (concurrencyCheck.warning) {
    warnings.push(concurrencyCheck.warning);
  }
  tasks.push({
    id: "capabilities",
    title: "Consultar capacidades reales (get_capabilities)",
    status: "completed",
    detail: `LLM: ${ai.configured ? ai.providerId : "local"}, Concurrencia segura Remotion: ${concurrencyCheck.concurrency}/${concurrencyCheck.detectedCores} núcleos`,
  });

  // 3. Cargar skills relevantes (progressive disclosure)
  const loadedSkills = selectRelevantSkills(options.request, hasUploadedVideo);
  tasks.push({
    id: "skills",
    title: "Cargar skills relevantes antes de editar",
    status: "completed",
    detail: loadedSkills.map((s) => `${s.id}@${s.version}`).join(", ") || "ninguna específica",
  });

  // 4. Modo asistido: entregar storyboard y plan para aprobación sin mutar timeline
  if (autonomy === "assisted") {
    tasks.push({
      id: "approval",
      title: "Esperar aprobación de storyboard (modo asistido)",
      status: "pending",
      detail: "Confirma o re-ejecuta con autonomy='autonomous' para construir y verificar el video.",
    });
    return {
      status: "unverified",
      summary: `Storyboard de ${spec.scenes.length} escenas (${spec.aspectRatio}, ${spec.targetDurationSec ?? "auto"} s) listo para aprobación. Incluye ${spec.allLiterals.length} textos literales sin modificar.`,
      warnings,
      verification: {
        checks: [
          { name: "storyboard_ready", passed: true, detail: `${spec.scenes.length} escenas planificadas` },
        ],
        evidence: [],
      },
      storyboard: spec.scenes,
      loadedSkills,
      tasks,
      assumptions,
      suggestedAdjustments: [
        "Confirmar el storyboard para iniciar la generación e inspección visual.",
        "Ajustar duración o copy literal antes de renderizar.",
      ],
      revision: project.revision,
    };
  }

  // 5. Checkpoint antes de modificar timeline
  reportProgress(0.15, "Creando checkpoint reversible antes de editar...");
  const cpRes = await runRegisteredTool("checkpoint", ctx(), {
    label: `Pre-Director: ${options.request.slice(0, 60)}`,
  });
  project = cpRes.project;
  tasks.push({
    id: "checkpoint",
    title: "Crear punto de control reversible (checkpoint)",
    status: cpRes.ok ? "completed" : "failed",
  });

  // 6. Configurar lienzo
  if (project.settings.aspect !== spec.aspectRatio) {
    reportProgress(0.22, `Configurando formato ${spec.aspectRatio}...`);
    const aspectRes = await runRegisteredTool("change_aspect_ratio", ctx(), {
      aspect: spec.aspectRatio,
    });
    project = aspectRes.project;
    warnings.push(...aspectRes.warnings);
  }

  // Verificar Brand Kit por defecto si está vacío y es encargo corporativo
  if (/oeclip/i.test(options.request)) {
    const existingBk = await projectStore.readBrandKit(options.projectId);
    if (!existingBk) {
      await runRegisteredTool("set_brand_kit", ctx(), {
        brandName: "OECLIP",
        primaryColor: "#0F172A",
        secondaryColor: "#1E3A8A",
        accentColor: "#22D3EE",
        backgroundColor: "#070B16",
        textColor: "#F8FAFC",
        fontFamily: "Inter",
        tone: "corporativo tecnológico limpio",
      });
    }
  }

  // 7. Ejecutar escenas o edición sobre material existente
  if (spec.scenes.length > 0 && !hasUploadedVideo) {
    // Limpiar clips sintéticos previos en V1 si se construye un montaje nuevo desde cero
    const v1 = project.tracks.find((t) => t.id === "v1" || t.name === "V1");
    if (v1 && v1.clips.length > 0 && v1.clips.every((c) => c.type !== "text" && Boolean(c.remotion?.code))) {
      project = {
        ...project,
        tracks: project.tracks.map((t) =>
          t.id === v1.id || t.id === "motion" || t.name === "Capa Motion" || t.kind === "text" || t.id === "a1" || t.id === "sfx"
            ? { ...t, clips: [] }
            : t,
        ),
        updatedAt: new Date().toISOString(),
      };
      const cleared = await projectStore.saveTimeline(options.projectId, project, { force: true });
      project = cleared.project;
    }

    for (let i = 0; i < spec.scenes.length; i++) {
      const scene = spec.scenes[i]!;
      reportProgress(0.25 + (i / spec.scenes.length) * 0.35, `Generando ${scene.label}...`);
      const motionRes = await runRegisteredTool("execute_custom_motion", ctx(), {
        prompt: scene.visualPrompt,
        title: scene.label,
        literalTexts: scene.literalTexts,
        ctaText: scene.ctaText,
        startSeconds: scene.startSec,
        durationSeconds: scene.durationSec,
        transparent: false,
        accentColor: spec.accentColor,
        skipAi: fallbackAiScenes >= 2 && usedAiScenes === 0,
      });
      project = motionRes.project;
      warnings.push(...motionRes.warnings);
      if (motionRes.status === "fallback") {
        hadFallback = true;
        fallbackAiScenes += 1;
      } else if (motionRes.ok) {
        usedAiScenes += 1;
      }
      if (!motionRes.ok) hadFailure = true;
    }
    tasks.push({
      id: "build_scenes",
      title: `Generar ${spec.scenes.length} escenas en Remotion con copy literal`,
      status: hadFailure ? "failed" : "completed",
      detail: hadFallback ? "Alguna escena usó motor procedural (marcado como fallback)." : "Escenas compiladas y validadas.",
    });

    // Audio & subtítulos sincronizados para montaje desde cero
    if (spec.wantsVoiceover) {
      reportProgress(0.62, "Generando locución TTS y subtítulos sincronizados...");
      const blocks = spec.scenes
        .filter((s) => Boolean(s.narration?.trim()))
        .map((s) => ({
          label: s.label,
          narration: s.narration!,
          durationSec: Math.max(1.2, s.durationSec),
        }));
      const ttsRes = await runRegisteredTool("synthesize_voiceover", ctx(), {
        blocks: blocks.length > 0 ? blocks : undefined,
        text: blocks.length === 0 ? spec.allLiterals.join(". ") : undefined,
        language: spec.language,
        startSeconds: 0,
        addSubtitles: spec.wantsSubtitles || true,
        alignToBlockDurations: blocks.length > 0,
      });
      project = ttsRes.project;
      warnings.push(...ttsRes.warnings);
      const ttsData = (ttsRes.data ?? null) as { provider?: string; usedRealTts?: boolean } | null;
      ttsProvider = ttsData?.provider ?? null;
      ttsUsedReal = typeof ttsData?.usedRealTts === "boolean" ? ttsData.usedRealTts : null;
      if (ttsRes.status === "fallback") hadFallback = true;
      tasks.push({
        id: "voiceover",
        title: "Sintetizar locución y subtítulos sincronizados",
        status: ttsRes.ok ? "completed" : "failed",
        detail: ttsRes.summary,
      });
    }

    if (spec.wantsMusic) {
      reportProgress(0.7, "Añadiendo música de fondo con ducking automático...");
      const musicRes = await runRegisteredTool("add_background_music", ctx(), {
        mood: spec.musicMood,
        durationSeconds: spec.targetDurationSec ?? 18,
      });
      project = musicRes.project;
      warnings.push(...musicRes.warnings);
      if (musicRes.status === "fallback") hadFallback = true;
    }

    if (spec.wantsSfx && spec.scenes.length > 1) {
      for (let i = 1; i < spec.scenes.length; i++) {
        const sfxRes = await runRegisteredTool("add_sound_effect", ctx(), {
          type: i === spec.scenes.length - 1 ? "pop" : "whoosh",
          startSeconds: spec.scenes[i]!.startSec,
          volume: 0.34,
        });
        project = sfxRes.project;
      }
    }

    // Normalizar límites exactos de escena en V1 (p. ej. exactamente 540 frames para 18.0s)
    if (spec.targetDurationSec) {
      const normalized = normalizeSyntheticSceneTiming(project, spec.scenes, spec.targetDurationSec);
      if (normalized.adjusted) {
        const saved = await projectStore.saveTimeline(options.projectId, normalized.project, { force: true });
        project = saved.project;
      }
    }
  } else if (hasUploadedVideo) {
    // Edición sobre material real aportado por el cliente
    reportProgress(0.4, "Editando material subido por el cliente...");
    const { detectLowResolutionSources } = await import("./perception");
    const lowRes = detectLowResolutionSources(project);
    for (const w of lowRes) {
      warnings.push(w.message);
    }
    if (spec.wantsSilenceRemoval) {
      const silRes = await runRegisteredTool("trim_silences", ctx(), {});
      project = silRes.project;
      warnings.push(...silRes.warnings);
    }
    if (spec.wantsSubtitles) {
      const subRes = await runRegisteredTool("generate_subtitles", ctx(), {
        language: spec.language,
        style: "viral",
      });
      project = subRes.project;
      warnings.push(...subRes.warnings);
      if (subRes.status === "fallback") hadFallback = true;
    }
    if (spec.allLiterals.length > 0) {
      const titleRes = await runRegisteredTool("execute_custom_motion", ctx(), {
        prompt: `Títulos limpios sin instrucciones crudas: ${spec.allLiterals.map((t) => `"${t}"`).join(" | ")}`,
        title: spec.allLiterals[0]!,
        startSeconds: 0,
        durationSeconds: 3.5,
        transparent: true,
        accentColor: spec.accentColor,
      });
      project = titleRes.project;
      warnings.push(...titleRes.warnings);
      if (titleRes.status === "fallback") hadFallback = true;
    }
    if (spec.wantsMusic) {
      const musicRes = await runRegisteredTool("add_background_music", ctx(), {
        mood: spec.musicMood,
      });
      project = musicRes.project;
      warnings.push(...musicRes.warnings);
    }
    tasks.push({
      id: "edit_media",
      title: "Aplicar edición sobre metraje del proyecto",
      status: "completed",
      detail: `${uploadedMedia.length} recurso(s) procesado(s)`,
    });
  }

  // 8. Observar y ciclo de autocorrección (máximo 3 iteraciones)
  reportProgress(0.8, "Inspeccionando timeline, QA report y fotogramas...");
  let qaReport = await buildTimelineQaReport(options.projectId, project, {
    expectedLiterals: spec.allLiterals,
    expectedPrompt: options.request,
    targetDurationSec: spec.targetDurationSec,
    strict: strictMode,
  });

  for (let cycle = 0; cycle < 3 && !qaReport.passed; cycle++) {
    let changed = false;
    const literalCheck = qaReport.checks.find((c) => c.name === "literal_copy_present");
    if (literalCheck && !literalCheck.passed) {
      const missing = spec.allLiterals.filter((lit) => literalCheck.detail.includes(lit));
      const patched = patchMissingLiteralsIntoMotionScene(
        project,
        missing.length > 0 ? missing : spec.allLiterals,
        spec.ctaText,
        spec.scenes,
      );
      if (patched.patched) {
        project = patched.project;
        changed = true;
      }
    }
    if (spec.targetDurationSec) {
      const durCheck = qaReport.checks.find((c) => c.name === "duration_match");
      if (durCheck && !durCheck.passed) {
        const retimed = normalizeSyntheticSceneTiming(project, spec.scenes, spec.targetDurationSec);
        if (retimed.adjusted) {
          project = retimed.project;
          changed = true;
        }
      }
    }
    if (!changed) break;
    const saved = await projectStore.saveTimeline(options.projectId, project, { force: true });
    project = saved.project;
    qaReport = await buildTimelineQaReport(options.projectId, project, {
      expectedLiterals: spec.allLiterals,
      expectedPrompt: options.request,
      targetDurationSec: spec.targetDurationSec,
      strict: strictMode,
    });
  }

  const durSec = Math.max(1, framesToSeconds(timelineDurationFrames(project), project.settings.fps));
  const sampleTimes =
    spec.scenes.length > 0
      ? [...new Set(spec.scenes.map((s) => Number((s.startSec + Math.min(0.65, s.durationSec * 0.4)).toFixed(2))))]
      : [0.5, Number((durSec * 0.5).toFixed(2)), Number(Math.max(0.5, durSec - 0.5).toFixed(2))];

  const renderStartedAt = Date.now();
  const renderedFrames = await renderTimelineFrames(options.projectId, project, {
    times: sampleTimes,
    scale: 0.45,
    signal: options.signal,
  });
  const sheet = await generateContactSheet(options.projectId, project, {
    every: Math.max(1, Math.round(durSec / Math.max(3, spec.scenes.length))),
    columns: 3,
    signal: options.signal,
    preRenderedFrames: renderedFrames.frames.length > 0 ? renderedFrames : undefined,
  });

  // Re-evaluar QA con evidencia real de píxeles e imagen (diff entre fotogramas + renderSource)
  if (renderedFrames.frames.length > 0) {
    qaReport = await buildTimelineQaReport(options.projectId, project, {
      expectedLiterals: spec.allLiterals,
      expectedPrompt: options.request,
      targetDurationSec: spec.targetDurationSec,
      strict: strictMode,
      renderedFrames: renderedFrames.frames,
    });
    const usesRemotionClips = project.tracks.some((t) => t.clips.some((c) => Boolean(c.remotion)));
    if (usesRemotionClips && renderedFrames.frames.some((f) => f.renderSource !== "remotion")) {
      hadFallback = true;
    }
  }

  for (const w of qaReport.warnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  tasks.push({
    id: "qa_observe",
    title: "Observar fotogramas, hoja de contactos y qa_report",
    status: qaReport.passed ? "completed" : "failed",
    detail: `${qaReport.checks.filter((c) => c.passed).length}/${qaReport.checks.length} checks QA OK · ${renderedFrames.frames.length} frames`,
  });

  // 9. Exportar y verificar si fue solicitado
  const chosenQuality = options.quality ?? "high";
  let exportResult: DirectorAgentResult["exportResult"];
  let exportBitrateBps: number | null = null;
  if (options.exportOnComplete) {
    reportProgress(0.9, "Exportando MP4 y verificando con FFprobe...");
    const dims = dimensionsFor(project.settings.aspect, project.settings.height);
    const fpsRounded = Math.round(fpsValue(project.settings.fps));
    const started = await startExport(options.projectId, {
      resolution: ([480, 720, 1080, 1440, 2160].includes(dims.height) ? dims.height : 1080) as 480 | 720 | 1080 | 1440 | 2160,
      aspect: project.settings.aspect,
      fps: ([24, 25, 30, 50, 60].includes(fpsRounded) ? fpsRounded : 30) as 24 | 25 | 30 | 50 | 60,
      quality: chosenQuality,
      encoder: config.encoderPreference ?? "auto",
      engine: remotionReady ? "remotion" : "ffmpeg",
      fileName: `${project.name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "oeclip-export"}.mp4`,
    });

    let job = jobQueue.get(started.job.id);
    while (job && (job.status === "queued" || job.status === "running")) {
      if (options.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 600));
      job = jobQueue.get(started.job.id);
    }

    if (job?.status === "done") {
      const verified = await verifyExport(options.projectId, started.record.id);
      const exportDurSec = verified.verification.durationUs / 1_000_000;
      exportBitrateBps =
        exportDurSec > 0 && verified.verification.sizeBytes > 0
          ? Math.round((verified.verification.sizeBytes * 8) / exportDurSec)
          : null;
      const downloadPath = buildSignedDownloadPath({
        kind: "export",
        projectId: options.projectId,
        exportId: verified.record.id,
        fileName: verified.record.settings.fileName,
      });
      exportResult = {
        exportId: verified.record.id,
        status: verified.record.status,
        outputFile: verified.record.outputFile ?? null,
        downloadUrl: downloadPath,
        verification: verified.verification,
      };
      tasks.push({
        id: "export_verify",
        title: "Exportar MP4 y verificar integridad (verify_export)",
        status: verified.verification.valid ? "completed" : "failed",
        detail: verified.verification.valid
          ? `${verified.record.outputFile ?? "export.mp4"} verificado (${exportBitrateBps ? `${(exportBitrateBps / 1_000_000).toFixed(1)} Mbps` : "MP4"})`
          : verified.verification.message,
      });
      if (!verified.verification.valid) {
        hadFailure = true;
        warnings.push(verified.verification.message);
      }
    } else {
      hadFailure = true;
      warnings.push(`La exportación falló: ${job?.error ?? "no completó en tiempo"}`);
      exportResult = {
        exportId: started.record.id,
        status: job?.status ?? "failed",
      };
      tasks.push({
        id: "export_verify",
        title: "Exportar MP4 y verificar integridad",
        status: "failed",
        detail: job?.error ?? "Error de exportación",
      });
    }
  }
  const renderDurationMs = Date.now() - renderStartedAt;

  if (strictMode && hadFallback) {
    hadFailure = true;
    warnings.push(
      "Modo estricto (strict/allowFallback=false): se detectó uso de respaldo procedural o de voz y no se permite entrega degradada.",
    );
  }

  // Persistir evento final en SSE
  eventBus.publish(options.projectId, {
    type: "project",
    projectId: options.projectId,
    revision: project.revision,
  });

  // Calcular estado honesto de salida (nunca ocultar fallbacks ni fallos QA)
  let status: DirectorStatus = "verified";
  if (hadFailure || !qaReport.passed) {
    status = "failed";
  } else if (renderedFrames.frames.length === 0) {
    status = "unverified";
  } else if (hadFallback) {
    status = "fallback";
  }

  const evidencePaths = [
    ...renderedFrames.frames.map((f) => path.basename(f.path)),
    path.basename(sheet.path),
  ];

  const finalSummaryParts: string[] = [
    `Montaje ${project.settings.aspect} (${project.settings.width}x${project.settings.height}, ${durSec.toFixed(1)} s) con ${spec.scenes.length || uploadedMedia.length} escena(s).`,
    `QA: ${qaReport.checks.filter((c) => c.passed).length}/${qaReport.checks.length} checks superados y ${renderedFrames.frames.length} fotogramas inspeccionados.`,
  ];
  if (hadFallback) {
    finalSummaryParts.push("Aviso honesto: se usó render procedural y/o locución fallback (declarado en warnings).");
  }
  if (!qaReport.passed) {
    const failedNames = qaReport.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
    finalSummaryParts.push(`Pendiente de corregir: ${failedNames.join(" | ")}.`);
  }

  const uniqueWarnings = [...new Set(warnings)];
  const runTrace: Record<string, unknown> = {
    traceId: `trace_${Date.now().toString(36)}`,
    projectId: options.projectId,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    renderDurationMs,
    status,
    autonomy,
    strict: strictMode,
    allowFallback: !strictMode,
    aiProvider: ai.providerId,
    aiModel: ai.model || null,
    aiConfigured: ai.configured,
    aiFallbackUsed: fallbackAiScenes > 0,
    usedAiScenes,
    fallbackAiScenes,
    ttsProvider,
    ttsUsedReal,
    remotionReady,
    remotionConcurrency: concurrencyCheck.concurrency,
    remotionDetectedCores: concurrencyCheck.detectedCores,
    exportQuality: chosenQuality,
    exportBitrateBps,
    exportStatus: exportResult?.status ?? null,
    downloadUrl: exportResult?.downloadUrl ?? null,
    qaScore: qaReport.score,
    qaPassed: qaReport.passed,
    frameCount: renderedFrames.frames.length,
    phases: tasks,
    loadedSkills: loadedSkills.map((s) => `${s.id}@${s.version}`),
    warnings: uniqueWarnings,
  };
  await projectStore.saveRunTrace(options.projectId, runTrace).catch(() => undefined);

  reportProgress(1, status === "failed" ? "Completado con incidencias detectadas en QA." : "Producción y verificación completadas.");

  return {
    status,
    summary: finalSummaryParts.join(" "),
    warnings: uniqueWarnings,
    verification: {
      checks: qaReport.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
      evidence: evidencePaths,
    },
    storyboard: spec.scenes,
    qaReport,
    frames: renderedFrames.frames,
    contactSheetPath: sheet.path,
    loadedSkills,
    tasks,
    exportResult,
    runTrace,
    assumptions,
    suggestedAdjustments: [
      "Cambiar tono o voz de la locución (corporativa, cercana o enérgica).",
      "Ajustar duración o copy literal de cualquiera de las escenas del storyboard.",
      "Exportar en MP4 para Reels/TikTok o generar variantes de plataforma.",
    ],
    revision: project.revision,
  };
}
