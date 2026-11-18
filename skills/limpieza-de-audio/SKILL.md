---
id: limpieza-de-audio
name: Limpieza y Masterización de Audio
description: Audita sonoridad (LUFS, true peak, ruido de fondo), recorta silencios improductivos, equilibra música con ducking y normaliza la mezcla final.
version: 1.0.0
kind: recipe
category: audio
triggers:
  - limpia los silencios
  - limpiar audio
  - silencio
  - ruido
  - volumen
  - masterizar audio
dependencies:
  - ffmpeg
tags:
  - audio
  - silencios
  - lufs
  - ducking
---

# Limpieza y Masterización de Audio

Flujo para dejar voz, música y efectos de sonido claros, equilibrados y listos para publicación móvil.

## Procedimiento
1. **Diagnóstico antes de editar**:
   - Ejecutar `audio_metrics` para conocer `integratedLufs`, `truePeakDbtp`, silencio total y balance entre pistas (`V1`, `A1`, `SFX`).
   - Crear `checkpoint`.
2. **Eliminación inteligente de silencios**:
   - Si el usuario pide limpiar silencios ("jump cuts"), recortar pausas largas (`>= 0.5–0.7 s`) conservando `80–120 ms` de ataque/cola por corte para evitar chasquidos o cortes abruptos de consonantes.
   - Mantener sincronía exacta con los clips de texto (`T1`) y overlays (`Motion`) al acortar el timeline.
3. **Balance de mezcla**:
   - Voz principal: objetivo `-16` a `-13 LUFS` integrados, sin saturación.
   - Música de fondo (`add_background_music`): habilitar `ducking: true` (`duckingDb: -18` respecto a la voz; entre `0.15` y `0.25` de ganancia base).
   - Efectos SFX (`add_sound_effect`): `0.28–0.42` de ganancia, nunca tapando palabras clave.
4. **Comprobación posterior**:
   - Volver a llamar `audio_metrics` y `qa_report` después de los cambios para confirmar que no hay clipping ni silencios involuntarios.
