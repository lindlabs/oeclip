import {
  type MediaAsset,
  type MediaClip,
  type Project,
  type TextClip,
  type TimelineClip,
  type Track,
} from "./schema";
import {
  frameDurationUs,
  framesToUs,
  usToFrames,
} from "./time";
import {
  getClipById,
  getMediaById,
  getTrackById,
  makeMediaClip,
  makeTextClip,
  timelineDurationFrames,
  touchProject,
  type MediaClipOptions,
  type TextClipInput,
} from "./project";

export type EditResult = { ok: true; project: Project } | { ok: false; error: string };

export function clipEnd(clip: TimelineClip): number {
  return clip.startFrame + clip.durationFrames;
}

export function isMediaClip(clip: TimelineClip): clip is MediaClip {
  return clip.type === "video" || clip.type === "audio" || clip.type === "image";
}

/**
 * Fuente única de verdad (preview en navegador + export FFmpeg/Remotion):
 * determina si un clip debe renderizarse mediante el motor Remotion en vivo.
 */
export function isLiveRemotionClip(clip: TimelineClip): boolean {
  if (!clip.remotion || !clip.remotion.code) return false;
  if (clip.type === "text") return true;
  return clip.remotion.live !== false;
}

export function clipTrackKind(clip: TimelineClip): Track["kind"] {
  if (clip.type === "text") return "text";
  if (clip.type === "audio") return "audio";
  return "video";
}

export function sortClips(clips: TimelineClip[]): TimelineClip[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame);
}

/**
 * Peso de profundidad visual Z (de atrás hacia adelante) para render y preview en vivo:
 * V0/Fondo (0) < V1 Principal (10) < Capa Motion/Overlays (20) < Capa Atmósfera/Look (25)
 * < Subtítulos/Texto (35) < Capa Transiciones (50).
 */
export function visualLayerWeight(track: Pick<Track, "name" | "kind">): number {
  const name = track.name.toLowerCase();
  if (/transici/i.test(name)) return 50;
  if (track.kind === "text" || /subt[íi]tulo|caption/i.test(name)) return 35;
  if (/atm[óo]sfera|look/i.test(name)) return 25;
  if (/motion|overlay|hud|b-?roll|pip/i.test(name)) return 20;
  if (/v0|fondo|ambient|background|canvas/i.test(name)) return 0;
  return 10;
}

/**
 * Ordena pistas visuales de atrás hacia adelante de forma determinista
 * (usado idénticamente en RemotionLiveOverlay y en export Remotion/FFmpeg).
 */
export function sortTracksByVisualZOrder(tracks: Track[]): Track[] {
  const indexMap = new Map(tracks.map((t, idx) => [t.id, idx]));
  return tracks
    .filter((t) => (t.kind === "video" || t.kind === "text") && !t.hidden)
    .sort((a, b) => {
      const wa = visualLayerWeight(a);
      const wb = visualLayerWeight(b);
      if (wa !== wb) return wa - wb;
      // En mismo peso, respetar convención histórica de pistas superiores primero (reverse)
      return (indexMap.get(b.id) ?? 0) - (indexMap.get(a.id) ?? 0);
    });
}

function withTrack(project: Project, trackId: string, updater: (track: Track) => Track): Project {
  return touchProject({
    ...project,
    tracks: project.tracks.map((track) => (track.id === trackId ? updater(track) : track)),
  });
}

export function canPlace(
  project: Project,
  trackId: string,
  startFrame: number,
  durationFrames: number,
  excludeClipId?: string,
): boolean {
  const track = getTrackById(project, trackId);
  if (!track) return false;
  if (track.locked) return false;
  if (startFrame < 0 || durationFrames < 1) return false;
  if (track.kind === "text") return true;
  const end = startFrame + durationFrames;
  return !track.clips.some(
    (clip) => clip.id !== excludeClipId && clip.startFrame < end && clip.startFrame + clip.durationFrames > startFrame,
  );
}

export function addClip(project: Project, trackId: string, clip: TimelineClip): EditResult {
  const track = getTrackById(project, trackId);
  if (!track) return { ok: false, error: "La pista no existe." };
  if (track.locked) return { ok: false, error: "La pista está bloqueada." };
  const expectedKind = clipTrackKind(clip);
  if (track.kind !== expectedKind) {
    return {
      ok: false,
      error: `El clip de tipo ${clip.type} no se puede colocar en una pista ${track.kind}.`,
    };
  }
  if (!canPlace(project, trackId, clip.startFrame, clip.durationFrames)) {
    return { ok: false, error: "El clip se solapa con otro clip de la pista." };
  }
  return {
    ok: true,
    project: withTrack(project, trackId, (current) => ({
      ...current,
      clips: sortClips([...current.clips, clip]),
    })),
  };
}

