import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaAsset } from "../src/shared/schema";
import { defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";

let store: typeof import("../server/projects/store").projectStore;
let authStore: typeof import("../server/auth/store").userStore;
let buildServer: typeof import("../server/app").buildServer;
let tempDir = "";
let originalDataDir: string | undefined;

function makeAsset(): MediaAsset {
  return {
    id: "med_store000001",
    name: "plano.mp4",
    kind: "video",
    file: "media/plano.mp4",
    mimeType: "video/mp4",
    sizeBytes: 2048,
    durationUs: 4_000_000,
    width: 1280,
    height: 720,
    fps: { num: 30, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    thumbnail: "pending",
    waveform: "pending",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
  };
}

beforeAll(async () => {
  originalDataDir = process.env.NOVACUT_DATA_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "novacut-store-"));
  process.env.NOVACUT_DATA_DIR = tempDir;
  const module = await import("../server/projects/store");
  const authModule = await import("../server/auth/store");
  const appModule = await import("../server/app");
  store = module.projectStore;
  authStore = authModule.userStore;
  buildServer = appModule.buildServer;
});

afterAll(async () => {
  authStore?.close();
  if (originalDataDir === undefined) delete process.env.NOVACUT_DATA_DIR;
  else process.env.NOVACUT_DATA_DIR = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("almacen de proyectos", () => {
  it("crea, guarda y detecta conflictos de revision", async () => {
    const bundle = await store.create("Prueba de almacen", defaultSettings(1280, 720, 30));
    const id = bundle.project.id;
    const textTrack = bundle.project.tracks.find((track) => track.kind === "text")!;
    const added = addClip(
      bundle.project,
      textTrack.id,
      makeTextClip({ text: "Hola", startFrame: 0, durationFrames: 30, role: "title" }),
    );
    if (!added.ok) throw new Error(added.error);

    const first = await store.saveTimeline(id, added.project, { baseRevision: 0 });
    expect(first.project.revision).toBe(1);

    await expect(store.saveTimeline(id, added.project, { baseRevision: 0 })).rejects.toMatchObject({
      code: "revision_conflict",
    });

    const forced = await store.saveTimeline(id, added.project, { force: true });
    expect(forced.project.revision).toBe(2);

    const disk = await store.get(id);
    expect(disk.project.tracks.find((track) => track.kind === "text")?.clips).toHaveLength(1);
  });

  it("conserva el estado de miniaturas y proxies al guardar desde el cliente", async () => {
    const bundle = await store.create("Metadatos", defaultSettings(1280, 720, 30));
    const id = bundle.project.id;
    const asset = makeAsset();
    const withMedia = await store.addMedia(id, asset);
    expect(withMedia.revision).toBe(1);

    await store.updateMedia(id, asset.id, { thumbnail: "ready", waveform: "ready", proxy: "ready", proxyFile: "proxies/med_store000001.mp4" });

    // El cliente guarda una copia antigua con los estados aun en "pending".
    const stale = structuredClone(withMedia.project);
    stale.media[0] = { ...stale.media[0]!, thumbnail: "pending", waveform: "pending", proxy: "none" };
    const saved = await store.saveTimeline(id, stale, { baseRevision: 1 });
    const savedAsset = saved.project.media.find((item) => item.id === asset.id)!;
    expect(savedAsset.thumbnail).toBe("ready");
    expect(savedAsset.waveform).toBe("ready");
    expect(savedAsset.proxy).toBe("ready");
    expect(savedAsset.proxyFile).toBe("proxies/med_store000001.mp4");
    expect(saved.project.revision).toBe(2);
  });

  it("crea y restaura instantaneas del montaje", async () => {
    const bundle = await store.create("Historial", defaultSettings(1280, 720, 30));
    const id = bundle.project.id;
    const videoTrack = bundle.project.tracks.find((track) => track.kind === "video")!;
    const asset = makeAsset();
    await store.addMedia(id, asset);
    const latest = await store.get(id);
    const assetFromServer = latest.project.media[0]!;
    let project = latest.project;
    const added = addClip(project, videoTrack.id, makeMediaClip(project, assetFromServer, { startFrame: 0 }));
    if (!added.ok) throw new Error(added.error);
    project = added.project;
    await store.saveTimeline(id, project, { baseRevision: latest.project.revision });

    const snapshot = await store.createSnapshot(id, "Antes de borrar");
    expect(snapshot.fileName.endsWith(".json")).toBe(true);

    const empty = structuredClone(project);
    empty.tracks = empty.tracks.map((track) => ({ ...track, clips: [] }));
    await store.saveTimeline(id, empty, { force: true });
    expect((await store.get(id)).project.tracks.flatMap((track) => track.clips)).toHaveLength(0);

    const restored = await store.restoreSnapshot(id, snapshot.fileName);
    expect(restored.project.tracks.flatMap((track) => track.clips)).toHaveLength(1);
    const list = await store.listSnapshots(id);
    expect(list.some((item) => item.fileName === snapshot.fileName)).toBe(true);
  });

  it("elimina un proyecto y lo conserva en la papelera", async () => {
    const bundle = await store.create("Borrar", defaultSettings(1280, 720, 30));
    const id = bundle.project.id;
    await store.delete(id);
    await expect(store.get(id)).rejects.toMatchObject({ code: "project_not_found" });
    const trash = await fs.readdir(path.join(tempDir, "trash"));
    expect(trash.some((name) => name.startsWith(id))).toBe(true);
  });
});

describe("autenticacion SQLite y aislamiento por usuario", () => {
  it("persiste cuentas en oeclip.db, valida credenciales y sesiones sin auto-registro", async () => {
    const reg = authStore.register({
      handle: "ana_creator",
      displayName: "Ana Videos",
      email: "ana@oeclip.test",
      password: "clave-segura-123",
    });
    expect(reg.user.handle).toBe("ana_creator");
    expect(reg.user.email).toBe("ana@oeclip.test");
    expect(reg.token.startsWith("tok_")).toBe(true);

    const dbStat = await fs.stat(path.join(tempDir, "oeclip.db"));
    expect(dbStat.size).toBeGreaterThan(0);

    // Rechaza duplicados por usuario y por correo
    expect(() =>
      authStore.register({ handle: "ana_creator", password: "otra-clave-456" }),
    ).toThrowError();
    expect(() =>
      authStore.register({ handle: "ana_dos", email: "ANA@oeclip.test", password: "otra-clave-456" }),
    ).toThrowError();

    // Rechaza auto-registro en login si la cuenta no existe
    expect(() =>
      authStore.login({ identifier: "no_existe", password: "clave-segura-123" }),
    ).toThrowError();

    // Rechaza contraseña incorrecta
    expect(() =>
      authStore.login({ identifier: "ana_creator", password: "incorrecta" }),
    ).toThrowError();

    // Permite login con correo electronico y verificar sesion / cerrar sesion
    const emailLogin = authStore.login({
      identifier: "ana@oeclip.test",
      password: "clave-segura-123",
    });
    expect(emailLogin.user.handle).toBe("ana_creator");
    const verified = authStore.verifySession(emailLogin.token);
    expect(verified?.user.handle).toBe("ana_creator");

    const logoutRes = authStore.logout(emailLogin.token);
    expect(logoutRes.revoked).toBe(true);
    expect(authStore.verifySession(emailLogin.token)).toBeNull();
  });

  it("aisla proyectos por cuenta y bloquea accesos HTTP sin sesion", async () => {
    const app = await buildServer();
    try {
      const regA = authStore.register({
        handle: "usuario_alfa",
        password: "passwordA1",
      });
      const regB = authStore.register({
        handle: "usuario_beta",
        password: "passwordB1",
      });

      // Sin token no puede crear proyectos ni listar proyectos de otros
      const unauthCreate = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: {
          "x-user-handle": "usuario_alfa", // Spoof sin token
        },
        payload: { name: "Proyecto intruso" },
      });
      expect(unauthCreate.statusCode).toBe(401);
      expect(unauthCreate.json()).toMatchObject({ code: "auth_required" });

      const unauthList = await app.inject({
        method: "GET",
        url: "/api/projects",
      });
      expect(unauthList.statusCode).toBe(200);
      expect(unauthList.json()).toEqual({ projects: [] });

      // Usuario Alfa crea su proyecto autenticado
      const createA = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: {
          authorization: `Bearer ${regA.token}`,
        },
        payload: { name: "Proyecto Alfa" },
      });
      expect(createA.statusCode).toBe(201);
      const bundleA = createA.json() as { project: { id: string; name: string } };

      const listA = await store.list(regA.user.sessionId, regA.user.handle);
      const listB = await store.list(regB.user.sessionId, regB.user.handle);
      expect(listA.some((p) => p.id === bundleA.project.id)).toBe(true);
      expect(listB.some((p) => p.id === bundleA.project.id)).toBe(false);

      // Usuario Beta no puede abrir el proyecto de Alfa
      const crossRead = await app.inject({
        method: "GET",
        url: `/api/projects/${bundleA.project.id}`,
        headers: {
          authorization: `Bearer ${regB.token}`,
        },
      });
      expect(crossRead.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("deshabilita listado publico de usuarios y conserva el token IA tras cerrar y reabrir sesion", async () => {
    const app = await buildServer();
    try {
      // 1. Endpoint publico de usuarios bloqueado por seguridad
      const listRes = await app.inject({ method: "GET", url: "/api/auth/users" });
      expect(listRes.statusCode).toBe(403);
      expect(listRes.json()).toMatchObject({ code: "user_list_disabled" });

      // 2. Registrar y guardar API Key / Token IA
      const reg = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { handle: "token_owner", password: "mi-password-99" },
      });
      expect(reg.statusCode).toBe(201);
      const regData = reg.json() as { token: string };

      const saveRes = await app.inject({
        method: "PUT",
        url: "/api/ai/settings",
        headers: { authorization: `Bearer ${regData.token}` },
        payload: {
          provider: "gemini",
          apiKey: "AIzaSyTestPersistentToken9876",
          model: "gemini-3.8-flash",
        },
      });
      expect(saveRes.statusCode).toBe(200);
      expect(saveRes.json()).toMatchObject({ hasApiKey: true, keyHint: "****9876" });

      // 3. Cerrar sesion y verificar que el token NO se filtra sin autenticacion
      const logoutRes = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { authorization: `Bearer ${regData.token}` },
        payload: {},
      });
      expect(logoutRes.statusCode).toBe(200);

      const anonCfg = await app.inject({
        method: "GET",
        url: "/api/ai/settings",
        headers: { "x-session-id": "ses_anon_otro" },
      });
      expect(anonCfg.json()).toMatchObject({ hasApiKey: false });

      // 4. Volver a iniciar sesion y verificar que el token persiste en SQLite + /api/config
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-session-id": "ses_anon_otro" },
        payload: { identifier: "token_owner", password: "mi-password-99" },
      });
      expect(loginRes.statusCode).toBe(200);
      const loginData = loginRes.json() as { token: string };

      const restoredSettings = await app.inject({
        method: "GET",
        url: "/api/ai/settings",
        headers: { authorization: `Bearer ${loginData.token}` },
      });
      expect(restoredSettings.statusCode).toBe(200);
      expect(restoredSettings.json()).toMatchObject({
        hasApiKey: true,
        keyHint: "****9876",
        provider: "gemini",
        model: "gemini-3.8-flash",
      });

      const restoredConfig = await app.inject({
        method: "GET",
        url: "/api/config",
        headers: { authorization: `Bearer ${loginData.token}` },
      });
      expect(restoredConfig.statusCode).toBe(200);
      expect(restoredConfig.json()).toMatchObject({
        ai: { configured: true, model: "gemini-3.8-flash" },
      });

      // 5. Si alguien guardo una API Key antes de registrarse, se reclama para su nueva cuenta
      await app.inject({
        method: "PUT",
        url: "/api/ai/settings",
        headers: { "x-session-id": "ses_anon_prelogin1" },
        payload: {
          provider: "groq",
          apiKey: "gsk_PreLoginKey4321",
          model: "llama-3.3-70b-versatile",
        },
      });
      const regClaim = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { "x-session-id": "ses_anon_prelogin1" },
        payload: { handle: "anon_claim_user", password: "clave-claim-1" },
      });
      expect(regClaim.statusCode).toBe(201);
      const claimData = regClaim.json() as { token: string };
      const claimedSettings = await app.inject({
        method: "GET",
        url: "/api/ai/settings",
        headers: { authorization: `Bearer ${claimData.token}` },
      });
      expect(claimedSettings.json()).toMatchObject({
        hasApiKey: true,
        keyHint: "****4321",
        provider: "groq",
      });
    } finally {
      await app.close();
    }
  });

  it("restringe gestion de cuentas exclusivamente al admin y soporta crear, suspender, cambiar clave y eliminar", async () => {
    const app = await buildServer();
    try {
      // Primera cuenta registrada en la BD debe ser admin; usuarios posteriores son "user"
      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: "ana_creator", password: "clave-segura-123" },
      });
      expect(adminLogin.statusCode).toBe(200);
      const adminAuth = adminLogin.json() as { token: string; user: { id: string; role: string } };
      expect(adminAuth.user.role).toBe("admin");

      const regularLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: "usuario_beta", password: "passwordB1" },
      });
      expect(regularLogin.statusCode).toBe(200);
      const userAuth = regularLogin.json() as { token: string; user: { id: string; role: string } };
      expect(userAuth.user.role).toBe("user");

      // Sin sesion -> 401
      const noAuthList = await app.inject({ method: "GET", url: "/api/admin/users" });
      expect(noAuthList.statusCode).toBe(401);

      // Usuario estandar -> 403 en todos los endpoints admin
      const forbiddenList = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: { authorization: `Bearer ${userAuth.token}` },
      });
      expect(forbiddenList.statusCode).toBe(403);
      expect(forbiddenList.json()).toMatchObject({ code: "admin_required" });

      const forbiddenCreate = await app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: { authorization: `Bearer ${userAuth.token}` },
        payload: { handle: "intruso_admin", password: "pass-1234", role: "admin" },
      });
      expect(forbiddenCreate.statusCode).toBe(403);

      // Admin lista cuentas con metadatos de proyectos y claves IA
      const adminList = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: { authorization: `Bearer ${adminAuth.token}` },
      });
      expect(adminList.statusCode).toBe(200);
      const listed = adminList.json() as {
        users: Array<{ id: string; handle: string; role: string; hasAiKey: boolean; projectCount: number }>;
      };
      expect(listed.users.some((u) => u.handle === "token_owner" && u.hasAiKey)).toBe(true);
      expect(listed.users.some((u) => u.handle === "usuario_alfa" && u.projectCount >= 1)).toBe(true);

      // Admin crea una nueva cuenta
      const createdRes = await app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: { authorization: `Bearer ${adminAuth.token}` },
        payload: {
          handle: "managed_creator",
          displayName: "Creador Gestionado",
          email: "managed@oeclip.test",
          password: "clave-inicial-1",
          role: "user",
        },
      });
      expect(createdRes.statusCode).toBe(201);
      const createdUser = (createdRes.json() as { user: { id: string; handle: string; role: string } }).user;
      expect(createdUser.handle).toBe("managed_creator");
      expect(createdUser.role).toBe("user");

      // Admin no puede auto-suspenderse, auto-degradarse ni auto-eliminarse
      const selfDemote = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${adminAuth.user.id}`,
        headers: { authorization: `Bearer ${adminAuth.token}` },
        payload: { role: "user" },
      });
      expect(selfDemote.statusCode).toBe(400);

      const selfDelete = await app.inject({
        method: "DELETE",
        url: `/api/admin/users/${adminAuth.user.id}`,
        headers: { authorization: `Bearer ${adminAuth.token}` },
      });
      expect(selfDelete.statusCode).toBe(400);

      // Admin suspende cuenta: bloquea login y revoca sesiones existentes
      const managedLogin1 = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: "managed_creator", password: "clave-inicial-1" },
      });
      const managedTok1 = (managedLogin1.json() as { token: string }).token;

      const suspendRes = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${createdUser.id}`,
        headers: { authorization: `Bearer ${adminAuth.token}` },
        payload: { disabled: true },
      });
      expect(suspendRes.statusCode).toBe(200);
      expect(suspendRes.json()).toMatchObject({ user: { disabled: true } });

      const revokedMe = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: `Bearer ${managedTok1}` },
      });
      expect(revokedMe.json()).toMatchObject({ authenticated: false });

      const disabledLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: "managed_creator", password: "clave-inicial-1" },
      });
      expect(disabledLogin.statusCode).toBe(403);
      expect(disabledLogin.json()).toMatchObject({ code: "account_disabled" });

      // Reactiva y cambia contraseña
      const reactivateRes = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${createdUser.id}`,
        headers: { authorization: `Bearer ${adminAuth.token}` },
        payload: { disabled: false, password: "nueva-clave-segura", role: "admin" },
      });
      expect(reactivateRes.statusCode).toBe(200);
      expect(reactivateRes.json()).toMatchObject({ user: { disabled: false, role: "admin" } });

      const relogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: "managed_creator", password: "nueva-clave-segura" },
      });
      expect(relogin.statusCode).toBe(200);

      // Admin elimina cuenta gestionada
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/admin/users/${createdUser.id}`,
        headers: { authorization: `Bearer ${adminAuth.token}` },
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json()).toMatchObject({ deleted: true });
    } finally {
      await app.close();
    }
  });

  it("permite editar perfil propio, conservar proyectos y token IA al cambiar de handle y cambiar contrasena", async () => {
    const app = await buildServer();
    try {
      // Sin autenticacion -> 401
      const unauthPatch = await app.inject({
        method: "PATCH",
        url: "/api/auth/me",
        payload: { displayName: "Intruso" },
      });
      expect(unauthPatch.statusCode).toBe(401);

      // Registrar usuario estandar
      const reg = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          handle: "perfil_orig",
          displayName: "Perfil Original",
          email: "perfil@ejemplo.com",
          password: "clave-original-123",
        },
      });
      expect(reg.statusCode).toBe(201);
      const regBody = reg.json() as {
        token: string;
        user: { id: string; handle: string; role: string; sessionId: string };
      };
      expect(regBody.user.role).toBe("user");
      const headers = {
        authorization: `Bearer ${regBody.token}`,
        "x-session-id": regBody.user.sessionId,
      };

      // Crear proyecto y guardar token IA bajo el handle original
      const createdProj = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "Proyecto Conservado", aspect: "9:16", height: 1080, fps: 30 },
      });
      expect(createdProj.statusCode).toBe(201);
      const projId = (createdProj.json() as { project: { id: string } }).project.id;

      const saveAi = await app.inject({
        method: "PUT",
        url: "/api/ai/settings",
        headers,
        payload: {
          provider: "gemini",
          apiKey: "AIzaSyKeepAcrossRename5555",
        },
      });
      expect(saveAi.statusCode).toBe(200);
      expect(saveAi.json()).toMatchObject({ hasApiKey: true, keyHint: "****5555" });

      // Editar perfil: cambiar nombre, correo y handle + intentar escalar rol (debe ignorarse)
      const patchProfile = await app.inject({
        method: "PATCH",
        url: "/api/auth/me",
        headers,
        payload: {
          handle: "perfil_renombrado",
          displayName: "Creador Renombrado",
          email: "nuevo_correo@ejemplo.com",
          role: "admin",
        },
      });
      expect(patchProfile.statusCode).toBe(200);
      const patchedBody = patchProfile.json() as {
        authenticated: boolean;
        user: { handle: string; displayName: string; email: string; role: string; sessionId: string };
      };
      expect(patchedBody).toMatchObject({
        authenticated: true,
        user: {
          handle: "perfil_renombrado",
          displayName: "Creador Renombrado",
          email: "nuevo_correo@ejemplo.com",
          role: "user",
          sessionId: "ses_perfil_renombrado",
        },
      });

      // Con el nuevo sessionId + mismo token, el proyecto y el token IA siguen disponibles
      const nextHeaders = {
        authorization: `Bearer ${regBody.token}`,
        "x-session-id": patchedBody.user.sessionId,
      };
      const projList = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: nextHeaders,
      });
      expect(projList.statusCode).toBe(200);
      expect((projList.json() as { projects: Array<{ id: string }> }).projects.some((p) => p.id === projId)).toBe(
        true,
      );

      const aiAfterRename = await app.inject({
        method: "GET",
        url: "/api/ai/settings",
        headers: nextHeaders,
      });
      expect(aiAfterRename.statusCode).toBe(200);
      expect(aiAfterRename.json()).toMatchObject({ hasApiKey: true, keyHint: "****5555" });

      // Cambio de contrasena: clave actual incorrecta -> 401
      const wrongPass = await app.inject({
        method: "PATCH",
        url: "/api/auth/me",
        headers: nextHeaders,
        payload: { currentPassword: "incorrecta", newPassword: "clave-cambiada-999" },
      });
      expect(wrongPass.statusCode).toBe(401);

      // Cambio de contrasena valido -> 200 y sesion actual sigue activa
      const goodPass = await app.inject({
        method: "PATCH",
        url: "/api/auth/me",
        headers: nextHeaders,
        payload: { currentPassword: "clave-original-123", newPassword: "clave-cambiada-999" },
      });
      expect(goodPass.statusCode).toBe(200);

      const stillActive = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: nextHeaders,
      });
      expect(stillActive.statusCode).toBe(200);
      expect(stillActive.json()).toMatchObject({
        authenticated: true,
        user: { handle: "perfil_renombrado", displayName: "Creador Renombrado" },
      });

      // Iniciar sesion con el nuevo handle y la nueva contrasena
      const newLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: "perfil_renombrado", password: "clave-cambiada-999" },
      });
      expect(newLogin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
