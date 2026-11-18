"use strict";
/**
 * Worker de render de Remotion.
 *
 * Se ejecuta en un worker_thread. Es JavaScript puro a propósito: el servidor
 * arranca con tsx y no hay paso de compilación, así que un artefacto .cjs
 * compilado se quedaba obsoleto (y provocaba diferencias invisibles entre lo
 * que se probaba y lo que corría de verdad).
 *
 * Optimizaciones clave para que insertar sea rápido:
 *  - El bundle de webpack se guarda en caché por código de componente. El
 *    preview y el render final del mismo componente comparten bundle.
 *  - El encoder VP9 usa el preset `realtime` (3x más rápido que el preset por
 *    defecto) manteniendo el canal alfa.
 *  - Los props NO se incrustan en el entry: se pasan al render, así el bundle
 *    se reutiliza aunque cambien los subtítulos.
 */
import { parentPort, threadId } from "node:worker_threads";
import { execSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia } from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

let cachedNproc;

function resolveSafeWorkerConcurrency(requested) {
  const osCores = os.cpus().length || 1;
  const parallelCores = typeof os.availableParallelism === "function" ? os.availableParallelism() : osCores;
  if (cachedNproc === undefined) {
    if (process.platform === "linux") {
      try {
        const parsed = Number.parseInt(execSync("nproc", { stdio: "pipe" }).toString().trim(), 10);
        cachedNproc = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      } catch {
        cachedNproc = null;
      }
    } else {
      cachedNproc = null;
    }
  }
  const maxAllowed = Math.max(1, Math.min(osCores, parallelCores, cachedNproc ?? parallelCores));
  const fallback = Math.max(1, Math.min(4, maxAllowed));
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
    return Math.max(1, Math.min(Math.floor(requested), maxAllowed));
  }
  return fallback;
}

const WORK_ROOT =
  process.env.NOVACUT_MOTION_TEMP?.trim() ||
  path.join(os.tmpdir(), "novacut-motion");
const COMPONENTS_DIR = path.join(WORK_ROOT, "components");
const BUNDLES_DIR = path.join(WORK_ROOT, "bundles");
const PREVIEW_DIR = path.join(WORK_ROOT, "previews");

const MAX_BUNDLES = 8;
const BUNDLE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_COMPONENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const running = new Map();

function emit(message) {
  parentPort?.postMessage(message);
}

function postProgress(job, stage, progress, extra = {}) {
  emit({
    id: job.id,
    type: "progress",
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...extra,
  });
}

function toForwardSlashes(p) {
  return p.replace(/\\/g, "/");
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function hashFileContent(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 20);
}

function entryCodeFor(job) {
  return `import { Composition, registerRoot } from "remotion";
import { ${job.componentName} } from "./${job.componentName}";

registerRoot(() => (
  <Composition
    id="${job.compositionId}"
    component={${job.componentName}}
    durationInFrames={${job.durationInFrames}}
    fps={${job.fps}}
    width={${job.width}}
    height={${job.height}}
  />
));
`;
}

async function prepareComponent(job, key) {
  const dir = path.join(COMPONENTS_DIR, key);
  await fs.mkdir(dir, { recursive: true });
  const componentPath = path.join(dir, `${job.componentName}.tsx`);
  const current = await fs.readFile(componentPath, "utf-8").catch(() => null);
  if (current !== job.componentCode) {
    await fs.writeFile(componentPath, job.componentCode, "utf-8");
  }
  const entryPath = path.join(dir, "index.tsx");
  const entry = entryCodeFor(job);
  const currentEntry = await fs.readFile(entryPath, "utf-8").catch(() => null);
  if (currentEntry !== entry) {
    await fs.writeFile(entryPath, entry, "utf-8");
  }
  return { dir, entryPath };
}

