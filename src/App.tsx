import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AgentMessage,
  AgentPlan,
  AgentStep,
  ExportRecord,
  ExportSettings,
  MediaAsset,
  Project,
  TextClip,
} from "./shared/schema";
import {
  api,
  ApiError,
  getCurrentUser,
  type AiStatus,
  type CreatorUser,
  type JobState,
  type ProjectBundle,
  type ProjectListItem,
  type ServerConfig,
} from "./api";
import { createAgentMessage, ensureTrack, firstVideoTrack, getClipById, timelineDurationFrames } from "./shared/project";
import { addMediaClip, addTextClip, moveClip, removeClips, splitAtFrame } from "./shared/timeline";
import { fpsValue } from "./shared/time";
import type { AspectRatio, ResolutionHeight } from "./shared/presets";
import type { HistoryEntry, ProjectChangeHandler, SaveStatus, SidebarTab } from "./editorTypes";
import { TopBar } from "./components/TopBar";
import { MediaPanel, type UploadItem } from "./components/MediaPanel";
import { Viewer } from "./components/Viewer";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { ExportDialog } from "./components/ExportDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { AdminUsersModal } from "./components/AdminUsersModal";
import { UserProfileModal } from "./components/UserProfileModal";
import { Welcome } from "./components/Welcome";
import { ConfirmDialog } from "./components/Modal";
import { Toasts, type ToastItem, type ToastKind } from "./components/Toasts";
import { Icon } from "./components/Icon";
import { Brand } from "./components/Brand";

type Phase = "boot" | "welcome" | "editor" | "fatal";

const SIDEBAR_WIDTH_KEY = "novacut.sidebarWidth";
const SIDEBAR_DEFAULT_WIDTH = 340;
const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 760;

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function readSidebarWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

interface ServerEvent {
  type: "hello" | "job" | "agent-step" | "agent-plan" | "project";
  job?: JobState;
  planId?: string;
  step?: AgentStep;
  status?: AgentPlan["status"];
  revision?: number;
  projectId?: string;
}

interface GestureState {
  project: Project;
  label: string;
  changed: boolean;
}

