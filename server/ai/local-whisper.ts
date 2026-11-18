import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { config } from "../config";
import { HttpError, pathExists } from "../util/fs";
import { projectTempDirectory } from "../projects/store";
import { runFfmpeg } from "../media/process";

/**
 * Transcripción local con Whisper (Transformers.js + ONNX Runtime).
 *
 * Es el camino universal: funciona con cualquier proveedor de chat (NVIDIA,
 * OpenRouter, Ollama o ninguno) porque el audio nunca sale del equipo. El
 * paquete y el modelo se cargan de forma perezosa la primera vez que se
 * transcribe, para no penalizar el arranque del servidor.
 */

export interface LocalTranscriptWord {
  text: string;
  startUs: number;
  endUs: number;
}

export interface LocalTranscriptSegment {
  startUs: number;
  endUs: number;
  text: string;
  words?: LocalTranscriptWord[];
}

export interface LocalTranscriptResult {
  segments: LocalTranscriptSegment[];
  language: string | null;
  model: string;
}

const DEFAULT_MODEL = "onnx-community/whisper-base";
const CHUNK_SECONDS = 5 * 60;
const SAMPLE_RATE = 16_000;

/** Nombres que acepta Whisper además del código ISO. */
const LANGUAGE_NAMES: Record<string, string> = {
  es: "spanish",
  en: "english",
  pt: "portuguese",
  fr: "french",
  de: "german",
  it: "italian",
  nl: "dutch",
  ca: "catalan",
  gl: "galician",
  eu: "basque",
  ru: "russian",
  zh: "chinese",
  ja: "japanese",
  ko: "korean",
  ar: "arabic",
  hi: "hindi",
  tr: "turkish",
  pl: "polish",
  sv: "swedish",
  da: "danish",
  no: "norwegian",
  fi: "finnish",
  cs: "czech",
  ro: "romanian",
  hu: "hungarian",
  el: "greek",
  he: "hebrew",
  id: "indonesian",
  vi: "vietnamese",
  th: "thai",
  uk: "ukrainian",
};

export function whisperModelId(): string {
  return process.env.NOVACUT_WHISPER_MODEL?.trim() || DEFAULT_MODEL;
}

export function whisperCacheDir(): string {
  return process.env.NOVACUT_WHISPER_CACHE?.trim() || path.join(config.dataDir, "models");
}

export function localWhisperAvailable(): boolean {
  try {
    const pkg = path.join(config.rootDir, "node_modules", "@huggingface", "transformers", "package.json");
    return fsSync.statSync(pkg).isFile();
  } catch {
    return false;
  }
}

interface WhisperChunk {
  text?: string;
  timestamp?: [number | null, number | null] | null;
}

interface WhisperOutput {
  text?: string;
  chunks?: WhisperChunk[];
}

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<WhisperOutput>;

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options: Record<string, unknown>,
  ) => Promise<Transcriber>;
  Tensor: new (type: string, data: ArrayLike<bigint>, dims: number[]) => unknown;
  env: {
    cacheDir?: string;
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
    useFSCache?: boolean;
  };
}

let TensorClass: TransformersModule["Tensor"] | null = null;

let transcriberPromise: Promise<Transcriber> | null = null;

async function loadTranscriber(onProgress?: (progress: number, message?: string) => void): Promise<Transcriber> {
  if (transcriberPromise) return transcriberPromise;
  transcriberPromise = (async () => {
    onProgress?.(0.01, "Preparando Whisper local");
    const transformers = (await import("@huggingface/transformers")) as unknown as TransformersModule;
    const { pipeline, env } = transformers;
    TensorClass = transformers.Tensor;
    env.cacheDir = whisperCacheDir();
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    env.useFSCache = true;
    const model = whisperModelId();
    onProgress?.(0.03, "Cargando el modelo de voz (la primera vez se descarga)");
    let lastDownloadPct = -1;
    return pipeline("automatic-speech-recognition", model, {
      device: "cpu",
      dtype: {
        encoder_model: "fp32",
        decoder_model_merged: "q8",
      },
      progress_callback: (event: { status?: string; progress?: number; file?: string }) => {
        if (event.status === "progress" && typeof event.progress === "number") {
          const pct = Math.max(0, Math.min(100, Math.round(event.progress)));
          // Varios archivos descargan en paralelo: evitamos inundar la cola de eventos.
          if (pct === lastDownloadPct || (pct < 100 && pct % 5 !== 0)) return;
          lastDownloadPct = pct;
          onProgress?.(0.03 + (pct / 100) * 0.1, `Descargando modelo de voz ${pct}%`);
        }
      },
    });
  })().catch((error: unknown) => {
    transcriberPromise = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      502,
      `No se pudo cargar Whisper local (${detail}). Comprueba la conexión para la primera descarga o define NOVACUT_WHISPER_MODEL.`,
      "whisper_unavailable",
    );
  });
  return transcriberPromise;
}

function normalizeLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const code = language.trim().toLowerCase();
  if (!code) return undefined;
  return LANGUAGE_NAMES[code] ?? code;
}

function toFloat32(buffer: Buffer): Float32Array {
  const usable = Math.floor(buffer.byteLength / 4) * 4;
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + usable));
}

/**
 * Transformers.js NO detecta el idioma: si no se le indica, Whisper asume
 * inglés y traduce el audio (un video en español acababa con subtítulos en
 * inglés). Aquí se ejecuta la detección real de Whisper sobre las ventanas con
 * más voz y se devuelve el código ganador.
 */
async function detectLanguageFromAudio(
  transcriber: Transcriber,
  audio: Float32Array,
): Promise<string | null> {
  const pipelineObject = transcriber as unknown as {
    model?: {
      (inputs: Record<string, unknown>): Promise<{ logits?: { data: Float32Array; dims: number[] } }>;
      generation_config?: { lang_to_id?: Record<string, number>; decoder_start_token_id?: number };
      config?: { decoder_start_token_id?: number };
    };
    processor?: (audio: Float32Array) => Promise<Record<string, unknown>>;
  };
  const model = pipelineObject.model;
  const processor = pipelineObject.processor;
  if (!model || !processor || !TensorClass) return null;
  const langToId = model.generation_config?.lang_to_id;
  if (!langToId) return null;
  const startId =
    model.generation_config?.decoder_start_token_id ?? model.config?.decoder_start_token_id;
  if (typeof startId !== "number") return null;

  try {
    const features = await processor(audio);
    const decoderInputIds = new TensorClass("int64", [BigInt(startId)], [1, 1]);
    const output = await model({ ...features, decoder_input_ids: decoderInputIds });
    const logits = output?.logits;
    if (!logits || !logits.data || logits.dims.length === 0) return null;
    const vocab = logits.dims[logits.dims.length - 1] ?? 0;
    const offset = logits.data.length - vocab;
    let best: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [token, id] of Object.entries(langToId)) {
      const match = /^<\|([a-z]{2,3})\|>$/.exec(token);
      if (!match) continue;
      const score = logits.data[offset + id];
      if (typeof score === "number" && score > bestScore) {
        bestScore = score;
        best = match[1] ?? null;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Ventanas de 30 s con más voz, separadas entre sí, para votar el idioma. */
function languageSamples(audio: Float32Array, limit = 3): Float32Array[] {
  const windowSamples = SAMPLE_RATE * 30;
  if (audio.length <= windowSamples) return [audio];
  const windows: Array<{ start: number; rms: number }> = [];
  for (let start = 0; start + windowSamples <= audio.length; start += windowSamples / 2) {
    let sum = 0;
    for (let index = start; index < start + windowSamples; index += 8) {
      const value = audio[index] ?? 0;
      sum += value * value;
    }
    windows.push({ start, rms: sum });
  }
  windows.sort((a, b) => b.rms - a.rms);
  const picked: number[] = [];
  for (const window of windows) {
    if (picked.length >= limit) break;
    if (picked.some((start) => Math.abs(start - window.start) < windowSamples / 2)) continue;
    picked.push(window.start);
  }
  return picked.map((start) => audio.subarray(start, start + windowSamples));
}

async function resolveLanguage(
  transcriber: Transcriber,
  audio: Float32Array,
): Promise<string | null> {
  const votes = new Map<string, number>();
  for (const sample of languageSamples(audio)) {
    const detected = await detectLanguageFromAudio(transcriber, sample);
    if (!detected) continue;
    votes.set(detected, (votes.get(detected) ?? 0) + 1);
  }
  let winner: string | null = null;
  let best = 0;
  for (const [code, count] of votes) {
    if (count > best) {
      best = count;
      winner = code;
    }
  }
  return winner;
}


/**
 * Whisper-base tiende a repetir la misma frase cuando hay música o ruido
 * («de forma de forma de que se transforma»). Se colapsan las repeticiones
 * inmediatas de 2..4 palabras; las de una sola palabra solo si son 4+.
 */
function collapseRepetitions(text: string): string {
  let result = text;
  for (let size = 4; size >= 2; size -= 1) {
    const pattern = new RegExp(
      `\\b((?:[\\p{L}\\p{N}']+\\s+){${size - 1}}[\\p{L}\\p{N}']+)(?:\\s+\\1)+\\b`,
      "giu",
    );
    result = result.replace(pattern, "$1");
  }
  result = result.replace(/\b([\p{L}\p{N}']+)(?:\s+\1){3,}\b/giu, "$1");
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Calcula el peso fonético aproximado de una palabra (núcleos vocálicos / sílabas)
 * para alinear la duración de cada palabra con la cadencia real del habla.
 */
function phoneticWordWeight(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-záéíóúüñ0-9]/gi, "");
  if (!clean) return 1;
  const vowelGroups = clean.match(/[aeiouáéíóúü]+/gi);
  const syllables = vowelGroups ? vowelGroups.length : Math.max(1, Math.ceil(clean.length / 3));
  const digitBonus = /\d/.test(clean) ? clean.replace(/\D/g, "").length * 0.8 : 0;
  const consonantBonus = clean.length * 0.12;
  return Math.max(0.8, syllables + digitBonus + consonantBonus);
}

/**
 * Alinea las palabras de un segmento con la envolvente de energía acústica real (16 kHz PCM).
 * - Recorta silencios iniciales y finales para que la primera palabra aparezca en el milisegundo
 *   exacto en que empieza la voz.
 * - Detecta micro-pausas internas (>= 80ms de silencio) dividiendo el segmento en islas de voz.
 * - Distribuye las palabras según peso fonético (sílabas) + integral de energía vocal.
 */
function alignWordsWithAudioEnergy(
  text: string,
  segStartSec: number,
  segEndSec: number,
  audio: Float32Array | undefined,
  offsetSeconds: number,
): LocalTranscriptWord[] {
  const rawWords = text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (rawWords.length === 0) return [];

  const safeStart = Math.max(0, segStartSec);
  const safeEnd = Math.max(safeStart + 0.08, segEndSec);
  const hopSamples = 160; // 10ms a 16kHz
  const hopSec = hopSamples / SAMPLE_RATE;

  const startSample = Math.max(0, Math.floor(safeStart * SAMPLE_RATE));
  const endSample = audio ? Math.min(audio.length, Math.ceil(safeEnd * SAMPLE_RATE)) : 0;
  const numFrames = Math.floor((endSample - startSample) / hopSamples);

  // Si no hay suficientes muestras de audio, respaldo por peso fonético silábico
  if (!audio || numFrames < 6) {
    const weights = rawWords.map(phoneticWordWeight);
    const totalW = weights.reduce((a, b) => a + b, 0);
    const span = safeEnd - safeStart;
    let cursor = safeStart;
    return rawWords.map((w, idx) => {
      const dur = (weights[idx]! / totalW) * span;
      const wStart = cursor;
      const wEnd = idx === rawWords.length - 1 ? safeEnd : wStart + dur;
      cursor = wEnd;
      return {
        text: w,
        startUs: Math.round((offsetSeconds + wStart) * 1_000_000),
        endUs: Math.round((offsetSeconds + Math.max(wStart + 0.04, wEnd)) * 1_000_000),
      };
    });
  }

  // 1. Calcular envolvente RMS por ventana de 10ms
  const rawRms = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const base = startSample + f * hopSamples;
    let sumSq = 0;
    for (let i = 0; i < hopSamples; i++) {
      const sample = audio[base + i] ?? 0;
      sumSq += sample * sample;
    }
    rawRms[f] = Math.sqrt(sumSq / hopSamples);
  }

  // Suavizado ligero (3 ventanas = 30ms) para eliminar picos aislados
  const env = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const prev = rawRms[Math.max(0, f - 1)] ?? 0;
    const curr = rawRms[f] ?? 0;
    const next = rawRms[Math.min(numFrames - 1, f + 1)] ?? 0;
    env[f] = prev * 0.25 + curr * 0.5 + next * 0.25;
  }

  // 2. Umbral adaptativo de actividad vocal (VAD)
  const sorted = Array.from(env).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  const peakLevel = sorted[Math.floor(sorted.length * 0.92)] ?? 0.01;
  const dynamicRange = Math.max(0.002, peakLevel - noiseFloor);
  const vadThreshold = noiseFloor + dynamicRange * 0.14;

  // 3. Recortar silencio inicial y final con histéresis de 20ms
  let firstActive = 0;
  while (firstActive < numFrames - 1) {
    const activeNow = (env[firstActive] ?? 0) >= vadThreshold;
    const activeNext = (env[Math.min(numFrames - 1, firstActive + 1)] ?? 0) >= vadThreshold * 0.85;
    if (activeNow && activeNext) break;
    firstActive++;
  }
  let lastActive = numFrames - 1;
  while (lastActive > firstActive) {
    const activeNow = (env[lastActive] ?? 0) >= vadThreshold;
    const activePrev = (env[Math.max(0, lastActive - 1)] ?? 0) >= vadThreshold * 0.85;
    if (activeNow && activePrev) break;
    lastActive--;
  }

  if (lastActive <= firstActive + 2) {
    firstActive = 0;
    lastActive = numFrames - 1;
  } else {
    // Pre-roll de 20ms para consonantes oclusivas iniciales (/p/, /t/, /k/) y post-roll de 20ms
    firstActive = Math.max(0, firstActive - 2);
    lastActive = Math.min(numFrames - 1, lastActive + 2);
  }

  // 4. Detectar islas de voz separadas por pausas reales (>= 80ms de silencio)
  interface SpeechIsland {
    startFrame: number;
    endFrame: number;
  }
  const islands: SpeechIsland[] = [];
  const minPauseFrames = 8; // 80ms
  let curStart = firstActive;
  let f = firstActive;
  while (f <= lastActive) {
    if ((env[f] ?? 0) < vadThreshold) {
      let silenceEnd = f;
      while (silenceEnd <= lastActive && (env[silenceEnd] ?? 0) < vadThreshold) {
        silenceEnd++;
      }
      const silenceLen = silenceEnd - f;
      if (silenceLen >= minPauseFrames && f > curStart + 2 && silenceEnd <= lastActive - 2) {
        islands.push({ startFrame: curStart, endFrame: f });
        curStart = silenceEnd;
      }
      f = silenceEnd;
    } else {
      f++;
    }
  }
  if (curStart <= lastActive) {
    islands.push({ startFrame: curStart, endFrame: lastActive + 1 });
  }
  if (islands.length === 0) {
    islands.push({ startFrame: firstActive, endFrame: lastActive + 1 });
  }

  // 5. Si hay más islas que palabras, fusionar las islas con menor separación
  while (islands.length > rawWords.length && islands.length > 1) {
    let minGap = Infinity;
    let mergeIdx = 0;
    for (let i = 0; i < islands.length - 1; i++) {
      const gap = islands[i + 1]!.startFrame - islands[i]!.endFrame;
      if (gap < minGap) {
        minGap = gap;
        mergeIdx = i;
      }
    }
    islands[mergeIdx] = {
      startFrame: islands[mergeIdx]!.startFrame,
      endFrame: islands[mergeIdx + 1]!.endFrame,
    };
    islands.splice(mergeIdx + 1, 1);
  }

  // 6. Asignar palabras a cada isla de voz respetando puntuación y peso fonético
  const weights = rawWords.map(phoneticWordWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const islandSpans = islands.map((isl) => Math.max(1, isl.endFrame - isl.startFrame));
  const totalIslandSpan = islandSpans.reduce((a, b) => a + b, 0);

  const wordGroups: Array<{ island: SpeechIsland; indices: number[] }> = [];
  if (islands.length === 1) {
    wordGroups.push({
      island: islands[0]!,
      indices: rawWords.map((_, i) => i),
    });
  } else {
    let wordCursor = 0;
    let accIslandSpan = 0;
    for (let islIdx = 0; islIdx < islands.length; islIdx++) {
      const isl = islands[islIdx]!;
      accIslandSpan += islandSpans[islIdx]!;
      const isLastIsland = islIdx === islands.length - 1;
      const remainingIslands = islands.length - 1 - islIdx;
      const maxWordEnd = rawWords.length - remainingIslands;

      if (isLastIsland) {
        const indices: number[] = [];
        for (let w = wordCursor; w < rawWords.length; w++) indices.push(w);
        if (indices.length > 0) wordGroups.push({ island: isl, indices });
        break;
      }

      const targetCumWeight = (accIslandSpan / totalIslandSpan) * totalWeight;
      let bestSplit = wordCursor + 1;
      let bestCost = Infinity;
      let runningWeight = 0;
      for (let w = 0; w < wordCursor; w++) runningWeight += weights[w]!;

      for (let w = wordCursor; w < maxWordEnd; w++) {
        runningWeight += weights[w]!;
        const dist = Math.abs(runningWeight - targetCumWeight);
        // Bonificación si la palabra termina en signo de puntuación (pausa natural)
        const hasPunct = /[,.;:!?…]$/.test(rawWords[w]!);
        const cost = hasPunct ? dist * 0.55 : dist;
        if (cost < bestCost) {
          bestCost = cost;
          bestSplit = w + 1;
        }
      }

      const indices: number[] = [];
      for (let w = wordCursor; w < bestSplit; w++) indices.push(w);
      wordGroups.push({ island: isl, indices });
      wordCursor = bestSplit;
    }
  }

  // 7. Dentro de cada isla, distribuir tiempos combinando peso fonético + densidad de energía vocal
  const result: LocalTranscriptWord[] = [];
  for (const group of wordGroups) {
    const { island, indices } = group;
    if (indices.length === 0) continue;
    const islStartSec = safeStart + island.startFrame * hopSec;
    const islEndSec = safeStart + island.endFrame * hopSec;
    const islDuration = Math.max(0.05 * indices.length, islEndSec - islStartSec);

    const groupWeights = indices.map((i) => weights[i]!);
    const groupTotalW = groupWeights.reduce((a, b) => a + b, 0);

    // Curva acumulada híbrida (65% cadencia silábica uniforme + 35% energía acústica real)
    const islFrames = Math.max(1, island.endFrame - island.startFrame);
    const cumEnergy = new Float32Array(islFrames + 1);
    for (let k = 0; k < islFrames; k++) {
      const e = Math.max(0, (env[island.startFrame + k] ?? 0) - noiseFloor * 0.8);
      cumEnergy[k + 1] = (cumEnergy[k] ?? 0) + e;
    }
    const totalE = cumEnergy[islFrames] ?? 0;

    let prevWordEndSec = islStartSec;
    let cumW = 0;
    for (let j = 0; j < indices.length; j++) {
      const wordIdx = indices[j]!;
      const wordText = rawWords[wordIdx]!;
      cumW += groupWeights[j]!;
      const normW = cumW / groupTotalW;

      let wordEndSec: number;
      if (j === indices.length - 1) {
        wordEndSec = islEndSec;
      } else if (totalE > 0.0001) {
        // Buscar el frame donde la integral de energía alcanza normW
        const targetE = normW * totalE;
        let kFound = 0;
        while (kFound < islFrames && (cumEnergy[kFound + 1] ?? 0) < targetE) {
          kFound++;
        }
        const energyRatio = Math.min(1, Math.max(0, (kFound + 0.5) / islFrames));
        const blendedRatio = normW * 0.65 + energyRatio * 0.35;
        wordEndSec = islStartSec + blendedRatio * islDuration;
      } else {
        wordEndSec = islStartSec + normW * islDuration;
      }

      const wStart = prevWordEndSec;
      const wEnd = Math.max(wStart + 0.04, wordEndSec);
      prevWordEndSec = wEnd;

      result.push({
        text: wordText,
        startUs: Math.round((offsetSeconds + wStart) * 1_000_000),
        endUs: Math.round((offsetSeconds + wEnd) * 1_000_000),
      });
    }
  }

  return result;
}

function buildSegments(
  output: WhisperOutput,
  offsetSeconds: number,
  fallbackDurationSeconds: number,
  audio?: Float32Array,
): LocalTranscriptSegment[] {
  const chunks = (output.chunks ?? [])
    .map((chunk) => ({
      text: collapseRepetitions((chunk.text ?? "").replace(/\s+/g, " ").trim()),
      start: chunk.timestamp?.[0] ?? null,
      end: chunk.timestamp?.[1] ?? null,
    }))
    .filter((chunk) => chunk.text.length > 0);

  if (chunks.length === 0) {
    const text = collapseRepetitions((output.text ?? "").replace(/\s+/g, " ").trim());
    if (!text) return [];
    const durationSec = Math.max(1, fallbackDurationSeconds);
    const words = alignWordsWithAudioEnergy(text, 0, durationSec, audio, offsetSeconds);
    const startUs = words[0]?.startUs ?? Math.round(offsetSeconds * 1_000_000);
    const endUs = words.at(-1)?.endUs ?? Math.round((offsetSeconds + durationSec) * 1_000_000);
    return [
      {
        startUs,
        endUs,
        text,
        ...(words.length > 0 ? { words } : {}),
      },
    ];
  }

  // Detectar si Whisper devolvió chunks palabra por palabra (return_timestamps: "word")
  const singleWordCount = chunks.filter((c) => !c.text.includes(" ")).length;
  const isWordLevelOutput = chunks.length > 1 && singleWordCount / chunks.length >= 0.75;

  if (isWordLevelOutput) {
    const allWords: LocalTranscriptWord[] = [];
    let prevEnd = 0;
    for (const chunk of chunks) {
      const rawStart = chunk.start ?? prevEnd;
      const rawEnd = chunk.end ?? rawStart + 0.18;
      const startSec = Math.max(0, rawStart);
      const endSec = Math.max(startSec + 0.05, rawEnd);
      prevEnd = Math.max(prevEnd, endSec);

      // Si el chunk tiene tiempos válidos, afinar contra energía de audio si es posible
      const aligned = alignWordsWithAudioEnergy(chunk.text, startSec, endSec, audio, offsetSeconds);
      if (aligned.length > 0) {
        allWords.push(...aligned);
      } else {
        allWords.push({
          text: chunk.text,
          startUs: Math.round((offsetSeconds + startSec) * 1_000_000),
          endUs: Math.round((offsetSeconds + endSec) * 1_000_000),
        });
      }
    }

    // Agrupar las palabras individuales en segmentos naturales por pausas o puntuación
    const segments: LocalTranscriptSegment[] = [];
    let currentWords: LocalTranscriptWord[] = [];
    const flushSegment = () => {
      if (currentWords.length === 0) return;
      segments.push({
        startUs: currentWords[0]!.startUs,
        endUs: currentWords[currentWords.length - 1]!.endUs,
        text: currentWords.map((w) => w.text).join(" "),
        words: currentWords,
      });
      currentWords = [];
    };

    for (const word of allWords) {
      const prev = currentWords[currentWords.length - 1];
      const pauseUs = prev ? word.startUs - prev.endUs : 0;
      if (currentWords.length >= 14 || pauseUs >= 350_000) {
        flushSegment();
      }
      currentWords.push(word);
      if (/[.!?]$/.test(word.text) && currentWords.length >= 3) {
        flushSegment();
      }
    }
    flushSegment();
    return segments;
  }

  // Modo segmentos de frase: alinear las palabras de cada segmento con la energía acústica real (16 kHz)
  const segments: LocalTranscriptSegment[] = [];
  let previousEnd = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const nextChunkStart = i + 1 < chunks.length ? chunks[i + 1]!.start : null;
    const rawStart = chunk.start ?? previousEnd;
    let rawEnd = chunk.end ?? (nextChunkStart ?? rawStart + Math.max(0.8, fallbackDurationSeconds / chunks.length));
    if (nextChunkStart !== null && rawEnd > nextChunkStart) {
      rawEnd = nextChunkStart;
    }
    const startSec = Math.max(0, rawStart);
    const endSec = Math.max(startSec + 0.12, rawEnd);
    previousEnd = Math.max(previousEnd, endSec);

    const words = alignWordsWithAudioEnergy(chunk.text, startSec, endSec, audio, offsetSeconds);
    const segStartUs = words[0]?.startUs ?? Math.round((offsetSeconds + startSec) * 1_000_000);
    const segEndUs = words.at(-1)?.endUs ?? Math.round((offsetSeconds + endSec) * 1_000_000);

    segments.push({
      startUs: segStartUs,
      endUs: Math.max(segStartUs + 60_000, segEndUs),
      text: chunk.text,
      ...(words.length > 0 ? { words } : {}),
    });
  }
  return segments;
}

export async function transcribeLocally(
  projectId: string,
  file: string,
  durationUs: number,
  language: string | undefined,
  signal: AbortSignal,
  onProgress?: (progress: number, message?: string) => void,
): Promise<LocalTranscriptResult> {
  if (!localWhisperAvailable()) {
    throw new HttpError(
      503,
      "El motor de subtítulos local no está instalado. Ejecuta npm install en el proyecto.",
      "whisper_not_installed",
    );
  }

  const transcriber = await loadTranscriber(onProgress);
  const tempDir = path.join(projectTempDirectory(projectId), "whisper");
  await fs.mkdir(tempDir, { recursive: true });
  const durationSeconds = Math.max(1, durationUs / 1_000_000);
  const chunks = Math.max(1, Math.ceil(durationSeconds / CHUNK_SECONDS));
  const segments: LocalTranscriptSegment[] = [];
  let resolvedLanguage: string | undefined = normalizeLanguage(language);

  try {
    for (let index = 0; index < chunks; index += 1) {
      if (signal.aborted) throw new HttpError(499, "Transcripción cancelada.", "cancelled");
      const start = index * CHUNK_SECONDS;
      const duration = Math.min(CHUNK_SECONDS, durationSeconds - start);
      const rawFile = path.join(tempDir, `chunk-${index}.f32`);
      await runFfmpeg(
        [
          "-y",
          "-ss",
          String(start),
          "-t",
          String(duration),
          "-i",
          file,
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-f",
          "f32le",
          "-acodec",
          "pcm_f32le",
          rawFile,
        ],
        { signal, timeoutMs: 10 * 60_000, durationSeconds: duration },
      );
      if (!(await pathExists(rawFile))) {
        throw new HttpError(500, "No se pudo extraer el audio para Whisper.", "extract_failed");
      }
      const buffer = await fs.readFile(rawFile);
      await fs.rm(rawFile, { force: true });
      const audio = toFloat32(buffer);
      if (audio.length === 0) continue;

      // El idioma se decide una sola vez, con las partes donde de verdad hay voz.
      if (!resolvedLanguage) {
        onProgress?.(0.14, "Detectando el idioma del audio");
        resolvedLanguage = (await resolveLanguage(transcriber, audio)) ?? undefined;
      }

      const base = index / chunks;
      const span = 1 / chunks;
      onProgress?.(
        0.15 + base * 0.8,
        chunks > 1 ? `Transcribiendo con Whisper local (${index + 1}/${chunks})` : "Transcribiendo con Whisper local",
      );
      let output: WhisperOutput;
      try {
        output = await transcriber(audio, {
          ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
          task: "transcribe",
          return_timestamps: "word",
          chunk_length_s: 30,
          stride_length_s: 5,
        });
      } catch {
        output = await transcriber(audio, {
          ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
          task: "transcribe",
          return_timestamps: true,
          chunk_length_s: 30,
          stride_length_s: 5,
        });
      }
      if (signal.aborted) throw new HttpError(499, "Transcripción cancelada.", "cancelled");
      segments.push(...buildSegments(output, start, duration, audio));
      onProgress?.(
        0.15 + (base + span) * 0.8,
        chunks > 1 ? `Fragmento ${index + 1}/${chunks} transcrito` : "Transcripción completada",
      );
    }
    if (segments.length === 0) {
      throw new HttpError(
        422,
        "Whisper no detectó voz en el audio. Comprueba que el clip tiene sonido audible.",
        "no_speech_detected",
      );
    }
    return {
      segments,
      language: resolvedLanguage ? (LANGUAGE_NAMES[resolvedLanguage] ?? resolvedLanguage) : null,
      model: whisperModelId(),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    onProgress?.(1, "Transcripción completada");
  }
}
