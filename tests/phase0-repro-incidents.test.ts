import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { defaultSettings, makeMediaClip } from "../src/shared/project";
import { addClip } from "../src/shared/timeline";

let tempDir = "";
let originalDataDir: string | undefined;

let store: typeof import("../server/projects/store").projectStore;
let authStore: typeof import("../server/auth/store").userStore;
let getTool: typeof import("../server/agent/tools").getTool;
let runDirectorAgent: typeof import("../server/agent/directorAgent").runDirectorAgent;
let buildTimelineQaReport: typeof import("../server/agent/perception").buildTimelineQaReport;
let renderTimelineFrames: typeof import("../server/agent/perception").renderTimelineFrames;
let buildExport: typeof import("../server/media/export").buildExport;
let buildCompositeArgs: typeof import("../server/media/export").buildCompositeArgs;
let AI_PRESETS: typeof import("../server/ai/settings").AI_PRESETS;
let saveAiSettings: typeof import("../server/ai/settings").saveAiSettings;
let aiChatReady: typeof import("../server/ai/provider").aiChatReady;
let chatJson: typeof import("../server/ai/provider").chatJson;
let resetAiChatCircuit: typeof import("../server/ai/provider").resetAiChatCircuit;
let handleMcpHttp: typeof import("../server/mcp/handler").handleMcpHttp;
let buildMcpServer: typeof import("../server/mcp/server").buildMcpServer;

beforeAll(async () => {
  originalDataDir = process.env.NOVACUT_DATA_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oeclip-p0-repro-"));
  process.env.NOVACUT_DATA_DIR = tempDir;

  store = (await import("../server/projects/store")).projectStore;
  authStore = (await import("../server/auth/store")).userStore;
  getTool = (await import("../server/agent/tools")).getTool;
  runDirectorAgent = (await import("../server/agent/directorAgent")).runDirectorAgent;
  buildTimelineQaReport = (await import("../server/agent/perception")).buildTimelineQaReport;
  renderTimelineFrames = (await import("../server/agent/perception")).renderTimelineFrames;
  buildExport = (await import("../server/media/export")).buildExport;
  buildCompositeArgs = (await import("../server/media/export")).buildCompositeArgs;
  AI_PRESETS = (await import("../server/ai/settings")).AI_PRESETS;
  saveAiSettings = (await import("../server/ai/settings")).saveAiSettings;
  aiChatReady = (await import("../server/ai/provider")).aiChatReady;
  chatJson = (await import("../server/ai/provider")).chatJson;
  resetAiChatCircuit = (await import("../server/ai/provider")).resetAiChatCircuit;
  handleMcpHttp = (await import("../server/mcp/handler")).handleMcpHttp;
  buildMcpServer = (await import("../server/mcp/server")).buildMcpServer;
  const skillRegistry = (await import("../server/skills/registry")).skillRegistry;
  await skillRegistry.loadAll();
});