export function addMediaClip(
  project: Project,
  trackId: string,
  mediaId: string,
  startFrame: number,
  options: MediaClipOptions = {},
): EditResult & { clip?: MediaClip } {
  const asset = getMediaById(project, mediaId);
  if (!asset) return { ok: false, error: "El recurso no existe." };
  const track = getTrackById(project, trackId);
  if (!track) return { ok: false, error: "La pista no existe." };
  const expected = asset.kind === "audio" ? "audio" : "video";
  if (track.kind !== expected) {
    return {
      ok: false,
      error: `Este recurso necesita una pista de ${expected === "video" ? "vídeo" : "audio"}.`,
    };
  }
  const clip = makeMediaClip(project, asset, { ...options, startFrame });
  const result = addClip(project, trackId, clip);
  return result.ok ? { ...result, clip } : result;
}

export function addTextClip(project: Project, trackId: string, input: TextClipInput): EditResult & { clip?: TextClip } {
  const track = getTrackById(project, trackId);
  if (!track) return { ok: false, error: "La pista no existe." };
  if (track.kind !== "text") return { ok: false, error: "Los textos necesitan una pista de texto." };
  const clip = makeTextClip(input);
  const result = addClip(project, trackId, clip);
  return result.ok ? { ...result, clip } : result;
}

export function removeClips(project: Project, clipIds: string[]): EditResult {
  const ids = new Set(clipIds);
  if (ids.size === 0) return { ok: false, error: "No hay clips seleccionados." };
  for (const track of project.tracks) {
    if (track.locked && track.clips.some((clip) => ids.has(clip.id))) {
      return { ok: false, error: `La pista ${track.name} esta bloqueada.` };
    }
  }
  return {
    ok: true,
    project: touchProject({
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !ids.has(clip.id)),
      })),
    }),
  };
}

export function moveClip(
  project: Project,
  clipId: string,
  targetTrackId: string,
  startFrame: number,
): EditResult {
  const found = getClipById(project, clipId);
  if (!found) return { ok: false, error: "El clip no existe." };
  const target = getTrackById(project, targetTrackId);
  if (!target) return { ok: false, error: "La pista de destino no existe." };
  if (found.track.locked || target.locked) return { ok: false, error: "La pista está bloqueada." };
  if (target.kind !== clipTrackKind(found.clip)) {
    return { ok: false, error: "El clip no es compatible con la pista de destino." };
  }
  const nextStart = Math.max(0, Math.round(startFrame));
  if (!canPlace(project, targetTrackId, nextStart, found.clip.durationFrames, clipId)) {
    return { ok: false, error: "El destino se solapa con otro clip." };
  }
  const updated: TimelineClip = { ...found.clip, startFrame: nextStart };
  const tracks = project.tracks.map((track) => {
    let clips = track.clips;
    if (track.id === found.track.id) clips = clips.filter((clip) => clip.id !== clipId);
    if (track.id === targetTrackId) clips = sortClips([...clips, updated]);
    return { ...track, clips };
  });
  return { ok: true, project: touchProject({ ...project, tracks }) };
}

