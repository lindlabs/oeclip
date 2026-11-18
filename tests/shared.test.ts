import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../src/shared/schema";
import { projectSchema } from "../src/shared/schema";
import { createProject, defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import {
  addClip,
  applySourceRanges,
  moveClip,
  splitClipAt,
  trimClipBy,
} from "../src/shared/timeline";
import {
  formatBytes,
  formatTimecode,
  framesToSeconds,
  framesToUs,
  secondsToFrames,
  toRational,
  usToFrames,
} from "../src/shared/time";
import { aspectForDimensions, dimensionsFor } from "../src/shared/presets";
import { buildSrt, srtTimestamp, wrapText } from "../src/shared/srt";

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "med_testasset01",
    name: "clip.mp4",
    kind: "video",
    file: "media/clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1000,
    durationUs: 6_000_000,
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    thumbnail: "ready",
    waveform: "ready",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
    ...overrides,
  };
}

function projectWithClip() {
  const project = createProject("Prueba", defaultSettings(1920, 1080, 30));
  const asset = makeAsset();
  const next = { ...project, media: [asset] };
  const track = next.tracks.find((item) => item.kind === "video")!;
  const clip = makeMediaClip(next, asset, { startFrame: 0 });
  const added = addClip(next, track.id, clip);
  if (!added.ok) throw new Error(added.error);
  return { project: added.project, asset, trackId: track.id, clipId: clip.id };
}

describe("tiempo y fotogramas", () => {
  it("convierte 29,97 fps sin acumular error", () => {
    const fps = toRational(29.97);
    expect(fps).toEqual({ num: 30000, den: 1001 });
    const frames = secondsToFrames(10, fps);
    // El redondeo a fotograma completo no puede desviarse mas de un fotograma.
    expect(Math.abs(framesToSeconds(frames, fps) - 10)).toBeLessThan(1001 / 30000);
    expect(usToFrames(framesToUs(frames, fps), fps)).toBe(frames);
  });

  it("formatea timecode y bytes de forma estable", () => {
    expect(formatTimecode(0, { num: 30, den: 1 })).toBe("00:00:00");
    expect(formatTimecode(95, { num: 30, den: 1 })).toBe("00:03:05");
    expect(formatTimecode(30 * 3661, { num: 30, den: 1 })).toBe("01:01:01:00");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});

describe("presets y esquema", () => {
  it("calcula dimensiones pares por formato", () => {
    expect(dimensionsFor("16:9", 1080)).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsFor("9:16", 1080)).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsFor("1:1", 1080)).toEqual({ width: 1080, height: 1080 });
    expect(dimensionsFor("4:5", 1080)).toEqual({ width: 1080, height: 1350 });
    expect(aspectForDimensions(1080, 1920)).toBe("9:16");
  });

  it("rechaza clips solapados en la misma pista", () => {
    const { project, asset, trackId } = projectWithClip();
    const second = makeMediaClip(project, asset, { startFrame: 60 });
    const added = addClip(project, trackId, second);
    expect(added).toEqual({ ok: false, error: "El clip se solapa con otro clip de la pista." });
  });

  it("el esquema detecta solapamientos aunque se construyan a mano", () => {
    const { project, trackId } = projectWithClip();
    const copy = structuredClone(project);
    const track = copy.tracks.find((item) => item.id === trackId)!;
    track.clips.push({ ...track.clips[0]!, id: "clp_manual0001", startFrame: 30 });
    const parsed = projectSchema.safeParse(copy);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("Solapamiento"))).toBe(true);
  });
});

describe("operaciones de montaje", () => {
  it("divide un clip conservando el rango de origen", () => {
    const { project, clipId } = projectWithClip();
    const result = splitClipAt(project, clipId, 45);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clips = result.project.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(2);
    const left = clips.find((clip) => clip.startFrame === 0)!;
    const right = clips.find((clip) => clip.startFrame === 45)!;
    expect(left.durationFrames).toBe(45);
    expect(right.durationFrames).toBe(180 - 45);
    expect(right.type === "text" ? 0 : right.sourceInUs).toBe(1_500_000);
  });

  it("recorta el inicio y desplaza el clip", () => {
    const { project, clipId, trackId } = projectWithClip();
    const trimmed = trimClipBy(project, clipId, "start", 15);
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    const moved = moveClip(trimmed.project, clipId, trackId, 60);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const clip = moved.project.tracks.flatMap((track) => track.clips)[0]!;
    expect(clip.startFrame).toBe(60);
    expect(clip.durationFrames).toBe(165);
    if (clip.type !== "text") expect(clip.sourceInUs).toBe(500_000);
  });

  it("no permite solapar al mover", () => {
    const { project, asset, clipId, trackId } = projectWithClip();
    const second = makeMediaClip(project, asset, { startFrame: 200 });
    const added = addClip(project, trackId, second);
    if (!added.ok) throw new Error(added.error);
    const moved = moveClip(added.project, clipId, trackId, 100);
    expect(moved.ok).toBe(false);
  });

  it("aplica rangos de origen y renombra los segmentos", () => {
    const { project, clipId } = projectWithClip();
    const result = applySourceRanges(project, clipId, [
      { startUs: 0, endUs: 1_000_000 },
      { startUs: 2_000_000, endUs: 3_000_000 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clips = result.project.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.startFrame)).toEqual([0, 30]);
    expect(clips.every((clip) => clip.id.startsWith(clipId))).toBe(true);
  });

  it("mantiene los clips de texto fuera del esquema de solapamiento", () => {
    const project = createProject("Texto", defaultSettings(1080, 1920, 30));
    const textTrack = project.tracks.find((track) => track.kind === "text")!;
    const first = addClip(project, textTrack.id, makeTextClip({ text: "A", startFrame: 0, durationFrames: 60 }));
    if (!first.ok) throw new Error(first.error);
    const second = addClip(
      first.project,
      textTrack.id,
      makeTextClip({ text: "B", startFrame: 30, durationFrames: 60 }),
    );
    expect(second.ok).toBe(true);
  });
});

describe("subtitulos y texto", () => {
  it("genera SRT con marcas de tiempo de 29,97 fps", () => {
    const project = createProject("Subs", defaultSettings(1920, 1080, 29.97));
    const textTrack = project.tracks.find((track) => track.kind === "text")!;
    const added = addClip(
      project,
      textTrack.id,
      makeTextClip({ text: "Hola mundo", startFrame: 0, durationFrames: 30, role: "subtitle" }),
    );
    if (!added.ok) throw new Error(added.error);
    const srt = buildSrt(added.project);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,001\nHola mundo");
    // 30000 fotogramas a 30000/1001 fps son exactamente 1001 s.
    expect(srtTimestamp(30000, { num: 30000, den: 1001 })).toBe("00:16:41,000");
  });

  it("envuelve lineas respetando el maximo de caracteres", () => {
    const wrapped = wrapText("uno dos tres cuatro cinco seis", 10);
    expect(wrapped.split("\n").every((line) => line.length <= 10)).toBe(true);
    expect(wrapped).toContain("tres");
  });
});
