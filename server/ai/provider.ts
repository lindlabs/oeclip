import fs from "node:fs/promises";
import path from "node:path";
import type { MediaAsset } from "../../src/shared/schema";
import { HttpError, pathExists } from "../util/fs";
import { projectTempDirectory } from "../projects/store";
import { requireMediaFile } from "../media/library";
import { runFfmpeg } from "../media/process";
import { localWhisperAvailable, transcribeLocally, whisperModelId } from "./local-whisper";
import {
  getAiConfig,
  isLocalBaseUrl,
  normalizeBaseUrl,
  presetForBaseUrl,
  publicAiSettings,
  type AiConfig,
} from "./settings";

export interface AiStatus {
  configured: boolean;
  chat: boolean;
  transcribe: boolean;
  provider: "openai-compatible" | "local";
  model: string;
  transcribeModel: string;
  baseUrlHost: string;
  providerId: string;
  keyHint: string | null;
  supportsTranscription: boolean;
  requiresApiKey: boolean;
  source: "file" | "env";
  /** "api" usa el proveedor; "local" usa Whisper en el equipo. */
  transcriptionMode: "api" | "local" | "none";
  localTranscription: { available: boolean; model: string };
}

function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function aiStatus(): AiStatus {
  const cfg = getAiConfig();
  const settings = publicAiSettings();
  const configured = Boolean(cfg.apiKey) || isLocalBaseUrl(cfg.baseUrl);
  const apiTranscription = configured && cfg.supportsTranscription && Boolean(cfg.transcribeModel);
  const localAvailable = localWhisperAvailable();
  return {
    configured,
    chat: configured,
    // Los subtítulos funcionan siempre que haya API de transcripción o Whisper local.
    transcribe: apiTranscription || localAvailable,
    provider: configured ? "openai-compatible" : "local",
    model: cfg.model,
    transcribeModel: apiTranscription ? cfg.transcribeModel : localAvailable ? whisperModelId() : "",
    baseUrlHost: providerHost(cfg.baseUrl),
    providerId: settings.provider,
    keyHint: settings.keyHint,
    supportsTranscription: cfg.supportsTranscription && Boolean(cfg.transcribeModel),
    requiresApiKey: settings.requiresApiKey,
    source: settings.source,
    transcriptionMode: apiTranscription ? "api" : localAvailable ? "local" : "none",
    localTranscription: { available: localAvailable, model: whisperModelId() },
  };
}

function assertConfigured(cfg: AiConfig = getAiConfig()): void {
  if (!cfg.apiKey && !isLocalBaseUrl(cfg.baseUrl)) {
    throw new HttpError(
      503,
      "No hay proveedor de IA configurado. Abre Ajustes → Proveedor de IA, elige un proveedor y pega tu clave. El planificador local sigue disponible.",
      "ai_not_configured",
    );
  }
}

function authHeaders(cfg: AiConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

function safeProviderError(status: number, body: string): HttpError {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      detail?: string;
      message?: string;
    };
    if (typeof parsed.error === "string") detail = parsed.error.slice(0, 500);
    else if (parsed.error?.message) detail = parsed.error.message.slice(0, 500);
    else if (parsed.detail) detail = parsed.detail.slice(0, 500);
    else if (parsed.message) detail = parsed.message.slice(0, 500);
  } catch {
    // cuerpo no JSON
  }
  if (status === 401 || status === 403) {
    return new HttpError(
      502,
      `El proveedor de IA rechazó la clave (HTTP ${status}). Revisa que esté copiada completa y siga activa.`,
      "ai_auth_failed",
    );
  }
  if (status === 404 || /no longer available|model.*not found|not supported for/i.test(detail)) {
    return new HttpError(
      404,
      `El modelo configurado no está disponible (HTTP ${status}): ${detail || "sin detalle"}`,
      "ai_model_not_found",
    );
  }
  if (status === 429) {
    return new HttpError(
      502,
      "El proveedor de IA limitó las peticiones (HTTP 429). Espera unos segundos y vuelve a intentarlo.",
      "ai_rate_limited",
    );
  }
  return new HttpError(
    502,
    `El proveedor de IA respondió con error ${status}: ${detail || "sin detalle"}`,
    "ai_provider_error",
  );
}

