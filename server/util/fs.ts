import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = /^prj_[a-zA-Z0-9]{6,40}$/;
const MEDIA_TOKEN = /^[a-zA-Z0-9_-]{3,64}$/;

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, code = "bad_request", details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function assertProjectId(id: string): string {
  if (!PROJECT_ID.test(id)) throw new HttpError(400, "Identificador de proyecto inválido.", "invalid_project_id");
  return id;
}

export function assertMediaId(id: string): string {
  if (!MEDIA_TOKEN.test(id)) throw new HttpError(400, "Identificador de recurso inválido.", "invalid_media_id");
  return id;
}

export function assertExportId(id: string): string {
  if (!MEDIA_TOKEN.test(id)) throw new HttpError(400, "Identificador de exportación inválido.", "invalid_export_id");
  return id;
}

export function resolveInside(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new HttpError(400, "Ruta no permitida.", "path_traversal");
  }
  const resolved = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new HttpError(400, "Ruta fuera del proyecto.", "path_traversal");
  }
  return resolved;
}

export function sanitizeFileName(input: string, fallback = "archivo"): string {
  const base = path.basename(input).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
  const withoutDots = base.replace(/^\.+/, "").slice(0, 120);
  return withoutDots || fallback;
}

export function uniqueFileName(dir: string, desired: string): Promise<string> {
  return (async () => {
    const parsed = path.parse(desired);
    let candidate = path.join(dir, desired);
    let index = 2;
    while (true) {
      try {
        await fs.access(candidate);
        candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
        index += 1;
      } catch {
        return candidate;
      }
    }
  })();
}

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80) || "oeclip";
}
