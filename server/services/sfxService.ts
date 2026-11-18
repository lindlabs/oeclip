import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type MediaAsset, type Project } from "../../src/shared/schema";
import { makeMediaClip } from "../../src/shared/project";
import { addClip, ensureSfxTrack } from "../../src/shared/timeline";
import { newId, frameDurationUs } from "../../src/shared/time";
import { projectMediaDirectory, projectStore } from "../projects/store";
import { runFfmpeg } from "../media/process";
import { eventBus } from "../events";

export type SfxType = "whoosh" | "pop" | "ding" | "riser" | "subhit" | "glitch";
export type MusicBedMood = "cinema" | "tech" | "ambient" | "energetic";

export const SFX_DURATIONS_US: Record<SfxType, number> = {
  whoosh: 350_000, // 0.35s
  pop: 120_000,    // 0.12s
  ding: 650_000,   // 0.65s
  riser: 1_100_000, // 1.10s
  subhit: 850_000, // 0.85s
  glitch: 280_000, // 0.28s
};

const PROCEDURAL_SFX_EXPR: Record<SfxType, { expr: string; durSec: number }> = {
  riser: {
    expr: "(0.28*sin(2*PI*(80+1180*pow(t/1.1,2.1))*t)+0.16*sin(2*PI*(160+2360*pow(t/1.1,2.1))*t)+0.09*(2*mod(t*43758.5453,1)-1)*(t/1.1))*min(1,t/0.92)*(1-max(0,(t-1.02)/0.08))",
    durSec: 1.1,
  },
  subhit: {
    expr: "(0.66*sin(2*PI*(38+64*exp(-4.8*t))*t)+0.22*sin(2*PI*76*t)*exp(-6*t)+0.14*sin(2*PI*190*t)*exp(-18*t))*exp(-2.6*t)",
    durSec: 0.85,
  },
  glitch: {
    expr: "(0.28*sin(2*PI*(580+1040*sin(2*PI*42*t))*t)+0.18*(2*mod(t*9871.3,1)-1)*max(0,sin(2*PI*24*t)))*exp(-7.5*mod(t,0.068))",
    durSec: 0.28,
  },
  whoosh: {
    expr: "(0.24*sin(2*PI*(160+480*sin(PI*t/0.35))*t)+0.18*(2*mod(t*15485.7,1)-1)*sin(PI*t/0.35))*sin(PI*t/0.35)",
    durSec: 0.35,
  },
  pop: {
    expr: "(0.48*sin(2*PI*(540*exp(-18*t)+155)*t)+0.16*sin(2*PI*1080*exp(-24*t)*t))*exp(-21*t)",
    durSec: 0.12,
  },
  ding: {
    expr: "0.36*sin(2*PI*987.77*t)*exp(-4.2*t)+0.22*sin(2*PI*1479.98*t)*exp(-5.0*t)+0.12*sin(2*PI*1975.53*t)*exp(-6.5*t)",
    durSec: 0.65,
  },
};

/**
 * Construye una expresión armónica multi-compás (progresión de 4 acordes + sub-bajo + arpegio/textura)
 * para sintetizar camas musicales evolutivas sin dependencia de archivos MP3 externos.
 */
