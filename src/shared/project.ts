import {
  type AgentMessage,
  type ExportRecord,
  type MediaAsset,
  type MediaClip,
  type Project,
  type ProjectSettings,
  type TextClip,
  type TimelineClip,
  type Track,
} from "./schema";
import { newId, framesToUs, frameDurationUs } from "./time";
import { dimensionsFor } from "./presets";
import { withSubtitleStyle } from "./subtitles";

export const SCHEMA_VERSION = 1 as const;

export function defaultSettings(width = 1920, height = 1080, fps = 30): ProjectSettings {
  const aspect =
    Math.abs(width / height - 9 / 16) < 0.02
      ? "9:16"
      : Math.abs(width / height - 1) < 0.02
        ? "1:1"
        : Math.abs(width / height - 4 / 5) < 0.02
          ? "4:5"
          : "16:9";
  return {
    width,
    height,
    fps: fps === 29.97 ? { num: 30000, den: 1001 } : { num: Math.round(fps), den: 1 },
    aspect,
    sampleRate: 48000,
  };
}

export function createTrack(kind: Track["kind"], name: string): Track {
  return {
    id: newId("trk"),
    kind,
    name,
    clips: [],
    muted: false,
    hidden: false,
    locked: false,
    volume: 1,
  };
}

export function createProject(name = "Proyecto sin título", settings?: ProjectSettings): Project {
  const now = new Date().toISOString();
  const resolved = settings ?? defaultSettings();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId("prj"),
    name,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    settings: resolved,
    media: [],
    tracks: [createTrack("video", "V1"), createTrack("audio", "A1"), createTrack("text", "T1")],
    exports: [],
    agentMessages: [],
  };
}

export function createProjectForResolution(
  name: string,
  aspect: ProjectSettings["aspect"],
  height: number,
  fps: number,
): Project {
  const dims = dimensionsFor(aspect, height);
  return createProject(name, {
    width: dims.width,
    height: dims.height,
    fps: fps === 29.97 ? { num: 30000, den: 1001 } : { num: Math.round(fps), den: 1 },
    aspect,
    sampleRate: 48000,
  });
}

/**
 * Auto-Reframe Inteligente: Adapta el proyecto entre 16:9, 9:16 (TikTok/Shorts/Reels), 1:1, etc.
 * Recalcula dimensiones pares exactas y re-encuadra automáticamente los clips de video/imagen
 * para llenar el lienzo sin bandas negras, respetando la zona segura en componentes Remotion.
 */
