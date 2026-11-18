import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderStill } from "@remotion/renderer";
import { projectSchema, exportSettingsSchema } from "../src/shared/schema";
import { buildOverlaySpecs, overlayFonts, NOVACUT_OVERLAY_COMPOSITION_ID } from "../src/shared/remotionSpec";

/**
 * Renderiza fotogramas sueltos de la capa de gráficos de un proyecto real para
 * revisar a ojo barras, contadores y acentos sin exportar el video completo.
 * Uso: npx tsx scripts/mg-debug.ts <projectId> [frames...]
 */
async function main() {
  const projectId = process.argv[2] ?? "prj_9c2d6d956cc34a23";
  const frames = process.argv.slice(3).map((value) => Number(value));
  const renderList = frames.length > 0 ? frames : [0, 10, 30, 80, 140];
  const projectFile = path.resolve("data/projects", projectId, "project.json");
  const project = projectSchema.parse(JSON.parse(await fs.readFile(projectFile, "utf8")));

  const settings = exportSettingsSchema.parse({
    resolution: 480,
    aspect: project.settings.aspect,
    fps: project.settings.fps.num / project.settings.fps.den,
    quality: "draft",
    encoder: "cpu",
    fileName: "mg-debug.mp4",
  });
  const specs = buildOverlaySpecs(project, settings);
  const fonts = overlayFonts(specs);
  console.log("overlays:", JSON.stringify(specs.map((s) => ({ id: s.id, graphic: s.graphic?.kind ?? null }))));

  const serveUrl = await bundle({
    entryPoint: path.resolve("novacut-remotion/index.tsx"),
    publicDir: path.resolve("assets/fonts"),
  });
  await ensureBrowser();

  const outDir = path.resolve("data/tmp/mg-debug-frames");
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const inputProps = { overlays: specs, fonts };
  const height = Math.round((settings.resolution * project.settings.height) / project.settings.width);
  for (const frame of renderList) {
    const output = path.join(outDir, `frame-${String(frame).padStart(4, "0")}.png`);
    await renderStill({
      serveUrl,
      composition: {
        id: NOVACUT_OVERLAY_COMPOSITION_ID,
        width: settings.resolution,
        height,
        fps: settings.fps,
        durationInFrames: Math.max(...renderList) + 1,
        defaultProps: inputProps,
        props: inputProps,
        defaultCodec: null,
        defaultOutName: null,
        defaultVideoImageFormat: null,
        defaultPixelFormat: null,
        defaultProResProfile: null,
        defaultSampleRate: null,
      },
      inputProps,
      frame,
      output,
      imageFormat: "png",
      overwrite: true,
      onBrowserLog: () => undefined,
    });
    console.log("still:", output);
  }
  console.log("files:", await fs.readdir(outDir));
  process.exit(0);
}

void main();
