import type { MediaAsset, MediaClip, Project, Track } from "../../src/shared/schema";
import { makeMediaClip, touchProject } from "../../src/shared/project";
import { addClip, addTrack } from "../../src/shared/timeline";
import type { TranscriptSegment } from "../ai/provider";
import { detectScenes, measureLoudness } from "../media/analysis";
import { analyzeAudioEnvelope, type AudioWindow } from "../media/library";
import type { MusicBedMood } from "../services/sfxService";

export interface AudioAnalysisProfile {
  /** Picos normalizados [0..1] muestreados cada ~0.25s para animaciones Remotion audio-reactivas */
  normalizedPeaks: number[];
  /** Frames donde hay picos reales de énfasis vocal o energía musical */
  peakImpactFrames: number[];
  /** Marcas de cambio de plano visual detectadas por FFmpeg scene filter */
  sceneTimestampsSec: number[];
  /** Sonoridad integrada medida en LUFS (EBU R128) */
  integratedLufs: number | null;
  /** Ganancia lineal recomendada para acercar la voz al estándar -14 LUFS */
  recommendedSpeechGain: number;
  report: string;
}

/**
 * Pure helper para normalizar ventanas RMS dB en curva [0..1] apta para shaders/CSS/SVG en Remotion.
 */
export function computeNormalizedAudioPeaks(
  windows: AudioWindow[],
  peakDb: number,
  meanDb: number,
): number[] {
  if (windows.length === 0) return [];
  const floorDb = Math.min(-42, meanDb - 14);
  const ceilDb = Math.max(floorDb + 6, Math.max(-6, peakDb));
  const span = Math.max(1, ceilDb - floorDb);

  return windows.map((w) => {
    const clamped = Math.max(floorDb, Math.min(ceilDb, w.rmsDb));
    const norm = (clamped - floorDb) / span;
    return Number(Math.max(0.08, Math.min(1, norm)).toFixed(3));
  });
}

/**
 * Extrae frames de impacto reales donde el volumen salta por encima del nivel medio vocal.
 */
export function extractPeakImpactFrames(
  windows: AudioWindow[],
  meanDb: number,
  fps: number,
  minSpacingSec = 2.4,
): number[] {
  if (windows.length === 0) return [];
  const thresholdDb = Math.max(-34, meanDb + 3.2);
  const minSpacingFrames = Math.round(fps * minSpacingSec);
  const candidates: number[] = [];
  let lastFrame = -minSpacingFrames;

  for (const w of windows) {
    if (w.rmsDb < thresholdDb) continue;
    const midSec = (w.startUs + w.endUs) / 2_000_000;
    const frame = Math.max(0, Math.round(midSec * fps));
    if (frame < Math.round(fps * 1.2)) continue;
    if (frame - lastFrame >= minSpacingFrames) {
      candidates.push(frame);
      lastFrame = frame;
    }
  }

  return candidates.slice(0, 14);
}

/**
 * Calcula ganancia lineal segura para normalizar locución hacia -14 LUFS.
 */
export function computeRecommendedSpeechGain(integratedLufs: number | null): number {
  if (integratedLufs === null || !Number.isFinite(integratedLufs)) return 1;
  const targetLufs = -14;
  const deltaDb = targetLufs - integratedLufs;
  // Evitar sobre-amplificar videos muy ruidosos o silenciosos en exceso
  if (Math.abs(deltaDb) < 1.8) return 1;
  const linear = Math.pow(10, deltaDb / 20);
  return Number(Math.max(0.75, Math.min(1.68, linear)).toFixed(2));
}

export async function analyzeProjectAudioProfile(options: {
  projectId: string;
  asset: MediaAsset;
  fps: number;
  signal: AbortSignal;
}): Promise<AudioAnalysisProfile> {
  const { projectId, asset, fps, signal } = options;

  let windows: AudioWindow[] = [];
  let peakDb = -10;
  let meanDb = -24;
  let integratedLufs: number | null = null;
  let sceneTimestampsSec: number[] = [];

  const hasAudio = Boolean(asset.audioCodec || asset.kind === "video");

  const [envRes, loudRes, sceneRes] = await Promise.allSettled([
    hasAudio ? analyzeAudioEnvelope(projectId, asset, 0.25, signal) : Promise.resolve(null),
    hasAudio ? measureLoudness(projectId, asset, signal) : Promise.resolve(null),
    asset.kind === "video"
      ? detectScenes(projectId, asset, { threshold: 0.28 }, signal)
      : Promise.resolve([]),
  ]);

  if (envRes.status === "fulfilled" && envRes.value) {
    windows = envRes.value.windows;
    peakDb = envRes.value.peakDb;
    meanDb = envRes.value.meanDb;
  }
  if (loudRes.status === "fulfilled" && loudRes.value) {
    integratedLufs = loudRes.value.integratedLufs;
  }
  if (sceneRes.status === "fulfilled" && Array.isArray(sceneRes.value)) {
    sceneTimestampsSec = sceneRes.value.slice(0, 24);
  }

  const normalizedPeaks = computeNormalizedAudioPeaks(windows, peakDb, meanDb);
  const peakImpactFrames = extractPeakImpactFrames(windows, meanDb, fps);
  const recommendedSpeechGain = computeRecommendedSpeechGain(integratedLufs);

  const lufsText =
    integratedLufs !== null ? `${integratedLufs.toFixed(1)} LUFS` : "LUFS n/d";
  const report = `Audio analizado (${lufsText}, ganancia ×${recommendedSpeechGain}), ${peakImpactFrames.length} picos de énfasis y ${sceneTimestampsSec.length} cambios de plano.`;

  return {
    normalizedPeaks,
    peakImpactFrames,
    sceneTimestampsSec,
    integratedLufs,
    recommendedSpeechGain,
    report,
  };
}

