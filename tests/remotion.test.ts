import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExportSettings, MediaAsset, MediaClip, Project, TextClip } from "../src/shared/schema";
import { exportSettingsSchema } from "../src/shared/schema";
import { createProject, defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";
import { dimensionsFor } from "../src/shared/presets";
import { buildOverlaySpecs, overlayFonts } from "../src/shared/remotionSpec";
import { buildCompositeArgs, buildExport } from "../server/media/export";

function asset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: "med_remotion01",
    name: "clip.mp4",
    kind: "video",
    file: "media/clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1000,
    durationUs: 12_000_000,
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    thumbnail: "pending",
    waveform: "pending",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
    ...overrides,
  };
}

function projectWithText(): { project: Project; text: TextClip } {
  const project = createProject("Remotion", defaultSettings(1080, 1920, 25));
  const video = asset({});
  let next = { ...project, media: [video] };
  const videoTrack = next.tracks.find((track) => track.kind === "video")!;
  const videoResult = addClip(next, videoTrack.id, makeMediaClip(next, video, { startFrame: 0 }) as MediaClip);
  if (!videoResult.ok) throw new Error(videoResult.error);
  next = videoResult.project;
  const textTrack = next.tracks.find((track) => track.kind === "text")!;
  const text = makeTextClip({
    text: "Un gancho corto y directo para redes",
    startFrame: 12,
    durationFrames: 75,
    role: "title",
    fontSize: 90,
    fontWeight: 700,
    animationIn: "bounce-in",
    animationInDuration: 20,
  });
  const textResult = addClip(next, textTrack.id, text);
  if (!textResult.ok) throw new Error(textResult.error);
  return { project: textResult.project, text };
}

const settings: ExportSettings = exportSettingsSchema.parse({
  resolution: 1080,
  aspect: "9:16",
  fps: 30,
  quality: "standard",
  encoder: "cpu",
  fileName: "remotion.mp4",
});

describe("motor de gráficos Remotion", () => {
  it("convierte capas de texto en specs con las métricas del export", () => {
    const { project, text } = projectWithText();
    const specs = buildOverlaySpecs(project, settings);
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    const dims = dimensionsFor(settings.aspect, settings.resolution);
    // fontSize escala por height/1080 (1080x1920 -> factor 1920/1080).
    expect(spec.fontSizePx).toBe(Math.round(text.fontSize * (dims.height / 1080)));
    // Los fotogramas del proyecto (25 fps) se convierten a los del export (30 fps).
    expect(spec.startFrame).toBe(Math.round((12 / 25) * 30));
    expect(spec.durationFrames).toBe(Math.round((75 / 25) * 30));
    expect(spec.animationInFrames).toBe(Math.round((20 / 25) * 30));
    expect(spec.animationIn).toBe("bounce-in");
    // Peso tipográfico con el mismo mapeo que el canvas (700 -> 900).
    expect(spec.fontWeight).toBe(900);
    // El wrapping usa la misma estimación de caracteres que drawtext.
    const maxWidthPx = dims.width * text.maxWidth;
    const maxChars = Math.max(10, Math.floor(maxWidthPx / (spec.fontSizePx * 0.52)));
    expect(spec.lines.every((line) => line.length <= maxChars)).toBe(true);
    expect(spec.lines.join(" ")).toContain("gancho");
    expect(spec.blockHeightPx).toBeCloseTo(spec.lines.length * spec.fontSizePx * text.lineHeight, 0);
  });

  it("ignora las pistas de texto ocultas", () => {
    const { project } = projectWithText();
    const hidden = {
      ...project,
      tracks: project.tracks.map((track) => (track.kind === "text" ? { ...track, hidden: true } : track)),
    };
    expect(buildOverlaySpecs(hidden, settings)).toHaveLength(0);
  });

  it("deduplica las fuentes de los overlays", () => {
    const { project } = projectWithText();
    const specs = buildOverlaySpecs(project, settings);
    expect(overlayFonts(specs)).toEqual([{ css: expect.any(String), file: "Inter-Variable.ttf" }]);
  });

  it("el esquema de exportación por defecto usa el motor FFmpeg", () => {
    const parsed = exportSettingsSchema.parse({
      resolution: 720,
      aspect: "16:9",
      fps: 30,
      quality: "standard",
      encoder: "auto",
      fileName: "x.mp4",
    });
    expect(parsed.engine).toBe("ffmpeg");
    expect(exportSettingsSchema.parse({ ...settings, engine: "remotion" }).engine).toBe("remotion");
  });

  it("la base con skipText no quema texto", async () => {
    const { project } = projectWithText();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "novacut-remotion-"));
    try {
      const built = await buildExport(project, settings, {
        outputFile: path.join(tempDir, "base.mp4"),
        projectDir: tempDir,
        tempDir,
        encoder: "libx264",
        skipText: true,
      });
      const filterGraph = await fs.readFile(built.filterFile, "utf8");
      expect(filterGraph).not.toContain("drawtext");
      expect(built.textFiles).toHaveLength(0);

      const withText = await buildExport(project, settings, {
        outputFile: path.join(tempDir, "full.mp4"),
        projectDir: tempDir,
        tempDir,
        encoder: "libx264",
      });
      const fullGraph = await fs.readFile(withText.filterFile, "utf8");
      expect(fullGraph).toContain("drawtext");
      await fs.rm(withText.filterFile, { force: true });
      for (const file of withText.textFiles) await fs.rm(file, { force: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("construye el pase de composición con la secuencia PNG y audio copiado", () => {
    const args = buildCompositeArgs({
      baseFile: "base.mp4",
      framesDir: "frames",
      frameCount: 90,
      settings,
      encoder: "libx264",
      outputFile: "final.mp4",
      durationSeconds: 3,
    });
    expect(args).toContain("base.mp4");
    expect(args).toContain("-framerate");
    expect(args).toContain("30");
    expect(args.join(" ")).toContain("frame_%06d.png");
    expect(args.join(" ")).toContain("overlay=0:0");
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
  });
});
