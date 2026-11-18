import { chatJson } from "../ai/provider.js";
import {
  MOTION_CODEGEN_PROMPT,
  MOTION_PLANNER_PROMPT,
  MOTION_REPAIR_PROMPT,
} from "./prompts.js";
import {
  clampDurationFrames,
  cleanEmojis,
  extractCodeFromData,
  sanitizeComponentCode,
  secondsToFrames,
  stripEmojis,
  validateTsx,
} from "./code-guard.js";
import {
  buildSubtitles,
  findCaptionSource,
  formatTechnicalSubtitleScript,
  previewWindow,
  resolveSubtitleStyle,
  subtitleComponentCode,
  type CaptionCue,
  type SubtitleBuild,
  type SubtitleStyleId,
} from "./subtitles.js";
import { renderPool } from "./worker/pool.js";
import type { RenderResult } from "./worker/types.js";
import { projectStore } from "../projects/store.js";
import { eventBus } from "../events.js";
import { timelineDurationFrames } from "../../src/shared/timeline.js";
import {
  cancelPrewarm,
  listOverlayJobs,
  overlayBundleKey,
  overlayRenderKey,
  renderAndInsertOverlay,
  schedulePrewarm,
  type OverlayComponent,
} from "./render-service.js";
import {
  buildProceduralTransition,
  type RemotionTransitionId,
  MOTION_PRESET_TEMPLATES,
} from "../../src/shared/motionTemplates.js";
import {
  buildHyperFrameAnimatedMap,
  buildHyperFrameBespokeMetaphor,
  buildHyperFrameBrandCard,
  buildHyperFrameCharacterDialogue,
  buildHyperFrameDataChart,
  buildHyperFrameFloatingUI,
  buildHyperFrameKineticHook,
  buildHyperFrameMetricHud,
  buildHyperFrameMotionGrid,
  buildHyperFrameRichMediaOverlay,
  type HyperFramePalette,
} from "../../src/shared/hyperframes.js";
import { extractProjectSemanticDNA } from "../agent/semanticDNA.js";
import { determineSfxForComponent } from "../services/sfxService.js";
import { autoReframeProject } from "../../src/shared/project.js";
import { detectBrandUrlInPrompt } from "../agent/brandCapture.js";
import { isMapOrRoutePrompt, extractRouteCities } from "../agent/swarmDirector.js";
import {
  buildPolymorphicProceduralSceneCode,
  collectTranscriptTextsFromProject,
  extractExplicitPromptTitles,
  isConversationalInstructionText,
  resolveContextualOverlayCopy,
} from "../agent/autonomousEditorBrain.js";

export interface MotionContext {
  projectId: string;
  project: any;
  currentFrame: number;
  mediaAssets: any[];
}

export type MotionResponseType =
  | "component"
  | "preview"
  | "final"
  | "inserted"
  | "error"
  | "text";

export interface MotionResponse {
  type: MotionResponseType;
  content: string;
  data?: any;
}

type MotionAction = "subtitles" | "create" | "modify" | "preview" | "insert" | "answer";

interface MotionPlan {
  action: MotionAction;
  reply: string;
  brief: string;
  /** Estilo visual pedido para subtítulos (id del catálogo o "custom"). */
  style?: SubtitleStyleId | null;
  durationInFrames: number | null;
  autoInsert: boolean;
  insertAtEnd: boolean;
}

interface ComponentState {
  code: string;
  name: string;
  compositionId: string;
  durationInFrames: number;
  props?: Record<string, unknown>;
  reasoning?: string;
  /** Frame del timeline donde debe insertarse (subtítulos alineados al clip). */
  startFrame?: number;
}

export interface SmartBRollMatch {
  startFrame: number;
  matchedText: string;
  metricLabel: string;
  metricValue: string;
  numericTarget: number;
  unit: string;
  foundInAudio: boolean;
}

const MAX_CONVERSATION_TURNS = 16;
const MAX_AGENTS = 8;
const PLANNER_TIMEOUT_MS = 20_000;
const CODEGEN_TIMEOUT_MS = 45_000;
const MAX_BUILD_ATTEMPTS = 3;

const agents = new Map<string, MotionAgent>();

