import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MediaClip, Project, RemotionComponentSpec, TextClip, TimelineClip } from "../shared/schema";
import { formatDurationUs, formatTimecode, frameDurationUs, framesToSeconds } from "../shared/time";
import {
  addClip,
  addTrack,
  clipEnd,
  duplicateClip,
  findFreeStartFrame,
  moveClip,
  removeClips,
  setClipSpeed,
  splitClipAt,
  trimClipBy,
  updateClip,
} from "../shared/timeline";
import { getClipById, makeTextClip, touchProject } from "../shared/project";
import {
  FONT_FAMILIES,
  SUBTITLE_STYLES,
  fontFamily as fontFamilyFor,
  withSubtitleStyle,
} from "../shared/subtitles";
import {
  MOTION_PRESET_TEMPLATES,
  REMOTION_SUBTITLE_STYLES,
  applyEditableFieldChange,
  buildSubtitleComponentCode,
  extractEditableFields,
  type CaptionCueItem,
  type MotionPresetTemplate,
  type RemotionSubtitleStyleId,
} from "../shared/motionTemplates";
import { api } from "../api";
import { Icon, type IconName } from "./Icon";
import type { ProjectChangeHandler, ProjectChangeOptions, SidebarTab } from "../editorTypes";

interface InspectorProps {
  project: Project;
  currentFrame: number;
  onFrameChange?: (frame: number) => void;
  selectedClipIds: string[];
  selectedTrackId: string | null;
  disabled?: boolean;
  onProjectChange: ProjectChangeHandler;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onSelectClips: (ids: string[]) => void;
  onSelectTrack: (trackId: string | null) => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
  onAddText: (text: string, role: TextClip["role"]) => void;
  onExport: () => void;
  onSnapshot: () => void;
  onTabChange?: (tab: SidebarTab) => void;
}

