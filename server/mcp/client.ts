import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import type { AgentPlan, ExportRecord, Project } from "../../src/shared/schema";
import { userStore } from "../auth/store";
import type { JobState } from "../jobs";

export interface McpRequestAuthContext {
  token?: string;
  userHandle?: string;
  publicBaseUrl?: string;
}

const mcpRequestAuthStorage = new AsyncLocalStorage<McpRequestAuthContext>();

export function runWithMcpRequestAuth<T>(
  context: McpRequestAuthContext,
  fn: () => Promise<T>,
): Promise<T> {
  return mcpRequestAuthStorage.run(context, fn);
}

export interface ProjectBundle {
  project: Project;
  exports: ExportRecord[];
  agentMessages: Array<{ id: string; role: string; text: string; createdAt: string; plan?: AgentPlan }>;
}

export interface ProjectListItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  durationFrames: number;
  mediaCount: number;
  thumbnailMediaId: string | null;
}

export interface PlanResponse {
  plan: AgentPlan;
  source: "llm" | "local";
  model?: string;
  ai: { configured: boolean; model: string; providerId: string };
}

export interface ToolRunResponse {
  ok: boolean;
  tool: string;
  status?: "verified" | "unverified" | "fallback" | "failed";
  summary: string;
  data: unknown;
  warnings?: string[];
  verification?: {
    checks?: Array<{ name: string; passed: boolean; detail?: string }>;
    evidence?: string[];
  };
  revision: number;
}

export interface ExportStartResponse {
  record: ExportRecord;
  job: JobState;
}

export function apiBaseUrl(): string {
  const explicit = process.env.NOVACUT_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = process.env.PORT?.trim() || process.env.NOVACUT_PORT?.trim() || "4331";
  return `http://127.0.0.1:${port}`;
}

export function publicBaseUrl(): string {
  const explicit = process.env.OECLIP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const ctxBase = mcpRequestAuthStorage.getStore()?.publicBaseUrl?.trim();
  if (ctxBase) return ctxBase.replace(/\/+$/, "");
  return apiBaseUrl();
}