async function pruneBundles(keepPath) {
  const entries = await fs.readdir(BUNDLES_DIR, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(BUNDLES_DIR, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat) dirs.push({ path: full, mtime: stat.mtimeMs });
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  for (let index = 0; index < dirs.length; index += 1) {
    const item = dirs[index];
    const tooMany = index >= MAX_BUNDLES;
    const tooOld = now - item.mtime > BUNDLE_MAX_AGE_MS;
    if (item.path === keepPath) continue;
    if (tooMany || tooOld) {
      await fs.rm(item.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function pruneComponents() {
  const entries = await fs.readdir(COMPONENTS_DIR, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(COMPONENTS_DIR, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > MAX_COMPONENT_AGE_MS) {
      await fs.rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Devuelve el directorio del bundle listo para servir, reutilizando el de
 * caché si ya existe. `job.bundleKey` lo calcula el servidor a partir del
 * código y de la forma de la composición (dimensiones, fps y duración).
 */
async function ensureBundle(job) {
  const key = job.bundleKey || (await hashFileContent(job.componentCode + entryCodeFor(job)));
  const cachedDir = path.join(BUNDLES_DIR, key);
  if (await exists(path.join(cachedDir, "index.html"))) {
    return { serveUrl: cachedDir, bundleMs: 0, bundleCached: true };
  }

  const started = Date.now();
  const { entryPath } = await prepareComponent(job, key);
  const built = await bundle({
    entryPoint: entryPath,
    ignoreRegisterRootWarning: true,
    onProgress: (progress) => postProgress(job, "bundle", progress),
    webpackOverride: (config) => {
      config.cache = {
        type: "filesystem",
        cacheDirectory: path.join(WORK_ROOT, "webpack-cache"),
      };
      return config;
    },
  });

  await fs.mkdir(BUNDLES_DIR, { recursive: true });
  await fs.rm(cachedDir, { recursive: true, force: true }).catch(() => undefined);
  try {
    await fs.rename(built, cachedDir);
  } catch {
    await fs.cp(built, cachedDir, { recursive: true }).catch(async () => {
      throw new Error("No pude guardar el bundle en caché.");
    });
    await fs.rm(built, { recursive: true, force: true }).catch(() => undefined);
  }
  void pruneBundles(cachedDir);
  void pruneComponents();

  return { serveUrl: cachedDir, bundleMs: Date.now() - started, bundleCached: false };
}

/** Inyecta el preset ultrarrápido de libvpx-vp9 en la línea de ffmpeg. */
function speedUpVp9({ args }) {
  const at = args.indexOf("-c:v");
  if (at === -1 || args[at + 1] !== "libvpx-vp9") return args;
  const threads = String(Math.max(2, Math.min(8, os.cpus().length || 4)));
  const extra = [
    "-deadline", "realtime",
    "-cpu-used", "8",
    "-lag-in-frames", "0",
    "-error-resilient", "1",
    "-threads", threads,
  ];
  if (!args.includes("-row-mt")) extra.push("-row-mt", "1");
  if (!args.includes("-tile-columns")) extra.push("-tile-columns", "2");
  return [...args.slice(0, at + 2), ...extra, ...args.slice(at + 2)];
}

function compositionFor(job) {
  const props = job.props || {};
  return {
    id: job.compositionId,
    width: job.width,
    height: job.height,
    fps: job.fps,
    durationInFrames: job.durationInFrames,
    defaultProps: props,
    props,
    defaultCodec: null,
    defaultOutName: null,
    defaultVideoImageFormat: null,
    defaultPixelFormat: job.transparentBackground ? "yuva420p" : null,
    defaultProResProfile: null,
    defaultSampleRate: null,
  };
}

async function executeRender(job) {
  const startTime = Date.now();
  const isTransparent = job.transparentBackground === true;
  const outputFile =
    job.outputPath ||
    path.join(
      WORK_ROOT,
      "outputs",
      `output-${job.id}${isTransparent ? ".webm" : ".mp4"}`,
    );

  const { cancelSignal, cancel } = makeCancelSignal();
  running.set(job.id, cancel);

  try {
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    emit({ id: job.id, type: "stage", stage: "bundle" });
    const bundleInfo = await ensureBundle(job);

    const codec = isTransparent ? "vp9" : "h264";
    const concurrency = resolveSafeWorkerConcurrency(job.concurrency);

    const renderOptions = {
      serveUrl: bundleInfo.serveUrl,
      composition: compositionFor(job),
      inputProps: job.props || {},
      outputLocation: toForwardSlashes(outputFile),
      codec,
      crf: job.crf ?? (isTransparent ? (job.type === "preview" ? 34 : 36) : 18),
      concurrency,
      scale: job.scale ?? 1,
      frameRange: job.frameRange,
      cancelSignal,
      browserExecutable: process.env.REMOTION_CHROME_EXECUTABLE_PATH || undefined,
      chromiumOptions: {
        gl: process.platform === "win32" ? "angle" : "swiftshader",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
      onProgress: (progress) =>
        postProgress(job, "render", progress.progress, {
          renderedFrames: progress.renderedFrames,
          encodedFrames: progress.encodedFrames,
        }),
    };

    if (isTransparent) {
      renderOptions.pixelFormat = "yuva420p";
      renderOptions.imageFormat = "png";
      renderOptions.ffmpegOverride = speedUpVp9;
    }

    emit({ id: job.id, type: "stage", stage: "render" });
    const renderStarted = Date.now();
    await renderMedia(renderOptions);
    const renderMs = Date.now() - renderStarted;

    const stat = await fs.stat(outputFile);
    if (job.type === "preview") {
      const buffer = await fs.readFile(outputFile);
      await fs.rm(outputFile, { force: true }).catch(() => undefined);
      return {
        id: job.id,
        success: true,
        base64Video: `data:${isTransparent ? "video/webm" : "video/mp4"};base64,${buffer.toString("base64")}`,
        durationMs: Date.now() - startTime,
        bundleMs: bundleInfo.bundleMs,
        renderMs,
        bundleCached: bundleInfo.bundleCached,
      };
    }

    return {
      id: job.id,
      success: true,
      videoPath: outputFile,
      videoBytes: stat.size,
      durationMs: Date.now() - startTime,
      bundleMs: bundleInfo.bundleMs,
      renderMs,
      bundleCached: bundleInfo.bundleCached,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "Error desconocido");
    const cancelled = /cancel/i.test(message);
    if (!cancelled) console.error("[Worker] Render error:", message);
    return {
      id: job.id,
      success: false,
      error: cancelled ? "cancelled" : message,
      durationMs: Date.now() - startTime,
    };
  } finally {
    running.delete(job.id);
  }
}

if (parentPort) {
  parentPort.on("message", async (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "cancel") {
      const cancel = running.get(message.id);
      if (cancel) cancel();
      return;
    }
    if (message.type === "ping") {
      parentPort.postMessage({ type: "pong", id: message.id });
      return;
    }
    const result = await executeRender(message);
    parentPort.postMessage(result);
  });
}

// Evita que el worker muera por promesas sueltas de limpieza.
process.on("unhandledRejection", (error) => {
  console.error("[Worker] unhandledRejection", error);
});