export function buildProceduralMusicExpression(mood: MusicBedMood): string {
  // Progresión cíclica cada 8 segundos (2s por acorde: Am - F - C - G / variantes por atmósfera).
  const step0 = "between(mod(t,8),0,2)";
  const step1 = "between(mod(t,8),2,4)";
  const step2 = "between(mod(t,8),4,6)";
  const step3 = "gte(mod(t,8),6)";

  switch (mood) {
    case "tech": {
      const bassHz = `(${step0}*110+${step1}*87.31+${step2}*130.81+${step3}*98)`;
      const fifthHz = `(${step0}*164.81+${step1}*130.81+${step2}*196+${step3}*146.83)`;
      const arpHz = `(${step0}*440+${step1}*349.23+${step2}*523.25+${step3}*392)*(1+0.5*gte(mod(t,0.5),0.25))`;
      const pulse = "pow(0.5+0.5*sin(2*PI*2*t),2)";
      const hiPulse = "pow(max(0,sin(2*PI*4*t)),3)";
      return `0.21*sin(2*PI*${bassHz}*t)*(0.65+0.35*${pulse})+0.13*sin(2*PI*${fifthHz}*t)+0.07*sin(2*PI*${arpHz}*t)*${hiPulse}`;
    }
    case "energetic": {
      const bassHz = `(${step0}*98+${step1}*110+${step2}*130.81+${step3}*146.83)`;
      const chordHz = `(${step0}*196+${step1}*220+${step2}*261.63+${step3}*293.66)`;
      const kickEnv = "exp(-14*mod(t,0.5))";
      const kick = `0.24*sin(2*PI*(44+70*exp(-28*mod(t,0.5)))*mod(t,0.5))*${kickEnv}`;
      const lead = `0.09*sin(2*PI*${chordHz}*2*t)*(0.4+0.6*pow(max(0,sin(2*PI*4*t)),2))`;
      return `${kick}+0.16*sin(2*PI*${bassHz}*t)+0.11*sin(2*PI*${chordHz}*t)+${lead}`;
    }
    case "cinema": {
      const rootHz = `(${step0}*110+${step1}*87.31+${step2}*130.81+${step3}*98)`;
      const thirdHz = `(${step0}*130.81+${step1}*103.83+${step2}*164.81+${step3}*123.47)`;
      const fifthHz = `(${step0}*164.81+${step1}*130.81+${step2}*196+${step3}*146.83)`;
      const swell = "(0.72+0.28*sin(2*PI*0.25*t))";
      return `0.22*sin(2*PI*${rootHz}*t)*${swell}+0.13*sin(2*PI*${thirdHz}*t)*(0.75+0.25*cos(2*PI*0.18*t))+0.10*sin(2*PI*${fifthHz}*t)+0.05*sin(2*PI*${rootHz}*4*t)*(0.5+0.5*sin(2*PI*0.5*t))`;
    }
    case "ambient":
    default: {
      const rootHz = `(${step0}*146.83+${step1}*130.81+${step2}*110+${step3}*123.47)`;
      const fifthHz = `(${step0}*220+${step1}*196+${step2}*164.81+${step3}*185)`;
      const shimmerHz = `(${step0}*329.63+${step1}*293.66+${step2}*261.63+${step3}*293.66)`;
      return `0.18*sin(2*PI*${rootHz}*t)*(0.78+0.22*sin(2*PI*0.15*t))+0.12*sin(2*PI*${fifthHz}*t)+0.08*sin(2*PI*${shimmerHz}*t)*(0.6+0.4*cos(2*PI*0.22*t))`;
    }
  }
}

