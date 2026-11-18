import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { AgentMessage, AgentPlan, AgentStep, MediaAsset, Project } from "../shared/schema";
import type { AiStatus, JobState } from "../api";
import { createAgentMessage } from "../shared/project";
import { formatDurationUs } from "../shared/time";
import { Icon, type IconName } from "./Icon";
import { ConfirmDialog } from "./Modal";

interface AgentPanelProps {
  project: Project;
  messages: AgentMessage[];
  ai: AiStatus | null;
  planning: boolean;
  activeJob: JobState | null;
  confirmationPlanId: string | null;
  selectedClipIds: string[];
  selectedMediaId: string | null;
  onPlan: (instruction: string, preferLocal: boolean) => void;
  onExecute: (planId: string) => void;
  onDismissConfirmation: () => void;
  onCancel: () => void;
  onClear: () => void;
  onRefreshAi: () => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
  onRunTool: (tool: string, args: Record<string, unknown>, label: string) => Promise<void>;
  onImportFiles: (files: File[]) => void;
  onSelectMedia: (mediaId: string | null) => void;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function requestsUpload(text: string): boolean {
  const normalized = normalizeText(text);
  if (/\b(no quiero|no necesito|sin)\b.{0,20}\b(subir|cargar|importar|adjuntar)\b/.test(normalized)) return false;
  return /\b(subir|sube|subeme|cargar|carga|cargame|importar|importa|adjuntar|adjunta|anexar|anexa)\b.{0,45}\b(video|imagen|foto|archivo|recurso|medio|material|catalogo)\b/.test(normalized) ||
    /\b(video|imagen|foto|archivo|recurso|medio|material|catalogo)\b.{0,35}\b(subir|cargar|importar|adjuntar)\b/.test(normalized);
}

function requestsResourceBrowsing(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    requestsUpload(text) ||
    (/\b(mostrar|muestrame|buscar|busca|seleccionar|selecciona|elegir|elige|usar|usa)\b/.test(normalized) &&
      /\b(video|videos|imagen|imagenes|foto|fotos|archivo|archivos|recurso|recursos|medio|medios|material|catalogo)\b/.test(normalized))
  );
}

function smallTalkReply(text: string): string | null {
  const n = normalizeText(text);
  if (/^(hola|buenas|hey|hello|hi)\b/.test(n)) return "Hola. Soy el copiloto de edición de OECLIP. Dime qué quieres hacer con tu montaje.";
  if (/^(quien eres|que eres|que haces)\b/.test(n)) return "Soy el agente de edición local de OECLIP. Puedo planificar cortes, subtítulos, cambios de velocidad, exportaciones y más, siempre bajo tu aprobación.";
  if (/^(gracias|thanks)\b/.test(n)) return "De nada. ¿En qué más puedo ayudarte con el proyecto?";
  return null;
}

/**
 * Los mensajes antiguos guardados incluían un aviso repetitivo sobre deshacer e
 * historial. Se limpia en el render para no tener que reescribir el historial.
 */
const BOILERPLATE_PATTERNS = [
  /Puedes revisar el montaje,\s*deshacer con Ctrl\+Z o abrir el historial de versiones para volver al estado anterior\.?/gi,
  /(?:y\s+)?puedes deshacer(?:las|lo|la|los)? con Ctrl\+Z o restaurar la instantánea[^.\n]*\.?/gi,
];

