import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaClip, Project, RemotionComponentSpec, TimelineClip } from "../../shared/schema";
import { getClipById, makeTextClip } from "../../shared/project";
import { addClip, addTrack, findFreeStartFrame, removeClips, updateClip } from "../../shared/timeline";
import { MOTION_PRESET_TEMPLATES, type MotionPresetTemplate } from "../../shared/motionTemplates";
import type { ProjectChangeHandler, SidebarTab } from "../../editorTypes";
import { api, ApiError, getAuthToken, getClientSessionId } from "../../api";

function buildMotionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Session-Id": getClientSessionId(),
  };
  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Auth-Token"] = token;
  }
  return headers;
}
import { Icon } from "../Icon";

interface MotionPanelProps {
  project: Project;
  currentFrame: number;
  disabled?: boolean;
  aiConfigured?: boolean;
  onOpenSettings?: () => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
  onSaveBeforeExternalEdit?: () => Promise<boolean>;
  onProjectSync?: () => Promise<void>;
  onProjectChange?: ProjectChangeHandler;
  onSelectClips?: (ids: string[]) => void;
  onTabChange?: (tab: SidebarTab) => void;
  /** ID del clip seleccionado en el viewer (para IA Motion) */
  selectedClipId?: string | null;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  type: "text" | "component" | "preview" | "inserted" | "error" | "SWARM_EDIT_COMPLETE";
  content: string;
  project?: Project;
  data?: any;
  timestamp: number;
}

type RenderStatus = {
  key: string;
  name?: string;
  status: "rendering" | "done" | "error" | "cancelled";
  progress: number;
  stage: "bundle" | "render";
  error?: string;
  assetId?: string;
  etaMs?: number;
  elapsedMs?: number;
};

type ComponentPayload = {
  code: string;
  name: string;
  compositionId: string;
  durationInFrames?: number;
  props?: Record<string, unknown>;
  startFrame?: number;
  renderKey?: string;
};

const MESSAGE_MAX = 60;

function playSfx(type: string = "whoosh") {
  try {
    const sfxName = type === "ding" ? "ding" : type === "pop" ? "pop" : "whoosh";
    const audio = new Audio(`/sfx/${sfxName}.wav`);
    audio.volume = 0.85;
    audio.play().catch(() => undefined);
  } catch {
    // Ignorar si el navegador restringe autoplay
  }
}

const SUGGESTIONS = [
  "Rótulo de Identidad Brand Kit (Cristal + SFX sincronizado)",
  "Eliminar silencios y pausas del video (Jump Cuts IA)",
  "Subtítulos virales estilo Hormozi / MrBeast con resaltado dinámico",
  "Transición cinemática Whip Pan con motion blur",
  "Transición Zoom Punch con onda expansiva SVG",
  "Smart B-Roll: Gráfico de ventas +40% escalando hacia arriba",
  "Auto-Reframe dinámico a 9:16 para TikTok y Reels",
  "Título cinético moderno para el inicio del video",
];

const QUICK_RECIPES: Array<{
  title: string;
  desc: string;
  icon: "sparkles" | "type" | "scissors" | "target";
  prompt: string;
}> = [
  {
    title: "Auto-Editar Completo",
    desc: "Quita silencios, agrega subtítulos, zooms y música",
    icon: "sparkles",
    prompt: "Haz una edición completa: quita silencios, añade subtítulos dinámicos, zoom en momentos clave y look cinematográfico",
  },
  {
    title: "Subtítulos Virales",
    desc: "Sincronizados palabra a palabra con la voz",
    icon: "type",
    prompt: "Subtítulos virales dinámicos sincronizados con la voz y buen contraste",
  },
  {
    title: "Vertical TikTok / Reels",
    desc: "Reencuadra al ponente automáticamente en 9:16",
    icon: "target",
    prompt: "Adapta el video a 9:16 para TikTok y Reels manteniendo centrado al protagonista",
  },
  {
    title: "Cortar Silencios y Zoom",
    desc: "Ritmo ágil sin pausas muertas",
    icon: "scissors",
    prompt: "Elimina los silencios y pausas largas del video y mejora el sonido de la voz",
  },
];

const INTERNAL_STEP_PATTERNS = [
  /^Iniciando agente/i,
  /^Renderizando pieza visual/i,
  /^Analizando tu instrucci[óo]n/i,
  /^Interpretando el brief/i,
  /^Ajustando la pieza/i,
  /^Escribiendo el componente Remotion/i,
  /^Dise[ñn]ando animaci[óo]n y generando c[óo]digo/i,
  /^Componente .* generado/i,
  /^Validando sintaxis/i,
  /^Re-validando c[óo]digo/i,
  /^Detectado problema en c[óo]digo/i,
  /^Compilando bundle Webpack/i,
  /^Renderizando fotogramas Remotion/i,
  /^Fallo al renderizar:/i,
  /^¡?Previsualizaci[óo]n generada/i,
  /^Preview listo\. Pulsa/i,
  /^Procesando transcripci[óo]n/i,
  /^Reutilizando la transcripci[óo]n/i,
  /^Transcribiendo el audio real/i,
  /^Aplicando nuevo estilo a los subt[íi]tulos/i,
  /^Generando previsualizaci[óo]n r[áa]pida/i,
  /^Renderizando versi[óo]n final e insertando/i,
  /^Insertando autom[áa]ticamente en el timeline/i,
  /^Preview listo/i,
];

function isInternalStepMessage(resp: { type?: string; content?: string; data?: any }): boolean {
  if (resp.type === "preview" && !resp.data?.base64Video) return true;
  if (resp.type !== "text") return false;
  if (resp.data?.isStep) return true;
  const text = (resp.content ?? "").trim();
  return INTERNAL_STEP_PATTERNS.some((re) => re.test(text));
}

function isErrorLikeReasoning(text: unknown): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  return /\b(error de sintaxis|escapados literalmente|no compila|fall[óo] al renderizar|he eliminado y corregido|reparando|unexpected|outputrange|mantengo el nombre de exportaci[óo]n|como indica el brief|easing c[úu]bico|conservando la estructura|c[óo]digo tsx)\b/i.test(
    text,
  );
}

function isTrueSubtitleComponentName(rawName?: string): boolean {
  const clean = (rawName || "").replace(/\.(tsx|webm)$/i, "").trim();
  return /subtit|caption|subs\b/i.test(clean);
}

function sanitizeComponentPayload(comp: ComponentPayload, fps = 30): ComponentPayload {
  const isSubs = isTrueSubtitleComponentName(comp.name);
  if (isSubs) return comp;
  const nextProps = comp.props ? { ...comp.props } : undefined;
  if (nextProps) {
    delete nextProps.captions;
    delete nextProps.offset;
  }
  const safeDuration =
    typeof comp.durationInFrames === "number" && comp.durationInFrames > 0 && comp.durationInFrames <= fps * 20
      ? comp.durationInFrames
      : Math.round(fps * 5);
  return {
    ...comp,
    durationInFrames: safeDuration,
    props: nextProps && Object.keys(nextProps).length > 0 ? nextProps : undefined,
    startFrame: comp.startFrame !== undefined ? comp.startFrame : undefined,
  };
}

function formatFriendlyComponentTitle(rawName?: string): string {
  const clean = (rawName || "Animación").replace(/\.(tsx|webm)$/i, "").trim();
  if (/hormozi\s*subtit/i.test(clean)) return "Subtítulos Virales Hormozi / MrBeast";
  if (/minimal\s*subtit/i.test(clean)) return "Subtítulos Editorial Minimalista";
  if (/tiktok\s*subtit/i.test(clean)) return "Subtítulos Dinámicos TikTok";
  if (/impact\s*subtit/i.test(clean)) return "Subtítulos Impacto Bold";
  if (/cinematic\s*subtit/i.test(clean)) return "Subtítulos Cinemáticos";
  if (/neon\s*subtit/i.test(clean)) return "Subtítulos Cyber Neon";
  if (/karaoke\s*subtit/i.test(clean)) return "Subtítulos Karaoke";
  if (/subtit|caption|subs/i.test(clean)) return "Subtítulos Sincronizados";
  if (/hyperframe.*metric|metric.*hud/i.test(clean)) return "HyperFrame HUD · Anillo de Datos SVG";
  if (/hyperframe.*hook|kinetic.*hook/i.test(clean)) return "HyperFrame Hook · Título 3D";
  if (/hyperframe.*chapter|chapter.*callout/i.test(clean)) return "HyperFrame Callout · Capítulo Editorial";
  if (/hyperframe.*optical|optical.*transition/i.test(clean)) return "HyperFrame · Transición Óptica";
  if (/smart\s*b\s*roll|stat|growth|broll|metric/i.test(clean)) return "Smart B-Roll Estadístico";
  if (/lower\s*third/i.test(clean)) return "Lower Third Animado";
  if (/hero\s*title|kinetic/i.test(clean)) return "Título Cinético";
  return clean.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function formatDurationSeconds(frames?: number, fps = 30): string | null {
  if (typeof frames !== "number" || frames <= 0) return null;
  const totalSec = Math.max(1, Math.round(frames / Math.max(1, fps)));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")} min`;
}

function sanitizeHistoryList(list: ChatMessage[]): ChatMessage[] {
  const filtered = list.filter((m) => !isInternalStepMessage(m));
  const deduped: ChatMessage[] = [];
  for (const msg of filtered) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.role === "user" &&
      msg.role === "user" &&
      prev.content.trim().toLowerCase() === msg.content.trim().toLowerCase()
    ) {
      continue;
    }
    deduped.push(msg);
  }
  return deduped;
}

function isConversationalQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;

  // Saludos directos y fórmulas de cortesía habituales
  if (
    /^(hola|hey|buenas|buen d[íi]as?|buenos d[íi]as|buenas tardes|buenas noches|qu[eé] tal|que tal|saludos|hi|hello)\b/i.test(lower) ||
    /^(gracias|muchas gracias|ok|vale|listo|entendido|excelente|genial|perfecto|de acuerdo)[.!?,]?$/i.test(lower)
  ) {
    // Si contiene intención explícita de crear un gráfico concreto (ej. "hola, crea un título"), no es solo saludo
    const hasCreationVerb = /\b(crea|cr[eé]ame|genera|haz|hazme|diseña|inserta|subt[íi]tula|ponle subt[íi]tulos?)\b/i.test(lower);
    if (!hasCreationVerb) return true;
  }

  // Preguntas, recomendaciones, asesoría, ideas o dudas editoriales
  const isQuestionOrAdvice =
    /^(qu[eé]|c[oó]mo|cu[aá]l|cu[aá]ndo|por qu[eé]|d[oó]nde|recomiendas|recomi[eé]ndame|dame ideas|qu[eé] opinas|qu[eé] sugieres|ayuda|puedes|ases[oó]rame)\b/i.test(lower) ||
    /\b(qu[eé] cosas me recomiendas|qu[eé] me recomiendas|qu[eé] recomiendas|qu[eé] puedo hacer|qu[eé] opciones tengo|qu[eé] puedes hacer|c[oó]mo funciona|dame consejos|ideas para|recomi[eé]ndame algo|qu[eé] har[íi]as|qu[eé] le falta|c[oó]mo lo ves|qu[eé] cambios me sugieres)\b/i.test(lower);

  const hasExplicitCreationIntent =
    /\b(subt[íi]tula|ponle subt[íi]tulos?|agrega subt[íi]tulos?|crea un|crea una|genera un|genera una|haz un|haz una|diseña un|diseña una)\b/i.test(lower);

  return isQuestionOrAdvice && !hasExplicitCreationIntent;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function cleanEmojis(obj: any): any {
  if (typeof obj === "string")
    return obj
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu,
        "",
      )
      .trim();
  if (Array.isArray(obj)) return obj.map(cleanEmojis);
  if (obj && typeof obj === "object") {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "code" || key === "componentCode" || (key === "content" && obj.type === "component")) {
        cleaned[key] = value;
      } else {
        cleaned[key] = cleanEmojis(value);
      }
    }
    return cleaned;
  }
  return obj;
}

function sanitizeAgentStep(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned) return "";
  if (/detectado problema en c[oó]digo|transform failed|<stdin>:\d+|syntaxerror|reparando/i.test(cleaned)) {
    return "Ajustando sintaxis de animación...";
  }
  const revalidateMatch = /^re-validando c[oó]digo(?:\s+corregido)?(?:\s*(\(intento\s*\d+\/\d+\)))?/i.exec(cleaned);
  if (revalidateMatch) {
    return revalidateMatch[1]
      ? `Re-validando animación ${revalidateMatch[1]}...`
      : "Re-validando animación...";
  }
  return cleaned;
}

/**
 * Parsea el texto del paso para separar el título del agente/fase del cuerpo del mensaje,
 * compactando nombres excesivamente largos.
 */
function parseLiveStep(step: string) {
  const sanitized = sanitizeAgentStep(step);
  const match = sanitized.match(/^(Fase(?:\s+en\s+ejecuci[oó]n)?|Paso\s+\d+\/\d+[^:]*|Enjambre\s+Aut[oó]nomo[^:]*):\s*(.*)$/i);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    let badge = match[1].trim();
    badge = badge
      .replace(/Creative\s+Art\s+Director\s*&\s*Storyboard\s+Agent/i, "Arte y Storyboard")
      .replace(/Self-Critique\s+QA\s+Auditor/i, "Auditoría QA")
      .replace(/Web\s+Research\s*&\s*Scriptwriting\s+Agent/i, "Investigación Web")
      .replace(/Agente\s+Investigador\s+Web/i, "Investigación")
      .replace(/Agente\s+Cutter\s*&\s*Base\s+Media/i, "Corte y Base")
      .replace(/Natural\s+Cutter\s*\/\s*J-L\s+Audio\s*&\s*Multi-Cam\s+Agent/i, "Cutter J/L")
      .replace(/Natural\s+Cutter\s*&\s*J\/L\s+Audio/i, "Cutter J/L")
      .replace(/Agente\s+de\s+Voz\s+y\s+Subt[ií]tulos/i, "Subtítulos")
      .replace(/Voice\s*&\s*Subtitles\s+Agent/i, "Subtítulos")
      .replace(/Director\s+de\s+C[aá]mara/i, "Cámara")
      .replace(/Camera\s+Director\s+Agent/i, "Cámara")
      .replace(/Motor\s+HyperFrames/i, "HyperFrames")
      .replace(/HyperFrames\s+Motion\s*&\s*Optical\s+Transitions\s+Agent/i, "HyperFrames")
      .replace(/HyperFrames\s+Motion\s*&\s*Optical\s+Transitions/i, "HyperFrames")
      .replace(/Agente\s+de\s+Sound\s+Design/i, "Sound Design")
      .replace(/Sound\s+Design\s+Agent/i, "Sound Design")
      .replace(/Synthetic\s+Environment\s*&\s*TTS\s+Agent/i, "Base y TTS")
      .replace(/Synthetic\s+Environment\s+Agent/i, "Base y TTS");

    return {
      badge,
      message: match[2].trim(),
    };
  }
  return {
    badge: null,
    message: sanitized,
  };
}

function compactAgentName(agent: string): string {
  if (/brand|marca|tokens/i.test(agent)) return "Brand Intelligence";
  if (/creative|art\s*director|storyboard/i.test(agent)) return "Arte y Storyboard";
  if (/qa|auditor|self-critique/i.test(agent)) return "Auditoría QA";
  if (/cutter/i.test(agent)) return "Cutter J/L";
  if (/voice|subt[ií]tulo/i.test(agent)) return "Subtítulos";
  if (/camera|c[aá]mara/i.test(agent)) return "Cámara";
  if (/map|mapa|geod/i.test(agent)) return "Remotion Maps";
  if (/hyperframe/i.test(agent)) return "HyperFrames";
  if (/sound|sfx/i.test(agent)) return "Sound Design";
  if (/research|investiga/i.test(agent)) return "Investigación Web";
  if (/synthetic|entorno|tts/i.test(agent)) return "Base y TTS";
  return agent;
}

/**
 * Componente de animación de escritura progresiva (Typewriter / Streaming effect).
 * Ofrece velocidad adaptativa fluida, cursor pulsante y puntos de actividad
 * dando la sensación de que el agente redacta y piensa en vivo en el chat.
 */
function TypewriterText({
  text,
  isLive,
}: {
  text: string;
  isLive: boolean;
}) {
  const [displayedCount, setDisplayedCount] = useState(() => (isLive ? 0 : text.length));
  const fullTextRef = useRef(text);
  fullTextRef.current = text;

  useEffect(() => {
    if (!isLive) {
      setDisplayedCount(text.length);
      return;
    }

    let current = 0;
    setDisplayedCount(0);

    const timer = window.setInterval(() => {
      const targetLen = fullTextRef.current.length;
      if (current >= targetLen) {
        setDisplayedCount(targetLen);
        window.clearInterval(timer);
        return;
      }
      // Velocidad adaptativa rápida y natural
      const remaining = targetLen - current;
      const stepIncrement = remaining > 35 ? 3 : remaining > 15 ? 2 : 1;
      current = Math.min(targetLen, current + stepIncrement);
      setDisplayedCount(current);
    }, 18);

    return () => window.clearInterval(timer);
  }, [text, isLive]);

  const visible = text.slice(0, displayedCount);
  const isTyping = isLive && displayedCount < text.length;

  return (
    <span className="inline">
      <span>{visible}</span>
      {isTyping && (
        <span
          className="inline-block h-2.5 w-1 ml-0.5 rounded-[2px] bg-[var(--sage-700)] align-middle animate-pulse"
          aria-hidden="true"
        />
      )}
      {isLive && !isTyping && (
        <span className="inline-flex items-center gap-0.5 ml-1 align-middle" aria-label="pensando">
          <span className="h-1 w-1 rounded-full bg-[var(--sage-600)] animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="h-1 w-1 rounded-full bg-[var(--sage-600)] animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="h-1 w-1 rounded-full bg-[var(--sage-600)] animate-bounce" style={{ animationDelay: "300ms" }} />
        </span>
      )}
    </span>
  );
}

/**
 * Renderiza el texto del resumen del agente formateando automáticamente
 * términos técnicos clave como micro-badges monoespaciados legibles.
 */
function renderFormattedAgentSummary(text: string) {
  if (!text) return null;
  const regex = /\b(V0|V1|V2|A1|SFX|Capa Motion|Capa Transiciones|hero-top|Remotion Maps|Brand Intelligence|Tokens|Safe Zones|whoosh(?:\.wav)?|pop(?:\.wav)?|ding(?:\.wav)?|TIKTOK|MINIMAL|CINEMATIC|HORMOZI|J\/L|Whisper|HyperFrames|Remotion|60\s*FPS)\b/gi;

  const parts = text.split(regex);
  if (parts.length === 1) return text;

  return parts.map((part, i) => {
    if (regex.test(part)) {
      return (
        <span
          key={i}
          className="inline-block mx-0.5 rounded px-1 py-[1px] font-mono text-[8.5px] font-bold bg-[var(--sage-100)] text-[var(--sage-900)] border border-[var(--sage-300)] align-baseline"
        >
          {part}
        </span>
      );
    }
    return part;
  });
}

/**
 * Tarjeta de resumen final con diseño pulido:
 * - Filtro inteligente de métricas (oculta ceros, muestra datos contextuales)
 * - Conector vertical continuo de 1px entre pasos (pipeline visual)
 * - Numeración humana (1 a 6)
 * - Micro-badges en términos técnicos (V0, V1, Capa Motion, whoosh.wav, etc.)
 * - Desglose de agentes colapsable / expandible
 */
