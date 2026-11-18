---
id: localizacion
name: Localización y Traducción Multilingüe
description: Adapta guiones, títulos en pantalla, subtítulos y locución TTS a otro idioma preservando marcas propias, sincronía temporal y diseño visual limpio.
version: 1.0.0
kind: recipe
category: localization
triggers:
  - traducir
  - localizar
  - inglés
  - español
  - portugués
  - idioma
  - doblaje
dependencies:
  - subtitulos-dinamicos
  - qa-visual
tags:
  - traduccion
  - localizacion
  - multilingue
  - tts
---

# Localización y Traducción Multilingüe

Guía para versionar un proyecto de video a otro idioma sin romper tiempos ni desbordar contenedores visuales.

## Reglas de localización limpia
1. **Preservar marcas y términos propios**:
   - No traducir nombres de marca (`OECLIP`, `NOVACUT AI`), nombres propios ni siglas técnicas acordadas.
2. **Control de expansión de texto**:
   - Al pasar de inglés a español o portugués, el texto suele crecer entre 15% y 30%.
   - Crear `checkpoint` previo y ajustar copy a frases breves equivalentes que quepan en el mismo espacio visual de cada escena.
3. **Actualización integral (Texto + Voz + Subtítulos)**:
   - Re-generar los títulos/escenas Remotion afectadas (`execute_custom_motion`) con los textos traducidos.
   - Si el video lleva locución en el nuevo idioma, sintetizar voz localizada (`synthesize_voiceover`) y regenerar subtítulos (`generate_subtitles`) acordes al nuevo audio.
4. **QA visual obligatoria**:
   - Ejecutar `qa_report` y `render_frames` para comprobar que ningún texto traducido se desborde ni invada los márgenes en `9:16`.
