import { describe, expect, it } from "vitest";
import { createProject, defaultSettings, makeMediaClip } from "../src/shared/project";
import { addClip, addTrack, sortTracksByVisualZOrder } from "../src/shared/timeline";
import type { MediaAsset, MediaClip, Project, Track } from "../src/shared/schema";
import {
  buildHyperFrameCinematicLook,
  buildHyperFrameKineticStatementFull,
} from "../src/shared/hyperframes";
import {
  synthesizeValidatedRemotionScene,
  verifyRemotionComponentTsx,
} from "../server/agent/autonomousEditorBrain";
import {
  applyDuckedMusicBedTrack,
  computeNormalizedAudioPeaks,
  computeRecommendedSpeechGain,
  extractPeakImpactFrames,
  resolveMusicBedMood,
  shouldAddProceduralMusicBed,
} from "../server/agent/audioDirector";
import {
  buildSubjectTrackingTransformKeyframes,
  runClosedLoopVisualQA,
} from "../server/agent/visionInspector";

function mustAddTrack(
  project: Project,
  kind: Track["kind"],
  name: string,
): { project: Project; track: Track } {
  const res = addTrack(project, kind, name);
  if (!res.ok || !res.track) {
    throw new Error(res.ok ? `No track returned for ${name}` : res.error);
  }
  return { project: res.project, track: res.track };
}

