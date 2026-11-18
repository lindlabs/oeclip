import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAiConfig } from "../ai/settings";
import { runFfmpeg, runProcess } from "../media/process";
import { probeMedia } from "../media/probe";
import { newId } from "../../src/shared/time";

export type TtsProviderKind =
  | "openai"
  | "edge-tts"
  | "piper"
  | "espeak-ng"
  | "say"
  | "windows-sapi"
  | "procedural";

export interface SpeechSegmentInput {
  label: string;
  narration: string;
  suggestedDurationSec: number;
}

export interface SynthesizedSceneSpeechSegment {
  index: number;
  label: string;
  narration: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  spokenDurationSec: number;
  provider: TtsProviderKind;
  file: string;
}

export interface SynthesizedSceneSpeechResult {
  file: string;
  totalDurationSec: number;
  provider: TtsProviderKind;
  usedRealTts: boolean;
  segments: SynthesizedSceneSpeechSegment[];
}

export interface SceneTimingSlot {
  startSec: number;
  endSec: number;
  durationSec: number;
}

/**
 * Estima la duración natural de locución a partir del conteo de palabras (~2.6 palabras/seg).
 */
export function estimateNarrationDurationSec(text: string, minSec = 1.2): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return minSec;
  return Math.max(minSec, Number((words / 2.6 + 0.35).toFixed(2)));
}

/**
 * Calcula los intervalos `[startSec, endSec]` alineados para cada bloque narrado más una micro-pausa respiratoria.
 */
export function computeAlignedSceneTimings(
  spokenDurationsSec: number[],
  pauseBetweenScenesSec = 0.28,
  minDurationsSec?: number[],
): SceneTimingSlot[] {
  const slots: SceneTimingSlot[] = [];
  let cursor = 0;
  for (let i = 0; i < spokenDurationsSec.length; i += 1) {
    const isLast = i === spokenDurationsSec.length - 1;
    const spoken = Math.max(0.8, Number((spokenDurationsSec[i] ?? 1.5).toFixed(3)));
    const pause = isLast ? 0.15 : Math.max(0, pauseBetweenScenesSec);
    const minSlot = Number(minDurationsSec?.[i] ?? 0);
    const durationSec = Number(Math.max(spoken + pause, minSlot > 0 ? minSlot : 0).toFixed(3));
    const startSec = Number(cursor.toFixed(3));
    const endSec = Number((startSec + durationSec).toFixed(3));
    slots.push({ startSec, endSec, durationSec });
    cursor = endSec;
  }
  return slots;
}

function resolveTtsEndpoint(): { baseUrl: string; apiKey: string; model: string; voice: string } | null {
  const explicitKey = (process.env.OECLIP_TTS_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim();
  const explicitUrl = (process.env.OECLIP_TTS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const model = (process.env.OECLIP_TTS_MODEL ?? "tts-1").trim();
  const voice = (process.env.OECLIP_TTS_VOICE ?? "onyx").trim();

  if (explicitUrl && (explicitKey || explicitUrl.includes("127.0.0.1") || explicitUrl.includes("localhost"))) {
    return { baseUrl: explicitUrl, apiKey: explicitKey, model, voice };
  }

  if (explicitKey) {
    return { baseUrl: "https://api.openai.com/v1", apiKey: explicitKey, model, voice };
  }

  try {
    const cfg = getAiConfig();
    if (cfg.provider === "openai" && cfg.apiKey) {
      return { baseUrl: cfg.baseUrl.replace(/\/+$/, ""), apiKey: cfg.apiKey, model, voice };
    }
  } catch {
    // Sin configuración AI activa.
  }

  return null;
}

async function normalizeSpeechWav(inputFile: string, outputWav: string, signal?: AbortSignal): Promise<void> {
  await fs.mkdir(path.dirname(outputWav), { recursive: true });
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputFile,
      "-af",
      "highpass=f=75,silenceremove=start_periods=1:start_silence=0.04:start_threshold=-46dB,areverse,silenceremove=start_periods=1:start_silence=0.06:start_threshold=-46dB,areverse,loudnorm=I=-16:TP=-1.5:LRA=9",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outputWav,
    ],
    { signal: signal ?? AbortSignal.timeout(20_000), timeoutMs: 20_000 },
  );
}

