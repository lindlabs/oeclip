import { useCallback, useRef, useState } from "react";
import type { HistoryEntry } from "../editorTypes";
import type { Project } from "../shared/schema";

function cloneProject(project: Project): Project {
  return structuredClone(project);
}

export interface UseProjectHistoryOptions {
  replaceProject: (p: Project) => void;
  scheduleSave: (delay?: number) => void;
  onStateRestored?: (label: string, mode: "undo" | "redo" | "restore") => void;
  onClearSelection?: () => void;
}

export function useProjectHistory({
  replaceProject,
  scheduleSave,
  onStateRestored,
  onClearSelection,
}: UseProjectHistoryOptions) {
  const [past, setPast] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);

  const pastRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);

  pastRef.current = past;
  futureRef.current = future;

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

  const clearHistory = useCallback(() => {
    pastRef.current = [];
    setPast([]);
    futureRef.current = [];
    setFuture([]);
  }, []);

  const undo = useCallback(
    (current: Project | null) => {
      const entry = pastRef.current.at(-1);
      if (!entry || !current) return;
      const nextPast = pastRef.current.slice(0, -1);
      pastRef.current = nextPast;
      setPast(nextPast);

      const redoEntry: HistoryEntry = { project: cloneProject(current), label: entry.label, at: Date.now() };
      const nextFuture = [redoEntry, ...futureRef.current].slice(0, 80);
      futureRef.current = nextFuture;
      setFuture(nextFuture);

      replaceProject(cloneProject(entry.project));
      onClearSelection?.();
      scheduleSave(350);
      onStateRestored?.(entry.label, "undo");
    },
    [onClearSelection, onStateRestored, replaceProject, scheduleSave],
  );

  const redo = useCallback(
    (current: Project | null) => {
      const entry = futureRef.current[0];
      if (!entry || !current) return;
      const nextFuture = futureRef.current.slice(1);
      futureRef.current = nextFuture;
      setFuture(nextFuture);

      const undoEntry: HistoryEntry = { project: cloneProject(current), label: entry.label, at: Date.now() };
      const nextPast = [...pastRef.current, undoEntry].slice(-80);
      pastRef.current = nextPast;
      setPast(nextPast);

      replaceProject(cloneProject(entry.project));
      onClearSelection?.();
      scheduleSave(350);
      onStateRestored?.(entry.label, "redo");
    },
    [onClearSelection, onStateRestored, replaceProject, scheduleSave],
  );

  const restoreLocal = useCallback(
    (index: number, current: Project | null) => {
      const entry = pastRef.current[index];
      if (!entry || !current) return;
      const nextPast = pastRef.current.slice(0, index);
      pastRef.current = nextPast;
      setPast(nextPast);

      const nextFuture = [
        { project: cloneProject(current), label: `Antes de volver a ${entry.label}`, at: Date.now() },
        ...futureRef.current,
      ].slice(0, 80);
      futureRef.current = nextFuture;
      setFuture(nextFuture);

      replaceProject(cloneProject(entry.project));
      onClearSelection?.();
      scheduleSave(350);
      onStateRestored?.(entry.label, "restore");
    },
    [onClearSelection, onStateRestored, replaceProject, scheduleSave],
  );

  return {
    past,
    setPast,
    future,
    setFuture,
    pastRef,
    futureRef,
    pushPast,
    clearFuture,
    clearHistory,
    undo,
    redo,
    restoreLocal,
  };
}

