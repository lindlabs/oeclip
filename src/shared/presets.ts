export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:5" | "21:9";

export interface AspectPreset {
  id: AspectRatio;
  label: string;
  ratio: number;
  widthRatio: number;
  heightRatio: number;
}

export const ASPECT_PRESETS: Record<AspectRatio, AspectPreset> = {
  "16:9": { id: "16:9", label: "Horizontal 16:9", ratio: 16 / 9, widthRatio: 16, heightRatio: 9 },
  "9:16": { id: "9:16", label: "Vertical 9:16", ratio: 9 / 16, widthRatio: 9, heightRatio: 16 },
  "1:1": { id: "1:1", label: "Cuadrado 1:1", ratio: 1, widthRatio: 1, heightRatio: 1 },
  "4:5": { id: "4:5", label: "Retrato 4:5", ratio: 4 / 5, widthRatio: 4, heightRatio: 5 },
  "21:9": { id: "21:9", label: "Cine 21:9", ratio: 21 / 9, widthRatio: 21, heightRatio: 9 },
};

export function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Devuelve dimensiones pares para un aspect y una resolución base (480, 720,
 * 1080, 2160...). La resolución se aplica al LADO CORTO: así un 9:16 a 1080
 * entrega 1080x1920 (no 608x1080, que era el error que dejaba el vertical con
 * bandas negras y poca nitidez), un 16:9 entrega 1920x1080 y un 4:5, 1080x1350.
 */
export function dimensionsFor(aspect: AspectRatio, resolution: number): { width: number; height: number } {
  const preset = ASPECT_PRESETS[aspect];
  const shortEdge = even(resolution);
  if (preset.ratio >= 1) {
    return { width: even(shortEdge * preset.ratio), height: shortEdge };
  }
  return { width: shortEdge, height: even(shortEdge / preset.ratio) };
}

export function aspectForDimensions(width: number, height: number): AspectRatio {
  const ratio = width / height;
  let best: AspectRatio = "16:9";
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const preset of Object.values(ASPECT_PRESETS)) {
    const delta = Math.abs(preset.ratio - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = preset.id;
    }
  }
  return best;
}

export const RESOLUTION_HEIGHTS = [480, 720, 1080, 1440, 2160] as const;
export type ResolutionHeight = (typeof RESOLUTION_HEIGHTS)[number];

export const EXPORT_FPS = [24, 25, 30, 50, 60] as const;
export type ExportFps = (typeof EXPORT_FPS)[number];
