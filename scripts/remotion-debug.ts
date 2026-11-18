import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderFrames } from "@remotion/renderer";
import { createProject, defaultSettings, makeTextClip } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";
import { buildOverlaySpecs, overlayFonts, NOVACUT_OVERLAY_COMPOSITION_ID } from "../src/shared/remotionSpec";
import { exportSettingsSchema } from "../src/shared/schema";

async function main() {
  const project = createProject("Debug", defaultSettings(1080, 1920, 25));
  const textTrack = project.tracks.find((track) => track.kind === "text")!;
  const text = makeTextClip({
    text: "Gancho de debug",
    startFrame: 0,
    durationFrames: 100,
    role: "title",
    fontSize: 90,
    animationIn: "bounce-in",
    animationInDuration: 20,
  });
  const added = addClip(project, textTrack.id, text);
  if (!added.ok) throw new Error(added.error);

  const settings = exportSettingsSchema.parse({
    resolution: 480,
    aspect: "9:16",
    fps: 30,
    quality: "draft",
    encoder: "cpu",
    fileName: "debug.mp4",
  });
  const specs = buildOverlaySpecs(added.project, settings);
  const fonts = overlayFonts(specs);
  console.log("specs:", specs.length, "fonts:", fonts);

  const serveUrl = await bundle({
    entryPoint: path.resolve("novacut-remotion/index.tsx"),
    publicDir: path.resolve("assets/fonts"),
  });
  console.log("bundle ok:", serveUrl);
  console.log("browser:", await ensureBrowser());

  const outDir = path.resolve("data/tmp/remotion-debug-frames");
  await fs.mkdir(outDir, { recursive: true });
  try {
    const inputProps = { overlays: specs, fonts };
    const result = await renderFrames({
      serveUrl,
      composition: {
        id: NOVACUT_OVERLAY_COMPOSITION_ID,
        width: 270,
        height: 480,
        fps: 30,
        durationInFrames: 4,
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
      outputDir: outDir,
      imageFormat: "png",
      concurrency: 2,
      frameRange: [0, 3],
      onBrowserLog: (log) => console.log("BROWSER LOG:", JSON.stringify(log).slice(0, 500)),
      onStart: () => undefined,
      onFrameUpdate: () => undefined,
    });
    console.log("render ok:", result);
    const files = await fs.readdir(outDir);
    console.log("files:", files);
  } catch (error) {
    console.error("RENDER ERROR:", error);
  }
  process.exit(0);
}

void main();
