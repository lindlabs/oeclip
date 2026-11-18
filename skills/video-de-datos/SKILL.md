---
id: video-de-datos
name: Video de Datos y Métricas Animadas
description: Convierte cifras, KPIs, comparativas y crecimiento en gráficos animados en Remotion con jerarquía tipográfica clara y alta legibilidad.
version: 1.0.0
kind: recipe
category: data-viz
triggers:
  - datos
  - estadísticas
  - kpi
  - gráficas
  - métricas
  - comparativa
dependencies:
  - remotion
  - qa-visual
tags:
  - data-viz
  - kpi
  - graficas
  - remotion
---

# Video de Datos y Métricas Animadas

Guía para visualizar números, porcentajes, gráficos de barras/líneas y KPIs sin saturar la pantalla ni perder precisión numérica.

## Reglas estrictas de fidelidad
1. **Cero cifras inventadas**:
   - Respetar exactamente los números, unidades (`%`, `$`, `x`, `s`, `fps`) y etiquetas proporcionados por el usuario.
2. **Máximo foco por escena**:
   - En `9:16`: máximo **2–3 KPIs** o **1 gráfica** por escena (`3–6 s` para permitir lectura real).
   - En `16:9`: hasta **4 barras o series** claramente diferenciadas por color y etiqueta directa.
3. **Generación en Remotion (`execute_custom_motion`)**:
   - Describir explícitamente los datos literales en `literalTexts` y especificar animación progresiva (`spring` suave o conteo ascendente sincronizado en los primeros 30%–60% del clip para que la cifra final repose legible).
4. **QA numérico y visual**:
   - Inspeccionar el fotograma final de cada escena (`render_frames` al 75% de la escena) para validar que las cifras completas ya terminaron de animarse, no están recortadas y cumplen contraste AA.
