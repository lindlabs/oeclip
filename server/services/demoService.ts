import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { MediaAsset, Project } from "../../src/shared/schema";
import { newId, secondsToFrames } from "../../src/shared/time";
import { defaultSettings, makeMediaClip, makeTextClip } from "../../src/shared/project";
import { addClip } from "../../src/shared/timeline";
import { projectMediaDirectory, projectStore, type ProjectBundle } from "../projects/store";
import { runFfmpeg } from "../media/process";
import { probeMedia } from "../media/probe";

interface DemoClipSpec {
  fileName: string;
  label: string;
  c0: string;
  c1: string;
  seconds: number;
}

const DEMO_CLIPS: DemoClipSpec[] = [
  { fileName: "demo-amanecer.mp4", label: "AMANECER", c0: "0x2F4A3A", c1: "0xD9E4CF", seconds: 6 },
  { fileName: "demo-travesia.mp4", label: "TRAVESIA", c0: "0x1D3630", c1: "0x9DBFA3", seconds: 6 },
  { fileName: "demo-cierre.mp4", label: "CIERRE", c0: "0x4C5B44", c1: "0xEFE9DA", seconds: 6 },
];

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function generateClip(directory: string, spec: DemoClipSpec): Promise<MediaAsset> {
  const output = path.join(directory, spec.fileName);
  const font = escapeFilterValue(config.interFont);
  const label = escapeFilterValue(spec.label);
  await runFfmpeg(
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `gradients=s=320x180:r=30:d=${spec.seconds}:c0=${spec.c0}:c1=${spec.c1}:x0=0:y0=0:x1=320:y1=180:speed=0.015`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=48000:duration=${spec.seconds}`,
      "-vf",
      `scale=1280:720:flags=bilinear,drawtext=fontfile='${font}':text='${label}':fontcolor=white@0.16:fontsize=132:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.18:shadowx=2:shadowy=2,` +
        `drawtext=fontfile='${font}':text='OECLIP / DEMO':fontcolor=white@0.55:fontsize=22:x=48:y=h-62`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      output,
    ],
    { timeoutMs: 10 * 60_000, durationSeconds: spec.seconds },
  );
  return assetFromFile(output, spec.fileName, "demo");
}

async function generateAmbience(directory: string): Promise<MediaAsset> {
  const fileName = "demo-ambiente.m4a";
  const output = path.join(directory, fileName);
  await runFfmpeg(
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=196:sample_rate=48000:duration=18",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=246.94:sample_rate=48000:duration=18",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=293.66:sample_rate=48000:duration=18",
      "-filter_complex",
      "[0:a]volume=0.07[a0];[1:a]volume=0.055[a1];[2:a]volume=0.04[a2];" +
        "[a0][a1][a2]amix=inputs=3:normalize=0,afade=t=in:st=0:d=2,afade=t=out:st=16:d=2," +
        "aecho=0.8:0.7:120|240:0.25|0.15[aout]",
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      output,
    ],
    { timeoutMs: 5 * 60_000, durationSeconds: 18 },
  );
  return assetFromFile(output, fileName, "demo");
}

async function assetFromFile(absolute: string, fileName: string, origin: MediaAsset["origin"]): Promise<MediaAsset> {
  const probe = await probeMedia(absolute);
  const stat = await fs.stat(absolute);
  return {
    id: newId("med"),
    name: fileName.replace(/^demo-/, "").replace(/\.[a-z0-9]+$/, ""),
    kind: probe.kind,
    file: `media/${fileName}`,
    mimeType: fileName.endsWith(".m4a") ? "audio/mp4" : "video/mp4",
    sizeBytes: stat.size,
    durationUs: probe.durationUs,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    rotation: probe.rotation,
    thumbnail: "pending",
    waveform: probe.audioCodec ? "pending" : "none",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin,
  };
}

function addMediaClipToTrack(project: Project, trackId: string, asset: MediaAsset, startFrame: number): Project {
  const clip = makeMediaClip(project, asset, { startFrame, createdBy: "demo" });
  const result = addClip(project, trackId, clip);
  if (!result.ok) throw new Error(`No se pudo montar el clip de demo: ${result.error}`);
  return result.project;
}

function addTextToTrack(
  project: Project,
  trackId: string,
  text: string,
  startSeconds: number,
  durationSeconds: number,
  role: "title" | "subtitle" | "caption",
): Project {
  const clip = makeTextClip({
    text,
    startFrame: secondsToFrames(startSeconds, project.settings.fps),
    durationFrames: secondsToFrames(durationSeconds, project.settings.fps),
    role,
    createdBy: "demo",
  });
  const result = addClip(project, trackId, clip);
  if (!result.ok) throw new Error(`No se pudo crear el texto de demo: ${result.error}`);
  return result.project;
}

async function ensureDemoAssetsInDir(projectDirectory: string): Promise<{
  videoAssets: MediaAsset[];
  ambience: MediaAsset;
}> {
  const cacheDir = path.join(config.dataDir, ".demo-cache-oeclip-v2");
  await fs.mkdir(cacheDir, { recursive: true });

  const ensureCachedClip = async (spec: DemoClipSpec): Promise<MediaAsset> => {
    const cached = path.join(cacheDir, spec.fileName);
    const dest = path.join(projectDirectory, spec.fileName);
    const exists = await fs
      .stat(cached)
      .then((s) => s.size > 1000)
      .catch(() => false);
    if (!exists) {
      await generateClip(cacheDir, spec);
    }
    await fs.copyFile(cached, dest);
    return assetFromFile(dest, spec.fileName, "demo");
  };

  const ensureCachedAmbience = async (): Promise<MediaAsset> => {
    const fileName = "demo-ambiente.m4a";
    const cached = path.join(cacheDir, fileName);
    const dest = path.join(projectDirectory, fileName);
    const exists = await fs
      .stat(cached)
      .then((s) => s.size > 500)
      .catch(() => false);
    if (!exists) {
      await generateAmbience(cacheDir);
    }
    await fs.copyFile(cached, dest);
    return assetFromFile(dest, fileName, "demo");
  };

  const [clips, ambience] = await Promise.all([
    Promise.all(DEMO_CLIPS.map((spec) => ensureCachedClip(spec))),
    ensureCachedAmbience(),
  ]);
  return { videoAssets: clips, ambience };
}

/**
 * Genera un proyecto de demostración con metraje real creado por FFmpeg.
 * Reutiliza una caché local en `.demo-cache` para abrirse en < 1 segundo sin dependencias remotas.
 */
export async function createDemoProject(): Promise<ProjectBundle> {
  const bundle = await projectStore.create("Demo editorial · OECLIP", defaultSettings(1920, 1080, 30));
  const projectDirectory = projectMediaDirectory(bundle.project.id);
  await fs.mkdir(projectDirectory, { recursive: true });

  try {
    const { videoAssets, ambience } = await ensureDemoAssetsInDir(projectDirectory);
    for (const asset of [...videoAssets, ambience]) {
      await projectStore.addMedia(bundle.project.id, asset);
    }

    const current = await projectStore.get(bundle.project.id);
    const project = current.project;
    const videoTrack = project.tracks.find((track) => track.kind === "video");
    const audioTrack = project.tracks.find((track) => track.kind === "audio");
    const textTrack = project.tracks.find((track) => track.kind === "text");
    if (!videoTrack || !audioTrack || !textTrack) {
      throw new Error("El proyecto de demostración no tiene las pistas base.");
    }

    let cursor = 0;
    let next = project;
    for (const asset of videoAssets) {
      const clip = makeMediaClip(next, asset, { startFrame: cursor, createdBy: "demo" });
      const result = addClip(next, videoTrack.id, clip);
      if (!result.ok) throw new Error(result.error);
      next = result.project;
      cursor += clip.durationFrames;
    }
    next = addMediaClipToTrack(next, audioTrack.id, ambience, 0);
    next = addTextToTrack(next, textTrack.id, "OECLIP Studio", 0.6, 3.8, "title");
    next = addTextToTrack(next, textTrack.id, "Edita con intención, no con menús.", 4.4, 4.2, "subtitle");
    next = addTextToTrack(next, textTrack.id, "Demo generado en local con FFmpeg", 12.6, 4.4, "caption");

    next.name = "Demo editorial · OECLIP";
    next.updatedAt = new Date().toISOString();
    const saved = await projectStore.saveTimeline(bundle.project.id, next, { force: true });
    return saved;
  } catch (error) {
    await projectStore.delete(bundle.project.id).catch(() => undefined);
    throw error;
  }
}
