---
id: subtitulos-dinamicos
name: Subtítulos Dinámicos Sincronizados
description: Genera, limpia y estiliza subtítulos palabra por palabra o por bloques rítmicos sincronizados con la voz y respetando zonas seguras de cada plataforma.
version: 1.0.0
kind: recipe
category: subtitles
triggers:
  - subtitulos
  - subtítulos
  - captions
  - karaoke
  - sincronizados con mi voz
dependencies:
  - ffmpeg
  - qa-visual
tags:
  - subtitulos
  - captions
  - stt
  - karaoke
---

# Subtítulos Dinámicos Sincronizados

Guía técnica para producir subtítulos legibles, fieles al audio y libres de colisiones visuales.

## Cuándo aplicar
- Siempre que exista voz (grabada o vía TTS) y el proyecto sea para redes, anuncios, reels o contenido accesible.

## Estándar técnico OECLIP
1. **Fuente de verdad temporal**:
   - Llamar `get_transcript` primero para comprobar si ya existen segmentos/palabras con timestamps reales.
   - Si el video **no tiene pista de voz ni audio**, no inventar transcripciones falsas de voz; en ese caso informar al usuario o generar locución real primero con `synthesize_voiceover`.
2. **Generación y densidad de lectura**:
   - Invocar `generate_subtitles` en la pista de texto (`T1`).
   - Límite visual: máximo **2 líneas** por evento y **3–6 palabras** por bloque para lectura cómoda en móvil.
   - Respetar verbatim nombres propios, marcas (ej. `OECLIP`, `NOVACUT AI`) y números.
3. **Ubicación y contraste**:
   - En `9:16`: ubicar en `y = 68%–78%` (por encima del HUD de likes/descripción en Reels/TikTok).
   - Fondo semitransparente oscuro o contorno nítido para cumplir contraste `>= 4.5:1` sobre cualquier fondo claro u oscuro.
   - Resaltar palabra activa con color primario/acento del Brand Kit (`get_brand_kit`).
4. **Verificación**:
   - Correr `qa_report` para detectar solapamientos con títulos u overlays de `Capa Motion` y verificar un par de frames con `render_frames`.
