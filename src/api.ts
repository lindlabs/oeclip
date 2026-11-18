import type {
  AgentMessage,
  AgentPlan,
  ExportRecord,
  ExportSettings,
  MediaAsset,
  Project,
  ProjectSettings,
} from "./shared/schema";
import type { AspectRatio, ResolutionHeight } from "./shared/presets";
import type { SkillParameter } from "./shared/skills";

export interface ProjectBundle {
  project: Project;
  exports: ExportRecord[];
  agentMessages: AgentMessage[];
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

export interface AiStatus {
  configured: boolean;
  chat: boolean;
  transcribe: boolean;
  provider: "openai-compatible" | "local";
  model: string;
  transcribeModel: string;
  baseUrlHost: string;
  providerId: string;
  keyHint: string | null;
  supportsTranscription: boolean;
  requiresApiKey: boolean;
  source: "file" | "env";
  transcriptionMode: "api" | "local" | "none";
  localTranscription: { available: boolean; model: string };
}

export interface AiPreset {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  transcribeModel: string;
  supportsTranscription: boolean;
  requiresApiKey: boolean;
  docsUrl: string;
}

export interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  transcribeModel: string;
  supportsTranscription: boolean;
  timeoutMs: number;
  hasApiKey: boolean;
  keyHint: string | null;
  requiresApiKey: boolean;
  source: "file" | "env";
  updatedAt: string | null;
  presets: AiPreset[];
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  baseUrlHost: string;
  jsonMode: boolean;
  models: string[];
  transcription: { available: boolean; model: string; reason: string };
  message: string;
}

export interface SystemCapabilities {
  ffmpegVersion: string | null;
  nvenc: boolean;
  nvidiaGpu: string | null;
  cpuCores: number;
  totalMemoryBytes: number;
  aiConfigured: boolean;
  aiModel: string;
  remotion: boolean;
  checkedAt: string;
}

export interface ServerConfig {
  brand: string;
  ai: AiStatus;
  capabilities: SystemCapabilities;
  maxUploadMb: number;
}

export interface Health {
  ok: boolean;
  brand: string;
  version: string;
  uptimeSeconds: number;
  platform: string;
  node: string;
  capabilities: SystemCapabilities;
  ai: AiStatus;
  dataDir: string;
}

export interface Snapshot {
  fileName: string;
  label: string;
  createdAt: string;
  revision: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  kind?: "recipe" | "template";
  category: string;
  version: string;
  author: string | null;
  tags: string[];
  triggers: string[];
  parameters: SkillParameter[];
  render: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    engine: "remotion" | "html-gsap" | "ffmpeg";
    audio: boolean;
  };
  instructions?: string;
  removable: boolean;
}

export interface JobState {
  id: string;
  type: "export" | "proxy" | "agent" | "media";
  projectId: string;
  label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
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

export interface PlanResponse {
  plan: AgentPlan;
  message: AgentMessage;
  source: "llm" | "local";
  model?: string;
  ai: AiStatus;
  projectRevision: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = "request_failed", details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SESSION_STORAGE_KEY = "oeclip.sessionId";
const AUTH_TOKEN_STORAGE_KEY = "oeclip.authToken";
const USER_STORAGE_KEY = "oeclip.currentUser";

export interface CreatorUser {
  id?: string;
  handle: string;
  displayName?: string;
  name?: string;
  email?: string | null;
  avatarColor?: string;
  sessionId?: string;
  role?: "admin" | "user";
  disabled?: boolean;
  hasPassword?: boolean;
  hasPin?: boolean;
  createdAt?: number | string;
  lastSeenAt?: string;
  lastLoginAt?: string;
}

export interface AdminUserRecord extends CreatorUser {
  id: string;
  role: "admin" | "user";
  disabled: boolean;
  projectCount: number;
  hasAiKey: boolean;
  aiModel: string | null;
}

function normalizeCreatorUser(raw: CreatorUser): CreatorUser {
  const displayName = raw.displayName?.trim() || raw.name?.trim() || raw.handle;
  return {
    ...raw,
    displayName,
    name: displayName,
    email: raw.email ?? null,
    role: raw.role === "admin" ? "admin" : "user",
    disabled: Boolean(raw.disabled),
    hasPassword: raw.hasPassword ?? raw.hasPin ?? true,
    hasPin: raw.hasPin ?? raw.hasPassword ?? true,
  };
}

export function getAuthToken(): string | null {
  try {
    const raw = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return raw && raw.startsWith("tok_") ? raw : null;
  } catch {
    return null;
  }
}

export function getCurrentUser(): CreatorUser | null {
  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CreatorUser;
    if (!parsed || !parsed.handle) return null;
    return normalizeCreatorUser(parsed);
  } catch {
    return null;
  }
}

function persistAuthSession(user: CreatorUser, token: string): CreatorUser {
  const normalized = normalizeCreatorUser(user);
  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(normalized));
  window.localStorage.setItem(SESSION_STORAGE_KEY, normalized.sessionId || `ses_${normalized.handle}`);
  return normalized;
}

