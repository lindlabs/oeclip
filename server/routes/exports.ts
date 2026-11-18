import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { exportSettingsSchema } from "../../src/shared/schema";
import { assertExportId, assertProjectId, HttpError } from "../util/fs";
import { projectDirectory, projectStore } from "../projects/store";
import { exportDownloadPath, startExport, verifyExport } from "../services/exportService";
import { resolveSafeProjectRelativePath, verifyDownloadToken } from "../services/downloadTokenService";
import { sendFile } from "./stream";

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/projects/:id/exports", async (request, reply) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const settings = exportSettingsSchema.parse(request.body ?? {});
    const { record, job } = await startExport(id, settings);
    reply.code(202);
    return { record, job };
  });

  app.get("/api/projects/:id/exports/:exportId/file", async (request, reply) => {
    const { id, exportId } = request.params as { id: string; exportId: string };
    assertProjectId(id);
    assertExportId(exportId);
    const bundle = await projectStore.get(id);
    const record = bundle.exports.find((item) => item.id === exportId);
    if (!record) throw new HttpError(404, "La exportación no existe.", "export_not_found");
    const file = exportDownloadPath(id, record);
    await sendFile(request, reply, file, {
      contentType: "video/mp4",
      fileName: record.settings.fileName,
      download: true,
      cacheControl: "no-store",
    });
  });

  app.post("/api/projects/:id/exports/:exportId/verify", async (request) => {
    const { id, exportId } = request.params as { id: string; exportId: string };
    assertProjectId(id);
    assertExportId(exportId);
    return verifyExport(id, exportId);
  });

  app.post("/api/projects/:id/exports/:exportId/reveal", async (request) => {
    const { id, exportId } = request.params as { id: string; exportId: string };
    assertProjectId(id);
    assertExportId(exportId);
    const bundle = await projectStore.get(id);
    const record = bundle.exports.find((item) => item.id === exportId);
    if (!record?.outputFile) throw new HttpError(409, "La exportación aún no tiene archivo final.", "export_not_ready");
    const file = path.join(projectDirectory(id), record.outputFile);
    await fs.access(file).catch(() => {
      throw new HttpError(404, "El archivo exportado ya no está en disco.", "export_file_missing");
    });
    if (process.platform === "win32") {
      spawn("explorer.exe", [`/select,${file}`], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-R", file], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [path.dirname(file)], { detached: true, stdio: "ignore" }).unref();
    }
    return { revealed: true, path: file };
  });

  app.get("/api/downloads/:token/:fileName", async (request, reply) => {
    const { token } = request.params as { token: string; fileName: string };
    const payload = verifyDownloadToken(token);
    if (!payload) {
      throw new HttpError(403, "Enlace de descarga inválido o expirado.", "invalid_download_token");
    }
    assertProjectId(payload.projectId);
    if (payload.kind === "export") {
      assertExportId(payload.exportId);
      const bundle = await projectStore.get(payload.projectId);
      const record = bundle.exports.find((item) => item.id === payload.exportId);
      if (!record) throw new HttpError(404, "La exportación no existe.", "export_not_found");
      const file = exportDownloadPath(payload.projectId, record);
      await sendFile(request, reply, file, {
        contentType: payload.contentType || "video/mp4",
        fileName: record.settings.fileName || payload.fileName,
        download: payload.download ?? true,
        cacheControl: "no-store",
      });
      return;
    }
    const targetFile = resolveSafeProjectRelativePath(projectDirectory(payload.projectId), payload.relPath);
    if (!targetFile) {
      throw new HttpError(403, "Ruta de archivo no permitida.", "invalid_download_path");
    }
    await fs.access(targetFile).catch(() => {
      throw new HttpError(404, "El archivo solicitado no existe.", "download_file_missing");
    });
    await sendFile(request, reply, targetFile, {
      contentType: payload.contentType || "application/octet-stream",
      fileName: payload.fileName,
      download: payload.download ?? false,
      cacheControl: "private, max-age=3600",
    });
  });

  app.get("/api/projects/:id/exports", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const bundle = await projectStore.get(id);
    return { exports: bundle.exports };
  });

  app.get("/api/jobs/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const { jobQueue } = await import("../jobs");
    const job = jobQueue.get(jobId);
    if (!job) throw new HttpError(404, "La tarea no existe.", "job_not_found");
    return job;
  });

  app.delete("/api/jobs/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const { jobQueue } = await import("../jobs");
    return jobQueue.cancel(jobId);
  });

  app.get("/api/projects/:id/jobs", async (request) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const { jobQueue } = await import("../jobs");
    return { jobs: jobQueue.listForProject(id) };
  });
}
