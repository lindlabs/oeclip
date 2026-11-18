import { useEffect, useMemo, useRef, useState } from "react";
import type { MediaClip, Project, TimelineClip, Track } from "../shared/schema";
import { fpsValue, formatDurationUs, framesToSeconds } from "../shared/time";
import { api } from "../api";
import {
  addTrack,
  clipEnd,
  removeClips,
  duplicateClip,
  moveClip,
  splitAtFrame,
  trimClipBy,
  updateClip,
  setTrackFlag,
  setTrackVolume,
} from "../shared/timeline";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Waveform } from "./Waveform";

const MIN_ZOOM = 24;
const MAX_ZOOM = 260;

function clipAriaLabel(clip: TimelineClip, track: Track, fps: { num: number; den: number }): string {
  return `${clip.name}, ${track.name}, empieza en ${framesToSeconds(clip.startFrame, fps).toFixed(2)} segundos`;
}

interface TimelineProps {
  project: Project;
  projectId: string;
  currentFrame: number;
  onFrameChange: (frame: number) => void;
  selectedClipIds: string[];
  selectedTrackId: string | null;
  onSelectClips: (ids: string[], additive?: boolean) => void;
  onSelectTrack: (trackId: string | null) => void;
  onCommit: (project: Project, options?: { history?: boolean }) => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
  onDropMedia: (mediaId: string, trackId: string, frame: number) => void;
  disabled?: boolean;
}

interface DragState {
  mode: "move" | "trim-start" | "trim-end";
  clipId: string;
  trackId: string;
  startX: number;
  startFrame: number;
  duration: number;
  deltaFrames: number;
  targetTrackId: string;
  moved: boolean;
}

function chooseTickStep(pxPerSecond: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const candidate of candidates) {
    if (candidate * pxPerSecond >= 74) return candidate;
  }
  return 900;
}

