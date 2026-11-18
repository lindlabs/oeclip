import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "http" ? "http" : "stdio";
const token = process.env.NOVACUT_MCP_TOKEN?.trim();

function textOf(result) {
  const content = result?.content ?? [];
  const text = content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`El tool no devolvió texto: ${JSON.stringify(result).slice(0, 500)}`);
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let transport;
if (mode === "stdio") {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "server/mcp/stdio.ts"],
    cwd: root,
    env: { ...process.env, NOVACUT_LOG_LEVEL: "error" },
    stderr: "pipe",
  });
} else {
  const url = new URL(process.env.NOVACUT_MCP_URL?.trim() || "http://127.0.0.1:4332/mcp");
  transport = new StreamableHTTPClientTransport(url, {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
}

const client = new Client({ name: "oeclip-smoke", version: "0.1.0" });
const started = Date.now();
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  console.log(`[${mode}] conectado en ${Date.now() - started} ms · ${names.length} herramientas`);
  console.log(`[${mode}] tools: ${names.join(", ")}`);
  for (const required of ["list_projects", "get_project", "plan_edit", "apply_edit", "run_tool", "export_video", "verify_export"]) {
    assert(names.includes(required), `Falta la herramienta ${required}`);
  }

  const status = textOf(await client.callTool({ name: "get_ai_status", arguments: {} }));
  console.log(`[${mode}] IA: configured=${status.configured} model=${status.model} transcribe=${status.transcribe}`);

  const projects = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
  console.log(`[${mode}] proyectos: ${projects.count}`);
  assert(projects.count > 0, "No hay proyectos para probar; crea uno con la app o el tool create_project.");
  const projectId = projects.projects[0].id;

  const project = textOf(await client.callTool({ name: "get_project", arguments: { project_id: projectId } }));
  console.log(`[${mode}] proyecto ${projectId}: ${project.tracks.length} pistas, ${project.media.length} medios, ${project.durationFrames} frames`);
  assert(project.id === projectId, "get_project devolvió otro proyecto");

  const media = project.media[0];
  if (media) {
    const inspected = textOf(
      await client.callTool({ name: "run_tool", arguments: { project_id: projectId, tool: "inspect_media", args: { mediaId: media.id } } }),
    );
    console.log(`[${mode}] run_tool inspect_media: ${inspected.summary}`);
  }

  const planned = textOf(
    await client.callTool({
      name: "plan_edit",
      arguments: { project_id: projectId, instruction: "Cambia el formato a vertical 9:16", prefer_local: true },
    }),
  );
  console.log(`[${mode}] plan_edit: ${planned.steps.length} pasos (${planned.source})`);
  assert(planned.plan_id, "plan_edit no devolvió plan_id");

  if (process.argv.includes("--full")) {
    const fixture = path.join(root, "fixtures", "camara-a.mp4");
    const created = textOf(
      await client.callTool({
        name: "create_project",
        arguments: { name: `MCP smoke ${new Date().toISOString().slice(0, 19)}`, aspect: "16:9", height: 720, fps: 30 },
      }),
    );
    console.log(`[${mode}] create_project: ${created.id}`);
    const imported = textOf(
      await client.callTool({ name: "add_media", arguments: { project_id: created.id, path: fixture } }),
    );
    console.log(`[${mode}] add_media: ${imported.imported.name} (${imported.imported.id})`);
    const placed = textOf(
      await client.callTool({
        name: "run_tool",
        arguments: {
          project_id: created.id,
          tool: "add_media_to_timeline",
          args: { mediaId: imported.imported.id, startSeconds: 0 },
        },
      }),
    );
    console.log(`[${mode}] add_media_to_timeline: ${placed.summary}`);

    const exported = textOf(
      await client.callTool({
        name: "export_video",
        arguments: { project_id: created.id, resolution: 720, quality: "draft", wait_seconds: 600 },
      }),
    );
    console.log(`[${mode}] export_video: ${exported.status} ${exported.file_name} job=${exported.job.status}`);
    assert(exported.status === "done", `La exportación no terminó: ${exported.job.error ?? exported.status}`);

    const verified = textOf(
      await client.callTool({
        name: "verify_export",
        arguments: { project_id: created.id, export_id: exported.export_id },
      }),
    );
    console.log(`[${mode}] verify_export: ${JSON.stringify(verified.verification)}`);
    assert(verified.verification?.valid === true, "La verificación del MP4 falló");
    console.log(`[${mode}] FULL_OK project=${created.id} export=${exported.export_id}`);
  }

  console.log(`[${mode}] OK`);
} catch (error) {
  console.error(`[${mode}] FALLO:`, error);
  if (mode === "stdio" && transport.stderr) {
    console.error("[stdio stderr]", String(transport.stderr).slice(-2000));
  }
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
