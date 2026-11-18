import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildServer } from "./app";
import { config } from "./config";
import { jobQueue } from "./jobs";
import { projectStore } from "./projects/store";
import { FALLBACK_THUMBNAIL_BYTES } from "./media/library";
import { prewarmRemotionBundle } from "./media/remotion";

async function repairMissingProjectThumbnails(): Promise<void> {
  try {
    const projectsRoot = path.join(config.dataDir, "projects");
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const prjId = entry.name;
      const pFile = path.join(projectsRoot, prjId, "project.json");
      const cacheDir = path.join(projectsRoot, prjId, "cache");
      const raw = await fs.readFile(pFile, "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const project = JSON.parse(raw);
        await fs.mkdir(cacheDir, { recursive: true });
        if (Array.isArray(project.media)) {
          for (const asset of project.media) {
            const thumbFile = path.join(cacheDir, `thumb-${asset.id}.jpg`);
            const buf = await fs.readFile(thumbFile).catch(() => null);
            const isValidJpeg = buf && buf.length > 50 && buf[0] === 0xff && buf[1] === 0xd8;
            if (!isValidJpeg) {
              await fs.writeFile(thumbFile, FALLBACK_THUMBNAIL_BYTES).catch(() => undefined);
            }
          }
        }
      } catch {
        // Ignorar proyectos corruptos
      }
    }
  } catch (err) {
    console.warn("[oeclip] Error reparando miniaturas:", err);
  }
}

async function pruneStaleTempDirs(maxAgeMs = 2 * 60 * 60_000): Promise<void> {
  const tmpRoot = config.tmpDir;
  try {
    const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      const fullPath = path.join(tmpRoot, entry.name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(fullPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Ignorar si el directorio temporal aún no existe
  }
}

async function main(): Promise<void> {
  const app = await buildServer();
  await projectStore.recoverInterruptedExports();
  await repairMissingProjectThumbnails();
  void pruneStaleTempDirs();
  const shutdown = async (signal: string) => {
    app.log.info(`Recibida señal ${signal}; cerrando OECLIP.`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      `OECLIP listo en http://${config.host}:${config.port} · datos: ${config.dataDir} · ffmpeg: ${config.ffmpeg}`,
    );
    prewarmRemotionBundle();
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const pruneTimer = setInterval(() => {
    jobQueue.prune();
    void pruneStaleTempDirs();
  }, 10 * 60_000);
  pruneTimer.unref();
}

void main();
