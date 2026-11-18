import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultSettings, timelineDurationFrames } from "../src/shared/project";

let tempDir = "";
let originalDataDir: string | undefined;

let store: typeof import("../server/projects/store").projectStore;
let authStore: typeof import("../server/auth/store").userStore;
let skillRegistry: typeof import("../server/skills/registry").skillRegistry;
let runDirectorAgent: typeof import("../server/agent/directorAgent").runDirectorAgent;
let getTool: typeof import("../server/agent/tools").getTool;
let measureFramePairMotionDiffPercent: typeof import("../server/agent/perception").measureFramePairMotionDiffPercent;
let createDownloadToken: typeof import("../server/services/downloadTokenService").createDownloadToken;
let verifyDownloadToken: typeof import("../server/services/downloadTokenService").verifyDownloadToken;
let resolveSafeProjectRelativePath: typeof import("../server/services/downloadTokenService").resolveSafeProjectRelativePath;

const GOLDEN_CASE1_PROMPT = `Genera el reel oficial de lanzamiento de OECLIP en 9:16 (1080x1920, 30 fps) de exactamente 24 segundos.

Estructura obligatoria (24 s exactos):
- 0–3 s · Gancho: pregunta directa de alto impacto "¿Tus videos tardan horas?" sobre fondo oscuro tecnológico.
- 3–8 s · Marca y propuesta: logotipo "OECLIP" y subtítulo "Estudio de Video con IA" con red neuronal en cian y azul.
- 8–17 s · Demo producto (3 micro-beats de 3 s):
  · 8–11 s: "Cortes inteligentes" sobre línea de tiempo animada.
  · 11–14 s: "Motion IA en Remotion" con nodos dinámicos.
  · 14–17 s: "Subtítulos dinámicos" estilo karaoke sincronizado.
- 17–24 s · Cierre y CTA: propuesta "Crea contenido profesional sin plantillas rígidas" y botón prominente "Pruébalo ahora en OECLIP".

Audio y subtítulos:
- Voz en off clara en español sincronizada en los 6 actos.
- Subtítulos dinámicos palabra por palabra (<= 4 palabras por bloque) con estilo karaoke.
- Música de fondo estilo tech con ducking automático bajo la voz y SFX suaves entre transiciones.`;

beforeAll(async () => {
  originalDataDir = process.env.NOVACUT_DATA_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-golden-case1-"));
  process.env.NOVACUT_DATA_DIR = tempDir;

  const storeMod = await import("../server/projects/store");
  const authMod = await import("../server/auth/store");
  const skillsMod = await import("../server/skills/registry");
  const directorMod = await import("../server/agent/directorAgent");
  const toolsMod = await import("../server/agent/tools");
  const perceptionMod = await import("../server/agent/perception");
  const downloadMod = await import("../server/services/downloadTokenService");

  store = storeMod.projectStore;
  authStore = authMod.userStore;
  skillRegistry = skillsMod.skillRegistry;
  runDirectorAgent = directorMod.runDirectorAgent;
  getTool = toolsMod.getTool;
  measureFramePairMotionDiffPercent = perceptionMod.measureFramePairMotionDiffPercent;
  createDownloadToken = downloadMod.createDownloadToken;
  verifyDownloadToken = downloadMod.verifyDownloadToken;
  resolveSafeProjectRelativePath = downloadMod.resolveSafeProjectRelativePath;

  await skillRegistry.loadAll();
});

