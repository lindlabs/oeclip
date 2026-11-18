import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { config } from "../config";
import { HttpError } from "../util/fs";

const AVATAR_COLORS = [
  "#0EA5E9",
  "#10B981",
  "#8B5CF6",
  "#F59E0B",
  "#EC4899",
  "#14B8A6",
  "#6366F1",
  "#EF4444",
] as const;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_SYNC_INTERVAL_MS = 60 * 1000;

export interface PublicUser {
  id: string;
  handle: string;
  displayName: string;
  email: string | null;
  avatarColor: string;
  sessionId: string;
  role: "admin" | "user";
  disabled: boolean;
  hasPassword: boolean;
  hasPin: boolean;
  createdAt: string;
  lastSeenAt: string;
}

export interface AdminUserSummary extends PublicUser {
  projectCount: number;
  hasAiKey: boolean;
  aiModel: string | null;
}

export interface AuthSessionResult {
  user: PublicUser;
  token: string;
  expiresAt: string;
}

export interface VerifiedSession {
  user: PublicUser;
  sessionId: string;
  expiresAt: string;
}

export interface ProjectOwnerRecord {
  projectId: string;
  userId: string | null;
  userHandle: string;
  sessionId: string | null;
  updatedAt: string;
}

export interface StoredUserAiSettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  transcribeModel: string;
  supportsTranscription: boolean;
  timeoutMs: number;
  updatedAt: string;
}

export interface RegisterInput {
  handle: string;
  displayName?: string;
  email?: string;
  password?: string;
  pin?: string;
}

export interface LoginInput {
  identifier?: string;
  handle?: string;
  email?: string;
  password?: string;
  pin?: string;
}

interface DbState {
  dataDir: string;
  persistentDbPath: string;
  workDbPath: string;
  db: DatabaseSync;
  migratedChecked: boolean;
}

function resolveDataDir(): string {
  const envDir = process.env.NOVACUT_DATA_DIR?.trim();
  return envDir ? path.resolve(envDir) : config.dataDir;
}

export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function normalizeEmail(raw?: string): string | null {
  const clean = raw?.trim().toLowerCase() ?? "";
  if (!clean) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) || clean.length > 160) {
    throw new HttpError(400, "El correo electrónico no tiene un formato válido.", "invalid_email");
  }
  return clean;
}