function isTerminal(status: JobState["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function cloneProject(project: Project): Project {
  return structuredClone(project);
}

function mergeMediaStatus(local: MediaAsset[], server: MediaAsset[]): MediaAsset[] {
  const serverById = new Map(server.map((asset) => [asset.id, asset]));
  return local.map((asset) => {
    const fresh = serverById.get(asset.id);
    if (!fresh) return asset;
    return {
      ...asset,
      thumbnail: fresh.thumbnail,
      waveform: fresh.waveform,
      proxy: fresh.proxy,
      proxyFile: fresh.proxyFile,
      missing: fresh.missing,
    };
  });
}

function projectIdFromHash(): string | null {
  const match = /^#\/p\/([A-Za-z0-9_]+)$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [bootError, setBootError] = useState<string | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [currentUser, setCurrentUser] = useState<CreatorUser | null>(() => getCurrentUser());
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [conflict, setConflict] = useState<{ revision: number } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [viewerSelectedClipId, setViewerSelectedClipId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);

  const [past, setPast] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);
  const [snapshotsVersion, setSnapshotsVersion] = useState(0);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("motion");
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1100);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [mediaOpen, setMediaOpen] = useState(() => window.innerWidth > 880);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [adminUsersOpen, setAdminUsersOpen] = useState(false);
  const [switchAccountTrigger, setSwitchAccountTrigger] = useState(0);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [confirmationPlanId, setConfirmationPlanId] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#F7F8F4");
    try {
      window.localStorage.removeItem("novacut.theme");
    } catch {
      // noop
    }
  }, []);

  const projectRef = useRef<Project | null>(null);
  const baseRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const changeSeqRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const importingRef = useRef(false);
  const pastRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);
  const gestureRef = useRef<GestureState | null>(null);
  const jobsRef = useRef<JobState[]>([]);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef<
    Map<number, { timerId: number | null; remainingMs: number; startedAt: number }>
  >(new Map());
  const planningRef = useRef(false);
  const currentFrameRef = useRef(0);
  const selectedClipIdsRef = useRef<string[]>([]);
  const selectedTrackIdRef = useRef<string | null>(null);
  const selectedMediaIdRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const agentRunningRef = useRef(false);
  const sessionStartedAtRef = useRef(Date.now());
  const quickFileInputRef = useRef<HTMLInputElement>(null);
  const autoInsertOnImportRef = useRef(false);

  currentFrameRef.current = currentFrame;
  selectedClipIdsRef.current = selectedClipIds;
  selectedTrackIdRef.current = selectedTrackId;
  selectedMediaIdRef.current = selectedMediaId;
  playingRef.current = playing;

  const clearToastTimer = useCallback((id: number) => {
    const entry = toastTimersRef.current.get(id);
    if (!entry) return;
    if (entry.timerId !== null) window.clearTimeout(entry.timerId);
    toastTimersRef.current.delete(id);
  }, []);

  const scheduleToastTimer = useCallback((id: number, delayMs: number) => {
    const existing = toastTimersRef.current.get(id);
    if (existing?.timerId !== null && existing?.timerId !== undefined) {
      window.clearTimeout(existing.timerId);
    }
    const timerId = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((items) => items.filter((item) => item.id !== id));
    }, delayMs);
    toastTimersRef.current.set(id, { timerId, remainingMs: delayMs, startedAt: Date.now() });
  }, []);

  const pauseToast = useCallback(
    (id: number, paused: boolean) => {
      const entry = toastTimersRef.current.get(id);
      if (!entry) return;
      if (paused) {
        if (entry.timerId === null) return;
        window.clearTimeout(entry.timerId);
        const elapsed = Date.now() - entry.startedAt;
        toastTimersRef.current.set(id, {
          timerId: null,
          remainingMs: Math.max(900, entry.remainingMs - elapsed),
          startedAt: Date.now(),
        });
      } else if (entry.timerId === null) {
        scheduleToastTimer(id, entry.remainingMs);
      }
    },
    [scheduleToastTimer],
  );

  useEffect(() => {
    return () => {
      for (const entry of toastTimersRef.current.values()) {
        if (entry.timerId !== null) window.clearTimeout(entry.timerId);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  const pushToast = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = toastIdRef.current + 1;
      toastIdRef.current = id;
      setToasts((items) => {
        const last = items[items.length - 1];
        // Un mismo aviso repetido se refresca en su sitio en vez de apilarse.
        if (last && last.message === message && last.kind === kind) {
          return [...items.slice(0, -1), { id, message, kind }];
        }
        return [...items.slice(-1), { id, message, kind }];
      });
      scheduleToastTimer(id, kind === "error" ? 7200 : 4200);
    },
    [scheduleToastTimer],
  );

  const replaceProject = useCallback((next: Project) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const pushPast = useCallback((previous: Project, label: string) => {
    const entry: HistoryEntry = { project: cloneProject(previous), label, at: Date.now() };
    const next = [...pastRef.current, entry].slice(-80);
    pastRef.current = next;
    setPast(next);
  }, []);

  const clearFuture = useCallback(() => {
    futureRef.current = [];
    setFuture([]);
  }, []);

  const scheduleSave = useCallback((delay = 900) => {
    dirtyRef.current = true;
    if (importingRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistRef.current();
    }, delay);
  }, []);

  const persistProject = useCallback(async (): Promise<boolean> => {
    const current = projectRef.current;
    if (!current) return true;
    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      return false;
    }
    const targetId = current.id;
    const seq = changeSeqRef.current;
    saveInFlightRef.current = true;
    setSaveStatus("saving");
    try {
      let bundle: ProjectBundle;
      try {
        bundle = await api.saveProject(targetId, current, baseRevisionRef.current);
      } catch (firstErr) {
        if (firstErr instanceof ApiError && firstErr.status === 409) {
          const details = firstErr.details as { currentRevision?: number } | undefined;
          if (typeof details?.currentRevision === "number") {
            baseRevisionRef.current = details.currentRevision;
            bundle = await api.saveProject(targetId, current, baseRevisionRef.current);
          } else {
            throw firstErr;
          }
        } else {
          throw firstErr;
        }
      }
      if (projectRef.current?.id !== targetId) return true;
      baseRevisionRef.current = bundle.project.revision;
      setConflict(null);
      const latest = projectRef.current;
      if (latest) {
        replaceProject({
          ...latest,
          revision: bundle.project.revision,
          updatedAt: bundle.project.updatedAt,
          media: mergeMediaStatus(latest.media, bundle.project.media),
        });
      }
      setExports(bundle.exports);
      setMessages(bundle.agentMessages);
      if (seq === changeSeqRef.current) {
        dirtyRef.current = false;
        setSaveStatus("saved");
      } else {
        dirtyRef.current = true;
        setSaveStatus("dirty");
        saveAgainRef.current = true;
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const details = error.details as { currentRevision?: number } | undefined;
        const revision = typeof details?.currentRevision === "number" ? details.currentRevision : -1;
        dirtyRef.current = true;
        setSaveStatus("conflict");
        setConflict({ revision });
        pushToast(
          "El proyecto cambió en el servidor. Recarga para continuar o guarda tu versión local.",
          "error",
        );
      } else {
        dirtyRef.current = true;
        setSaveStatus("error");
        pushToast(errorMessage(error, "No se pudo guardar el proyecto."), "error");
      }
      return false;
    } finally {
      saveInFlightRef.current = false;
      if (saveAgainRef.current && dirtyRef.current) {
        saveAgainRef.current = false;
        window.setTimeout(() => void persistRef.current(), 350);
      }
    }
  }, [pushToast, replaceProject]);

  const persistRef = useRef(persistProject);
  persistRef.current = persistProject;

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    let waited = 0;
    while (saveInFlightRef.current && waited < 20_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      waited += 60;
    }
    if (!dirtyRef.current) return true;
    return persistRef.current();
  }, []);

  const applyProject: ProjectChangeHandler = useCallback(
    (next, options = {}) => {
      const previous = projectRef.current;
      if (!previous || previous === next) return;
      if (options.history !== false) {
        if (gestureRef.current) {
          gestureRef.current.changed = true;
          if (!gestureRef.current.label && options.label) gestureRef.current.label = options.label;
        } else {
          pushPast(previous, options.label ?? "Editar montaje");
          clearFuture();
        }
      }
      replaceProject(next);
      dirtyRef.current = true;
      changeSeqRef.current += 1;
      setSaveStatus("dirty");
      if (options.save !== false) scheduleSave();
    },
    [clearFuture, pushPast, replaceProject, scheduleSave],
  );

  const beginEdit = useCallback(() => {
    const current = projectRef.current;
    if (!current || gestureRef.current) return;
    gestureRef.current = { project: cloneProject(current), label: "", changed: false };
  }, []);

  const endEdit = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    const current = projectRef.current;
    if (!gesture || !current || !gesture.changed) return;
    pushPast(gesture.project, gesture.label || "Ajustar valores");
    clearFuture();
    dirtyRef.current = true;
    changeSeqRef.current += 1;
    setSaveStatus("dirty");
    scheduleSave(500);
  }, [clearFuture, pushPast, scheduleSave]);

  const undo = useCallback(() => {
    const entry = pastRef.current.at(-1);
    const current = projectRef.current;
    if (!entry || !current) return;
    pastRef.current = pastRef.current.slice(0, -1);
    setPast(pastRef.current);
    const redoEntry: HistoryEntry = { project: cloneProject(current), label: entry.label, at: Date.now() };
    futureRef.current = [redoEntry, ...futureRef.current].slice(0, 80);
    setFuture(futureRef.current);
    replaceProject(cloneProject(entry.project));
    dirtyRef.current = true;
    changeSeqRef.current += 1;
    setSaveStatus("dirty");
    setSelectedClipIds([]);
    scheduleSave(350);
    pushToast(`Deshecho: ${entry.label}`, "info");
  }, [pushToast, replaceProject, scheduleSave]);

  const redo = useCallback(() => {
    const entry = futureRef.current[0];
    const current = projectRef.current;
    if (!entry || !current) return;
    futureRef.current = futureRef.current.slice(1);
    setFuture(futureRef.current);
    const undoEntry: HistoryEntry = { project: cloneProject(current), label: entry.label, at: Date.now() };
    pastRef.current = [...pastRef.current, undoEntry].slice(-80);
    setPast(pastRef.current);
    replaceProject(cloneProject(entry.project));
    dirtyRef.current = true;
    changeSeqRef.current += 1;
    setSaveStatus("dirty");
    setSelectedClipIds([]);
    scheduleSave(350);
    pushToast(`Rehecho: ${entry.label}`, "info");
  }, [pushToast, replaceProject, scheduleSave]);

  const restoreLocal = useCallback(
    (index: number) => {
      const entry = pastRef.current[index];
      const current = projectRef.current;
      if (!entry || !current) return;
      pastRef.current = pastRef.current.slice(0, index);
      setPast(pastRef.current);
      futureRef.current = [
        { project: cloneProject(current), label: `Antes de volver a ${entry.label}`, at: Date.now() },
        ...futureRef.current,
      ].slice(0, 80);
      setFuture(futureRef.current);
      replaceProject(cloneProject(entry.project));
      dirtyRef.current = true;
      changeSeqRef.current += 1;
      setSaveStatus("dirty");
      setSelectedClipIds([]);
      scheduleSave(350);
      pushToast("Estado de la sesión restaurado.", "success");
    },
    [pushToast, replaceProject, scheduleSave],
  );

  const applyBundle = useCallback((bundle: ProjectBundle) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    projectRef.current = bundle.project;
    setProject(bundle.project);
    setConfirmationPlanId(null);
    baseRevisionRef.current = bundle.project.revision;
    dirtyRef.current = false;
    changeSeqRef.current = 0;
    saveAgainRef.current = false;
    setExports(bundle.exports);
    setMessages(bundle.agentMessages);
    setSaveStatus("saved");
    setConflict(null);
    setPhase("editor");
    setCurrentFrame(0);
    setPlaying(false);
    setSelectedClipIds([]);
    setSelectedTrackId(null);
    setSelectedMediaId(null);
    pastRef.current = [];
    setPast([]);
    futureRef.current = [];
    setFuture([]);
    jobsRef.current = [];
    setJobs([]);
    setUploads([]);
    setPlanning(false);
    planningRef.current = false;
    setExportOpen(false);
    setSettingsOpen(false);
    setProfileOpen(false);
    setAdminUsersOpen(false);
    setRemoveTarget(null);
    window.location.hash = `#/p/${bundle.project.id}`;
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      setProjects(await api.listProjects());
    } catch (error) {
      pushToast(errorMessage(error, "No se pudieron cargar los proyectos."), "error");
    } finally {
      setProjectsLoading(false);
    }
  }, [pushToast]);

  const openProject = useCallback(
    async (id: string) => {
      const bundle = await api.getProject(id);
      applyBundle(bundle);
    },
    [applyBundle],
  );

  const createProject = useCallback(
    async (input: { name: string; aspect: AspectRatio; height: ResolutionHeight; fps: number }) => {
      const bundle = await api.createProject(input);
      applyBundle(bundle);
      pushToast(`Proyecto "${bundle.project.name}" creado.`, "success");
    },
    [applyBundle, pushToast],
  );

  const createDemo = useCallback(async () => {
    const bundle = await api.createDemo();
    applyBundle(bundle);
    pushToast("Proyecto de demostración creado con medios reales.", "success");
  }, [applyBundle, pushToast]);

  const duplicateProjectById = useCallback(
    async (id: string) => {
      const bundle = await api.duplicateProject(id);
      await loadProjects();
      pushToast(`Proyecto duplicado como "${bundle.project.name}".`, "success");
    },
    [loadProjects, pushToast],
  );

  const duplicateCurrent = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const saved = await flushSave();
    if (!saved) {
      pushToast("No se pudo guardar el proyecto antes de duplicarlo.", "error");
      return;
    }
    try {
      const bundle = await api.duplicateProject(current.id);
      applyBundle(bundle);
      pushToast(`Proyecto duplicado como "${bundle.project.name}".`, "success");
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo duplicar el proyecto."), "error");
    }
  }, [applyBundle, flushSave, pushToast]);

  const deleteProjectById = useCallback(async (id: string) => {
    await api.deleteProject(id);
    await loadProjects();
  }, [loadProjects]);

  const revealProjectById = useCallback(async (id: string) => {
    await api.revealProject(id);
  }, []);

  const goHome = useCallback(async () => {
    const saved = await flushSave();
    if (!saved) {
      pushToast("No se pudo guardar el proyecto. Resuelve el conflicto antes de salir.", "error");
      return;
    }
    setPhase("welcome");
    projectRef.current = null;
    setProject(null);
    setExports([]);
    setMessages([]);
    jobsRef.current = [];
    setJobs([]);
    setPlaying(false);
    setSelectedClipIds([]);
    setSelectedTrackId(null);
    setSelectedMediaId(null);
    setExportOpen(false);
    setSettingsOpen(false);
    setProfileOpen(false);
    setAdminUsersOpen(false);
    window.location.hash = "";
    await loadProjects();
  }, [flushSave, loadProjects, pushToast]);

  const refreshConfig = useCallback(async (): Promise<ServerConfig | null> => {
    try {
      const next = await api.config();
      setConfig(next);
      setAi(next.ai);
      return next;
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo consultar la configuración."), "error");
      return null;
    }
  }, [pushToast]);

  const handleAuthSuccess = useCallback(
    async (user: CreatorUser) => {
      setCurrentUser(user);
      await Promise.all([loadProjects(), refreshConfig()]);
    },
    [loadProjects, refreshConfig],
  );

  const handleUserUpdated = useCallback(
    async (user: CreatorUser) => {
      setCurrentUser(user);
      await Promise.all([loadProjects(), refreshConfig()]);
    },
    [loadProjects, refreshConfig],
  );

  const handleSwitchAccountFromEditor = useCallback(async () => {
    setProfileOpen(false);
    setAdminUsersOpen(false);
    await goHome();
    setSwitchAccountTrigger((prev) => prev + 1);
  }, [goHome]);

  const handleSignOut = useCallback(async () => {
    if (projectRef.current) {
      await flushSave().catch(() => false);
    }
    await api.logout();
    setCurrentUser(null);
    setProjects([]);
    setPhase("welcome");
    projectRef.current = null;
    setProject(null);
    setExports([]);
    setMessages([]);
    jobsRef.current = [];
    setJobs([]);
    setPlaying(false);
    setSelectedClipIds([]);
    setSelectedTrackId(null);
    setSelectedMediaId(null);
    setExportOpen(false);
    setSettingsOpen(false);
    setProfileOpen(false);
    setAdminUsersOpen(false);
    window.location.hash = "";
    void refreshConfig();
    pushToast("Sesión cerrada.", "info");
  }, [flushSave, pushToast, refreshConfig]);

  const refreshExports = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id) return;
    try {
      const list = await api.listExports(id);
      if (projectRef.current?.id === id) setExports(list);
    } catch {
      // La lista se refresca de nuevo al terminar el trabajo o abrir el dialogo.
    }
  }, []);

  const refreshMediaStatuses = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id) return;
    try {
      const bundle = await api.getProject(id);
      const current = projectRef.current;
      if (!current || current.id !== id) return;
      replaceProject({ ...current, media: mergeMediaStatus(current.media, bundle.project.media) });
    } catch {
      // Sin conexión momentánea: el próximo evento o guardado sincronizará el estado.
    }
  }, [replaceProject]);

  const handleTerminalJob = useCallback(
    async (job: JobState) => {
      if (job.projectId !== projectRef.current?.id) return;
      if (job.type === "proxy" || job.type === "media") {
        await refreshMediaStatuses();
        return;
      }
      if (job.type === "export") {
        await refreshExports();
        return;
      }
      if (job.type !== "agent") return;
      const previous = projectRef.current;
      try {
        const bundle = await api.getProject(job.projectId);
        if (projectRef.current?.id !== job.projectId) return;
        if (previous) pushPast(previous, job.label || "Agente");
        clearFuture();
        projectRef.current = bundle.project;
        setProject(bundle.project);
        baseRevisionRef.current = bundle.project.revision;
        dirtyRef.current = false;
        changeSeqRef.current += 1;
        setSaveStatus("saved");
        setConflict(null);
        setExports(bundle.exports);
        setMessages(bundle.agentMessages);
        setSelectedClipIds([]);
        setCurrentFrame((frame) => Math.min(frame, timelineDurationFrames(bundle.project)));
        if (job.status === "done") {
          pushToast("El agente terminó y el montaje se actualizó.", "success");
        } else if (job.status === "cancelled") {
          pushToast("Ejecución cancelada. Se conservan los pasos ya aplicados.", "info");
        } else {
          pushToast(`El agente se detuvo: ${job.error ?? "error desconocido"}`, "error");
        }
      } catch (error) {
        pushToast(errorMessage(error, "No se pudo recargar el proyecto tras el agente."), "error");
      }
    },
    [clearFuture, pushPast, pushToast, refreshExports, refreshMediaStatuses],
  );

  const handleTerminalJobRef = useRef(handleTerminalJob);
  handleTerminalJobRef.current = handleTerminalJob;

  const updateJob = useCallback((job: JobState) => {
    const previous = jobsRef.current.find((item) => item.id === job.id);
    const next = previous
      ? jobsRef.current.map((item) => (item.id === job.id ? job : item))
      : [...jobsRef.current, job];
    jobsRef.current = next;
    setJobs(next);
    if (!isTerminal(job.status)) return;
    if (previous && isTerminal(previous.status)) return;
    // El servidor reenvía los últimos trabajos al abrir el SSE. Los que ya habían
    // terminado antes de cargar la página no deben repetir avisos ni pasos de
    // historial: el proyecto recién cargado ya incluye su resultado.
    if (!previous) {
      const createdAt = Date.parse(job.createdAt);
      if (Number.isFinite(createdAt) && createdAt < sessionStartedAtRef.current - 1500) return;
    }
    // Un trabajo puede llegar ya terminado (planes muy rápidos) o el evento SSE
    // final puede perderse: en ambos casos sincronizamos el proyecto y el chat.
    void handleTerminalJobRef.current(job);
  }, []);

  const refreshJobs = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id) return;
    try {
      const list = await api.listJobs(id);
      if (projectRef.current?.id !== id) return;
      jobsRef.current = list;
      setJobs(list);
    } catch {
      // SSE mantiene la lista cuando la consulta puntual falla.
    }
  }, []);

  const activeAgentJob = useMemo(
    () =>
      jobs
        .filter(
          (job) =>
            job.type === "agent" && (job.status === "queued" || job.status === "running"),
        )
        .at(-1) ?? null,
    [jobs],
  );
  const agentRunning = Boolean(activeAgentJob);
  agentRunningRef.current = agentRunning;

  // Respaldo por sondeo: si el SSE se corta, el estado del trabajo y el plan se
  // actualizan igualmente y la barra de progreso desaparece al terminar.
  useEffect(() => {
    const jobId = activeAgentJob?.id;
    if (!jobId) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api
        .getJob(jobId)
        .then((job) => {
          if (!cancelled) updateJob(job);
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeAgentJob?.id, updateJob]);

  const applySnapshotFromServer = useCallback(
    async (id: string, fileName: string) => {
      const previous = projectRef.current;
      const bundle = await api.restoreSnapshot(id, fileName);
      if (!projectRef.current || projectRef.current.id !== id) return;
      if (previous) pushPast(previous, "Antes de restaurar");
      clearFuture();
      projectRef.current = bundle.project;
      setProject(bundle.project);
      baseRevisionRef.current = bundle.project.revision;
      dirtyRef.current = false;
      changeSeqRef.current += 1;
      setSaveStatus("saved");
      setConflict(null);
      setExports(bundle.exports);
      setMessages(bundle.agentMessages);
      setSelectedClipIds([]);
      setCurrentFrame(0);
      setPlaying(false);
      setSnapshotsVersion((value) => value + 1);
    },
    [clearFuture, pushPast],
  );

  const createSnapshot = useCallback(
    async (label: string) => {
      const id = projectRef.current?.id;
      if (!id) throw new Error("No hay un proyecto abierto.");
      const saved = await flushSave();
      if (!saved) throw new Error("No se pudo guardar el proyecto antes de crear la instantánea.");
      await api.createSnapshot(id, label);
      setSnapshotsVersion((value) => value + 1);
    },
    [flushSave],
  );

  const restoreSnapshot = useCallback(
    async (fileName: string) => {
      const id = projectRef.current?.id;
      if (!id) throw new Error("No hay un proyecto abierto.");
      const saved = await flushSave();
      if (!saved) throw new Error("No se pudo guardar el proyecto antes de restaurar.");
      await applySnapshotFromServer(id, fileName);
    },
    [applySnapshotFromServer, flushSave],
  );

  const snapshotNow = useCallback(async () => {
    try {
      await createSnapshot(`Versión manual · ${new Date().toLocaleString("es-ES")}`);
      pushToast("Instantánea guardada.", "success");
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo guardar la instantánea."), "error");
    }
  }, [createSnapshot, pushToast]);

  // ---------------------------------------------------------------- agente
  const planAgent = useCallback(
    async (instruction: string, preferLocal: boolean) => {
      if (planningRef.current) return;
      const current = projectRef.current;
      if (!current) return;
      if (agentRunningRef.current) {
        pushToast("Espera a que termine la ejecución actual del agente.", "info");
        return;
      }
      planningRef.current = true;
      setPlanning(true);
      setConfirmationPlanId(null);
      setSidebarTab("motion");
      setMessages((items) => [...items, createAgentMessage("user", instruction)]);
      try {
        const saved = await flushSave();
        if (!saved) throw new Error("No se pudo guardar el proyecto antes de planificar.");
        const result = await api.plan(current.id, instruction, {
          clipIds: [...selectedClipIdsRef.current],
          mediaId: selectedMediaIdRef.current ?? undefined,
          preferLocal,
        });
        setMessages((items) => [...items, result.message]);
        setAi(result.ai);
        const requiresConfirmation = result.plan.steps.some(
          (step) => step.risk === "high" || step.tool === "remove_clip",
        );
        if (requiresConfirmation) {
          setConfirmationPlanId(result.plan.id);
          pushToast("Revisa y confirma las acciones de alto impacto antes de continuar.", "info");
          return;
        }
        const execution = await api.executePlan(current.id, result.plan.id);
        setMessages((items) =>
          items.map((message) =>
            message.plan?.id === result.plan.id
              ? { ...message, plan: { ...message.plan, status: "running" as const } }
              : message,
          ),
        );
        const job = await api.getJob(execution.jobId).catch(() => null);
        if (job) updateJob(job);
        pushToast("El copiloto está aplicando los cambios al montaje.", "info");
      } catch (error) {
        const message = errorMessage(error, "No se pudo preparar el plan de edición.");
        setMessages((items) => [...items, createAgentMessage("assistant", message, { kind: "error" })]);
        pushToast(message, "error");
      } finally {
        planningRef.current = false;
        setPlanning(false);
      }
    },
    [flushSave, pushToast, updateJob],
  );

  const executePlan = useCallback(
    async (planId: string) => {
      const current = projectRef.current;
      if (!current || agentRunningRef.current) return;
      try {
        const saved = await flushSave();
        if (!saved) throw new Error("No se pudo guardar el proyecto antes de aplicar el plan.");
        const result = await api.executePlan(current.id, planId);
        setMessages((items) =>
          items.map((message) =>
            message.plan?.id === planId
              ? { ...message, plan: { ...message.plan, status: "running" as const } }
              : message,
          ),
        );
        setConfirmationPlanId(null);
        const job = await api.getJob(result.jobId).catch(() => null);
        if (job) updateJob(job);
        pushToast("Plan en ejecución. La edición manual queda en pausa hasta que termine.", "info");
      } catch (error) {
        pushToast(errorMessage(error, "No se pudo ejecutar el plan."), "error");
      }
    },
    [flushSave, pushToast, updateJob],
  );

  const cancelAgent = useCallback(() => {
    if (!activeAgentJob) return;
    pushToast("Cancelando la ejecución del agente...", "info");
    void api
      .cancelJob(activeAgentJob.id)
      .then((job) => updateJob(job))
      .catch((error) => pushToast(errorMessage(error, "No se pudo cancelar la tarea."), "error"));
  }, [activeAgentJob, pushToast, updateJob]);

  const clearAgent = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id) return;
    try {
      await api.clearAgent(id);
      setMessages([]);
      setConfirmationPlanId(null);
      pushToast("Historial del agente borrado.", "success");
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo borrar el historial del agente."), "error");
    }
  }, [pushToast]);

  const runAgentTool = useCallback(
    async (tool: string, args: Record<string, unknown>, label: string) => {
      const projectId = projectRef.current?.id;
      if (!projectId) throw new Error("No hay ningún proyecto activo.");
      const saved = await flushSave();
      if (!saved) throw new Error("No se pudo guardar el proyecto antes de aplicar el cambio.");
      const current = projectRef.current;
      if (!current || current.id !== projectId) throw new Error("El proyecto activo cambió antes de aplicar el cambio.");

      const result = await api.runTool(projectId, tool, args);
      const bundle = await api.getProject(projectId);
      if (projectRef.current?.id !== projectId) return;

      pushPast(cloneProject(current), label);
      clearFuture();
      replaceProject(bundle.project);
      baseRevisionRef.current = bundle.project.revision;
      dirtyRef.current = false;
      changeSeqRef.current += 1;
      setSaveStatus("saved");
      setMessages(bundle.agentMessages);
      setExports(bundle.exports);
      setSelectedClipIds([]);
      pushToast(result.summary, "success");
    },
    [clearFuture, flushSave, pushPast, pushToast, replaceProject],
  );

  const syncExternalProject = useCallback(async () => {
    const projectId = projectRef.current?.id;
    if (!projectId) return;
    const bundle = await api.getProject(projectId);
    if (projectRef.current?.id !== projectId) return;
    replaceProject(bundle.project);
    baseRevisionRef.current = bundle.project.revision;
    dirtyRef.current = false;
    changeSeqRef.current += 1;
    setSaveStatus("saved");
    setMessages(bundle.agentMessages);
    setExports(bundle.exports);
  }, [replaceProject]);

  const refreshAi = useCallback(async () => {
    try {
      const next = await api.aiStatus();
      setAi(next);
      pushToast(next.configured ? `IA conectada: ${next.model}` : "Planificador local activo.", "info");
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo consultar el estado de la IA."), "error");
    }
  }, [pushToast]);

  // ---------------------------------------------------------------- medios
  const importFiles = useCallback(
    async (files: File[]) => {
      const active = projectRef.current;
      if (!active || files.length === 0) return;
      const saved = await flushSave();
      if (!saved) {
        pushToast("No se puede importar mientras haya un conflicto sin resolver.", "error");
        return;
      }
      importingRef.current = true;
      const patchUpload = (id: string, patch: Partial<UploadItem>) => {
        setUploads((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
      };
      try {
        for (const [index, file] of files.entries()) {
          const uploadId = `upl_${Date.now().toString(36)}_${index}`;
          setUploads((items) => [
            ...items,
            { id: uploadId, name: file.name, progress: 0, status: "uploading" },
          ]);
          try {
            const result = await api.uploadMedia(active.id, file, (ratio) => {
              patchUpload(uploadId, { progress: Math.min(0.99, ratio) });
            });
            patchUpload(uploadId, { progress: 1, status: "done" });
            const current = projectRef.current;
            let addedTimelineClipId: string | null = null;
            if (current && current.id === active.id) {
              const exists = current.media.some((asset) => asset.id === result.asset.id);
              const media = exists
                ? current.media.map((asset) => (asset.id === result.asset.id ? result.asset : asset))
                : [...current.media, result.asset];
              let next: Project = { ...current, media, revision: result.revision };
              const mediaById = new Map(media.map((asset) => [asset.id, asset]));
              const isSyntheticClip = (clip: Project["tracks"][number]["clips"][number]) => {
                if (clip.type === "text") return false;
                if (clip.remotion || clip.name.startsWith("Escena Fondo") || clip.name.startsWith("Locución IA")) {
                  return true;
                }
                const asset = mediaById.get(clip.mediaId);
                return Boolean(
                  asset &&
                    (asset.origin === "generated" ||
                      asset.file.startsWith("virtual://") ||
                      asset.file.includes("swarm-bg-canvas")),
                );
              };
              const currentV1 = firstVideoTrack(current);
              const hasRealUserVideoOnV1 = Boolean(
                currentV1?.clips.some((clip) => !isSyntheticClip(clip)),
              );
              const isRealVideoOrImage =
                (result.asset.kind === "video" || result.asset.kind === "image") &&
                result.asset.origin !== "generated";
              const shouldAutoAdd =
                autoInsertOnImportRef.current ||
                timelineDurationFrames(current) === 0 ||
                (!hasRealUserVideoOnV1 && isRealVideoOrImage);
              if (shouldAutoAdd) {
                const cloned: Project = {
                  ...next,
                  tracks: next.tracks.map((track) => ({ ...track, clips: [...track.clips] })),
                };
                const targetKind = result.asset.kind === "audio" ? "audio" : "video";
                const track =
                  targetKind === "video"
                    ? firstVideoTrack(cloned) ?? ensureTrack(cloned, "video")
                    : ensureTrack(cloned, "audio");
                if (!track.locked) {
                  if (!hasRealUserVideoOnV1 && result.asset.kind === "video") {
                    for (const t of cloned.tracks) {
                      if (t.kind === "video" || t.kind === "audio") {
                        t.clips = t.clips.filter((clip) => !isSyntheticClip(clip));
                      }
                    }
                  }
                  const alreadyInTrack = track.clips.some(
                    (clip) => clip.type !== "text" && clip.mediaId === result.asset.id,
                  );
                  if (!alreadyInTrack) {
                    const startFrame = track.clips.reduce(
                      (maxEnd, clip) => Math.max(maxEnd, clip.startFrame + clip.durationFrames),
                      0,
                    );
                    const added = addMediaClip(cloned, track.id, result.asset.id, startFrame);
                    if (added.ok && added.clip) {
                      next = added.project;
                      addedTimelineClipId = added.clip.id;
                    }
                  }
                }
              }
              projectRef.current = next;
              setProject(next);
              baseRevisionRef.current = result.revision;
              if (addedTimelineClipId) {
                setSelectedClipIds([addedTimelineClipId]);
                setSelectedMediaId(result.asset.id);
                setViewerSelectedClipId(addedTimelineClipId);
                dirtyRef.current = true;
                const triggerSave = () => {
                  window.setTimeout(() => {
                    if (!dirtyRef.current) return;
                    if (importingRef.current) {
                      triggerSave();
                    } else {
                      scheduleSave(220);
                    }
                  }, 220);
                };
                triggerSave();
                if (window.innerWidth <= 880) {
                  setMediaOpen(false);
                }
              }
            }
            pushToast(
              addedTimelineClipId
                ? `"${result.asset.name}" añadido al timeline.`
                : `"${result.asset.name}" importado.`,
              "success",
            );
          } catch (error) {
            const message = errorMessage(error, "No se pudo importar el archivo.");
            patchUpload(uploadId, { status: "error", error: message });
            pushToast(message, "error");
          }
        }
      } finally {
        importingRef.current = false;
        setSaveStatus(dirtyRef.current ? "dirty" : "saved");
        if (dirtyRef.current) {
          void persistRef.current();
        }
        window.setTimeout(() => {
          setUploads((items) => items.filter((item) => item.status !== "done"));
        }, 2200);
      }
    },
    [flushSave, pushToast, scheduleSave],
  );

  const addMediaToTimeline = useCallback(
    (mediaId: string, trackId?: string, frame?: number) => {
      const current = projectRef.current;
      if (!current) return;
      const asset = current.media.find((item) => item.id === mediaId);
      if (!asset) {
        pushToast("El recurso ya no está en la biblioteca.", "error");
        return;
      }
      const kind = asset.kind === "audio" ? "audio" : "video";
      let base = current;
      let track = trackId
        ? base.tracks.find((item) => item.id === trackId)
        : selectedTrackIdRef.current
          ? base.tracks.find((item) => item.id === selectedTrackIdRef.current)
          : undefined;
      if (!track || track.kind !== kind) {
        track = base.tracks.find((item) => item.kind === kind && !item.locked);
      }
      if (!track) {
        const draft = structuredClone(base);
        track = ensureTrack(draft, kind);
        base = draft;
      }
      if (track.locked) {
        pushToast("La pista está bloqueada.", "error");
        return;
      }
      const preferred = Math.max(0, Math.round(frame ?? currentFrameRef.current));
      let result = addMediaClip(base, track.id, mediaId, preferred);
      if (!result.ok && frame === undefined) {
        const trackEnd = track.clips.reduce(
          (max, clip) => Math.max(max, clip.startFrame + clip.durationFrames),
          0,
        );
        if (trackEnd > preferred) result = addMediaClip(base, track.id, mediaId, trackEnd);
      }
      if (!result.ok) {
        pushToast(result.error, "error");
        return;
      }
      applyProject(result.project, { history: true, label: "Añadir clip" });
      if (result.clip) {
        setSelectedClipIds([result.clip.id]);
        setSelectedTrackId(track.id);
        setCurrentFrame(result.clip.startFrame);
      }
    },
    [applyProject, pushToast],
  );

  const dropMediaOnTrack = useCallback(
    (mediaId: string, trackId: string, frame: number) => {
      const current = projectRef.current;
      if (!current) return;
      const result = addMediaClip(current, trackId, mediaId, Math.max(0, Math.round(frame)));
      if (!result.ok) {
        pushToast(result.error, "error");
        return;
      }
      applyProject(result.project, { history: true, label: "Colocar clip" });
      if (result.clip) {
        setSelectedClipIds([result.clip.id]);
        setSelectedTrackId(trackId);
        setCurrentFrame(result.clip.startFrame);
      }
    },
    [applyProject, pushToast],
  );

  const confirmRemoveMedia = useCallback(async () => {
    const target = removeTarget;
    const current = projectRef.current;
    setRemoveTarget(null);
    if (!target || !current) return;
    const saved = await flushSave();
    if (!saved) {
      pushToast("No se puede quitar el recurso mientras haya un conflicto.", "error");
      return;
    }
    try {
      const updated = await api.removeMedia(current.id, target.id);
      if (projectRef.current?.id !== current.id) return;
      projectRef.current = updated;
      setProject(updated);
      baseRevisionRef.current = updated.revision;
      dirtyRef.current = false;
      setSaveStatus("saved");
      setSelectedMediaId(null);
      pushToast(`"${target.name}" se quito de la biblioteca.`, "success");
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo quitar el recurso."), "error");
    }
  }, [flushSave, pushToast, removeTarget]);

  const generateProxy = useCallback(
    async (mediaId: string) => {
      const current = projectRef.current;
      if (!current) return;
      try {
        const { job } = await api.generateProxy(current.id, mediaId);
        updateJob(job);
        const latest = projectRef.current;
        if (latest?.id === current.id) {
          replaceProject({
            ...latest,
            media: latest.media.map((asset) =>
              asset.id === mediaId ? { ...asset, proxy: "pending" } : asset,
            ),
          });
        }
        pushToast("Proxy en cola. La previsualización usará el original mientras tanto.", "info");
      } catch (error) {
        pushToast(errorMessage(error, "No se pudo generar el proxy."), "error");
      }
    },
    [pushToast, replaceProject, updateJob],
  );

  const revealProject = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id) return;
    try {
      await api.revealProject(id);
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo abrir la carpeta del proyecto."), "error");
    }
  }, [pushToast]);

  // ---------------------------------------------------------------- texto
  const addText = useCallback(
    (text: string, role: TextClip["role"]) => {
      const current = projectRef.current;
      const trimmed = text.trim();
      if (!current || !trimmed) return;
      const draft = structuredClone(current);
      const track = ensureTrack(draft, "text");
      if (track.locked) {
        pushToast("La pista de texto está bloqueada.", "error");
        return;
      }
      const fps = fpsValue(current.settings.fps);
      const durationFrames = Math.max(1, Math.round(fps * (role === "subtitle" ? 3 : 4)));
      const result = addTextClip(draft, track.id, {
        text: trimmed,
        role,
        startFrame: Math.max(0, Math.round(currentFrameRef.current)),
        durationFrames,
        createdBy: "user",
      });
      if (!result.ok) {
        pushToast(result.error, "error");
        return;
      }
      applyProject(result.project, { history: true, label: "Añadir texto" });
      if (result.clip) {
        setSelectedClipIds([result.clip.id]);
        setSelectedTrackId(track.id);
      }
    },
    [applyProject, pushToast],
  );

  // ---------------------------------------------------------------- export
  const openExport = useCallback(() => {
    setExportOpen(true);
    void refreshExports();
    void refreshJobs();
  }, [refreshExports, refreshJobs]);

  const startExport = useCallback(
    async (settings: ExportSettings) => {
      const current = projectRef.current;
      if (!current) throw new Error("No hay un proyecto abierto.");
      const saved = await flushSave();
      if (!saved) throw new Error("No se pudo guardar el proyecto antes de exportar.");
      const result = await api.startExport(current.id, settings);
      setExports((items) => [...items, result.record]);
      updateJob(result.job);
      return result;
    },
    [flushSave, updateJob],
  );

  const verifyExport = useCallback(
    async (exportId: string) => {
      const id = projectRef.current?.id;
      if (!id) return;
      try {
        const result = await api.verifyExport(id, exportId);
        setExports((items) => items.map((item) => (item.id === result.record.id ? result.record : item)));
        pushToast(
          result.verification.valid
            ? `Exportación verificada: ${result.verification.message}`
            : `Verificación con avisos: ${result.verification.message}`,
          result.verification.valid ? "success" : "error",
        );
      } catch (error) {
        pushToast(errorMessage(error, "No se pudo verificar la exportación."), "error");
      }
    },
    [pushToast],
  );

  const revealExport = useCallback(
    async (exportId: string) => {
      const id = projectRef.current?.id;
      if (!id) return;
      try {
        await api.revealExport(id, exportId);
      } catch (error) {
        pushToast(errorMessage(error, "No se pudo abrir el archivo exportado."), "error");
      }
    },
    [pushToast],
  );

  const cancelJob = useCallback(
    async (jobId: string) => {
      try {
        const job = await api.cancelJob(jobId);
        updateJob(job);
      } catch (error) {
        pushToast(errorMessage(error, "No se pudo cancelar la tarea."), "error");
      }
    },
    [pushToast, updateJob],
  );

  // ---------------------------------------------------------------- conflicto
  const reloadFromServer = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id) return;
    try {
      const bundle = await api.getProject(id);
      applyBundle(bundle);
      pushToast("Proyecto recargado desde el servidor.", "success");
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo recargar el proyecto."), "error");
    }
  }, [applyBundle, pushToast]);

  const keepLocalVersion = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    try {
      const bundle = await api.getProject(current.id);
      if (projectRef.current?.id !== current.id) return;
      baseRevisionRef.current = bundle.project.revision;
      setConflict(null);
      dirtyRef.current = true;
      setSaveStatus("dirty");
      const saved = await persistRef.current();
      if (saved) pushToast("Tu versión local se guardó por encima de la remota.", "success");
    } catch (error) {
      pushToast(errorMessage(error, "No se pudo guardar tu versión local."), "error");
    }
  }, [pushToast]);

  const durationFrames = project ? timelineDurationFrames(project) : 0;

  const saveNow = useCallback(async () => {
    const saved = await flushSave();
    if (saved) pushToast("Proyecto guardado.", "success");
  }, [flushSave, pushToast]);

  const renameProject = useCallback(
    (name: string) => {
      const current = projectRef.current;
      const trimmed = name.trim();
      if (!current || !trimmed || current.name === trimmed) return;
      applyProject({ ...current, name: trimmed }, { history: true, label: "Renombrar proyecto" });
    },
    [applyProject],
  );

  const seekTo = useCallback(
    (frame: number) => {
      setPlaying(false);
      setCurrentFrame(Math.max(0, Math.min(durationFrames, Math.round(frame))));
    },
    [durationFrames],
  );

  const togglePlay = useCallback(() => {
    const current = projectRef.current;
    if (!current) return;
    const max = timelineDurationFrames(current);
    if (max <= 0) {
      pushToast("La línea de tiempo está vacía. Añade un clip para reproducir.", "info");
      return;
    }
    if (playingRef.current) {
      setPlaying(false);
      return;
    }
    if (currentFrameRef.current >= max) setCurrentFrame(0);
    setPlaying(true);
  }, [pushToast]);

  const splitSelection = useCallback(() => {
    const current = projectRef.current;
    if (!current) return;
    const selection = selectedClipIdsRef.current;
    const result = splitAtFrame(
      current,
      Math.round(currentFrameRef.current),
      selection.length > 0 ? [...selection] : undefined,
    );
    if (!result.ok) {
      pushToast(result.error, "error");
      return;
    }
    applyProject(result.project, { history: true, label: "Dividir clip" });
    if (result.newIds?.length) setSelectedClipIds(result.newIds);
    pushToast("Corte aplicado en el fotograma actual.", "success");
  }, [applyProject, pushToast]);

  const deleteSelection = useCallback(() => {
    const current = projectRef.current;
    if (!current) return;
    if (selectedClipIdsRef.current.length === 0) {
      pushToast("Selecciona uno o varios clips para eliminar.", "info");
      return;
    }
    const result = removeClips(current, [...selectedClipIdsRef.current]);
    if (!result.ok) {
      pushToast(result.error, "error");
      return;
    }
    applyProject(result.project, { history: true, label: "Eliminar clips" });
    setSelectedClipIds([]);
  }, [applyProject, pushToast]);

  const nudgeSelected = useCallback(
    (delta: number) => {
      const current = projectRef.current;
      if (!current) return;
      const ids = [...selectedClipIdsRef.current];
      if (ids.length === 0) {
        setCurrentFrame((frame) => Math.max(0, Math.min(durationFrames, Math.round(frame) + delta)));
        return;
      }
      const ordered = ids
        .map((id) => ({ id, start: getClipById(current, id)?.clip.startFrame ?? 0 }))
        .sort((a, b) => (delta > 0 ? b.start - a.start : a.start - b.start));
      let next = current;
      for (const item of ordered) {
        const found = getClipById(next, item.id);
        if (!found) continue;
        const result = moveClip(next, item.id, found.track.id, found.clip.startFrame + delta);
        if (!result.ok) {
          pushToast(result.error, "error");
          return;
        }
        next = result.project;
      }
      applyProject(next, { history: true, label: "Mover clip" });
    },
    [applyProject, durationFrames, pushToast],
  );

  const selectClips = useCallback((ids: string[]) => {
    setSelectedClipIds(ids);
  }, []);

  const selectClipsFromTimeline = useCallback((ids: string[], additive?: boolean) => {
    if (!additive) {
      setSelectedClipIds(ids);
      return;
    }
    setSelectedClipIds((previous) => {
      const merged = [...previous];
      for (const id of ids) if (!merged.includes(id)) merged.push(id);
      return merged;
    });
  }, []);

  const commitTimeline = useCallback(
    (next: Project, options?: { history?: boolean }) => {
      applyProject(next, {
        history: options?.history ?? true,
        label: "Editar línea de tiempo",
      });
    },
    [applyProject],
  );

  const dismissToast = useCallback(
    (id: number) => {
      clearToastTimer(id);
      setToasts((items) => items.filter((item) => item.id !== id));
    },
    [clearToastTimer],
  );

  // ---------------------------------------------------------------- arranque
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextConfig, verifiedUser] = await Promise.all([api.config(), api.me()]);
        if (cancelled) return;
        setConfig(nextConfig);
        setAi(nextConfig.ai);
        setCurrentUser(verifiedUser);

        if (!verifiedUser) {
          setProjects([]);
          if (projectIdFromHash()) {
            window.location.hash = "";
            pushToast("Inicia sesión para abrir tu proyecto.", "info");
          }
          setPhase("welcome");
          return;
        }

        const list = await api.listProjects();
        if (cancelled) return;
        setProjects(list);

        const hashId = projectIdFromHash();
        if (hashId) {
          try {
            const bundle = await api.getProject(hashId);
            if (!cancelled) applyBundle(bundle);
            return;
          } catch {
            if (!cancelled) {
              pushToast("El proyecto enlazado no existe o pertenece a otra cuenta.", "error");
              window.location.hash = "";
            }
          }
        }
        if (!cancelled) setPhase("welcome");
      } catch (error) {
        if (!cancelled) {
          setBootError(errorMessage(error, "No se pudo conectar con el servidor local."));
          setPhase("fatal");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyBundle, pushToast]);

  useEffect(() => {
    document.title = project ? `${project.name} · OECLIP` : "OECLIP · Editor local-first";
  }, [project]);

  useEffect(() => {
    const id = project?.id;
    if (!id) return;
    let cancelled = false;
    void api
      .listJobs(id)
      .then((list) => {
        if (cancelled) return;
        jobsRef.current = list;
        setJobs(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  useEffect(() => {
    const id = project?.id;
    if (!id) return;
    const source = new EventSource(`/api/events?projectId=${encodeURIComponent(id)}`);
    source.onmessage = (event) => {
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      if (data.type === "job" && data.job) {
        updateJob(data.job);
        return;
      }
      if (data.type === "agent-plan" && data.planId && data.status) {
        const planId = data.planId;
        const status = data.status;
        setMessages((items) =>
          items.map((message) =>
            message.plan?.id === planId
              ? { ...message, plan: { ...message.plan, status } }
              : message,
          ),
        );
        if (status === "running") setConfirmationPlanId(null);
        return;
      }
      if (data.type === "agent-step" && data.planId && data.step) {
        const planId = data.planId;
        const step = data.step;
        setMessages((items) =>
          items.map((message) => {
            if (!message.plan || message.plan.id !== planId) return message;
            return {
              ...message,
              plan: {
                ...message.plan,
                steps: message.plan.steps.map((item) => (item.id === step.id ? step : item)),
              },
            };
          }),
        );
        return;
      }
      if (data.type === "project" && data.projectId === id) {
        // El proyecto cambió en el servidor (ej. subtítulos, sincronización de SFX, etc.)
        // Si hay una edición local en vuelo, solo actualizamos la revisión base para no pisar el estado local.
        if (dirtyRef.current || saveInFlightRef.current) {
          if (typeof data.revision === "number" && data.revision > 0) {
            baseRevisionRef.current = data.revision;
          }
          return;
        }
        // Refrescar localmente para ver los cambios sin recargar la página ni provocar conflictos de revisión.
        if (data.revision !== projectRef.current?.revision) {
          void api
            .getProject(id)
            .then((bundle) => {
              if (dirtyRef.current || saveInFlightRef.current) {
                baseRevisionRef.current = bundle.project.revision;
                return;
              }
              replaceProject(bundle.project);
              baseRevisionRef.current = bundle.project.revision;
              dirtyRef.current = false;
              setSaveStatus("saved");
              setConflict(null);
              setMessages(bundle.agentMessages);
              setExports(bundle.exports);
            })
            .catch(() => {
              // Ignorar errores de red transitorios
            });
        }
        return;
      }
      if (data.type === "project" && data.revision === -1 && !agentRunningRef.current) {
        void refreshMediaStatuses();
      }
    };
    return () => source.close();
  }, [project?.id, refreshMediaStatuses, updateJob]);

  useEffect(() => {
    if (!project) return;
    const clipIds = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    setSelectedClipIds((previous) => {
      const next = previous.filter((id) => clipIds.has(id));
      return next.length === previous.length ? previous : next;
    });
    setSelectedTrackId((previous) =>
      previous && !project.tracks.some((track) => track.id === previous) ? null : previous,
    );
    setSelectedMediaId((previous) =>
      previous && !project.media.some((asset) => asset.id === previous) ? null : previous,
    );
  }, [project]);

  useEffect(() => {
    setCurrentFrame((frame) => Math.min(frame, durationFrames));
  }, [durationFrames]);

  useEffect(() => {
    if (!playing || !project) return;
    const fps = fpsValue(project.settings.fps);
    const max = timelineDurationFrames(project);
    let last = performance.now();
    let floatFrame = currentFrameRef.current;
    let raf = 0;
    const tick = (now: number) => {
      const delta = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      floatFrame += delta * fps;
      if (floatFrame >= max) {
        setCurrentFrame(max);
        setPlaying(false);
        return;
      }
      const nextInt = Math.floor(floatFrame);
      setCurrentFrame((prev) => (prev === nextInt ? prev : nextInt));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playing, project?.id, project?.settings.fps.num, project?.settings.fps.den, durationFrames]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || saveInFlightRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (phase !== "editor" || exportOpen || settingsOpen || profileOpen || adminUsersOpen) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable),
      );
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
        return;
      }
      if (mod && event.key.toLowerCase() === "e") {
        event.preventDefault();
        openExport();
        return;
      }
      if (typing) return;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (event.altKey) nudgeSelected(event.shiftKey ? -10 : -1);
        else seekTo(currentFrameRef.current + (event.shiftKey ? -10 : -1));
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (event.altKey) nudgeSelected(event.shiftKey ? 10 : 1);
        else seekTo(currentFrameRef.current + (event.shiftKey ? 10 : 1));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        seekTo(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        seekTo(durationFrames);
        return;
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        splitSelection();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    phase,
    exportOpen,
    settingsOpen,
    profileOpen,
    adminUsersOpen,
    saveNow,
    openExport,
    undo,
    redo,
    togglePlay,
    nudgeSelected,
    seekTo,
    splitSelection,
    deleteSelection,
    durationFrames,
  ]);

  if (phase === "boot") {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <Brand />
          <div className="spinner" />
          <span>Iniciando el motor local de OECLIP...</span>
        </div>
      </div>
    );
  }

  if (phase === "fatal") {
    return (
      <div className="loading-screen">
        <div className="loading-card boot-error">
          <Brand />
          <Icon name="alert" size={26} />
          <strong>No se pudo iniciar OECLIP</strong>
          <span className="boot-error-message">{bootError}</span>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reintentar
          </button>
          <span className="field-hint">
            Comprueba que el servidor local está en marcha con <code>npm run dev</code>.
          </span>
          <Toasts
            items={toasts}
            placement="standalone"
            onPauseChange={pauseToast}
            onDismiss={dismissToast}
          />
        </div>
      </div>
    );
  }

  if (phase === "welcome" || !project || !currentUser) {
    return (
      <div className="welcome-screen">
        <Welcome
          config={config}
          user={currentUser}
          projects={projects}
          loadingProjects={projectsLoading}
          onRetry={() => void loadProjects()}
          onAuthSuccess={(user) => void handleAuthSuccess(user)}
          onUserUpdated={(user) => void handleUserUpdated(user)}
          onSignOut={() => void handleSignOut()}
          switchAccountTrigger={switchAccountTrigger}
          onCreate={createProject}
          onCreateDemo={createDemo}
          onOpen={openProject}
          onDuplicate={duplicateProjectById}
          onDelete={deleteProjectById}
          onReveal={revealProjectById}
          onOpenSettings={() => setSettingsOpen(true)}
          onToast={pushToast}
        />
        {settingsOpen && (
          <SettingsDialog
            project={null}
            config={config}
            onClose={() => setSettingsOpen(false)}
            onRefreshConfig={refreshConfig}
            onToast={pushToast}
          />
        )}
        <Toasts
          items={toasts}
          placement="standalone"
          onPauseChange={pauseToast}
          onDismiss={dismissToast}
        />
      </div>
    );
  }

  return (
    <div className={`app${conflict ? " has-conflict" : ""}`}>
      <TopBar
        project={project}
        user={currentUser}
        saveStatus={saveStatus}
        ai={ai}
        agentRunning={agentRunning}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onRename={renameProject}
        onSave={() => void saveNow()}
        onUndo={undo}
        onRedo={redo}
        onExport={openExport}
        onSettings={() => setSettingsOpen(true)}
        onHome={() => void goHome()}
        onSignOut={() => void handleSignOut()}
        onOpenProfile={() => setProfileOpen(true)}
        onDuplicate={() => void duplicateCurrent()}
        onReveal={() => void revealProject()}
        onSnapshot={() => void snapshotNow()}
        onToggleMedia={() => {
          setMediaOpen((value) => {
            const next = !value;
            if (next && window.innerWidth <= 880) setSidebarOpen(false);
            return next;
          });
        }}
        onToggleInspector={() => {
          setSidebarOpen((value) => {
            const next = !value;
            if (next && window.innerWidth <= 880) setMediaOpen(false);
            return next;
          });
        }}
        onToast={pushToast}
      />

      {conflict && (
        <div className="conflict-wrap">
          <div className="conflict-banner" role="alert">
            <div className="conflict-banner-msg">
              <Icon name="alert" size={15} className="shrink-0" />
              <span>
                El proyecto cambió en el servidor
                {conflict.revision >= 0 ? ` (revisión ${conflict.revision})` : ""}. Tienes cambios locales sin
                guardar.
              </span>
            </div>
            <div className="conflict-banner-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => void reloadFromServer()}>
                Recargar
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => void keepLocalVersion()}>
                Guardar mi versión
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className={`main${mediaOpen ? "" : " media-hidden"}${sidebarOpen ? "" : " inspector-hidden"}`}
      >
        <MediaPanel
          project={project}
          selectedMediaId={selectedMediaId}
          uploads={uploads}
          disabled={agentRunning}
          open={mediaOpen}
          onSelect={setSelectedMediaId}
          onImport={(files) => void importFiles(files)}
          onAdd={(mediaId) => addMediaToTimeline(mediaId)}
          onRemove={(mediaId) => {
            const asset = project.media.find((item) => item.id === mediaId);
            setRemoveTarget({ id: mediaId, name: asset?.name ?? "este recurso" });
          }}
          onProxy={(mediaId) => void generateProxy(mediaId)}
          onReveal={() => void revealProject()}
          onToast={pushToast}
          onCloseMobile={() => setMediaOpen(false)}
        />

        <div className="center">
          <div className="center-top">
            <Viewer
              project={project}
              frame={currentFrame}
              playing={playing}
              onFrameChange={seekTo}
              onTogglePlay={togglePlay}
              onError={(message) => pushToast(message, "error")}
              selectedClipId={selectedClipIds[0] ?? viewerSelectedClipId}
              onClipSelect={(clipId) => {
                setViewerSelectedClipId(clipId);
                setSelectedClipIds(clipId ? [clipId] : []);
              }}
              onProjectChange={applyProject}
              onAttachToChat={(clipId, promptHint) => {
                setViewerSelectedClipId(clipId);
                setSelectedClipIds([clipId]);
                setSidebarOpen(true);
                setSidebarTab("motion");
                window.setTimeout(() => {
                  window.dispatchEvent(
                    new CustomEvent("oeclip:attach-clip", {
                      detail: { clipId, promptHint },
                    }),
                  );
                }, 40);
              }}
              onOpenInspector={(clipId) => {
                setViewerSelectedClipId(clipId);
                setSelectedClipIds([clipId]);
                setMediaOpen(false);
                setSidebarOpen(true);
                setSidebarTab("inspector");
              }}
              onQuickImportFiles={(files) => {
                autoInsertOnImportRef.current = true;
                void importFiles(files).finally(() => {
                  autoInsertOnImportRef.current = false;
                });
              }}
              onOpenAiAssistant={() => {
                setMediaOpen(false);
                setSidebarOpen(true);
                setSidebarTab("motion");
              }}
              disabled={agentRunning}
            />
          </div>

          <div className="mobile-quick-bar" aria-label="Acciones rápidas táctiles">
            <input
              ref={quickFileInputRef}
              type="file"
              hidden
              multiple
              accept="video/*,audio/*,image/*,.mp4,.mov,.mkv,.webm,.avi,.mp3,.wav,.aac,.m4a,.png,.jpg,.jpeg,.webp"
              onChange={(event) => {
                const picked = event.target.files ? Array.from(event.target.files) : [];
                event.target.value = "";
                if (picked.length === 0) return;
                autoInsertOnImportRef.current = true;
                void importFiles(picked).finally(() => {
                  autoInsertOnImportRef.current = false;
                });
              }}
            />

            {agentRunning && (
              <button
                type="button"
                className="mobile-quick-pill is-live"
                onClick={() => {
                  setMediaOpen(false);
                  setSidebarTab("motion");
                  setSidebarOpen(true);
                }}
              >
                <span className="mobile-live-dot" aria-hidden="true" />
                <span className="truncate max-w-[140px]">
                  {activeAgentJob?.label || "IA editando"}
                </span>
                {activeAgentJob ? (
                  <span className="tabular-nums opacity-80">
                    {Math.round(activeAgentJob.progress * 100)}%
                  </span>
                ) : null}
              </button>
            )}

            {selectedClipIds.length > 0 ? (
              <>
                <button
                  type="button"
                  className="mobile-quick-pill is-primary"
                  onClick={() => splitSelection()}
                >
                  <Icon name="scissors" size={14} />
                  <span>Dividir</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill"
                  onClick={() => {
                    setMediaOpen(false);
                    setSidebarTab("inspector");
                    setSidebarOpen(true);
                  }}
                >
                  <Icon name="sliders" size={14} />
                  <span>Ajustar</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill is-danger"
                  onClick={() => deleteSelection()}
                >
                  <Icon name="trash" size={14} />
                  <span>Borrar</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill"
                  onClick={() => setSelectedClipIds([])}
                >
                  <Icon name="close" size={13} />
                  <span>Listo</span>
                </button>
              </>
            ) : durationFrames === 0 ? (
              <>
                <button
                  type="button"
                  className="mobile-quick-pill is-primary"
                  onClick={() => quickFileInputRef.current?.click()}
                >
                  <Icon name="upload" size={14} />
                  <span>Subir video</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill is-ai"
                  onClick={() => {
                    setMediaOpen(false);
                    setSidebarTab("motion");
                    setSidebarOpen(true);
                  }}
                >
                  <Icon name="sparkles" size={14} />
                  <span>Crear con IA</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill"
                  onClick={() => {
                    setMediaOpen(false);
                    setSidebarTab("skills");
                    setSidebarOpen(true);
                  }}
                >
                  <Icon name="wand" size={14} />
                  <span>Skills</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill"
                  onClick={() => addText("Tu título aquí", "title")}
                >
                  <Icon name="type" size={14} />
                  <span>Texto</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="mobile-quick-pill is-primary"
                  onClick={() => quickFileInputRef.current?.click()}
                >
                  <Icon name="upload" size={14} />
                  <span>Subir</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill is-ai"
                  onClick={() => {
                    setMediaOpen(false);
                    setSidebarTab("motion");
                    setSidebarOpen(true);
                  }}
                >
                  <Icon name="sparkles" size={14} />
                  <span>Auto-editar IA</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill"
                  onClick={() => {
                    setMediaOpen(false);
                    setSidebarTab("skills");
                    setSidebarOpen(true);
                  }}
                >
                  <Icon name="wand" size={14} />
                  <span>Skills</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill"
                  onClick={() => addText("Tu título aquí", "title")}
                >
                  <Icon name="type" size={14} />
                  <span>Texto</span>
                </button>
                <button
                  type="button"
                  className="mobile-quick-pill"
                  onClick={() => void openExport()}
                >
                  <Icon name="download" size={14} />
                  <span>Exportar</span>
                </button>
              </>
            )}
          </div>

          <Timeline
            project={project}
            projectId={project.id}
            currentFrame={currentFrame}
            onFrameChange={seekTo}
            selectedClipIds={selectedClipIds}
            selectedTrackId={selectedTrackId}
            onSelectClips={selectClipsFromTimeline}
            onSelectTrack={setSelectedTrackId}
            onCommit={commitTimeline}
            onToast={pushToast}
            onDropMedia={dropMediaOnTrack}
            disabled={agentRunning}
          />
        </div>

        <Sidebar
          project={project}
          tab={sidebarTab}
          open={sidebarOpen}
          width={sidebarWidth}
          onResize={(width) => {
            setSidebarWidth(clampSidebarWidth(width));
          }}
          onResizeCommit={(width) => {
            try {
              window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
            } catch {
              // Sin almacenamiento local: el ancho se mantiene solo en esta sesión.
            }
          }}
          currentFrame={playing ? Math.floor(currentFrame / 15) * 15 : currentFrame}
          onFrameChange={seekTo}
          selectedClipIds={selectedClipIds}
          selectedTrackId={selectedTrackId}
          selectedMediaId={selectedMediaId}
          viewerSelectedClipId={viewerSelectedClipId}
          disabled={agentRunning}
          saveStatus={saveStatus}
          past={past}
          future={future}
          snapshotsVersion={snapshotsVersion}
          ai={ai}
          onTabChange={(tab) => {
            setSidebarTab(tab);
          }}
          onProjectChange={applyProject}
          onBeginEdit={beginEdit}
          onEndEdit={endEdit}
          onSelectClips={selectClips}
          onSelectTrack={setSelectedTrackId}
          onSelectMedia={setSelectedMediaId}
          onImportFiles={(files) => void importFiles(files)}
          onRunAgentTool={runAgentTool}
          onSaveBeforeExternalEdit={flushSave}
          onProjectSync={syncExternalProject}
          onToast={pushToast}
          onAddText={addText}
          onExport={openExport}
          onSnapshot={() => void snapshotNow()}
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateSnapshot={createSnapshot}
          onRestoreSnapshot={restoreSnapshot}
          onUndo={undo}
          onRedo={redo}
          onRestoreLocal={restoreLocal}
          onCloseMobile={() => setSidebarOpen(false)}
        />

        {(mediaOpen || sidebarOpen) && (
          <div
            className="mobile-drawer-backdrop"
            aria-hidden="true"
            onClick={() => {
              if (window.innerWidth <= 880) setMediaOpen(false);
              if (window.innerWidth <= 1100) setSidebarOpen(false);
            }}
          />
        )}
      </div>

      {/* Barra de navegación inferior adaptativa para móviles y tablets (5 accesos rápidos) */}
      <nav className="mobile-editor-dock" aria-label="Navegación rápida del estudio">
        <button
          type="button"
          className={`mobile-dock-btn${!mediaOpen && !sidebarOpen ? " active" : ""}`}
          onClick={() => {
            setMediaOpen(false);
            setSidebarOpen(false);
          }}
        >
          <Icon name="play" size={15} />
          <span>Monitor</span>
        </button>
        <button
          type="button"
          className={`mobile-dock-btn${sidebarOpen && sidebarTab === "motion" ? " active" : ""}`}
          onClick={() => {
            setMediaOpen(false);
            setSidebarTab("motion");
            setSidebarOpen(true);
          }}
        >
          <span className="relative inline-flex items-center justify-center">
            <Icon name="sparkles" size={15} />
            {agentRunning && <span className="mobile-dock-badge" aria-hidden="true" />}
          </span>
          <span>IA</span>
        </button>
        <button
          type="button"
          className={`mobile-dock-btn${sidebarOpen && sidebarTab === "skills" ? " active" : ""}`}
          onClick={() => {
            setMediaOpen(false);
            setSidebarTab("skills");
            setSidebarOpen(true);
          }}
        >
          <Icon name="wand" size={15} />
          <span>Skills</span>
        </button>
        <button
          type="button"
          className={`mobile-dock-btn${mediaOpen ? " active" : ""}`}
          onClick={() => {
            setSidebarOpen(false);
            setMediaOpen((v) => !v);
          }}
        >
          <Icon name="folder" size={15} />
          <span>Medios</span>
        </button>
        <button
          type="button"
          className={`mobile-dock-btn${sidebarOpen && (sidebarTab === "inspector" || sidebarTab === "history") ? " active" : ""}`}
          onClick={() => {
            setMediaOpen(false);
            setSidebarTab("inspector");
            setSidebarOpen(true);
          }}
        >
          <Icon name="sliders" size={15} />
          <span>Ajustes</span>
        </button>
      </nav>

      {exportOpen && (
        <ExportDialog
          project={project}
          exports={exports}
          jobs={jobs}
          config={config}
          onClose={() => setExportOpen(false)}
          onStart={startExport}
          onRefreshExports={refreshExports}
          onVerify={verifyExport}
          onReveal={(exportId) => void revealExport(exportId)}
          onCancelJob={(jobId) => void cancelJob(jobId)}
          onToast={pushToast}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          project={project}
          config={config}
          onClose={() => setSettingsOpen(false)}
          onRefreshConfig={refreshConfig}
          onRevealProject={() => void revealProject()}
          onToast={pushToast}
        />
      )}

      {profileOpen && currentUser && (
        <UserProfileModal
          user={currentUser}
          aiStatus={ai}
          onClose={() => setProfileOpen(false)}
          onUserUpdated={(updated) => void handleUserUpdated(updated)}
          onSwitchAccount={() => void handleSwitchAccountFromEditor()}
          onLogout={() => {
            setProfileOpen(false);
            void handleSignOut();
          }}
          onOpenSettings={() => {
            setProfileOpen(false);
            setSettingsOpen(true);
          }}
          onOpenAdminAccounts={
            currentUser.role === "admin"
              ? () => {
                  setProfileOpen(false);
                  setAdminUsersOpen(true);
                }
              : undefined
          }
          onToast={pushToast}
        />
      )}

      {adminUsersOpen && currentUser?.role === "admin" && (
        <AdminUsersModal
          currentUser={currentUser}
          onClose={() => setAdminUsersOpen(false)}
          onToast={pushToast}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Quitar recurso de la biblioteca"
          message={`Se quitará "${removeTarget.name}" del proyecto. El archivo original no se borra del disco. Si el recurso está usado en la línea de tiempo, primero elimina sus clips.`}
          confirmLabel="Quitar recurso"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => void confirmRemoveMedia()}
        />
      )}

      <Toasts
        items={toasts}
        placement="editor"
        onPauseChange={pauseToast}
        onDismiss={dismissToast}
      />
    </div>
  );
}
