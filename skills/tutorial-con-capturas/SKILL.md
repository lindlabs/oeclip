---
id: tutorial-con-capturas
name: Tutorial con Capturas y Screencast
description: Convierte grabaciones de pantalla o capturas UI en tutoriales claros con zooms dirigidos a la acción, callouts limpios, eliminación de silencios y guía paso a paso.
version: 1.0.0
kind: recipe
category: productivity
triggers:
  - tutorial
  - captura de pantalla
  - screencast
  - paso a paso
  - demo software
dependencies:
  - ffmpeg
  - remotion
  - limpieza-de-audio
tags:
  - tutorial
  - screencast
  - demo
  - zooms
---

# Tutorial con Capturas y Screencast

Flujo para editar grabaciones de software, onboarding de producto o demostraciones paso a paso.

## Pasos clave
1. **Diagnóstico de fuentes**:
   - Ejecutar `inspect_media` sobre las capturas o videos de pantalla.
   - Si la captura es `16:9` y la salida pedida es `9:16`, advertir explícitamente qué zona lateral quedará recortada o proponer un encuadre vertical con tarjeta superior/inferior.
2. **Limpieza temporal y de audio**:
   - Crear `checkpoint`.
   - Ejecutar `limpieza-de-audio` / `detect_silences` para recortar pausas muertas de carga sin cortar respiraciones naturales.
   - Analizar volumen y picos con `audio_metrics`.
3. **Atención visual sin ensuciar la UI**:
   - Aplicar zooms suaves (`1.12x–1.35x`) únicamente en los momentos donde el cursor o la interfaz ejecutan una acción crítica.
   - Si el usuario pide callouts de pasos (`Paso 1`, `Paso 2`), usar `execute_custom_motion` con pastillas compactas en esquinas seguras que nunca tapen botones ni texto del screencast.
4. **Subtítulos y verificación**:
   - Generar subtítulos sincronizados en zona segura inferior (`generate_subtitles`).
   - Verificar con `render_frames` antes y durante cada zoom para asegurar que el elemento de interfaz sigue dentro del cuadro.
