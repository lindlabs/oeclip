import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../shared/schema";
import type { SkillParameter } from "../shared/skills";
import { timelineDurationFrames } from "../shared/project";
import { api, ApiError, type SkillSummary } from "../api";
import { Icon, type IconName } from "./Icon";
import { ConfirmDialog, Modal } from "./Modal";

interface SkillsPanelProps {
  project: Project;
  currentFrame: number;
  disabled?: boolean;
  onRunTool: (tool: string, args: Record<string, unknown>, label: string) => Promise<void>;
  onRunWithAgent?: (skill: SkillSummary, prompt: string) => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

type RawValue = string | boolean;
type SkillDomain = "all" | "video" | "audio" | "design" | "publish";

const DOMAIN_FILTERS: Array<{ id: SkillDomain; label: string; icon: IconName }> = [
  { id: "all", label: "Todas", icon: "wand" },
  { id: "video", label: "Reels y Video", icon: "video" },
  { id: "audio", label: "Audio y Subs", icon: "music" },
  { id: "design", label: "Diseño IA", icon: "sparkles" },
  { id: "publish", label: "Export y QA", icon: "check" },
];

const CARD =
  "rounded-xl border-[1.5px] border-[var(--line-strong)] bg-[var(--white)] transition-all";
const INPUT =
  "w-full min-w-0 rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-2 text-[13px] sm:text-[12px] font-medium text-[var(--ink)] outline-none transition-all placeholder:text-[var(--muted)] focus:border-[var(--ink)] disabled:opacity-50";
const LABEL =
  "mb-1 block text-[10px] font-extrabold uppercase tracking-[0.09em] text-[var(--muted-strong)]";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function initialRaw(param: SkillParameter): RawValue {
  if (param.type === "boolean") return Boolean(param.default);
  if (param.type === "array" || param.type === "object") {
    return param.default === undefined ? "" : JSON.stringify(param.default, null, 2);
  }
  if (param.type === "color") {
    return typeof param.default === "string" ? param.default : "#22a06b";
  }
  return param.default === undefined ? "" : String(param.default);
}

function buildDraft(skill: SkillSummary): Record<string, RawValue> {
  const draft: Record<string, RawValue> = {};
  for (const param of skill.parameters) draft[param.name] = initialRaw(param);
  return draft;
}

function parseParameter(
  param: SkillParameter,
  raw: RawValue,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (param.type === "boolean") return { ok: true, value: Boolean(raw) };
  const text = typeof raw === "string" ? raw.trim() : String(raw);

  if (param.required && text === "") {
    return { ok: false, error: `"${param.label}" es obligatorio.` };
  }
  if (text === "") {
    return { ok: true, value: param.default === undefined ? "" : param.default };
  }

  switch (param.type) {
    case "number": {
      const value = Number(text.replace(",", "."));
      if (!Number.isFinite(value)) return { ok: false, error: `"${param.label}" debe ser un número.` };
      if (param.min !== undefined && value < param.min) {
        return { ok: false, error: `"${param.label}" debe ser mayor o igual a ${param.min}.` };
      }
      if (param.max !== undefined && value > param.max) {
        return { ok: false, error: `"${param.label}" debe ser menor o igual a ${param.max}.` };
      }
      return { ok: true, value };
    }
    case "array":
    case "object": {
      try {
        const value = JSON.parse(text) as unknown;
        if (param.type === "array" && !Array.isArray(value)) {
          return { ok: false, error: `"${param.label}" debe ser un array JSON.` };
        }
        if (param.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
          return { ok: false, error: `"${param.label}" debe ser un objeto JSON.` };
        }
        return { ok: true, value };
      } catch {
        return { ok: false, error: `"${param.label}" no contiene JSON válido.` };
      }
    }
    case "select":
      if (param.options && param.options.length > 0 && !param.options.includes(text)) {
        return { ok: false, error: `"${param.label}" debe ser uno de: ${param.options.join(", ")}.` };
      }
      return { ok: true, value: text };
    case "color":
      return { ok: true, value: text };
    default:
      return { ok: true, value: text };
  }
}

function isTemplateSkill(skill: SkillSummary): boolean {
  if (skill.kind === "template") return true;
  if (skill.kind === "recipe") return false;
  return skill.parameters.length > 0;
}

function classifyDomain(skill: SkillSummary): Exclude<SkillDomain, "all"> {
  const hay = `${skill.id} ${skill.category} ${skill.tags.join(" ")}`.toLowerCase();
  if (/(audio|voz|subt|caption|whisper|podcast|localiz|idioma|traduc)/.test(hay)) return "audio";
  if (/(export|qa|calidad|plataforma|contraste|auditor)/.test(hay)) return "publish";
  if (/(brand|marca|mockup|celular|dato|metric|chart|crear-skill|creaci)/.test(hay) || isTemplateSkill(skill)) {
    return "design";
  }
  return "video";
}

function iconForSkill(skill: SkillSummary): IconName {
  const hay = `${skill.id} ${skill.category} ${skill.name}`.toLowerCase();
  if (/subt|caption|texto/.test(hay)) return "type";
  if (/audio|limpieza|voz/.test(hay)) return "volume-2";
  if (/podcast|micro/.test(hay)) return "music";
  if (/brand|marca|estilo/.test(hay)) return "sparkles";
  if (/qa|audit|calidad|export/.test(hay)) return "check";
  if (/dato|metric|graf/.test(hay)) return "trending-up";
  if (/celular|iphone|mockup/.test(hay)) return "monitor";
  if (/foto|slideshow|imagen/.test(hay)) return "image";
  if (/vertical|entrevista|reel|anuncio/.test(hay)) return "video";
  return "wand";
}

interface ParsedGuideSection {
  heading?: string;
  items: string[];
}

function cleanMdText(line: string): string {
  return line
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

function parseSkillGuide(instructions?: string): ParsedGuideSection[] {
  if (!instructions) return [];
  const lines = instructions.split(/\r?\n/);
  const sections: ParsedGuideSection[] = [];
  let current: ParsedGuideSection = { items: [] };
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || !trimmed) continue;

    const headingMatch = /^#{1,4}\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      if (current.heading || current.items.length > 0) sections.push(current);
      current = { heading: cleanMdText(headingMatch[1]!), items: [] };
      continue;
    }