function extractCodeStringField(raw: string, field: string): string | null {
  const keyMatch = raw.match(new RegExp(`"${field}"\\s*:\\s*"`));
  if (!keyMatch || keyMatch.index === undefined) return null;
  let i = keyMatch.index + keyMatch[0].length;
  let out = "";
  let escaped = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (escaped) {
      if (ch === "n") out += "\n";
      else if (ch === "r") out += "\r";
      else if (ch === "t") out += "\t";
      else out += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      return out;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out.trim().length > 20 ? out : null;
}

function extractJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // intentar rescate tolerante de campo "code" / TSX
      }
    }
    const rescuedCode = extractCodeStringField(text, "code");
    if (rescuedCode && /from\s+["']remotion["']/.test(rescuedCode)) {
      const name = extractCodeStringField(text, "componentName");
      const compId = extractCodeStringField(text, "compositionId");
      return {
        ...(name ? { componentName: name } : {}),
        ...(compId ? { compositionId: compId } : {}),
        code: rescuedCode,
      };
    }
    const fenceMatch = text.match(/```(?:tsx|typescript|jsx|react)?\s*([\s\S]*?)```/i);
    const tsxCandidate = (fenceMatch?.[1] ?? text).trim();
    if (/from\s+["']remotion["']/.test(tsxCandidate) && /export\s+(?:const|default)/.test(tsxCandidate)) {
      return { code: tsxCandidate };
    }
    throw new HttpError(502, "La respuesta del modelo no es JSON válido.", "ai_invalid_json");
  }
}

export interface ChatResult {
  data: unknown;
  model: string;
}

/**
 * Cortacircuitos granular por (proveedor, modelo): un fallo en un modelo concreto
 * (y nunca un 404 de modelo obsoleto) no bloquea el uso de modelos o proveedores alternativos.
 */
const CHAT_COOLDOWN_MS = 60_000;
const modelCooldownUntil = new Map<string, number>();
const discoveredWorkingModels = new Map<string, { model: string; expiresAt: number }>();

function cooldownKey(baseUrl: string, model: string): string {
  return `${providerHost(baseUrl)}::${model}`;
}

function isModelCoolingDown(baseUrl: string, model: string): boolean {
  const until = modelCooldownUntil.get(cooldownKey(baseUrl, model)) ?? 0;
  if (until <= Date.now()) {
    modelCooldownUntil.delete(cooldownKey(baseUrl, model));
    return false;
  }
  return true;
}

export function aiChatReady(modelOverride?: string): boolean {
  const cfg = getAiConfig();
  const targetModel = modelOverride ?? cfg.model;
  if (!isModelCoolingDown(cfg.baseUrl, targetModel)) return true;
  // Si el modelo activo está en cooldown, pero hay proveedores fallback de entorno configurados, sigue operativo.
  return collectFallbackAiConfigs(cfg).some((fb) => !isModelCoolingDown(fb.baseUrl, fb.model));
}

/** Permite reintentar la IA al cambiar de proveedor o modelo en Ajustes. */
export function resetAiChatCircuit(): void {
  modelCooldownUntil.clear();
  discoveredWorkingModels.clear();
}

function openChatCircuitFor(baseUrl: string, model: string): void {
  modelCooldownUntil.set(cooldownKey(baseUrl, model), Date.now() + CHAT_COOLDOWN_MS);
}

