import { describe, expect, it } from "vitest";
import type { MediaAsset, MediaClip } from "../src/shared/schema";
import { createProject, defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";
import { buildPlan, detectTextIntent, planFromDraft, type PlanDraft } from "../server/agent/planner";
import { chunkSubtitleText, getTool, toolCatalog, validateToolArgs } from "../server/agent/tools";
import { aiStatus } from "../server/ai/provider";

function asset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: "med_agent00001",
    name: "entrevista.mp4",
    kind: "video",
    file: "media/entrevista.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1000,
    durationUs: 20_000_000,
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    thumbnail: "pending",
    waveform: "pending",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
    ...overrides,
  };
}

function projectWithMedia() {
  const project = createProject("Entrevista", defaultSettings(1920, 1080, 30));
  const video = asset({});
  const audio = asset({
    id: "med_agent00002",
    name: "musica.m4a",
    kind: "audio",
    file: "media/musica.m4a",
    mimeType: "audio/mp4",
    durationUs: 20_000_000,
    width: undefined,
    height: undefined,
    fps: undefined,
  });
  let next = { ...project, media: [video, audio] };
  const videoTrack = next.tracks.find((track) => track.kind === "video")!;
  const audioTrack = next.tracks.find((track) => track.kind === "audio")!;
  const videoResult = addClip(next, videoTrack.id, makeMediaClip(next, video, { startFrame: 0 }) as MediaClip);
  if (!videoResult.ok) throw new Error(videoResult.error);
  next = videoResult.project;
  const audioResult = addClip(next, audioTrack.id, makeMediaClip(next, audio, { startFrame: 0 }) as MediaClip);
  if (!audioResult.ok) throw new Error(audioResult.error);
  return { project: audioResult.project, video, audio };
}

function addSubtitle(project: ReturnType<typeof createProject>) {
  const textTrack = project.tracks.find((track) => track.kind === "text")!;
  const result = addClip(project, textTrack.id, makeTextClip({
    text: "Una frase importante",
    startFrame: 0,
    durationFrames: 60,
    role: "subtitle",
    fontSize: 50,
    sourceMediaId: "med_agent00001",
  }));
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

/** Proyecto vertical con una imagen de 5 s y un texto corto de 0,8 s. */
function projectWithShortText() {
  const project = createProject("Mi nuevo montaje", defaultSettings(1080, 1920, 30));
  const image = asset({
    id: "med_agent00003",
    name: "foto.jpg",
    kind: "image",
    file: "media/foto.jpg",
    mimeType: "image/jpeg",
    durationUs: 5_000_000,
    width: 960,
    height: 1280,
    videoCodec: "mjpeg",
    audioCodec: undefined,
    fps: { num: 25, den: 1 },
  });
  let next = { ...project, media: [image] };
  const videoTrack = next.tracks.find((track) => track.kind === "video")!;
  const textTrack = next.tracks.find((track) => track.kind === "text")!;
  const videoResult = addClip(next, videoTrack.id, makeMediaClip(next, image, { startFrame: 0 }) as MediaClip);
  if (!videoResult.ok) throw new Error(videoResult.error);
  next = videoResult.project;
  const textResult = addClip(
    next,
    textTrack.id,
    makeTextClip({
      text: "Tu risa es mi razón para seguir creyendo",
      startFrame: 0,
      durationFrames: 24,
      role: "title",
    }),
  );
  if (!textResult.ok) throw new Error(textResult.error);
  const textClip = textResult.project.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.type === "text" && clip.text === "Tu risa es mi razón para seguir creyendo");
  if (!textClip) throw new Error("No se creó el texto de prueba");
  return { project: textResult.project, textId: textClip.id };
}