export function Timeline({
  project,
  projectId,
  currentFrame,
  onFrameChange,
  selectedClipIds,
  selectedTrackId,
  onSelectClips,
  onSelectTrack,
  onCommit,
  onToast,
  onDropMedia,
  disabled,
}: TimelineProps) {
  const [zoom, setZoom] = useState(72);
  const [headerWidth, setHeaderWidth] = useState(186);
  const [dragPreview, setDragPreview] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cornerRef = useRef<HTMLDivElement | null>(null);
  const scrubRef = useRef(false);
  const scrubRafRef = useRef<number | null>(null);
  const pendingScrubFrameRef = useRef<number | null>(null);
  const lastScrubFrameRef = useRef<number>(currentFrame);
  lastScrubFrameRef.current = currentFrame;
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fps = fpsValue(project.settings.fps);
  const durationFrames = project.tracks.reduce(
    (max, track) => Math.max(max, ...track.clips.map((clip) => clip.startFrame + clip.durationFrames), 0),
    0,
  );
  const durationSeconds = durationFrames / fps;
  const totalClips = project.tracks.reduce((count, track) => count + track.clips.length, 0);
  const visibleSeconds = Math.max(16, durationSeconds + 8, 24);
  const laneWidth = Math.max(700, visibleSeconds * zoom);
  const tickStep = chooseTickStep(zoom);
  const ticks = useMemo(() => {
    const list: number[] = [];
    for (let second = 0; second <= visibleSeconds; second += tickStep) list.push(second);
    return list;
  }, [tickStep, visibleSeconds]);

  useEffect(() => {
    const node = cornerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeaderWidth(node.getBoundingClientRect().width || 186));
    observer.observe(node);
    setHeaderWidth(node.getBoundingClientRect().width || 186);
    return () => observer.disconnect();
  }, []);

  const clipIndex = useMemo(() => {
    const map = new Map<string, { clip: TimelineClip; track: Track }>();
    for (const track of project.tracks) for (const clip of track.clips) map.set(clip.id, { clip, track });
    return map;
  }, [project.tracks]);

  const frameFromClientX = (lane: HTMLElement, clientX: number): number => {
    const rect = lane.getBoundingClientRect();
    const seconds = Math.max(0, (clientX - rect.left) / zoom);
    return Math.round(seconds * fps);
  };

  const scrub = (event: React.PointerEvent, immediate = false) => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    const seconds = Math.max(0, (event.clientX - rect.left) / zoom);
    const nextFrame = Math.round(seconds * fps);
    if (immediate) {
      if (scrubRafRef.current !== null) {
        cancelAnimationFrame(scrubRafRef.current);
        scrubRafRef.current = null;
      }
      pendingScrubFrameRef.current = null;
      if (nextFrame !== lastScrubFrameRef.current) {
        lastScrubFrameRef.current = nextFrame;
        onFrameChange(nextFrame);
      }
      return;
    }
    pendingScrubFrameRef.current = nextFrame;
    if (scrubRafRef.current !== null) return;
    scrubRafRef.current = requestAnimationFrame(() => {
      scrubRafRef.current = null;
      const target = pendingScrubFrameRef.current;
      pendingScrubFrameRef.current = null;
      if (target !== null && target !== lastScrubFrameRef.current) {
        lastScrubFrameRef.current = target;
        onFrameChange(target);
      }
    });
  };

  const startScrub = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    scrubRef.current = true;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers and some touch bridges do not support capture.
    }
    scrub(event, true);
  };

  const onScrubMove = (event: React.PointerEvent) => {
    if (!scrubRef.current) return;
    scrub(event, false);
  };

  const stopScrub = () => {
    scrubRef.current = false;
    if (scrubRafRef.current !== null) {
      cancelAnimationFrame(scrubRafRef.current);
      scrubRafRef.current = null;
    }
    if (pendingScrubFrameRef.current !== null && pendingScrubFrameRef.current !== lastScrubFrameRef.current) {
      lastScrubFrameRef.current = pendingScrubFrameRef.current;
      onFrameChange(pendingScrubFrameRef.current);
    }
    pendingScrubFrameRef.current = null;
  };

  const beginDrag = (
    event: React.PointerEvent,
    clip: TimelineClip,
    track: Track,
    mode: DragState["mode"],
  ) => {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const wasSelected = selectedClipIds.includes(clip.id);
    if (mode === "move") {
      if (!wasSelected) onSelectClips([clip.id], additive);
      else if (additive) onSelectClips([clip.id], true);
    } else {
      onSelectClips([clip.id], false);
    }
    onSelectTrack(track.id);
    if (track.locked) return;
    // En pantalla táctil: el primer toque selecciona y permite deslizar el timeline sin mover el clip por accidente
    if (event.pointerType === "touch" && mode === "move" && !wasSelected) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers and some touch bridges do not support capture.
    }
    const state: DragState = {
      mode,
      clipId: clip.id,
      trackId: track.id,
      startX: event.clientX,
      startFrame: clip.startFrame,
      duration: clip.durationFrames,
      deltaFrames: 0,
      targetTrackId: track.id,
      moved: false,
    };
    dragRef.current = state;
    setDragPreview(state);
  };

  useEffect(() => {
    if (!dragPreview) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaFrames = Math.round(((event.clientX - drag.startX) / zoom) * fps);
      const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const lane = element?.closest<HTMLElement>("[data-track-lane]");
      let targetTrackId = drag.targetTrackId;
      if (drag.mode === "move" && lane?.dataset.trackLane) {
        const candidate = project.tracks.find((track) => track.id === lane.dataset.trackLane);
        const current = project.tracks.find((track) => track.id === drag.trackId);
        if (candidate && current && candidate.kind === current.kind && !candidate.locked) targetTrackId = candidate.id;
      }
      const next: DragState = {
        ...drag,
        deltaFrames: drag.mode === "move" ? Math.max(-drag.startFrame, deltaFrames) : deltaFrames,
        targetTrackId,
        moved: drag.moved || Math.abs(deltaFrames) > 0,
      };
      dragRef.current = next;
      setDragPreview(next);
    };
    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragPreview(null);
      setDropTarget(null);
      if (!drag || !drag.moved) return;
      if (drag.mode === "move") {
        const target = drag.targetTrackId || drag.trackId;
        if (drag.deltaFrames === 0 && target === drag.trackId) return;
        const result = moveClip(project, drag.clipId, target, drag.startFrame + drag.deltaFrames);
        if (!result.ok) onToast(result.error, "error");
        else onCommit(result.project, { history: true });
      } else {
        const edge = drag.mode === "trim-start" ? "start" : "end";
        const result = trimClipBy(project, drag.clipId, edge, drag.deltaFrames);
        if (!result.ok) onToast(result.error, "error");
        else onCommit(result.project, { history: true });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragPreview, zoom, fps, project, onCommit, onToast]);

  const splitSelection = () => {
    const result = splitAtFrame(project, currentFrame, selectedClipIds.length > 0 ? selectedClipIds : undefined);
    if (!result.ok) {
      onToast(result.error, "error");
      return;
    }
    onCommit(result.project, { history: true });
    if (result.newIds?.length) onSelectClips(result.newIds, false);
    onToast("Corte aplicado en el fotograma actual.", "success");
  };

  const deleteSelection = () => {
    if (selectedClipIds.length === 0) {
      onToast("Selecciona uno o varios clips para eliminar.", "info");
      return;
    }
    const result = removeClips(project, selectedClipIds);
    if (!result.ok) {
      onToast(result.error, "error");
      return;
    }
    onCommit(result.project, { history: true });
    onSelectClips([], false);
  };

  const duplicateSelection = () => {
    if (selectedClipIds.length !== 1) {
      onToast("Selecciona un único clip para duplicarlo.", "info");
      return;
    }
    const result = duplicateClip(project, selectedClipIds[0]!);
    if (!result.ok) {
      onToast(result.error, "error");
      return;
    }
    onCommit(result.project, { history: true });
    if (result.newClipId) onSelectClips([result.newClipId], false);
  };

  const addNewTrack = (kind: Track["kind"]) => {
    const result = addTrack(project, kind);
    if (!result.ok) {
      onToast(result.error, "error");
      return;
    }
    onCommit(result.project, { history: true });
    if (result.track) onSelectTrack(result.track.id);
  };

  const toggleFlag = (track: Track, flag: "muted" | "hidden" | "locked") => {
    onCommit(setTrackFlag(project, track.id, flag, !track[flag]), { history: true });
  };

  const changeVolume = (track: Track, delta: number) => {
    onCommit(setTrackVolume(project, track.id, Math.min(2, Math.max(0, track.volume + delta))), {
      history: true,
    });
  };

  const trackKindLabel = (kind: Track["kind"]) => (kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Texto");

  const clipForRender = (clip: TimelineClip) => {
    if (!dragPreview || dragPreview.clipId !== clip.id) return null;
    return dragPreview;
  };

  const rulerTicksContent = useMemo(
    () =>
      ticks.map((second) => (
        <span key={second}>
          <span className="ruler-tick major" style={{ left: second * zoom }} />
          <span className="ruler-label" style={{ left: second * zoom }}>
            {second >= 60
              ? `${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}`
              : `${second}s`}
          </span>
          {tickStep >= 2 &&
            Array.from({ length: 3 }, (_, index) => (
              <span
                key={`${second}-${index}`}
                className="ruler-tick"
                style={{ left: (second + ((index + 1) * tickStep) / 4) * zoom }}
              />
            ))}
        </span>
      )),
    [ticks, zoom, tickStep],
  );

  const trackRowsContent = useMemo(
    () =>
      project.tracks.map((track) => {
        const selected = selectedTrackId === track.id;
        const isMotionTrack = track.name.startsWith("Motion Overlay") || track.name.startsWith("Capa Motion");
        return (
          <div className={`track-row${selected ? " selected" : ""}${isMotionTrack ? " motion-track" : ""}`} key={track.id}>
            <div className="track-head">
              <div className={`track-kind ${isMotionTrack ? "motion" : track.kind}`}>
                <Icon
                  name={
                    isMotionTrack
                      ? "sparkles"
                      : track.kind === "video"
                        ? "film"
                        : track.kind === "audio"
                          ? "music"
                          : "type"
                  }
                  size={12}
                />
              </div>
              <div className="track-name-wrap" onClick={() => onSelectTrack(track.id)} role="button" tabIndex={0}>
                <div className="track-name">
                  {track.name.toLowerCase().includes("caption") || track.name.toLowerCase().includes("subtit")
                    ? "Subs"
                    : isMotionTrack || track.name.toLowerCase().includes("overlay")
                      ? "Motion"
                      : track.name}
                </div>
                <div className="track-sub">
                  {isMotionTrack ? "Componente IA" : trackKindLabel(track.kind)}
                  {track.kind === "audio" ? ` · ${Math.round(track.volume * 100)}%` : ""}
                </div>
              </div>
              <div className="track-actions">
                {track.kind === "audio" && (
                  <button
                    className={`track-control${track.muted ? " on" : ""}`}
                    title={track.muted ? "Activar audio" : "Silenciar pista"}
                    onClick={() => toggleFlag(track, "muted")}
                  >
                    <Icon name={track.muted ? "mute" : "volume"} size={12} />
                  </button>
                )}
                {track.kind !== "audio" && (
                  <button
                    className={`track-control${track.hidden ? " on" : ""}`}
                    title={track.hidden ? "Mostrar pista" : "Ocultar pista"}
                    onClick={() => toggleFlag(track, "hidden")}
                  >
                    <Icon name={track.hidden ? "eye-off" : "eye"} size={12} />
                  </button>
                )}
                <button
                  className={`track-control${track.locked ? " on" : ""}`}
                  title={track.locked ? "Desbloquear pista" : "Bloquear pista"}
                  onClick={() => toggleFlag(track, "locked")}
                >
                  <Icon name={track.locked ? "lock" : "unlock"} size={12} />
                </button>
              </div>
            </div>
            <div
              className={`track-lane${track.locked ? " locked" : ""}${dropTarget === track.id ? " drop-target" : ""}`}
              data-track-lane={track.id}
              data-track-kind={track.kind}
              style={{ width: laneWidth }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.button !== 0) return;
                onSelectTrack(track.id);
                onSelectClips([], false);
                onFrameChange(frameFromClientX(event.currentTarget, event.clientX));
              }}
              onDragOver={(event) => {
                if (disabled || track.locked) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDropTarget(track.id);
              }}
              onDragLeave={() => setDropTarget((current) => (current === track.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setDropTarget(null);
                if (disabled || track.locked) return;
                const mediaId = event.dataTransfer.getData("text/x-novacut-media");
                if (!mediaId) return;
                const frame = frameFromClientX(event.currentTarget, event.clientX);
                onDropMedia(mediaId, track.id, frame);
              }}
            >
              {track.clips.map((clip) => {
                const preview = clipForRender(clip);
                let left = framesToSeconds(clip.startFrame, project.settings.fps) * zoom;
                let width = Math.max(8, framesToSeconds(clip.durationFrames, project.settings.fps) * zoom);
                if (preview) {
                  const deltaPx = (preview.deltaFrames / fps) * zoom;
                  if (preview.mode === "move") left += deltaPx;
                  if (preview.mode === "trim-start") {
                    left += deltaPx;
                    width -= deltaPx;
                  }
                  if (preview.mode === "trim-end") width += deltaPx;
                  width = Math.max(8, width);
                }
                const selected = selectedClipIds.includes(clip.id);
                const fadeInFrames = clip.type === "text" ? clip.fadeFrames : clip.fadeInFrames;
                const asset = clip.type === "text" ? undefined : project.media.find((item) => item.id === clip.mediaId);
                const isMotionClip =
                  Boolean(clip.remotion) ||
                  (clip.type !== "text" &&
                    (isMotionTrack ||
                      (clip.createdBy === "agent" &&
                        (/\.webm$/i.test(clip.name) || (asset ? /\.webm$/i.test(asset.name) : false)))));
                const isSubtitleMotion =
                  isMotionClip &&
                  (Array.isArray(clip.remotion?.props?.captions) || /subtit|caption|subs\b/i.test(clip.name));
                const displayClipName = clip.remotion
                  ? (clip.name || clip.remotion.componentName).replace(/\.webm$/i, "")
                  : clip.type === "text"
                    ? clip.text
                    : isMotionClip
                      ? clip.name.replace(/\.webm$/i, "")
                      : clip.name;
                return (
                  <div
                    key={clip.id}
                    className={`clip ${isMotionClip ? "motion-component" : clip.type}${selected ? " selected" : ""}${clip.createdBy === "agent" ? " agent" : ""}${
                      preview ? " dragging" : ""
                    }`}
                    style={{ left, width }}
                    role="button"
                    tabIndex={0}
                    aria-label={clipAriaLabel(clip, track, project.settings.fps)}
                    aria-pressed={selected}
                    title={clipAriaLabel(clip, track, project.settings.fps)}
                    onPointerDown={(event) => beginDrag(event, clip, track, "move")}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectClips([clip.id], event.shiftKey || event.metaKey || event.ctrlKey);
                        onSelectTrack(track.id);
                      }
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      onFrameChange(clip.startFrame);
                    }}
                  >
                    <div className="clip-head">
                      <Icon
                        name={
                          clip.type === "text" || isSubtitleMotion
                            ? "type"
                            : isMotionClip
                              ? "sparkles"
                              : clip.type === "audio"
                                ? "music"
                                : clip.type === "image"
                                  ? "image"
                                  : "film"
                        }
                        size={10}
                      />
                      <span className="clip-name">{displayClipName}</span>
                      {isMotionClip ? (
                        <span className="clip-badge motion-badge">{isSubtitleMotion ? "SUBS IA" : "COMP TSX"}</span>
                      ) : (
                        clip.createdBy === "agent" && <span className="clip-badge">IA</span>
                      )}
                      {clip.type !== "text" && clip.speed !== 1 && <span className="clip-badge">{clip.speed}x</span>}
                    </div>
                    {clip.type !== "text" && (
                      <div className="clip-body">
                        {isMotionClip ? (
                          <div className="clip-motion-pattern" aria-hidden="true">
                            <span className="clip-motion-pill">
                              {isSubtitleMotion ? "Subtítulos Dinámicos · Canal Alfa" : "Componente Remotion · Canal Alfa"}
                            </span>
                          </div>
                        ) : clip.type === "audio" ? (
                          <Waveform projectId={projectId} mediaId={clip.mediaId} />
                        ) : asset ? (
                          <img
                            className="clip-thumbstrip"
                            src={api.thumbnailUrl(projectId, asset.id)}
                            alt=""
                            loading="lazy"
                            draggable={false}
                          />
                        ) : null}
                      </div>
                    )}
                    {selected && !track.locked && (
                      <>
                        <div
                          className="clip-handle start"
                          onPointerDown={(event) => beginDrag(event, clip, track, "trim-start")}
                        />
                        <div
                          className="clip-handle end"
                          onPointerDown={(event) => beginDrag(event, clip, track, "trim-end")}
                        />
                      </>
                    )}
                    {fadeInFrames > 0 && (
                      <span
                        className="clip-fade"
                        style={{
                          left: 0,
                          width: Math.min(width, (fadeInFrames / clip.durationFrames) * width),
                          transform: "scaleX(-1)",
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }),
    [
      project,
      projectId,
      selectedTrackId,
      selectedClipIds,
      dragPreview,
      dropTarget,
      laneWidth,
      zoom,
      fps,
      disabled,
    ],
  );

  return (
    <section className="timeline" aria-label="Línea de tiempo">
      <div className="timeline-toolbar">
        <div className="timeline-title">
          <Icon name="layers" size={13} />
          <span>Línea de tiempo</span>
          <span className="time-pill">{durationSeconds.toFixed(2)} s</span>
          <span className="timeline-count">
            {project.tracks.length} pistas · {totalClips} clips
          </span>
        </div>

        <div className="timeline-tools">
          <div className="timeline-group">
            <button
              className="timeline-tool"
              onClick={splitSelection}
              title="Dividir en el fotograma actual (S)"
              disabled={disabled}
            >
              <Icon name="scissors" size={14} />
              <span className="tool-label">Dividir</span>
            </button>
            <button
              className="timeline-tool"
              onClick={duplicateSelection}
              title="Duplicar el clip seleccionado"
              disabled={disabled || selectedClipIds.length === 0}
            >
              <Icon name="duplicate" size={14} />
              <span className="tool-label">Duplicar</span>
            </button>
            <button
              className="timeline-tool"
              onClick={deleteSelection}
              title="Eliminar selección (Supr)"
              aria-label="Eliminar selección"
              disabled={disabled || selectedClipIds.length === 0}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>

          <div className="timeline-group">
            <button className="timeline-add" onClick={() => addNewTrack("video")} title="Añadir pista de vídeo" disabled={disabled}>
              <Icon name="plus" size={11} /> V
            </button>
            <button className="timeline-add" onClick={() => addNewTrack("audio")} title="Añadir pista de audio" disabled={disabled}>
              <Icon name="plus" size={11} /> A
            </button>
            <button className="timeline-add" onClick={() => addNewTrack("text")} title="Añadir pista de texto" disabled={disabled}>
              <Icon name="plus" size={11} /> T
            </button>
          </div>
        </div>

        <div className="timeline-spacer" />

        <div className="zoom-control">
          <button onClick={() => setZoom((value) => Math.max(MIN_ZOOM, Math.round(value / 1.25)))} aria-label="Alejar">
            <Icon name="zoom-out" size={14} />
          </button>
          <span className="zoom-label">{Math.round(zoom)} px/s</span>
          <input
            className="timeline-zoom-range"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoom}
            onChange={(event) => setZoom(event.currentTarget.valueAsNumber)}
            aria-label="Nivel de zoom de la línea de tiempo"
          />
          <button onClick={() => setZoom((value) => Math.min(MAX_ZOOM, Math.round(value * 1.25)))} aria-label="Acercar">
            <Icon name="zoom-in" size={14} />
          </button>
        </div>
        <IconButton
          icon="maximize"
          label="Ajustar toda la secuencia a la vista"
          className="timeline-icon-btn"
          onClick={() => {
            const node = scrollRef.current;
            if (!node) return;
            const availableWidth = Math.max(300, node.clientWidth - headerWidth - 24);
            setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, availableWidth / visibleSeconds)));
            node.scrollTo({ left: 0, behavior: "smooth" });
          }}
        />
        <button
          className="timeline-icon-btn"
          onClick={() => {
            const node = scrollRef.current;
            if (!node) return;
            const playhead = headerWidth + (currentFrame / fps) * zoom;
            node.scrollTo({ left: Math.max(0, playhead - node.clientWidth / 2), behavior: "smooth" });
          }}
          title="Centrar la cabeza de reproducción"
          aria-label="Centrar la cabeza de reproducción"
        >
          <Icon name="monitor" size={14} />
        </button>
      </div>
      <div className="timeline-scroll" ref={scrollRef}>
        <div className="timeline-content" style={{ width: headerWidth + laneWidth + 24 }}>
          <div className="ruler-row">
            <div className="ruler-corner" ref={cornerRef}>
              Pistas
            </div>
            <div
              className="ruler"
              ref={rulerRef}
              style={{ width: laneWidth }}
              onPointerDown={startScrub}
              onPointerMove={onScrubMove}
              onPointerUp={stopScrub}
              onPointerCancel={stopScrub}
            >
              {rulerTicksContent}
            </div>
          </div>
          {trackRowsContent}
          <div
            className="playhead"
            style={{ left: headerWidth + (currentFrame / fps) * zoom, top: 30 }}
            aria-hidden="true"
          />
          {durationFrames === 0 && (
            <div className="timeline-empty">
              <span>Arrastra un recurso aquí o pulsa + en la biblioteca de medios</span>
            </div>
          )}
        </div>
      </div>
      <div className="timeline-footer">
        <div className="shortcut">
          <span>
            <kbd>Espacio</kbd> reproducir
          </span>
          <span>
            <kbd>S</kbd> dividir
          </span>
          <span>
            <kbd>Alt</kbd>+<kbd>←</kbd> mover
          </span>
          <span>
            <kbd>Supr</kbd> eliminar
          </span>
        </div>
        <span>
          {selectedClipIds.length > 0 ? `${selectedClipIds.length} seleccionado(s)` : "Sin selección"} ·{" "}
          {project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} clips
        </span>
      </div>
    </section>
  );
}
