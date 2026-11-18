import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaAsset, MediaClip, Project } from "../src/shared/schema";
import { createProject, defaultSettings, makeMediaClip, timelineDurationFrames } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";

let tempDir = "";
let originalDataDir: string | undefined;

let store: typeof import("../server/projects/store").projectStore;
let authStore: typeof import("../server/auth/store").userStore;
let getTool: typeof import("../server/agent/tools").getTool;
let normalizeToolResponse: typeof import("../server/agent/tools").normalizeToolResponse;
let computeSafeRemotionConcurrency: typeof import("../server/media/remotion").computeSafeRemotionConcurrency;
let isStructuralSceneLabel: typeof import("../server/agent/autonomousEditorBrain").isStructuralSceneLabel;
let extractAllLiteralSceneCopy: typeof import("../server/agent/autonomousEditorBrain").extractAllLiteralSceneCopy;
let runDirectorAgent: typeof import("../server/agent/directorAgent").runDirectorAgent;
let skillRegistry: typeof import("../server/skills/registry").skillRegistry;

beforeAll(async () => {
  originalDataDir = process.env.NOVACUT_DATA_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-pmv2-"));
  process.env.NOVACUT_DATA_DIR = tempDir;

  const storeMod = await import("../server/projects/store");
  const authMod = await import("../server/auth/store");
  const toolsMod = await import("../server/agent/tools");
  const remotionMod = await import("../server/media/remotion");
  const brainMod = await import("../server/agent/autonomousEditorBrain");
  const directorMod = await import("../server/agent/directorAgent");
  const skillsMod = await import("../server/skills/registry");

  store = storeMod.projectStore;
  authStore = authMod.userStore;
  getTool = toolsMod.getTool;
  normalizeToolResponse = toolsMod.normalizeToolResponse;
  computeSafeRemotionConcurrency = remotionMod.computeSafeRemotionConcurrency;
  isStructuralSceneLabel = brainMod.isStructuralSceneLabel;
  extractAllLiteralSceneCopy = brainMod.extractAllLiteralSceneCopy;
  runDirectorAgent = directorMod.runDirectorAgent;
  skillRegistry = skillsMod.skillRegistry;
  await skillRegistry.loadAll();
});

