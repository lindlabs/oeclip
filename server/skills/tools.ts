import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import type { MediaAsset } from "../../src/shared/schema";
import { HttpError } from "../util/fs";
import {
  firstVideoTrack,
  timelineDurationFrames,
  makeMediaClip,
} from "../../src/shared/project";
import { importMediaFile } from "../media/import";
import { projectDirectory, projectTempDirectory } from "../projects/store";
import { newId } from "../../src/shared/time";
import { addClip, addTrack } from "../../src/shared/timeline";
import {
  formatSkillMarkdown,
  skillSchema,
  validateSkillParams,
} from "../../src/shared/skills";
import { executeSkill } from "./engine";
import { getSkillsDir, skillRegistry } from "./registry";

async function ensureRegistryLoaded(): Promise<void> {
  if (skillRegistry.getAll().length === 0) {
    await skillRegistry.loadAll();
  }
}

export const runSkillTool = {
  name: "run_skill",
  description:
    "Ejecuta una skill con plantilla renderizable (p. ej. mockup de celular) y coloca el clip en la línea de tiempo.",
  argsHint:
    '{ "skillId": "celular", "parameters": { "etiqueta": "Ventas", "desde": 0, "hasta": 100, "serie": [10,20,30] } }',
  risk: "low" as const,
  argsSchema: z.object({
    skillId: z.string().min(1),
    parameters: z.record(z.unknown()).default({}),
    startSeconds: z.number().min(0).optional(),
    trackId: z.string().optional(),
  }),
  execute: async (context: any, rawArgs: any) => {
    const args = z
      .object({
        skillId: z.string().min(1),
        parameters: z.record(z.unknown()).default({}),
        startSeconds: z.number().min(0).optional(),
        trackId: z.string().optional(),
      })
      .parse(rawArgs);

    await ensureRegistryLoaded();
    const skill = skillRegistry.get(args.skillId);
    if (!skill) {
      const available = skillRegistry
        .getAll()
        .map((s) => `${s.id} (${s.name})`)
        .join(", ");
      throw new HttpError(404, `Skill no encontrada: ${args.skillId}. Disponibles: ${available}`, "skill_not_found");
    }

    if (skill.kind === "recipe") {
      throw new HttpError(
        422,
        `La skill "${skill.id}" es una guía/receta de flujo (${skill.version}), no una plantilla de clip único. Léela con get_skill y sigue sus pasos o usa ask_director.`,
        "skill_is_recipe",
      );
    }

    const validation = validateSkillParams(skill, args.parameters);
    if (!validation.ok) {
      throw new HttpError(422, `Parámetros inválidos: ${validation.errors.join("; ")}`, "invalid_skill_params");
    }

    const warnings: string[] = [];
    const result = await executeSkill(skill, {
      projectId: context.projectId,
      project: context.project,
      parameters: validation.validated,
      selection: context.selection,
      onProgress: context.setProgress,
      signal: context.signal,
    });

    warnings.push(...result.warnings);
    if (!result.success) {
      throw new HttpError(500, `Error ejecutando skill: ${result.warnings.join("; ")}`, "skill_execution_failed");
    }

    let updatedProject = context.project;
    const fps = updatedProject.settings.fps.num / updatedProject.settings.fps.den;
    const startFrame =
      args.startSeconds !== undefined
        ? Math.round(args.startSeconds * fps)
        : timelineDurationFrames(updatedProject);

    let videoTrack = firstVideoTrack(updatedProject);
    if (!videoTrack && args.trackId) {
      const track = updatedProject.tracks.find((t: any) => t.id === args.trackId);
      if (track && track.kind === "video") videoTrack = track;
    }
    if (!videoTrack) {
      const trackResult = addTrack(updatedProject, "video", "Video");
      if (!trackResult.ok || !trackResult.track) throw new HttpError(500, "No se pudo crear pista de video");
      updatedProject = trackResult.project;
      videoTrack = trackResult.track;
    }

    const importedFiles: string[] = [];
    let insertedFrames = 0;
    for (const clip of result.clips) {
      const videoFile = clip.props?.videoFile as string | undefined;
      if (!videoFile) {
        warnings.push(`Clip de skill ${skill.id} sin archivo de video`);
        continue;
      }

      const projectDir = projectDirectory(context.projectId);
      const fullVideoPath = path.join(projectDir, videoFile);
      const stagingDir = path.join(projectTempDirectory(context.projectId), "skill-imports");
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingFile = path.join(stagingDir, `${newId("imp")}${path.extname(fullVideoPath) || ".mp4"}`);

      let asset: MediaAsset;
      try {
        await fs.copyFile(fullVideoPath, stagingFile);
        asset = await importMediaFile(context.projectId, stagingFile, `${skill.id}.mp4`);
      } catch (e) {
        await fs.rm(stagingFile, { force: true }).catch(() => {});
        const err = e as Error;
        warnings.push(`No se pudo importar video de skill ${skill.id}: ${err.message}`);
        continue;
      }
      importedFiles.push(path.join(projectDir, asset.file));

      const clipFrames =
        asset.durationUs > 0
          ? Math.max(1, Math.round((asset.durationUs / 1_000_000) * fps))
          : clip.durationFrames;
      insertedFrames += clipFrames;

      const mediaClip = makeMediaClip(updatedProject, asset, {
        startFrame: clip.startFrame + startFrame,
        durationFrames: clipFrames,
        createdBy: "agent",
      });

      const addResult = addClip(updatedProject, videoTrack.id, mediaClip);
      if (!addResult.ok) throw new HttpError(422, addResult.error, "skill_clip_insert_failed");
      updatedProject = addResult.project;
    }

    return {
      summary: `Skill "${skill.name}" ejecutada: ${result.clips.length} clip(s) generado(s) en ${(insertedFrames / fps).toFixed(1)}s.`,
      project: updatedProject,
      data: {
        skillId: skill.id,
        skillName: skill.name,
        clips: result.clips.map((c) => ({ id: c.id, durationFrames: c.durationFrames })),
        outputFiles: importedFiles.length > 0 ? importedFiles : result.outputFiles,
        warnings: result.warnings,
      },
    };
  },
};

