# MCP: Conectar OECLIP con Claude, Gemini, Cursor y Clientes Remotos

**OECLIP** implementa un **servidor Model Context Protocol (`@modelcontextprotocol/sdk`)** con **26 herramientas** reales que permiten listar proyectos, importar medios por ruta local o URL, ejecutar al **Agente Director Autónomo**, inspeccionar fotogramas renderizados, gestionar skills, exportar MP4 H.264/AAC y obtener enlaces de descarga firmados.

---

## Formas de Conexión

| Transporte | URL / Entrada | Cuándo usarlo |
|---|---|---|
| **HTTP en Cloud Run (Producción)** | `https://oeclip-viwz7ywnaa-uc.a.run.app/mcp` | Conectores remotos en Claude Desktop, Claude Web, Claude Code, Gemini o SDKs MCP sobre HTTPS (`StreamableHTTP`). |
| **HTTP Local** | `http://127.0.0.1:4331/mcp` (o puerto `4332` con `npm run mcp:http`) | Pruebas locales cuando ejecutas `npm start`. |
| **stdio (Local)** | `node .../tsx/dist/cli.mjs .../server/mcp/stdio.ts` | Clientes locales de escritorio que lanzan el proceso directamente. |

### Generar configuración y verificar conexión

```bash
npm run mcp:config       # genera JSON stdio para Claude Desktop / Gemini CLI
npm run mcp:config:http  # muestra URL HTTP y comando para Claude Code
npm run mcp:check        # prueba herramientas y listado en modo stdio
npm run mcp:check:http   # prueba endpoint StreamableHTTP (acepta NOVACUT_MCP_URL)
npm run mcp:check:full   # prueba extremo a extremo incluyendo exportación MP4
```

Para comprobar el despliegue en vivo en Cloud Run:

```powershell
$env:NOVACUT_MCP_URL = "https://oeclip-viwz7ywnaa-uc.a.run.app/mcp"
npm run mcp:check:http
```

---

## Conectar desde Claude / ChatGPT / CLI

### Claude Code / Claude Web (HTTP remoto en Cloud Run)

```bash
claude mcp add --transport http oeclip https://oeclip-viwz7ywnaa-uc.a.run.app/mcp
```

Para vincular el acceso MCP a una cuenta específica de **OECLIP** o protegerlo con token de sesión/MCP:
- Por query o cabecera Bearer de usuario (`tok_...`): `https://oeclip-viwz7ywnaa-uc.a.run.app/mcp?token=tok_...` o `Authorization: Bearer tok_...`.
- Por handle explícito (en entornos de confianza): `https://oeclip-viwz7ywnaa-uc.a.run.app/mcp?user=<tu_usuario>`.
- Con token de servidor compartido: configura `NOVACUT_MCP_TOKEN` en el entorno del servidor y envíalo como `Authorization: Bearer <token>`.

### Claude Desktop (stdio local)

Copia la salida de `npm run mcp:config` en `%APPDATA%\Claude\claude_desktop_config.json` (Windows) o `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "oeclip": {
      "command": "node",
      "args": [
        "D:/OECLIP/node_modules/tsx/dist/cli.mjs",
        "D:/OECLIP/server/mcp/stdio.ts"
      ],
      "cwd": "D:/OECLIP",
      "env": { "NOVACUT_API_URL": "http://127.0.0.1:4331" }
    }
  }
}
```

---

## Catálogo de 26 Herramientas MCP (`server/mcp/server.ts`)

| Categoría | Herramientas registradas |
|---|---|
| **Proyectos e Importación** | `list_projects`, `get_project`, `create_project`, `add_media`, `import_media_from_url` |
| **Edición y Agente Autónomo** | `ask_director`, `plan_edit`, `apply_edit`, `list_tools`, `run_tool` |
| **Inspección Visual y Trazas** | `render_frames`, `contact_sheet`, `inspect_frame`, `qa_report`, `get_run_trace` |
| **Skills Modulares** | `list_skills`, `get_skill`, `create_skill` |
| **Exportación, Descargas y Jobs** | `export_video`, `verify_export`, `list_exports`, `list_jobs`, `get_job`, `cancel_job` |
| **Estado y Capacidades** | `get_capabilities`, `get_ai_status` |

> **Descargas remotas desde Cloud Run:** Al terminar `export_video`, OECLIP genera URLs firmadas con HMAC-SHA256 (`/api/downloads/:token/:fileName`, vigencia por defecto `24 h`) usando el origen HTTPS público detectado por proxy inverso (`resolvePublicBaseUrl`), permitiendo descargar el MP4 directamente sin abrir sesiones de cookies.

---

## Seguridad y Aislamiento MCP

- Cada petición HTTP en `/mcp` se ejecuta bajo `AsyncLocalStorage` (`runWithMcpRequestAuth`), aislando el usuario autenticado, sus proyectos y su configuración BYOK en SQLite.
- `add_media` solo lee archivos locales existentes en la máquina donde corre el servidor (`import_media_from_url` permite importar recursos remotos vía HTTP/HTTPS en entornos cloud).
- Las sesiones HTTP activas de `StreamableHTTPServerTransport` residen en memoria por instancia; tras un despliegue o reinicio del contenedor, el cliente MCP debe reinicializar la sesión (`initialize`).
