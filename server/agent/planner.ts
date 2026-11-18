import { z } from "zod";
import type { AgentPlan, AgentStep, MediaClip, Project } from "../../src/shared/schema";
import { newId, framesToSeconds } from "../../src/shared/time";
import { timelineDurationFrames } from "../../src/shared/project";
import { config } from "../config";
import { HttpError } from "../util/fs";
import { aiChatReady, aiStatus, chatJson } from "../ai/provider";
import { subtitleColorFromText } from "../../src/shared/subtitles";
import { ASPECT_PRESETS, type AspectRatio } from "../../src/shared/presets";
import { getTool, toolCatalog, validateToolArgs } from "./tools";
import { parseUserEditingConstraints } from "./autonomousEditorBrain";
import { isMacroSwarmPrompt } from "./swarmDirector";

export interface PlannerSelection {
  clipIds?: string[];
  mediaId?: string;
}

interface DraftStep {
  tool: string;
  title: string;
  reason?: string;
  args: Record<string, unknown>;
  risk: "low" | "medium" | "high";
}

export interface PlanDraft {
  summary: string;
  steps: DraftStep[];
  warnings: string[];
  source: "llm" | "local";
}

const llmPlanSchema = z.object({
  summary: z.string().min(1).max(2000),
  steps: z
    .array(
      z.object({
        tool: z.string().min(1).max(64),
        title: z.string().min(1).max(200),
        reason: z.string().max(600).optional(),
        args: z.record(z.unknown()).default({}),
        risk: z.enum(["low", "medium", "high"]).optional(),
      }),
    )
    .min(1)
    .max(12),
  warnings: z.array(z.string().max(600)).max(10).default([]),
});

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function quotedTexts(instruction: string): string[] {
  const matches = [...instruction.matchAll(/["“”'«»]([^"“”'«»]{2,180})["“”'«»]/g)];
  return matches.map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

function detectDurationSeconds(instruction: string): number | null {
  const normalized = normalize(instruction);
  // Solo frases que expresan duración total. «A los 5 segundos» es una
  // posición temporal, no una petición de recorte, y no debe acortar el vídeo.
  const match = normalized.match(
    /(?:duracion(?: total)?|que dure|dure|dejalo|dejalo en|deja el (?:video|montaje|proyecto)|recorta el (?:video|montaje|proyecto)|ajusta la duracion|que quede|maximo de|hasta un maximo de)\D{0,30}(\d+(?:[.,]\d+)?)\s*(?:s\b|seg\b|segs\b|segundos?)\b/,
  );
  if (match?.[1]) {
    const value = Number(match[1].replace(",", "."));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function selectedMedia(project: Project, instruction: string): string | undefined {
  const normalized = normalize(instruction);
  const found = project.media.find((asset) => {
    const name = normalize(asset.name).replace(/\.[a-z0-9]+$/, "");
    return name.length >= 4 && normalized.includes(name);
  });
  return found?.id;
}

function targetMedia(project: Project, instruction: string, selection?: PlannerSelection): string | undefined {
  return selection?.mediaId ?? selectedMedia(project, instruction);
}

function firstClipId(project: Project, selection?: PlannerSelection): string | undefined {
  if (selection?.clipIds && selection.clipIds.length > 0) {
    const id = selection.clipIds[0];
    if (project.tracks.some((track) => track.clips.some((clip) => clip.id === id))) return id;
  }
  const first = project.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .find((clip) => clip.type !== "text");
  return first?.id;
}

function step(toolName: string, title: string, args: Record<string, unknown>, reason?: string): DraftStep {
  const definition = getTool(toolName);
  return {
    tool: toolName,
    title,
    args,
    reason,
    risk: definition.risk,
  };
}

function detectSubtitleStyle(text: string): string | undefined {
  if (/moderno|space grotesk|geometrico|geometrica/.test(text)) return "modern";
  if (/ne[oó]n|brillo|glow|gaming/.test(text)) return "neon";
  if (/viral|tiktok|reel|instagram/.test(text)) return "viral";
  if (/impacto|energ[ií]a|amarill|directo/.test(text)) return "impact";
  if (/cine|cinematogr|tr[aá]iler|deporte/.test(text)) return "cinema";
  if (/editorial|revista|elegante|serif/.test(text)) return "editorial";
  if (/resaltad|highlight|lima|marcador/.test(text)) return "highlight";
  if (/minimal|discret|sutil|sobri/.test(text)) return "minimal";
  if (/tarjeta|card|documental|caja/.test(text)) return "card";
  if (/limpio|cl[aá]sico|legible/.test(text)) return "clean";
  return undefined;
}

function subtitleAppearanceRequest(project: Project, instruction: string): boolean {
  const text = normalize(instruction);
  if (/\bsin\s+subtitul|\bcero\s+subtitul|\bno\s+(?:pongas|quiero)\s+subtitul/.test(text)) {
    return false;
  }
  if (/\b(?:edita|editar|edicion|monta|montar)\s+(?:todo\s+)?(?:el|este|mi)?\s*video\b|\b(?:documental|trailer|enjambre|hyperframes)\b/.test(text)) {
    return false;
  }
  const hasSubtitleClips = project.tracks.some(
    (track) => track.kind === "text" && track.clips.some(
      (clip) => clip.type === "text" && (clip.role === "subtitle" || clip.role === "caption"),
    ),
  );
  const refersToText = /subtitul|caption|texto|palabra/.test(text);
  const requestsAppearance =
    /color|tamano|pequen|chic|grande|fuente|tipograf|estilo|resalt|destac|capcut|dinamic|inmobiliari|real estate|pop|moderno/.test(text) ||
    subtitleColorFromText(text) !== undefined;
  return refersToText && requestsAppearance && (hasSubtitleClips || /subtitul|caption/.test(text));
}

function dynamicSubtitlePreset(text: string): "real-estate" | "phrase-highlight" | "clean-pop" | undefined {
  if (/inmobiliari|real estate|capcut|viral|palabras? grandes|texto grande/.test(text)) return "real-estate";
  if (/highlight|frase.{0,24}resalt|resalt.{0,24}frase|frase.{0,24}destacad|destacad.{0,24}frase/.test(text)) return "phrase-highlight";
  if (/dinamic|moderno pop|pop/.test(text)) return "clean-pop";
  return undefined;
}

function subtitleAnimationRequest(text: string): boolean {
  const normalized = normalize(text);
  if (/\bsin\s+subtitul|\bcero\s+subtitul|\b(?:edita|editar|edicion|monta|montar)\s+(?:todo\s+)?(?:el|este|mi)?\s*video\b/.test(normalized)) {
    return false;
  }
  return /subtitul|caption/.test(normalized) &&
    /anim|efect|cinematic|entrada|salida|movimiento/.test(normalized);
}

function splitSubtitlesRequest(text: string): boolean {
  const normalized = normalize(text);
  return /subtitul|caption/.test(normalized) &&
    /acorta|mas cort|frases? cort|pocas palabras|divid|separa|segmenta|hasta cuatro palabras|por palabras|texto.{0,15}larg|larg.{0,15}texto/.test(normalized);
}

function removeSubtitlesRequest(text: string): boolean {
  const normalized = normalize(text);
  if (!/subtitul|caption|leyenda/.test(normalized)) return false;
  const deletes =
    /\b(elimina|eliminar|elimine|borra|borrar|borre|quita|quitar|quite|remueve|remover|suprime|suprimir|limpia|limpiar|saca|sacar|delete|remove)\b/.test(
      normalized,
    );
  const creates =
    /\b(genera|generar|crea|crear|anade|anadir|agrega|agregar|poner|pon|inserta|insertar|regenera|regenerar|transcribe|transcribir)\b/.test(
      normalized,
    );
  return deletes && !creates;
}

function detectAllSeconds(instruction: string): number[] {
  const normalized = normalize(instruction);
  const values: number[] = [];
  // Listas como «5 y 12 segundos» o «3, 7 y 10 s».
  for (const match of normalized.matchAll(
    /((?:\d+(?:[.,]\d+)?(?:\s*(?:,|y|e|\/)\s*)?)+)\s*(?:s\b|seg\b|segs\b|segundos?)\b/g,
  )) {
    for (const number of (match[1] ?? "").matchAll(/\d+(?:[.,]\d+)?/g)) {
      values.push(Number(number[0].replace(",", ".")));
    }
  }
  // Unidades repetidas: «5s y 12s», «a los 5 segundos y a los 12 segundos».
  for (const match of normalized.matchAll(
    /(\d+(?:[.,]\d+)?)\s*(?:s\b|seg\b|segs\b|segundos?)\b/g,
  )) {
    values.push(Number((match[1] ?? "").replace(",", ".")));
  }
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))].sort(
    (a, b) => a - b,
  );
}

/**
 * Momento explícito para un gráfico: «en el segundo 8», «a los 12 s», «en 1:05».
 * Se interpreta sobre la línea de tiempo final, no sobre el material original.
 */
function detectGraphicStartSeconds(instruction: string): number | null {
  const normalized = normalize(instruction);
  const clock = normalized.match(/\b(?:en|desde|a|sobre|hacia)\s+(?:el\s+)?(?:minuto\s+)?(\d{1,3}):([0-5]\d)\b/);
  if (clock?.[1] && clock[2]) return Number(clock[1]) * 60 + Number(clock[2]);
  const withUnit = normalized.match(
    /\b(?:en|desde|a|sobre|hacia)\s+(?:el\s+)?(?:segundo|seg|s)\s+(\d+(?:[.,]\d+)?)\b/,
  );
  const atSeconds = normalized.match(
    /\b(?:en|desde|a|sobre|hacia)\s+(?:los?\s+)?(\d+(?:[.,]\d+)?)\s*(?:s\b|seg\b|segs\b|segundos?)\b/,
  );
  const raw = withUnit?.[1] ?? atSeconds?.[1];
  if (!raw) return null;
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

/** Duración propia del gráfico: «que dure 5 segundos», «durante 4 s». */
function detectGraphicDurationSeconds(instruction: string): number | null {
  const normalized = normalize(instruction);
  const match = normalized.match(
    /\b(?:que dure|dure|durante|por)\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|seg\b|segs\b|segundos?)\b/,
  );
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(30, Math.max(0.8, value));
}

/** El zoom por keyframes se planifica en local: es rápido y no inventa clics. */
function zoomKeyframeRequest(instruction: string): boolean {
  const text = normalize(instruction);
  if (/\bsin\s+(?:zoom|escala|acercar)|\bno\s+(?:hagas|apliques)\s+zoom/.test(text)) return false;
  return /zoom.*suave|zoom.*accion|zoom.*clic|zoom.*momento|keyframe.*zoom|zoom.*dinamico|zoom.*localizado|zoom.*cuando|haz zoom.*cuando|aplica zoom.*cuando|zoom en cada|zoom en accion|zoom en un punto|zoom.*hago clic|zoom.*pantalla|zoom.*boton|zoom.*opciones|zoom.*se esta haciendo/.test(
    text,
  ) || (/zoom/.test(text) && detectAllSeconds(instruction).length > 0);
}

export type MotionPreset =
  | "lower-third"
  | "kinetic-title"
  | "callout"
  | "social-hook"
  | "stat-bars"
  | "stat-counter"
  | "stat-progress"
  | "title-card"
  | "shape-accent";

export function isDataGraphicPreset(preset: string): boolean {
  return preset === "stat-bars" || preset === "stat-counter" || preset === "stat-progress";
}

export function motionGraphicPreset(text: string): MotionPreset | undefined {
  const explicitMotionRequest =
    /motion graphics?|lower.?third|rotulo animado|banda inferior animada|callout|globo animado|etiqueta animada|titulo cinetico|texto animado|grafico animado|graficos? animados?|gancho social animado|hook animado|kinetic|\bgrafic|estadistic|\bbarras?\b|\bcontador\b|progreso|porcentaje|\bdatos?\b|forma geometrica|geometric|\bintro\b|\boutro\b|apertura|creditos|portada|titulo de (?:inicio|apertura|cierre)/.test(
      text,
    );
  if (!explicitMotionRequest) return undefined;
  if (/lower.?third|rotulo|banda inferior/.test(text)) return "lower-third";
  if (/callout|globo|etiqueta/.test(text)) return "callout";
  if (/gancho|hook/.test(text)) return "social-hook";
  if (/barra(s)? de (?:progreso|avance)|progreso|porcentaje|avance/.test(text)) return "stat-progress";
  if (/contador|numero(s)? que|dato numerico|cuenta(?:dor)?\b/.test(text)) return "stat-counter";
  if (/\bbarras?\b|estadistic|\bgrafic|\bdatos?\b|\bchart\b|\btarta\b|pastel|tendencia|comparativa/.test(text)) return "stat-bars";
  if (/\bintro\b|apertura|portada|\boutro\b|creditos|titulo de (?:inicio|apertura|cierre)|cierre animado/.test(text)) return "title-card";
  if (/forma|geometric|circulo|linea|destacado/.test(text)) return "shape-accent";
  return "kinetic-title";
}

export type TextPosition = "center" | "top" | "bottom" | "lower-third";

export interface TextEditIntent {
  kind: "timing" | "animation";
  clipId: string;
  durationSeconds?: number;
  startSeconds?: number;
  animationIn?: "fade-in" | "slide-left" | "slide-up" | "zoom-in";
  animationOut?: "fade-out" | "slide-left" | "slide-up" | "zoom-out";
}

