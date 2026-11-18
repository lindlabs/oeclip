---
id: reel-educativo
name: Reel Educativo y Explicativo
description: Estructura videos didácticos cortos (20-45 s) con gancho de curiosidad, 3 puntos visuales claros, gráficos animados, subtítulos dinámicos y resumen accionable.
version: 1.0.0
kind: recipe
category: social-media
triggers:
  - educativo
  - explica
  - tutorial corto
  - consejos
  - tips
  - 3 claves
dependencies:
  - remotion
  - ffmpeg
  - subtitulos-dinamicos
tags:
  - educacion
  - storytelling
  - explicativo
---

# Reel Educativo y Explicativo

Receta para transformar una idea, concepto técnico o lista de consejos en un video retenedor y fácil de digerir.

## Flujo de producción
1. **Checkpoint y análisis**:
   - Revisar duración objetivo y relación de aspecto (`9:16` por defecto para reels; `16:9` si es clase/YouTube).
   - Estructurar el contenido en **Gancho -> Punto 1 -> Punto 2 -> Punto 3 -> Cierre/Guardar**.
2. **Voz guía primero (Voice-First)**:
   - Si no existe grabación de voz, redactar un guion conversacional conciso (~135–150 palabras/minuto) y sintetizar con `synthesize_voiceover`.
   - Medir duración real resultante en `get_timeline_summary` y ajustar las escenas visuales a la voz, nunca al revés.
3. **Visuales por bloque**:
   - Para cada concepto, crear visuales explicativos con `execute_custom_motion` (diagramas simples, contadores, comparativas antes/después o viñetas progresivas).
   - Prohibido saturar con párrafos largos en pantalla: máximo 1 idea titular + 2–3 palabras de apoyo por cuadro.
4. **Subtítulos de retención**:
   - Aplicar `subtitulos-dinamicos` sincronizados con palabras clave resaltadas en color de acento.
   - Añadir música ambiental sutil (`add_background_music` con volumen base `0.18` y ducking).
5. **Verificación visual**:
   - Ejecutar `qa_report` y `inspect_frame` en cada transición de punto para garantizar cero superposición entre subtítulos inferiores y cards informativas.