export function trimClipBy(project: Project, clipId: string, edge: "start" | "end", deltaFrames: number): EditResult {
  const found = getClipById(project, clipId);
  if (!found) return { ok: false, error: "El clip no existe." };
  const { clip, track } = found;
  if (track.locked) return { ok: false, error: "La pista está bloqueada." };
  if (deltaFrames === 0) return { ok: true, project };

  const frameUs = frameDurationUs(project.settings.fps);
  const end = clipEnd(clip);
  const previousEnd = Math.max(
    0,
    ...track.clips.filter((other) => other.id !== clip.id && clipEnd(other) <= clip.startFrame).map(clipEnd),
  );
  const nextStart = Math.min(
    Number.POSITIVE_INFINITY,
    ...track.clips
      .filter((other) => other.id !== clip.id && other.startFrame >= end)
      .map((other) => other.startFrame),
  );
  const nextStartSafe = Number.isFinite(nextStart) ? nextStart : Number.POSITIVE_INFINITY;

  if (edge === "start") {
    const allowedDelta = Math.max(-(clip.startFrame - previousEnd), deltaFrames);
    let nextStart = clip.startFrame + allowedDelta;
    let nextDuration = clip.durationFrames - allowedDelta;
    if (nextDuration < 1) return { ok: false, error: "El clip debe conservar al menos un fotograma." };
    let sourceInUs = clip.type === "text" ? 0 : clip.sourceInUs;
    if (clip.type !== "text") {
      const sourceDelta = Math.round(allowedDelta * frameUs * clip.speed);
      sourceInUs = Math.max(0, clip.sourceInUs + sourceDelta);
      const effectiveDelta = Math.round((sourceInUs - clip.sourceInUs) / (frameUs * clip.speed));
      nextStart = clip.startFrame + effectiveDelta;
      nextDuration = clip.durationFrames - effectiveDelta;
      if (nextDuration < 1) return { ok: false, error: "El recorte supera la duración del clip." };
    }
    const updated: TimelineClip =
      clip.type === "text"
        ? { ...clip, startFrame: nextStart, durationFrames: nextDuration }
        : { ...clip, startFrame: nextStart, durationFrames: nextDuration, sourceInUs };
    return {
      ok: true,
      project: withTrack(project, track.id, (current) => ({
        ...current,
        clips: sortClips(current.clips.map((item) => (item.id === clipId ? updated : item))),
      })),
    };
  }

  const allowedGrow = Math.max(0, Math.min(deltaFrames, nextStartSafe - end));
  let nextDuration = Math.max(1, clip.durationFrames + allowedGrow);
  if (deltaFrames < 0) nextDuration = Math.max(1, clip.durationFrames + deltaFrames);
  let sourceOutUs = clip.type === "text" ? 0 : clip.sourceOutUs;
  if (clip.type !== "text") {
    const asset = getMediaById(project, clip.mediaId);
    const maxUs = asset?.kind === "image" ? Number.MAX_SAFE_INTEGER : (asset?.durationUs ?? clip.sourceOutUs);
    const requestedOut = Math.round(clip.sourceInUs + nextDuration * frameUs * clip.speed);
    sourceOutUs = Math.min(maxUs, requestedOut);
    const effectiveDuration = Math.max(
      1,
      Math.round((sourceOutUs - clip.sourceInUs) / (frameUs * clip.speed)),
    );
    if (deltaFrames > 0 && effectiveDuration < nextDuration) {
      return { ok: false, error: "No hay más material de origen para alargar el clip." };
    }
    nextDuration = Math.min(nextDuration, effectiveDuration);
  }
  const updated: TimelineClip =
    clip.type === "text"
      ? { ...clip, durationFrames: nextDuration }
      : { ...clip, durationFrames: nextDuration, sourceOutUs };
  return {
    ok: true,
    project: withTrack(project, track.id, (current) => ({
      ...current,
      clips: sortClips(current.clips.map((item) => (item.id === clipId ? updated : item))),
    })),
  };
}

export function splitClipAt(project: Project, clipId: string, frame: number): EditResult & { leftId?: string; rightId?: string } {
  const found = getClipById(project, clipId);
  if (!found) return { ok: false, error: "El clip no existe." };
  const { clip, track } = found;
  if (track.locked) return { ok: false, error: "La pista está bloqueada." };
  const at = Math.round(frame);
  if (at <= clip.startFrame || at >= clipEnd(clip)) {
    return { ok: false, error: "El punto de corte debe estar dentro del clip." };
  }
  const leftDuration = at - clip.startFrame;
  const rightDuration = clip.durationFrames - leftDuration;
  let left: TimelineClip;
  let right: TimelineClip;
  if (clip.type === "text") {
    left = { ...clip, durationFrames: leftDuration };
    right = { ...clip, id: `${clip.id}_b`, startFrame: at, durationFrames: rightDuration };
  } else {
    const frameUs = frameDurationUs(project.settings.fps);
    const splitUs = Math.round(clip.sourceInUs + leftDuration * frameUs * clip.speed);
    left = { ...clip, durationFrames: leftDuration, sourceOutUs: splitUs };
    right = {
      ...clip,
      id: `${clip.id}_b`,
      startFrame: at,
      durationFrames: rightDuration,
      sourceInUs: splitUs,
      sourceOutUs: clip.sourceOutUs,
    };
  }
  if (clip.type !== "text" && left.type !== "text" && left.sourceOutUs <= 0) {
    return { ok: false, error: "El corte no produce material válido." };
  }
  const rightId = ensureUniqueClipId(project, right.id);
  right = { ...right, id: rightId };
  return {
    ok: true,
    leftId: clip.id,
    rightId,
    project: withTrack(project, track.id, (current) => ({
      ...current,
      clips: sortClips(current.clips.flatMap((item) => (item.id === clipId ? [left, right] : [item]))),
    })),
  };
}