export function autoReframeProject(
  project: Project,
  aspect: ProjectSettings["aspect"],
  resolution = 1080,
): Project {
  const dims = dimensionsFor(aspect, resolution);
  const targetAspect = dims.width / dims.height;

  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (clip.type === "text") return clip;
      const asset = project.media.find((m) => m.id === clip.mediaId);
      if (!asset || !asset.width || !asset.height) return clip;
      const rotated = Boolean(asset.rotation && Math.abs(asset.rotation % 180) === 90);
      const sourceWidth = rotated ? asset.height! : asset.width;
      const sourceHeight = rotated ? asset.width : asset.height!;
      const baseWidth = Math.max(0.01, 1 - clip.crop.left - clip.crop.right);
      const baseHeight = Math.max(0.01, 1 - clip.crop.top - clip.crop.bottom);
      const currentAspect = (sourceWidth / sourceHeight) * (baseWidth / baseHeight);
      if (Math.abs(currentAspect - targetAspect) < 0.005) {
        return { ...clip, transform: { ...clip.transform, x: 0, y: 0 } };
      }
      const next = { ...clip.crop };
      if (currentAspect > targetAspect) {
        const keep = targetAspect / currentAspect;
        const cut = ((1 - keep) / 2) * baseWidth;
        next.left = Math.min(0.48, clip.crop.left + cut);
        next.right = Math.min(0.48, clip.crop.right + cut);
      } else {
        const keep = currentAspect / targetAspect;
        const cut = ((1 - keep) / 2) * baseHeight;
        next.top = Math.min(0.48, clip.crop.top + cut);
        next.bottom = Math.min(0.48, clip.crop.bottom + cut);
      }
      return { ...clip, crop: next, transform: { ...clip.transform, x: 0, y: 0 } };
    }),
  }));

  if (aspect === "9:16") {
    const v1Track = tracks.find(
      (t) =>
        t.kind === "video" &&
        !/motion|overlay|transici|v0|fondo\s*ambient/i.test(t.name) &&
        t.clips.some((c) => c.type === "video"),
    );
    if (v1Track) {
      const existingAmbient = tracks.find(
        (t) => t.kind === "video" && (t.name === "V0" || /fondo\s+ambient/i.test(t.name)),
      );
      const ambientClips: MediaClip[] = v1Track.clips
        .filter((c): c is MediaClip => c.type === "video")
        .map((c) => ({
          ...c,
          id: `clp_amb_${newId("clp")}`,
          name: `Fondo Ambiental · ${c.name}`,
          volume: 0,
          transform: {
            ...c.transform,
            scale: 2.2,
            opacity: 0.85,
          },
          adjustments: {
            brightness: 0.65,
            contrast: 1.15,
            saturation: 1.35,
          },
          createdBy: "agent" as const,
        }));

      if (existingAmbient) {
        existingAmbient.clips = ambientClips;
      } else if (ambientClips.length > 0) {
        const ambientTrack: Track = {
          id: `trk_v0_${newId("trk")}`,
          kind: "video",
          name: "V0 (Fondo Ambiental)",
          clips: ambientClips,
          muted: true,
          hidden: false,
          locked: false,
          volume: 0,
        };
        const v1Index = tracks.findIndex((t) => t.id === v1Track.id);
        // Colocar la pista ambiental en la capa inferior (detrás de V1)
        tracks.splice(v1Index + 1, 0, ambientTrack);
      }
    }
  }

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    settings: {
      ...project.settings,
      aspect,
      width: dims.width,
      height: dims.height,
    },
    tracks,
  };
}

export interface MediaClipOptions {
  startFrame?: number;
  sourceInUs?: number;
  sourceOutUs?: number;
  durationFrames?: number;
  createdBy?: MediaClip["createdBy"];
}

export function mediaClipDurationFrames(project: Project, sourceInUs: number, sourceOutUs: number, speed: number): number {
  const us = (sourceOutUs - sourceInUs) / Math.max(0.01, speed);
  return Math.max(1, Math.round(us / frameDurationUs(project.settings.fps)));
}

export function makeMediaClip(project: Project, asset: MediaAsset, options: MediaClipOptions = {}): MediaClip {
  const startFrame = Math.max(0, Math.round(options.startFrame ?? 0));
  const sourceInUs = Math.max(0, Math.round(options.sourceInUs ?? 0));
  const maxUs = asset.kind === "image" ? 5_000_000 : Math.max(1, asset.durationUs);
  const sourceOutUs = Math.min(maxUs, Math.max(sourceInUs + 1000, Math.round(options.sourceOutUs ?? maxUs)));
  const speed = 1;
  const durationFrames =
    options.durationFrames ??
    (asset.kind === "image" ? 150 : mediaClipDurationFrames(project, sourceInUs, sourceOutUs, speed));
  return {
    id: newId("clp"),
    type: asset.kind,
    name: asset.name,
    startFrame,
    durationFrames: Math.max(1, Math.round(durationFrames)),
    mediaId: asset.id,
    sourceInUs,
    sourceOutUs,
    speed,
    volume: 1,
    opacity: 1,
    transform: {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      animationIn: "none",
      animationInDuration: 30,
      animationOut: "none",
      animationOutDuration: 30,
    },
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    adjustments: { brightness: 1, contrast: 1, saturation: 1 },
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transitionType: "none",
    audioEnhance: "none",
    createdBy: options.createdBy ?? "user",
  };
}

