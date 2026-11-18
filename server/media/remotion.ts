import { execSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { transform } from "esbuild";
import type { ExportSettings, Project, TimelineClip } from "../../src/shared/schema";
import { dimensionsFor, even } from "../../src/shared/presets";
import { fpsValue, framesToSeconds } from "../../src/shared/time";
import { runFfmpeg } from "./process";
import { isLiveRemotionClip, sortTracksByVisualZOrder, visualLayerWeight } from "../../src/shared/timeline";
import { timelineDurationFrames } from "../../src/shared/project";
import {
  buildOverlaySpecs,
  type LiveRemotionExportSpec,
  NOVACUT_OVERLAY_COMPOSITION_ID,
  overlayFonts,
} from "../../src/shared/remotionSpec";
import { sanitizeComponentCode } from "../motion-agent/code-guard";
import { config } from "../config";
import { HttpError } from "../util/fs";

/**
 * Motor de gráficos Remotion: renderiza la capa de texto del proyecto como una
 * secuencia PNG con canal alfa que FFmpeg compone después sobre el video base.
 * El bundle se cachea por proceso; el navegador headless se descarga solo la
 * primera vez (unos 120 MB) gracias a ensureBrowser().
 */

export interface RemotionRenderHooks {
  onProgress?: (ratio: number) => void;
  onMessage?: (message: string) => void;
  signal?: AbortSignal;
}

export interface RenderOverlayOptions {
  /** Duración en segundos para forzar (para skills). Si no se proporciona, usa la duración del proyecto. */
  forcedDurationSeconds?: number;
}

let cachedNproc: number | null | undefined;

function readNprocCount(): number | null {
  if (cachedNproc !== undefined) return cachedNproc;
  if (process.platform !== "linux") {
    cachedNproc = null;
    return null;
  }
  try {
    const parsed = Number.parseInt(execSync("nproc", { stdio: "pipe" }).toString().trim(), 10);
    cachedNproc = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    cachedNproc = null;
  }
  return cachedNproc;
}

export interface SafeRemotionConcurrencyResult {
  concurrency: number;
  requested: number;
  detectedCores: number;
  memoryCap: number;
  clamped: boolean;
  warning?: string;
}

export function computeSafeRemotionConcurrency(options?: {
  requested?: number;
  cpuCores?: number;
  freeMemBytes?: number;
}): SafeRemotionConcurrencyResult {
  const requested = Math.max(1, Math.floor(options?.requested ?? 4));
  const osCores = os.cpus().length || 1;
  const parallelCores = typeof os.availableParallelism === "function" ? os.availableParallelism() : osCores;
  const nprocCores = options?.cpuCores !== undefined ? options.cpuCores : (readNprocCount() ?? parallelCores);
  const detectedCores = Math.max(
    1,
    Math.floor(
      options?.cpuCores !== undefined
        ? options.cpuCores
        : Math.min(osCores, parallelCores, nprocCores),
    ),
  );
  const freeMemBytes = options?.freeMemBytes ?? os.freemem();
  const freeMemGb = freeMemBytes > 0 ? freeMemBytes / (1024 ** 3) : 4;
  const memoryCap = Math.max(1, Math.floor(freeMemGb / 0.6));
  const concurrency = Math.max(1, Math.min(requested, detectedCores, memoryCap));
  const clamped = concurrency < requested;
  const warning = clamped
    ? `Concurrencia de Remotion ajustada automáticamente de ${requested} a ${concurrency} (núcleos: ${detectedCores}, límite memoria: ${memoryCap}).`
    : undefined;
  return {
    concurrency,
    requested,
    detectedCores,
    memoryCap,
    clamped,
    warning,
  };
}

export function resolveSafeRemotionConcurrency(
  preferredMax = 4,
  overrides?: { cpuCores?: number; freeMemBytes?: number },
): number {
  return computeSafeRemotionConcurrency({
    requested: preferredMax,
    cpuCores: overrides?.cpuCores,
    freeMemBytes: overrides?.freeMemBytes,
  }).concurrency;
}

export function remotionEngineAvailable(): boolean {
  return (
    fsSync.existsSync(path.join(config.rootDir, "node_modules", "@remotion", "renderer", "package.json")) &&
    fsSync.existsSync(path.join(config.rootDir, "node_modules", "remotion", "package.json"))
  );
}

let bundlePromise: Promise<string> | null = null;

async function getBundle(hooks: RemotionRenderHooks): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      hooks.onMessage?.("Empaquetando la composición de Remotion");
      const { bundle } = await import("@remotion/bundler");
      return bundle({
        entryPoint: path.join(config.rootDir, "novacut-remotion", "index.tsx"),
        publicDir: path.join(config.assetsDir, "fonts"),
      });
    })().catch((error: unknown) => {
      bundlePromise = null;
      throw error;
    });
  }
  return bundlePromise;
}

