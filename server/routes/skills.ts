import type { FastifyInstance } from "fastify";
import "@fastify/multipart";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import AdmZip from "adm-zip";
import { z } from "zod";
import { config } from "../config";
import { HttpError, pathExists, resolveInside } from "../util/fs";
import { newId } from "../../src/shared/time";
import { skillSchema, type Skill } from "../../src/shared/skills";
import { skillRegistry, skillsDir } from "../skills/registry";

const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UPLOAD_MARKER = ".novacut-upload.json";
const MAX_ENTRIES = 400;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Extensiones permitidas dentro de un ZIP de skill (código, datos y medios). */
const ALLOWED_EXTENSIONS = new Set([
  ".json",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".md",
  ".txt",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".mp4",
  ".webm",
  ".mov",
]);

const ALLOWED_EXTENSIONLESS = new Set(["license", "licence", "notice", "readme"]);

function assertSkillId(id: string): string {
  if (!SKILL_ID.test(id) || id === "." || id === "..") {
    throw new HttpError(400, "Identificador de skill inválido.", "invalid_skill_id");
  }
  return id;
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isIgnoredEntry(name: string): boolean {
  const segments = name.split("/");
  return segments.some(
    (segment) =>
      segment === "__MACOSX" ||
      segment === ".git" ||
      segment === "node_modules" ||
      segment === ".DS_Store" ||
      segment === "Thumbs.db",
  );
}

function toSummary(skill: Skill, removable: boolean) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    kind: skill.kind,
    category: skill.category,
    version: skill.version,
    author: skill.author ?? null,
    tags: skill.tags,
    triggers: skill.triggers,
    parameters: skill.parameters,
    render: skill.render,
    instructions: skill.instructionsMarkdown ? skill.instructionsMarkdown.trim().slice(0, 8000) : "",
    removable,
  };
}

async function isRemovable(skillId: string): Promise<boolean> {
  return pathExists(path.join(skillsDir, skillId, UPLOAD_MARKER));
}