async function tryOpenAiSpeech(
  text: string,
  outputWav: string,
  voiceHint?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const endpoint = resolveTtsEndpoint();
  if (!endpoint) return false;
  const rawFile = `${outputWav}.raw.mp3`;
  try {
    const res = await fetch(`${endpoint.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        input: text,
        voice: voiceHint?.trim() || endpoint.voice,
        response_format: "mp3",
      }),
      signal: signal ?? AbortSignal.timeout(18_000),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 256) return false;
    await fs.writeFile(rawFile, buf);
    await normalizeSpeechWav(rawFile, outputWav, signal);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(rawFile, { force: true }).catch(() => undefined);
  }
}

async function tryEdgeTts(
  text: string,
  outputWav: string,
  language: string,
  voiceHint?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const isSpanish = /^es\b/i.test(language) || /[áéíóúñ¿¡]/i.test(text);
  const voice = voiceHint?.includes("Neural")
    ? voiceHint
    : isSpanish
      ? (process.env.OECLIP_EDGE_VOICE_ES ?? "es-MX-JorgeNeural")
      : (process.env.OECLIP_EDGE_VOICE_EN ?? "en-US-AndrewNeural");
  const rawMp3 = `${outputWav}.edge.mp3`;
  try {
    const res = await runProcess(
      "edge-tts",
      ["--voice", voice, "--rate=+6%", "--text", text, "--write-media", rawMp3],
      { signal: signal ?? AbortSignal.timeout(20_000), timeoutMs: 20_000 },
    );
    if (res.code !== 0) return false;
    const stat = await fs.stat(rawMp3).catch(() => null);
    if (!stat || stat.size < 256) return false;
    await normalizeSpeechWav(rawMp3, outputWav, signal);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(rawMp3, { force: true }).catch(() => undefined);
  }
}

async function tryPiperTts(text: string, outputWav: string, signal?: AbortSignal): Promise<boolean> {
  const modelPath = (process.env.OECLIP_PIPER_MODEL ?? "").trim();
  if (!modelPath) return false;
  const rawWav = `${outputWav}.piper.wav`;
  const txtFile = `${outputWav}.txt`;
  try {
    await fs.writeFile(txtFile, text, "utf8");
    const cmd = process.platform === "win32" ? "cmd" : "sh";
    const args =
      process.platform === "win32"
        ? ["/c", `type "${txtFile}" | piper --model "${modelPath}" --output_file "${rawWav}"`]
        : ["-c", `cat "${txtFile}" | piper --model "${modelPath}" --output_file "${rawWav}"`];
    const res = await runProcess(cmd, args, { signal: signal ?? AbortSignal.timeout(20_000), timeoutMs: 20_000 });
    if (res.code !== 0) return false;
    await normalizeSpeechWav(rawWav, outputWav, signal);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(rawWav, { force: true }).catch(() => undefined);
    await fs.rm(txtFile, { force: true }).catch(() => undefined);
  }
}

async function tryEspeakTts(
  text: string,
  outputWav: string,
  language: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const lang = /^es\b/i.test(language) ? "es" : "en";
  const rawWav = `${outputWav}.espeak.wav`;
  for (const bin of ["espeak-ng", "espeak"]) {
    try {
      const res = await runProcess(
        bin,
        ["-v", lang, "-s", "162", "-w", rawWav, text],
        { signal: signal ?? AbortSignal.timeout(12_000), timeoutMs: 12_000 },
      );
      if (res.code === 0) {
        const stat = await fs.stat(rawWav).catch(() => null);
        if (stat && stat.size > 256) {
          await normalizeSpeechWav(rawWav, outputWav, signal);
          await fs.rm(rawWav, { force: true }).catch(() => undefined);
          return true;
        }
      }
    } catch {
      // Binario no disponible.
    } finally {
      await fs.rm(rawWav, { force: true }).catch(() => undefined);
    }
  }
  return false;
}

async function tryMacSayTts(text: string, outputWav: string, signal?: AbortSignal): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const rawAiff = `${outputWav}.aiff`;
  try {
    const res = await runProcess("say", ["-o", rawAiff, text], {
      signal: signal ?? AbortSignal.timeout(15_000),
      timeoutMs: 15_000,
    });
    if (res.code !== 0) return false;
    await normalizeSpeechWav(rawAiff, outputWav, signal);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(rawAiff, { force: true }).catch(() => undefined);
  }
}

async function tryWindowsSapiTts(
  text: string,
  outputWav: string,
  language: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const rawWav = `${outputWav}.sapi.wav`;
  const textFile = path.join(os.tmpdir(), `oeclip-sapi-${newId("tts")}.txt`);
  try {
    await fs.writeFile(textFile, text, "utf8");
    const preferSpanish = /^es\b/i.test(language) || /[áéíóúñ¿¡]/i.test(text);
    const culturePrefix = preferSpanish ? "es" : "en";
    const script = [
      "Add-Type -AssemblyName System.Speech;",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      `$voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq '${culturePrefix}' } | Select-Object -First 1;`,
      "if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }",
      "$synth.Rate = 1;",
      `$text = [System.IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8);`,
      `$synth.SetOutputToWaveFile('${rawWav.replace(/'/g, "''")}');`,
      "$synth.Speak($text);",
      "$synth.Dispose();",
    ].join(" ");

    const res = await runProcess(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { signal: signal ?? AbortSignal.timeout(20_000), timeoutMs: 20_000 },
    );
    if (res.code !== 0) return false;
    const stat = await fs.stat(rawWav).catch(() => null);
    if (!stat || stat.size < 256) return false;
    await normalizeSpeechWav(rawWav, outputWav, signal);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(rawWav, { force: true }).catch(() => undefined);
    await fs.rm(textFile, { force: true }).catch(() => undefined);
  }
}

