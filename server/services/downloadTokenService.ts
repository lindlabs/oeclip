import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { config } from "../config";

export type DownloadTokenPayload =
  | {
      kind: "export";
      projectId: string;
      exportId: string;
      fileName: string;
      contentType?: string;
      download?: boolean;
      exp: number;
    }
  | {
      kind: "file";
      projectId: string;
      relPath: string;
      fileName: string;
      contentType?: string;
      download?: boolean;
      exp: number;
    };

export type DownloadTokenInput =
  | Omit<Extract<DownloadTokenPayload, { kind: "export" }>, "exp">
  | Omit<Extract<DownloadTokenPayload, { kind: "file" }>, "exp">;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const secretCache = new Map<string, string>();
let fallbackEphemeralSecret: string | null = null;

function activeDataDir(): string {
  return path.resolve(process.env.NOVACUT_DATA_DIR?.trim() || config.dataDir);
}

function getSigningSecret(): string {
  const envSecret = process.env.NOVACUT_DOWNLOAD_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) return envSecret;

  const dataDir = activeDataDir();
  const cached = secretCache.get(dataDir);
  if (cached) return cached;

  const secretPath = path.join(dataDir, ".download-secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) {
      secretCache.set(dataDir, existing);
      return existing;
    }
  } catch {
    // Se intenta crear una clave compartida en dataDir para todas las réplicas.
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretPath, generated, { encoding: "utf8", flag: "wx", mode: 0o600 });
    secretCache.set(dataDir, generated);
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      try {
        const racer = fs.readFileSync(secretPath, "utf8").trim();
        if (racer.length >= 16) {
          secretCache.set(dataDir, racer);
          return racer;
        }
      } catch {
        // continúa al fallback en memoria
      }
    }
  }

  if (!fallbackEphemeralSecret) {
    fallbackEphemeralSecret = crypto.randomBytes(32).toString("hex");
  }
  return fallbackEphemeralSecret;
}

function signPayload(encodedPayload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeFileSegment(fileName: string, fallback = "archivo.bin"): string {
  const clean = path
    .basename(fileName || fallback)
    .replace(/[\r\n\0/\\?%*:|"<>]/g, "-")
    .replace(/-{2,}/g, "-")
    .trim();
  return clean || fallback;
}

export function createDownloadToken(input: DownloadTokenInput, ttlMs = DEFAULT_TTL_MS): string {
  const safeTtl = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, ttlMs));
  const payload: DownloadTokenPayload = {
    ...input,
    fileName: safeFileSegment(input.fileName),
    exp: Date.now() + safeTtl,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signPayload(encoded, getSigningSecret());
  return `v1.${encoded}.${sig}`;
}

export function verifyDownloadToken(token: string): DownloadTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;

  const expectedSig = signPayload(encoded, getSigningSecret());
  const a = Buffer.from(expectedSig, "utf8");
  const b = Buffer.from(providedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as DownloadTokenPayload;
    if (!parsed || typeof parsed !== "object" || typeof parsed.exp !== "number") return null;
    if (Date.now() > parsed.exp) return null;
    if (typeof parsed.projectId !== "string" || !parsed.projectId) return null;
    if (parsed.kind === "export") {
      if (typeof parsed.exportId !== "string" || !parsed.exportId) return null;
      return parsed;
    }
    if (parsed.kind === "file") {
      if (typeof parsed.relPath !== "string" || !parsed.relPath) return null;
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildSignedDownloadPath(input: DownloadTokenInput, ttlMs = DEFAULT_TTL_MS): string {
  const safeName = safeFileSegment(input.fileName);
  const token = createDownloadToken({ ...input, fileName: safeName }, ttlMs);
  return `/api/downloads/${encodeURIComponent(token)}/${encodeURIComponent(safeName)}`;
}

export function resolveSafeProjectRelativePath(projectDir: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!/^(renders|exports|media)\//.test(normalized)) return null;
  const base = path.resolve(projectDir);
  const target = path.resolve(base, normalized);
  if (!target.startsWith(`${base}${path.sep}`)) return null;
  return target;
}
