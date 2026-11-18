# Despliegue y Arquitectura en Google Cloud Run (`OECLIP`)

Esta guía documenta la configuración exacta en producción de **OECLIP** sobre **Google Cloud Platform (GCP)**.

---

## 1. Especificaciones de Producción Verificadas

| Recurso GCP | Identificador / Configuración Real |
|---|---|
| **Proyecto** | `gen-lang-client-0787787872` |
| **Región** | `us-central1` (Iowa) |
| **Servicio Cloud Run** | `oeclip` (`execution-environment: gen2`, `startup-cpu-boost: true`) |
| **URL pública HTTPS** | `https://oeclip-viwz7ywnaa-uc.a.run.app` |
| **Endpoint MCP HTTP** | `https://oeclip-viwz7ywnaa-uc.a.run.app/mcp` |
| **Cómputo y Escalado** | `4 vCPU` · `8 GiB RAM` · `min-instances: 1` · `max-instances: 10` · `containerConcurrency: 160` · `timeout: 3600s` |
| **Almacenamiento Persistente** | Bucket Cloud Storage Standard `gs://oeclip-data-604825376915` montado vía FUSE en `/app/data` (con `soft_delete_policy` de 7 días y `uniform-bucket-level-access`) |
| **Cuenta de Servicio** | `604825376915-compute@developer.gserviceaccount.com` |
| **Contenedor** | `node:22-bookworm-slim` + FFmpeg + Chromium + `espeak-ng` + `edge-tts` + fuentes OFL |

---

## 2. Separación FUSE (`/app/data`) vs Disco Rápido (`/tmp`)

Para lograr alto rendimiento y cero corrupción en contenedores serverless:
1. **Base de datos SQLite (`server/auth/store.ts`)**: El archivo maestro `oeclip.db` reside en `/app/data` (Cloud Storage), pero las consultas y escrituras operan sobre una copia en `/tmp/oeclip-sqlite/`, sincronizando atómicamente (`copyFileSync` → `renameSync`) tras cada mutación.
2. **Temporales de Render (`server/config.ts`)**: En `NODE_ENV=production`, `resolveTmpDir()` apunta a `/tmp/oeclip-tmp`, evitando realizar *seeks* aleatorios de FFmpeg o miles de frames PNG de Remotion sobre FUSE. Solo el MP4 final verificado se copia a `/app/data/projects/<id>/exports/`.
3. **Limpieza automática (`server/index.ts`, `exportService.ts`)**: `recoverInterruptedExports()` desbloquea trabajos huérfanos tras un reinicio, y `pruneStaleTempDirs()` elimina temporales mayores a 30 minutos / 2 horas sin afectar renders concurrentes.

---

## 3. Comandos Reproducibles de Despliegue

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts/deploy-gcp.ps1
```

```bash
# Linux / macOS / Cloud Shell
bash scripts/deploy-gcp.sh
```

Para reducir costos en entornos de desarrollo o bajas visitas, se puede escalar a cero fuera de horario de demostración pasando `--min-instances 0`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-gcp.ps1 -MinInstances 0
```

---

## 4. Verificación Post-Despliegue

- **Salud y motores:** `GET https://oeclip-viwz7ywnaa-uc.a.run.app/api/health`
- **Seguridad:**
  - `GET /api/auth/users` → `403` (listado público bloqueado)
  - `GET /api/admin/users` sin sesión admin → `401`
  - `PATCH /api/auth/me` sin sesión → `401`
- **Smoke Test MCP HTTP:**
  ```powershell
  $env:NOVACUT_MCP_URL = "https://oeclip-viwz7ywnaa-uc.a.run.app/mcp"
  npm run mcp:check:http
  ```