export const listSkillsTool = {
  name: "list_skills",
  description:
    "Lista de forma ligera (carga progresiva) todas las skills disponibles con nombre, versión, descripción, disparadores y dependencias.",
  argsHint: '{ "category"?: string, "query"?: string }',
  risk: "low" as const,
  argsSchema: z.object({
    category: z.string().optional(),
    query: z.string().optional(),
  }),
  execute: async (_context: any, rawArgs: any) => {
    const args = z.object({ category: z.string().optional(), query: z.string().optional() }).parse(rawArgs ?? {});
    await ensureRegistryLoaded();
    let skills = skillRegistry.getAll();
    if (args.category) {
      skills = skills.filter((s) => s.category === args.category);
    }
    if (args.query) {
      const q = args.query.toLowerCase();
      skills = skills.filter(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.triggers.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return {
      status: "verified" as const,
      summary: `${skills.length} skill(s) disponibles (metadatos ligeros; usa get_skill para leer SKILL.md completo).`,
      data: skills.map((s) => ({
        id: s.id,
        name: s.name,
        version: s.version,
        kind: s.kind,
        category: s.category,
        description: s.description,
        triggers: s.triggers,
        dependencies: s.dependencies,
        hasInstructions: Boolean(s.instructionsMarkdown),
        parameters: s.parameters.map((p) => ({
          name: p.name,
          type: p.type,
          label: p.label,
          required: p.required,
          default: p.default,
        })),
      })),
    };
  },
};

export const getSkillTool = {
  name: "get_skill",
  description:
    "Carga completa de una skill (`SKILL.md`, instrucciones paso a paso, dependencias, criterios QA y plantilla si aplica).",
  argsHint: '{ "skillId": "reel-corporativo" }',
  risk: "low" as const,
  argsSchema: z.object({
    skillId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  }),
  execute: async (_context: any, rawArgs: any) => {
    const args = z
      .object({
        skillId: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
      })
      .parse(rawArgs);
    const targetId = (args.skillId ?? args.id ?? "").trim();
    if (!targetId) throw new HttpError(422, "Debes indicar skillId o id.", "missing_skill_id");
    await ensureRegistryLoaded();
    const skill = skillRegistry.get(targetId);
    if (!skill) throw new HttpError(404, `Skill no encontrada: ${targetId}`, "skill_not_found");

    let templatePreview = "";
    if (skill.kind === "template") {
      try {
        const templatePath = path.join(getSkillsDir(), skill.id, skill.template);
        templatePreview = await fs.readFile(templatePath, "utf-8");
      } catch {
        templatePreview = "";
      }
    }

    let skillMarkdown = "";
    try {
      skillMarkdown = await fs.readFile(path.join(getSkillsDir(), skill.id, "SKILL.md"), "utf-8");
    } catch {
      skillMarkdown = skill.instructionsMarkdown ?? "";
    }

    return {
      status: "verified" as const,
      summary: `Skill "${skill.name}" v${skill.version} (${skill.kind}): cargadas instrucciones completas.`,
      data: {
        ...skill,
        instructionsMarkdown: skill.instructionsMarkdown || skillMarkdown,
        skillMarkdown,
        templatePreview,
      },
    };
  },
};

const createSkillInputSchema = z.object({
  id: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(2).max(80),
  description: z.string().min(4).max(1000),
  version: z.string().default("1.0.0"),
  category: z.string().default("recipe"),
  kind: z.enum(["recipe", "template"]).default("recipe"),
  triggers: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  overwrite: z.boolean().optional(),
  instructionsMarkdown: z.string().min(10).optional(),
  instructions: z.string().min(10).optional(),
  template: z.string().optional(),
  compose: z.string().optional(),
  parameters: z.array(z.any()).optional(),
});

export const createSkillTool = {
  name: "create_skill",
  description:
    "Crea una nueva skill versionada en Markdown (`SKILL.md` + `skill.json`) y la registra en el catálogo para futuras peticiones.",
  argsHint:
    '{ "id": "mi-reel-saas", "name": "Reel SaaS", "description": "...", "version": "1.0.0", "triggers": ["saas"], "dependencies": ["execute_custom_motion", "qa_report"], "instructionsMarkdown": "# Flujo..." }',
  risk: "medium" as const,
  argsSchema: createSkillInputSchema,
  execute: async (_context: any, rawArgs: any) => {
    const args = createSkillInputSchema.parse(rawArgs);
    const skillDir = path.join(getSkillsDir(), args.id);

    if (!args.overwrite) {
      try {
        await fs.access(skillDir);
        throw new HttpError(409, `La skill "${args.id}" ya existe.`, "skill_exists");
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
    }

    const body = (args.instructionsMarkdown ?? args.instructions ?? `# ${args.name}\n\n${args.description}`).trim();
    const manifest = skillSchema.parse({
      id: args.id,
      name: args.name,
      description: args.description,
      version: args.version,
      category: args.category,
      kind: args.kind,
      triggers: args.triggers.length > 0 ? args.triggers : [args.id],
      dependencies: args.dependencies,
      tags: args.tags.length > 0 ? args.tags : [args.id],
      instructionsMarkdown: body,
      parameters: args.parameters ?? [],
      template: args.template ?? "template.tsx",
      compose: args.compose ?? "compose.mjs",
    });

    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });

    const mdContent = formatSkillMarkdown({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      category: manifest.category,
      triggers: manifest.triggers,
      dependencies: manifest.dependencies,
      body,
    });

    await Promise.all([
      fs.writeFile(path.join(skillDir, "SKILL.md"), mdContent, "utf-8"),
      fs.writeFile(path.join(skillDir, "skill.json"), JSON.stringify(manifest, null, 2), "utf-8"),
    ]);

    await skillRegistry.reload();

    return {
      status: "verified" as const,
      summary: `Skill "${manifest.name}" v${manifest.version} creada y registrada en ${skillDir}.`,
      data: { skillId: manifest.id, version: manifest.version, path: skillDir },
    };
  },
};

export const skillTools = [runSkillTool, listSkillsTool, getSkillTool, createSkillTool];
