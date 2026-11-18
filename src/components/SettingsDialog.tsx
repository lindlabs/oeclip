import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../shared/schema";
import { api, getCurrentUser, type AiSettings, type AiTestResult, type Health, type ServerConfig } from "../api";
import { formatBytes } from "../shared/time";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { AdminUsersModal } from "./AdminUsersModal";

interface SettingsDialogProps {
  project?: Project | null;
  config: ServerConfig | null;
  onClose: () => void;
  onRefreshConfig: () => Promise<ServerConfig | null>;
  onRevealProject?: () => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

interface ProviderQuickCard {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  defaultModel: string;
  desc: string;
  models: Array<{ id: string; label: string; desc: string }>;
  keyPrefix: string;
}

const QUICK_PROVIDERS: ProviderQuickCard[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "Recomendado",
    badgeColor: "bg-[var(--sage-100)] text-[var(--sage-900)] border-[var(--sage-400)]",
    defaultModel: "gemini-2.5-flash",
    desc: "Ultra rápido para edición y Remotion. Clave en 1 clic desde Google AI Studio.",
    keyPrefix: "AIzaSy...",
    models: [
      { id: "gemini-2.5-flash", label: "2.5 Flash", desc: "Velocidad instantánea" },
      { id: "gemini-2.5-pro", label: "2.5 Pro", desc: "Máxima inteligencia editorial" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    badge: "Gratis + Whisper",
    badgeColor: "bg-amber-100 text-amber-900 border-amber-300",
    defaultModel: "llama-3.3-70b-versatile",
    desc: "Inferencia Llama 3.3 70B a ultra velocidad y subtítulos Whisper en la nube.",
    keyPrefix: "gsk_...",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", desc: "Modelo versátil ultra rápido" },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    badge: "70B Pro",
    badgeColor: "bg-emerald-100 text-emerald-900 border-emerald-300",
    defaultModel: "meta/llama-3.3-70b-instruct",
    desc: "Inferencia Llama 3.3 70B Pro de build.nvidia.com.",
    keyPrefix: "nvapi-...",
    models: [
      { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B", desc: "Instrucciones precisas" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    badge: "GPT-4o",
    badgeColor: "bg-sky-100 text-sky-900 border-sky-300",
    defaultModel: "gpt-4o-mini",
    desc: "Modelos GPT oficiales y transcripción Whisper.",
    keyPrefix: "sk-proj-...",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o Mini", desc: "Económico y ágil" },
      { id: "gpt-4o", label: "GPT-4o", desc: "Multimodal completo" },
    ],
  },
];

export function SettingsDialog({
  project,
  config,
  onClose,
  onRefreshConfig,
  onRevealProject,
  onToast,
}: SettingsDialogProps) {
  const [health, setHealth] = useState<Health | null>(null);

  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [providerId, setProviderId] = useState("gemini");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("gemini-2.5-flash");
  const [transcribeModel, setTranscribeModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [manualModelInput, setManualModelInput] = useState(false);
  const [copiedMcpUrl, setCopiedMcpUrl] = useState(false);
  const [adminUsersOpen, setAdminUsersOpen] = useState(false);
  const loadTimerRef = useRef<number | null>(null);

  const currentUser = getCurrentUser();
  const mcpServerUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const handle = currentUser?.handle?.trim();
    return `${origin}/mcp${handle ? `?user=${encodeURIComponent(handle)}` : ""}`;
  }, [currentUser?.handle]);

  const copyMcpUrl = async () => {
    try {
      await navigator.clipboard.writeText(mcpServerUrl);
      setCopiedMcpUrl(true);
      onToast("URL MCP copiada para Claude.", "success");
      window.setTimeout(() => setCopiedMcpUrl(false), 2000);
    } catch {
      onToast("No se pudo copiar automáticamente; selecciona la URL manualmente.", "info");
    }
  };

  useEffect(() => {
    void api.health().then(setHealth).catch(() => undefined);
    void api
      .aiSettings()
      .then((next) => {
        setSettings(next);
        setProviderId(next.provider);
        setBaseUrl(next.baseUrl);
        setModel(next.model || "gemini-2.5-flash");
        setTranscribeModel(next.transcribeModel);
      })
      .catch(() => undefined);
  }, []);

  const capabilities = config?.capabilities ?? health?.capabilities;
  const ai = config?.ai ?? health?.ai;

  const currentPreset = useMemo(
    () => settings?.presets.find((item) => item.id === providerId),
    [settings, providerId],
  );

  const activeQuick = useMemo(
    () => QUICK_PROVIDERS.find((p) => p.id === providerId),
    [providerId],
  );

  const selectProvider = (id: string) => {
    setProviderId(id);
    setTestResult(null);
    setTestError(null);
    setAvailableModels([]);
    const next = settings?.presets.find((item) => item.id === id);
    if (!next) return;
    if (next.baseUrl) setBaseUrl(next.baseUrl);
    if (next.model) setModel(next.model);
    setTranscribeModel(next.transcribeModel);
  };

  const applySettings = (next: AiSettings) => {
    setSettings(next);
    setProviderId(next.provider);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setTranscribeModel(next.transcribeModel);
    setApiKey("");
  };

  const loadModelsForCurrentKey = useCallback(
    async (targetKey = apiKey, targetBaseUrl = baseUrl, targetProvider = providerId) => {
      const activeKey = targetKey.trim() || (settings?.hasApiKey ? undefined : "");
      if (activeKey === "" && !settings?.hasApiKey) {
        onToast("Pega primero tu API Key para consultar los modelos disponibles.", "info");
        return;
      }
      setLoadingModels(true);
      try {
        const res = await api.fetchAiModels({
          apiKey: targetKey.trim() || undefined,
          baseUrl: targetBaseUrl.trim() || undefined,
          provider: targetProvider,
        });
        if (Array.isArray(res.models) && res.models.length > 0) {
          setAvailableModels(res.models);
          // Si el modelo actual no está en la lista recibida, preseleccionar uno destacado
          if (!model || !res.models.includes(model)) {
            const preferred =
              res.models.find((m) => m === "gemini-2.5-pro") ||
              res.models.find((m) => m === "gemini-2.5-flash") ||
              res.models.find((m) => m === "gpt-4o") ||
              res.models.find((m) => m === "gpt-4o-mini") ||
              res.models.find((m) => m.includes("70b")) ||
              res.models[0];
            if (preferred) setModel(preferred);
          }
          onToast(`${res.models.length} modelos listados desde tu cuenta.`, "success");
        } else {
          onToast("No se encontraron modelos adicionales para esta clave.", "info");
        }
      } catch {
        // Ignorar si la clave aún no está completa
      } finally {
        setLoadingModels(false);
      }
    },
    [apiKey, baseUrl, providerId, model, settings?.hasApiKey, onToast],
  );

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const result = await api.testAi({
        baseUrl,
        model,
        transcribeModel,
        apiKey: apiKey.trim() || undefined,
      });
      setTestResult(result);
      if (Array.isArray(result.models) && result.models.length > 0) {
        setAvailableModels(result.models);
      }
      onToast(result.message, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo probar la conexión.";
      setTestError(message);
      onToast(message, "error");
    } finally {
      setTesting(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const next = await api.saveAiSettings({
        provider: providerId,
        baseUrl,
        model,
        transcribeModel,
        apiKey: apiKey.trim() || undefined,
      });
      applySettings(next);
      setTestResult(null);
      setTestError(null);
      await onRefreshConfig();
      onToast("API Key guardada y activa al instante.", "success");
      onClose();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "No se pudo guardar la clave.", "error");
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    if (!window.confirm("¿Eliminar la clave guardada? La IA se pausará hasta que agregues otra.")) return;
    try {
      const next = await api.saveAiSettings({
        provider: providerId,
        baseUrl,
        model,
        transcribeModel,
        clearApiKey: true,
      });
      applySettings(next);
      await onRefreshConfig();
      onToast("Clave eliminada.", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "No se pudo eliminar la clave.", "error");
    }
  };

  return (
    <Modal
      title="Configurar API Key de IA"
      kicker="BYOK · Privada y Segura"
      subtitle="Elige tu proveedor, pega tu clave y empieza a crear videos con IA al instante."
      wide={false}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row w-full sm:items-center justify-between gap-2">
          {settings?.hasApiKey ? (
            <button
              type="button"
              className="self-start sm:self-auto text-[11px] font-semibold text-[var(--muted)] hover:text-[var(--danger)] transition-colors py-1 sm:py-0"
              onClick={() => void clearKey()}
            >
              Eliminar clave guardada
            </button>
          ) : (
            <span className="hidden sm:inline" />
          )}

          <div className="flex w-full sm:w-auto items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary flex-1 sm:flex-initial justify-center !min-h-[36px] sm:!min-h-0 sm:!h-8 !px-3 !text-[11.5px]"
              onClick={() => void testConnection()}
              disabled={testing || saving}
            >
              <Icon name="refresh" size={12} className={testing ? "spin" : undefined} />
              {testing ? "Probando..." : "Probar conexión"}
            </button>
            <button
              type="button"
              className="btn btn-primary flex-1 sm:flex-initial justify-center !min-h-[36px] sm:!min-h-0 sm:!h-8 !px-4 !text-[11.5px]"
              onClick={() => void saveSettings()}
              disabled={saving}
            >
              <Icon name="check" size={12} />
              {saving ? "Guardando..." : "Guardar y Activar"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 py-1">
        {/* Estado actual de conexión */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-[var(--sage-50)] px-3 py-2 text-[11px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  ai?.configured ? "bg-learn-green animate-ping" : "bg-amber-400"
                }`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  ai?.configured ? "bg-learn-green" : "bg-amber-500"
                }`}
              />
            </span>
            <span className="font-semibold text-[var(--ink)] break-words">
              {ai?.configured ? (
                <>
                  IA Conectada · <strong className="text-[var(--sage-900)]">{ai.model}</strong>
                </>
              ) : (
                "Sin API Key configurada (Modo manual activo)"
              )}
            </span>
          </div>
          {settings?.hasApiKey && (
            <span className="rounded-md border border-[var(--sage-300)] bg-[var(--white)] px-1.5 py-0.5 text-[9.5px] font-bold text-[var(--sage-800)]">
              Clave guardada ({settings.keyHint || "activa"})
            </span>
          )}
        </div>

        {/* Paso 1: Elegir proveedor */}
        <div className="space-y-2">
          <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-soft)]">
            1. Elige tu proveedor de IA
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {QUICK_PROVIDERS.map((qp) => {
              const isSelected = providerId === qp.id;
              return (
                <button
                  key={qp.id}
                  type="button"
                  onClick={() => selectProvider(qp.id)}
                  className={`flex flex-col items-start rounded-xl border-2 p-2.5 text-left transition-all cursor-pointer ${
                    isSelected
                      ? "border-[var(--ink)] bg-[var(--paper)] shadow-[3px_3px_0_#202a28]"
                      : "border-[var(--line)] bg-[var(--paper)]/60 hover:border-[var(--ink-soft)] hover:bg-[var(--paper)]"
                  }`}
                >
                  <div className="flex w-full flex-wrap items-center justify-between gap-1">
                    <span className="text-[12px] font-bold leading-tight text-[var(--ink)]">{qp.name}</span>
                    <span className={`shrink-0 rounded-full border px-1.5 py-[1px] text-[8.5px] font-bold ${qp.badgeColor}`}>
                      {qp.badge}
                    </span>
                  </div>
                  <span className="mt-1 line-clamp-2 text-[9.5px] text-[var(--muted)] leading-tight">
                    {qp.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Opción para otros proveedores menos comunes */}
          <div className="flex items-center justify-between pt-0.5 text-[10px]">
            {currentPreset?.docsUrl ? (
              <a
                href={currentPreset.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-[var(--sage-800)] hover:underline inline-flex items-center gap-1"
              >
                <span>Obtener API Key gratis en {activeQuick?.name || "el proveedor"}</span>
                <span>↗</span>
              </a>
            ) : (
              <span />
            )}

            <button
              type="button"
              onClick={() => {
                const nextId = providerId === "openrouter" ? "ollama" : "openrouter";
                selectProvider(nextId);
              }}
              className="text-[10px] font-semibold text-[var(--muted)] hover:text-[var(--ink)] underline"
            >
              ¿Usar OpenRouter u Ollama local?
            </button>
          </div>
        </div>

        {/* Paso 2: Pegar API Key */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="ai-key-input" className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-soft)]">
              2. Pega tu API Key
            </label>
            {settings?.hasApiKey && (
              <span className="text-[9.5px] font-medium text-[var(--muted)]">
                Deja vacío para conservar la clave guardada
              </span>
            )}
          </div>

          <div className="relative flex items-center">
            <input
              id="ai-key-input"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                const val = e.target.value;
                setApiKey(val);
                if (val.trim().length >= 24) {
                  if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
                  loadTimerRef.current = window.setTimeout(() => {
                    void loadModelsForCurrentKey(val);
                  }, 650);
                }
              }}
              placeholder={
                settings?.hasApiKey
                  ? `•••••••••••••••• (Clave actual activa)`
                  : `Ej. ${activeQuick?.keyPrefix || "AIzaSy..."}`
              }
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-2 pr-9 text-[12px] font-mono text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--ink)] outline-none"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2.5 grid h-6 w-6 place-items-center rounded text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
              title={showKey ? "Ocultar clave" : "Mostrar clave"}
            >
              <Icon name={showKey ? "eye-off" : "eye"} size={13} />
            </button>
          </div>
        </div>

        {/* Paso 3: Selección de Modelo */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-soft)]">
              3. Modelo de IA
            </label>
            <div className="flex items-center gap-2">
              {availableModels.length > 0 && (
                <button
                  type="button"
                  onClick={() => setManualModelInput((v) => !v)}
                  className="text-[10px] font-medium text-[var(--muted)] hover:text-[var(--ink)] underline cursor-pointer"
                >
                  {manualModelInput ? "Ver menú desplegable" : "Escribir otro"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadModelsForCurrentKey()}
                disabled={loadingModels || (!apiKey.trim() && !settings?.hasApiKey)}
                className="text-[10px] font-bold text-[var(--sage-800)] hover:underline inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
                title="Consultar modelos disponibles en tu cuenta con esta clave"
              >
                <Icon name="refresh" size={10} className={loadingModels ? "spin" : undefined} />
                <span>{loadingModels ? "Consultando modelos..." : "Consultar modelos de mi clave"}</span>
              </button>
            </div>
          </div>

          {/* Modelos detectados en vivo con la clave */}
          {availableModels.length > 0 && !manualModelInput ? (
            <div className="space-y-1.5 animate-fade-in">
              <div className="flex items-center justify-between text-[10px] text-[var(--muted)]">
                <span>{availableModels.length} modelos detectados para tu cuenta:</span>
                <span className="font-bold text-emerald-800 flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 inline-block" />
                  Sincronizado en vivo con tu API Key
                </span>
              </div>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-xl border-2 border-[var(--ink)] bg-[var(--white)] px-3 py-2 text-[12px] font-bold text-[var(--ink)] shadow-sm outline-none cursor-pointer"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              {/* Píldoras rápidas del proveedor */}
              <div className="flex flex-wrap items-center gap-1.5">
                {activeQuick?.models.map((m) => {
                  const isSelected = model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModel(m.id)}
                      className={`rounded-lg border px-2.5 py-1 text-[10.5px] font-bold transition-all cursor-pointer ${
                        isSelected
                          ? "border-[var(--ink)] bg-[var(--sage-200)] text-[var(--ink)] shadow-sm"
                          : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-soft)] hover:border-[var(--ink-soft)]"
                      }`}
                    >
                      <span>{m.label}</span>
                      <span className="ml-1 text-[9px] font-medium opacity-75">· {m.desc}</span>
                    </button>
                  );
                })}
              </div>

              <div className="pt-1">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Nombre del modelo (ej. gemini-2.5-pro, gemini-2.5-flash)"
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--white)] px-2.5 py-1 text-[11px] font-mono text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--ink)] outline-none"
                />
              </div>
            </>
          )}
        </div>

        {/* Resultado de la prueba en tiempo real */}
        {testResult && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-950 animate-fade-in flex items-center gap-2">
            <span className="grid h-4 w-4 place-items-center rounded-full bg-emerald-200 text-emerald-800 text-[9px] font-bold">
              ✓
            </span>
            <span className="font-semibold leading-snug">{testResult.message}</span>
          </div>
        )}

        {testError && (
          <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-950 animate-fade-in flex items-center gap-2">
            <span className="grid h-4 w-4 place-items-center rounded-full bg-rose-200 text-rose-800 text-[9px] font-bold">
              ✕
            </span>
            <span className="font-medium leading-snug">{testError}</span>
          </div>
        )}

        {/* Conector remoto MCP para Claude */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--sage-50)] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink)]">
                Conectar con Claude (MCP)
              </div>
              <p className="text-[10px] text-[var(--muted)] leading-snug">
                En Claude → Agregar conector personalizado, pega estos datos:
              </p>
            </div>
            <button
              type="button"
              onClick={() => void copyMcpUrl()}
              className="btn btn-secondary shrink-0 !min-h-[30px] !h-7 !px-2.5 !text-[10.5px]"
            >
              <Icon name={copiedMcpUrl ? "check" : "duplicate"} size={11} />
              <span>{copiedMcpUrl ? "Copiada" : "Copiar URL MCP"}</span>
            </button>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-4 text-[10.5px]">
            <div className="rounded-lg border border-[var(--line)] bg-[var(--white)] px-2.5 py-1.5">
              <div className="text-[9px] font-bold uppercase text-[var(--muted)]">Nombre</div>
              <div className="font-bold text-[var(--ink)]">OECLIP</div>
            </div>
            <div className="sm:col-span-3 rounded-lg border border-[var(--line)] bg-[var(--white)] px-2.5 py-1.5">
              <div className="text-[9px] font-bold uppercase text-[var(--muted)]">URL del servidor MCP</div>
              <div className="font-mono text-[10.5px] text-[var(--ink)] break-all select-all">{mcpServerUrl}</div>
            </div>
          </div>
        </div>

        {/* Campo exclusivo de administrador: Gestión de cuentas */}
        {currentUser?.role === "admin" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-[var(--ink)] bg-[var(--cream)] px-3 py-2.5 shadow-[var(--shadow-hard-sm)]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--ink)]">
                <Icon name="user" size={12} className="text-[var(--sage-800)]" />
                <span>Administración · Gestión de Cuentas</span>
              </div>
              <p className="mt-0.5 text-[10.5px] text-[var(--ink-soft)] leading-snug">
                Crea cuentas, asigna roles, suspende accesos o restablece contraseñas.
              </p>
            </div>
            <button
              type="button"
              data-admin-users-btn
              onClick={() => setAdminUsersOpen(true)}
              className="btn btn-primary shrink-0 !h-8 !px-3 !text-[11px]"
            >
              <Icon name="user" size={12} />
              <span>Gestionar cuentas</span>
            </button>
          </div>
        )}

        {/* Opciones avanzadas y Diagnóstico (colapsados limpiamente) */}
        <details
          className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-2.5 text-[10.5px] text-[var(--ink-soft)] transition-all"
          open={showAdvanced}
          onToggle={(e) => setShowAdvanced(e.currentTarget.open)}
        >
          <summary className="cursor-pointer font-bold text-[var(--ink)] select-none">
            Ajustes avanzados & Diagnóstico del sistema
          </summary>
          <div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-[var(--muted)]">
                  URL Base personalizada
                </label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--white)] px-2 py-1 text-[10.5px] font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-[var(--muted)]">
                  Modelo de transcripción (Whisper)
                </label>
                <input
                  value={transcribeModel}
                  onChange={(e) => setTranscribeModel(e.target.value)}
                  placeholder="whisper-1 (opcional)"
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--white)] px-2 py-1 text-[10.5px] font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg bg-[var(--sage-50)] p-2 text-[10px]">
              <div>
                <span className="text-[var(--muted)]">FFmpeg:</span>{" "}
                <strong>{capabilities?.ffmpegVersion ? "Disponible" : "No detectado"}</strong>
              </div>
              <div>
                <span className="text-[var(--muted)]">GPU:</span>{" "}
                <strong>{capabilities?.nvidiaGpu || "Render CPU"}</strong>
              </div>
              <div>
                <span className="text-[var(--muted)]">Memoria:</span>{" "}
                <strong>{capabilities ? formatBytes(capabilities.totalMemoryBytes) : "—"}</strong>
              </div>
            </div>

            {project && onRevealProject && (
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={onRevealProject}
                  className="text-[10px] font-semibold text-[var(--sage-800)] hover:underline inline-flex items-center gap-1"
                >
                  <Icon name="folder" size={11} />
                  Abrir carpeta del proyecto
                </button>
              </div>
            )}
          </div>
        </details>
      </div>
      {adminUsersOpen && currentUser?.role === "admin" && (
        <AdminUsersModal
          currentUser={currentUser}
          onClose={() => setAdminUsersOpen(false)}
          onToast={onToast}
        />
      )}
    </Modal>
  );
}
