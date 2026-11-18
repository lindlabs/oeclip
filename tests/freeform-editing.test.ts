import { describe, expect, it } from "vitest";
import { createProject, defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import { addClip, timelineDurationFrames } from "../src/shared/timeline";
import { buildHyperFrameCinematicLook } from "../src/shared/hyperframes";
import type { MediaAsset, MediaClip } from "../src/shared/schema";
import {
  buildPolymorphicProceduralSceneCode,
  computeEditorialBudget,
  deriveAdaptiveScenesFromTranscriptAndPrompt,
  enforceEditorialRestraint,
  executeSurgicalTimelineTools,
  extractExplicitPromptTitles,
  isConversationalInstructionText,
  parseUserEditingConstraints,
  planAutonomousEditDirective,
  resolveContextualOverlayCopy,
  stripEditingMetaInstructions,
  verifyRemotionComponentTsx,
} from "../server/agent/autonomousEditorBrain";
import { getTool } from "../server/agent/tools";
import { buildPlan } from "../server/agent/planner";

function makeRealVideoAsset(durationUs = 30_000_000): MediaAsset {
  return {
    id: "med_real_video",
    name: "presentador.mp4",
    kind: "video",
    file: "media/presentador.mp4",
    mimeType: "video/mp4",
    sizeBytes: 2_048_000,
    durationUs,
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    thumbnail: "ready",
    waveform: "none",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
  };
}

function makeRealAudioAsset(durationUs = 30_000_000): MediaAsset {
  return {
    id: "med_real_audio",
    name: "voz.wav",
    kind: "audio",
    file: "media/voz.wav",
    mimeType: "audio/wav",
    sizeBytes: 512_000,
    durationUs,
    audioCodec: "pcm_s16le",
    sampleRate: 48000,
    channels: 1,
    thumbnail: "ready",
    waveform: "none",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
  };
}

function buildSampleProjectWithFootage(durationSec = 30) {
  let project = createProject("Edición Libre", defaultSettings(1920, 1080, 30));
  const durationUs = durationSec * 1_000_000;
  const videoAsset = makeRealVideoAsset(durationUs);
  const audioAsset = makeRealAudioAsset(durationUs);
  project = { ...project, media: [videoAsset, audioAsset] };

  const vTrack = project.tracks.find((t) => t.kind === "video")!;
  const aTrack = project.tracks.find((t) => t.kind === "audio")!;
  const tTrack = project.tracks.find((t) => t.kind === "text")!;

  const vRes = addClip(project, vTrack.id, makeMediaClip(project, videoAsset, { startFrame: 0 }));
  if (!vRes.ok) throw new Error(vRes.error);
  project = vRes.project;

  const aRes = addClip(project, aTrack.id, makeMediaClip(project, audioAsset, { startFrame: 0 }));
  if (!aRes.ok) throw new Error(aRes.error);
  project = aRes.project;

  const tRes = addClip(
    project,
    tTrack.id,
    makeTextClip({ text: "Título continuo", startFrame: 0, durationFrames: durationSec * 30 }),
  );
  if (!tRes.ok) throw new Error(tRes.error);
  project = tRes.project;

  return { project, videoClipId: vTrack.clips[0]?.id ?? project.tracks.find((t) => t.kind === "video")!.clips[0]!.id };
}

describe("edición autónoma libre sin plantillas ni presets rígidos", () => {
  it("parseUserEditingConstraints detecta restricciones negativas, cortes temporales y tinte hexadecimal", () => {
    const parsed = parseUserEditingConstraints(
      "Edita con look verde Matrix #10B981, corta del segundo 4 al 8.5, quita los últimos 2s, sin cortar silencios, sin subtítulos, sin zooms, sin gráficos, sin música, sin efectos de sonido y sin barras negras",
    );
    expect(parsed.noSilenceCut).toBe(true);
    expect(parsed.noSubs).toBe(true);
    expect(parsed.noZooms).toBe(true);
    expect(parsed.noGraphics).toBe(true);
    expect(parsed.noMusic).toBe(true);
    expect(parsed.noSfx).toBe(true);
    expect(parsed.noLetterbox).toBe(true);
    expect(parsed.noColorFilter).toBe(false);
    expect(parsed.customTintHex).toBe("#10B981");
    expect(parsed.trimEndSeconds).toBe(2);
    expect(parsed.cutRanges).toEqual([{ startSeconds: 4, endSeconds: 8.5 }]);
  });

  it("cut_time_range y keep_time_ranges cortan y conservan intervalos exactos sincronizando vídeo, audio y texto", async () => {
    const { project } = buildSampleProjectWithFootage(30);
    expect(timelineDurationFrames(project)).toBe(900);

    const cutTool = getTool("cut_time_range");
    const cutRes = await cutTool.execute(
      { projectId: project.id, project, signal: new AbortController().signal, setProgress: () => undefined },
      { startSeconds: 5, endSeconds: 10, ripple: true },
    );
    expect(cutRes.project).toBeDefined();
    const afterCut = cutRes.project!;
    expect(timelineDurationFrames(afterCut)).toBe(750);
    const vClips = afterCut.tracks.find((t) => t.kind === "video")!.clips as MediaClip[];
    expect(vClips).toHaveLength(2);
    expect(vClips[0]!.durationFrames).toBe(150);
    expect(vClips[1]!.startFrame).toBe(150);
    expect(vClips[1]!.sourceInUs).toBe(10_000_000);

    const keepTool = getTool("keep_time_ranges");
    const keepRes = await keepTool.execute(
      { projectId: project.id, project: afterCut, signal: new AbortController().signal, setProgress: () => undefined },
      {
        ranges: [
          { startSeconds: 2, endSeconds: 8 },
          { startSeconds: 14, endSeconds: 19 },
        ],
      },
    );
    expect(keepRes.project).toBeDefined();
    const afterKeep = keepRes.project!;
    expect(timelineDurationFrames(afterKeep)).toBe(330);
  });

  it("split_clip unificado acepta tanto atSeconds como atFrame y devuelve leftId/rightId", async () => {
    const { project, videoClipId } = buildSampleProjectWithFootage(10);
    const splitTool = getTool("split_clip");

    const bySeconds = await splitTool.execute(
      { projectId: project.id, project, signal: new AbortController().signal, setProgress: () => undefined },
      { clipId: videoClipId, atSeconds: 3 },
    );
    expect((bySeconds.data as { leftId?: string; rightId?: string }).leftId).toBe(videoClipId);
    expect((bySeconds.data as { leftId?: string; rightId?: string }).rightId).toBeTruthy();

    const byFrame = await splitTool.execute(
      { projectId: project.id, project, signal: new AbortController().signal, setProgress: () => undefined },
      { clipId: videoClipId, atFrame: 60 },
    );
    expect((byFrame.data as { atSeconds?: number }).atSeconds).toBeCloseTo(2, 1);
  });

  it("compila los 4 motores polimórficos en modo overlay transparente para metraje real y soporta tintes libres", async () => {
    for (let seed = 0; seed < 4; seed += 1) {
      const code = buildPolymorphicProceduralSceneCode({
        componentName: `PolyHudSeed${seed}`,
        variantSeed: seed,
        headline: "CRECIMIENTO EN VIVO",
        subheadline: "Indicador contextual no intrusivo",
        accentColor: "#10B981",
        secondaryColor: "#0EA5E9",
        surfaceColor: "#090D18",
        textColor: "#F8FAFC",
        fontFamily: "Space Grotesk",
        visualTheme: "Tech",
        transparentOverlay: true,
        zone: seed % 2 === 0 ? "top-right-hud" : "hero-top",
        metricValue: "+48%",
      });
      expect(code).toContain('backgroundColor: "transparent"');
      const check = await verifyRemotionComponentTsx(code);
      expect(check.ok).toBe(true);
    }

    const lookSpec = buildHyperFrameCinematicLook({
      lookPreset: "editorial-clean",
      accentColor: "#38BDF8",
      secondaryColor: "#818CF8",
      customTintHex: "#10B981",
    });
    expect(lookSpec.props.customTintHex).toBe("#10B981");
  });

  it("execute_custom_motion inserta HUD TSX transparente sobre vídeo real y escena opaca en lienzo vacío", async () => {
    const customMotion = getTool("execute_custom_motion");
    const { project } = buildSampleProjectWithFootage(12);

    const onRealVideo = await customMotion.execute(
      { projectId: project.id, project, signal: new AbortController().signal, setProgress: () => undefined },
      {
        prompt: "Gráfico de partículas neuronales con pulso de crecimiento",
        title: "IMPACTO +42%",
        startSeconds: 1.5,
        durationSeconds: 3.5,
        zone: "top-right-hud",
        accentColor: "#10B981",
      },
    );
    expect(onRealVideo.project).toBeDefined();
    const overlayTrack = onRealVideo.project!.tracks.find((t) => t.name === "Motion Overlay");
    expect(overlayTrack).toBeDefined();
    const inserted = overlayTrack!.clips[0] as MediaClip;
    expect(inserted.remotion?.live).toBe(true);
    expect(inserted.remotion?.code).toContain('backgroundColor: "transparent"');

    const emptyProject = createProject("Vacío", defaultSettings(1080, 1920, 30));
    const onBlankCanvas = await customMotion.execute(
      { projectId: emptyProject.id, project: emptyProject, signal: new AbortController().signal, setProgress: () => undefined },
      { prompt: "Escena futurista de partículas orbitales", durationSeconds: 4 },
    );
    const v1Clip = onBlankCanvas.project!.tracks.find((t) => t.kind === "video")!.clips[0] as MediaClip;
    expect(v1Clip.remotion?.code).not.toContain('backgroundColor: "transparent"');
  });

  it("planAutonomousEditDirective genera escenas adaptativas desde transcripción y bloquea acciones prohibidas por el usuario", async () => {
    const { project } = buildSampleProjectWithFootage(24);
    const segments = [
      { id: "s1", startUs: 1_000_000, endUs: 4_500_000, text: "En este lanzamiento crecimos un 140% en ingresos" },
      { id: "s2", startUs: 9_000_000, endUs: 13_000_000, text: "El punto clave es evitar el error más común" },
      { id: "s3", startUs: 16_500_000, endUs: 20_500_000, text: "Ahora verás el resultado real en segundos" },
    ];

    const adaptive = deriveAdaptiveScenesFromTranscriptAndPrompt({
      prompt: "Mejora este video explicativo",
      project,
      transcriptSegments: segments,
    });
    expect(adaptive.length).toBeGreaterThanOrEqual(2);
    expect(adaptive.every((s) => s.layerRole === "overlay")).toBe(true);

    // Con IA simulada que intenta colar remove_silences o subtítulos prohibidos
    const directive = await planAutonomousEditDirective({
      project,
      prompt: "Edita en estilo Matrix #10B981, corta del segundo 4 al 6, no cortes silencios, sin subtítulos y sin zooms",
      transcriptSegments: segments,
      signal: new AbortController().signal,
      chatJsonFn: async () => ({
        model: "mock-director",
        data: {
          artDirection: {
            palette: { accent: "#38BDF8", secondary: "#818CF8", surface: "#090D18", text: "#F8FAFC" },
            visualTheme: "Matrix Tech",
            typographyStyle: "tech_mono",
            editingPace: "balanced_editorial",
            cameraStyle: "whip_energetic",
            colorMood: "verde neón",
          },
          timelineToolCalls: [
            { tool: "remove_silences", args: { minSilenceMs: 700 }, reason: "Poda automática" },
          ],
          subtitleDirective: { enabled: true, style: "tiktok", hideDuringFullScreenScenes: true, placement: "adaptive" },
          atmosphereLook: {
            enabled: true,
            lookPreset: "neon-cyber",
            letterboxRatio: 0.08,
            vignetteIntensity: 0.35,
            grainOpacity: 0.03,
            glowIntensity: 0.25,
          },
          customScenes: [],
          narrativeSummary: "Edición cyberpunk verde",
        },
      }),
    });

    expect(directive.subtitleDirective.enabled).toBe(false);
    expect(directive.artDirection.cameraStyle).toBe("static_clean");
    expect(directive.artDirection.palette.accent).toBe("#10B981");
    expect(directive.atmosphereLook.customTintHex).toBe("#10B981");
    expect(directive.timelineToolCalls.some((c) => c.tool === "remove_silences")).toBe(false);
    expect(directive.timelineToolCalls.some((c) => c.tool === "cut_time_range")).toBe(true);

    const exec = await executeSurgicalTimelineTools({
      projectId: project.id,
      project,
      toolCalls: directive.timelineToolCalls.filter((c) => c.tool === "cut_time_range"),
      signal: new AbortController().signal,
    });
    expect(exec.skippedTools).toHaveLength(0);
    expect(timelineDurationFrames(exec.project)).toBe(660);
  });

  it("planner enruta cortes por rango, diseño TSX sin plantillas y edición libre creativa sin romper presets clásicos", async () => {
    const { project } = buildSampleProjectWithFootage(60);

    const cutPlan = await buildPlan(project, "Corta del segundo 4 al segundo 9 del video", { preferLocal: true });
    expect(cutPlan.plan.steps.some((s) => s.tool === "cut_time_range")).toBe(true);

    const bespokeMotionPlan = await buildPlan(
      project,
      "Crea una animación de partículas neuronales 3D sin plantillas sobre el lanzamiento",
      { preferLocal: true },
    );
    expect(bespokeMotionPlan.plan.steps.some((s) => s.tool === "execute_custom_motion")).toBe(true);

    const freeformSwarmPlan = await buildPlan(
      project,
      "Edita este video estilo documental cinematográfico con tintes verdes, sin subtítulos y sin zooms",
      { preferLocal: true },
    );
    expect(freeformSwarmPlan.plan.steps.some((s) => s.tool === "execute_autonomous_edit_swarm")).toBe(true);

    // Regresión obligatoria del planificador clásico de tendencias (60s * 0.22 -> clamped min 15s)
    const trendPlan = await buildPlan(project, "editar el video con las nuevas tendencias", { preferLocal: true });
    const hl = trendPlan.plan.steps.find((s) => s.tool === "select_highlights");
    expect(hl?.args.targetSeconds).toBe(15);
  });

  it("aplica criterio y contención editorial (menos carga visual = mayor impacto) según tono, metraje y duración", () => {
    const { project } = buildSampleProjectWithFootage(25);

    const restraintBudget = computeEditorialBudget({
      prompt: "Edita esta entrevista sobria de forma limpia y natural sin saturar la pantalla",
      project,
      hasRealVideoFootage: true,
      totalDurationSec: 25,
    });
    const curatedBudget = computeEditorialBudget({
      prompt: "Edita este video para retener audiencia",
      project,
      hasRealVideoFootage: true,
      totalDurationSec: 25,
    });
    const kineticBudget = computeEditorialBudget({
      prompt: "Edición viral frenética estilo MrBeast ultra dinámico con muchos efectos e infografías",
      project,
      hasRealVideoFootage: true,
      totalDurationSec: 25,
    });

    expect(restraintBudget.densityTier).toBe("restraint");
    expect(restraintBudget.applyAtmosphereLayer).toBe(false);
    expect(restraintBudget.applyOpticalTransitionsOnJumpCuts).toBe(false);
    expect(curatedBudget.densityTier).toBe("curated");
    expect(kineticBudget.densityTier).toBe("kinetic");
    expect(restraintBudget.maxOverlays).toBeLessThanOrEqual(curatedBudget.maxOverlays);
    expect(curatedBudget.maxOverlays).toBeLessThan(kineticBudget.maxOverlays);
    expect(restraintBudget.maxZoomPunches).toBeLessThan(kineticBudget.maxZoomPunches);

    // En vídeo real sin transcripción ni petición explícita de rótulos, no inventa tarjetas con palabras del prompt
    const silentFallbackScenes = deriveAdaptiveScenesFromTranscriptAndPrompt({
      prompt: "Edita este video para que quede profesional",
      project,
      transcriptSegments: [],
    });
    expect(silentFallbackScenes).toHaveLength(0);

    // enforceEditorialRestraint conserva background-v1 y poda overlays saturados dejando solo picos espaciados
    const saturatedScenes = [
      {
        id: "bg_main",
        title: "Fondo generativo",
        startSec: 0,
        durationSec: 25,
        zone: "center-stage" as const,
        layerRole: "background-v1" as const,
        visualConcept: "Escena generativa atmosférica completa",
        animationChoreography: "Movimiento orgánico lento",
        headline: "FONDO",
        subheadline: "",
        sfxType: "whoosh" as const,
        hideSubtitlesDuringScene: false,
        fontFamilyHint: "inter" as const,
      },
      ...Array.from({ length: 10 }, (_, idx) => ({
        id: `ov_${idx}`,
        title: idx === 3 ? "Crecimiento récord" : `Tarjeta ${idx + 1}`,
        startSec: idx * 2.2,
        durationSec: 3.2,
        zone: "top-right-hud" as const,
        layerRole: "overlay" as const,
        visualConcept: "HUD minimalista",
        animationChoreography: "Entrada suave y salida limpia",
        headline: idx === 3 ? "+320% IMPACTO" : `DATO ${idx + 1}`,
        subheadline: idx === 3 ? "Cifra verificada" : "Detalle",
        ...(idx === 3 ? { metricValue: "+320%" } : {}),
        sfxType: "pop" as const,
        hideSubtitlesDuringScene: false,
        fontFamilyHint: "space-grotesk" as const,
      })),
    ];

    const filtered = enforceEditorialRestraint({
      scenes: saturatedScenes,
      budget: curatedBudget,
      prompt: "Edita este video para retener audiencia",
      totalDurationSec: 25,
      hasRealVideoFootage: true,
    });

    const keptBg = filtered.filter((s) => s.layerRole === "background-v1");
    const keptOverlays = filtered
      .filter((s) => s.layerRole !== "background-v1")
      .sort((a, b) => a.startSec - b.startSec);

    expect(keptBg).toHaveLength(1);
    expect(keptOverlays.length).toBeGreaterThanOrEqual(1);
    expect(keptOverlays.length).toBeLessThanOrEqual(curatedBudget.maxOverlays);
    expect(keptOverlays.some((s) => s.id === "ov_3")).toBe(true);
    for (let i = 1; i < keptOverlays.length; i += 1) {
      const prevEnd = keptOverlays[i - 1]!.startSec + keptOverlays[i - 1]!.durationSec;
      expect(keptOverlays[i]!.startSec - prevEnd).toBeGreaterThanOrEqual(
        curatedBudget.minOverlayGapSec - 0.05,
      );
    }
  });

  it("planAutonomousEditDirective poda una respuesta sobrecargada del Director IA y desactiva atmósfera redundante en metraje limpio", async () => {
    const { project } = buildSampleProjectWithFootage(25);
    const transcriptSegments = [
      { startUs: 500_000, endUs: 4_500_000, text: "Hoy explicamos por qué casi nadie escala con consistencia." },
      { startUs: 6_000_000, endUs: 11_000_000, text: "En noventa días logramos +320% de retención orgánica sostenida." },
      { startUs: 15_000_000, endUs: 21_000_000, text: "La clave final es dejar aire para que cada idea respire." },
    ];

    const directive = await planAutonomousEditDirective({
      project,
      prompt: "Edita esta entrevista sobria de forma limpia y natural sin sobrecargar la pantalla",
      transcriptSegments,
      hasPrimaryVideoMedia: true,
      signal: new AbortController().signal,
      chatJsonFn: async () => ({
        model: "mock-director",
        data: {
          editorialPlan: {
            densityTier: "kinetic",
            decisionRationale: "Sobrecarga artificial que debe ser acotada por el criterio editorial",
            maxOverlays: 8,
            minOverlayGapSec: 0.5,
          },
          artDirection: {
            palette: {
              accent: "#38BDF8",
              secondary: "#818CF8",
              surface: "#090D18",
              text: "#F8FAFC",
            },
            visualTheme: "Clean Editorial",
            typographyStyle: "clean_geometric",
            editingPace: "balanced_editorial",
            cameraStyle: "subtle_editorial",
            colorMood: "Natural Clean",
          },
          timelineToolCalls: [],
          subtitleDirective: {
            enabled: true,
            style: "minimal",
            hideDuringFullScreenScenes: true,
            placement: "adaptive",
          },
          atmosphereLook: {
            enabled: true,
            lookPreset: "editorial-clean",
            letterboxRatio: 0,
            vignetteIntensity: 0.3,
            grainOpacity: 0.04,
            glowIntensity: 0.2,
          },
          customScenes: Array.from({ length: 8 }, (_, idx) => ({
            id: `ai_sc_${idx}`,
            title: idx === 2 ? "Hito +320%" : `Escena IA ${idx + 1}`,
            startSec: idx * 2.5,
            durationSec: 3.4,
            zone: "top-right-hud",
            layerRole: "overlay",
            visualConcept: "Rótulo editorial animado con precisión geométrica",
            animationChoreography: "Spring entrada limpia y salida fluida",
            headline: idx === 2 ? "+320% RETENCIÓN" : `BLOQUE ${idx + 1}`,
            subheadline: idx === 2 ? "90 días orgánicos" : "Contexto breve",
            ...(idx === 2 ? { metricValue: "+320%" } : {}),
            sfxType: "pop",
            hideSubtitlesDuringScene: false,
          })),
          narrativeSummary: "Edición sobria con foco en el mensaje.",
        },
      }),
    });

    expect(directive.source).toBe("ai_director");
    expect(directive.resolvedBudget).toBeDefined();
    expect(directive.resolvedBudget!.densityTier).toBe("restraint");
    expect(directive.customScenes.length).toBeGreaterThanOrEqual(1);
    expect(directive.customScenes.length).toBeLessThanOrEqual(directive.resolvedBudget!.maxOverlays);
    expect(directive.customScenes.length).toBeLessThan(8);
    expect(directive.customScenes.some((s) => s.id === "ai_sc_2")).toBe(true);
    expect(directive.atmosphereLook.enabled).toBe(false);
  });

  it("nunca plasma el prompt conversacional del usuario como título o subtítulo en pantalla y extrae el tema real del video", async () => {
    const userPrompt =
      "Quiero que al incio pogues un titulo con los mismo estilos osea profesioanl y muy coorpo";
    expect(isConversationalInstructionText(userPrompt)).toBe(true);
    expect(stripEditingMetaInstructions(userPrompt)).toBe("");

    const parsedTitles = extractExplicitPromptTitles(userPrompt);
    expect(parsedTitles.wantsIntroTitle).toBe(true);
    expect(parsedTitles.wantsCorporateCleanStyle).toBe(true);

    const { project } = buildSampleProjectWithFootage(20);
    const subTrack = project.tracks.find((t) => t.kind === "text")!;
    const s1 = addClip(
      project,
      subTrack.id,
      makeTextClip({
        text: "Bueno, buenísimo,",
        startFrame: 30,
        durationFrames: 30,
        role: "subtitle",
      }),
    );
    if (!s1.ok) throw new Error(s1.error);
    const s2 = addClip(
      s1.project,
      subTrack.id,
      makeTextClip({
        text: "hoy presentamos la plataforma OECLIP para equipos corporativos.",
        startFrame: 65,
        durationFrames: 90,
        role: "subtitle",
      }),
    );
    if (!s2.ok) throw new Error(s2.error);
    const projectWithSubs = s2.project;

    const resolved = resolveContextualOverlayCopy({
      prompt: userPrompt,
      project: projectWithSubs,
    });
    expect(resolved.wantsCorporateCleanStyle).toBe(true);
    expect(resolved.headline).not.toMatch(/quiero|incio|pogues|mismo|estilos|osea|profesioanl|coorpo/i);
    expect(resolved.subheadline).not.toMatch(/quiero|incio|pogues|mismo|estilos|osea|profesioanl|coorpo/i);
    expect(resolved.headline).not.toMatch(/bueno|buen[ií]simo/i);
    expect(resolved.headline).toMatch(/PRESENTAMOS|PLATAFORMA|OECLIP/i);

    const adaptiveScenes = deriveAdaptiveScenesFromTranscriptAndPrompt({
      prompt: userPrompt,
      project: projectWithSubs,
      transcriptSegments: [
        { startUs: 200_000, endUs: 1_200_000, text: "Bueno, buenísimo," },
        {
          startUs: 1_300_000,
          endUs: 4_800_000,
          text: "hoy presentamos la plataforma OECLIP para equipos corporativos.",
        },
      ],
    });
    expect(adaptiveScenes).toHaveLength(1);
    expect(adaptiveScenes[0]!.startSec).toBeLessThan(0.5);
    expect(adaptiveScenes[0]!.headline).not.toMatch(/quiero|pogues|coorpo|bueno/i);
    expect(adaptiveScenes[0]!.subheadline).not.toMatch(/quiero|pogues|coorpo/i);

    const customMotion = getTool("execute_custom_motion");
    const execResult = await customMotion.execute(
      {
        projectId: projectWithSubs.id,
        project: projectWithSubs,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      {
        prompt: userPrompt,
        startSeconds: 0,
        durationSeconds: 3,
      },
    );
    const overlayTrack = execResult.project!.tracks.find((t) => t.name === "Motion Overlay");
    expect(overlayTrack).toBeDefined();
    const clip = overlayTrack!.clips[0] as MediaClip;
    const propsTitle = String(clip.remotion?.props?.title ?? "");
    const propsSubtitle = String(clip.remotion?.props?.subtitle ?? "");
    expect(propsTitle).not.toMatch(/quiero|incio|pogues|mismo|estilos|osea|profesioanl|coorpo/i);
    expect(propsSubtitle).not.toMatch(/quiero|incio|pogues|mismo|estilos|osea|profesioanl|coorpo/i);
    expect(clip.remotion?.code).not.toContain("pogues");
    expect(clip.remotion?.code).not.toContain("coorpo");
  });
});
