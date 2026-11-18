import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/schema";
import type { AiStatus, CreatorUser } from "../api";
import { getCurrentUser } from "../api";
import { Icon } from "./Icon";
import { Brand } from "./Brand";
import type { SaveStatus } from "../editorTypes";
import type { ToastKind } from "./Toasts";

interface TopBarProps {
  project: Project;
  user?: CreatorUser | null;
  saveStatus: SaveStatus;
  ai: AiStatus | null;
  agentRunning: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onRename: (name: string) => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onSettings: () => void;
  onHome: () => void;
  onSignOut?: () => void;
  onOpenProfile?: () => void;
  onDuplicate: () => void;
  onReveal: () => void;
  onSnapshot: () => void;
  onToggleMedia: () => void;
  onToggleInspector: () => void;
  onToast?: (message: string, kind?: ToastKind) => void;
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "Guardado",
  saving: "Guardando",
  dirty: "Sin guardar",
  error: "Error al guardar",
  conflict: "Conflicto",
};

const ICON_BUTTON =
  "btn btn-secondary btn-icon btn-sm !border-[var(--ink)] !text-[var(--ink-soft)] disabled:!opacity-40";

export function TopBar({
  project,
  user,
  saveStatus,
  ai,
  agentRunning,
  canUndo,
  canRedo,
  onRename,
  onSave,
  onUndo,
  onRedo,
  onExport,
  onSettings,
  onHome,
  onSignOut,
  onOpenProfile,
  onDuplicate,
  onReveal,
  onSnapshot,
  onToggleMedia,
  onToggleInspector,
  onToast,
}: TopBarProps) {
  const [name, setName] = useState(project.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setName(project.name);
  }, [project.id, project.name]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(project.name);
      return;
    }
    if (trimmed !== project.name) onRename(trimmed);
  };

  const aiLabel = agentRunning ? "Agente activo" : ai?.configured ? "IA conectada" : "Configurar API Key";

  return (
    <header className="topbar flex h-[var(--topbar-h)] min-w-0 shrink-0 items-center gap-1.5 sm:gap-2.5 border-b-2 border-[var(--ink)] bg-[var(--white)] px-2 sm:px-4">
      {/* Marca + proyecto */}
      <button
        className="Brand shrink-0"
        onClick={onHome}
        title="Ir a la biblioteca de proyectos"
        aria-label="Ir a la biblioteca de proyectos"
      >
        <Brand />
      </button>

      <span className="hidden h-6 w-px shrink-0 bg-[var(--line-strong)] sm:block" />

      <div className="project-chip min-w-0 flex-1 sm:flex-initial">
        <button
          type="button"
          className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded-full md:hidden"
          title={SAVE_LABEL[saveStatus]}
          aria-label={`Estado de guardado: ${SAVE_LABEL[saveStatus]}`}
          onClick={() => {
            if (saveStatus === "dirty" || saveStatus === "error") {
              onSave();
              return;
            }
            onToast?.(`Estado del proyecto: ${SAVE_LABEL[saveStatus]}.`, saveStatus === "conflict" ? "error" : "info");
          }}
        >
          <span className={`save-pill-dot ${saveStatus}`} />
        </button>
        <Icon name="film" size={12} className="hidden sm:block shrink-0 text-[var(--sage-600)]" />
        <input
          value={name}
          aria-label="Nombre del proyecto"
          className="min-w-0 flex-1 bg-transparent text-[12px] sm:text-[13px] font-bold text-[var(--ink)] outline-none truncate"
          placeholder={project.name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setName(project.name);
              event.currentTarget.blur();
            }
          }}
          maxLength={160}
          title="Renombra el proyecto y pulsa Enter"
        />
        <span className="project-chip-rev hidden sm:inline-block" title={`Revisión ${project.revision}`}>
          v{project.revision}
        </span>
      </div>

      {(() => {
        const activeUser = user ?? getCurrentUser();
        if (!activeUser) return null;
        const initial = (activeUser.displayName || activeUser.name || activeUser.handle || "C").charAt(0).toUpperCase();
        return (
          <button
            type="button"
            data-user-profile-btn
            onClick={() => onOpenProfile?.()}
            className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-[var(--paper)] hover:border-[var(--ink)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--ink)] shrink-0 cursor-pointer transition-colors"
            title={`Mi cuenta (${activeUser.displayName || activeUser.name || activeUser.handle}) · Editar datos o cambiar de usuario`}
          >
            <span
              className="w-3.5 h-3.5 rounded-full text-[8px] font-black text-[#0c150d] grid place-items-center"
              style={{ backgroundColor: activeUser.avatarColor || "var(--learn-green)" }}
            >
              {initial}
            </span>
            <span className="truncate max-w-[100px]">@{activeUser.handle}</span>
          </button>
        );
      })()}

      <button
        className="save-pill shrink-0 !hidden md:!inline-flex"
        onClick={onSave}
        title={
          saveStatus === "saved"
            ? "Todos los cambios están guardados. Pulsa para guardar una versión."
            : "Guardar ahora (Ctrl+S)"
        }
      >
        <span className={`save-pill-dot ${saveStatus}`} />
        <span>{SAVE_LABEL[saveStatus]}</span>
      </button>

      {/* Acciones */}
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        <button
          type="button"
          onClick={onSettings}
          className={`inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--ink)] px-2 sm:px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.05em] shadow-[var(--shadow-hard-sm)] transition-transform hover:-translate-y-0.5 ${
            ai?.configured
              ? "bg-[var(--sage-100)] text-[var(--sage-800)]"
              : "bg-[var(--warning-soft)] text-[var(--ink)]"
          }`}
          title={
            agentRunning
              ? "El agente está trabajando"
              : ai?.configured
                ? `IA conectada (${ai.model}) · Pulsa para cambiar tu API Key`
                : "Configura tu propia API Key (Gemini, Groq, NVIDIA u OpenAI)"
          }
        >
          <span className={`ai-dot${ai?.configured || agentRunning ? "" : " off"}`} />
          <Icon name="key" size={11} />
          <span className="hidden md:inline">{aiLabel}</span>
          <span className="md:hidden">{ai?.configured ? "IA" : "Key"}</span>
        </button>

        <button className={`${ICON_BUTTON} hidden sm:inline-flex`} onClick={onUndo} disabled={!canUndo} title="Deshacer (Ctrl+Z)" aria-label="Deshacer">
          <Icon name="undo" size={14} />
        </button>
        <button
          className={`${ICON_BUTTON} topbar-desktop-only`}
          onClick={onRedo}
          disabled={!canRedo}
          title="Rehacer (Ctrl+Shift+Z)"
          aria-label="Rehacer"
        >
          <Icon name="redo" size={14} />
        </button>

        <span className="mx-0.5 hidden h-6 w-px shrink-0 bg-[var(--line-strong)] topbar-desktop-only" />

        <button
          className={`${ICON_BUTTON} topbar-desktop-only`}
          onClick={onToggleMedia}
          title="Biblioteca de medios"
          aria-label="Biblioteca de medios"
        >
          <Icon name="panel-left" size={15} />
        </button>
        <button
          className={`${ICON_BUTTON} topbar-desktop-only`}
          onClick={onToggleInspector}
          title="Inspector, agente e historial"
          aria-label="Inspector"
        >
          <Icon name="panel-right" size={15} />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            className={ICON_BUTTON}
            aria-label="Menú del proyecto"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <Icon name="more" size={15} />
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 top-[calc(100%+10px)] z-50 w-60 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-var(--topbar-h)-16px)] overflow-y-auto rounded-2xl border-2 border-[var(--ink)] bg-[var(--paper)] p-1.5 shadow-[var(--shadow-hard)]"
              role="menu"
            >
              <div className="flex items-center gap-1 p-1 bg-[var(--sage-50)] rounded-xl mb-1 sm:hidden">
                <button
                  type="button"
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--white)] text-[11px] font-bold text-[var(--ink)] disabled:opacity-40"
                  onClick={() => {
                    setMenuOpen(false);
                    onUndo();
                  }}
                  disabled={!canUndo}
                >
                  <Icon name="undo" size={11} /> Deshacer
                </button>
                <button
                  type="button"
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--white)] text-[11px] font-bold text-[var(--ink)] disabled:opacity-40"
                  onClick={() => {
                    setMenuOpen(false);
                    onRedo();
                  }}
                  disabled={!canRedo}
                >
                  <Icon name="redo" size={11} /> Rehacer
                </button>
              </div>

              <p className="px-3 pb-1.5 pt-1 text-[9.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
                Proyecto y IA
              </p>
              <button
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-bold text-[var(--sage-800)] bg-[var(--sage-50)] transition-colors hover:bg-[var(--sage-100)] mb-1"
                onClick={() => {
                  setMenuOpen(false);
                  onSettings();
                }}
              >
                <Icon name="lock" size={13} className="text-[var(--sage-700)]" />
                Configurar mi API Key (IA)
              </button>
              <button
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--sage-100)]"
                onClick={() => {
                  setMenuOpen(false);
                  onSnapshot();
                }}
              >
                <Icon name="history" size={13} className="text-[var(--sage-600)]" />
                Guardar instantánea
              </button>
              <button
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--sage-100)]"
                onClick={() => {
                  setMenuOpen(false);
                  onDuplicate();
                }}
              >
                <Icon name="duplicate" size={13} className="text-[var(--sage-600)]" />
                Duplicar proyecto
              </button>
              <div className="my-1 h-px bg-[var(--line)]" />
              {(user ?? getCurrentUser()) && (
                <button
                  type="button"
                  data-user-profile-mobile-btn
                  className="w-full px-3 py-1.5 mb-1 rounded-xl bg-[var(--white)] border border-[var(--line)] hover:border-[var(--ink)] text-[11px] flex items-center justify-between transition-colors text-left"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenProfile?.();
                  }}
                >
                  <span className="font-semibold text-[var(--muted)]">Mi cuenta</span>
                  <span className="font-bold text-[var(--ink)]">@{(user ?? getCurrentUser())?.handle}</span>
                </button>
              )}
              <button
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--sage-100)]"
                onClick={() => {
                  setMenuOpen(false);
                  onHome();
                }}
              >
                <Icon name="panel-left" size={13} className="text-[var(--sage-600)]" />
                Todos los proyectos
              </button>
              {onSignOut && (
                <button
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold text-[var(--danger)] transition-colors hover:bg-red-500/10"
                  onClick={() => {
                    setMenuOpen(false);
                    onSignOut();
                  }}
                >
                  <Icon name="lock" size={13} />
                  Cerrar sesión
                </button>
              )}
            </div>
          )}
        </div>

        <button className="btn btn-primary shrink-0 !px-2.5 sm:!px-3.5" onClick={onExport} title="Exportar vídeo (Ctrl+E)">
          <Icon name="download" size={14} />
          <span className="hidden md:inline">Exportar</span>
        </button>
      </div>
    </header>
  );
}