function collectFallbackAiConfigs(primary: AiConfig): AiConfig[] {
  const candidates: AiConfig[] = [];
  const rawJson = process.env.NOVACUT_FALLBACK_AI_CONFIGS?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Array<{
        provider?: string;
        baseUrl?: string;
        apiKey?: string;
        model?: string;
      }>;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.baseUrl && item?.model && item?.apiKey) {
            candidates.push({
              provider: item.provider || "fallback",
              baseUrl: normalizeBaseUrl(item.baseUrl),
              apiKey: item.apiKey.trim(),
              model: item.model.trim(),
              transcribeModel: "",
              supportsTranscription: false,
              timeoutMs: primary.timeoutMs,
            });
          }
        }
      }
    } catch {
      // ignora JSON malformado en env opcional
    }
  }
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (groqKey && providerHost(primary.baseUrl) !== "api.groq.com") {
    candidates.push({
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: groqKey,
      model: "llama-3.3-70b-versatile",
      transcribeModel: "whisper-large-v3-turbo",
      supportsTranscription: true,
      timeoutMs: primary.timeoutMs,
    });
  }
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey && providerHost(primary.baseUrl) !== "api.openai.com") {
    candidates.push({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: openaiKey,
      model: "gpt-4o-mini",
      transcribeModel: "whisper-1",
      supportsTranscription: true,
      timeoutMs: primary.timeoutMs,
    });
  }
  const nvidiaKey = process.env.NVIDIA_API_KEY?.trim();
  if (nvidiaKey && providerHost(primary.baseUrl) !== "integrate.api.nvidia.com") {
    candidates.push({
      provider: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: nvidiaKey,
      model: "meta/llama-3.3-70b-instruct",
      transcribeModel: "",
      supportsTranscription: false,
      timeoutMs: primary.timeoutMs,
    });
  }
  return candidates;
}

function rankFallbackModels(discovered: string[], excludeModel: string, isGemini: boolean): string[] {
  const unique = Array.from(new Set(discovered)).filter(
    (m) => m && m !== excludeModel && m !== "gemini-2.5-flash",
  );
  if (!isGemini) return unique.slice(0, 6);
  const score = (m: string) => {
    const l = m.toLowerCase();
    if (l.includes("3.8") && l.includes("flash")) return 100;
    if (l.includes("3.") && l.includes("flash")) return 90;
    if (l.includes("flash-lite")) return 60;
    if (l.includes("flash")) return 80;
    if (l.includes("pro")) return 70;
    return 10;
  };
  return unique.sort((a, b) => score(b) - score(a)).slice(0, 6);
}

