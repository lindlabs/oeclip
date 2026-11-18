---
id: crear-skill
name: Creación y Versionado de Skills
description: Diseña, redacta y registra una nueva skill reusable en formato SKILL.md dentro de OECLIP para consolidar flujos repetibles con criterios de calidad y QA.
version: 1.0.0
kind: recipe
category: meta
triggers:
  - crear skill
  - nueva skill
  - guardar receta
  - automatizar flujo
dependencies:
  - qa-visual
tags:
  - skills
  - recetas
  - meta
  - automatizacion
---

# Creación y Versionado de Skills

Meta-skill para enseñar al agente o al usuario cómo capturar un flujo de producción exitoso como una skill versionada reutilizable.

## Buenas prácticas de diseño de Skills en OECLIP
1. **Progressive Disclosure**:
   - `frontmatter` YAML breve y claro (`id`, `name`, `description` <= 250 caracteres, `version`, `kind`, `category`, `triggers`, `dependencies`) para descubrimiento barato en `list_skills`.
   - Cuerpo Markdown detallado que solo se lee bajo demanda mediante `get_skill`.
2. **Estructura recomendada del cuerpo Markdown**:
   - Cuándo usar esta skill.
   - Entradas y parámetros requeridos.
   - Pasos exactos citando nombres reales de herramientas OECLIP (`change_aspect_ratio`, `execute_custom_motion`, `synthesize_voiceover`, `qa_report`, `render_frames`, etc.).
   - Reglas anti-regresión (sin placeholders, literalidad exacta, zonas seguras).
   - Checklist de verificación final.
3. **Registro**:
   - Guardar con `create_skill` usando slug en minúsculas con guiones (`kebab-case`) y versión semántica (`1.0.0`).
   - Confirmar después con `get_skill` que la nueva skill quedó indexada y legible.
