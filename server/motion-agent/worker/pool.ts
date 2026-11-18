import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import type {
  RenderJob,
  RenderProgress,
  RenderResult,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_FILE = path.join(__dirname, "renderWorker.mjs");

interface QueueEntry {
  job: RenderJob;
  resolve: (result: RenderResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: RenderProgress) => void;
  cancelled: boolean;
}

interface WorkerWrapper {
  worker: Worker;
  busy: boolean;
  resolve: ((result: RenderResult) => void) | null;
  reject: ((error: Error) => void) | null;
  onProgress: ((progress: RenderProgress) => void) | null;
  currentJobId: string | null;
}

export interface RenderHandle {
  promise: Promise<RenderResult>;
  cancel: () => void;
}

/**
 * Pool de workers de render.
 *
 * Se mantienen pocos workers a propósito: cada render usa varias pestañas de
 * Chrome (concurrency), así que lanzar 7 workers en un portátil de 4 núcleos
 * solo consigue que todos vayan lentos. Dos permiten un render de fondo
 * (prewarm) y un preview sin pelearse de más por la CPU.
 */
export class RenderWorkerPool {
  private workers: WorkerWrapper[] = [];
  private queue: QueueEntry[] = [];
  private maxWorkers: number;
  private initialized = false;

  constructor(maxWorkers = Math.max(1, Math.min(2, (os.cpus().length || 4) - 2))) {
    this.maxWorkers = maxWorkers;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (let i = 0; i < this.maxWorkers; i += 1) {
      await this.createWorker();
    }
    this.initialized = true;
  }

  private createWorker(): Promise<void> {
    return new Promise((resolve) => {
      const worker = new Worker(WORKER_FILE);

      const wrapper: WorkerWrapper = {
        worker,
        busy: false,
        resolve: null,
        reject: null,
        onProgress: null,
        currentJobId: null,
      };

      worker.on("message", (message: any) => {
        if (message && message.type === "progress") {
          wrapper.onProgress?.(message as RenderProgress);
          return;
        }
        if (message && (message.type === "stage" || message.type === "pong")) {
          return;
        }
        if (wrapper.resolve) {
          wrapper.resolve(message as RenderResult);
        }
        wrapper.resolve = null;
        wrapper.reject = null;
        wrapper.onProgress = null;
        wrapper.busy = false;
        wrapper.currentJobId = null;
        this.processQueue();
      });

      worker.on("error", (error) => {
        if (wrapper.reject) wrapper.reject(error);
        wrapper.resolve = null;
        wrapper.reject = null;
        wrapper.onProgress = null;
        wrapper.busy = false;
        wrapper.currentJobId = null;
        this.processQueue();
      });

      worker.on("exit", (code) => {
        if (code !== 0 && wrapper.reject) {
          wrapper.reject(new Error(`El worker de render terminó con código ${code}`));
        }
        this.workers = this.workers.filter((item) => item !== wrapper);
        if (this.initialized) {
          void this.createWorker();
        }
      });

      this.workers.push(wrapper);
      resolve();
    });
  }

  private dispatch(wrapper: WorkerWrapper, entry: QueueEntry): void {
    wrapper.busy = true;
    wrapper.currentJobId = entry.job.id;
    wrapper.resolve = entry.resolve;
    wrapper.reject = entry.reject;
    wrapper.onProgress = entry.onProgress ?? null;
    wrapper.worker.postMessage(entry.job);
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const freeWorker = this.workers.find((item) => !item.busy);
      if (!freeWorker) return;
      const entry = this.queue.shift()!;
      if (entry.cancelled) {
        entry.reject(new Error("cancelled"));
        continue;
      }
      this.dispatch(freeWorker, entry);
    }
  }

  renderWithProgress(
    job: RenderJob,
    onProgress?: (progress: RenderProgress) => void,
  ): RenderHandle {
    let cancelled = false;
    let wrapperRef: WorkerWrapper | null = null;

    const promise = new Promise<RenderResult>((resolve, reject) => {
      const start = async () => {
        if (!this.initialized) await this.initialize();
        if (cancelled) {
          reject(new Error("cancelled"));
          return;
        }
        const freeWorker = this.workers.find((item) => !item.busy);
        const entry: QueueEntry = {
          job,
          resolve,
          reject,
          onProgress,
          cancelled: false,
        };
        if (freeWorker) {
          wrapperRef = freeWorker;
          this.dispatch(freeWorker, entry);
        } else {
          this.queue.push(entry);
        }
      };
      void start();
    });

    const cancel = () => {
      cancelled = true;
      if (wrapperRef && wrapperRef.currentJobId === job.id) {
        wrapperRef.worker.postMessage({ type: "cancel", id: job.id });
        return;
      }
      for (const entry of this.queue) {
        if (entry.job.id === job.id && !entry.cancelled) {
          entry.cancelled = true;
        }
      }
    };

    return { promise, cancel };
  }

  render(job: RenderJob, onProgress?: (progress: RenderProgress) => void): Promise<RenderResult> {
    return this.renderWithProgress(job, onProgress).promise;
  }

  async preview(
    componentCode: string,
    componentName: string,
    compositionId: string,
    width: number,
    height: number,
    fps: number,
    durationInFrames: number,
    props?: Record<string, unknown>,
    options?: {
      frameRange?: [number, number];
      /** Duración real de la composición cuando se renderiza una ventana. */
      compositionDurationInFrames?: number;
      scale?: number;
      bundleKey?: string;
      onProgress?: (progress: RenderProgress) => void;
    },
  ): Promise<RenderResult> {
    return this.render(
      {
        id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "preview",
        componentCode,
        componentName,
        compositionId,
        width,
        height,
        fps,
        durationInFrames: options?.compositionDurationInFrames ?? durationInFrames,
        props,
        frameRange: options?.frameRange,
        scale: options?.scale,
        bundleKey: options?.bundleKey,
        transparentBackground: true,
      },
      options?.onProgress,
    );
  }

  async finalRender(
    componentCode: string,
    componentName: string,
    compositionId: string,
    width: number,
    height: number,
    fps: number,
    durationInFrames: number,
    outputPath: string,
    props?: Record<string, unknown>,
    transparentBackground?: boolean,
    options?: {
      bundleKey?: string;
      crf?: number;
      onProgress?: (progress: RenderProgress) => void;
    },
  ): Promise<RenderResult> {
    return this.render(
      {
        id: `final-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "final",
        componentCode,
        componentName,
        compositionId,
        width,
        height,
        fps,
        durationInFrames,
        outputPath,
        props,
        transparentBackground: transparentBackground === true,
        bundleKey: options?.bundleKey,
        crf: options?.crf,
      },
      options?.onProgress,
    );
  }

  getStats(): { total: number; busy: number; queueLength: number } {
    return {
      total: this.workers.length,
      busy: this.workers.filter((item) => item.busy).length,
      queueLength: this.queue.length,
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((item) => item.worker.terminate()));
    this.workers = [];
    this.queue = [];
  }
}

export const renderPool = new RenderWorkerPool();
