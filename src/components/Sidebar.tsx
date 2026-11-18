import { useRef } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { AgentMessage, Project, TextClip } from "../shared/schema";
import type { AiStatus, JobState } from "../api";
import type { HistoryEntry, ProjectChangeHandler, SaveStatus, SidebarTab } from "../editorTypes";
import { MotionPanel } from "./MotionPanel/MotionPanel";
import { SkillsPanel } from "./SkillsPanel";
import { Icon } from "./Icon";
import { Inspector } from "./Inspector";
import { HistoryPanel } from "./HistoryPanel";

interface SidebarProps {
  project: Project;
  tab: SidebarTab;
  open: boolean;
  width: number;
  onResize: (width: number) => void;
  onResizeCommit: (width: number) => void;
  currentFrame: number;
  onFrameChange?: (frame: number) => void;
  selectedClipIds: string[];
  selectedTrackId: string | null;
  selectedMediaId: string | null;
  /** Clip seleccionado en el viewer (para IA Motion) */
  viewerSelectedClipId: string | null;
  disabled?: boolean;
  saveStatus: SaveStatus;
  past: HistoryEntry[];
  future: HistoryEntry[];
  snapshotsVersion: number;
  ai: AiStatus | null;
  onTabChange: (tab: SidebarTab) => void;
  onProjectChange: ProjectChangeHandler;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onSelectClips: (ids: string[]) => void;
  onSelectTrack: (trackId: string | null) => void;
  onSelectMedia: (mediaId: string | null) => void;
  onImportFiles: (files: File[]) => void;
  onRunAgentTool: (tool: string, args: Record<string, unknown>, label: string) => Promise<void>;
  onSaveBeforeExternalEdit: () => Promise<boolean>;
  onProjectSync: () => Promise<void>;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
  onAddText: (text: string, role: TextClip["role"]) => void;
  onExport: () => void;
  onSnapshot: () => void;
  onCreateSnapshot: (label: string) => Promise<void>;
  onRestoreSnapshot: (fileName: string) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onRestoreLocal: (index: number) => void;
  onOpenSettings?: () => void;
  onCloseMobile?: () => void;
}

const TABS: Array<{ id: SidebarTab; label: string; icon: "film" | "sliders" | "wand" | "history" }> = [
  { id: "motion", label: "IA Motion", icon: "film" },
  { id: "inspector", label: "Inspector", icon: "sliders" },
  { id: "skills", label: "Skills", icon: "wand" },
  { id: "history", label: "Historial", icon: "history" },
];

const MIN_WIDTH = 310;
const MAX_WIDTH = 680;
const DEFAULT_WIDTH = 350;

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

export function Sidebar(props: SidebarProps) {
  const { tab, open, onTabChange, width, onResize, onResizeCommit } = props;
  const drag = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, lastWidth: width };
    document.body.classList.add("resizing");
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const next = clampWidth(state.startWidth + state.startX - event.clientX);
    state.lastWidth = next;
    onResize(next);
  };

  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    onResizeCommit(state.lastWidth);
    document.body.classList.remove("resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 60 : 20;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + step;
    if (event.key === "ArrowRight") next = width - step;
    if (event.key === "Home") next = MIN_WIDTH;
    if (event.key === "End") next = MAX_WIDTH;
    if (event.key === "Enter") next = DEFAULT_WIDTH;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampWidth(next);
    onResize(clamped);
    onResizeCommit(clamped);
  };

  return (
    <aside
      className={`inspector${open ? " is-open" : ""}`}
      style={{ "--inspector-width": `${width}px` } as CSSProperties}
      aria-label="Panel lateral"
    >
      <div
        className="inspector-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Cambiar el ancho del panel"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        title="Arrastra para cambiar el ancho · doble clic para restablecer"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={() => {
          onResize(DEFAULT_WIDTH);
          onResizeCommit(DEFAULT_WIDTH);
        }}
        onKeyDown={resizeWithKeyboard}
      />
      <div className="inspector-header">
        <div className="inspector-tabs" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`inspector-tab${tab === item.id ? " active" : ""}`}
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onTabChange(item.id)}
            >
              <Icon name={item.icon} size={13} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        {props.onCloseMobile && (
          <button
            type="button"
            onClick={props.onCloseMobile}
            className="inspector-mobile-close min-[1101px]:hidden"
            aria-label="Volver al video"
            title="Volver al video"
          >
            <Icon name="close" size={12} />
            <span>Video</span>
          </button>
        )}
      </div>

      <div className={`inspector-body${tab === "inspector" ? "" : " flush"}`}>
        <div className={tab === "motion" ? "flex flex-1 min-h-0 h-full flex-col overflow-hidden" : "hidden"}>
          <MotionPanel
            project={props.project}
            currentFrame={props.currentFrame}
            disabled={props.disabled}
            aiConfigured={props.ai?.configured}
            onOpenSettings={props.onOpenSettings}
            onToast={props.onToast}
            onSaveBeforeExternalEdit={props.onSaveBeforeExternalEdit}
            onProjectSync={props.onProjectSync}
            onProjectChange={props.onProjectChange}
            onSelectClips={props.onSelectClips}
            onTabChange={props.onTabChange}
            selectedClipId={props.selectedClipIds[0] ?? props.viewerSelectedClipId}
          />
        </div>
        {tab === "inspector" && (
          <Inspector
            project={props.project}
            currentFrame={props.currentFrame}
            onFrameChange={props.onFrameChange}
            selectedClipIds={props.selectedClipIds}
            selectedTrackId={props.selectedTrackId}
            disabled={props.disabled}
            onProjectChange={props.onProjectChange}
            onBeginEdit={props.onBeginEdit}
            onEndEdit={props.onEndEdit}
            onSelectClips={props.onSelectClips}
            onSelectTrack={props.onSelectTrack}
            onToast={props.onToast}
            onAddText={props.onAddText}
            onExport={props.onExport}
            onSnapshot={props.onSnapshot}
            onTabChange={props.onTabChange}
          />
        )}
        {tab === "history" && (
          <HistoryPanel
            project={props.project}
            past={props.past}
            future={props.future}
            saveStatus={props.saveStatus}
            snapshotsVersion={props.snapshotsVersion}
            onCreateSnapshot={props.onCreateSnapshot}
            onRestoreSnapshot={props.onRestoreSnapshot}
            onUndo={props.onUndo}
            onRedo={props.onRedo}
            onRestoreLocal={props.onRestoreLocal}
            onToast={props.onToast}
          />
        )}
        {tab === "skills" && (
          <SkillsPanel
            project={props.project}
            currentFrame={props.currentFrame}
            disabled={props.disabled}
            onRunTool={props.onRunAgentTool}
            onRunWithAgent={(_skill, prompt) => {
              onTabChange("motion");
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent("oeclip:run-skill-prompt", { detail: { prompt } }));
              }, 60);
            }}
            onToast={props.onToast}
          />
        )}
      </div>
    </aside>
  );
}
