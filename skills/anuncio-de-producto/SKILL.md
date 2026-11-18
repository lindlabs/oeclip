---
id: anuncio-de-producto
name: Anuncio de Producto de Alto Impacto
description: Crea un spot publicitario breve (15-30 s) centrado en problema, demostración del producto, beneficio clave, prueba social y oferta o CTA directo.
version: 1.0.0
kind: recipe
category: commercial
triggers:
  - anuncio
  - spot
  - producto
  - ad
  - comercial
  - ecommerce
dependencies:
  - remotion
  - ffmpeg
  - qa-visual
tags:
  - anuncio
  - producto
  - conversion
  - performance
---

# Anuncio de Producto de Alto Impacto

Guía para producir anuncios orientados a conversión (Meta Ads, TikTok Ads, YouTube Shorts/In-Feed o 16:9 web).

## Cuándo usar esta skill
- El usuario quiere promocionar un producto físico o digital con foco en conversión y claridad comercial.

## Estructura probada (Problema → Producto → Prueba → CTA)
1. **Preparación**:
   - Consultar `get_brand_kit` y respetar colores primarios, acentos y fuentes.
   - Si el usuario subió fotos o clips del producto, revisar resoluciones con `inspect_media` y `get_project_summary` antes de montar (F7: advertir si hay orígenes `< 720p`).
   - Crear `checkpoint`.
2. **Bloque 1 · Gancho problema (0–3.5 s)**:
   - Mostrar inmediatamente el producto o el punto de dolor principal. Titular grande (`<= 6` palabras), legible en menos de 1 segundo.
3. **Bloque 2 · Demostración y diferenciador (3.5–11 s)**:
   - Combinar metraje del producto con tarjetas de especificaciones generadas vía `execute_custom_motion` (máximo 1–2 métricas o beneficios por pantalla).
4. **Bloque 3 · Oferta / CTA (11–15+ s)**:
   - Pastilla CTA exacta pedida por el usuario (`ctaText`), logotipo limpio y beneficio de urgencia si fue solicitado.
5. **Sonido y ritmo**:
   - Locución enérgica vía `synthesize_voiceover` o voz del usuario limpiada con `audio_metrics`.
   - Cama musical dinámica (`add_background_music`) + hits de impacto (`add_sound_effect`: `pop`, `whoosh`) en cambios de beneficio.
6. **QA y exportación**:
   - Correr `qa_report` y `contact_sheet` verificando que el CTA no quede tapado por la interfaz nativa de Reels/TikTok ni por subtítulos.
   - Usar `export-por-plataforma` para entregar el formato exacto.