export function shouldAddProceduralMusicBed(
  prompt: string,
  usedSyntheticEnvironment: boolean,
): boolean {
  const lower = prompt.toLowerCase();
  if (
    /\b(sin\s+m[úu]sica|no\s+m[úu]sica|solo\s+voz|sin\s+banda\s+sonora|audio\s+original|entrevista\s+(?:limpia|natural)|podcast\s+(?:puro|limpio)|estilo\s+limpio|sin\s+saturar)\b/i.test(
      lower,
    )
  ) {
    return false;
  }
  if (
    /\b(m[úu]sica|soundtrack|banda\s+sonora|beat|canc[ió]n|fondo\s+musical|ambient|trailer|tr[áa]iler|cinematogr[áa]fic|lofi|lo-fi|épico|epico)\b/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\bdocumental\b/i.test(lower) && !/\b(minimalista|sobrio|solo\s+voz|crudo)\b/i.test(lower)) {
    return true;
  }
  return usedSyntheticEnvironment;
}

export function resolveMusicBedMood(prompt: string, colorMood?: string): MusicBedMood {
  const combined = `${prompt} ${colorMood ?? ""}`.toLowerCase();
  if (/\b(cyber|ne[óo]n|ia|inteligencia\s+artificial|tech|c[óo]digo|futur|matrix|saas)\b/i.test(combined)) {
    return "tech";
  }
  if (/\b(viral|hormozi|mrbeast|energi|r[áa]pido|din[áa]mic|fitness|sports)\b/i.test(combined)) {
    return "energetic";
  }
  if (/\b(trailer|tr[áa]iler|documental|cine|pel[íi]cula|dram[áa]tic|noir|épico)\b/i.test(combined)) {
    return "cinema";
  }
  return "ambient";
}

function ensureMusicTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (t) =>
      t.kind === "audio" &&
      !t.locked &&
      (/m[úu]sica/i.test(t.name) || /music|bgm/i.test(t.name)),
  );
  if (existing) return { project, track: existing };
  const added = addTrack(project, "audio", "Música Fondo");
  if (!added.ok || !added.track) {
    throw new Error(added.ok ? "No se pudo crear la pista de música." : added.error);
  }
  return { project: added.project, track: added.track };
}

/**
 * Inserta cama musical procedural en "Música Fondo" aplicando Audio Ducking por segmentos:
 * atenúa suavemente a ~0.13 durante habla continua y sube hasta ~0.26 en huecos sin voz o intro/outro.
 */
export function applyDuckedMusicBedTrack(options: {
  project: Project;
  musicAsset: MediaAsset;
  totalTimelineFrames: number;
  fps: number;
  transcriptSegments?: TranscriptSegment[];
  hasSpeechInTimeline: boolean;
}): Project {
  const {
    project,
    musicAsset,
    totalTimelineFrames,
    fps,
    transcriptSegments,
    hasSpeechInTimeline,
  } = options;

  if (totalTimelineFrames <= 10) return project;

  const trackRes = ensureMusicTrack(project);
  let nextProject = trackRes.project;
  const musicTrackId = trackRes.track.id;

  // Idempotencia: limpiar música generada previamente por agente
  const prevTrack = nextProject.tracks.find((t) => t.id === musicTrackId)!;
  const oldAgentIds = prevTrack.clips.filter((c) => c.createdBy === "agent").map((c) => c.id);
  if (oldAgentIds.length > 0) {
    nextProject = touchProject({
      ...nextProject,
      tracks: nextProject.tracks.map((t) =>
        t.id === musicTrackId
          ? { ...t, clips: t.clips.filter((c) => !oldAgentIds.includes(c.id)) }
          : t,
      ),
    });
  }

  const maxAssetFrames = Math.max(
    1,
    Math.floor((musicAsset.durationUs / 1_000_000) * fps),
  );
  const clipDurationFrames = Math.min(totalTimelineFrames, maxAssetFrames);
  if (clipDurationFrames < 10) return nextProject;

  // Calcular volumen óptimo de mezcla considerando presencia de locución
  const duckedVolume =
    !hasSpeechInTimeline
      ? 0.34
      : transcriptSegments && transcriptSegments.length > 0
        ? 0.13
        : 0.16;

  const fadeFrames = Math.min(Math.round(fps * 1.1), Math.floor(clipDurationFrames / 3));

  const musicClip: MediaClip = {
    ...makeMediaClip(nextProject, musicAsset, {
      startFrame: 0,
      durationFrames: clipDurationFrames,
      createdBy: "agent",
    }),
    name: `${musicAsset.name} (Ducking Auto)`,
    volume: duckedVolume,
    fadeInFrames: fadeFrames,
    fadeOutFrames: fadeFrames,
  };

  const added = addClip(nextProject, musicTrackId, musicClip);
  return added.ok ? added.project : nextProject;
}
