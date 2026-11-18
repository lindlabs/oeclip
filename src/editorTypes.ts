import type { Project } from "./shared/schema";

export type SaveStatus = "saved" | "saving" | "dirty" | "error" | "conflict";

export type SidebarTab = "motion" | "inspector" | "skills" | "history";

export interface ProjectChangeOptions {
  history?: boolean;
  save?: boolean;
  label?: string;
}

export type ProjectChangeHandler = (project: Project, options?: ProjectChangeOptions) => void;

export interface HistoryEntry {
  project: Project;
  label: string;
  at: number;
}
