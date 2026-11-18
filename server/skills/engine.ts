import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { bundle as remotionBundle } from "@remotion/bundler";
import { renderFrames, ensureBrowser } from "@remotion/renderer";
import { Skill, SkillContext, SkillExecutionResult, validateSkillParams } from "../../src/shared/skills";
import { projectDirectory, projectTempDirectory, projectStore } from "../projects/store";
import { newId } from "../../src/shared/time";
import { runProcess, runFfmpeg } from "../media/process";
import { getTool } from "../agent/tools";
import { buildExport } from "../media/export";
import { selectEncoder } from "../system";
import { timelineDurationFrames } from "../../src/shared/project";
import { framesToSeconds } from "../../src/shared/time";
import type { ExportSettings } from "../../src/shared/schema";
import { filterScriptOption } from "../system";

import { getSkillsDir } from "./registry";
import { resolveSafeRemotionConcurrency } from "../media/remotion";

async function copySkillAssets(skill: Skill, fromDir: string, toDir: string): Promise<void> {
  const assetsDir = path.join(toDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  for (const font of skill.assets.fonts) {
    await fs.copyFile(path.join(fromDir, font), path.join(assetsDir, font)).catch(() => {});
  }
  for (const img of skill.assets.images) {
    await fs.copyFile(path.join(fromDir, img), path.join(assetsDir, img)).catch(() => {});
  }
  for (const aud of skill.assets.audio) {
    await fs.copyFile(path.join(fromDir, aud), path.join(assetsDir, aud)).catch(() => {});
  }
}

async function loadComposeFunction(skill: Skill, skillDir: string): Promise<(params: any, meta: any) => any> {
  const composePath = path.join(skillDir, skill.compose);
  const code = await fs.readFile(composePath, "utf-8");
  const fn = new Function("params", "meta", code + "\nreturn compose(params, meta);");
  return fn as (params: any, meta: any) => any;
}

async function framesToVideo(
  framesDir: string,
  outputPath: string,
  fps: number,
  width: number,
  height: number
): Promise<void> {
  const result = await runProcess("ffmpeg", [
    "-y",
    "-framerate", String(fps),
    "-i", path.join(framesDir, "frame-%04d.png"),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "-r", String(fps),
    outputPath
  ], { timeoutMs: 300_000 });

  if (result.code !== 0) {
    throw new Error(`FFmpeg error: ${result.stderr}`);
  }
}

/**
 * Reemplaza placeholders {{key}} en strings, objetos y arrays
 * Soporta placeholders anidados como {{obj.nested.key}}
 */
// function replacePlaceholders(templateProps: any, value: any): any {
//   if (typeof value === "string") {
//     const fullMatch = value.match(/^\{\{([\w.]+)\}\}$/);
//     if (fullMatch && fullMatch[1]) {
//       const key = fullMatch[1];
//       const keys = key.split(".");
//       let resolvedValue: any = templateProps;
//       for (const k of keys) {
//         resolvedValue = resolvedValue?.[k];
//         if (resolvedValue === undefined) {
//           return undefined;
//         }
//       }
//       return resolvedValue;
//     }
//     
//     return value.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
//       const keys = key.split(".");
//       let resolvedValue: any = templateProps;
//       for (const k of keys) {
//         resolvedValue = resolvedValue?.[k];
//         if (resolvedValue === undefined) return match;
//       }
//       if (typeof resolvedValue === "object" && resolvedValue !== null) {
//         return match;
//       }
//       return String(resolvedValue);
//     });
//   } else if (typeof value === "object" && value !== null) {
//     if (Array.isArray(value)) {
//       return value.map(v => replacePlaceholders(templateProps, v));
//     } else {
//       const result: Record<string, any> = {};
//       for (const [k, v] of Object.entries(value)) {
//         result[k] = replacePlaceholders(templateProps, v);
//       }
//       return result;
//     }
//   }
//   return value;
// }

/**
 * Renderiza el proyecto a un archivo de video usando FFmpeg
 * Se usa para plantillas basadas en herramientas (create_motion_graphic, etc.)
 */
async function exportProjectToVideo(
  projectId: string,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  duration: number
): Promise<void> {
  console.log(`[SkillEngine] Exporting project ${projectId} to video: ${outputPath}`);
  
  const { projectStore } = await import("../projects/store");
  const { startExport } = await import("../services/exportService");
  const { exportSettingsSchema } = await import("../../src/shared/schema");
  const { projectDirectory, projectExportDirectory, projectTempDirectory } = await import("../projects/store");
  const { verifyVideoFile } = await import("../media/probe");
  const fs = await import("node:fs/promises");
  
  const bundle = await projectStore.get(projectId);
  if (!bundle || !bundle.project) {
    throw new Error(`Project ${projectId} not found`);
  }
  const project = bundle.project;

  {
    // Calcular aspect ratio válido según schema
    const aspectRatio = width / height;
    let aspect: "16:9" | "9:16" | "1:1" | "4:5" | "21:9" = "16:9";
    if (Math.abs(aspectRatio - 16/9) < 0.02) aspect = "16:9";
    else if (Math.abs(aspectRatio - 9/16) < 0.02) aspect = "9:16";
    else if (Math.abs(aspectRatio - 1) < 0.02) aspect = "1:1";
    else if (Math.abs(aspectRatio - 4/5) < 0.02) aspect = "4:5";
    else if (Math.abs(aspectRatio - 21/9) < 0.02) aspect = "21:9";
    
    // Calcular resolución válida (lado corto: el schema la interpreta como alto en 16:9 y ancho en vertical)
    const validResolutions = [480, 720, 1080, 1440, 2160] as const;
    const requestedShortSide = Math.min(width, height);
    let resolution: 480 | 720 | 1080 | 1440 | 2160 = 1080;
    for (const r of validResolutions) {
      if (Math.abs(requestedShortSide - r) < Math.abs(requestedShortSide - resolution)) {
        resolution = r;
      }
    }
    
    // Calcular FPS válido
    const validFps = [24, 25, 30, 50, 60] as const;
    let exportFps: 24 | 25 | 30 | 50 | 60 = 30;
    for (const f of validFps) {
      if (Math.abs(fps - f) < Math.abs(fps - exportFps)) {
        exportFps = f;
      }
    }
    
    const exportSettings = {
      aspect,
      resolution,
      fps: exportFps,
      quality: "standard" as "draft" | "standard" | "high",
      encoder: "auto" as "auto" | "cpu" | "nvidia",
      engine: "ffmpeg" as "ffmpeg" | "remotion",
      fileName: path.basename(outputPath),
    };
    
    const { record: exportRecordResult } = await startExport(projectId, exportSettings);
    console.log(`[SkillEngine] Export started: ${exportRecordResult.id}`);
    
    // Esperar a que termine la exportación (polling)
    let attempts = 0;
    const maxAttempts = 300; // 5 minutos máximo
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      
      const bundle = await projectStore.get(projectId);
      const exportRecord = bundle.exports.find(e => e.id === exportRecordResult.id);
      if (!exportRecord) continue;
      
      if (exportRecord.status === "done") {
        if (!exportRecord.outputFile) {
          throw new Error("La exportación terminó sin archivo de salida registrado.");
        }
        console.log(`[SkillEngine] Export completed: ${exportRecord.outputFile}`);
        // outputFile es relativo a la carpeta del proyecto (ej: "exports/video.mp4")
        const exportFile = path.isAbsolute(exportRecord.outputFile)
          ? exportRecord.outputFile
          : path.join(projectDirectory(projectId), exportRecord.outputFile);
        const exists = await fs.stat(exportFile).then((s) => s.size > 0).catch(() => false);
        if (!exists) {
          throw new Error(`El archivo exportado no existe o está vacío: ${exportFile}`);
        }
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.copyFile(exportFile, outputPath);
        const copied = await fs.stat(outputPath).catch(() => null);
        if (!copied || copied.size === 0) {
          throw new Error(`No se pudo copiar el video exportado a ${outputPath}`);
        }
        console.log(`[SkillEngine] Video copied to ${outputPath} (${copied.size} bytes)`);
        return;
      } else if (exportRecord.status === "failed" || exportRecord.status === "cancelled") {
        throw new Error(`Export failed: ${exportRecord.error || "Unknown error"}`);
      }
      
      if (attempts % 10 === 0) {
        console.log(`[SkillEngine] Export progress: ${exportRecord.progress * 100}%`);
      }
    }
    
    throw new Error("Export timeout");
  }
}