function cleanMessageText(text: string): string {
  let next = text;
  for (const pattern of BOILERPLATE_PATTERNS) next = next.replace(pattern, "");
  next = next.replace(
    /He aplicado (\d+) de (\d+) operaciones\./gi,
    (_match, done: string, total: string) => `Apliqué ${done} de ${total} ${total === "1" ? "cambio" : "cambios"}.`,
  );
  return next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function toolIcon(tool: string): IconName {
  if (tool === "add_media_clip" || tool === "select_media") return "film";
  if (tool === "add_text_clip" || tool === "add_subtitle" || tool === "change_subtitle_style") return "type";
  if (tool === "trim_clip" || tool === "split_clip" || tool === "remove_clip") return "scissors";
  if (tool === "set_speed") return "clock";
  if (tool === "change_aspect_ratio") return "maximize";
  if (tool === "export") return "download";
  if (tool === "generate_proxy") return "refresh";
  return "sparkles";
}

function formatStepDuration(ms?: number): string {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

const STEP_STATUS: Record<AgentStep["status"], { label: string; bg: string; text: string; icon: IconName }> = {
  done: { label: "Hecho", bg: "bg-[var(--sage-50)]", text: "text-[var(--sage-700)]", icon: "check" },
  running: { label: "En curso", bg: "bg-[var(--warning-soft)]", text: "text-[var(--warning)]", icon: "loader" },
  failed: { label: "Error", bg: "bg-[var(--danger-soft)]", text: "text-[var(--danger)]", icon: "alert" },
  skipped: { label: "Omitido", bg: "bg-[var(--cream-deep)]", text: "text-[var(--muted)]", icon: "close" },
  pending: { label: "Pendiente", bg: "bg-[var(--cream-deep)]", text: "text-[var(--muted)]", icon: "clock" },
};

function StatusBadge({ status }: { status: AgentStep["status"] }) {
  const variant = STEP_STATUS[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shadow-sm ${variant.bg} ${variant.text}`}>
      <Icon name={variant.icon} size={10} className={status === "running" ? "animate-spin" : undefined} />
      {variant.label}
    </span>
  );
}

function ResourceCard({ asset, selected, onSelect }: { asset: MediaAsset; selected: boolean; onSelect: () => void }) {
  const isAudio = asset.kind === "audio";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl border-2 transition-all ${selected ? "border-[var(--sage-600)] bg-[var(--sage-50)]" : "border-[var(--line)] bg-[var(--white)] hover:border-[var(--sage-600)] hover:shadow-[var(--shadow-hard-sm)]"}`}
    >
      <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${isAudio ? "bg-[var(--sage-100)] text-[var(--sage-700)]" : "bg-[var(--cream-deep)] text-[var(--ink-soft)]"}`}>
        <Icon name={isAudio ? "music" : "film"} size={14} />
      </div>
      <span className="text-xs font-medium text-[var(--ink)] leading-tight truncate w-full text-center">{asset.name}</span>
      <span className="text-[10px] text-[var(--muted)] leading-tight w-full text-center">
        {formatDurationUs(asset.durationUs)}{asset.width && asset.height ? ` · ${asset.width}x${asset.height}` : ""}
      </span>
    </button>
  );
}

function QuickChip({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border-2 px-3 py-1.5 text-xs font-medium transition-all ${disabled ? "border-[var(--line)] bg-[var(--paper)] text-[var(--muted)] cursor-not-allowed" : "border-[var(--ink)] bg-[var(--white)] text-[var(--ink)] hover:bg-[var(--sage-50)] hover:border-[var(--sage-600)] hover:text-[var(--ink)] shadow-[var(--shadow-hard-sm)]"}`}
    >
      {label}
    </button>
  );
}

