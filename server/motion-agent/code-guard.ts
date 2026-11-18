import { transform } from "esbuild";

/**
 * Guardas de código para los componentes Remotion generados por el LLM.
 *
 * El modelo a veces devuelve fences de markdown, imports de paquetes que no
 * existen en el sandbox o helpers inventados (por ejemplo `linear`). Aquí se
 * limpia el código y se valida la sintaxis antes de mandarlo al bundler para
 * no gastar un render completo en errores evitables.
 */

/**
 * Elimina emojis y caracteres no imprimibles de un texto.
 */
export function stripEmojis(text: string): string {
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "") // Emoticons
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, "") // Símbolos y pictogramas
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "") // Transporte y mapas
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "") // Banderas
    .replace(/[\u{2600}-\u{26FF}]/gu, "") // Símbolos varios
    .replace(/[\u{2700}-\u{27BF}]/gu, "") // Dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "") // Variantes de presentación
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, "") // Símbolos suplementarios
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, "") // Símbolos extendidos
    .replace(/[^\S\r\n]+/g, " ") // Normalizar espacios horizontales SIN aplanar saltos de línea (\r\n / \n)
    .trim();
}

/**
 * Limpia emojis recursivamente en cualquier estructura de datos.
 * Preserva las propiedades de código TSX intactas para no aplanar líneas ni corromper sintaxis.
 */
export function cleanEmojis(obj: any): any {
  if (typeof obj === "string") return stripEmojis(obj);
  if (Array.isArray(obj)) return obj.map(cleanEmojis);
  if (obj && typeof obj === "object") {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // NO alterar ni aplanar el código fuente de componentes
      if (key === "code" || key === "componentCode" || (key === "content" && obj.type === "component")) {
        cleaned[key] = value;
      } else {
        cleaned[key] = cleanEmojis(value);
      }
    }
    return cleaned;
  }
  return obj;
}

/** Módulos que el bundler del worker puede resolver. */
const ALLOWED_MODULES = new Set(["react", "react/jsx-runtime", "remotion"]);

/** Exports reales de remotion que usamos con frecuencia. */
const REMOTION_EXPORTS = new Set([
  "AbsoluteFill",
  "AbsoluteFillObject",
  "Audio",
  "Composition",
  "Easing",
  "Folder",
  "Freeze",
  "Html5Audio",
  "Html5Video",
  "Img",
  "Loop",
  "OffthreadVideo",
  "Sequence",
  "Series",
  "Still",
  "Video",
  "cancelRender",
  "continueRender",
  "delayRender",
  "getInputProps",
  "getRemotionEnvironment",
  "interpolate",
  "interpolateColors",
  "measureSpring",
  "random",
  "registerRoot",
  "spring",
  "staticFile",
  "useBufferState",
  "useCurrentFrame",
  "useCurrentScale",
  "useDelayRender",
  "useVideoConfig",
]);

/** Nombres que el modelo inventa y que no son exports de remotion. */
const INVALID_REMOTION_EXPORTS = new Set(["linear", "easeLinear", "EasingLinear"]);

