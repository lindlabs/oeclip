# Agente de IA, Motion Studio, Skills y Audio en OECLIP

**OECLIP** integra un sistema agéntico multimodal que convierte instrucciones en lenguaje natural en ediciones multipista reales, componentes animados TSX/Remotion, locución IA, música, efectos de sonido y exportaciones MP4 verificadas. Nunca ejecuta comandos de shell arbitrarios: todas las acciones pasan por herramientas registradas con esquemas **Zod**.

---

## Modos de Inteligencia

### 1. Planificador Local Determinista (sin red ni API Key)
Reconoce intenciones en español mediante reglas exactas y funciona incluso sin clave externa (`server/agent/planner.ts`):
- Detección y corte de silencios (`silencedetect`), ajuste de duración, selección de destacados por energía de audio (`find_highlights`).
- Cambio de formato (`9:16`, `16:9`, `1:1`, `4:5`, `21:9`), mejora de voz (`highpass` + compresor + reducción de ruido), ajuste de volumen y keyframes de zoom.
- Generación de subtítulos sincronizados con **Whisper ONNX local** (`onnx-community/whisper-base`) dentro del propio servidor.
- Exportación MP4 verificada en segundo plano (`480p`, `720p`, `1080p`, `1440p`, `2160p`).

### 2. Agente Director Autónomo y LLM (BYOK Multi-proveedor)
Con una clave configurada por el creador (**BYOK — *Bring Your Own Key***), **OECLIP** desbloquea el planificador LLM, el **Agente Director (`ask_director`)**, **AI Motion Studio** y **Swarm Director**:

| Proveedor | Endpoint base | Modelo por defecto | Transcripción API |
|---|---|---|---|
| **Google Gemini (gratis)** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | Fallback Whisper local |
| **Groq (gratis + Whisper)** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `whisper-large-v3-turbo` |
| **NVIDIA NIM (gratis)** | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.3-70b-instruct` | Fallback Whisper local |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | `whisper-1` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | Modelos OpenAI-compatible | Fallback Whisper local |
| **Ollama / LM Studio (local)** | `http://127.0.0.1:11434/v1` | `llama3.2` u otro local | Fallback Whisper local |

> **Persistencia segura BYOK por usuario (`user_ai_settings`):** La clave de cada usuario se almacena vinculada a su cuenta en SQLite (`/app/data/oeclip.db`), persiste entre cierres de sesión y cambios de `@handle`, y jamás se expone completa al navegador (la interfaz recibe únicamente estado y `keyHint`, ej. `****5566`).

---

## Motor Remotion, Motion Libre y Guardas de Calidad

A diferencia de editores basados en plantillas rígidas, **OECLIP** genera código React/Remotion (`TSX`) adaptado al encargo:
1. **Generación y Compilación Libre (`execute_custom_motion`)**: Compila código con `esbuild` dentro de `RenderWorkerPool`.
2. **AST Code Guard (`server/motion-agent/code-guard.ts`)**: Limpia markdown, elimina helpers inválidos y valida que solo se importen paquetes autorizados (`react`, `react/jsx-runtime`, `remotion`).
3. **Concurrencia Segura (`computeSafeRemotionConcurrency`)**: Ajusta automáticamente `--concurrency` según los núcleos reales disponibles y memoria libre del contenedor o PC local.
4. **Inspección Visual y Verificación (`visionInspector.ts`, `qa_report`)**:
   - Extrae fotogramas reales (`render_frames`, `contact_sheet`) y los analiza mediante VLM (`inspect_frame`).
   - Verifica literalmente que el copy solicitado aparezca (`literal_copy_present`) y que no se filtren nombres internos de clips (`no_internal_clip_label_leak`).
   - Distingue explícitamente resultados `verified`, `unverified`, `fallback` o `failed` evitando fallos silenciosos reportados como éxito.

---

## Audio, Locución (TTS) y Subtítulos Karaoke

- **Síntesis de Voz (`server/services/ttsService.ts`)**: Cascada automática `OpenAI TTS` → `edge-tts` → `piper` → `espeak-ng` → síntesis nativa de SO / procedural, alineando los tiempos de cada escena narrada.
- **Dirección de Audio (`audioDirector.ts` & `sfxService.ts`)**: Mezcla multipista (`amix` + `alimiter`), música de fondo procedural con ducking automático sobre voz, y efectos embebidos (`ding.wav`, `pop.wav`, `whoosh.wav`).
- **Subtítulos Dinámicos (13 estilos + Karaoke palabra a palabra)**: Incluye estilos tipográficos 2026 (`clean`, `impact`, `card`, `viral`, `neon`, `cinema`, `editorial`, `highlight`, `minimal`, `modern`, `real-estate`, `phrase-highlight`, `clean-pop`) renderizados con fuentes OFL empaquetadas en `assets/fonts/` y quemado rápido en FFmpeg mediante `libass` (`.ass`) o composición transparente Remotion.

---

## Sistema de Skills (15 nativas + extensibles)

Cada skill vive en `skills/<id>/SKILL.md` con frontmatter YAML y carga progresiva:
`anuncio-de-producto`, `brand-kit`, `clip-de-podcast`, `crear-skill`, `entrevista-a-vertical`, `export-por-plataforma`, `limpieza-de-audio`, `localizacion`, `qa-visual`, `reel-corporativo`, `reel-educativo`, `slideshow-de-fotos`, `subtitulos-dinamicos`, `tutorial-con-capturas` y `video-de-datos`.

Pueden aplicarse desde el panel **Skills** de la UI, mediante el Agente Director o subir paquetes `.zip` personalizados en caliente vía `POST /api/skills/upload`.

---

## Catálogo de Herramientas del Agente (`server/agent/tools.ts` — 72 herramientas)

- **Inspección y Análisis**: `inspect_media`, `analyze_audio`, `audio_metrics`, `analyze_video`, `transcribe_audio`, `get_transcript`, `detect_silences`, `detect_scenes`, `find_highlights`, `get_capabilities`, `get_project_summary`, `get_timeline_summary`.
- **Edición y Línea de Tiempo**: `create_edit_plan`, `add_media_to_timeline`, `trim_clip`, `split_clip`, `move_clip`, `remove_clip`, `set_clip_speed`, `set_clip_transform`, `set_clip_crop`, `set_clip_rotation`, `set_clip_timing`, `set_clip_opacity`, `set_clip_fade`, `set_clip_zoom_keyframes`, `set_clip_animation`, `cut_time_range`, `keep_time_ranges`, `remove_silences`, `fit_duration`, `select_highlights`, `change_aspect_ratio`, `apply_color_adjustment`, `apply_social_preset`, `rename_project`.
- **Audio y Voz**: `adjust_audio`, `enhance_voice`, `synthesize_voiceover`, `add_background_music`, `add_sound_effect`.
- **Texto, Motion y Marca**: `generate_subtitles`, `split_subtitles_into_phrases`, `remove_subtitles`, `change_subtitle_style`, `apply_dynamic_subtitle_preset`, `add_text_overlay`, `create_motion_graphic`, `execute_custom_motion`, `execute_autonomous_edit_swarm`, `ask_director`, `set_brand_kit`, `get_brand_kit`, `import_media_from_url`.
- **Historial, Render y QA Visual**: `checkpoint`, `undo`, `redo`, `revert_to_revision`, `diff_revisions`, `generate_proxy`, `preview_edit`, `render_frames`, `remotion_still_render`, `contact_sheet`, `inspect_frame`, `qa_report`, `literal_copy_present`, `no_internal_clip_label_leak`, `get_run_trace`, `render_export`, `verify_export`, `ffprobe_export_valid`.