/**
 * Renderiza el proyecto a un archivo de video usando FFmpeg
 * Se usa para plantillas basadas en herramientas (create_motion_graphic, etc.)
 */
async function renderProjectToVideo(
  skill: Skill,
  templateProps: any,
  projectId: string,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  duration: number
): Promise<void> {
  console.log(`[SkillEngine] Rendering project ${projectId} to video: ${outputPath}`);
  
  const projectDir = projectDirectory(projectId);
  const tempDir = path.join(path.dirname(outputPath), "export-temp");
  await fs.mkdir(tempDir, { recursive: true });
  
  const bundle = await projectStore.get(projectId);
  if (!bundle || !bundle.project) {
    throw new Error(`Project ${projectId} not found`);
  }
  const project = bundle.project;
  
  // Verificar si hay clips con gráficos (stat-bars, stat-counter, stat-progress, title-card, shape-accent)
  // Estos requieren Remotion para renderizarse correctamente
  const hasGraphicClips = project.tracks.some(
    (track) =>
      track.kind === "text" &&
      !track.hidden &&
      track.clips.some((clip) => clip.type === "text" && Boolean(clip.graphic))
  );
  
  console.log(`[SkillEngine] hasGraphicClips: ${hasGraphicClips}`);
  
  if (hasGraphicClips) {
    // Usar Remotion para renderizar gráficos
    console.log(`[SkillEngine] Using Remotion for graphic clips...`);
    await renderRemotionSkill(
      skill,
      templateProps,
      outputPath,
      width,
      height,
      fps,
      duration
    );
    return;
  }
  
  // Calcular aspect ratio válido según schema
  const aspectRatio = width / height;
  let aspect: "16:9" | "9:16" | "1:1" | "4:5" | "21:9" = "16:9";
  if (Math.abs(aspectRatio - 16/9) < 0.02) aspect = "16:9";
  else if (Math.abs(aspectRatio - 9/16) < 0.02) aspect = "9:16";
  else if (Math.abs(aspectRatio - 1) < 0.02) aspect = "1:1";
  else if (Math.abs(aspectRatio - 4/5) < 0.02) aspect = "4:5";
  else if (Math.abs(aspectRatio - 21/9) < 0.02) aspect = "21:9";
  
  // Calcular resolución válida (alto)
  const validResolutions = [480, 720, 1080, 1440, 2160] as const;
  let resolution: 480 | 720 | 1080 | 1440 | 2160 = 1080;
  for (const r of validResolutions) {
    if (Math.abs(height - r) < Math.abs(height - resolution)) {
      resolution = r;
    }
  }
  
  // Calcular FPS válido
  const validFps = [24, 25, 30, 50, 60] as const;
  let exportFps: 24 | 25 | 30 | 50 | 60 = 30;
  for (const f of validFps) {
    if (Math.abs(fps - f) < Math.abs(fps - exportFps)) {
      exportFps = f;
    }
  }
  
  // Configurar export settings según el skill
  const exportSettings: ExportSettings = {
    aspect,
    resolution,
    fps: exportFps,
    quality: "standard",
    encoder: "auto",
    engine: "ffmpeg",
    fileName: path.basename(outputPath),
  };
  
  // Seleccionar encoder - force CPU for skill rendering to avoid NVENC issues
  const encoder = "libx264"; // await selectEncoder(exportSettings.encoder);
  
  // Construir export
  const built = await buildExport(project, exportSettings, {
    outputFile: outputPath,
    projectDir,
    tempDir,
    encoder,
  });
  
  // Ejecutar FFmpeg
  console.log(`[SkillEngine] Running FFmpeg to render project...`);
  const result = await runFfmpeg(built.args, {
    durationSeconds: duration,
    timeoutMs: 300_000,
    cwd: tempDir,
  });
  
  if (result.code !== 0) {
    throw new Error(`FFmpeg render error: ${result.stderr}`);
  }
  
  // Limpiar archivos temporales
  await fs.rm(built.filterFile, { force: true }).catch(() => {});
  for (const file of built.textFiles) {
    await fs.rm(file, { force: true }).catch(() => {});
  }
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  
  console.log(`[SkillEngine] Project rendered successfully to ${outputPath}`);
}

