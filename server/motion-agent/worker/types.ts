/**
 * Tipos compartidos entre el pool de render (hilo principal) y el worker.
 *
 * El worker real vive en `renderWorker.mjs` (JavaScript puro) para no depender
 * de un artefacto compilado que se quede obsoleto. Este archivo solo contiene
 * los tipos que usa el resto del servidor.
 */

export interface RenderJob {
  id: string;
  type: "preview" | "final";
  componentCode: string;
  componentName: string;
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props?: Record<string, unknown>;
  outputPath?: string;
  /** Si true, renderiza con canal alfa (WebM/VP9) para overlay transparente. */
  transparentBackground?: boolean;
  /** Ventana a renderizar, en frames absolutos de la composición (ambos inclusive). */
  frameRange?: [number, number];
  /** Escala de salida: 0.5 = mitad de resolución. La composición no cambia. */
  scale?: number;
  /** Clave de caché del bundle: mismo código + misma composición = mismo bundle. */
  bundleKey?: string;
  concurrency?: number;
  crf?: number;
}

export interface RenderProgress {
  id: string;
  stage: "bundle" | "render";
  /** 0..1 */
  progress: number;
  renderedFrames?: number;
  encodedFrames?: number;
}

export interface RenderResult {
  id: string;
  success: boolean;
  videoPath?: string;
  base64Video?: string;
  error?: string;
  durationMs: number;
  bundleMs?: number;
  renderMs?: number;
  bundleCached?: boolean;
}