function clearStoredAuth(): void {
  try {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(USER_STORAGE_KEY);
    const newAnonId = `ses_anon_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    window.localStorage.setItem(SESSION_STORAGE_KEY, newAnonId);
  } catch {
    // Ignore storage errors
  }
}

export async function authRegister(input: {
  handle: string;
  displayName?: string;
  name?: string;
  email?: string;
  password: string;
  pin?: string;
}): Promise<{ user: CreatorUser; token: string; expiresAt?: string }> {
  const res = await request<{ user: CreatorUser; token: string; expiresAt?: string }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      handle: input.handle,
      displayName: input.displayName ?? input.name,
      email: input.email,
      password: input.password,
    }),
  });
  const user = persistAuthSession(res.user, res.token);
  return { ...res, user };
}

export async function authLogin(input: {
  identifier?: string;
  handle?: string;
  email?: string;
  password: string;
  pin?: string;
}): Promise<{ user: CreatorUser; token: string; expiresAt?: string }> {
  const res = await request<{ user: CreatorUser; token: string; expiresAt?: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      identifier: input.identifier ?? input.email ?? input.handle,
      handle: input.handle,
      email: input.email,
      password: input.password,
    }),
  });
  const user = persistAuthSession(res.user, res.token);
  return { ...res, user };
}

export async function authMe(): Promise<CreatorUser | null> {
  try {
    const res = await request<{ authenticated: boolean; user: CreatorUser | null }>("/auth/me");
    if (!res.authenticated || !res.user) {
      clearStoredAuth();
      return null;
    }
    const normalized = normalizeCreatorUser(res.user);
    window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(normalized));
    if (normalized.sessionId) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, normalized.sessionId);
    }
    return normalized;
  } catch {
    return null;
  }
}

export async function authLogout(): Promise<void> {
  try {
    await request<{ ok: boolean }>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch {
    // Even if offline, still clear client auth state
  } finally {
    clearStoredAuth();
  }
}

export function signOutUser(): void {
  clearStoredAuth();
}

export interface UpdateMeInput {
  handle?: string;
  displayName?: string;
  email?: string | null;
  currentPassword?: string;
  newPassword?: string;
}

export async function authUpdateMe(
  input: UpdateMeInput,
): Promise<{ authenticated: boolean; user: CreatorUser; expiresAt: string }> {
  const res = await request<{ authenticated: boolean; user: CreatorUser; expiresAt: string }>("/auth/me", {
    method: "PATCH",
    ...jsonBody(input),
  });
  if (res.user) {
    try {
      window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(res.user));
      if (res.user.sessionId) {
        window.localStorage.setItem(SESSION_STORAGE_KEY, res.user.sessionId);
      }
    } catch {
      // Ignorar errores de almacenamiento local
    }
  }
  return res;
}

export function getClientSessionId(): string {
  try {
    let id = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!id) {
      id = `ses_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      window.localStorage.setItem(SESSION_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return "ses_anon";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Session-Id", getClientSessionId());
  const token = getAuthToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-Auth-Token", token);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const data = (payload ?? {}) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(
      response.status,
      data.error || `Error ${response.status}`,
      data.code || "request_failed",
      data.details,
    );
  }
  return payload as T;
}

function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value ?? {}) };
}

