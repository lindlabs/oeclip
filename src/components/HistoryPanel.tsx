import { useCallback, useEffect, useState } from "react";
import type { Project } from "../shared/schema";
import { api, type Snapshot } from "../api";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./Modal";
import type { HistoryEntry, SaveStatus } from "../editorTypes";

interface HistoryPanelProps {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  saveStatus: SaveStatus;
  snapshotsVersion: number;
  onCreateSnapshot: (label: string) => Promise<void>;
  onRestoreSnapshot: (fileName: string) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onRestoreLocal: (index: number) => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

function formatWhen(iso: string | number): string {
  const date = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "Guardado en disco",
  saving: "Guardando…",
  dirty: "Cambios sin guardar",
  error: "Error de guardado",
  conflict: "Conflicto de revisión",
};

const SAVE_TONE: Record<SaveStatus, string> = {
  saved: "border-[var(--sage-400)] bg-[var(--sage-50)] text-[var(--sage-800)]",
  saving: "border-[var(--line-strong)] bg-[var(--cream-deep)] text-[var(--ink-soft)]",
  dirty: "border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)]",
  error: "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]",
  conflict: "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]",
};

const SECTION = "rounded-2xl border-2 border-[var(--line-strong)] bg-[var(--white)] p-3";
const SECTION_HEAD = "flex items-center justify-between gap-2";
const SECTION_TITLE =
  "flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.13em] text-[var(--muted-strong)]";
const ROW =
  "flex items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2 transition-colors hover:border-[var(--sage-400)] hover:bg-[var(--sage-50)]";

export function HistoryPanel({
  project,
  past,
  future,
  saveStatus,
  snapshotsVersion,
  onCreateSnapshot,
  onRestoreSnapshot,
  onUndo,
  onRedo,
  onRestoreLocal,
  onToast,
}: HistoryPanelProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Snapshot | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshots(await api.listSnapshots(project.id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "No se pudieron cargar las instantáneas.", "error");
    } finally {
      setLoading(false);
    }
  }, [project.id, onToast]);

  useEffect(() => {
    void load();
  }, [load, snapshotsVersion]);

  const createSnapshot = async () => {
    const trimmed = label.trim() || `Versión manual · ${new Date().toLocaleTimeString("es-ES")}`;
    setCreating(true);
    try {
      await onCreateSnapshot(trimmed);
      setLabel("");
      await load();
      onToast("Instantánea guardada.", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "No se pudo guardar la instantánea.", "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3.5 py-2.5">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border-2 px-2.5 py-1 text-[9.5px] font-extrabold uppercase tracking-[0.08em] ${SAVE_TONE[saveStatus]}`}
        >
          {saveStatus === "saved" ? (
            <Icon name="check" size={10} />
          ) : saveStatus === "saving" ? (
            <Icon name="loader" size={10} className="spin" />
          ) : (
            <Icon name="clock" size={10} />
          )}
          {SAVE_LABEL[saveStatus]}
        </span>
        <span className="flex-1" />
        <span className="rounded-full border border-[var(--line-strong)] bg-[var(--paper)] px-2 py-0.5 font-mono text-[9.5px] font-bold text-[var(--muted)]">
          rev {project.revision}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-6 pt-3 [&>*]:shrink-0">
        <section className={SECTION}>
          <div className={SECTION_HEAD}>
            <div className={SECTION_TITLE}>
              <Icon name="undo" size={11} />
              Historial de la sesión
            </div>
            <div className="flex items-center gap-1">
              <button
                className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-soft)] transition-colors hover:bg-[var(--sage-100)] disabled:opacity-35"
                onClick={onUndo}
                disabled={past.length === 0}
                title="Deshacer (Ctrl+Z)"
                aria-label="Deshacer"
              >
                <Icon name="undo" size={13} />
              </button>
              <button
                className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-soft)] transition-colors hover:bg-[var(--sage-100)] disabled:opacity-35"
                onClick={onRedo}
                disabled={future.length === 0}
                title="Rehacer (Ctrl+Shift+Z)"
                aria-label="Rehacer"
              >
                <Icon name="redo" size={13} />
              </button>
            </div>
          </div>

          {past.length === 0 ? (
            <p className="mt-2 text-[11px] font-medium leading-relaxed text-[var(--muted)]">
              Las ediciones que hagas aparecerán aquí. Puedes deshacer hasta 80 operaciones.
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              {[...past]
                .reverse()
                .slice(0, 30)
                .map((entry, reverseIndex) => {
                  const index = past.length - 1 - reverseIndex;
                  return (
                    <div className={ROW} key={`${entry.at}-${index}`}>
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-[var(--line-strong)] bg-[var(--white)] text-[var(--sage-700)]">
                        <Icon name="undo" size={11} />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[11.5px] font-bold leading-tight text-[var(--ink)]" title={entry.label}>
                          {entry.label}
                        </span>
                        <span className="text-[9.5px] font-semibold text-[var(--muted)]">
                          {formatWhen(entry.at)} · rev {entry.project.revision}
                        </span>
                      </div>
                      <button
                        className="shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.06em] text-[var(--sage-700)] transition-colors hover:bg-[var(--sage-150)]"
                        onClick={() => onRestoreLocal(index)}
                        title="Volver a este estado y descartar los cambios posteriores de la sesión"
                      >
                        Volver
                      </button>
                    </div>
                  );
                })}
            </div>
          )}

          {future.length > 0 && (
            <p className="mt-2 text-[10.5px] font-semibold text-[var(--muted)]">
              {future.length} operación(es) para rehacer disponibles.
            </p>
          )}
        </section>

        <section className={SECTION}>
          <div className={SECTION_HEAD}>
            <div className={SECTION_TITLE}>
              <Icon name="history" size={11} />
              Instantáneas del proyecto
            </div>
            <button
              className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-soft)] transition-colors hover:bg-[var(--sage-100)]"
              onClick={() => void load()}
              title="Recargar instantáneas"
              aria-label="Recargar instantáneas"
            >
              <Icon name="refresh" size={12} className={loading ? "spin" : undefined} />
            </button>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <input
              className="h-8 min-w-0 flex-1 rounded-full border-2 border-[var(--line-strong)] bg-[var(--paper)] px-3 text-[11.5px] font-semibold text-[var(--ink)] outline-none transition-all placeholder:font-medium placeholder:text-[var(--muted)] focus:border-[var(--ink)] focus:bg-[var(--white)]"
              placeholder="Nombre (opcional)"
              value={label}
              maxLength={200}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !creating) void createSnapshot();
              }}
            />
            <button
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border-2 border-[var(--ink)] bg-[var(--sage-150)] px-2.5 text-[10px] font-extrabold uppercase tracking-[0.06em] text-[var(--sage-900)] shadow-[var(--shadow-hard-sm)] transition-all hover:-translate-y-px active:translate-y-0 active:shadow-none disabled:opacity-40"
              onClick={() => void createSnapshot()}
              disabled={creating}
            >
              {creating ? <Icon name="loader" size={12} className="spin" /> : <Icon name="plus" size={12} />}
              Guardar
            </button>
          </div>
          <p className="mt-1.5 text-[10px] font-medium leading-relaxed text-[var(--muted)]">
            Se guardan en el proyecto local. El agente crea una automáticamente antes de aplicar cada plan.
          </p>

          {loading && snapshots.length === 0 ? (
            <div className="mt-2 flex items-center gap-1.5 text-[10.5px] font-semibold text-[var(--muted)]">
              <Icon name="loader" size={12} className="spin" /> Cargando instantáneas…
            </div>
          ) : snapshots.length === 0 ? (
            <div className="mt-2 flex flex-col items-center gap-1 rounded-xl border border-dashed border-[var(--line-strong)] bg-[var(--paper)] px-3 py-4 text-center">
              <Icon name="history" size={16} className="text-[var(--sage-500)]" />
              <strong className="text-[11px] font-bold text-[var(--ink)]">Todavía no hay versiones</strong>
              <span className="text-[10px] font-medium text-[var(--muted)]">
                Guarda una instantánea antes de un cambio importante.
              </span>
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              {snapshots.slice(0, 20).map((snapshot) => (
                <div className={ROW} key={snapshot.fileName}>
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-[var(--line-strong)] bg-[var(--white)] text-[var(--sage-700)]">
                    <Icon name="clock" size={11} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[11.5px] font-bold leading-tight text-[var(--ink)]" title={snapshot.label}>
                      {snapshot.label}
                    </span>
                    <span className="text-[9.5px] font-semibold text-[var(--muted)]">
                      {formatWhen(snapshot.createdAt)} · rev {snapshot.revision}
                    </span>
                  </div>
                  <button
                    className="shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.06em] text-[var(--sage-700)] transition-colors hover:bg-[var(--sage-150)] disabled:opacity-40"
                    onClick={() => setRestoreTarget(snapshot)}
                    disabled={restoring}
                  >
                    Restaurar
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="rounded-2xl border-2 border-[var(--sage-300)] bg-[var(--sage-50)] p-3 text-[10.5px] font-medium leading-relaxed text-[var(--ink-soft)]">
          <strong className="font-extrabold text-[var(--ink)]">Consejo:</strong> restaura una instantánea si el montaje
          toma un rumbo equivocado. Antes de restaurar se crea otra instantánea con el estado actual, así que también
          puedes volver atrás.
        </div>
      </div>

      {restoreTarget && (
        <ConfirmDialog
          title="Restaurar instantánea"
          message={`Se reemplazará el montaje actual por "${restoreTarget.label}" (revisión ${restoreTarget.revision}). Se guardará antes una instantánea del estado actual. Las exportaciones y el historial del agente no se eliminan.`}
          confirmLabel={restoring ? "Restaurando…" : "Restaurar"}
          onCancel={() => setRestoreTarget(null)}
          onConfirm={() => {
            if (restoring || !restoreTarget) return;
            setRestoring(true);
            void onRestoreSnapshot(restoreTarget.fileName)
              .then(async () => {
                await load();
                setRestoreTarget(null);
                onToast("Instantánea restaurada.", "success");
              })
              .catch((error) => {
                onToast(error instanceof Error ? error.message : "No se pudo restaurar la instantánea.", "error");
                setRestoring(false);
              });
          }}
        />
      )}
    </div>
  );
}