function Section({ title, icon, children, actions }: { title: string; icon: IconName; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        <div className="section-title">
          <Icon name={icon} size={12} />
          {title}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function TimeField({
  label,
  value,
  min,
  max,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.max(min, Math.min(max, Math.round(parsed)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <div className="field">
      <label>{label}</label>
      <div className="number-wrap">
        <input
          className="input"
          type="number"
          inputMode="numeric"
          value={draft}
          min={min}
          max={max}
          step={1}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(String(value));
              event.currentTarget.blur();
            }
          }}
        />
        {suffix && <span>{suffix}</span>}
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  multiline,
  placeholder,
  disabled,
  maxLength,
  onCommit,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (!next) {
      setDraft(value);
      return;
    }
    if (next !== value) onCommit(next);
  };
  return (
    <div className="field">
      <label>{label}</label>
      {multiline ? (
        <textarea
          className="textarea"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          className="input"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(value);
              event.currentTarget.blur();
            }
          }}
        />
      )}
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  format,
  onStart,
  onEnd,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format?: (value: number) => string;
  onStart: () => void;
  onEnd: () => void;
  onChange: (value: number) => void;
}) {
  return (
    <div className="field">
      <div className="range-label">
        <label>{label}</label>
        <span className="range-value">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onPointerDown={onStart}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onKeyDown={onStart}
        onKeyUp={onEnd}
        onBlur={onEnd}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

function formatFrames(project: Project, frames: number): string {
  return formatTimecode(frames, project.settings.fps);
}

export function Inspector({
  project,
  currentFrame,
  onFrameChange,
  selectedClipIds,
  selectedTrackId,
  disabled,
  onProjectChange,
  onBeginEdit,
  onEndEdit,
  onSelectClips,
  onSelectTrack,
  onToast,
  onAddText,
  onExport,
  onSnapshot,
  onTabChange,
}: InspectorProps) {
  const [newText, setNewText] = useState("");
  const [newRole, setNewRole] = useState<TextClip["role"]>("title");
  const [subtitleQuery, setSubtitleQuery] = useState("");

  const found = useMemo(() => {
    for (const id of selectedClipIds) {
      const result = getClipById(project, id);
      if (result) return result;
    }
    return null;
  }, [project, selectedClipIds]);

  const clip = found?.clip ?? null;
  const track = found?.track ?? project.tracks.find((item) => item.id === selectedTrackId) ?? null;
  const selection = project.tracks.flatMap((item) => item.clips.filter((entry) => selectedClipIds.includes(entry.id)));

  const apply = (next: Project, label: string, options: ProjectChangeOptions = {}) => {
    onProjectChange(next, { label, ...options });
  };

  const patch = (updater: (clip: TimelineClip) => TimelineClip, label = "Editar clip", options: ProjectChangeOptions = {}) => {
    if (!clip) return;
    const result = updateClip(project, clip.id, updater);
    if (!result.ok) {
      if (result.error.includes("solapamiento")) onToast(result.error, "error");
      return;
    }
    apply(result.project, label, options);
  };

  const patchMedia = (updater: (clip: MediaClip) => MediaClip, label?: string, options?: ProjectChangeOptions) => {
    if (!clip || clip.type === "text") return;
    patch((current) => (current.type === "text" ? current : updater(current)), label, options);
  };

  const commitStart = (startFrame: number) => {
    if (!clip || !track) return;
    if (startFrame === clip.startFrame) return;
    const result = moveClip(project, clip.id, track.id, startFrame);
    if (!result.ok) onToast(result.error, "error");
    else apply(result.project, "Mover clip");
  };

  const commitDuration = (durationFrames: number) => {
    if (!clip) return;
    if (durationFrames === clip.durationFrames) return;
    const result = trimClipBy(project, clip.id, "end", durationFrames - clip.durationFrames);
    if (!result.ok) onToast(result.error, "error");
    else apply(result.project, "Cambiar duración");
  };

  const changeSpeed = (speed: number) => {
    if (!clip || clip.type === "text") return;
    const result = setClipSpeed(project, clip.id, speed);
    if (!result.ok) onToast(result.error, "error");
    else apply(result.project, "Cambiar velocidad");
  };

  const splitHere = () => {
    if (!clip) return;
    const result = splitClipAt(project, clip.id, currentFrame);
    if (!result.ok) {
      onToast(result.error, "error");
      return;
    }
    apply(result.project, "Dividir clip");
    if (result.rightId) onSelectClips([result.rightId]);
    onToast("Clip dividido en el cursor.", "success");
  };

  const duplicate = () => {
    if (!clip) return;
    const result = duplicateClip(project, clip.id);
    if (!result.ok) {
      onToast(result.error, "error");
      return;
    }
    apply(result.project, "Duplicar clip");
    if (result.newClipId) onSelectClips([result.newClipId]);
  };

  const removeSelection = () => {
    if (selectedClipIds.length === 0) return;
    const result = removeClips(project, selectedClipIds);
    if (!result.ok) {
      onToast(result.error, "error");
      return;
    }
    apply(result.project, selectedClipIds.length > 1 ? "Eliminar clips" : "Eliminar clip");
    onSelectClips([]);
  };

  const media = clip && clip.type !== "text" ? project.media.find((asset) => asset.id === clip.mediaId) : undefined;
  const canSplit = Boolean(clip && currentFrame > clip.startFrame && currentFrame < clipEnd(clip));

  const insertPresetTemplate = (preset: MotionPresetTemplate) => {
    let nextProject = project;
    let targetTrack = nextProject.tracks.find((t) => t.kind === "text" && !t.locked);
    if (!targetTrack) {
      const added = addTrack(nextProject, "text", "Capa Motion");
      if (added.ok && added.track) {
        nextProject = added.project;
        targetTrack = added.track;
      }
    }
    if (!targetTrack) {
      onToast("No hay pista disponible para insertar la plantilla.", "error");
      return;
    }
    const startFrame = findFreeStartFrame(targetTrack, currentFrame, preset.durationFrames);
    const remotionSpec: RemotionComponentSpec = {
      code: preset.code,
      componentName: preset.componentName,
      compositionId: preset.compositionId,
      props: { ...preset.defaultProps },
      live: true,
    };
    const newClip = makeTextClip({
      name: preset.label,
      text: String(preset.defaultProps.title ?? preset.defaultProps.label ?? preset.defaultProps.handle ?? preset.label),
      startFrame,
      durationFrames: preset.durationFrames,
      role: "title",
      createdBy: "agent",
      remotion: remotionSpec,
    });
    const res = addClip(nextProject, targetTrack.id, newClip);
    if (!res.ok) {
      onToast(res.error, "error");
      return;
    }
    apply(res.project, `Insertar plantilla ${preset.label}`);
    onSelectClips([newClip.id]);
    onToast(`Plantilla "${preset.label}" insertada en vivo (0ms)`, "success");
  };

  // Hidrata automáticamente el código/props Remotion para clips .webm insertados previamente
  useEffect(() => {
    if (!clip || clip.remotion) return;
    const isLegacyMotion =
      clip.type !== "text" &&
      ((track?.name ?? "").startsWith("Motion Overlay") ||
        (clip.createdBy === "agent" && (/\.webm$/i.test(clip.name) || (media ? /\.webm$/i.test(media.name) : false))));
    if (!isLegacyMotion) return;

    let cancelled = false;
    const applyFoundComponent = (comp?: {
      code?: string;
      name?: string;
      compositionId?: string;
      props?: Record<string, unknown>;
    } | null) => {
      if (cancelled || !comp?.code || !comp.name) return false;
      const cleanClipName = clip.name.replace(/\.webm$/i, "").toLowerCase();
      const compName = comp.name.replace(/\.webm$/i, "").toLowerCase();
      const isBothSubtitles =
        /subtit|caption|subs/i.test(cleanClipName) && /subtit|caption|subs/i.test(compName);
      if (cleanClipName === compName || isBothSubtitles) {
        const remotionSpec: RemotionComponentSpec = {
          code: comp.code,
          componentName: comp.name,
          compositionId: comp.compositionId || comp.name,
          props: comp.props ?? {},
          styleId: isBothSubtitles ? "minimal" : undefined,
          live: false,
        };
        const updated = updateClip(project, clip.id, (curr) => ({
          ...curr,
          remotion: remotionSpec,
        }));
        if (updated.ok) {
          onProjectChange(updated.project, { history: false, save: true });
          return true;
        }
      }
      return false;
    };

    try {
      const raw = window.localStorage.getItem(`novacut.motion.history.${project.id}`);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          lastComponent?: {
            code?: string;
            name?: string;
            compositionId?: string;
            props?: Record<string, unknown>;
          } | null;
        };
        if (applyFoundComponent(parsed.lastComponent)) {
          return () => {
            cancelled = true;
          };
        }
      }
    } catch {
      // Ignorar lectura localStorage
    }

    void api
      .request<{
        lastComponent?: {
          code?: string;
          name?: string;
          compositionId?: string;
          props?: Record<string, unknown>;
        } | null;
      }>(`/projects/${encodeURIComponent(project.id)}/motion/history`)
      .then((saved) => {
        applyFoundComponent(saved?.lastComponent);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clip, track?.name, media, project, onProjectChange]);

  if (selectedClipIds.length > 1) {
    return (
      <div className="inspector-pane">
        <div className="inspector-empty" style={{ paddingBottom: 16 }}>
          <div className="empty-icon">
            <Icon name="layers" size={20} />
          </div>
          <strong>{selectedClipIds.length} clips seleccionados</strong>
          <span>Los ajustes de composición se aplican de uno en uno.</span>
        </div>
        <Section title="Selección" icon="layers">
          <div className="selected-list">
            {selection.map((item) => (
              <div className="selected-row" key={item.id}>
                <Icon name={item.type === "text" ? "type" : item.type === "audio" ? "music" : "film"} size={12} />
                <span>{item.type === "text" ? item.text : item.name}</span>
              </div>
            ))}
          </div>
          <div className="mini-actions" style={{ marginTop: 10 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => onSelectClips([selectedClipIds[0]!])}>
              Editar el primero
            </button>
            <button className="btn btn-danger btn-sm" onClick={removeSelection} disabled={disabled}>
              <Icon name="trash" size={13} />
              Eliminar
            </button>
          </div>
        </Section>
      </div>
    );
  }

  if (!clip) {
    const durationFrames = project.tracks.reduce(
      (max, item) => Math.max(max, ...item.clips.map((entry) => entry.startFrame + entry.durationFrames), 0),
      0,
    );
    return (
      <div className="inspector-pane">
        <div className="inspector-empty">
          <div className="empty-icon">
            <Icon name="sliders" size={20} />
          </div>
          <strong>Nada seleccionado</strong>
          <span>Selecciona un clip en la línea de tiempo para ajustar su composición, audio o texto.</span>
        </div>

        <Section title="Proyecto" icon="film">
          <div className="overview-list">
            <div className="capability-row">
              <span>Resolución</span>
              <strong>
                {project.settings.width} x {project.settings.height}
              </strong>
            </div>
            <div className="capability-row">
              <span>Formato</span>
              <strong>{project.settings.aspect}</strong>
            </div>
            <div className="capability-row">
              <span>Fotogramas por segundo</span>
              <strong>{project.settings.fps.num / project.settings.fps.den} fps</strong>
            </div>
            <div className="capability-row">
              <span>Duración</span>
              <strong>{formatSeconds(framesToSeconds(durationFrames, project.settings.fps))}</strong>
            </div>
            <div className="capability-row">
              <span>Revisión guardada</span>
              <strong>{project.revision}</strong>
            </div>
            <div className="capability-row">
              <span>Recursos y pistas</span>
              <strong>
                {project.media.length} / {project.tracks.length}
              </strong>
            </div>
          </div>
          <div className="mini-actions" style={{ marginTop: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={onSnapshot}>
              <Icon name="history" size={13} />
              Instantánea
            </button>
            <button className="btn btn-soft btn-sm" onClick={onExport}>
              <Icon name="download" size={13} />
              Exportar
            </button>
          </div>
        </Section>

        <Section title="Añadir texto" icon="type">
          <div className="field">
            <label>Contenido</label>
            <textarea
              className="textarea"
              rows={2}
              placeholder="Escribe un título, subtítulo o rótulo"
              value={newText}
              maxLength={2000}
              onChange={(event) => setNewText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && newText.trim()) {
                  event.preventDefault();
                  onAddText(newText.trim(), newRole);
                  setNewText("");
                }
              }}
            />
          </div>
          <div className="field" style={{ marginTop: 9 }}>
            <label>Tipo</label>
            <div className="segmented">
              {(["title", "subtitle", "caption"] as const).map((role) => (
                <button
                  key={role}
                  className={newRole === role ? "active" : ""}
                  onClick={() => setNewRole(role)}
                  disabled={disabled}
                >
                  {role === "title" ? "Título" : role === "subtitle" ? "Subtítulo" : "Rótulo"}
                </button>
              ))}
            </div>
          </div>
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: 10, width: "100%" }}
            disabled={!newText.trim() || disabled}
            onClick={() => {
              onAddText(newText.trim(), newRole);
              setNewText("");
            }}
          >
            <Icon name="plus" size={14} />
            Insertar en el cursor
          </button>
          <p className="field-hint" style={{ marginTop: 7 }}>
            {formatFrames(project, currentFrame)} · Se coloca en la primera pista de texto libre.
          </p>
        </Section>

        <Section title="Plantillas Motion Remotion (En Vivo)" icon="sparkles">
          <p className="field-hint" style={{ marginBottom: 8 }}>
            Inserta gráficos animados nativos en 0ms y personaliza sus textos y colores directamente en el monitor.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {MOTION_PRESET_TEMPLATES.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={disabled}
                onClick={() => insertPresetTemplate(preset)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 3,
                  padding: "8px 9px",
                  borderRadius: 10,
                  border: "1.5px solid var(--line-strong)",
                  background: "var(--paper)",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#92400E",
                    background: "#FEF3C7",
                    padding: "1px 5px",
                    borderRadius: 4,
                  }}
                >
                  {preset.badge}
                </span>
                <strong style={{ fontSize: 11.5, color: "var(--ink)", lineHeight: 1.2 }}>
                  {preset.label}
                </strong>
                <span style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.25 }}>
                  {preset.description.slice(0, 52)}...
                </span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Atajos" icon="info">
          <div className="shortcut-list">
            <span>
              <kbd>Espacio</kbd> Reproducir
            </span>
            <span>
              <kbd>S</kbd> Dividir
            </span>
            <span>
              <kbd>Supr</kbd> Eliminar
            </span>
            <span>
              <kbd>Ctrl</kbd>+<kbd>Z</kbd> Deshacer
            </span>
            <span>
              <kbd>Ctrl</kbd>+<kbd>S</kbd> Guardar
            </span>
            <span>
              <kbd>Ctrl</kbd>+<kbd>E</kbd> Exportar
            </span>
          </div>
        </Section>
      </div>
    );
  }

  const isMotionComponent =
    Boolean(clip.remotion) ||
    (clip.type !== "text" &&
      ((track?.name ?? "").startsWith("Motion Overlay") ||
        (clip.createdBy === "agent" && (/\.webm$/i.test(clip.name) || (media ? /\.webm$/i.test(media.name) : false)))));
  const isSubtitleMotion =
    isMotionComponent &&
    (Array.isArray(clip.remotion?.props?.captions) || /subtit|caption|subs\b/i.test(clip.name));
  const kindLabel = isSubtitleMotion
    ? "Subtítulos Dinámicos IA"
    : isMotionComponent
      ? "Componente Motion TSX"
      : clip.type === "audio"
        ? "Audio"
        : clip.type === "text"
          ? "Texto"
          : clip.type === "image"
            ? "Imagen"
            : "Video";
  const displayClipTitle = clip.remotion
    ? (clip.name || clip.remotion.componentName).replace(/\.webm$/i, "")
    : clip.type === "text"
      ? clip.text
      : isMotionComponent
        ? clip.name.replace(/\.webm$/i, "")
        : clip.name;
  const displayTrackName = (track?.name ?? "Pista").replace("Motion Overlay", "Capa Motion");
  const sourceDuration = clip.type === "text" ? 0 : (clip.sourceOutUs - clip.sourceInUs) / 1_000_000;
  const isMedia = clip.type !== "text";
  const activeRemotion = clip.remotion;
  const remotionCaptions = Array.isArray(activeRemotion?.props?.captions)
    ? (activeRemotion!.props.captions as CaptionCueItem[])
    : null;
  const editableRemotionFields = activeRemotion && !remotionCaptions ? extractEditableFields(activeRemotion) : [];

  const updateRemotionSpec = (
    updater: (spec: RemotionComponentSpec) => RemotionComponentSpec,
    label = "Editar componente Motion",
    options: ProjectChangeOptions = { history: false, save: true },
  ) => {
    if (!activeRemotion) return;
    const nextSpec = updater(activeRemotion);
    patch(
      (current) => ({
        ...current,
        remotion: { ...nextSpec, live: true },
      }),
      label,
      options,
    );
  };

  return (
    <div className="inspector-pane">
      <div className="clip-summary">
        <div className="clip-summary-thumb">
          {clip.type !== "text" && media && !isMotionComponent ? (
            <img src={api.thumbnailUrl(project.id, media.id)} alt="" onError={(event) => (event.currentTarget.style.display = "none")} />
          ) : (
            <Icon
              name={
                clip.type === "text" || isSubtitleMotion
                  ? "type"
                  : isMotionComponent
                    ? "sparkles"
                    : clip.type === "audio"
                      ? "music"
                      : "film"
              }
              size={18}
            />
          )}
        </div>
        <div className="clip-summary-text">
          <span className="clip-summary-title">{displayClipTitle}</span>
          <span className="clip-summary-meta">
            {kindLabel} · {displayTrackName}
          </span>
          <span className="clip-summary-meta">
            {formatFrames(project, clip.startFrame)} → {formatFrames(project, clipEnd(clip))}
          </span>
        </div>
        {clip.createdBy === "agent" && <span className="tag">{isMotionComponent ? "TSX" : "IA"}</span>}
      </div>

      {onTabChange && (
        <button
          type="button"
          onClick={() => {
            onSelectClips([clip.id]);
            onTabChange("motion");
            window.setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent("oeclip:attach-clip", {
                  detail: { clipId: clip.id },
                }),
              );
            }, 40);
          }}
          className="btn btn-primary btn-sm"
          style={{ width: "100%", justifyContent: "center", gap: 6, marginBottom: 4 }}
          title="Adjuntar este elemento al Chat IA para pedirle que lo reduzca, mejore, modifique o elimine"
        >
          <Icon name="wand" size={13} />
          <span>Adjuntar al Chat IA para modificar / reducir / eliminar</span>
        </button>
      )}

      <Section
        title="Tiempo"
        icon="clock"
        actions={
          <div className="mini-actions">
            {canSplit && (
              <button className="btn btn-ghost btn-icon btn-sm" onClick={splitHere} title="Dividir en el cursor" disabled={disabled}>
                <Icon name="scissors" size={13} />
              </button>
            )}
            <button className="btn btn-ghost btn-icon btn-sm" onClick={duplicate} title="Duplicar clip" disabled={disabled}>
              <Icon name="duplicate" size={13} />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={removeSelection} title="Eliminar clip" disabled={disabled}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        }
      >
        <div className="field-row">
          <TimeField
            label="Inicio"
            value={clip.startFrame}
            min={0}
            max={1_000_000}
            suffix="f"
            disabled={disabled}
            onCommit={commitStart}
          />
          <TimeField
            label="Duración"
            value={clip.durationFrames}
            min={1}
            max={1_000_000}
            suffix="f"
            disabled={disabled}
            onCommit={commitDuration}
          />
        </div>
        <div className="time-readout">
          <span>{formatSeconds(framesToSeconds(clip.durationFrames, project.settings.fps))}</span>
          {isMedia && (
            <span>
              Origen {formatDurationUs(clip.sourceInUs)} – {formatDurationUs(clip.sourceOutUs)} · {sourceDuration.toFixed(2)} s
            </span>
          )}
        </div>
        {isMedia && (
          <div className="field" style={{ marginTop: 10 }}>
            <label>Velocidad</label>
            <select
              className="select"
              value={Number(clip.speed.toFixed(2))}
              disabled={disabled}
              onChange={(event) => changeSpeed(Number(event.target.value))}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((speed) => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
            <p className="field-hint">La duración se recalcula automáticamente y no puede solaparse con el siguiente clip.</p>
          </div>
        )}
      </Section>

      {activeRemotion && remotionCaptions && (
        <>
          <Section title="Plantilla de Subtítulos (En Vivo)" icon="sparkles">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {REMOTION_SUBTITLE_STYLES.map((style) => {
                const isActive =
                  activeRemotion.styleId === style.id ||
                  (!activeRemotion.styleId &&
                    activeRemotion.componentName.toLowerCase().includes(style.id));
                return (
                  <button
                    key={style.id}
                    type="button"
                    disabled={disabled}
                    title={style.description}
                    onClick={() => {
                      const built = buildSubtitleComponentCode(style.id);
                      updateRemotionSpec(
                        (spec) => ({
                          ...spec,
                          code: built.code,
                          componentName: built.componentName,
                          styleId: style.id,
                          props: {
                            ...spec.props,
                            accentColor: style.accentColor,
                          },
                          live: true,
                        }),
                        `Cambiar estilo de subtítulos a ${style.label}`,
                        { history: true, save: true },
                      );
                      onToast(`Plantilla "${style.label}" aplicada en vivo (0ms)`, "success");
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 4,
                      padding: "7px 8px",
                      borderRadius: 10,
                      border: isActive ? "2px solid var(--ink)" : "1px solid var(--line-strong)",
                      background: isActive ? "var(--sage-100)" : "var(--paper)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ fontSize: 11, color: "var(--ink)" }}>{style.label}</strong>
                      <span
                        style={{
                          fontSize: 8.5,
                          fontWeight: 800,
                          textTransform: "uppercase",
                          padding: "1px 4px",
                          borderRadius: 4,
                          background: style.accentColor,
                          color: "#111",
                        }}
                      >
                        {style.badge}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 800,
                        padding: "2px 6px",
                        borderRadius: 5,
                        background: style.previewBg,
                        color: style.previewText,
                      }}
                    >
                      que bueno <span style={{ color: style.accentColor }}>verde</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="field-hint" style={{ marginTop: 7 }}>
              Cambia de plantilla al instante (0ms). Se renderiza en vivo sobre el monitor con Remotion.
            </p>

            <div className="field-row" style={{ marginTop: 9 }}>
              <div className="field">
                <label>Color de acento</label>
                <div className="color-row">
                  <input
                    type="color"
                    value={String(activeRemotion.props.accentColor ?? "#F59E0B")}
                    disabled={disabled}
                    onFocus={onBeginEdit}
                    onBlur={onEndEdit}
                    onChange={(e) =>
                      updateRemotionSpec(
                        (spec) => ({ ...spec, props: { ...spec.props, accentColor: e.target.value } }),
                        "Color de acento de subtítulos",
                      )
                    }
                  />
                  <span className="mono">{String(activeRemotion.props.accentColor ?? "#F59E0B").toUpperCase()}</span>
                </div>
              </div>
              <div className="field">
                <label>Color de texto</label>
                <div className="color-row">
                  <input
                    type="color"
                    value={String(activeRemotion.props.textColor ?? "#FFFFFF")}
                    disabled={disabled}
                    onFocus={onBeginEdit}
                    onBlur={onEndEdit}
                    onChange={(e) =>
                      updateRemotionSpec(
                        (spec) => ({ ...spec, props: { ...spec.props, textColor: e.target.value } }),
                        "Color de texto de subtítulos",
                      )
                    }
                  />
                  <span className="mono">{String(activeRemotion.props.textColor ?? "#FFFFFF").toUpperCase()}</span>
                </div>
              </div>
            </div>

            <div className="field-row" style={{ marginTop: 8 }}>
              <RangeField
                label="Escala de texto"
                value={(() => {
                  const raw = Number(activeRemotion.props.fontScale ?? 1);
                  return raw > 5 ? raw / 100 : raw;
                })()}
                min={0.4}
                max={2.4}
                step={0.02}
                disabled={disabled}
                format={(v) => `${Math.round(v * 100)}%`}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(fontScale) =>
                  updateRemotionSpec(
                    (spec) => ({ ...spec, props: { ...spec.props, fontScale } }),
                    "Escala de subtítulos",
                  )
                }
              />
              <RangeField
                label="Posición Y"
                value={(() => {
                  const raw = Number(activeRemotion.props.positionY ?? 0.88);
                  return raw > 1.5 ? raw / 100 : raw;
                })()}
                min={0.15}
                max={0.95}
                step={0.01}
                disabled={disabled}
                format={(v) => `${Math.round(v * 100)}%`}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(positionY) =>
                  updateRemotionSpec(
                    (spec) => ({ ...spec, props: { ...spec.props, positionY } }),
                    "Posición vertical de subtítulos",
                  )
                }
              />
            </div>

            <RangeField
              label="Opacidad de caja / fondo"
              value={Number(activeRemotion.props.bgOpacity ?? 0.56)}
              min={0}
              max={0.95}
              step={0.02}
              disabled={disabled}
              format={(v) => `${Math.round(v * 100)}%`}
              onStart={onBeginEdit}
              onEnd={onEndEdit}
              onChange={(bgOpacity) =>
                updateRemotionSpec(
                  (spec) => ({ ...spec, props: { ...spec.props, bgOpacity } }),
                  "Opacidad de fondo de subtítulos",
                )
              }
            />
          </Section>

          <Section
            title={`Bloques de Subtítulo (${remotionCaptions.length})`}
            icon="type"
          >
            <div className="field" style={{ marginBottom: 8 }}>
              <input
                className="input"
                placeholder="Buscar palabra o bloque en la transcripción..."
                value={subtitleQuery}
                onChange={(e) => setSubtitleQuery(e.target.value)}
              />
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                maxHeight: 280,
                overflowY: "auto",
                paddingRight: 2,
              }}
            >
              {remotionCaptions.map((cue, cueIndex) => {
                const phrase = cue.words.map((w) => w.text).join(" ");
                if (
                  subtitleQuery.trim() &&
                  !phrase.toLowerCase().includes(subtitleQuery.trim().toLowerCase())
                ) {
                  return null;
                }
                const localFrame = currentFrame - clip.startFrame;
                const isCueActive = localFrame >= cue.start && localFrame < cue.end;
                return (
                  <div
                    key={`${cue.start}-${cueIndex}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                      padding: "7px 8px",
                      borderRadius: 9,
                      border: isCueActive
                        ? "1.5px solid #F59E0B"
                        : "1px solid var(--line)",
                      background: isCueActive ? "rgba(245, 158, 11, 0.1)" : "var(--paper)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => onFrameChange?.(clip.startFrame + cue.start)}
                        title="Ir a este instante en el timeline"
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: 5,
                          border: "1px solid var(--line-strong)",
                          background: isCueActive ? "#F59E0B" : "var(--bg)",
                          color: isCueActive ? "#111" : "var(--ink-soft)",
                          cursor: "pointer",
                        }}
                      >
                        {formatFrames(project, clip.startFrame + cue.start)}
                      </button>
                      <span style={{ fontSize: 9.5, color: "var(--muted)" }}>
                        F:{cue.start}–{cue.end} ({cue.words.length} pal.)
                      </span>
                    </div>
                    <input
                      className="input"
                      style={{ height: 27, fontSize: 11.5 }}
                      value={phrase}
                      disabled={disabled}
                      onChange={(e) => {
                        const tokens = e.target.value.split(/\s+/).filter(Boolean);
                        if (tokens.length === 0) return;
                        const span = Math.max(1, cue.end - cue.start);
                        const step = span / tokens.length;
                        const nextWords = tokens.map((tok, idx) => ({
                          text: tok,
                          start: Math.round(cue.start + idx * step),
                          end: Math.max(
                            Math.round(cue.start + idx * step) + 1,
                            Math.round(cue.start + (idx + 1) * step),
                          ),
                          highlight: cue.words[idx]?.highlight,
                        }));
                        const nextCaptions = remotionCaptions.map((item, idx) =>
                          idx === cueIndex ? { ...item, words: nextWords } : item,
                        );
                        updateRemotionSpec(
                          (spec) => ({
                            ...spec,
                            props: { ...spec.props, captions: nextCaptions },
                          }),
                          "Editar texto de subtítulo",
                        );
                      }}
                    />
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {cue.words.map((word, wordIdx) => (
                        <button
                          key={`${wordIdx}-${word.text}`}
                          type="button"
                          title="Click para resaltar / quitar acento de palabra clave"
                          onClick={() => {
                            const nextCaptions = remotionCaptions.map((item, idx) =>
                              idx === cueIndex
                                ? {
                                    ...item,
                                    words: item.words.map((w, wIdx) =>
                                      wIdx === wordIdx ? { ...w, highlight: !w.highlight } : w,
                                    ),
                                  }
                                : item,
                            );
                            updateRemotionSpec(
                              (spec) => ({
                                ...spec,
                                props: { ...spec.props, captions: nextCaptions },
                              }),
                              "Resaltar palabra clave",
                              { history: true, save: true },
                            );
                          }}
                          style={{
                            fontSize: 10,
                            fontWeight: word.highlight ? 800 : 600,
                            padding: "1px 6px",
                            borderRadius: 999,
                            border: word.highlight ? "1px solid #D97706" : "1px solid var(--line)",
                            background: word.highlight ? "#FEF3C7" : "var(--bg)",
                            color: word.highlight ? "#92400E" : "var(--ink-soft)",
                            cursor: "pointer",
                          }}
                        >
                          {word.text}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="field-hint" style={{ marginTop: 6 }}>
              Edita cualquier bloque en vivo o haz clic en una píldora de palabra para marcarla con color de acento.
            </p>
          </Section>
        </>
      )}

      {activeRemotion && !remotionCaptions && (
        <Section title="Propiedades del Componente (En Vivo)" icon="sparkles">
          <p className="field-hint" style={{ marginBottom: 8 }}>
            Edita los textos, métricas y colores del componente Remotion en tiempo real sin re-renderizar video.
          </p>
          {editableRemotionFields.length === 0 ? (
            <p className="field-hint">Este componente no expone parámetros editables adicionales.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {editableRemotionFields.map((field) => {
                if (field.type === "color") {
                  return (
                    <div className="field" key={field.key}>
                      <label>{field.label}</label>
                      <div className="color-row">
                        <input
                          type="color"
                          value={String(field.value)}
                          disabled={disabled}
                          onFocus={onBeginEdit}
                          onBlur={onEndEdit}
                          onChange={(e) =>
                            updateRemotionSpec(
                              (spec) => applyEditableFieldChange(spec, field, e.target.value),
                              `Cambiar ${field.label}`,
                            )
                          }
                        />
                        <span className="mono">{String(field.value).toUpperCase()}</span>
                      </div>
                    </div>
                  );
                }
                if (field.type === "number") {
                  return (
                    <RangeField
                      key={field.key}
                      label={field.label}
                      value={Number(field.value)}
                      min={field.min ?? 0}
                      max={field.max ?? 500}
                      step={field.step ?? 1}
                      disabled={disabled}
                      onStart={onBeginEdit}
                      onEnd={onEndEdit}
                      onChange={(val) =>
                        updateRemotionSpec(
                          (spec) => applyEditableFieldChange(spec, field, val),
                          `Ajustar ${field.label}`,
                        )
                      }
                    />
                  );
                }
                return (
                  <div className="field" key={field.key}>
                    <label>{field.label}</label>
                    <input
                      className="input"
                      value={String(field.value)}
                      disabled={disabled}
                      onChange={(e) =>
                        updateRemotionSpec(
                          (spec) => applyEditableFieldChange(spec, field, e.target.value),
                          `Editar ${field.label}`,
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {clip.type === "text" && !clip.remotion && (
        <>
          <Section title="Texto" icon="type">
            <TextField
              label="Contenido"
              value={clip.text}
              multiline
              maxLength={2000}
              disabled={disabled}
              onCommit={(text) => patch((current) => (current.type === "text" ? { ...current, text, name: text.slice(0, 60) } : current), "Editar texto")}
            />
            <div className="field" style={{ marginTop: 9 }}>
              <label>Función</label>
              <div className="segmented">
                {(["title", "subtitle", "caption"] as const).map((role) => (
                  <button
                    key={role}
                    className={clip.role === role ? "active" : ""}
                    disabled={disabled}
                    onClick={() =>
                      patch((current) => (current.type === "text" ? { ...current, role } : current), "Cambiar tipo de texto")
                    }
                  >
                    {role === "title" ? "Título" : role === "subtitle" ? "Subtítulo" : "Rótulo"}
                  </button>
                ))}
              </div>
            </div>
            <div className="field-row" style={{ marginTop: 9 }}>
              <RangeField
                label="Tamaño"
                value={clip.fontSize}
                min={8}
                max={220}
                step={1}
                disabled={disabled}
                format={(value) => `${Math.round(value)} px`}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(fontSize) => patch((current) => (current.type === "text" ? { ...current, fontSize } : current), "Tamaño de texto", { history: false, save: false })}
              />
              <div className="field">
                <label>Peso</label>
                <select
                  className="select"
                  value={clip.fontWeight}
                  disabled={disabled}
                  onChange={(event) =>
                    patch(
                      (current) =>
                        current.type === "text"
                          ? { ...current, fontWeight: Number(event.target.value) as TextClip["fontWeight"] }
                          : current,
                      "Peso tipográfico",
                    )
                  }
                >
                  <option value={400}>Regular 400</option>
                  <option value={500}>Medium 500</option>
                  <option value={600}>Semibold 600</option>
                  <option value={700}>Bold 700</option>
                </select>
              </div>
            </div>
            <div className="field-row" style={{ marginTop: 9 }}>
              <RangeField
                label="Ancho máximo"
                value={clip.maxWidth}
                min={0.2}
                max={1}
                step={0.01}
                disabled={disabled}
                format={(value) => `${Math.round(value * 100)}%`}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(maxWidth) =>
                  patch((current) => (current.type === "text" ? { ...current, maxWidth } : current), "Ancho de texto", {
                    history: false,
                    save: false,
                  })
                }
              />
              <RangeField
                label="Interlineado"
                value={clip.lineHeight}
                min={0.8}
                max={2}
                step={0.01}
                disabled={disabled}
                format={(value) => value.toFixed(2)}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(lineHeight) =>
                  patch((current) => (current.type === "text" ? { ...current, lineHeight } : current), "Interlineado", {
                    history: false,
                    save: false,
                  })
                }
              />
            </div>
            <div className="field-row" style={{ marginTop: 9 }}>
              <div className="field">
                <label>Color</label>
                <div className="color-row">
                  <input
                    type="color"
                    value={clip.color}
                    disabled={disabled}
                    onFocus={onBeginEdit}
                    onBlur={onEndEdit}
                    onChange={(event) =>
                      patch((current) => (current.type === "text" ? { ...current, color: event.target.value } : current), "Color de texto", {
                        history: false,
                        save: false,
                      })
                    }
                  />
                  <span className="mono">{clip.color.toUpperCase()}</span>
                </div>
              </div>
              <RangeField
                label="Fundido"
                value={clip.fadeFrames}
                min={0}
                max={60}
                step={1}
                disabled={disabled}
                format={(value) => `${Math.round(value)} f`}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(fadeFrames) =>
                  patch((current) => (current.type === "text" ? { ...current, fadeFrames } : current), "Fundido de texto", {
                    history: false,
                    save: false,
                  })
                }
              />
            </div>
            <div className="field" style={{ marginTop: 9 }}>
              <label>Alineación</label>
              <div className="segmented">
                {(["left", "center", "right"] as const).map((align) => (
                  <button
                    key={align}
                    className={clip.align === align ? "active" : ""}
                    disabled={disabled}
                    onClick={() => patch((current) => (current.type === "text" ? { ...current, align } : current), "Alinear texto")}
                  >
                    {align === "left" ? "Izquierda" : align === "center" ? "Centro" : "Derecha"}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ marginTop: 9 }}>
              <label>Posición</label>
              <div className="mini-actions">
                {[
                  { label: "Superior", x: 0.5, y: 0.16 },
                  { label: "Centro", x: 0.5, y: 0.5 },
                  { label: "Tercio inferior", x: 0.5, y: 0.8 },
                  { label: "Inferior", x: 0.5, y: 0.92 },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    className={`chip${Math.abs(clip.position.y - preset.y) < 0.02 ? " active" : ""}`}
                    disabled={disabled}
                    onClick={() =>
                      patch((current) => (current.type === "text" ? { ...current, position: { x: preset.x, y: preset.y } } : current), "Mover texto")
                    }
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ marginTop: 9 }}>
              <label>Fondo</label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={clip.background}
                  disabled={disabled}
                  onChange={(event) =>
                    patch((current) => (current.type === "text" ? { ...current, background: event.target.checked } : current), "Fondo de texto")
                  }
                />
                <span>Caja de fondo para mejorar la legibilidad</span>
              </label>
            </div>
            {clip.background && (
              <RangeField
                label="Opacidad del fondo"
                value={clip.backgroundOpacity}
                min={0}
                max={1}
                step={0.01}
                disabled={disabled}
                format={(value) => `${Math.round(value * 100)}%`}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(backgroundOpacity) =>
                  patch((current) => (current.type === "text" ? { ...current, backgroundOpacity } : current), "Fondo de texto", {
                    history: false,
                    save: false,
                  })
                }
              />
            )}
          </Section>

          <Section title="Estilo de subtítulo" icon="sparkles">
            <div className="subtitle-style-grid">
              {SUBTITLE_STYLES.map((style) => {
                const family = fontFamilyFor(style.fontFamily);
                const active =
                  clip.fontFamily === style.fontFamily &&
                  clip.fontWeight === style.fontWeight &&
                  clip.color.toUpperCase() === style.color.toUpperCase() &&
                  clip.textTransform === style.textTransform &&
                  clip.background === style.background &&
                  clip.strokeWidth === style.strokeWidth;
                return (
                  <button
                    key={style.id}
                    type="button"
                    className={`subtitle-style-card${active ? " active" : ""}`}
                    disabled={disabled}
                    title={style.description}
                    onClick={() =>
                      patch(
                        (current) => (current.type === "text" ? withSubtitleStyle(current, style.id) : current),
                        `Estilo ${style.label}`,
                      )
                    }
                  >
                    <span
                      className="subtitle-style-sample"
                      style={{
                        fontFamily: family.css,
                        fontWeight: style.fontWeight,
                        color: style.color,
                        textTransform: style.textTransform === "upper" ? "uppercase" : style.textTransform === "lower" ? "lowercase" : "none",
                        background: style.background
                          ? `${style.backgroundColor}${Math.round(style.backgroundOpacity * 255).toString(16).padStart(2, "0")}`
                          : "transparent",
                        padding: style.background ? "3px 6px" : 0,
                        WebkitTextStroke: style.strokeWidth > 0 ? `${Math.max(0.4, style.strokeWidth / 5)}px ${style.strokeColor}` : undefined,
                        textShadow: style.shadow > 0 ? `0 1px ${Math.max(2, style.shadow / 3)}px ${style.shadowColor}` : undefined,
                      }}
                    >
                      {style.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="field-hint">
              Toca un estilo para aplicarlo a todos los subtítulos seleccionados. Después ajusta la tipografía fina
              sin perder el resto del estilo.
            </p>
            <div className="field-row" style={{ marginTop: 9 }}>
              <div className="field">
                <label>Tipografía</label>
                <select
                  className="select"
                  value={clip.fontFamily}
                  disabled={disabled}
                  onChange={(event) =>
                    patch(
                      (current) =>
                        current.type === "text"
                          ? { ...current, fontFamily: event.target.value as TextClip["fontFamily"] }
                          : current,
                      "Tipografía",
                    )
                  }
                >
                  {FONT_FAMILIES.map((family) => (
                    <option key={family.id} value={family.id}>
                      {family.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Mayúsculas</label>
                <div className="segmented">
                  {(["none", "upper", "lower"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={clip.textTransform === mode ? "active" : ""}
                      disabled={disabled}
                      onClick={() =>
                        patch(
                          (current) => (current.type === "text" ? { ...current, textTransform: mode } : current),
                          "Transformar texto",
                        )
                      }
                    >
                      {mode === "none" ? "Aa" : mode === "upper" ? "AA" : "aa"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="field-row" style={{ marginTop: 9 }}>
              <RangeField
                label="Contorno"
                value={clip.strokeWidth}
                min={0}
                max={24}
                step={1}
                disabled={disabled}
                format={(value) => (value > 0 ? `${Math.round(value)} px` : "Sin contorno")}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(strokeWidth) =>
                  patch((current) => (current.type === "text" ? { ...current, strokeWidth } : current), "Contorno de texto", {
                    history: false,
                    save: false,
                  })
                }
              />
              <div className={`field${clip.strokeWidth > 0 ? "" : " is-muted"}`}>
                <label>Color del contorno</label>
                <div className="color-row">
                  <input
                    type="color"
                    value={clip.strokeColor}
                    disabled={disabled || clip.strokeWidth === 0}
                    onFocus={onBeginEdit}
                    onBlur={onEndEdit}
                    onChange={(event) =>
                      patch((current) => (current.type === "text" ? { ...current, strokeColor: event.target.value } : current), "Color del contorno", {
                        history: false,
                        save: false,
                      })
                    }
                  />
                  <span className="mono">{clip.strokeColor.toUpperCase()}</span>
                </div>
              </div>
            </div>
            <div className="field-row" style={{ marginTop: 9 }}>
              <RangeField
                label="Sombra"
                value={clip.shadow}
                min={0}
                max={30}
                step={1}
                disabled={disabled}
                format={(value) => (value > 0 ? `${Math.round(value)} px` : "Sin sombra")}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(shadow) =>
                  patch((current) => (current.type === "text" ? { ...current, shadow } : current), "Sombra de texto", {
                    history: false,
                    save: false,
                  })
                }
              />
              <div className={`field${clip.shadow > 0 ? "" : " is-muted"}`}>
                <label>Color de sombra</label>
                <div className="color-row">
                  <input
                    type="color"
                    value={clip.shadowColor}
                    disabled={disabled || clip.shadow === 0}
                    onFocus={onBeginEdit}
                    onBlur={onEndEdit}
                    onChange={(event) =>
                      patch((current) => (current.type === "text" ? { ...current, shadowColor: event.target.value } : current), "Color de sombra", {
                        history: false,
                        save: false,
                      })
                    }
                  />
                  <span className="mono">{clip.shadowColor.toUpperCase()}</span>
                </div>
              </div>
            </div>
            {clip.background && (
              <div className="field-row" style={{ marginTop: 9 }}>
                <div className="field">
                  <label>Color del fondo</label>
                  <div className="color-row">
                    <input
                      type="color"
                      value={clip.backgroundColor}
                      disabled={disabled}
                      onFocus={onBeginEdit}
                      onBlur={onEndEdit}
                      onChange={(event) =>
                        patch((current) => (current.type === "text" ? { ...current, backgroundColor: event.target.value } : current), "Color del fondo", {
                          history: false,
                          save: false,
                        })
                      }
                    />
                    <span className="mono">{clip.backgroundColor.toUpperCase()}</span>
                  </div>
                </div>
                <RangeField
                  label="Relleno"
                  value={clip.backgroundPadding}
                  min={0}
                  max={60}
                  step={1}
                  disabled={disabled}
                  format={(value) => `${Math.round(value)} px`}
                  onStart={onBeginEdit}
                  onEnd={onEndEdit}
                  onChange={(backgroundPadding) =>
                    patch((current) => (current.type === "text" ? { ...current, backgroundPadding } : current), "Relleno del fondo", {
                      history: false,
                      save: false,
                    })
                  }
                />
              </div>
            )}
          </Section>

          {clip.type === "text" && (
            <Section title="Animación" icon="wand">
              <div className="field-row" style={{ marginTop: 9 }}>
                <div className="field">
                  <label>Entrada</label>
                  <select
                    className="select"
                    value={clip.animationIn}
                    disabled={disabled}
                    onChange={(event) =>
                      patch(
                        (current) =>
                          current.type === "text"
                            ? { ...current, animationIn: event.target.value as TextClip["animationIn"] }
                            : current,
                        "Animación de entrada",
                        { history: false, save: false },
                      )
                    }
                  >
                    <option value="none">Ninguna</option>
                    <option value="fade-in">Desvanecimiento</option>
                    <option value="slide-left">Deslizar desde izquierda</option>
                    <option value="slide-right">Deslizar desde derecha</option>
                    <option value="slide-up">Deslizar desde abajo</option>
                    <option value="slide-down">Deslizar desde arriba</option>
                    <option value="zoom-in">Acercar</option>
                    <option value="bounce-in">Rebote</option>
                  </select>
                </div>
                <div className="field">
                  <label>Duración entrada (f)</label>
                  <input
                    type="number"
                    className="input"
                    value={clip.animationInDuration}
                    min={0}
                    max={120}
                    step={1}
                    disabled={disabled}
                    onChange={(event) =>
                      patch(
                        (current) =>
                          current.type === "text"
                            ? {
                                ...current,
                                animationInDuration: Number(event.target.value),
                              }
                            : current,
                        "Duración de entrada",
                        { history: false, save: false },
                      )
                    }
                  />
                </div>
              </div>
              <div className="field-row" style={{ marginTop: 9 }}>
                <div className="field">
                  <label>Salida</label>
                  <select
                    className="select"
                    value={clip.animationOut}
                    disabled={disabled}
                    onChange={(event) =>
                      patch(
                        (current) =>
                          current.type === "text"
                            ? { ...current, animationOut: event.target.value as TextClip["animationOut"] }
                            : current,
                        "Animación de salida",
                        { history: false, save: false },
                      )
                    }
                  >
                    <option value="none">Ninguna</option>
                    <option value="fade-out">Desvanecimiento</option>
                    <option value="slide-left">Deslizar hacia izquierda</option>
                    <option value="slide-right">Deslizar hacia derecha</option>
                    <option value="slide-up">Deslizar hacia abajo</option>
                    <option value="slide-down">Deslizar hacia arriba</option>
                    <option value="zoom-out">Alejar</option>
                    <option value="bounce-out">Rebote salida</option>
                  </select>
                </div>
                <div className="field">
                  <label>Duración salida (f)</label>
                  <input
                    type="number"
                    className="input"
                    value={clip.animationOutDuration}
                    min={0}
                    max={120}
                    step={1}
                    disabled={disabled}
                    onChange={(event) =>
                      patch(
                        (current) =>
                          current.type === "text"
                            ? {
                                ...current,
                                animationOutDuration: Number(event.target.value),
                              }
                            : current,
                        "Duración de salida",
                        { history: false, save: false },
                      )
                    }
                  />
                </div>
              </div>
            </Section>
          )}
          {clip.type === "text" && clip.sourceMediaId && (
            <Section title="Aplicar a todos los subtítulos de este recurso" icon="duplicate">
              <p className="field-hint">
                Cambia el estilo de todos los subtítulos del mismo archivo de vídeo de una vez, sin editarlos uno por
                uno.
              </p>
              <button
                className="btn btn-primary btn-sm"
                disabled={disabled}
                onClick={() => {
                  if (!clip.sourceMediaId) return;
                  const styleProps = {
                    fontFamily: clip.fontFamily,
                    fontWeight: clip.fontWeight,
                    fontSize: clip.fontSize,
                    color: clip.color,
                    textTransform: clip.textTransform,
                    background: clip.background,
                    backgroundColor: clip.backgroundColor,
                    backgroundOpacity: clip.backgroundOpacity,
                    backgroundPadding: clip.backgroundPadding,
                    strokeWidth: clip.strokeWidth,
                    strokeColor: clip.strokeColor,
                    shadow: clip.shadow,
                    shadowColor: clip.shadowColor,
                    position: clip.position,
                    align: clip.align,
                    maxWidth: clip.maxWidth,
                    lineHeight: clip.lineHeight,
                  };
                  let next = project;
                  for (const track of next.tracks) {
                    if (track.kind !== "text") continue;
                    next = {
                      ...next,
                      tracks: next.tracks.map((t) =>
                        t.id === track.id
                          ? {
                              ...t,
                              clips: t.clips.map((c) =>
                                c.type === "text" && c.role === "subtitle" && c.sourceMediaId === clip.sourceMediaId
                                  ? { ...c, ...styleProps }
                                  : c,
                              ),
                            }
                          : t,
                      ),
                    };
                  }
                  apply(touchProject(next), "Aplicar estilo a todos los subtítulos de este recurso");
                }}
              >
                Aplicar a todos los subtítulos de este recurso
              </button>
            </Section>
          )}
        </>
      )}

      {isMedia && (
        <>
          {(clip.type === "video" || clip.type === "image") && (
            <Section title="Composición" icon="maximize">
              <div className="field-row">
                <RangeField
                  label="Posición X"
                  value={clip.transform.x}
                  min={-100}
                  max={100}
                  step={0.5}
                  disabled={disabled}
                  format={(value) => `${value.toFixed(1)}%`}
                  onStart={onBeginEdit}
                  onEnd={onEndEdit}
                  onChange={(x) =>
                    patchMedia((current) => ({ ...current, transform: { ...current.transform, x } }), "Mover en el lienzo", {
                      history: false,
                      save: false,
                    })
                  }
                />
                <RangeField
                  label="Posición Y"
                  value={clip.transform.y}
                  min={-100}
                  max={100}
                  step={0.5}
                  disabled={disabled}
                  format={(value) => `${value.toFixed(1)}%`}
                  onStart={onBeginEdit}
                  onEnd={onEndEdit}
                  onChange={(y) =>
                    patchMedia((current) => ({ ...current, transform: { ...current.transform, y } }), "Mover en el lienzo", {
                      history: false,
                      save: false,
                    })
                  }
                />
              </div>
              <div className="field-row" style={{ marginTop: 9 }}>
                <RangeField
                  label="Escala"
                  value={clip.transform.scale}
                  min={0.1}
                  max={3}
                  step={0.01}
                  disabled={disabled}
                  format={(value) => `${Math.round(value * 100)}%`}
                  onStart={onBeginEdit}
                  onEnd={onEndEdit}
                  onChange={(scale) =>
                    patchMedia((current) => ({ ...current, transform: { ...current.transform, scale } }), "Escalar clip", {
                      history: false,
                      save: false,
                    })
                  }
                />
                <RangeField
                  label="Rotación"
                  value={clip.transform.rotation}
                  min={-180}
                  max={180}
                  step={0.5}
                  disabled={disabled}
                  format={(value) => `${value.toFixed(1)}°`}
                  onStart={onBeginEdit}
                  onEnd={onEndEdit}
                  onChange={(rotation) =>
                    patchMedia((current) => ({ ...current, transform: { ...current.transform, rotation } }), "Rotar clip", {
                      history: false,
                      save: false,
                    })
                  }
                />
              </div>
              <RangeField
                label="Opacidad"
                value={clip.opacity}
                min={0}
                max={1}
                step={0.01}
                disabled={disabled}
                format={(value) => `${Math.round(value * 100)}%`}
                onStart={onBeginEdit}
                onEnd={onEndEdit}
                onChange={(opacity) => patchMedia((current) => ({ ...current, opacity }), "Cambiar opacidad", { history: false, save: false })}
              />
              <div className="field" style={{ marginTop: 4 }}>
                <label>Recorte</label>
                <div className="crop-grid">
                  {(["top", "right", "bottom", "left"] as const).map((edge) => (
                    <div className="crop-cell" key={edge}>
                      <span>{edge === "top" ? "Sup." : edge === "right" ? "Der." : edge === "bottom" ? "Inf." : "Izq."}</span>
                      <input
                        type="range"
                        value={clip.crop[edge]}
                        min={0}
                        max={0.48}
                        step={0.01}
                        disabled={disabled}
                        onPointerDown={onBeginEdit}
                        onPointerUp={onEndEdit}
                        onKeyDown={onBeginEdit}
                        onKeyUp={onEndEdit}
                        onChange={(event) =>
                          patchMedia(
                            (current) => ({
                              ...current,
                              crop: { ...current.crop, [edge]: Number(event.target.value) },
                            }),
                            "Recortar clip",
                            { history: false, save: false },
                          )
                        }
                      />
                      <span className="crop-value">{Math.round(clip.crop[edge] * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          )}

          <Section
            title="Color"
            icon="sliders"
            actions={
              <button
                className="btn btn-ghost btn-sm"
                disabled={disabled}
                onClick={() =>
                  patchMedia((current) => ({ ...current, adjustments: { brightness: 1, contrast: 1, saturation: 1 } }), "Restablecer color")
                }
              >
                Restablecer
              </button>
            }
          >
            <RangeField
              label="Brillo"
              value={clip.adjustments.brightness}
              min={0}
              max={2}
              step={0.01}
              disabled={disabled}
              format={(value) => `${Math.round(value * 100)}%`}
              onStart={onBeginEdit}
              onEnd={onEndEdit}
              onChange={(brightness) =>
                patchMedia((current) => ({ ...current, adjustments: { ...current.adjustments, brightness } }), "Ajustar brillo", {
                  history: false,
                  save: false,
                })
              }
            />
            <RangeField
              label="Contraste"
              value={clip.adjustments.contrast}
              min={0}
              max={2}
              step={0.01}
              disabled={disabled}
              format={(value) => `${Math.round(value * 100)}%`}
              onStart={onBeginEdit}
              onEnd={onEndEdit}
              onChange={(contrast) =>
                patchMedia((current) => ({ ...current, adjustments: { ...current.adjustments, contrast } }), "Ajustar contraste", {
                  history: false,
                  save: false,
                })
              }
            />
            <RangeField
              label="Saturación"
              value={clip.adjustments.saturation}
              min={0}
              max={2}
              step={0.01}
              disabled={disabled}
              format={(value) => `${Math.round(value * 100)}%`}
              onStart={onBeginEdit}
              onEnd={onEndEdit}
              onChange={(saturation) =>
                patchMedia((current) => ({ ...current, adjustments: { ...current.adjustments, saturation } }), "Ajustar saturación", {
                  history: false,
                  save: false,
                })
              }
            />
          </Section>

          <Section title="Audio" icon="volume-2">
            <RangeField
              label="Volumen del clip"
              value={clip.volume}
              min={0}
              max={2}
              step={0.01}
              disabled={disabled}
              format={(value) => `${Math.round(value * 100)}%`}
              onStart={onBeginEdit}
              onEnd={onEndEdit}
              onChange={(volume) => patchMedia((current) => ({ ...current, volume }), "Cambiar volumen", { history: false, save: false })}
            />
            <div className="field-row" style={{ marginTop: 6 }}>
              <TimeField
                label="Fundido de entrada"
                value={clip.fadeInFrames}
                min={0}
                max={Math.floor(clip.durationFrames / 2)}
                suffix="f"
                disabled={disabled}
                onCommit={(fadeInFrames) => patchMedia((current) => ({ ...current, fadeInFrames }), "Fundido de entrada")}
              />
              <TimeField
                label="Fundido de salida"
                value={clip.fadeOutFrames}
                min={0}
                max={Math.floor(clip.durationFrames / 2)}
                suffix="f"
                disabled={disabled}
                onCommit={(fadeOutFrames) => patchMedia((current) => ({ ...current, fadeOutFrames }), "Fundido de salida")}
              />
            </div>
            <div className="field" style={{ marginTop: 9 }}>
              <label>Mejora de voz (al exportar)</label>
              <div className="segmented">
                <button
                  className={clip.audioEnhance === "none" ? "active" : ""}
                  disabled={disabled}
                  onClick={() => patchMedia((current) => ({ ...current, audioEnhance: "none" }), "Desactivar mejora de voz")}
                >
                  Original
                </button>
                <button
                  className={clip.audioEnhance === "voice" ? "active" : ""}
                  disabled={disabled}
                  onClick={() => patchMedia((current) => ({ ...current, audioEnhance: "voice" }), "Activar mejora de voz")}
                >
                  Voz limpia
                </button>
              </div>
              <p className="field-hint">Aplica paso alto, reducción de ruido y compresión solo en la exportación.</p>
            </div>
          </Section>
        </>
      )}

      <div className="inspector-meta">
        <span>
          <Icon name="clock" size={11} />
          Inicio en {formatFrames(project, clip.startFrame)} · {formatDurationUs(frameDurationUs(project.settings.fps) * clip.durationFrames)}
        </span>
        <span>
          {clip.createdBy === "agent" ? "Creado por el agente" : clip.createdBy === "demo" ? "Clip de demostración" : "Editado por ti"}
        </span>
        {track && selectedTrackId !== track.id && (
          <button className="btn btn-ghost btn-sm" onClick={() => onSelectTrack(track.id)}>
            Seleccionar pista {track.name}
          </button>
        )}
      </div>
    </div>
  );
}
