import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { userStore } from "../auth/store";
import { claimAnonymousSessionAiSettings, migrateSessionAiSettings } from "../ai/settings";
import { HttpError } from "../util/fs";

export const AUTH_COOKIE_NAME = "oeclip_token";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const registerSchema = z.object({
  handle: z.string().trim().min(2).max(48),
  displayName: z.string().trim().max(64).optional(),
  email: z.string().trim().max(160).optional(),
  password: z.string().min(4).max(128).optional(),
  pin: z.string().min(4).max(128).optional(),
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(160).optional(),
  handle: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().min(1).max(160).optional(),
  password: z.string().min(1).max(128).optional(),
  pin: z.string().min(1).max(128).optional(),
});

const adminCreateUserSchema = z.object({
  handle: z.string().trim().min(2).max(48),
  displayName: z.string().trim().max(64).optional(),
  email: z.string().trim().max(160).optional(),
  password: z.string().min(4).max(128),
  role: z.enum(["admin", "user"]).optional(),
});

const adminUpdateUserSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  disabled: z.boolean().optional(),
  displayName: z.string().trim().max(64).optional(),
  email: z.string().trim().max(160).nullable().optional(),
  password: z.string().min(4).max(128).optional(),
});

const updateMeSchema = z.object({
  handle: z.string().trim().min(2).max(48).optional(),
  displayName: z.string().trim().max(64).optional(),
  email: z.string().trim().max(160).nullable().optional(),
  currentPassword: z.string().min(1).max(128).optional(),
  newPassword: z.string().min(4, "La nueva contraseña debe tener al menos 4 caracteres.").max(128).optional(),
});

function requireAdmin(request: FastifyRequest) {
  const token = extractAuthToken(request);
  const verified = token ? userStore.verifySession(token) : null;
  if (!verified) {
    throw new HttpError(401, "Inicia sesión para continuar.", "auth_required");
  }
  if (verified.user.role !== "admin") {
    throw new HttpError(403, "Solo el administrador puede gestionar cuentas.", "admin_required");
  }
  return verified;
}

function parseCookieHeader(headerValue?: string): Record<string, string> {
  if (!headerValue) return {};
  const result: Record<string, string> = {};
  for (const part of headerValue.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    const rawValue = part.slice(eqIndex + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(rawValue);
    } catch {
      result[key] = rawValue;
    }
  }
  return result;
}

export function extractAuthToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (match?.[1] && match[1].startsWith("tok_")) {
      return match[1];
    }
  }

  const xAuthToken = request.headers["x-auth-token"];
  if (typeof xAuthToken === "string" && xAuthToken.trim().startsWith("tok_")) {
    return xAuthToken.trim();
  }

  const xSessionId = request.headers["x-session-id"];
  if (typeof xSessionId === "string" && xSessionId.trim().startsWith("tok_")) {
    return xSessionId.trim();
  }

  const cookies = parseCookieHeader(request.headers.cookie);
  const cookieToken = cookies[AUTH_COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken.trim().startsWith("tok_")) {
    return cookieToken.trim();
  }

  return undefined;
}

function isHttpsRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string") {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return request.protocol === "https";
}

export function setAuthCookie(reply: FastifyReply, request: FastifyRequest, token: string): void {
  const secureFlag = isHttpsRequest(request) ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secureFlag}`,
  );
}

export function clearAuthCookie(reply: FastifyReply, request: FastifyRequest): void {
  const secureFlag = isHttpsRequest(request) ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
  );
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Completa usuario y contraseña (mínimo 4 caracteres).",
        "invalid_register_payload",
      );
    }

    const result = userStore.register({
      handle: parsed.data.handle,
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      password: parsed.data.password ?? parsed.data.pin,
    });
    const rawAnon = typeof request.headers["x-session-id"] === "string" ? request.headers["x-session-id"] : undefined;
    claimAnonymousSessionAiSettings(rawAnon, result.user.sessionId, result.user.id);
    setAuthCookie(reply, request, result.token);
    return reply.code(201).send(result);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Ingresa usuario/correo y contraseña.",
        "invalid_login_payload",
      );
    }

    const result = userStore.login({
      identifier: parsed.data.identifier,
      handle: parsed.data.handle,
      email: parsed.data.email,
      password: parsed.data.password ?? parsed.data.pin,
    });
    const rawAnon = typeof request.headers["x-session-id"] === "string" ? request.headers["x-session-id"] : undefined;
    claimAnonymousSessionAiSettings(rawAnon, result.user.sessionId, result.user.id);
    setAuthCookie(reply, request, result.token);
    return result;
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = extractAuthToken(request);
    const result = userStore.logout(token);
    clearAuthCookie(reply, request);
    return result;
  });

  app.get("/api/auth/users", async (_request, reply) => {
    return reply.code(403).send({
      error: "El listado público de usuarios está deshabilitado por seguridad.",
      code: "user_list_disabled",
    });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const token = extractAuthToken(request);
    const verified = userStore.verifySession(token);
    if (!verified) {
      if (token) {
        clearAuthCookie(reply, request);
      }
      return { authenticated: false, user: null };
    }
    return {
      authenticated: true,
      user: verified.user,
      expiresAt: verified.expiresAt,
    };
  });

  app.patch("/api/auth/me", async (request, reply) => {
    const token = extractAuthToken(request);
    const verified = userStore.verifySession(token);
    if (!verified) {
      if (token) {
        clearAuthCookie(reply, request);
      }
      throw new HttpError(401, "Debes iniciar sesión para editar tu perfil.", "auth_required");
    }

    const parsed = updateMeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Datos de perfil no válidos.",
        "invalid_profile_update_payload",
      );
    }

    const result = userStore.updateSelfProfile(verified.user.id, parsed.data, token);
    if (result.handleChanged) {
      migrateSessionAiSettings(`ses_${result.previousHandle}`, result.user.sessionId, result.user.id);
    }
    if (token) {
      setAuthCookie(reply, request, token);
    }
    return {
      authenticated: true,
      user: result.user,
      expiresAt: verified.expiresAt,
    };
  });

  // Panel de gestión de cuentas (estrictamente restringido a rol admin)
  app.get("/api/admin/users", async (request) => {
    requireAdmin(request);
    return { users: userStore.listAdminUsers() };
  });

  app.post("/api/admin/users", async (request, reply) => {
    requireAdmin(request);
    const parsed = adminCreateUserSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Completa usuario y contraseña (mínimo 4 caracteres).",
        "invalid_admin_user_payload",
      );
    }
    const created = userStore.adminCreateUser(parsed.data);
    return reply.code(201).send({ user: created });
  });

  app.patch("/api/admin/users/:id", async (request) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = adminUpdateUserSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Datos de actualización no válidos.",
        "invalid_admin_update_payload",
      );
    }
    const updated = userStore.adminUpdateUser(id, admin.user.id, parsed.data);
    return { user: updated };
  });

  app.delete("/api/admin/users/:id", async (request) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    return userStore.adminDeleteUser(id, admin.user.id);
  });
}