describe("planificador local", () => {
  it("detecta eliminacion de silencios sobre el primer clip visual", async () => {
    const { project } = projectWithMedia();
    const { plan, source } = await buildPlan(project, "Elimina los silencios y las pausas del video", {
      preferLocal: true,
    });
    expect(source).toBe("local");
    expect(plan.steps.map((step) => step.tool)).toContain("remove_silences");
    expect(plan.steps[0]?.args.thresholdDb).toBe(-35);
  });

  it("cambia el formato y anade el titulo entre comillas", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, 'Ponlo en vertical y anade el titulo "Entrevista 2026"', {
      preferLocal: true,
    });
    const aspect = plan.steps.find((step) => step.tool === "change_aspect_ratio");
    const text = plan.steps.find((step) => step.tool === "add_text_overlay");
    expect(aspect?.args.aspect).toBe("9:16");
    expect(text?.args.text).toBe("Entrevista 2026");
    expect(text?.args.role).toBe("title");
  });

  it("baja el volumen del clip de musica existente", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, "Baja el volumen de la musica", { preferLocal: true });
    const audio = plan.steps.find((step) => step.tool === "adjust_audio");
    expect(audio).toBeDefined();
    expect(Number(audio?.args.volume)).toBeLessThan(1);
  });

  it("respeta la resolución y el formato indicados al exportar", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, "Exporta el proyecto en vertical a 720p", { preferLocal: true });
    const render = plan.steps.find((step) => step.tool === "render_export");
    expect(render?.args.resolution).toBe(720);
    expect(render?.args.aspect).toBe("9:16");
  });

  it("exporta con el motor Remotion cuando se pide", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, "Exporta el proyecto con gráficos de Remotion", {
      preferLocal: true,
    });
    const render = plan.steps.find((step) => step.tool === "render_export");
    expect(render?.args.engine).toBe("remotion");
    expect(plan.warnings.join(" ")).not.toContain("Remotion");
  });

  it("exporta con FFmpeg por defecto sin motor Remotion", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, "Exporta el proyecto", { preferLocal: true });
    const render = plan.steps.find((step) => step.tool === "render_export");
    expect(render?.args.engine).toBeUndefined();
  });

  it("no recorta el video cuando se pide no cambiar el encuadre", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan } = await buildPlan(
      project,
      "Reduce un poco el tamaño de los subtítulos, sin cambiar el encuadre del video.",
      { preferLocal: true },
    );
    expect(plan.steps.some((step) => step.tool === "change_subtitle_style")).toBe(true);
    expect(plan.steps.some((step) => step.tool === "set_clip_crop")).toBe(false);
    expect(plan.steps.some((step) => step.tool === "set_clip_transform")).toBe(false);
  });

  it("no recorta el montaje cuando se menciona una posición en segundos", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      'Añade un título a los 5 segundos que diga "Hola"',
      { preferLocal: true },
    );
    expect(plan.steps.some((step) => step.tool === "fit_duration")).toBe(false);
    expect(plan.steps.some((step) => step.tool === "add_text_overlay")).toBe(true);
  });

  it("no aplica zoom cuando se pide evitarlo", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan } = await buildPlan(
      project,
      "reduce el tamaño de los subtítulos, sin zoom",
      { preferLocal: true },
    );
    expect(plan.steps.some((step) => step.tool === "set_clip_zoom_keyframes")).toBe(false);
    expect(plan.steps.some((step) => step.tool === "set_clip_transform")).toBe(false);
  });

  it("recorta a la duración total cuando se pide explícitamente", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, "Déjalo en 10 segundos", { preferLocal: true });
    const fit = plan.steps.find((step) => step.tool === "fit_duration");
    expect(fit?.args.targetSeconds).toBe(10);
  });

  it("rechaza instrucciones sin operacion compatible", async () => {
    const { project } = projectWithMedia();
    await expect(buildPlan(project, "Hazme un cafe con leche", { preferLocal: true })).rejects.toMatchObject({
      code: "intent_not_supported",
    });
  });

  it("bloquea subtitulos si no hay proveedor configurado", async () => {
    if (aiStatus().chat) return;
    const { project } = projectWithMedia();
    await expect(buildPlan(project, "Genera subtitulos automaticos", { preferLocal: true })).rejects.toMatchObject({
      code: "ai_not_configured",
    });
  });

  it("ordena las operaciones de reconstruccion antes de los textos", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      'Selecciona los mejores momentos y anade el titulo "Resumen"',
      { preferLocal: true },
    );
    const tools = plan.steps.map((step) => step.tool);
    expect(tools.indexOf("select_highlights")).toBeGreaterThanOrEqual(0);
    expect(tools.indexOf("add_text_overlay")).toBeGreaterThan(tools.indexOf("select_highlights"));
  });

  it("reduce el tamaño de subtitulos existentes sin aplicar zoom al video", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan, source } = await buildPlan(project, "reducir el tamaño de los subtítulos, más pequeños", {
      preferLocal: false,
    });
    expect(source).toBe("local");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.tool).toBe("change_subtitle_style");
    expect(plan.steps[0]?.args.fontSize).toBe(41);
    expect(plan.steps.some((step) => step.tool.includes("zoom"))).toBe(false);
  });

  it("planifica dividir subtítulos existentes en frases cortas", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan, source } = await buildPlan(
      project,
      "Divide los subtítulos existentes en frases cortas para que no salga todo el texto largo",
      { preferLocal: false },
    );
    expect(source).toBe("local");
    expect(plan.steps.map((step) => step.tool)).toEqual(["split_subtitles_into_phrases"]);
  });

  it("elimina los subtítulos existentes en lugar de regenerarlos", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan, source } = await buildPlan(project, "elimina los subtítulos", { preferLocal: false });
    expect(source).toBe("local");
    expect(plan.steps.map((step) => step.tool)).toEqual(["remove_subtitles"]);
    expect(plan.steps[0]?.args).not.toHaveProperty("mediaId");
    expect(plan.steps[0]?.args).not.toHaveProperty("includeTitles");
  });

  it("incluye los títulos solo cuando se piden explícitamente", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan } = await buildPlan(project, "elimina los subtítulos y los títulos", {
      preferLocal: true,
    });
    expect(plan.steps[0]?.tool).toBe("remove_subtitles");
    expect(plan.steps[0]?.args).toMatchObject({ includeTitles: true });
  });

  it("crea keyframes de zoom localizados en los segundos indicados", async () => {
    const { project } = projectWithMedia();
    const { plan, source } = await buildPlan(
      project,
      "haz zoom a los 5 segundos y 12 segundos",
      { preferLocal: false },
    );
    expect(source).toBe("local");
    const zoom = plan.steps.find((step) => step.tool === "set_clip_zoom_keyframes");
    expect(zoom).toBeDefined();
    expect(plan.steps.some((step) => step.tool === "set_clip_transform")).toBe(false);
    const keyframes = zoom?.args.keyframes as Array<{ frame: number; scale: number }>;
    expect(keyframes.length).toBeGreaterThanOrEqual(8);
    expect(keyframes.some((keyframe) => Math.abs(keyframe.frame - 150) <= 1 && keyframe.scale > 1)).toBe(true);
    expect(keyframes.some((keyframe) => Math.abs(keyframe.frame - 360) <= 1 && keyframe.scale > 1)).toBe(true);
    expect(keyframes[0]?.frame).toBe(0);
    expect(keyframes[keyframes.length - 1]?.scale).toBe(1);
  });

  it("anima el primer subtítulo con duraciones enteras y conserva los demás clips", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const firstSubtitle = project.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.role === "subtitle");
    if (!firstSubtitle || firstSubtitle.type !== "text") throw new Error("Falta clip de subtítulo de prueba.");

    const { plan, source } = await buildPlan(
      project,
      "animar el primer subtitulo que sea mucho mas atractivo y con efectos cinematicos",
      { preferLocal: false },
    );
    expect(source).toBe("local");
    expect(plan.steps.map((step) => step.tool)).toEqual(["set_clip_animation"]);
    expect(plan.steps[0]).toMatchObject({
      tool: "set_clip_animation",
      args: {
        clipId: firstSubtitle.id,
        animationIn: "zoom-in",
        animationInDuration: 12,
        animationOut: "fade-out",
        animationOutDuration: 8,
      },
    });
  });

  it("redondea a fotogramas enteros las duraciones de animación generadas por el modelo", () => {
    const { project } = projectWithMedia();
    const clipId = project.tracks.find((track) => track.kind === "video")!.clips[0]!.id;
    const draft: PlanDraft = {
      summary: "Animar el clip.",
      source: "llm",
      warnings: [],
      steps: [{
        tool: "set_clip_animation",
        title: "Animar clip",
        args: { clipId, animationIn: "zoom-in", animationInDuration: 12.7, animationOutDuration: 7.5 },
        risk: "low",
      }],
    };
    const plan = planFromDraft(draft, project, "anima el clip");
    expect(plan.steps[0]?.args).toMatchObject({
      animationInDuration: 13,
      animationOutDuration: 8,
    });
  });

  it("usa blanco como color base y explica que no admite resaltado por palabra", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan } = await buildPlan(
      project,
      "cambiar el color del texto, algunas palabras resaltantes a rojo y las otras en blanco",
      { preferLocal: false },
    );
    expect(plan.steps[0]?.tool).toBe("change_subtitle_style");
    expect(plan.steps[0]?.args.color).toBe("#FFFFFF");
    expect(plan.warnings.join(" ")).toContain("no admite varios colores dentro de una misma frase");
    expect(plan.steps.some((step) => step.tool.includes("zoom"))).toBe(false);
  });

  it("aplica el color pedido sin confundirlo con un preset de diseño", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan, source } = await buildPlan(
      project,
      "cambiar el color del texto del subtitulo a rojo",
      { preferLocal: false },
    );
    expect(source).toBe("local");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.tool).toBe("change_subtitle_style");
    expect(plan.steps[0]?.args).toMatchObject({ color: "#FF3030" });
    expect(plan.steps.some((step) => step.args.style !== undefined)).toBe(false);
  });

  it.each([
    ["cambiar de color el texto del subtitulo a rojo", "#FF3030"],
    ["cambiar el color de los subtítulos a azul", "#38BDF8"],
    ["poner los subtítulos de color rosa", "#EC4899"],
  ])("interpreta la petición de color «%s» como un ajuste de color", async (instruction, color) => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan, source } = await buildPlan(project, instruction, { preferLocal: false });
    expect(source).toBe("local");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.tool).toBe("change_subtitle_style");
    expect(plan.steps[0]?.args).toMatchObject({ color });
    expect(plan.steps[0]?.args.style).toBeUndefined();
  });

  it.each([
    ["Aplica subtítulos dinámicos estilo CapCut inmobiliario", "real-estate"],
    ["Quiero subtítulos con cada frase resaltada", "phrase-highlight"],
    ["Pon subtítulos dinámicos modernos pop", "clean-pop"],
    ["Aplica subtítulos modernos pop", "clean-pop"],
  ])("detecta el preset de subtítulo «%s»", async (instruction, preset) => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const { plan, source } = await buildPlan(project, instruction, { preferLocal: false });
    expect(source).toBe("local");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "apply_dynamic_subtitle_preset",
      args: { preset },
    });
  });

  it("planifica un motion graphic sin añadir un título duplicado", async () => {
    const { project } = projectWithMedia();
    const { plan, source } = await buildPlan(
      project,
      'Añade un lower third animado con el texto "Ana Pérez · Directora"',
      { preferLocal: false },
    );
    expect(source).toBe("local");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "create_motion_graphic",
      args: { text: "Ana Pérez · Directora", preset: "lower-third" },
    });
  });

  it("respeta el segundo indicado para el motion graphic", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      'Añade un lower third animado en el segundo 8 con el texto "Ana Pérez · Directora"',
      { preferLocal: true },
    );
    expect(plan.steps[0]).toMatchObject({
      tool: "create_motion_graphic",
      args: { text: "Ana Pérez · Directora", preset: "lower-third", startSeconds: 8 },
    });
  });

  it("usa la duración del gráfico sin recortar el montaje", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      'Añade un callout animado con el texto "Nuevo episodio" que dure 6 segundos',
      { preferLocal: true },
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "create_motion_graphic",
      args: { text: "Nuevo episodio", preset: "callout", durationSeconds: 6 },
    });
    expect(plan.steps.some((item) => item.tool === "fit_duration")).toBe(false);
  });

  it("combina un gancho animado con un CTA sin duplicar el texto", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      'Añade un gancho social animado "No te lo pierdas" y un CTA final "Sígueme para más"',
      { preferLocal: true },
    );
    const graphic = plan.steps.find((item) => item.tool === "create_motion_graphic");
    const cta = plan.steps.find((item) => item.tool === "add_text_overlay");
    expect(graphic?.args).toMatchObject({ text: "No te lo pierdas", preset: "social-hook" });
    expect(cta?.args).toMatchObject({ text: "Sígueme para más", position: "lower-third" });
  });

  it("alarga el texto existente hasta igualar la imagen sin pedir una frase nueva", async () => {
    const { project, textId } = projectWithShortText();
    const { plan, source } = await buildPlan(
      project,
      "quiero que alargues el tiempo del texto al igual que el tiempo de la imagen",
      { preferLocal: true },
    );
    expect(source).toBe("local");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "set_clip_timing",
      args: { clipId: textId, durationSeconds: 5 },
    });
    expect(plan.summary).toContain("duración");
  });

  it("acorta el texto existente a los segundos pedidos", async () => {
    const { project, textId } = projectWithShortText();
    const { plan } = await buildPlan(project, "acorta el texto a 2 segundos", { preferLocal: true });
    expect(plan.steps[0]).toMatchObject({
      tool: "set_clip_timing",
      args: { clipId: textId, durationSeconds: 2 },
    });
  });

  it("anima el texto existente en lugar de crear otro", async () => {
    const { project, textId } = projectWithShortText();
    const { plan } = await buildPlan(
      project,
      "ponle al texto una animación de entrada y salida suave",
      { preferLocal: true },
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "set_clip_animation",
      args: { clipId: textId, animationIn: "fade-in", animationOut: "fade-out" },
    });
  });

  it("crea un gráfico de barras con datos de ejemplo editables", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, "quiero que añadas al video graficos estadisticos", {
      preferLocal: true,
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "create_motion_graphic",
      args: { preset: "stat-bars" },
    });
    expect(plan.warnings.join(" ")).toContain("datos de ejemplo");
  });

  it("usa las cifras indicadas en un gráfico de barras", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      "añade un gráfico de barras con datos 42, 58 y 74",
      { preferLocal: true },
    );
    expect(plan.steps[0]?.args).toMatchObject({
      preset: "stat-bars",
      data: [
        { label: "Dato 1", value: 42 },
        { label: "Dato 2", value: 58 },
        { label: "Dato 3", value: 74 },
      ],
    });
  });

  it("planifica un contador animado con valor y unidad", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, "añade un contador animado del 87%", {
      preferLocal: true,
    });
    expect(plan.steps[0]?.args).toMatchObject({
      preset: "stat-counter",
      value: 87,
      unit: "%",
    });
  });

  it("planifica una intro animada como tarjeta de título", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(project, 'añade una intro animada con el título "Temporada 2027"', {
      preferLocal: true,
    });
    expect(plan.steps[0]).toMatchObject({
      tool: "create_motion_graphic",
      args: { preset: "title-card", text: "Temporada 2027" },
    });
  });

  it("calcula el resumen sobre el material aunque el timeline ya esté troceado", async () => {
    const base = createProject("Tendencias", defaultSettings(608, 1080, 30));
    const video = asset({ durationUs: 240_000_000, width: 640, height: 360 });
    let project = { ...base, media: [video] };
    const track = project.tracks.find((item) => item.kind === "video")!;
    // Simula el montaje roto: 40 micro-cortes de 0,5 s (20 s de timeline) sobre
    // un material de 240 s. El objetivo debe salir del material, no del corte.
    project = {
      ...project,
      tracks: project.tracks.map((item) =>
        item.id !== track.id
          ? item
          : {
              ...item,
              clips: Array.from({ length: 40 }, (_, index) =>
                makeMediaClip(project, video, {
                  startFrame: index * 15,
                  sourceInUs: index * 500_000,
                  sourceOutUs: (index + 1) * 500_000,
                }) as MediaClip,
              ),
            },
      ),
    };

    const { plan, source } = await buildPlan(
      project,
      "editar el video con las nuevas tendencias",
      { preferLocal: true },
    );
    expect(source).toBe("local");
    const highlights = plan.steps.find((item) => item.tool === "select_highlights");
    expect(highlights?.args).toMatchObject({ targetSeconds: 45 });
  });

  it("exporta con una resolución válida en vertical", async () => {
    const { project } = projectWithMedia();
    const vertical = {
      ...project,
      settings: { ...project.settings, width: 1080, height: 1920, aspect: "9:16" as const },
    };
    const { plan } = await buildPlan(vertical, "exporta el video", { preferLocal: true });
    expect(plan.steps.find((item) => item.tool === "render_export")?.args).toMatchObject({
      resolution: 1080,
      aspect: "9:16",
    });
  });

  it("pide el texto literal antes de crear un motion graphic", async () => {
    const { project } = projectWithMedia();
    await expect(
      buildPlan(project, "Quiero añadir un lower third animado", { preferLocal: false }),
    ).rejects.toMatchObject({ code: "motion_graphic_text_required" });
  });

  it("genera una sola frase central animada cuando se pide copy", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      "quiero que generes un texto al medio de la imagen con una frase bastante emotiva juvenil y sobre todo profesional",
      { preferLocal: true },
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "create_motion_graphic",
      args: { preset: "kinetic-title", startSeconds: 0 },
    });
    expect(String(plan.steps[0]?.args.text).length).toBeGreaterThan(10);
    const tools = plan.steps.map((step) => step.tool);
    expect(tools).not.toContain("change_aspect_ratio");
    expect(tools).not.toContain("enhance_voice");
    expect(tools).not.toContain("generate_subtitles");
    expect(tools).not.toContain("render_export");
  });

  it("no convierte «profesional» describiendo un texto en una edición genérica", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      "Añade una frase profesional al centro",
      { preferLocal: true },
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.tool).toBe("create_motion_graphic");
    expect(plan.steps.some((step) => step.tool === "render_export")).toBe(false);
  });

  it("mantiene el texto literal como overlay si no se pide animación", async () => {
    const { project } = projectWithMedia();
    const { plan } = await buildPlan(
      project,
      'Añade un texto al centro que diga "Hola mundo"',
      { preferLocal: true },
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "add_text_overlay",
      args: { text: "Hola mundo", position: "center" },
    });
  });

  it("detecta intención, posición y tono en una petición de texto", () => {
    const intent = detectTextIntent("genera una frase emotiva y profesional arriba");
    expect(intent).toMatchObject({
      wantsText: true,
      generateCopy: true,
      position: "top",
      motion: false,
    });
    expect(intent.tones).toEqual(expect.arrayContaining(["emotiva", "profesional"]));
  });
});