export interface ChatRequestOptions {
  /** Tope de tokens de salida. Los planes y el copy son cortos. */
  maxTokens?: number;
  temperature?: number;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

async function executeSingleProviderChat(
  cfg: AiConfig,
  systemPrompt: string,
  userContent: string | ChatContentPart[],
  signal: AbortSignal,
  chatOptions: ChatRequestOptions,
  isVisionCall: boolean,
): Promise<ChatResult> {
  assertConfigured(cfg);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  const isNvidiaNim = cfg.baseUrl.toLowerCase().includes("integrate.api.nvidia.com");
  const isGemini = cfg.baseUrl.toLowerCase().includes("generativelanguage.googleapis.com") || cfg.provider === "gemini";
  const cacheKey = `${providerHost(cfg.baseUrl)}::${cfg.model}`;
  const cachedDiscovered = discoveredWorkingModels.get(cacheKey);
  const initialModel =
    cachedDiscovered && cachedDiscovered.expiresAt > Date.now()
      ? cachedDiscovered.model
      : isNvidiaNim && cfg.model === "openai/gpt-oss-20b"
        ? "meta/llama-3.3-70b-instruct"
        : cfg.model;

  let attemptedModel = initialModel;

  const request = async (options: {
    jsonMode: boolean;
    tokenParam: "max_tokens" | "max_completion_tokens";
    temperature: boolean;
    modelOverride?: string;
  }) => {
    attemptedModel = options.modelOverride ?? initialModel;
    const body: Record<string, unknown> = {
      model: attemptedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      ...(options.temperature ? { temperature: chatOptions.temperature ?? 0.2 } : {}),
      [options.tokenParam]: chatOptions.maxTokens ?? 2400,
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };
    return fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  };

  try {
    let options: {
      jsonMode: boolean;
      tokenParam: "max_tokens" | "max_completion_tokens";
      temperature: boolean;
      modelOverride?: string;
    } = {
      jsonMode: true,
      tokenParam: "max_tokens",
      temperature: true,
    };
    let response = await request(options);

    // Cascade automático ante 404 (modelo retirado/no disponible) o 429/5xx en proveedores multi-modelo
    if (!response.ok && (response.status === 404 || (isNvidiaNim && !isVisionCall && (response.status === 429 || response.status >= 500)))) {
      const candidateModels: string[] = [];
      if (isNvidiaNim) {
        candidateModels.push(
          "meta/llama-3.3-70b-instruct",
          "qwen/qwen2.5-coder-32b-instruct",
          "openai/gpt-oss-20b",
        );
      } else {
        const listed = await listRemoteModels({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          provider: cfg.provider,
        }).catch(() => ({ ok: false, models: [] as string[] }));
        candidateModels.push(...rankFallbackModels(listed.models, attemptedModel, isGemini));
        if (isGemini) {
          for (const fallback of ["gemini-3.8-flash", "gemini-2.5-pro", "gemini-2.0-flash"]) {
            if (!candidateModels.includes(fallback)) candidateModels.push(fallback);
          }
        }
      }

      const seen = new Set<string>([attemptedModel]);
      for (const fallbackModel of candidateModels) {
        if (!fallbackModel || seen.has(fallbackModel) || isModelCoolingDown(cfg.baseUrl, fallbackModel)) continue;
        seen.add(fallbackModel);
        options = { ...options, modelOverride: fallbackModel };
        response = await request(options);
        if (response.ok) {
          discoveredWorkingModels.set(cacheKey, {
            model: fallbackModel,
            expiresAt: Date.now() + 10 * 60_000,
          });
          break;
        }
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (response.ok) break;
      if (response.status !== 400 && response.status !== 422) break;
      const body = await response.text();
      if (isVisionCall && /image|vision|multimodal|content.*array|unsupported/i.test(body)) {
        throw safeProviderError(response.status, body);
      }
      const next = { ...options };
      let changed = false;
      if (/response_format|json_object|json mode/i.test(body)) {
        next.jsonMode = false;
        changed = true;
      }
      if (/max_completion_tokens|max_tokens|maximum context|unsupported parameter/i.test(body)) {
        next.tokenParam = options.tokenParam === "max_tokens" ? "max_completion_tokens" : "max_tokens";
        changed = true;
      }
      if (/temperature/i.test(body)) {
        next.temperature = false;
        changed = true;
      }
      if (!changed) throw safeProviderError(response.status, body);
      options = next;
      response = await request(options);
    }
    if (!response.ok) throw safeProviderError(response.status, await response.text());
    const readContent = async (res: typeof response): Promise<string> => {
      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      return typeof content === "string" ? content.trim() : "";
    };
    let content = await readContent(response);
    if (!content && options.jsonMode) {
      const plain = await request({ ...options, jsonMode: false });
      if (plain.ok) content = await readContent(plain);
      else await plain.text().catch(() => undefined);
    }
    if (!content) {
      throw new HttpError(
        502,
        "El proveedor de IA no devolvió contenido. Vuelve a intentarlo o cambia de modelo en Ajustes.",
        "ai_empty_response",
      );
    }
    try {
      return { data: extractJson(content), model: attemptedModel };
    } catch (error) {
      if (!options.jsonMode) throw error;
      const plain = await request({ ...options, jsonMode: false });
      if (!plain.ok) throw error;
      const retryContent = await readContent(plain);
      if (!retryContent) throw error;
      return { data: extractJson(retryContent), model: attemptedModel };
    }
  } catch (error) {
    if (error instanceof HttpError) {
      // NUNCA abrir circuit breaker por 404 de modelo obsoleto o JSON inválido.
      if (
        !isVisionCall &&
        (error.code === "ai_rate_limited" ||
          error.code === "ai_provider_error" ||
          error.code === "ai_auth_failed")
      ) {
        openChatCircuitFor(cfg.baseUrl, attemptedModel);
      }
      throw error;
    }
    if (controller.signal.aborted) {
      const callerTimeout = signal.aborted && (signal as AbortSignal & { reason?: { name?: string } }).reason?.name === "TimeoutError";
      if (signal.aborted && !callerTimeout) throw new HttpError(499, "Operación cancelada.", "cancelled");
      if (!isVisionCall) openChatCircuitFor(cfg.baseUrl, attemptedModel);
      throw new HttpError(504, "El proveedor de IA no respondió a tiempo.", "ai_timeout");
    }
    if (!isVisionCall) openChatCircuitFor(cfg.baseUrl, attemptedModel);
    throw new HttpError(
      502,
      `No se pudo contactar con el proveedor de IA (${error instanceof Error ? error.message : String(error)}).`,
      "ai_unreachable",
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function runChatJsonRequest(
  systemPrompt: string,
  userContent: string | ChatContentPart[],
  signal: AbortSignal,
  chatOptions: ChatRequestOptions = {},
  isVisionCall = false,
): Promise<ChatResult> {
  const primary = getAiConfig();
  assertConfigured(primary);

  const chain = [primary, ...collectFallbackAiConfigs(primary)];
  let lastError: unknown;
  for (let i = 0; i < chain.length; i += 1) {
    const candidate = chain[i]!;
    if (i > 0 && isModelCoolingDown(candidate.baseUrl, candidate.model)) continue;
    try {
      return await executeSingleProviderChat(candidate, systemPrompt, userContent, signal, chatOptions, isVisionCall);
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && error.code === "cancelled") throw error;
      if (isVisionCall && error instanceof HttpError && error.statusCode === 400) throw error;
    }
  }
  throw lastError;
}

export async function chatJson(
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  chatOptions: ChatRequestOptions = {},
): Promise<ChatResult> {
  return runChatJsonRequest(systemPrompt, userPrompt, signal, chatOptions, false);
}

/**
 * Envía prompts multimodales (texto + frames JPEG base64 vía image_url) al modelo de visión configurado.
 * No abre el cortacircuitos global si el modelo actual solo soporta texto, permitiendo degradación elegante.
 */
export async function chatVisionJson(
  systemPrompt: string,
  parts: ChatContentPart[],
  signal: AbortSignal,
  chatOptions: ChatRequestOptions = {},
): Promise<ChatResult> {
  return runChatJsonRequest(systemPrompt, parts, signal, chatOptions, true);
}

export interface TranscriptWord {
  text: string;
  startUs: number;
  endUs: number;
}

export interface TranscriptSegment {
  startUs: number;
  endUs: number;
  text: string;
  words?: TranscriptWord[];
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  language: string | null;
  model: string;
}

function assertTranscription(cfg: AiConfig): void {
  assertConfigured(cfg);
  if (!cfg.supportsTranscription || !cfg.transcribeModel) {
    throw new HttpError(
      503,
      "Este proveedor no ofrece transcripción de audio. Configura un modelo de transcripción (OpenAI o Groq) en Ajustes → Proveedor de IA, o deja que OECLIP use Whisper local. El resto de la edición funciona con normalidad.",
      "transcription_unsupported",
    );
  }
}

async function transcribeChunk(
  file: string,
  language: string | undefined,
  signal: AbortSignal,
): Promise<{ segments: TranscriptSegment[]; language: string | null; raw: unknown }> {
  const cfg = getAiConfig();
  assertTranscription(cfg);
  const buffer = await fs.readFile(file);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "audio/mpeg" }), path.basename(file));
  form.append("model", cfg.transcribeModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (language) form.append("language", language);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs * 2);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: authHeaders(cfg),
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw safeProviderError(response.status, await response.text());
    const payload = (await response.json()) as {
      text?: string;
      language?: string;
      words?: Array<{ word?: string; text?: string; start: number; end: number }>;
      segments?: Array<{
        start: number;
        end: number;
        text: string;
        words?: Array<{ word?: string; text?: string; start: number; end: number }>;
      }>;
    };
    const topWords = (payload.words ?? [])
      .map((w) => {
        const startUs = Math.max(0, Math.round(w.start * 1_000_000));
        const endUs = Math.max(startUs + 40_000, Math.round(w.end * 1_000_000));
        return {
          text: (w.word ?? w.text ?? "").trim(),
          startUs,
          endUs,
        };
      })
      .filter((w) => w.text.length > 0);

    const rawSegments = payload.segments ?? [];
    // Si tenemos topWords a nivel de documento, asignamos cada palabra exactamente a un único segmento
    // por proximidad de punto medio para nunca perder ni duplicar palabras en los bordes de segmento.
    const bucketedWords: TranscriptWord[][] = rawSegments.map(() => []);
    if (topWords.length > 0 && rawSegments.length > 0) {
      const segBounds = rawSegments.map((seg) => ({
        startUs: Math.max(0, Math.round(seg.start * 1_000_000)),
        endUs: Math.max(1, Math.round(seg.end * 1_000_000)),
      }));
      let segCursor = 0;
      for (const word of topWords) {
        const mid = (word.startUs + word.endUs) * 0.5;
        while (
          segCursor < segBounds.length - 1 &&
          mid > segBounds[segCursor]!.endUs &&
          Math.abs(mid - segBounds[segCursor + 1]!.startUs) <= Math.abs(mid - segBounds[segCursor]!.endUs)
        ) {
          segCursor += 1;
        }
        bucketedWords[segCursor]!.push(word);
      }
    }

    const segments: TranscriptSegment[] = rawSegments.map((segment, idx) => {
      const rawStartUs = Math.max(0, Math.round(segment.start * 1_000_000));
      const rawEndUs = Math.max(rawStartUs + 60_000, Math.round(segment.end * 1_000_000));
      const segWords =
        Array.isArray(segment.words) && segment.words.length > 0
          ? segment.words
              .map((w) => {
                const wStart = Math.max(0, Math.round(w.start * 1_000_000));
                const wEnd = Math.max(wStart + 40_000, Math.round(w.end * 1_000_000));
                return {
                  text: (w.word ?? w.text ?? "").trim(),
                  startUs: wStart,
                  endUs: wEnd,
                };
              })
              .filter((w) => w.text.length > 0)
          : (bucketedWords[idx] ?? []);
      const startUs = segWords[0]?.startUs ?? rawStartUs;
      const endUs = segWords.at(-1)?.endUs ?? rawEndUs;
      return {
        startUs,
        endUs: Math.max(startUs + 50_000, endUs),
        text: segment.text.trim(),
        ...(segWords.length > 0 ? { words: segWords } : {}),
      };
    });
    if (segments.length === 0 && payload.text?.trim()) {
      segments.push({
        startUs: topWords[0]?.startUs ?? 0,
        endUs: topWords.at(-1)?.endUs ?? 0,
        text: payload.text.trim(),
        ...(topWords.length > 0 ? { words: topWords } : {}),
      });
    }
    return { segments, language: payload.language ?? null, raw: payload };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) {
      if (signal.aborted) throw new HttpError(499, "Transcripción cancelada.", "cancelled");
      throw new HttpError(504, "La transcripción excedió el tiempo máximo.", "ai_timeout");
    }
    throw new HttpError(
      502,
      `Error de transcripción: ${error instanceof Error ? error.message : String(error)}`,
      "transcription_failed",
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function transcribeMedia(
  projectId: string,
  asset: MediaAsset,
  language: string | undefined,
  signal: AbortSignal,
  onProgress?: (progress: number, message?: string) => void,
): Promise<TranscriptResult> {
  const cfg = getAiConfig();
  const file = await requireMediaFile(projectId, asset);
  if (asset.audioCodec === undefined) {
    throw new HttpError(422, "El recurso no tiene pista de audio para transcribir.", "no_audio");
  }

  const apiTranscription =
    cfg.supportsTranscription &&
    Boolean(cfg.transcribeModel) &&
    (Boolean(cfg.apiKey) || isLocalBaseUrl(cfg.baseUrl));
  if (!apiTranscription) {
    if (!localWhisperAvailable()) {
      throw new HttpError(
        503,
        "No hay transcripción disponible. Configura una clave con Whisper (OpenAI o Groq) en Ajustes → Proveedor de IA o instala el motor local con npm install.",
        "transcription_unavailable",
      );
    }
    return transcribeLocally(projectId, file, asset.durationUs, language, signal, onProgress);
  }

  const tempDir = path.join(projectTempDirectory(projectId), "transcribe");
  await fs.mkdir(tempDir, { recursive: true });
  const chunkSeconds = 8 * 60;
  const durationSeconds = Math.max(1, asset.durationUs / 1_000_000);
  const chunks = Math.max(1, Math.ceil(durationSeconds / chunkSeconds));
  const allSegments: TranscriptSegment[] = [];
  let detectedLanguage: string | null = null;
  try {
    for (let index = 0; index < chunks; index += 1) {
      if (signal.aborted) throw new HttpError(499, "Transcripción cancelada.", "cancelled");
      const start = index * chunkSeconds;
      const duration = Math.min(chunkSeconds, durationSeconds - start);
      const chunkFile = path.join(tempDir, `chunk-${index}.mp3`);
      await runFfmpeg(
        [
          "-y",
          "-ss",
          String(start),
          "-t",
          String(duration),
          "-i",
          file,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-b:a",
          "64k",
          chunkFile,
        ],
        { signal, timeoutMs: 10 * 60_000, durationSeconds: duration },
      );
      if (!(await pathExists(chunkFile))) {
        throw new HttpError(500, "No se pudo extraer el audio para transcribir.", "extract_failed");
      }
      onProgress?.(index / chunks, `Transcribiendo fragmento ${index + 1} de ${chunks}`);
      const result = await transcribeChunk(chunkFile, language, signal);
      if (!detectedLanguage && result.language) detectedLanguage = result.language;
      for (const segment of result.segments) {
        const offsetUs = start * 1_000_000;
        allSegments.push({
          startUs: segment.startUs + offsetUs,
          endUs: segment.endUs + offsetUs,
          text: segment.text,
          ...(segment.words
            ? {
                words: segment.words.map((w) => ({
                  text: w.text,
                  startUs: w.startUs + offsetUs,
                  endUs: w.endUs + offsetUs,
                })),
              }
            : {}),
        });
      }
      await fs.rm(chunkFile, { force: true });
      onProgress?.((index + 1) / chunks, `Fragmento ${index + 1} de ${chunks} transcrito`);
    }
    return { segments: allSegments, language: detectedLanguage, model: cfg.transcribeModel };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  baseUrlHost: string;
  jsonMode: boolean;
  models: string[];
  transcription: { available: boolean; model: string; reason: string };
  message: string;
}

export interface AiTestDraft {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  transcribeModel?: string;
}

export async function testAiProvider(draft: AiTestDraft = {}): Promise<AiTestResult> {
  const cfg = getAiConfig();
  const baseUrl = draft.baseUrl?.trim() ? normalizeBaseUrl(draft.baseUrl) : cfg.baseUrl;
  const apiKey = draft.apiKey?.trim() ? draft.apiKey.trim() : cfg.apiKey;
  const model = draft.model?.trim() || cfg.model;
  const probe: AiConfig = { ...cfg, baseUrl, apiKey, model };
  const draftPreset = presetForBaseUrl(baseUrl);
  const transcribeModel =
    draft.transcribeModel !== undefined ? draft.transcribeModel.trim() : cfg.transcribeModel;

  if (!apiKey && !isLocalBaseUrl(baseUrl)) {
    throw new HttpError(422, "Pega la clave de tu proveedor para probar la conexión.", "ai_key_missing");
  }
  if (!model) throw new HttpError(422, "Indica el modelo de chat que quieres usar.", "ai_model_missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(45_000, cfg.timeoutMs));
  try {
    const started = Date.now();
    let response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(probe) },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: 'Responde únicamente JSON válido: {"ok":true}' },
          { role: "user", content: "ping" },
        ],
      }),
      signal: controller.signal,
    });
    let jsonMode = response.ok;
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      const retry = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(probe) },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 300,
          messages: [
            { role: "system", content: 'Responde únicamente JSON válido: {"ok":true}' },
            { role: "user", content: "ping" },
          ],
        }),
        signal: controller.signal,
      });
      if (retry.ok) {
        jsonMode = false;
        response = retry;
      }
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) throw safeProviderError(response.status, await response.text());
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    if (!payload.choices?.[0]?.message?.content) {
      throw new HttpError(502, "El modelo respondió sin contenido.", "ai_empty_response");
    }

    let models: string[] = [];
    try {
      const modelsResponse = await fetch(`${baseUrl}/models`, {
        headers: authHeaders(probe),
        signal: AbortSignal.timeout(8_000),
      });
      if (modelsResponse.ok) {
        const list = (await modelsResponse.json()) as { data?: Array<{ id?: string }> };
        models = (list.data ?? [])
          .map((item) => item.id ?? "")
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 300);
      }
    } catch {
      // El listado de modelos es opcional; el chat ya funcionó.
    }

    const transcriptionAvailable = Boolean(transcribeModel) && (draftPreset ? draftPreset.supportsTranscription : true);
    return {
      ok: true,
      latencyMs,
      model,
      baseUrlHost: providerHost(baseUrl),
      jsonMode,
      models,
      transcription: {
        available: transcriptionAvailable,
        model: transcriptionAvailable ? transcribeModel : whisperModelId(),
        reason: transcriptionAvailable
          ? `Transcripción por API disponible con ${transcribeModel}.`
          : `Este proveedor no transcribe audio: los subtítulos usarán Whisper local (${whisperModelId()}).`,
      },
      message: `Conexión correcta con ${model} (${latencyMs} ms).`,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) {
      throw new HttpError(504, "La prueba excedió el tiempo máximo. Revisa tu conexión.", "ai_timeout");
    }
    throw new HttpError(
      502,
      `No se pudo probar la conexión (${error instanceof Error ? error.message : String(error)}).`,
      "ai_unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function aiProviderLabel(): string {
  const settings = publicAiSettings();
  return settings.presets.find((preset) => preset.id === settings.provider)?.label ?? "Personalizado";
}