export function buildPublicUrl(relativePath: string): string {
  if (/^https?:\/\//i.test(relativePath)) return relativePath;
  const normalized = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return `${publicBaseUrl()}${normalized}`;
}

export function mcpHttpUrl(): string {
  const explicit = process.env.NOVACUT_MCP_URL?.trim();
  if (explicit) return explicit;
  const ctxBase = mcpRequestAuthStorage.getStore()?.publicBaseUrl?.trim();
  if (ctxBase) return `${ctxBase.replace(/\/+$/, "")}/mcp`;
  const port = process.env.NOVACUT_MCP_PORT?.trim();
  if (!port) return `${apiBaseUrl()}/mcp`;
  const host = process.env.NOVACUT_MCP_HOST?.trim();
  const publicHost = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${publicHost}:${port}/mcp`;
}

export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 0, code = "bridge_error") {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

function httpJsonRequest(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  bodyText: string | undefined,
  timeoutMs: number | undefined,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;
    const reqHeaders: Record<string, string> = { ...headers };
    if (bodyText !== undefined) {
      reqHeaders["Content-Length"] = String(Buffer.byteLength(bodyText, "utf8"));
    }
    const effectiveTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 120_000;
    const req = transport.request(
      parsed,
      {
        method,
        headers: reqHeaders,
        timeout: effectiveTimeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 500,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(effectiveTimeout, () => {
      req.destroy(new Error(`Timeout tras ${Math.round(effectiveTimeout / 1000)}s esperando respuesta de la API`));
    });
    req.on("error", reject);
    if (bodyText !== undefined) {
      req.write(bodyText, "utf8");
    }
    req.end();
  });
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ctx = mcpRequestAuthStorage.getStore();
  const explicitToken = ctx?.token?.trim() || process.env.NOVACUT_API_TOKEN?.trim();
  let resolvedToken = explicitToken;
  if (!resolvedToken || !resolvedToken.startsWith("tok_")) {
    try {
      resolvedToken = userStore.getOrCreateMcpSessionToken(
        ctx?.userHandle || process.env.NOVACUT_MCP_USER,
        explicitToken,
      );
    } catch {
      // Si se ejecuta fuera del servidor sin acceso a SQLite local, continuar con explicitToken si existe
    }
  }
  if (resolvedToken) headers.Authorization = `Bearer ${resolvedToken}`;

  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  let status = 500;
  let text = "";
  try {
    // Usar node:http/https nativo evita el headersTimeout fijo de 300s de undici fetch
    // en operaciones largas de render/exportación por Remotion (p. ej. ask_director).
    const res = await httpJsonRequest(`${apiBaseUrl()}/api${path}`, method, headers, bodyText, timeoutMs);
    status = res.status;
    text = res.text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BridgeError(
      `No se pudo conectar con OECLIP en ${apiBaseUrl()} (${reason}). Arranca la app con "npm start" antes de usar MCP.`,
      0,
      "api_unreachable",
    );
  }

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 500) };
    }
  }
  if (status < 200 || status >= 300) {
    const data = (payload ?? {}) as { error?: string; code?: string };
    throw new BridgeError(data.error || `La API respondió con HTTP ${status}.`, status, data.code);
  }
  return payload as T;
}

export const api = {
  listProjects: () => apiRequest<{ projects: ProjectListItem[] }>("GET", "/projects"),
  getProject: (projectId: string) =>
    apiRequest<ProjectBundle>("GET", `/projects/${encodeURIComponent(projectId)}`),
  createProject: (input: { name?: string; aspect?: string; height?: number; fps?: number }) =>
    apiRequest<ProjectBundle>("POST", "/projects", input),
  importMedia: (projectId: string, input: { path: string; name?: string }, timeoutMs = 30 * 60_000) =>
    apiRequest<{ asset: { id: string; name: string; kind: string; durationUs: number }; revision: number }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/media/import`,
      input,
      timeoutMs,
    ),
  plan: (projectId: string, input: { instruction: string; mediaId?: string; clipIds?: string[]; preferLocal?: boolean }) =>
    apiRequest<PlanResponse>("POST", `/projects/${encodeURIComponent(projectId)}/agent/plan`, input, 10 * 60_000),
  executePlan: (projectId: string, planId: string) =>
    apiRequest<{ jobId: string; planId: string }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/agent/execute`,
      { planId },
    ),
  runTool: (projectId: string, tool: string, args: Record<string, unknown>, timeoutMs = 30 * 60_000) =>
    apiRequest<ToolRunResponse>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tools/${encodeURIComponent(tool)}`,
      { args },
      timeoutMs,
    ),
  getJob: (jobId: string) => apiRequest<JobState>("GET", `/jobs/${encodeURIComponent(jobId)}`),
  listJobs: (projectId: string) =>
    apiRequest<{ jobs: JobState[] }>("GET", `/projects/${encodeURIComponent(projectId)}/jobs`),
  cancelJob: (jobId: string) => apiRequest<JobState>("DELETE", `/jobs/${encodeURIComponent(jobId)}`),
  startExport: (projectId: string, settings: Record<string, unknown>) =>
    apiRequest<ExportStartResponse>("POST", `/projects/${encodeURIComponent(projectId)}/exports`, settings),
  listExports: (projectId: string) =>
    apiRequest<{ exports: ExportRecord[] }>("GET", `/projects/${encodeURIComponent(projectId)}/exports`),
  verifyExport: (projectId: string, exportId: string) =>
    apiRequest<{ record: ExportRecord; verification: unknown }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/verify`,
      {},
      5 * 60_000,
    ),
  askDirector: (
    projectId: string,
    input: {
      request: string;
      autonomy?: "assisted" | "semi" | "autonomous";
      exportOnComplete?: boolean;
      storyboard?: unknown;
      allowFallback?: boolean;
      strict?: boolean;
      quality?: "draft" | "standard" | "high";
    },
    timeoutMs = 30 * 60_000,
  ) =>
    apiRequest<ToolRunResponse>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/agent/director`,
      input,
      timeoutMs,
    ),
  fetchBinary: async (pathOrUrl: string, timeoutMs = 30_000): Promise<Buffer> => {
    const targetUrl = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : pathOrUrl.startsWith("/api/")
        ? `${apiBaseUrl()}${pathOrUrl}`
        : `${apiBaseUrl()}/api${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    const response = await fetch(targetUrl, {
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!response.ok) {
      throw new BridgeError(`No se pudo descargar recurso HTTP (${response.status}).`, response.status, "binary_fetch_failed");
    }
    return Buffer.from(await response.arrayBuffer());
  },
  aiStatus: () => apiRequest<Record<string, unknown>>("GET", "/ai/status"),
  health: () => apiRequest<Record<string, unknown>>("GET", "/health"),
  listSkills: () => apiRequest<{ skills: Array<Record<string, unknown>> }>("GET", "/skills"),
  toolCatalog: () =>
    apiRequest<{ tools: Array<{ name: string; description: string; argsHint: string; risk: string }> }>(
      "GET",
      "/tools",
    ),
};

export async function waitForJob(
  jobId: string,
  timeoutSeconds: number,
): Promise<{ job: JobState; timedOut: boolean }> {
  const deadline = Date.now() + Math.max(1, Math.min(600, timeoutSeconds)) * 1_000;
  let job = await api.getJob(jobId);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() >= deadline) return { job, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, 750));
    job = await api.getJob(jobId);
  }
  return { job, timedOut: false };
}
