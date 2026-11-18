---
id: brand-kit
name: Identidad de Marca (Brand Kit)
description: Define, consulta y aplica coherentemente paleta cromática, tipografía, tonos visuales, estilo de subtítulos y logotipo de una marca en todo el proyecto.
version: 1.0.0
kind: recipe
category: branding
triggers:
  - brand kit
  - marca
  - colores de marca
  - tipografía
  - identidad visual
  - estilo corporativo
dependencies:
  - qa-visual
tags:
  - branding
  - paleta
  - tipografia
  - identidad
---

# Identidad de Marca (Brand Kit)

Skill transversal para que todas las escenas Remotion, títulos, botones CTA y subtítulos respeten la identidad visual del cliente.

## Flujo
1. **Consultar estado actual**:
   - Llamar `get_brand_kit`. Si no existe Brand Kit guardado o el usuario aporta nuevos colores/fuente/logo, configurar primero con `set_brand_kit`.
2. **Tokens obligatorios de consistencia**:
   - `brandName`: nombre oficial (ej. `OECLIP`, `NOVACUT AI`).
   - `primaryColor`, `secondaryColor`, `accentColor`, `backgroundColor`, `textColor`.
   - `fontFamily`: familia limpia coherente en títulos y subtítulos (`Inter`, `Plus Jakarta Sans`, etc.).
   - `tone`: ej. `corporativo moderno`, `dinámico tech`, `minimal editorial`.
3. **Aplicación en escena y subtítulos**:
   - Pasar la paleta y tono de marca en los prompts de `execute_custom_motion` y elegir variantes de `generate_subtitles` alineadas.
4. **Auditar coherencia**:
   - Verificar con `render_frames` y `contact_sheet` que no aparezcan colores aleatorios fuera del Brand Kit ni texto de bajo contraste sobre los fondos corporativos.
