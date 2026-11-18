# Limitaciones Conocidas y Alcance Actual de OECLIP

**OECLIP** es una plataforma de edición y generación audiovisual con IA funcional y verificada, optimizada para contenido social, reels, anuncios, tutoriales y automatización vía agentes. Esta guía resume su alcance real vigente para operar con transparencia en producción.

---

## 1. Alcance del Editor Multipista
- **No sustituye una suite NLE cinematográfica completa:** No incluye nodos de etalonaje/LUTs avanzados, composición 3D multicámara, seguimiento óptico de máscaras vectoriales ni importación/exportación XML/EDL/AAF/FCPXML.
- **Formato de salida:** Exportación estandarizada a **MP4 (H.264 / `yuv420p` 8-bit SDR + AAC 192 kbps 48 kHz estéreo)** para máxima compatibilidad en web y redes sociales (`24, 25, 30, 50, 60 fps`). No exporta ProRes, AV1 ni video 10-bit HDR.
- **Keyframes de movimiento y zoom:** Soporta keyframes de escala y posición interpolados tanto en el visor `<canvas>` como en `zoompan` de FFmpeg, además de animaciones y componentes **Remotion TSX** completos; en encuadres extremos sobre clips de baja resolución (ej. `640×360` escalados a `1080p`), la calidad depende del material original (sin superresolución IA).

---

## 2. Entorno Cloud Run y Persistencia
- **Almacenamiento SQLite sobre Cloud Storage FUSE:** Para evitar corrupciones de bloqueos WAL y baja velocidad en FUSE (`/app/data`), cada instancia mantiene copia de trabajo SQLite en `/tmp` sincronizada atómicamente tras cada escritura hacia `/app/data/oeclip.db`. Este diseño es sólido para una o pocas instancias cálidas; bajo escala masiva multi-réplica concurrente con escrituras simultáneas intensivas se recomienda migrar la tabla relacional a **Cloud SQL (PostgreSQL)**.
- **Sesiones SSE / MCP en memoria:** Los streams activos de `/api/events` y sesiones de transporte `/mcp` viven en la memoria RAM del contenedor activo; ante un despliegue de nueva revisión o reciclado de instancia, el navegador y los clientes MCP reconectan automáticamente.
- **Renderizado por CPU en Cloud Run:** Las instancias estándar de Cloud Run (`gen2`, `4 vCPU / 8 GiB`) operan sin GPU NVIDIA, por lo que `exportService` utiliza `libx264` y Chromium software rendering (`NOVACUT_ENCODER=cpu`). En local con GPU NVIDIA activa se habilita `h264_nvenc` con repliegue automático a CPU.
- **Cola de trabajos acotada:** `JobQueue` limita a **2 trabajos pesados concurrentes** por instancia y `computeSafeRemotionConcurrency` restringe los hilos de Chromium según vCPU y memoria libre disponible para prevenir errores de memoria (`OOM`).

---

## 3. Inteligencia Artificial y Transcripción
- **Modelo BYOK (*Bring Your Own Key*):** Las funciones de LLM, generación TSX libre y control visual con VLM dependen de la clave del proveedor configurada por cada usuario (**Google Gemini**, **Groq**, **NVIDIA NIM**, **OpenAI**, **OpenRouter** o **Ollama**). Sin clave externa funciona el planificador determinista local, TTS local/edge y Whisper ONNX.
- **Cifrado de claves en repositorio:** Las claves BYOK de usuario nunca regresan completas al navegador (`hasApiKey` + `keyHint`), pero se almacenan en `user_ai_settings` dentro del volumen persistente del bucket controlado por IAM de GCP (permisos de bucket privados uniformes, sin KMS adicional por campo).
- **Transcripción Whisper ONNX local:** Se procesa en bloques de 5 minutos en mono 16 kHz directamente en CPU cuando el proveedor LLM no implementa `/audio/transcriptions`. No realiza diarización multipersona (*speaker diarization*) y en Cloud Run la primera descarga del modelo `onnx-community/whisper-base` se almacena en `/app/data/models`.

---

## 4. Pruebas y Localización
- La suite de **13 archivos (`148` pruebas)** valida contratos compartidos, FFmpeg, FFprobe, Remotion, AST Code Guard, Agente Director, SQLite Auth, perfiles, administración y BYOK, pero no reemplaza pruebas manuales en todos los códecs exóticos del mercado ni auditoría WCAG completa con lector de pantalla.
- La interfaz gráfica principal y prompts de planificador local están centrados en **español**.