export function prewarmRemotionBundle(): void {
  if (!remotionEngineAvailable() || bundlePromise) return;
  void getBundle({}).catch(() => undefined);
}

async function ensureRemotionBrowser(hooks: RemotionRenderHooks): Promise<void> {
  if (process.env.REMOTION_CHROME_EXECUTABLE_PATH) {
    return;
  }
  const { ensureBrowser } = await import("@remotion/renderer");
  hooks.onMessage?.("Comprobando el navegador de render (se descarga solo la primera vez)");
  const status = await ensureBrowser();
  if (status.type === "no-browser") {
    throw new HttpError(
      409,
      "Remotion necesita un navegador headless que no se pudo descargar. Revisa la conexión o usa el motor FFmpeg.",
      "remotion_browser_missing",
    );
  }
}

export interface RemotionOverlayRender {
  framesDir: string;
  frameCount: number;
  overlayFps: number;
}

export function shouldRenderClipInRemotion(clip: TimelineClip): boolean {
  return isLiveRemotionClip(clip);
}

export async function buildLiveRemotionExportSpecs(
  project: Project,
  settings: ExportSettings,
  targetFps: number = settings.fps,
): Promise<LiveRemotionExportSpec[]> {
  const { width, height } = dimensionsFor(settings.aspect, settings.resolution);
  const projectFps = Math.max(1, project.settings.fps.num / Math.max(1, project.settings.fps.den));
  const exportFps = Math.max(1, targetFps);
  const fpsRatio = exportFps / projectFps;

  const orderedTracks = sortTracksByVisualZOrder(project.tracks);

  const liveSpecs: LiveRemotionExportSpec[] = [];

  for (const track of orderedTracks) {
    const trackZIndex = visualLayerWeight(track) * 10;
    for (const clip of track.clips) {
      if (!shouldRenderClipInRemotion(clip) || !clip.remotion) continue;

      let cjsCode = "";
      let resolvedCompName = clip.remotion.componentName || "MotionComponent";
      try {
        const sanitized = sanitizeComponentCode(clip.remotion.code);
        if (sanitized.name) {
          resolvedCompName = sanitized.name;
        }
        const compiled = await transform(sanitized.code, {
          loader: "tsx",
          format: "cjs",
          target: "es2020",
          jsx: "transform",
          jsxFactory: "React.createElement",
          jsxFragment: "React.Fragment",
        });
        cjsCode = compiled.code;
      } catch (err) {
        console.warn(`[remotion-export] Error compilando TSX del clip ${clip.id}:`, err);
      }

      const startFrame = Math.max(0, Math.round(clip.startFrame * fpsRatio));
      const durationFrames = Math.max(1, Math.round(clip.durationFrames * fpsRatio));

      const rawProps = { ...(clip.remotion.props ?? {}) };
      if (Math.abs(fpsRatio - 1) > 0.001 && Array.isArray(rawProps.captions)) {
        rawProps.captions = (rawProps.captions as Array<any>).map((cue) => ({
          ...cue,
          start: Math.max(0, Math.round(Number(cue.start ?? 0) * fpsRatio)),
          end: Math.max(1, Math.round(Number(cue.end ?? 1) * fpsRatio)),
          words: Array.isArray(cue.words)
            ? cue.words.map((w: any) => ({
              ...w,
              start: Math.max(0, Math.round(Number(w.start ?? 0) * fpsRatio)),
              end: Math.max(1, Math.round(Number(w.end ?? 1) * fpsRatio)),
            }))
            : [],
        }));
      }

      let transformStyle: string | undefined;
      let transformOrigin = "center center";
      if (clip.type !== "text") {
        const tx = clip.transform.x;
        const ty = clip.transform.y;
        const sc = clip.transform.scale;
        const rot = clip.transform.rotation;
        if (tx !== 0 || ty !== 0 || sc !== 1 || rot !== 0) {
          transformStyle = `translate(${tx}%, ${ty}%) scale(${sc}) rotate(${rot}deg)`;
        }
      } else {
        const ox = Number(clip.remotion.props?.offsetX ?? 0);
        const hasNativeScale = /fontScale|scaleMult/.test(clip.remotion.code);
        const hasNativePosY = /positionY/.test(clip.remotion.code);
        const rawFontScale = Number(clip.remotion.props?.fontScale ?? 1);
        const fontScale = rawFontScale > 5 ? rawFontScale / 100 : rawFontScale;
        const defaultPosY = height > width ? 0.74 : 0.88;
        const rawPosY = Number(clip.remotion.props?.positionY ?? defaultPosY);
        const posY = rawPosY > 1.5 ? rawPosY / 100 : rawPosY;
        const dyPct = hasNativePosY ? 0 : (posY - defaultPosY) * 100;
        const sc = hasNativeScale ? 1 : fontScale;
        if (ox !== 0 || Math.abs(dyPct) > 0.01 || Math.abs(sc - 1) > 0.005) {
          transformOrigin = `50% ${Math.round(posY * 100)}%`;
          transformStyle = `translate(${ox}%, ${dyPct}%) scale(${sc})`;
        }
      }

      liveSpecs.push({
        id: clip.id,
        cjsCode,
        componentName: resolvedCompName,
        compositionId: clip.remotion.compositionId || "MotionComp",
        startFrame,
        durationFrames,
        props: rawProps,
        opacity: clip.opacity ?? 1,
        transformStyle,
        transformOrigin,
        zIndex: trackZIndex,
      });
    }
  }

  return liveSpecs;
}