describe("registro de herramientas", () => {
  it("agrupa los subtítulos en frases de hasta cuatro palabras y respeta puntuación", () => {
    const chunks = chunkSubtitleText("Bienvenidos a esta hermosa casa. Tiene cuatro habitaciones y jardín.");
    expect(chunks).toEqual(["Bienvenidos a esta", "hermosa casa.", "Tiene cuatro habitaciones", "y jardín."]);
    expect(chunks.every((chunk) => chunk.split(/\s+/).length <= 4)).toBe(true);
  });

  it("expone solo herramientas conocidas", () => {
    const catalog = toolCatalog();
    expect(catalog).toContain("remove_silences");
    expect(catalog).toContain("create_motion_graphic");
    expect(catalog).toContain("render_export");
    expect(() => getTool("run_shell")).toThrowError(/Herramienta desconocida/);
  });

  it("valida los argumentos antes de ejecutar", () => {
    const invalid = validateToolArgs("trim_clip", { clipId: "clp_test" });
    expect(invalid.ok).toBe(false);
    const valid = validateToolArgs("trim_clip", { clipId: "clp_test", trimStartSeconds: 1 });
    expect(valid.ok).toBe(true);
  });

  it("valida los cambios de tamaño y color de subtítulos", () => {
    expect(validateToolArgs("change_subtitle_style", { fontSize: 36, color: "#FFFFFF" }).ok).toBe(true);
    expect(validateToolArgs("change_subtitle_style", { color: "red" }).ok).toBe(false);
  });

  it("aplica tamaño y color a los subtítulos existentes", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const result = await getTool("change_subtitle_style").execute(
      {
        projectId: project.id,
        project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      { fontSize: 36, color: "#ff3030" },
    );
    const updated = result.project?.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.role === "subtitle");
    expect(updated).toMatchObject({ fontSize: 36, color: "#FF3030" });
  });

  it("aplica el estilo Moderno con Space Grotesk a subtítulos existentes", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const result = await getTool("change_subtitle_style").execute(
      {
        projectId: project.id,
        project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      { style: "modern" },
    );
    const updated = result.project?.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.role === "subtitle");
    expect(updated).toMatchObject({ fontFamily: "space-grotesk", color: "#FFFFFF", fontWeight: 700 });
  });

  it("aplica subtítulos Real Estate conservando texto y sincronización", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const originalClip = project.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.role === "subtitle");
    if (!originalClip || originalClip.type !== "text") throw new Error("Falta clip de subtítulo de prueba.");
    const result = await getTool("apply_dynamic_subtitle_preset").execute(
      {
        projectId: project.id,
        project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      { preset: "real-estate" },
    );
    const updated = result.project?.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.id === originalClip.id);
    expect(updated).toMatchObject({
      text: originalClip.text,
      startFrame: originalClip.startFrame,
      durationFrames: originalClip.durationFrames,
      fontFamily: "anton",
      fontSize: 70,
      animationIn: "bounce-in",
      animationOut: "fade-out",
    });
  });

  it("divide cues largos sin perder texto ni cambiar su duración total", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const textTrack = project.tracks.find((track) => track.kind === "text")!;
    const longCue = makeTextClip({
      text: "Bienvenidos a esta hermosa propiedad con cuatro habitaciones y un amplio jardín",
      startFrame: 90,
      durationFrames: 120,
      role: "subtitle",
      sourceMediaId: "med_agent00001",
    });
    const withLongCue = addClip(project, textTrack.id, longCue);
    if (!withLongCue.ok) throw new Error(withLongCue.error);
    const result = await getTool("split_subtitles_into_phrases").execute(
      {
        projectId: project.id,
        project: withLongCue.project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      {},
    );
    const phrases = result.project?.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .filter((clip) => clip.type === "text" && clip.startFrame >= 90 && clip.startFrame < 210)
      .sort((a, b) => a.startFrame - b.startFrame);
    expect(phrases?.length).toBeGreaterThan(1);
    expect(phrases?.every((clip) => clip.type === "text" && clip.text.split(/\s+/).length <= 4)).toBe(true);
    expect(phrases?.map((clip) => clip.type === "text" ? clip.text : "").join(" ")).toBe(longCue.text);
    expect(phrases?.reduce((sum, clip) => sum + clip.durationFrames, 0)).toBe(longCue.durationFrames);
  });

  it("no crea cues ilegibles de pocos fotogramas", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const textTrack = project.tracks.find((track) => track.kind === "text")!;
    const longCue = makeTextClip({
      text: "Bienvenidos a esta propiedad con cuatro habitaciones y un jardín amplio",
      startFrame: 90,
      durationFrames: 120,
      role: "subtitle",
      sourceMediaId: "med_agent00001",
    });
    const withLong = addClip(project, textTrack.id, longCue);
    if (!withLong.ok) throw new Error(withLong.error);
    const tinyCue = makeTextClip({
      text: "un momento de que nos ha dado un momento de que nos ha dado",
      startFrame: 300,
      durationFrames: 20,
      role: "subtitle",
      sourceMediaId: "med_agent00001",
    });
    const withTiny = addClip(withLong.project, textTrack.id, tinyCue);
    if (!withTiny.ok) throw new Error(withTiny.error);
    const result = await getTool("split_subtitles_into_phrases").execute(
      {
        projectId: project.id,
        project: withTiny.project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      {},
    );
    const cues = result.project?.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .filter((clip) => clip.type === "text" && clip.startFrame >= 300)
      .sort((a, b) => a.startFrame - b.startFrame);
    expect(cues?.length).toBe(1);
    expect(cues?.[0]).toMatchObject({ startFrame: 300, durationFrames: 20 });
  });

  it("borra los subtítulos y conserva los títulos", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const textTrack = project.tracks.find((track) => track.kind === "text")!;
    const title = makeTextClip({
      text: "Título principal",
      startFrame: 0,
      durationFrames: 60,
      role: "title",
    });
    const withTitle = addClip(project, textTrack.id, title);
    if (!withTitle.ok) throw new Error(withTitle.error);
    const context = {
      projectId: project.id,
      project: withTitle.project,
      signal: new AbortController().signal,
      setProgress: () => undefined,
    };
    const result = await getTool("remove_subtitles").execute(context, {});
    expect(result.data).toMatchObject({ removed: 1 });
    const clips = result.project!.tracks.flatMap((track) => track.clips);
    expect(clips.some((clip) => clip.type === "text" && clip.role === "subtitle")).toBe(false);
    expect(clips.some((clip) => clip.type === "text" && clip.role === "title")).toBe(true);
    await expect(
      getTool("remove_subtitles").execute({ ...context, project: result.project! }, {}),
    ).rejects.toMatchObject({ code: "no_subtitles" });
  });

  it("aplica un paquete social con formato, subtítulos animados y textos exactos", async () => {
    const { project: base } = projectWithMedia();
    const project = addSubtitle(base);
    const result = await getTool("apply_social_preset").execute(
      {
        projectId: project.id,
        project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      { preset: "creator", hookText: "Mira este resultado", ctaText: "Sígueme para más" },
    );
    const updatedProject = result.project!;
    const subtitle = updatedProject.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.role === "subtitle");
    const overlays = updatedProject.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .filter((clip) => clip.type === "text" && clip.createdBy === "agent");
    expect(updatedProject.settings.aspect).toBe("9:16");
    expect(subtitle).toMatchObject({ animationIn: "bounce-in", animationOut: "fade-out" });
    expect(overlays.map((clip) => clip.type === "text" ? clip.text : "")).toEqual([
      "Mira este resultado",
      "Sígueme para más",
    ]);
  });

  it("crea un lower third animado usando la capa de texto nativa", async () => {
    const { project } = projectWithMedia();
    const result = await getTool("create_motion_graphic").execute(
      {
        projectId: project.id,
        project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      {
        text: "Ana Pérez · Directora",
        preset: "lower-third",
        startSeconds: 2,
        durationSeconds: 4,
      },
    );
    const graphic = result.project?.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.text === "Ana Pérez · Directora");
    expect(graphic).toMatchObject({
      type: "text",
      role: "title",
      fontFamily: "inter",
      animationIn: "slide-left",
      animationOut: "fade-out",
      startFrame: 60,
      durationFrames: 120,
    });
  });

  it("crea un gráfico de barras animado con datos en el clip de texto", async () => {
    const { project } = projectWithMedia();
    const result = await getTool("create_motion_graphic").execute(
      {
        projectId: project.id,
        project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      {
        text: "Ventas por mes",
        preset: "stat-bars",
        durationSeconds: 5,
        data: [
          { label: "Ene", value: 42 },
          { label: "Feb", value: 58 },
          { label: "Mar", value: 74 },
        ],
      },
    );
    const graphic = result.project?.tracks
      .filter((track) => track.kind === "text")
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === "text" && clip.text === "Ventas por mes");
    expect(graphic).toMatchObject({
      type: "text",
      durationFrames: 150,
      graphic: {
        kind: "bars",
        title: "Ventas por mes",
        items: [
          { label: "Ene", value: 42 },
          { label: "Feb", value: 58 },
          { label: "Mar", value: 74 },
        ],
      },
    });
  });

  it("actualiza la duración del texto existente con set_clip_timing", async () => {
    const { project, textId } = projectWithShortText();
    const result = await getTool("set_clip_timing").execute(
      {
        projectId: project.id,
        project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      { clipId: textId, durationSeconds: 5 },
    );
    const updated = result.project?.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === textId);
    expect(updated).toMatchObject({ durationFrames: 150, startFrame: 0 });
  });

  it("recorta el inicio y final de un clip de video con trim_clip", async () => {
    const { project } = projectWithMedia();
    const videoTrack = project.tracks.find((t) => t.kind === "video")!;
    const clip = videoTrack.clips[0]!;
    const result = await getTool("trim_clip").execute(
      { projectId: project.id, project, signal: new AbortController().signal, setProgress: () => undefined },
      { clipId: clip.id, trimStartSeconds: 1, trimEndSeconds: 0.5 },
    );
    expect(result.project).toBeDefined();
    const updated = result.project!.tracks
      .flatMap((track) => track.clips)
      .find((c) => c.id === clip.id);
    expect(updated).toBeDefined();
    expect(updated!.startFrame).toBeGreaterThan(clip.startFrame);
    expect(updated!.durationFrames).toBeLessThan(clip.durationFrames);
  });

  it("divide un clip de video en dos con split_clip", async () => {
    const { project } = projectWithMedia();
    const videoTrack = project.tracks.find((t) => t.kind === "video")!;
    const clip = videoTrack.clips[0]!;
    const result = await getTool("split_clip").execute(
      { projectId: project.id, project, signal: new AbortController().signal, setProgress: () => undefined },
      { clipId: clip.id, atSeconds: 1 },
    );
    expect(result.project).toBeDefined();
    const data = result.data as { leftId: string; rightId: string };
    expect(data.leftId).toBeDefined();
    expect(data.rightId).toBeDefined();
    const projectResult = result.project!;
    const track = projectResult.tracks.find((t) => t.kind === "video")!;
    const clips = track.clips.filter((c) => c.id === data.leftId || c.id === data.rightId);
    expect(clips).toHaveLength(2);
  });

  it("aplica fade crossfade entre clips con set_clip_fade", async () => {
    const { project } = projectWithMedia();
    const videoTrack = project.tracks.find((t) => t.kind === "video")!;
    const clipA = videoTrack.clips[0]!;
    const clipB = videoTrack.clips[1]!;
    const result = await getTool("set_clip_fade").execute(
      { projectId: project.id, project, signal: new AbortController().signal, setProgress: () => undefined },
      { clipId: clipA.id, fadeOutFrames: 15, transitionType: "crossfade" },
    );
    expect(result.project).toBeDefined();
    const updated = result.project!.tracks
      .flatMap((track) => track.clips)
      .find((c) => c.id === clipA.id);
    expect(updated).toMatchObject({ fadeOutFrames: 15, transitionType: "crossfade" });
  });
});
