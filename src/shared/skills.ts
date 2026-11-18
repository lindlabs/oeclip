import { z } from "zod";

/**
 * Esquema y registro progresivo de Skills de OECLIP.
 * Soporta tanto plantillas renderizables (`skill.json` + TSX/JS) como
 * recetas/guías versionadas en Markdown (`SKILL.md` con frontmatter YAML y carga progresiva).
 */

export const skillParameterSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "color", "select", "array", "object"]),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean().default(true),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

export const skillCategorySchema = z.enum([
  "mockup",
  "data-viz",
  "ui",
  "transition",
  "title",
  "lower-third",
  "social",
  "recipe",
  "editorial",
  "audio",
  "qa",
  "export",
  "localization",
  "custom",
]);

export const skillSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  description: z.string().max(1000),
  category: skillCategorySchema.catch("recipe").default("recipe"),
  version: z.string().default("1.0.0"),
  kind: z.enum(["template", "recipe"]).default("template"),
  author: z.string().optional(),
  tags: z.array(z.string()).default([]),
  triggers: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  instructionsMarkdown: z.string().optional(),

  // Parámetros que pide la skill
  parameters: z.array(skillParameterSchema).default([]),

  // Configuración de render (para skills con plantilla)
  render: z
    .object({
      width: z.number().int().positive().default(1080),
      height: z.number().int().positive().default(1920),
      fps: z.number().int().positive().default(60),
      duration: z.number().positive().default(5),
      engine: z.enum(["remotion", "html-gsap", "ffmpeg"]).default("remotion"),
      audio: z.boolean().default(false),
    })
    .default({}),

  assets: z
    .object({
      fonts: z.array(z.string()).default([]),
      images: z.array(z.string()).default([]),
      audio: z.array(z.string()).default([]),
      scripts: z.array(z.string()).default([]),
    })
    .default({}),

  template: z.string().default("template.tsx"),
  compose: z.string().default("compose.mjs"),
});

export type Skill = z.infer<typeof skillSchema>;
export type SkillParameter = z.infer<typeof skillParameterSchema>;

export interface SkillExecutionResult {
  success: boolean;
  clips: Array<{
    id: string;
    type: "video" | "image" | "text";
    startFrame: number;
    durationFrames: number;
    trackKind: "video" | "text";
    props: Record<string, unknown>;
    skillId: string;
    skillParams: Record<string, unknown>;
  }>;
  outputFiles: string[];
  warnings: string[];
  durationFrames: number;
}

export interface SkillContext {
  projectId: string;
  project: any;
  parameters: Record<string, unknown>;
  selection?: { clipIds?: string[]; mediaId?: string };
  onProgress?: (ratio: number, message: string) => void;
  signal?: AbortSignal;
}