export async function generateProceduralSfxWav(
  sfxType: SfxType,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const spec = PROCEDURAL_SFX_EXPR[sfxType];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-sfx-"));
  const localWav = path.join(tempDir, `sfx-${sfxType}.wav`);
  try {
    await runFfmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=${spec.expr}:d=${spec.durSec.toFixed(2)}:s=48000`,
        "-c:a",
        "pcm_s16le",
        "-ac",
        "1",
        localWav,
      ],
      { signal: signal ?? AbortSignal.timeout(15_000), timeoutMs: 15_000 },
    );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(localWav, destination);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Resuelve la ruta al archivo SFX fuente en assets o public.
 */
function getSourceSfxPath(sfxType: SfxType): string {
  const assetsPath = path.join(process.cwd(), "assets", "sfx", `${sfxType}.wav`);
  return assetsPath;
}

/**
 * Garantiza que el recurso de audio SFX exista en el catálogo multimedia del proyecto.
 * Usa archivos WAV nativos para whoosh/pop/ding y síntesis procedural FFmpeg para riser/subhit/glitch o fallback.
 */
export async function ensureProjectSfxAsset(
  projectId: string,
  sfxType: SfxType,
): Promise<MediaAsset> {
  const bundle = await projectStore.get(projectId);
  const targetName = `SFX ${sfxType.toUpperCase()}`;
  const targetRelativeFile = `media/sfx-${sfxType}.wav`;

  const existing = bundle.project.media.find(
    (m) =>
      m.origin === "generated" &&
      (m.name === targetName || m.file === targetRelativeFile),
  );
  if (existing) return existing;

  const mediaDir = projectMediaDirectory(projectId);
  await fs.mkdir(mediaDir, { recursive: true });
  const destination = path.join(mediaDir, `sfx-${sfxType}.wav`);

  const isProceduralPrimary = sfxType === "riser" || sfxType === "subhit" || sfxType === "glitch";
  if (isProceduralPrimary) {
    await generateProceduralSfxWav(sfxType, destination);
  } else {
    const sourceFile = getSourceSfxPath(sfxType);
    try {
      await fs.copyFile(sourceFile, destination);
    } catch {
      try {
        const fallbackPath = path.join(process.cwd(), "public", "sfx", `${sfxType}.wav`);
        await fs.copyFile(fallbackPath, destination);
      } catch {
        await generateProceduralSfxWav(sfxType, destination);
      }
    }
  }

  const stat = await fs.stat(destination);
  const asset: MediaAsset = {
    id: newId("med"),
    name: targetName,
    kind: "audio",
    file: targetRelativeFile,
    mimeType: "audio/wav",
    sizeBytes: stat.size,
    durationUs: SFX_DURATIONS_US[sfxType] ?? 350_000,
    audioCodec: "pcm_s16le",
    sampleRate: 48000,
    channels: 1,
    thumbnail: "pending",
    waveform: "none",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "generated",
  };

  await projectStore.addMedia(projectId, asset);
  return asset;
}

/**
 * Genera o recupera una cama musical ambiental estéreo libre de derechos mediante síntesis
 * armónica procedural con FFmpeg adaptada a la duración y atmósfera emocional del video.
 */
export async function ensureProceduralMusicBedAsset(
  projectId: string,
  durationSec: number,
  mood: MusicBedMood,
  signal?: AbortSignal,
): Promise<MediaAsset> {
  const safeDur = Math.max(4, Math.min(300, Number(durationSec.toFixed(2))));
  const bundle = await projectStore.get(projectId);
  const targetRelativeFile = `media/bgm-${mood}.wav`;
  const existing = bundle.project.media.find(
    (m) =>
      m.origin === "generated" &&
      m.file === targetRelativeFile &&
      m.durationUs >= Math.round(safeDur * 950_000),
  );
  if (existing) return existing;

  const mediaDir = projectMediaDirectory(projectId);
  await fs.mkdir(mediaDir, { recursive: true });
  const destination = path.join(mediaDir, `bgm-${mood}.wav`);

  const expr = buildProceduralMusicExpression(mood);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-bgm-"));
  const localWav = path.join(tempDir, `bgm-${mood}.wav`);
  try {
    await runFfmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc='${expr}':d=${safeDur.toFixed(2)}:s=44100`,
        "-af",
        `lowpass=f=3600,aecho=0.85:0.75:24|42:0.22|0.14,acompressor=threshold=0.25:ratio=2.4:attack=15:release=180,afade=t=in:st=0:d=1.0,afade=t=out:st=${Math.max(0, safeDur - 1.4).toFixed(2)}:d=1.4`,
        "-c:a",
        "pcm_s16le",
        "-ac",
        "2",
        localWav,
      ],
      { signal: signal ?? AbortSignal.timeout(25_000), timeoutMs: 25_000 },
    );
    await fs.copyFile(localWav, destination);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const stat = await fs.stat(destination);
  const asset: MediaAsset = {
    id: newId("med"),
    name: `Música Fondo (${mood.toUpperCase()})`,
    kind: "audio",
    file: targetRelativeFile,
    mimeType: "audio/wav",
    sizeBytes: stat.size,
    durationUs: Math.round(safeDur * 1_000_000),
    audioCodec: "pcm_s16le",
    sampleRate: 44100,
    channels: 2,
    thumbnail: "pending",
    waveform: "none",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "generated",
  };

  await projectStore.addMedia(projectId, asset);
  return asset;
}

