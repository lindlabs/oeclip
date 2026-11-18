---
id: reel-corporativo
name: Reel Corporativo 9:16
description: Produce un reel vertical corporativo o de lanzamiento de 15 a 30 segundos en 1080x1920 con gancho visual, demo en movimiento, locución/música, subtítulos dinámicos y CTA final verificado.
version: 1.0.0
kind: recipe
category: social-media
triggers:
  - reel corporativo
  - lanzamiento
  - redes sociales
  - reel 9:16
  - video vertical de marca
dependencies:
  - remotion
  - ffmpeg
  - qa-visual
tags:
  - reel
  - vertical
  - lanzamiento
  - corporativo
---

# Reel Corporativo 9:16

Receta end-to-end para construir un reel vertical (1080x1920, 30 fps) de marca, producto SaaS o lanzamiento sin plantillas rígidas y con verificación visual cuadro a cuadro.

## Cuándo usar esta skill
- El usuario pide un reel o video de lanzamiento para Instagram Reels, TikTok, YouTube Shorts o LinkedIn vertical.
- No hay metraje grabado (o se combina metraje + motion graphics personalizados con Remotion).

## Flujo paso a paso (obligatorio)
1. **Desambiguar y fijar contrato**:
   - Extraer **todos** los textos literales entrecomillados o explícitos (título, bajada, claims, CTA).
   - No inventar textos distintos ni mostrar nunca nombres internos de clips (`"Escena 1 · Gancho"`, `"Clip 1"`).
   - Crear `checkpoint` antes de modificar el timeline.
2. **Configurar lienzo vertical**:
   - Llamar `change_aspect_ratio` con `aspect: "9:16"` (`1080x1920`, `30 fps`).
   - Cargar `get_brand_kit` si existe marca definida para heredar paleta y tipografía.
3. **Estructura de 3 actos (ejemplo 18 s = 540 fotogramas)**:
   - **Escena 1 · Gancho (0–6 s)**: fondo oscuro/gradiente tecnológico de marca, elemento visual protagonista (red neuronal, logotipo o visual 2D/3D), título principal + subtítulo literal en zona segura vertical (`y: 12%–72%`).
   - **Escena 2 · Demo / Valor (6–12 s)**: visualización animada del producto o timeline (pistas, clips, ondas de voz, cards sincronizadas) sin textos saturados ni colisiones.
   - **Escena 3 · Cierre + CTA (12–18 s)**: propuesta de valor final + logotipo + botón/pastilla CTA literal de alto contraste.
4. **Generar escenas en Remotion (`execute_custom_motion`)**:
   - Enviar un prompt visual específico por escena pasando `literalTexts`, `ctaText` y `durationSeconds` explícitos.
   - Comprobar `status`: si devuelve `"fallback"` o `"unverified"`, **declararlo honestamente** o regenerar/ajustar hasta validar.
5. **Audio y subtítulos sincronizados**:
   - Si no hay voz grabada y el cliente pide locución o subtítulos de voz: usar `synthesize_voiceover` con guion alineado a los 3 actos.
   - Añadir música con ducking automático usando `add_background_music` (ducking `-18 dB` bajo voz).
   - Acentuar transiciones clave con `add_sound_effect` (`whoosh`, `pop`, `subhit`) a volumen moderado (`0.30–0.45`).
   - Generar o ajustar subtítulos dinámicos sincronizados con la locución en `T1` (`generate_subtitles`).
6. **Transiciones y ritmo**:
   - Enlazar escenas consecutivas en `V1` sin huecos ni negro accidental. Añadir transiciones suaves cortas (`8–12 frames`) cuando mejoren el flujo.
7. **Inspección y autocrítica obligatoria (`qa-visual`)**:
   - Ejecutar `qa_report`, `render_frames` (inicio, mitad y final de cada escena) y `contact_sheet`.
   - Verificar que no aparezca ningún label interno, que todo texto literal y CTA sea legible, sin solapamientos ni bordes recortados, y que la duración coincida al fotograma.
8. **Exportar y verificar archivo final**:
   - Llamar `render_export` (`1080x1920`, MP4 H.264) y `verify_export`.

## Criterios de calidad mínima
- Resolución nativa `1080x1920` sin fuentes escaladas por debajo del 70% salvo aviso explícito.
- Contraste mínimo WCAG AA (4.5:1) en títulos, subtítulos y botón CTA.
- LUFS integrado entre `-16` y `-13` si hay audio; sin clipping (`truePeak < -1 dBTP`).
- Todos los textos literales del usuario presentes en el timeline final y verificados en frames renderizados.
