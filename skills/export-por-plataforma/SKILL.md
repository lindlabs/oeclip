---
id: export-por-plataforma
name: Exportación Optimizada por Plataforma
description: Configura y verifica la exportación MP4 exacta para Reels/TikTok/Shorts (9:16), YouTube (16:9), LinkedIn o Feed cuadrado (1:1) comprobando el archivo final con verify_export.
version: 1.0.0
kind: recipe
category: delivery
triggers:
  - exportar
  - tiktok
  - reels
  - shorts
  - youtube
  - instagram
  - formato plataforma
dependencies:
  - ffmpeg
  - remotion
  - qa-visual
tags:
  - export
  - plataformas
  - mp4
  - entrega
---

# Exportación Optimizada por Plataforma

Receta para elegir parámetros óptimos de salida y validar el archivo MP4 final antes de entregarlo al usuario.

## Presets por destino
- **Instagram Reels / TikTok / YouTube Shorts**: `1080x1920` (`9:16`), `30 fps` (o `60 fps` si gameplay/screencast rápido), H.264 High Profile, AAC `48 kHz` estéreo, audio entre `-16` y `-13 LUFS`.
- **YouTube / Web Horizontal**: `1920x1080` (`16:9`), `30 fps`, H.264, AAC `48 kHz`.
- **Feed LinkedIn / Instagram Cuadrado / 4:5**: `1080x1080` (`1:1`) o `1080x1350` (`4:5`) ajustando márgenes de texto para no recortar titulares.

## Pasos de entrega segura
1. Ejecutar `qa-visual` (`qa_report` + `render_frames`) **antes** de exportar para no desperdiciar tiempo de render en un montaje roto.
2. Llamar `render_export` respetando la concurrencia segura automática de Remotion en el host (`computeSafeRemotionConcurrency`, nunca forzar por encima de los núcleos disponibles).
3. Llamar `verify_export` sobre el archivo generado y reportar al usuario:
   - ruta o URL de descarga,
   - resolución real, duración exacta y fps verificados,
   - motor usado y cualquier advertencia o límite real (ej. sin voz grabada, fallback procedural, etc.).
