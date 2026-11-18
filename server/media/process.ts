import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { config } from "../config";
import { HttpError } from "../util/fs";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onStdoutChunk?: (chunk: Buffer) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const MAX_BUFFER = 4 * 1024 * 1024;

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // proceso ya terminado
    }
  }
}

export function runProcess(bin: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const maxBuffer = options.maxBuffer ?? MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(bin, args, {
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: options.cwd,
    });

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, options.timeoutMs)
        : null;

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let stdoutCarry = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.onStdoutChunk) {
        try {
          options.onStdoutChunk(chunk);
        } catch (error) {
          stderr += `\n[oeclip] Error procesando salida: ${String(error)}`;
        }
      }
      if (options.onStdoutLine) {
        const text = stdoutCarry + chunk.toString("utf8");
        const lines = text.split(/\r?\n/);
        stdoutCarry = lines.pop() ?? "";
        for (const line of lines) options.onStdoutLine(line);
      } else if (stdout.length < maxBuffer) {
        stdout += chunk.toString("utf8");
      }
    });

    let stderrCarry = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderr.length < maxBuffer) stderr += text;
      if (options.onStderrLine) {
        const combined = stderrCarry + text;
        const lines = combined.split(/\r?\n/);
        stderrCarry = lines.pop() ?? "";
        for (const line of lines) options.onStderrLine(line);
      }
    });

    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (stdoutCarry && options.onStdoutLine) options.onStdoutLine(stdoutCarry);
      if (stderrCarry && options.onStderrLine) options.onStderrLine(stderrCarry);
      if (error && !aborted && !timedOut) {
        reject(error);
        return;
      }
      resolve({
        code,
        stdout,
        stderr,
        aborted,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

export interface FfmpegProgress {
  seconds: number;
  progress: number;
}

export interface FfmpegOptions extends RunOptions {
  durationSeconds?: number;
  onProgress?: (progress: FfmpegProgress) => void;
}

export async function runFfmpeg(args: string[], options: FfmpegOptions = {}): Promise<ProcessResult> {
  let lastOut = 0;
  let lastEmit = 0;
  const fullArgs = [
    "-hide_banner",
    "-nostdin",
    "-progress",
    "pipe:1",
    "-nostats",
    ...args,
  ];
  const result = await runProcess(config.ffmpeg, fullArgs, {
    ...options,
    onStdoutLine: (line) => {
      const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
      if (match?.[1]) {
        const raw = Number(match[1]);
        lastOut = raw > 10_000_000 ? raw / 1_000_000 : raw / 1_000_000;
        // out_time_us y out_time_ms se expresan en microsegundos en FFmpeg reciente.
        const seconds = raw / 1_000_000;
        const now = Date.now();
        if (now - lastEmit > 350 && options.onProgress) {
          lastEmit = now;
          const duration = options.durationSeconds && options.durationSeconds > 0 ? options.durationSeconds : 0;
          options.onProgress({
            seconds,
            progress: duration > 0 ? Math.min(0.999, seconds / duration) : 0,
          });
        }
      }
      options.onStdoutLine?.(line);
    },
  });
  if (options.onProgress) {
    const duration = options.durationSeconds && options.durationSeconds > 0 ? options.durationSeconds : 0;
    options.onProgress({
      seconds: lastOut,
      progress: result.code === 0 ? 1 : duration > 0 ? Math.min(0.999, lastOut / duration) : 0,
    });
  }
  if (result.aborted) throw new HttpError(499, "Operación cancelada por el usuario.", "cancelled");
  if (result.timedOut) throw new HttpError(504, "La operación multimedia excedió el tiempo máximo.", "timeout");
  if (result.code !== 0) {
    const tail = result.stderr.split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
    throw new HttpError(500, `FFmpeg fallo (codigo ${result.code}).\n${tail}`, "ffmpeg_failed");
  }
  return result;
}

export function ffmpegBinary(): string {
  return config.ffmpeg;
}
