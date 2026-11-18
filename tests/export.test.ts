import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaAsset } from "../src/shared/schema";
import { defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";
import { buildExport } from "../server/media/export";
import { normalizeFileName } from "../server/services/exportService";
import { probeMedia, verifyVideoFile } from "../server/media/probe";
import { runFfmpeg } from "../server/media/process";
import { dimensionsFor } from "../src/shared/presets";

const workDir = path.join(os.tmpdir(), `novacut-export-test-${Date.now()}`);
const projectDir = path.join(workDir, "project");
const tempDir = path.join(workDir, "temp");
const outputFile = path.join(tempDir, "salida.mp4");
const keyframeOutput = path.join(tempDir, "zoom.mp4");

let project: ReturnType<typeof defaultSettings> extends never ? never : import("../src/shared/schema").Project;

beforeAll(async () => {
  await fs.mkdir(path.join(projectDir, "media"), { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  const source = path.join(projectDir, "media", "fuente.mp4");
  await runFfmpeg(
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-shortest",
      source,
    ],
    { timeoutMs: 60_000, durationSeconds: 1 },
  );

  const base = import("../src/shared/project");
  const created = (await base).createProject("Export test", defaultSettings(640, 360, 30));
  const asset: MediaAsset = {
    id: "med_export00001",
    name: "fuente.mp4",
    kind: "video",
    file: "media/fuente.mp4",
    mimeType: "video/mp4",
    sizeBytes: (await fs.stat(source)).size,
    durationUs: 1_000_000,
    width: 640,
    height: 360,
    fps: { num: 30, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    sampleRate: 48000,
    channels: 2,
    thumbnail: "ready",
    waveform: "ready",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
  };
  const withMedia = { ...created, media: [asset] };
  const videoTrack = withMedia.tracks.find((track) => track.kind === "video")!;
  const textTrack = withMedia.tracks.find((track) => track.kind === "text")!;
  const mediaClip = makeMediaClip(withMedia, asset, { startFrame: 0 });
  let next = addClip(withMedia, videoTrack.id, mediaClip);
  if (!next.ok) throw new Error(next.error);
  const text = addClip(
    next.project,
    textTrack.id,
    makeTextClip({
      text: "Prueba de exportación",
      startFrame: 0,
      durationFrames: 30,
      role: "subtitle",
      animationIn: "bounce-in",
      animationInDuration: 9,
      animationOut: "fade-out",
      animationOutDuration: 6,
    }),
  );
  if (!text.ok) throw new Error(text.error);
  project = text.project;
}, 120_000);

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("exportacion FFmpeg", () => {
  it("normaliza el nombre de salida para que sea válido en el registro", () => {
    expect(normalizeFileName("Demo editorial · OECLIP.mp4")).toBe("Demo-editorial-OECLIP.mp4");
    expect(normalizeFileName("vídeo final.mp4")).toBe("video-final.mp4");
    expect(normalizeFileName("???")).toBe("oeclip-export.mp4");
  });

  it("genera un MP4 H.264/AAC verificable con texto quemado", async () => {
    const settings = {
      resolution: 480 as const,
      aspect: "16:9" as const,
      fps: 30 as const,
      quality: "draft" as const,
      encoder: "cpu" as const,
      engine: "ffmpeg" as const,
      fileName: "salida.mp4",
    };
    const built = await buildExport(project, settings, {
      outputFile,
      projectDir,
      tempDir,
      encoder: "libx264",
    });
    expect(built.args).toContain(built.filterFile);
    expect(built.durationUs).toBeGreaterThan(900_000);
    expect(built.textFiles).toHaveLength(1);
    const filterGraph = await fs.readFile(built.filterFile, "utf8");
    expect(filterGraph).toContain("fontsize='max(1,");
    expect(filterGraph).toContain("sin(");
    expect(filterGraph).toContain("alpha='min(");

    await runFfmpeg(built.args, { timeoutMs: 120_000, durationSeconds: 1 });

    const probe = await probeMedia(outputFile);
    const dims = dimensionsFor("16:9", 480);
    expect(probe.kind).toBe("video");
    expect(probe.width).toBe(dims.width);
    expect(probe.height).toBe(dims.height);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.audioCodec).toBe("aac");
    expect(probe.durationUs).toBeGreaterThan(900_000);

    const verification = await verifyVideoFile(outputFile, {
      durationUs: built.durationUs,
      width: built.width,
      height: built.height,
      hasAudio: built.expectedAudio,
    });
    expect(verification.valid).toBe(true);
    expect((await fs.stat(outputFile)).size).toBeGreaterThan(10_000);
  }, 120_000);

  it("anima el zoom con keyframes reales sin cambiar el tamaño de salida", async () => {
    const animated = {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.type === "video"
            ? {
                ...clip,
                transform: {
                  ...clip.transform,
                  keyframes: [
                    { frame: 0, scale: 1 },
                    { frame: 15, scale: 1.5 },
                    { frame: 30, scale: 1 },
                  ],
                },
              }
            : clip,
        ),
      })),
    };
    const built = await buildExport(
      animated,
      {
        resolution: 480,
        aspect: "16:9",
        fps: 30,
        quality: "draft",
        encoder: "cpu",
        engine: "ffmpeg",
        fileName: "zoom.mp4",
      },
      { outputFile: keyframeOutput, projectDir, tempDir, encoder: "libx264" },
    );
    const filterGraph = await fs.readFile(built.filterFile, "utf8");
    expect(filterGraph).toContain("zoompan=z='");
    expect(filterGraph).toContain("d=1:s=");
    expect(filterGraph).not.toContain("eval=frame");

    await runFfmpeg(built.args, { timeoutMs: 120_000, durationSeconds: 1 });
    const probe = await probeMedia(keyframeOutput);
    const dims = dimensionsFor("16:9", 480);
    expect(probe.width).toBe(dims.width);
    expect(probe.height).toBe(dims.height);
    expect(probe.durationUs).toBeGreaterThan(900_000);
    expect((await fs.stat(keyframeOutput)).size).toBeGreaterThan(10_000);
  }, 120_000);

  it("rechaza una linea de tiempo vacia", async () => {
    const empty = { ...project, tracks: project.tracks.map((track) => ({ ...track, clips: [] })) };
    await expect(
      buildExport(
        empty,
        { resolution: 480, aspect: "16:9", fps: 30, quality: "draft", encoder: "cpu", engine: "ffmpeg", fileName: "vacio.mp4" },
        { outputFile, projectDir, tempDir, encoder: "libx264" },
      ),
    ).rejects.toMatchObject({ code: "empty_timeline" });
  });
});
