import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Project } from "../../src/shared/schema";
import { timelineDurationFrames } from "../../src/shared/project";
import { buildSignedDownloadPath } from "../services/downloadTokenService";
import {
  api,
  apiBaseUrl,
  BridgeError,
  buildPublicUrl,
  mcpHttpUrl,
  publicBaseUrl,
  waitForJob,
  type ProjectBundle,
} from "./client";

const aspectValues = ["16:9", "9:16", "1:1", "4:5", "21:9"] as const;
const resolutionValues = [480, 720, 1080, 1440, 2160] as const;
const fpsValues = [24, 25, 30, 50, 60] as const;

function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= 80_000) return text;
  return `${text.slice(0, 80_000)}\n… (respuesta truncada; pide solo lo que necesites)`;
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: jsonText(value) }] };
}

function fail(error: unknown): CallToolResult {
  const message =
    error instanceof BridgeError
      ? `${error.message}${error.code !== "bridge_error" ? ` [${error.code}]` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

function compactProject(bundle: ProjectBundle) {
  const project: Project = bundle.project;
  const durationFrames = timelineDurationFrames(project);
  return {
    id: project.id,
    name: project.name,
    revision: project.revision,
    durationFrames,
    durationSeconds: Number((durationFrames / (project.settings.fps.num / project.settings.fps.den)).toFixed(3)),
    settings: project.settings,
    media: project.media.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      durationUs: asset.durationUs,
      width: asset.width ?? null,
      height: asset.height ?? null,
      hasAudio: Boolean(asset.audioCodec),
      missing: asset.missing ?? false,
    })),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      name: track.name,
      muted: track.muted,
      hidden: track.hidden,
      locked: track.locked,
      volume: track.volume,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        type: clip.type,
        name: clip.name,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        ...(clip.type === "text"
          ? { text: clip.text, role: clip.role }
          : {
              mediaId: clip.mediaId,
              sourceInUs: clip.sourceInUs,
              sourceOutUs: clip.sourceOutUs,
              speed: clip.speed,
              volume: clip.volume,
              opacity: clip.opacity,
            }),
      })),
    })),
    exports: bundle.exports.map((record) => ({
      id: record.id,
      status: record.status,
      fileName: record.settings.fileName,
      verification: record.verification ?? null,
    })),
    lastAgentMessage: bundle.agentMessages.at(-1)
      ? {
          role: bundle.agentMessages.at(-1)!.role,
          text: bundle.agentMessages.at(-1)!.text,
          planId: bundle.agentMessages.at(-1)!.plan?.id ?? null,
        }
      : null,
  };
}

function closest<T extends number>(values: readonly T[], target: number): T {
  return values.reduce((best, item) => (Math.abs(item - target) < Math.abs(best - target) ? item : best), values[0]!);
}

function slugFileName(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/[-.]+$/, "")
    .slice(0, 100);
  return `${base || "oeclip-export"}.mp4`;
}

function cleanProjectTitle(request: string, explicitName?: string): string {
  const manual = explicitName?.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (manual) return manual.slice(0, 72);

  const normalized = request
    .replace(/\r?\n+/g, " · ")
    .replace(/[«"'“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const stopSection =
    normalized.split(/\b(?:estructura obligatoria|audio y subt[ií]tulos|detalles técnicos|requisitos|duraci[oó]n exacta)\b/i)[0] ??
    normalized;
  const cleanedPrefix = stopSection
    .replace(/^(?:crea|genera|edita|produce|haz|arma|prepara|dise[nñ]a)\s+(?:un|una|el|la)\s+/i, "")
    .replace(/\s*[,;:·-]+\s*$/, "")
    .trim();

  const source = cleanedPrefix.length >= 6 ? cleanedPrefix : normalized;
  if (source.length <= 48) return source || "Nuevo montaje Director";
  const cut = source.slice(0, 48);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= 20 ? cut.slice(0, lastSpace) : cut).replace(/[,;:·-]+$/, "").trim() || "Nuevo montaje Director";
}

type ImageContentBlock = { type: "image"; data: string; mimeType: "image/png" };

async function loadImageContentBlocks(
  items: Array<{ filePath?: string; imageUrl?: string }>,
  limit = 6,
): Promise<ImageContentBlock[]> {
  const blocks: ImageContentBlock[] = [];
  for (const item of items.slice(0, limit)) {
    let bytes: Buffer | null = null;
    if (item.filePath) {
      bytes = await fs.readFile(item.filePath).catch(() => null);
    }
    if (!bytes && item.imageUrl) {
      bytes = await api.fetchBinary(item.imageUrl).catch(() => null);
    }
    if (bytes && bytes.byteLength > 64 && bytes.byteLength <= 3 * 1024 * 1024) {
      blocks.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/png",
      });
    }
  }
  return blocks;
}

function formatImageToolResult(
  result: Record<string, unknown>,
  imageBlocks: ImageContentBlock[],
): CallToolResult {
  return {
    content: [
      { type: "text", text: jsonText(result) },
      ...imageBlocks,
    ],
  };
}

function buildInstructions(): string {
  const publicBase = publicBaseUrl();
  const endpoint = mcpHttpUrl();
  return `Servidor MCP oficial de OECLIP, plataforma de creación y edición de vídeo con agente autónomo, motor FFmpeg y Remotion.

FLUJO AUTÓNOMO OBLIGATORIO (no improvisar):
1. Capacidades reales primero: llama a get_capabilities ANTES de prometer voz TTS, transcripción STT, generación de imágenes o concurrencia de render. Si una capacidad falta, dilo con claridad.
2. Skills de carga progresiva: llama a list_skills para ver qué recetas existen (solo nombre/descripción) y LEE con get_skill la skill relevante (p. ej. "reel-corporativo", "subtitulos-dinamicos", "qa-visual") ANTES de editar o generar escenas.
3. Proyecto e ingesta remota: usa list_projects / create_project / get_project. Para subir metraje desde rutas locales usa add_media; desde clientes remotos (Claude web/Cloud Run) usa import_media_from_url({ project_id, url }).
4. Delegación integral o paso a paso:
   - Para encargos completos de creación o edición autónoma (reels, anuncios, lanzamientos, montajes desde cero con locución, música, SFX y subtítulos), usa ask_director({ request, project_id?, autonomy, storyboard?, strict?, quality?, export_on_complete? }).
   - Usa strict: true (o allow_fallback: false) si prefieres fallar explícitamente antes que usar motores de respaldo.
   - Para auditoría detallada paso a paso, consulta get_run_trace({ project_id }).
5. PERCEPCIÓN Y QA OBLIGATORIOS antes de dar por bueno el montaje:
   - Nunca digas "listo" sin mirar lo que produjiste.
   - Ejecuta qa_report, render_frames / contact_sheet e inspect_frame sobre el timeline real (devuelven imágenes PNG reales e imageUrls).
   - Comprueba que TODOS los textos literales entrecomillados y botones CTA del cliente aparecen en pantalla y que NUNCA aparece un nombre interno de clip ("Escena 1 · Gancho", "Clip 1") ni instrucciones del chat dibujadas sobre el vídeo.
   - Corrige si falta copy o hay huecos/solapamientos (máx. 3 ciclos).
6. Exportar y verificar: llama a export_video (devuelve downloadUrl directo firmado sin necesidad de cookies) y luego verify_export.

REGLAS DE HONESTIDAD Y UNIDADES:
- Todas las respuestas devuelven contrato uniforme { ok, status, summary, data, warnings, verification, revision }.
- Si status es "fallback", "unverified" o "failed", NO lo presentes como éxito pleno: informa la causa real y lo que sí/no se logró.
- No inventes IDs ni capacidades. Respeta texto literal entre comillas sin modificarlo.
- URL pública del servicio: ${publicBase}; endpoint MCP HTTP: ${endpoint}.`;
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "oeclip", version: "0.1.0" },
    {
      instructions: buildInstructions(),
      capabilities: { tools: {} },
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "Listar proyectos",
      description:
        "Lista los proyectos de OECLIP con su ID, nombre, duración en fotogramas, número de medios y fecha de actualización. Empieza siempre por aquí si no conoces el project_id.",
      inputSchema: {
        query: z.string().optional().describe("Texto para filtrar por nombre (opcional)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query }) =>
      run(async () => {
        const { projects } = await api.listProjects();
        const needle = query?.trim().toLowerCase();
        const filtered = needle ? projects.filter((item) => item.name.toLowerCase().includes(needle)) : projects;
        return { count: filtered.length, projects: filtered };
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Leer proyecto",
      description:
        "Devuelve el proyecto completo: ajustes, medios, pistas y clips con sus IDs y tiempos, exportaciones y último mensaje del agente. Úsalo antes de editar para conocer IDs reales.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto, por ejemplo prj_e4be890f8dd543cf."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) =>
      run(async () => compactProject(await api.getProject(project_id))),
  );

  server.registerTool(
    "create_project",
    {
      title: "Crear proyecto",
      description: "Crea un proyecto vacío con nombre, relación de aspecto, resolución y FPS opcionales.",
      inputSchema: {
        name: z.string().max(120).optional().describe("Nombre visible del proyecto."),
        aspect: z.enum(aspectValues).optional().describe("Relación de aspecto (por defecto 16:9)."),
        height: z.union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional(),
        fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const bundle = await api.createProject(args);
        return compactProject(bundle);
      }),
  );

  server.registerTool(
    "add_media",
    {
      title: "Importar archivo local",
      description:
        "Copia un archivo de vídeo, audio o imagen desde una ruta absoluta de este equipo al proyecto indicado. Formatos: MP4, MOV, MKV, WebM, AVI, MP3, WAV, M4A, FLAC, OGG, JPG, PNG, WebP. No modifica el archivo original.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto destino."),
        path: z.string().describe("Ruta absoluta del archivo en este equipo, por ejemplo D:\\\\videos\\\\toma.mp4."),
        name: z.string().optional().describe("Nombre visible alternativo (opcional)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project_id, path, name }) =>
      run(async () => {
        const result = await api.importMedia(project_id, { path, name });
        return {
          imported: result.asset,
          revision: result.revision,
          hint: "Añade el medio a la línea de tiempo con run_tool y la herramienta correspondiente, o pide un plan con plan_edit.",
        };
      }),
  );

  server.registerTool(
    "plan_edit",
    {
      title: "Planificar edición",
      description:
        "Genera un plan de edición revisable a partir de una instrucción en lenguaje natural. NO modifica el proyecto. Usa prefer_local=true para forzar el planificador determinista sin IA. Devuelve steps con tool y args; ejecútalo con apply_edit.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        instruction: z.string().min(1).max(4000).describe("Qué quieres hacer, en español o inglés."),
        media_id: z.string().optional().describe("Limita el trabajo a un medio concreto (med_...)."),
        clip_ids: z.array(z.string()).max(100).optional().describe("Limita el trabajo a estos clips."),
        prefer_local: z.boolean().optional().describe("true para usar el planificador local sin llamar al proveedor de IA."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ project_id, instruction, media_id, clip_ids, prefer_local }) =>
      run(async () => {
        const response = await api.plan(project_id, {
          instruction,
          mediaId: media_id,
          clipIds: clip_ids,
          preferLocal: prefer_local,
        });
        return {
          plan_id: response.plan.id,
          summary: response.plan.summary,
          source: response.plan.source,
          model: response.model ?? null,
          warnings: response.plan.warnings,
          steps: response.plan.steps.map((step) => ({
            tool: step.tool,
            title: step.title,
            reason: step.reason ?? null,
            args: step.args,
            risk: step.risk,
          })),
          next: "Revisa el plan y llama a apply_edit con este plan_id para ejecutarlo.",
        };
      }),
  );

  server.registerTool(
    "apply_edit",
    {
      title: "Ejecutar edición",
      description:
        "Ejecuta un plan existente (plan_id) o planifica y ejecuta una instrucción nueva. Espera al job hasta wait_seconds y devuelve el proyecto actualizado. Si el job sigue en curso, usa get_job.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        plan_id: z.string().optional().describe("Plan ya generado con plan_edit."),
        instruction: z.string().max(4000).optional().describe("Instrucción nueva; se planifica y ejecuta en un paso."),
        wait_seconds: z.number().int().min(1).max(600).optional().describe("Máximo de espera (por defecto 120 s)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ project_id, plan_id, instruction, wait_seconds }) =>
      run(async () => {
        let resolvedPlanId = plan_id;
        let planSummary: string | null = null;
        if (!resolvedPlanId) {
          if (!instruction?.trim()) throw new Error("Indica plan_id o instruction.");
          const response = await api.plan(project_id, { instruction });
          resolvedPlanId = response.plan.id;
          planSummary = response.plan.summary;
        }
        const started = await api.executePlan(project_id, resolvedPlanId);
        const { job, timedOut } = await waitForJob(started.jobId, wait_seconds ?? 120);
        if (job.status === "failed") throw new Error(`La edición falló: ${job.error ?? "error desconocido"}`);
        const bundle = job.status === "done" ? await api.getProject(project_id) : null;
        return {
          plan_id: resolvedPlanId,
          plan_summary: planSummary,
          job,
          timed_out: timedOut,
          project: bundle ? compactProject(bundle) : null,
          next: timedOut ? "El job sigue en curso: consulta get_job con job_id." : "Verifica el resultado y exporta con export_video.",
        };
      }),
  );

  server.registerTool(
    "list_tools",
    {
      title: "Catálogo de herramientas",
      description:
        "Enumera las herramientas de edición de bajo nivel disponibles en run_tool, con su descripción, argumentos y nivel de riesgo.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const { tools } = await api.toolCatalog();
        return { count: tools.length, tools };
      }),
  );

  server.registerTool(
    "run_tool",
    {
      title: "Ejecutar herramienta",
      description:
        "Ejecuta una herramienta tipada del catálogo (list_tools) sobre el proyecto y devuelve un resumen, datos y la nueva revisión. Para vídeos completos desde cero con locución TTS, escenas Remotion, subtítulos y SFX usa tool='execute_autonomous_edit_swarm' con args={ prompt }. Otros ejemplos: execute_custom_motion, trim_clip, split_clip, move_clip, remove_clip, set_clip_speed, add_text_overlay, change_aspect_ratio, detect_silences, detect_scenes, select_highlights, generate_subtitles, render_export, verify_export.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        tool: z.string().describe("Nombre exacto de la herramienta, por ejemplo trim_clip."),
        args: z.record(z.unknown()).optional().describe("Argumentos de la herramienta según list_tools."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ project_id, tool, args }) =>
      run(async () => {
        const result = await api.runTool(project_id, tool, args ?? {});
        return result;
      }),
  );

  server.registerTool(
    "export_video",
    {
      title: "Exportar MP4",
      description:
        "Inicia una exportación FFmpeg real (H.264/AAC) y espera al job. Usa por defecto los ajustes del proyecto. Devuelve el registro, la verificación si terminó y el job. Después puedes llamar a verify_export.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        file_name: z.string().max(120).optional().describe("Nombre del MP4 (por defecto, el del proyecto)."),
        resolution: z.union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional(),
        aspect: z.enum(aspectValues).optional(),
        fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
        quality: z.enum(["draft", "standard", "high"]).optional(),
        encoder: z.enum(["auto", "cpu", "nvidia"]).optional(),
        wait_seconds: z.number().int().min(1).max(1800).optional().describe("Máximo de espera (por defecto 600 s)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project_id, file_name, resolution, aspect, fps, quality, encoder, wait_seconds }) =>
      run(async () => {
        const bundle = await api.getProject(project_id);
        const project = bundle.project;
        const projectFps = Math.round(project.settings.fps.num / project.settings.fps.den);
        const settings = {
          resolution: resolution ?? closest(resolutionValues, project.settings.height),
          aspect: aspect ?? project.settings.aspect,
          fps: fps ?? closest(fpsValues, projectFps),
          quality: quality ?? "standard",
          encoder: encoder ?? "auto",
          fileName: file_name ?? slugFileName(project.name),
        };
        const started = await api.startExport(project_id, settings);
        const { job, timedOut } = await waitForJob(started.job.id, wait_seconds ?? 600);
        let record = started.record;
        if (job.status === "done") {
          const exports = await api.listExports(project_id);
          record = exports.exports.find((item) => item.id === started.record.id) ?? record;
        }
        if (job.status === "failed") throw new Error(`La exportación falló: ${job.error ?? "error desconocido"}`);
        const downloadPath = `/api/projects/${encodeURIComponent(project_id)}/exports/${encodeURIComponent(record.id)}/file`;
        const signedPath = buildSignedDownloadPath({
          kind: "export",
          projectId: project_id,
          exportId: record.id,
          fileName: record.settings.fileName,
          contentType: "video/mp4",
          download: true,
        });
        return {
          export_id: record.id,
          status: record.status,
          job,
          timed_out: timedOut,
          file_name: record.settings.fileName,
          output_file: record.outputFile ?? null,
          verification: record.verification ?? null,
          download_path: downloadPath,
          downloadUrl: buildPublicUrl(signedPath),
          next:
            job.status === "done"
              ? "Verifica el MP4 con verify_export si aún no tiene verificación."
              : "La exportación sigue en curso: consulta get_job.",
        };
      }),
  );

  server.registerTool(
    "verify_export",
    {
      title: "Verificar exportación",
      description:
        "Comprueba con FFprobe que el MP4 exportado existe, tiene vídeo H.264, audio si corresponde y una duración coherente. Devuelve el registro actualizado y enlace directo.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        export_id: z.string().describe("ID de la exportación (exp_...)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, export_id }) =>
      run(async () => {
        const result = await api.verifyExport(project_id, export_id);
        const signedPath = buildSignedDownloadPath({
          kind: "export",
          projectId: project_id,
          exportId: export_id,
          fileName: result.record.settings.fileName,
          contentType: "video/mp4",
          download: true,
        });
        return {
          ...result,
          downloadUrl: buildPublicUrl(signedPath),
        };
      }),
  );

  server.registerTool(
    "list_exports",
    {
      title: "Listar exportaciones",
      description: "Lista las exportaciones del proyecto con estado, nombre de archivo, verificación y URL directa.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) =>
      run(async () => {
        const { exports } = await api.listExports(project_id);
        return {
          count: exports.length,
          exports: exports.map((record) => ({
            id: record.id,
            status: record.status,
            fileName: record.settings.fileName,
            outputFile: record.outputFile ?? null,
            verification: record.verification ?? null,
            downloadUrl:
              record.status === "done" || record.outputFile
                ? buildPublicUrl(
                    buildSignedDownloadPath({
                      kind: "export",
                      projectId: project_id,
                      exportId: record.id,
                      fileName: record.settings.fileName,
                      contentType: "video/mp4",
                      download: true,
                    }),
                  )
                : null,
            error: record.error ?? null,
          })),
        };
      }),
  );

  server.registerTool(
    "list_jobs",
    {
      title: "Listar tareas",
      description: "Lista los jobs activos y recientes del proyecto (exportación, proxy, agente, medios).",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) =>
      run(async () => {
        const { jobs } = await api.listJobs(project_id);
        return { count: jobs.length, jobs };
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Consultar tarea",
      description: "Consulta el estado, progreso, resultado y error de un job por su ID.",
      inputSchema: {
        job_id: z.string().describe("ID del job (job_...)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => run(async () => api.getJob(job_id)),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancelar tarea",
      description: "Solicita cancelar un job en curso (exportación, proxy o agente).",
      inputSchema: {
        job_id: z.string().describe("ID del job (job_...)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ job_id }) => run(async () => api.cancelJob(job_id)),
  );

  server.registerTool(
    "ask_director",
    {
      title: "Agente Director autónomo",
      description:
        "Delega un encargo completo de creación o edición al Agente Director integrado de OECLIP: consulta capacidades y skills, diseña storyboard respetando textos literales sin modificarlos, crea checkpoint, construye escenas/audio/subtítulos, inspecciona con qa_report + render_frames + contact_sheet, autocorrige fallos y reporta con honestidad.",
      inputSchema: {
        request: z.string().min(3).max(6000).describe("Encargo completo del cliente en lenguaje natural."),
        project_id: z
          .string()
          .optional()
          .describe("ID del proyecto existente (opcional; si se omite se crea uno nuevo con nombre limpio)."),
        project_name: z
          .string()
          .max(120)
          .optional()
          .describe("Nombre corto limpio del proyecto si se crea uno nuevo."),
        autonomy: z
          .enum(["assisted", "semi", "autonomous"])
          .optional()
          .describe("Modo de autonomía: assisted (solo storyboard), semi o autonomous (por defecto)."),
        export_on_complete: z
          .boolean()
          .optional()
          .describe("Si es true, exporta MP4 y ejecuta verify_export al terminar QA."),
        strict: z
          .boolean()
          .optional()
          .describe("Si es true, equivale a allow_fallback=false: falla explícitamente si falta LLM o QA estricto."),
        allow_fallback: z
          .boolean()
          .optional()
          .describe("Permite motores de respaldo (true por defecto; false exige cumplimiento estricto)."),
        quality: z.enum(["draft", "standard", "high"]).optional().describe("Calidad de exportación si export_on_complete=true."),
        storyboard: z
          .object({
            title: z.string().optional(),
            aspect: z.enum(aspectValues).optional(),
            durationSec: z.number().positive().optional(),
            scenes: z
              .array(
                z.object({
                  startSec: z.number().nonnegative().optional(),
                  durationSec: z.number().positive(),
                  role: z.enum(["hook", "brand", "demo", "close", "custom"]).optional(),
                  visualArchetype: z.string().optional(),
                  literalTexts: z.array(z.string()).optional(),
                  ctaText: z.string().optional(),
                  narration: z.string().optional(),
                  prompt: z.string().optional(),
                  accentColor: z.string().optional(),
                }),
              )
              .min(1),
          })
          .optional()
          .describe("Storyboard JSON estructurado opcional para controlar cada acto sin depender de regex."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ request, project_id, project_name, autonomy, export_on_complete, strict, allow_fallback, quality, storyboard }) =>
      run(async () => {
        let targetProjectId = project_id?.trim();
        if (!targetProjectId) {
          const cleanName = cleanProjectTitle(request, project_name || storyboard?.title);
          const created = await api.createProject({
            name: cleanName,
            aspect: storyboard?.aspect ?? "9:16",
            height: 1080,
            fps: 30,
          });
          targetProjectId = created.project.id;
        }
        return api.askDirector(targetProjectId, {
          request,
          autonomy: autonomy ?? "autonomous",
          exportOnComplete: export_on_complete ?? false,
          strict,
          allowFallback: allow_fallback,
          quality,
          storyboard,
        });
      }),
  );

  server.registerTool(
    "get_capabilities",
    {
      title: "Consultar capacidades reales",
      description:
        "Devuelve qué motores y proveedores están realmente configurados en OECLIP (LLM, TTS, STT, Remotion, concurrencia segura de CPU/memoria, música/SFX y skills disponibles). Llámalo antes de prometer cualquier capacidad.",
      inputSchema: {
        project_id: z.string().optional().describe("ID de proyecto opcional."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) =>
      run(async () => {
        let pid = project_id?.trim();
        if (!pid) {
          const { projects } = await api.listProjects();
          pid = projects[0]?.id;
        }
        if (pid) {
          return api.runTool(pid, "get_capabilities", {});
        }
        const [health, { skills }] = await Promise.all([api.health(), api.listSkills()]);
        return {
          ok: true,
          tool: "get_capabilities",
          status: "verified",
          summary: "Capacidades reales consultadas desde /api/health.",
          data: { ...health, skillsCount: skills.length },
          warnings: [],
        };
      }),
  );

  server.registerTool(
    "list_skills",
    {
      title: "Listar skills disponibles",
      description:
        "Lista de forma ligera (id, name, description, version, triggers, dependencies) las skills disponibles en OECLIP (progressive disclosure). Lee la skill elegida con get_skill antes de editar.",
      inputSchema: {
        project_id: z.string().optional().describe("ID de proyecto opcional."),
        category: z.string().optional().describe("Filtrar por categoría."),
        kind: z.enum(["recipe", "motion", "effect", "tool", "template"]).optional().describe("Filtrar por tipo de skill."),
        tag: z.string().optional().describe("Filtrar por etiqueta."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, category, kind, tag }) =>
      run(async () => {
        let pid = project_id?.trim();
        if (!pid) {
          const { projects } = await api.listProjects();
          pid = projects[0]?.id;
        }
        if (pid) {
          return api.runTool(pid, "list_skills", { category, kind, tag });
        }
        const { skills } = await api.listSkills();
        return { ok: true, tool: "list_skills", status: "verified", count: skills.length, skills };
      }),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Leer SKILL.md completo",
      description:
        "Carga bajo demanda las instrucciones completas (SKILL.md), dependencias y criterios QA de una skill antes de ejecutar herramientas de edición.",
      inputSchema: {
        id: z.string().describe("ID/slug de la skill, p. ej. reel-corporativo o qa-visual."),
        project_id: z.string().optional().describe("ID de proyecto opcional."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, project_id }) =>
      run(async () => {
        let pid = project_id?.trim();
        if (!pid) {
          const { projects } = await api.listProjects();
          pid = projects[0]?.id;
        }
        if (!pid) throw new Error("Crea o abre al menos un proyecto para inspeccionar una skill vía tool.");
        return api.runTool(pid, "get_skill", { id });
      }),
  );

  server.registerTool(
    "create_skill",
    {
      title: "Crear o actualizar skill",
      description:
        "Guarda un flujo verificado y reutilizable como nueva carpeta SKILL.md versionada y recarga el registro de skills.",
      inputSchema: {
        id: z.string().describe("Slug kebab-case único (p. ej. mi-receta-vertical)."),
        name: z.string().describe("Nombre legible de la skill."),
        description: z.string().describe("Cuándo usarla y qué logra."),
        instructionsMarkdown: z.string().describe("Cuerpo Markdown paso a paso con criterios QA."),
        version: z.string().optional().describe("Versión semántica (por defecto 1.0.0)."),
        kind: z.enum(["recipe", "motion", "effect", "tool"]).optional(),
        category: z.string().optional(),
        triggers: z.array(z.string()).optional(),
        dependencies: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        overwrite: z.boolean().optional(),
        project_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, ...skillArgs }) =>
      run(async () => {
        let pid = project_id?.trim();
        if (!pid) {
          const { projects } = await api.listProjects();
          pid = projects[0]?.id;
        }
        if (!pid) {
          const created = await api.createProject({ name: "Workspace Skills" });
          pid = created.project.id;
        }
        return api.runTool(pid, "create_skill", skillArgs);
      }),
  );

  server.registerTool(
    "qa_report",
    {
      title: "Informe automático de calidad (QA)",
      description:
        "Audita duración, aspecto, textos literales presentes, ausencia de placeholders internos ('Escena 1 · Gancho'), zonas seguras, contrastes y audio antes de exportar.",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        expected_literals: z.array(z.string()).optional().describe("Textos literales exactos que deben aparecer."),
        expected_prompt: z.string().optional().describe("Prompt original del encargo para extraer copy esperado."),
        target_duration_sec: z.number().positive().optional().describe("Duración esperada en segundos."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, expected_literals, expected_prompt, target_duration_sec }) =>
      run(async () =>
        api.runTool(project_id, "qa_report", {
          expectedLiterals: expected_literals,
          expectedPrompt: expected_prompt,
          targetDurationSec: target_duration_sec,
        }),
      ),
  );

  server.registerTool(
    "import_media_from_url",
    {
      title: "Importar medio desde URL",
      description:
        "Descarga de forma segura un archivo de vídeo, audio o imagen desde una URL HTTP/HTTPS pública directamente al proyecto (ideal cuando el cliente MCP es remoto).",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto destino."),
        url: z.string().url().describe("URL pública HTTP/HTTPS del archivo multimedia."),
        name: z.string().max(255).optional().describe("Nombre visible alternativo (opcional)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ project_id, url, name }) =>
      run(async () => api.runTool(project_id, "import_media_from_url", { url, name })),
  );

  server.registerTool(
    "get_run_trace",
    {
      title: "Trazabilidad de ejecución del Director",
      description:
        "Devuelve la traza estructurada de la última ejecución del Director (fases, modelo/fallback de IA, TTS, concurrencia, duración de render, bitrate y chequeos QA).",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) =>
      run(async () => api.runTool(project_id, "get_run_trace", {})),
  );

  server.registerTool(
    "render_frames",
    {
      title: "Renderizar fotogramas del timeline",
      description:
        "Genera imágenes PNG reales del timeline en los tiempos indicados para inspeccionar visualmente el resultado antes de exportar (devuelve bloques nativos image/png + imageUrls).",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        times: z.array(z.number().nonnegative()).optional().describe("Lista de tiempos en segundos."),
        every: z.number().positive().optional().describe("Intervalo en segundos si no se pasa times."),
        scale: z.number().min(0.1).max(1).optional().describe("Escala de renderizado (p. ej. 0.45)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, times, every, scale }) => {
      try {
        const res = await api.runTool(project_id, "render_frames", { times, every, scale });
        const data = (res.data ?? {}) as {
          frames?: Array<{ path?: string; relPath?: string; fileName?: string; imageUrl?: string; time?: number }>;
        };
        const frames = Array.isArray(data.frames) ? data.frames : [];
        const enrichedFrames = frames.map((frame) => {
          const urlPath = frame.imageUrl
            ? frame.imageUrl
            : frame.relPath
              ? buildSignedDownloadPath({
                  kind: "file",
                  projectId: project_id,
                  relPath: frame.relPath,
                  fileName: frame.fileName || `frame-${frame.time ?? 0}.png`,
                  contentType: "image/png",
                  download: false,
                })
              : undefined;
          return {
            ...frame,
            imageUrl: urlPath ? buildPublicUrl(urlPath) : undefined,
          };
        });
        const imageBlocks = await loadImageContentBlocks(
          enrichedFrames.map((f) => ({ filePath: f.path, imageUrl: f.imageUrl })),
          6,
        );
        return formatImageToolResult(
          {
            ...res,
            data: {
              ...data,
              frames: enrichedFrames.map(({ path: _omit, ...rest }) => rest),
            },
          },
          imageBlocks,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "contact_sheet",
    {
      title: "Generar hoja de contactos",
      description:
        "Crea una cuadrícula visual (contact sheet PNG) del timeline completo con marca de tiempo para revisar ritmo, escenas y continuidad (devuelve imagen PNG nativa + imageUrl).",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        every: z.number().positive().optional().describe("Segundos entre capturas."),
        columns: z.number().int().min(1).max(8).optional().describe("Columnas de la hoja de contactos."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, every, columns }) => {
      try {
        const res = await api.runTool(project_id, "contact_sheet", { every, columns });
        const data = (res.data ?? {}) as {
          path?: string;
          relPath?: string;
          imageUrl?: string;
        };
        const urlPath = data.imageUrl
          ? data.imageUrl
          : data.relPath
            ? buildSignedDownloadPath({
                kind: "file",
                projectId: project_id,
                relPath: data.relPath,
                fileName: "contact-sheet.png",
                contentType: "image/png",
                download: false,
              })
            : undefined;
        const fullUrl = urlPath ? buildPublicUrl(urlPath) : undefined;
        const imageBlocks = await loadImageContentBlocks([{ filePath: data.path, imageUrl: fullUrl }], 1);
        return formatImageToolResult(
          {
            ...res,
            data: {
              ...data,
              imageUrl: fullUrl,
            },
          },
          imageBlocks,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "inspect_frame",
    {
      title: "Inspeccionar fotograma puntual",
      description:
        "Renderiza un fotograma exacto y devuelve la imagen PNG junto con los elementos detectados en ese instante (clips activos, textos visibles, contraste y alertas).",
      inputSchema: {
        project_id: z.string().describe("ID del proyecto."),
        time: z.number().nonnegative().describe("Instante en segundos a inspeccionar."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, time }) => {
      try {
        const res = await api.runTool(project_id, "inspect_frame", { time });
        const data = (res.data ?? {}) as {
          frame?: { path?: string; relPath?: string; fileName?: string; imageUrl?: string; time?: number };
        };
        const frame = data.frame;
        const urlPath = frame?.imageUrl
          ? frame.imageUrl
          : frame?.relPath
            ? buildSignedDownloadPath({
                kind: "file",
                projectId: project_id,
                relPath: frame.relPath,
                fileName: frame.fileName || `inspect-${time}.png`,
                contentType: "image/png",
                download: false,
              })
            : undefined;
        const fullUrl = urlPath ? buildPublicUrl(urlPath) : undefined;
        const imageBlocks = await loadImageContentBlocks([{ filePath: frame?.path, imageUrl: fullUrl }], 1);
        return formatImageToolResult(
          {
            ...res,
            data: {
              ...data,
              frame: frame ? { ...frame, imageUrl: fullUrl } : undefined,
              imageUrl: fullUrl,
            },
          },
          imageBlocks,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_ai_status",
    {
      title: "Estado de IA",
      description:
        "Indica si hay proveedor de IA configurado, modelo activo, si hay transcripción disponible y las URLs de la API y de MCP.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const status = await api.aiStatus();
        return {
          ...status,
          apiUrl: apiBaseUrl(),
          publicUrl: publicBaseUrl(),
          mcpHttpUrl: mcpHttpUrl(),
          note: "La clave nunca sale del servidor. La transcripción depende del proveedor (OpenAI/Groq o Whisper local).",
        };
      }),
  );

  return server;
}

export { cleanProjectTitle, compactProject };
