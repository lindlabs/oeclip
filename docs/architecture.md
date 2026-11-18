# Arquitectura de OECLIP

**OECLIP** es una plataforma web y servidor agéntico de edición de video modular construido con **React 19 + TypeScript** en el frontend y **Fastify 5 + Node.js 22** en el backend, integrando **FFmpeg/FFprobe**, **Remotion 4 + Chromium headless**, **Whisper ONNX**, **SQLite** y el protocolo **MCP (`Model Context Protocol`)**. Funciona tanto en desarrollo/uso local como desplegada en contenedores serverless sobre **Google Cloud Run** con persistencia en **Cloud Storage**.

```text
Navegador Web (React 19 SPA)                    Cliente Externo MCP (Claude, CLI, SDK)
  ├─ Canvas Viewer + RemotionLiveOverlay           └─ StreamableHTTP / stdio (/mcp)
  ├─ Timeline Multipista + Skills + AI Motion                 │
  ├─ Autosave (baseRevision) + SSE /api/events                ▼
  └──────────────────────────────────────────────► Servidor Fastify (Puerto 8080 Cloud / 4331 Local)
                                                     ├─ Hook Auth (`onRequest`) + AsyncLocalStorage (BYOK / User)
                                                     ├─ AuthStore (SQLite `oeclip.db` en /tmp + sync atómica a /app/data)
                                                     ├─ ProjectStore (`project.json`, `history/`, `media/`, `exports/`)
                                                     ├─ SkillRegistry (15 skills nativas `skills/*/SKILL.md` + ZIP)
                                                     ├─ JobQueue (máx. 2 renders concurrentes + SSE progreso)
                                                     ├─ RenderWorkerPool (esbuild + AST code-guard + Remotion/Chromium)
                                                     ├─ Agent Director + Swarm + VisionInspector + AudioDirector
                                                     └─ ExportService (`libx264`/NVENC + FFprobe verify + HMAC Downloads)
                                                               │
                                                               ▼
                                                     Bucket Cloud Storage (montado por FUSE en `/app/data`)
```

---

## Decisiones de Arquitectura

### 1. Monolito Modular Node 22 + Fastify 5
- Un único proceso Node.js sirve la SPA compilada (`dist/`), los **76 endpoints REST/SSE**, los webhooks/streams y el servidor **MCP (`/mcp`)** mediante `reply.hijack()`.
- Las cabeceras HTTP de caché están diferenciadas en `server/app.ts`: `index.html` fuerza `no-cache, no-store, must-revalidate` para reflejar despliegues recientes al instante, mientras `/assets/*` (con hash de Vite) se cachean como inmutables por 1 año.

### 2. Autenticación Multi-usuario, Roles y Aislamiento (`server/auth/store.ts`)
- Base de datos **SQLite** nativa (`node:sqlite`, modo `DELETE`, `PRAGMA foreign_keys = ON`):
  - `users`: `id`, `handle` único, `display_name`, `email`, `password_hash` (`crypto.scryptSync` + sal aleatoria de 16 bytes + `timingSafeEqual`), `avatar_color`, `role` (`"admin"` o `"user"`), `disabled` (0/1).
  - `sessions`: hashes SHA-256 de tokens (`oeclip_token` en cookie `HttpOnly` o `Authorization: Bearer`).
  - `project_owners`: asociación estricta `project_id -> user_id / user_handle / session_id` para aislar los montajes entre cuentas.
  - `user_ai_settings`: configuración y API key BYOK persistente por usuario, sobreviviente a cierres de sesión, cambios de dispositivo y cambio de `@handle` (`updateSelfProfile`).
- Seguridad en red:
  - El listado público `GET /api/auth/users` está bloqueado con **HTTP 403**.
  - Los endpoints administrativos (`/api/admin/users*`) exigen `role === "admin"` (`requireAdmin`).
  - `PATCH /api/auth/me` permite editar `displayName`, `handle`, `email` y contraseña propia (validando `currentPassword`), bloqueando cualquier auto-escalación de `role` o `disabled`.

### 3. Persistencia Híbrida sobre Cloud Storage FUSE (`/app/data` vs `/tmp`)
En Google Cloud Run, `/app/data` apunta al bucket **Cloud Storage** montado mediante **Cloud Storage FUSE**, el cual presenta latencia elevada y no soporta bloqueos POSIX WAL ni *seeks* aleatorios fiables para escritura MP4 directa. Para resolverlo:
- **`SqliteAuthStore`**: abre una copia de trabajo rápida en `os.tmpdir()/oeclip-sqlite/oeclip-<hash>.db` con `PRAGMA journal_mode = DELETE`, y tras cada escritura llama a `syncToPersistent()` copiando a archivo temporal `.tmp` y realizando `renameSync` atómico hacia `/app/data/oeclip.db`.
- **`resolveTmpDir()` (`server/config.ts`)**: en `NODE_ENV=production`, FFmpeg, Remotion y los frames PNG intermedios escriben exclusivamente en `/tmp/oeclip-tmp`. Solo el MP4 final ya verificado por **FFprobe** se mueve al bucket persistente.

### 4. Estado Canónico del Proyecto y Modelo Zod (`src/shared/`)
`server/projects/store.ts` es la fuente de verdad de cada proyecto:
- Guardado atómico en `project.json` con `baseRevision`: si otro cliente/agente modificó el proyecto, devuelve **HTTP 409 `revision_conflict`**.
- Sidecars separados (`exports.json`, `agent.json`, `history/` snapshots y `trash/`).
- Contratos Zod compartidos en `src/shared/schema.ts` y operaciones puras de timeline en `src/shared/timeline.ts` utilizadas por React, el backend y el agente.

### 5. Motores de Previsualización, Remotion y Exportación (`server/media/`, `server/motion-agent/`, `server/services/`)
- **Previsualización Web (`Viewer.tsx`)**: Composición en `<canvas>` + elementos `HTMLVideoElement` / `HTMLAudioElement` sincronizados + `RemotionLiveOverlay.tsx` para componentes TSX en tiempo real.
- **Motor Remotion (`server/media/remotion.ts`, `server/motion-agent/worker/pool.ts`)**:
  - Pool controlado de workers (`RenderWorkerPool`) usando Chromium headless (`/usr/bin/chromium` en contenedor Linux) y `esbuild`.
  - **AST Code Guard (`code-guard.ts`)**: restringe imports únicamente a `react`, `react/jsx-runtime` y `remotion` antes de compilar componentes generados por IA.
  - **Concurrencia segura (`computeSafeRemotionConcurrency`)**: calcula dinámicamente el número de pestañas Chromium permisibles según vCPU (`nproc`, `availableParallelism`) y memoria libre (`freeMemGb / 0.6`), evitando errores `Maximum for --concurrency`.
- **Exportación (`exportService.ts`)**:
  - Cola de trabajos (`server/jobs.ts`) limitada a **2 trabajos simultáneos por instancia** con `AbortController`, progreso vía **SSE** (`/api/events`) y recuperación al inicio (`recoverInterruptedExports()`).
  - Filtro complejo FFmpeg (`overlay`, `zoompan`, `amix` + `alimiter`, `highpass`/compresor, quemado de subtítulos `.ass` vía `libass` o `drawtext` con fuentes OFL empaquetadas).
  - Codificador `libx264` o `h264_nvenc` (con repliegue automático a CPU) + validación obligatoria con **FFprobe** y enlaces de descarga temporales firmados con **HMAC-SHA256** (`downloadTokenService.ts`).

### 6. Agente Director, Visión, Audio, Skills y MCP
- **Catálogo de Agente**: **72 herramientas** en `server/agent/tools.ts`, incluyendo `directorAgent.ts`, `swarmDirector.ts`, `swarmResearcher.ts` y `brandCapture.ts`.
- **Inspección Visual (`visionInspector.ts`)**: Extracción de *keyframes* JPEG (`480px`) y hojas de contacto (`contact_sheet`) para control de calidad visual en bucle cerrado (`VLM`), evitando entregas con fallos silenciosos (`literal_copy_present`, `no_internal_clip_label_leak`).
- **Audio y Voz**: Locución en cascada (`OpenAI TTS` → `edge-tts` → `piper` → `espeak-ng` → SAPI/Say → procedural), música con ducking automático (`audioDirector.ts`), efectos (`public/sfx/ding.wav`, `pop.wav`, `whoosh.wav`) y transcripción local con **Whisper ONNX** (`@huggingface/transformers`, `onnx-community/whisper-base`).
- **15 Skills nativas (`skills/*/SKILL.md`)** + subida de paquetes `.zip` (`POST /api/skills/upload`) y creación en caliente (`create_skill`).
- **Servidor MCP Dual**: **26 herramientas** en `server/mcp/server.ts` accesibles vía `stdio` y `StreamableHTTP` (`/mcp`).

---

## Pruebas Automatizadas (`tests/`)

El repositorio cuenta con **13 suites** en Vitest (`148` pruebas verificadas):
- `tests/store.test.ts`: persistencia SQLite `oeclip.db`, aislamiento de proyectos por creador, bloqueo `403` de `/api/auth/users`, persistencia BYOK de tokens IA, panel admin `/api/admin/users*`, autoedición `PATCH /api/auth/me`, snapshots y conflictos de revisión.
- `tests/export.test.ts`: renders FFmpeg reales H.264/AAC y verificación FFprobe.
- `tests/remotion.test.ts` y `tests/motion-code-guard.test.ts`: render Remotion y sanitización de componentes TSX.
- `tests/agent.test.ts`, `tests/autonomous-editor.test.ts`, `tests/freeform-editing.test.ts`, `tests/zero-template-studio.test.ts`, `tests/phase0-repro-incidents.test.ts`, `tests/prompt-maestro-v2.test.ts`, `tests/golden-case1-acceptance.test.ts`, `tests/phase2-studio.test.ts`, `tests/shared.test.ts`.
