---
id: slideshow-de-fotos
name: Slideshow Dinámico de Fotos
description: Transforma secuencias de imágenes o capturas en un video fluido con movimientos Ken Burns suaves, transiciones rítmicas, títulos limpios y cama musical.
version: 1.0.0
kind: recipe
category: photo-video
triggers:
  - slideshow
  - fotos
  - imágenes
  - galería animada
  - carrusel de fotos
dependencies:
  - ffmpeg
  - remotion
  - qa-visual
tags:
  - fotos
  - slideshow
  - ken-burns
  - musica
---

# Slideshow Dinámico de Fotos

Receta para dar vida a colecciones de fotografías (lanzamientos, inmobiliaria, e-commerce, recap de eventos) evitando transiciones planas o cortes bruscos.

## Procedimiento
1. **Revisar resoluciones y orientación**:
   - Llamar `inspect_media` para todas las imágenes del proyecto.
   - Advertir si alguna foto es inferior al 70% de la resolución del lienzo (F7).
   - Decidir entre ajuste vertical `9:16` o apaisado `16:9` según mayoría de fotografías o encargo explícito.
2. **Ritmo y duración por foto**:
   - Duración recomendada: `2.5 s` a `4.0 s` por imagen (más corta en promos dinámicos; más larga si hay texto explicativo).
   - Aplicar zoom/paneo sutil (`1.00x -> 1.08x`) para sensación cinematográfica sin marear.
3. **Capas de texto y música**:
   - Evitar tapar el sujeto principal de la fotografía: usar gradientes sutiles arriba/abajo para titulares y bajadas.
   - Añadir música rítmica (`add_background_music`) y opcionalmente voz narrativa (`synthesize_voiceover`) con ducking.
4. **Verificación visual**:
   - Correr `contact_sheet` y `qa_report` verificando una muestra de cada foto en el montaje final.
