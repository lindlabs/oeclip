import { newId } from "../src/shared/time";
import { eventBus } from "./events";
import { HttpError } from "./util/fs";

export type JobType = "export" | "proxy" | "agent" | "media";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobState {
  id: string;
  type: JobType;
  projectId: string;
  label: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
  detail?: Record<string, unknown>;
  cancellable: boolean;
}

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  setProgress: (progress: number, message?: string) => void;
  setMessage: (message: string) => void;
  setDetail: (detail: Record<string, unknown>) => void;
  getProgress: () => number;
}

interface JobDefinition {
  type: JobType;
  projectId: string;
  label: string;
  cancellable?: boolean;
  run: (context: JobContext) => Promise<unknown>;
}

interface InternalJob {
  state: JobState;
  controller: AbortController;
  run: (context: JobContext) => Promise<unknown>;
}

class JobQueue {
  private jobs = new Map<string, InternalJob>();
  private queue: string[] = [];
  private running = new Set<string>();
  private maxConcurrent = 2;

  enqueue(definition: JobDefinition): JobState {
    const id = newId("job");
    const controller = new AbortController();
    const state: JobState = {
      id,
      type: definition.type,
      projectId: definition.projectId,
      label: definition.label,
      status: "queued",
      progress: 0,
      message: "En cola",
      createdAt: new Date().toISOString(),
      cancellable: definition.cancellable ?? true,
    };
    this.jobs.set(id, { state, controller, run: definition.run });
    this.queue.push(id);
    this.emit(state);
    this.drain();
    return state;
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id)?.state;
  }

  listForProject(projectId: string): JobState[] {
    return [...this.jobs.values()]
      .map((job) => job.state)
      .filter((job) => job.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  cancel(id: string): JobState {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, "La tarea no existe.", "job_not_found");
    if (job.state.status === "done" || job.state.status === "failed") {
      return job.state;
    }
    job.controller.abort();
    if (job.state.status === "queued") {
      this.queue = this.queue.filter((jobId) => jobId !== id);
      job.state.status = "cancelled";
      job.state.finishedAt = new Date().toISOString();
      job.state.message = "Cancelada";
      job.state.progress = 1;
      this.emit(job.state);
    }
    return job.state;
  }

  private async drain(): Promise<void> {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) return;
      const job = this.jobs.get(id);
      if (!job || job.state.status !== "queued") continue;
      this.running.add(id);
      void this.execute(job).finally(() => {
        this.running.delete(id);
        this.drain();
      });
    }
  }

  private async execute(job: InternalJob): Promise<void> {
    const { state } = job;
    state.status = "running";
    state.startedAt = new Date().toISOString();
    state.message = "Procesando";
    this.emit(state);
    let lastEmit = 0;
    const context: JobContext = {
      jobId: state.id,
      signal: job.controller.signal,
      setProgress: (progress, message) => {
        state.progress = Math.min(1, Math.max(state.progress, progress));
        if (message) state.message = message;
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          this.emit(state);
        }
      },
      setMessage: (message) => {
        state.message = message;
        this.emit(state);
      },
      setDetail: (detail) => {
        state.detail = { ...state.detail, ...detail };
        this.emit(state);
      },
      getProgress: () => state.progress,
    };
    try {
      const result = await job.run(context);
      if (job.controller.signal.aborted) {
        state.status = "cancelled";
        state.message = "Cancelada";
      } else {
        state.status = "done";
        state.progress = 1;
        state.message = "Completada";
        state.result = result;
      }
    } catch (error) {
      const aborted = job.controller.signal.aborted;
      state.status = aborted ? "cancelled" : "failed";
      state.message = aborted ? "Cancelada" : "Error";
      state.error = aborted
        ? "Operación cancelada por el usuario."
        : error instanceof HttpError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      if (state.status === "cancelled") state.progress = 1;
    } finally {
      state.finishedAt = new Date().toISOString();
      this.emit(state);
      eventBus.publish(state.projectId, {
        type: "project",
        projectId: state.projectId,
        revision: -1,
      });
    }
  }

  private emit(state: JobState): void {
    eventBus.publish(state.projectId, { type: "job", job: { ...state } });
  }

  prune(): void {
    const done = [...this.jobs.values()]
      .filter((job) => job.state.finishedAt)
      .sort((a, b) => a.state.createdAt.localeCompare(b.state.createdAt));
    for (const job of done.slice(0, Math.max(0, done.length - 100))) {
      this.jobs.delete(job.state.id);
    }
  }
}

export const jobQueue = new JobQueue();
