---
id: entrevista-a-vertical
name: Entrevista 16:9 a Vertical 9:16
description: Adapta entrevistas o videos horizontales 16:9 al formato vertical 9:16 con cortes inteligentes, reencuadre activo y subtítulos sin deformar la imagen.
version: 1.0.0
kind: recipe
category: editing
triggers:
  - entrevista
  - horizontal a vertical
  - 16:9 a 9:16
  - reframing
  - reencuadre
dependencies:
  - ffmpeg
  - qa-visual
tags:
  - entrevista
  - reencuadre
  - vertical
  - reframing
---

# Entrevista 16:9 a Vertical 9:16

Receta honesta y precisa para transformar metraje horizontal en piezas verticales legibles.

## Reglas clave
1. **Honestidad sobre capacidades y resolución (F7)**:
   - Consultar `get_capabilities` e `inspect_media`.
   - Si el video original tiene resolución horizontal reducida (ej. `640x360` o `1280x720`) al escalar a `1080x1920`, **informar explícitamente** al usuario la pérdida de nitidez esperada al recortar al centro.
   - Si no existe seguimiento automático de múltiples rostros (`auto_reframe`), declararlo claramente y posicionar manualmente o mediante layout en pantalla dividida / carta con marco limpio.
2. **Estrategias de encuadre**:
   - **Opción A (Speaker único centrado)**: `change_aspect_ratio("9:16")` + ajuste de escala/posición del clip en `V1` para mantener ojos y boca en el tercio superior-medio.
   - **Opción B (Diálogo o fuente muy baja en px)**: Mantener ancho completo centrado en formato vertical con fondo desenfocado/brandizado arriba y abajo, titular superior y subtítulos inferiores.
3. **Limpieza y ritmo**:
   - Cortar pausas extensas entre preguntas y respuestas; aplicar `generate_subtitles` sincronizados.
4. **Verificación obligatoria**:
   - Ejecutar `render_frames` y `inspect_frame` para confirmar que la cara del hablante nunca queda cortada ni fuera de cuadro ni oculta tras textos.