async function copyLocalFileAtomically(srcFile: string, destinationFile: string): Promise<void> {
  if (path.resolve(srcFile) === path.resolve(destinationFile)) return;
  await fs.mkdir(path.dirname(destinationFile), { recursive: true });
  await fs.copyFile(srcFile, destinationFile);
}

async function generateProceduralCadenceWav(
  destination: string,
  durationSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const safeDur = Math.max(0.8, Math.min(60, Number(durationSec.toFixed(2))));
  const inOsTmp = path.resolve(destination).startsWith(path.resolve(os.tmpdir()));
  const localOut = inOsTmp
    ? destination
    : path.join(os.tmpdir(), `oeclip-cadence-${newId("tts")}.wav`);
  try {
    await fs.mkdir(path.dirname(localOut), { recursive: true });
    // Señal tonal cadenciada sutil (bajo umbral vocal) para mantener sincronía rítmica si no hay motor TTS instalado.
    await runFfmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=0.045*sin(2*PI*165*t)*max(0,sin(2*PI*2.4*t))+0.025*sin(2*PI*330*t)*pow(0.5+0.5*cos(2*PI*3.6*t),2):d=${safeDur.toFixed(2)}:s=48000`,
        "-af",
        `lowpass=f=1200,afade=t=in:st=0:d=0.08,afade=t=out:st=${Math.max(0, safeDur - 0.12).toFixed(2)}:d=0.12`,
        "-c:a",
        "pcm_s16le",
        "-ac",
        "1",
        localOut,
      ],
      { signal: signal ?? AbortSignal.timeout(15_000), timeoutMs: 15_000 },
    );
    await copyLocalFileAtomically(localOut, destination);
  } finally {
    if (!inOsTmp) await fs.rm(localOut, { force: true }).catch(() => undefined);
  }
}

/**
 * Sintetiza un segmento de locución en archivo WAV 48 kHz mono usando la cadena multiplataforma:
 * OpenAI Speech API -> edge-tts -> piper -> espeak-ng -> macOS say -> Windows System.Speech -> cadencia procedural.
 */
export async function synthesizeSpeechSegment(
  text: string,
  destinationWav: string,
  options: {
    language?: string;
    voiceHint?: string;
    fallbackDurationSec?: number;
    allowNetworkTts?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{ file: string; durationSec: number; provider: TtsProviderKind }> {
  const cleanText = text.trim();
  const language = options.language ?? "es";
  const fallbackDur = options.fallbackDurationSec ?? estimateNarrationDurationSec(cleanText);
  const offlineOnly = process.env.OECLIP_TTS_OFFLINE === "1" || options.allowNetworkTts === false;

  const alreadyInTmp = path.resolve(destinationWav).startsWith(path.resolve(os.tmpdir()));
  const scratchDir = alreadyInTmp ? null : await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-tts-seg-"));
  const workingWav = scratchDir ? path.join(scratchDir, path.basename(destinationWav) || "seg.wav") : destinationWav;

  try {
    await fs.mkdir(path.dirname(workingWav), { recursive: true });

    let provider: TtsProviderKind = "procedural";
    if (cleanText.length > 0 && !offlineOnly) {
      if (await tryOpenAiSpeech(cleanText, workingWav, options.voiceHint, options.signal)) {
        provider = "openai";
      } else if (await tryEdgeTts(cleanText, workingWav, language, options.voiceHint, options.signal)) {
        provider = "edge-tts";
      }
    }

    if (provider === "procedural" && cleanText.length > 0) {
      if (await tryPiperTts(cleanText, workingWav, options.signal)) {
        provider = "piper";
      } else if (await tryEspeakTts(cleanText, workingWav, language, options.signal)) {
        provider = "espeak-ng";
      } else if (await tryMacSayTts(cleanText, workingWav, options.signal)) {
        provider = "say";
      } else if (await tryWindowsSapiTts(cleanText, workingWav, language, options.signal)) {
        provider = "windows-sapi";
      }
    }

    if (provider === "procedural") {
      await generateProceduralCadenceWav(workingWav, fallbackDur, options.signal);
    }

    let measuredSec = fallbackDur;
    try {
      const probed = await probeMedia(workingWav);
      if (probed.durationUs > 0) {
        measuredSec = Number((probed.durationUs / 1_000_000).toFixed(3));
      }
    } catch {
      // Mantiene la duración estimada si ffprobe fallara puntualmente.
    }

    if (scratchDir) {
      await copyLocalFileAtomically(workingWav, destinationWav);
    }

    return {
      file: destinationWav,
      durationSec: Math.max(0.8, measuredSec),
      provider,
    };
  } finally {
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Rellena o concatena varios clips WAV en un único maestro continuo 48 kHz mono con pausas exactas entre escenas.
 */
async function concatenateSceneSpeechWavs(
  segments: Array<{ file: string; targetDurationSec: number; spokenDurationSec: number }>,
  destinationWav: string,
  signal?: AbortSignal,
): Promise<void> {
  if (segments.length === 0) {
    await generateProceduralCadenceWav(destinationWav, 2, signal);
    return;
  }

  // Todo FFmpeg WAV con seek de cabecera DEBE ejecutarse en disco local (/tmp)
  // y copiarse una sola vez al almacenamiento persistente (evita OutOfOrderError en GCSFuse).
  const paddedFiles: string[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-tts-concat-"));
  const concatListFile = path.join(tempDir, `tts-concat-${newId("list")}.txt`);
  const localMasterWav = path.join(tempDir, `master-${newId("wav")}.wav`);

  try {
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      const paddedPath = path.join(tempDir, `tts-seg-pad-${i}-${newId("p")}.wav`);
      const targetDur = Math.max(seg.spokenDurationSec, seg.targetDurationSec);
      await runFfmpeg(
        [
          "-y",
          "-i",
          seg.file,
          "-af",
          `apad=whole_dur=${targetDur.toFixed(3)},atrim=0:${targetDur.toFixed(3)}`,
          "-ar",
          "48000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          paddedPath,
        ],
        { signal: signal ?? AbortSignal.timeout(15_000), timeoutMs: 15_000 },
      );
      paddedFiles.push(paddedPath);
    }

    const concatText = paddedFiles
      .map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.writeFile(concatListFile, `${concatText}\n`, "utf8");

    await runFfmpeg(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatListFile,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        localMasterWav,
      ],
      { signal: signal ?? AbortSignal.timeout(20_000), timeoutMs: 20_000 },
    );

    await copyLocalFileAtomically(localMasterWav, destinationWav);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Genera locución escena por escena, mide su duración real con ffprobe, calcula slots exactos
 * `[startSec, endSec]` para sincronizar la línea de tiempo y subtítulos, y construye el maestro WAV.
 */
export async function synthesizeSceneSpeechTracks(options: {
  mediaDir: string;
  destinationPath: string;
  blocks: SpeechSegmentInput[];
  language?: string;
  voiceHint?: string;
  pauseBetweenScenesSec?: number;
  alignToBlockDurations?: boolean;
  allowNetworkTts?: boolean;
  signal?: AbortSignal;
}): Promise<SynthesizedSceneSpeechResult> {
  await fs.mkdir(options.mediaDir, { recursive: true });
  const tempSegmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-tts-segs-"));

  const synthesized: Array<{
    index: number;
    label: string;
    narration: string;
    file: string;
    spokenDurationSec: number;
    provider: TtsProviderKind;
  }> = [];

  try {
    for (let i = 0; i < options.blocks.length; i += 1) {
      const block = options.blocks[i]!;
      const segFile = path.join(tempSegmentsDir, `seg-${i}.wav`);
      const text = block.narration.trim();
      const seg = await synthesizeSpeechSegment(text, segFile, {
        language: options.language ?? "es",
        voiceHint: options.voiceHint,
        fallbackDurationSec: Math.max(1.2, block.suggestedDurationSec),
        allowNetworkTts: options.allowNetworkTts,
        signal: options.signal,
      });

      synthesized.push({
        index: i,
        label: block.label,
        narration: text,
        file: seg.file,
        spokenDurationSec: seg.durationSec,
        provider: seg.provider,
      });
    }

    const timings = computeAlignedSceneTimings(
      synthesized.map((item) => item.spokenDurationSec),
      options.pauseBetweenScenesSec ?? 0.28,
      options.alignToBlockDurations
        ? options.blocks.map((b) => Math.max(0.8, b.suggestedDurationSec))
        : undefined,
    );

    await concatenateSceneSpeechWavs(
      synthesized.map((item, idx) => ({
        file: item.file,
        spokenDurationSec: item.spokenDurationSec,
        targetDurationSec: timings[idx]?.durationSec ?? item.spokenDurationSec,
      })),
      options.destinationPath,
      options.signal,
    );

    let totalDurationSec = timings.reduce((acc, s) => acc + s.durationSec, 0);
    try {
      const masterProbe = await probeMedia(options.destinationPath);
      if (masterProbe.durationUs > 0) {
        totalDurationSec = Number((masterProbe.durationUs / 1_000_000).toFixed(3));
      }
    } catch {
      // Usa la suma calculada.
    }

    const primaryProvider =
      synthesized.find((s) => s.provider !== "procedural")?.provider ?? "procedural";

    return {
      file: options.destinationPath,
      totalDurationSec: Math.max(1, totalDurationSec),
      provider: primaryProvider,
      usedRealTts: primaryProvider !== "procedural",
      segments: synthesized.map((item, idx) => {
        const slot = timings[idx]!;
        return {
          index: item.index,
          label: item.label,
          narration: item.narration,
          startSec: slot.startSec,
          endSec: slot.endSec,
          durationSec: slot.durationSec,
          spokenDurationSec: item.spokenDurationSec,
          provider: item.provider,
          file: item.file,
        };
      }),
    };
  } finally {
    await fs.rm(tempSegmentsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