function stripCodeFences(input: string): string {
  let text = input.replace(/^\uFEFF/, "").trim();

  const fence = text.match(/```(?:tsx|ts|typescript|jsx|js)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1];

  text = text.replace(/^```[\w-]*\s*/, "").replace(/```\s*$/, "").trim();

  // Algunos modelos anteponen una frase ("Aquí tienes el componente:").
  const start = text.search(/^(import|export|const|function|type|interface)\b/m);
  if (start > 0) {
    const prefix = text.slice(0, start);
    if (!/^\s*(?:\/\/|\/\*|\*)/.test(prefix)) text = text.slice(start);
  }

  return text.trim();
}

/** Extrae el código de las distintas formas de respuesta que produce el LLM. */
export function extractCodeFromData(data: unknown): string {
  if (typeof data === "string") return stripCodeFences(data);
  if (!data || typeof data !== "object") return "";

  const record = data as Record<string, unknown>;
  for (const key of ["code", "tsx", "componentCode", "source"]) {
    const value = record[key];
    if (typeof value === "string") return stripCodeFences(value);
    // Algunos modelos anidan el código en un objeto dentro de "code".
    if (value && typeof value === "object") {
      const nested = extractCodeFromData(value);
      if (nested) return nested;
    }
  }
  if (record.component && typeof record.component === "object") {
    const component = record.component as Record<string, unknown>;
    if (typeof component.code === "string") return stripCodeFences(component.code);
  }
  if (record.data && typeof record.data === "object") {
    return extractCodeFromData(record.data);
  }
  return "";
}

function detectExportName(code: string): string {
  const named = code.match(/export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/);
  if (named && named[1]) return named[1];
  const defaultFunction = code.match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
  if (defaultFunction && defaultFunction[1]) return defaultFunction[1];
  return "";
}

/** Garantiza que el archivo tenga un export nombrado y devuelve su nombre. */
function ensureNamedExport(code: string): { code: string; name: string } {
  const detected = detectExportName(code);
  if (detected) {
    const normalized = code.replace(/export\s+default\s+function\s+/, "export function ");
    return { code: normalized, name: detected };
  }

  const defaultIdentifier = code.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
  if (defaultIdentifier && defaultIdentifier[1]) {
    const name = defaultIdentifier[1];
    return {
      code: code.replace(/export\s+default\s+[A-Za-z_$][\w$]*\s*;?/, `export { ${name} };`),
      name,
    };
  }

  const declaration = code.match(/(?:^|\n)(const|function)\s+([A-Z][\w$]*)\s*[=(<]/);
  if (declaration && declaration[1] && declaration[2]) {
    const keyword = declaration[1];
    const name = declaration[2];
    const withExport = code.replace(new RegExp(`(^|\\n)(${keyword})\\s+${name}\b`), `$1export $2 ${name}`);
    return { code: withExport, name };
  }

  return { code, name: "" };
}

/** Quita imports no permitidos y nombres inventados de remotion. */
function sanitizeImports(code: string): string {
  return code.replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g, (full, specifiers: string, source: string) => {
    if (!ALLOWED_MODULES.has(source)) return "";

    if (source !== "remotion") return full;
    if (!specifiers.trim().startsWith("{")) return full;

    const cleaned = specifiers
      .replace(/[{}]/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => {
        const importedName = part.split(/\s+as\s+/)[0]!.trim();
        return REMOTION_EXPORTS.has(importedName) && !INVALID_REMOTION_EXPORTS.has(importedName);
      });

    if (cleaned.length === 0) return "";
    return `import { ${cleaned.join(", ")} } from "remotion";`;
  });
}

/** APIs que el modelo usa a menudo sin importar. */
const AUTO_IMPORT_CANDIDATES = [
  "AbsoluteFill",
  "Easing",
  "interpolate",
  "interpolateColors",
  "random",
  "Sequence",
  "Series",
  "spring",
  "useCurrentFrame",
  "useVideoConfig",
] as const;

/**
 * Añade los imports de remotion que el código usa pero no declara.
 * Evita un render fallido (y una reparación con IA) por un olvido mecánico.
 */
function ensureRemotionImports(code: string): string {
  const importMatch = code.match(/import\s*\{([^}]*)\}\s*from\s*["']remotion["'];?/);
  const imported = new Set(
    (importMatch?.[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+/)[0]!.trim()),
  );

  const needed: string[] = [];
  for (const name of AUTO_IMPORT_CANDIDATES) {
    if (imported.has(name)) continue;
    const usage =
      name === "AbsoluteFill"
        ? /<AbsoluteFill\b/
        : new RegExp(`(?<![.\\w$])${name}\\b`);
    if (usage.test(code)) needed.push(name);
  }

  if (needed.length === 0) return code;

  if (importMatch) {
    const all = [...imported, ...needed];
    return code.replace(
      importMatch[0],
      `import { ${all.join(", ")} } from "remotion";`,
    );
  }

  return `import { ${needed.join(", ")} } from "remotion";\n${code}`;
}

export interface SanitizedComponent {
  code: string;
  name: string;
}

/**
 * Si el código fuente viene en una sola línea (por ejemplo, serializado sin saltos
 * de línea por un modelo), cualquier comentario `//` comentaría el resto del código
 * provocando `Unexpected end of file`. Esta función preserva los saltos de línea.
 */
function repairSingleLineComments(code: string): string {
  if (!code.includes("\n")) {
    // Si no contiene saltos de línea pero tiene comentarios //, convertirlos o añadir \n antes de la siguiente instrucción
    return code.replace(
      /\/\/\s*([^\r\n;{}]+?)(?=\s+(?:const|let|var|for|return|if|switch|function|<[a-zA-Z])\b)/g,
      "/* $1 */\n",
    );
  }
  return code;
}

/**
 * Limpia fences, imports inseguros y garantiza un export nombrado.
 * No valida sintaxis: eso lo hace `validateTsx` para poder reparar con el error.
 */
export function sanitizeComponentCode(input: string): SanitizedComponent {
  let code = stripCodeFences(input);
  code = repairSingleLineComments(code);
  code = sanitizeImports(code);
  code = ensureRemotionImports(code);
  const exported = ensureNamedExport(code);
  return { code: exported.code.trim(), name: exported.name };
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Detecta llamadas a `interpolate` e `interpolateColors` defectuosas:
 * 1. `outputRange` ausente o undefined: `interpolate(val, [0, 1])`
 * 2. `inputRange` con valores no monótonos o repetidos.
 */
function checkInterpolateRanges(code: string): string | null {
  // 1. Detectar interpolate/interpolateColors con solo 2 argumentos (falta outputRange)
  // Ej: interpolate(frame, [0, 10]) o interpolate(frame, [0, 10], { extrapolateRight: ... })
  const missingOutputPattern = /interpolate(?:Colors)?\s*\(\s*[^,()]+\s*,\s*\[[^\]]*\]\s*(?:,\s*\{[^}]*\}\s*)?\)/g;
  for (const match of code.matchAll(missingOutputPattern)) {
    const callStr = match[0];
    // Si no tiene un segundo array o lista de colores como outputRange
    const arrayCount = (callStr.match(/\[[^\]]*\]/g) || []).length;
    if (arrayCount < 2) {
      return `interpolate requiere obligatoriamente 'outputRange' como 3er argumento: interpolate(frame, [inputStart, inputEnd], [outputStart, outputEnd]). Encontré: ${callStr}`;
    }
  }

  const patterns = [
    /interpolate\s*\(\s*[^,()]+,\s*\[([^\]]*)\]/g,
    /interpolateColors\s*\(\s*[^,()]+,\s*\[([^\]]*)\]/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const raw = match[1] ?? "";
      const values = raw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value));
      if (values.length < 2) continue;
      for (let index = 1; index < values.length; index += 1) {
        if (values[index]! <= values[index - 1]!) {
          return `inputRange debe ser estrictamente creciente; recibí [${raw.trim()}]. Usa tiempos distintos (suma 1 frame cuando coincidan) y ordena los valores.`;
        }
      }
    }
  }
  return null;
}

/** Valida la sintaxis TSX con esbuild sin ejecutar el componente. */
export async function validateTsx(code: string): Promise<ValidationResult> {
  const rangeError = checkInterpolateRanges(code);
  if (rangeError) return { ok: false, error: rangeError };
  try {
    await transform(code, {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
      target: "es2020",
    });
    return { ok: true };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    return {
      ok: false,
      error: message.split("\n").slice(0, 10).join("\n").slice(0, 1500),
    };
  }
}

/** Duración razonable para un motion graphic dentro del editor. */
export function clampDurationFrames(value: unknown, fps: number, maxFrames = 900): number {
  const numeric = Number(value);
  const fallback = Math.round(3 * fps);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(Math.round(fps * 0.5), Math.min(Math.max(900, maxFrames), Math.round(numeric)));
}

/** Busca "4 segundos", "2.5s", "3 seg" en el mensaje. */
export function secondsToFrames(message: string, fps: number): number | null {
  const match = message.match(/(\d+(?:[.,]\d+)?)\s*(?:segundos?|segs?|secs?|s)\b/i);
  if (!match || !match[1]) return null;
  const seconds = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * fps);
}