async function listInstalled() {
  const skills = skillRegistry.getAll();
  const summaries = await Promise.all(
    skills.map(async (skill) => toSummary(skill, await isRemovable(skill.id))),
  );
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function registerSkillRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/skills", async () => ({ skills: await listInstalled() }));

  app.get("/api/skills/:id", async (request) => {
    const { id } = request.params as { id: string };
    assertSkillId(id);
    if (skillRegistry.getAll().length === 0) {
      await skillRegistry.loadAll();
    }
    const skill = skillRegistry.get(id);
    if (!skill) {
      throw new HttpError(404, `La skill "${id}" no existe.`, "skill_not_found");
    }
    return {
      skill: {
        ...toSummary(skill, await isRemovable(skill.id)),
        body: skill.instructionsMarkdown ?? "",
      },
    };
  });

  app.post("/api/skills/upload", async (request, reply) => {
    const overwrite = (request.query as { overwrite?: string } | undefined)?.overwrite === "1";
    let data;
    try {
      data = await request.file();
    } catch (error) {
      throw new HttpError(413, "El archivo supera el limite de subida configurado.", "upload_too_large", error);
    }
    if (!data) throw new HttpError(400, "No se recibió ningún archivo ZIP.", "no_file");
    if (!/\.zip$/i.test(data.filename || "")) {
      throw new HttpError(422, "La skill debe subirse como un archivo .zip.", "invalid_skill_archive");
    }

    const tempDir = path.join(config.dataDir, "tmp", "skill-uploads");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${newId("skl")}.zip`);
    const stagingDir = path.join(tempDir, `${newId("skl")}.extract`);
    let installedDir: string | null = null;
    let previousDir: { trash: string; target: string } | null = null;

    try {
      await pipeline(data.file, createWriteStream(tempFile));
      if (data.file.truncated) {
        throw new HttpError(413, "El archivo supera el limite de subida configurado.", "upload_too_large");
      }
      const stat = await fs.stat(tempFile);
      if (stat.size === 0) throw new HttpError(400, "El archivo ZIP está vacío.", "empty_file");

      let zip: AdmZip;
      try {
        zip = new AdmZip(tempFile);
      } catch (error) {
        throw new HttpError(422, "No se pudo leer el ZIP de la skill.", "invalid_skill_archive", error);
      }

      const entries = zip.getEntries();
      if (entries.length > MAX_ENTRIES) {
        throw new HttpError(422, `El ZIP contiene demasiados archivos (máximo ${MAX_ENTRIES}).`, "skill_archive_too_large");
      }

      // 1. Localizar el manifiesto (skill.json en la raíz o dentro de una carpeta).
      const manifests = entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => ({ entry, name: normalizeEntryName(entry.entryName) }))
        .filter(({ name }) => name === "skill.json" || name.endsWith("/skill.json"))
        .sort((a, b) => a.name.split("/").length - b.name.split("/").length);

      const manifest = manifests[0];
      if (!manifest) {
        throw new HttpError(
          422,
          "El ZIP no contiene un skill.json en la raíz (o dentro de una única carpeta).",
          "skill_manifest_missing",
        );
      }

      let parsedManifest: unknown;
      try {
        parsedManifest = JSON.parse(manifest.entry.getData().toString("utf-8"));
      } catch (error) {
        throw new HttpError(422, "El skill.json del ZIP no es JSON válido.", "skill_manifest_invalid", error);
      }

      let skill: Skill;
      try {
        skill = skillSchema.parse(parsedManifest);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new HttpError(
            422,
            `El skill.json no es válido: ${error.issues
              .map((issue) => `${issue.path.join(".") || "skill"}: ${issue.message}`)
              .join("; ")}`,
            "skill_manifest_invalid",
            error.issues,
          );
        }
        throw error;
      }
      assertSkillId(skill.id);

      // 2. Extraer a una carpeta temporal validando rutas y tamaños.
      const rootPrefix = manifest.name.slice(0, -"skill.json".length);
      let totalBytes = 0;
      let written = 0;
      for (const entry of entries) {
        const name = normalizeEntryName(entry.entryName);
        if (!name || entry.isDirectory || name.endsWith("/")) continue;
        if (isIgnoredEntry(name)) continue;

        const baseName = name.split("/").pop() ?? name;
        const ext = path.extname(baseName).toLowerCase();
        if (ext) {
          if (!ALLOWED_EXTENSIONS.has(ext)) {
            throw new HttpError(
              422,
              `Archivo no permitido en la skill: "${name}" (${ext}).`,
              "skill_archive_forbidden_file",
            );
          }
        } else if (!ALLOWED_EXTENSIONLESS.has(baseName.toLowerCase())) {
          throw new HttpError(
            422,
            `Archivo no permitido en la skill: "${name}".`,
            "skill_archive_forbidden_file",
          );
        }

        const declaredSize = entry.header.size;
        if (declaredSize > MAX_ENTRY_BYTES) {
          throw new HttpError(422, `El archivo "${name}" es demasiado grande.`, "skill_archive_too_large");
        }
        totalBytes += declaredSize;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new HttpError(422, "El contenido descomprimido del ZIP es demasiado grande.", "skill_archive_too_large");
        }

        const destination = resolveInside(stagingDir, name);
        const content = entry.getData();
        if (content.length > MAX_ENTRY_BYTES) {
          throw new HttpError(422, `El archivo "${name}" es demasiado grande.`, "skill_archive_too_large");
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content);
        written += 1;
      }
      if (written === 0) {
        throw new HttpError(422, "El ZIP no contiene archivos utilizables.", "empty_skill_archive");
      }

      const payloadRoot = rootPrefix
        ? resolveInside(stagingDir, rootPrefix.replace(/\/+$/, ""))
        : stagingDir;

      // 3. Comprobar que los archivos declarados en el manifiesto existen.
      const requireFile = async (relativePath: string, label: string, allowAssetsFallback: boolean) => {
        const candidates = allowAssetsFallback
          ? [relativePath, `assets/${path.basename(relativePath)}`]
          : [relativePath];
        for (const candidate of candidates) {
          const absolute = resolveInside(payloadRoot, candidate);
          if (await pathExists(absolute)) return;
        }
        throw new HttpError(
          422,
          `Falta el archivo ${label} declarado en skill.json: "${relativePath}".`,
          "skill_file_missing",
        );
      };

      await requireFile(skill.template, "template", false);
      await requireFile(skill.compose, "compose", false);
      for (const font of skill.assets.fonts) await requireFile(font, "font", true);
      for (const image of skill.assets.images) await requireFile(image, "imagen", true);
      for (const audio of skill.assets.audio) await requireFile(audio, "audio", true);
      for (const script of skill.assets.scripts) await requireFile(script, "script", false);

      // 4. Instalar en skills/<id>.
      const target = path.join(skillsDir, skill.id);
      const exists = await pathExists(target);
      if (exists && !overwrite) {
        throw new HttpError(
          409,
          `Ya existe una skill con el id "${skill.id}". Confirma para reemplazarla.`,
          "skill_exists",
        );
      }

      const trash = path.join(skillsDir, `.trash-${skill.id}-${newId("old")}`);
      if (exists) {
        await fs.rename(target, trash);
        previousDir = { trash, target };
      }

      try {
        await fs.rename(payloadRoot, target);
      } catch (error) {
        if (previousDir) await fs.rename(previousDir.trash, previousDir.target).catch(() => undefined);
        previousDir = null;
        throw new HttpError(500, "No se pudo instalar la skill en disco.", "skill_install_failed", error);
      }

      await fs.writeFile(
        path.join(target, UPLOAD_MARKER),
        JSON.stringify({ uploadedAt: new Date().toISOString(), archive: data.filename }, null, 2),
        "utf-8",
      );
      installedDir = target;

      await skillRegistry.reload();
      const registered = skillRegistry.get(skill.id);
      if (!registered) {
        throw new HttpError(
          422,
          "La skill se copió pero no se pudo cargar. Revisa su skill.json y sus archivos.",
          "skill_load_failed",
        );
      }

      // La skill nueva ya está cargada: ahora sí se puede descartar la anterior.
      if (previousDir) {
        await fs.rm(previousDir.trash, { recursive: true, force: true }).catch(() => undefined);
        previousDir = null;
      }

      reply.code(exists ? 200 : 201);
      return {
        skill: toSummary(registered, true),
        overwritten: exists,
        summary: exists
          ? `Skill "${registered.name}" actualizada.`
          : `Skill "${registered.name}" instalada.`,
      };
    } catch (error) {
      if (installedDir) {
        await fs.rm(installedDir, { recursive: true, force: true }).catch(() => undefined);
        installedDir = null;
      }
      if (previousDir) {
        await fs.rename(previousDir.trash, previousDir.target).catch(() => undefined);
        previousDir = null;
      }
      await skillRegistry.reload().catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.delete("/api/skills/:id", async (request) => {
    const { id } = request.params as { id: string };
    assertSkillId(id);
    const target = path.join(skillsDir, id);
    if (!(await pathExists(target))) {
      throw new HttpError(404, `La skill "${id}" no existe.`, "skill_not_found");
    }
    if (!(await isRemovable(id))) {
      throw new HttpError(
        403,
        "Solo se pueden eliminar skills instaladas desde la interfaz.",
        "skill_not_removable",
      );
    }
    await fs.rm(target, { recursive: true, force: true });
    await skillRegistry.reload();
    return { deleted: true, skillId: id };
  });
}
