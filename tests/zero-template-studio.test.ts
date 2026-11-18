import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createProject, defaultSettings, makeMediaClip, makeTextClip } from "../src/shared/project";
import { addClip, addTrack, isLiveRemotionClip } from "../src/shared/timeline";
import { buildOverlaySpecs, overlayFonts, allProjectFonts } from "../src/shared/remotionSpec";
import { exportSettingsSchema, type MediaAsset, type MediaClip } from "../src/shared/schema";
import { buildExport } from "../server/media/export";
import { buildLiveRemotionExportSpecs, shouldRenderClipInRemotion } from "../server/media/remotion";
import { runFfmpeg } from "../server/media/process";
import { buildProceduralMusicExpression } from "../server/services/sfxService";
import { computeAlignedSceneTimings, synthesizeSceneSpeechTracks } from "../server/services/ttsService";
import { parseBrandHtmlMetadata } from "../server/agent/brandCapture";
import { auditGeneratedCompositionGeometry, wcagContrastRatio } from "../server/agent/visionInspector";
import {
  auditRemotionComponentSafety,
  buildPolymorphicProceduralSceneCode,
  planAutonomousEditDirective,
  synthesizeValidatedRemotionScene,
  verifyRemotionComponentTsx,
} from "../server/agent/autonomousEditorBrain";
import { rebalanceNarrativePlanWithTts, parsePromptNarrativePlan } from "../server/agent/swarmDirector";
import { buildPlan, isGenerativeFromScratchInstruction } from "../server/agent/planner";
import { FONT_FAMILIES } from "../src/shared/subtitles";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("estudio generativo desde cero sin plantillas rígidas", () => {
  it("sincroniza preview y export Remotion incluyendo fondos V1, zIndex y las 6 fuentes locales", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-remotion-parity-"));
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, "media"), { recursive: true });
    await fs.mkdir(path.join(dir, "temp"), { recursive: true });

    let project = createProject("Zero Template Parity", defaultSettings(1080, 1920, 30));
    const dummyAsset: MediaAsset = {
      id: "med_bg_dummy01",
      name: "swarm-bg-canvas.mp4",
      kind: "video",
      file: "media/swarm-bg-canvas.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
      durationUs: 5_000_000,
      width: 1080,
      height: 1920,
      fps: { num: 30, den: 1 },
      videoCodec: "h264",
      thumbnail: "ready",
      waveform: "none",
      proxy: "none",
      importedAt: new Date().toISOString(),
      origin: "generated",
    };
    project = { ...project, media: [dummyAsset] };

    const v1Track = project.tracks.find((t) => t.kind === "video")!;
    const v1BgClip: MediaClip = {
      ...makeMediaClip(project, dummyAsset, { startFrame: 0, durationFrames: 120, createdBy: "agent" }),
      name: "Escena Fondo 1 · Hook",
      remotion: {
        compositionId: "swarm_bg_1",
        componentName: "CinematicCanvasBg1",
        code: `import React from "react";\nimport { AbsoluteFill, useCurrentFrame } from "remotion";\nexport const CinematicCanvasBg1 = () => <AbsoluteFill style={{ backgroundColor: "#0F172A" }} />;`,
        props: { accentColor: "#38BDF8" },
        live: true,
      },
    };
    const r1 = addClip(project, v1Track.id, v1BgClip);
    if (!r1.ok) throw new Error(r1.error);
    project = r1.project;

    const motionAdded = addTrack(project, "video", "Capa Motion");
    if (!motionAdded.ok || !motionAdded.track) throw new Error("No se pudo crear Capa Motion");
    project = motionAdded.project;
    const motionTrackId = motionAdded.track.id;
    const hudClip: MediaClip = {
      ...makeMediaClip(project, dummyAsset, { startFrame: 15, durationFrames: 90, createdBy: "agent" }),
      name: "HUD Datos",
      remotion: {
        compositionId: "hud_comp_1",
        componentName: "HudComp",
        code: `import React from "react";\nimport { AbsoluteFill, useCurrentFrame } from "remotion";\nexport const HudComp = () => <AbsoluteFill style={{ backgroundColor: "transparent" }} />;`,
        props: { zone: "hero-top" },
        live: true,
      },
    };
    const r2 = addClip(project, motionTrackId, hudClip);
    if (!r2.ok) throw new Error(r2.error);
    project = r2.project;

    const textTrack = project.tracks.find((t) => t.kind === "text")!;
    const r3 = addClip(
      project,
      textTrack.id,
      makeTextClip({ text: "Título legible", startFrame: 0, durationFrames: 90, fontFamily: "anton" }),
    );
    if (!r3.ok) throw new Error(r3.error);
    project = r3.project;

    expect(isLiveRemotionClip(v1BgClip)).toBe(true);
    expect(shouldRenderClipInRemotion(v1BgClip)).toBe(true);
    expect(shouldRenderClipInRemotion(hudClip)).toBe(true);

    const exportSettings = exportSettingsSchema.parse({
      resolution: 1080,
      aspect: "9:16",
      fps: 30,
      quality: "standard",
      encoder: "cpu",
      engine: "remotion",
      fileName: "out.mp4",
    });

    const liveSpecs = await buildLiveRemotionExportSpecs(project, exportSettings);
    expect(liveSpecs).toHaveLength(2);
    const bgSpec = liveSpecs.find((s) => s.componentName === "CinematicCanvasBg1")!;
    const hudSpec = liveSpecs.find((s) => s.componentName === "HudComp")!;
    expect(bgSpec.zIndex).toBe(100);
    expect(hudSpec.zIndex).toBe(200);
    expect((bgSpec.zIndex ?? 0) < (hudSpec.zIndex ?? 0)).toBe(true);

    const allFonts = allProjectFonts();
    expect(allFonts).toHaveLength(FONT_FAMILIES.length);
    const textSpecs = buildOverlaySpecs(project, exportSettings);
    expect(overlayFonts(textSpecs, { includeAllFamilies: true })).toHaveLength(FONT_FAMILIES.length);

    // En modo skipText=true, FFmpeg no debe leer el archivo placeholder V1 como entrada de video si es clip live
    const built = await buildExport(project, exportSettings, {
      outputFile: path.join(dir, "temp", "base.mp4"),
      projectDir: dir,
      tempDir: path.join(dir, "temp"),
      encoder: "libx264",
      skipText: true,
    });
    expect(built.args.join(" ")).not.toContain("swarm-bg-canvas.mp4");
  });

  it("construye sidechain ducking en FFmpeg cuando coexisten voz y pista Música + música evolutiva", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-ducking-test-"));
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, "media"), { recursive: true });
    await fs.mkdir(path.join(dir, "temp"), { recursive: true });

    const speechWav = path.join(dir, "media", "speech.wav");
    const musicWav = path.join(dir, "media", "bgm.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=f=220:d=2:r=48000", "-c:a", "pcm_s16le", speechWav], {
      timeoutMs: 15_000,
    });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=f=110:d=2:r=48000", "-ac", "2", "-c:a", "pcm_s16le", musicWav], {
      timeoutMs: 15_000,
    });

    const speechAsset: MediaAsset = {
      id: "med_speech",
      name: "Locución IA",
      kind: "audio",
      file: "media/speech.wav",
      mimeType: "audio/wav",
      sizeBytes: 1000,
      durationUs: 2_000_000,
      audioCodec: "pcm_s16le",
      sampleRate: 48000,
      channels: 1,
      thumbnail: "ready",
      waveform: "none",
      proxy: "none",
      importedAt: new Date().toISOString(),
      origin: "generated",
    };
    const musicAsset: MediaAsset = {
      ...speechAsset,
      id: "med_bgm",
      name: "Música Fondo",
      file: "media/bgm.wav",
      channels: 2,
    };

    let project = createProject("Ducking", defaultSettings(1080, 1920, 30));
    project = { ...project, media: [speechAsset, musicAsset] };
    const a1 = project.tracks.find((t) => t.kind === "audio")!;
    const speechRes = addClip(project, a1.id, makeMediaClip(project, speechAsset, { startFrame: 0, durationFrames: 60 }));
    if (!speechRes.ok) throw new Error(speechRes.error);
    project = speechRes.project;

    const musicTrack = addTrack(project, "audio", "Música");
    if (!musicTrack.ok || !musicTrack.track) throw new Error("No se pudo crear pista Música");
    project = musicTrack.project;
    const musicRes = addClip(project, musicTrack.track.id, makeMediaClip(project, musicAsset, { startFrame: 0, durationFrames: 60 }));
    if (!musicRes.ok) throw new Error(musicRes.error);
    project = musicRes.project;

    const built = await buildExport(
      project,
      exportSettingsSchema.parse({
        resolution: 720,
        aspect: "9:16",
        fps: 30,
        quality: "standard",
        encoder: "cpu",
        fileName: "duck.mp4",
      }),
      {
        outputFile: path.join(dir, "temp", "duck.mp4"),
        projectDir: dir,
        tempDir: path.join(dir, "temp"),
        encoder: "libx264",
      },
    );
    const filterText = await fs.readFile(built.filterFile, "utf8");
    expect(filterText).toContain("sidechaincompress=threshold=0.025:ratio=4.5:attack=18:release=320");

    const cinemaExpr = buildProceduralMusicExpression("cinema");
    const techExpr = buildProceduralMusicExpression("tech");
    const energeticExpr = buildProceduralMusicExpression("energetic");
    expect(cinemaExpr).not.toBe(techExpr);
    expect(techExpr).not.toBe(energeticExpr);
    expect(cinemaExpr).toContain("mod(t,8)");
  });

  it("sintetiza locución escena por escena offline/cross-platform y recalibra bloques y tiempos", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-tts-sync-"));
    tempDirs.push(dir);
    const mediaDir = path.join(dir, "media");
    const masterWav = path.join(mediaDir, "swarm-tts-voice.wav");

    const slots = computeAlignedSceneTimings([2.0, 3.2], 0.25);
    expect(slots).toHaveLength(2);
    expect(slots[0]!.startSec).toBe(0);
    expect(slots[0]!.durationSec).toBeCloseTo(2.25, 2);
    expect(slots[1]!.startSec).toBeCloseTo(2.25, 2);

    const prevOffline = process.env.OECLIP_TTS_OFFLINE;
    process.env.OECLIP_TTS_OFFLINE = "1";
    try {
      const tts = await synthesizeSceneSpeechTracks({
        mediaDir,
        destinationPath: masterWav,
        allowNetworkTts: false,
        blocks: [
          { label: "Gancho", narration: "La computación cuántica redefine el futuro.", suggestedDurationSec: 2.0 },
          { label: "Impacto", narration: "Miles de variables resueltas en segundos.", suggestedDurationSec: 2.5 },
        ],
      });
      expect(tts.segments).toHaveLength(2);
      expect(tts.totalDurationSec).toBeGreaterThan(2.0);
      const stat = await fs.stat(masterWav);
      expect(stat.size).toBeGreaterThan(5000);

      const basePlan = parsePromptNarrativePlan("Video sobre cuántica", 30, "Test");
      const slicedPlan = { ...basePlan, blocks: basePlan.blocks.slice(0, 2) };
      const rebalanced = rebalanceNarrativePlanWithTts(slicedPlan, tts.segments, 30, false);
      expect(rebalanced.blocks[0]!.startFrame).toBe(0);
      expect(rebalanced.blocks[1]!.startFrame).toBe(rebalanced.blocks[0]!.endFrame);
      expect(rebalanced.totalFrames).toBeGreaterThanOrEqual(Math.round(tts.totalDurationSec * 30) - 6);
    } finally {
      if (prevOffline === undefined) delete process.env.OECLIP_TTS_OFFLINE;
      else process.env.OECLIP_TTS_OFFLINE = prevOffline;
    }
  }, 25_000);

  it("sintetiza motores polimórficos Canvas 2D / 3D / SVG / Monolito válidos y tolera 2 reparaciones IA", async () => {
    for (let seed = 0; seed < 4; seed += 1) {
      const code = buildPolymorphicProceduralSceneCode({
        componentName: `PolyScene${seed}`,
        variantSeed: seed,
        headline: `ACTO ${seed + 1}`,
        subheadline: "Motor generativo sin plantilla",
        accentColor: "#38BDF8",
        secondaryColor: "#A855F7",
        surfaceColor: "#090D18",
        textColor: "#F8FAFC",
        fontFamily: "Space Grotesk",
        visualTheme: "Quantum Studio",
      });
      expect(auditRemotionComponentSafety(code).ok).toBe(true);
      const astCheck = await verifyRemotionComponentTsx(code);
      expect(astCheck.ok).toBe(true);
    }

    // Motor 0 usa Canvas 2D; Motor 1 usa perspective 3D; Motor 2 usa waves SVG; Motor 3 usa conic monolith
    expect(
      buildPolymorphicProceduralSceneCode({
        componentName: "M0",
        variantSeed: 0,
        headline: "A",
        subheadline: "B",
        accentColor: "#38BDF8",
        secondaryColor: "#818CF8",
        surfaceColor: "#090D18",
        textColor: "#F8FAFC",
        fontFamily: "Inter",
        visualTheme: "T",
      }),
    ).toContain("<canvas");
    expect(
      buildPolymorphicProceduralSceneCode({
        componentName: "M1",
        variantSeed: 1,
        headline: "A",
        subheadline: "B",
        accentColor: "#38BDF8",
        secondaryColor: "#818CF8",
        surfaceColor: "#090D18",
        textColor: "#F8FAFC",
        fontFamily: "Anton",
        visualTheme: "T",
      }),
    ).toContain("rotateX(68deg)");

    // Test 2-attempt self-repair + background-v1 planning
    let capturedDirectorPrompt = "";
    const project = createProject("Empty AI", defaultSettings(1080, 1920, 30));
    const directive = await planAutonomousEditDirective({
      project,
      prompt: "Crea un video sobre biotecnología",
      hasPrimaryVideoMedia: false,
      availableSkills: ["celular (Celular 3D): Mockup iPhone"],
      narrativeBlocksHint: [{ label: "Intro", startSec: 0, durationSec: 5, narration: "Hola" }],
      signal: AbortSignal.timeout(5000),
      chatJsonFn: async (_sys, user) => {
        capturedDirectorPrompt = user;
        return {
          model: "mock-ai",
          rawText: "{}",
          data: {
            artDirection: {
              palette: { accent: "#10B981", secondary: "#38BDF8", surface: "#04120E", text: "#FFFFFF" },
              visualTheme: "BioFuturism",
              typographyStyle: "tech_mono",
              editingPace: "balanced_editorial",
              cameraStyle: "slow_cinema_push",
              colorMood: "Emerald Bio",
            },
            timelineToolCalls: [],
            subtitleDirective: { enabled: true, style: "cinematic", hideDuringFullScreenScenes: true, placement: "adaptive" },
            atmosphereLook: { enabled: true, lookPreset: "editorial-clean", letterboxRatio: 0, vignetteIntensity: 0.3, grainOpacity: 0.02, glowIntensity: 0.2 },
            customScenes: [
              {
                id: "bg1",
                title: "Escena Celular V1",
                startSec: 0,
                durationSec: 5,
                zone: "center-stage",
                layerRole: "background-v1",
                visualConcept: "Canvas de hélices ADN conectadas",
                headline: "BIOTECNOLOGÍA",
                subheadline: "Diseño celular programable",
                sfxType: "whoosh",
              },
            ],
            narrativeSummary: "Video bio generativo V1+HUD.",
          },
        };
      },
    });
    expect(capturedDirectorPrompt).toContain("NO hay video cámara en V1");
    expect(capturedDirectorPrompt).toContain("celular (Celular 3D)");
    expect(directive.customScenes[0]?.layerRole).toBe("background-v1");

    let callIdx = 0;
    const synthResult = await synthesizeValidatedRemotionScene({
      scene: directive.customScenes[0]!,
      artDirection: directive.artDirection,
      width: 1080,
      height: 1920,
      fps: 30,
      durationFrames: 150,
      maxRepairAttempts: 2,
      signal: AbortSignal.timeout(5000),
      chatJsonFn: async () => {
        callIdx += 1;
        if (callIdx <= 2) {
          return {
            model: "mock",
            rawText: "{}",
            data: { code: `export const HFScenebg1 = () => { const broken = interpolate(0, [0, 10]); return <div />; };` },
          };
        }
        return {
          model: "mock",
          rawText: "{}",
          data: {
            code: `import React from "react";\nimport { AbsoluteFill, useCurrentFrame } from "remotion";\nexport const HFScenebg1: React.FC = () => { const f = useCurrentFrame(); return <AbsoluteFill style={{ opacity: f >= 0 ? 1 : 0 }}>BIO</AbsoluteFill>; };\nexport default HFScenebg1;`,
          },
        };
      },
    });
    expect(synthResult.ok).toBe(true);
    if (synthResult.ok) {
      expect(synthResult.repairedAttempts).toBe(2);
      expect(synthResult.props.fontFamily).toBe("Space Grotesk");
    }
  });

  it("extrae tokens CSS/DOM reales de marca y corrige colisiones geométricas y contraste WCAG", () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="NovaBio — Medicina Celular" />
          <meta name="og:description" content="Terapias génicas de precisión en Latinoamérica" />
          <style>:root { --primary: #0ea5e9; --secondary: #a855f7; --surface: #070B14; }</style>
        </head>
        <body>
          <h2>Secuenciación ultrarrápida</h2>
          <h2>Modelado molecular 3D</h2>
          <svg><path d="M10 10 H 90 V 90 H 10 Z" /></svg>
        </body>
      </html>
    `;
    const brand = parseBrandHtmlMetadata(html, {
      brandName: "Fallback",
      tagline: "Innovación digital",
      accentColor: "#000000",
      secondaryColor: "#111111",
    });
    expect(brand.brandName).toBe("NovaBio");
    expect(brand.accentColor).toBe("#0EA5E9");
    expect(brand.secondaryColor).toBe("#A855F7");
    expect(brand.keyFeatures).toContain("Secuenciación ultrarrápida");
    expect(brand.logoSvgPaths.length).toBeGreaterThan(0);

    expect(wcagContrastRatio("#FFFFFF", "#0F172A")).toBeGreaterThan(14);
    expect(wcagContrastRatio("#111827", "#0F172A")).toBeLessThan(2);

    let project = createProject("QA Geo", defaultSettings(1080, 1920, 30));
    const motionTrack = addTrack(project, "video", "Capa Motion");
    if (!motionTrack.ok || !motionTrack.track) throw new Error("No se pudo crear Capa Motion QA");
    project = motionTrack.project;
    const qaMotionTrackId = motionTrack.track.id;
    const dummyAsset: MediaAsset = {
      id: "med_qa",
      name: "motion.webm",
      kind: "video",
      file: "generated/m.webm",
      mimeType: "video/webm",
      sizeBytes: 0,
      durationUs: 5_000_000,
      width: 1080,
      height: 1920,
      fps: { num: 30, den: 1 },
      thumbnail: "ready",
      waveform: "none",
      proxy: "none",
      importedAt: new Date().toISOString(),
      origin: "generated",
    };
    project = { ...project, media: [dummyAsset] };
    const clipRes = addClip(project, qaMotionTrackId, {
      ...makeMediaClip(project, dummyAsset, { startFrame: 0, durationFrames: 90 }),
      name: "HUD Baja",
      remotion: {
        compositionId: "hud_qa",
        componentName: "HudQa",
        code: `const zone = "lower-third";`,
        props: { zone: "lower-third" },
        live: true,
      },
    });
    if (!clipRes.ok) throw new Error(clipRes.error);
    project = clipRes.project;

    const textTrack = project.tracks.find((t) => t.kind === "text")!;
    const subRes = addClip(
      project,
      textTrack.id,
      makeTextClip({
        text: "Subtítulo inferior oscuro",
        startFrame: 0,
        durationFrames: 90,
        role: "subtitle",
        position: { x: 0.5, y: 0.84 },
        color: "#111827",
        backgroundColor: "#0F172A",
        backgroundOpacity: 0.9,
      }),
    );
    if (!subRes.ok) throw new Error(subRes.error);
    project = subRes.project;

    const audited = auditGeneratedCompositionGeometry(project);
    expect(audited.adjustmentsMade).toBe(2);
    const updatedHud = audited.project.tracks
      .find((t) => t.id === qaMotionTrackId)!
      .clips[0] as MediaClip;
    expect(updatedHud.remotion?.props?.zone).toBe("hero-top");
    const updatedSub = audited.project.tracks.find((t) => t.id === textTrack.id)!.clips[0]!;
    if (updatedSub.type === "text") {
      expect(updatedSub.color).toBe("#FFFFFF");
    }
  });

  it("permite planificar desde cero sobre proyectos vacíos (media = []) sin rechazar la petición", async () => {
    expect(isGenerativeFromScratchInstruction("Crea un reel de 20 segundos sobre Marte desde cero")).toBe(true);
    expect(isGenerativeFromScratchInstruction("Corta los primeros 3 segundos del video")).toBe(false);

    const emptyProject = createProject("Vacío Total", defaultSettings(1920, 1080, 30));
    const result = await buildPlan(
      emptyProject,
      "Crea un video vertical para TikTok sobre inteligencia artificial en medicina y expórtalo",
      { preferLocal: true },
    );
    const tools = result.plan.steps.map((s) => s.tool);
    expect(tools).toEqual(["change_aspect_ratio", "execute_autonomous_edit_swarm", "render_export"]);
  });
});
