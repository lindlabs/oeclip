import type { MediaAsset } from "../../src/shared/schema";
import { HttpError } from "../util/fs";
import { requireMediaFile } from "./library";
import { runFfmpeg } from "./process";
import type { SourceRange } from "../../src/shared/timeline";

export interface SilenceInterval {
  startUs: number;
  endUs: number;
  durationUs: number;
}

export async function detectSilences(
  projectId: string,
  asset: MediaAsset,
  options: { thresholdDb: number; minSilenceSec: number },
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<{ intervals: SilenceInterval[]; analyzedUs: number }> {
  const file = await requireMediaFile(projectId, asset);
  if (asset.durationUs <= 0) throw new HttpError(422, "El recurso no tiene audio analizable.", "no_audio");
  const threshold = Math.min(-5, Math.max(-80, options.thresholdDb));
  const minSilence = Math.min(30, Math.max(0.1, options.minSilenceSec));
  const starts: number[] = [];
  const ends: number[] = [];
  await runFfmpeg(
    [
      "-i",
      file,
      "-vn",
      "-af",
      `silencedetect=noise=${threshold}dB:d=${minSilence}`,
      "-f",
      "null",
      "-",
    ],
    {
      signal,
      durationSeconds: asset.durationUs / 1_000_000,
      timeoutMs: 30 * 60_000,
      onProgress: (progress) => onProgress?.(progress.progress),
      onStderrLine: (line) => {
        const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (startMatch?.[1]) starts.push(Math.max(0, Number(startMatch[1])));
        const endMatch = /silence_end:\s*(-?[\d.]+)/.exec(line);
        if (endMatch?.[1]) ends.push(Math.max(0, Number(endMatch[1])));
      },
    },
  );
  const durationSec = asset.durationUs / 1_000_000;
  const intervals: SilenceInterval[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const startUs = Math.round((starts[i] ?? 0) * 1_000_000);
    const endUs = Math.round(Math.min(durationSec, ends[i] ?? durationSec) * 1_000_000);
    if (endUs - startUs >= minSilence * 1_000_000 * 0.8) {
      intervals.push({ startUs, endUs, durationUs: endUs - startUs });
    }
  }
  return { intervals, analyzedUs: asset.durationUs };
}

export async function detectScenes(
  projectId: string,
  asset: MediaAsset,
  options: { threshold: number },
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<number[]> {
  if (asset.kind !== "video") throw new HttpError(422, "La detección de escenas requiere un video.", "not_video");
  const file = await requireMediaFile(projectId, asset);
  const threshold = Math.min(0.9, Math.max(0.05, options.threshold));
  const times: number[] = [];
  await runFfmpeg(
    [
      "-i",
      file,
      "-an",
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ],
    {
      signal,
      durationSeconds: asset.durationUs / 1_000_000,
      timeoutMs: 30 * 60_000,
      onProgress: (progress) => onProgress?.(progress.progress),
      onStderrLine: (line) => {
        const match = /pts_time:\s*([\d.]+)/.exec(line);
        if (match?.[1]) {
          const value = Number(match[1]);
          if (Number.isFinite(value) && value > 0.05) times.push(value);
        }
      },
    },
  );
  return [...new Set(times.map((time) => Number(time.toFixed(3))))].sort((a, b) => a - b).slice(0, 500);
}

export async function measureLoudness(
  projectId: string,
  asset: MediaAsset,
  signal: AbortSignal,
): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> {
  const file = await requireMediaFile(projectId, asset);
  let integratedLufs: number | null = null;
  let truePeakDb: number | null = null;
  await runFfmpeg(["-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], {
    signal,
    durationSeconds: asset.durationUs / 1_000_000,
    timeoutMs: 30 * 60_000,
    onStderrLine: (line) => {
      const integrated = /I:\s*(-?[\d.]+)\s*LUFS/.exec(line);
      if (integrated?.[1] && integratedLufs === null) integratedLufs = Number(integrated[1]);
      const peak = /Peak:\s*(-?[\d.]+)\s*dBFS/.exec(line);
      if (peak?.[1]) truePeakDb = Number(peak[1]);
    },
  });
  return { integratedLufs, truePeakDb };
}

export interface NaturalKeepRangeOptions {
  /** Colchón antes de que empiece a hablar (ataque vocal natural, J-cut sutil) */
  prePadSec?: number;
  /** Colchón después de terminar una frase (cola consonántica y respiración natural, L-cut sutil) */
  postPadSec?: number;
  /** Duración mínima de un hueco tras aplicar padding para que merezca un corte */
  minCutGapSec?: number;
  /** Duración mínima de un fragmento conservado */
  minKeepSec?: number;
  /** Inicio real de la primera palabra hablada (Whisper) para podar silencios muertos al inicio */
  firstWordStartUs?: number;
  /** Fin real de la última palabra hablada (Whisper) para podar silencios muertos al final */
  lastWordEndUs?: number;
}

/**
 * Convierte silencios detectados en intervalos de material a conservar, con
 * margen asimétrico de seguridad (J/L-cut orgánico) para no cortar ataques
 * ni colas de frases y podar silencios muertos al inicio/final del video.
 */
export function keepRangesNatural(
  sourceStartUs: number,
  sourceEndUs: number,
  silences: SilenceInterval[],
  options: NaturalKeepRangeOptions = {},
): SourceRange[] {
  // Márgenes asimétricos orgánicos para preservar ataques consonánticos y colas vocálicas
  const prePadUs = Math.round(Math.max(0.10, options.prePadSec ?? 0.20) * 1_000_000);
  const postPadUs = Math.round(Math.max(0.12, options.postPadSec ?? 0.28) * 1_000_000);
  // Gaps menores a 0.55s tras padding no se cortan para preservar la respiración y cadencia natural
  const minCutGapUs = Math.round(Math.max(0.25, options.minCutGapSec ?? 0.55) * 1_000_000);
  // Fragmentos menores a 0.75s no se aíslan como micro-clips individuales
  const minKeepUs = Math.round(Math.max(0.30, options.minKeepSec ?? 0.75) * 1_000_000);

  // Si tenemos marcas de tiempo reales de voz (Whisper), recortamos el aire muerto inicial y final
  let effectiveStartUs = sourceStartUs;
  let effectiveEndUs = sourceEndUs;

  if (
    typeof options.firstWordStartUs === "number" &&
    Number.isFinite(options.firstWordStartUs) &&
    options.firstWordStartUs > sourceStartUs + 450_000
  ) {
    effectiveStartUs = Math.max(sourceStartUs, options.firstWordStartUs - Math.max(prePadUs, 220_000));
  }

  if (
    typeof options.lastWordEndUs === "number" &&
    Number.isFinite(options.lastWordEndUs) &&
    options.lastWordEndUs > effectiveStartUs + 500_000 &&
    options.lastWordEndUs < sourceEndUs - 450_000
  ) {
    effectiveEndUs = Math.min(sourceEndUs, options.lastWordEndUs + Math.max(postPadUs, 320_000));
  }

  // En cada intervalo de silencio [interval.startUs, interval.endUs]:
  // - interval.startUs es donde terminó de hablar la frase anterior -> dejamos postPadUs de cola natural
  // - interval.endUs es donde empieza a hablar la frase siguiente -> dejamos prePadUs de ataque natural
  const cuts = silences
    .map((interval) => {
      const isLeadingSilence = interval.startUs <= effectiveStartUs + 180_000;
      const isTrailingSilence = interval.endUs >= effectiveEndUs - 180_000;
      return {
        startUs: isLeadingSilence
          ? effectiveStartUs
          : Math.max(effectiveStartUs, interval.startUs + postPadUs),
        endUs: isTrailingSilence
          ? effectiveEndUs
          : Math.min(effectiveEndUs, interval.endUs - prePadUs),
        isBoundary: isLeadingSilence || isTrailingSilence,
      };
    })
    .filter((interval) => interval.endUs - interval.startUs > (interval.isBoundary ? 180_000 : minCutGapUs))
    .sort((a, b) => a.startUs - b.startUs);

  const rawKeep: SourceRange[] = [];
  let cursor = effectiveStartUs;
  for (const cut of cuts) {
    if (cut.startUs > cursor) {
      rawKeep.push({ startUs: cursor, endUs: cut.startUs });
    }
    cursor = Math.max(cursor, cut.endUs);
  }
  if (cursor < effectiveEndUs) {
    rawKeep.push({ startUs: cursor, endUs: effectiveEndUs });
  }

  // Fusionar fragmentos que hayan quedado separados por micro-cortes menores a minCutGapUs
  // para evitar cortes bruscos tipo ametralladora
  const mergedKeep: SourceRange[] = [];
  for (const seg of rawKeep) {
    const cleanSeg = {
      startUs: Math.round(seg.startUs),
      endUs: Math.round(seg.endUs),
    };
    if (cleanSeg.endUs - cleanSeg.startUs < 100_000) continue;
    const prev = mergedKeep[mergedKeep.length - 1];
    if (prev && cleanSeg.startUs - prev.endUs < minCutGapUs) {
      prev.endUs = cleanSeg.endUs;
    } else {
      mergedKeep.push(cleanSeg);
    }
  }

  return mergedKeep.filter((range) => range.endUs - range.startUs >= minKeepUs);
}

export function keepRangesFromSilences(
  sourceStartUs: number,
  sourceEndUs: number,
  silences: SilenceInterval[],
  paddingSec = 0.22,
): SourceRange[] {
  return keepRangesNatural(sourceStartUs, sourceEndUs, silences, {
    prePadSec: Math.max(0.18, paddingSec * 0.90),
    postPadSec: Math.max(0.26, paddingSec * 1.30),
    minCutGapSec: 0.52,
    minKeepSec: 0.70,
  });
}

export interface HighlightResult {
  ranges: SourceRange[];
  method: string;
  totalUs: number;
}

export async function findHighlights(
  projectId: string,
  asset: MediaAsset,
  targetSeconds: number,
  signal: AbortSignal,
  onProgress?: (progress: number, message?: string) => void,
): Promise<HighlightResult> {
  const file = await requireMediaFile(projectId, asset);
  const windowSec = 0.5;
  const sampleRate = 8000;
  const windowSamples = Math.round(windowSec * sampleRate);
  const windows: Array<{ startUs: number; endUs: number; rms: number }> = [];
  let sampleIndex = 0;
  let sumSquares = 0;
  let count = 0;
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const flush = () => {
    if (count === 0) return;
    windows.push({
      startUs: Math.round(((sampleIndex - count) * 1_000_000) / sampleRate),
      endUs: Math.round((sampleIndex * 1_000_000) / sampleRate),
      rms: Math.sqrt(sumSquares / count),
    });
    sumSquares = 0;
    count = 0;
  };
  await runFfmpeg(
    [
      "-i",
      file,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      "pipe:1",
    ],
    {
      signal,
      durationSeconds: asset.durationUs / 1_000_000,
      timeoutMs: 30 * 60_000,
      onProgress: (progress) => onProgress?.(progress.progress, "Analizando energía de audio"),
      onStdoutChunk: (chunk) => {
        const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const usable = combined.length - (combined.length % 2);
        const view = new Int16Array(combined.buffer, combined.byteOffset, Math.floor(usable / 2));
        for (let i = 0; i < view.length; i += 1) {
          const value = (view[i] ?? 0) / 32768;
          sumSquares += value * value;
          count += 1;
          sampleIndex += 1;
          if (count >= windowSamples) flush();
        }
        carry = combined.subarray(usable);
      },
    },
  );
  flush();
  if (windows.length === 0) throw new HttpError(422, "No se pudo analizar el audio del recurso.", "analysis_empty");
  const windowDurationUs = Math.round(windowSec * 1_000_000);
  const resultDurationUs = Math.min(Math.round(targetSeconds * 1_000_000), asset.durationUs);

  // Suavizado: el RMS por ventana de 0,5 s es demasiado nervioso para decidir
  // cortes. Una media móvil de 3 ventanas describe mejor la energia de una frase.
  const smoothed = windows.map((window, index) => {
    const from = Math.max(0, index - 1);
    const to = Math.min(windows.length - 1, index + 1);
    let sum = 0;
    for (let i = from; i <= to; i += 1) sum += windows[i]!.rms;
    return sum / (to - from + 1);
  });
  const sortedRms = [...smoothed].sort((a, b) => a - b);
  const percentile = (ratio: number) => sortedRms[Math.min(sortedRms.length - 1, Math.floor(sortedRms.length * ratio))] ?? 0;
  const floor = Math.max(0.004, percentile(0.2));
  const peak = Math.max(floor * 3, percentile(0.92), 0.01);
  const activeThreshold = Math.min(peak * 0.32, Math.max(floor * 1.9, peak * 0.16));

  // 1) Pasajes con voz: ventanas activas unidas aunque haya micro-silencios.
  const passages: Array<{ start: number; end: number }> = [];
  let runStart: number | null = null;
  let lastActive = -10;
  for (let index = 0; index < windows.length; index += 1) {
    const active = smoothed[index]! >= activeThreshold;
    if (active) {
      if (runStart === null) runStart = index;
      else if (index - lastActive > 2) {
        passages.push({ start: runStart, end: lastActive + 1 });
        runStart = index;
      }
      lastActive = index;
    }
  }
  if (runStart !== null) passages.push({ start: runStart, end: lastActive + 1 });

  // 2) Descarta migas de menos de 1,2 s y parte los pasajes eternos para que el
  // montaje respire: nadie aguanta un plano fijo de 20 s en vertical.
  const minUs = Math.round(1_200_000);
  const maxUs = Math.round(8_000_000);
  const segments: SourceRange[] = [];
  for (const passage of passages) {
    const startUs = passage.start * windowDurationUs;
    const endUs = Math.min(asset.durationUs, passage.end * windowDurationUs);
    if (endUs - startUs < minUs) continue;
    if (endUs - startUs <= maxUs) {
      segments.push({ startUs, endUs });
      continue;
    }
    // Un pasaje largo se corta en trozos de 8 s como maximo, pero el corte se
    // busca en la ventana mas silenciosa cercana (pausa natural) para no partir
    // una palabra a la mitad, que es lo que hace que un montaje suene amateur.
    const cutPoints: number[] = [];
    let cursorUs = startUs;
    const windowsPerPart = Math.max(2, Math.floor(maxUs / windowDurationUs));
    while (endUs - cursorUs > maxUs) {
      const ideal = Math.floor(cursorUs / windowDurationUs) + windowsPerPart;
      let best = ideal;
      let bestValue = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset <= 3; offset += 1) {
        for (const sign of [1, -1]) {
          const index = ideal + offset * sign;
          if (index <= Math.floor(cursorUs / windowDurationUs) + 1) continue;
          if (index >= Math.ceil(endUs / windowDurationUs)) continue;
          const value = smoothed[index];
          if (value === undefined) continue;
          if (value < bestValue) {
            bestValue = value;
            best = index;
          }
        }
      }
      const cutUs = best * windowDurationUs;
      if (cutUs - cursorUs < minUs) break;
      cutPoints.push(cutUs);
      cursorUs = cutUs;
    }
    let partStart = startUs;
    for (const cutUs of cutPoints) {
      if (cutUs - partStart >= minUs) segments.push({ startUs: partStart, endUs: cutUs });
      partStart = cutUs;
    }
    if (endUs - partStart >= minUs) segments.push({ startUs: partStart, endUs });
  }
  if (segments.length === 0) {
    throw new HttpError(422, "No se encontraron fragmentos utiles para el resumen.", "highlights_empty");
  }

  // 3) Puntua cada pasaje por energia sostenida y elige los mejores hasta cubrir
  // el objetivo, siempre en orden cronologico para que la historia se entienda.
  const scoreOf = (range: SourceRange) => {
    const from = Math.floor(range.startUs / windowDurationUs);
    const to = Math.max(from + 1, Math.ceil(range.endUs / windowDurationUs));
    let sum = 0;
    let count = 0;
    for (let index = from; index < to && index < smoothed.length; index += 1) {
      sum += smoothed[index]!;
      count += 1;
    }
    const mean = count > 0 ? sum / count : 0;
    const seconds = (range.endUs - range.startUs) / 1_000_000;
    // Premia la energia sostenida y evita fragmentos de relleno.
    return mean * Math.min(1.35, 0.65 + seconds / 4);
  };
  const ranked = segments
    .map((range, index) => ({ range, index, score: scoreOf(range) }))
    .sort((a, b) => b.score - a.score);
  const chosen: Array<{ range: SourceRange; index: number }> = [];
  let coveredUs = 0;
  for (const candidate of ranked) {
    if (coveredUs >= resultDurationUs) break;
    chosen.push({ range: candidate.range, index: candidate.index });
    coveredUs += candidate.range.endUs - candidate.range.startUs;
  }
  chosen.sort((a, b) => a.range.startUs - b.range.startUs);
  // Une pasajes que quedaron pegados tras la seleccion para evitar micro-cortes,
  // pero sin reconstruir tomas eternas: el resultado nunca supera maxUs.
  const merged: SourceRange[] = [];
  for (const { range } of chosen) {
    const last = merged.at(-1);
    const joined = last ? range.endUs - last.startUs : 0;
    if (last && range.startUs - last.endUs <= windowDurationUs * 2 && joined <= maxUs) {
      last.endUs = Math.max(last.endUs, range.endUs);
    } else {
      merged.push({ ...range });
    }
  }
  const trimmed = merged
    .map((range) => ({
      startUs: Math.max(0, Math.min(asset.durationUs, range.startUs)),
      endUs: Math.min(asset.durationUs, range.endUs),
    }))
    .filter((range) => range.endUs - range.startUs >= minUs);
  if (trimmed.length === 0) {
    throw new HttpError(422, "No se encontraron fragmentos utiles para el resumen.", "highlights_empty");
  }
  return {
    ranges: trimmed,
    method: "Pasajes de voz por energía suavizada (ventanas de 0,5 s)",
    totalUs: trimmed.reduce((total, range) => total + (range.endUs - range.startUs), 0),
  };
}

export function describeSilences(intervals: SilenceInterval[]): string {
  if (intervals.length === 0) return "No se detectaron silencios con los umbrales indicados.";
  const total = intervals.reduce((sum, interval) => sum + interval.durationUs, 0);
  return `${intervals.length} silencios detectados (${(total / 1_000_000).toFixed(2)} s en total).`;
}
