import { type HyperFramePalette } from "../../src/shared/hyperframes";

export type VideoThemeCategory = string;

export interface CharacterEntity {
  id: string;
  name: string;
  role: string;
  badge: string;
  accentColor: string;
  avatarType:
    | "anime_hero"
    | "anime_heroine"
    | "scholar"
    | "tech_dev"
    | "executive"
    | "athlete"
    | "eco_guide"
    | "cyber_specialist"
    | "astro_commander"
    | "medical_lead"
    | "artisan_creator";
  initials: string;
}

export type ParticleAtmosphereType =
  | "sakura_petals"
  | "cyber_bits"
  | "bio_leaves"
  | "gold_sparks"
  | "bokeh_dust"
  | "quantum_nodes"
  | "star_drift"
  | "fluid_waves"
  | "energy_rays";

export interface ArtDirectionGeometry {
  layoutStyle:
    | "asymmetric_editorial"
    | "technical_brackets"
    | "glassmorphism_floating"
    | "isometric_perspective"
    | "cyber_hud"
    | "diagonal_kinetic"
    | "minimal_swiss";
  clipPath?: string;
  borderRadius: string;
  borderStyle: string;
  headerBracket: string;
}

export interface ProjectSemanticDNA {
  category: VideoThemeCategory;
  categoryLabel: string;
  themeKicker: string;
  emotionalTone:
    | "high_energy"
    | "dramatic_cinematic"
    | "technical_analytical"
    | "warm_editorial"
    | "playful_viral"
    | "dark_futuristic"
    | "epic_documentary";
  masterPalette: HyperFramePalette;
  paletteTheory: {
    accentGlow: string;
    contrastText: string;
    surfaceShade: string;
    ambientGradients: [string, string, string];
  };
  geometry: ArtDirectionGeometry;
  atmosphere: {
    backgroundGradients: [string, string, string];
    particleType: ParticleAtmosphereType;
    glowColor: string;
    meshNoise: boolean;
  };
  thematicSvgIcon: string;
  thematicIconType: string;
  customVisualMetaphorKind:
    | "neural_network"
    | "radar_telemetry"
    | "quantum_orbit"
    | "isometric_flow"
    | "chronicle_timeline"
    | "hud_brackets"
    | "generic_svg";
  characters: CharacterEntity[];
  vocabulary: {
    kickerTags: string[];
    metricUnits: string[];
    suggestedBadges: string[];
    ctaPhrase: string;
  };
}

// ---------------------------------------------------------------------------
// UTILIDADES DETERMINISTAS DE COLOR Y GENERACIÓN PROCEDIMENTAL
// ---------------------------------------------------------------------------

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return Math.abs(hash);
}