/**
 * Renderiza plantilla FFmpeg (drawtext/drawbox) directamente con FFmpeg
 */
async function renderFfmpegTemplate(
  skill: Skill,
  templateProps: any,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  duration: number
): Promise<void> {
  const templatePath = path.join(getSkillsDir(), skill.id, skill.template);
  const templateContent = await fs.readFile(templatePath, "utf-8");
  const template = JSON.parse(templateContent);
  
  const outputDir = path.dirname(outputPath);
  
  // Copiar fuentes al MISMO directorio del video de salida (FFmpeg busca ahí)
  const fontFiles = new Set<string>();
  template.filters.forEach((filter: any) => {
    if (filter.type === "drawtext" && filter.fontfile) {
      fontFiles.add(filter.fontfile);
    }
  });
  for (const fontFile of fontFiles) {
    // fontFile ya incluye "assets/archivo.ttf", buscar en skills/celular/assets/
    const src = path.join(getSkillsDir(), skill.id, fontFile);
    const dest = path.join(outputDir, path.basename(fontFile));
    const copied = await fs.copyFile(src, dest).then(() => true).catch((err) => {
      console.error(`[SkillEngine] Error copiando fuente ${src}: ${err.message}`);
      return false;
    });
    if (!copied) {
      throw new Error(`No se pudo copiar la fuente ${fontFile} para la plantilla FFmpeg.`);
    }
  }
  console.log(`[SkillEngine] ${template.filters.length} filtros FFmpeg, fuentes: ${[...fontFiles].map((f) => path.basename(f)).join(", ")}`);

  // Construir filter_complex con placeholders reemplazados
  const replacePlaceholders = (str: string) => {
    return str.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
      const keys = key.split(".");
      let value: any = templateProps;
      for (const k of keys) {
        value = value?.[k];
        if (value === undefined) return match;
      }
      return String(value);
    });
  };

  const tempFiles: string[] = [];
  const filters: string[] = [];

  for (let index = 0; index < template.filters.length; index += 1) {
    const filter = template.filters[index];

    switch (filter.type) {
      case "drawbox": {
        const x = replacePlaceholders(String(filter.x ?? 0));
        const y = replacePlaceholders(String(filter.y ?? 0));
        const w = replacePlaceholders(String(filter.w ?? 0));
        const h = replacePlaceholders(String(filter.h ?? 0));
        const color = replacePlaceholders(String(filter.color ?? "black"));
        const thickness = filter.thickness || "fill";
        const enable = filter.enable ? replacePlaceholders(String(filter.enable)) : "";
        filters.push(
          `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:thickness=${thickness}${enable ? `:enable='${enable}'` : ""}`
        );
        break;
      }
      case "drawtext": {
        // El texto se escribe en un archivo aparte: evita escapar ':' ',' '\'' etc.
        const text = replacePlaceholders(String(filter.text ?? ""));
        const textFileName = `text-${index}.txt`;
        await fs.writeFile(path.join(outputDir, textFileName), text, "utf-8");
        tempFiles.push(textFileName);

        const x = replacePlaceholders(String(filter.x ?? 0));
        const y = replacePlaceholders(String(filter.y ?? 0));
        const fontsize = filter.fontsize || 24;
        const fontcolor = replacePlaceholders(String(filter.fontcolor || "white"));
        // Usar solo el nombre del archivo (fuentes están en el mismo dir que el video)
        const fontfile = filter.fontfile ? path.basename(filter.fontfile) : "";
        const box = filter.box ? "1" : "0";
        const boxcolor = replacePlaceholders(String(filter.boxcolor || "black"));
        const boxborderw = filter.boxborderw || 0;
        const enable = filter.enable ? replacePlaceholders(String(filter.enable)) : "";
        const fontfileStr = fontfile ? `fontfile='${fontfile}':` : "";
        filters.push(
          `drawtext=textfile='${textFileName}':expansion=none:x=${x}:y=${y}:fontsize=${fontsize}:fontcolor=${fontcolor}:${fontfileStr}box=${box}:boxcolor=${boxcolor}:boxborderw=${boxborderw}${enable ? `:enable='${enable}'` : ""}`
        );
        break;
      }
      default:
        break;
    }
  }

  const filterComplex = filters.join(",");

  // Usar archivo de script para filter_complex largo (evita límite de línea de comandos)
  const filterScriptOptionCmd = await filterScriptOption();
  const filterScriptPath = path.join(outputDir, "filter_complex.txt");
  await fs.writeFile(filterScriptPath, filterComplex, "utf-8");

  try {
    // Render base video (color negro) + overlay filters
    const result = await runProcess("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=black:s=${width}x${height}:d=${duration}:r=${fps}`,
      filterScriptOptionCmd, filterScriptPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-t", String(duration),
      outputPath
    ], { timeoutMs: 300_000, cwd: outputDir });

    if (result.code !== 0) {
      throw new Error(`FFmpeg template error: ${result.stderr}`);
    }
  } finally {
    await fs.rm(filterScriptPath, { force: true }).catch(() => {});
    for (const file of tempFiles) {
      await fs.rm(path.join(outputDir, file), { force: true }).catch(() => {});
    }
  }
}