export interface TextClipInput {
  name?: string;
  text: string;
  startFrame: number;
  durationFrames: number;
  role?: TextClip["role"];
  position?: { x: number; y: number };
  fontSize?: number;
  color?: string;
  background?: boolean;
  maxWidth?: number;
  fontWeight?: TextClip["fontWeight"];
  fadeFrames?: number;
  createdBy?: TextClip["createdBy"];
  sourceMediaId?: string;
  styleId?: string;
  fontFamily?: TextClip["fontFamily"];
  textTransform?: TextClip["textTransform"];
  backgroundColor?: string;
  backgroundOpacity?: number;
  backgroundPadding?: number;
  strokeWidth?: number;
  strokeColor?: string;
  shadow?: number;
  shadowColor?: string;
  lineHeight?: number;
  opacity?: number;
  animationIn?: "none" | "fade-in" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "zoom-in" | "bounce-in";
  animationInDuration?: number;
  animationOut?: "none" | "fade-out" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "zoom-out" | "bounce-out";
  animationOutDuration?: number;
  graphic?: TextClip["graphic"];
  remotion?: TextClip["remotion"];
}

export function makeTextClip(input: TextClipInput): TextClip {
  const role = input.role ?? "title";
  const base: TextClip = {
    id: newId("txt"),
    type: "text",
    name: (input.name ?? input.text).slice(0, 80),
    startFrame: Math.max(0, Math.round(input.startFrame)),
    durationFrames: Math.max(1, Math.round(input.durationFrames)),
    text: input.text,
    role,
    fontSize: input.fontSize ?? (role === "subtitle" ? 46 : 72),
    fontWeight: input.fontWeight ?? (role === "title" ? 600 : 500),
    color: input.color ?? "#FFFFFF",
    background: input.background ?? role === "subtitle",
    backgroundOpacity: input.backgroundOpacity ?? (role === "subtitle" ? 0.55 : 0.35),
    backgroundColor: input.backgroundColor ?? "#101813",
    backgroundPadding: input.backgroundPadding ?? (role === "subtitle" ? 14 : 12),
    fontFamily: input.fontFamily ?? "inter",
    textTransform: input.textTransform ?? "none",
    strokeWidth: input.strokeWidth ?? 0,
    strokeColor: input.strokeColor ?? "#000000",
    shadow: input.shadow ?? (role === "subtitle" ? 6 : 4),
    shadowColor: input.shadowColor ?? "#000000",
    position: input.position ?? (role === "subtitle" ? { x: 0.5, y: 0.86 } : { x: 0.5, y: 0.5 }),
    align: "center",
    maxWidth: input.maxWidth ?? (role === "subtitle" ? 0.8 : 0.72),
    lineHeight: input.lineHeight ?? 1.2,
    opacity: input.opacity ?? 1,
    animationIn: input.animationIn ?? "none",
    animationInDuration: input.animationInDuration ?? 30,
    animationOut: input.animationOut ?? "none",
    animationOutDuration: input.animationOutDuration ?? 30,
    fadeFrames: input.fadeFrames ?? (role === "subtitle" ? 2 : 8),
    createdBy: input.createdBy ?? "user",
    sourceMediaId: input.sourceMediaId,
    ...(input.graphic ? { graphic: input.graphic } : {}),
    ...(input.remotion ? { remotion: input.remotion } : {}),
  };
  return input.styleId ? withSubtitleStyle(base, input.styleId) : base;
}

export function getTrackById(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((track) => track.id === trackId);
}

export function getMediaById(project: Project, mediaId: string): MediaAsset | undefined {
  return project.media.find((asset) => asset.id === mediaId);
}

export function getClipById(
  project: Project,
  clipId: string,
): { track: Track; clip: TimelineClip; index: number } | undefined {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    const clip = index >= 0 ? track.clips[index] : undefined;
    if (clip) return { track, clip, index };
  }
  return undefined;
}

export function timelineDurationFrames(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.startFrame + clip.durationFrames);
    }
  }
  return max;
}

export function projectDurationSeconds(project: Project): number {
  return framesToUs(timelineDurationFrames(project), project.settings.fps) / 1_000_000;
}

