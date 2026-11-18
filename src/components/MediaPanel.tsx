import { useEffect, useRef, useState } from "react";
import type { MediaAsset, Project } from "../shared/schema";
import { formatBytes, formatDurationUs } from "../shared/time";
import { api } from "../api";
import { Icon } from "./Icon";

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "processing" | "done" | "error";
  error?: string;
}

interface MediaPanelProps {
  project: Project;
  selectedMediaId: string | null;
  uploads: UploadItem[];
  disabled?: boolean;
  open?: boolean;
  onSelect: (mediaId: string | null) => void;
  onImport: (files: File[]) => void;
  onAdd: (mediaId: string) => void;
  onRemove: (mediaId: string) => void;
  onProxy: (mediaId: string) => void;
  onReveal: () => void;
  onCloseMobile?: () => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

function MediaThumb({ projectId, asset }: { projectId: string; asset: MediaAsset }) {
  const [failed, setFailed] = useState(false);
  const isAudio = asset.kind === "audio";
  return (
    <div className="media-thumb">
      {isAudio || failed ? (
        <Icon name={isAudio ? "music" : "film"} size={20} />
      ) : (
        <img
          src={api.thumbnailUrl(projectId, asset.id)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      <span className="kind-badge" title={asset.kind}>
        <Icon
          name={asset.kind === "audio" ? "music" : asset.kind === "image" ? "image" : "film"}
          size={10}
        />
      </span>
    </div>
  );
}

function isGeneratedMotionAsset(asset: MediaAsset, project: Project): boolean {
  if (asset.file.startsWith("generated/")) return true;
  // 1. Si el asset es referenciado por cualquier pista "Motion Overlay" / "Capa Motion" o un clip con Remotion
  for (const track of project.tracks) {
    const isOverlayTrack = track.name.startsWith("Motion Overlay") || track.name.startsWith("Capa Motion");
    for (const clip of track.clips) {
      if (clip.type !== "text" && clip.mediaId === asset.id) {
        if (isOverlayTrack || Boolean(clip.remotion?.code) || (clip.createdBy === "agent" && /\.webm$/i.test(asset.name))) {
          return true;
        }
      }
    }
  }
  // 2. Si el archivo fue generado por el motor Remotion (nomenclatura PascalCase terminada en Subtitles/Overlay/Comp.webm)
  if (/\.webm$/i.test(asset.name) && /(Subtitles|Overlay|Comp|Title|Caption|LowerThird)\.webm$/i.test(asset.name)) {
    return true;
  }
  return false;
}

export function MediaPanel({
  project,
  selectedMediaId,
  uploads,
  disabled,
  open,
  onSelect,
  onImport,
  onAdd,
  onRemove,
  onProxy,
  onReveal,
  onCloseMobile,
  onToast,
}: MediaPanelProps) {
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const reset = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragend", reset);
    return () => window.removeEventListener("dragend", reset);
  }, [dragging]);

  const normalized = query.trim().toLowerCase();
  const userMedia = project.media.filter((asset) => !isGeneratedMotionAsset(asset, project));
  const visible = userMedia.filter((asset) => !normalized || asset.name.toLowerCase().includes(normalized));
  const totalBytes = userMedia.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  const activeUploads = uploads.filter((item) => item.status !== "done");

  return (
    <aside
      className={`media-panel flex min-h-[0] flex-col border-r-2 border-[var(--line)] bg-[var(--paper)] ${
        open === false ? "" : "is-open"
      }`}
      aria-label="Biblioteca de medios"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg border-2 border-[var(--ink)] bg-[var(--sage-100)] text-[var(--sage-800)]">
            <Icon name="layers" size={12} />
          </span>
          <span className="font-display text-[13.5px] font-bold leading-none text-[var(--ink)]">Medios</span>
          <span className="rounded-full border-2 border-[var(--ink)] bg-[var(--sage-150)] px-2 py-0.5 text-[10px] font-bold leading-none text-[var(--sage-800)]">
            {userMedia.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            className="btn btn-primary btn-sm shrink-0 !min-h-[34px]"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            title="Importar vídeo, audio o imagen"
          >
            <Icon name="plus" size={13} />
            Subir
          </button>
          {onCloseMobile && (
            <button
              type="button"
              onClick={onCloseMobile}
              className="btn btn-secondary btn-sm shrink-0 !min-h-[34px] min-[881px]:hidden"
              title="Volver al monitor de video"
              aria-label="Volver al video"
            >
              <Icon name="close" size={13} />
              <span className="text-[11px]">Video</span>
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          multiple
          accept="video/*,audio/*,image/*,.mp4,.mov,.mkv,.webm,.m4v,.avi,.mp3,.wav,.m4a,.aac,.flac,.ogg,.png,.jpg,.jpeg,.webp"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) onImport(files);
          }}
        />
      </div>

      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input
            className="w-full min-w-0 rounded-full border-2 border-[var(--line-strong)] bg-[var(--white)] py-2 pl-8 pr-3 text-base sm:text-[12.5px] font-medium text-[var(--ink)] outline-none transition-all placeholder:text-[var(--muted)] focus:border-[var(--ink)] focus:shadow-[var(--shadow-hard-sm)]"
            placeholder="Buscar en la biblioteca"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Buscar medios"
          />
        </div>
      </div>

      {activeUploads.length > 0 && (
        <div className="space-y-2 px-4 pb-2">
          {activeUploads.map((item) => (
            <div className={`flex flex-col gap-1 px-3 py-2 rounded-lg border border-transparent ${item.status === "error" ? "border-danger bg-danger-soft text-danger" : ""}`} key={item.id}>
              <div className="flex justify-between">
                <span className="text-sm font-medium text-[var(--ink)]" title={item.name}>
                  {item.name}
                </span>
                <span className="text-xs font-medium text-[var(--ink-soft)]">
                  {item.status === "error" ? "Error" : `${Math.round(item.progress * 100)}%`}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-[var(--sage-200)] overflow-hidden">
                <span className="h-full bg-[var(--sage-600)]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </div>
              {item.error && <div className="text-[10px] font-medium text-danger">{item.error}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="relative min-h-[0] flex-1 overflow-y-auto px-3 py-1" onDragEnter={(event) => {
        if (disabled) return;
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }} onDragOver={(event) => {
        if (disabled) return;
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }} onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }} onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onImport(files);
      }}>
        {dragging && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-[20px] border-2 border-[var(--ink)] border-dashed bg-[var(--sage-150)]/50 backdrop-blur-sm shadow-[var(--shadow-hard)]">
            <Icon name="upload" size={26} className="mb-2 text-[var(--sage-600)]" />
            <span className="text-[var(--ink)] font-medium">Suelta para importar</span>
            <small className="text-[var(--muted)]">Los originales se copian al proyecto y nunca se modifican.</small>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2.5 pb-2">
          {visible.map((asset) => {
          const selected = selectedMediaId === asset.id;
          const canProxy = asset.kind === "video";
          return (
            <div
              key={asset.id}
              className={`media-card${selected ? " selected" : ""}${asset.missing ? " missing" : ""}`}
              draggable={!disabled}
              tabIndex={0}
              role="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : asset.id)}
              onDoubleClick={() => {
                if (!disabled) onAdd(asset.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !disabled) onAdd(asset.id);
              }}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/x-novacut-media", asset.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              title={`${asset.name} · arrastra a la línea de tiempo o doble clic para insertar`}
            >
              <MediaThumb projectId={project.id} asset={asset} />
              <div className="media-info">
                <span className="media-name">{asset.name}</span>
                <span className="media-meta">
                  {formatDurationUs(asset.durationUs)}
                  {asset.width && asset.height ? ` · ${asset.width}x${asset.height}` : ""}
                  {asset.kind === "audio" && asset.sampleRate ? ` · ${Math.round(asset.sampleRate / 1000)} kHz` : ""}
                </span>
                <span className="media-badges">
                  {asset.missing && asset.origin !== "generated" && <span className="tag danger">No encontrado</span>}
                  {asset.origin === "generated" && <span className="tag">Remotion IA</span>}
                  {asset.proxy === "ready" && <span className="tag">Proxy listo</span>}
                  {asset.proxy === "pending" && <span className="tag warn">Proxy...</span>}
                </span>
              </div>
              <div className="media-actions">
                <button
                  className="track-control"
                  title="Insertar en la línea de tiempo"
                  aria-label="Insertar en la línea de tiempo"
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAdd(asset.id);
                    if (typeof window !== "undefined" && window.innerWidth <= 880) {
                      onCloseMobile?.();
                    }
                  }}
                >
                  <Icon name="plus" size={13} />
                </button>
                {canProxy && (
                  <button
                    className="track-control"
                    title={asset.proxy === "ready" ? "Proxy ya disponible" : "Generar proxy de edición"}
                    aria-label="Generar proxy"
                    disabled={disabled || asset.proxy === "pending" || asset.proxy === "ready"}
                    onClick={(event) => {
                      event.stopPropagation();
                      onProxy(asset.id);
                    }}
                  >
                    <Icon name={asset.proxy === "pending" ? "loader" : "refresh"} size={12} className={asset.proxy === "pending" ? "spin" : undefined} />
                  </button>
                )}
                <button
                  className="track-control"
                  title="Quitar de la biblioteca"
                  aria-label="Quitar de la biblioteca"
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(asset.id);
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            </div>
          );
          })}
        </div>

        {visible.length === 0 && userMedia.length > 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Icon name="search" size={20} className="mb-2 text-[var(--muted)]" />
            <strong className="text-sm font-medium text-[var(--ink)]">Sin resultados</strong>
            <span className="mt-0.5 text-xs text-[var(--muted)]">Prueba con otro nombre.</span>
          </div>
        )}

        {userMedia.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Icon name="upload" size={22} className="mb-2 text-[var(--muted)]" />
            <strong className="text-sm font-medium text-[var(--ink)]">Importa tus primeros medios</strong>
            <span className="mt-0.5 text-xs text-[var(--muted)]">Vídeo, audio o imágenes. Se copian al proyecto local.</span>
            <button className="mt-3 w-full max-w-xs btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={disabled}>
              Elegir archivos
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] px-3.5 py-2">
        <span className="text-[11px] font-semibold text-[var(--muted)]">
          {userMedia.length} {userMedia.length === 1 ? "recurso" : "recursos"} · {formatBytes(totalBytes)}
        </span>
        <button
          className="btn btn-secondary btn-icon btn-sm"
          onClick={onReveal}
          title="Abrir la carpeta del proyecto"
          aria-label="Abrir la carpeta del proyecto"
        >
          <Icon name="folder" size={13} />
        </button>
      </div>
    </aside>
  );
}