afterAll(async () => {
  await fs.rm(path.join(process.cwd(), "skills", "test-tmp-skill-v2"), { recursive: true, force: true }).catch(() => undefined);
  await skillRegistry?.loadAll().catch(() => undefined);
  authStore?.close();
  if (originalDataDir === undefined) delete process.env.NOVACUT_DATA_DIR;
  else process.env.NOVACUT_DATA_DIR = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

async function runToolOnProject(projectId: string, name: string, args: Record<string, unknown> = {}) {
  const def = getTool(name);
  if (!def) throw new Error(`Herramienta no registrada: ${name}`);
  const bundle = await store.get(projectId);
  const controller = new AbortController();
  const res = await def.execute(
    {
      projectId,
      project: bundle.project,
      signal: controller.signal,
      setProgress: () => undefined,
    },
    args,
  );
  let rev = bundle.project.revision;
  if (res.project) {
    const saved = await store.saveTimeline(projectId, res.project, { force: true });
    rev = saved.project.revision;
  } else if (
    res.data &&
    typeof res.data === "object" &&
    "revision" in res.data &&
    typeof (res.data as { revision?: unknown }).revision === "number"
  ) {
    rev = (res.data as { revision: number }).revision;
  }
  return normalizeToolResponse(name, res, rev);
}

describe("PROMPT MAESTRO v2 · P0..P2 & Golden Suite Case #1", () => {
  it("F3: computeSafeRemotionConcurrency nunca excede cpuCores ni el límite de memoria (2, 4, 5, 16 núcleos)", () => {
    const host5 = computeSafeRemotionConcurrency({ requested: 8, cpuCores: 5, freeMemBytes: 16 * 1024 ** 3 });
    expect(host5.concurrency).toBeLessThanOrEqual(5);
    expect(host5.clamped).toBe(true);
    expect(host5.warning).toBeTruthy();

    const host2 = computeSafeRemotionConcurrency({ requested: 4, cpuCores: 2, freeMemBytes: 8 * 1024 ** 3 });
    expect(host2.concurrency).toBe(2);
    expect(host2.clamped).toBe(true);

    const host4 = computeSafeRemotionConcurrency({ requested: 4, cpuCores: 4, freeMemBytes: 8 * 1024 ** 3 });
    expect(host4.concurrency).toBe(4);
    expect(host4.clamped).toBe(false);

    const host16LowMem = computeSafeRemotionConcurrency({ requested: 12, cpuCores: 16, freeMemBytes: 1.5 * 1024 ** 3 });
    expect(host16LowMem.concurrency).toBeLessThanOrEqual(4);
    expect(host16LowMem.clamped).toBe(true);
  });

  it("F1: evita labels estructurales en pantalla, extrae copy literal/CTA y marca fallback procedural sin éxito silencioso", async () => {
    expect(isStructuralSceneLabel("Escena 1 · Gancho")).toBe(true);
    expect(isStructuralSceneLabel("Escena 2 · Demo")).toBe(true);
    expect(isStructuralSceneLabel("OECLIP · Estudio de Video con IA")).toBe(false);

    const extracted = extractAllLiteralSceneCopy(
      'Fondo azul marino con título "OECLIP · Estudio de Video con IA", bajada "Crea contenido profesional sin plantillas rígidas" y botón CTA "Pruébalo ahora en OECLIP".',
      "Escena 3 · Cierre",
    );
    expect(extracted.allLiterals).toContain("OECLIP · Estudio de Video con IA");
    expect(extracted.allLiterals).toContain("Crea contenido profesional sin plantillas rígidas");
    expect(extracted.ctaText).toBe("Pruébalo ahora en OECLIP");

    const bundle = await store.create("Test F1 Motion", defaultSettings(1080, 1920, 30));
    const motion = await runToolOnProject(bundle.project.id, "execute_custom_motion", {
      prompt:
        'Cierre corporativo elegante: "Crea contenido profesional sin plantillas rígidas" y botón CTA "Pruébalo ahora en OECLIP".',
      title: "Escena 3 · Cierre",
      startSeconds: 0,
      durationSeconds: 6,
      transparent: false,
    });

    expect(motion.ok).toBe(true);
    // Sin LLM externo debe reportar fallback explícitamente y nunca esconderlo
    expect(["fallback", "verified"]).toContain(motion.status);

    const after = await store.get(bundle.project.id);
    const clip = after.project.tracks.flatMap((t) => t.clips).find((c): c is MediaClip => c.type !== "text" && Boolean(c.remotion));
    expect(clip).toBeDefined();
    expect(clip!.remotion!.code).not.toContain("Escena 3 · Cierre");
    expect(JSON.stringify(clip!.remotion!.props)).not.toContain("Escena 3 · Cierre");
    expect(clip!.remotion!.code).toContain("Pruébalo ahora en OECLIP");

    // F2: inspect_media funciona sobre el asset virtual de Remotion
    const virtualInspect = await runToolOnProject(bundle.project.id, "inspect_media", {
      mediaId: clip!.mediaId,
    });
    expect(virtualInspect.ok).toBe(true);
    expect((virtualInspect.data as { virtual?: boolean }).virtual).toBe(true);
  });

  it("F2, F4, F5-F7 & Section 6: percepción real, audio/brand-kit, historial undo/redo, rename y aviso F7 640x360", async () => {
    const bundle = await store.create("Proyecto Original", defaultSettings(1920, 1080, 30));
    const id = bundle.project.id;

    // Rename & summary
    const renamed = await runToolOnProject(id, "rename_project", { name: "Reel Producto Renamed" });
    expect(renamed.ok).toBe(true);
    expect((await store.get(id)).project.name).toBe("Reel Producto Renamed");

    // Capabilities
    const caps = await runToolOnProject(id, "get_capabilities", {});
    expect(caps.ok).toBe(true);
    expect((caps.data as { skillsCount?: number }).skillsCount).toBeGreaterThanOrEqual(15);

    // Brand Kit
    await runToolOnProject(id, "set_brand_kit", {
      brandName: "OECLIP",
      primaryColor: "#0F172A",
      accentColor: "#22D3EE",
      tone: "corporativo tech",
    });
    const bk = await runToolOnProject(id, "get_brand_kit", {});
    expect((bk.data as { brandName?: string }).brandName).toBe("OECLIP");

    // Checkpoint + Undo + Redo
    const cp = await runToolOnProject(id, "checkpoint", { label: "Estado Base" });
    expect(cp.ok).toBe(true);
    await runToolOnProject(id, "change_aspect_ratio", { aspect: "9:16" });
    expect((await store.get(id)).project.settings.aspect).toBe("9:16");

    const undone = await runToolOnProject(id, "undo", {});
    expect(undone.ok).toBe(true);
    expect((await store.get(id)).project.settings.aspect).toBe("16:9");

    const redone = await runToolOnProject(id, "redo", {});
    expect(redone.ok).toBe(true);
    expect((await store.get(id)).project.settings.aspect).toBe("9:16");

    // Audio tools (F4)
    const tts = await runToolOnProject(id, "synthesize_voiceover", {
      text: "Descubre OECLIP, tu estudio de video con IA.",
      language: "es",
      startSeconds: 0,
      addSubtitles: true,
    });
    expect(tts.ok).toBe(true);
    expect(["fallback", "verified"]).toContain(tts.status);

    const music = await runToolOnProject(id, "add_background_music", {
      mood: "tech",
      durationSeconds: 6,
    });
    expect(music.ok).toBe(true);

    const sfx = await runToolOnProject(id, "add_sound_effect", {
      type: "whoosh",
      startSeconds: 1,
      volume: 0.35,
    });
    expect(sfx.ok).toBe(true);

    const summary = await runToolOnProject(id, "get_timeline_summary", {});
    const summaryTracks = (summary.data as { tracks?: Array<{ clips: unknown[] }> }).tracks ?? [];
    const totalClips = summaryTracks.reduce((acc, t) => acc + t.clips.length, 0);
    expect(totalClips).toBeGreaterThan(0);

    // F7: aviso de baja resolución (640x360 en proyecto 1080p)
    const lowBundle = await store.create("LowRes Project", defaultSettings(1080, 1920, 30));
    const lowAsset: MediaAsset = {
      id: "med_lowres360",
      name: "video2677177610.mp4",
      kind: "video",
      file: "media/video2677177610.mp4",
      mimeType: "video/mp4",
      sizeBytes: 120_000,
      durationUs: 10_000_000,
      width: 640,
      height: 360,
      fps: { num: 30, den: 1 },
      videoCodec: "h264",
      audioCodec: "aac",
      thumbnail: "pending",
      waveform: "pending",
      proxy: "none",
      importedAt: new Date().toISOString(),
      origin: "import",
    };
    const lowProj = { ...lowBundle.project, media: [lowAsset] };
    const lowV1 = lowProj.tracks.find((t) => t.kind === "video")!;
    const addedLow = addClip(lowProj, lowV1.id, makeMediaClip(lowProj, lowAsset, { startFrame: 0 }));
    if (!addedLow.ok) throw new Error(addedLow.error);
    await store.saveTimeline(lowBundle.project.id, addedLow.project, { force: true });

    const aspectWarn = await runToolOnProject(lowBundle.project.id, "change_aspect_ratio", { aspect: "9:16" });
    expect(aspectWarn.warnings.some((w) => w.includes("640x360"))).toBe(true);
  }, 30_000);

  it("F8: skills progresivas (15 skills iniciales + get_skill + create_skill)", async () => {
    const bundle = await store.create("Test Skills", defaultSettings(1080, 1920, 30));
    const listed = await runToolOnProject(bundle.project.id, "list_skills", {});
    expect(listed.ok).toBe(true);
    const skillsArr = Array.isArray(listed.data)
      ? (listed.data as Array<{ id: string }>)
      : ((listed.data as { skills?: Array<{ id: string }> }).skills ?? []);
    expect(skillsArr.length).toBeGreaterThanOrEqual(15);
    expect(skillsArr.map((s) => s.id)).toContain("reel-corporativo");
    expect(skillsArr.map((s) => s.id)).toContain("qa-visual");

    const fullSkill = await runToolOnProject(bundle.project.id, "get_skill", { id: "reel-corporativo" });
    expect(fullSkill.ok).toBe(true);
    expect((fullSkill.data as { instructionsMarkdown?: string }).instructionsMarkdown).toContain("Reel Corporativo");

    const created = await runToolOnProject(bundle.project.id, "create_skill", {
      id: "test-tmp-skill-v2",
      name: "Skill Temporal QA",
      description: "Skill temporal de prueba para validar persistencia SKILL.md.",
      instructionsMarkdown: "# Skill Temporal\n1. Paso uno.\n2. Verificar con qa_report.",
      version: "1.0.1",
      kind: "recipe",
      category: "testing",
      triggers: ["tmp test"],
      dependencies: ["qa-visual"],
      overwrite: true,
    });
    expect(created.ok).toBe(true);
  });

  it("Golden Suite Case #1: Agente Director crea el reel 9:16 de 18 s de lanzamiento OECLIP con copy literal, voz, música, subtítulos y QA visual real", async () => {
    const bundle = await store.create("Reel Lanzamiento OECLIP", defaultSettings(1080, 1920, 30));
    const controller = new AbortController();

    const prompt =
      'Crea un reel vertical 9:16 de 18 s estilo corporativo tecnológico para el lanzamiento oficial de OECLIP con voz, música y subtítulos dinámicos sincronizados. ' +
      'Escena 1 (0-6 s), gancho: fondo azul marino con red neuronal en cian y azul, logotipo "OECLIP · Estudio de Video con IA" y el mensaje "Transforma ideas y grabaciones en videos listos para redes en segundos". ' +
      'Escena 2 (6-12 s), demo: línea de tiempo simulada con cortes inteligentes, capas de diseño en movimiento (Remotion) y subtítulos tipo karaoke sincronizados con onda de voz. ' +
      'Escena 3 (12-18 s), cierre: "Crea contenido profesional sin plantillas rígidas", logo y un botón con "Pruébalo ahora en OECLIP".';

    const result = await runDirectorAgent({
      projectId: bundle.project.id,
      request: prompt,
      autonomy: "autonomous",
      exportOnComplete: false,
      signal: controller.signal,
    });

    expect(["verified", "fallback"]).toContain(result.status);
    expect(result.storyboard).toHaveLength(3);
    expect(result.qaReport).toBeDefined();
    expect(result.qaReport!.passed).toBe(true);
    expect(result.frames && result.frames.length).toBeGreaterThanOrEqual(3);
    expect(result.contactSheetPath).toBeTruthy();

    // Evidencia física en disco de fotogramas y contact sheet
    await expect(fs.access(result.contactSheetPath!)).resolves.toBeUndefined();
    await expect(fs.access(result.frames![0]!.path)).resolves.toBeUndefined();

    const finalProject = (await store.get(bundle.project.id)).project;
    expect(finalProject.settings.aspect).toBe("9:16");
    expect(finalProject.settings.width).toBe(1080);
    expect(finalProject.settings.height).toBe(1920);
    expect(timelineDurationFrames(finalProject)).toBeGreaterThanOrEqual(537);
    expect(timelineDurationFrames(finalProject)).toBeLessThanOrEqual(543);

    // Todos los textos literales exigidos deben estar presentes y cero labels internos ("Escena 1 · Gancho", etc.)
    const videoClips = finalProject.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
    expect(videoClips.length).toBeGreaterThanOrEqual(3);

    const renderedCodesAndProps = videoClips
      .filter((c): c is MediaClip => c.type !== "text")
      .map((c) => `${c.remotion?.code ?? ""}\n${JSON.stringify(c.remotion?.props ?? {})}`)
      .join("\n");

    expect(renderedCodesAndProps).toContain("OECLIP · Estudio de Video con IA");
    expect(renderedCodesAndProps).toContain("Transforma ideas y grabaciones en videos listos para redes en segundos");
    expect(renderedCodesAndProps).toContain("Crea contenido profesional sin plantillas rígidas");
    expect(renderedCodesAndProps).toContain("Pruébalo ahora en OECLIP");
    expect(renderedCodesAndProps).not.toContain("Escena 1 · Gancho");
    expect(renderedCodesAndProps).not.toContain("Escena 2 · Demo");
    expect(renderedCodesAndProps).not.toContain("Escena 3 · Cierre");

    // Audio (voz + música) y subtítulos presentes
    const audioClips = finalProject.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
    const textClips = finalProject.tracks.filter((t) => t.kind === "text").flatMap((t) => t.clips);
    expect(audioClips.length).toBeGreaterThanOrEqual(2);
    expect(textClips.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
