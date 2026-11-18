# OECLIP · Estudio de Video con IA en la Nube

Plataforma web y servidor agéntico (**Model Context Protocol · MCP**) para crear, editar, subtitular, animar y exportar video MP4 real con **FFmpeg**, **Remotion 4**, **Whisper ONNX** y un **Agente Director autónomo**, lista para ejecutarse en local o desplegarse en contenedor sobre **Google Cloud Run**.

---

## Arquitectura y Capacidades Principales

- **Interfaz Studio Web (React 19 + Vite + Tailwind CSS)**:
  - Visor multipista en tiempo real basado en `<canvas>` y capas en vivo de **Remotion**, línea de tiempo interactiva multipista (`V1`, `A1`, `SFX`, `T1`, overlays) con ondas de audio, recortes, división, velocidad, zoom por keyframes y filtros visuales.
  - Paneles integrados de **IA Motion Studio**, **Inspector**, **15 Skills modulares** (`skills/*/SKILL.md` + soporte para carga por `.zip`), **Historial / Snapshots** y autosave atómico con control optimista de revisiones (`409 revision_conflict`).
- **Autenticación Multi-usuario y Gobernanza SQLite (`server/auth/store.ts`)**:
  - Registro/inicio de sesión con hash `scrypt` + sal aleatoria, sesiones seguras (`oeclip_token` en cookie `HttpOnly` / Bearer), perfil editable (`PATCH /api/auth/me`) con conservación automática de proyectos y claves al cambiar de `@usuario`, y panel administrativo exclusivo para rol `admin` (`/api/admin/users*`).
  - Aislamiento estricto por creador en proyectos (`project_owners`) y tokens IA **BYOK** (*Bring Your Own Key*) en SQLite (`user_ai_settings`).
- **Agente Director Autónomo y Motor Remotion (`server/agent/`, `server/motion-agent/`)**:
  - **72 herramientas tipadas** en `server/agent/tools.ts`, guardas AST (`code-guard.ts`), pool de renderizado con worker threads (`RenderWorkerPool`) y ajuste seguro de concurrencia (`computeSafeRemotionConcurrency`).
  - Inspección visual en bucle cerrado (`visionInspector.ts`), captura de identidad de marca (`brandCapture.ts`), locución multiproveedor (`OpenAI TTS`, `edge-tts`, `espeak-ng`, procedural), mezcla con ducking musical (`audioDirector.ts`), SFX embebidos y subtítulos karaoke palabra por palabra con **Whisper local ONNX** (`onnx-community/whisper-base`).
- **Servidor MCP Dual (`stdio` + `StreamableHTTP` en `/mcp`)**:
  - Expone **26 herramientas MCP** para conectar clientes como Claude Desktop, Claude Code o SDKs compatibles mediante HTTPS, incluyendo enlaces de descarga firmados con **HMAC-SHA256** (`/api/downloads/:token/:fileName`).
- **Exportación MP4 Verificada (`server/services/exportService.ts`)**:
  - Compone FFmpeg (`libx264`/AAC o `h264_nvenc` con repliegue automático a CPU) + secuencia PNG alfa de Remotion y valida la salida con **FFprobe** antes de publicarla.

---

## Requisitos Locales

- **Node.js >= 22.12** y npm 10+
- **FFmpeg y FFprobe** disponibles en `PATH` (o configurados en `.env`)
- Navegador web moderno (Chrome / Edge / Firefox / Safari)

---

## Instalación y Ejecución Local

```bash
npm install
npm run demo      # opcional: genera un proyecto de demostración con medios reales
npm run dev       # modo desarrollo (Vite + API Fastify)
```

Para compilar y arrancar en modo producción local:

```bash
npm run build
npm start
```

Comandos de verificación y pruebas:

```bash
npm run typecheck # verificación TypeScript (tsc --noEmit)
npm test          # suite Vitest (13 archivos, 148 pruebas)
npm run mcp:check # smoke test del servidor MCP
```