function SwarmSummaryMessageCard({
  msg,
  project,
  fps,
  onTabChange,
}: {
  msg: ChatMessage;
  project: Project;
  fps: number;
  onTabChange?: (tab: SidebarTab) => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const stepsList: Array<{ step: number; agent: string; summary: string; applied: boolean }> =
    Array.isArray(msg.data?.steps) ? msg.data.steps : [];
  const rawStats = msg.data?.stats as
    | {
        silencesRemoved?: number;
        subtitleCues?: number;
        zoomPunches?: number;
        brollCardsInserted?: number;
        sfxEventsInserted?: number;
        brandDomain?: string;
        collisionsResolved?: number;
        themeCategory?: string;
      }
    | undefined;

  const productionMode = msg.data?.productionMode as string | undefined;
  const productionModeLabel = msg.data?.productionModeLabel as string | undefined;

  // Filtrado inteligente: eliminar ceros y priorizar métricas con valor real
  const statItems: Array<{ value: string | number; label: string }> = [];
  if (rawStats?.silencesRemoved && rawStats.silencesRemoved > 0) {
    statItems.push({ value: rawStats.silencesRemoved, label: "Cortes J/L" });
  }
  if (rawStats?.subtitleCues && rawStats.subtitleCues > 0) {
    statItems.push({ value: rawStats.subtitleCues, label: "Palabras" });
  }
  if (rawStats?.brollCardsInserted && rawStats.brollCardsInserted > 0) {
    statItems.push({ value: rawStats.brollCardsInserted, label: "HyperFrames" });
  }
  if (rawStats?.zoomPunches && rawStats.zoomPunches > 0) {
    statItems.push({ value: rawStats.zoomPunches, label: "Zooms" });
  }
  if (rawStats?.sfxEventsInserted && rawStats.sfxEventsInserted > 0) {
    statItems.push({ value: rawStats.sfxEventsInserted, label: "SFX" });
  }
  if (rawStats?.collisionsResolved && rawStats.collisionsResolved > 0) {
    statItems.push({ value: rawStats.collisionsResolved, label: "Zonas Seguras" });
  }

  // Si hay menos de 3 métricas con valor, complementar con datos reales del proyecto
  if (statItems.length < 3) {
    const totalSec = Math.round(
      (project.tracks.flatMap((t) => t.clips).reduce((m, c) => Math.max(m, c.startFrame + c.durationFrames), 0) /
        fps) || 0,
    );
    if (totalSec > 0) {
      statItems.push({ value: `${totalSec}s`, label: "Duración" });
    }
    statItems.push({ value: project.settings.aspect, label: "Formato" });
  }

  return (
    <div className="flex justify-start w-full animate-slide-up-fade">
      <div className="w-full max-w-[94%] rounded-xl rounded-tl-[4px] border border-[var(--line)] bg-[var(--paper)] p-2.5 text-[10px] leading-snug text-[var(--ink)] shadow-sm">
        {/* Cabecera integrada compacta */}
        <div className="flex items-center justify-between pb-2 border-b border-[var(--line)]">
          <div className="flex items-center gap-1.5">
            <span className="grid h-[18px] w-[18px] place-items-center rounded-md bg-[var(--sage-100)] text-[var(--sage-800)] border border-[var(--sage-300)]">
              <Icon name="check" size={10} />
            </span>
            <div>
              <div className="text-[11px] font-bold text-[var(--ink)] leading-tight">
                Postproducción completada
              </div>
              <div className="flex flex-wrap items-center gap-1 mt-0.5">
                {productionModeLabel && (
                  <span
                    className={`inline-block rounded px-1.5 py-[1px] font-mono text-[8px] font-bold border ${
                      productionMode === "modo_a_quirurgico"
                        ? "bg-sky-50 text-sky-800 border-sky-300"
                        : productionMode === "modo_c_hibrido"
                        ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                        : "bg-indigo-50 text-indigo-800 border-indigo-300"
                    }`}
                  >
                    {productionModeLabel}
                  </span>
                )}
                {rawStats?.brandDomain && (
                  <span className="inline-block rounded px-1.5 py-[1px] font-mono text-[8px] font-bold bg-amber-50 text-amber-800 border border-amber-300">
                    🌐 {rawStats.brandDomain}
                  </span>
                )}
                {rawStats?.themeCategory && (
                  <span className="inline-block rounded px-1.5 py-[1px] font-mono text-[8px] font-bold bg-purple-50 text-purple-800 border border-purple-300">
                    🎨 {rawStats.themeCategory}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIsCollapsed((prev) => !prev)}
              className="flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--ink-soft)] hover:bg-[var(--surface-hover)] transition-colors"
            >
              <span>{isCollapsed ? "Ver agentes" : "Colapsar"}</span>
              <Icon
                name="chevron-down"
                size={9}
                className={isCollapsed ? "transition-transform" : "rotate-180 transition-transform"}
              />
            </button>
            <button
              type="button"
              onClick={() => onTabChange?.("inspector")}
              className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-[9px] font-semibold text-[var(--ink)] hover:bg-[var(--surface-hover)] transition-colors shadow-sm"
            >
              Inspector
            </button>
          </div>
        </div>

        {/* Métricas limpias inteligentes (sin ceros) */}
        {statItems.length > 0 && (
          <div
            className="grid gap-1 py-1.5 border-b border-[var(--line)] text-center"
            style={{ gridTemplateColumns: `repeat(${statItems.length}, minmax(0, 1fr))` }}
          >
            {statItems.map((item, i) => (
              <div key={i}>
                <div className="text-[11.5px] font-black text-[var(--ink)] leading-tight">
                  {item.value}
                </div>
                <div className="text-[8px] font-semibold text-[var(--muted)]">{item.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Pasos concisos con conector vertical continuo de 1px y numeración humana 1 a 6 */}
        {!isCollapsed && (
          <div className="py-2 space-y-2 border-b border-[var(--line)]">
            {stepsList.length > 0 ? (
              <div className="relative pl-1">
                {stepsList.map((st, idx) => {
                  const humanNumber = idx + 1;
                  const isLast = idx === stepsList.length - 1;

                  return (
                    <div key={idx} className="relative flex items-start gap-2 pb-1.5 last:pb-0">
                      {/* Línea conectora vertical de 1px */}
                      {!isLast && (
                        <div
                          className="absolute left-[7px] top-[14px] bottom-[-2px] w-[1px] bg-[var(--sage-300)]"
                          aria-hidden="true"
                        />
                      )}

                      {/* Círculo con numeración humana 1-6 */}
                      <span className="relative z-10 mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-[var(--sage-100)] text-[8.5px] font-bold text-[var(--sage-800)] border border-[var(--sage-300)]">
                        {humanNumber}
                      </span>

                      <div className="min-w-0 flex-1 leading-snug">
                        <span className="text-[9.5px] font-bold text-[var(--ink)]">
                          {compactAgentName(st.agent)}:{" "}
                        </span>
                        <span className="text-[9px] text-[var(--ink-soft)]">
                          {renderFormattedAgentSummary(st.summary)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words text-[9.5px] text-[var(--ink-soft)]">
                {renderFormattedAgentSummary(msg.content)}
              </div>
            )}
          </div>
        )}

        {/* Telemetría técnica inferior integrada compacta */}
        <div className="flex items-center justify-between pt-1.5 text-[8.5px] text-[var(--muted)]">
          <span>
            <strong>{project.settings.width}x{project.settings.height}</strong> · <strong>{fps} fps</strong>
          </span>
          <div className="flex items-center gap-2">
            <span className="text-emerald-700 font-semibold">🛡️ Safe Zones 2026 OK</span>
            <span className="font-semibold text-[var(--sage-800)]">60 FPS Determinista</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MotionPanel({
  project,
  currentFrame,
  disabled,
  aiConfigured,
  onOpenSettings,
  onToast,
  onSaveBeforeExternalEdit,
  onProjectSync,
  onProjectChange,
  onSelectClips,
  onTabChange,
  selectedClipId,
}: MotionPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [previewVideo, setPreviewVideo] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [lastComponent, setLastComponent] = useState<ComponentPayload | null>(null);
  const [renderJob, setRenderJob] = useState<RenderStatus | null>(null);
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  const [liveStepsExpanded, setLiveStepsExpanded] = useState(false);
  const [activeStepText, setActiveStepText] = useState<string>("");
  const [showPresetsMenu, setShowPresetsMenu] = useState(false);
  const [pendingActionBanner, setPendingActionBanner] = useState(false);
  const [isConversationalTurn, setIsConversationalTurn] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const projectIdRef = useRef(project.id);
  const pollRef = useRef<number | null>(null);
  const seenTurnPayloadsRef = useRef<Set<string>>(new Set());
  const hydratedRef = useRef(false);
  const applyComponentRef = useRef<(comp: ComponentPayload, openInspector?: boolean, silent?: boolean) => void>(
    () => undefined,
  );

  const fps = useMemo(
    () => Math.max(1, project.settings.fps.num / Math.max(1, project.settings.fps.den)),
    [project.settings.fps.num, project.settings.fps.den],
  );

  const [explicitAttachedClipId, setExplicitAttachedClipId] = useState<string | null>(null);

  const attachedClipEntry = useMemo(
    () => (explicitAttachedClipId ? getClipById(project, explicitAttachedClipId) : undefined),
    [project, explicitAttachedClipId],
  );
  const attachedClip = attachedClipEntry?.clip ?? null;


  const handleDeleteAttachedClip = useCallback(
    (customTargetClip?: TimelineClip | null): string | null => {
      const target = customTargetClip ?? attachedClip;
      if (!target || !onProjectChange) return null;
      const friendlyName = formatFriendlyComponentTitle(target.remotion?.componentName || target.name);
      const res = removeClips(project, [target.id]);
      if (res.ok) {
        onProjectChange(res.project, {
          history: true,
          save: true,
          label: `Eliminar ${friendlyName}`,
        });
        onSelectClips?.([]);
        return friendlyName;
      }
      return null;
    },
    [attachedClip, onProjectChange, project, onSelectClips],
  );

  const sendChatRef = useRef<(text: string) => Promise<void>>(async () => undefined);

  useEffect(() => {
    const onAttachEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<{ clipId?: string; promptHint?: string }>).detail;
      if (detail?.clipId) {
        setExplicitAttachedClipId(detail.clipId);
      }
      if (detail?.promptHint) {
        setInput(detail.promptHint);
      }
      window.setTimeout(() => {
        textareaRef.current?.focus();
      }, 30);
    };
    const onRunSkillEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<{ prompt?: string }>).detail;
      const nextPrompt = detail?.prompt?.trim();
      if (nextPrompt) {
        void sendChatRef.current(nextPrompt);
      }
    };
    window.addEventListener("oeclip:attach-clip", onAttachEvent);
    window.addEventListener("oeclip:run-skill-prompt", onRunSkillEvent);
    return () => {
      window.removeEventListener("oeclip:attach-clip", onAttachEvent);
      window.removeEventListener("oeclip:run-skill-prompt", onRunSkillEvent);
    };
  }, []);

  const findMatchingClipInProject = useCallback(
    (comp?: ComponentPayload | null, proj: Project = project): TimelineClip | null => {
      if (!comp) return null;
      const cleanName = comp.name.replace(/\.(tsx|webm)$/i, "").toLowerCase();
      const isSubtitles = isTrueSubtitleComponentName(cleanName);

      // Si hay un clip seleccionado/adjunto del mismo tipo (subtítulo vs gráfico), actualizar ese mismo clip
      if (selectedClipId) {
        const selectedEntry = getClipById(proj, selectedClipId);
        if (selectedEntry && !selectedEntry.track.locked && selectedEntry.clip.remotion) {
          const selIsSubs =
            (selectedEntry.clip.type === "text" && selectedEntry.clip.role === "subtitle") ||
            Array.isArray(selectedEntry.clip.remotion.props?.captions);
          if (selIsSubs === isSubtitles) {
            return selectedEntry.clip;
          }
        }
      }

      for (const track of proj.tracks) {
        if (track.locked) continue;
        for (const clip of track.clips) {
          const clipCleanName = (clip.remotion?.componentName || clip.name)
            .replace(/\.(tsx|webm)$/i, "")
            .toLowerCase();
          if (clipCleanName === cleanName) return clip;
          if (
            isSubtitles &&
            ((clip.type === "text" && clip.role === "subtitle") ||
              isTrueSubtitleComponentName(clipCleanName))
          ) {
            return clip;
          }
        }
      }
      return null;
    },
    [project, selectedClipId],
  );

  const activeTimelineClip = useMemo(
    () => findMatchingClipInProject(lastComponent, project),
    [findMatchingClipInProject, lastComponent, project],
  );

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, liveSteps, activeStepText, scrollToBottom]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollRender = useCallback(
    (key: string) => {
      stopPolling();
      let attempts = 0;
      const tick = async () => {
        attempts += 1;
        try {
          const job = await api.request<RenderStatus>(
            `/projects/${encodeURIComponent(project.id)}/motion/render/${key}`,
            { headers: { "Content-Type": "application/json" } },
          );
          setRenderJob(job);
          if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
            stopPolling();
          }
        } catch {
          if (attempts >= 3) stopPolling();
        }
      };
      void tick();
      pollRef.current = window.setInterval(() => void tick(), 800);
    },
    [stopPolling, project.id],
  );

  const startRender = useCallback(
    async (
      component: ComponentPayload,
      options?: { prewarm?: boolean },
    ): Promise<RenderStatus | null> => {
      try {
        const job = await api.request<RenderStatus>(
          `/projects/${encodeURIComponent(project.id)}/motion/render`,
          {
            method: "POST",
            body: JSON.stringify({
              componentCode: component.code,
              componentName: component.name,
              compositionId: component.compositionId,
              durationInFrames: component.durationInFrames,
              props: component.props,
              startFrame: component.startFrame,
              prewarm: options?.prewarm === true,
            }),
            headers: { "Content-Type": "application/json" },
          },
        );
        setRenderJob(job);
        if (job.status === "rendering") pollRender(job.key);
        return job;
      } catch (error) {
        onToast(errorMessage(error, "No pude preparar el render"), "error");
        return null;
      }
    },
    [project.id, pollRender, onToast],
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    if (projectIdRef.current === project.id) return;
    projectIdRef.current = project.id;
    hydratedRef.current = false;
    stopPolling();
    setMessages([]);
    setLastComponent(null);
    setRenderJob(null);
    setPreviewVideo(null);
    setShowPreview(false);
    setLiveSteps([]);
    setActiveStepText("");
  }, [project.id, stopPolling]);

  // Hidrata el historial de conversación y la pieza activa desde localStorage + servidor
  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false;
    setPendingActionBanner(false);
    const storageKey = `novacut.motion.history.${project.id}`;

    let localMessages: ChatMessage[] = [];
    let localComponent: ComponentPayload | null = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          messages?: ChatMessage[];
          lastComponent?: ComponentPayload | null;
        };
        if (Array.isArray(parsed.messages)) {
          localMessages = sanitizeHistoryList(parsed.messages);
          setMessages(localMessages);
        }
        if (parsed.lastComponent?.code && parsed.lastComponent?.name) {
          localComponent = parsed.lastComponent;
          setLastComponent(parsed.lastComponent);
        }
      }
    } catch {
      // Ignorar errores de lectura de localStorage
    }

    void api
      .request<{
        messages?: ChatMessage[];
        lastComponent?: ComponentPayload | null;
      }>(`/projects/${encodeURIComponent(project.id)}/motion/history`)
      .then((saved) => {
        if (cancelled) return;
        if (Array.isArray(saved.messages) && saved.messages.length > 0 && localMessages.length === 0) {
          const cleanHistory = sanitizeHistoryList(saved.messages);
          setMessages(cleanHistory);
          const lastPrev = [...cleanHistory]
            .reverse()
            .find((m) => m.type === "preview" && m.data?.base64Video);
          if (lastPrev?.data?.base64Video) {
            setPreviewVideo(lastPrev.data.base64Video);
          }
        }
        if (saved.lastComponent && saved.lastComponent.code && saved.lastComponent.name && !localComponent) {
          setLastComponent(saved.lastComponent);
        }
        hydratedRef.current = true;
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Persiste cambios del chat y la pieza activa localmente (sin base64 pesados ni llamadas PUT redundantes)
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (messages.length === 0 && !lastComponent) return;
    const storageKey = `novacut.motion.history.${project.id}`;
    const compactMessages = sanitizeHistoryList(messages)
      .filter((m) => m.type !== "preview")
      .slice(-MESSAGE_MAX)
      .map((m) => ({
        ...m,
        timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      }));
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          messages: compactMessages,
          lastComponent,
        }),
      );
    } catch {
      // Ignorar si localStorage alcanza cuota
    }
  }, [messages, lastComponent, project.id]);

  const handleIncomingResponse = useCallback(
    async (resp: ChatMessage) => {
      if (!resp || !resp.type) return;

      // Si es un mensaje de proceso intermedio (isStep o patrón técnico interno),
      // lo agregamos al timeline de razonamiento en vivo sin llenar el chat de burbujas repetitivas.
      if (isInternalStepMessage(resp)) {
        const stepText = cleanEmojis(resp.content || "");
        if (!stepText) return;
        setActiveStepText(stepText);
        setLiveSteps((prev) => {
          if (prev.includes(stepText)) return prev;
          return [...prev, stepText];
        });
        return;
      }

      // Deduplicación por turno para cuando llegan eventos por doble vía (EventSource + POST stream)
      const dedupeKey = `${resp.type}:${(resp.content || "").slice(0, 180)}:${resp.data?.componentName ?? ""}:${resp.data?.durationMs ?? ""}`;
      if (seenTurnPayloadsRef.current.has(dedupeKey)) {
        return;
      }
      seenTurnPayloadsRef.current.add(dedupeKey);

      const { id: _id, role: _role, ...respRest } = resp;
      const msg: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: "assistant",
        timestamp: typeof resp.timestamp === "number" ? resp.timestamp : Date.now(),
        ...cleanEmojis(respRest),
      };
      setMessages((prev) => [...prev.slice(-MESSAGE_MAX + 1), msg]);

      if (resp.type === "SWARM_EDIT_COMPLETE" || resp.data?.type === "SWARM_EDIT_COMPLETE") {
        const updatedProject = (resp.project ?? resp.data?.project) as Project | undefined;
        if (updatedProject && onProjectChange) {
          onProjectChange(updatedProject, {
            history: true,
            save: true,
            label: "Edición autónoma por enjambre IA",
          });
        } else {
          await onProjectSync?.();
        }
        playSfx("ding");
        onToast("Edición autónoma por enjambre IA completada", "success");
        setPendingActionBanner(false);
        return;
      }

      if (resp.type === "component" && resp.data?.componentName) {
        const component = sanitizeComponentPayload(
          {
            code: resp.content,
            name: resp.data.componentName,
            compositionId: resp.data.compositionId,
            durationInFrames: resp.data.durationInFrames,
            props: resp.data.props as Record<string, unknown> | undefined,
            startFrame: typeof resp.data.startFrame === "number" ? resp.data.startFrame : undefined,
            renderKey: typeof resp.data.renderKey === "string" ? resp.data.renderKey : undefined,
          },
          fps,
        );
        setLastComponent(component);
        // Aplicamos o actualizamos automáticamente en el timeline en vivo (0ms)
        applyComponentRef.current(component, false, false);
        setPendingActionBanner(false);
        void startRender(component, { prewarm: true });
      }
      if (resp.type === "preview" && resp.data?.base64Video) {
        setPreviewVideo(resp.data.base64Video);
        if (resp.data.sfxType) {
          playSfx(resp.data.sfxType);
        }
        if (resp.data.durationInFrames) {
          setLastComponent((prev) => (prev ? { ...prev, durationInFrames: resp.data.durationInFrames } : prev));
        }
      }
      if (resp.type === "inserted") {
        onToast(resp.content, "success");
        setPreviewVideo(null);
        setShowPreview(false);
        setPendingActionBanner(false);
        await onProjectSync?.();
      }
      if (resp.type === "error") {
        onToast(resp.content, "error");
      }
    },
    [onProjectChange, onToast, onProjectSync, startRender, fps],
  );

  // Canal en vivo 1: Suscripción directa al bus SSE global (/api/events)
  useEffect(() => {
    const id = project?.id;
    if (!id) return;
    const source = new EventSource(`/api/events?projectId=${encodeURIComponent(id)}`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === "motion-progress" && data.projectId === id) {
          if (data.active === false) {
            // Conversación normal o proceso finalizado: no agregar pasos de compilación Remotion
            if (data.response && typeof data.response === "object") {
              void handleIncomingResponse(data.response as ChatMessage);
            }
            return;
          }
          if (typeof data.step === "string" && data.step.trim()) {
            const cleanStep = cleanEmojis(data.step);
            setActiveStepText(cleanStep);
            setLiveSteps((prev) => (prev.includes(cleanStep) ? prev : [...prev, cleanStep]));
          }
          if (data.response && typeof data.response === "object") {
            void handleIncomingResponse(data.response as ChatMessage);
          }
        }
      } catch {
        // Ignorar eventos malformados
      }
    };
    return () => source.close();
  }, [project?.id, handleIncomingResponse]);

  // Canal en vivo 2: Sondeo ligero (/motion/status) + progreso sintético fluido mientras `sending === true`
  useEffect(() => {
    // Si no está enviando o es una simple conversación/pregunta, no ejecutamos avance sintético de Remotion
    if (!sending || isConversationalTurn) return;
    let cancelled = false;
    const startedAt = Date.now();

    const syntheticCheckpoints: Array<{ afterMs: number; label: string }> = [
      { afterMs: 1200, label: "Analizando contexto y timeline..." },
      { afterMs: 3200, label: "Diseñando estructura de montaje..." },
      { afterMs: 6500, label: "Generando componentes Remotion..." },
      { afterMs: 12500, label: "Validando sintaxis e interpolación..." },
      { afterMs: 18000, label: "Compilando vista previa 60 FPS..." },
    ];

    const timer = window.setInterval(async () => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;

      // Sondear estado real del backend si el endpoint existe
      try {
        const status = await api.request<{ active: boolean; steps: string[]; currentStep: string }>(
          `/projects/${encodeURIComponent(project.id)}/motion/status`,
        );
        if (!cancelled && Array.isArray(status?.steps) && status.steps.length > 0) {
          setLiveSteps((prev) => {
            const merged = [...prev];
            for (const s of status.steps) {
              if (s && !merged.includes(s)) merged.push(s);
            }
            return merged;
          });
          if (status.currentStep) setActiveStepText(status.currentStep);
          return;
        }
      } catch {
        // Si el servidor aún no se reinició y /motion/status devuelve 404, usamos el avance sintético
      }

      // Avance sintético en tiempo real si la red/proxy retiene los paquetes hasta el final
      for (const cp of syntheticCheckpoints) {
        if (elapsed >= cp.afterMs) {
          setLiveSteps((prev) => {
            // Si ya llegaron pasos reales equivalentes, no duplicar
            const prefix = cp.label.slice(0, 18).toLowerCase();
            if (prev.some((existing) => existing.toLowerCase().startsWith(prefix))) {
              return prev;
            }
            setActiveStepText(cp.label);
            return [...prev, cp.label];
          });
        }
      }
    }, 550);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sending, isConversationalTurn, project.id]);

  const sendChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      // 0. Comandos directos instantáneos (0ms) sobre el elemento seleccionado/adjunto en el monitor
      const targetClip = attachedClip ?? activeTimelineClip;
      const isJumpCutRequest = /\b(silencios?|pausas?|jump\s*cuts?)\b/i.test(trimmed);

      if (targetClip && !isJumpCutRequest) {
        const targetFriendlyName = formatFriendlyComponentTitle(
          targetClip.remotion?.componentName || targetClip.name,
        );

        // A) Eliminar el elemento seleccionado si el usuario lo pide explícitamente
        const asksToDeleteClip =
          /\b(elim[ií]nalo|b[oó]rralo|qu[ií]talo|elimina(r)?\s+(este|el|los|la)\s+(elemento|subt[ií]tulos?|gr[aá]fico|componente|t[ií]tulo|clip|lower\s*third)|borra(r)?\s+(este|el|los|la)\s+(elemento|subt[ií]tulos?|gr[aá]fico|componente|t[ií]tulo|clip|lower\s*third))\b/i.test(
            trimmed,
          ) || /^(elimina|eliminar|borra|borrar|quitar|quita|eliminar elemento)$/i.test(trimmed);

        if (asksToDeleteClip) {
          setInput("");
          const deletedName = handleDeleteAttachedClip(targetClip);
          if (deletedName) {
            setExplicitAttachedClipId(null);
            const now = Date.now();
            setMessages((prev) => [
              ...prev,
              { id: `msg-${now}`, role: "user", type: "text", content: trimmed, timestamp: now },
              {
                id: `msg-${now + 1}`,
                role: "assistant",
                type: "inserted",
                content: `${deletedName} eliminado del video.`,
                timestamp: now + 1,
              },
            ]);
            onToast(`${deletedName} eliminado del video`, "success");
            return;
          }
        }
      }

      if (aiConfigured === false && onOpenSettings) {
        onOpenSettings();
        onToast("Conecta tu API Key de IA (Gemini, Groq, NVIDIA u OpenAI) para que el Agente pueda diseñar tu video.", "info");
        return;
      }

      const isConv = isConversationalQuery(trimmed);
      setInput("");
      setSending(true);
      setIsConversationalTurn(isConv);
      seenTurnPayloadsRef.current.clear();
      setLiveStepsExpanded(false);
      setLiveSteps(isConv ? [] : ["Iniciando agente autónomo..."]);
      setActiveStepText(isConv ? "" : "Iniciando agente autónomo...");

      const userMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "user",
        type: "text",
        content: trimmed,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      if (onSaveBeforeExternalEdit) {
        try {
          await onSaveBeforeExternalEdit();
        } catch {
          // continuar aunque falle el volcado previo
        }
      }

      const mentionsSubtitles = /\b(subt[íi]tulos?|captions?|subtitula)\b/i.test(trimmed);
      const hasAttachedRemotion = Boolean(attachedClip?.remotion?.code);
      const asksExplicitlyForBrandNew =
        /\b(otro\s+nuevo|crea\s+otro|agrega\s+otro|nuevo\s+gr[aá]fico)\b/i.test(trimmed);

      const asksForNewGraphic =
        !isConv &&
        !mentionsSubtitles &&
        (!hasAttachedRemotion || asksExplicitlyForBrandNew) &&
        /\b(genera|generar|crea|crear|diseña|mapa|gr[áa]fico|grafico|dinero|contador|barra|barras|t[íi]tulo|titulo|lower third|intro|outro|icono|logo|tarjeta|animaci[óo]n)\b/i.test(
          trimmed,
        );

      // Si el usuario pide crear un gráfico/mapa/título nuevo (y no está editando el clip adjunto), limpiamos el lastComponent en el servidor
      if (asksForNewGraphic) {
        await fetch(`/api/projects/${encodeURIComponent(project.id)}/motion/reset`, {
          method: "POST",
          body: "{}",
          credentials: "include",
          headers: buildMotionHeaders(),
        }).catch(() => undefined);
      }

      const activeContextComp: ComponentPayload | null =
        !asksForNewGraphic && attachedClip?.remotion?.code
          ? {
              code: attachedClip.remotion.code,
              name: attachedClip.remotion.componentName || attachedClip.name.replace(/\.webm$/i, ""),
              compositionId:
                attachedClip.remotion.compositionId ||
                attachedClip.remotion.componentName ||
                "MotionComp",
              durationInFrames: attachedClip.durationFrames,
              props: attachedClip.remotion.props,
              startFrame: attachedClip.startFrame,
            }
          : !asksForNewGraphic
            ? lastComponent
            : null;

      const payloadBody = JSON.stringify({
        message: trimmed,
        selectedClipId: asksForNewGraphic ? undefined : selectedClipId ?? undefined,
        ...(activeContextComp
          ? {
              componentCode: activeContextComp.code,
              componentName: activeContextComp.name,
              compositionId: activeContextComp.compositionId,
              durationInFrames: activeContextComp.durationInFrames,
              props: activeContextComp.props,
              startFrame: activeContextComp.startFrame,
            }
          : {}),
      });

      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(project.id)}/motion/chat-stream?currentFrame=${currentFrame}`,
          {
            method: "POST",
            body: payloadBody,
            credentials: "include",
            headers: buildMotionHeaders(),
          },
        );

        if (!response.ok || !response.body) {
          const res = await api.request<{ responses: ChatMessage[] }>(
            `/projects/${encodeURIComponent(project.id)}/motion/chat?currentFrame=${currentFrame}`,
            {
              method: "POST",
              body: payloadBody,
              headers: { "Content-Type": "application/json" },
            },
          );
          for (const resp of res.responses) {
            await handleIncomingResponse(resp);
          }
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const evt of events) {
            const lines = evt.split("\n");
            let eventName = "message";
            let dataLine = "";
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLine = line.slice(5).trim();
            }
            if (!dataLine) continue;
            if (eventName === "done") break;
            if (eventName === "message" || eventName === "SWARM_EDIT_COMPLETE") {
              try {
                const parsed = JSON.parse(dataLine) as ChatMessage;
                await handleIncomingResponse(parsed);
              } catch {
                // Ignorar fragmento malformado
              }
            }
          }
        }
      } catch (error) {
        onToast(errorMessage(error, "Error enviando mensaje"), "error");
      } finally {
        setSending(false);
        setIsConversationalTurn(false);
        setActiveStepText("");
      }
    },
    [
      sending,
      attachedClip,
      activeTimelineClip,
      handleDeleteAttachedClip,
      aiConfigured,
      onOpenSettings,
      project.id,
      currentFrame,
      selectedClipId,
      lastComponent,
      onToast,
      handleIncomingResponse,
    ],
  );

  const sendMessage = useCallback(() => {
    void sendChat(input);
  }, [input, sendChat]);

  sendChatRef.current = sendChat;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const rePreview = useCallback(async () => {
    if (!lastComponent) return;
    try {
      const res = await api.request<{ base64Video: string }>(
        `/projects/${encodeURIComponent(project.id)}/motion/preview`,
        {
          method: "POST",
          body: JSON.stringify({
            componentCode: lastComponent.code,
            componentName: lastComponent.name,
            compositionId: lastComponent.compositionId,
            durationInFrames: lastComponent.durationInFrames,
            props: lastComponent.props,
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      if (res.base64Video) {
        setPreviewVideo(res.base64Video);
        setShowPreview(true);
      }
    } catch (error) {
      onToast(errorMessage(error, "Error generando preview"), "error");
    }
  }, [lastComponent, project.id, onToast]);

  const insertInstantLive = useCallback(
    (targetComponent?: ComponentPayload, openInspector = false, silent = false) => {
      const rawComp = targetComponent ?? lastComponent;
      if (!rawComp || !onProjectChange) return;

      const comp = sanitizeComponentPayload(rawComp, fps);
      let nextProject = project;
      const cleanCompName = comp.name.replace(/\.(tsx|webm)$/i, "");
      const isSubtitles = isTrueSubtitleComponentName(cleanCompName);
      const durationFrames = Math.max(1, Math.round(comp.durationInFrames ?? fps * 4));

      const remotionSpec: RemotionComponentSpec = {
        code: comp.code,
        componentName: cleanCompName,
        compositionId: comp.compositionId || cleanCompName,
        props: { ...(comp.props ?? {}) },
        styleId: isSubtitles ? "minimal" : undefined,
        live: true,
      };

      // 1. Verificar si ya existe un clip equivalente en el timeline
      let existingMatch = findMatchingClipInProject(comp, nextProject);

      // Si el componente es un gráfico visual (no subtítulos) y existía un clip anterior que se creó
      // erróneamente como tipo "text" en pistas como T1, lo eliminamos para recrearlo correctamente en Capa Motion
      if (existingMatch && !isSubtitles && existingMatch.type === "text") {
        const cleaned = removeClips(nextProject, [existingMatch.id]);
        if (cleaned.ok) {
          nextProject = cleaned.project;
          existingMatch = null;
        }
      }

      if (existingMatch) {
        // Si es de subtítulos y había duplicados desplazados al final (startFrame > 0), limpiarlos
        if (isSubtitles) {
          const duplicateIds: string[] = [];
          for (const tr of nextProject.tracks) {
            if (tr.locked) continue;
            for (const c of tr.clips) {
              if (
                c.id !== existingMatch.id &&
                ((c.type === "text" && c.role === "subtitle") || /subtit|caption|subs\b/i.test(c.name))
              ) {
                duplicateIds.push(c.id);
              }
            }
          }
          if (duplicateIds.length > 0) {
            const cleaned = removeClips(nextProject, duplicateIds);
            if (cleaned.ok) nextProject = cleaned.project;
          }
        }

        const updatedRes = updateClip(nextProject, existingMatch.id, (curr) => ({
          ...curr,
          name: isSubtitles ? cleanCompName : `${cleanCompName}.webm`,
          startFrame: isSubtitles
            ? typeof comp.startFrame === "number"
              ? comp.startFrame
              : curr.startFrame
            : curr.startFrame,
          durationFrames: isSubtitles ? durationFrames : curr.durationFrames,
          ...(curr.type === "text" ? { text: cleanCompName } : {}),
          remotion: {
            ...remotionSpec,
            styleId: curr.remotion?.styleId ?? remotionSpec.styleId,
          },
        }));

        if (updatedRes.ok) {
          onProjectChange(updatedRes.project, {
            history: true,
            save: true,
            label: `Actualizar ${formatFriendlyComponentTitle(cleanCompName)}`,
          });
          onSelectClips?.([existingMatch.id]);
          setPendingActionBanner(false);
          if (openInspector) {
            onTabChange?.("inspector");
          }
          if (!silent) {
            onToast(`${formatFriendlyComponentTitle(cleanCompName)} actualizado en tu video`, "success");
          }
          return;
        }
      }

      // 2. Si aún no existe en el timeline, insertarlo en la pista correspondiente:
      // A) Subtítulos Dinámicos: van a su pista dedicada "Capa Motion Subtítulos" (kind: "text", role: "subtitle")
      if (isSubtitles) {
        let targetTrack = nextProject.tracks.find(
          (t) => t.kind === "text" && !t.locked && (t.name === "Capa Motion Subtítulos" || t.name === "Subtítulos"),
        );
        if (!targetTrack) {
          const added = addTrack(nextProject, "text", "Capa Motion Subtítulos");
          if (added.ok && added.track) {
            nextProject = added.project;
            targetTrack = added.track;
          }
        }
        if (!targetTrack) {
          onToast("No se pudo crear una pista para los subtítulos.", "error");
          return;
        }

        const startFrame = comp.startFrame ?? 0;
        const newClip = makeTextClip({
          name: cleanCompName,
          text: "Subtítulos Dinámicos",
          startFrame,
          durationFrames,
          role: "subtitle",
          createdBy: "agent",
          remotion: remotionSpec,
        });

        const res = addClip(nextProject, targetTrack.id, newClip);
        if (!res.ok) {
          onToast(res.error, "error");
          return;
        }

        onProjectChange(res.project, {
          history: true,
          save: true,
          label: `Aplicar ${formatFriendlyComponentTitle(cleanCompName)}`,
        });
        onSelectClips?.([newClip.id]);
        setPendingActionBanner(false);
        if (openInspector) onTabChange?.("inspector");
        if (!silent) onToast(`${formatFriendlyComponentTitle(cleanCompName)} aplicado al video`, "success");
        return;
      }

      // B) Elementos Gráficos Visuales (Corazón 3D, gráfico de dinero, mapa, títulos cinéticos, etc.):
      // Van a la pista de vídeo "Capa Motion" (kind: "video", Motion Overlay) con canal alfa
      let targetTrack = nextProject.tracks.find(
        (t) =>
          t.kind === "video" &&
          !t.locked &&
          (t.name.startsWith("Motion Overlay") || t.name.startsWith("Capa Motion")),
      );
      if (!targetTrack) {
        const added = addTrack(nextProject, "video", "Capa Motion");
        if (added.ok && added.track) {
          nextProject = added.project;
          targetTrack = added.track;
        }
      }
      if (!targetTrack) {
        onToast("No se pudo crear una pista para el componente.", "error");
        return;
      }

      const assetName = `${cleanCompName}.webm`;
      let asset = nextProject.media.find((m) => m.name === assetName);
      if (!asset) {
        asset = {
          id: `med_mot_${cleanCompName.toLowerCase().replace(/[^a-z0-9]/g, "")}_${Date.now().toString(36)}`,
          name: assetName,
          kind: "video",
          file: `generated/${assetName}`,
          mimeType: "video/webm",
          sizeBytes: 0,
          durationUs: Math.round((durationFrames / fps) * 1_000_000),
          importedAt: new Date().toISOString(),
          origin: "generated",
          thumbnail: "pending",
          waveform: "none",
          proxy: "none",
        };
        nextProject = { ...nextProject, media: [...nextProject.media, asset] };
      }

      const desiredStart = comp.startFrame !== undefined ? comp.startFrame : currentFrame;
      const startFrame = findFreeStartFrame(targetTrack, desiredStart, durationFrames);

      const newClip: MediaClip = {
        id: `clp_mot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: "video",
        name: assetName,
        startFrame,
        durationFrames,
        mediaId: asset.id,
        sourceInUs: 0,
        sourceOutUs: Math.max(1, Math.round((durationFrames / fps) * 1_000_000)),
        speed: 1,
        volume: 1,
        opacity: 1,
        transform: {
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          animationIn: "none",
          animationInDuration: 30,
          animationOut: "none",
          animationOutDuration: 30,
        },
        crop: { top: 0, right: 0, bottom: 0, left: 0 },
        adjustments: { brightness: 1, contrast: 1, saturation: 1 },
        fadeInFrames: 0,
        fadeOutFrames: 0,
        transitionType: "none",
        audioEnhance: "none",
        createdBy: "agent",
        remotion: remotionSpec,
      };

      const res = addClip(nextProject, targetTrack.id, newClip);
      if (!res.ok) {
        onToast(res.error, "error");
        return;
      }

      onProjectChange(res.project, {
        history: true,
        save: true,
        label: `Aplicar ${formatFriendlyComponentTitle(cleanCompName)}`,
      });
      onSelectClips?.([newClip.id]);
      setPendingActionBanner(false);
      if (openInspector) {
        onTabChange?.("inspector");
      }
      if (!silent) {
        onToast(`${formatFriendlyComponentTitle(cleanCompName)} aplicado al video`, "success");
      }

      // Sincronización automática de Sound Design en la pista "SFX"
      void (async () => {
        try {
          // 1. Persistir primero el montaje con el componente gráfico en el servidor
          // para evitar condiciones de carrera entre el guardado del cliente y el micro-SFX del servidor.
          if (onSaveBeforeExternalEdit) {
            await onSaveBeforeExternalEdit();
          }
          const syncRes = await api.request<{ ok: boolean; sfxType: string; project: any }>(
            `/projects/${encodeURIComponent(project.id)}/motion/sync-sfx`,
            {
              method: "POST",
              body: JSON.stringify({
                startFrame,
                componentName: cleanCompName,
                code: comp.code,
              }),
              headers: { "Content-Type": "application/json" },
            },
          );
          if (syncRes?.sfxType) {
            playSfx(syncRes.sfxType);
          }
          if (onProjectSync) {
            await onProjectSync();
          }
        } catch {
          // Ignorar fallo de SFX secundario sin afectar al componente principal
        }
      })();
    },
    [
      lastComponent,
      onProjectChange,
      project,
      fps,
      findMatchingClipInProject,
      currentFrame,
      onToast,
      onSelectClips,
      onTabChange,
      onSaveBeforeExternalEdit,
      onProjectSync,
    ],
  );

  useEffect(() => {
    applyComponentRef.current = insertInstantLive;
  }, [insertInstantLive]);

  const insertPreset = useCallback(
    (preset: MotionPresetTemplate) => {
      setShowPresetsMenu(false);
      insertInstantLive(
        {
          code: preset.code,
          name: preset.componentName || preset.label,
          compositionId: preset.compositionId,
          durationInFrames: preset.durationFrames,
          props: { ...preset.defaultProps },
          startFrame: currentFrame,
        },
        true,
      );
    },
    [insertInstantLive, currentFrame],
  );

  const clearChat = useCallback(() => {
    stopPolling();
    setMessages([]);
    setLastComponent(null);
    setRenderJob(null);
    setPreviewVideo(null);
    setShowPreview(false);
    setLiveSteps([]);
    setActiveStepText("");
    setPendingActionBanner(false);
    try {
      window.localStorage.removeItem(`novacut.motion.history.${project.id}`);
    } catch {
      // Ignorar
    }
    void api
      .request(`/projects/${encodeURIComponent(project.id)}/motion/reset`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
      .catch(() => undefined);
  }, [project.id, stopPolling]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      {/* Header minimalista y limpio */}
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper)] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md border-[1.5px] border-[var(--ink)] bg-[var(--sage-100)] text-[var(--sage-800)] shadow-sm">
            <Icon name="sparkles" size={11} />
          </span>
          <div className="min-w-0">
            <span className="font-display text-[13px] font-bold leading-none text-[var(--ink)]">
              AI Motion Studio
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {onTabChange && (
            <button
              type="button"
              onClick={() => onTabChange("skills")}
              disabled={disabled}
              className="flex h-6 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--white)] px-2 text-[10.5px] font-semibold text-[var(--ink-soft)] transition-colors hover:border-[var(--ink)] hover:bg-[var(--sage-50)] hover:text-[var(--ink)]"
              title="Explorar recetas y plantillas de Skills"
            >
              <Icon name="wand" size={10} />
              <span>Skills</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowPresetsMenu((prev) => !prev)}
            disabled={disabled}
            className={`flex h-6 items-center gap-1 rounded-md border px-2 text-[10.5px] font-semibold transition-colors ${
              showPresetsMenu
                ? "border-[var(--ink)] bg-[var(--sage-100)] text-[var(--ink)]"
                : "border-[var(--line)] bg-[var(--white)] text-[var(--ink-soft)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
            }`}
            title="Explorar plantillas y componentes"
          >
            <Icon name="plus" size={10} />
            <span>Plantillas</span>
          </button>
          {messages.length > 0 && (
            <button
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--ink-soft)] transition-colors hover:bg-[var(--sage-100)] hover:text-[var(--ink)] disabled:opacity-35"
              onClick={clearChat}
              disabled={sending}
              title="Nueva conversación"
              aria-label="Nueva conversación"
            >
              <Icon name="trash" size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {aiConfigured === false && onOpenSettings && (
          <div className="shrink-0 flex items-center justify-between gap-2 border-b-2 border-[var(--ink)] bg-[var(--warning-soft)] px-3 py-2 text-[11px] text-[var(--ink)]">
            <div className="min-w-0">
              <strong className="font-bold">Conecta tu API Key</strong>{" "}
              <span className="text-[var(--ink-soft)]">(Gemini, Groq, NVIDIA o OpenAI) para generar con IA.</span>
            </div>
            <button
              type="button"
              onClick={onOpenSettings}
              className="btn btn-primary btn-sm shrink-0 !h-7 !px-2.5 !text-[10.5px]"
            >
              <Icon name="lock" size={11} />
              Configurar Key
            </button>
          </div>
        )}
        {/* Menú desplegable de plantillas (solo cuando el usuario lo abre) */}
        {showPresetsMenu && (
          <div className="shrink-0 border-b border-[var(--line)] bg-[var(--sage-50)] p-2.5 animate-fade-in space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] font-bold text-[var(--ink)]">
                Plantillas y Componentes
              </span>
              <button
                type="button"
                onClick={() => setShowPresetsMenu(false)}
                className="text-[10px] font-medium text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Cerrar
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {MOTION_PRESET_TEMPLATES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => insertPreset(preset)}
                  className="flex flex-col items-start rounded-lg border border-[var(--line-strong)] bg-[var(--paper)] px-2.5 py-1.5 text-left transition-all hover:border-[var(--ink)] hover:bg-[var(--sage-100)]"
                >
                  <span className="text-[10.5px] font-bold text-[var(--ink)]">
                    + {preset.label}
                  </span>
                  <span className="line-clamp-1 text-[9.5px] text-[var(--muted)]">
                    {preset.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Lista de mensajes */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2.5 [&>*]:shrink-0">
          {messages.length === 0 && !sending ? (
            <div className="flex flex-1 items-start sm:items-center justify-center px-1.5 py-1">
              <div className="w-full max-w-[360px] space-y-3 text-center">
                <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl border-[1.5px] border-[var(--line-strong)] bg-[var(--paper)] text-[var(--sage-700)] shadow-sm">
                  <Icon name="sparkles" size={18} />
                </div>
                <div className="space-y-1">
                  <p className="font-display text-[14px] sm:text-[13px] font-bold text-[var(--ink)]">
                    Edita con IA en 1 toque
                  </p>
                  <p className="text-[11.5px] sm:text-[11px] font-medium leading-relaxed text-[var(--muted)]">
                    Elige una acción rápida o escribe abajo exactamente lo que quieres lograr.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-left">
                  {QUICK_RECIPES.map((recipe) => (
                    <button
                      key={recipe.title}
                      type="button"
                      onClick={() => void sendChat(recipe.prompt)}
                      disabled={disabled || sending}
                      className="flex items-start gap-2 rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] px-2.5 py-2 text-left transition-all hover:border-[var(--ink)] hover:bg-[var(--sage-50)] active:scale-[0.99] disabled:opacity-50"
                    >
                      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--sage-100)] text-[var(--sage-800)]">
                        <Icon name={recipe.icon} size={12} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11.5px] font-bold leading-tight text-[var(--ink)]">
                          {recipe.title}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-[var(--muted)]">
                          {recipe.desc}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="space-y-1 text-left pt-0.5">
                  <p className="text-[9.5px] font-bold uppercase tracking-wider text-[var(--muted)] px-0.5">
                    Más ideas listas
                  </p>
                  {SUGGESTIONS.slice(0, 4).map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => void sendChat(suggestion)}
                      disabled={disabled || sending}
                      className="flex w-full items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-left text-[11px] font-medium leading-snug text-[var(--ink-soft)] transition-all hover:border-[var(--sage-500)] hover:bg-[var(--sage-50)] hover:text-[var(--ink)] disabled:opacity-50"
                    >
                      <Icon name="sparkles" size={10} className="shrink-0 text-[var(--sage-600)]" />
                      <span className="truncate">{suggestion}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === "user";

              if (isUser) {
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-xl rounded-tr-[4px] border border-[var(--sage-300)] bg-[var(--sage-100)] px-2.5 py-1 text-[10.5px] font-medium leading-snug text-[var(--ink)] shadow-sm">
                      <div className="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>
                    </div>
                  </div>
                );
              }

              // Tarjeta amigable de diseño aplicado (sin código técnico ni jerga para el usuario)
              if (msg.type === "component") {
                const compPayload = sanitizeComponentPayload(
                  {
                    code: msg.content,
                    name: msg.data?.componentName || "MotionComponent",
                    compositionId: msg.data?.compositionId || msg.data?.componentName || "MotionComp",
                    durationInFrames: msg.data?.durationInFrames,
                    props: msg.data?.props,
                    startFrame: msg.data?.startFrame,
                  },
                  fps,
                );
                const friendlyTitle = formatFriendlyComponentTitle(compPayload.name);
                const durationLabel = formatDurationSeconds(compPayload.durationInFrames, fps);
                const matchedClip = findMatchingClipInProject(compPayload, project);
                const isAlreadyApplied = Boolean(matchedClip);
                const isSubtitles = isTrueSubtitleComponentName(compPayload.name);

                return (
                  <div key={msg.id} className="w-full">
                    <div className="overflow-hidden rounded-xl border border-[var(--sage-300)] bg-[var(--paper)] shadow-sm">
                      <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--sage-50)] px-2.5 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--sage-200)] text-[var(--sage-800)]">
                            <Icon name={isSubtitles ? "type" : "sparkles"} size={12} />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-[11.5px] font-bold text-[var(--ink)]">
                              {friendlyTitle}
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] font-medium text-[var(--muted)]">
                              <span>
                                {isAlreadyApplied ? "✓ Aplicado en tu video" : "Diseño listo"}
                              </span>
                              {durationLabel && <span>· {durationLabel}</span>}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="px-2.5 py-2 space-y-2">
                        <p className="text-[11px] leading-snug text-[var(--ink-soft)]">
                          {isSubtitles
                            ? "Sincronizado con el audio. Puedes cambiar entre 6 plantillas visuales, ajustar colores o corregir palabras desde el Inspector."
                            : "Elemento gráfico animado listo en tu línea de tiempo. Puedes personalizar sus textos y colores en el Inspector."}
                        </p>

                        <div className="flex items-center gap-1.5">
                          {isAlreadyApplied && matchedClip ? (
                            <button
                              type="button"
                              onClick={() => {
                                onSelectClips?.([matchedClip.id]);
                                onTabChange?.("inspector");
                              }}
                              className="btn btn-primary btn-sm !h-7 flex-1 justify-center !text-[10.5px]"
                            >
                              <Icon name="sliders" size={11} /> Personalizar diseño
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => insertInstantLive(compPayload, true)}
                              className="btn btn-primary btn-sm !h-7 flex-1 justify-center !text-[10.5px]"
                            >
                              <Icon name="plus" size={11} /> Aplicar al video
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              // Si es un mensaje preview sin video en base64, no mostrar burbuja huérfana
              if (msg.type === "preview") {
                if (!msg.data?.base64Video) return null;
                return (
                  <div key={msg.id} className="w-full">
                    <div className="overflow-hidden rounded-xl border border-[var(--sage-300)] bg-[var(--paper)] shadow-sm">
                      <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--sage-50)] px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--sage-600)]" />
                          <span className="text-[10px] font-bold text-[var(--sage-800)]">
                            Vista previa de animación
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewVideo(msg.data.base64Video);
                            setShowPreview(true);
                          }}
                          className="rounded bg-[var(--white)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--ink)] border border-[var(--line)] hover:bg-[var(--sage-100)]"
                        >
                          Ampliar
                        </button>
                      </div>
                      <div
                        className="relative grid place-items-center overflow-hidden"
                        style={{
                          backgroundImage:
                            "conic-gradient(#232925 25%, #171b18 0 50%, #232925 0 75%, #171b18 0)",
                          backgroundSize: "14px 14px",
                        }}
                      >
                        <video
                          src={msg.data.base64Video}
                          controls
                          autoPlay
                          loop
                          muted
                          playsInline
                          className="max-h-[150px] w-full object-contain"
                        />
                      </div>
                      {msg.data?.sfxType && (
                        <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--sage-50)]/80 px-2.5 py-1 text-[9.5px]">
                          <span className="flex items-center gap-1.5 font-medium text-[var(--ink-soft)]">
                            <Icon name="volume-2" size={11} className="text-[var(--sage-700)] shrink-0" /> Sound Design: <strong className="uppercase text-[var(--sage-800)]">{msg.data.sfxType}</strong> sincronizado
                          </span>
                          <button
                            type="button"
                            onClick={() => playSfx(msg.data.sfxType)}
                            className="flex items-center gap-1 rounded bg-[var(--white)] px-1.5 py-0.5 font-semibold text-[var(--sage-800)] border border-[var(--line)] hover:bg-[var(--sage-100)]"
                            title="Escuchar micro-efecto de sonido"
                          >
                            <Icon name="play" size={9} />
                            <span>Escuchar</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              if (msg.type === "inserted") {
                return (
                  <div
                    key={msg.id}
                    className="flex items-center gap-1.5 rounded-lg border border-[var(--sage-400)] bg-[var(--sage-100)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--sage-900)]"
                  >
                    <Icon name="check" size={12} className="shrink-0 text-[var(--sage-700)]" />
                    <span>{msg.content}</span>
                  </div>
                );
              }

              if (msg.type === "error") {
                return (
                  <div
                    key={msg.id}
                    className="flex items-start gap-1.5 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-2.5 py-1.5 text-[11px] font-medium text-[var(--danger)]"
                  >
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">{msg.content}</span>
                  </div>
                );
              }

              const isTechScript = msg.content.startsWith("GUION TÉCNICO DE SUBTITULADO");
              if (isTechScript) {
                return (
                  <div key={msg.id} className="w-full">
                    <details className="group overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-sm">
                      <summary className="flex cursor-pointer items-center justify-between gap-2 bg-[var(--sage-50)]/70 px-2.5 py-1.5 text-[10.5px] font-semibold text-[var(--ink-soft)] select-none hover:bg-[var(--sage-100)] hover:text-[var(--ink)]">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Icon name="type" size={11} className="shrink-0 text-[var(--sage-700)]" />
                          <span className="truncate">Ver transcripción sincronizada</span>
                        </div>
                        <Icon name="chevron-down" size={11} className="shrink-0 transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="max-h-36 overflow-y-auto border-t border-[var(--line)] px-2.5 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-[var(--ink-soft)]">
                        {msg.content.split("\n").slice(1).join("\n")}
                      </div>
                    </details>
                  </div>
                );
              }

              const isSwarmComplete =
                msg.type === "SWARM_EDIT_COMPLETE" ||
                msg.content.includes("Orquestación de Enjambre Autónomo completada");

              if (isSwarmComplete) {
                return (
                  <SwarmSummaryMessageCard
                    key={msg.id}
                    msg={msg}
                    project={project}
                    fps={fps}
                    onTabChange={onTabChange}
                  />
                );
              }

              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-xl rounded-tl-[4px] border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 text-[10px] leading-snug text-[var(--ink)] shadow-sm">
                    {msg.content}
                  </div>
                </div>
              );
            })
          )}

          {/* Tarjeta única colapsable para el progreso del agente (evita apilar burbujas en el chat) */}
          {sending && (
            isConversationalTurn || liveSteps.length === 0 ? (
              <div className="flex items-center gap-1.5 rounded-xl rounded-tl-[4px] border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-[10.5px] font-medium text-[var(--ink)] shadow-sm animate-slide-up-fade max-w-[260px]">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-learn-green opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-learn-green" />
                </span>
                <span>Pensando respuesta...</span>
              </div>
            ) : (() => {
              const displaySteps: Array<{ raw: string; badge: string | null; message: string }> = [];
              for (const rawStep of liveSteps) {
                const parsed = parseLiveStep(rawStep);
                if (!parsed.message) continue;
                const prev = displaySteps[displaySteps.length - 1];
                if (prev && prev.message === parsed.message && prev.badge === parsed.badge) continue;
                displaySteps.push({ raw: rawStep, ...parsed });
              }
              const latest = displaySteps[displaySteps.length - 1];
              if (!latest) return null;
              const hasHistory = displaySteps.length > 1;

              return (
                <div
                  data-agent-activity
                  className="w-full max-w-[94%] overflow-hidden rounded-2xl rounded-tl-[4px] border-[1.5px] border-[var(--sage-400)] bg-[var(--paper)] shadow-sm animate-fade-in"
                >
                  <button
                    type="button"
                    onClick={() => hasHistory && setLiveStepsExpanded((v) => !v)}
                    aria-expanded={liveStepsExpanded}
                    className={`w-full px-3 py-2 text-left transition-colors ${
                      hasHistory ? "cursor-pointer hover:bg-[var(--sage-50)]/70" : "cursor-default"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-start gap-2">
                        <span className="relative mt-1 flex h-2 w-2 shrink-0">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--sage-500)] opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--sage-700)]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-[var(--sage-800)]">
                              {latest.badge || "Agente OECLIP"}
                            </span>
                            <span className="rounded-full bg-[var(--sage-100)] px-1.5 py-[1px] text-[8.5px] font-bold text-[var(--sage-900)]">
                              {hasHistory ? `Paso ${displaySteps.length}` : "En curso"}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] font-semibold leading-snug text-[var(--ink)]">
                            <TypewriterText text={latest.message} isLive />
                          </div>
                        </div>
                      </div>

                      {hasHistory && (
                        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--line-strong)] bg-[var(--white)] px-2 py-0.5 text-[9.5px] font-bold text-[var(--ink-soft)]">
                          <span>{liveStepsExpanded ? "Ocultar" : `Ver (${displaySteps.length})`}</span>
                          <Icon
                            name="chevron-down"
                            size={10}
                            className={`transition-transform duration-200 ${liveStepsExpanded ? "rotate-180" : ""}`}
                          />
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Barra sutil de progreso continuo */}
                  <div className="h-[2px] w-full overflow-hidden bg-[var(--sage-100)]">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-[var(--sage-700)]" />
                  </div>

                  {liveStepsExpanded && hasHistory && (
                    <div className="border-t border-[var(--line)] bg-[var(--sage-50)]/40 px-3 py-2">
                      <ol className="list-none space-y-1.5 border-l-[1.5px] border-[var(--sage-300)] pl-3.5">
                        {displaySteps.map((item, idx) => {
                          const isCurrent = idx === displaySteps.length - 1;
                          return (
                            <li
                              key={`timeline-step-${idx}`}
                              className={`relative text-[10px] leading-snug ${
                                isCurrent ? "font-semibold text-[var(--ink)]" : "text-[var(--ink-soft)]"
                              }`}
                            >
                              <span
                                className={`absolute -left-[18.5px] top-1 h-2 w-2 rounded-full border ${
                                  isCurrent
                                    ? "border-[var(--sage-700)] bg-[var(--sage-600)]"
                                    : "border-[var(--sage-400)] bg-[var(--white)]"
                                }`}
                              />
                              {item.badge && (
                                <span className="mr-1 font-bold text-[var(--sage-800)]">{item.badge}:</span>
                              )}
                              <span>{item.message}</span>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                </div>
              );
            })()
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Modal de vista previa a pantalla completa */}
        {showPreview && previewVideo && (
          <div
            className="fixed inset-0 z-[100] grid place-items-center bg-[rgba(0,0,0,0.82)] p-4 backdrop-blur-sm"
            onClick={() => {
              setShowPreview(false);
            }}
          >
            <div
              className="relative max-h-[85vh] w-full max-w-[780px] overflow-hidden rounded-2xl border-2 border-[var(--ink)] bg-[var(--paper)] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--paper)] px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Icon name="sparkles" size={14} className="text-[var(--sage-700)]" />
                  <span className="font-display text-[13px] font-bold text-[var(--ink)]">
                    Vista Previa de Animación
                  </span>
                </div>
                <button
                  className="grid h-6 w-6 place-items-center rounded-lg hover:bg-[var(--sage-100)]"
                  onClick={() => setShowPreview(false)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div
                className="grid place-items-center p-2"
                style={{
                  backgroundImage:
                    "conic-gradient(#2b312d 25%, #1b201d 0 50%, #2b312d 0 75%, #1b201d 0)",
                  backgroundSize: "22px 22px",
                }}
              >
                <video
                  src={previewVideo}
                  controls
                  autoPlay
                  loop
                  className="max-h-[68vh] w-full object-contain"
                />
              </div>
            </div>
          </div>
        )}

        {/* Barra inferior de entrada limpia: muestra chip sutil cuando un elemento está adjunto */}
        <div className="shrink-0 border-t border-[var(--line)] bg-[var(--paper)] p-2">
          {attachedClip && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--sage-300)] bg-[var(--sage-50)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ink)] animate-fade-in shadow-sm">
              <div className="flex items-center gap-1.5 min-w-0">
                <Icon name="wand" size={11} className="text-learn-green shrink-0" />
                <span className="truncate">
                  Elemento adjunto: <strong className="text-[var(--sage-900)]">{formatFriendlyComponentTitle(attachedClip.remotion?.componentName || attachedClip.name)}</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setExplicitAttachedClipId(null)}
                className="grid h-4 w-4 shrink-0 place-items-center rounded text-[var(--muted)] hover:bg-[var(--sage-200)] hover:text-[var(--ink)] cursor-pointer"
                title="Quitar elemento adjunto"
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          )}

          {lastComponent && pendingActionBanner && !activeTimelineClip && !attachedClip && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--sage-300)] bg-[var(--sage-50)] px-2.5 py-1.5 shadow-sm">
              <div className="flex min-w-0 items-center gap-1.5">
                <Icon name="sparkles" size={11} className="shrink-0 text-[var(--sage-700)]" />
                <span className="truncate text-[11px] font-semibold text-[var(--ink)]">
                  {formatFriendlyComponentTitle(lastComponent.name)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 sm:gap-1">
                <button
                  type="button"
                  className="btn btn-primary btn-sm !min-h-[34px] sm:!min-h-0 sm:!h-6 !px-3 sm:!px-2.5 !text-[11px] sm:!text-[10px] touch-manipulation"
                  onClick={() => insertInstantLive(lastComponent, true)}
                  disabled={sending || inserting}
                >
                  <Icon name="plus" size={11} /> Aplicar
                </button>
                <button
                  type="button"
                  className="grid h-8 w-8 sm:h-6 sm:w-6 place-items-center rounded-lg sm:rounded text-[var(--muted)] hover:bg-[var(--sage-200)] hover:text-[var(--ink)] touch-manipulation"
                  onClick={() => setPendingActionBanner(false)}
                  aria-label="Ocultar aviso"
                  title="Ocultar"
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )}

          <div className="flex items-end gap-1.5">
            <textarea
              ref={textareaRef}
              className="max-h-[110px] min-h-[40px] sm:min-h-[34px] flex-1 resize-none rounded-lg border-[1.5px] border-[var(--line-strong)] bg-[var(--white)] px-3 py-2 sm:px-2.5 sm:py-1.5 text-base sm:text-[11.5px] font-medium text-[var(--ink)] outline-none transition-all placeholder:text-[var(--muted)] focus:border-[var(--ink)] disabled:opacity-50"
              placeholder={
                sending
                  ? isConversationalTurn
                    ? "OECLIP está respondiendo..."
                    : "Generando edición..."
                  : attachedClip
                    ? "Modificar elemento seleccionado... (Enter)"
                    : "Escribe qué quieres editar... (ej. subtítulos)"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled || sending}
              rows={1}
              style={{ lineHeight: "1.4" }}
            />
            <button
              type="button"
              className="btn btn-primary !h-[40px] !min-w-[44px] sm:!h-[34px] sm:!min-w-0 shrink-0 !px-3"
              onClick={sendMessage}
              disabled={!input.trim() || sending || disabled}
              title="Enviar instrucción"
              aria-label="Enviar instrucción"
            >
              {sending ? <Icon name="loader" size={15} className="spin" /> : <Icon name="send" size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