function ExecutionStep({ step }: { step: AgentStep }) {
  const detail = step.error ?? step.result ?? step.reason;
  const isRunning = step.status === "running";
  return (
    <li className={`flex items-start gap-2.5 rounded-xl px-2 py-2 ${isRunning ? "bg-[var(--sage-50)]" : ""}`}>
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${step.status === "running" ? "bg-[var(--sage-100)] text-[var(--sage-700)]" : "bg-[var(--cream-deep)] text-[var(--muted)]"}`}>
        <Icon name={toolIcon(step.tool)} size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className={`text-[13px] font-bold leading-snug break-words ${step.status === "skipped" ? "text-[var(--muted)]" : "text-[var(--ink)]"}`}>
            {step.title}
          </span>
          <StatusBadge status={step.status} />
        </div>
        {detail && (
          <p className={`mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed ${step.status === "failed" ? "text-[var(--danger)]" : "text-[var(--ink-soft)]"}`}>
            {detail}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--muted)]">
          {step.risk === "high" && (
            <span className="inline-flex items-center gap-1 font-bold uppercase tracking-wide text-[var(--warning)]">
              <Icon name="alert" size={9} />
              Alto impacto
            </span>
          )}
          {step.durationMs !== undefined && step.durationMs > 0 && (
            <span className="tabular-nums">{formatStepDuration(step.durationMs)}</span>
          )}
        </div>
      </div>
    </li>
  );
}

const PLAN_STATUS: Record<AgentPlan["status"], { label: string; icon: IconName; tone: string }> = {
  proposed: { label: "Plan listo", icon: "layers", tone: "text-[var(--sage-700)]" },
  running: { label: "Aplicando cambios…", icon: "loader", tone: "text-[var(--warning)]" },
  done: { label: "Plan completado", icon: "check", tone: "text-[var(--sage-700)]" },
  failed: { label: "Plan interrumpido", icon: "alert", tone: "text-[var(--danger)]" },
  cancelled: { label: "Plan cancelado", icon: "close", tone: "text-[var(--muted)]" },
};

interface PlanCardProps {
  plan: AgentPlan;
  activeJob: JobState | null;
  confirmationPlanId: string | null;
  busy: boolean;
  dismissed: boolean;
  onExecute: (planId: string) => void;
  onDismiss: (planId: string) => void;
}

function PlanCard({ plan, activeJob, confirmationPlanId, busy, dismissed, onExecute, onDismiss }: PlanCardProps) {
  const [open, setOpen] = useState(plan.status !== "done" && plan.status !== "cancelled");
  const [starting, setStarting] = useState(false);
  const isRunning = plan.status === "running";
  const meta = PLAN_STATUS[plan.status];
  const completed = plan.steps.filter((step) => step.status === "done").length;
  const total = plan.steps.length;
  const stepRatio = total > 0 ? completed / total : 0;
  const ratio = plan.status === "done" ? 1 : isRunning ? Math.max(stepRatio, activeJob?.progress ?? 0) : stepRatio;
  const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const highImpact = plan.steps.some((step) => step.risk === "high" || step.tool === "remove_clip");

  useEffect(() => {
    if (isRunning || plan.status === "proposed") setOpen(true);
  }, [isRunning, plan.status]);

  useEffect(() => {
    if (confirmationPlanId === plan.id) setOpen(true);
  }, [confirmationPlanId, plan.id]);

  useEffect(() => {
    if (plan.status !== "proposed") setStarting(false);
  }, [plan.status]);

  useEffect(() => {
    if (!starting) return;
    const timer = window.setTimeout(() => setStarting(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [starting]);

  return (
    <div className={`overflow-hidden rounded-[18px] border-2 bg-[var(--white)] shadow-[var(--shadow-hard-sm)] ${isRunning ? "border-[var(--sage-600)]" : "border-[var(--ink)]"}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--cream-deep)] ${meta.tone}`}>
          <Icon name={meta.icon} size={13} className={isRunning ? "animate-spin" : undefined} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold leading-tight text-[var(--ink)]">{meta.label}</span>
          <span className="mt-0.5 block text-[11px] leading-tight text-[var(--muted)]">
            {total} {total === 1 ? "paso" : "pasos"} · {completed} completados
          </span>
        </span>
        <span className="shrink-0 text-[11px] font-bold tabular-nums text-[var(--muted)]">{percent}%</span>
        <Icon name="chevron-down" size={13} className={`shrink-0 text-[var(--muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {plan.status !== "proposed" && (
        <div className="h-1 bg-[var(--line)]">
          <div
            className={`h-full transition-all ${plan.status === "failed" ? "bg-[var(--danger)]" : "bg-[var(--sage-600)]"}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {open && (
        <div className="border-t border-[var(--line)] px-2 py-2">
          <ul className="space-y-0.5">
            {plan.steps.map((step) => (
              <ExecutionStep key={step.id} step={step} />
            ))}
          </ul>

          {plan.warnings.length > 0 && (
            <ul className="mt-2 space-y-1 rounded-xl bg-[var(--warning-soft)] px-2.5 py-2">
              {plan.warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--warning)]">
                  <Icon name="alert" size={10} className="mt-0.5 shrink-0" />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {plan.status === "proposed" && !dismissed && (
        <div className="flex flex-wrap items-center gap-2 border-t-2 border-[var(--ink)] bg-[var(--sage-50)] px-3 py-2.5">
          <p className="min-w-[140px] flex-1 text-[11px] leading-snug text-[var(--ink-soft)]">
            {highImpact
              ? "Este plan incluye acciones de alto impacto. Revísalo antes de aplicarlo."
              : "Confirma el plan para aplicarlo al montaje."}
          </p>
          <button
            type="button"
            onClick={() => {
              setStarting(true);
              onExecute(plan.id);
            }}
            disabled={busy || starting}
            className="btn btn-sm btn-primary"
          >
            <Icon name={busy || starting ? "loader" : "play"} size={12} className={busy || starting ? "animate-spin" : undefined} />
            {starting ? "Aplicando…" : "Aplicar cambios"}
          </button>
          <button type="button" onClick={() => onDismiss(plan.id)} disabled={busy || starting} className="btn btn-sm btn-ghost">
            Ahora no
          </button>
        </div>
      )}

      {plan.status === "proposed" && dismissed && (
        <div className="border-t border-[var(--line)] px-3 py-2 text-[11px] text-[var(--muted)]">
          Plan descartado. Pídeme otro cambio cuando quieras.
        </div>
      )}

      {plan.status === "failed" && (
        <div className="border-t border-[var(--line)] px-3 py-2 text-[11px] leading-snug text-[var(--danger)]">
          Los pasos completados siguen aplicados. Puedes deshacer con Ctrl+Z si algo no encaja.
        </div>
      )}

      {plan.status === "cancelled" && (
        <div className="border-t border-[var(--line)] px-3 py-2 text-[11px] text-[var(--muted)]">
          Ejecución detenida. Se conservan los pasos ya aplicados.
        </div>
      )}
    </div>
  );
}

export function AgentPanel({
  project,
  messages,
  ai,
  planning,
  activeJob,
  confirmationPlanId,
  selectedClipIds,
  selectedMediaId,
  onPlan,
  onExecute,
  onDismissConfirmation,
  onCancel,
  onClear,
  onRefreshAi,
  onImportFiles,
  onSelectMedia,
}: AgentPanelProps) {
  const [input, setInput] = useState("");
  const [preferLocal, setPreferLocal] = useState(!ai?.chat);
  const [confirmClear, setConfirmClear] = useState(false);
  const [localMessages, setLocalMessages] = useState<AgentMessage[]>([]);
  const [dismissedPlanIds, setDismissedPlanIds] = useState<Set<string>>(new Set());
  const [resourceIntent, setResourceIntent] = useState<"upload" | "browse" | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const working = planning || Boolean(activeJob);
  const busy = working;

  const suggestions = [
    "Añade un título al principio",
    "Añade subtítulos",
    "Aumenta la velocidad 1.5x",
    "Corta los silencios",
    "Exporta en 1080p",
  ];

  const allMessages = useMemo(() => {
    const merged = [...messages, ...localMessages];
    return merged.sort((a, b) => {
      const first = Date.parse(a.at);
      const second = Date.parse(b.at);
      if (Number.isNaN(first) && Number.isNaN(second)) return 0;
      if (Number.isNaN(first)) return 1;
      if (Number.isNaN(second)) return -1;
      return first - second;
    });
  }, [messages, localMessages]);

  const visibleResources = useMemo(
    () => [...project.media].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6),
    [project.media],
  );

  const activeStep =
    activeJob?.detail && typeof activeJob.detail.stepIndex === "number" && typeof activeJob.detail.totalSteps === "number"
      ? { index: activeJob.detail.stepIndex + 1, total: activeJob.detail.totalSteps }
      : null;

  useEffect(() => {
    const node = chatRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, localMessages, planning, activeJob?.message, activeJob?.progress]);

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) importFiles(files);
  };

  const importFiles = (files: File[]) => {
    if (files.length === 0) return;
    onImportFiles(files);
    setResourceIntent("browse");
  };

  const appendLocalMessage = (message: AgentMessage) => {
    setLocalMessages((items) => [...items, message]);
  };

  const submit = () => {
    const instruction = input.trim();
    if (!instruction || busy) return;
    stickToBottomRef.current = true;
    const smallTalk = smallTalkReply(instruction);
    if (smallTalk) {
      setResourceIntent(null);
      appendLocalMessage(createAgentMessage("user", instruction));
      appendLocalMessage(createAgentMessage("assistant", smallTalk));
      setInput("");
      return;
    }
    if (requestsUpload(instruction)) {
      setResourceIntent("upload");
      appendLocalMessage(createAgentMessage("user", instruction));
      appendLocalMessage(
        createAgentMessage(
          "assistant",
          "Claro. Puedes seleccionar o arrastrar el video o la imagen aquí. Cuando termine de importarse, dime qué quieres hacer con ese recurso.",
        ),
      );
      setInput("");
      return;
    }
    setResourceIntent(requestsResourceBrowsing(instruction) ? "browse" : null);
    onPlan(instruction, preferLocal || !ai?.chat);
    setInput("");
  };

  const chooseSuggestion = (text: string) => {
    setInput(text);
    textRef.current?.focus();
  };

  const dismissPlan = (planId: string) => {
    setDismissedPlanIds((items) => new Set(items).add(planId));
    onDismissConfirmation();
  };

  return (
    <section className="h-full min-h-0 flex flex-col bg-[var(--paper)]" aria-label="Chat del agente de edición">
      <header className="shrink-0 flex items-center gap-3 border-b-2 border-[var(--ink)] bg-[var(--cream)] px-4 py-3 shadow-learn-topbar z-10">
        <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--sage-600)] text-[var(--white)] shadow-[var(--shadow-hard-sm)]">
          <Icon name="sparkles" size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-serif font-bold text-lg text-[var(--ink)] tracking-tight">Copiloto de edición</h2>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className={`h-2 w-2 rounded-full ${ai?.configured ? "bg-[var(--sage-600)]" : "bg-[var(--warning)]"}`} />
            {ai?.configured ? `IA conectada · ${ai.model}` : "Modo local · listo para ayudarte"}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefreshAi}
          className="p-1.5 rounded-xl border-2 border-[var(--ink)] bg-[var(--white)] text-[var(--ink-soft)] shadow-[var(--shadow-hard-sm)] hover:bg-[var(--sage-50)] hover:border-[var(--sage-600)] hover:text-[var(--ink)] transition-all"
          title="Actualizar estado de la IA"
          aria-label="Actualizar estado de la IA"
        >
          <Icon name="refresh" size={14} className="text-[var(--muted)] hover:text-[var(--ink)] transition-colors" />
        </button>
        <button
          type="button"
          onClick={() => setConfirmClear(true)}
          className="p-1.5 rounded-xl border-2 border-[var(--ink)] bg-[var(--white)] text-[var(--ink-soft)] shadow-[var(--shadow-hard-sm)] hover:bg-[var(--sage-50)] hover:border-[var(--sage-600)] hover:text-[var(--ink)] transition-all"
          title="Borrar historial"
          aria-label="Borrar historial"
        >
          <Icon name="trash" size={14} className="text-[var(--muted)] hover:text-[var(--ink)] transition-colors" />
        </button>
      </header>

      <div
        ref={chatRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversación con el copiloto de edición"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[var(--cream)] px-3 py-4"
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {allMessages.length === 0 && !planning && (
          <div className="rounded-[20px] border-2 border-[var(--ink)] bg-[var(--white)] p-5 shadow-[var(--shadow-hard-sm)]">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--sage-50)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--sage-700)] shadow-sm">
              <Icon name="sparkles" size={12} className="text-[var(--sage-600)]" />
              Copiloto creativo
            </span>
            <h3 className="mt-3 font-serif font-bold text-xl text-[var(--ink)] tracking-tight">¿Qué te gustaría editar?</h3>
            <p className="mt-1 text-sm leading-relaxed text-[var(--ink-soft)]">
              Cuéntame el resultado que buscas. Verás cada paso del plan, su progreso y el resultado en tiempo real.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {suggestions.map((text) => (
                <QuickChip key={text} label={text} disabled={busy} onClick={() => chooseSuggestion(text)} />
              ))}
            </div>
          </div>
        )}

        {(selectedMediaId || selectedClipIds.length > 0) && (
          <div className="flex items-center gap-2 rounded-xl border-2 border-[var(--sage-300)] bg-[var(--sage-50)] px-3 py-2 text-xs font-semibold text-[var(--sage-800)] shadow-[var(--shadow-hard-sm)]">
            <Icon name="grip" size={13} className="text-[var(--sage-600)]" />
            <span>
              Contexto: {selectedClipIds.length ? `${selectedClipIds.length} clip(s)` : ""}
              {selectedClipIds.length && selectedMediaId ? " · " : ""}
              {project.media.find((m) => m.id === selectedMediaId)?.name ?? ""}
            </span>
          </div>
        )}

        {allMessages.map((message) => {
          const isOwn = message.role === "user";
          const text = isOwn ? message.text : cleanMessageText(message.text);
          const isError = message.kind === "error";
          return (
            <div key={message.id} className="space-y-2">
              {text.length > 0 && (
                <div className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[92%] rounded-[18px] px-3 py-2.5 text-sm leading-relaxed shadow-[var(--shadow-hard-sm)] ${isOwn
                      ? "bg-[var(--sage-600)] text-[var(--white)] rounded-bl-sm"
                      : isError
                        ? "border-2 border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] rounded-tr-sm"
                        : "border-2 border-[var(--ink)] bg-[var(--white)] text-[var(--ink-soft)] rounded-tr-sm"}`}
                  >
                    {isError && (
                      <span className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
                        <Icon name="alert" size={11} />
                        No se pudo completar
                      </span>
                    )}
                    <p className="whitespace-pre-wrap break-words">{text}</p>
                    {message.at && (
                      <span className={`mt-1 block text-[10px] ${isOwn ? "text-[var(--sage-100)]" : "text-[var(--muted)]"}`}>
                        {formatClock(message.at)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {message.plan && (
                <PlanCard
                  plan={message.plan}
                  activeJob={activeJob}
                  confirmationPlanId={confirmationPlanId}
                  busy={busy}
                  dismissed={dismissedPlanIds.has(message.plan.id)}
                  onExecute={onExecute}
                  onDismiss={dismissPlan}
                />
              )}
            </div>
          );
        })}

        {resourceIntent && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">Recursos del proyecto</h3>
              <span className="text-[11px] text-[var(--muted)]">{project.media.length}</span>
            </div>

            {visibleResources.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {visibleResources.map((asset) => (
                  <ResourceCard
                    key={asset.id}
                    asset={asset}
                    selected={selectedMediaId === asset.id}
                    onSelect={() => onSelectMedia(selectedMediaId === asset.id ? null : asset.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-xl border-2 border-dashed border-[var(--line)] px-3 py-3 text-xs leading-relaxed text-[var(--muted)]">
                Todavía no hay recursos en este proyecto. Sube un video o una imagen para empezar.
              </p>
            )}

            {(resourceIntent === "upload" || visibleResources.length === 0) && (
              <>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  className="w-full cursor-pointer rounded-xl border-2 border-dashed border-[var(--line)] bg-[var(--cream)] p-3 text-center transition-colors hover:border-[var(--sage-600)]"
                >
                  <span className="mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--sage-100)] text-[var(--sage-700)]">
                    <Icon name="upload" size={15} />
                  </span>
                  <span className="block text-sm font-medium text-[var(--ink)]">Seleccionar video o imagen</span>
                  <span className="mt-0.5 block text-xs text-[var(--muted)]">Arrastra un archivo o elígelo desde el equipo</span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  multiple
                  accept="video/*,audio/*,image/*,.mp4,.mov,.mkv,.webm,.m4v,.avi,.mp3,.wav,.m4a,.aac,.flac,.ogg,.png,.jpg,.jpeg,.webp"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    importFiles(files);
                    event.target.value = "";
                  }}
                />
              </>
            )}
          </div>
        )}

        {planning && (
          <div className="flex items-start gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--sage-50)] text-[var(--sage-700)] shadow-[var(--shadow-hard-sm)]">
              <Icon name="bot" size={15} />
            </div>
            <div className="flex items-center gap-2 rounded-[18px] border-2 border-[var(--ink)] bg-[var(--white)] px-3.5 py-2.5 text-sm font-bold text-[var(--ink)] shadow-[var(--shadow-hard-sm)]">
              <Icon name="loader" size={14} className="animate-spin text-[var(--sage-600)]" />
              Entendiendo tu idea y preparando la edición…
            </div>
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-[var(--line)] px-3 pb-3 pt-2 bg-[var(--cream)]">
        {working && (
          <div className="mb-2 rounded-xl border-2 border-[var(--ink)] bg-[var(--white)] px-3 py-2 shadow-[var(--shadow-hard-sm)]">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--green-bright)] opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--sage-600)]" />
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold text-[var(--ink)]">
                {activeJob
                  ? activeStep
                    ? `Paso ${activeStep.index} de ${activeStep.total} · ${activeJob.message}`
                    : activeJob.message
                  : "Preparando el plan de edición…"}
              </span>
              {activeJob && <span className="shrink-0 tabular-nums text-[var(--muted)]">{Math.round(activeJob.progress * 100)}%</span>}
              {activeJob && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="shrink-0 rounded-md px-1.5 py-0.5 font-bold text-[var(--ink-soft)] transition-colors hover:bg-[var(--sage-100)] hover:text-[var(--ink)]"
                >
                  Detener
                </button>
              )}
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--line)]">
              <div
                className={`h-full rounded-full bg-[var(--sage-600)] transition-all ${activeJob ? "" : "animate-pulse"}`}
                style={{ width: activeJob ? `${Math.min(100, Math.max(0, activeJob.progress * 100))}%` : "100%" }}
              />
            </div>
          </div>
        )}

        <div className="rounded-[20px] border-2 border-[var(--ink)] bg-[var(--white)] p-2 focus-within:border-[var(--sage-600)] focus-within:ring-2 focus-within:ring-[var(--sage-300)]">
          <textarea
            ref={textRef}
            aria-label="Describe qué quieres editar"
            value={input}
            placeholder={busy ? "El copiloto está trabajando…" : "Describe el cambio que quieres hacer…"}
            disabled={busy}
            maxLength={4000}
            rows={2}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="max-h-32 min-h-14 w-full resize-y bg-transparent px-2 py-1 text-base leading-6 outline-none placeholder-[var(--muted)] disabled:opacity-60"
          />
          <div className="flex items-center gap-2 px-1 pt-1">
            <button
              type="button"
              disabled={!ai?.chat}
              onClick={() => setPreferLocal((value) => !value)}
              className={`btn btn-sm ${preferLocal ? "btn-soft" : "btn-ghost"}`}
              title={ai?.chat ? "Alternar entre agente local y proveedor de IA" : "No hay proveedor de IA configurado"}
            >
              {preferLocal ? "Local" : "IA"}
            </button>
            <span className="flex-1 text-[11px] text-[var(--muted)]">Enter envía · Shift+Enter nueva línea</span>
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim() || busy}
              className="btn btn-primary agent-send-button"
              aria-label="Enviar mensaje"
            >
              <Icon name={planning ? "loader" : "sparkles"} size={15} className={planning ? "animate-spin" : undefined} />
            </button>
          </div>
        </div>
      </footer>

      {confirmClear && (
        <ConfirmDialog
          title="Borrar historial del agente"
          message="Se eliminarán los mensajes y planes guardados. Las instantáneas y los cambios del montaje no se tocan."
          confirmLabel="Borrar historial"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            setLocalMessages([]);
            setResourceIntent(null);
            setDismissedPlanIds(new Set());
            onClear();
          }}
        />
      )}
    </section>
  );
}