function textClipsOf(project: Project): Extract<Project["tracks"][number]["clips"][number], { type: "text" }>[] {
  return project.tracks
    .filter((track) => track.kind === "text" && !track.hidden)
    .flatMap((track) => track.clips)
    .filter((clip): clip is Extract<typeof clip, { type: "text" }> => clip.type === "text")
    .sort((a, b) => a.startFrame - b.startFrame);
}

/**
 * Distingue «crea un texto» de «alarga/acorta/mueve el texto que ya existe».
 * Sin esta separación, «alarga el tiempo del texto» se interpretaba como una
 * petición de texto nuevo y terminaba pidiendo una frase literal.
 */
export function detectTextEditIntent(
  project: Project,
  instruction: string,
  selection?: PlannerSelection,
): TextEditIntent | null {
  const text = normalize(instruction);
  const clips = textClipsOf(project);
  if (clips.length === 0) return null;

  const mentionsExisting = /(?:el|del|este|ese|mi)\s+(?:texto|titulo|rotulo)|ese texto|el mismo texto|texto (?:actual|existente)|la frase (?:actual|anterior)/.test(
    text,
  );
  const explicitCreate =
    /\b(anade|anadir|agrega|agregar|crea|crear|genera|generar|escribe|escribir|inserta|insertar)\b/.test(text) &&
    !mentionsExisting;
  if (explicitCreate) return null;

  const timingVerb =
    /alarga|alargar|alargues|prolonga|prolongar|extiende|extender|amplia|ampliar|aumenta|aumentar|acorta|acortar|reduce|reducir|iguala|igualar|ajusta|ajustar|mueve|mover|adelanta|atrasa|que dure|dure lo mismo|igual que|lo mismo que|hasta el final|todo el (?:video|montaje)|termina con el (?:video|montaje)|empieza|empiece/.test(
      text,
    );
  const timingNoun =
    /tiempo|duracion|segundos?|igual que (?:la|el) (?:imagen|video|clip|montaje)|lo mismo que (?:la|el) (?:imagen|video|clip|montaje)|hasta el final|todo el (?:video|montaje)|termina con el (?:video|montaje)/.test(
      text,
    );
  const animationEdit =
    /animaci|anima|entrada|salida|fade|desvanece|desvanec|aparece|desaparezca|suave/.test(text) &&
    /texto|titulo|rotulo|frase/.test(text) &&
    !/subtitul|caption|leyenda/.test(text);
  if (!(timingVerb && timingNoun) && !animationEdit) return null;

  const selected = selection?.clipIds
    ?.map((id) => clips.find((clip) => clip.id === id))
    .find((clip) => clip !== undefined);
  // Con varios textos, «el texto» se refiere a un rótulo normal, no a una capa
  // de datos (barras, contador o progreso). «el grafico» elige la de datos.
  const wantsGraphic = /grafic|barra|contador|progreso|estadistic|dato/.test(text);
  const candidates = wantsGraphic
    ? clips
    : clips.filter((clip) => !clip.graphic).length > 0
      ? clips.filter((clip) => !clip.graphic)
      : clips;
  const target =
    selected ??
    (mentionsExisting || candidates.length === 1
      ? candidates[candidates.length - 1]!
      : undefined);
  if (!target) return null;

  const result: TextEditIntent = { kind: "timing", clipId: target.id };
  if (animationEdit) {
    result.kind = "animation";
    result.animationIn = /slide|desliza|izquierda|lateral/.test(text) ? "slide-left" : /zoom|acerca/.test(text) ? "zoom-in" : "fade-in";
    result.animationOut = /slide|desliza|izquierda|lateral/.test(text) ? "slide-left" : /zoom|acerca/.test(text) ? "zoom-out" : "fade-out";
  }

  const fps = project.settings.fps.num / project.settings.fps.den;
  const timelineFrames = timelineDurationFrames(project);
  const numeric = text.match(
    /(?:dure|duracion(?: de)?|tiempo(?: de)?|durante|por|a)\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|seg\b|segs\b|segundos?)\b/,
  );
  const matchesTimeline = /(?:igual|lo mismo) que.*(?:imagen|video|clip|montaje)|al igual que.*(?:imagen|video)|todo el (?:video|montaje)|hasta el final|termina con el (?:video|montaje)/.test(
    text,
  );
  if (numeric?.[1]) {
    result.durationSeconds = Math.max(0.5, Number(numeric[1].replace(",", ".")));
  } else if (matchesTimeline) {
    result.durationSeconds = Math.max(1, (timelineFrames - target.startFrame) / fps);
  } else if (/acorta|acortar|reduce|reducir|mas corto|menos tiempo/.test(text)) {
    result.durationSeconds = Math.max(1, (target.durationFrames / fps) * 0.6);
  } else if (timingVerb) {
    result.durationSeconds = Math.max(target.durationFrames / fps, Math.min(4, (timelineFrames - target.startFrame) / fps));
  }
  if (/desde el (?:inicio|principio)|al principio|empieza en 0/.test(text)) result.startSeconds = 0;
  return result;
}

function buildTextEditDraft(
  project: Project,
  instruction: string,
  edit: TextEditIntent,
): PlanDraft {
  const clip = textClipsOf(project).find((item) => item.id === edit.clipId);
  const label = clip?.text ? `«${clip.text.slice(0, 48)}${clip.text.length > 48 ? "…" : ""}»` : "el texto";
  if (edit.kind === "animation") {
    const fps = project.settings.fps.num / project.settings.fps.den;
    return {
      summary: `Ajusto la animación de entrada y salida de ${label} sin tocar su contenido.`,
      steps: [
        step(
          "set_clip_animation",
          "Suavizar la animación del texto existente",
          {
            clipId: edit.clipId,
            animationIn: edit.animationIn ?? "fade-in",
            animationInDuration: Math.max(1, Math.round(fps * 0.5)),
            animationOut: edit.animationOut ?? "fade-out",
            animationOutDuration: Math.max(1, Math.round(fps * 0.5)),
          },
          "Se conserva el texto y se aplican curvas de entrada y salida suaves.",
        ),
      ],
      warnings: [],
      source: "local",
    };
  }
  const seconds = edit.durationSeconds;
  const stepArgs: Record<string, unknown> = { clipId: edit.clipId };
  if (edit.startSeconds !== undefined) stepArgs.startSeconds = edit.startSeconds;
  if (seconds !== undefined) stepArgs.durationSeconds = Number(seconds.toFixed(3));
  return {
    summary:
      seconds !== undefined
        ? `Ajusto la duración de ${label} a ${seconds.toFixed(2).replace(/\.00$/, "")} s sin mover el resto del montaje.`
        : `Ajusto el tiempo de ${label} sin mover el resto del montaje.`,
    steps: [
      step(
        "set_clip_timing",
        seconds !== undefined ? `Ajustar el texto a ${Number(seconds.toFixed(2))} s` : "Ajustar el tiempo del texto",
        stepArgs,
        "Se modifica solo el clip de texto indicado; la imagen y los demás clips conservan su duración.",
      ),
    ],
    warnings: [],
    source: "local",
  };
}

export interface TextIntent {
  /** La instrucción pide crear un texto/frase sobre la imagen. */
  wantsText: boolean;
  /** No hay texto literal: hay que redactar una frase nueva. */
  generateCopy: boolean;
  literalText?: string;
  position: TextPosition;
  startSeconds?: number;
  durationSeconds?: number;
  /** La frase principal se anima como motion graphic. */
  motion: boolean;
  role: "title" | "caption";
  tones: string[];
  /** La petición incluye además otra edición (formato, subtítulos, export...). */
  withOtherEdits: boolean;
}

const TEXT_NOUN = /\b(texto|frase|copy|titulo|titular|rotulo|mensaje)\b/;
const TEXT_CREATE_VERB =
  /\b(genera|generar|generes|genere|crea|crear|crees|anade|anadir|agrega|agregar|agregues|pon|poner|ponle|inserta|insertar|escribe|escribir|redacta|redactar|inventa|inventar|quiero|necesito|deseo)\b/;

