import path from "node:path";
import { config } from "../config";
import { runProcess } from "./process";
import { HttpError } from "../util/fs";

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  bit_rate?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

export interface ProbeFormat {
  filename?: string;
  format_name?: string;
  format_long_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

export interface ProbeJson {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

export interface ProbeResult {
  kind: "video" | "audio" | "image";
  durationUs: number;
  width?: number;
  height?: number;
  fps?: { num: number; den: number };
  rotation?: number;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  sizeBytes: number;
  formatName?: string;
  bitRate?: number;
  raw: ProbeJson;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "gif", "tiff"]);

export function parseRational(value?: string): { num: number; den: number } | undefined {
  if (!value) return undefined;
  const [numRaw, denRaw] = value.split("/");
  const num = Number(numRaw);
  const den = Number(denRaw ?? "1");
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return undefined;
  return { num: Math.round(num), den: Math.round(den) };
}

export function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
  };
  return map[ext] ?? "application/octet-stream";
}

export function isSupportedExtension(filePath: string): boolean {
  return mimeForFile(filePath) !== "application/octet-stream";
}

export async function probeMedia(filePath: string, signal?: AbortSignal): Promise<ProbeResult> {
  const result = await runProcess(
    config.ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { signal, timeoutMs: 60_000 },
  );
  if (result.aborted) throw new HttpError(499, "Analisis cancelado.", "cancelled");
  if (result.code !== 0) {
    throw new HttpError(
      422,
      "No se pudo leer el archivo multimedia. Puede estar corrupto o usar un formato no soportado.",
      "probe_failed",
    );
  }
  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(result.stdout) as ProbeJson;
  } catch {
    throw new HttpError(422, "FFprobe devolvió una respuesta no válida.", "probe_invalid");
  }
  const streams = parsed.streams ?? [];
  const videoStream = streams.find(
    (stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const ext = path.extname(filePath).toLowerCase();
  const formatName = parsed.format?.format_name;
  const durationRaw = Number(parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0);
  const durationUs = Number.isFinite(durationRaw) ? Math.max(0, Math.round(durationRaw * 1_000_000)) : 0;
  const fps = parseRational(videoStream?.r_frame_rate) ?? parseRational(videoStream?.avg_frame_rate);
  let rotation = 0;
  const sideData = videoStream?.side_data_list?.find((item) => typeof item.rotation === "number");
  if (sideData && typeof sideData.rotation === "number") rotation = Math.round(sideData.rotation);
  const tagRotate = videoStream?.tags?.rotate ? Number(videoStream.tags.rotate) : 0;
  if (!rotation && Number.isFinite(tagRotate)) rotation = Math.round(tagRotate);

  let kind: "video" | "audio" | "image";
  if (!videoStream) {
    kind = "audio";
  } else if (IMAGE_EXTENSIONS.has(ext) || (IMAGE_CODECS.has(videoStream.codec_name ?? "") && durationUs === 0)) {
    kind = "image";
  } else {
    kind = "video";
  }
  if (kind === "audio" && !audioStream) {
    throw new HttpError(422, "El archivo no contiene audio ni video utilizables.", "no_streams");
  }

  return {
    kind,
    durationUs: kind === "image" ? 0 : durationUs,
    width: videoStream?.width,
    height: videoStream?.height,
    fps: fps ? { num: fps.num, den: fps.den } : undefined,
    rotation: rotation || undefined,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : undefined,
    channels: audioStream?.channels,
    sizeBytes: Number(parsed.format?.size ?? 0),
    formatName,
    bitRate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : undefined,
    raw: parsed,
  };
}

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface ExportVerificationResult {
  valid: boolean;
  message: string;
  durationUs: number;
  width: number;
  height: number;
  videoCodec?: string;
  audioCodec?: string;
  fps?: number;
  sizeBytes: number;
}

export async function verifyVideoFile(
  filePath: string,
  expected: { durationUs: number; width: number; height: number; hasAudio?: boolean },
): Promise<ExportVerificationResult> {
  const probe = await probeMedia(filePath);
  const fps = probe.fps ? probe.fps.num / probe.fps.den : undefined;
  const durationDelta = Math.abs(probe.durationUs - expected.durationUs);
  const tolerance = Math.max(700_000, expected.durationUs * 0.005);
  const issues: string[] = [];
  if (probe.kind !== "video") issues.push("El archivo no contiene una pista de video válida.");
  if (durationDelta > tolerance) {
    issues.push(
      `Duración inesperada: ${(probe.durationUs / 1e6).toFixed(2)}s frente a ${(expected.durationUs / 1e6).toFixed(2)}s.`,
    );
  }
  if (probe.width !== expected.width || probe.height !== expected.height) {
    issues.push(`Dimensiones ${probe.width}x${probe.height} frente a ${expected.width}x${expected.height}.`);
  }
  if (expected.hasAudio && !probe.audioCodec) issues.push("Falta la pista de audio.");
  if (probe.sizeBytes <= 0) issues.push("El archivo generado está vacío.");
  return {
    valid: issues.length === 0,
    message: issues.length === 0 ? "Exportación verificada con FFprobe." : issues.join(" "),
    durationUs: probe.durationUs,
    width: probe.width ?? 0,
    height: probe.height ?? 0,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    fps,
    sizeBytes: probe.sizeBytes,
  };
}