export function firstVideoTrack(project: Project): Track | undefined {
  return (
    project.tracks.find(
      (track) =>
        track.kind === "video" &&
        !/motion|overlay|subt|transici|v0|fondo\s*ambient/i.test(track.name) &&
        track.clips.some((c) => c.type === "video"),
    ) ??
    project.tracks.find(
      (track) =>
        track.kind === "video" &&
        !/motion|overlay|subt|transici|v0|fondo\s*ambient/i.test(track.name),
    ) ??
    project.tracks.find((track) => track.kind === "video")
  );
}

export function firstAudioTrack(project: Project): Track | undefined {
  return project.tracks.find((track) => track.kind === "audio");
}

export function firstTextTrack(project: Project): Track | undefined {
  return project.tracks.find((track) => track.kind === "text");
}

export function ensureTrack(project: Project, kind: Track["kind"]): Track {
  const existing = project.tracks.find((track) => track.kind === kind);
  if (existing) return existing;
  const track = createTrack(kind, kind === "video" ? "V1" : kind === "audio" ? "A1" : "T1");
  project.tracks.push(track);
  return track;
}

export function touchProject(project: Project): Project {
  return { ...project, updatedAt: new Date().toISOString() };
}

export function createAgentMessage(
  role: AgentMessage["role"],
  text: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    id: newId("msg"),
    role,
    text,
    at: new Date().toISOString(),
    kind: extra.kind ?? "text",
    ...extra,
  };
}

/** Crea un mensaje interactivo con tarjetas clickeables dentro del chat. */
export function createInteractiveCardsMessage(
  title: string,
  chatText: string,
  cards: AgentMessage["cards"],
): AgentMessage {
  return createAgentMessage("assistant", chatText, {
    kind: "interactive_cards",
    interactiveTitle: title,
    interactiveText: chatText,
    cards,
  });
}

/** Crea un mensaje de confirmación de acción aplicada. */
export function createActionFeedbackMessage(label: string, detail: string): AgentMessage {
  return createAgentMessage("assistant", label, {
    kind: "action_feedback",
    actionLabel: label,
    actionDetail: detail,
  });
}

/** Crea un mensaje con chips de sugerencias rápidas. */
export function createSuggestionChipsMessage(text: string, suggestions: AgentMessage["suggestions"]): AgentMessage {
  return createAgentMessage("assistant", text, {
    kind: "suggestion_chips",
    suggestions,
  });
}

/** Resumen compacto para el agente: no incluye rutas ni datos binarios. */
export function projectSummary(project: Project) {
  const duration = timelineDurationFrames(project);
  return {
    projectId: project.id,
    name: project.name,
    settings: project.settings,
    durationFrames: duration,
    durationSeconds: Number((framesToUs(duration, project.settings.fps) / 1_000_000).toFixed(3)),
    media: project.media.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      durationSeconds: Number((asset.durationUs / 1_000_000).toFixed(3)),
      width: asset.width,
      height: asset.height,
      fps: asset.fps ? Number((asset.fps.num / asset.fps.den).toFixed(3)) : undefined,
      hasAudio: Boolean(asset.audioCodec),
      missing: asset.missing ?? false,
    })),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      muted: track.muted,
      hidden: track.hidden,
      locked: track.locked,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        type: clip.type,
        name: clip.name,
        startFrame: clip.startFrame,
        endFrame: clip.startFrame + clip.durationFrames,
        durationFrames: clip.durationFrames,
        ...(clip.type === "text"
          ? { text: clip.text }
          : { mediaId: clip.mediaId, sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs, speed: clip.speed }),
      })),
    })),
    textClips: project.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .filter((clip): clip is TextClip => clip.type === "text")
      .map((clip) => ({ id: clip.id, text: clip.text, role: clip.role, startFrame: clip.startFrame })),
    recentExports: project.exports.slice(-3),
  };
}

export function latestExport(project: Project): ExportRecord | undefined {
  return project.exports.at(-1);
}