/** Texto literal explícito: entre comillas o después de «que diga:». */
function literalTextFromInstruction(instruction: string): string | undefined {
  const quoted = quotedTexts(instruction);
  if (quoted[0]) return quoted[0];
  const patterns = [
    /que\s+(?:diga|ponga|muestre|lea|dira)\s*:?\s*([^.\n]{2,160})/i,
    /(?:con\s+el\s+texto|con\s+la\s+frase|texto|frase)\s*:\s*([^.\n]{2,160})/i,
  ];
  for (const pattern of patterns) {
    const match = instruction.match(pattern);
    const value = match?.[1]?.trim().replace(/^["“”'«»]+|["“”'«»]+$/g, "");
    if (value && value.length >= 2) return value;
  }
  return undefined;
}

function detectTones(text: string): string[] {
  const tones = [
    "emotiva", "emotivo", "juvenil", "profesional", "inspiradora", "inspirador",
    "motivacional", "poetica", "poetico", "viral", "impactante", "elegante",
    "divertida", "divertido", "autentica", "autentico", "reflexiva", "reflexivo",
    "positiva", "positivo", "energetica", "energetico", "moderna", "moderno",
  ];
  return tones.filter((tone) => new RegExp(`\\b${tone}\\b`).test(text));
}

/**
 * Separa una petición de texto del resto de ediciones. Es clave para no
 * responder con formato vertical, voz, subtítulos o export cuando el usuario
 * solo quiere una frase sobre la imagen.
 */
export function detectTextIntent(instruction: string): TextIntent {
  const text = normalize(instruction);
  // «texto en pantalla» y «subtítulos» son otra intención: transcribir el audio.
  const subtitleRequest = /subtitul|transcri|texto en pantalla|caption|leyenda/.test(text);
  const noun = TEXT_NOUN.test(text);
  // «cambiar el color del texto», «alargar el tiempo del texto» o «renombrar
  // el título» editan lo existente; no crean un rótulo nuevo.
  const editsExistingText =
    /cambiar|cambia|ajusta|modifica|alarga|alargar|alargues|prolonga|prolongar|extiende|extender|amplia|ampliar|aumenta|aumentar|reduce|reducir|acorta|acortar|iguala|igualar|mueve|mover|quita|elimina|borra|renombra/.test(text) &&
    /(?:el|del|este|ese|mi)\s+(?:texto|titulo|rotulo|nombre)|color|tamano|fuente|tipograf|estilo|resalt|destac|pequen|grande|animacion|divide|acorta|separa|tiempo|duracion|segundos?/.test(
      text,
    );
  const wantsText = noun && TEXT_CREATE_VERB.test(text) && !subtitleRequest && !editsExistingText;
  const literalText = wantsText ? literalTextFromInstruction(instruction) : undefined;
  const descriptors =
    /emotiv|juvenil|profesional|inspirador|motivacional|poetic|viral|impactante|elegante|divertid|autentic|reflexiv|positiv|energetic|modern/.test(text);
  const generateVerb =
    /\b(genera|generar|generes|genere|crea|crear|crees|redacta|redactar|inventa|inventar|escribe|escribir|propone|propon|sugiere|sugerir)\b/.test(text);
  const phraseDescriptor = /con (?:una|la) frase|una frase (?:sobre|de|que)|frase (?:emotiva|juvenil|profesional|viral|motivacional|inspiradora)/.test(
    text,
  );
  const generateCopy = wantsText && !literalText && (generateVerb || descriptors || phraseDescriptor);

  const position: TextPosition =
    /tercio inferior|lower.?third|parte inferior de la (?:imagen|pantalla)/.test(text)
      ? "lower-third"
      : /arriba|superior|parte de arriba|cabecera|en la parte alta/.test(text)
        ? "top"
        : /abajo|inferior|parte de abajo|pie de (?:la )?(?:imagen|pantalla)|bottom/.test(text)
          ? "bottom"
          : "center";

  const explicitMotion =
    /motion|animad|animaci|cinetic|lower.?third|callout|gancho|hook|dinamic|zoom|aparece|entra/.test(text);
  const rejectsMotion = /\bsin\s+(?:animacion|movimiento|efectos)|\bestatico\b|\bfijo\b/.test(text);
  // Una frase protagonista centrada se anima como título cinético; un texto
  // literal sin animación se queda como overlay simple.
  const motion = wantsText && !rejectsMotion && (explicitMotion || (generateCopy && position === "center"));

  const otherEdit =
    /export|subtitul|transcri|silencio|recort(?:a|ar|e)?\s+(?:el\s+)?(?:video|clip|montaje)|crop|zoom|vertical|horizontal|cuadrado|9:16|16:9|1:1|banda sonora|\bmusica\b|\bvoz\b|ruido|volumen|mejores momentos|resumen|highlights|velocidad|ritmo del (?:video|montaje)|rotar|opacidad|duracion del (?:video|montaje)|recorta|cta|llamada a la accion/.test(
      text,
    );

  return {
    wantsText,
    generateCopy,
    literalText,
    position,
    startSeconds: wantsText ? detectGraphicStartSeconds(instruction) ?? undefined : undefined,
    durationSeconds: wantsText ? detectGraphicDurationSeconds(instruction) ?? undefined : undefined,
    motion,
    role: /cta|llamada a la accion|cierre|final|pie de/.test(text) ? "caption" : "title",
    tones: detectTones(text),
    withOtherEdits: otherEdit,
  };
}

const COPY_FALLBACKS: Record<"profesional" | "emotiva" | "juvenil" | "general", string[]> = {
  profesional: [
    "La confianza se construye con cada paso que decides dar.",
    "Tu historia merece contarse con claridad, calma y carácter.",
    "Lo que haces con dedicación siempre encuentra su momento.",
    "Crecer también es aprender a confiar en tu propio camino.",
  ],
  emotiva: [
    "Nunca dejes de creer en todo lo que puedes llegar a ser.",
    "Los momentos que importan empiezan cuando te atreves.",
    "Hazlo con el corazón; el resto encuentra su camino.",
    "Cada paso que das hoy construye la versión que serás mañana.",
  ],
  juvenil: [
    "No necesitas tenerlo todo claro para empezar a brillar.",
    "Atrévete a crear algo que todavía no existe.",
    "Lo que te hace diferente es exactamente lo que te hace valioso.",
    "Tu energía también es una forma de talento.",
  ],
  general: [
    "Todo lo que imaginas puede empezar hoy.",
    "Las mejores historias empiezan con un primer paso.",
    "Hay momentos que solo necesitan una oportunidad para quedarse.",
    "Confía en el proceso, incluso cuando todavía no ves el resultado.",
  ],
};

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** Frase de reserva cuando el proveedor de IA no está disponible o tarda. */
export function fallbackCopy(instruction: string, intent?: TextIntent): string {
  const tones = intent?.tones ?? detectTones(normalize(instruction));
  const pool =
    tones.includes("profesional")
      ? COPY_FALLBACKS.profesional
      : tones.some((tone) => tone.startsWith("emotiv"))
        ? COPY_FALLBACKS.emotiva
        : tones.some((tone) => tone.startsWith("juvenil"))
          ? COPY_FALLBACKS.juvenil
          : COPY_FALLBACKS.general;
  return pool[hashString(instruction) % pool.length]!;
}

function cleanPhrase(raw: string): string {
  const phrase = raw
    .replace(/^["“”'«»\s]+|["“”'«»\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (phrase.length < 2 || phrase.length > 180) return "";
  if (/\{|\}|<|>/.test(phrase)) return "";
  return phrase;
}

const copySchema = z.object({ phrase: z.string().min(2).max(180) });

/**
 * Generación de copy en una llamada corta: sin catálogo de herramientas ni
 * historial. Si el proveedor tarda o falla, responde al instante con una frase
 * local del tono pedido.
 */
async function generateCopy(
  instruction: string,
  intent: TextIntent,
): Promise<{ phrase: string; source: "ai" | "fallback"; warning?: string }> {
  const tones = intent.tones.length > 0 ? intent.tones.join(", ") : "emotiva, juvenil y profesional";
  const system =
    'Devuelve SOLO JSON válido: {"phrase":"..."}. Eres copywriter de video y escribes en español natural. ' +
    "La frase debe tener entre 6 y 14 palabras, sin comillas, sin hashtags y sin emojis. " +
    "Debe funcionar centrada sobre una imagen, con fuerza emocional y tono profesional.";
  const user = `Petición: ${instruction}\nTono pedido: ${tones}.\nEscribe una sola frase original para el video.`;
  try {
    const result = await chatJson(system, user, AbortSignal.timeout(8_000), {
      maxTokens: 180,
      temperature: 0.9,
    });
    const parsed = copySchema.safeParse(result.data);
    const phrase = parsed.success ? cleanPhrase(parsed.data.phrase) : "";
    if (phrase) return { phrase, source: "ai" };
  } catch {
    // Proveedor lento o sin respuesta: se usa la frase local.
  }
  return { phrase: fallbackCopy(instruction, intent), source: "fallback" };
}

function motionPresetForText(
  intent: TextIntent,
  instruction: string,
): MotionPreset | undefined {
  const preset = motionGraphicPreset(normalize(instruction));
  if (preset) return preset;
  if (!intent.motion) return undefined;
  if (/gancho|hook/.test(normalize(instruction))) return "social-hook";
  return "kinetic-title";
}

/** Crea el único paso necesario para una petición de texto. */
function buildTextStep(project: Project, instruction: string, intent: TextIntent, phrase: string): DraftStep {
  const timelineSeconds = Math.max(
    0.5,
    framesToSeconds(timelineDurationFrames(project), project.settings.fps),
  );
  const requestedDuration = intent.durationSeconds ?? Math.min(4, timelineSeconds);
  const durationSeconds = Math.min(
    30,
    Math.max(0.8, Math.min(requestedDuration, Math.max(1, timelineSeconds))),
  );
  const startSeconds = Math.max(
    0,
    Math.min(intent.startSeconds ?? 0, Math.max(0, timelineSeconds - durationSeconds)),
  );
  const preset = motionPresetForText(intent, instruction);
  if (preset) {
    const labels: Record<MotionPreset, string> = {
      "lower-third": "Rótulo lower third",
      "kinetic-title": "Título cinético",
      callout: "Callout animado",
      "social-hook": "Gancho social animado",
      "stat-bars": "Gráfico de barras animado",
      "stat-counter": "Contador animado",
      "stat-progress": "Barra de progreso animada",
      "title-card": "Tarjeta de título animada",
      "shape-accent": "Acento de forma animado",
    };
    return step(
      "create_motion_graphic",
      `Crear ${labels[preset]}`,
      {
        text: phrase,
        preset,
        startSeconds,
        durationSeconds,
        ...(targetMedia(project, instruction) ? { mediaId: targetMedia(project, instruction) } : {}),
      },
      "Se añade una capa de texto animada, editable y centrada, sin tocar el resto del montaje.",
    );
  }
  return step(
    "add_text_overlay",
    `Añadir el texto "${phrase.slice(0, 40)}"`,
    {
      text: phrase,
      role: intent.role,
      startSeconds,
      durationSeconds,
      position: intent.position,
      ...(intent.position === "center" ? { fontSize: 72 } : {}),
    },
    "Se añade un rótulo sobre la imagen con la posición y duración pedidas; el resto del montaje no se modifica.",
  );
}

function buildTextDraft(
  project: Project,
  instruction: string,
  intent: TextIntent,
  phrase: string,
  origin: "literal" | "ai" | "fallback",
  warning?: string,
): PlanDraft {
  const graphic = motionPresetForText(intent, instruction);
  const positionLabel =
    intent.position === "center"
      ? "en el centro"
      : intent.position === "top"
        ? "arriba"
        : intent.position === "bottom"
          ? "abajo"
          : "en el tercio inferior";
  const graphicLabel: Record<MotionPreset, string> = {
    "lower-third": "en el tercio inferior como rótulo animado",
    "kinetic-title": "al centro como título animado",
    callout: "arriba a la derecha como callout animado",
    "social-hook": "arriba como gancho social animado",
    "stat-bars": "al centro como gráfico de barras animado",
    "stat-counter": "al centro como contador animado",
    "stat-progress": "al centro como barra de progreso animada",
    "title-card": "al centro como tarjeta de título animada",
    "shape-accent": "al centro con un acento de forma animado",
  };
  const summary = graphic
    ? `Añado la frase «${phrase}» ${graphicLabel[graphic]}.`
    : `Añado la frase «${phrase}» ${positionLabel}.`;
  const warnings: string[] = [];
  if (origin === "fallback") {
    warnings.push(
      warning ??
        "La frase es una propuesta generada acorde al tono pedido. Puedes pedirme otra variante o escribir el texto exacto.",
    );
  }
  return {
    summary,
    steps: [buildTextStep(project, instruction, intent, phrase)],
    warnings,
    source: origin === "ai" ? "llm" : "local",
  };
}

/**
 * Determina si la instrucción solicita generar o producir una pieza audiovisual desde cero
 * (incluso cuando el proyecto aún no tiene archivos importados en `media`).
 */
export function isGenerativeFromScratchInstruction(instruction: string): boolean {
  const normalized = normalize(instruction);
  if (!normalized) return false;
  if (
    /\b(desde\s+cero|de\s+la\s+nada|sin\s+(?:videos?|clips?|metraje|archivos?)|intro\s+aut[oó]noma)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return /\b(crea|genera|haz(?:me)?|produce|construye|dise[nñ]a|arma|inventa|monta)\b[\s\S]{0,80}\b(video|reel|short|shorts|tiktok|intro|promo|anuncio|trailer|guion|historia|documental|presentaci[oó]n|an[aá]lisis|explicaci[oó]n|escena|animaci[oó]n|mockup|celular|3d|comercial)\b/.test(
    normalized,
  );
}

function buildLocalDraft(project: Project, instruction: string, selection?: PlannerSelection): PlanDraft {
  const text = normalize(instruction);
  const textIntent = detectTextIntent(instruction);
  const textEdit = detectTextEditIntent(project, instruction, selection);
  if (textEdit) {
    return buildTextEditDraft(project, instruction, textEdit);
  }
  // Una petición de solo texto se resuelve aquí, sin planificador genérico ni
  // pasos añadidos que el usuario no pidió.
  if (textIntent.wantsText && !textIntent.withOtherEdits) {
    const literal = textIntent.literalText;
    return buildTextDraft(
      project,
      instruction,
      textIntent,
      literal ?? fallbackCopy(instruction, textIntent),
      literal ? "literal" : "fallback",
    );
  }

  if (project.media.length === 0 && isGenerativeFromScratchInstruction(instruction)) {
    const genSteps: DraftStep[] = [];
    const wantsVerticalGen = /vertical|tiktok|reel|shorts|9:16|9x16/.test(text);
    const wantsSquareGen = /cuadrado|1:1|1x1/.test(text);
    const wantsLandscapeGen = /horizontal|16:9|16x9/.test(text);
    if (wantsVerticalGen && project.settings.aspect !== "9:16") {
      genSteps.push(step("change_aspect_ratio", "Configurar lienzo vertical 9:16 (1080x1920)", { aspect: "9:16" }));
    } else if (wantsSquareGen && project.settings.aspect !== "1:1") {
      genSteps.push(step("change_aspect_ratio", "Configurar lienzo cuadrado 1:1 (1080x1080)", { aspect: "1:1" }));
    } else if (wantsLandscapeGen && project.settings.aspect !== "16:9") {
      genSteps.push(step("change_aspect_ratio", "Configurar lienzo horizontal 16:9 (1920x1080)", { aspect: "16:9" }));
    }

    genSteps.push(
      step(
        "execute_autonomous_edit_swarm",
        "Generar video completo desde cero (Enjambre Autónomo + Remotion × HyperFrames + TTS)",
        {
          prompt: instruction,
          style: wantsVerticalGen ? "tiktok" : "cinematic",
          enablePunches: true,
          enableBrollCards: true,
        },
        "Genera guion narrativo, locución TTS sincronizada, escenas Remotion V1/HUD reactivas al audio, música con ducking y subtítulos.",
      ),
    );

    if (/export|redes\s+sociales|render/.test(text)) {
      const targetAspect = wantsVerticalGen
        ? "9:16"
        : wantsSquareGen
          ? "1:1"
          : wantsLandscapeGen
            ? "16:9"
            : project.settings.aspect;
      genSteps.push(
        step("render_export", "Exportar video final MP4", {
          resolution: 1080,
          aspect: targetAspect,
          quality: "standard",
        }),
      );
    }

    return {
      summary:
        "Generaré el video completo desde cero con escenas Remotion únicas, locución TTS sincronizada, música con ducking y subtítulos.",
      steps: genSteps,
      warnings: [],
      source: "local",
    };
  }
  const steps: DraftStep[] = [];
  const warnings: string[] = [];
  const targetMediaId = targetMedia(project, instruction, selection);
  const targetClipId = firstClipId(project, selection);
  const seconds = detectDurationSeconds(instruction);
  const quoted = quotedTexts(instruction);
  const constraints = parseUserEditingConstraints(instruction);
  const adjustsSubtitleAppearance = subtitleAppearanceRequest(project, instruction);
  const animatesSubtitle = subtitleAnimationRequest(instruction);
  const splitsSubtitles = splitSubtitlesRequest(instruction);
  const removesSubtitles = removeSubtitlesRequest(instruction);
  const isHolisticCreativeEdit =
    isMacroSwarmPrompt(instruction) &&
    /\b(edita|editar|edicion|monta|estilo|look|tintes?|documental|trailer|cyber|matrix|remotion|hyperframes|enjambre|sin\s+plantillas)\b/i.test(
      text,
    );
  const graphicPreset = isHolisticCreativeEdit ? undefined : motionGraphicPreset(text);

  const wantsSilence = /silencio|pausa|pausas|muletilla|respiro/.test(text) && !constraints.noSilenceCut;
  const wantsSubtitles =
    /subtitul|subtitula|transcri|texto en pantalla/.test(text) &&
    !constraints.noSubs &&
    !adjustsSubtitleAppearance &&
    !animatesSubtitle &&
    !splitsSubtitles &&
    !removesSubtitles;
  const wantsHighlights = /mejores|destacad|resumen|highlights|momentos|recopilac/.test(text);
  const wantsVertical = /vertical|tiktok|reel|shorts|9:16|9x16/.test(text);
  const wantsSquare = /cuadrado|1:1|1x1/.test(text);
  const wantsLandscape = /horizontal|16:9|16x9/.test(text);
  const wantsTitle = /\btitulo\b|\btitulo inicial\b|\bportada\b/.test(text);
  const wantsCta = /cta|llamada a la acci[oó]n|cierre|final/.test(text);
  const wantsVoice = /voz|ruido|audio.*mejor|mejora.*audio|limpiar.*audio|reducir.*ruido/.test(text);
  const wantsLowerVolume =
    /volumen|sonido|audio|m[uú]sica|banda sonora/.test(text) &&
    /baja|bajar|reduce|reducir|bajo|suaviza|atenuar/.test(text);
  const wantsDynamic = /ritmo|din[aá]mic|[aá]gil|r[aá]pid|pacing/.test(text) && !dynamicSubtitlePreset(text);
  const wantsExport = /export|redes sociales|social/.test(text);
  const wantsMusic = /m[uú]sica|banda sonora/.test(text);
  const wantsRepeated = /repetid|duplicad|muletilla/.test(text);
  const wantsZoom =
    /zoom|escala|escalar|agrand|acerca|primer plano|haz zoom|aplica zoom/.test(text) &&
    !/\bsin\s+(?:zoom|escala|acercar)|\bno\s+(?:hagas|apliques)\s+zoom/.test(text);
  const wantsCrop =
    /recort|crop|cropear|encuadra(?:r)?\b|elimina.*bordes|quita.*bordes/.test(text) &&
    !/\bsin\s+(?:cambiar\s+el\s+)?(?:encuadre|recort|crop)|\bno\s+(?:cambies|recortes|cropees|toques)\s+(?:el\s+)?(?:encuadre|video|clip)|\bsin\s+encuadrar/.test(text);
  const wantsRotation =
    /rota|rotacion|gira|girar|inclin|endereza/.test(text) &&
    !/\bsin\s+(?:rotar|girar|inclinar)|\bno\s+(?:gires|rotes|inclines|endereces)/.test(text);
  const wantsOpacity =
    /opaci|transparen|semitrans|superpone|capa|desvanec/.test(text) &&
    !/\bsin\s+(?:transparencia|opacidad|desvanecer)|\bno\s+(?:cambies)\s+(?:la\s+)?opacidad/.test(text);
  const wantsTransition = /transicion|transici[oó]n|crossfade|fundid|suav.*entre/.test(text);
  const wantsTrim = /recorta\s+(?:el\s+)?(?:inicio|principio|final|fin)|corta\s+(?:el\s+)?(?:inicio|principio|final|fin)|quita\s+(?:el\s+)?(?:inicio|principio|final|fin)|trim\s+(?:start|end|inicio|final)/.test(text);
  const wantsSplit = /divide\s+(?:el\s+)?clip|parte\s+(?:el\s+)?clip|corta\s+(?:el\s+)?clip\s+en|split\s+(?:el\s+)?clip|corta\s+en\s+\d+/.test(text);
  const wantsCrossfade = /crossfade|cross\s+fade|fundido\s+encadenado/.test(text);
  const wantsZoomTransition = /transicion\s+zoom|zoom\s+transicion|zoom\s+transition/.test(text);
  const wantsSlideTransition = /transicion\s+slide|slide\s+transicion|desliza\s+transicion|slide\s+transition/.test(text);
  const wantsAnimationIn = /entra|aparece|entrada|animaci[oó]n de entrada|aparece desliz|aparece desvanec|hace zoom ent|bounce ent/.test(text);
  const wantsAnimationOut = /sale|desaparece|salida|animaci[oó]n de salida|desaparece desliz|desaparece desvanec|hace zoom sal|bounce sal/.test(text);
  const wantsZoomKeyframes = zoomKeyframeRequest(instruction);
  const resolutionMatch = text.match(/\b(2160p?|4k|1440p?|2k|1080p?|720p?|480p?)\b/);
  const resolutionMap: Record<string, number> = {
    "4k": 2160,
    "2160p": 2160,
    "2k": 1440,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
  };
  const requestedResolution = resolutionMatch ? resolutionMap[resolutionMatch[1]!] : undefined;
  // `resolution` es el lado corto y solo admite 480/720/1080/1440/2160. Usar la
  // altura del proyecto (1920 en vertical) generaba un plan inválido.
  const EXPORT_RESOLUTIONS = [480, 720, 1080, 1440, 2160];
  const nearestExportResolution = (value: number) =>
    EXPORT_RESOLUTIONS.reduce(
      (best, candidate) => (Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best),
      1080,
    );

  if (graphicPreset) {
    const dataPreset = isDataGraphicPreset(graphicPreset);
    const needsLiteral = !dataPreset && graphicPreset !== "title-card" && graphicPreset !== "shape-accent";
    let graphicText = quoted[0];
    if (!graphicText && dataPreset) graphicText = "Datos clave";
    if (!graphicText && graphicPreset === "title-card") graphicText = project.name;
    if (!graphicText && graphicPreset === "shape-accent") {
      graphicText = textIntent.generateCopy ? fallbackCopy(instruction, textIntent) : "Detalles que cuentan";
    }
    if (!graphicText && textIntent.generateCopy) graphicText = fallbackCopy(instruction, textIntent);
    if (!graphicText && needsLiteral) {
      throw new HttpError(
        422,
        "Puedo crear ese motion graphic. Envíame el texto literal entre comillas o pídeme que genere una frase.",
        "motion_graphic_text_required",
      );
    }
    const finalText = graphicText ?? "Datos clave";
    // Datos simples en la propia frase: «datos 42, 58 y 74».
    const dataMatch = instruction.match(
      /(?:datos?|valores?|cifras?)\s*(?:de|:)?\s*((?:\d+(?:[.,]\d+)?\s*(?:,|y|\/)?\s*){2,})/i,
    );
    const dataValues = dataMatch?.[1]
      ? [...dataMatch[1].matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => Number(match[0].replace(",", ".")))
      : [];
    const data =
      dataValues.length >= 2
        ? dataValues.map((value, index) => ({ label: `Dato ${index + 1}`, value }))
        : undefined;
    const counterMatch = instruction.match(
      /(?:valor|contador|n[uú]mero|cifra|hasta|llega a)[^\d%]{0,24}(\d+(?:[.,]\d+)?)/i,
    );
    const counterValue = counterMatch?.[1]
      ? Number(counterMatch[1].replace(",", "."))
      : dataValues[0];
    const unit = /%|porcentaje/.test(text) ? "%" : undefined;
    const selectedClip = targetClipId
      ? project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === targetClipId)
      : undefined;
    // La posición explícita («en el segundo 8») manda sobre el clip seleccionado;
    // sin ella, el gráfico se ancla al inicio del clip elegido.
    const explicitStart = detectGraphicStartSeconds(instruction);
    const startSeconds =
      explicitStart ?? (selectedClip ? framesToSeconds(selectedClip.startFrame, project.settings.fps) : 0);
    const graphicDuration =
      detectGraphicDurationSeconds(instruction) ?? (dataPreset ? 5 : seconds);
    const labels: Record<MotionPreset, string> = {
      "lower-third": "Rótulo lower third",
      "kinetic-title": "Título cinético",
      callout: "Callout animado",
      "social-hook": "Gancho social animado",
      "stat-bars": "Gráfico de barras animado",
      "stat-counter": "Contador animado",
      "stat-progress": "Barra de progreso animada",
      "title-card": "Tarjeta de título animada",
      "shape-accent": "Acento de forma animado",
    };
    const args: Record<string, unknown> = {
      text: finalText,
      preset: graphicPreset,
      startSeconds,
      ...(graphicDuration ? { durationSeconds: graphicDuration } : {}),
      ...(targetMediaId ? { mediaId: targetMediaId } : {}),
    };
    if (dataPreset) {
      if (data) args.data = data;
      if (counterValue !== undefined) args.value = counterValue;
      if (unit) args.unit = unit;
      if (!data && graphicPreset === "stat-bars") {
        warnings.push(
          "El gráfico usa datos de ejemplo editables. Dime las cifras y las etiquetas reales (por ejemplo: «datos 42, 58 y 74») y las actualizo.",
        );
      }
    }
    steps.push(
      step(
        "create_motion_graphic",
        `Crear ${labels[graphicPreset]}`,
        args,
        dataPreset
          ? "Se añade un gráfico de datos animado y editable sobre el montaje; el video base no se modifica."
          : "Se añade una capa animada editable y se renderiza con el motor de composición actual.",
      ),
    );
  }

  if (textIntent.wantsText && !graphicPreset && !wantsTitle && !wantsCta) {
    const phrase = textIntent.literalText ?? fallbackCopy(instruction, textIntent);
    steps.push(buildTextStep(project, instruction, textIntent, phrase));
  }

  if (adjustsSubtitleAppearance) {
    const subtitleClips = project.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .filter((clip): clip is Extract<typeof clip, { type: "text" }> =>
        clip.type === "text" && (clip.role === "subtitle" || clip.role === "caption"),
      );
    if (subtitleClips.length === 0) {
      throw new HttpError(422, "No encontré subtítulos en la línea de tiempo para cambiar. Primero genera los subtítulos y vuelve a pedirme el ajuste.", "no_subtitles");
    }
    const dynamicPreset = dynamicSubtitlePreset(text);
    if (dynamicPreset) {
      steps.push(
        step(
          "apply_dynamic_subtitle_preset",
          `Aplicar subtítulos dinámicos ${dynamicPreset}`,
          {
            preset: dynamicPreset,
            ...(subtitleColorFromText(text) ? { color: subtitleColorFromText(text) } : {}),
            ...(targetMediaId ? { mediaId: targetMediaId } : {}),
          },
          "Se conserva el texto y la sincronización de cada frase; se aplica el estilo y una animación breve.",
        ),
      );
    }
    const sizeMatch = text.match(/(?:a|en|dejar(?:los)? en)\s*(\d{1,3})\s*(?:px|puntos)?\b/);
    const wantsSmaller = /mas pequen|mas chico|reduc(?:e|ir|eme)|baja(?:r)? el tamano/.test(text);
    const wantsLarger = /mas grand|mas grande|aument(?:a|ar)|sube(?:r)? el tamano/.test(text);
    const averageFontSize = subtitleClips.reduce((sum, clip) => sum + clip.fontSize, 0) / subtitleClips.length;
    const fontSize = sizeMatch?.[1]
      ? Math.min(400, Math.max(8, Number(sizeMatch[1])))
      : wantsSmaller
        ? Math.max(8, Math.round(averageFontSize * (/mucho|bastante|considerablemente/.test(text) ? 0.7 : 0.82)))
        : wantsLarger
          ? Math.min(400, Math.round(averageFontSize * 1.18))
          : undefined;
    const selectiveColors = /palabras?|frases?|terminos?/.test(text) && /resalt|destac|algunas|algunos|claves/.test(text);
    const color = subtitleColorFromText(text);
    const args = {
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(color ? { color } : {}),
    };
    if (!dynamicPreset && Object.keys(args).length > 0) {
      steps.push(
        step(
          "change_subtitle_style",
          fontSize !== undefined
            ? `Ajustar tamaño de subtítulos a ${fontSize}`
            : `Cambiar color de subtítulos a ${color}`,
          args,
          "El cambio se aplica a los subtítulos existentes y conserva su texto y sincronización.",
        ),
      );
    }
    if (selectiveColors) {
      warnings.push("El editor todavía no admite varios colores dentro de una misma frase. Se aplicará el color base indicado; el resaltado individual en rojo no se modificará.");
    }
  }

  if (animatesSubtitle) {
    const subtitleClips = project.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .filter((clip): clip is Extract<typeof clip, { type: "text" }> =>
        clip.type === "text" && (clip.role === "subtitle" || clip.role === "caption"),
      )
      .sort((a, b) => a.startFrame - b.startFrame);
    const selectedSubtitle = selection?.clipIds
      ?.map((id) => subtitleClips.find((clip) => clip.id === id))
      .find((clip) => clip !== undefined);
    const target = selectedSubtitle ?? subtitleClips[0];
    if (!target) {
      throw new HttpError(422, "No encontré subtítulos en la línea de tiempo para animar. Primero genera los subtítulos y vuelve a intentarlo.", "no_subtitles");
    }
    const fps = project.settings.fps.num / project.settings.fps.den;
    steps.push(
      step(
        "set_clip_animation",
        `Añadir animación cinematográfica al subtítulo "${target.text.slice(0, 40)}"`,
        {
          clipId: target.id,
          animationIn: "zoom-in",
          animationInDuration: Math.max(1, Math.round(fps * 0.4)),
          animationOut: "fade-out",
          animationOutDuration: Math.max(1, Math.round(fps * 0.25)),
        },
        "Se anima el primer subtítulo con una entrada de zoom suave y una salida en fundido, conservando el texto y su sincronización.",
      ),
    );
  }

  if (splitsSubtitles) {
    steps.push(
      step(
        "split_subtitles_into_phrases",
        "Dividir subtítulos en frases cortas",
        targetMediaId ? { mediaId: targetMediaId } : {},
        "Se conservan todas las palabras y la duración total, mostrando hasta cuatro palabras por cue.",
      ),
    );
  }

  if (removesSubtitles) {
    steps.push(
      step(
        "remove_subtitles",
        "Eliminar los subtítulos de la línea de tiempo",
        {
          ...(targetMediaId ? { mediaId: targetMediaId } : {}),
          ...(/todos los textos|\btitulos?\b/.test(text) ? { includeTitles: true } : {}),
        },
        "Se eliminan los clips de subtítulo y leyenda existentes; el resto del montaje no se modifica.",
      ),
    );
  }

  if (wantsSilence) {
    steps.push(
      step(
        "remove_silences",
        "Eliminar silencios y pausas",
        {
          ...(targetClipId ? { clipId: targetClipId } : {}),
          ...(targetMediaId ? { mediaId: targetMediaId } : {}),
          thresholdDb: -35,
          minSilenceSec: 0.85,
          paddingSec: 0.22,
        },
        "Se detectan pausas reales con FFmpeg y se conservan márgenes para no cortar palabras.",
      ),
    );
  }

  if (wantsHighlights) {
    steps.push(
      step(
        "select_highlights",
        "Seleccionar los mejores momentos",
        {
          ...(targetMediaId ? { mediaId: targetMediaId } : {}),
          targetSeconds:
            seconds ??
            Math.min(30, Math.max(5, Math.round(framesToSeconds(timelineDurationFrames(project), project.settings.fps)))),
        },
        "Se puntúa la energía del audio y se montan fragmentos representativos.",
      ),
    );
    warnings.push("La selección se basa en energía de audio; revisa los cortes antes de exportar.");
  }

  if (wantsVertical) {
    steps.push(step("change_aspect_ratio", "Cambiar a formato vertical 9:16", { aspect: "9:16" }));
    warnings.push("El reencuadre automático por rostro no está disponible; ajusta escala y posición en el inspector.");
  } else if (wantsSquare) {
    steps.push(step("change_aspect_ratio", "Cambiar a formato cuadrado 1:1", { aspect: "1:1" }));
  } else if (wantsLandscape) {
    steps.push(step("change_aspect_ratio", "Cambiar a formato horizontal 16:9", { aspect: "16:9" }));
  }

  if (wantsSubtitles) {
    if (aiStatus().transcriptionMode === "local") {
      warnings.push(
        "Los subtítulos se generarán con Whisper local. La primera vez se descarga el modelo de voz; el audio no sale de tu equipo.",
      );
    }
    const style = detectSubtitleStyle(text);
    steps.push(
      step(
        "generate_subtitles",
        style ? `Transcribir y generar subtítulos (estilo ${style})` : "Transcribir y generar subtítulos",
        {
          ...(targetMediaId ? { mediaId: targetMediaId } : {}),
          ...(/espanol|español|castellano/.test(text) ? { language: "es" } : {}),
          maxChars: 56,
          ...(style ? { style } : {}),
        },
        "Se crean cues sincronizados a partir de la transcripción real del audio.",
      ),
    );
  }

  if (wantsZoom && !wantsZoomKeyframes) {
    const targetClip = targetClipId
      ? project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text")
      : undefined;
    if (targetClip) {
      steps.push(
        step(
          "set_clip_transform",
          `Aplicar zoom a "${targetClip.name.slice(0, 40)}"`,
          { clipId: targetClip.id, scale: 1.4, x: 0, y: 0 },
          "Se aplica un zoom del 140% al clip seleccionado para resaltar el contenido.",
        ),
      );
    } else {
      warnings.push("No hay ningún clip de video en la línea de tiempo al que aplicar el zoom.");
    }
  }

  if (wantsCrop) {
    const targetClip = targetClipId
      ? project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text")
      : undefined;
    if (targetClip) {
      steps.push(
        step(
          "set_clip_crop",
          `Recortar "${targetClip.name.slice(0, 40)}"`,
          { clipId: targetClip.id, top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
          "Se recortan los bordes del clip para mejorar el encuadre.",
        ),
      );
    } else {
      warnings.push("No hay ningún clip de video en la línea de tiempo al que aplicar el recorte.");
    }
  }

  if (wantsRotation) {
    const targetClip = targetClipId
      ? project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text")
      : undefined;
    if (targetClip) {
      steps.push(
        step(
          "set_clip_rotation",
          `Rotar "${targetClip.name.slice(0, 40)}"`,
          { clipId: targetClip.id, rotation: 90 },
          "Se rota el clip 90 grados para corregir la orientación.",
        ),
      );
    } else {
      warnings.push("No hay ningún clip de video en la línea de tiempo al que aplicar la rotación.");
    }
  }

  if (wantsOpacity) {
    const targetClip = targetClipId
      ? project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text")
      : undefined;
    if (targetClip) {
      steps.push(
        step(
          "set_clip_opacity",
          `Ajustar opacidad de "${targetClip.name.slice(0, 40)}"`,
          { clipId: targetClip.id, opacity: 0.7 },
          "Se reduce la opacidad al 70% para crear un efecto de superposición.",
        ),
      );
    } else {
      warnings.push("No hay ningún clip en la línea de tiempo al que ajustar la opacidad.");
    }
  }

  if (wantsTransition) {
    const videoTrack =
      project.tracks.find(
        (track) =>
          track.kind === "video" &&
          !/motion|overlay|transici|v0|fondo\s*ambient/i.test(track.name),
      ) ?? project.tracks.find((track) => track.kind === "video");
    if (videoTrack && videoTrack.clips.length >= 2) {
      const sortedClips = [...videoTrack.clips].sort((a, b) => a.startFrame - b.startFrame);
      for (let i = 0; i < sortedClips.length - 1; i++) {
        const clipA = sortedClips[i]!;
        const clipB = sortedClips[i + 1]!;
        if (clipA.type !== "audio" && clipB.type !== "audio") {
          const fpsValue = project.settings.fps.num / project.settings.fps.den;
          const fadeFrames = Math.min(30, Math.floor(clipA.durationFrames / 4), Math.floor(clipB.durationFrames / 4));
          if (fadeFrames > 0) {
            steps.push(
              step(
                "set_clip_fade",
                `Transición suave entre "${clipA.name.slice(0, 30)}" y "${clipB.name.slice(0, 30)}"`,
                { clipId: clipA.id, fadeOutFrames: fadeFrames },
                `Fade-out de ${fadeFrames} frames en el final del primer clip.`,
              ),
            );
            steps.push(
              step(
                "set_clip_fade",
                `Transición suave entre "${clipA.name.slice(0, 30)}" y "${clipB.name.slice(0, 30)}"`,
                { clipId: clipB.id, fadeInFrames: fadeFrames },
                `Fade-in de ${fadeFrames} frames en el inicio del segundo clip.`,
              ),
            );
          }
        }
      }
    } else {
      warnings.push("Se necesitan al menos dos clips de video en la línea de tiempo para crear una transición.");
    }
  }

  if (wantsTrim) {
    const targetClip = targetClipId
      ? project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text")
      : project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.type !== "audio" && clip.type !== "text");
    if (targetClip) {
      const trimStartMatch = text.match(/recorta\s+(?:el\s+)?(?:inicio|principio)\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(?:s|seg|segundos?)|trim\s+start\s+(\d+(?:[.,]\d+)?)/i);
      const trimEndMatch = text.match(/recorta\s+(?:el\s+)?(?:final|fin)\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(?:s|seg|segundos?)|trim\s+end\s+(\d+(?:[.,]\d+)?)/i);
      const trimStartSec = trimStartMatch ? parseFloat(trimStartMatch[1]?.replace(",", ".") ?? trimStartMatch[2]?.replace(",", ".") ?? "0") : undefined;
      const trimEndSec = trimEndMatch ? parseFloat(trimEndMatch[1]?.replace(",", ".") ?? trimEndMatch[2]?.replace(",", ".") ?? "0") : undefined;
      if (trimStartSec !== undefined || trimEndSec !== undefined) {
        steps.push(
          step(
            "trim_clip",
            `Recortar ${trimStartSec !== undefined ? `inicio ${trimStartSec}s` : ""}${trimStartSec !== undefined && trimEndSec !== undefined ? " y " : ""}${trimEndSec !== undefined ? `final ${trimEndSec}s` : ""} de "${targetClip.name.slice(0, 40)}"`,
            { clipId: targetClip.id, ...(trimStartSec !== undefined ? { trimStartSeconds: trimStartSec } : {}), ...(trimEndSec !== undefined ? { trimEndSeconds: trimEndSec } : {}) },
            `Se recorta ${trimStartSec !== undefined ? `${trimStartSec}s del inicio` : ""}${trimStartSec !== undefined && trimEndSec !== undefined ? ", " : ""}${trimEndSec !== undefined ? `${trimEndSec}s del final` : ""}.`,
          ),
        );
      } else {
        warnings.push("Indica cuántos segundos recortar del inicio o final (ej: «recorta 2 segundos del inicio»).");
      }
    } else {
      warnings.push("No hay ningún clip de video o imagen en la línea de tiempo para recortar.");
    }
  }

  if (wantsSplit) {
    const targetClip = targetClipId
      ? project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text")
      : project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.type !== "audio" && clip.type !== "text");
    if (targetClip) {
      const splitSecMatch = text.match(/(?:divide|parte|corta)\s+(?:el\s+)?clip\s+en\s+(\d+(?:[.,]\d+)?)\s*(?:s|seg|segundos?)|split\s+(?:el\s+)?clip\s+(?:en\s+)?(\d+(?:[.,]\d+)?)/i);
      const splitSec = splitSecMatch ? parseFloat(splitSecMatch[1]?.replace(",", ".") ?? splitSecMatch[2]?.replace(",", ".") ?? "0") : undefined;
      if (splitSec !== undefined && splitSec > 0 && splitSec < (targetClip.durationFrames / (project.settings.fps.num / project.settings.fps.den))) {
        steps.push(
          step(
            "split_clip",
            `Dividir "${targetClip.name.slice(0, 40)}" en ${splitSec}s`,
            { clipId: targetClip.id, atSeconds: splitSec },
            `El clip se divide en dos en el segundo ${splitSec.toFixed(2)}.`,
          ),
        );
      } else {
        warnings.push("Indica en qué segundo dividir el clip (ej: «divide el clip en 3 segundos»).");
      }
    } else {
      warnings.push("No hay ningún clip de video o imagen en la línea de tiempo para dividir.");
    }
  }

  if (wantsTransition || wantsCrossfade || wantsZoomTransition || wantsSlideTransition) {
    let transitionType = "fade";
    if (wantsCrossfade) transitionType = "crossfade";
    else if (wantsZoomTransition) transitionType = "zoom";
    else if (wantsSlideTransition) transitionType = "slide";

    const videoTrack =
      project.tracks.find(
        (track) =>
          track.kind === "video" &&
          !/motion|overlay|transici|v0|fondo\s*ambient/i.test(track.name),
      ) ?? project.tracks.find((track) => track.kind === "video");
    if (videoTrack && videoTrack.clips.length >= 2) {
      const sortedClips = [...videoTrack.clips].sort((a, b) => a.startFrame - b.startFrame);
      for (let i = 0; i < sortedClips.length - 1; i++) {
        const clipA = sortedClips[i]!;
        const clipB = sortedClips[i + 1]!;
        if (clipA.type !== "audio" && clipB.type !== "audio") {
          const fpsValue = project.settings.fps.num / project.settings.fps.den;
          const fadeFrames = Math.min(30, Math.floor(clipA.durationFrames / 4), Math.floor(clipB.durationFrames / 4));
          if (fadeFrames > 0) {
            steps.push(
              step(
                "set_clip_fade",
                `Transición ${transitionType} entre "${clipA.name.slice(0, 30)}" y "${clipB.name.slice(0, 30)}"`,
                { clipId: clipA.id, fadeOutFrames: fadeFrames, transitionType },
                `${transitionType}-out de ${fadeFrames} frames en el final del primer clip.`,
              ),
            );
            steps.push(
              step(
                "set_clip_fade",
                `Transición ${transitionType} entre "${clipA.name.slice(0, 30)}" y "${clipB.name.slice(0, 30)}"`,
                { clipId: clipB.id, fadeInFrames: fadeFrames, transitionType },
                `${transitionType}-in de ${fadeFrames} frames en el inicio del segundo clip.`,
              ),
            );
          }
        }
      }
    } else if (targetClipId) {
      const targetClip = project.tracks
        .flatMap((track) => track.clips)
        .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text");
      if (targetClip) {
        const fpsValue = project.settings.fps.num / project.settings.fps.den;
        const fadeFrames = Math.min(30, Math.floor(targetClip.durationFrames / 4));
        if (fadeFrames > 0) {
          steps.push(
            step(
              "set_clip_fade",
              `Transición ${transitionType} en "${targetClip.name.slice(0, 40)}"`,
              { clipId: targetClip.id, fadeOutFrames: fadeFrames, transitionType },
              `${transitionType}-out de ${fadeFrames} frames en el final del clip.`,
            ),
          );
        }
      }
    } else {
      warnings.push("Se necesitan al menos dos clips de video en la línea de tiempo para crear una transición, o selecciona un clip específico.");
    }
  }

  if (wantsZoomKeyframes) {
    const targetClip = targetClipId
      ? project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.id === targetClipId && clip.type !== "text")
      : project.tracks
          .flatMap((track) => track.clips)
          .find((clip): clip is MediaClip => clip.type === "video");
    if (targetClip) {
      const fpsValue = project.settings.fps.num / project.settings.fps.den;
      const durationFrames = Math.max(1, targetClip.durationFrames);
      const seconds = detectAllSeconds(instruction).filter(
        (value) => value * fpsValue < durationFrames,
      );
      const points = new Map<number, number>();
      const addPoint = (frame: number, scale: number) => {
        const clamped = Math.max(0, Math.min(durationFrames, Math.round(frame)));
        points.set(clamped, Math.round(scale * 1000) / 1000);
      };
      if (seconds.length > 0) {
        // Zoom localizado: entra en 0,55 s, mantiene 1,1 s y vuelve suavemente.
        addPoint(0, 1);
        addPoint(durationFrames, 1);
        for (const second of seconds) {
          const centerFrame = second * fpsValue;
          addPoint(centerFrame - 0.55 * fpsValue, 1);
          addPoint(centerFrame, 1.25);
          addPoint(centerFrame + 1.1 * fpsValue, 1.25);
          addPoint(centerFrame + 1.8 * fpsValue, 1);
        }
      } else {
        // Sin marcas de tiempo no se inventan clics: se aplica un acercamiento progresivo suave.
        addPoint(0, 1);
        addPoint(durationFrames * 0.55, 1.1);
        addPoint(durationFrames * 0.9, 1.1);
        addPoint(durationFrames, 1);
      }
      const sortedPoints = [...points.entries()].sort((a, b) => a[0] - b[0]);
      if (sortedPoints.length < 2) {
        sortedPoints.push([durationFrames, sortedPoints[0]?.[1] ?? 1]);
      }
      const keyframes = sortedPoints.map(([frame, scale]) => ({ frame, scale }));
      steps.push(
        step(
          "set_clip_zoom_keyframes",
          `Zoom dinámico en "${targetClip.name.slice(0, 40)}"`,
          { clipId: targetClip.id, keyframes },
          seconds.length > 0
            ? `Se interpola el zoom en los segundos indicados (${seconds.join(", ")} s) y vuelve al encuadre original.`
            : "Se aplica un acercamiento progresivo suave con vuelta al encuadre original.",
        ),
      );
      warnings.push(
        seconds.length > 0
          ? "El zoom se centra en los segundos indicados. Puedes pedir otro punto con «zoom a los N segundos»."
          : "No puedo detectar clics ni acciones automáticamente: se aplica un zoom progresivo suave. Indica los segundos exactos (por ejemplo «zoom a los 5 y 12 segundos») para un zoom localizado.",
      );
    } else {
      warnings.push("No hay ningún clip de video en la línea de tiempo al que aplicar keyframes de zoom.");
    }
  }

  if (wantsTitle && !graphicPreset) {
    const titleText = quoted[0] ?? project.name;
    steps.push(
      step("add_text_overlay", "Añadir título inicial", {
        text: titleText,
        role: "title",
        startSeconds: 0.4,
        durationSeconds: 4,
        position: "center",
      }),
    );
    if (!quoted[0]) warnings.push(`El título usa el nombre del proyecto ("${project.name}"); puedes editarlo en el inspector.`);
  }

  if (wantsCta) {
    // El primer texto citado puede pertenecer al motion graphic o al título;
    // el CTA usa el siguiente para no duplicar el mismo rótulo.
    const ctaIndex = (wantsTitle && !graphicPreset ? 1 : 0) + (graphicPreset ? 1 : 0);
    if (quoted.length > ctaIndex) {
      const ctaText = quoted[ctaIndex]!;
      const duration = Math.max(1, framesToSeconds(timelineDurationFrames(project), project.settings.fps));
      steps.push(
        step("add_text_overlay", "Añadir llamada a la acción final", {
          text: ctaText,
          role: "caption",
          startSeconds: Math.max(0, duration - 4.5),
          durationSeconds: 4,
          position: "lower-third",
        }),
      );
    } else {
      warnings.push("No se añadió la llamada a la acción porque falta el texto exacto entre comillas.");
    }
  }

  if (wantsLowerVolume) {
    const audioClip =
      project.tracks
        .filter((track) => track.kind === "audio")
        .flatMap((track) => track.clips)
        .find((clip): clip is MediaClip => clip.type === "audio") ??
      project.tracks
        .flatMap((track) => track.clips)
        .find((clip): clip is MediaClip => clip.type === "audio");
    if (audioClip) {
      steps.push(
        step(
          "adjust_audio",
          "Bajar el volumen del audio",
          {
            clipId: audioClip.id,
            volume: Math.min(0.5, Math.round(audioClip.volume * 0.45 * 100) / 100),
          },
          "Se reduce el volumen del clip de audio; el archivo original no se modifica.",
        ),
      );
    } else {
      warnings.push("No hay ningún clip de audio en la línea de tiempo para bajar el volumen.");
    }
  }

  if (wantsVoice) {
    steps.push(
      step(
        "enhance_voice",
        "Mejorar la voz y reducir ruido",
        {},
        "Aplica highpass, reducción de ruido y compresión al render; el original no se modifica.",
      ),
    );
  }

  if (wantsDynamic && !wantsHighlights) {
    const clips = project.tracks
      .filter((track) => track.kind === "video" && !track.hidden)
      .flatMap((track) => track.clips)
      .filter((clip) => clip.type === "video")
      .slice(0, 6);
    for (const clip of clips) {
      if (clip.type !== "video") continue;
      if (clip.speed < 1.15) {
        steps.push(
          step("set_clip_speed", `Acelerar "${clip.name.slice(0, 40)}"`, {
            clipId: clip.id,
            speed: 1.15,
          }),
        );
      }
    }
    if (steps.length === 0) warnings.push("Los clips ya están a 1,15x o más; no se modificó el ritmo.");
  }

  if (seconds && !wantsHighlights && !wantsZoomKeyframes && !graphicPreset) {
    const duration = framesToSeconds(timelineDurationFrames(project), project.settings.fps);
    if (duration > seconds + 0.5) {
      steps.push(
        step(
          "fit_duration",
          `Ajustar el montaje a ${seconds} segundos`,
          { targetSeconds: seconds },
          "Recorte determinista desde el final; revisa los últimos planos.",
        ),
      );
      warnings.push("El ajuste de duración recorta el final del montaje. Usa 'mejores momentos' para una selección inteligente.");
    }
  }

  if (wantsRepeated) {
    warnings.push("La detección de contenido repetido no está implementada de forma fiable; no se aplicó ningún corte.");
  }
  if (wantsMusic) {
    warnings.push("No se añadió música: no hay generación musical ni recurso musical seleccionado. Importa un audio y colócalo en la pista de audio.");
  }

  if (wantsExport) {
    const wantsRemotionEngine = /\bremotion\b/.test(text);
    steps.push(
      step(
        "render_export",
        "Preparar exportación MP4",
        {
          resolution:
            requestedResolution ??
            nearestExportResolution(Math.min(project.settings.width, project.settings.height)),
          aspect: wantsVertical ? "9:16" : wantsSquare ? "1:1" : project.settings.aspect,
          quality: "standard",
          ...(wantsRemotionEngine ? { engine: "remotion" as const } : {}),
        },
        wantsRemotionEngine
          ? "La capa de gráficos se renderiza con Remotion (springs y easing reales) y se compone sobre el video base con FFmpeg."
          : "La exportación se ejecuta en segundo plano con FFmpeg y se verifica con FFprobe.",
      ),
    );
  }

  if (constraints.keepRanges.length > 0 && !wantsHighlights) {
    steps.push(
      step(
        "keep_time_ranges",
        `Conservar ${constraints.keepRanges.length} tramo(s) indicado(s)`,
        { ranges: constraints.keepRanges },
        "Mantiene solo los intervalos temporales indicados por el usuario y compacta el resto.",
      ),
    );
  } else if (constraints.cutRanges.length > 0) {
    const descCuts = [...constraints.cutRanges].sort((a, b) => b.startSeconds - a.startSeconds);
    for (const rng of descCuts) {
      steps.push(
        step(
          "cut_time_range",
          `Cortar de ${rng.startSeconds}s a ${rng.endSeconds}s`,
          { startSeconds: rng.startSeconds, endSeconds: rng.endSeconds, ripple: true },
          "Elimina el tramo temporal indicado y compacta la línea de tiempo.",
        ),
      );
    }
  }

  if (constraints.noSubs) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]!.tool === "generate_subtitles") steps.splice(i, 1);
    }
  }
  if (constraints.noSilenceCut) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]!.tool === "remove_silences") steps.splice(i, 1);
    }
  }

  // Peticiones abiertas del tipo «edítalo con las nuevas tendencias», «hazlo
  // viral», «que quede profesional». Antes se respondía «no entiendo la
  // instrucción»; ahora se entrega una edición vertical corta y legible, y
  // las peticiones creativas libres / sin plantillas activan el enjambre autónomo o motion TSX.
  if (steps.length === 0) {
    const wantsCustomMotionOnly =
      !isMacroSwarmPrompt(instruction) &&
      /\b(sin\s+plantillas|bespoke|personalizad[oa]|a\s+medida|part[íi]culas|neuronal|onda|ecg|3d|canvas|diagrama|hologr)\b/i.test(
        text,
      );
    const bypassesClassicTrendPreset =
      /\b(sin\s+plantillas|remotion|enjambre|hyperframes|documental|matrix|sin\s+subt[íi]tulos|sin\s+zoom|color\s+natural)\b/i.test(
        text,
      );
    const wantsTrendEdit =
      !textIntent.wantsText &&
      !bypassesClassicTrendPreset &&
      /tendencia|trend|viral|viraliz|impactante|hazlo (?:viral|profesional|cinematografico)|increible|atractiv|dinamico|para (?:tiktok|reels|shorts|redes)|edita(?:me|r|lo)? (?:el |este )?video|mejora(?:me|r|lo)? (?:el |este )?video|optimiza(?:me|r|lo)? (?:el |este )?video/.test(
        text,
      );
    if (wantsTrendEdit && project.tracks.some((track) => track.clips.length > 0)) {
      // El objetivo del resumen se calcula sobre el MATERIAL, no sobre el
      // montaje actual: si el timeline ya viene troceado (por ejemplo 50
      // micro-cortes de 0,5 s) un 22 % de 21 s daba un resumen de 15 s.
      const timelineSeconds = framesToSeconds(
        timelineDurationFrames(project),
        project.settings.fps,
      );
      const sourceSeconds = targetMediaId
        ? (project.media.find((media) => media.id === targetMediaId)?.durationUs ?? 0) / 1_000_000
        : Math.max(0, ...project.media.map((media) => media.durationUs / 1_000_000));
      const durationSeconds = Math.max(timelineSeconds, sourceSeconds);
      const needsVertical =
        project.settings.aspect !== "9:16" || Math.min(project.settings.width, project.settings.height) < 1080;
      const highlightTarget = Math.max(15, Math.min(45, Math.round(durationSeconds * 0.22)));
      if (needsVertical) {
        steps.push(
          step(
            "change_aspect_ratio",
            "Reencuadrar en vertical 9:16 (1080x1920)",
            { aspect: "9:16" },
            "Se recorta el material para llenar el lienzo vertical sin bandas negras.",
          ),
        );
      }
      if (durationSeconds > highlightTarget * 2) {
        steps.push(
          step(
            "select_highlights",
            `Montar un resumen de ~${highlightTarget} s`,
            {
              ...(targetMediaId ? { mediaId: targetMediaId } : {}),
              targetSeconds: highlightTarget,
            },
            "Se eligen pasajes de voz completos (sin micro-cortes) y se descarta el relleno.",
          ),
        );
        warnings.push(
          "El resumen se arma con pasajes de voz; revisa el orden de los cortes antes de publicar.",
        );
      }
      steps.push(
        step(
          "enhance_voice",
          "Limpiar y realzar la voz",
          {},
          "Se aplica reducción de ruido y compresión suave al audio de los clips.",
        ),
      );
      steps.push(
        step(
          "generate_subtitles",
          "Subtítulos dinámicos legibles",
          { ...(targetMediaId ? { mediaId: targetMediaId } : {}), maxChars: 56, style: "clean-pop" },
          "Texto grande con contorno, sincronizado con la transcripción real.",
        ),
      );
      steps.push(
        step(
          "render_export",
          "Exportar MP4 vertical",
          { resolution: 1080, aspect: "9:16", quality: "standard" },
          "Salida 1080x1920 lista para TikTok, Reels y Shorts.",
        ),
      );
    } else if (wantsCustomMotionOnly) {
      const startSeconds = detectGraphicStartSeconds(instruction) ?? 0;
      const durationSeconds = detectGraphicDurationSeconds(instruction) ?? 4;
      steps.push(
        step(
          "execute_custom_motion",
          "Diseñar gráfico Remotion TSX personalizado",
          {
            prompt: instruction,
            startSeconds,
            durationSeconds,
            ...(constraints.customTintHex ? { accentColor: constraints.customTintHex } : {}),
          },
          "Sintetiza y compila una escena Remotion a medida sin depender de plantillas fijas.",
        ),
      );
    } else if (
      (/\b(edita|editar|edicion|video|reel|trailer|documental|corto|clip|montaje|escena|remotion|hyperframes|enjambre|tintes?|color|lut|grafic|transicion|subtitul|zooms?|silencios?|efectos?|sfx|audio|voz|cinematografic|vintage|noir|cyber|matrix|estilo)\b/i.test(
        text,
      ) &&
        (isMacroSwarmPrompt(instruction) || bypassesClassicTrendPreset)) ||
      (project.media.length === 0 &&
        /\b(crea|genera|haz|video|reel|promo|documental|intro|comercial|historia)\b/i.test(text))
    ) {
      steps.push(
        step(
          "execute_autonomous_edit_swarm",
          "Ejecutar edición autónoma sin plantillas",
          { prompt: instruction },
          "Orquesta el Director IA, cortes quirúrgicos, gráficos Remotion a medida, color y audio según tu petición.",
        ),
      );
    }
  }

  if (steps.length === 0) {
    throw new HttpError(
      422,
      "No he identificado una operación compatible en esa instrucción. Puedo editar el video libremente a medida, cortar rangos exactos, eliminar silencios, generar subtítulos, crear motion TSX sin plantillas, cambiar el formato, mejorar la voz o exportar.",
      "intent_not_supported",
    );
  }

  // El orden importa: primero se reconstruye el material y después se generan
  // subtitulos o textos sobre el montaje resultante.
  const priority: Record<string, number> = {
    select_highlights: 10,
    keep_time_ranges: 11,
    cut_time_range: 12,
    execute_autonomous_edit_swarm: 15,
    remove_silences: 20,
    adjust_audio: 25,
    enhance_voice: 30,
    change_aspect_ratio: 40,
    set_clip_speed: 50,
    fit_duration: 60,
    remove_subtitles: 65,
    generate_subtitles: 70,
    set_clip_timing: 74,
    create_motion_graphic: 78,
    execute_custom_motion: 79,
    add_text_overlay: 80,
    render_export: 100,
  };
  steps.sort((a, b) => (priority[a.tool] ?? 90) - (priority[b.tool] ?? 90));

  const uniqueSteps: DraftStep[] = [];
  const seen = new Set<string>();
  for (const draft of steps) {
    const key = `${draft.tool}:${JSON.stringify(draft.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueSteps.push(draft);
  }

  return {
    summary: [
      uniqueSteps.map((item) => item.title).join(". ") + ".",
      ...warnings,
    ].join(" "),
    steps: uniqueSteps,
    warnings,
    source: "local",
  };
}

function validateDraft(project: Project, draft: PlanDraft): DraftStep[] {
  if (draft.steps.length === 0) throw new HttpError(422, "El plan no contiene operaciones.", "empty_plan");
  const validated: DraftStep[] = [];
  for (const raw of draft.steps) {
    const normalizedArgs = raw.tool === "set_clip_animation"
      ? {
          ...raw.args,
          ...(typeof raw.args.animationInDuration === "number"
            ? { animationInDuration: Math.round(raw.args.animationInDuration) }
            : {}),
          ...(typeof raw.args.animationOutDuration === "number"
            ? { animationOutDuration: Math.round(raw.args.animationOutDuration) }
            : {}),
        }
      : raw.args;
    const result = validateToolArgs(raw.tool, normalizedArgs);
    if (!result.ok) {
      throw new HttpError(422, `El plan contiene argumentos invalidos: ${result.error}`, "invalid_plan_args");
    }
    const args = result.data as Record<string, unknown>;
    const clipId = typeof args.clipId === "string" ? args.clipId : undefined;
    if (clipId) {
      const exists = project.tracks.some((track) => track.clips.some((clip) => clip.id === clipId));
      if (!exists) throw new HttpError(422, `El plan referencia un clip inexistente: ${clipId}.`, "invalid_plan_reference");
    }
    const trackId = typeof args.trackId === "string" ? args.trackId : undefined;
    if (trackId && !project.tracks.some((track) => track.id === trackId)) {
      throw new HttpError(422, `El plan referencia una pista inexistente: ${trackId}.`, "invalid_plan_reference");
    }
    const mediaId = typeof args.mediaId === "string" ? args.mediaId : undefined;
    if (mediaId && !project.media.some((asset) => asset.id === mediaId)) {
      throw new HttpError(422, `El plan referencia un recurso inexistente: ${mediaId}.`, "invalid_plan_reference");
    }
    validated.push({
      tool: raw.tool,
      title: raw.title,
      reason: raw.reason,
      args,
      risk: raw.risk ?? result.definition.risk,
    });
  }
  return validated;
}

function compactProject(project: Project) {
  const fpsNum = project.settings.fps.num / Math.max(1, project.settings.fps.den);
  return {
    id: project.id,
    name: project.name,
    settings: project.settings,
    durationSeconds: Number(framesToSeconds(timelineDurationFrames(project), project.settings.fps).toFixed(2)),
    media: project.media.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      durationSeconds: Number((asset.durationUs / 1e6).toFixed(2)),
      width: asset.width,
      height: asset.height,
      hasAudio: Boolean(asset.audioCodec),
    })),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      muted: track.muted,
      hidden: track.hidden,
      clips: track.clips.slice(0, 60).map((clip) => ({
        id: clip.id,
        type: clip.type,
        name: clip.name,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        startSec: Number((clip.startFrame / fpsNum).toFixed(2)),
        durationSec: Number((clip.durationFrames / fpsNum).toFixed(2)),
        ...(clip.type === "text"
          ? { text: clip.text }
          : { mediaId: clip.mediaId, sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs, speed: clip.speed }),
      })),
    })),
  };
}

async function buildLlmDraft(
  project: Project,
  instruction: string,
  selection: PlannerSelection | undefined,
  history: Array<{ role: string; text: string }>,
): Promise<{ draft: PlanDraft; model: string }> {
  const system = `Responde SIEMPRE con JSON válido: {"summary": string, "steps": [{"tool": string, "title": string, "reason": string, "args": object}], "warnings": string[]}

Eres un editor de video senior que ayuda al usuario de forma conversacional. Habla en español natural y cercano.

En "summary" escribe una frase natural y conversacional (ej: "¡Perfecto! Voy a cambiar el estilo de los subtítulos. ¿Qué estilo prefieres?").

Reglas:
- Usa IDs existentes del proyecto. No inventes clipId, mediaId ni trackId.
- Para "eliminar silencios" usa remove_silences.
- Para eliminar subtítulos o leyendas existentes usa remove_subtitles. Nunca uses generate_subtitles para borrar subtítulos.
- Para crear subtítulos usa generate_subtitles; pasa el estilo en el argumento style usando los IDs del catálogo (clean, impact, card, viral, neon, cinema, editorial, highlight, minimal, modern, real-estate, phrase-highlight, clean-pop).
- Para cambiar el tamaño, color o estilo de subtítulos existentes usa change_subtitle_style; para estilo dinámico Real Estate/CapCut, frases resaltadas o Moderno Pop usa apply_dynamic_subtitle_preset. No uses herramientas de zoom para cambios tipográficos. El color es uniforme por frase; no afirmes que puedes colorear palabras individuales.
- Para "zoom en clic" o "zoom en acciones" usa SIEMPRE set_clip_zoom_keyframes. NO es un evento interactivo, es un zoom dinámico. Aplícalo directamente.
- Para "mejores momentos" usa select_highlights.
- Si usas select_highlights, colócalo ANTES de generate_subtitles, de los textos y del zoom: el resumen reordena la línea de tiempo y todo lo demás debe construirse sobre el resultado.
- Para formato vertical usa change_aspect_ratio (antes de select_highlights si vas a hacer las dos cosas).
- Para mejorar voz usa enhance_voice.
- Para títulos usa add_text_overlay con el texto literal del usuario.
- Para motion graphics (lower thirds, callouts, ganchos o títulos cinéticos) usa create_motion_graphic.
- Para gráficos estadísticos, barras, contadores, porcentajes o datos animados usa create_motion_graphic con preset stat-bars, stat-counter o stat-progress y pasa "data": [{"label":"...","value":n}] y "value"/"unit" cuando el usuario dé cifras. Si no da cifras, usa datos de ejemplo editables y avísalo en warnings.
- Para intros, outros, portadas o tarjetas de título usa create_motion_graphic con preset title-card; para formas geométricas decorativas, shape-accent.
- Para alargar, acortar o mover un texto ya existente usa set_clip_timing con su clipId; NO crees un texto nuevo ni pidas la frase otra vez.
- Si el usuario pide generar una frase o copy (emotiva, juvenil, profesional, viral...) sin darla, redacta tú una frase breve y original y colócala centrada con create_motion_graphic (preset kinetic-title). No pidas más datos.
- Si el usuario solo pide un texto, devuelve solo ese paso de texto: no añadas formato, voz, subtítulos ni exportación.
- Si el usuario pide "Remotion" para los gráficos, añade "engine": "remotion" al paso render_export.
- Los segundos que pases a textos o zoom deben estar dentro de la duración FINAL del montaje, no la del video original.
- Si el proyecto NO tiene archivos en \`media\` (\`media: []\`) y el usuario pide crear o generar un video/reel/promo/animación desde cero, utiliza \`execute_autonomous_edit_swarm\` pasando \`"prompt"\` con toda la instrucción completa (y opcionalmente \`change_aspect_ratio\` primero si indicó formato).
- Si el proyecto SÍ tiene vídeo real y el usuario pide una edición integral creativa/estilizada ("estilo documental", "como trailer", "con estética Matrix", "edición completa personalizada", color + cortes + gráficos a medida + audio), utiliza \`execute_autonomous_edit_swarm\` con \`"prompt"\` literal completo del usuario (pasando \`enableSilenceCut\`, \`enablePunches\`, \`enableBrollCards\` en \`false\` si el usuario pidió omitir silencios, zooms o gráficos).
- Para cortar o conservar rangos temporales concretos de video/audio/subtítulos, usa \`cut_time_range\` (\`startSeconds\`, \`endSeconds\`, \`ripple\`) o \`keep_time_ranges\` (\`ranges: [{ startSeconds, endSeconds }]\`). Si realizas varios \`cut_time_range\`, ordénalos de mayor a menor \`startSeconds\`.
- Para crear animaciones, diagramas, partículas 3D, efectos Canvas o motion graphics LIBRES sin limitarse a las 9 plantillas básicas, usa \`execute_custom_motion\` con \`prompt\`, \`title\`, \`startSeconds\`, \`durationSeconds\`, \`zone\`, \`transparent\` y \`accentColor\`.
- Respeta estrictamente restricciones negativas del usuario ("sin subtítulos", "sin cortar silencios", "sin zooms", "sin gráficos", "sin música", "color natural").
- Máximo 12 pasos. Ordena: formato, cortes/resumen, subtítulos, textos, zoom, export al final.
- Si no puedes cumplir exactamente, propón la mejor aproximación en warnings.

Herramientas:
${toolCatalog()}

Proyecto:
${JSON.stringify(compactProject(project))}

Historial:
${history.slice(-4).map((message) => `${message.role}: ${message.text}`).join("\n") || "(sin historial)"}

Selección: ${JSON.stringify(selection ?? {})}`;

  const user = `Instrucción del usuario: ${instruction}`;
  const timeoutMs = Math.min(config.ai.timeoutMs, 30_000);
  const first = await chatJson(system, user, AbortSignal.timeout(timeoutMs), { maxTokens: 1400 });
  let parsed = llmPlanSchema.safeParse(first.data);
  let repairedData: unknown = first.data;
  if (!parsed.success) {
    const repair = await chatJson(
      `${system}\n\nLa respuesta anterior no cumplía el esquema. Corrige el JSON y devuelve solo JSON válido. Errores: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
      `${user}\n\nRespuesta anterior:\n${JSON.stringify(first.data).slice(0, 10000)}`,
      AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
      { maxTokens: 1400 },
    );
    parsed = llmPlanSchema.safeParse(repair.data);
    repairedData = repair.data;
    if (!parsed.success) {
      throw new HttpError(502, "El modelo no produjo un plan válido tras el reintento.", "invalid_ai_plan");
    }
  }
  const draft: PlanDraft = {
    summary: parsed.data.summary,
    steps: parsed.data.steps.map((item) => ({
      tool: item.tool,
      title: item.title,
      reason: item.reason,
      args: item.args,
      risk: item.risk ?? getTool(item.tool).risk,
    })),
    warnings: parsed.data.warnings,
    source: "llm",
  };
  void repairedData;
  return { draft, model: first.model };
}

export async function buildPlan(
  project: Project,
  instruction: string,
  options: { selection?: PlannerSelection; preferLocal?: boolean; history?: Array<{ role: string; text: string }> } = {},
): Promise<{ plan: AgentPlan; source: "llm" | "local"; model?: string }> {
  const trimmed = instruction.trim();
  if (!trimmed) throw new HttpError(422, "Escribe una instrucción para el agente.", "empty_instruction");
  if (trimmed.length > 4000) throw new HttpError(422, "La instrucción es demasiado larga.", "instruction_too_long");
  const status = aiStatus();
  const canUseAi = status.chat && aiChatReady();
  const textIntent = detectTextIntent(trimmed);
  const textEdit = detectTextEditIntent(project, trimmed, options.selection);
  let draft: PlanDraft;
  let model: string | undefined;
  if (textEdit) {
    draft = buildTextEditDraft(project, trimmed, textEdit);
  } else if (textIntent.wantsText && !textIntent.withOtherEdits) {
    const literal = textIntent.literalText;
    if (literal) {
      draft = buildTextDraft(project, trimmed, textIntent, literal, "literal");
    } else if (textIntent.generateCopy) {
      if (options.preferLocal || !canUseAi) {
        draft = buildTextDraft(
          project,
          trimmed,
          textIntent,
          fallbackCopy(trimmed, textIntent),
          "fallback",
          status.chat
            ? undefined
            : "No hay proveedor de IA configurado; usé una frase de reserva acorde al tono pedido. Puedes pedirme otra variante.",
        );
      } else {
        const copy = await generateCopy(trimmed, textIntent);
        draft = buildTextDraft(
          project,
          trimmed,
          textIntent,
          copy.phrase,
          copy.source,
          copy.source === "fallback"
            ? "El copiloto no respondió a tiempo; usé una frase de reserva acorde al tono pedido. Puedes pedirme otra variante."
            : undefined,
        );
        if (copy.source === "ai") model = status.model;
      }
    } else {
      throw new HttpError(
        422,
        "Dime el texto exacto que quieres que aparezca o pídeme que genere una frase (por ejemplo: «genera una frase emotiva y profesional»).",
        "text_required",
      );
    }
  } else if (
    subtitleAppearanceRequest(project, trimmed) ||
    subtitleAnimationRequest(trimmed) ||
    splitSubtitlesRequest(trimmed) ||
    removeSubtitlesRequest(trimmed) ||
    zoomKeyframeRequest(trimmed) ||
    (motionGraphicPreset(normalize(trimmed)) &&
      !isMacroSwarmPrompt(trimmed) &&
      !/\b(sin\s+plantillas|bespoke|a\s+medida|personalizad|3d|part[íi]culas|neuronal|canvas|hologr|tsx|hyperframes|remotion)\b/i.test(
        normalize(trimmed),
      ))
  ) {
    draft = buildLocalDraft(project, trimmed, options.selection);
  } else if (!options.preferLocal && canUseAi) {
    try {
      const result = await buildLlmDraft(project, trimmed, options.selection, options.history ?? []);
      draft = result.draft;
      model = result.model;
    } catch (error) {
      // Si el proveedor falla o devuelve una respuesta vacía, seguimos con el
      // planificador local en lugar de dejar al usuario sin respuesta.
      let fallback: PlanDraft | null = null;
      try {
        fallback = buildLocalDraft(project, trimmed, options.selection);
      } catch (localError) {
        if (
          localError instanceof HttpError &&
          localError.code !== "intent_not_supported"
        ) {
          throw localError;
        }
      }
      if (!fallback) {
        throw error instanceof HttpError
          ? error
          : new HttpError(
              502,
              "El copiloto no respondió. Reformula la instrucción o activa el planificador local; también puedo eliminar silencios, borrar o crear subtítulos, aplicar zoom o cambiar el formato.",
              "ai_planner_failed",
            );
      }
      fallback.warnings = [
        ...fallback.warnings,
        "El copiloto no respondió a tiempo; el plan se generó con el planificador local.",
      ];
      fallback.summary = `${fallback.summary} (Plan local: el copiloto no respondió.)`;
      draft = fallback;
    }
  } else {
    draft = buildLocalDraft(project, trimmed, options.selection);
  }
  const steps = normalizeStepOrder(repairSteps(project, trimmed, validateDraft(project, draft), draft.warnings));
  const now = new Date().toISOString();
  const plan: AgentPlan = {
    id: newId("plan"),
    instruction: trimmed,
    summary: draft.summary,
    source: draft.source,
    steps: steps.map<AgentStep>((stepDraft, index) => ({
      id: `stp_${planStepSuffix(index)}`,
      tool: stepDraft.tool,
      title: stepDraft.title,
      reason: stepDraft.reason,
      args: stepDraft.args,
      risk: stepDraft.risk,
      status: "pending",
    })),
    warnings: draft.warnings,
    createdAt: now,
    status: "proposed",
  };
  return { plan, source: draft.source, model };
}

function planStepSuffix(index: number): string {
  return `${Date.now().toString(36)}${index}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Ajustes de sentido común sobre cualquier plan (del modelo o local) para que la
 * edición resulte coherente: sin rótulos inventados, con resumen de duración
 * short-form, sin recortes que rompan la sincronía y con el lienzo a 1080.
 */
function repairSteps(
  project: Project,
  instruction: string,
  steps: DraftStep[],
  warnings: string[],
): DraftStep[] {
  // Las ediciones de un texto existente (duración o animación) no crean texto:
  // los ajustes de "texto nuevo" de abajo no deben reconstruir el plan.
  if (detectTextEditIntent(project, instruction)) return steps;
  let next = [...steps];
  const textIntent = detectTextIntent(instruction);
  const textTools = new Set(["add_text_overlay", "create_motion_graphic"]);
  const textOnly = textIntent.wantsText && !textIntent.withOtherEdits;
  const hasHighlights = next.some((item) => item.tool === "select_highlights");

  // 1) Un texto literal solo se acepta si está en la instrucción. El copy
  // generado por el copiloto se acepta únicamente cuando el usuario lo pidió
  // explícitamente («genera una frase...»).
  const quoted = quotedTexts(instruction).map((text) => normalize(text));
  const plainInstruction = normalize(instruction);
  next = next.filter((item) => {
    if (!textTools.has(item.tool)) return true;
    const text = typeof item.args.text === "string" ? normalize(item.args.text) : "";
    if (!text) return false;
    const preset = typeof item.args.preset === "string" ? item.args.preset : "";
    const dataGraphic = item.tool === "create_motion_graphic" && isDataGraphicPreset(preset);
    const accepted =
      textIntent.generateCopy ||
      dataGraphic ||
      plainInstruction.includes(text) ||
      quoted.some((quote) => quote.includes(text) || text.includes(quote));
    if (!accepted) {
      warnings.push(
        `Se omitió el rótulo "${String(item.args.text)}": no aparece en tu instrucción y no se inventa texto.`,
      );
    }
    return accepted;
  });

  // 1b) Si solo se pidió un texto, el plan no debe incluir formato, voz,
  // subtítulos ni exportación. Y nunca debe quedar vacío.
  if (textOnly) {
    next = next.filter((item) => textTools.has(item.tool) || item.tool === "execute_custom_motion");
  }
  if (next.length === 0 && textIntent.wantsText) {
    next.push(
      buildTextStep(
        project,
        instruction,
        textIntent,
        textIntent.literalText ?? fallbackCopy(instruction, textIntent),
      ),
    );
  }

  // 1c) Un texto debe poder leerse: duración corta y posición coherente aunque
  // el modelo elija valores arbitrarios (p. ej. un título de 18 s en la parte
  // superior cuando no se pidió posición).
  if (textIntent.wantsText) {
    const explicitPosition =
      /centro|medio|arriba|abajo|inferior|superior|tercio|lower.?third|\btop\b|\bbottom\b/.test(
        plainInstruction,
      );
    const explicitStart = detectGraphicStartSeconds(instruction) !== null;
    const explicitDuration = detectGraphicDurationSeconds(instruction) !== null;
    const isCta =
      textIntent.role === "caption" ||
      /cta|llamada a la accion|cierre|final/.test(plainInstruction);
    next = next.map((item) => {
      if (!textTools.has(item.tool)) return item;
      const args = { ...item.args };
      const preset = typeof args.preset === "string" ? args.preset : "";
      const dataGraphic = item.tool === "create_motion_graphic" && isDataGraphicPreset(preset);
      if (!explicitDuration) {
        const current = typeof args.durationSeconds === "number" ? args.durationSeconds : dataGraphic ? 5 : 3.5;
        args.durationSeconds = dataGraphic
          ? Math.min(8, Math.max(4, current))
          : item.tool === "add_text_overlay"
            ? Math.min(5, Math.max(2.2, current))
            : Math.min(6, Math.max(2.5, current));
      }
      if (item.tool === "add_text_overlay" && !isCta) {
        args.position = explicitPosition ? textIntent.position : "center";
        if (!explicitStart) args.startSeconds = 0;
      }
      return { ...item, args };
    });
  }

  // 2) Tras un resumen, recortar silencios con ripple descoloca subtítulos y
  // rótulos. La selección de pasajes ya evita el relleno.
  if (hasHighlights && next.some((item) => item.tool === "remove_silences")) {
    next = next.filter((item) => item.tool !== "remove_silences");
    warnings.push(
      "La selección de momentos ya descarta los silencios; se omitió el recorte extra para no desincronizar el texto.",
    );
  }

  // 3) Formato corto: un resumen de 2 minutos no es una edición viral. Se limita
  // a 60 s salvo que el usuario haya pedido una duración concreta. «Profesional»
  // o «emotiva» describiendo un texto no convierten la petición en una edición
  // genérica: solo las fórmulas explícitas cuentan.
  const broadEditRequest =
    !textIntent.wantsText &&
    /tendencia|trend|viral|viraliz|impactante|hazlo (?:viral|profesional|cinematografico)|para (?:tiktok|reels|shorts|redes)|edita(?:me|r|lo)? (?:el |este )?video|mejora(?:me|r|lo)? (?:el |este )?video|optimiza(?:me|r|lo)? (?:el |este )?video/.test(
      plainInstruction,
    );
  if (broadEditRequest && detectDurationSeconds(instruction) === null) {
    next = next.map((item) => {
      if (item.tool !== "select_highlights") return item;
      const target = typeof item.args.targetSeconds === "number" ? item.args.targetSeconds : 30;
      if (target <= 60) return item;
      return { ...item, args: { ...item.args, targetSeconds: 60 } };
    });
  }

  // 4) Lienzo de entrega: si se exporta en vertical/cuadrado y el proyecto no
  // llega a 1080 en el lado corto, se antepone el cambio de formato (que además
  // reencuadra para llenar el lienzo y evita las bandas negras).
  const exportStep = next.find((item) => item.tool === "render_export");
  const exportAspect =
    exportStep && typeof exportStep.args.aspect === "string"
      ? (exportStep.args.aspect as AspectRatio)
      : undefined;
  const wantedAspect = exportAspect ?? project.settings.aspect;
  const shortEdge = Math.min(project.settings.width, project.settings.height);
  const hasFormatStep = next.some((item) => item.tool === "change_aspect_ratio");
  const aspectChanged = exportAspect !== undefined && exportAspect !== project.settings.aspect;
  if (!textOnly && !hasFormatStep && (shortEdge < 1080 || aspectChanged)) {
    next.unshift({
      tool: "change_aspect_ratio",
      title: `Reencuadrar a ${ASPECT_PRESETS[wantedAspect].label} a 1080`,
      reason: "Se ajusta el lienzo y se recorta el material para llenarlo, sin bandas negras.",
      args: { aspect: wantedAspect },
      risk: "medium",
    });
  }

  // 5) Entrega: una edición para redes debe terminar en un MP4 publicable. Si el
  // plan no exporta, se añade la exportación al final.
  const hasAutonomousSwarm = next.some((item) => item.tool === "execute_autonomous_edit_swarm");
  const explicitExportRequested = /export|render|descarga|redes sociales|publicar|mp4/.test(plainInstruction);
  if (broadEditRequest && !next.some((item) => item.tool === "render_export") && (!hasAutonomousSwarm || explicitExportRequested)) {
    next.push({
      tool: "render_export",
      title: "Exportar MP4 listo para publicar",
      reason: /\bremotion\b/.test(plainInstruction)
        ? "Gráficos renderizados con Remotion y compuestos sobre el video base."
        : "Salida H.264/AAC a 1080 en el lado corto, verificada con FFprobe.",
      args: {
        resolution: 1080,
        aspect: wantedAspect,
        quality: "standard",
        ...(/\bremotion\b/.test(plainInstruction) ? { engine: "remotion" as const } : {}),
      },
      risk: "high",
    });
  }

  return next;
}

/**
 * El resumen por momentos reescribe la pista de video. Si el modelo coloca ese
 * paso después de los subtítulos o del zoom, esos cambios se pierden o quedan
 * desincronizados. Aquí se garantiza el orden correcto: formato, resumen y
 * después todo lo que se monta encima, con la exportación al final.
 */
function normalizeStepOrder(steps: DraftStep[]): DraftStep[] {
  if (!steps.some((step) => step.tool === "select_highlights")) return steps;
  const isExport = (tool: string) => tool === "render_export" || tool === "verify_export";
  const format = steps.filter((step) => step.tool === "change_aspect_ratio");
  const highlights = steps.filter((step) => step.tool === "select_highlights");
  const rest = steps.filter(
    (step) => step.tool !== "change_aspect_ratio" && step.tool !== "select_highlights" && !isExport(step.tool),
  );
  const exports = steps.filter((step) => isExport(step.tool));
  return [...format, ...highlights, ...rest, ...exports];
}

export function planFromDraft(draft: PlanDraft, project: Project, instruction: string): AgentPlan {
  const steps = normalizeStepOrder(repairSteps(project, instruction, validateDraft(project, draft), draft.warnings));
  return {
    id: newId("plan"),
    instruction,
    summary: draft.summary,
    source: draft.source,
    steps: steps.map<AgentStep>((stepDraft, index) => ({
      id: `stp_${planStepSuffix(index)}`,
      tool: stepDraft.tool,
      title: stepDraft.title,
      reason: stepDraft.reason,
      args: stepDraft.args,
      risk: stepDraft.risk,
      status: "pending",
    })),
    warnings: draft.warnings,
    createdAt: new Date().toISOString(),
    status: "proposed",
  };
}