export async function listRemoteModels(draft: {
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
} = {}): Promise<{ ok: boolean; models: string[] }> {
  const cfg = getAiConfig();
  const baseUrl = draft.baseUrl?.trim() ? normalizeBaseUrl(draft.baseUrl) : cfg.baseUrl;
  const apiKey = draft.apiKey?.trim() ? draft.apiKey.trim() : cfg.apiKey;
  const probe: AiConfig = { ...cfg, baseUrl, apiKey };

  const isGemini = baseUrl.includes("generativelanguage.googleapis.com") || draft.provider === "gemini";
  let models: string[] = [];

  // 1. Si es Gemini, consultar la API de Google AI Studio con la clave
  if (isGemini && apiKey) {
    try {
      const nativeRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(9_000) },
      );
      if (nativeRes.ok) {
        const json = (await nativeRes.json()) as {
          models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
        };
        if (Array.isArray(json.models)) {
          models = json.models
            .filter(
              (m) =>
                m.name &&
                (!m.supportedGenerationMethods ||
                  m.supportedGenerationMethods.includes("generateContent")),
            )
            .map((m) => m.name!.replace(/^models\//, ""))
            .filter((name) => name.toLowerCase().includes("gemini"))
            .sort((a, b) => b.localeCompare(a));
        }
      }
    } catch (err) {
      console.warn("[listRemoteModels] Aviso consultando modelos nativos de Gemini:", err);
    }
  }

  // 2. Consulta estándar /models (OpenAI, Groq, NVIDIA NIM, OpenRouter, Ollama)
  if (models.length === 0 && (apiKey || isLocalBaseUrl(baseUrl))) {
    try {
      const modelsUrl = `${baseUrl}/models`;
      const res = await fetch(modelsUrl, {
        headers: authHeaders(probe),
        signal: AbortSignal.timeout(9_000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{ id?: string; name?: string }>;
          models?: Array<{ id?: string; name?: string }>;
        };
        const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
        models = rawList
          .map((item) => (item.id || item.name || "").replace(/^models\//, "").trim())
          .filter((id) => {
            const lower = id.toLowerCase();
            return (
              id &&
              !lower.includes("embed") &&
              !lower.includes("whisper") &&
              !lower.includes("tts") &&
              !lower.includes("dall-e") &&
              !lower.includes("moderation") &&
              !lower.includes("babbage") &&
              !lower.includes("davinci")
            );
          })
          .sort((a, b) => a.localeCompare(b));
      }
    } catch (err) {
      console.warn("[listRemoteModels] Aviso consultando /models:", err);
    }
  }

  return {
    ok: true,
    models: Array.from(new Set(models)).slice(0, 150),
  };
}