function ensureUniqueClipId(project: Project, preferred: string): string {
  const ids = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  if (!ids.has(preferred)) return preferred;
  let index = 2;
  while (ids.has(`${preferred}_${index}`)) index += 1;
  return `${preferred}_${index}`;
}

export function setClipSpeed(project: Project, clipId: string, speed: number): EditResult {
  const found = getClipById(project, clipId);
  if (!found) return { ok: false, error: "El clip no existe." };
  const { clip, track } = found;
  if (track.locked) return { ok: false, error: "La pista está bloqueada." };
  if (clip.type === "text") return { ok: false, error: "Los textos no admiten cambio de velocidad." };
  const safeSpeed = Math.min(4, Math.max(0.25, Math.round(speed * 100) / 100));
  const frameUs = frameDurationUs(project.settings.fps);
  const nextDuration = Math.max(
    1,
    clip.type === "image"
      ? Math.round((clip.durationFrames * clip.speed) / safeSpeed)
      : Math.round((clip.sourceOutUs - clip.sourceInUs) / (frameUs * safeSpeed)),
  );
  if (!canPlace(project, track.id, clip.startFrame, nextDuration, clip.id)) {
    return { ok: false, error: "La nueva duración se solapa con el siguiente clip." };
  }
  const updated: MediaClip = {
    ...clip,
    speed: safeSpeed,
    durationFrames: nextDuration,
    fadeInFrames: Math.min(clip.fadeInFrames, Math.floor(nextDuration / 2)),
    fadeOutFrames: Math.min(clip.fadeOutFrames, Math.floor(nextDuration / 2)),
  };
  return {
    ok: true,
    project: withTrack(project, track.id, (current) => ({
      ...current,
      clips: current.clips.map((item) => (item.id === clipId ? updated : item)),
    })),
  };
}

export function updateClip(project: Project, clipId: string, updater: (clip: TimelineClip) => TimelineClip): EditResult {
  const found = getClipById(project, clipId);
  if (!found) return { ok: false, error: "El clip no existe." };
  if (found.track.locked) return { ok: false, error: "La pista está bloqueada." };
  const updated = updater(found.clip);
  if (updated.startFrame !== found.clip.startFrame || updated.durationFrames !== found.clip.durationFrames) {
    if (
      updated.startFrame < 0 ||
      !canPlace(project, found.track.id, updated.startFrame, updated.durationFrames, clipId)
    ) {
      return { ok: false, error: "La modificación provoca un solapamiento o una posición inválida." };
    }
  }
  return {
    ok: true,
    project: withTrack(project, found.track.id, (track) => ({
      ...track,
      clips: sortClips(track.clips.map((clip) => (clip.id === clipId ? updated : clip))),
    })),
  };
}

export function duplicateClip(project: Project, clipId: string): EditResult & { newClipId?: string } {
  const found = getClipById(project, clipId);
  if (!found) return { ok: false, error: "El clip no existe." };
  const start = clipEnd(found.clip);
  const copy = { ...found.clip, id: `${found.clip.id}_copy`, startFrame: start };
  if (!canPlace(project, found.track.id, start, copy.durationFrames)) {
    return { ok: false, error: "No hay espacio libre después del clip." };
  }
  const result = addClip(project, found.track.id, copy);
  return result.ok ? { ...result, newClipId: copy.id } : result;
}

