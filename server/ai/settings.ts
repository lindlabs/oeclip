import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { userStore } from "../auth/store";

const aiSessionContext = new AsyncLocalStorage<{ sessionId?: string; userId?: string }>();

export function runWithAiSession<T>(
  sessionId: string | undefined,
  fn: () => T,
  userId?: string | undefined,
): T {
  return aiSessionContext.run({ sessionId, userId }, fn);
}

export function currentAiSessionId(): string | undefined {
  const id = aiSessionContext.getStore()?.sessionId?.trim();
  return id && /^[a-zA-Z0-9_-]{4,80}$/.test(id) ? id : undefined;
}

export function currentAiUserId(): string | undefined {
  const id = aiSessionContext.getStore()?.userId?.trim();
  return id || undefined;
}

export interface AiPreset {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  transcribeModel: string;
  supportsTranscription: boolean;
  requiresApiKey: boolean;
  docsUrl: string;
}

export const DEFAULT_GEMINI_MODEL =
  process.env.NOVACUT_GEMINI_MODEL?.trim() || "gemini-3.8-flash";

const RETIRED_GEMINI_MODELS = new Set(["gemini-2.5-flash"]);

export function upgradeRetiredModel(provider: string, baseUrl: string, model: string): string {
  const isGemini = provider === "gemini" || baseUrl.toLowerCase().includes("generativelanguage.googleapis.com");
  if (isGemini && RETIRED_GEMINI_MODELS.has(model.trim())) {
    return DEFAULT_GEMINI_MODEL;
  }
  return model.trim();
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: "gemini",
    label: "Google Gemini (gratis)",
    description: "Clave gratuita en 1 clic desde Google AI Studio. Ultra veloz para edición y generación Remotion.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: DEFAULT_GEMINI_MODEL,
    transcribeModel: "",
    supportsTranscription: false,
    requiresApiKey: true,
    docsUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq (gratis + Whisper)",
    description: "Inferencia ultra rápida gratuita con Llama 3.3 70B y transcripción de subtítulos Whisper en la nube.",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    transcribeModel: "whisper-large-v3-turbo",
    supportsTranscription: true,
    requiresApiKey: true,
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM 70B Pro (gratis)",
    description: "Clave gratuita nvapi- de build.nvidia.com con Llama 3.3 70B + Qwen Coder (cascade automático) y Whisper local.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    transcribeModel: "",
    supportsTranscription: false,
    requiresApiKey: true,
    docsUrl: "https://build.nvidia.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Chat GPT-4o y transcripción Whisper en el mismo proveedor.",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    transcribeModel: "whisper-1",
    supportsTranscription: true,
    requiresApiKey: true,
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Acceso a Claude, DeepSeek, Gemini y GPT con una sola clave.",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    transcribeModel: "",
    supportsTranscription: false,
    requiresApiKey: true,
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    description: "Modelos en tu propio equipo. No necesita clave ni conexión a internet.",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    transcribeModel: "",
    supportsTranscription: false,
    requiresApiKey: false,
    docsUrl: "https://ollama.com",
  },
  {
    id: "custom",
    label: "Otro compatible con OpenAI",
    description: "Cualquier endpoint /v1 compatible con la API de OpenAI.",
    baseUrl: "",
    model: "",
    transcribeModel: "",
    supportsTranscription: false,
    requiresApiKey: true,
    docsUrl: "",
  },
];

export interface AiConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  transcribeModel: string;
  supportsTranscription: boolean;
  timeoutMs: number;
}

export interface PublicAiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  transcribeModel: string;
  supportsTranscription: boolean;
  timeoutMs: number;
  hasApiKey: boolean;
  keyHint: string | null;
  requiresApiKey: boolean;
  source: "file" | "env";
  updatedAt: string | null;
  presets: AiPreset[];
}

interface StoredSettings extends AiConfig {
  version: 1;
  updatedAt: string;
}

let cached: AiConfig | null = null;
let cachedUpdatedAt: string | null = null;

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("La URL del proveedor no es válida.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("La URL del proveedor debe empezar por http:// o https://.");
  }
  return trimmed;
}

export function getPreset(id: string): AiPreset | undefined {
  return AI_PRESETS.find((preset) => preset.id === id);
}

export function presetForBaseUrl(baseUrl: string): AiPreset | undefined {
  let host = "";
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.endsWith("generativelanguage.googleapis.com")) return getPreset("gemini");
  if (host.endsWith("integrate.api.nvidia.com")) return getPreset("nvidia");
  if (host === "api.openai.com") return getPreset("openai");
  if (host.endsWith("openrouter.ai")) return getPreset("openrouter");
  if (host.endsWith("api.groq.com")) return getPreset("groq");
  if (host === "127.0.0.1:11434" || host === "localhost:11434") return getPreset("ollama");
  return undefined;
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

function settingsFilePath(sessionId?: string): string {
  if (sessionId) {
    return path.join(config.dataDir, "ai-sessions", `${sessionId}.json`);
  }
  return path.join(config.dataDir, "ai-settings.json");
}

function safeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 600_000 ? parsed : fallback;
}

function envConfig(): AiConfig {
  const baseUrl = normalizeBaseUrl(config.ai.baseUrl) || "https://api.openai.com/v1";
  const preset = presetForBaseUrl(baseUrl);
  const transcribeModel = config.ai.transcribeModel.trim();
  return {
    provider: preset?.id ?? "custom",
    baseUrl,
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    transcribeModel,
    supportsTranscription: preset ? preset.supportsTranscription && Boolean(transcribeModel) : Boolean(transcribeModel),
    timeoutMs: config.ai.timeoutMs,
  };
}

function emptyByokConfig(): AiConfig {
  return {
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "",
    model: DEFAULT_GEMINI_MODEL,
    transcribeModel: "",
    supportsTranscription: false,
    timeoutMs: config.ai.timeoutMs,
  };
}

function parseStoredPayload(parsed: Partial<StoredSettings> | null | undefined): StoredSettings | null {
  if (!parsed || typeof parsed !== "object") return null;
  try {
    const baseUrl = normalizeBaseUrl(String(parsed.baseUrl ?? ""));
    const rawModel = String(parsed.model ?? "").trim();
    const provider = String(parsed.provider ?? "custom");
    const model = upgradeRetiredModel(provider, baseUrl, rawModel);
    if (!baseUrl || !model) return null;
    const transcribeModel = String(parsed.transcribeModel ?? "").trim();
    return {
      version: 1,
      provider,
      baseUrl,
      apiKey: String(parsed.apiKey ?? "").trim(),
      model,
      transcribeModel,
      supportsTranscription: Boolean(parsed.supportsTranscription) && Boolean(transcribeModel),
      timeoutMs: safeNumber(parsed.timeoutMs, config.ai.timeoutMs),
      updatedAt: String(parsed.updatedAt ?? ""),
    };
  } catch {
    return null;
  }
}

function readStored(sessionId?: string): StoredSettings | null {
  if (sessionId) {
    try {
      const dbStored = parseStoredPayload(userStore.getUserAiSettings(sessionId) ?? undefined);
      if (dbStored) return dbStored;
    } catch {
      // Fallback a archivo JSON si SQLite aún no está disponible
    }
  }
  try {
    const raw = fs.readFileSync(settingsFilePath(sessionId), "utf8");
    const migrated = parseStoredPayload(JSON.parse(raw) as Partial<StoredSettings>);
    if (migrated && sessionId) {
      try {
        userStore.saveUserAiSettings(sessionId, migrated, currentAiUserId());
      } catch {
        // Ignorar si la migración falla en modo lectura
      }
    }
    return migrated;
  } catch {
    return null;
  }
}

export function claimAnonymousSessionAiSettings(
  anonSessionId: string | undefined,
  targetSessionId: string,
  targetUserId?: string | null,
): void {
  const cleanAnon = anonSessionId?.trim() ?? "";
  if (!cleanAnon || !cleanAnon.startsWith("ses_anon_") || cleanAnon === targetSessionId) return;
  try {
    if (userStore.claimAnonymousAiSettingsIfEmpty(cleanAnon, targetSessionId, targetUserId)) {
      return;
    }
  } catch {
    // Continuar con fallback de archivo JSON
  }
  const existingTarget = readStored(targetSessionId);
  if (existingTarget?.apiKey) return;
  const anonFile = readStored(cleanAnon);
  if (!anonFile?.apiKey) return;
  try {
    userStore.saveUserAiSettings(targetSessionId, anonFile, targetUserId);
    fs.unlinkSync(settingsFilePath(cleanAnon));
  } catch {
    // Ignorar fallo de limpieza
  }
}

export function migrateSessionAiSettings(
  oldSessionId: string,
  newSessionId: string,
  userId?: string | null,
): void {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return;
  const oldStored = readStored(oldSessionId);
  if (oldStored) {
    const newStored = readStored(newSessionId);
    if (!newStored?.apiKey) {
      userStore.saveUserAiSettings(newSessionId, oldStored, userId ?? undefined);
    }
  }
  const oldPath = settingsFilePath(oldSessionId);
  const newPath = settingsFilePath(newSessionId);
  try {
    if (fs.existsSync(oldPath)) {
      if (!fs.existsSync(newPath)) {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
      } else {
        fs.unlinkSync(oldPath);
      }
    }
  } catch {
    // Ignorar error de renombrado en disco si SQLite ya migró los ajustes
  }
}

export function getAiConfig(): AiConfig {
  const sessionId = currentAiSessionId();
  if (sessionId) {
    const sessionStored = readStored(sessionId);
    if (sessionStored) {
      return {
        provider: sessionStored.provider,
        baseUrl: sessionStored.baseUrl,
        apiKey: sessionStored.apiKey,
        model: sessionStored.model,
        transcribeModel: sessionStored.transcribeModel,
        supportsTranscription: sessionStored.supportsTranscription,
        timeoutMs: sessionStored.timeoutMs,
      };
    }
    return emptyByokConfig();
  }

  if (cached) return cached;
  const stored = readStored();
  if (stored) {
    cached = {
      provider: stored.provider,
      baseUrl: stored.baseUrl,
      apiKey: stored.apiKey,
      model: stored.model,
      transcribeModel: stored.transcribeModel,
      supportsTranscription: stored.supportsTranscription,
      timeoutMs: stored.timeoutMs,
    };
    cachedUpdatedAt = stored.updatedAt || null;
    return cached;
  }
  cached = envConfig();
  cachedUpdatedAt = null;
  return cached;
}

