---
id: qa-visual
name: Auditoría y QA Visual Autónoma
description: Inspecciona el montaje con render_frames, contact_sheet, inspect_frame y qa_report para detectar fallos de texto, placeholders, negros accidentales, contrastes o cortes antes de entregar.
version: 1.0.0
kind: recipe
category: verification
triggers:
  - revisar video
  - qa
  - verificar
  - inspeccionar
  - revisar montaje
dependencies:
  - ffmpeg
tags:
  - qa
  - percepcion
  - verificacion
  - autocritica
---

# Auditoría y QA Visual Autónoma

La entrega de cualquier proyecto en OECLIP **exige** ver y comprobar el resultado real, nunca asumir éxito por ausencia de excepciones.

## Protocolo obligatorio de verificación
1. **Inspección estructural (`qa_report` + `get_timeline_summary`)**:
   - Verificar duración exacta pedida por el usuario (ej. `540 fotogramas = 18.0 s` a `30 fps`).
   - Verificar que no hay huecos negros inesperados en `V1`, clips huérfanos o pistas desincronizadas.
   - Comprobar advertencias de resolución baja (F7) y textos literales faltantes en el timeline.
2. **Inspección visual de cuadros (`render_frames` / `contact_sheet` / `inspect_frame`)**:
   - Renderizar fotogramas representativos: inicio (`t=0.5s`), centro de cada escena y cierre CTA.
   - Confirmar visualmente 5 reglas críticas:
     1. **Cero fugas de prompts ni labels internos**: nunca debe verse `"Escena 1 · Gancho"`, `"Clip 1"` ni instrucciones crudas del chat.
     2. **Literalidad exacta**: títulos, claims y botón CTA coinciden letra por letra con lo pedido.
     3. **Cero solapamientos**: título superior, demo central y subtítulos inferiores respetan zonas seguras sin pisarse.
     4. **Contraste y recorte**: texto legible (`>= 4.5:1`) dentro de márgenes seguros (`10%` horizontal, `12%` superior/inferior en `9:16`).
     5. **Sincronía audio-video**: si el pedido incluía voz o subtítulos, comprobar `audio_metrics` y `get_transcript`.
3. **Ciclo de corrección**:
   - Si falla cualquiera de los 5 puntos, corregir sobre el timeline (usando `undo`/`checkpoint` si conviene) y repetir QA hasta aprobar o reportar exactamente el bloqueo detectado.