function hslToHex(h: number, s: number, l: number): string {
  const normL = Math.max(0, Math.min(100, l)) / 100;
  const normS = Math.max(0, Math.min(100, s)) / 100;
  const a = normS * Math.min(normL, 1 - normL);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = normL - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function hexToHsl(hex: string): [number, number, number] {
  let c = hex.replace("#", "").trim();
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return [Math.round(h || 0), Math.round(s * 100), Math.round(l * 100)];
}

function detectExplicitPaletteFromPrompt(prompt: string): HyperFramePalette | null {
  const lower = prompt.toLowerCase();
  const hexMatches = prompt.match(/#[0-9A-Fa-f]{6}/g);
  if (hexMatches && hexMatches.length >= 2) {
    const [acc, sec] = hexMatches;
    return {
      accent: acc!.toUpperCase(),
      secondary: sec!.toUpperCase(),
      surface: "#0A0D14",
      text: "#F8FAFC",
    };
  }

  const colorPairs: Array<{ regex: RegExp; accent: string; secondary: string; surface: string }> = [
    { regex: /dorado|oro|gold/i, accent: "#EAB308", secondary: "#F59E0B", surface: "#151105" },
    { regex: /esmeralda|verde\s*menta|bio/i, accent: "#10B981", secondary: "#34D399", surface: "#041B13" },
    { regex: /carmes[ií]|rojo\s*fuego|escarlata/i, accent: "#EF4444", secondary: "#F97316", surface: "#1A0606" },
    { regex: /cian|azul\s*el[eé]ctrico|cobalto/i, accent: "#06B6D4", secondary: "#3B82F6", surface: "#03141F" },
    { regex: /violeta|p[uú]rpura|ne[oó]n\s*magenta/i, accent: "#A855F7", secondary: "#EC4899", surface: "#14041F" },
    { regex: /blanco\s*y\s*negro|monocrom/i, accent: "#F8FAFC", secondary: "#94A3B8", surface: "#05070A" },
    { regex: /naranja|ámbar|ambar/i, accent: "#F97316", secondary: "#FBBF24", surface: "#1B0B03" },
  ];

  for (const p of colorPairs) {
    if (p.regex.test(lower)) {
      return {
        accent: p.accent,
        secondary: p.secondary,
        surface: p.surface,
        text: "#FFFFFF",
      };
    }
  }

  return null;
}

function synthesizeHarmoniousPalette(
  basePalette: HyperFramePalette,
  seedStr: string,
): HyperFramePalette {
  const hash = djb2Hash(seedStr);
  const [baseH, baseS, baseL] = hexToHsl(basePalette.accent);
  const [secH, secS, secL] = hexToHsl(basePalette.secondary);

  // Desplazamiento determinista no lineal (+/- 22 grados) para garantizar originalidad
  const shift = (hash % 44) - 22;
  const newAccentH = (baseH + shift + 360) % 360;
  const newSecH = (secH + shift * 0.75 + 360) % 360;

  const accent = hslToHex(newAccentH, Math.min(100, Math.max(65, baseS)), Math.min(68, Math.max(48, baseL)));
  const secondary = hslToHex(newSecH, Math.min(100, Math.max(60, secS)), Math.min(72, Math.max(50, secL)));

  // Superficie profunda calculada con el tinte del color secundario al 4-6% de luminosidad
  const surface = hslToHex(newSecH, 32, 5);

  return {
    accent,
    secondary,
    surface,
    text: "#F8FAFC",
  };
}
export const THEMATIC_PALETTES: Record<string, HyperFramePalette> = {
  sustainability_nature: {
    accent: "#10B981", // Esmeralda bio
    secondary: "#34D399", // Menta luminosa
    surface: "#06281E", // Verde bosque profundo
    text: "#ECFDF5",
  },
  anime_storytelling: {
    accent: "#F43F5E", // Carmesí anime
    secondary: "#A855F7", // Violeta místico
    surface: "#1A0826", // Noche púrpura
    text: "#FFF1F2",
  },
  tech_ai_software: {
    accent: "#6366F1", // Índigo computacional
    secondary: "#38BDF8", // Cian eléctrico
    surface: "#0B0F19", // Negro obsidiana tech
    text: "#F8FAFC",
  },
  fintech_business: {
    accent: "#F59E0B", // Ámbar dorado de valor
    secondary: "#10B981", // Verde rendimiento alcista
    surface: "#0F172A", // Azul marino institucional
    text: "#FFFBEB",
  },
  fitness_wellness: {
    accent: "#F97316", // Naranja energía
    secondary: "#E11D48", // Rojo pulsaciones
    surface: "#180A04", // Carbón térmico
    text: "#FFF7ED",
  },
  education_documentary: {
    accent: "#0284C7", // Azul académico
    secondary: "#F59E0B", // Dorado ilustración
    surface: "#081628", // Biblioteca nocturna
    text: "#F0F9FF",
  },
  creative_cinema: {
    accent: "#EAB308", // Oro cinematográfico
    secondary: "#FB7185", // Rosa crepúsculo
    surface: "#0C0A09", // Negro cine 2.39:1
    text: "#FEFCE8",
  },
  space_astrophysics: {
    accent: "#38BDF8", // Azul estelar
    secondary: "#C084FC", // Nebulosa púrpura
    surface: "#030712", // Vacío cósmico
    text: "#F8FAFC",
  },
  cybersecurity_matrix: {
    accent: "#22C55E", // Verde terminal fósforo
    secondary: "#06B6D4", // Cian criptográfico
    surface: "#020A05", // Terminal sombra
    text: "#F0FDF4",
  },
  medical_biotech: {
    accent: "#06B6D4", // Cian clínico estéril
    secondary: "#3B82F6", // Azul quirúrgico
    surface: "#03141E", // Azul abisal laboratorio
    text: "#F0FDFA",
  },
  luxury_editorial: {
    accent: "#D4AF37", // Oro noble metálico
    secondary: "#E2E8F0", // Platino satinado
    surface: "#0A0A0A", // Obsidian onyx
    text: "#FFFFFF",
  },
  quantum_physics: {
    accent: "#818CF8", // Radiación Cherenkov
    secondary: "#F472B6", // Superposición cuántica
    surface: "#080614", // Cámara de vacío
    text: "#EEF2FF",
  },
  culinary_gastronomy: {
    accent: "#F59E0B", // Azafrán dorado
    secondary: "#EF4444", // Pimentón cálido
    surface: "#180905", // Madera ahumada
    text: "#FFFBEB",
  },
  travel_adventure: {
    accent: "#06B6D4", // Turquesa arrecife
    secondary: "#F59E0B", // Arena dorada
    surface: "#03141D", // Profundidad marina
    text: "#F0FDFA",
  },
  gaming_esports: {
    accent: "#A855F7", // Violeta neón
    secondary: "#06B6D4", // Cian láser
    surface: "#0D031A", // Noche arcade
    text: "#FAF5FF",
  },
  automotive_speed: {
    accent: "#DC2626", // Rojo competición
    secondary: "#E2E8F0", // Titanio cepillado
    surface: "#120303", // Asfalto negro
    text: "#FEF2F2",
  },
  music_audio: {
    accent: "#EC4899", // Fucsia sónico
    secondary: "#38BDF8", // Onda cian
    surface: "#15041B", // Cámara anecoica
    text: "#FDF2F8",
  },
};

/**
 * Iconos SVG temáticos vectoriales de alta precisión procedimentales.
 */
export const THEMATIC_SVG_ICONS: Record<string, { path: string; viewBox: string; label: string }> = {
  sustainability_nature: {
    path: "M12 2C6.5 2 2 6.5 2 12c0 3.5 1.8 6.6 4.5 8.4-.2-1.5 0-3.1.6-4.5 1.5-3.5 4.5-6 8.5-7.5.3 1.8-.2 3.8-1.2 5.3-1.6 2.4-4.1 4-6.9 4.3C9 19.3 10.4 20 12 20c5.5 0 10-4.5 10-10S17.5 2 12 2z",
    viewBox: "0 0 24 24",
    label: "ECO_LEAF",
  },
  anime_storytelling: {
    path: "M12 2l2.4 5.8 6.2.5-4.7 4.1 1.4 6.1L12 15.3 6.7 18.5l1.4-6.1-4.7-4.1 6.2-.5L12 2z",
    viewBox: "0 0 24 24",
    label: "ANIME_STAR",
  },
  tech_ai_software: {
    path: "M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M7 5h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2zm4 4h2v2h-2V9zm0 4h2v2h-2v-2z",
    viewBox: "0 0 24 24",
    label: "TECH_CHIP",
  },
  fintech_business: {
    path: "M3 17l6-6 4 4 8-8m0 0h-5m5 0v5",
    viewBox: "0 0 24 24",
    label: "GROWTH_CHART",
  },
  fitness_wellness: {
    path: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
    viewBox: "0 0 24 24",
    label: "ENERGY_BOLT",
  },
  education_documentary: {
    path: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
    viewBox: "0 0 24 24",
    label: "OBSERVATORY",
  },
  creative_cinema: {
    path: "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z",
    viewBox: "0 0 24 24",
    label: "CINEMA_CLAPPER",
  },
  space_astrophysics: {
    path: "M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 14.93V17a1 1 0 01-2 0v-.07A8 8 0 014.07 11H4a1 1 0 010-2h.07A8 8 0 0111 4.07V4a1 1 0 012 0v.07A8 8 0 0119.93 11H20a1 1 0 010 2h-.07A8 8 0 0113 16.93zM12 8a4 4 0 104 4 4 4 0 00-4-4z",
    viewBox: "0 0 24 24",
    label: "ORBITAL_RADAR",
  },
  cybersecurity_matrix: {
    path: "M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm0 4a3 3 0 013 3c0 1.3-.84 2.4-2 2.82V15h-2v-3.18A3 3 0 019 9a3 3 0 013-3z",
    viewBox: "0 0 24 24",
    label: "CYBER_SHIELD",
  },
  medical_biotech: {
    path: "M19 10.5V6a2 2 0 00-2-2H7a2 2 0 00-2 2v4.5a7.5 7.5 0 0014 0zM12 6v6m-3-3h6M5 18a2 2 0 002 2h10a2 2 0 002-2",
    viewBox: "0 0 24 24",
    label: "HEALTH_DNA",
  },
  luxury_editorial: {
    path: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
    viewBox: "0 0 24 24",
    label: "DIAMOND_EMBLEM",
  },
  quantum_physics: {
    path: "M12 3c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L12 12V3zm0 18c4.97 0 9-4.03 9-9 0-2.12-.74-4.07-1.97-5.61L12 12v9z",
    viewBox: "0 0 24 24",
    label: "QUANTUM_SPHERE",
  },
  culinary_gastronomy: {
    path: "M12 2a5 5 0 00-4.9 4A4 4 0 005 10a4 4 0 004 4h6a4 4 0 004-4 4 4 0 00-2.1-4A5 5 0 0012 2zm-5 14v4h10v-4H7z",
    viewBox: "0 0 24 24",
    label: "CHEF_CROWN",
  },
  travel_adventure: {
    path: "M12 2a10 10 0 1010 10A10 10 0 0012 2zm2.5 13.5l-6 2 2-6 6-2-2 6z",
    viewBox: "0 0 24 24",
    label: "COMPASS_NAV",
  },
  gaming_esports: {
    path: "M6 7h12a4 4 0 014 4v4a3 3 0 01-3 3h-2l-2-2h-6l-2 2H5a3 3 0 01-3-3v-4a4 4 0 014-4zm3 3H7v2h2v2h2v-2h2v-2h-2V8H9v2zm8 0a1 1 0 100 2 1 1 0 000-2zm-2 3a1 1 0 100 2 1 1 0 000-2z",
    viewBox: "0 0 24 24",
    label: "GAMEPAD_PRO",
  },
  automotive_speed: {
    path: "M12 4a8 8 0 00-8 8c0 2.2.9 4.2 2.3 5.7l1.4-1.4A6 6 0 1118 12h-6l3-3",
    viewBox: "0 0 24 24",
    label: "SPEEDOMETER",
  },
  music_audio: {
    path: "M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z",
    viewBox: "0 0 24 24",
    label: "MUSIC_BEAT",
  },
};

/**
 * Catálogo de personajes arquetípicos por universo temático.
 */
export const THEMATIC_CHARACTERS: Record<string, CharacterEntity[]> = {
  sustainability_nature: [
    {
      id: "char_eco_1",
      name: "Dra. Valery Cruz",
      role: "Especialista Ambiental",
      badge: "INVESTIGACIÓN AMBIENTAL",
      accentColor: "#10B981",
      avatarType: "eco_guide",
      initials: "VC",
    },
    {
      id: "char_eco_2",
      name: "Comunidad Campus",
      role: "Participación Estudiantil",
      badge: "VOCES DEL CAMPUS",
      accentColor: "#34D399",
      avatarType: "scholar",
      initials: "CC",
    },
  ],
  anime_storytelling: [
    {
      id: "char_anime_1",
      name: "Aoi Kisaragi",
      role: "Estudiante de 3er Año",
      badge: "AOI · PROTAGONISTA",
      accentColor: "#F43F5E",
      avatarType: "anime_heroine",
      initials: "AK",
    },
    {
      id: "char_anime_2",
      name: "Ren Tachibana",
      role: "Compañero de Clase",
      badge: "REN · CO-PROTAGONISTA",
      accentColor: "#A855F7",
      avatarType: "anime_hero",
      initials: "RT",
    },
  ],
  tech_ai_software: [
    {
      id: "char_tech_1",
      name: "Alex Dev",
      role: "Lead Systems Architect",
      badge: "ARQUITECTURA CLOUD",
      accentColor: "#6366F1",
      avatarType: "tech_dev",
      initials: "AD",
    },
    {
      id: "char_tech_2",
      name: "Nova Core",
      role: "Agente IA Autónomo",
      badge: "SISTEMA COGNITIVO",
      accentColor: "#38BDF8",
      avatarType: "scholar",
      initials: "NC",
    },
  ],
  fintech_business: [
    {
      id: "char_fin_1",
      name: "Carlos Mendoza",
      role: "Director de Estrategia",
      badge: "MÉTRICAS & VALOR",
      accentColor: "#F59E0B",
      avatarType: "executive",
      initials: "CM",
    },
    {
      id: "char_fin_2",
      name: "Inversores Globales",
      role: "Comunidad de Mercado",
      badge: "ADOPCIÓN INSTITUCIONAL",
      accentColor: "#10B981",
      avatarType: "scholar",
      initials: "IG",
    },
  ],
  fitness_wellness: [
    {
      id: "char_fit_1",
      name: "Marcos V.",
      role: "Head Performance Coach",
      badge: "ALTO RENDIMIENTO",
      accentColor: "#F97316",
      avatarType: "athlete",
      initials: "MV",
    },
  ],
  education_documentary: [
    {
      id: "char_edu_1",
      name: "Prof. Alberto Silva",
      role: "Divulgador Científico",
      badge: "HISTORIA & CIENCIA",
      accentColor: "#0284C7",
      avatarType: "scholar",
      initials: "AS",
    },
  ],
  creative_cinema: [
    {
      id: "char_cine_1",
      name: "El Narrador",
      role: "Voz en Off Cinematográfica",
      badge: "RELATO DRAMÁTICO",
      accentColor: "#EAB308",
      avatarType: "executive",
      initials: "NR",
    },
  ],
  space_astrophysics: [
    {
      id: "char_space_1",
      name: "Comandante Elena Rostova",
      role: "Directora de Misión Orbital",
      badge: "TELEMETRÍA ORBITAL",
      accentColor: "#38BDF8",
      avatarType: "astro_commander",
      initials: "ER",
    },
  ],
  cybersecurity_matrix: [
    {
      id: "char_cyber_1",
      name: "Vector Zero",
      role: "Analista de Ciberdefensa",
      badge: "MONITOREO DE RED",
      accentColor: "#22C55E",
      avatarType: "cyber_specialist",
      initials: "VZ",
    },
  ],
  medical_biotech: [
    {
      id: "char_med_1",
      name: "Dr. Aris Thorne",
      role: "Director de Neurocirugía",
      badge: "DIAGNÓSTICO CLÍNICO",
      accentColor: "#06B6D4",
      avatarType: "medical_lead",
      initials: "AT",
    },
  ],
};

/**
 * MOTOR DE SÍNTESIS DE DIRECCIÓN DE ARTE Y ADN SEMÁNTICO EN TIEMPO REAL (ZERO-TEMPLATE ENGINE).
 *
 * Implementa la Fase 1 del protocolo Claude Fable 5.2:
 * 1. Analiza el prompt del usuario y la transcripción sin recurrir a categorías rígidas cerradas.
 * 2. Sintetiza una especificación completa de diseño exclusiva para esa obra audiovisual.
 * 3. Deduce psicología del color (armonía 2-tonos + contraste profundo), geometría asimétrica/HUD,
 *    partículas procedimentales continuas y metáforas vectoriales a medida.
 */
export function extractProjectSemanticDNA(options: {
  prompt: string;
  transcriptText?: string;
  projectName?: string;
}): ProjectSemanticDNA {
  const combined = `${options.prompt} ${options.transcriptText ?? ""} ${options.projectName ?? ""}`.toLowerCase();

  // 1. Detección semántica abierta y flexible del concepto central
  let category = "tech_ai_software";
  let categoryLabel = "Tecnología & Innovación";
  let emotionalTone: ProjectSemanticDNA["emotionalTone"] = "technical_analytical";
  let metaphorKind: ProjectSemanticDNA["customVisualMetaphorKind"] = "neural_network";
  let layoutStyle: ArtDirectionGeometry["layoutStyle"] = "technical_brackets";
  let particleType: ParticleAtmosphereType = "cyber_bits";

  if (
    /anime|manga|otaku|shonen|jujutsu|kimetsu|naruto|one\s*piece|colegio|escuela|instituto|personajes?|di[aá]logo\s+entre|ficci[oó]n\s+animada/i.test(
      combined,
    )
  ) {
    category = "anime_storytelling";
    categoryLabel = "Anime & Ficción Narrativa";
    emotionalTone = "dramatic_cinematic";
    metaphorKind = "chronicle_timeline";
    layoutStyle = "diagonal_kinetic";
    particleType = "sakura_petals";
  } else if (
    /espacio|universo|galaxia|astronom|orbita|planeta|cohete|nasa|marte|sat[eé]lite|telescopio/i.test(
      combined,
    )
  ) {
    category = "space_astrophysics";
    categoryLabel = "Astrofísica & Espacio Profundo";
    emotionalTone = "epic_documentary";
    metaphorKind = "quantum_orbit";
    layoutStyle = "isometric_perspective";
    particleType = "star_drift";
  } else if (
    /seguridad|hacker|ciber|ciberseguridad|vulnerabil|firewall|exploits?|malware|servidor|linux|terminal|root/i.test(
      combined,
    )
  ) {
    category = "cybersecurity_matrix";
    categoryLabel = "Ciberseguridad & Terminal Matrix";
    emotionalTone = "dark_futuristic";
    metaphorKind = "hud_brackets";
    layoutStyle = "cyber_hud";
    particleType = "cyber_bits";
  } else if (
    /cu[aá]ntic|superposici[oó]n|part[ií]cula|f[ií]sica|átomo|electr[oó]n|quark|schr[oö]dinger|fot[oó]n/i.test(
      combined,
    )
  ) {
    category = "quantum_physics";
    categoryLabel = "Física & Dinámica Cuántica";
    emotionalTone = "technical_analytical";
    metaphorKind = "quantum_orbit";
    layoutStyle = "isometric_perspective";
    particleType = "quantum_nodes";
  } else if (
    /m[eé]dic|cirug|salud|cerebro|neurona|biolog|gen[eé]tic|paciente|cl[ií]nic|tratamiento|adn/i.test(
      combined,
    )
  ) {
    category = "medical_biotech";
    categoryLabel = "Biomedicina & Ciencias de la Salud";
    emotionalTone = "technical_analytical";
    metaphorKind = "neural_network";
    layoutStyle = "technical_brackets";
    particleType = "fluid_waves";
  } else if (
    /lujo|moda|reloj|joya|elegante|haute|editorial|perfume|arquitectura|premium|alta\s+gama/i.test(
      combined,
    )
  ) {
    category = "luxury_editorial";
    categoryLabel = "Lujo & Diseño Editorial";
    emotionalTone = "dramatic_cinematic";
    metaphorKind = "generic_svg";
    layoutStyle = "minimal_swiss";
    particleType = "gold_sparks";
  } else if (
    /residuo|recicl|campus|sostenib|ambiental|ecolog|basura|material\s+recuperable|pl[aá]stico|huella\s+de\s+carbono|verde/i.test(
      combined,
    )
  ) {
    category = "sustainability_nature";
    categoryLabel = "Sostenibilidad & Medio Ambiente";
    emotionalTone = "warm_editorial";
    metaphorKind = "chronicle_timeline";
    layoutStyle = "glassmorphism_floating";
    particleType = "bio_leaves";
  } else if (
    /finanza|cripto|bitcoin|dinero|inversi[oó]n|rentabil|ahorro|costo|precio|banco|d[oó]lar|mercado|ventas|factur/i.test(
      combined,
    )
  ) {
    category = "fintech_business";
    categoryLabel = "Finanzas & Mercados Globales";
    emotionalTone = "high_energy";
    metaphorKind = "radar_telemetry";
    layoutStyle = "glassmorphism_floating";
    particleType = "gold_sparks";
  } else if (/entrena|fitness|gimnasio|atleta|rutina|ejercicio|dieta|fuerza|m[uú]sculo|wellness/i.test(combined)) {
    category = "fitness_wellness";
    categoryLabel = "Fitness & Alto Rendimiento";
    emotionalTone = "high_energy";
    metaphorKind = "radar_telemetry";
    layoutStyle = "diagonal_kinetic";
    particleType = "energy_rays";
  } else if (
    /historia\s+de|origen\s+de|biograf[ií]a|documental|qu[eé]\s+pas[oó]|por\s+qu[eé]\s+cay[oó]|ciencia|investigaci[oó]n|lecci[oó]n/i.test(
      combined,
    )
  ) {
    category = "education_documentary";
    categoryLabel = "Educación & Documental";
    emotionalTone = "epic_documentary";
    metaphorKind = "chronicle_timeline";
    layoutStyle = "asymmetric_editorial";
    particleType = "bokeh_dust";
  } else if (/cocina|receta|chef|gastronom|comida|restaurante|plato|culinar|ingrediente|sabor/i.test(combined)) {
    category = "culinary_gastronomy";
    categoryLabel = "Cocina & Alta Gastronomía";
    emotionalTone = "warm_editorial";
    metaphorKind = "chronicle_timeline";
    layoutStyle = "asymmetric_editorial";
    particleType = "gold_sparks";
  } else if (/viaje|turismo|aventura|destino|explorar|vuelo|pa[íi]s|ciudad|ruta|hotel/i.test(combined)) {
    category = "travel_adventure";
    categoryLabel = "Viajes, Destinos & Aventura";
    emotionalTone = "epic_documentary";
    metaphorKind = "radar_telemetry";
    layoutStyle = "glassmorphism_floating";
    particleType = "star_drift";
  } else if (/gameplay|videojuego|gaming|stream|esports|partida|gamer|twitch|consola|playstation/i.test(combined)) {
    category = "gaming_esports";
    categoryLabel = "Gaming & Esports Competitivo";
    emotionalTone = "high_energy";
    metaphorKind = "hud_brackets";
    layoutStyle = "cyber_hud";
    particleType = "cyber_bits";
  } else if (/auto|coche|motor|carrera|f[oó]rmula|f1|velocidad|superdeportivo|veh[íi]culo|neum[aá]tico/i.test(combined)) {
    category = "automotive_speed";
    categoryLabel = "Automoción & Alta Velocidad";
    emotionalTone = "high_energy";
    metaphorKind = "radar_telemetry";
    layoutStyle = "diagonal_kinetic";
    particleType = "energy_rays";
  } else if (/m[uú]sica|canci[oó]n|beat|sonido|audio|ritmo|concierto|artista|melod[íi]a|álbum/i.test(combined)) {
    category = "music_audio";
    categoryLabel = "Música, Sonido & Creatividad";
    emotionalTone = "high_energy";
    metaphorKind = "quantum_orbit";
    layoutStyle = "diagonal_kinetic";
    particleType = "fluid_waves";
  } else if (/cine|pel[ií]cula|trailer|tr[aá]iler|cinem[aá]tico|drama|hollywood|actor/i.test(combined)) {
    category = "creative_cinema";
    categoryLabel = "Cine & Gran Pantalla";
    emotionalTone = "dramatic_cinematic";
    metaphorKind = "generic_svg";
    layoutStyle = "asymmetric_editorial";
    particleType = "gold_sparks";
  }

  // 2. Psicología del Color y Paleta Maestra Armónica (Cero colores por defecto)
  const basePalette: HyperFramePalette =
    THEMATIC_PALETTES[category] ?? {
      accent: "#6366F1",
      secondary: "#38BDF8",
      surface: "#0B0F19",
      text: "#F8FAFC",
    };

  const seedString = `${options.prompt} ${options.projectName ?? "oeclip"}`;
  const masterPalette =
    detectExplicitPaletteFromPrompt(options.prompt) ??
    synthesizeHarmoniousPalette(basePalette, seedString);

  const iconSpec = THEMATIC_SVG_ICONS[category] ?? THEMATIC_SVG_ICONS["tech_ai_software"]!;

  // 3. Extracción y Síntesis Dinámica de Personajes y Portavoces (Cero plantillas fijas)
  const characters: CharacterEntity[] = [];
  const nameMatch = options.prompt.match(
    /(?:con|de|llamado|protagonista|orador|personaje|avatar|profesor|doctor|chef|directora?)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i,
  );

  const seedHash = djb2Hash(seedString);

  if (nameMatch && nameMatch[1]) {
    const rawName = nameMatch[1].trim();
    const initials = rawName
      .split(/\s+/)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 2);
    characters.push({
      id: `char_dyn_1`,
      name: rawName,
      role: `${categoryLabel} · Presentador`,
      badge: rawName.toUpperCase(),
      accentColor: masterPalette.accent,
      avatarType: category === "anime_storytelling" ? "anime_hero" : "scholar",
      initials: initials || "EX",
    });
  } else {
    // Generar nombres originales y contextuales según el tema
    const ANIME_NAMES = [
      ["Kaito Takahashi", "Sora Minami"],
      ["Ren Tachibana", "Aoi Kisaragi"],
      ["Maya Shirogane", "Kenji Sato"],
      ["Hikari Kuroki", "Daiki Asuka"],
      ["Yuki Morikawa", "Haruto Shin"],
    ];
    const TECH_NAMES = [
      ["Dra. Elena Silva", "Marcos Vance"],
      ["Alex Calderón", "Sofía Chen"],
      ["Gabriel Thorne", "Clara Morales"],
    ];
    const CULINARY_NAMES = [
      ["Chef Andrés Vega", "Camila Ortiz"],
      ["Mateo Serrano", "Lucía Morales"],
    ];
    const GENERAL_NAMES = [
      ["Carlos Mendoza", "Valeria Cruz"],
      ["David Ramos", "Elena Rostova"],
      ["Natalia Sanz", "Javier Rivas"],
    ];

    const pool =
      category === "anime_storytelling"
        ? ANIME_NAMES
        : category.includes("tech") || category.includes("cyber")
        ? TECH_NAMES
        : category === "culinary_gastronomy"
        ? CULINARY_NAMES
        : GENERAL_NAMES;

    const pair = pool[seedHash % pool.length]!;
    characters.push(
      {
        id: `char_${category}_1`,
        name: pair[0]!,
        role: "Voz Principal",
        badge: pair[0]!.toUpperCase(),
        accentColor: masterPalette.accent,
        avatarType: category === "anime_storytelling" ? "anime_hero" : "scholar",
        initials: pair[0]!.split(" ").map((w) => w[0]).join("").slice(0, 2),
      },
      {
        id: `char_${category}_2`,
        name: pair[1]!,
        role: "Co-Protagonista",
        badge: pair[1]!.toUpperCase(),
        accentColor: masterPalette.secondary,
        avatarType: category === "anime_storytelling" ? "anime_heroine" : "tech_dev",
        initials: pair[1]!.split(" ").map((w) => w[0]).join("").slice(0, 2),
      },
    );
  }

  // 4. Geometría y Layout A Medida
  const geometry: ArtDirectionGeometry = {
    layoutStyle,
    clipPath:
      layoutStyle === "diagonal_kinetic"
        ? "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)"
        : layoutStyle === "cyber_hud"
        ? "polygon(0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%)"
        : undefined,
    borderRadius:
      layoutStyle === "cyber_hud"
        ? "4px"
        : layoutStyle === "minimal_swiss"
        ? "0px"
        : layoutStyle === "diagonal_kinetic"
        ? "14px"
        : "22px",
    borderStyle:
      layoutStyle === "cyber_hud"
        ? `1.5px solid ${masterPalette.accent}88`
        : `1px solid rgba(255, 255, 255, 0.16)`,
    headerBracket:
      layoutStyle === "cyber_hud"
        ? "[ SYS // TELEMETRÍA ]"
        : layoutStyle === "diagonal_kinetic"
        ? "● ACTIVO // 60 FPS"
        : "DATOS CLAVE",
  };

  // 5. Atmósfera Procedimental y Fórmulas de Gradientes Profundos
  const atmosphereGradients: [string, string, string] = [
    masterPalette.surface,
    hslToHex(hexToHsl(masterPalette.surface)[0], 25, 3),
    "#020306",
  ];

  // 6. Extracción de Vocabulario Dinámico del Guion y Prompt (Cero cadenas quemadas)
  const rawWords = options.prompt
    .replace(/[¿?¡!.,;:"'()\[\]]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(
      (w) =>
        w.length >= 4 &&
        !/^(este|esta|para|como|sobre|todo|hacer|crear|genera|video|vídeo|quiero|poner|desde|escena|scene|acto|bloque|parte|segmento|shot|clip|duraci[oó]n|segundos?|formato|vertical|horizontal|estructura|obligatoria|gancho|cierre|demo|apertura|visual|fondo|pantalla|claro|propuesta|valor)$/i.test(
          w,
        ),
    );

  const uniqueTopicWords = Array.from(new Set(rawWords)).slice(0, 4);
  const primaryTopic = uniqueTopicWords[0]?.toUpperCase() || categoryLabel.toUpperCase();

  const kickerTags: string[] = [
    primaryTopic === "ESCENA" ? "ESTUDIO · IA" : `${primaryTopic} · STUDIO`,
    uniqueTopicWords[1] ? `ENFOQUE: ${uniqueTopicWords[1].toUpperCase()}` : "CLAVE ESTRATÉGICA",
    uniqueTopicWords[2] ? `IMPACTO: ${uniqueTopicWords[2].toUpperCase()}` : "DATO DETERMINANTE",
    "CONCLUSIÓN Y CIERRE",
  ];

  const suggestedBadges: string[] = [
    `01 · ${uniqueTopicWords[0]?.toUpperCase() || "INICIO"}`,
    `02 · ${uniqueTopicWords[1]?.toUpperCase() || "DESARROLLO"}`,
    `03 · ${uniqueTopicWords[2]?.toUpperCase() || "EVIDENCIA"}`,
    "PASO FINAL",
  ];

  const cleanTopicTitle = options.prompt
    .replace(/^(hazme|genera(r)?|crea(r)?|edita(r)?)\s+(un\s+|este\s+|el\s+)?(video|vídeo|reel|trailer|tráiler)\s*(completo|dinámico|profesional)?\s*(de|sobre)?\s*/i, "")
    .trim()
    .slice(0, 40);

  const ctaPhrase = cleanTopicTitle
    ? `Comenta qué opinas sobre ${cleanTopicTitle.toLowerCase()} y síguenos para más.`
    : "Guarda este contenido y compártelo con tu comunidad.";

  const vocabulary = {
    kickerTags,
    metricUnits: ["%", "x", "k", "pts"],
    suggestedBadges,
    ctaPhrase,
  };

  return {
    category,
    categoryLabel,
    themeKicker: vocabulary.kickerTags[0]!,
    emotionalTone,
    masterPalette,
    paletteTheory: {
      accentGlow: `${masterPalette.accent}44`,
      contrastText: masterPalette.text,
      surfaceShade: masterPalette.surface,
      ambientGradients: atmosphereGradients,
    },
    geometry,
    atmosphere: {
      backgroundGradients: atmosphereGradients,
      particleType,
      glowColor: masterPalette.accent,
      meshNoise: true,
    },
    thematicSvgIcon: iconSpec.path,
    thematicIconType: iconSpec.label,
    customVisualMetaphorKind: metaphorKind,
    characters,
    vocabulary,
  };
}