afterAll(async () => {
  authStore?.close();
  if (originalDataDir === undefined) delete process.env.NOVACUT_DATA_DIR;
  else process.env.NOVACUT_DATA_DIR = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("Acceptance Golden Case #1 · Reel Lanzamiento OECLIP 24s 9:16", () => {
  it("genera 6 actos exactos (720 frames), subtítulos karaoke <=4 palabras, frames Remotion reales, diff > 0% y runTrace", async () => {
    const saved = await store.create("OECLIP Lanzamiento Oficial", {
      ...defaultSettings(),
      aspect: "9:16",
      width: 1080,
      height: 1920,
      fps: { num: 30, den: 1 },
    });

    const result = await runDirectorAgent({
      projectId: saved.project.id,
      request: GOLDEN_CASE1_PROMPT,
      autonomy: "autonomous",
      exportOnComplete: false,
      quality: "high",
      signal: new AbortController().signal,
    });

    // 1. Storyboard de 6 actos y duración exacta 24.0 s
    expect(result.storyboard.length).toBe(6);
    expect(result.storyboard.map((s) => s.durationSec)).toEqual([3, 5, 3, 3, 3, 7]);

    const updated = await store.get(saved.project.id);
    expect(timelineDurationFrames(updated.project)).toBe(720);
    expect(updated.project.settings.width).toBe(1080);
    expect(updated.project.settings.height).toBe(1920);

    // 2. QA report debe aprobar los checks críticos de copy literal, contraste y duración sin fugas de prompt
    const qa = result.qaReport!;
    expect(qa).toBeDefined();
    expect(qa.checks.find((c) => c.name === "duration_match")?.passed).toBe(true);
    expect(qa.checks.find((c) => c.name === "literal_copy_present")?.passed).toBe(true);
    expect(qa.checks.find((c) => c.name === "literal_texts_and_no_placeholders")?.passed).toBe(true);
    expect(qa.visibleTextsByScene.every((s) => !s.usesInternalPlaceholderOnly)).toBe(true);
    expect(qa.checks.find((c) => c.name === "legibility_and_safe_zones")?.passed).toBe(true);
    expect(qa.checks.find((c) => c.name === "visual_rhythm")?.passed).toBe(true);
    expect(qa.checks.find((c) => c.name === "subtitles_sync_and_lines")?.passed).toBe(true);

    const visibleJoined = qa.visibleTextsByScene.flatMap((s) => s.texts).join(" | ");
    for (const requiredLiteral of [
      "¿Tus videos tardan horas?",
      "OECLIP",
      "Estudio de Video con IA",
      "Cortes inteligentes",
      "Motion IA en Remotion",
      "Subtítulos dinámicos",
      "Crea contenido profesional sin plantillas rígidas",
      "Pruébalo ahora en OECLIP",
    ]) {
      expect(visibleJoined).toContain(requiredLiteral);
    }
    expect(visibleJoined).not.toContain("Audio y subtítulos");
    expect(visibleJoined).not.toContain("Estructura obligatoria");

    // 3. Subtítulos karaoke <= 4 palabras por bloque
    const subClips = updated.project.tracks
      .filter((t) => t.kind === "text")
      .flatMap((t) => t.clips)
      .filter((c) => c.type === "text" && (c.role === "subtitle" || c.role === "caption"));
    const captions = subClips.flatMap((c) =>
      Array.isArray(c.remotion?.props?.captions) ? c.remotion!.props!.captions : [],
    ) as Array<{ words?: Array<{ text: string }> }>;
    expect(captions.length).toBeGreaterThan(6);
    for (const cue of captions) {
      expect((cue.words ?? []).length).toBeLessThanOrEqual(4);
    }

    // 4. Frames renderizados realmente por Remotion con cambio visual real entre actos distintos
    const frames = result.frames ?? [];
    expect(frames.length).toBeGreaterThanOrEqual(6);
    expect(frames.every((f) => f.renderSource === "remotion")).toBe(true);
    const diff = await measureFramePairMotionDiffPercent(frames[0]!.path, frames[frames.length - 1]!.path);
    expect(diff).toBeGreaterThan(1);

    // Copiar frames muestra si se solicita inspección visual externa
    const outSaveDir = process.env.SAVE_GOLDEN_FRAMES_DIR;
    if (outSaveDir) {
      await fs.mkdir(outSaveDir, { recursive: true });
      for (const [idx, fr] of [frames[0]!, frames[Math.floor(frames.length / 2)]!, frames[frames.length - 1]!].entries()) {
        await fs.copyFile(fr.path, path.join(outSaveDir, `golden-act-${idx + 1}-${fr.time}s.png`));
      }
    }

    // 5. Traza persistida accesible vía get_run_trace
    const getTrace = getTool("get_run_trace");
    const traceOut = await getTrace.execute(
      {
        projectId: saved.project.id,
        project: updated.project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      {},
    );
    const traceData = (traceOut.data as { trace?: Record<string, unknown> } | undefined)?.trace;
    expect(traceData).toBeDefined();
    expect(traceData?.qaScore).toBe(qa.score);
    expect(Array.isArray(traceData?.phases)).toBe(true);
  }, 90000);

  it("strict=true / allowFallback=false rechaza entrega degradada si ocurre fallback", async () => {
    const saved = await store.create("Strict Mode Rejection", {
      ...defaultSettings(),
      aspect: "9:16",
      width: 1080,
      height: 1920,
    });

    const result = await runDirectorAgent({
      projectId: saved.project.id,
      request: 'Crea reel 9:16 de 12 s. Escena 1 (0-6s): "OECLIP". Escena 2 (6-12s): botón "Pruébalo ahora en OECLIP". Con voz y música.',
      autonomy: "autonomous",
      strict: true,
      allowFallback: false,
      exportOnComplete: false,
      signal: new AbortController().signal,
    });

    if (result.warnings.some((w) => /respaldo|procedural|no hay motor|no utilizado/i.test(w))) {
      expect(result.status).toBe("failed");
    } else {
      expect(["verified", "failed"]).toContain(result.status);
    }
  }, 60000);

  it("tokens de descarga HMAC validan exportación y bloquean traversal", () => {
    const token = createDownloadToken({
      kind: "export",
      projectId: "prj_demo123",
      exportId: "exp_demo456",
      fileName: "reel-oeclip.mp4",
    });
    const verified = verifyDownloadToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.kind).toBe("export");
    expect(verified?.projectId).toBe("prj_demo123");
    expect(verified?.kind === "export" ? verified.exportId : undefined).toBe("exp_demo456");

    expect(resolveSafeProjectRelativePath("D:\\data\\prj_1", "../../etc/passwd")).toBeNull();
    expect(resolveSafeProjectRelativePath("D:\\data\\prj_1", "exports/../../etc/passwd")).toBeNull();
    const safeFile = resolveSafeProjectRelativePath("D:\\data\\prj_1", "exports/final.mp4");
    expect(safeFile).not.toBeNull();
    expect(safeFile!.endsWith(path.join("exports", "final.mp4"))).toBe(true);
  });
});
