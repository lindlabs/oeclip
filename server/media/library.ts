import fs from "node:fs/promises";
import path from "node:path";
import type { MediaAsset } from "../../src/shared/schema";
import { frameDurationUs } from "../../src/shared/time";
import { config } from "../config";
import { projectCacheDirectory, projectProxyDirectory, projectStore } from "../projects/store";
import { HttpError, pathExists } from "../util/fs";
import { runFfmpeg, runProcess } from "./process";
import { probeMedia } from "./probe";

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

const thumbnailSemaphore = new Semaphore(2);
const waveformSemaphore = new Semaphore(2);
const thumbnailInflight = new Map<string, Promise<string>>();
const waveformInflight = new Map<string, Promise<string>>();

export const FALLBACK_THUMBNAIL_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAAAEAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z",
  "base64",
);

export function resolveMediaFile(projectId: string, asset: MediaAsset, useProxy = false): string {
  const relative = useProxy && asset.proxy === "ready" && asset.proxyFile ? asset.proxyFile : asset.file;
  return path.join(path.dirname(projectCacheDirectory(projectId)), relative);
}

export async function requireMediaFile(projectId: string, asset: MediaAsset, useProxy = false): Promise<string> {
  const file = resolveMediaFile(projectId, asset, useProxy);
  if (!(await pathExists(file))) {
    if (asset.origin === "generated" || asset.file.startsWith("generated/")) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.alloc(0)).catch(() => undefined);
      return file;
    }
    throw new HttpError(
      410,
      `El archivo multimedia "${asset.name}" no está disponible en la carpeta del proyecto.`,
      "media_missing",
    );
  }
  return file;
}

export async function ensureThumbnail(projectId: string, asset: MediaAsset, signal?: AbortSignal): Promise<string> {
  if (asset.kind === "audio") {
    const exists = await pathExists(thumbnailPath(projectId, asset.id));
    if (exists) return thumbnailPath(projectId, asset.id);
  }
  const key = `${projectId}:${asset.id}`;
  const inflight = thumbnailInflight.get(key);
  if (inflight) return inflight;
  const task = thumbnailSemaphore.run(async () => {
    const output = thumbnailPath(projectId, asset.id);
    if (await pathExists(output)) return output;
    await fs.mkdir(projectCacheDirectory(projectId), { recursive: true });

    const file = resolveMediaFile(projectId, asset);
    const fileExists = await pathExists(file);
    if (!fileExists) {
      // Escribir de inmediato el buffer JPEG de respaldo
      await fs.writeFile(output, FALLBACK_THUMBNAIL_BYTES).catch(() => undefined);
      return output;
    }

    const temp = `${output}.tmp-${Date.now()}.jpg`;
    const durationSeconds = Math.max(0, asset.durationUs / 1_000_000);
    if (asset.kind === "audio") {
      await runFfmpeg(
        [
          "-y",
          "-i",
          file,
          "-filter_complex",
          "color=c=0xE7EEE5:s=640x360[bg];[0:a]showwavespic=s=640x360:colors=0x5B875C:split_channels=0[w];[bg][w]overlay=shortest=1",
          "-frames:v",
          "1",
          "-q:v",
          "4",
          temp,
        ],
        { signal, timeoutMs: 60_000 },
      );
    } else if (asset.kind === "image") {
      await runFfmpeg(
        ["-y", "-i", file, "-frames:v", "1", "-vf", "scale=480:-2:flags=lanczos", "-q:v", "3", temp],
        { signal, timeoutMs: 60_000 },
      );
    } else {
      const seek = Math.min(Math.max(0.2, durationSeconds * 0.12), Math.max(0.2, durationSeconds - 0.1), 5);
      await runFfmpeg(
        [
          "-y",
          "-ss",
          String(seek),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=480:-2:flags=lanczos",
          "-q:v",
          "3",
          temp,
        ],
        { signal, timeoutMs: 90_000 },
      );
    }
    await fs.rename(temp, output).catch(async (error) => {
      await fs.rm(temp, { force: true });
      throw error;
    });
    return output;
  });
  thumbnailInflight.set(key, task);
  try {
    return await task;
  } finally {
    thumbnailInflight.delete(key);
  }
}

