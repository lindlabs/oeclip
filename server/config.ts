import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const rootDir = path.resolve(import.meta.dirname, "..");
loadEnvFile(path.join(rootDir, ".env"));

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const resolvedDataDir = path.resolve(process.env.NOVACUT_DATA_DIR?.trim() || path.join(rootDir, "data"));

// Los temporales de render/exportación deben vivir en disco local rápido. En Cloud Run
// /app/data es un bucket montado por FUSE (lento y sin seeks fiables para MP4), así que en
// producción se usa el directorio temporal del sistema. NOVACUT_TMP_DIR lo sobreescribe.
function resolveTmpDir(): string {
  const explicit = process.env.NOVACUT_TMP_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.env.NODE_ENV === "production") return path.join(os.tmpdir(), "oeclip-tmp");
  return path.join(resolvedDataDir, "tmp");
}

export const config = {
  brand: process.env.OECLIP_BRAND?.trim() || process.env.NOVACUT_BRAND?.trim() || "OECLIP",
  rootDir,
  dataDir: resolvedDataDir,
  tmpDir: resolveTmpDir(),
  distDir: path.join(rootDir, "dist"),
  assetsDir: path.join(rootDir, "assets"),
  port: envNumber("PORT", envNumber("NOVACUT_PORT", 4331)),
  host: process.env.NOVACUT_HOST?.trim() || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  ffmpeg: process.env.NOVACUT_FFMPEG?.trim() || "ffmpeg",
  ffprobe: process.env.NOVACUT_FFPROBE?.trim() || "ffprobe",
  maxUploadBytes: envNumber("NOVACUT_MAX_UPLOAD_MB", 4096) * 1024 * 1024,
  encoderPreference: (process.env.NOVACUT_ENCODER?.trim() || "auto") as "auto" | "cpu" | "nvidia",
  ai: {
    baseUrl: (process.env.NOVACUT_AI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.NOVACUT_AI_API_KEY?.trim() || "",
    model: process.env.NOVACUT_AI_MODEL?.trim() || "gpt-4o-mini",
    transcribeModel:
      process.env.NOVACUT_AI_TRANSCRIBE_MODEL !== undefined
        ? process.env.NOVACUT_AI_TRANSCRIBE_MODEL.trim()
        : "whisper-1",
    timeoutMs: envNumber("NOVACUT_AI_TIMEOUT_MS", 120_000),
  },
  interFont: path.join(rootDir, "assets", "fonts", "Inter-Variable.ttf"),
  exportsDir: path.join(rootDir, "exports"),
  isDev: process.env.NOVACUT_DEV === "1",
};

export function ensureBaseDirs(): void {
  fs.mkdirSync(path.join(config.dataDir, "projects"), { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "trash"), { recursive: true });
  if (!fs.existsSync(config.interFont)) {
    console.warn(`[oeclip] Falta la fuente de render: ${config.interFont}. Los textos se exportaran sin drawtext.`);
  }
}
