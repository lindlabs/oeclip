import { describe, expect, it } from "vitest";
import { createProject, defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";
import type { MediaAsset, MediaClip, Project } from "../src/shared/schema";
import {
  buildHyperFrameCinematicLook,
  buildHyperFrameSplitComparison,
} from "../src/shared/hyperframes";
import {
  auditRemotionComponentSafety,
  deriveLocalEditDirective,
  executeSurgicalTimelineTools,
  planAutonomousEditDirective,
  synthesizeValidatedRemotionScene,
  verifyRemotionComponentTsx,
} from "../server/agent/autonomousEditorBrain";
import {
  auditAndResolveSpatialCollisions,
  auditAndValidateGeneratedRemotionClips,
  isMacroSwarmPrompt,
  mapSourceSecToTimelineFrame,
  mapTimelineFrameToSourceSec,
} from "../server/agent/swarmDirector";
import { getTool } from "../server/agent/tools";

function makeSampleProject(): { project: Project; clip: MediaClip } {
  const base = createProject("Test Editorial", defaultSettings(1920, 1080, 30));
  const videoAsset: MediaAsset = {
    id: "med_auto_01",
    name: "entrevista.mp4",
    kind: "video",
    file: "media/entrevista.mp4",
    mimeType: "video/mp4",
    sizeBytes: 2_500_000,
    durationUs: 20_000_000,
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    videoCodec: "h264",
    audioCodec: "aac",
    thumbnail: "ready",
    waveform: "ready",
    proxy: "none",
    importedAt: new Date().toISOString(),
    origin: "import",
  };

  let project: Project = { ...base, media: [videoAsset] };
  const v1 = project.tracks.find((t) => t.kind === "video")!;
  const clip = makeMediaClip(project, videoAsset, { startFrame: 0 });
  const added = addClip(project, v1.id, clip);
  if (!added.ok) throw new Error(added.error);
  project = added.project;
  return { project, clip };
}

describe("motor de edición autónoma Remotion × HyperFrames", () => {
  it("genera capas HyperFrames válidas y compilables (CinematicLook y SplitComparison)", async () => {
    const look = buildHyperFrameCinematicLook({
      lookPreset: "cinema-teal-orange",
      accentColor: "#38BDF8",
      secondaryColor: "#F97316",
      letterboxRatio: 0.08,
      vignetteIntensity: 0.45,
      grainOpacity: 0.04,
      glowIntensity: 0.28,
    });
    const split = buildHyperFrameSplitComparison({
      badge: "BENCHMARK",
      title: "Latencia de Inferencia",
      leftLabel: "ANTES",
      leftValue: "420 ms",
      rightLabel: "AHORA",
      rightValue: "38 ms",
      palette: {
        accent: "#38BDF8",
        secondary: "#818CF8",
        surface: "#090D18",
        text: "#F8FAFC",
      },
    });

    expect((await verifyRemotionComponentTsx(look.code)).ok).toBe(true);
    expect((await verifyRemotionComponentTsx(split.code)).ok).toBe(true);
  });

  it("deduce ediciones locales reales (color, velocidad, aspecto, recorte) desde lenguaje natural", () => {
    const { project } = makeSampleProject();
    const directive = deriveLocalEditDirective(
      project,
      "Edita en blanco y negro cinematográfico en formato vertical 9:16, velocidad 1.5x, quita los primeros 2 segundos y mejora la voz",
    );

    const tools = directive.timelineToolCalls.map((t) => t.tool);
    expect(tools).toContain("change_aspect_ratio");
    expect(tools).toContain("apply_color_adjustment");
    expect(tools).toContain("set_clip_speed");
    expect(tools).toContain("trim_clip");
    expect(tools).toContain("enhance_voice");
    expect(directive.atmosphereLook.lookPreset).toBe("noir-contrast");
  });

  it("ejecuta acciones quirúrgicas de timeline reales (color, velocidad, audio) sin fallar ante argumentos aislados", async () => {
    const { project } = makeSampleProject();
    const res = await executeSurgicalTimelineTools({
      projectId: project.id,
      project,
      signal: new AbortController().signal,
      resolveTool: async (name) => getTool(name),
      toolCalls: [
        {
          tool: "apply_color_adjustment",
          clipTarget: "all_visual",
          args: { brightness: 0.94, contrast: 1.24, saturation: 1.18 },
        },
        {
          tool: "set_clip_speed",
          clipTarget: "primary",
          args: { speed: 1.25 },
        },
        {
          tool: "adjust_audio",
          clipTarget: "primary",
          args: { volume: 1.1, enhanceVoice: true },
        },
      ],
    });

    expect(res.appliedTools).toHaveLength(3);
    const updatedV1 = res.project.tracks.find((t) => t.kind === "video")!;
    const mutatedClip = updatedV1.clips[0] as MediaClip;
    expect(mutatedClip.adjustments.contrast).toBeCloseTo(1.24, 2);
    expect(mutatedClip.speed).toBeCloseTo(1.25, 2);
    expect(mutatedClip.audioEnhance).toBe("voice");
  });

  it("combina plan del Director IA (LLM mockeado) con requisitos explícitos del usuario", async () => {
    const { project } = makeSampleProject();
    const directive = await planAutonomousEditDirective({
      project,
      prompt: "Edita en 9:16 con estética documental cuántica",
      signal: new AbortController().signal,
      chatJsonFn: async () => ({
        model: "mock-director",
        data: {
          artDirection: {
            palette: {
              accent: "#22D3EE",
              secondary: "#A855F7",
              surface: "#050814",
              text: "#F8FAFC",
            },
            visualTheme: "Quantum Noir",
            typographyStyle: "tech_mono",
            editingPace: "slow_cinematic",
            cameraStyle: "slow_cinema_push",
            colorMood: "Cold Quantum",
          },
          timelineToolCalls: [
            {
              tool: "apply_color_adjustment",
              clipTarget: "all_visual",
              args: { brightness: 0.92, contrast: 1.2, saturation: 1.1 },
            },
          ],
          subtitleDirective: {
            enabled: true,
            style: "cinematic",
            hideDuringFullScreenScenes: true,
            placement: "adaptive",
          },
          atmosphereLook: {
            enabled: true,
            lookPreset: "cinema-teal-orange",
            letterboxRatio: 0.08,
            vignetteIntensity: 0.45,
            grainOpacity: 0.03,
            glowIntensity: 0.25,
          },
          customScenes: [
            {
              id: "q_intro",
              title: "Órbita Cuántica",
              startSec: 1,
              durationSec: 4,
              zone: "hero-top",
              layerRole: "overlay",
              visualConcept: "Átomo vectorial rotando con anillos elípticos",
              animationChoreography: "Spring entrance + orbital rotation",
              headline: "COMPUTACIÓN CUÁNTICA",
              subheadline: "Superposición coherente",
              metricValue: "1024 Qubits",
              sfxType: "ding",
              hideSubtitlesDuringScene: false,
            },
          ],
          narrativeSummary: "Estilo documental frío con foco cuántico.",
        },
      }),
    });

    expect(directive.source).toBe("ai_director");
    expect(directive.artDirection.palette.accent).toBe("#22D3EE");
    expect(directive.customScenes).toHaveLength(1);
    // El merger garantiza que la petición explícita de 9:16 siga presente aunque el LLM la omitiera
    expect(directive.timelineToolCalls.some((c) => c.tool === "change_aspect_ratio")).toBe(true);
    expect(directive.timelineToolCalls.some((c) => c.tool === "apply_color_adjustment")).toBe(true);
  });

  it("auto-repara componentes Remotion TSX con errores de compilación antes de aceptarlos", async () => {
    let calls = 0;
    const result = await synthesizeValidatedRemotionScene({
      scene: {
        id: "hero_ai",
        title: "Diagrama Neuronal",
        startSec: 2,
        durationSec: 4,
        zone: "hero-top",
        layerRole: "overlay",
        visualConcept: "Red de nodos pulsantes conectada por trazos SVG",
        animationChoreography: "Spring + strokeDashoffset",
        headline: "RED NEURONAL",
        subheadline: "Arquitectura paralela",
        sfxType: "whoosh",
        hideSubtitlesDuringScene: false,
      },
      artDirection: {
        palette: {
          accent: "#38BDF8",
          secondary: "#818CF8",
          surface: "#090D18",
          text: "#F8FAFC",
        },
        visualTheme: "AI Lab",
        typographyStyle: "clean_geometric",
        editingPace: "balanced_editorial",
        cameraStyle: "subtle_editorial",
        colorMood: "Clean Tech",
      },
      width: 1920,
      height: 1080,
      fps: 30,
      durationFrames: 120,
      signal: new AbortController().signal,
      chatJsonFn: async () => {
        calls += 1;
        if (calls === 1) {
          // 1er intento intencionalmente roto (interpolate sin outputRange)
          return {
            model: "mock-codegen",
            data: {
              componentName: "HFSceneheroai",
              compositionId: "HeroAiComp",
              code: `import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
export const HFSceneheroai = () => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 30]);
  return <AbsoluteFill style={{ opacity: op }}><div>Broken</div></AbsoluteFill>;
};`,
            },
          };
        }
        // 2do intento reparado
        return {
          model: "mock-repair",
          data: {
            componentName: "HFSceneheroai",
            compositionId: "HeroAiComp",
            code: `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
export const HFSceneheroai: React.FC<Record<string, any>> = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 16, stiffness: 130 } });
  const op = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: op, pointerEvents: "none", backgroundColor: "transparent" }}>
      <div style={{ transform: \`scale(\${s})\`, color: "#FFFFFF" }}>RED NEURONAL</div>
    </AbsoluteFill>
  );
};
export default HFSceneheroai;`,
          },
        };
      },
    });

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repairedAttempts).toBe(1);
      expect((await verifyRemotionComponentTsx(result.code)).ok).toBe(true);
    }
  });

  it("bloquea APIs inseguras en componentes Remotion y poda clips inválidos en la auditoría QA", async () => {
    const unsafe = auditRemotionComponentSafety(
      `import { useCurrentFrame } from "remotion"; export const Bad = () => { fetch("/x"); return <div />; };`,
    );
    expect(unsafe.ok).toBe(false);

    const { project, clip } = makeSampleProject();
    const brokenClip: MediaClip = {
      ...clip,
      id: "clp_broken_agent",
      startFrame: 0,
      durationFrames: 60,
      createdBy: "agent",
      remotion: {
        compositionId: "broken",
        componentName: "BrokenComp",
        code: `import { AbsoluteFill } from "remotion"; export const BrokenComp = () => <AbsoluteFill><span>Malo</div></AbsoluteFill>;`,
        props: {},
        live: true,
      },
    };
    const nextProject: Project = {
      ...project,
      tracks: [
        ...project.tracks,
        {
          id: "trk_motion_test",
          name: "Capa Motion",
          kind: "video",
          volume: 1,
          muted: false,
          hidden: false,
          locked: false,
          clips: [brokenClip],
        },
      ],
    };

    const qa = await auditAndValidateGeneratedRemotionClips(nextProject);
    expect(qa.checkedCount).toBe(1);
    expect(qa.prunedInvalidCount).toBe(1);
    const trackAfter = qa.project.tracks.find((t) => t.id === "trk_motion_test")!;
    expect(trackAfter.clips).toHaveLength(0);
  });

  it("detecta prompts compuestos de edición con color, ritmo y Remotion/HyperFrames", () => {
    expect(
      isMacroSwarmPrompt(
        "Aplica color cinematográfico frío, velocidad 1.2x en el clip y animaciones a medida con Remotion HyperFrames",
      ),
    ).toBe(true);
    expect(isMacroSwarmPrompt("cambia el texto a Hola")).toBe(false);
  });

  it("mapea bidireccionalmente timestamps entre metraje fuente y V1 segmentado/acelerado", () => {
    const { clip } = makeSampleProject();
    const seg1: MediaClip = {
      ...clip,
      id: "clp_v1_seg1",
      startFrame: 0,
      durationFrames: 90,
      sourceInUs: 2_000_000,
      sourceOutUs: 5_000_000,
      speed: 1,
      mediaId: "med_auto_01",
    };
    const seg2: MediaClip = {
      ...clip,
      id: "clp_v1_seg2",
      startFrame: 90,
      durationFrames: 60,
      sourceInUs: 10_000_000,
      sourceOutUs: 14_000_000,
      speed: 2,
      mediaId: "med_auto_01",
    };
    const foreignClip: MediaClip = {
      ...clip,
      id: "clp_v1_foreign",
      startFrame: 150,
      durationFrames: 60,
      sourceInUs: 0,
      sourceOutUs: 2_000_000,
      speed: 1,
      mediaId: "med_other_02",
    };

    const clips = [seg1, seg2, foreignClip];

    expect(mapSourceSecToTimelineFrame(3.5, clips, 30, "med_auto_01")).toBe(45);
    expect(mapSourceSecToTimelineFrame(7.0, clips, 30, "med_auto_01")).toBeNull();
    expect(mapSourceSecToTimelineFrame(12.0, clips, 30, "med_auto_01")).toBe(120);
    expect(mapSourceSecToTimelineFrame(1.0, clips, 30, "med_auto_01")).toBeNull();

    expect(mapTimelineFrameToSourceSec(45, clips, 30)).toBe(3.5);
    expect(mapTimelineFrameToSourceSec(120, clips, 30)).toBe(12);
    expect(mapTimelineFrameToSourceSec(500, clips, 30)).toBeNull();
  });

  it("sincroniza bidireccionalmente colisiones y supresiones entre Capa Motion y subtítulos", () => {
    const { project, clip } = makeSampleProject();

    const makeMotionOverlay = (
      id: string,
      startFrame: number,
      durationFrames: number,
      props: Record<string, unknown>,
    ): MediaClip => ({
      ...clip,
      id,
      startFrame,
      durationFrames,
      createdBy: "agent",
      remotion: {
        compositionId: `comp_${id}`,
        componentName: `Comp_${id}`,
        code: `import { AbsoluteFill } from "remotion"; export const Comp_${id} = () => <AbsoluteFill />;`,
        props,
        live: true,
      },
    });

    const motionFullScene = makeMotionOverlay("clp_m_full", 5, 40, {
      zone: "center-stage",
      layerRole: "full-scene",
      hideSubtitlesDuringScene: true,
    });
    const motionTopHud = makeMotionOverlay("clp_m_top", 55, 40, {
      zone: "hero-top",
      layerRole: "overlay",
      hideSubtitlesDuringScene: false,
    });
    const motionLowerCard = makeMotionOverlay("clp_m_low", 105, 40, {
      zone: "lower-third",
      layerRole: "overlay",
      hideSubtitlesDuringScene: false,
    });

    const subClip = makeTextClip({
      name: "Subtítulos IA (minimal)",
      text: "Demo subtítulos",
      startFrame: 0,
      durationFrames: 200,
      role: "subtitle",
      createdBy: "agent",
      remotion: {
        compositionId: "subs_test",
        componentName: "SwarmMinimalSubtitles",
        code: `import { AbsoluteFill } from "remotion"; export const SwarmMinimalSubtitles = () => <AbsoluteFill />;`,
        live: true,
        props: {
          captions: [
            {
              start: 10,
              end: 40,
              zone: "lower-third",
              suppressed: false,
              words: [{ text: "Escena", start: 10, end: 25 }, { text: "completa", start: 25, end: 40 }],
            },
            {
              start: 60,
              end: 90,
              zone: "hero-top",
              suppressed: false,
              words: [{ text: "Arriba", start: 60, end: 90 }],
            },
            {
              start: 110,
              end: 140,
              zone: "lower-third",
              suppressed: false,
              words: [{ text: "Abajo", start: 110, end: 140 }],
            },
          ],
        },
      },
    });

    const populatedProject: Project = {
      ...project,
      tracks: [
        ...project.tracks,
        {
          id: "trk_subs_test",
          name: "Subtítulos",
          kind: "text",
          volume: 1,
          muted: false,
          hidden: false,
          locked: false,
          clips: [subClip],
        },
        {
          id: "trk_motion_bidir",
          name: "Capa Motion",
          kind: "video",
          volume: 1,
          muted: false,
          hidden: false,
          locked: false,
          clips: [motionFullScene, motionTopHud, motionLowerCard],
        },
      ],
    };

    const resolved = auditAndResolveSpatialCollisions(populatedProject, 30, {
      userWantsFullSubtitles: false,
    });
    expect(resolved.collisionsResolved).toBeGreaterThanOrEqual(3);

    const outSub = resolved.project.tracks
      .find((t) => t.id === "trk_subs_test")!
      .clips[0]!;
    const outCaptions = outSub.remotion?.props?.captions as Array<{
      suppressed?: boolean;
      zone?: string;
    }>;
    expect(outCaptions[0]!.suppressed).toBe(true);
    expect(outCaptions[1]!.zone).toBe("lower-third");
    expect(outCaptions[2]!.suppressed).toBe(false);

    const outLowerOverlay = resolved.project.tracks
      .find((t) => t.id === "trk_motion_bidir")!
      .clips.find((c) => c.id === "clp_m_low")!;
    expect(outLowerOverlay.remotion?.props?.zone).toBe("hero-top");

    // Cuando el usuario exige subtítulos completos, no deben suprimirse ni en escena full-scene
    const fullSubsAudit = auditAndResolveSpatialCollisions(populatedProject, 30, {
      userWantsFullSubtitles: true,
    });
    const fullSubCaptions = fullSubsAudit.project.tracks
      .find((t) => t.id === "trk_subs_test")!
      .clips[0]!.remotion?.props?.captions as Array<{ suppressed?: boolean }>;
    expect(fullSubCaptions[0]!.suppressed).toBe(false);
  });
});