function pickAvatarColor(seed: string): string {
  let acc = 0;
  for (let i = 0; i < seed.length; i += 1) {
    acc = (acc * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[acc % AVATAR_COLORS.length] ?? "#0EA5E9";
}

function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPasswordHash(password: string, storedHash: string): boolean {
  if (!storedHash || !password) return false;
  if (storedHash.startsWith("scrypt$")) {
    const parts = storedHash.split("$");
    const salt = parts[1];
    const expectedHex = parts[2];
    if (!salt || !expectedHex) return false;
    const expected = Buffer.from(expectedHex, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  if (storedHash.startsWith("legacy-sha256$")) {
    const expectedHex = storedHash.slice("legacy-sha256$".length);
    if (!expectedHex) return false;
    const candidateA = crypto.createHash("sha256").update(password).digest("hex");
    const candidateB = crypto.createHash("sha256").update(`oeclip-pin:${password}`).digest("hex");
    const expected = Buffer.from(expectedHex, "hex");
    for (const candidateHex of [candidateA, candidateB]) {
      const candidate = Buffer.from(candidateHex, "hex");
      if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
        return true;
      }
    }
  }
  return false;
}

function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function asString(value: SQLOutputValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: SQLOutputValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function configuredAdminHandles(): Set<string> {
  const raw = process.env.OECLIP_ADMIN_HANDLES?.trim() || "";
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const clean = normalizeHandle(part);
    if (clean) set.add(clean);
  }
  return set;
}

function mapUserRow(row: Record<string, SQLOutputValue>, includeEmail = true): PublicUser {
  const passwordHash = asString(row.password_hash);
  const hasPassword = passwordHash.length > 0;
  const handle = asString(row.handle);
  const rawRole = asString(row.role);
  const role: "admin" | "user" =
    rawRole === "admin" || configuredAdminHandles().has(handle) ? "admin" : "user";
  const disabled = Number(row.disabled) === 1;
  return {
    id: asString(row.id),
    handle,
    displayName: asString(row.display_name) || handle,
    email: includeEmail ? asNullableString(row.email) : null,
    avatarColor: asString(row.avatar_color) || pickAvatarColor(handle),
    sessionId: `ses_${handle}`,
    role,
    disabled,
    hasPassword,
    hasPin: hasPassword,
    createdAt: asString(row.created_at),
    lastSeenAt: asString(row.last_seen_at),
  };
}

class SqliteAuthStore {
  private state: DbState | null = null;
  private mcpTokenCache = new Map<string, string>();

  private computeWorkDbPath(dataDir: string): string {
    const hash = crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
    return path.join(os.tmpdir(), "oeclip-sqlite", `oeclip-${hash}.db`);
  }

  private removeIfExists(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup race errors on temp paths
    }
  }

  private syncToPersistent(state: DbState): void {
    fs.mkdirSync(state.dataDir, { recursive: true });
    const tmpTarget = `${state.persistentDbPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.copyFileSync(state.workDbPath, tmpTarget);
      fs.renameSync(tmpTarget, state.persistentDbPath);
    } finally {
      this.removeIfExists(tmpTarget);
    }
  }

  private ensureDb(): DbState {
    const dataDir = resolveDataDir();
    if (this.state && this.state.dataDir === dataDir) {
      if (!fs.existsSync(this.state.persistentDbPath)) {
        this.syncToPersistent(this.state);
      }
      return this.state;
    }

    this.close();

    const persistentDbPath = path.join(dataDir, "oeclip.db");
    const workDbPath = this.computeWorkDbPath(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.dirname(workDbPath), { recursive: true });

    this.removeIfExists(`${workDbPath}-journal`);
    this.removeIfExists(`${workDbPath}-wal`);
    this.removeIfExists(`${workDbPath}-shm`);

    if (fs.existsSync(persistentDbPath)) {
      const stat = fs.statSync(persistentDbPath);
      if (stat.size > 0) {
        fs.copyFileSync(persistentDbPath, workDbPath);
      } else {
        this.removeIfExists(workDbPath);
      }
    } else {
      this.removeIfExists(workDbPath);
    }

    const db = new DatabaseSync(workDbPath);
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);

      CREATE TABLE IF NOT EXISTS project_owners (
        project_id TEXT PRIMARY KEY,
        user_id TEXT,
        user_handle TEXT NOT NULL,
        session_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_owners_user_handle ON project_owners(user_handle);
      CREATE INDEX IF NOT EXISTS idx_project_owners_user_id ON project_owners(user_id);

      CREATE TABLE IF NOT EXISTS user_ai_settings (
        session_id TEXT PRIMARY KEY,
        user_id TEXT,
        provider TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model TEXT NOT NULL,
        transcribe_model TEXT NOT NULL,
        supports_transcription INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_ai_settings_user_id ON user_ai_settings(user_id);
    `);

    const state: DbState = {
      dataDir,
      persistentDbPath,
      workDbPath,
      db,
      migratedChecked: false,
    };

    let schemaChanged = this.ensureUserGovernanceColumns(state);
    const migrated = this.migrateLegacyUsersIfNeeded(state);
    if (this.ensureBootstrapAdmin(state)) schemaChanged = true;
    state.migratedChecked = true;
    if (schemaChanged || migrated || !fs.existsSync(persistentDbPath)) {
      this.syncToPersistent(state);
    }

    this.state = state;
    return state;
  }

  private ensureUserGovernanceColumns(state: DbState): boolean {
    const cols = state.db.prepare("PRAGMA table_info(users)").all() as Array<Record<string, SQLOutputValue>>;
    const names = new Set(cols.map((c) => asString(c.name)));
    let changed = false;
    if (!names.has("role")) {
      state.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
      changed = true;
    }
    if (!names.has("disabled")) {
      state.db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
      changed = true;
    }
    return changed;
  }

  private ensureBootstrapAdmin(state: DbState): boolean {
    let changed = false;
    for (const handle of configuredAdminHandles()) {
      const res = state.db
        .prepare("UPDATE users SET role = 'admin' WHERE handle = ? AND role != 'admin'")
        .run(handle);
      if (res.changes > 0) changed = true;
    }
    const adminRow = state.db
      .prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
      .get() as Record<string, SQLOutputValue> | undefined;
    if (!adminRow) {
      const firstCreator = state.db
        .prepare("SELECT id FROM users WHERE handle != 'creador' ORDER BY created_at ASC LIMIT 1")
        .get() as Record<string, SQLOutputValue> | undefined;
      const targetId = firstCreator ? asString(firstCreator.id) : "";
      if (targetId) {
        const res = state.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(targetId);
        if (res.changes > 0) changed = true;
      }
    }
    return changed;
  }

  private migrateLegacyUsersIfNeeded(state: DbState): boolean {
    const doneRow = state.db
      .prepare("SELECT value FROM meta WHERE key = 'legacy_users_migrated'")
      .get() as Record<string, SQLOutputValue> | undefined;
    if (doneRow) return false;

    const legacyFile = path.join(state.dataDir, "users.json");
    let changed = false;
    if (fs.existsSync(legacyFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(legacyFile, "utf8")) as unknown;
        const rawList = Array.isArray(raw)
          ? raw
          : raw && typeof raw === "object" && Array.isArray((raw as { users?: unknown[] }).users)
            ? (raw as { users: unknown[] }).users
            : [];

        const insertUser = state.db.prepare(`
          INSERT OR IGNORE INTO users (
            id, handle, display_name, email, password_hash, avatar_color, created_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const item of rawList) {
          if (!item || typeof item !== "object") continue;
          const obj = item as Record<string, unknown>;
          const rawHandle = typeof obj.handle === "string" ? obj.handle : "";
          const handle = normalizeHandle(rawHandle);
          if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle)) continue;
          const id = typeof obj.id === "string" && obj.id ? obj.id : `usr_${crypto.randomUUID().slice(0, 12)}`;
          const displayName =
            typeof obj.displayName === "string" && obj.displayName.trim()
              ? obj.displayName.trim().slice(0, 48)
              : handle;
          const email =
            typeof obj.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(obj.email.trim())
              ? obj.email.trim().toLowerCase()
              : null;
          const legacyHash =
            typeof obj.passwordHash === "string" && obj.passwordHash
              ? obj.passwordHash
              : typeof obj.pinHash === "string" && obj.pinHash
                ? obj.pinHash.startsWith("scrypt$")
                  ? obj.pinHash
                  : `legacy-sha256$${obj.pinHash}`
                : "";
          const avatarColor =
            typeof obj.avatarColor === "string" && obj.avatarColor
              ? obj.avatarColor
              : pickAvatarColor(handle);
          const now = new Date().toISOString();
          const createdAt = typeof obj.createdAt === "string" && obj.createdAt ? obj.createdAt : now;
          const lastSeenAt = typeof obj.lastSeenAt === "string" && obj.lastSeenAt ? obj.lastSeenAt : createdAt;

          const res = insertUser.run(
            id,
            handle,
            displayName,
            email,
            legacyHash,
            avatarColor,
            createdAt,
            lastSeenAt,
          );
          if (res.changes > 0) changed = true;
        }
      } catch {
        // Malformed legacy users.json should not crash startup
      }
    }

    state.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_users_migrated', ?)")
      .run(new Date().toISOString());
    return true || changed;
  }

  private createSession(state: DbState, userRow: Record<string, SQLOutputValue>): AuthSessionResult {
    const token = `tok_${crypto.randomBytes(24).toString("hex")}`;
    const tokenHash = hashSessionToken(token);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const handle = asString(userRow.handle);
    const userId = asString(userRow.id);
    const sessionId = `ses_${handle}`;

    state.db
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(nowIso);

    state.db
      .prepare(`
        INSERT INTO sessions (token_hash, user_id, session_id, created_at, expires_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(tokenHash, userId, sessionId, nowIso, expiresAt, nowIso);

    state.db
      .prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
      .run(nowIso, userId);

    this.syncToPersistent(state);

    return {
      user: {
        ...mapUserRow(userRow, true),
        lastSeenAt: nowIso,
      },
      token,
      expiresAt,
    };
  }

  register(input: RegisterInput): AuthSessionResult {
    const state = this.ensureDb();
    const handle = normalizeHandle(input.handle);
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle)) {
      throw new HttpError(
        400,
        "El nombre de usuario debe tener entre 2 y 32 caracteres (letras, números, _ o -).",
        "invalid_handle",
      );
    }

    const rawPassword = typeof input.password === "string"
      ? input.password
      : typeof input.pin === "string"
        ? input.pin
        : "";
    if (rawPassword.length < 4 || rawPassword.length > 128) {
      throw new HttpError(
        400,
        "La contraseña es obligatoria y debe tener al menos 4 caracteres.",
        "invalid_password",
      );
    }

    const email = normalizeEmail(input.email);
    const existingHandle = state.db
      .prepare("SELECT id FROM users WHERE handle = ?")
      .get(handle) as Record<string, SQLOutputValue> | undefined;
    if (existingHandle) {
      throw new HttpError(
        409,
        `El usuario @${handle} ya está registrado. Inicia sesión con tu contraseña.`,
        "handle_taken",
      );
    }

    if (email) {
      const existingEmail = state.db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email) as Record<string, SQLOutputValue> | undefined;
      if (existingEmail) {
        throw new HttpError(
          409,
          "Ya existe una cuenta registrada con ese correo electrónico.",
          "email_taken",
        );
      }
    }

    const id = `usr_${crypto.randomBytes(8).toString("hex")}`;
    const displayName = input.displayName?.trim().slice(0, 48) || handle;
    const passwordHash = hashPasswordScrypt(rawPassword);
    const avatarColor = pickAvatarColor(handle);
    const nowIso = new Date().toISOString();
    const hasAnyAdmin = Boolean(
      state.db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get(),
    );
    const role: "admin" | "user" =
      configuredAdminHandles().has(handle) || (!hasAnyAdmin && handle !== "creador") ? "admin" : "user";

    state.db
      .prepare(`
        INSERT INTO users (id, handle, display_name, email, password_hash, avatar_color, role, disabled, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `)
      .run(id, handle, displayName, email, passwordHash, avatarColor, role, nowIso, nowIso);

    const inserted = state.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as Record<string, SQLOutputValue> | undefined;
    if (!inserted) {
      throw new HttpError(500, "No se pudo crear la cuenta.", "register_failed");
    }

    return this.createSession(state, inserted);
  }

  login(input: LoginInput): AuthSessionResult {
    const state = this.ensureDb();
    const rawIdentifier = (input.identifier ?? input.email ?? input.handle ?? "").trim();
    if (!rawIdentifier) {
      throw new HttpError(400, "Ingresa tu usuario o correo electrónico.", "identifier_required");
    }

    const rawPassword = typeof input.password === "string"
      ? input.password
      : typeof input.pin === "string"
        ? input.pin
        : "";
    if (!rawPassword) {
      throw new HttpError(401, "Ingresa tu contraseña para iniciar sesión.", "password_required");
    }

    const normalizedEmailCandidate = rawIdentifier.toLowerCase();
    const normalizedHandleCandidate = normalizeHandle(rawIdentifier);

    const userRow = state.db
      .prepare(`
        SELECT * FROM users
        WHERE handle = ? OR (email IS NOT NULL AND email = ?)
        LIMIT 1
      `)
      .get(normalizedHandleCandidate, normalizedEmailCandidate) as Record<string, SQLOutputValue> | undefined;

    if (!userRow) {
      throw new HttpError(
        404,
        "No encontramos una cuenta con esos datos. Crea una cuenta nueva para entrar.",
        "user_not_found",
      );
    }

    const storedHash = asString(userRow.password_hash);
    if (!storedHash) {
      throw new HttpError(
        401,
        "Esta cuenta heredada no tiene contraseña configurada.",
        "password_not_configured",
      );
    }

    if (!verifyPasswordHash(rawPassword, storedHash)) {
      throw new HttpError(401, "Contraseña incorrecta.", "invalid_credentials");
    }

    if (Number(userRow.disabled) === 1) {
      throw new HttpError(
        403,
        "Tu cuenta está suspendida por un administrador.",
        "account_disabled",
      );
    }

    if (storedHash.startsWith("legacy-sha256$")) {
      const upgraded = hashPasswordScrypt(rawPassword);
      state.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(upgraded, asString(userRow.id));
      userRow.password_hash = upgraded;
    }

    return this.createSession(state, userRow);
  }

  verifySession(token?: string | null): VerifiedSession | null {
    const clean = token?.trim() ?? "";
    if (!clean || !clean.startsWith("tok_")) return null;

    const state = this.ensureDb();
    const tokenHash = hashSessionToken(clean);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const row = state.db
      .prepare(`
        SELECT
          s.session_id AS session_session_id,
          s.expires_at AS session_expires_at,
          s.last_seen_at AS session_last_seen_at,
          u.*
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        LIMIT 1
      `)
      .get(tokenHash) as Record<string, SQLOutputValue> | undefined;

    if (!row) return null;

    if (Number(row.disabled) === 1) {
      state.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      this.syncToPersistent(state);
      return null;
    }

    const expiresAt = asString(row.session_expires_at);
    if (!expiresAt || expiresAt <= nowIso) {
      state.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      this.syncToPersistent(state);
      return null;
    }

    const lastSeenStr = asString(row.session_last_seen_at);
    const lastSeenMs = lastSeenStr ? Date.parse(lastSeenStr) : 0;
    if (!Number.isFinite(lastSeenMs) || now - lastSeenMs > LAST_SEEN_SYNC_INTERVAL_MS) {
      state.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowIso, tokenHash);
      state.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(nowIso, asString(row.id));
      this.syncToPersistent(state);
      row.last_seen_at = nowIso;
    }

    return {
      user: mapUserRow(row, true),
      sessionId: asString(row.session_session_id) || `ses_${asString(row.handle)}`,
      expiresAt,
    };
  }

  logout(token?: string | null): { ok: true; revoked: boolean } {
    const clean = token?.trim() ?? "";
    if (!clean) return { ok: true, revoked: false };

    const state = this.ensureDb();
    const tokenHash = hashSessionToken(clean);
    const res = state.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    if (res.changes > 0) {
      this.syncToPersistent(state);
    }
    return { ok: true, revoked: res.changes > 0 };
  }

  updateSelfProfile(
    userId: string,
    patch: {
      handle?: string;
      displayName?: string;
      email?: string | null;
      currentPassword?: string;
      newPassword?: string;
    },
    currentToken?: string | null,
  ): { user: PublicUser; previousHandle: string; handleChanged: boolean } {
    const cleanId = userId.trim();
    const state = this.ensureDb();
    const currentRow = state.db
      .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
      .get(cleanId) as Record<string, SQLOutputValue> | undefined;
    if (!currentRow) {
      throw new HttpError(404, "La cuenta solicitada no existe.", "user_not_found");
    }

    const oldHandle = asString(currentRow.handle);
    let nextHandle = oldHandle;
    if (patch.handle !== undefined) {
      const candidate = normalizeHandle(patch.handle);
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(candidate)) {
        throw new HttpError(
          400,
          "El nombre de usuario debe tener entre 2 y 32 caracteres (letras, números, _ o -).",
          "invalid_handle",
        );
      }
      if (candidate !== oldHandle) {
        const dupHandle = state.db
          .prepare("SELECT id FROM users WHERE handle = ? AND id != ? LIMIT 1")
          .get(candidate, cleanId) as Record<string, SQLOutputValue> | undefined;
        if (dupHandle) {
          throw new HttpError(409, `El usuario @${candidate} ya está en uso.`, "handle_taken");
        }
        nextHandle = candidate;
      }
    }

    const nextDisplayName =
      patch.displayName !== undefined
        ? patch.displayName.trim().slice(0, 48) || nextHandle
        : asString(currentRow.display_name) || nextHandle;

    const nextEmail =
      patch.email !== undefined
        ? patch.email === null || patch.email.trim() === ""
          ? null
          : normalizeEmail(patch.email)
        : asNullableString(currentRow.email);

    if (nextEmail) {
      const dupEmail = state.db
        .prepare("SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1")
        .get(nextEmail, cleanId) as Record<string, SQLOutputValue> | undefined;
      if (dupEmail) {
        throw new HttpError(409, "Ese correo electrónico ya pertenece a otra cuenta.", "email_taken");
      }
    }

    const existingHash = asString(currentRow.password_hash);
    let nextPasswordHash = existingHash;
    let passwordChanged = false;
    if (patch.newPassword !== undefined && patch.newPassword.length > 0) {
      if (existingHash.length > 0) {
        const currentPass = typeof patch.currentPassword === "string" ? patch.currentPassword : "";
        if (!currentPass || !verifyPasswordHash(currentPass, existingHash)) {
          throw new HttpError(401, "La contraseña actual es incorrecta.", "invalid_current_password");
        }
      }
      if (patch.newPassword.length < 4 || patch.newPassword.length > 128) {
        throw new HttpError(
          400,
          "La nueva contraseña debe tener entre 4 y 128 caracteres.",
          "invalid_password",
        );
      }
      nextPasswordHash = hashPasswordScrypt(patch.newPassword);
      passwordChanged = true;
    }

    const nowIso = new Date().toISOString();
    state.db
      .prepare(`
        UPDATE users
        SET handle = ?, display_name = ?, email = ?, password_hash = ?, last_seen_at = ?
        WHERE id = ?
      `)
      .run(nextHandle, nextDisplayName, nextEmail, nextPasswordHash, nowIso, cleanId);

    const handleChanged = nextHandle !== oldHandle;
    if (handleChanged) {
      const oldSessionId = `ses_${oldHandle}`;
      const newSessionId = `ses_${nextHandle}`;

      state.db
        .prepare("UPDATE sessions SET session_id = ? WHERE user_id = ? OR session_id = ?")
        .run(newSessionId, cleanId, oldSessionId);

      state.db
        .prepare(`
          UPDATE project_owners
          SET user_handle = ?, session_id = ?, user_id = COALESCE(user_id, ?)
          WHERE user_id = ? OR user_handle = ?
        `)
        .run(nextHandle, newSessionId, cleanId, cleanId, oldHandle);

      const latestAiRow = state.db
        .prepare(
          "SELECT session_id FROM user_ai_settings WHERE user_id = ? OR session_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(cleanId, oldSessionId) as Record<string, SQLOutputValue> | undefined;
      if (latestAiRow) {
        const keepSessionId = asString(latestAiRow.session_id);
        if (keepSessionId !== newSessionId) {
          state.db.prepare("DELETE FROM user_ai_settings WHERE session_id = ?").run(newSessionId);
          state.db
            .prepare("UPDATE user_ai_settings SET session_id = ?, user_id = ? WHERE session_id = ?")
            .run(newSessionId, cleanId, keepSessionId);
        } else {
          state.db
            .prepare("UPDATE user_ai_settings SET user_id = ? WHERE session_id = ?")
            .run(cleanId, newSessionId);
        }
        state.db
          .prepare("DELETE FROM user_ai_settings WHERE (user_id = ? OR session_id = ?) AND session_id != ?")
          .run(cleanId, oldSessionId, newSessionId);
      }

      this.mcpTokenCache.delete(oldHandle);
      this.mcpTokenCache.delete(nextHandle);
      this.mcpTokenCache.delete("__default__");
    }

    if (passwordChanged) {
      const cleanToken = currentToken?.trim() ?? "";
      if (cleanToken) {
        const currentHash = hashSessionToken(cleanToken);
        state.db
          .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
          .run(cleanId, currentHash);
      } else {
        state.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(cleanId);
      }
    }

    this.syncToPersistent(state);
    const updatedRow = state.db
      .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
      .get(cleanId) as Record<string, SQLOutputValue> | undefined;
    if (!updatedRow) {
      throw new HttpError(500, "No se pudo actualizar la cuenta.", "update_failed");
    }
    return {
      user: mapUserRow(updatedRow, true),
      previousHandle: oldHandle,
      handleChanged,
    };
  }

  listUsers(): PublicUser[] {
    const state = this.ensureDb();
    const rows = state.db
      .prepare("SELECT * FROM users ORDER BY last_seen_at DESC LIMIT 50")
      .all() as Record<string, SQLOutputValue>[];
    return rows.map((row) => mapUserRow(row, false));
  }

  getUserByHandle(handle: string): PublicUser | null {
    const clean = normalizeHandle(handle);
    if (!clean) return null;
    const state = this.ensureDb();
    const row = state.db
      .prepare("SELECT * FROM users WHERE handle = ? LIMIT 1")
      .get(clean) as Record<string, SQLOutputValue> | undefined;
    return row ? mapUserRow(row, true) : null;
  }

  setProjectOwner(projectId: string, userHandle: string, sessionId?: string | null, userId?: string | null): void {
    const cleanProjectId = projectId.trim();
    const cleanHandle = normalizeHandle(userHandle);
    if (!cleanProjectId || !cleanHandle) return;

    const state = this.ensureDb();
    let resolvedUserId = userId?.trim() || null;
    if (!resolvedUserId) {
      const userRow = state.db
        .prepare("SELECT id FROM users WHERE handle = ? LIMIT 1")
        .get(cleanHandle) as Record<string, SQLOutputValue> | undefined;
      resolvedUserId = userRow ? asNullableString(userRow.id) : null;
    }

    const cleanSessionId = sessionId?.trim() || `ses_${cleanHandle}`;
    const updatedAt = new Date().toISOString();

    state.db
      .prepare(`
        INSERT INTO project_owners (project_id, user_id, user_handle, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          user_id = COALESCE(excluded.user_id, project_owners.user_id),
          user_handle = excluded.user_handle,
          session_id = COALESCE(excluded.session_id, project_owners.session_id),
          updated_at = excluded.updated_at
      `)
      .run(cleanProjectId, resolvedUserId, cleanHandle, cleanSessionId, updatedAt);

    this.syncToPersistent(state);
  }

  getProjectOwner(projectId: string): ProjectOwnerRecord | null {
    const cleanProjectId = projectId.trim();
    if (!cleanProjectId) return null;
    const state = this.ensureDb();
    const row = state.db
      .prepare("SELECT * FROM project_owners WHERE project_id = ? LIMIT 1")
      .get(cleanProjectId) as Record<string, SQLOutputValue> | undefined;
    if (!row) return null;
    return {
      projectId: asString(row.project_id),
      userId: asNullableString(row.user_id),
      userHandle: asString(row.user_handle),
      sessionId: asNullableString(row.session_id),
      updatedAt: asString(row.updated_at),
    };
  }

  deleteProjectOwner(projectId: string): void {
    const cleanProjectId = projectId.trim();
    if (!cleanProjectId) return;
    const state = this.ensureDb();
    const res = state.db.prepare("DELETE FROM project_owners WHERE project_id = ?").run(cleanProjectId);
    if (res.changes > 0) {
      this.syncToPersistent(state);
    }
  }

  listUserProjectIds(userHandle: string): string[] {
    const cleanHandle = normalizeHandle(userHandle);
    if (!cleanHandle) return [];
    const state = this.ensureDb();
    const rows = state.db
      .prepare("SELECT project_id FROM project_owners WHERE user_handle = ?")
      .all(cleanHandle) as Record<string, SQLOutputValue>[];
    return rows.map((row) => asString(row.project_id)).filter(Boolean);
  }

  getOrCreateMcpSessionToken(preferredHandle?: string | null, explicitToken?: string | null): string {
    const cleanExplicit = explicitToken?.trim() ?? "";
    if (cleanExplicit.startsWith("tok_") && this.verifySession(cleanExplicit)) {
      return cleanExplicit;
    }

    const cleanHandle = preferredHandle ? normalizeHandle(preferredHandle) : "";
    const key = cleanHandle || "__default__";
    const cached = this.mcpTokenCache.get(key);
    if (cached && this.verifySession(cached)) {
      return cached;
    }

    const state = this.ensureDb();
    let userRow = cleanHandle
      ? (state.db
          .prepare("SELECT * FROM users WHERE handle = ? LIMIT 1")
          .get(cleanHandle) as Record<string, SQLOutputValue> | undefined)
      : undefined;

    if (!userRow) {
      userRow = state.db
        .prepare("SELECT * FROM users ORDER BY last_seen_at DESC LIMIT 1")
        .get() as Record<string, SQLOutputValue> | undefined;
    }

    if (!userRow) {
      const id = `usr_${crypto.randomBytes(8).toString("hex")}`;
      const defaultHandle = /^[a-z0-9][a-z0-9_-]{1,31}$/.test(cleanHandle) ? cleanHandle : "creador";
      const passwordHash = hashPasswordScrypt("oeclip-mcp-default");
      const avatarColor = pickAvatarColor(defaultHandle);
      const nowIso = new Date().toISOString();

      state.db
        .prepare(`
          INSERT INTO users (id, handle, display_name, email, password_hash, avatar_color, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(id, defaultHandle, "Creador OECLIP", null, passwordHash, avatarColor, nowIso, nowIso);

      userRow = state.db
        .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
        .get(id) as Record<string, SQLOutputValue> | undefined;
    }

    if (!userRow) {
      throw new HttpError(500, "No se pudo inicializar la sesión MCP.", "mcp_session_failed");
    }

    const session = this.createSession(state, userRow);
    this.mcpTokenCache.set(key, session.token);
    return session.token;
  }

  getUserAiSettings(sessionId: string): StoredUserAiSettings | null {
    const cleanSession = sessionId.trim();
    if (!cleanSession) return null;
    const state = this.ensureDb();
    let row = state.db
      .prepare("SELECT * FROM user_ai_settings WHERE session_id = ? LIMIT 1")
      .get(cleanSession) as Record<string, SQLOutputValue> | undefined;

    // Si el usuario tiene ses_<handle>, respaldar búsqueda por user_id en users
    if (!row && cleanSession.startsWith("ses_") && !cleanSession.startsWith("ses_anon_")) {
      const handleCandidate = cleanSession.slice(4);
      const userRow = state.db
        .prepare("SELECT id FROM users WHERE handle = ? LIMIT 1")
        .get(handleCandidate) as Record<string, SQLOutputValue> | undefined;
      const uid = userRow ? asString(userRow.id) : "";
      if (uid) {
        row = state.db
          .prepare("SELECT * FROM user_ai_settings WHERE user_id = ? LIMIT 1")
          .get(uid) as Record<string, SQLOutputValue> | undefined;
      }
    }

    if (!row) return null;
    const baseUrl = asString(row.base_url);
    const model = asString(row.model);
    if (!baseUrl || !model) return null;
    return {
      provider: asString(row.provider) || "custom",
      baseUrl,
      apiKey: asString(row.api_key),
      model,
      transcribeModel: asString(row.transcribe_model),
      supportsTranscription: Number(row.supports_transcription) === 1,
      timeoutMs: Number(row.timeout_ms) || 120_000,
      updatedAt: asString(row.updated_at),
    };
  }

  saveUserAiSettings(sessionId: string, cfg: StoredUserAiSettings, userId?: string | null): void {
    const cleanSession = sessionId.trim();
    if (!cleanSession) return;
    const state = this.ensureDb();
    let resolvedUserId = userId?.trim() || null;
    if (!resolvedUserId && cleanSession.startsWith("ses_") && !cleanSession.startsWith("ses_anon_")) {
      const handleCandidate = cleanSession.slice(4);
      const userRow = state.db
        .prepare("SELECT id FROM users WHERE handle = ? LIMIT 1")
        .get(handleCandidate) as Record<string, SQLOutputValue> | undefined;
      resolvedUserId = userRow ? asNullableString(userRow.id) : null;
    }

    state.db
      .prepare(`
        INSERT INTO user_ai_settings (
          session_id, user_id, provider, base_url, api_key, model, transcribe_model, supports_transcription, timeout_ms, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          user_id = COALESCE(excluded.user_id, user_ai_settings.user_id),
          provider = excluded.provider,
          base_url = excluded.base_url,
          api_key = excluded.api_key,
          model = excluded.model,
          transcribe_model = excluded.transcribe_model,
          supports_transcription = excluded.supports_transcription,
          timeout_ms = excluded.timeout_ms,
          updated_at = excluded.updated_at
      `)
      .run(
        cleanSession,
        resolvedUserId,
        cfg.provider,
        cfg.baseUrl,
        cfg.apiKey,
        cfg.model,
        cfg.transcribeModel,
        cfg.supportsTranscription ? 1 : 0,
        cfg.timeoutMs,
        cfg.updatedAt || new Date().toISOString(),
      );
    this.syncToPersistent(state);
  }

  claimAnonymousAiSettingsIfEmpty(anonSessionId: string, targetSessionId: string, targetUserId?: string | null): boolean {
    const cleanAnon = anonSessionId.trim();
    const cleanTarget = targetSessionId.trim();
    if (!cleanAnon || !cleanTarget || cleanAnon === cleanTarget || !cleanAnon.startsWith("ses_anon_")) {
      return false;
    }
    const existingTarget = this.getUserAiSettings(cleanTarget);
    if (existingTarget?.apiKey) return false;
    const anon = this.getUserAiSettings(cleanAnon);
    if (!anon?.apiKey) return false;

    this.saveUserAiSettings(cleanTarget, anon, targetUserId);
    const state = this.ensureDb();
    state.db.prepare("DELETE FROM user_ai_settings WHERE session_id = ?").run(cleanAnon);
    this.syncToPersistent(state);
    return true;
  }

  listAdminUsers(): AdminUserSummary[] {
    const state = this.ensureDb();
    const rows = state.db
      .prepare("SELECT * FROM users ORDER BY (role = 'admin') DESC, created_at ASC")
      .all() as Record<string, SQLOutputValue>[];

    const projectCounts = new Map<string, number>();
    const ownerRows = state.db
      .prepare("SELECT user_handle, COUNT(*) AS cnt FROM project_owners GROUP BY user_handle")
      .all() as Record<string, SQLOutputValue>[];
    for (const r of ownerRows) {
      const h = asString(r.user_handle);
      if (h) projectCounts.set(h, Number(r.cnt) || 0);
    }

    const aiBySession = new Map<string, { hasKey: boolean; model: string | null }>();
    const aiRows = state.db
      .prepare("SELECT session_id, user_id, api_key, model FROM user_ai_settings")
      .all() as Record<string, SQLOutputValue>[];
    for (const r of aiRows) {
      const hasKey = Boolean(asString(r.api_key).trim());
      const model = asNullableString(r.model);
      const sid = asString(r.session_id);
      const uid = asString(r.user_id);
      if (sid) aiBySession.set(sid, { hasKey, model });
      if (uid) aiBySession.set(uid, { hasKey, model });
    }

    return rows.map((row) => {
      const pub = mapUserRow(row, true);
      const aiMeta = aiBySession.get(pub.id) ?? aiBySession.get(pub.sessionId);
      return {
        ...pub,
        projectCount: projectCounts.get(pub.handle) ?? 0,
        hasAiKey: Boolean(aiMeta?.hasKey),
        aiModel: aiMeta?.hasKey ? aiMeta.model : null,
      };
    });
  }

  adminCreateUser(input: RegisterInput & { role?: "admin" | "user" }): AdminUserSummary {
    const state = this.ensureDb();
    const handle = normalizeHandle(input.handle);
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle)) {
      throw new HttpError(
        400,
        "El nombre de usuario debe tener entre 2 y 32 caracteres (letras, números, _ o -).",
        "invalid_handle",
      );
    }

    const rawPassword = typeof input.password === "string" ? input.password : "";
    if (rawPassword.length < 4 || rawPassword.length > 128) {
      throw new HttpError(
        400,
        "La contraseña debe tener entre 4 y 128 caracteres.",
        "invalid_password",
      );
    }

    const email = normalizeEmail(input.email);
    const existingHandle = state.db
      .prepare("SELECT id FROM users WHERE handle = ?")
      .get(handle) as Record<string, SQLOutputValue> | undefined;
    if (existingHandle) {
      throw new HttpError(409, `El usuario @${handle} ya existe.`, "handle_taken");
    }

    if (email) {
      const existingEmail = state.db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email) as Record<string, SQLOutputValue> | undefined;
      if (existingEmail) {
        throw new HttpError(409, "Ya existe una cuenta con ese correo electrónico.", "email_taken");
      }
    }

    const id = `usr_${crypto.randomBytes(8).toString("hex")}`;
    const displayName = input.displayName?.trim().slice(0, 48) || handle;
    const passwordHash = hashPasswordScrypt(rawPassword);
    const avatarColor = pickAvatarColor(handle);
    const nowIso = new Date().toISOString();
    const role: "admin" | "user" = input.role === "admin" ? "admin" : "user";

    state.db
      .prepare(`
        INSERT INTO users (id, handle, display_name, email, password_hash, avatar_color, role, disabled, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `)
      .run(id, handle, displayName, email, passwordHash, avatarColor, role, nowIso, nowIso);

    this.syncToPersistent(state);
    const created = this.listAdminUsers().find((u) => u.id === id);
    if (!created) throw new HttpError(500, "No se pudo crear la cuenta.", "create_user_failed");
    return created;
  }

  adminUpdateUser(
    targetUserId: string,
    actingUserId: string,
    patch: {
      role?: "admin" | "user";
      disabled?: boolean;
      displayName?: string;
      email?: string | null;
      password?: string;
    },
  ): AdminUserSummary {
    const cleanId = targetUserId.trim();
    const state = this.ensureDb();
    const currentRow = state.db
      .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
      .get(cleanId) as Record<string, SQLOutputValue> | undefined;
    if (!currentRow) {
      throw new HttpError(404, "La cuenta solicitada no existe.", "user_not_found");
    }

    if (cleanId === actingUserId) {
      if (patch.role === "user") {
        throw new HttpError(400, "No puedes quitarte el rol de administrador a ti mismo.", "cannot_demote_self");
      }
      if (patch.disabled === true) {
        throw new HttpError(400, "No puedes suspender tu propia cuenta activa.", "cannot_disable_self");
      }
    }

    const nextDisplayName =
      patch.displayName !== undefined
        ? patch.displayName.trim().slice(0, 48) || asString(currentRow.handle)
        : asString(currentRow.display_name);

    const nextEmail =
      patch.email !== undefined
        ? patch.email === null || patch.email.trim() === ""
          ? null
          : normalizeEmail(patch.email)
        : asNullableString(currentRow.email);

    if (nextEmail) {
      const dup = state.db
        .prepare("SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1")
        .get(nextEmail, cleanId) as Record<string, SQLOutputValue> | undefined;
      if (dup) {
        throw new HttpError(409, "Ese correo electrónico ya pertenece a otra cuenta.", "email_taken");
      }
    }

    const nextRole =
      patch.role === "admin" || patch.role === "user"
        ? patch.role
        : asString(currentRow.role) === "admin"
          ? "admin"
          : "user";
    const nextDisabled =
      patch.disabled !== undefined ? (patch.disabled ? 1 : 0) : Number(currentRow.disabled) === 1 ? 1 : 0;

    let nextPasswordHash = asString(currentRow.password_hash);
    let revokeSessions = nextDisabled === 1;
    if (patch.password !== undefined && patch.password.length > 0) {
      if (patch.password.length < 4 || patch.password.length > 128) {
        throw new HttpError(400, "La contraseña debe tener entre 4 y 128 caracteres.", "invalid_password");
      }
      nextPasswordHash = hashPasswordScrypt(patch.password);
      revokeSessions = true;
    }

    state.db
      .prepare(`
        UPDATE users
        SET display_name = ?, email = ?, role = ?, disabled = ?, password_hash = ?
        WHERE id = ?
      `)
      .run(nextDisplayName, nextEmail, nextRole, nextDisabled, nextPasswordHash, cleanId);

    if (revokeSessions) {
      state.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(cleanId);
    }

    this.syncToPersistent(state);
    const updated = this.listAdminUsers().find((u) => u.id === cleanId);
    if (!updated) throw new HttpError(404, "Cuenta no encontrada.", "user_not_found");
    return updated;
  }

  adminDeleteUser(targetUserId: string, actingUserId: string): { deleted: boolean; id: string } {
    const cleanId = targetUserId.trim();
    if (cleanId === actingUserId) {
      throw new HttpError(400, "No puedes eliminar tu propia cuenta activa.", "cannot_delete_self");
    }
    const state = this.ensureDb();
    const row = state.db
      .prepare("SELECT id, handle FROM users WHERE id = ? LIMIT 1")
      .get(cleanId) as Record<string, SQLOutputValue> | undefined;
    if (!row) {
      throw new HttpError(404, "La cuenta solicitada no existe.", "user_not_found");
    }

    const handle = asString(row.handle);
    state.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(cleanId);
    state.db.prepare("DELETE FROM user_ai_settings WHERE user_id = ? OR session_id = ?").run(cleanId, `ses_${handle}`);
    const res = state.db.prepare("DELETE FROM users WHERE id = ?").run(cleanId);
    this.syncToPersistent(state);
    return { deleted: res.changes > 0, id: cleanId };
  }

  close(): void {
    this.mcpTokenCache.clear();
    if (!this.state) return;
    const prev = this.state;
    this.state = null;
    try {
      prev.db.close();
    } catch {
      // Ignore close errors
    }
    this.removeIfExists(`${prev.workDbPath}-journal`);
    this.removeIfExists(`${prev.workDbPath}-wal`);
    this.removeIfExists(`${prev.workDbPath}-shm`);
  }
}

export const userStore = new SqliteAuthStore();