export const api = {
  health: () => request<Health>("/health"),
  config: () => request<ServerConfig>("/config"),

  listProjects: async () => (await request<{ projects: ProjectListItem[] }>("/projects")).projects,
  getProject: (id: string) => request<ProjectBundle>(`/projects/${encodeURIComponent(id)}`),
  createProject: (input: {
    name?: string;
    aspect?: AspectRatio;
    height?: ResolutionHeight;
    fps?: number;
  }) =>
    request<ProjectBundle>("/projects", { method: "POST", ...jsonBody(input) }),
  createDemo: () => request<ProjectBundle>("/projects/demo", { method: "POST", ...jsonBody({}) }),
  deleteProject: (id: string) =>
    request<void>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  duplicateProject: (id: string) =>
    request<ProjectBundle>(`/projects/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
      ...jsonBody({}),
    }),
  saveProject: (id: string, project: Project, baseRevision: number) =>
    request<ProjectBundle>(`/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      ...jsonBody({ project, baseRevision }),
    }),
  revealProject: (id: string) =>
    request<{ opened: boolean; path: string }>(`/projects/${encodeURIComponent(id)}/reveal`, {
      method: "POST",
      ...jsonBody({}),
    }),

  listSnapshots: async (id: string) =>
    (
      await request<{ snapshots: Snapshot[] }>(`/projects/${encodeURIComponent(id)}/history`)
    ).snapshots,
  createSnapshot: (id: string, label: string) =>
    request<{ fileName: string }>(`/projects/${encodeURIComponent(id)}/snapshot`, {
      method: "POST",
      ...jsonBody({ label }),
    }),
  restoreSnapshot: (id: string, fileName: string) =>
    request<ProjectBundle>(
      `/projects/${encodeURIComponent(id)}/history/${encodeURIComponent(fileName)}/restore`,
      { method: "POST", ...jsonBody({}) },
    ),

  uploadMedia: (projectId: string, file: File, onProgress?: (ratio: number) => void) =>
    new Promise<{ asset: MediaAsset; revision: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/projects/${encodeURIComponent(projectId)}/media`);
      xhr.responseType = "text";
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      xhr.onerror = () => reject(new ApiError(0, "No se pudo conectar con el servidor."));
      xhr.onload = () => {
        let data: { error?: string; code?: string; asset?: MediaAsset; revision?: number } = {};
        try {
          data = JSON.parse(xhr.responseText || "{}") as typeof data;
        } catch {
          data = { error: xhr.responseText };
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.asset) {
          resolve({ asset: data.asset, revision: data.revision ?? 0 });
        } else {
          reject(
            new ApiError(
              xhr.status,
              data.error || "No se pudo importar el archivo.",
              data.code || "upload_failed",
            ),
          );
        }
      };
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    }),
  removeMedia: (projectId: string, mediaId: string) =>
    request<Project>(
      `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}`,
      { method: "DELETE" },
    ),
  generateProxy: (projectId: string, mediaId: string) =>
    request<{ job: JobState; proxy: "pending" }>(
      `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/proxy`,
      { method: "POST", ...jsonBody({}) },
    ),
  subtitlesUrl: (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/subtitles.srt`,
  mediaFileUrl: (projectId: string, mediaId: string, proxy = false) =>
    `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/file${proxy ? "?proxy=1" : ""}`,
  thumbnailUrl: (projectId: string, mediaId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/thumb`,
  waveform: (projectId: string, mediaId: string, peaks = 900) =>
    request<{ peaks: Array<{ min: number; max: number }>; durationUs: number; sampleRate: number }>(
      `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/waveform?peaks=${peaks}`,
    ),

  listExports: async (projectId: string) =>
    (await request<{ exports: ExportRecord[] }>(`/projects/${encodeURIComponent(projectId)}/exports`))
      .exports,
  startExport: (projectId: string, settings: ExportSettings) =>
    request<{ record: ExportRecord; job: JobState }>(
      `/projects/${encodeURIComponent(projectId)}/exports`,
      { method: "POST", ...jsonBody(settings) },
    ),
  verifyExport: (projectId: string, exportId: string) =>
    request<{ record: ExportRecord; verification: { valid: boolean; message: string } }>(
      `/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/verify`,
      { method: "POST", ...jsonBody({}) },
    ),
  revealExport: (projectId: string, exportId: string) =>
    request<{ revealed: boolean; path: string }>(
      `/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/reveal`,
      { method: "POST", ...jsonBody({}) },
    ),
  exportFileUrl: (projectId: string, exportId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/file`,
  cancelJob: (jobId: string) =>
    request<JobState>(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }),
  getJob: (jobId: string) => request<JobState>(`/jobs/${encodeURIComponent(jobId)}`),
  listJobs: async (projectId: string) =>
    (await request<{ jobs: JobState[] }>(`/projects/${encodeURIComponent(projectId)}/jobs`)).jobs,

  aiStatus: () => request<AiStatus>("/ai/status"),
  aiSettings: () => request<AiSettings>("/ai/settings"),
  saveAiSettings: (input: {
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    model?: string;
    transcribeModel?: string;
    supportsTranscription?: boolean;
    timeoutMs?: number;
  }) => request<AiSettings>("/ai/settings", { method: "PUT", ...jsonBody(input) }),
  testAi: (input: { baseUrl?: string; apiKey?: string; model?: string; transcribeModel?: string } = {}) =>
    request<AiTestResult>("/ai/test", { method: "POST", ...jsonBody(input) }),
  fetchAiModels: (input: { baseUrl?: string; apiKey?: string; provider?: string } = {}) =>
    request<{ ok: boolean; models: string[] }>("/ai/models", { method: "POST", ...jsonBody(input) }),
  plan: (
    projectId: string,
    instruction: string,
    options: { clipIds?: string[]; mediaId?: string; preferLocal?: boolean } = {},
  ) =>
    request<PlanResponse>(`/projects/${encodeURIComponent(projectId)}/agent/plan`, {
      method: "POST",
      ...jsonBody({
        instruction,
        selection: { clipIds: options.clipIds, mediaId: options.mediaId },
        preferLocal: options.preferLocal,
      }),
    }),
  executePlan: (projectId: string, planId: string) =>
    request<{ jobId: string; planId: string }>(
      `/projects/${encodeURIComponent(projectId)}/agent/execute`,
      { method: "POST", ...jsonBody({ planId }) },
    ),
  listMessages: async (projectId: string) =>
    (
      await request<{ messages: AgentMessage[] }>(
        `/projects/${encodeURIComponent(projectId)}/agent/messages`,
      )
    ).messages,
  runTool: (projectId: string, tool: string, args: Record<string, unknown>) =>
    request<{ ok: boolean; tool: string; summary: string; project?: Project; data?: unknown }>(
      `/projects/${encodeURIComponent(projectId)}/tools/${encodeURIComponent(tool)}`,
      { method: "POST", ...jsonBody({ args }) },
    ),

  listSkills: async () => (await request<{ skills: SkillSummary[] }>("/skills")).skills,
  getSkill: async (skillId: string) =>
    (await request<{ skill: SkillSummary & { body?: string } }>(`/skills/${encodeURIComponent(skillId)}`)).skill,
  uploadSkill: (file: File, overwrite = false) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<{ skill: SkillSummary; overwritten: boolean; summary: string }>(
      `/skills/upload${overwrite ? "?overwrite=1" : ""}`,
      { method: "POST", body: form },
    );
  },
  deleteSkill: (skillId: string) =>
    request<{ deleted: boolean; skillId: string }>(`/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
    }),
  clearAgent: async (projectId: string) =>
    request<{ cleared: boolean }>(`/projects/${encodeURIComponent(projectId)}/agent/clear`, {
      method: "POST",
      ...jsonBody({}),
    }),

  // Auth
  registerUser: authRegister,
  loginUser: authLogin,
  me: authMe,
  updateMe: authUpdateMe,
  logout: authLogout,

  // Admin (solo rol admin)
  adminListUsers: () => request<{ users: AdminUserRecord[] }>("/admin/users"),
  adminCreateUser: (input: {
    handle: string;
    displayName?: string;
    email?: string;
    password: string;
    role?: "admin" | "user";
  }) =>
    request<{ user: AdminUserRecord }>("/admin/users", {
      method: "POST",
      ...jsonBody(input),
    }),
  adminUpdateUser: (
    userId: string,
    patch: {
      role?: "admin" | "user";
      disabled?: boolean;
      displayName?: string;
      email?: string | null;
      password?: string;
    },
  ) =>
    request<{ user: AdminUserRecord }>(`/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      ...jsonBody(patch),
    }),
  adminDeleteUser: (userId: string) =>
    request<{ deleted: boolean; id: string }>(`/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),

  // Generic request for custom endpoints
  request: <T>(path: string, init?: RequestInit) => request<T>(path, init),
};

export type { ProjectSettings };
