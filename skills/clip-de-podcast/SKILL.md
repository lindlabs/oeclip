---
id: clip-de-podcast
name: Clip de Podcast Multiformato
description: Extrae el mejor momento de un episodio de podcast y lo transforma en un clip vertical 9:16 con limpieza de voz, onda visual opcional, título gancho superior y subtítulos karaoke.
version: 1.0.0
kind: recipe
category: audio-first
triggers:
  - podcast
  - clip de podcast
  - episodio
  - audio a video
dependencies:
  - ffmpeg
  - subtitulos-dinamicos
  - limpieza-de-audio
tags:
  - podcast
  - audio
  - clips
  - karaoke
---

# Clip de Podcast Multiformato

Convierte un extracto de video o audio largo de podcast en una pieza corta con alta retención visual.

## Procedimiento
1. **Auditoría inicial**:
   - Llamar `get_project_summary` y `audio_metrics` para conocer duración, nivel LUFS, rango dinámico y resolución de video (F7: avisar si el origen es `< 720p`).
   - Obtener transcripción con `get_transcript`.
2. **Selección del hook e higiene**:
   - Identificar un fragmento autónomo (20–55 s) que empiece con una afirmación potente o pregunta directa.
   - Eliminar muletillas largas o silencios muertos (`> 600 ms`) manteniendo la naturalidad del diálogo.
3. **Composición visual**:
   - Encuadrar en `9:16` (`change_aspect_ratio`) o crear lienzo dividido/enmarcado si solo existe pista de audio o cámara muy abierta.
   - Opcional según pedido: añadir titular gancho fijo en el tercio superior y visualizador/onda de audio en `execute_custom_motion` si no hay cámara.
4. **Subtítulos y sonoridad**:
   - Colocar subtítulos dinámicos centrados en el tercio medio-bajo (evitando botones de TikTok/Reels).
   - Normalizar voz alrededor de `-14 LUFS` sin saturación.
5. **QA final**:
   - Revisar `qa_report` y `contact_sheet` comprobando que el rostro (si hay video) no quede tapado por el título superior ni por los subtítulos.
