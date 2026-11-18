import os from "node:os";
import path from "node:path";
import { config } from "./config";
import { runProcess } from "./media/process";
import { remotionEngineAvailable } from "./media/remotion";

export interface SystemCapabilities {
  ffmpegVersion: string | null;
  nvenc: boolean;
  nvidiaGpu: string | null;
  cpuCores: number;
  totalMemoryBytes: number;
  aiConfigured: boolean;
  aiModel: string;
  remotion: boolean;
  checkedAt: string;
}

let cached: Promise<SystemCapabilities> | null = null;
let cachedFilterScriptOption: Promise<string> | null = null;

async function detect(): Promise<SystemCapabilities> {
  let ffmpegVersion: string | null = null;
  let nvenc = false;
  try {
    const version = await runProcess(config.ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 15_000 });
    const firstLine = version.stdout.split(/\r?\n/)[0] ?? "";
    ffmpegVersion = firstLine.replace(/^ffmpeg version\s*/i, "").trim() || null;
    const encoders = await runProcess(config.ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 20_000 });
    nvenc = /h264_nvenc/.test(encoders.stdout);
  } catch {
    ffmpegVersion = null;
  }

  let nvidiaGpu: string | null = null;
  if (nvenc) {
    try {
      const smi = await runProcess(
        "nvidia-smi",
        ["--query-gpu=name,memory.total", "--format=csv,noheader"],
        { timeoutMs: 10_000 },
      );
      if (smi.code === 0) {
        nvidiaGpu = smi.stdout.trim().split(/\r?\n/)[0] ?? null;
      }
    } catch {
      nvidiaGpu = null;
    }
  }

  return {
    ffmpegVersion,
    nvenc,
    nvidiaGpu,
    cpuCores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    aiConfigured: Boolean(config.ai.apiKey),
    aiModel: config.ai.model,
    remotion: remotionEngineAvailable(),
    checkedAt: new Date().toISOString(),
  };
}

export function getCapabilities(force = false): Promise<SystemCapabilities> {
  if (force || !cached) cached = detect();
  return cached;
}

export async function selectEncoder(preference: "auto" | "cpu" | "nvidia"): Promise<"libx264" | "h264_nvenc"> {
  if (preference === "cpu") return "libx264";
  const capabilities = await getCapabilities();
  if (!capabilities.nvenc) return "libx264";
  if (preference === "nvidia") return "h264_nvenc";
  return capabilities.nvidiaGpu ? "h264_nvenc" : "libx264";
}

export function resetCapabilitiesCache(): void {
  cached = null;
  cachedFilterScriptOption = null;
}

/**
 * FFmpeg 9 elimino `-filter_complex_script`. Las compilaciones modernas aceptan
 * `-/filter_complex <archivo>`; las anteriores usan el nombre clasico. Se detecta
 * una sola vez por proceso consultando la ayuda del binario.
 */
export function filterScriptOption(): Promise<string> {
  if (!cachedFilterScriptOption) {
    cachedFilterScriptOption = (async () => {
      try {
        const help = await runProcess(config.ffmpeg, ["-hide_banner", "-h", "full"], { timeoutMs: 30_000 });
        if (/\bfilter_complex_script\b/.test(help.stdout)) return "-filter_complex_script";
        const probe = await runProcess(
          config.ffmpeg,
          [
            "-hide_banner",
            "-/filter_complex",
            path.join(os.tmpdir(), "novacut-filter-probe-does-not-exist.txt"),
            "-version",
          ],
          { timeoutMs: 20_000 },
        );
        const output = `${probe.stdout}\n${probe.stderr}`;
        if (!/Unrecognized option|Option not found/i.test(output)) return "-/filter_complex";
      } catch {
        // se usa la opcion clasica y FFmpeg explicara el error real
      }
      return "-filter_complex_script";
    })();
  }
  return cachedFilterScriptOption;
}
