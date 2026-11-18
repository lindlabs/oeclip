import { useEffect, useMemo, useRef, useState } from "react";
import type { ExportRecord, ExportSettings, Project } from "../shared/schema";
import { EXPORT_FPS, RESOLUTION_HEIGHTS, dimensionsFor, type AspectRatio, type ResolutionHeight } from "../shared/presets";
import { formatBytes, formatDurationUs, fpsValue, framesToSeconds } from "../shared/time";
import { timelineDurationFrames } from "../shared/project";
import type { JobState, ServerConfig } from "../api";
import { api } from "../api";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

interface ExportDialogProps {
  project: Project;
  exports: ExportRecord[];
  jobs: JobState[];
  config: ServerConfig | null;
  onClose: () => void;
  onStart: (settings: ExportSettings) => Promise<{ record: ExportRecord; job: JobState }>;
  onRefreshExports: () => Promise<void>;
  onVerify: (exportId: string) => Promise<void>;
  onReveal: (exportId: string) => void;
  onCancelJob: (jobId: string) => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

function sanitizeName(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 90) || "oeclip-export"
  );
}

function nearestFps(fps: number): (typeof EXPORT_FPS)[number] {
  return EXPORT_FPS.reduce((best, current) => (Math.abs(current - fps) < Math.abs(best - fps) ? current : best), EXPORT_FPS[0]);
}

function statusLabel(record: ExportRecord): string {
  if (record.status === "done") return "Listo";
  if (record.status === "failed") return "Error";
  if (record.status === "cancelled") return "Cancelado";
  if (record.status === "running") return "Exportando";
  return "En cola";
}

const QUALITY_LABEL: Record<ExportSettings["quality"], string> = {
  draft: "Rápido (vista previa)",
  standard: "Equilibrado (recomendado)",
  high: "Máxima calidad (más lento)",
};

// "Mostrar en carpeta" abre el explorador del servidor: solo tiene sentido en local.
const IS_LOCAL_HOST =
  typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

