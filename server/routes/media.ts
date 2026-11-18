import type { FastifyInstance } from "fastify";
import "@fastify/multipart";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { z } from "zod";
import { config } from "../config";
import { projectStore } from "../projects/store";
import { HttpError, assertMediaId, assertProjectId } from "../util/fs";
import { newId } from "../../src/shared/time";
import { importMediaFile, mediaAbsolutePath } from "../media/import";
import { ensureThumbnail, ensureWaveform, generateProxy, FALLBACK_THUMBNAIL_BYTES } from "../media/library";
import { jobQueue } from "../jobs";
import { sendFile } from "./stream";
import { probeMedia } from "../media/probe";
import { buildSrt } from "../../src/shared/srt";

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/projects/:id/media", async (request, reply) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await projectStore.get(id);
    let data;
    try {
      data = await request.file();
    } catch (error) {
      throw new HttpError(413, "El archivo supera el limite de subida configurado.", "upload_too_large", error);
    }
    if (!data) throw new HttpError(400, "No se recibió ningún archivo.", "no_file");
    const tempDir = path.join(os.tmpdir(), "oeclip-tmp", "uploads");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${newId("upl")}.part`);
    try {
      await pipeline(data.file, createWriteStream(tempFile));
      if (data.file.truncated) {
        await fs.rm(tempFile, { force: true });
        throw new HttpError(413, "El archivo supera el limite de subida configurado.", "upload_too_large");
      }
      const stat = await fs.stat(tempFile);
      if (stat.size === 0) throw new HttpError(400, "El archivo está vacío.", "empty_file");
      const asset = await importMediaFile(id, tempFile, data.filename || "recurso");
      const bundle = await projectStore.get(id);
      reply.code(201);
      return { asset, revision: bundle.project.revision };
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
    }
  });

  app.post("/api/projects/:id/media/import", async (request, reply) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    await projectStore.get(id);
    const body = z
      .object({
        path: z.string().trim().min(1).max(4096),
        name: z.string().trim().min(1).max(255).optional(),
      })
      .parse(request.body ?? {});
    const source = path.resolve(body.path);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile()) {
      throw new HttpError(404, "No existe un archivo en la ruta indicada.", "source_not_found");
    }
    const tempDir = path.join(os.tmpdir(), "oeclip-tmp", "imports");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${newId("imp")}${path.extname(source).toLowerCase()}`);
    try {
      await fs.copyFile(source, tempFile);
      const asset = await importMediaFile(id, tempFile, body.name || path.basename(source));
      const bundle = await projectStore.get(id);
      reply.code(201);
      return { asset, revision: bundle.project.revision };
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
  });

  app.get("/api/projects/:id/media/:mediaId/file", async (request, reply) => {    const { id, mediaId } = request.params as { id: string; mediaId: string };
    assertProjectId(id);
    assertMediaId(mediaId);
    const bundle = await projectStore.get(id);
    const asset = bundle.project.media.find((item) => item.id === mediaId);
    if (!asset) throw new HttpError(404, "El recurso no existe.", "media_not_found");
    const useProxy = (request.query as { proxy?: string } | undefined)?.proxy === "1";
    const file = mediaAbsolutePath(id, asset, useProxy);
    const contentType = useProxy && asset.proxy ? "video/mp4" : asset.mimeType;
    await sendFile(request, reply, file, {
      contentType,
      fileName: asset.name,
      cacheControl: "private, max-age=86400",
    });
  });

  app.get("/api/projects/:id/media/:mediaId/thumb", async (request, reply) => {
    const { id, mediaId } = request.params as { id: string; mediaId: string };
    try {
      assertProjectId(id);
      assertMediaId(mediaId);
      const bundle = await projectStore.get(id);
      const asset = bundle.project.media.find((item) => item.id === mediaId);
      if (!asset) {
        reply.header("Content-Type", "image/jpeg");
        reply.header("Cache-Control", "no-cache");
        return reply.send(FALLBACK_THUMBNAIL_BYTES);
      }
      const file = await ensureThumbnail(id, asset);
      if (asset.thumbnail !== "ready") {
        await projectStore.updateMedia(id, asset.id, { thumbnail: "ready" }).catch(() => undefined);
      }
      await sendFile(request, reply, file, {
        contentType: "image/jpeg",
        fileName: `${asset.name}.jpg`,
        cacheControl: "private, max-age=86400",
      });
    } catch {
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "no-cache");
      return reply.send(FALLBACK_THUMBNAIL_BYTES);
    }
  });

  app.get("/api/projects/:id/media/:mediaId/waveform", async (request) => {
    const { id, mediaId } = request.params as { id: string; mediaId: string };
    assertProjectId(id);
    assertMediaId(mediaId);
    const query = z.object({ peaks: z.coerce.number().int().min(100).max(2400).optional() }).parse(request.query);
    const bundle = await projectStore.get(id);
    const asset = bundle.project.media.find((item) => item.id === mediaId);
    if (!asset) throw new HttpError(404, "El recurso no existe.", "media_not_found");
    if (!asset.audioCodec) throw new HttpError(404, "El recurso no tiene audio.", "no_audio");
    const waveform = await ensureWaveform(id, asset, query.peaks ?? 900);
    if (asset.waveform !== "ready") {
      await projectStore.updateMedia(id, asset.id, { waveform: "ready" }).catch(() => undefined);
    }
    return waveform;
  });

  app.delete("/api/projects/:id/media/:mediaId", async (request) => {
    const { id, mediaId } = request.params as { id: string; mediaId: string };
    assertProjectId(id);
    assertMediaId(mediaId);
    return projectStore.removeMedia(id, mediaId);
  });

  app.post("/api/projects/:id/media/:mediaId/probe", async (request) => {
    const { id, mediaId } = request.params as { id: string; mediaId: string };
    assertProjectId(id);
    assertMediaId(mediaId);
    const bundle = await projectStore.get(id);
    const asset = bundle.project.media.find((item) => item.id === mediaId);
    if (!asset) throw new HttpError(404, "El recurso no existe.", "media_not_found");
    const probe = await probeMedia(mediaAbsolutePath(id, asset));
    return {
      kind: probe.kind,
      durationUs: probe.durationUs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      sizeBytes: probe.sizeBytes,
    };
  });

  app.post("/api/projects/:id/media/:mediaId/proxy", async (request) => {
    const { id, mediaId } = request.params as { id: string; mediaId: string };
    assertProjectId(id);
    assertMediaId(mediaId);
    const bundle = await projectStore.get(id);
    const asset = bundle.project.media.find((item) => item.id === mediaId);
    if (!asset) throw new HttpError(404, "El recurso no existe.", "media_not_found");
    if (asset.kind !== "video") throw new HttpError(422, "Solo se generan proxies de video.", "not_video");
    const job = jobQueue.enqueue({
      type: "proxy",
      projectId: id,
      label: `Proxy de ${asset.name}`,
      cancellable: true,
      run: async (context) => {
        const latest = await projectStore.get(id);
        const current = latest.project.media.find((item) => item.id === mediaId);
        if (!current) throw new HttpError(404, "El recurso desaparecio.", "media_not_found");
        const proxyFile = await generateProxy(id, current, context.signal, (progress) =>
          context.setProgress(progress, "Generando proxy"),
        );
        context.setDetail({ proxyFile });
        return { proxyFile };
      },
    });
    return { job, proxy: "pending" };
  });

  app.get("/api/projects/:id/subtitles.srt", async (request, reply) => {
    const { id } = request.params as { id: string };
    assertProjectId(id);
    const bundle = await projectStore.get(id);
    const srt = buildSrt(bundle.project);
    if (!srt.trim()) throw new HttpError(404, "El proyecto no tiene subtítulos.", "no_subtitles");
    reply
      .header("Content-Type", "application/x-subrip; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="subtitulos.srt"`)
      .send(srt);
  });
}