async function renderRemotionSkill(
  skill: Skill,
  templateProps: any,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  duration: number
): Promise<void> {
  // Find the Remotion entry point (index.tsx or <skill-id>.tsx)
  const skillDir = path.join(getSkillsDir(), skill.id);
  let remotionEntryPoint = skill.template;
  
  // If template is a JSON file (tool-based), look for Remotion component
  if (remotionEntryPoint.endsWith(".json")) {
    // Try index.tsx first
    const indexTsx = path.join(skillDir, "index.tsx");
    if (await fs.access(indexTsx).then(() => true).catch(() => false)) {
      remotionEntryPoint = "index.tsx";
    } else {
      // Try <skill-id>.tsx
      const skillTsx = path.join(skillDir, `${skill.id}.tsx`);
      if (await fs.access(skillTsx).then(() => true).catch(() => false)) {
        remotionEntryPoint = `${skill.id}.tsx`;
      } else {
        // Find any .tsx file
        const files = await fs.readdir(skillDir);
        const tsxFile = files.find(f => f.endsWith(".tsx"));
        if (tsxFile) {
          remotionEntryPoint = tsxFile;
        }
      }
    }
  }
  
  console.log(`[SkillEngine] Remotion entry point: ${remotionEntryPoint}`);
  
  const serveUrl = await remotionBundle({
    entryPoint: path.join(skillDir, remotionEntryPoint),
    publicDir: path.join(skillDir, "assets"),
  });

  if (!process.env.REMOTION_CHROME_EXECUTABLE_PATH) {
    await ensureBrowser();
  }

  const durationFrames = Math.round(duration * fps);
  const framesDir = path.join(path.dirname(outputPath), "frames");
  await fs.mkdir(framesDir, { recursive: true });

  await renderFrames({
    serveUrl,
    composition: {
      id: skill.id,
      width,
      height,
      fps,
      durationInFrames: durationFrames,
      defaultProps: templateProps,
      props: templateProps,
      defaultCodec: null,
      defaultOutName: null,
      defaultVideoImageFormat: null,
      defaultPixelFormat: null,
      defaultProResProfile: null,
      defaultSampleRate: null,
    },
    inputProps: templateProps,
    outputDir: path.join(path.dirname(outputPath), "frames"),
    imageFormat: "png",
    browserExecutable: process.env.REMOTION_CHROME_EXECUTABLE_PATH || undefined,
    concurrency: resolveSafeRemotionConcurrency(4),
    onStart: () => {},
    onFrameUpdate: () => {},
  });

  await framesToVideo(path.join(path.dirname(outputPath), "frames"), outputPath, fps, width, height);
}