export function ExportDialog({
  project,
  exports,
  jobs,
  config,
  onClose,
  onStart,
  onRefreshExports,
  onVerify,
  onReveal,
  onCancelJob,
  onToast,
}: ExportDialogProps) {
  const [resolution, setResolution] = useState<ResolutionHeight>(1080);
  const [aspect, setAspect] = useState<AspectRatio>(project.settings.aspect);
  const [fps, setFps] = useState<(typeof EXPORT_FPS)[number]>(nearestFps(fpsValue(project.settings.fps)));
  const [quality, setQuality] = useState<ExportSettings["quality"]>("standard");
  const [encoder, setEncoder] = useState<ExportSettings["encoder"]>(config?.capabilities.nvenc ? "auto" : "cpu");
  const [engine, setEngine] = useState<ExportSettings["engine"]>("ffmpeg");
  const [fileName, setFileName] = useState(`${sanitizeName(project.name)}-${new Date().toISOString().slice(0, 10)}`);
  const [starting, setStarting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [focusExportId, setFocusExportId] = useState<string | null>(exports.at(-1)?.id ?? null);
  const lastTerminal = useRef("");

  const exportJobs = jobs.filter((job) => job.type === "export");
  const latestActive = exportJobs.filter((job) => job.status === "running" || job.status === "queued").at(-1);
  const job = (jobId ? exportJobs.find((item) => item.id === jobId) : latestActive) ?? null;
  const jobExportId =
    job && job.detail && typeof job.detail.exportId === "string" ? (job.detail.exportId as string) : null;
  const recordId = focusExportId ?? jobExportId ?? exports.at(-1)?.id ?? null;
  const record = exports.find((item) => item.id === recordId) ?? null;
  const jobActive = Boolean(job && (job.status === "queued" || job.status === "running"));
  const dimensions = dimensionsFor(aspect, resolution);
  const durationFrames = timelineDurationFrames(project);
  const durationSeconds = framesToSeconds(durationFrames, project.settings.fps);
  const ffmpegAvailable = config ? Boolean(config.capabilities.ffmpegVersion) : true;

  useEffect(() => {
    if (job && (job.status === "done" || job.status === "failed" || job.status === "cancelled")) {
      const key = `${job.id}:${job.status}`;
      if (lastTerminal.current !== key) {
        lastTerminal.current = key;
        void onRefreshExports();
        if (job.detail && typeof job.detail.exportId === "string") setFocusExportId(job.detail.exportId as string);
      }
    }
  }, [job, onRefreshExports]);

  const progress = jobActive ? job?.progress ?? 0 : record?.status === "done" ? 1 : record?.progress ?? 0;
  const eta = job && typeof job.detail?.etaSeconds === "number" ? (job.detail.etaSeconds as number) : record?.etaSeconds;
  const message = jobActive ? job?.message ?? "Exportando" : record?.status === "done" ? "Exportación verificada" : record?.error ?? "";
  const downloadUrl = record?.status === "done" ? api.exportFileUrl(project.id, record.id) : null;

  const canStart = !jobActive && !starting && ffmpegAvailable && durationFrames > 0 && fileName.trim().length > 0;

  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const result = await onStart({
        resolution,
        aspect,
        fps,
        quality,
        encoder,
        engine,
        fileName: fileName.trim(),
      });
      setJobId(result.job.id);
      setFocusExportId(result.record.id);
      onToast("Exportación encolada. Puedes seguir editando.", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "No se pudo iniciar la exportación.", "error");
    } finally {
      setStarting(false);
    }
  };

  const exportList = useMemo(() => [...exports].reverse().slice(0, 8), [exports]);

  return (
    <Modal
      title="Exportar vídeo"
      kicker="Descarga tu video"
      subtitle="Se genera un MP4 listo para TikTok, Reels, Shorts o YouTube. Puedes cerrar esta ventana mientras se procesa."
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cerrar
          </button>
          <span className="flex-1" />
          {jobActive && job && (
            <button
              className="btn btn-danger"
              onClick={() => {
                onCancelJob(job.id);
                onToast("Cancelando la exportación...", "info");
              }}
            >
              Cancelar exportación
            </button>
          )}
          <button className="btn btn-primary" onClick={() => void start()} disabled={!canStart}>
            {starting || jobActive ? <Icon name="loader" size={14} className="spin" /> : <Icon name="download" size={14} />}
            {jobActive ? "Exportando..." : "Iniciar exportación"}
          </button>
        </>
      }
    >
      {!ffmpegAvailable && (
        <div className="info-callout warn">
          <strong>FFmpeg no está disponible.</strong> OECLIP no puede exportar ni analizar medios hasta que FFmpeg y
          FFprobe estén en el PATH o configurados en <code>.env</code>.
        </div>
      )}

      {durationFrames === 0 && (
        <div className="info-callout warn">
          La línea de tiempo está vacía. Añade al menos un clip antes de exportar.
        </div>
      )}

      {(jobActive || record) && (
        <div className="export-progress-block">
          <div className="progress-head">
            <strong>
              {record ? record.settings.fileName : job?.label ?? "Exportación"}
              {jobActive && <span className="tag warn">En curso</span>}
              {record?.status === "done" && <span className="tag">Verificada</span>}
              {record?.status === "failed" && <span className="tag danger">Error</span>}
              {record?.status === "cancelled" && <span className="tag neutral">Cancelada</span>}
            </strong>
            <span className="mono">{Math.round(progress * 100)}%</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.max(2, Math.round(progress * 100))}%`, opacity: record?.status === "failed" ? 0.4 : 1 }}
            />
          </div>
          <div className="progress-meta">
            <span>{message || "Preparando"}</span>
            <span>
              {jobActive && eta !== undefined ? `~${Math.max(1, Math.round(eta))} s restantes` : null}
              {!jobActive && record?.status === "done" && record.verification
                ? `${formatDurationUs(record.verification.durationUs)} · ${formatBytes(record.verification.sizeBytes)}`
                : null}
            </span>
          </div>

          {record?.status === "done" && (
            <div className="export-done">
              <div className="export-done-head">
                <Icon name="check" size={16} />
                Archivo MP4 verificado
              </div>
              {record.verification && (
                <div className="verification-grid">
                  <div className="verification-cell">
                    <span>Duración</span>
                    <strong>{formatDurationUs(record.verification.durationUs)}</strong>
                  </div>
                  <div className="verification-cell">
                    <span>Resolución</span>
                    <strong>
                      {record.verification.width}x{record.verification.height}
                    </strong>
                  </div>
                  <div className="verification-cell">
                    <span>Video</span>
                    <strong>{record.verification.videoCodec ?? "—"}</strong>
                  </div>
                  <div className="verification-cell">
                    <span>Audio</span>
                    <strong>{record.verification.audioCodec ?? "—"}</strong>
                  </div>
                  <div className="verification-cell">
                    <span>FPS</span>
                    <strong>{record.verification.fps ? record.verification.fps.toFixed(2) : "—"}</strong>
                  </div>
                  <div className="verification-cell">
                    <span>Tamaño</span>
                    <strong>{formatBytes(record.verification.sizeBytes)}</strong>
                  </div>
                </div>
              )}
              <div className="mini-actions">
                {downloadUrl && (
                  <a className="btn btn-primary btn-sm pill" href={downloadUrl} download={record.settings.fileName}>
                    <Icon name="download" size={13} />
                    Descargar
                  </a>
                )}
                {IS_LOCAL_HOST && (
                  <button className="btn btn-secondary btn-sm pill" onClick={() => onReveal(record.id)}>
                    <Icon name="folder" size={13} />
                    Mostrar en carpeta
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm pill"
                  disabled={verifying}
                  onClick={() => {
                    setVerifying(true);
                    void onVerify(record.id).finally(() => setVerifying(false));
                  }}
                >
                  {verifying ? <Icon name="loader" size={13} className="spin" /> : <Icon name="check" size={13} />}
                  Comprobar archivo
                </button>
              </div>
            </div>
          )}

          {(record?.status === "failed" || job?.status === "failed") && (
            <div className="info-callout warn">
              <strong>La exportación no se completó.</strong>{" "}
              {job?.error ?? record?.error ?? "Revisa el registro y vuelve a intentarlo."}
            </div>
          )}

          <p className="field-hint">Puedes cerrar esta ventana: la exportación sigue en segundo plano.</p>
        </div>
      )}

      <div className="export-grid">
        <div className="field">
          <label htmlFor="export-resolution">Resolución</label>
          <select
            id="export-resolution"
            className="select"
            value={resolution}
            disabled={jobActive}
            onChange={(event) => setResolution(Number(event.target.value) as ResolutionHeight)}
          >
            {RESOLUTION_HEIGHTS.map((height) => {
              const size = dimensionsFor(aspect, height);
              return (
                <option key={height} value={height}>
                  {height}p · {size.width}x{size.height}
                </option>
              );
            })}
          </select>
        </div>
        <div className="field">
          <label htmlFor="export-aspect">Formato</label>
          <select
            id="export-aspect"
            className="select"
            value={aspect}
            disabled={jobActive}
            onChange={(event) => setAspect(event.target.value as AspectRatio)}
          >
            <option value="16:9">Horizontal 16:9</option>
            <option value="9:16">Vertical 9:16</option>
            <option value="1:1">Cuadrado 1:1</option>
            <option value="4:5">Retrato 4:5</option>
            <option value="21:9">Cine 21:9</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="export-fps">Fotogramas por segundo</label>
          <select
            id="export-fps"
            className="select"
            value={fps}
            disabled={jobActive}
            onChange={(event) => setFps(Number(event.target.value) as (typeof EXPORT_FPS)[number])}
          >
            {EXPORT_FPS.map((value) => (
              <option key={value} value={value}>
                {value} fps
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="export-quality">Calidad</label>
          <select
            id="export-quality"
            className="select"
            value={quality}
            disabled={jobActive}
            onChange={(event) => setQuality(event.target.value as ExportSettings["quality"])}
          >
            {Object.entries(QUALITY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="export-filename">Nombre del archivo</label>
          <div className="filename-wrap">
            <input
              id="export-filename"
              className="input"
              value={fileName}
              disabled={jobActive}
              maxLength={110}
              onChange={(event) => setFileName(event.target.value)}
              onBlur={() => setFileName(sanitizeName(fileName))}
            />
            <span>.mp4</span>
          </div>
        </div>
      </div>

      <details className="export-advanced">
        <summary>Opciones avanzadas</summary>
        <p className="field-hint">
          Normalmente no hace falta tocar esto: OECLIP elige el mejor método automáticamente.
        </p>
        <div className="export-grid">
          <div className="field">
            <label htmlFor="export-encoder">Codificador</label>
            <select
              id="export-encoder"
              className="select"
              value={encoder}
              disabled={jobActive}
              onChange={(event) => setEncoder(event.target.value as ExportSettings["encoder"])}
            >
              <option value="auto">Automático (GPU si es posible)</option>
              <option value="cpu">CPU · libx264</option>
              <option value="nvidia" disabled={!config?.capabilities.nvenc}>
                NVIDIA NVENC {config?.capabilities.nvenc ? "" : "(no disponible)"}
              </option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="export-engine">Motor de gráficos</label>
            <select
              id="export-engine"
              className="select"
              value={engine}
              disabled={jobActive}
              onChange={(event) => setEngine(event.target.value as ExportSettings["engine"])}
            >
              <option value="ffmpeg">FFmpeg nativo (rápido)</option>
              <option value="remotion" disabled={!config?.capabilities.remotion}>
                Remotion · springs y easing {config?.capabilities.remotion ? "" : "(no disponible)"}
              </option>
            </select>
          </div>
        </div>
      </details>

      <div className="export-summary">
        <span>
          <Icon name="monitor" size={13} /> {dimensions.width}x{dimensions.height} · {fps} fps
        </span>
        <span>
          <Icon name="clock" size={13} /> {formatDurationUs(durationSeconds * 1_000_000)}
        </span>
        <span>
          <Icon name="film" size={13} /> {project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} clips
        </span>
        <span>
          <Icon name="volume-2" size={13} /> AAC 48 kHz
        </span>
      </div>

      {exportList.length > 0 && (
        <div>
          <div className="section-head">
            <div className="section-title">
              <Icon name="history" size={12} />
              Exportaciones recientes
            </div>
          </div>
          <div className="export-list">
            {exportList.map((item) => (
              <div className="export-row" key={item.id}>
                <Icon
                  name={item.status === "done" ? "check" : item.status === "failed" ? "alert" : item.status === "cancelled" ? "close" : "loader"}
                  size={13}
                  className={item.status === "running" ? "spin" : undefined}
                />
                <span className="file-name" title={item.settings.fileName}>
                  {item.settings.fileName}
                </span>
                <span className={`tag ${item.status === "done" ? "" : item.status === "failed" ? "danger" : "neutral"}`}>
                  {statusLabel(item)}
                </span>
                <span className="meta">
                  {item.verification ? formatBytes(item.verification.sizeBytes) : `${item.settings.resolution}p`}
                </span>
                {item.status === "done" && (
                  <>
                    <a
                      className="btn btn-ghost btn-icon btn-sm pill"
                      href={api.exportFileUrl(project.id, item.id)}
                      download={item.settings.fileName}
                      title="Descargar"
                      aria-label="Descargar"
                    >
                      <Icon name="download" size={13} />
                    </a>
                    {IS_LOCAL_HOST && (
                      <button
                        className="btn btn-ghost btn-icon btn-sm pill"
                        onClick={() => onReveal(item.id)}
                        title="Mostrar en carpeta"
                        aria-label="Mostrar en carpeta"
                      >
                        <Icon name="folder" size={13} />
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