---

## Despliegue en Google Cloud Run

El proyecto incluye contenedor de producción (`Dockerfile`) basado en `node:22-bookworm-slim` con `ffmpeg`, `chromium`, `espeak-ng`, `edge-tts` y fuentes tipográficas, además de scripts reproducibles para **Google Cloud Platform**:

- PowerShell (Windows): `scripts/deploy-gcp.ps1`
- Bash (Linux / macOS / Cloud Shell): `scripts/deploy-gcp.sh`

### Despliegue rápido con `gcloud`

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-gcp.ps1
```

O manualmente mediante CLI:

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com storage.googleapis.com

gcloud storage buckets create gs://oeclip-data-604825376915 \
  --location=us-central1 \
  --uniform-bucket-level-access

gcloud run deploy oeclip \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 4 \
  --memory 8Gi \
  --min-instances 1 \
  --timeout 3600 \
  --execution-environment gen2 \
  --add-volume name=oeclip-data,type=cloud-storage,bucket=oeclip-data-604825376915 \
  --add-volume-mount volume=oeclip-data,mount-path=/app/data \
  --update-env-vars NODE_ENV=production,NOVACUT_HOST=0.0.0.0,NOVACUT_ENCODER=cpu
```

> **Arquitectura Cloud FUSE:** En producción (`NODE_ENV=production`), la base de datos SQLite activa se ejecuta sobre disco efímero rápido (`/tmp/oeclip-sqlite`) con sincronización atómica hacia `/app/data/oeclip.db` en Cloud Storage, y los archivos temporales de render MP4 se generan en `/tmp/oeclip-tmp` antes de copiarse al bucket persistente.

---

## Estructura del Repositorio

```text
server/            Backend Fastify, rutas REST/SSE, SQLite Auth/BYOK, agente director, worker Remotion y servidor MCP
src/               Frontend React 19 + modelo Zod compartido, editor multipista y componentes UI
skills/            15 skills nativas versionadas en formato SKILL.md (YAML + Markdown)
public/            Favicon vectorial OECLIP y efectos de sonido embebidos (ding.wav, pop.wav, whoosh.wav)
assets/fonts/      Tipografías abiertas empaquetadas (OFL 1.1: Inter, Grandstander, Anton, Bebas Neue, Playfair Display, Space Grotesk)
scripts/           Scripts de despliegue Cloud Run, diagnóstico MCP, demo y utilidades
tests/             Suite automatizada Vitest (exportación FFmpeg, Remotion, agente, autenticación y aislamiento)
Dockerfile         Imagen de producción multi-motor (Node 22 + FFmpeg + Chromium + edge-tts)
```

---

## Documentación Técnica

- [Arquitectura del sistema](docs/architecture.md)
- [Despliegue y arquitectura en Google Cloud Run](docs/cloud-run.md)
- [Agente de IA, Motion Studio, Skills y Audio](docs/ai.md)
- [Servidor MCP (`stdio` y `StreamableHTTP`)](docs/mcp.md)
- [Limitaciones conocidas y alcance](docs/limitations.md)

## Enlaces del Proyecto

- **Repositorio oficial:** https://github.com/lindlabs/oeclip
- **Aplicación en producción (Cloud Run):** https://oeclip-viwz7ywnaa-uc.a.run.app
- **Endpoint MCP público:** https://oeclip-viwz7ywnaa-uc.a.run.app/mcp

## Variables de Entorno

Consulta `.env.example` para ver todas las variables soportadas (`PORT`, `NOVACUT_DATA_DIR`, `NOVACUT_TMP_DIR`, `OECLIP_ADMIN_HANDLES`, `NOVACUT_MCP_TOKEN`, `NOVACUT_AI_*`, `NOVACUT_ENCODER`, `NOVACUT_MAX_UPLOAD_MB`). No incluyas claves reales ni `.env` en el repositorio.