export function addTrack(project: Project, kind: Track["kind"], name?: string): EditResult & { track?: Track } {
  if (project.tracks.length >= 24) return { ok: false, error: "Se alcanzó el máximo de 24 pistas." };
  const count = project.tracks.filter((track) => track.kind === kind).length + 1;
  const defaultName = kind === "video" ? `V${count}` : kind === "audio" ? `A${count}` : `T${count}`;
  const track: Track = {
    id: `${kind.slice(0, 3)}_${Math.random().toString(36).slice(2, 10)}`,
    kind,
    name: name?.trim() || defaultName,
    clips: [],
    muted: false,
    hidden: false,
    locked: false,
    volume: 1,
  };
  let tracks: Track[];
  if (kind === "video" || kind === "text") {
    tracks = [track, ...project.tracks];
  } else {
    const lastSame = project.tracks.map((item) => item.kind).lastIndexOf(kind);
    tracks = [...project.tracks];
    if (lastSame >= 0) tracks.splice(lastSame + 1, 0, track);
    else tracks.push(track);
  }
  return { ok: true, project: touchProject({ ...project, tracks }), track };
}

export function removeTrack(project: Project, trackId: string): EditResult {
  if (project.tracks.length <= 1) return { ok: false, error: "El proyecto necesita al menos una pista." };
  const track = getTrackById(project, trackId);
  if (!track) return { ok: false, error: "La pista no existe." };
  if (track.clips.length > 0) return { ok: false, error: "Vacia la pista antes de eliminarla." };
  return {
    ok: true,
    project: touchProject({ ...project, tracks: project.tracks.filter((item) => item.id !== trackId) }),
  };
}

export function setTrackFlag(project: Project, trackId: string, flag: "muted" | "hidden" | "locked", value: boolean): Project {
  return withTrack(project, trackId, (track) => ({ ...track, [flag]: value }));
}

export function setTrackVolume(project: Project, trackId: string, volume: number): Project {
  return withTrack(project, trackId, (track) => ({ ...track, volume: Math.min(2, Math.max(0, volume)) }));
}

export function splitAtFrame(project: Project, frame: number, clipIds?: string[]): EditResult & { newIds?: string[] } {
  const targets = project.tracks
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        (!clipIds || clipIds.includes(clip.id)) && clip.startFrame < frame && clipEnd(clip) > frame,
    );
  if (targets.length === 0) return { ok: false, error: "No hay clips bajo el cursor para dividir." };
  let current = project;
  const newIds: string[] = [];
  for (const clip of targets) {
    const result = splitClipAt(current, clip.id, frame);
    if (!result.ok) return { ok: false, error: result.error };
    current = result.project;
    if (result.rightId) newIds.push(result.rightId);
  }
  return { ok: true, project: current, newIds };
}

export function selectionClips(project: Project, ids: string[]): TimelineClip[] {
  const set = new Set(ids);
  return project.tracks.flatMap((track) => track.clips.filter((clip) => set.has(clip.id)));
}

export function rippleShiftAfter(project: Project, trackId: string, afterFrame: number, deltaFrames: number): Project {
  return withTrack(project, trackId, (track) => ({
    ...track,
    clips: sortClips(
      track.clips.map((clip) =>
        clip.startFrame >= afterFrame
          ? { ...clip, startFrame: Math.max(0, clip.startFrame + deltaFrames) }
          : clip,
      ),
    ),
  }));
}

export interface SourceRange {
  startUs: number;
  endUs: number;
}

/**
 * Sustituye un clip por los intervalos de origen indicados, colocados de forma
 * consecutiva (ripple). Desplaza los clips posteriores de la misma pista.
 */