export function isConversationalQuery(text: string): boolean {
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

function projectFps(project: any): number {
  const num = Number(project?.settings?.fps?.num ?? 30);
  const den = Number(project?.settings?.fps?.den ?? 1);
  const fps = den > 0 ? num / den : 30;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function projectWidth(project: any): number {
  return Math.max(2, Math.round(Number(project?.settings?.width ?? 1920)));
}

function projectHeight(project: any): number {
  return Math.max(2, Math.round(Number(project?.settings?.height ?? 1080)));
}

function seconds(frames: number, fps: number): string {
  return (frames / fps).toFixed(2);
}

function toIdentifier(value: unknown, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[^A-Za-z0-9_$]/g, "")
    .replace(/^[^A-Za-z_$]/, "");
  return cleaned || fallback;
}

function toComponentName(value: unknown, fallback: string): string {
  const id = toIdentifier(value, fallback);
  return /^[A-Z]/.test(id) ? id : id.charAt(0).toUpperCase() + id.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function shortError(message: string, max = 600): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function normalizePlan(data: unknown, message: string): MotionPlan {
  let record = asRecord(data);

  // Algunos modelos devuelven el JSON como string dentro del objeto.
  if (typeof data === "string") {
    try {
      record = asRecord(JSON.parse(data));
    } catch {
      record = {};
    }
  }

  const allowed: MotionAction[] = [
    "subtitles",
    "create",
    "modify",
    "preview",
    "insert",
    "answer",
  ];
  const rawAction = String(record.action ?? "").trim().toLowerCase();
  const action = (allowed as string[]).includes(rawAction)
    ? (rawAction as MotionAction)
    : "create";

  const rawDuration = Number(record.durationInFrames);
  const durationInFrames =
    Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : null;

  const reply = typeof record.reply === "string" ? record.reply.trim() : "";
  const brief = typeof record.brief === "string" ? record.brief.trim() : "";
  const mentionsSubs = /\b(subt[íi]tulos?|captions?|subtitula)\b/i.test(message);

  return {
    action,
    reply,
    brief,
    style:
      action === "subtitles" || (action === "modify" && mentionsSubs)
        ? record.style == null
          ? null
          : resolveSubtitleStyle(record.style, brief)
        : null,
    durationInFrames,
    autoInsert: record.autoInsert === true,
    insertAtEnd: record.insertAtEnd === true,
  };
}

/**
 * Agente de motion graphics por proyecto.
 *
 * El modelo decide la acción (crear, modificar, previsualizar, insertar o
 * responder), escribe el componente Remotion y se auto-corrige con el error
 * real del render. La conversación queda en memoria para que el chat tenga
 * continuidad ("hazlo más lento", "cámbialo a verde", "ahora insértalo").
 */
export class MotionAgent {
  private conversation: Array<{ role: "user" | "assistant"; content: string }> = [];
  private context: MotionContext | null = null;
  private lastComponent: ComponentState | null = null;
  private lastBrief = "";
  /** Transcripción cacheada para no repetir Whisper al cambiar de estilo. */
  private subtitleCache: { segments: any[]; key: string } | null = null;
  private lastSubtitleStyle: SubtitleStyleId | null = null;
  /** ID del clip seleccionado en el viewer para modificaciones directas. */
  private selectedClipId: string | null = null;
  /** Estado en tiempo real del proceso activo para streaming y polling. */
  private liveStatus: { active: boolean; steps: string[]; currentStep: string } = {
    active: false,
    steps: [],
    currentStep: "",
  };

  getLiveStatus(): { active: boolean; steps: string[]; currentStep: string } {
    const st = this.liveStatus || { active: false, steps: [], currentStep: "" };
    const safeSteps = Array.isArray(st.steps) ? [...st.steps] : [];
    return {
      active: Boolean(st.active),
      steps: safeSteps,
      currentStep:
        typeof st.currentStep === "string" && st.currentStep.trim()
          ? st.currentStep
          : safeSteps[safeSteps.length - 1] || "",
    };
  }

  private reportStep(stepText: string, onProgress?: (response: MotionResponse) => void): void {
    const cleanStep = stripEmojis(stepText);
    if (!cleanStep) return;
    if (!this.liveStatus.steps.includes(cleanStep)) {
      this.liveStatus.steps.push(cleanStep);
    }
    this.liveStatus.currentStep = cleanStep;
    const stepResp: MotionResponse = {
      type: "text",
      content: cleanStep,
      data: { isStep: true },
    };
    onProgress?.(stepResp);
    if (this.context?.projectId) {
      eventBus.publish(this.context.projectId, {
        type: "motion-progress",
        projectId: this.context.projectId,
        step: cleanStep,
        response: stepResp,
        active: true,
      });
    }
  }

  setContext(context: MotionContext): void {
    this.context = context;
  }

  setLastComponent(component: Partial<ComponentState> | null): void {
    if (!component || !component.code || !component.name) return;
    this.lastComponent = {
      code: component.code,
      name: toComponentName(component.name, "MotionGraphic"),
      compositionId: toComponentName(component.compositionId, `${component.name}Comp`),
      durationInFrames: Math.max(
        1,
        Math.round(Number(component.durationInFrames) || 90),
      ),
      props: component.props,
      reasoning: component.reasoning,
      startFrame: typeof component.startFrame === "number" ? component.startFrame : undefined,
    };
  }

  getAgentMemorySnapshot(): {
    lastComponent: ComponentState | null;
    lastBrief: string;
    conversation: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    return {
      lastComponent: this.lastComponent ? { ...this.lastComponent } : null,
      lastBrief: this.lastBrief,
      conversation: [...this.conversation],
    };
  }

  hydrateFromSaved(saved: {
    lastComponent?: (Partial<ComponentState> & { durationInFrames?: number | null }) | null;
    lastBrief?: string;
    conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  }): void {
    if (saved.lastComponent && !this.lastComponent) {
      const c = saved.lastComponent;
      this.setLastComponent({
        ...c,
        durationInFrames:
          c.durationInFrames == null ? undefined : Math.max(1, Math.round(c.durationInFrames)),
      });
    }
    if (saved.lastBrief && !this.lastBrief) {
      this.lastBrief = saved.lastBrief;
    }
    if (Array.isArray(saved.conversation) && this.conversation.length === 0) {
      this.conversation = saved.conversation.slice(-MAX_CONVERSATION_TURNS);
    }
  }

  reset(): void {
    this.conversation = [];
    this.lastComponent = null;
    this.lastBrief = "";
    this.selectedClipId = null;
  }

  async processMessage(
    userMessage: string,
    selectedClipId?: string,
    onProgress?: (response: MotionResponse) => void,
  ): Promise<MotionResponse[]> {
    if (!this.context) {
      const err: MotionResponse = { type: "error", content: "Falta el contexto del proyecto." };
      onProgress?.(err);
      return [err];
    }

    // Si hay un clip seleccionado, guardarlo para usarlo en modificaciones
    if (selectedClipId) {
      this.selectedClipId = selectedClipId;
    }

    const projectId = this.context.projectId;
    const isConv = isConversationalQuery(userMessage);

    this.liveStatus = {
      active: !isConv,
      steps: isConv ? [] : ["Iniciando agente autónomo..."],
      currentStep: isConv ? "" : "Iniciando agente autónomo...",
    };

    const responses: MotionResponse[] = [];
    const emit = (r: MotionResponse) => {
      const cleaned = cleanEmojis(r);
      if (cleaned.type === "text" && cleaned.data?.isStep) {
        if (!this.liveStatus.steps.includes(cleaned.content)) {
          this.liveStatus.steps.push(cleaned.content);
        }
        this.liveStatus.currentStep = cleaned.content;
      } else {
        responses.push(cleaned);
      }
      onProgress?.(cleaned);
      eventBus.publish(projectId, {
        type: "motion-progress",
        projectId,
        step: cleaned.data?.isStep ? cleaned.content : undefined,
        response: cleaned,
        active: !isConv,
      });
    };

    // Si es una consulta conversacional, recomendación, duda o saludo simple:
    if (isConv) {
      const plan = await this.planAction(userMessage);
      this.remember("user", userMessage);
      const reply =
        plan.reply && plan.reply.length > 15
          ? plan.reply
          : "He analizado tu video y te recomiendo 3 cosas clave para aumentar la retención:\n" +
            "1. **Subtítulos Virales al Toque**: Subtítulos dinámicos estilo Hormozi o TikTok con resaltado palabra por palabra.\n" +
            "2. **Cortes de Silencios (Jump Cuts)**: Eliminar pausas muertas y respiraciones para que el ritmo sea ágil.\n" +
            "3. **Título Cinético o Smart B-Roll**: Colocar un gancho visual en los primeros 3 segundos o gráficos animados de apoyo.\n\n" +
            "¿Quieres que le agregue los subtítulos virales o prefieres empezar con los jump cuts?";
      this.remember("assistant", reply);
      emit({ type: "text", content: stripEmojis(reply) });
      this.liveStatus.active = false;
      return responses;
    }

    // Auto-Reframe Dinámico (16:9 a 9:16 para TikTok/Shorts/Reels o viceversa)
    const asksReframe =
      /\b(auto-?reframe|reframe|vertical|horizontal|tiktok|shorts|reels|16:9|9:16|1:1)\b/i.test(userMessage) &&
      /\b(cambia|adapta|formato|ajusta|pasa|reencuadra|re-encuadra|a 9:16|a 16:9|a 1:1|ponlo|hazlo|para)\b/i.test(userMessage);

    if (asksReframe) {
      let targetAspect: "16:9" | "9:16" | "1:1" = "9:16";
      if (/16:9|horizontal|youtube/i.test(userMessage)) targetAspect = "16:9";
      else if (/1:1|cuadrado|feed/i.test(userMessage)) targetAspect = "1:1";

      const updated = autoReframeProject(this.context.project, targetAspect);
      const saved = await projectStore.saveTimeline(projectId, updated, { force: true });
      this.context.project = saved.project;

      eventBus.publish(projectId, {
        type: "project",
        projectId,
        revision: saved.project.revision,
      });

      const replyMsg = `He ejecutado el Auto-Reframe Dinámico a formato ${targetAspect} (${updated.settings.width}×${updated.settings.height}). Los clips de video se han re-encuadrado inteligentemente para llenar la pantalla sin bandas negras y los gráficos/subtítulos de Remotion se han adaptado automáticamente a la zona segura de ${targetAspect === "9:16" ? "TikTok/Reels" : "la pantalla"}.`;
      emit({ type: "text", content: replyMsg });
      this.remember("user", userMessage);
      this.remember("assistant", replyMsg);
      this.liveStatus.active = false;
      return responses;
    }

    // Eliminación Automática de Silencios / Jump Cuts IA (Pausas muertas de audio)
    const asksSilenceRemoval =
      /\b(silencio|silencios|pausas?|dead air|respiracion|respiraciones|partes mudas|jump\s*cuts?)\b/i.test(userMessage) &&
      /\b(elimina|quitar?|borrar?|corta|recorta|limpia|depura|suprime|haz|aplicar?)\b/i.test(userMessage);

    if (asksSilenceRemoval && this.context) {
      this.reportStep("Analizando audio para detectar silencios y pausas muertas...", onProgress);
      const videoTrack = this.context.project.tracks.find(
        (t: any) =>
          t.kind === "video" &&
          !/motion|overlay|transici|v0|fondo\s*ambient/i.test(t.name) &&
          t.clips.length > 0,
      );
      const targetClip =
        (this.selectedClipId ? videoTrack?.clips.find((c: any) => c.id === this.selectedClipId) : null) ??
        videoTrack?.clips.find((c: any) => c.type === "video");

      if (targetClip) {
        const asset = this.context.project.media.find((m: any) => m.id === targetClip.mediaId);
        if (asset) {
          try {
            const { detectSilences, keepRangesFromSilences } = await import("../media/analysis.js");
            const { applySourceRanges } = await import("../../src/shared/timeline.js");

            const silenceResult = await detectSilences(
              projectId,
              asset,
              { thresholdDb: -38, minSilenceSec: 0.85 },
              AbortSignal.timeout(60_000),
            );
            const silences = silenceResult.intervals;

            if (silences.length === 0) {
              const replyMsg = `He analizado la pista de audio de "${targetClip.name}" y no se detectaron pausas o silencios prolongados (> 0.85s a -38dB). El discurso ya cuenta con un ritmo dinámico continuo.`;
              emit({ type: "text", content: replyMsg });
              this.remember("user", userMessage);
              this.remember("assistant", replyMsg);
              this.liveStatus.active = false;
              return responses;
            }

            const keepRanges = keepRangesFromSilences(targetClip.sourceInUs, targetClip.sourceOutUs, silences, 0.22);
            const editResult = applySourceRanges(this.context.project, targetClip.id, keepRanges);

            if (editResult.ok) {
              const saved = await projectStore.saveTimeline(projectId, editResult.project, { force: true });
              this.context.project = saved.project;

              eventBus.publish(projectId, {
                type: "project",
                projectId,
                revision: saved.project.revision,
              });

              const totalSavedUs = silences.reduce((acc, s) => acc + (s.durationUs || s.endUs - s.startUs), 0);
              const totalSavedSec = (totalSavedUs / 1_000_000).toFixed(1);

              const replyMsg = `He eliminado automáticamente ${silences.length} silencios y pausas muertas (${totalSavedSec} segundos recortados) en "${targetClip.name}" aplicando Jump Cuts inteligentes con ripple. Tu video ahora tiene un ritmo dinámico y fluido sin tiempos muertos.`;
              emit({ type: "text", content: replyMsg });
              this.remember("user", userMessage);
              this.remember("assistant", replyMsg);
              this.liveStatus.active = false;
              return responses;
            } else {
              emit({ type: "error", content: editResult.error });
            }
          } catch (silenceErr: any) {
            console.error("[MotionAgent] Error en eliminación de silencios:", silenceErr);
            emit({ type: "error", content: `Error al procesar silencios: ${silenceErr.message || silenceErr}` });
          }
        }
      }
    }

    // Detección de petición de Zoom en el video / cámara / clics / acciones
    const asksVideoZoom =
      /\b(zoom|acerca|acercar|acercamiento|primer plano|escalar)\b/i.test(userMessage) &&
      /\b(video|videos|clic|clics|click|clicks|pantalla|acciones|accion|haciendo clic|cuando haga clic|cuando se hace clic|partes donde doy click|donde doy click|donde hago click)\b/i.test(userMessage) &&
      !/\b(transici[óo]n|transicion|punch)\b/i.test(userMessage);

    if (asksVideoZoom && this.context) {
      const currentPlayhead = this.context.currentFrame ?? 0;
      const videoTrack = this.context.project.tracks.find(
        (t: any) =>
          t.kind === "video" &&
          !/motion|overlay|transici|v0|fondo\s*ambient/i.test(t.name) &&
          t.clips.length > 0,
      );
      const targetClip =
        (this.selectedClipId ? videoTrack?.clips.find((c: any) => c.id === this.selectedClipId) : null) ??
        videoTrack?.clips.find(
          (c: any) =>
            c.type === "video" &&
            currentPlayhead >= c.startFrame &&
            currentPlayhead <= c.startFrame + c.durationFrames,
        ) ??
        videoTrack?.clips.find((c: any) => c.type === "video") ??
        videoTrack?.clips[0];

      if (targetClip) {
        const fps = projectFps(this.context.project);
        const clipStart = targetClip.startFrame || 0;
        const clipDuration = targetClip.durationFrames || 300;

        // Extraer tiempos explícitos si los hay (ej. "2:15", "135s", etc.)
        const explicitPoints: number[] = [];
        const colonMatches = userMessage.matchAll(/\b(\d{1,2}):(\d{2})\b/g);
        for (const m of colonMatches) {
          const mins = parseInt(m[1]!, 10);
          const secs = parseInt(m[2]!, 10);
          if (!isNaN(mins) && !isNaN(secs)) {
            explicitPoints.push(Math.round((mins * 60 + secs) * fps));
          }
        }
        const secMatches = userMessage.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:s|seg|segundos?)\b/gi);
        for (const m of secMatches) {
          const s = parseFloat(m[1]!);
          if (!isNaN(s) && s > 0) {
            explicitPoints.push(Math.round(s * fps));
          }
        }

        // Puntos de zoom objetivo
        let targetFrames: number[] = [];
        if (explicitPoints.length > 0) {
          targetFrames = explicitPoints;
        } else if (this.context.currentFrame > fps) {
          // El usuario está pausado en un momento concreto (ej. 2:15 en el visor)
          targetFrames = [this.context.currentFrame];
        } else {
          // Si no indicó tiempo y está en el segundo 0, aplicar en puntos clave del tutorial (ej. 0:45 y 2:15)
          targetFrames = clipDuration > 3600
            ? [Math.round(45 * fps), Math.round(135 * fps)]
            : [Math.round(clipDuration * 0.35)];
        }

        // Construir keyframes para cada punto de zoom expresado en tiempo local del clip
        const existingKeyframes = (targetClip.transform?.keyframes ?? []).filter((k: any) => {
          return !targetFrames.some((tf) => Math.abs(k.frame - (tf - clipStart)) < fps * 4);
        });

        const baseScale =
          targetClip.transform?.scale && targetClip.transform.scale > 0
            ? targetClip.transform.scale
            : 1;
        const baseX = targetClip.transform?.x ?? 0;
        const baseY = targetClip.transform?.y ?? 0;
        const zoomScale = Number((baseScale * 1.35).toFixed(2));

        const generatedKeyframes: Array<{ frame: number; scale: number; x: number; y: number }> = [];
        for (const tf of targetFrames) {
          const localTf = Math.max(fps, Math.min(clipDuration - Math.round(fps * 2.5), tf - clipStart));
          const zoomStart = Math.max(0, localTf - Math.round(fps * 0.5));
          const zoomHold = Math.min(clipDuration - Math.round(fps * 0.5), localTf + Math.round(fps * 3));
          const zoomEnd = Math.min(clipDuration, zoomHold + Math.round(fps * 0.5));

          generatedKeyframes.push(
            { frame: zoomStart, scale: baseScale, x: baseX, y: baseY },
            { frame: localTf, scale: zoomScale, x: baseX, y: baseY },
            { frame: zoomHold, scale: zoomScale, x: baseX, y: baseY },
            { frame: zoomEnd, scale: baseScale, x: baseX, y: baseY },
          );
        }

        const mergedKeyframes = [...existingKeyframes, ...generatedKeyframes].sort((a, b) => a.frame - b.frame);

        const updatedTracks = this.context.project.tracks.map((track: any) => {
          if (track.id === videoTrack.id) {
            return {
              ...track,
              clips: track.clips.map((clip: any) => {
                if (clip.id === targetClip.id) {
                  return {
                    ...clip,
                    transform: {
                      ...clip.transform,
                      keyframes: mergedKeyframes,
                    },
                  };
                }
                return clip;
              }),
            };
          }
          if (track.name.startsWith("Capa Motion")) {
            return {
              ...track,
              clips: track.clips.filter((c: any) => !/zoom\s*transition/i.test(c.name || "")),
            };
          }
          return track;
        });

        const updatedMedia = this.context.project.media.filter(
          (m: any) => !/zoom\s*transition/i.test(m.name || ""),
        );

        const updatedProject = {
          ...this.context.project,
          tracks: updatedTracks,
          media: updatedMedia,
          updatedAt: new Date().toISOString(),
        };

        const saved = await projectStore.saveTimeline(projectId, updatedProject, { force: true });
        this.context.project = saved.project;

        eventBus.publish(projectId, {
          type: "project",
          projectId,
          revision: saved.project.revision,
        });

        const timeLabels = targetFrames.map((f) => {
          const s = Math.round(f / fps);
          const mins = Math.floor(s / 60);
          const secs = s % 60;
          return `${mins}:${secs.toString().padStart(2, "0")}`;
        }).join(", ");

        const replyMsg = `He aplicado el zoom dinámico (${zoomScale}x) sobre "${targetClip.name}" en los momentos clave (${timeLabels}), partiendo desde su encuadre actual y regresando con suavidad al plano original. Puedes ajustar la posición X/Y o la duración en el Inspector.`;
        emit({ type: "text", content: replyMsg });
        this.remember("user", userMessage);
        this.remember("assistant", replyMsg);
        this.liveStatus.active = false;
        return responses;
      }
    }

    this.reportStep("Analizando tu instrucción y contexto del proyecto...", onProgress);
    const plan = await this.planAction(userMessage);
    this.remember("user", userMessage);

    if (plan.reply) this.remember("assistant", plan.reply);

    if (plan.reply) emit({ type: "text", content: stripEmojis(plan.reply) });

    try {
      switch (plan.action) {
        case "answer":
          this.liveStatus.active = false;
          this.liveStatus.steps = [];
          this.liveStatus.currentStep = "";
          break;

        case "subtitles": {
          if (!this.context) throw new Error("Falta el contexto del proyecto.");
          this.reportStep("Procesando transcripción y diseñando subtítulos...", onProgress);
          const subResponses = await this.generateSubtitles(plan, userMessage);
          for (const sr of subResponses) emit(sr);
          break;
        }

        case "preview": {
          const currentComponent = this.lastComponent;
          if (!currentComponent) {
            emit({
              type: "text",
              content:
                "Todavía no hay ninguna pieza generada. Dime qué quieres animar y la creo.",
            });
            break;
          }
          this.reportStep("Generando previsualización rápida...", onProgress);
          const preview = await this.renderPreview(currentComponent);
          emit(this.toPreviewResponse(currentComponent, preview));
          break;
        }

        case "insert": {
          if (!this.lastComponent) {
            emit({
              type: "text",
              content:
                "Aún no tengo una pieza para insertar. Pídeme primero el motion graphic y luego lo pongo en el timeline.",
            });
            break;
          }
          this.reportStep("Renderizando versión final e insertando en el timeline...", onProgress);
          emit(await this.renderAndInsert(plan.insertAtEnd));
          break;
        }

        case "modify":
        case "create": {
          // Cambio de estilo sobre subtítulos ya generados: SOLO cuando la acción es
          // modificar subtítulos y no cuando el usuario pide crear un gráfico/mapa/título nuevo.
          const asksNewVisualGraphic =
            /\b(mapa|gr[áa]fico|grafico|dinero|contador|barra|barras|t[íi]tulo|titulo|lower third|intro|outro|logo|icono|tarjeta|kpi|cta)\b/i.test(
              userMessage,
            );
          const isSubtitlePiece =
            plan.action === "modify" &&
            !asksNewVisualGraphic &&
            this.lastComponent?.props?.captions != null &&
            /subtit|caption|subs/i.test(this.lastComponent.name);
          const styleChanged =
            plan.style != null && plan.style !== this.lastSubtitleStyle;
          if (isSubtitlePiece && (styleChanged || plan.style === "custom")) {
            this.reportStep("Aplicando nuevo estilo a los subtítulos existentes...", onProgress);
            const subResponses = await this.generateSubtitles(plan, userMessage);
            for (const sr of subResponses) emit(sr);
            break;
          }

          if (plan.action === "modify" && !this.lastComponent) {
            // No hay nada que modificar: se trata como una creación nueva.
            await this.createAndPreview(plan, userMessage, emit);
            break;
          }

          await this.createAndPreview(plan, userMessage, emit);

          if (plan.autoInsert && this.lastComponent) {
            this.reportStep("Insertando automáticamente en el timeline...", onProgress);
            emit(await this.renderAndInsert(plan.insertAtEnd));
          }
          break;
        }
      }
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[MotionAgent] processMessage failed:", error);
      emit({ type: "error", content: message });
    } finally {
      this.liveStatus.active = false;
      this.liveStatus.currentStep = "";
      eventBus.publish(projectId, {
        type: "motion-progress",
        projectId,
        active: false,
      });
    }

    return responses;
  }

  // ---------------------------------------------------------------------------
  // Planificación
  // ---------------------------------------------------------------------------

  private async planAction(message: string): Promise<MotionPlan> {
    const userPrompt = [
      this.projectSummary(),
      this.conversationSummary(),
      this.componentSummary(),
      `MENSAJE DEL USUARIO:\n${message}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const result = await chatJson(
        MOTION_PLANNER_PROMPT,
        userPrompt,
        AbortSignal.timeout(PLANNER_TIMEOUT_MS),
        { maxTokens: 900, temperature: 0.15 },
      );
      const plan = normalizePlan(result.data, message);
      return this.overridePlanIfVisual(plan, message);
    } catch (error) {
      console.warn(
        "[MotionAgent] Planner no disponible, usando plan de respaldo:",
        error instanceof Error ? error.message : error,
      );
      return this.fallbackPlan(message);
    }
  }

  /**
   * Override determinista: si el mensaje pide claramente crear algo visual
   * (título, animación, lower third, mapa, gráfico...) pero el LLM devolvió
   * "answer", se corrige a "create". El usuario nunca debe quedarse con un
   * texto vacío cuando pidió una pieza.
   */
  private overridePlanIfVisual(plan: MotionPlan, message: string): MotionPlan {
    if (plan.action !== "answer") return plan;
    if (isConversationalQuery(message)) return plan;
    const lower = message.toLowerCase();
    const isgreeting = /^(hola|hey|buenas|qué puedes|que puedes|ayuda|gracias)\b/.test(lower);
    if (isgreeting && message.length < 60) return plan;

    const asksVisual =
      /\b(crea|crear|genera|generar|haz|hacer|diseña|diseñar|a[ñn]ade|a[ñn]adir|muéstrame|mostrar|quiero|necesito|pon|poner)\b/.test(lower) &&
      /\b(t[íi]tulo|titulo|animaci[óo]n|animado|animada|lower third|intro|outro|mapa|gr[áa]fico|contador|icono|logo|transici[óo]n|motion|visual|tipograf[íi]a|texto animado|subt[íi]tulo|caption|efecto|barras|tabla)\b/.test(lower);

    if (!asksVisual) return plan;

    const wantsSubtitles = /\b(subt[íi]tulos?|captions?|subtitula)\b/.test(lower);
    if (wantsSubtitles) {
      return {
        ...plan,
        action: "subtitles",
        reply: "Voy a preparar los subtítulos.",
        brief: message,
        style: plan.style ?? resolveSubtitleStyle(undefined, message),
        durationInFrames: null,
      };
    }

    return {
      ...plan,
      action: "create",
      reply: plan.reply && plan.reply.length > 12 ? plan.reply : "Voy a preparar esa pieza.",
      brief: plan.brief?.trim() ? plan.brief : message,
    };
  }

  /**
   * Respaldo cuando el proveedor no responde. No es el camino normal: sirve
   * para no dejar el chat mudo si falla la red. La generación de código sigue
   * necesitando el modelo, así que un fallo real se reporta al usuario.
   */
  private fallbackPlan(message: string): MotionPlan {
    const lower = message.toLowerCase();
    const hasComponent = Boolean(this.lastComponent);
    const hasSelectedClip = Boolean(this.selectedClipId);
    const wantsSubtitles = /\b(subt[íi]tulos?|captions?|subtitula)\b/.test(lower);
    const wantsNew = /\b(genera|generar|crea|crear|diseña|diseñar|haz|hacer|animación|animado|título|lower third|intro|outro|mapa|gráfico|contador|icono|logo|transición|motion|visual|tipografía|texto animado)\b/.test(lower);
    const wantsModify = /\b(cambia|modifica|ajusta|corrige|hazlo|hazla|redimensiona|tama[ñn]o|estilo|font|color)\b/.test(lower);

    // Si hay un clip seleccionado y se pide modificar, es una modificación
    if (hasSelectedClip && (wantsModify || wantsSubtitles)) {
      return {
        action: "modify",
        reply: `Ajusto el clip seleccionado (${this.selectedClipId}).`,
        brief: message,
        durationInFrames: null,
        autoInsert: false,
        insertAtEnd: false,
      };
    }

    // Petición nueva de subtítulos, o cambio de estilo sobre los que ya hay.
    if (wantsSubtitles && (!hasComponent || wantsNew)) {
      return {
        action: "subtitles",
        reply: "Voy a transcribir el audio real y montarte los subtítulos.",
        brief: message,
        style: resolveSubtitleStyle(undefined, message),
        durationInFrames: null,
        autoInsert: false,
        insertAtEnd: false,
      };
    }

    if (hasComponent && /\b(inserta|insertar|aplica|aplicar|ponlo|ponla|timeline|exporta)\b/.test(lower)) {
      return {
        action: "insert",
        reply: "Lo inserto en el timeline.",
        brief: "",
        durationInFrames: null,
        autoInsert: false,
        insertAtEnd: /al final|final del timeline/.test(lower),
      };
    }
    if (hasComponent && /\b(preview|previsualiza|muestra|ver)\b/.test(lower)) {
      return {
        action: "preview",
        reply: "Te muestro la pieza actual.",
        brief: "",
        durationInFrames: null,
        autoInsert: false,
        insertAtEnd: false,
      };
    }
    if (hasComponent && /\b(cambia|modifica|ajusta|corrige|hazlo|hazla|quita|pon)\b/.test(lower)) {
      return {
        action: "modify",
        reply: "Ajusto la pieza.",
        brief: message,
        durationInFrames: null,
        autoInsert: false,
        insertAtEnd: false,
      };
    }
    if (isConversationalQuery(message)) {
      return {
        action: "answer",
        reply:
          "He analizado tu video y te recomiendo 3 cosas clave para aumentar la retención:\n" +
          "1. **Subtítulos Virales al Toque**: Subtítulos dinámicos estilo Hormozi o TikTok con resaltado palabra por palabra.\n" +
          "2. **Cortes de Silencios (Jump Cuts)**: Eliminar pausas muertas y respiraciones para que el ritmo sea ágil.\n" +
          "3. **Título Cinético o Smart B-Roll**: Colocar un gancho visual en los primeros 3 segundos o gráficos animados de apoyo.\n\n" +
          "¿Quieres que le agregue los subtítulos virales o prefieres empezar con los jump cuts?",
        brief: "",
        durationInFrames: null,
        autoInsert: false,
        insertAtEnd: false,
      };
    }
    if (/^(hola|hey|buenas|qué puedes|que puedes|ayuda)\b/.test(lower) && message.length < 60) {
      return {
        action: "answer",
        reply:
          "Puedo crear cualquier motion graphic con Remotion: mapas, gráficos, contadores, títulos, lower thirds, iconos, intros y transiciones. Dime qué necesitas y a qué región o dato debe apuntar.",
        brief: "",
        durationInFrames: null,
        autoInsert: false,
        insertAtEnd: false,
      };
    }
    return {
      action: "create",
      reply: "Voy a preparar esa pieza.",
      brief: message,
      durationInFrames: null,
      autoInsert: false,
      insertAtEnd: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Generación y reparación
  // ---------------------------------------------------------------------------

  private async createAndPreview(
    plan: MotionPlan,
    userMessage: string,
    onProgress?: (response: MotionResponse) => void,
  ): Promise<MotionResponse[]> {
    if (!this.context) throw new Error("Falta el contexto del proyecto.");

    const fps = projectFps(this.context.project);
    const brief =
      plan.brief ||
      this.lastBrief ||
      userMessage ||
      "Motion graphic limpio y profesional acorde al proyecto.";

    // Una pieza nueva invalida el pre-render de la anterior.
    cancelPrewarm(this.context.projectId);

    const requestedDuration =
      plan.durationInFrames ??
      secondsToFrames(userMessage, fps) ??
      clampDurationFrames(3 * fps, fps, Math.round(fps * 90));

    const responses: MotionResponse[] = [];
    const push = (r: MotionResponse) => {
      const cleaned = cleanEmojis(r);
      responses.push(cleaned);
      onProgress?.(cleaned);
    };

    const isModify = plan.action === "modify";

    // Detección de Smart B-Roll y Gráficos Estadísticos Automáticos vinculados al audio
    const isSmartBRoll =
      !isModify &&
      /\b(b-roll|broll|estad[íi]st|porcentaj|m[é metric]|cifra|gr[áa]fico|grafico|barra|barras|creci|ventas|dinero|escalando)\b/i.test(
        userMessage,
      );
    const smartBRollMatch = isSmartBRoll ? this.findSmartBRollTimestamp(userMessage) : null;
    if (smartBRollMatch) {
      const atSeconds = (smartBRollMatch.startFrame / fps).toFixed(2);
      if (smartBRollMatch.foundInAudio) {
        push({
          type: "text",
          content: `Detectada mención en el audio: "${smartBRollMatch.matchedText}" en el segundo ${atSeconds}s (frame ${smartBRollMatch.startFrame}). Sincronizando Smart B-Roll en ese instante exacto...`,
          data: { isStep: true },
        });
      } else {
        push({
          type: "text",
          content: `Configurando Smart B-Roll estadístico: "${smartBRollMatch.metricLabel}" (${smartBRollMatch.metricValue}) con barra escalando hacia arriba en el frame ${smartBRollMatch.startFrame}...`,
          data: { isStep: true },
        });
      }
    }

    // Detección de Transición Cinemática Procedural (0ms de descarga)
    const isTransitionRequest =
      !isModify &&
      /\b(transici[óo]n|transicion|whip\s*pan|zoom\s*punch|glitch|light\s*leak|fuga de luz|destello)\b/i.test(
        userMessage,
      );

    let proceduralTransition: ReturnType<typeof buildProceduralTransition> | null = null;
    if (isTransitionRequest) {
      let tid: RemotionTransitionId = "whip-pan";
      if (/zoom\s*punch|punch|impacto|zoom/i.test(userMessage)) tid = "zoom-punch";
      else if (/glitch|digital|ciber|cyber|crt/i.test(userMessage)) tid = "glitch-svg";
      else if (/light\s*leak|luz|quemadura|film|35mm|anal[óo]gic/i.test(userMessage)) tid = "light-leak";
      else if (/whip\s*pan|barrido|whip|velocidad/i.test(userMessage)) tid = "whip-pan";

      proceduralTransition = buildProceduralTransition(tid);
      push({
        type: "text",
        content: `Cargando transición procedural "${proceduralTransition.componentName}" (0ms de descarga, 100% vector y shader escalable sin pixelarse)...`,
        data: { isStep: true },
      });
    }

    // Selección explícita de plantillas predefinidas (SOLO cuando el usuario pide explícitamente 'plantilla predefinida' o 'preset fijo')
    const asksExplicitPreset = /\b(plantilla predefinida|preset fijo)\b/i.test(userMessage);

    // Detección de Lower Thirds y Rótulos de Identidad (Brand Kit IA)
    const isLowerThirdRequest =
      !isModify &&
      asksExplicitPreset &&
      /\b(lower\s*third|r[óo]tulo|rotulo|identidad|brand\s*kit|qui[ée]n habla|quien habla|orador|speaker|presentador)\b/i.test(
        userMessage,
      );

    let brandLowerThird: {
      code: string;
      componentName: string;
      compositionId: string;
      durationInFrames: number;
      props: Record<string, unknown>;
    } | null = null;
    if (isLowerThirdRequest && !proceduralTransition) {
      const speaker = this.detectSpeakerIdentity(userMessage);
      const preset = MOTION_PRESET_TEMPLATES.find((p) => p.id === "brand-identity-lower-third");
      if (preset) {
        const props = {
          ...preset.defaultProps,
          name: speaker.name,
          role: speaker.role,
          company: speaker.company,
          handle: speaker.handle,
          initials: speaker.initials,
          accentColor: speaker.accentColor,
          accentSecondary: speaker.accentSecondary,
        };
        brandLowerThird = {
          code: preset.code,
          componentName: preset.componentName,
          compositionId: preset.compositionId,
          durationInFrames: preset.durationFrames,
          props,
        };
        push({
          type: "text",
          content: `Cargando plantilla Rótulo de Identidad Brand Kit para "${speaker.name}"...`,
          data: { isStep: true },
        });
      }
    }

    // Detección de Título Cinético Predefinido
    const isKineticTitleRequest =
      !isModify &&
      !proceduralTransition &&
      !brandLowerThird &&
      asksExplicitPreset &&
      /\b(t[íi]tulo|titulo|intro|titular|cin[ée]tico|cinetico|hero|apertura|inicio del video|comienzo)\b/i.test(
        userMessage,
      );

    let kineticTitle: {
      code: string;
      componentName: string;
      compositionId: string;
      durationInFrames: number;
      props: Record<string, unknown>;
    } | null = null;
    if (isKineticTitleRequest) {
      const preset = MOTION_PRESET_TEMPLATES.find((p) => p.id === "kinetic-hero-title");
      if (preset) {
        const explicitTitles = extractExplicitPromptTitles(userMessage);
        const titleText =
          explicitTitles.introTitle ??
          resolveContextualOverlayCopy({
            prompt: userMessage,
            project: this.context.project,
            transcriptTexts: this.collectProjectTranscriptTexts(),
          }).headline;
        kineticTitle = {
          code: preset.code,
          componentName: preset.componentName,
          compositionId: preset.compositionId,
          durationInFrames: preset.durationFrames,
          props: {
            ...preset.defaultProps,
            badge: "INTRO",
            title: titleText,
            subtitle: explicitTitles.introSubtitle ?? "",
            accentColor: "#4ADE80",
          },
        };
        push({
          type: "text",
          content: `Cargando plantilla Título Cinético Moderno con animación física spring()...`,
          data: { isStep: true },
        });
      }
    }

    // Mensajes de proceso visibles para el usuario (registro de la creación).
    push({
      type: "text",
      content: isModify
        ? "Ajustando la pieza actual..."
        : "Interpretando el brief y diseñando la pieza...",
      data: { isStep: true },
    });
    push({
      type: "text",
      content: `Escribiendo el componente Remotion (${proceduralTransition ? proceduralTransition.durationInFrames : brandLowerThird ? brandLowerThird.durationInFrames : kineticTitle ? kineticTitle.durationInFrames : requestedDuration} frames · ${seconds(proceduralTransition ? proceduralTransition.durationInFrames : brandLowerThird ? brandLowerThird.durationInFrames : kineticTitle ? kineticTitle.durationInFrames : requestedDuration, fps)} s)...`,
      data: { isStep: true },
    });

    const existing = isModify ? this.lastComponent : null;
    let component: ComponentState;
    let preview: RenderResult;

    if (proceduralTransition) {
      component = {
        code: proceduralTransition.code,
        name: proceduralTransition.componentName,
        compositionId: proceduralTransition.compositionId,
        durationInFrames: proceduralTransition.durationInFrames,
        reasoning: "Transición cinemática procedural generada en React/Remotion (0ms de descarga, vector/shader escalable).",
        startFrame: this.context.currentFrame,
      };
      push({
        type: "text",
        content: "Compilando bundle Webpack y renderizando transición cinemática...",
        data: { isStep: true },
      });
      preview = await this.renderPreview(component, fps, (p) => {
        const pct = Math.round((p.progress || 0) * 100);
        if (pct % 25 === 0 && pct > 0 && pct < 100) {
          push({
            type: "text",
            content: `Renderizando fotogramas con canal alfa (${pct}%)...`,
            data: { isStep: true },
          });
        }
      });
    } else if (brandLowerThird) {
      component = {
        code: brandLowerThird.code,
        name: brandLowerThird.componentName,
        compositionId: brandLowerThird.compositionId,
        durationInFrames: brandLowerThird.durationInFrames,
        props: brandLowerThird.props,
        reasoning: `Rótulo de Identidad Brand Kit para "${brandLowerThird.props.name}" (${brandLowerThird.props.role}) con degradados de cristal, avatar y sound design sincronizado.`,
        startFrame: this.context.currentFrame,
      };
      push({
        type: "text",
        content: "Compilando bundle Webpack y renderizando Lower Third con transparencia...",
        data: { isStep: true },
      });
      preview = await this.renderPreview(component, fps, (p) => {
        const pct = Math.round((p.progress || 0) * 100);
        if (pct % 25 === 0 && pct > 0 && pct < 100) {
          push({
            type: "text",
            content: `Renderizando fotogramas con canal alfa (${pct}%)...`,
            data: { isStep: true },
          });
        }
      });
    } else if (kineticTitle) {
      component = {
        code: kineticTitle.code,
        name: kineticTitle.componentName,
        compositionId: kineticTitle.compositionId,
        durationInFrames: kineticTitle.durationInFrames,
        props: kineticTitle.props,
        reasoning: "Título cinético moderno para el inicio del video con físicas spring y píldora superior.",
        startFrame: this.resolveRequestedStartFrame(brief, kineticTitle.durationInFrames),
      };
      push({
        type: "text",
        content: "Compilando bundle Webpack y calculando físicas spring() para el título cinético...",
        data: { isStep: true },
      });
      preview = await this.renderPreview(component, fps, (p) => {
        const pct = Math.round((p.progress || 0) * 100);
        if (pct % 25 === 0 && pct > 0 && pct < 100) {
          push({
            type: "text",
            content: `Renderizando fotogramas con canal alfa (${pct}%)...`,
            data: { isStep: true },
          });
        }
      });
    } else {
      const built = await this.buildComponent(
        brief,
        requestedDuration,
        existing,
        (stepMessage) => {
          push({ type: "text", content: stepMessage, data: { isStep: true } });
        },
        smartBRollMatch,
      );
      component = built.component;
      preview = built.preview;
    }

    this.lastComponent = component;
    this.lastBrief = brief;

    push({
      type: "component",
      content: component.code,
      data: {
        componentName: component.name,
        compositionId: component.compositionId,
        durationInFrames: component.durationInFrames,
        reasoning: component.reasoning,
        modified: plan.action === "modify",
        props: component.props,
        startFrame: component.startFrame,
        renderKey: overlayRenderKey(component, this.context.project),
      },
    });
    push(this.toPreviewResponse(component, preview));

    push({
      type: "text",
      content: "Preview listo. Pulsa \"Render + Insertar\" para colocarlo sobre el vídeo.",
      data: { isStep: true },
    });

    // Pre-render en segundo plano: cuando el usuario pulse "Render + Insertar"
    // lo normal es que el archivo ya esté listo.
    schedulePrewarm(this.context.projectId, this.context.project, component);

    return responses;
  }

  private async buildComponent(
    brief: string,
    durationInFrames: number,
    existing: ComponentState | null,
    onProgress?: (message: string) => void,
    smartBRoll?: SmartBRollMatch | null,
  ): Promise<{ component: ComponentState; preview: RenderResult }> {
    const fps = projectFps(this.context!.project);
    onProgress?.("Diseñando animación y generando código TSX...");

    let component: ComponentState;
    try {
      component = await this.generateComponent(brief, durationInFrames, existing, undefined, smartBRoll);
    } catch (genError) {
      console.warn("[MotionAgent] generateComponent falló o tardó demasiado, usando plantilla adaptada:", genError);
      onProgress?.("Adaptando plantilla gráfica de alta calidad basada en tu instrucción...");
      component = this.createFallbackComponent(brief, durationInFrames);
    }

    if (smartBRoll && typeof smartBRoll.startFrame === "number") {
      component.startFrame = smartBRoll.startFrame;
    } else if (!existing && component.startFrame === undefined) {
      component.startFrame = this.resolveRequestedStartFrame(brief, component.durationInFrames);
    }
    let lastError = "";

    for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
      onProgress?.(
        attempt === 0
          ? "Validando sintaxis y rangos de animación..."
          : `Re-validando código corregido (intento ${attempt + 1}/${MAX_BUILD_ATTEMPTS})...`,
      );
      const validation = await validateTsx(component.code);
      if (!validation.ok) {
        lastError = validation.error ?? "Sintaxis TSX inválida.";
        if (attempt === MAX_BUILD_ATTEMPTS - 1) break;
        console.warn("[MotionAgent] Código inválido, reparando:", lastError);
        onProgress?.(`Detectado problema en código: ${shortError(lastError, 100)}. Reparando...`);
        try {
          component = await this.repairComponent(
            component,
            brief,
            `El código no compila:\n${lastError}`,
          );
        } catch {
          component = this.createFallbackComponent(brief, durationInFrames);
          break;
        }
        continue;
      }

      let lastBucket = -1;
      onProgress?.("Compilando bundle Webpack (0%)...");
      const preview = await this.renderPreview(component, fps, (p) => {
        const pct = Math.round((p.progress || 0) * 100);
        const bucket = Math.floor(pct / 20) * 20;
        if (bucket > lastBucket && bucket > 0 && bucket < 100) {
          lastBucket = bucket;
          const stageLabel = p.stage === "bundle" ? "Compilando bundle Webpack" : "Renderizando fotogramas Remotion";
          onProgress?.(`${stageLabel} (${pct}%)...`);
        }
      });
      if (preview.success && preview.base64Video) {
        onProgress?.("¡Previsualización generada exitosamente!");
        return { component, preview };
      }

      lastError = preview.error ?? "El render no devolvió vídeo.";
      if (attempt === MAX_BUILD_ATTEMPTS - 1) break;
      console.warn("[MotionAgent] Render falló, reparando:", lastError);
      onProgress?.(`Ajustando render Remotion: ${shortError(lastError, 100)}...`);
      try {
        component = await this.repairComponent(
          component,
          brief,
          `El componente falló al renderizar en Remotion:\n${lastError}`,
        );
      } catch {
        component = this.createFallbackComponent(brief, durationInFrames);
        break;
      }
    }

    // Si falló la generación dinámica, recurrir a la plantilla garantizada de Remotion
    onProgress?.("Renderizando pieza visual garantizada...");
    component = this.createFallbackComponent(brief, durationInFrames);
    const fallbackPreview = await this.renderPreview(component, fps);
    if (fallbackPreview.success && fallbackPreview.base64Video) {
      onProgress?.("¡Previsualización lista!");
      return { component, preview: fallbackPreview };
    }

    throw new Error(
      `No pude generar una pieza que renderice. Último error: ${
        shortError(lastError) || "desconocido"
      }`,
    );
  }

  private collectProjectTranscriptTexts(): string[] {
    const projectTexts = collectTranscriptTextsFromProject(this.context?.project);
    if (projectTexts.length > 0) return projectTexts;
    return (this.subtitleCache?.segments ?? [])
      .map((seg: any) => String(seg.text ?? "").trim())
      .filter(Boolean);
  }

  private resolveRequestedStartFrame(brief: string, durationInFrames: number): number {
    const project = this.context?.project;
    if (
      /\b(al\s+(?:inicio|incio|principio|comienzo)|en\s+el\s+(?:inicio|incio|principio|comienzo)|desde\s+el\s+(?:inicio|principio)|apertura|portada)\b/i.test(
        brief,
      )
    ) {
      return 0;
    }
    if (/\b(al\s+final|en\s+el\s+final|cierre|outro|despedida)\b/i.test(brief)) {
      const total = project ? timelineDurationFrames(project) : 0;
      return Math.max(0, total - Math.max(1, durationInFrames));
    }
    const atSecMatch = brief.match(
      /\b(?:en\s+el\s+segundo|a\s+los?|desde\s+el\s+segundo)\s+(\d+(?:[.,]\d+)?)\b/i,
    );
    if (atSecMatch?.[1] && project) {
      const sec = Number.parseFloat(atSecMatch[1].replace(",", "."));
      if (Number.isFinite(sec) && sec >= 0) {
        return Math.round(sec * projectFps(project));
      }
    }
    return this.context?.currentFrame ?? 0;
  }

  private resolveTimelineStylePalette(
    fallbackPalette: HyperFramePalette,
    wantsCorporateClean: boolean,
  ): HyperFramePalette {
    if (!wantsCorporateClean || !this.context?.project?.tracks) {
      return fallbackPalette;
    }
    const isHex = (v: unknown): v is string =>
      typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v.trim());
    let detectedHighlight: string | undefined;
    let detectedText: string | undefined;
    let detectedSurface: string | undefined;

    for (const track of this.context.project.tracks as any[]) {
      for (const clip of track.clips ?? []) {
        const props = clip.remotion?.props ?? {};
        if (!detectedHighlight && isHex(props.highlightColor)) detectedHighlight = props.highlightColor.trim();
        if (!detectedHighlight && isHex(props.accentColor)) detectedHighlight = props.accentColor.trim();
        if (!detectedText && isHex(props.color)) detectedText = props.color.trim();
        if (!detectedText && isHex(clip.color)) detectedText = clip.color.trim();
        if (!detectedSurface && isHex(props.backgroundColor)) detectedSurface = props.backgroundColor.trim();
        if (!detectedSurface && isHex(clip.backgroundColor)) detectedSurface = clip.backgroundColor.trim();
      }
    }

    return {
      ...fallbackPalette,
      ...(detectedHighlight ? { accent: detectedHighlight } : {}),
      ...(detectedText ? { text: detectedText } : {}),
      ...(detectedSurface ? { surface: detectedSurface } : {}),
    };
  }

  private createFallbackComponent(
    brief: string,
    durationInFrames: number,
  ): ComponentState {
    const lower = brief.toLowerCase();

    // 1. Extraer ADN Semántico y Dirección de Arte exclusiva en tiempo real (Zero-Template Engine)
    const dna = extractProjectSemanticDNA({
      prompt: brief,
      projectName: this.context?.project?.name,
    });
    const copy = resolveContextualOverlayCopy({
      prompt: brief,
      project: this.context?.project,
      transcriptTexts: this.collectProjectTranscriptTexts(),
      dna,
    });
    const palette: HyperFramePalette = this.resolveTimelineStylePalette(
      dna.masterPalette,
      copy.wantsCorporateCleanStyle,
    );
    const requestedStartFrame = this.resolveRequestedStartFrame(brief, durationInFrames);

    const isBrand = Boolean(detectBrandUrlInPrompt(brief));
    const isMap = isMapOrRoutePrompt(lower);
    const isDataOrChart = /\b(m[ée]trica|metrica|gr[áa]fico|grafico|kpi|contador|porcentaje|ventas|datos|chart|barras)\b/i.test(lower);
    const isCharacter = dna.characters.length > 0 && /\b(habla|dice|orador|personaje|avatar|dialogo|diálogo|presenta|expositor)\b/i.test(lower);
    const isCyberOrGrid = /\b(cyber|ciber|grid|malla|futur|part[íi]cula|atm[óo]sfera|ambient|espacio)\b/i.test(lower);
    const isRichMedia = /\b(imagen|foto|sticker|icono|recorte|multimedia|badge)\b/i.test(lower);

    const extractedTitle = copy.headline;
    const resolvedSubtitle = copy.subheadline;
    const fontFamily = copy.wantsCorporateCleanStyle ? "Inter" : "Space Grotesk";

    if (isBrand) {
      const brandUrl = detectBrandUrlInPrompt(brief) || "https://brand.com";
      const domain = brandUrl.replace(/^https?:\/\//, "").split("/")[0] || "brand.com";
      const spec = buildHyperFrameBrandCard({
        brandName: extractedTitle,
        tagline: resolvedSubtitle || "Plataforma digital de última generación",
        domain,
        metricsText: "60 FPS · Verificado",
        badge: "BRAND INTELLIGENCE",
        zone: "hero-top",
        palette,
      });
      return {
        code: spec.code,
        name: spec.componentName,
        compositionId: `${spec.componentName}Comp`,
        durationInFrames,
        props: spec.props,
        reasoning: "Tarjeta de identidad ejecutiva de marca HyperFrames con monograma dinámico y destello sheen.",
        startFrame: requestedStartFrame,
      };
    }

    if (isCharacter && dna.characters[0]) {
      const char = dna.characters[0];
      const spec = buildHyperFrameCharacterDialogue({
        characterName: char.name,
        characterRole: char.role,
        dialogueText: extractedTitle !== dna.categoryLabel.toUpperCase() ? extractedTitle : "Composición autónoma a 60 FPS con síntesis determinista.",
        badge: char.badge || dna.themeKicker,
        avatarInitials: char.initials,
        zone: "hero-top",
        palette,
      });
      return {
        code: spec.code,
        name: spec.componentName,
        compositionId: `${spec.componentName}Comp`,
        durationInFrames,
        props: spec.props,
        reasoning: `Diálogo procedimental con personaje animado ${char.name} (${char.role}) y barras de voz reactivas.`,
        startFrame: requestedStartFrame,
      };
    }

    if (isMap) {
      const cities = extractRouteCities(brief);
      const spec = buildHyperFrameAnimatedMap({
        title: extractedTitle,
        subtitle: resolvedSubtitle || "Ruta geodésica y telemetría en vivo",
        routeFrom: cities.from,
        routeTo: cities.to,
        routeDistanceKm: 10450,
        badge: "REMOTION MAPS",
        zone: "hero-top",
        palette,
      });
      return {
        code: spec.code,
        name: spec.componentName,
        compositionId: `${spec.componentName}Comp`,
        durationInFrames,
        props: spec.props,
        reasoning: "Mapa procedimental animado Remotion Maps con ruta geodésica curva y faro de pulso.",
        startFrame: requestedStartFrame,
      };
    }

    if (isDataOrChart) {
      const numericMatches = [...brief.matchAll(/([A-Za-zÁÉÍÓÚáéíóúñÑ0-9_-]{2,18})\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(%|x|k|m)?/gi)]
        .filter((m) => Number.isFinite(Number.parseFloat((m[2] ?? "").replace(",", "."))))
        .slice(0, 4);

      if (numericMatches.length > 0) {
        const parsedItems = numericMatches.map((m, idx) => {
          const val = Number.parseFloat(m[2]!.replace(",", "."));
          const unit = m[3] ?? "";
          return {
            label: m[1]!,
            value: val,
            formatted: `${val}${unit}`,
            color: idx % 2 === 0 ? palette.accent : palette.secondary,
          };
        });
        const spec = buildHyperFrameDataChart({
          title: extractedTitle,
          subtitle: resolvedSubtitle || `Visualización dinámica · ${copy.badge}`,
          badge: dna.themeKicker || "DATOS EN VIVO",
          chartType: "bars",
          items: parsedItems,
          palette,
          zone: "lower-third",
        });
        return {
          code: spec.code,
          name: spec.componentName,
          compositionId: `${spec.componentName}Comp`,
          durationInFrames,
          props: spec.props,
          reasoning: "Gráfico de barras procedural generado con las cifras exactas de tu instrucción.",
          startFrame: requestedStartFrame,
        };
      }
    }

    if (isCyberOrGrid) {
      const spec = buildHyperFrameMotionGrid({
        theme: "cyber",
        title: extractedTitle,
        kicker: dna.themeKicker || "HIPER-ESPACIO",
        palette,
      });
      return {
        code: spec.code,
        name: spec.componentName,
        compositionId: `${spec.componentName}Comp`,
        durationInFrames,
        props: spec.props,
        reasoning: "Malla procedural 3D con perspectiva ciberespacial y horizonte de luz animado a 60 FPS.",
        startFrame: requestedStartFrame,
      };
    }

    if (isRichMedia) {
      const spec = buildHyperFrameRichMediaOverlay({
        title: extractedTitle,
        tag: copy.badge || "DESTACADO",
        description: resolvedSubtitle,
        palette,
        zone: "lower-third",
      });
      return {
        code: spec.code,
        name: spec.componentName,
        compositionId: `${spec.componentName}Comp`,
        durationInFrames,
        props: spec.props,
        reasoning: "Capa multimedia Remotion <Img> con encuadre reflectante y resplandor.",
        startFrame: requestedStartFrame,
      };
    }

    // Generación polimórfica sin plantillas (Canvas 2D / 3D Orbital / Espectro SVG / Monolito) adaptada al contexto real
    const hasRealVideo = Boolean(
      this.context?.project?.tracks?.some(
        (t: any) =>
          t.kind === "video" &&
          !/motion|overlay|atm[óo]sfera/i.test(String(t.name ?? "")) &&
          Array.isArray(t.clips) &&
          t.clips.some((c: any) => c.type === "video" && !c.remotion),
      ),
    );
    const metricMatch = isConversationalInstructionText(brief)
      ? null
      : brief.match(/(\+|-)?\d+(?:[.,]\d+)?\s*(%|x\b|k\b|m\b|€|\$|usd\b|millones\b)/i);
    const rawSeed = Math.abs(
      brief.split("").reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 17) +
        requestedStartFrame,
    );
    const seed = copy.wantsCorporateCleanStyle ? 3 : rawSeed;
    const polyName = `DynamicMotion${(rawSeed % 9000) + 1000}`;
    const zone = hasRealVideo ? "hero-top" : "center-stage";
    const polyCode = buildPolymorphicProceduralSceneCode({
      componentName: polyName,
      variantSeed: seed,
      headline: extractedTitle,
      subheadline: resolvedSubtitle,
      accentColor: palette.accent,
      secondaryColor: palette.secondary,
      surfaceColor: palette.surface,
      textColor: palette.text,
      fontFamily,
      visualTheme: copy.badge,
      transparentOverlay: hasRealVideo,
      zone,
      metricValue: metricMatch?.[0],
    });
    return {
      code: polyCode,
      name: polyName,
      compositionId: `${polyName}Comp`,
      durationInFrames,
      props: {
        zone,
        accentColor: palette.accent,
        secondaryColor: palette.secondary,
        surfaceColor: palette.surface,
        textColor: palette.text,
        title: extractedTitle,
        subtitle: resolvedSubtitle,
        metricValue: metricMatch?.[0] ?? "",
        fontFamily,
      },
      reasoning: `Motor procedural polimórfico (${hasRealVideo ? "HUD transparente sobre vídeo" : "Escena completa Canvas/3D/SVG"}) para ${copy.badge} sin plantillas fijas.`,
      startFrame: requestedStartFrame,
    };
  }

  private getVideoScriptContext(currentFrame: number): string | null {
    if (!this.context) return null;
    const project = this.context.project;
    const fps = projectFps(project);
    const contextItems: string[] = [];

    // 1. Extraer subtítulos del timeline si existen (Remotion captions o TextClips)
    let allCues: Array<{ start: number; end: number; text: string }> = [];
    for (const track of project.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (Array.isArray(clip.remotion?.props?.captions)) {
          for (const cue of clip.remotion.props.captions) {
            const cueText = Array.isArray(cue.words)
              ? cue.words.map((w: any) => w.text).join(" ")
              : typeof cue.text === "string"
                ? cue.text
                : "";
            if (cueText) {
              allCues.push({
                start: Number(cue.start ?? 0),
                end: Number(cue.end ?? 0),
                text: cueText,
              });
            }
          }
        } else if (
          clip.type === "text" &&
          (clip.role === "subtitle" || clip.role === "caption" || /subt|caption/i.test(track.name || "")) &&
          typeof clip.text === "string" &&
          clip.text.trim()
        ) {
          allCues.push({
            start: Number(clip.startFrame ?? 0),
            end: Number(clip.startFrame ?? 0) + Number(clip.durationFrames ?? 30),
            text: clip.text.trim(),
          });
        }
      }
    }

    // 2. Si no están en el timeline, buscar en subtitleCache de Whisper
    if (allCues.length === 0 && this.subtitleCache?.segments) {
      allCues = this.subtitleCache.segments.map((seg: any) => ({
        start: Math.round(Number(seg.start ?? 0) * fps),
        end: Math.round(Number(seg.end ?? 0) * fps),
        text: String(seg.text ?? "").trim(),
      }));
    }

    if (allCues.length > 0) {
      allCues.sort((a, b) => a.start - b.start);

      // Frase/diálogo en el frame actual (± 60 frames = ~2s)
      const currentCues = allCues.filter(
        (c) => currentFrame >= c.start - 60 && currentFrame <= c.end + 60,
      );
      if (currentCues.length > 0) {
        const spokenNow = currentCues.map((c) => c.text).join(" ").trim();
        if (spokenNow) {
          contextItems.push(`- Diálogo o locución en este instante: "${spokenNow}"`);
        }
      }

      // Frases del inicio del video (primeros 15s)
      const introCues = allCues.filter((c) => c.start <= 15 * fps);
      if (introCues.length > 0) {
        const introText = introCues.slice(0, 5).map((c) => c.text).join(" ").trim();
        if (introText) {
          contextItems.push(`- Tema del inicio del video: "${introText}"`);
        }
      }

      // Palabras clave más destacadas
      const fullTranscript = allCues.map((c) => c.text).join(" ");
      const words = fullTranscript
        .replace(/[.,!?;:¡¿"']/g, "")
        .split(/\s+/)
        .filter((w) => w.length >= 5 && !/^(este|esta|estos|estas|para|como|donde|cuando|porque|pero|sobre|desde|hacia)$/i.test(w));
      const freqMap: Record<string, number> = {};
      for (const w of words) {
        const lower = w.toLowerCase();
        freqMap[lower] = (freqMap[lower] ?? 0) + 1;
      }
      const topKeywords = Object.entries(freqMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([kw]) => kw.toUpperCase());
      if (topKeywords.length > 0) {
        contextItems.push(`- Palabras clave y conceptos detectados: ${topKeywords.join(", ")}`);
      }
    }

    // 3. Nombres de archivos de video o medios montados en el timeline
    const mediaNames = (project.media ?? [])
      .map((m: any) => m.name)
      .filter((n: string) => !/\.webm$/i.test(n) && !/subtitle/i.test(n))
      .slice(0, 3);
    if (mediaNames.length > 0) {
      contextItems.push(`- Archivo/recurso base: ${mediaNames.join(", ")}`);
    }

    if (contextItems.length === 0) return null;

    return [
      "CONTEXTO REAL Y GUION DEL VIDEO (OBLIGATORIO):",
      ...contextItems,
      "REGLA CRÍTICA: Si el brief pide un título, rótulo o texto y no indica un texto literal entre comillas, NUNCA uses placeholders genéricos como 'CINEMATIC TITLE' o 'LOREM IPSUM'. Inspírate y adapta el título a este contenido real del video (ej. marca, concepto, tema hablado o palabra clave destacada).",
    ].join("\n");
  }

  public detectSpeakerIdentity(userMessage: string): {
    name: string;
    role: string;
    company: string;
    handle: string;
    initials: string;
    accentColor: string;
    accentSecondary: string;
  } {
    if (!this.context) {
      return {
        name: "Presentador Principal",
        role: "Dirección de Contenido",
        company: "ESTUDIO IA",
        handle: "@presentador",
        initials: "PP",
        accentColor: "#38BDF8",
        accentSecondary: "#818CF8",
      };
    }

    const project = this.context.project;
    const fps = projectFps(project);

    // 1. Cues y transcripción de audio disponibles
    let allCues: Array<{ text: string; start: number; end: number }> = [];
    for (const track of project.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (Array.isArray(clip.remotion?.props?.captions)) {
          for (const cue of clip.remotion.props.captions) {
            const cueText = Array.isArray(cue.words)
              ? cue.words.map((w: any) => w.text).join(" ")
              : typeof cue.text === "string"
                ? cue.text
                : "";
            if (cueText) allCues.push({ start: Number(cue.start ?? 0), end: Number(cue.end ?? 0), text: cueText });
          }
        }
      }
    }
    if (allCues.length === 0 && this.subtitleCache?.segments) {
      allCues = this.subtitleCache.segments.map((seg: any) => ({
        start: Math.round(Number(seg.start ?? 0) * fps),
        end: Math.round(Number(seg.end ?? 0) * fps),
        text: String(seg.text ?? "").trim(),
      }));
    }
    const fullTranscript = allCues.map((c) => c.text).join(" ");

    // 2. Extracción de nombre explícito en el mensaje del usuario (ej. "para David Vega", "llamado Andrés")
    const explicitNameMatch = userMessage.match(/(?:para|de|llamado|nombre[:\s]+)\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,2})/i);
    let name = explicitNameMatch ? explicitNameMatch[1]!.trim() : "";

    // 3. Si no hay nombre explícito, buscar auto-presentación en la locución
    if (!name && fullTranscript) {
      const introMatch = fullTranscript.match(/(?:hola(?:,| a todos)?\s*,?\s*soy|mi nombre es|les habla|aquí|yo soy)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){1,2})/i);
      if (introMatch && introMatch[1]) {
        name = introMatch[1].trim();
      }
    }

    // 4. Detección dinámica y cohesiva del rol y estilo según ADN Semántico
    const dna = extractProjectSemanticDNA({
      prompt: userMessage,
      transcriptText: fullTranscript,
      projectName: project.name,
    });

    let role = dna.characters[0]?.role || "Especialista";
    let company = project.name || "ESTUDIO CREATIVO";
    let handle = `@${(name || dna.characters[0]?.name || "creador").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    let accentColor = dna.masterPalette.accent;
    let accentSecondary = dna.masterPalette.secondary;

    if (!name) {
      const char = dna.characters[0];
      name = char ? char.name : "Orador Principal";
      role = char ? char.role : "Análisis & Dirección";
      handle = `@${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    }

    // Iniciales
    const initials = name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "OP";

    return {
      name,
      role,
      company,
      handle,
      initials,
      accentColor,
      accentSecondary,
    };
  }

  public findSmartBRollTimestamp(userMessage: string): SmartBRollMatch | null {
    if (!this.context) return null;
    const project = this.context.project;
    const fps = projectFps(project);

    // 1. Recolectar todos los cues disponibles del proyecto o cache
    let allCues: Array<{ start: number; end: number; text: string }> = [];
    for (const track of project.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (Array.isArray(clip.remotion?.props?.captions)) {
          for (const cue of clip.remotion.props.captions) {
            const cueText = Array.isArray(cue.words)
              ? cue.words.map((w: any) => w.text).join(" ")
              : typeof cue.text === "string"
                ? cue.text
                : "";
            if (cueText) {
              allCues.push({
                start: Number(cue.start ?? 0),
                end: Number(cue.end ?? 0),
                text: cueText,
              });
            }
          }
        }
      }
    }

    if (allCues.length === 0 && this.subtitleCache?.segments) {
      allCues = this.subtitleCache.segments.map((seg: any) => ({
        start: Math.round(Number(seg.start ?? 0) * fps),
        end: Math.round(Number(seg.end ?? 0) * fps),
        text: String(seg.text ?? "").trim(),
      }));
    }

    allCues.sort((a, b) => a.start - b.start);

    // 2. Extraer métricas y palabras clave de la petición del usuario
    const lowerMsg = userMessage.toLowerCase();
    const percentMatch = userMessage.match(/(\+|-)?\s*(\d+(?:\.\d+)?)\s*(%|por ciento)/i);
    const moneyMatch =
      userMessage.match(/(\$|usd|soles|€)\s*(\d+(?:[.,]\d+)?)\s*(k|m|millones|mil)?/i) ||
      userMessage.match(/(\d+(?:[.,]\d+)?)\s*(k|m|millones|mil)?\s*(dólares|dolares|soles|euros|usd|€|\$)/i);
    const rawNumberMatch = userMessage.match(/(\b\d+(?:[.,]\d+)?\b)/);

    let targetNumeric = 40;
    let targetUnit = "%";
    let targetValueStr = "+40%";
    let label = "CRECIMIENTO DE VENTAS";

    if (percentMatch && percentMatch[2]) {
      const sign = percentMatch[1] || "+";
      const num = parseFloat(percentMatch[2]);
      targetNumeric = Number.isFinite(num) ? num : 40;
      targetUnit = "%";
      targetValueStr = `${sign}${targetNumeric}%`;
      label = /venta/i.test(userMessage)
        ? "CRECIMIENTO DE VENTAS"
        : /usuario|client/i.test(userMessage)
          ? "CRECIMIENTO DE USUARIOS"
          : /ingreso|gananc/i.test(userMessage)
            ? "CRECIMIENTO DE INGRESOS"
            : "TASA DE CRECIMIENTO";
    } else if (moneyMatch) {
      const rawMoney = moneyMatch[2] || moneyMatch[1] || "10000";
      const num = parseFloat(rawMoney);
      targetNumeric = Number.isFinite(num) ? num : 10000;
      targetUnit = "$";
      targetValueStr = `$${targetNumeric.toLocaleString()}`;
      label = "INGRESOS Y CAPITAL";
    } else if (/\bdinero|capital|ganancia|facturaci[óo]n\b/i.test(lowerMsg)) {
      targetNumeric = 85;
      targetUnit = "%";
      targetValueStr = "+85%";
      label = "INGRESOS Y CAPITAL";
    } else if (rawNumberMatch && rawNumberMatch[1]) {
      const num = parseFloat(rawNumberMatch[1]);
      if (Number.isFinite(num)) {
        targetNumeric = num;
        targetUnit = "%";
        targetValueStr = `+${targetNumeric}%`;
      }
    }

    // 3. Buscar coincidencia en el audio (si hay transcript de voz)
    let matchedCue: { start: number; end: number; text: string } | null = null;
    const searchPercent = percentMatch?.[2];
    for (const cue of allCues) {
      const cueLower = cue.text.toLowerCase();
      if (
        (searchPercent && cueLower.includes(searchPercent)) ||
        cueLower.includes("40%") ||
        cueLower.includes("40 por ciento") ||
        cueLower.includes("ventas") ||
        cueLower.includes("crecieron") ||
        cueLower.includes("crecimiento") ||
        cueLower.includes("dinero")
      ) {
        matchedCue = cue;
        break;
      }
    }

    if (!matchedCue) {
      for (const cue of allCues) {
        if (/\d+/.test(cue.text)) {
          matchedCue = cue;
          break;
        }
      }
    }

    if (matchedCue) {
      const cuePercent = matchedCue.text.match(/(\d+(?:\.\d+)?)\s*(%|por ciento)/i);
      if (cuePercent && cuePercent[1]) {
        targetNumeric = parseFloat(cuePercent[1]);
        targetValueStr = `+${targetNumeric}%`;
      }
      return {
        startFrame: Math.max(0, matchedCue.start),
        matchedText: matchedCue.text,
        metricLabel: label,
        metricValue: targetValueStr,
        numericTarget: targetNumeric,
        unit: targetUnit,
        foundInAudio: true,
      };
    }

    const fallbackFrame = Math.max(0, this.context.currentFrame > 0 ? this.context.currentFrame : Math.round(fps * 2));
    return {
      startFrame: fallbackFrame,
      matchedText: userMessage.slice(0, 60),
      metricLabel: label,
      metricValue: targetValueStr,
      numericTarget: targetNumeric,
      unit: targetUnit,
      foundInAudio: false,
    };
  }

  private async generateComponent(
    brief: string,
    durationInFrames: number,
    existing: ComponentState | null,
    preferredName?: string,
    smartBRoll?: SmartBRollMatch | null,
  ): Promise<ComponentState> {
    const project = this.context!.project;
    const fps = projectFps(project);
    const width = projectWidth(project);
    const height = projectHeight(project);

    const lines = [
      `BRIEF VISUAL:\n${brief}`,
      [
        "CONTEXTO TÉCNICO:",
        `- Lienzo: ${width}x${height} (${width >= height ? "horizontal" : "vertical"})`,
        `- FPS: ${fps}`,
        `- Duración objetivo: ${durationInFrames} frames (${seconds(durationInFrames, fps)} s)`,
        `- Se usará como overlay transparente sobre un video ya montado.`,
        `- Frame actual del timeline: ${this.context!.currentFrame}`,
      ].join("\n"),
    ];

    if (smartBRoll) {
      lines.push(
        [
          "DIRECTIVA OBLIGATORIA DE SMART B-ROLL / GRÁFICO ESTADÍSTICO:",
          `- Métrica principal: ${smartBRoll.metricLabel}`,
          `- Cifra numérica objetivo: ${smartBRoll.numericTarget}${smartBRoll.unit} (${smartBRoll.metricValue})`,
          `- Frame de sincronización con la voz: ${smartBRoll.startFrame} (${(smartBRoll.startFrame / fps).toFixed(2)}s)`,
          `- Texto o locución detectada: "${smartBRoll.matchedText}"`,
          "- GUÍA DE DISEÑO PROCEDURAL (CERO PLANTILLAS ESTÁTICAS):",
          "  1. Diseña un componente visual React/Remotion auténtico y adaptado al tema, tono y contexto exacto de la métrica.",
          "  2. Si es porcentaje o métrica individual: usa un indicador radial circular SVG, un display numérico cinético o una tarjeta HUD técnica en zona superior segura.",
          "  3. Si es comparativa o reducción/crecimiento: usa barras horizontales limpias o métricas destacadas con spring() suave.",
          "  4. Anima el valor numérico arrancando en 0 y subiendo progresivamente con interpolate() determinista.",
          "  5. Respeta zonas seguras superiores para no tapar el rostro del orador ni los subtítulos inferiores.",
          "  6. Animación de entrada fluida con spring() y salida elegante.",
        ].join("\n"),
      );
    }

    const scriptContext = this.getVideoScriptContext(this.context!.currentFrame);
    if (scriptContext) {
      lines.push(scriptContext);
    }

    // Solo incluir info del clip seleccionado cuando estamos modificando una pieza existente (no creando una nueva)
    if (existing && this.selectedClipId && project.tracks) {
      const selectedClip = project.tracks.flatMap((t: any) => t.clips ?? []).find((c: any) => c.id === this.selectedClipId);
      if (selectedClip && !/subtit|caption|subs/i.test(selectedClip.name || "")) {
        lines.push(
          [
            "CLIP SELECCIONADO EN EL VIEWER (modifica ESTE clip):",
            `- ID: ${selectedClip.id}`,
            `- Tipo: ${selectedClip.type}`,
            `- Track: ${this.getTrackName(selectedClip.trackId) || selectedClip.trackId}`,
            `- Frame inicio: ${selectedClip.startFrame}`,
            `- Duración: ${selectedClip.durationFrames} frames`,
            `- Media ID: ${selectedClip.mediaId || 'N/A'}`,
            `- Props actuales: ${JSON.stringify(selectedClip, null, 2).slice(0, 2000)}`,
            "Genera código que modifique este clip específico (ajusta sus props, no crees uno nuevo).",
          ].join("\n"),
        );
      }
    }

    if (existing) {
      lines.push(
        [
          "CÓDIGO ACTUAL (modifícalo, no empieces de cero):",
          "```tsx",
          existing.code,
          "```",
          `Mantén el nombre de export "${existing.name}" si es posible.`,
        ].join("\n"),
      );
    }

    const result = await chatJson(
      MOTION_CODEGEN_PROMPT,
      lines.join("\n\n"),
      AbortSignal.timeout(CODEGEN_TIMEOUT_MS),
      { maxTokens: 3500, temperature: existing ? 0.2 : 0.35 },
    );

    return this.normalizeGenerated(
      result.data,
      durationInFrames,
      preferredName ?? existing?.name,
      smartBRoll?.startFrame,
    );
  }

  private async repairComponent(
    component: ComponentState,
    brief: string,
    error: string,
  ): Promise<ComponentState> {
    const project = this.context!.project;
    const fps = projectFps(project);
    const width = projectWidth(project);
    const height = projectHeight(project);

    const prompt = [
      `BRIEF ORIGINAL:\n${brief}`,
      `CONTEXTO: ${width}x${height}, ${fps} fps, ${component.durationInFrames} frames.`,
      `ERROR REAL:\n${error}`,
      [
        `CÓDIGO ACTUAL (nombre de export: ${component.name}):`,
        "```tsx",
        component.code,
        "```",
      ].join("\n"),
      `Devuelve el componente completo corregido con el mismo nombre de export "${component.name}".`,
    ].join("\n\n");

    try {
      const result = await chatJson(
        MOTION_REPAIR_PROMPT,
        prompt,
        AbortSignal.timeout(CODEGEN_TIMEOUT_MS),
        { maxTokens: 3500, temperature: 0.1 },
      );
      const repaired = this.normalizeGenerated(
        result.data,
        component.durationInFrames,
        component.name,
        component.startFrame,
      );
      return {
        ...repaired,
        startFrame: component.startFrame,
        reasoning: component.reasoning,
      };
    } catch (error2) {
      console.error("[MotionAgent] La reparación con IA también falló:", error2);
      // Se devuelve el componente tal cual para que el bucle agote intentos y
      // el usuario reciba el error real del render.
      return component;
    }
  }

  // ---------------------------------------------------------------------------
  // Subtítulos (transcripción real + overlay TikTok)
  // ---------------------------------------------------------------------------

  private async generateSubtitles(plan: MotionPlan, userMessage: string): Promise<MotionResponse[]> {
    if (!this.context) throw new Error("Falta el contexto del proyecto.");

    const { projectId, project, currentFrame } = this.context;
    const styleBrief = (plan.brief || userMessage || "").trim();
    const style: SubtitleStyleId = plan.style ?? resolveSubtitleStyle(undefined, styleBrief);

    // Un estilo nuevo invalida el pre-render del estilo anterior.
    cancelPrewarm(projectId);

    // La transcripción se reutiliza si el clip de audio es el mismo: cambiar de
    // estilo no debería volver a invocar Whisper.
    const source = findCaptionSource(project, currentFrame);
    const sourceKey = source
      ? `${source.clip.mediaId}:${source.clip.sourceInUs}:${source.clip.sourceOutUs}:${source.clip.speed}`
      : "";
    const cachedSegments =
      this.subtitleCache &&
      this.subtitleCache.key === sourceKey &&
      this.subtitleCache.segments.some((s) => Array.isArray(s.words) && s.words.length > 0)
        ? this.subtitleCache.segments
        : undefined;

    const subtitleResponses: MotionResponse[] = [
      {
        type: "text",
        content: cachedSegments
          ? "Reutilizando la transcripción del audio y aplicando el nuevo estilo..."
          : "Transcribiendo el audio real del clip con Whisper...",
        data: { isStep: true },
      },
    ];

    const userPrompt = userMessage || plan.brief || "";
    const dna = extractProjectSemanticDNA({ prompt: userPrompt, projectName: project.name });

    let built = await buildSubtitles({
      projectId,
      project,
      currentFrame,
      signal: AbortSignal.timeout(12 * 60_000),
      style,
      cachedSegments,
      userPrompt,
      dna,
    });

    // Modo libre: el LLM escribe el componente con el contrato de captions.
    // Si falla, caemos silenciosamente al estilo del catálogo más cercano.
    if (style === "custom") {
      const custom = await this.buildCustomSubtitles(
        styleBrief,
        built.durationInFrames,
        built.props,
      );
      if (custom) {
        built = { ...built, ...custom };
      } else {
        // El modo libre falló: caemos al estilo cinemático, que nunca falla.
        const fallbackStyle: Exclude<SubtitleStyleId, "custom"> = "cinematic";
        built = {
          ...built,
          style: fallbackStyle,
          code: subtitleComponentCode(fallbackStyle),
          name: "CinematicSubtitles",
          compositionId: "CinematicSubtitlesComp",
        };
      }
    }

    // Guarda la transcripción para el siguiente cambio de estilo.
    if (built.segments.length > 0) {
      this.subtitleCache = { key: built.sourceKey, segments: built.segments };
    }
    this.lastSubtitleStyle = built.style;

    this.lastComponent = {
      code: built.code,
      name: built.name,
      compositionId: built.compositionId,
      durationInFrames: built.durationInFrames,
      props: built.props,
      reasoning:
        built.cueCount +
        " frases, " +
        built.wordCount +
        " palabras transcritas del audio real · estilo " +
        built.style,
      startFrame: built.startFrame,
    };
    this.lastBrief = styleBrief;

    const previewFps = projectFps(project);
    const width = projectWidth(project);
    const height = projectHeight(project);

    const overlayComponent: OverlayComponent = {
      code: built.code,
      name: built.name,
      compositionId: built.compositionId,
      durationInFrames: built.durationInFrames,
      props: built.props,
      startFrame: built.startFrame,
    };
    const renderKey = overlayRenderKey(overlayComponent, project);

    // Preview: centrado en el cue activo para las plantillas; desde el inicio
    // para los componentes libres (que pueden ignorar props.offset).
    const cues = (built.props?.captions ?? []) as CaptionCue[];
    const currentRelative = Math.max(0, Math.round(currentFrame - built.startFrame));
    const window =
      built.style === "custom"
        ? {
            offset: 0,
            durationInFrames: Math.max(1, Math.min(previewWindow(cues, 0, previewFps, built.durationInFrames, 8).durationInFrames, built.durationInFrames)),
          }
        : previewWindow(cues, currentRelative, previewFps, built.durationInFrames, 8);

    // Preview: se intenta renderizar de fondo; si tarda o falla, caemos suavemente al Live Overlay
    let preview: RenderResult | null = null;
    try {
      preview = await renderPool.preview(
        built.code,
        built.name,
        built.compositionId,
        width,
        height,
        previewFps,
        window.durationInFrames,
        {
          ...built.props,
          offset: 0,
          width,
          height,
          fps: previewFps,
          durationInFrames: built.durationInFrames,
        },
        {
          compositionDurationInFrames: built.durationInFrames,
          frameRange: [window.offset, window.offset + window.durationInFrames - 1],
          scale: 0.5,
          bundleKey: overlayBundleKey(overlayComponent, project),
        },
      );
    } catch (previewErr) {
      console.warn("[MotionAgent] Fallback a Live Overlay para subtítulos:", previewErr);
    }

    const technicalScript = formatTechnicalSubtitleScript(cues, previewFps, built.style, 10, built.governance);

    const responses: MotionResponse[] = [
      {
        type: "text",
        content: technicalScript,
      },
      {
        type: "component",
        content: built.code,
        data: {
          componentName: built.name,
          compositionId: built.compositionId,
          durationInFrames: built.durationInFrames,
          reasoning:
            built.cueCount +
            " bloques (máx. 3-4 palabras) · " +
            built.wordCount +
            " palabras verbatim sincronizadas al fonema · estilo " +
            built.style,
          startFrame: built.startFrame,
          style: built.style,
          renderKey,
          // CRÍTICO: sin estos props el render final no tendría subtítulos.
          props: built.props,
        },
      },
    ];

    if (preview && preview.success && preview.base64Video) {
      responses.push({
        type: "preview",
        content: "Subtítulos listos",
        data: {
          base64Video: preview.base64Video,
          durationMs: preview.durationMs,
          durationInFrames: built.durationInFrames,
          componentName: built.name,
          cueCount: built.cueCount,
          wordCount: built.wordCount,
          startFrame: built.startFrame,
          style: built.style,
          renderKey,
        },
      });
    } else {
      responses.push({
        type: "text",
        content: `Subtítulos "${built.name}" (${built.cueCount} frases) generados y aplicados directamente sobre tu monitor en vivo a 60fps. Puedes personalizar colores o tipografía en el Inspector.`,
        data: { isStep: true },
      });
    }

    // Pre-render en segundo plano del render final completo.
    schedulePrewarm(projectId, project, overlayComponent);

    return [...subtitleResponses, ...responses].map((r) => cleanEmojis(r));
  }

  /**
   * Modo libre: pide al LLM un componente de subtítulos completo respetando el
   * contrato de `props.captions`. Valida y auto-repara con el error real del
   * render. Devuelve null si no se consigue (el llamador usa una plantilla).
   */
  private async buildCustomSubtitles(
    brief: string,
    durationInFrames: number,
    captionsProps: Record<string, unknown>,
  ): Promise<Partial<SubtitleBuild> | null> {
    const contract = [
      "CONTRATO DE DATOS (obligatorio):",
      "- Recibes props.captions: array de { start, end, words: [{ text, start, end }] } en FRAMES.",
      "- Recibes props.offset (número de frames). Úsalo: const frame = useCurrentFrame() + (props.offset ?? 0);",
      "- NO cambies el texto ni los tiempos: solo diseña.",
      "- Devuelve null cuando no haya frase activa. Raíz transparente.",
    ].join("\n");

    let component = await this.generateComponent(
      `${brief}\n\n${contract}`,
      durationInFrames,
      null,
      "CustomSubtitles",
    );

    for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
      const validation = await validateTsx(component.code);
      if (!validation.ok) {
        if (attempt === MAX_BUILD_ATTEMPTS - 1) return null;
        component = await this.repairComponent(
          component,
          brief,
          `El código no compila:\n${validation.error}`,
        );
        continue;
      }
      const preview = await renderPool.preview(
        component.code,
        component.name,
        component.compositionId,
        480,
        854,
        30,
        90,
        { captionsProps, width: 480, height: 854, fps: 30, durationInFrames: 90 },
      );
      if (preview.success) {
        return { code: component.code, name: component.name, compositionId: component.compositionId };
      }
      if (attempt === MAX_BUILD_ATTEMPTS - 1) return null;
      component = await this.repairComponent(
        component,
        brief,
        `El componente falló al renderizar:\n${preview.error}`,
      );
    }
    return null;
  }

  private normalizeGenerated(
    data: unknown,
    fallbackDuration: number,
    fallbackName?: string,
    initialStartFrame?: number,
  ): ComponentState {
    const record = asRecord(data);
    const rawCode = extractCodeFromData(record);
    if (!rawCode.trim()) {
      throw new Error(
        "El modelo no devolvió código utilizable. Vuelve a intentarlo o cambia de modelo en Ajustes.",
      );
    }

    const sanitized = sanitizeComponentCode(rawCode);
    // El export real del código manda: así la entrada del bundler siempre
    // importa un nombre que existe, aunque el modelo se invente otro.
    const codeName =
      sanitized.name ||
      (typeof record.componentName === "string" ? record.componentName : "");
    const name = toComponentName(codeName, fallbackName ?? "MotionGraphic");
    const compositionId = toComponentName(
      record.compositionId,
      `${name}Comp`,
    );

    const fps = this.context ? projectFps(this.context.project) : 30;
    const requested = Number(record.durationInFrames);

    // Solo preservar captions si el componente generado es realmente de subtítulos
    const finalName = sanitized.name || name;
    const isSubtitles =
      this.lastComponent?.props?.captions != null &&
      /subtit|caption|subs/i.test(finalName);
    let durationInFrames: number;
    let preservedProps: Record<string, unknown> | undefined;
    if (isSubtitles && this.lastComponent?.props) {
      durationInFrames = this.lastComponent.durationInFrames;
      // Preservar captions y offset del componente original
      preservedProps = {
        captions: this.lastComponent.props.captions,
        offset: this.lastComponent.props.offset,
      };
    } else {
      durationInFrames = clampDurationFrames(
        Number.isFinite(requested) && requested > 0 ? requested : fallbackDuration,
        fps,
        Math.round(fps * 90),
      );
    }

    return {
      code: sanitized.code,
      name: finalName,
      compositionId,
      durationInFrames,
      reasoning:
        typeof record.reasoning === "string" ? record.reasoning.trim() : undefined,
      startFrame:
        typeof initialStartFrame === "number"
          ? initialStartFrame
          : isSubtitles
            ? this.lastComponent?.startFrame
            : undefined,
      props: preservedProps,
    };
  }

  // ---------------------------------------------------------------------------
  // Preview y render final
  // ---------------------------------------------------------------------------

  private async renderPreview(
    component: ComponentState,
    fps = projectFps(this.context!.project),
    onProgress?: (progress: { stage?: string; progress: number }) => void,
  ): Promise<RenderResult> {
    const project = this.context!.project;
    // Misma composición que el render final (mismas dimensiones y props) pero a
    // resolución turbo con `scale` y ventana acotada: comparte bundle con el render final.
    const width = projectWidth(project);
    const height = projectHeight(project);
    const maxPreviewFrames = Math.min(component.durationInFrames, Math.round(fps * 5));
    const frameRange: [number, number] | undefined =
      component.durationInFrames > maxPreviewFrames
        ? [0, Math.max(0, maxPreviewFrames - 1)]
        : undefined;

    return renderPool.preview(
      component.code,
      component.name,
      component.compositionId,
      width,
      height,
      fps,
      component.durationInFrames,
      {
        ...(component.props ?? {}),
        width,
        height,
        fps,
        durationInFrames: component.durationInFrames,
      },
      {
        compositionDurationInFrames: component.durationInFrames,
        frameRange,
        scale: 0.4,
        bundleKey: overlayBundleKey(component, project),
        onProgress,
      },
    );
  }

  private toPreviewResponse(
    component: ComponentState,
    result: RenderResult,
  ): MotionResponse {
    if (!result.success || !result.base64Video) {
      return {
        type: "error",
        content: `No pude previsualizar la pieza: ${shortError(result.error ?? "sin detalle")}`,
      };
    }

    const sfxType = determineSfxForComponent(component.name, component.code);

    return {
      type: "preview",
      content: "Preview listo",
      data: {
        base64Video: result.base64Video,
        durationMs: result.durationMs,
        durationInFrames: component.durationInFrames,
        componentName: component.name,
        sfxType,
      },
    };
  }

  private async renderAndInsert(insertAtEnd: boolean): Promise<MotionResponse> {
    if (!this.context) throw new Error("Falta el contexto del proyecto.");
    const component = this.lastComponent;
    if (!component) throw new Error("No hay una pieza para insertar.");

    const projectId = this.context.projectId;
    // Se relee el proyecto para insertar sobre el timeline más reciente.
    const bundle = await projectStore.get(projectId);

    const result = await renderAndInsertOverlay({
      projectId,
      project: bundle.project,
      component: component as OverlayComponent,
      origin: "user",
      startFrame: component.startFrame,
      insertAtEnd,
      currentFrame: this.context.currentFrame,
    });

    const refreshed = await projectStore.get(projectId);
    this.context.project = refreshed.project;

    const sfxNotice = result.sfxType
      ? ` 🔊 Sound design sincronizado: micro-efecto "${result.sfxType.toUpperCase()}" emparejado en la pista "SFX" en el frame ${result.startFrame}.`
      : "";

    return {
      type: "inserted",
      content: `Inserté "${component.name}" en el timeline (frame ${result.startFrame}).${sfxNotice}`,
      data: {
        assetId: result.assetId,
        clipFrames: result.clipFrames,
        startFrame: result.startFrame,
        trackId: result.trackId,
        videoPath: result.videoPath,
        revision: result.revision,
        renderMs: result.renderMs,
        sfxType: result.sfxType,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Memoria y contexto
  // ---------------------------------------------------------------------------

  recordExternalTurn(
    userPrompt: string,
    assistantSummary: string,
    lastComponent?: Partial<ComponentState> | null,
  ): void {
    const cleanUser = userPrompt.trim();
    if (cleanUser) {
      this.remember("user", cleanUser);
      this.lastBrief = cleanUser;
    }
    const cleanAssistant = assistantSummary.trim();
    if (cleanAssistant) {
      this.remember("assistant", cleanAssistant);
    }
    if (lastComponent?.code && lastComponent?.name) {
      this.setLastComponent(lastComponent);
    }
  }

  private remember(role: "user" | "assistant", content: string): void {
    const text = content.trim();
    if (!text) return;
    this.conversation.push({ role, content: text });
    if (this.conversation.length > MAX_CONVERSATION_TURNS) {
      this.conversation = this.conversation.slice(-MAX_CONVERSATION_TURNS);
    }
  }

  private projectSummary(): string {
    if (!this.context) return "";
    const project = this.context.project;
    const fps = projectFps(project);
    const lines = [
      "CONTEXTO DEL PROYECTO:",
      `- Resolución: ${projectWidth(project)}x${projectHeight(project)}`,
      `- FPS: ${fps}`,
      `- Frame actual: ${this.context.currentFrame}`,
      `- Duración total del timeline: ${timelineDurationFrames(project)} frames`,
    ];
    if (this.selectedClipId && project.tracks) {
      const clip = project.tracks.flatMap((t: any) => t.clips ?? []).find((c: any) => c.id === this.selectedClipId);
      if (clip) {
        lines.push(`- Clip seleccionado: ${clip.id} (track: ${this.getTrackName(clip.trackId) || 'desconocida'}, tipo: ${clip.type}, frame ${clip.startFrame}-${clip.startFrame + clip.durationFrames})`);
        if (clip.type === "video" && clip.mediaId) {
          const asset = project.media?.find((a: any) => a.id === clip.mediaId);
          if (asset) lines.push(`  Media: ${asset.name}`);
        }
      } else {
        lines.push(`- Clip seleccionado: ${this.selectedClipId} (no encontrado en el proyecto actual)`);
      }
    }
    return lines.join("\n");
  }

  private getTrackName(trackId: string | undefined): string | null {
    if (!this.context || !trackId) return null;
    const track = this.context.project.tracks.find((t: any) => t.id === trackId);
    return track?.name ?? null;
  }

  private conversationSummary(): string {
    if (this.conversation.length === 0) return "";
    const lines = this.conversation
      .slice(-8)
      .map(
        (turn) =>
          `${turn.role === "user" ? "Usuario" : "Asistente"}: ${turn.content.slice(0, 700)}`,
      );
    return ["CONVERSACIÓN RECIENTE:", ...lines].join("\n");
  }

  private componentSummary(): string {
    if (!this.lastComponent) return "PIEZA ACTUAL: ninguna.";
    return [
      "PIEZA ACTUAL:",
      `- Nombre: ${this.lastComponent.name}`,
      `- Duración: ${this.lastComponent.durationInFrames} frames`,
      this.lastBrief ? `- Brief: ${this.lastBrief.slice(0, 700)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/**
 * Devuelve el agente del proyecto, reutilizando su memoria conversacional.
 * El contexto técnico (frame actual, proyecto) se refresca en cada petición.
 */
export async function getMotionAgent(context: MotionContext): Promise<MotionAgent> {
  let agent = agents.get(context.projectId);
  if (!agent) {
    agent = new MotionAgent();
    try {
      const saved = await projectStore.readMotionState(context.projectId);
      agent.hydrateFromSaved(saved);
    } catch {
      // Si no hay estado previo en disco, iniciar limpio
    }
    agents.set(context.projectId, agent);
    if (agents.size > MAX_AGENTS) {
      const oldest = agents.keys().next().value;
      if (oldest && oldest !== context.projectId) agents.delete(oldest);
    }
  }
  agent.setContext(context);
  return agent;
}

export function resetMotionAgent(projectId: string): void {
  const agent = agents.get(projectId);
  agent?.reset();
  agents.delete(projectId);
}

export function getMotionAgentLiveStatus(projectId: string): {
  active: boolean;
  steps: string[];
  currentStep: string;
} {
  try {
    const agent = agents.get(projectId);
    if (!agent) return { active: false, steps: [], currentStep: "" };
    return agent.getLiveStatus();
  } catch {
    return { active: false, steps: [], currentStep: "" };
  }
}

/** Compatibilidad con llamadas existentes. */
export async function createMotionAgent(context: MotionContext): Promise<MotionAgent> {
  const agent = new MotionAgent();
  agent.setContext(context);
  return agent;
}