/**
 * Renderiza la capa de texto y componentes Remotion en vivo como PNG secuencia con alfa.
 * Devuelve frameCount 0 cuando el proyecto no tiene capas visibles para Remotion.
 */
export async function renderOverlaySequence(
  project: Project,
  settings: ExportSettings,
  framesDir: string,
  hooks: RemotionRenderHooks = {},
  options: RenderOverlayOptions = {}
): Promise<RemotionOverlayRender> {
  const maxOverlayFps = settings.quality === "high" ? 30 : 24;
  const overlayFps = Math.min(maxOverlayFps, Math.max(1, settings.fps));
  const specs = buildOverlaySpecs(project, settings);
  const liveClips = await buildLiveRemotionExportSpecs(project, settings, overlayFps);
  if (specs.length === 0 && liveClips.length === 0) return { framesDir, frameCount: 0, overlayFps };

  if (!remotionEngineAvailable()) {
    throw new HttpError(
      409,
      "El motor Remotion no está instalado. Ejecuta npm install y vuelve a intentarlo, o usa el motor FFmpeg.",
      "remotion_not_installed",
    );
  }

  await fs.mkdir(framesDir, { recursive: true });
  await ensureRemotionBrowser(hooks);
  const serveUrl = await getBundle(hooks);
  hooks.onProgress?.(0.02);

  const { width, height } = dimensionsFor(settings.aspect, settings.resolution);
  // Usar duración forzada si se proporciona, sino duración del proyecto
  let durationFrames: number;
  let durationSeconds: number;
  if (options.forcedDurationSeconds !== undefined) {
    durationSeconds = options.forcedDurationSeconds;
  } else {
    durationFrames = timelineDurationFrames(project);
    durationSeconds = framesToSeconds(durationFrames, project.settings.fps);
  }
  const durationInFrames = Math.max(1, Math.round(durationSeconds * overlayFps));

  const { renderFrames, makeCancelSignal } = await import("@remotion/renderer");
  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  hooks.signal?.addEventListener("abort", onAbort);
  hooks.onMessage?.("Renderizando los gráficos con Remotion");

  try {
    // En Remotion >= 4.0.539 el render usa `composition.props` como props
    // resueltos; `inputProps` solo alimenta calculateMetadata. Se pasa lo mismo
    // en ambos sitios para que la composición reciba los overlays y liveClips.
    const inputProps = {
      overlays: specs,
      fonts: overlayFonts(specs, { includeAllFamilies: liveClips.length > 0 }),
      liveClips,
    };
    const composition = {
      id: NOVACUT_OVERLAY_COMPOSITION_ID,
      width,
      height,
      fps: overlayFps,
      durationInFrames,
      defaultProps: inputProps,
      props: inputProps,
      defaultCodec: null,
      defaultOutName: null,
      defaultVideoImageFormat: null,
      defaultPixelFormat: null,
      defaultProResProfile: null,
      defaultSampleRate: null,
    };
    const renderScale =
      settings.quality === "high" ? 0.85 : settings.quality === "draft" ? 0.6 : 0.72;
    const concurrencyPlan = computeSafeRemotionConcurrency({ requested: 4 });
    if (concurrencyPlan.warning) {
      hooks.onMessage?.(concurrencyPlan.warning);
    }
    const runRenderWithConcurrency = async (concurrency: number) => {
      await renderFrames({
        serveUrl,
        composition,
        inputProps,
        outputDir: framesDir,
        imageFormat: "png",
        scale: renderScale,
        concurrency,
        cancelSignal,
        browserExecutable: process.env.REMOTION_CHROME_EXECUTABLE_PATH || undefined,
        chromiumOptions: {
          gl: process.platform === "win32" ? "angle" : "swiftshader",
          enableMultiProcessOnLinux: true,
        },
        onFrameUpdate: (rendered: number) => hooks.onProgress?.(Math.min(1, rendered / durationInFrames)),
        onStart: () => undefined,
      });
    };
    try {
      await runRenderWithConcurrency(concurrencyPlan.concurrency);
    } catch (firstErr) {
      if (hooks.signal?.aborted) throw firstErr;
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const isConcurrencyOrMemError = /concurrency|cores|memory|out of memory|oom|browser/i.test(msg);
      if (isConcurrencyOrMemError && concurrencyPlan.concurrency > 1) {
        const retryConcurrency = concurrencyPlan.concurrency > 2 ? 2 : 1;
        hooks.onMessage?.(`Reintentando render Remotion con concurrencia reducida (${retryConcurrency}) tras fallo: ${msg}`);
        await runRenderWithConcurrency(retryConcurrency);
      } else {
        throw firstErr;
      }
    }
  } catch (error) {
    if (hooks.signal?.aborted) throw new HttpError(499, "Render de gráficos cancelado.", "job_cancelled");
    throw new HttpError(
      502,
      `El render de Remotion falló: ${error instanceof Error ? error.message : String(error)}`,
      "remotion_render_failed",
    );
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
  }

  const renamed = await normalizeFrameNames(framesDir);
  return { framesDir, frameCount: renamed, overlayFps };
}