    const listMatch = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      current.items.push(cleanMdText(listMatch[1]!));
      continue;
    }

    if (trimmed.length >= 12 && !trimmed.startsWith("|")) {
      current.items.push(cleanMdText(trimmed));
    }
  }
  if (current.heading || current.items.length > 0) sections.push(current);
  return sections.filter((s) => s.items.length > 0).slice(0, 6);
}

function buildAgentSkillPrompt(skill: SkillSummary, customBrief: string): string {
  const trimmed = customBrief.trim();
  const baseContext = trimmed
    ? `Usa la skill "${skill.name}" (${skill.id}): ${trimmed}`
    : `Aplica la skill "${skill.name}" (${skill.id}) sobre este proyecto: ${skill.description}`;
  return baseContext;
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return "0.0s";
  return `${Math.max(0, value).toFixed(1)}s`;
}

export function SkillsPanel({
  project,
  currentFrame,
  disabled,
  onRunTool,
  onRunWithAgent,
  onToast,
}: SkillsPanelProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUploadHelp, setShowUploadHelp] = useState(false);
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<SkillDomain>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [gallerySelectedId, setGallerySelectedId] = useState<string | null>(null);
  const [galleryMobileDetail, setGalleryMobileDetail] = useState(false);
  const [agentBriefs, setAgentBriefs] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, RawValue>>>({});
  const [placement, setPlacement] = useState<"playhead" | "end">("playhead");
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<File | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.listSkills();
      setSkills(next);
      setDrafts((previous) => {
        const rebuilt: Record<string, Record<string, RawValue>> = {};
        for (const skill of next) rebuilt[skill.id] = previous[skill.id] ?? buildDraft(skill);
        return rebuilt;
      });
      setOpenId((current) => (current && next.some((skill) => skill.id === current) ? current : null));
      setGallerySelectedId((current) =>
        current && next.some((skill) => skill.id === current) ? current : (next[0]?.id ?? null),
      );
    } catch (error) {
      onToast(errorMessage(error, "No se pudieron cargar las skills."), "error");
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (domain !== "all" && classifyDomain(skill) !== domain) return false;
      if (!needle) return true;
      return [skill.name, skill.description, skill.category, skill.id, ...skill.tags, ...skill.triggers]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [domain, query, skills]);

  const upload = useCallback(
    async (file: File, overwrite = false) => {
      setUploading(true);
      try {
        const result = await api.uploadSkill(file, overwrite);
        onToast(result.summary, "success");
        await load();
        setOpenId(result.skill.id);
        setGallerySelectedId(result.skill.id);
      } catch (error) {
        if (error instanceof ApiError && error.code === "skill_exists") {
          setPendingOverwrite(file);
          return;
        }
        onToast(errorMessage(error, "No se pudo instalar la skill."), "error");
      } finally {
        setUploading(false);
      }
    },
    [load, onToast],
  );

  const remove = useCallback(
    async (skill: SkillSummary) => {
      try {
        await api.deleteSkill(skill.id);
        onToast(`Skill "${skill.name}" eliminada.`, "success");
        setOpenId((current) => (current === skill.id ? null : current));
        setGallerySelectedId((current) => (current === skill.id ? null : current));
        await load();
      } catch (error) {
        onToast(errorMessage(error, "No se pudo eliminar la skill."), "error");
      }
    },
    [load, onToast],
  );

  const applyTemplate = useCallback(
    async (skill: SkillSummary) => {
      if (disabled || applyingId) return;
      const raw = drafts[skill.id] ?? buildDraft(skill);
      const parameters: Record<string, unknown> = {};
      for (const param of skill.parameters) {
        const parsed = parseParameter(param, raw[param.name] ?? initialRaw(param));
        if (!parsed.ok) {
          onToast(parsed.error, "error");
          return;
        }
        parameters[param.name] = parsed.value;
      }

      const fps = project.settings.fps.num / project.settings.fps.den;
      const seconds =
        placement === "end"
          ? timelineDurationFrames(project) / fps
          : Math.max(0, currentFrame) / fps;
      const startSeconds = Number(seconds.toFixed(3));
      if (skill.parameters.some((param) => param.name === "startSeconds")) {
        parameters.startSeconds = startSeconds;
      }

      setApplyingId(skill.id);
      try {
        await onRunTool("run_skill", { skillId: skill.id, parameters, startSeconds }, `Skill: ${skill.name}`);
        setGalleryOpen(false);
      } catch (error) {
        onToast(errorMessage(error, "No se pudo aplicar la plantilla al proyecto."), "error");
      } finally {
        setApplyingId(null);
      }
    },
    [applyingId, currentFrame, disabled, drafts, onRunTool, onToast, placement, project],
  );

  const runRecipeWithAi = useCallback(
    (skill: SkillSummary) => {
      if (disabled) return;
      const prompt = buildAgentSkillPrompt(skill, agentBriefs[skill.id] ?? "");
      if (onRunWithAgent) {
        setGalleryOpen(false);
        onRunWithAgent(skill, prompt);
        return;
      }
      window.dispatchEvent(
        new CustomEvent("oeclip:run-skill-prompt", {
          detail: { skillId: skill.id, skillName: skill.name, prompt },
        }),
      );
      setGalleryOpen(false);
    },
    [agentBriefs, disabled, onRunWithAgent],
  );

  const renderSkillActionBody = (skill: SkillSummary, compact: boolean) => {
    const templateMode = isTemplateSkill(skill);
    const raw = drafts[skill.id] ?? buildDraft(skill);
    const busy = applyingId === skill.id;
    const guideSections = parseSkillGuide(skill.instructions);

    if (templateMode) {
      return (
        <div className="space-y-3">
          {skill.parameters.length > 0 ? (
            <div className={compact ? "space-y-2.5" : "grid grid-cols-1 sm:grid-cols-2 gap-3"}>
              {skill.parameters
                .filter((param) => param.name !== "startSeconds")
                .map((param) => {
                  const value = raw[param.name] ?? initialRaw(param);
                  if (param.type === "boolean") {
                    return (
                      <label
                        key={param.name}
                        className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--white)] px-3 py-2 text-[12px] font-semibold text-[var(--ink-soft)]"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--sage-700)]"
                          checked={Boolean(value)}
                          onChange={(event) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [skill.id]: { ...raw, [param.name]: event.target.checked },
                            }))
                          }
                        />
                        {param.label}
                      </label>
                    );
                  }
                  if (param.type === "select") {
                    return (
                      <label key={param.name} className="block">
                        <span className={LABEL}>{param.label}</span>
                        <select
                          className={INPUT}
                          value={typeof value === "string" ? value : ""}
                          onChange={(event) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [skill.id]: { ...raw, [param.name]: event.target.value },
                            }))
                          }
                        >
                          {(param.options ?? []).map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  }
                  if (param.type === "array" || param.type === "object") {
                    return (
                      <label key={param.name} className="block sm:col-span-2">
                        <span className={LABEL}>
                          {param.label} <span className="normal-case tracking-normal opacity-75">(datos)</span>
                        </span>
                        <textarea
                          className={`${INPUT} min-h-[70px] resize-y font-mono text-[11.5px] leading-snug`}
                          value={typeof value === "string" ? value : ""}
                          spellCheck={false}
                          onChange={(event) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [skill.id]: { ...raw, [param.name]: event.target.value },
                            }))
                          }
                        />
                      </label>
                    );
                  }
                  if (param.type === "color") {
                    return (
                      <label key={param.name} className="block">
                        <span className={LABEL}>{param.label}</span>
                        <span className="flex items-center gap-2">
                          <input
                            type="color"
                            className="h-9 w-11 shrink-0 cursor-pointer rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] p-0.5"
                            value={typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#22a06b"}
                            onChange={(event) =>
                              setDrafts((previous) => ({
                                ...previous,
                                [skill.id]: { ...raw, [param.name]: event.target.value },
                              }))
                            }
                          />
                          <input
                            className={INPUT}
                            value={typeof value === "string" ? value : ""}
                            spellCheck={false}
                            onChange={(event) =>
                              setDrafts((previous) => ({
                                ...previous,
                                [skill.id]: { ...raw, [param.name]: event.target.value },
                              }))
                            }
                          />
                        </span>
                      </label>
                    );
                  }
                  return (
                    <label key={param.name} className="block">
                      <span className={LABEL}>{param.label}</span>
                      <input
                        className={INPUT}
                        type={param.type === "number" ? "number" : "text"}
                        inputMode={param.type === "number" ? "decimal" : undefined}
                        step={param.type === "number" ? param.step ?? "any" : undefined}
                        min={param.type === "number" ? param.min : undefined}
                        max={param.type === "number" ? param.max : undefined}
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) =>
                          setDrafts((previous) => ({
                            ...previous,
                            [skill.id]: { ...raw, [param.name]: event.target.value },
                          }))
                        }
                      />
                    </label>
                  );
                })}
            </div>
          ) : (
            <p className="text-[12px] font-medium text-[var(--muted-strong)]">
              Plantilla lista para generar al instante con los ajustes por defecto.
            </p>
          )}

          <div className="border-t border-[var(--line)] pt-3 space-y-2.5">
            <label className="block">
              <span className={LABEL}>Dónde insertar en la línea de tiempo</span>
              <select
                className={INPUT}
                value={placement}
                onChange={(event) => setPlacement(event.target.value === "end" ? "end" : "playhead")}
              >
                <option value="playhead">
                  En el cursor actual ({formatSeconds(currentFrame / (project.settings.fps.num / project.settings.fps.den))})
                </option>
                <option value="end">Al final de la secuencia</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-md w-full justify-center shadow-[var(--shadow-hard-sm)]"
              onClick={() => void applyTemplate(skill)}
              disabled={disabled || Boolean(applyingId)}
            >
              {busy ? (
                <>
                  <Icon name="loader" size={14} className="spin" />
                  Generando clip…
                </>
              ) : (
                <>
                  <Icon name="wand" size={14} />
                  Generar clip e insertar
                </>
              )}
            </button>
          </div>
        </div>
      );
    }

    // Flujo simplificado e impactante para Recetas IA (SKILL.md)
    const previewSteps = guideSections.flatMap((sec) => sec.items).slice(0, compact ? 3 : 8);

    return (
      <div className="space-y-3">
        {skill.triggers.length > 0 && (
          <div>
            <span className={LABEL}>Ideal cuando quieres</span>
            <div className="flex flex-wrap gap-1.5">
              {skill.triggers.slice(0, compact ? 3 : 6).map((trigger) => (
                <span
                  key={trigger}
                  className="inline-flex items-center rounded-full border border-[var(--sage-300)] bg-[var(--white)] px-2.5 py-0.5 text-[10.5px] font-semibold text-[var(--sage-800)]"
                >
                  {trigger}
                </span>
              ))}
            </div>
          </div>
        )}

        {!compact && guideSections.length > 0 ? (
          <div className="space-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--white)] p-3.5">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--sage-800)]">
              Qué hace paso a paso
            </div>
            {guideSections.map((sec, sIdx) => (
              <div key={sIdx} className="space-y-1">
                {sec.heading && (
                  <p className="text-[12px] font-bold text-[var(--ink)]">{sec.heading}</p>
                )}
                <ul className="space-y-1 pl-1">
                  {sec.items.slice(0, 5).map((item, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--ink-soft)]">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sage-600)]" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          previewSteps.length > 0 && (
            <div className="rounded-xl border border-[var(--line)] bg-[var(--white)] p-2.5 space-y-1.5">
              <div className="text-[9.5px] font-extrabold uppercase tracking-[0.09em] text-[var(--sage-800)]">
                Qué hará la IA por ti
              </div>
              {previewSteps.map((step, idx) => (
                <div key={idx} className="flex items-start gap-2 text-[11.5px] leading-snug text-[var(--ink-soft)]">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--sage-150)] text-[9.5px] font-black text-[var(--sage-900)]">
                    {idx + 1}
                  </span>
                  <span className="line-clamp-2">{step}</span>
                </div>
              ))}
            </div>
          )
        )}

        <label className="block">
          <span className={LABEL}>Personaliza tu pedido (opcional)</span>
          <textarea
            rows={compact ? 2 : 3}
            className={`${INPUT} resize-y leading-snug`}
            placeholder={`Ej: Aplica "${skill.name}" con tono directo y texto grande...`}
            value={agentBriefs[skill.id] ?? ""}
            onChange={(event) =>
              setAgentBriefs((prev) => ({ ...prev, [skill.id]: event.target.value }))
            }
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm sm:btn-md flex-1 justify-center shadow-[var(--shadow-hard-sm)]"
            onClick={() => runRecipeWithAi(skill)}
            disabled={disabled}
          >
            <Icon name="sparkles" size={14} />
            <span>Aplicar con Agente IA</span>
          </button>
          {compact && (
            <button
              type="button"
              className="btn btn-soft btn-sm shrink-0"
              onClick={() => {
                setGallerySelectedId(skill.id);
                setGalleryMobileDetail(true);
                setGalleryOpen(true);
              }}
              title="Abrir guía completa en pantalla amplia"
            >
              <Icon name="maximize" size={12} />
              <span>Ver guía</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  const selectedGallerySkill =
    skills.find((s) => s.id === gallerySelectedId) ?? filtered[0] ?? skills[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      {/* Encabezado compacto */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--line)] bg-[var(--white)] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border-2 border-[var(--ink)] bg-[var(--sage-100)] text-[var(--sage-800)]">
            <Icon name="wand" size={12} />
          </span>
          <span className="font-display text-[15px] font-bold leading-none text-[var(--ink)]">Skills</span>
          <span className="rounded-full border-2 border-[var(--ink)] bg-[var(--sage-150)] px-2 py-0.5 text-[10px] font-extrabold leading-none text-[var(--sage-900)]">
            {skills.length}
          </span>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border-2 border-[var(--ink)] bg-[var(--sage-50)] px-2.5 text-[11px] font-bold text-[var(--ink)] shadow-[1.5px_1.5px_0_0_var(--ink)] transition-transform hover:-translate-y-px"
          onClick={() => {
            setGalleryMobileDetail(false);
            if (!gallerySelectedId && filtered[0]) setGallerySelectedId(filtered[0].id);
            setGalleryOpen(true);
          }}
          title="Abrir catálogo completo en pantalla amplia"
        >
          <Icon name="maximize" size={11} />
          <span>Explorar</span>
        </button>
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[var(--ink-soft)] transition-colors hover:bg-[var(--sage-100)] disabled:opacity-35"
          onClick={() => void load()}
          disabled={loading || uploading}
          title="Recargar skills"
          aria-label="Recargar skills"
        >
          <Icon name="refresh" size={13} className={loading ? "spin" : undefined} />
        </button>
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[var(--line-strong)] bg-[var(--white)] text-[var(--ink-soft)] transition-colors hover:border-[var(--ink)] hover:bg-[var(--sage-50)] disabled:opacity-40"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || uploading}
          title="Instalar nueva skill (.zip)"
          aria-label="Subir ZIP de skill"
        >
          {uploading ? <Icon name="loader" size={13} className="spin" /> : <Icon name="upload" size={13} />}
        </button>
        <button
          type="button"
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[var(--muted-strong)] transition-colors hover:bg-[var(--sage-100)] hover:text-[var(--ink)] ${
            showUploadHelp ? "bg-[var(--sage-100)] text-[var(--ink)]" : ""
          }`}
          onClick={() => setShowUploadHelp((v) => !v)}
          title="Cómo usar o instalar skills"
          aria-label="Ayuda sobre skills"
        >
          <Icon name="info" size={13} />
        </button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>

      {/* Buscador y filtros por categoría (fijos arriba, no se aplastan nunca) */}
      <div className="shrink-0 space-y-2 border-b border-[var(--line)] bg-[var(--paper)] px-3 py-2.5">
        <div className="relative">
          <Icon
            name="search"
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
          />
          <input
            className="w-full min-w-0 rounded-full border-2 border-[var(--line-strong)] bg-[var(--white)] py-1.5 pl-8 pr-3 text-[13px] sm:text-[12px] font-medium text-[var(--ink)] outline-none transition-all placeholder:text-[var(--muted)] focus:border-[var(--ink)]"
            placeholder="Buscar reel, subtítulos, audio, marca..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Buscar skills"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {DOMAIN_FILTERS.map((item) => {
            const active = domain === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setDomain(item.id)}
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-all ${
                  active
                    ? "border-[var(--ink)] bg-[var(--sage-700)] text-[var(--paper)] shadow-[1.5px_1.5px_0_0_var(--ink)]"
                    : "border-[var(--line-strong)] bg-[var(--white)] text-[var(--ink-soft)] hover:border-[var(--ink)]"
                }`}
              >
                <Icon name={item.icon} size={11} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {showUploadHelp && (
          <div className="rounded-xl border border-[var(--sage-300)] bg-[var(--white)] p-2.5 text-[11.5px] leading-relaxed text-[var(--ink-soft)]">
            <strong className="text-[var(--ink)]">¿Cómo funcionan?</strong> Elige cualquier{" "}
            <span className="font-bold text-[var(--sage-800)]">Receta IA</span> y pulsa{" "}
            <span className="font-bold text-[var(--ink)]">Aplicar con Agente IA</span> para que OECLIP la ejecute
            automáticamente. También puedes subir tu propia skill en <code>.zip</code> con el botón de subida.
          </div>
        )}
      </div>

      {/* Lista desplazable SIN flex-shrink (bloque vertical seguro en todos los dispositivos) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-2.5">
        {loading && skills.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] font-semibold text-[var(--muted-strong)]">
            <Icon name="loader" size={15} className="spin" />
            Cargando skills…
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-[var(--line-strong)] bg-[var(--white)] p-5 text-center">
            <p className="text-[12.5px] font-semibold text-[var(--muted-strong)]">
              {query.trim() || domain !== "all"
                ? "Ninguna skill coincide con ese filtro."
                : "Todavía no hay skills instaladas."}
            </p>
            {(query.trim() || domain !== "all") && (
              <button
                type="button"
                className="btn btn-soft btn-sm mt-2.5"
                onClick={() => {
                  setQuery("");
                  setDomain("all");
                }}
              >
                Ver todas las skills
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((skill) => {
              const open = openId === skill.id;
              const isTemplate = isTemplateSkill(skill);
              const skillIcon = iconForSkill(skill);
              return (
                <section
                  key={skill.id}
                  data-skill-card={skill.id}
                  className={`${CARD}${
                    open
                      ? " border-[var(--ink)] shadow-[var(--shadow-hard-sm)]"
                      : " hover:border-[var(--ink)]"
                  }`}
                >
                  <div
                    className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--sage-50)]"
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : skill.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(open ? null : skill.id);
                      }
                    }}
                  >
                    <span
                      className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border-[1.5px] border-[var(--ink)] ${
                        isTemplate
                          ? "bg-[#fef3c7] text-[#92400e]"
                          : "bg-[var(--sage-100)] text-[var(--sage-800)]"
                      }`}
                    >
                      <Icon name={skillIcon} size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate font-display text-[12.5px] font-bold leading-tight text-[var(--ink)]">
                          {skill.name}
                        </span>
                        <span
                          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-[1px] text-[8.5px] font-extrabold uppercase tracking-[0.04em] ${
                            isTemplate
                              ? "border-[#d97706]/40 bg-[#fef3c7] text-[#92400e]"
                              : "border-[var(--sage-500)]/40 bg-[var(--sage-100)] text-[var(--sage-900)]"
                          }`}
                        >
                          {isTemplate ? "Plantilla" : "IA"}
                        </span>
                      </span>
                      <span className="mt-0.5 truncate block text-[11px] font-medium leading-tight text-[var(--ink-soft)]">
                        {skill.description}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      {skill.removable && (
                        <button
                          type="button"
                          className="grid h-6 w-6 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                          title="Eliminar skill subida"
                          aria-label={`Eliminar ${skill.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteTarget(skill);
                          }}
                        >
                          <Icon name="trash" size={11} />
                        </button>
                      )}
                      <Icon
                        name={open ? "chevron-down" : "chevron-right"}
                        size={13}
                        className="text-[var(--muted-strong)]"
                      />
                    </span>
                  </div>

                  {open && (
                    <div className="border-t border-[var(--line)] bg-[var(--paper)] px-2.5 pb-3 pt-2.5 space-y-2.5">
                      <p className="text-[11.5px] font-medium leading-relaxed text-[var(--ink-soft)]">
                        {skill.description}
                      </p>
                      {!isTemplate && skill.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {skill.tags.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full border border-[var(--line-strong)] bg-[var(--white)] px-2 py-0.5 text-[9.5px] font-semibold text-[var(--muted-strong)]"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {renderSkillActionBody(skill, true)}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal amplio / adaptativo de Galería Completa de Skills (Escritorio, Tablet y Móvil) */}
      {galleryOpen && (
        <Modal
          wide
          title="Galería de Skills de OECLIP"
          kicker="Estudio autónomo"
          subtitle="Elige una receta o plantilla y aplícala a tu video en 1 clic. Sin configurar código ni comandos."
          onClose={() => setGalleryOpen(false)}
        >
          <div className="flex flex-col gap-3 min-h-0">
            {/* Barra superior de búsqueda + filtros dentro de la galería */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 shrink-0">
              <div className="relative flex-1 min-w-0">
                <Icon
                  name="search"
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
                />
                <input
                  className="w-full rounded-full border-2 border-[var(--line-strong)] bg-[var(--white)] py-2 pl-9 pr-3 text-[13px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                  placeholder="Buscar por formato, subtítulos, audio, marca..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-soft btn-sm shrink-0 justify-center"
                onClick={() => fileRef.current?.click()}
                disabled={disabled || uploading}
              >
                <Icon name="upload" size={13} />
                <span>Subir skill (.zip)</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {DOMAIN_FILTERS.map((item) => {
                const active = domain === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setDomain(item.id)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border-2 px-3 py-1 text-[11.5px] font-bold transition-all ${
                      active
                        ? "border-[var(--ink)] bg-[var(--sage-700)] text-[var(--paper)] shadow-[var(--shadow-hard-sm)]"
                        : "border-[var(--line-strong)] bg-[var(--white)] text-[var(--ink-soft)] hover:border-[var(--ink)]"
                    }`}
                  >
                    <Icon name={item.icon} size={12} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Vista Master-Detail en Tablet/Escritorio; Lista <-> Detalle limpia en Móvil */}
            <div className="grid grid-cols-1 md:grid-cols-[290px_minmax(0,1fr)] gap-3 min-h-[340px]">
              <div
                className={`${
                  galleryMobileDetail ? "hidden md:block" : "block"
                } max-h-[54dvh] md:max-h-[540px] overflow-y-auto space-y-2 p-1`}
              >
                {filtered.map((skill) => {
                  const selected = selectedGallerySkill?.id === skill.id;
                  const isTemplate = isTemplateSkill(skill);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      data-gallery-skill={skill.id}
                      onClick={() => {
                        setGallerySelectedId(skill.id);
                        setGalleryMobileDetail(true);
                      }}
                      className={`flex w-full items-center gap-2 rounded-xl border-[1.5px] px-2.5 py-2 text-left transition-all ${
                        selected
                          ? "border-[var(--ink)] bg-[var(--sage-100)] shadow-[var(--shadow-hard-sm)]"
                          : "border-[var(--line-strong)] bg-[var(--white)] hover:border-[var(--ink)]"
                      }`}
                    >
                      <span
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border-[1.5px] border-[var(--ink)] ${
                          isTemplate
                            ? "bg-[#fef3c7] text-[#92400e]"
                            : "bg-[var(--white)] text-[var(--sage-800)]"
                        }`}
                      >
                        <Icon name={iconForSkill(skill)} size={13} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-display text-[12.5px] font-bold leading-tight text-[var(--ink)]">
                          {skill.name}
                        </span>
                        <span className="mt-0.5 truncate block text-[11px] font-medium leading-tight text-[var(--ink-soft)]">
                          {skill.description}
                        </span>
                      </span>
                      <Icon name="chevron-right" size={13} className="shrink-0 text-[var(--muted-strong)] md:hidden" />
                    </button>
                  );
                })}
              </div>

              <div
                className={`${
                  galleryMobileDetail ? "block" : "hidden md:block"
                } rounded-2xl border-2 border-[var(--ink)] bg-[var(--cream)] p-4 sm:p-5 overflow-y-auto max-h-[66dvh] md:max-h-[540px]`}
              >
                {selectedGallerySkill ? (
                  <div className="space-y-4">
                    <button
                      type="button"
                      className="inline-flex md:hidden items-center gap-1.5 rounded-full border-2 border-[var(--ink)] bg-[var(--white)] px-3 py-1 text-[11.5px] font-bold text-[var(--ink)] shadow-[var(--shadow-hard-sm)]"
                      onClick={() => setGalleryMobileDetail(false)}
                    >
                      <Icon name="chevron-left" size={12} />
                      <span>Todas las skills ({filtered.length})</span>
                    </button>

                    <div className="flex items-start gap-3">
                      <span
                        className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl border-2 border-[var(--ink)] shadow-[var(--shadow-hard-sm)] ${
                          isTemplateSkill(selectedGallerySkill)
                            ? "bg-[#fef3c7] text-[#92400e]"
                            : "bg-[var(--sage-100)] text-[var(--sage-800)]"
                        }`}
                      >
                        <Icon name={iconForSkill(selectedGallerySkill)} size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-[17px] sm:text-[19px] font-bold leading-tight text-[var(--ink)]">
                            {selectedGallerySkill.name}
                          </h3>
                          <span className="rounded-full border border-[var(--ink)] bg-[var(--white)] px-2.5 py-0.5 text-[10px] font-extrabold uppercase text-[var(--sage-800)]">
                            {isTemplateSkill(selectedGallerySkill) ? "Plantilla visual" : "Receta IA"}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[12.5px] sm:text-[13px] font-medium leading-relaxed text-[var(--ink-soft)]">
                          {selectedGallerySkill.description}
                        </p>
                      </div>
                    </div>

                    {renderSkillActionBody(selectedGallerySkill, false)}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center py-10 text-center text-[13px] font-medium text-[var(--muted-strong)]">
                    Selecciona una skill de la lista para ver sus detalles y aplicarla.
                  </div>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {pendingOverwrite && (
        <ConfirmDialog
          title="Reemplazar skill existente"
          message={`Ya existe una skill con el id "${pendingOverwrite.name.replace(/\.zip$/i, "")}". ¿Quieres reemplazarla por la del ZIP?`}
          confirmLabel="Reemplazar"
          danger
          onCancel={() => setPendingOverwrite(null)}
          onConfirm={() => {
            const file = pendingOverwrite;
            setPendingOverwrite(null);
            void upload(file, true);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Eliminar skill"
          message={`¿Eliminar la skill "${deleteTarget.name}"? Esta acción borra su carpeta de skills y no se puede deshacer.`}
          confirmLabel="Eliminar"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const skill = deleteTarget;
            setDeleteTarget(null);
            void remove(skill);
          }}
        />
      )}
    </div>
  );
}