/**
 * Determina el micro-efecto de sonido idóneo según el nombre o código del componente:
 * - "whoosh": Entradas cinematográficas, Lower Thirds, Títulos, Transiciones (Whip Pan, Zoom Punch).
 * - "ding": Gráficos estadísticos, KPI, contadores de dinero/ventas, tarjetas de datos.
 * - "pop": Emojis, badges, botones, corazones, iconos animados.
 */
export function determineSfxForComponent(
  componentName: string,
  code?: string,
): SfxType {
  const combined = `${componentName} ${code ?? ""}`.toLowerCase();
  if (
    /\b(metric|kpi|data|stat|gr[áa]fico|grafico|dinero|money|cuenta|contador|percent|porcentaje|ventas|sales|crecimiento|growth|ding)\b/i.test(
      combined,
    )
  ) {
    return "ding";
  }
  if (
    /\b(pop|badge|pill|emoji|icon|icono|cta|heart|coraz[óo]n|like|boton|button|star|estrella|tag)\b/i.test(
      combined,
    )
  ) {
    return "pop";
  }
  return "whoosh";
}

export interface SyncSfxOptions {
  sfxType?: SfxType;
  startFrame: number;
  componentName?: string;
  code?: string;
}

export interface SyncSfxResult {
  ok: boolean;
  sfxType: SfxType;
  clipId?: string;
  startFrame: number;
  durationFrames: number;
  trackName: string;
}

/**
 * Sincroniza e inserta automáticamente un micro-efecto de sonido (whoosh, pop, ding)
 * en la pista de audio "SFX" del proyecto, justo en el frame donde entra el elemento gráfico.
 */
export async function syncMotionSoundEffect(
  projectId: string,
  options: SyncSfxOptions,
): Promise<SyncSfxResult> {
  const sfxType =
    options.sfxType ??
    determineSfxForComponent(options.componentName ?? "", options.code);

  const asset = await ensureProjectSfxAsset(projectId, sfxType);
  const bundle = await projectStore.get(projectId);
  const project = bundle.project;

  // Garantizar que existe la pista de audio "SFX"
  const sfxTrackResult = ensureSfxTrack(project);
  let updatedProject = sfxTrackResult.project;
  const sfxTrack = sfxTrackResult.track;

  // Verificar si ya hay un clip SFX en exactamente el mismo fotograma para no duplicar
  const existingClip = sfxTrack.clips.find(
    (c) => Math.abs(c.startFrame - options.startFrame) < 3,
  );
  if (existingClip) {
    return {
      ok: true,
      sfxType,
      clipId: existingClip.id,
      startFrame: existingClip.startFrame,
      durationFrames: existingClip.durationFrames,
      trackName: sfxTrack.name,
    };
  }

  // Calcular duración en fotogramas del clip de audio
  const fps = project.settings.fps;
  const frameDurUs = frameDurationUs(fps);
  const durationFrames = Math.max(
    1,
    Math.round(asset.durationUs / Math.max(1, frameDurUs)),
  );

  const mediaClip = {
    ...makeMediaClip(updatedProject, asset, {
      startFrame: Math.max(0, Math.round(options.startFrame)),
      durationFrames,
      createdBy: "agent",
    }),
    name: `SFX ${sfxType.toUpperCase()}`,
    volume: 0.9,
  };

  const addResult = addClip(updatedProject, sfxTrack.id, mediaClip);
  if (!addResult.ok) {
    console.warn(
      `[SfxService] No se pudo insertar clip SFX en ${sfxTrack.id}: ${addResult.error}`,
    );
    return {
      ok: false,
      sfxType,
      startFrame: options.startFrame,
      durationFrames,
      trackName: sfxTrack.name,
    };
  }

  const saved = await projectStore.saveTimeline(projectId, addResult.project, {
    force: true,
  });

  eventBus.publish(projectId, {
    type: "project",
    projectId,
    revision: saved.project.revision,
  });

  console.log(
    `[SfxService] Micro-SFX "${sfxType}" sincronizado en pista "${sfxTrack.name}" @ frame ${options.startFrame} (rev ${saved.project.revision})`,
  );

  return {
    ok: true,
    sfxType,
    clipId: mediaClip.id,
    startFrame: mediaClip.startFrame,
    durationFrames: mediaClip.durationFrames,
    trackName: sfxTrack.name,
  };
}

