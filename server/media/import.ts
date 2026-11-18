import fs from "node:fs/promises";
import path from "node:path";
import type { MediaAsset } from "../../src/shared/schema";
import { newId } from "../../src/shared/time";
import { projectMediaDirectory, projectStore } from "../projects/store";
import { HttpError, pathExists, sanitizeFileName } from "../util/fs";
import { mimeForFile, probeMedia, isSupportedExtension } from "./probe";

const MAX_DURATION_US = 6 * 60 * 60 * 1_000_000;

export async function importMediaFile(
  projectId: string,
  tempFile: string,
  originalName: string,
): Promise<MediaAsset> {
  if (!isSupportedExtension(originalName)) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw new HttpError(
      415,
      "Formato no soportado. Usa MP4, MOV, MKV, WebM, AVI, MP3, WAV, M4A, FLAC, OGG, JPG, PNG o WebP.",
      "unsupported_format",
    );
  }
  try {
    const probe = await probeMedia(tempFile);
    if (probe.durationUs > MAX_DURATION_US) {
      throw new HttpError(413, "El archivo supera la duración máxima permitida (6 horas).", "media_too_long");
    }
    const mediaId = newId("med");
    const ext = path.extname(originalName).toLowerCase() || ".bin";
    const storedName = `${mediaId}${ext}`;
    const mediaDir = projectMediaDirectory(projectId);
    await fs.mkdir(mediaDir, { recursive: true });
    const destination = path.join(mediaDir, storedName);
    await fs.rename(tempFile, destination).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        await fs.copyFile(tempFile, destination);
        await fs.rm(tempFile, { force: true });
      } else {
        throw error;
      }
    });
    const asset: MediaAsset = {
      id: mediaId,
      name: sanitizeFileName(originalName, "recurso"),
      kind: probe.kind,
      file: `media/${storedName}`,
      mimeType: mimeForFile(originalName),
      sizeBytes: (await fs.stat(destination)).size,
      durationUs: probe.durationUs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      rotation: probe.rotation,
      thumbnail: "pending",
      waveform: probe.audioCodec ? "none" : "none",
      proxy: "none",
      importedAt: new Date().toISOString(),
      origin: "import",
    };
    await projectStore.addMedia(projectId, asset);
    return asset;
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function mediaAbsolutePath(projectId: string, asset: MediaAsset, useProxy = false): string {
  const projectRoot = path.dirname(projectMediaDirectory(projectId));
  const relative = useProxy && asset.proxy === "ready" && asset.proxyFile ? asset.proxyFile : asset.file;
  return path.join(projectRoot, relative);
}

export async function assertMediaFileExists(projectId: string, asset: MediaAsset): Promise<string> {
  const file = mediaAbsolutePath(projectId, asset);
  if (!(await pathExists(file))) {
    if (asset.origin === "generated" || asset.file.startsWith("generated/")) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.alloc(0)).catch(() => undefined);
      return file;
    }
    throw new HttpError(410, "El archivo multimedia ya no está disponible en el proyecto.", "media_missing");
  }
  return file;
}