export function thumbnailPath(projectId: string, mediaId: string): string {
  return path.join(projectCacheDirectory(projectId), `thumb-${mediaId}.jpg`);
}

export interface WaveformData {
  peaks: Array<{ min: number; max: number }>;
  durationUs: number;
  sampleRate: number;
}

export async function ensureWaveform(
  projectId: string,
  asset: MediaAsset,
  peakCount = 900,
  signal?: AbortSignal,
): Promise<WaveformData> {
  const safePeaks = Math.min(2400, Math.max(100, Math.round(peakCount)));
  const key = `${projectId}:${asset.id}:${safePeaks}`;
  const inflight = waveformInflight.get(key);
  if (inflight) {
    const file = await inflight;
    return JSON.parse(await fs.readFile(file, "utf8")) as WaveformData;
  }
  const task = waveformSemaphore.run(async () => {
    const cache = path.join(projectCacheDirectory(projectId), `wave-${asset.id}-${safePeaks}.json`);
    if (await pathExists(cache)) return cache;
    await fs.mkdir(projectCacheDirectory(projectId), { recursive: true });

    const file = resolveMediaFile(projectId, asset);
    const fileExists = await pathExists(file);
    if (!fileExists || asset.durationUs <= 0) {
      const emptyWave: WaveformData = {
        peaks: Array.from({ length: safePeaks }, () => ({ min: 0, max: 0 })),
        durationUs: Math.max(0, asset.durationUs),
        sampleRate: 8000,
      };
      await fs.writeFile(cache, JSON.stringify(emptyWave), "utf8").catch(() => undefined);
      return cache;
    }
    await fs.mkdir(projectCacheDirectory(projectId), { recursive: true });
    const sampleRate = 8000;
    const totalSamples = Math.max(1, Math.round((asset.durationUs / 1_000_000) * sampleRate));
    const bucketSamples = Math.max(1, totalSamples / safePeaks);
    const mins = new Float32Array(safePeaks).fill(1);
    const maxs = new Float32Array(safePeaks).fill(-1);
    let sampleIndex = 0;
    let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    await runProcess(
      config.ffmpeg,
      ["-hide_banner", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"],
      {
        signal,
        timeoutMs: 10 * 60_000,
        onStdoutChunk: (chunk) => {
          const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          const usable = combined.length - (combined.length % 2);
          const view = new Int16Array(combined.buffer, combined.byteOffset, Math.floor(usable / 2));
          for (let i = 0; i < view.length; i += 1) {
            const value = (view[i] ?? 0) / 32768;
            const bucket = Math.min(safePeaks - 1, Math.floor(sampleIndex / bucketSamples));
            if (value < (mins[bucket] ?? 1)) mins[bucket] = value;
            if (value > (maxs[bucket] ?? -1)) maxs[bucket] = value;
            sampleIndex += 1;
          }
          carry = combined.subarray(usable);
        },
      },
    );
    const peaks = Array.from({ length: safePeaks }, (_, index) => ({
      min: Number((mins[index] ?? 0).toFixed(4)),
      max: Number((maxs[index] ?? 0).toFixed(4)),
    }));
    const data: WaveformData = { peaks, durationUs: asset.durationUs, sampleRate };
    const temp = `${cache}.tmp-${Date.now()}`;
    await fs.writeFile(temp, JSON.stringify(data), "utf8");
    await fs.rename(temp, cache);
    return cache;
  });
  waveformInflight.set(key, task);
  try {
    const file = await task;
    return JSON.parse(await fs.readFile(file, "utf8")) as WaveformData;
  } finally {
    waveformInflight.delete(key);
  }
}

export interface AudioWindow {
  startUs: number;
  endUs: number;
  rms: number;
  rmsDb: number;
}

export async function analyzeAudioEnvelope(
  projectId: string,
  asset: MediaAsset,
  windowSeconds = 0.5,
  signal?: AbortSignal,
): Promise<{ windows: AudioWindow[]; durationUs: number; peakDb: number; meanDb: number; silenceRatio: number }> {
  const file = await requireMediaFile(projectId, asset);
  const sampleRate = 8000;
  const windowSamples = Math.max(1, Math.round(windowSeconds * sampleRate));
  const windows: AudioWindow[] = [];
  let sampleIndex = 0;
  let sumSquares = 0;
  let windowCount = 0;
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let maxAbs = 0;
  let silentWindows = 0;
  const flush = () => {
    if (windowCount === 0) return;
    const rms = Math.sqrt(sumSquares / windowCount);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    windows.push({
      startUs: Math.round((sampleIndex - windowCount) * 1_000_000 / sampleRate),
      endUs: Math.round(sampleIndex * 1_000_000 / sampleRate),
      rms: Number(rms.toFixed(5)),
      rmsDb: Number(db.toFixed(2)),
    });
    if (db < -45) silentWindows += 1;
    sumSquares = 0;
    windowCount = 0;
  };
  await runProcess(
    config.ffmpeg,
    ["-hide_banner", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"],
    {
      signal,
      timeoutMs: 10 * 60_000,
      onStdoutChunk: (chunk) => {
        const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const usable = combined.length - (combined.length % 2);
        const view = new Int16Array(combined.buffer, combined.byteOffset, Math.floor(usable / 2));
        for (let i = 0; i < view.length; i += 1) {
          const value = (view[i] ?? 0) / 32768;
          maxAbs = Math.max(maxAbs, Math.abs(value));
          sumSquares += value * value;
          windowCount += 1;
          sampleIndex += 1;
          if (windowCount >= windowSamples) flush();
        }
        carry = combined.subarray(usable);
      },
    },
  );
  flush();
  const dbValues = windows.map((window) => window.rmsDb);
  const meanDb = dbValues.length > 0 ? dbValues.reduce((a, b) => a + b, 0) / dbValues.length : -100;
  return {
    windows,
    durationUs: asset.durationUs,
    peakDb: maxAbs > 0 ? Number((20 * Math.log10(maxAbs)).toFixed(2)) : -100,
    meanDb: Number(meanDb.toFixed(2)),
    silenceRatio: windows.length > 0 ? Number((silentWindows / windows.length).toFixed(3)) : 0,
  };
}

export async function generateProxy(
  projectId: string,
  asset: MediaAsset,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<string> {
  if (asset.kind !== "video") throw new HttpError(422, "Solo se generan proxies de video.", "not_video");
  const file = await requireMediaFile(projectId, asset);
  const dir = projectProxyDirectory(projectId);
  await fs.mkdir(dir, { recursive: true });
  const relative = `proxies/${asset.id}.mp4`;
  const output = path.join(dir, `${asset.id}.mp4`);
  const temp = path.join(dir, `${asset.id}.tmp-${Date.now()}.mp4`);
  await projectStore.updateMedia(projectId, asset.id, { proxy: "pending" });
  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        file,
        "-vf",
        "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        temp,
      ],
      {
        signal,
        durationSeconds: asset.durationUs / 1_000_000,
        onProgress: (progress) => onProgress(progress.progress),
        timeoutMs: 60 * 60_000,
      },
    );
    const probe = await probeMedia(temp);
    if (probe.durationUs <= 0) throw new HttpError(500, "El proxy generado no es válido.", "proxy_invalid");
    await fs.rename(temp, output);
    await projectStore.updateMedia(projectId, asset.id, { proxy: "ready", proxyFile: relative });
    return relative;
  } catch (error) {
    await projectStore.updateMedia(projectId, asset.id, { proxy: "error" }).catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function estimateTimelineDurationUs(durationFrames: number, fps: { num: number; den: number }): number {
  return Math.round((durationFrames * frameDurationUs(fps)) / 1000) * 1000;
}