afterAll(async () => {
  authStore?.close();
  if (originalDataDir === undefined) delete process.env.NOVACUT_DATA_DIR;
  else process.env.NOVACUT_DATA_DIR = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

const CASE1_6ACT_PROMPT = `Crea el VIDEO DE LANZAMIENTO OFICIAL de OECLIP para redes sociales, duración exacta 24 segundos en formato 9:16 (1080x1920, 30 fps).

Estructura obligatoria de 6 actos con estos tiempos y textos literales exactos:
- 0–3 s · Gancho: visual dinámico sobre el dolor del editor y texto literal "¿Tus videos tardan horas?".
- 3–8 s · Revelado de marca: red neuronal tecnológica en azul marino y cian revelando "OECLIP" y subtítulo "Estudio de Video con IA".
- 8–17 s · Demo en 3 golpes rápidos:
  · 8–11 s: "Cortes inteligentes"
  · 11–14 s: "Motion IA en Remotion"
  · 14–17 s: "Subtítulos dinámicos"
- 17–24 s · Cierre y CTA: propuesta literal "Crea contenido profesional sin plantillas rígidas" y botón destacado "Pruébalo ahora en OECLIP".

Audio y subtítulos:
Voz masculina o femenina profesional en español locutando el guion, música tecnológica con ducking automático bajo la voz, transiciones SFX sutiles y subtítulos dinámicos tipo karaoke palabra por palabra sincronizados durante todo el video.`;

async function invokeMcpRaw(options: {
  method: "POST" | "GET";
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const srv = http.createServer((req, res) => {
    void handleMcpHttp(req, res);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address() as { port: number };
  try {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    return await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/mcp",
          method: options.method,
          timeout: 3000,
          headers: {
            host: "oeclip-viwz7ywnaa-uc.a.run.app",
            "x-forwarded-proto": "https",
            accept: "application/json, text/event-stream",
            ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
            ...(options.headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          const isSse =
            options.method === "GET" &&
            String(res.headers["content-type"] ?? "").toLowerCase().includes("text/event-stream");
          res.on("data", (chunk) => {
            chunks.push(Buffer.from(chunk));
            if (isSse) {
              const out = {
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                text: Buffer.concat(chunks).toString("utf8"),
              };
              req.destroy();
              res.destroy();
              resolve(out);
            }
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("MCP HTTP request timed out")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  } finally {
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

describe("Phase 0 · Reproducción roja de incidencias I-05..I-23", () => {
  it("I-05 / I-06: MCP HTTP debe tolerar tools/list sin Mcp-Session-Id desconocido, GET SSE y initialize Accept:application/json tras rotación de instancia", async () => {
    // 1) Cliente envia initialize con Accept: application/json (sin text/event-stream)
    const initResp = await invokeMcpRaw({
      method: "POST",
      headers: { accept: "application/json" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });
    expect(initResp.statusCode).toBe(200);
    expect(initResp.text).toContain("oeclip");

    // 2) Simula un cliente que envía Mcp-Session-Id emitido por otra réplica ya reciclada
    const resp = await invokeMcpRaw({
      method: "POST",
      headers: { "mcp-session-id": "stale-replica-session-12345" },
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.text).toContain("ask_director");

    // 3) GET /mcp con Accept: text/event-stream y sesión rotada no debe devolver 405 ni 500
    const getResp = await invokeMcpRaw({
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": "stale-replica-session-12345",
      },
    });
    expect(getResp.statusCode).toBe(200);
  });

  it("I-08: Gemini preset por defecto no debe apuntar al modelo retirado gemini-2.5-flash", () => {
    const gemini = AI_PRESETS.find((p) => p.id === "gemini");
    expect(gemini).toBeDefined();
    expect(gemini?.model).not.toBe("gemini-2.5-flash");
  });

  it("I-09: Un error 404 de modelo obsoleto no debe activar circuit breaker global que bloquee la siguiente escena o proveedor", async () => {
    const origFetch = globalThis.fetch;
    resetAiChatCircuit();
    saveAiSettings({
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "test-key-invalid-404",
      model: "gemini-deprecated-test",
    });

    let calls = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      calls += 1;
      if (url.includes("/v1beta/models")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (calls <= 2) {
        return new Response(JSON.stringify({ error: { code: 404, message: "not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      try {
        await chatJson("sys", "user", new AbortController().signal);
      } catch {
        // Primer intento con modelo mock 404
      }
      // No debería haberse quedado bloqueado por circuit breaker tras un 404 de modelo
      expect(aiChatReady()).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      resetAiChatCircuit();
    }
  });

  it("I-11 / I-12 / I-13 / I-14: Director debe respetar los 6 actos por rango de tiempo, sin filtrar el prompt ni cortar guion o generar '..'", async () => {
    const saved = await store.create("Test 6 Actos", {
      ...defaultSettings(),
      aspect: "9:16",
      width: 1080,
      height: 1920,
    });

    const res = await runDirectorAgent({
      projectId: saved.project.id,
      request: CASE1_6ACT_PROMPT,
      autonomy: "assisted",
      signal: new AbortController().signal,
    });

    expect(res.storyboard.length).toBe(6);
    expect(res.storyboard.map((s) => s.startSec)).toEqual([0, 3, 8, 11, 14, 17]);
    const totalDur = res.storyboard.reduce((acc, s) => acc + s.durationSec, 0);
    expect(totalDur).toBeCloseTo(24, 1);

    for (const scene of res.storyboard) {
      expect(scene.visualPrompt.length).toBeLessThan(650);
      expect(scene.visualPrompt).not.toContain("Estructura obligatoria de 6 actos");
    }

    const allLiterals = res.storyboard.flatMap((s) => s.literalTexts);
    expect(allLiterals.some((t) => /Voz masculina|ducking automático|transiciones SFX/i.test(t))).toBe(false);

    const combinedNarration = res.storyboard.map((s) => s.narration ?? "").join(" ");
    expect(combinedNarration).not.toContain("..");
    expect(combinedNarration).toContain("Crea contenido profesional sin plantillas rígidas");
  });

  it("I-15: synthesize_voiceover con addSubtitles debe generar subtítulos karaoke palabra por palabra (<= 4 palabras por bloque)", async () => {
    const saved = await store.create("Test Subs Karaoke", {
      ...defaultSettings(),
      aspect: "9:16",
      width: 1080,
      height: 1920,
    });

    const synth = getTool("synthesize_voiceover");
    const out = await synth.execute(
      {
        projectId: saved.project.id,
        project: saved.project,
        signal: new AbortController().signal,
        setProgress: () => undefined,
      },
      {
        blocks: [
          { label: "Gancho", narration: "¿Tus videos tardan horas en editarse?", durationSec: 3 },
          { label: "Marca", narration: "Descubre OECLIP, tu Estudio de Video con IA.", durationSec: 5 },
          { label: "Cierre", narration: "Crea contenido profesional sin plantillas rígidas. Pruébalo ahora en OECLIP.", durationSec: 7 },
        ],
        language: "es",
        addSubtitles: true,
      },
    );

    const nextProj = out.project!;
    const subClips = nextProj.tracks
      .filter((t) => t.kind === "text")
      .flatMap((t) => t.clips)
      .filter((c) => c.type === "text" && (c.role === "subtitle" || c.role === "caption"));

    const remotionCaptions = subClips.flatMap((c) => {
      const caps = c.remotion?.props?.captions;
      return Array.isArray(caps) ? caps : [];
    }) as Array<{ words?: Array<{ text: string; start: number; end: number }> }>;

    expect(remotionCaptions.length).toBeGreaterThan(3);
    for (const cue of remotionCaptions) {
      expect(Array.isArray(cue.words)).toBe(true);
      expect((cue.words ?? []).length).toBeLessThanOrEqual(4);
    }
  }, 25000);

  it("I-16 / I-10: qa_report NO debe aprobar comentarios TSX falsos ni marcar passed=true cuando haya fallos de copy", async () => {
    const saved = await store.create("Fake Comment Test", {
      ...defaultSettings(),
      aspect: "9:16",
      width: 1080,
      height: 1920,
    });
    const vTrackId = saved.project.tracks.find((t) => t.kind === "video")!.id;
    const fakeClip = makeMediaClip(
      saved.project,
      {
        id: "med_motion_fake",
        name: "FakeScene",
        kind: "video",
        file: "generated/fake.mp4",
        mimeType: "video/mp4",
        sizeBytes: 0,
        durationUs: 6_000_000,
        width: 1080,
        height: 1920,
        thumbnail: "pending",
        waveform: "none",
        proxy: "none",
        importedAt: new Date().toISOString(),
        origin: "generated",
      },
      { startFrame: 0, durationFrames: 180, createdBy: "agent" },
    );
    fakeClip.remotion = {
      compositionId: "FakeComp",
      componentName: "FakeComp",
      live: true,
      code: `import React from "react";
import { AbsoluteFill } from "remotion";
export const FakeComp: React.FC = () => <AbsoluteFill><div>Solo fondo</div></AbsoluteFill>;
// Verified literal copy: "Crea contenido profesional sin plantillas rígidas"
`,
      props: { title: "Solo fondo", subtitle: "" },
    };
    const added = addClip(saved.project, vTrackId, fakeClip);
    if (!added.ok) throw new Error(added.error);

    const report = await buildTimelineQaReport(saved.project.id, added.project, {
      expectedLiterals: ["Crea contenido profesional sin plantillas rígidas"],
      targetDurationSec: 6,
    });

    const literalCheck = report.checks.find((c) => c.name === "literal_copy_present");
    expect(literalCheck?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("I-16b: renderTimelineFrames debe reflejar los colores reales del componente Remotion y no solo un rectángulo #090D18", async () => {
    const saved = await store.create("Real Render Frame Test", {
      ...defaultSettings(),
      aspect: "9:16",
      width: 1080,
      height: 1920,
    });
    const vTrackId = saved.project.tracks.find((t) => t.kind === "video")!.id;
    const clip = makeMediaClip(
      saved.project,
      {
        id: "med_motion_cyan",
        name: "CyanScreen",
        kind: "video",
        file: "generated/cyan.mp4",
        mimeType: "video/mp4",
        sizeBytes: 0,
        durationUs: 3_000_000,
        width: 1080,
        height: 1920,
        thumbnail: "pending",
        waveform: "none",
        proxy: "none",
        importedAt: new Date().toISOString(),
        origin: "generated",
      },
      { startFrame: 0, durationFrames: 90, createdBy: "agent" },
    );
    clip.remotion = {
      compositionId: "CyanStage",
      componentName: "CyanStage",
      live: true,
      code: `import React from "react";
import { AbsoluteFill } from "remotion";
export const CyanStage: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#00FFAA", justifyContent: "center", alignItems: "center" }}>
    <div style={{ fontSize: 64, color: "#000000" }}>PIXEL REAL OK</div>
  </AbsoluteFill>
);`,
      props: {}, // sin surfaceColor prop: debe renderizar #00FFAA real, no #090D18
    };
    const added = addClip(saved.project, vTrackId, clip);
    if (!added.ok) throw new Error(added.error);

    const frames = await renderTimelineFrames(saved.project.id, added.project, {
      times: [1.0],
      scale: 0.25,
      signal: new AbortController().signal,
    });
    expect(frames.frames.length).toBe(1);
    const pngBytes = await fs.readFile(frames.frames[0]!.path);
    // Verifica que no sea simplemente un PNG casi uniforme de color #090D18 sin el componente Remotion
    // Extraer muestra de un píxel verde brillante o comprobar fuente Remotion (en esta implementación actual, renderTimelineFrames jamás invoca Remotion)
    expect(frames.frames[0]).toHaveProperty("renderSource", "remotion");
    expect(pngBytes.byteLength).toBeGreaterThan(100);
  }, 60000);

  it("I-18: Calidad high debe garantizar suelo de bitrate >= 8 Mbps en argumentos de FFmpeg", async () => {
    const saved = await store.create("Bitrate Test", {
      ...defaultSettings(),
      aspect: "9:16",
      width: 1080,
      height: 1920,
    });
    const vTrackId = saved.project.tracks.find((t) => t.kind === "video")!.id;
    const dummyClip = makeMediaClip(
      saved.project,
      {
        id: "med_bitrate_dummy",
        name: "DummyMotion",
        kind: "video",
        file: "generated/dummy.mp4",
        mimeType: "video/mp4",
        sizeBytes: 0,
        durationUs: 2_000_000,
        width: 1080,
        height: 1920,
        thumbnail: "pending",
        waveform: "none",
        proxy: "none",
        importedAt: new Date().toISOString(),
        origin: "generated",
      },
      { startFrame: 0, durationFrames: 60, createdBy: "agent" },
    );
    dummyClip.remotion = {
      compositionId: "BitrateScene",
      componentName: "BitrateScene",
      live: true,
      code: `import React from "react"; import { AbsoluteFill } from "remotion"; export const BitrateScene = () => <AbsoluteFill style={{background:"#090D18"}} />;`,
      props: { title: "Bitrate" },
    };
    const withClip = addClip(saved.project, vTrackId, dummyClip);
    if (!withClip.ok) throw new Error(withClip.error);
    const settings = {
      resolution: 1080 as const,
      aspect: "9:16" as const,
      fps: 30 as const,
      quality: "high" as const,
      encoder: "cpu" as const,
      engine: "ffmpeg" as const,
      fileName: "test-bitrate.mp4",
    };

    const built = await buildExport(withClip.project, settings, {
      outputFile: path.join(tempDir, "out.mp4"),
      projectDir: path.join(tempDir, "projects", saved.project.id),
      tempDir,
      encoder: "libx264",
    });

    const joined = built.args.join(" ");
    expect(joined).toMatch(/-minrate\s+(?:8M|8000k|10M|10000k)/);

    const compositeArgs = buildCompositeArgs({
      baseFile: path.join(tempDir, "base.mp4"),
      framesDir: tempDir,
      frameCount: 30,
      settings,
      encoder: "libx264",
      outputFile: path.join(tempDir, "final.mp4"),
      durationSeconds: 1,
    });
    expect(compositeArgs.join(" ")).toMatch(/-minrate\s+(?:8M|8000k|10M|10000k)/);
  }, 60000);

  it("I-19 / I-23: Deben existir las herramientas import_media_from_url y get_run_trace", () => {
    expect(() => getTool("import_media_from_url")).not.toThrow();
    expect(() => getTool("get_run_trace")).not.toThrow();
  });

  it("I-21: Todas las skills deben estar alineadas con los parámetros reales de las tools", async () => {
    const reelSkill = await fs.readFile(path.join(process.cwd(), "skills", "reel-corporativo", "SKILL.md"), "utf8");
    expect(reelSkill).not.toMatch(/change_aspect_ratio.*aspectRatio/);
    const customMotion = getTool("execute_custom_motion");
    const validKeys = new Set(Object.keys((customMotion.argsSchema as { shape?: Record<string, unknown> }).shape ?? {}));
    expect(validKeys.has("literalTexts") || !reelSkill.includes("literalTexts")).toBe(true);
  });
});