export function applySourceRanges(project: Project, clipId: string, ranges: SourceRange[]): EditResult {
  const found = getClipById(project, clipId);
  if (!found) return { ok: false, error: "El clip no existe." };
  const { clip, track } = found;
  if (track.locked) return { ok: false, error: "La pista está bloqueada." };
  if (!isMediaClip(clip)) return { ok: false, error: "Solo se pueden recortar clips multimedia." };
  const asset = getMediaById(project, clip.mediaId);
  if (!asset) return { ok: false, error: "El recurso no existe." };
  const frameUs = frameDurationUs(project.settings.fps);
  const normalized = ranges
    .map((range) => ({
      startUs: Math.max(clip.sourceInUs, Math.round(range.startUs)),
      endUs: Math.min(clip.sourceOutUs, Math.round(range.endUs)),
    }))
    .filter((range) => range.endUs - range.startUs > 50_000)
    .sort((a, b) => a.startUs - b.startUs);

  if (normalized.length === 0) return { ok: false, error: "No quedan intervalos de material tras el análisis." };

  let cursor = clip.startFrame;
  const replacement: MediaClip[] = normalized.map((range, index) => {
    const duration = Math.max(1, Math.round((range.endUs - range.startUs) / (frameUs * clip.speed)));
    const next: MediaClip = {
      ...clip,
      id: `${clip.id}_seg${index + 1}`,
      startFrame: cursor,
      durationFrames: duration,
      sourceInUs: range.startUs,
      sourceOutUs: range.endUs,
      name: `${clip.name} · ${index + 1}`,
      fadeInFrames: index === 0 ? Math.min(clip.fadeInFrames, duration) : 0,
      fadeOutFrames: index === normalized.length - 1 ? Math.min(clip.fadeOutFrames, duration) : 0,
    };
    cursor += duration;
    return next;
  });

  const originalEnd = clipEnd(clip);
  const totalRemoved = originalEnd - cursor;
  const tracks = project.tracks.map((current) => {
    if (current.id !== track.id) return current;
    const others = current.clips
      .filter((item) => item.id !== clipId)
      .map((item) =>
        item.startFrame >= originalEnd ? { ...item, startFrame: Math.max(0, item.startFrame - totalRemoved) } : item,
      );
    return { ...current, clips: sortClips([...others, ...replacement]) };
  });

  // Comprobación de solapamientos resultantes en la pista.
  const updatedTrack = tracks.find((current) => current.id === track.id)!;
  for (let i = 1; i < updatedTrack.clips.length; i += 1) {
    const prev = updatedTrack.clips[i - 1];
    const curr = updatedTrack.clips[i];
    if (prev && curr && prev.startFrame + prev.durationFrames > curr.startFrame) {
      return { ok: false, error: "El montaje resultante produce solapamientos." };
    }
  }
  void asset;
  return { ok: true, project: touchProject({ ...project, tracks }) };
}

export function insertClipsAt(project: Project, trackId: string, clips: TimelineClip[]): EditResult {
  const track = getTrackById(project, trackId);
  if (!track) return { ok: false, error: "La pista no existe." };
  let current = project;
  for (const clip of clips) {
    const result = addClip(current, trackId, clip);
    if (!result.ok) return result;
    current = result.project;
  }
  return { ok: true, project: current };
}

export const MOTION_OVERLAY_TRACK_NAME = "Motion Overlay";

/**
 * Pista de vídeo dedicada para motion graphics. Al crearse se inserta al
 * principio de la lista, de modo que se dibuja por encima del vídeo base.
 */
export function ensureMotionOverlayTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (track) => track.kind === "video" && track.name === MOTION_OVERLAY_TRACK_NAME,
  );
  if (existing) return { project, track: existing };
  const result = addTrack(project, "video", MOTION_OVERLAY_TRACK_NAME);
  if (!result.ok || !result.track) {
    throw new Error(result.ok ? "No se pudo crear la pista de overlay." : result.error);
  }
  return { project: result.project, track: result.track };
}

export const SFX_TRACK_NAME = "SFX";

/**
 * Pista de audio dedicada para Sound Design sincronizado (whoosh, pop, ding).
 */
export function ensureSfxTrack(project: Project): { project: Project; track: Track } {
  const existing = project.tracks.find(
    (track) => track.kind === "audio" && track.name === SFX_TRACK_NAME,
  );
  if (existing) return { project, track: existing };
  const result = addTrack(project, "audio", SFX_TRACK_NAME);
  if (!result.ok || !result.track) {
    throw new Error(result.ok ? "No se pudo crear la pista de SFX." : result.error);
  }
  return { project: result.project, track: result.track };
}

/**
 * Devuelve el primer fotograma libre de la pista a partir de `startFrame`,
 * desplazándose hacia delante si el hueco solicitado está ocupado.
 */
export function findFreeStartFrame(track: Track, startFrame: number, durationFrames: number): number {
  let start = Math.max(0, Math.round(startFrame));
  const clips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
  let moved = true;
  while (moved) {
    moved = false;
    for (const clip of clips) {
      const overlaps = start < clip.startFrame + clip.durationFrames && start + durationFrames > clip.startFrame;
      if (overlaps) {
        start = clip.startFrame + clip.durationFrames;
        moved = true;
      }
    }
  }
  return start;
}

export function durationSecondsToFrames(project: Project, seconds: number): number {
  return Math.max(1, Math.round(seconds / (frameDurationUs(project.settings.fps) / 1_000_000)));
}

export function sourceSecondsToUs(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1_000_000));
}

export { timelineDurationFrames, framesToUs, usToFrames };