export interface StillFrameRequest {
  timeSec: number;
  outPath: string;
  backgroundFile?: string;
  backgroundHex?: string;
}

export interface StillFrameResult {
  timeSec: number;
  ok: boolean;
  outPath: string;
  width: number;
  height: number;
  error?: string;
}

function closestValidPresetHeight(height: number): 480 | 720 | 1080 | 1440 | 2160 {
  const presets = [480, 720, 1080, 1440, 2160] as const;
  return presets.reduce((best, cand) => (Math.abs(cand - height) < Math.abs(best - height) ? cand : best), 1080 as 480 | 720 | 1080 | 1440 | 2160);
}

function closestValidPresetFps(fps: number): 24 | 25 | 30 | 50 | 60 {
  const presets = [24, 25, 30, 50, 60] as const;
  return presets.reduce((best, cand) => (Math.abs(cand - fps) < Math.abs(best - fps) ? cand : best), 30 as 24 | 25 | 30 | 50 | 60);
}

/**
 * Renderiza fotogramas reales puntuales usando `@remotion/renderer` `renderStill`
 * reutilizando bundle y navegador headless compartidos entre todos los timestamps.
 */
export async function renderTimelineStillFrames(
  project: Project,
  requests: StillFrameRequest[],
  options: { scale?: number; signal?: AbortSignal } = {},
): Promise<StillFrameResult[]> {
  if (requests.length === 0) return [];

  const scale = Math.max(0.15, Math.min(1, options.scale ?? 0.45));
  const fullW = even(Math.max(160, project.settings.width));
  const fullH = even(Math.max(160, project.settings.height));
  const outW = even(Math.max(160, Math.round(fullW * scale)));
  const outH = even(Math.max(160, Math.round(fullH * scale)));

  const projectFps = fpsValue(project.settings.fps);
  const renderSettings: ExportSettings = {
    resolution: closestValidPresetHeight(fullH),
    aspect: project.settings.aspect,
    fps: closestValidPresetFps(projectFps),
    quality: "standard",
    encoder: "cpu",
    engine: "remotion",
    fileName: "preview.mp4",
  };

  const specs = buildOverlaySpecs(project, renderSettings);
  const liveClips = await buildLiveRemotionExportSpecs(project, renderSettings, projectFps);

  if (!remotionEngineAvailable() || (specs.length === 0 && liveClips.length === 0)) {
    return requests.map((req) => ({
      timeSec: req.timeSec,
      ok: false,
      outPath: req.outPath,
      width: outW,
      height: outH,
      error: specs.length === 0 && liveClips.length === 0 ? "no_remotion_layers" : "remotion_unavailable",
    }));
  }

  await ensureRemotionBrowser({ signal: options.signal });
  const serveUrl = await getBundle({ signal: options.signal });
  const { renderStill, openBrowser, makeCancelSignal } = await import("@remotion/renderer");
  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  options.signal?.addEventListener("abort", onAbort);

  const durationInFrames = Math.max(1, timelineDurationFrames(project));
  const inputProps = {
    overlays: specs,
    fonts: overlayFonts(specs, { includeAllFamilies: liveClips.length > 0 }),
    liveClips,
  };
  const composition = {
    id: NOVACUT_OVERLAY_COMPOSITION_ID,
    width: fullW,
    height: fullH,
    fps: Math.max(1, Math.round(projectFps)),
    durationInFrames,
    defaultProps: inputProps,
    props: inputProps,
    defaultCodec: null,
    defaultOutName: null,
    defaultVideoImageFormat: null,
    defaultPixelFormat: null,
    defaultProResProfile: null,
    defaultSampleRate: null,
  };

  const browserExecutable = process.env.REMOTION_CHROME_EXECUTABLE_PATH || undefined;
  const chromiumOptions = {
    gl: (process.platform === "win32" ? "angle" : "swiftshader") as "angle" | "swiftshader",
    enableMultiProcessOnLinux: true,
  };

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-still-"));
  let puppeteerInstance: Awaited<ReturnType<typeof openBrowser>> | undefined;
  const results: StillFrameResult[] = [];

  try {
    puppeteerInstance = await openBrowser("chrome", {
      browserExecutable,
      chromiumOptions,
    }).catch(() => undefined);

    for (let i = 0; i < requests.length; i += 1) {
      const req = requests[i]!;
      const frame = Math.max(0, Math.min(durationInFrames - 1, Math.round(req.timeSec * projectFps)));
      const rawStill = path.join(workDir, `still-${i}.png`);
      const compositedTmp = path.join(workDir, `comp-${i}.png`);

      try {
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          frame,
          output: rawStill,
          imageFormat: "png",
          scale,
          overwrite: true,
          cancelSignal,
          browserExecutable,
          chromiumOptions,
          ...(puppeteerInstance ? { puppeteerInstance } : {}),
        });

        await fs.mkdir(path.dirname(req.outPath), { recursive: true });
        const bgHex = (req.backgroundHex || "#090D18").replace(/^#/, "0x");
        if (req.backgroundFile && fsSync.existsSync(req.backgroundFile)) {
          await runFfmpeg(
            [
              "-y",
              "-i",
              req.backgroundFile,
              "-i",
              rawStill,
              "-filter_complex",
              `[0:v]scale=${outW}:${outH}:flags=bicubic[bg];[1:v]scale=${outW}:${outH}:flags=bicubic,format=rgba[ov];[bg][ov]overlay=0:0:format=auto[v]`,
              "-map",
              "[v]",
              "-frames:v",
              "1",
              compositedTmp,
            ],
            { signal: options.signal, timeoutMs: 12_000 },
          );
          await fs.copyFile(compositedTmp, req.outPath);
        } else {
          await runFfmpeg(
            [
              "-y",
              "-f",
              "lavfi",
              "-i",
              `color=c=${bgHex}:s=${outW}x${outH}:d=0.1`,
              "-i",
              rawStill,
              "-filter_complex",
              `[1:v]scale=${outW}:${outH}:flags=bicubic,format=rgba[ov];[0:v][ov]overlay=0:0:shortest=1[v]`,
              "-map",
              "[v]",
              "-frames:v",
              "1",
              compositedTmp,
            ],
            { signal: options.signal, timeoutMs: 12_000 },
          ).catch(async () => {
            await fs.copyFile(rawStill, compositedTmp);
          });
          await fs.copyFile(compositedTmp, req.outPath);
        }

        results.push({
          timeSec: req.timeSec,
          ok: true,
          outPath: req.outPath,
          width: outW,
          height: outH,
        });
      } catch (err) {
        results.push({
          timeSec: req.timeSec,
          ok: false,
          outPath: req.outPath,
          width: outW,
          height: outH,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await puppeteerInstance?.close({ silent: false }).catch(() => undefined);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return results;
}

/**
 * renderFrames escribe "element-<n>.png" con un padding interno; FFmpeg
 * necesita un patrón estable. Renombera a frame_000000.png en orden.
 */
async function normalizeFrameNames(framesDir: string): Promise<number> {
  const entries = await fs.readdir(framesDir);
  const pngs = entries
    .filter((name) => name.endsWith(".png"))
    .map((name) => {
      const match = name.match(/(\d+)\.png$/);
      return { name, index: match?.[1] ? Number(match[1]) : Number.NaN };
    })
    .filter((item) => Number.isFinite(item.index))
    .sort((a, b) => a.index - b.index);
  for (const [position, item] of pngs.entries()) {
    if (item.name !== `frame_${String(position).padStart(6, "0")}.png`) {
      await fs.rename(
        path.join(framesDir, item.name),
        path.join(framesDir, `frame_${String(position).padStart(6, "0")}.png`),
      );
    }
  }
  return pngs.length;
}