// Ejecuta plantillas basadas en herramientas (ej: create_motion_graphic)
async function executeToolBasedTemplate(
  skill: Skill,
  templateProps: any,
  outputVideo: string,
  projectId: string
): Promise<void> {
  const templatePath = path.join(getSkillsDir(), skill.id, skill.template);
  const templateContent = await fs.readFile(templatePath, "utf-8");
  const template = JSON.parse(templateContent);

  if (!Array.isArray(template.tools)) {
    return;
  }

  // Import the tool dynamically
  const { getTool } = await import("../agent/tools");

  for (const toolConfig of template.tools) {
    const toolName = toolConfig.name;
    const tool = getTool(toolName);

    const args: Record<string, any> = {};
    // Resuelve "{{ruta}}" conservando el tipo original (número, array, objeto)
    const resolvePlaceholder = (key: string): unknown => {
      let resolved: any = templateProps;
      for (const part of key.split(".")) {
        resolved = resolved?.[part];
        if (resolved === undefined) return undefined;
      }
      return resolved;
    };
    const applyPlaceholders = (value: unknown): unknown => {
      if (typeof value === "string") {
        const fullMatch = value.match(/^\{\{([\w.]+)\}\}$/);
        if (fullMatch?.[1]) {
          const resolved = resolvePlaceholder(fullMatch[1]);
          return resolved === undefined ? value : resolved;
        }
        return value.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
          const resolved = resolvePlaceholder(key);
          if (resolved === undefined) return match;
          if (typeof resolved === "object" && resolved !== null) return match;
          return String(resolved);
        });
      }
      if (Array.isArray(value)) return value.map(applyPlaceholders);
      if (typeof value === "object" && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value)) {
          result[key] = applyPlaceholders(nested);
        }
        return result;
      }
      return value;
    };

    if (toolConfig.args) {
      for (const [key, value] of Object.entries(toolConfig.args)) {
        args[key] = applyPlaceholders(value);
      }
    }
    
    const { projectStore } = await import("../projects/store");

    // Execute the tool
    console.log(`[SkillEngine] Ejecutando ${toolName}`);
    const bundle = await projectStore.get(projectId);
    if (!bundle || !bundle.project) {
      throw new Error(`Project ${projectId} not found`);
    }
    const result = await tool.execute(
      {
        projectId,
        project: bundle.project,
        signal: new AbortController().signal,
        setProgress: () => {},
      },
      args
    );

    console.log(`[SkillEngine] Tool ${toolName} executed: ${result.summary}`);
    
    // Save the modified project if the tool returned one
    if (result.project) {
      console.log(`[SkillEngine] Saving modified project...`);
      await projectStore.saveTimeline(projectId, result.project, { force: true });
      console.log(`[SkillEngine] Project saved successfully`);
    }
  }
  
  // After all tools executed, render the project to the output video using export service
  console.log(`[SkillEngine] Rendering project to video: ${outputVideo}`);
  await exportProjectToVideo(
    projectId,
    outputVideo,
    skill.render.width,
    skill.render.height,
    skill.render.fps,
    skill.render.duration
  );
  console.log(`[SkillEngine] Video rendered successfully`);
  console.log(`[SkillEngine] executeToolBasedTemplate END`);
}