export function reloadAiSettings(): void {
  cached = null;
  cachedUpdatedAt = null;
}

function keyHint(apiKey: string): string | null {
  if (!apiKey) return null;
  const suffix = apiKey.slice(-4);
  return `****${suffix}`;
}

export function publicAiSettings(): PublicAiSettings {
  const sessionId = currentAiSessionId();
  const current = getAiConfig();
  const preset = presetForBaseUrl(current.baseUrl);
  const sessionStored = sessionId ? readStored(sessionId) : null;
  const updatedAt = sessionId ? sessionStored?.updatedAt ?? null : cachedUpdatedAt;
  return {
    provider: preset?.id ?? current.provider,
    baseUrl: current.baseUrl,
    model: current.model,
    transcribeModel: current.transcribeModel,
    supportsTranscription: current.supportsTranscription,
    timeoutMs: current.timeoutMs,
    hasApiKey: Boolean(current.apiKey),
    keyHint: keyHint(current.apiKey),
    requiresApiKey: !isLocalBaseUrl(current.baseUrl),
    source: updatedAt ? "file" : "env",
    updatedAt,
    presets: AI_PRESETS,
  };
}

export interface SaveAiSettingsInput {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  transcribeModel?: string;
  supportsTranscription?: boolean;
  timeoutMs?: number;
}

export function saveAiSettings(input: SaveAiSettingsInput): PublicAiSettings {
  const sessionId = currentAiSessionId();
  const current = getAiConfig();
  const preset = input.provider ? getPreset(input.provider) : undefined;
  if (input.provider && !preset) throw new Error("Proveedor de IA desconocido.");

  let baseUrl =
    input.baseUrl !== undefined
      ? normalizeBaseUrl(input.baseUrl)
      : preset && preset.id !== current.provider && preset.baseUrl
        ? normalizeBaseUrl(preset.baseUrl)
        : current.baseUrl;
  if (!baseUrl && preset?.baseUrl) baseUrl = normalizeBaseUrl(preset.baseUrl);
  if (!baseUrl) throw new Error("Indica la URL base del proveedor (por ejemplo https://api.openai.com/v1).");

  const model = (input.model !== undefined ? input.model : current.model).trim();
  if (!model) throw new Error("Indica el modelo de chat que quieres usar.");

  const transcribeModel =
    input.transcribeModel !== undefined
      ? input.transcribeModel.trim()
      : preset && preset.id !== current.provider
        ? preset.transcribeModel
        : current.transcribeModel;

  const apiKey =
    input.clearApiKey === true
      ? ""
      : input.apiKey !== undefined && input.apiKey.trim()
        ? input.apiKey.trim()
        : current.apiKey;

  const detected = presetForBaseUrl(baseUrl);
  const effectivePreset = preset ?? detected;
  const supportsTranscription =
    input.supportsTranscription !== undefined
      ? Boolean(input.supportsTranscription) && Boolean(transcribeModel)
      : Boolean(transcribeModel) && (effectivePreset ? effectivePreset.supportsTranscription : true);

  const next: StoredSettings = {
    version: 1,
    provider: effectivePreset?.id ?? "custom",
    baseUrl,
    apiKey,
    model,
    transcribeModel: transcribeModel,
    supportsTranscription,
    timeoutMs: safeNumber(input.timeoutMs, current.timeoutMs),
    updatedAt: new Date().toISOString(),
  };

  if (sessionId) {
    userStore.saveUserAiSettings(sessionId, next, currentAiUserId());
  }

  const target = settingsFilePath(sessionId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Windows o FUSE no siempre permiten chmod
    }
  } catch (err) {
    // Si ya se persistió en SQLite para el usuario, usar escritura directa o tolerar fallo de rename en GCS FUSE
    try {
      fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    } catch {
      if (!sessionId) throw err;
    }
  }

  if (!sessionId) {
    cached = {
      provider: next.provider,
      baseUrl: next.baseUrl,
      apiKey: next.apiKey,
      model: next.model,
      transcribeModel: next.transcribeModel,
      supportsTranscription: next.supportsTranscription,
      timeoutMs: next.timeoutMs,
    };
    cachedUpdatedAt = next.updatedAt;
  }
  return publicAiSettings();
}

export function requireUsableAiConfig(cfg: AiConfig): void {
  if (!cfg.apiKey && !isLocalBaseUrl(cfg.baseUrl)) {
    throw new Error("Falta la clave del proveedor de IA.");
  }
}

export function aiSettingsUpdatedAt(): string | null {
  getAiConfig();
  return cachedUpdatedAt;
}