function makeBaseTestProject(width = 1920, height = 1080, fps = 30): {
  project: Project;
  videoAsset: MediaAsset;
  v1Clip: MediaClip;
} {
  const base = createProject("Test Phase2", defaultSettings(width, height, fps));
  const videoAsset: MediaAsset = {
    id: "med_v1_test",
    name: "ponente.mp4",
    kind: "video",
    file: "media/ponente.mp4",
    mimeType: "video/mp4",
    sizeBytes: 3_200_000,
    durationUs: 16_000_000,
    width,
    height,
    fps: { num: fps, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    thumbnail: "ready",
    waveform: "ready",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
  };
  let project: Project = { ...base, media: [videoAsset] };
  const v1 = project.tracks.find((t) => t.kind === "video")!;
  const v1Clip = makeMediaClip(project, videoAsset, { startFrame: 0 });
  const added = addClip(project, v1.id, v1Clip);
  if (!added.ok) throw new Error(added.error);
  project = added.project;
  return { project, videoAsset, v1Clip };
}

describe("Phase 2 Estudio IA: Z-order, 60fps, Audio-Reactividad y Visión VLM", () => {
  it("ordena las capas visuales de manera determinista compartida entre Preview y Export", () => {
    const base = createProject("ZOrder Test", defaultSettings(1080, 1920, 60));
    const s1 = mustAddTrack(base, "video", "Capa Transiciones");
    const s2 = mustAddTrack(s1.project, "video", "Capa Atmósfera");
    const s3 = mustAddTrack(s2.project, "video", "Capa Motion");
    const s4 = mustAddTrack(s3.project, "video", "V0");
    const s5 = mustAddTrack(s4.project, "text", "Subtítulos");

    const ordered = sortTracksByVisualZOrder(s5.project.tracks).map((t) => t.name);
    const idxV0 = ordered.indexOf("V0");
    const idxV1 = ordered.indexOf("V1");
    const idxMotion = ordered.indexOf("Capa Motion");
    const idxAtm = ordered.indexOf("Capa Atmósfera");
    const idxSubs = ordered.indexOf("Subtítulos");
    const idxTrans = ordered.indexOf("Capa Transiciones");

    expect(idxV0).toBeLessThan(idxV1);
    expect(idxV1).toBeLessThan(idxMotion);
    expect(idxMotion).toBeLessThan(idxAtm);
    expect(idxAtm).toBeLessThan(idxSubs);
    expect(idxSubs).toBeLessThan(idxTrans);
  });

  it("normaliza picos acústicos, extrae beats vocales y calibra ganancia hacia -14 LUFS", () => {
    const windows = [
      { startUs: 0, endUs: 250_000, peakDb: -28, rmsDb: -34, rms: 0.02 },
      { startUs: 250_000, endUs: 500_000, peakDb: -24, rmsDb: -30, rms: 0.032 },
      { startUs: 1_500_000, endUs: 1_750_000, peakDb: -8, rmsDb: -12, rms: 0.25 },
      { startUs: 4_500_000, endUs: 4_750_000, peakDb: -7, rmsDb: -11, rms: 0.28 },
    ];
    const peaks = computeNormalizedAudioPeaks(windows, -7, -26);
    expect(peaks).toHaveLength(4);
    expect(peaks[0]!).toBeGreaterThanOrEqual(0.08);
    expect(peaks[3]!).toBeGreaterThan(peaks[0]!);
    expect(peaks[3]!).toBeLessThanOrEqual(1);

    const impacts = extractPeakImpactFrames(windows, -24, 30, 2.0);
    expect(impacts.length).toBeGreaterThanOrEqual(2);
    expect(impacts[1]! - impacts[0]!).toBeGreaterThanOrEqual(60);

    expect(computeRecommendedSpeechGain(-22)).toBeGreaterThan(1.3);
    expect(computeRecommendedSpeechGain(-14.5)).toBe(1);
    expect(computeRecommendedSpeechGain(null)).toBe(1);
  });

  it("aplica cama musical con ducking automático bajo locución de forma idempotente", () => {
    const { project } = makeBaseTestProject();
    const musicAsset: MediaAsset = {
      id: "med_bgm_01",
      name: "Cama Musical (ambient)",
      kind: "audio",
      file: "generated/bgm_ambient.wav",
      mimeType: "audio/wav",
      sizeBytes: 1_000_000,
      durationUs: 15_000_000,
      audioCodec: "pcm_s16le",
      sampleRate: 44100,
      channels: 2,
      thumbnail: "pending",
      waveform: "ready",
      proxy: "none",
      importedAt: new Date().toISOString(),
      origin: "generated",
    };

    const projWithMusic = { ...project, media: [...project.media, musicAsset] };
    const first = applyDuckedMusicBedTrack({
      project: projWithMusic,
      musicAsset,
      totalTimelineFrames: 300,
      fps: 30,
      transcriptSegments: [{ startUs: 0, endUs: 2_000_000, text: "Hola mundo" }],
      hasSpeechInTimeline: true,
    });
    const second = applyDuckedMusicBedTrack({
      project: first,
      musicAsset,
      totalTimelineFrames: 300,
      fps: 30,
      transcriptSegments: [{ startUs: 0, endUs: 2_000_000, text: "Hola mundo" }],
      hasSpeechInTimeline: true,
    });

    const musicTrack = second.tracks.find((t) => /M[úu]sica/i.test(t.name));
    expect(musicTrack).toBeDefined();
    expect(musicTrack!.clips).toHaveLength(1);
    const bgmClip = musicTrack!.clips[0]! as MediaClip;
    expect(bgmClip.volume).toBeLessThan(0.2);
    expect(bgmClip.fadeInFrames).toBeGreaterThan(0);

    expect(shouldAddProceduralMusicBed("edita sin música de fondo", false)).toBe(false);
    expect(shouldAddProceduralMusicBed("video cinemático con música cyberpunk", false)).toBe(true);
    expect(resolveMusicBedMood("estilo tráiler documental épico")).toBe("cinema");
  });

  it("calcula keyframes de seguimiento 16:9->9:16 y reubica overlays vía QA visual VLM", async () => {
    const tracking = buildSubjectTrackingTransformKeyframes({
      focusTracks: [
        { timeSec: 0, focusX: 0.25, focusY: 0.42 },
        { timeSec: 5, focusX: 0.72, focusY: 0.42 },
      ],
      durationFrames: 180,
      fps: 30,
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1080,
      targetHeight: 1920,
    });

    expect(tracking.length).toBeGreaterThanOrEqual(2);
    // Sujeto a la izquierda (0.25) desplaza el encuadre positivo en X; a la derecha (0.72), negativo
    expect(tracking[0]!.x!).toBeGreaterThan(0);
    expect(tracking.at(-1)!.x!).toBeLessThan(0);

    const { project, videoAsset } = makeBaseTestProject();
    const motionTrackRes = mustAddTrack(project, "video", "Capa Motion");
    const motionClip: MediaClip = {
      ...makeMediaClip(motionTrackRes.project, { ...videoAsset, id: "med_hf_qa", kind: "video" }, {
        startFrame: 15,
        durationFrames: 90,
        createdBy: "agent",
      }),
      id: "clp_overlay_face",
      name: "Metric HUD",
      remotion: {
        compositionId: "MetricComp",
        componentName: "MetricComp",
        code: `import React from "react";
import { AbsoluteFill } from "remotion";
export const MetricComp: React.FC<Record<string, any>> = ({ zone = "lower-third" }) => (
  <AbsoluteFill data-zone={zone}><div>Metric</div></AbsoluteFill>
);
export default MetricComp;`,
        props: { zone: "lower-third" },
        live: true,
      },
    };

    const projWithMotion = addClip(
      { ...motionTrackRes.project, media: [...motionTrackRes.project.media, { ...videoAsset, id: "med_hf_qa" }] },
      motionTrackRes.track.id,
      motionClip,
    );
    expect(projWithMotion.ok).toBe(true);
    if (!projWithMotion.ok) return;

    const qaRes = await runClosedLoopVisualQA({
      projectId: projWithMotion.project.id,
      project: projWithMotion.project,
      signal: new AbortController().signal,
      extractKeyframesFn: async () => [{ timeSec: 1.5, dataUrl: "data:image/jpeg;base64,AAAA" }],
      chatVisionFn: async () => ({
        model: "mock-vlm",
        data: {
          conflicts: [
            {
              clipId: "clp_overlay_face",
              suggestedZone: "hero-top",
              reason: "Cubre barbilla del ponente",
            },
          ],
          overallScore: 88,
        },
      }),
    });

    expect(qaRes.inspected).toBe(true);
    expect(qaRes.adjustmentsMade).toBe(1);
    const updatedClip = qaRes.project.tracks
      .find((t) => t.name === "Capa Motion")!
      .clips.find((c) => c.id === "clp_overlay_face")! as MediaClip;
    expect(updatedClip.remotion?.props?.zone).toBe("hero-top");
    expect((await verifyRemotionComponentTsx(updatedClip.remotion!.code)).ok).toBe(true);

    // Verificar degradación silenciosa cuando el modelo activo es solo texto y falla chatVision
    const offlineQa = await runClosedLoopVisualQA({
      projectId: projWithMotion.project.id,
      project: projWithMotion.project,
      signal: new AbortController().signal,
      extractKeyframesFn: async () => [{ timeSec: 1.5, dataUrl: "data:image/jpeg;base64,AAAA" }],
      chatVisionFn: async () => {
        throw new Error("vision not supported");
      },
    });
    expect(offlineQa.inspected).toBe(false);
    expect(offlineQa.adjustmentsMade).toBe(0);
    expect(offlineQa.project).toEqual(projWithMotion.project);
  });

  it("genera HyperFrames audio-reactivos y KineticStatementFull compilables con esbuild", async () => {
    const peaks = [0.2, 0.85, 0.45, 0.96, 0.3];
    const look = buildHyperFrameCinematicLook({
      lookPreset: "cinema-teal-orange",
      accentColor: "#22D3EE",
      secondaryColor: "#A855F7",
      letterboxRatio: 0.08,
      vignetteIntensity: 0.4,
      grainOpacity: 0.03,
      glowIntensity: 0.3,
      audioPeaks: peaks,
    });
    expect(look.props.audioPeaks).toEqual(peaks);
    expect((await verifyRemotionComponentTsx(look.code)).ok).toBe(true);

    const statement = buildHyperFrameKineticStatementFull({
      kicker: "ARQUITECTURA AUTÓNOMA",
      headline: "Cero Plantillas Fijas",
      subheadline: "Cada fotograma razonado desde cero",
      palette: {
        accent: "#38BDF8",
        secondary: "#818CF8",
        surface: "#0A0E17",
        text: "#F8FAFC",
      },
      audioPeaks: peaks,
    });
    expect((await verifyRemotionComponentTsx(statement.code)).ok).toBe(true);

    const synth = await synthesizeValidatedRemotionScene({
      scene: {
        id: "scene_audio_pulse",
        title: "Pulso Neuronal",
        layerRole: "overlay",
        zone: "hero-top",
        startSec: 1,
        durationSec: 4,
        visualConcept: "Ondas reactivas al audio",
        animationChoreography: "Glow pulsante con audioPeaks",
        headline: "99.4% Precisión",
        subheadline: "Motor en tiempo real",
        sfxType: "riser",
        hideSubtitlesDuringScene: false,
      },
      artDirection: {
        visualTheme: "Cyber Lab",
        colorMood: "tech-dark",
        typographyStyle: "editorial_serif",
        cameraStyle: "whip_energetic",
        editingPace: "balanced_editorial",
        palette: {
          accent: "#38BDF8",
          secondary: "#818CF8",
          surface: "#0A0E17",
          text: "#F8FAFC",
        },
      },
      width: 1920,
      height: 1080,
      fps: 60,
      durationFrames: 240,
      audioPeaks: peaks,
      signal: new AbortController().signal,
      chatJsonFn: async () => ({
        model: "mock",
        data: {
          componentName: "HFAudioPulseCard",
          compositionId: "AudioPulse",
          code: `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
export const HFAudioPulseCard: React.FC<Record<string, any>> = ({ audioPeaks = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const peak = Array.isArray(audioPeaks) && audioPeaks.length > 0 ? (audioPeaks[Math.min(audioPeaks.length - 1, Math.floor((frame / Math.max(1, fps)) * 4))] ?? 0.35) : 0.35;
  return <AbsoluteFill style={{ opacity: 0.5 + peak * 0.5, backgroundColor: "transparent", pointerEvents: "none" }}><div>99.4%</div></AbsoluteFill>;
};
export default HFAudioPulseCard;`,
        },
      }),
    });

    expect(synth.ok).toBe(true);
    if (synth.ok) {
      expect(synth.props.audioPeaks).toEqual(peaks);
      expect((await verifyRemotionComponentTsx(synth.code)).ok).toBe(true);
    }
  });
});