// Execute a skill with given parameters
export async function executeSkill(
  skill: Skill,
  context: SkillContext
): Promise<SkillExecutionResult> {
  const warnings: string[] = [];
  const outputFiles: string[] = [];
  
  try {
    const { ok, errors, validated } = validateSkillParams(skill, context.parameters);
    if (!ok) {
      return { success: false, clips: [], outputFiles: [], warnings: errors, durationFrames: 0 };
    }

    const projectDir = projectDirectory(context.projectId);
    const tempDir = projectTempDirectory(context.projectId);
    const skillOutputDir = path.join(tempDir, "skills", skill.id, newId("skill"));
    await fs.mkdir(skillOutputDir, { recursive: true });

    const skillAssetsDir = path.join(getSkillsDir(), skill.id);
    await copySkillAssets(skill, skillAssetsDir, skillOutputDir);

    const composeFn = await loadComposeFunction(skill, skillAssetsDir);
    const templateProps = await composeFn(validated, { 
      width: skill.render.width, 
      height: skill.render.height, 
      fps: skill.render.fps,
      duration: skill.render.duration 
    });

    // Duración efectiva: si compose devuelve "duracion", respetarla
    const requestedDuration = Number(templateProps?.duracion);
    const renderDuration = Number.isFinite(requestedDuration) && requestedDuration > 0
      ? requestedDuration
      : skill.render.duration;

    const outputVideo = path.join(skillOutputDir, `${skill.id}.mp4`);

    // Read template for tool-based templates
    const templatePath = path.join(getSkillsDir(), skill.id, skill.template);
    const templateContent = await fs.readFile(templatePath, "utf-8");
    const template = JSON.parse(templateContent);

    const hasTools = Array.isArray(template.tools);
    const hasFilters = Array.isArray(template.filters);
    console.log(
      `[SkillEngine] ${skill.id}: template=${skill.template} engine=${skill.render.engine} ` +
      `tools=${hasTools} filters=${hasFilters} duration=${renderDuration}s`
    );
    
    if (hasTools) {
      // Tool-based template: execute the tools directly
      console.log(`[SkillEngine] Template has tools array, executing tools...`);
      await executeToolBasedTemplate(
        skill,
        templateProps,
        outputVideo,
        context.projectId
      );
    } else if (skill.render.engine === "ffmpeg" && hasFilters) {
      // Motor FFmpeg: usar plantilla JSON directamente
      console.log(`[SkillEngine] Template has filters array, rendering with FFmpeg...`);
      await renderFfmpegTemplate(
        skill,
        templateProps,
        outputVideo,
        skill.render.width,
        skill.render.height,
        skill.render.fps,
        renderDuration
      );
    } else if (skill.render.engine === "remotion") {
      // Motor Remotion: usar bundler + renderFrames
      console.log(`[SkillEngine] Rendering with Remotion...`);
      await renderRemotionSkill(
        skill,
        templateProps,
        outputVideo,
        skill.render.width,
        skill.render.height,
        skill.render.fps,
        renderDuration
      );
    } else {
      // Unknown template type
      console.error(`[SkillEngine] ERROR: Unknown template type for ${skill.id}. Template keys:`, Object.keys(template));
      throw new Error(`Template ${skill.template} has neither 'tools' nor 'filters' array`);
    }

    outputFiles.push(outputVideo);

    const durationFrames = Math.round(renderDuration * skill.render.fps);
    const clips = [{
      id: newId("clp"),
      type: "video" as const,
      startFrame: 0,
      durationFrames,
      trackKind: "video" as const,
      props: {
        skillId: skill.id,
        skillParams: validated,
        videoFile: path.relative(projectDir, outputVideo),
        ...templateProps,
      },
      skillId: skill.id,
      skillParams: validated,
    }];

    return {
      success: true,
      clips,
      outputFiles,
      warnings,
      durationFrames,
    };
  } catch (error) {
    console.error(`[SkillEngine] Error ejecutando skill ${skill.id}:`, error);
    return {
      success: false,
      clips: [],
      outputFiles: [],
      warnings: [error instanceof Error ? error.message : "Error desconocido"],
      durationFrames: 0,
    };
  }
}