/** Parsea frontmatter YAML básico + cuerpo Markdown desde `SKILL.md`. */
export function parseSkillMarkdown(
  markdown: string,
  fallbackId: string,
): {
  meta: Record<string, unknown>;
  body: string;
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { meta: { id: fallbackId, name: fallbackId }, body: normalized.trim() };
  }

  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const meta: Record<string, unknown> = { id: fallbackId };
  let currentListKey: string | null = null;

  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listItemMatch = line.match(/^\s*-\s+(.+)$/);
    if (listItemMatch && currentListKey) {
      const existing = Array.isArray(meta[currentListKey]) ? (meta[currentListKey] as string[]) : [];
      existing.push(listItemMatch[1]!.trim().replace(/^["']|["']$/g, ""));
      meta[currentListKey] = existing;
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1]!.trim();
    const rawVal = (kvMatch[2] ?? "").trim();

    if (!rawVal) {
      currentListKey = key;
      if (!Array.isArray(meta[key])) meta[key] = [];
      continue;
    }

    currentListKey = null;
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      meta[key] = rawVal
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      meta[key] = rawVal.replace(/^["']|["']$/g, "");
    }
  }

  if (!meta.name) meta.name = fallbackId;
  return { meta, body };
}

/** Formatea una skill en `SKILL.md` con frontmatter YAML versionado. */
export function formatSkillMarkdown(skill: {
  id: string;
  name: string;
  description: string;
  version?: string;
  category?: string;
  triggers?: string[];
  dependencies?: string[];
  body: string;
}): string {
  const lines = [
    "---",
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    `version: ${JSON.stringify(skill.version ?? "1.0.0")}`,
    `category: ${skill.category ?? "recipe"}`,
    `triggers: [${(skill.triggers ?? []).map((t) => JSON.stringify(t)).join(", ")}]`,
    `dependencies: [${(skill.dependencies ?? []).map((d) => JSON.stringify(d)).join(", ")}]`,
    "---",
    "",
    skill.body.trim(),
    "",
  ];
  return lines.join("\n");
}

/**
 * Registro global de skills (con soporte de carga progresiva de `SKILL.md` + `skill.json`).
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async loadAll(): Promise<void> {
    const fs = await import("node:fs/promises");

    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          await this.loadSkill(entry.name);
        }
      }
    } catch (error) {
      console.warn("[SkillRegistry] No se pudo cargar skills:", error);
    }
  }

  async reload(): Promise<void> {
    this.skills.clear();
    await this.loadAll();
  }

  private async loadSkill(skillId: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const skillDir = path.join(this.skillsDir, skillId);
    const manifestPath = path.join(skillDir, "skill.json");
    const skillMdPath = path.join(skillDir, "SKILL.md");

    let manifestObj: Record<string, unknown> | null = null;
    try {
      const manifestContent = await fs.readFile(manifestPath, "utf-8");
      manifestObj = JSON.parse(manifestContent) as Record<string, unknown>;
    } catch {
      manifestObj = null;
    }

    let mdMeta: Record<string, unknown> | null = null;
    let mdBody: string | undefined;
    try {
      const mdContent = await fs.readFile(skillMdPath, "utf-8");
      const parsed = parseSkillMarkdown(mdContent, skillId);
      mdMeta = parsed.meta;
      mdBody = parsed.body;
    } catch {
      mdMeta = null;
    }

    if (!manifestObj && !mdMeta) return;

    try {
      const merged = manifestObj
        ? {
            ...manifestObj,
            ...(mdMeta?.version ? { version: mdMeta.version } : {}),
            ...(Array.isArray(mdMeta?.dependencies) ? { dependencies: mdMeta.dependencies } : {}),
            ...(mdBody ? { instructionsMarkdown: mdBody } : {}),
            kind: manifestObj.kind ?? "template",
          }
        : {
            id: skillId,
            name: String(mdMeta?.name || skillId),
            description: String(mdMeta?.description || `Receta y guía para ${skillId}`),
            category: skillCategorySchema.safeParse(mdMeta?.category).success
              ? mdMeta?.category
              : "recipe",
            version: String(mdMeta?.version || "1.0.0"),
            kind: "recipe",
            triggers: Array.isArray(mdMeta?.triggers) ? mdMeta.triggers : [skillId],
            dependencies: Array.isArray(mdMeta?.dependencies) ? mdMeta.dependencies : [],
            tags: Array.isArray(mdMeta?.tags) ? mdMeta.tags : [skillId],
            instructionsMarkdown: mdBody ?? "",
            parameters: [],
          };

      const skill = skillSchema.parse(merged);
      this.skills.set(skillId, skill);
    } catch (error) {
      console.warn(`[SkillRegistry] Error cargando skill ${skillId}:`, error);
    }
  }

  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  list(): Skill[] {
    return this.getAll();
  }

  findByTrigger(trigger: string): Skill | undefined {
    const normalized = trigger.toLowerCase();
    return Array.from(this.skills.values()).find((skill) =>
      skill.triggers.some((t) => normalized.includes(t.toLowerCase())),
    );
  }

  findByCategory(category: Skill["category"]): Skill[] {
    return Array.from(this.skills.values()).filter((s) => s.category === category);
  }
}

export function validateSkillParams(
  skill: Skill,
  params: Record<string, unknown>,
): { ok: boolean; errors: string[]; validated: Record<string, unknown> } {
  const errors: string[] = [];
  const validated: Record<string, unknown> = {};

  for (const param of skill.parameters) {
    const value = params[param.name];

    if (param.required && (value === undefined || value === null || value === "")) {
      errors.push(`Parámetro requerido faltante: ${param.name} (${param.label})`);
      continue;
    }

    if (value === undefined || value === null || value === "") {
      if (param.default !== undefined) {
        validated[param.name] = param.default;
      }
      continue;
    }

    switch (param.type) {
      case "number":
        if (typeof value !== "number") {
          const parsed = Number(value);
          if (isNaN(parsed)) {
            errors.push(`${param.name} debe ser un número`);
          } else {
            validated[param.name] = parsed;
          }
        } else {
          if (param.min !== undefined && value < param.min) errors.push(`${param.name} debe ser >= ${param.min}`);
          if (param.max !== undefined && value > param.max) errors.push(`${param.name} debe ser <= ${param.max}`);
          validated[param.name] = value;
        }
        break;
      case "boolean":
        validated[param.name] = Boolean(value);
        break;
      case "color":
        if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
          validated[param.name] = value;
        } else {
          errors.push(`${param.name} debe ser un color hex (#RRGGBB)`);
        }
        break;
      case "select":
        if (param.options && !param.options.includes(value as string)) {
          errors.push(`${param.name} debe ser uno de: ${param.options.join(", ")}`);
        } else {
          validated[param.name] = value;
        }
        break;
      case "array":
        if (Array.isArray(value)) validated[param.name] = value;
        else errors.push(`${param.name} debe ser un array`);
        break;
      case "object":
        if (typeof value === "object" && value !== null) validated[param.name] = value;
        else errors.push(`${param.name} debe ser un objeto`);
        break;
      default:
        validated[param.name] = value;
    }
  }

  return { ok: errors.length === 0, errors, validated };
}
