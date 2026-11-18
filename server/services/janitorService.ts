import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../config";
import { projectStore } from "../projects/store";

export interface CleanupResult {
  removedFiles: number;
  reclaimedBytes: number;
}

/**
 * Limpia archivos temporales y renders antiguos que superen la antigüedad especificada.
 * @param maxAgeMs Antigüedad máxima en milisegundos (por defecto 24 horas)
 */
export async function cleanOrphanRendersAndTemps(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<CleanupResult> {
  let removedFiles = 0;
  let reclaimedBytes = 0;
  const now = Date.now();

  // 1. Limpieza de renders de motion cacheados en data/motion-renders
  const motionRendersDir = path.join(config.dataDir, "motion-renders");
  try {
    const projectDirs = await fs.readdir(motionRendersDir).catch(() => [] as string[]);
    for (const projectDirName of projectDirs) {
      const fullProjectDirPath = path.join(motionRendersDir, projectDirName);
      const stat = await fs.stat(fullProjectDirPath).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const files = await fs.readdir(fullProjectDirPath).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".webm") && !file.endsWith(".tmp")) continue;
        const filePath = path.join(fullProjectDirPath, file);
        const fileStat = await fs.stat(filePath).catch(() => null);
        if (fileStat && now - fileStat.mtimeMs > maxAgeMs) {
          await fs.rm(filePath, { force: true }).catch(() => undefined);
          removedFiles += 1;
          reclaimedBytes += fileStat.size;
        }
      }
    }
  } catch (error) {
    console.warn("[Janitor] Error limpiando motion-renders:", error);
  }

  // 2. Limpieza de directorios temporales de proyectos en data/projects/<id>/tmp
  try {
    const projects = await projectStore.list();
    for (const p of projects) {
      const pTempDir = path.join(config.dataDir, "projects", p.id, "tmp");
      const tempEntries = await fs.readdir(pTempDir).catch(() => [] as string[]);
      for (const entry of tempEntries) {
        const fullPath = path.join(pTempDir, entry);
        const entryStat = await fs.stat(fullPath).catch(() => null);
        if (entryStat && now - entryStat.mtimeMs > maxAgeMs) {
          await fs.rm(fullPath, { recursive: true, force: true }).catch(() => undefined);
          removedFiles += 1;
          reclaimedBytes += entryStat.size;
        }
      }
    }
  } catch (error) {
    console.warn("[Janitor] Error limpiando tmp de proyectos:", error);
  }

  return { removedFiles, reclaimedBytes };
}
