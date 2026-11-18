import { z } from "zod";

const idSchema = z.string().min(3).max(80).regex(/^[a-zA-Z0-9_]+$/);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const rationalSchema = z.object({
  num: z.number().int().positive().max(120000),
  den: z.number().int().positive().max(10000),
});
const relativeFileSchema = z
  .string()
  .min(1)
  .max(260)
  .regex(/^(media|proxies|generated|exports)\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const aspectSchema = z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]);

export const projectSettingsSchema = z.object({
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(7680),
  fps: rationalSchema,
  aspect: aspectSchema,
  sampleRate: z.number().int().min(8000).max(192000),
});

export const mediaAssetSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(255),
  kind: z.enum(["video", "audio", "image"]),
  file: relativeFileSchema,
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().min(0),
  durationUs: z.number().int().min(0),
  width: z.number().int().min(0).max(16384).optional(),
  height: z.number().int().min(0).max(16384).optional(),
  fps: rationalSchema.optional(),
  videoCodec: z.string().max(80).optional(),
  audioCodec: z.string().max(80).optional(),
  sampleRate: z.number().int().min(0).max(384000).optional(),
  channels: z.number().int().min(0).max(32).optional(),
  rotation: z.number().int().min(-360).max(360).optional(),
  thumbnail: z.enum(["pending", "ready", "error"]).default("pending"),
  waveform: z.enum(["none", "pending", "ready", "error"]).default("none"),
  proxy: z.enum(["none", "pending", "ready", "error"]).default("none"),
  proxyFile: relativeFileSchema.optional(),
  importedAt: z.string().datetime(),
  origin: z.enum(["import", "demo", "generated"]).default("import"),
  missing: z.boolean().optional(),
});

const transformSchema = z.object({
  x: z.number().min(-200).max(200),
  y: z.number().min(-200).max(200),
  scale: z.number().min(0.05).max(5),
  rotation: z.number().min(-360).max(360),
  opacity: z.number().min(0).max(1).default(1),
  keyframes: z.array(z.object({
    frame: z.number().int().min(0),
    scale: z.number().min(0.05).max(5),
    x: z.number().min(-200).max(200).optional(),
    y: z.number().min(-200).max(200).optional(),
  })).optional(),
  animationIn: z.enum([
    "none", "fade-in", "slide-left", "slide-right", "slide-up", "slide-down",
    "zoom-in", "bounce-in",
  ]).default("none"),
  animationInDuration: z.number().int().min(0).max(600).default(30),
  animationOut: z.enum([
    "none", "fade-out", "slide-left", "slide-right", "slide-up", "slide-down",
    "zoom-out", "bounce-out",
  ]).default("none"),
  animationOutDuration: z.number().int().min(0).max(600).default(30),
});

const cropSchema = z.object({
  top: z.number().min(0).max(0.48),
  right: z.number().min(0).max(0.48),
  bottom: z.number().min(0).max(0.48),
  left: z.number().min(0).max(0.48),
});

const adjustmentsSchema = z.object({
  brightness: z.number().min(0).max(2),
  contrast: z.number().min(0).max(2),
  saturation: z.number().min(0).max(2),
});

/**
 * Especificación de un componente Remotion TSX vivo asociado a un clip.
 * Permite previsualizar y editar propiedades (textos, colores, subtítulos) en
 * tiempo real en el monitor sin esperar un re-render de video WebM.
 */
export const remotionComponentSchema = z.object({
  code: z.string().min(1).max(300_000),
  componentName: z.string().min(1).max(160),
  compositionId: z.string().min(1).max(160).default("MotionComp"),
  props: z.record(z.unknown()).default({}),
  styleId: z.string().max(80).optional(),
  live: z.boolean().default(true),
});

export type RemotionComponentSpec = z.infer<typeof remotionComponentSchema>;

const mediaClipSchema = z.object({
  id: idSchema,
  type: z.enum(["video", "audio", "image"]),
  name: z.string().min(1).max(255),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  mediaId: idSchema,
  sourceInUs: z.number().int().min(0),
  sourceOutUs: z.number().int().min(1),
  speed: z.number().min(0.25).max(4),
  volume: z.number().min(0).max(2),
  opacity: z.number().min(0).max(1),
  transform: transformSchema,
  crop: cropSchema,
  adjustments: adjustmentsSchema,
  fadeInFrames: z.number().int().min(0).max(100000),
  fadeOutFrames: z.number().int().min(0).max(100000),
  transitionType: z.enum(["none", "fade", "crossfade", "zoom", "slide"]).default("none"),
  audioEnhance: z.enum(["none", "voice"]),
  createdBy: z.enum(["user", "agent", "demo"]).default("user"),
  /** Componente Remotion TSX editable asociado al clip. */
  remotion: remotionComponentSchema.optional(),
});

/**
 * Gráfico de datos animado que viaja con un clip de texto. Se dibuja en el
 * preview y en la capa Remotion; el texto del clip sigue siendo el título
 * editable en la línea de tiempo.
 */
export const dataGraphicSchema = z.object({
  kind: z.enum(["bars", "counter", "progress", "title-card", "accent"]),
  title: z.string().max(160).optional(),
  subtitle: z.string().max(160).optional(),
  unit: z.string().max(12).optional(),
  value: z.number().optional(),
  decimals: z.number().int().min(0).max(3).default(0),
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        value: z.number(),
        color: hexColor.optional(),
      }),
    )
    .min(1)
    .max(8)
    .optional(),
  maxValue: z.number().positive().optional(),
  color: hexColor.default("#FFD44A"),
  trackColor: hexColor.default("#FFFFFF"),
  background: z.boolean().default(true),
  backgroundOpacity: z.number().min(0).max(1).default(0.72),
  position: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  width: z.number().min(0.2).max(1).default(0.82),
  height: z.number().min(0.1).max(0.9).default(0.38),
  shape: z.enum(["circle", "line", "square"]).default("circle"),
  animation: z.enum(["grow", "fade"]).default("grow"),
});

const textClipSchema = z.object({
  id: idSchema,
  type: z.literal("text"),
  name: z.string().min(1).max(255),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  role: z.enum(["title", "subtitle", "caption"]),
  fontSize: z.number().min(8).max(400),
  fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(900)]),
  color: hexColor,
  background: z.boolean(),
  backgroundOpacity: z.number().min(0).max(1),
  backgroundColor: hexColor.default("#101813"),
  backgroundPadding: z.number().min(0).max(80).default(14),
  fontFamily: z.enum(["inter", "grandstander", "anton", "bebas", "playfair", "space-grotesk"]).default("inter"),
  textTransform: z.enum(["none", "upper", "lower"]).default("none"),
  strokeWidth: z.number().min(0).max(40).default(0),
  strokeColor: hexColor.default("#000000"),
  shadow: z.number().min(0).max(40).default(4),
  shadowColor: hexColor.default("#000000"),
  position: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  align: z.enum(["left", "center", "right"]),
  maxWidth: z.number().min(0.1).max(1),
  lineHeight: z.number().min(0.8).max(2),
  fadeFrames: z.number().int().min(0).max(10000),
  createdBy: z.enum(["user", "agent", "demo"]).default("user"),
  sourceMediaId: z.string().min(3).max(80).optional(),
  opacity: z.number().min(0).max(1).default(1),
  animationIn: z.enum([
    "none", "fade-in", "slide-left", "slide-right", "slide-up", "slide-down",
    "zoom-in", "bounce-in",
  ]).default("none"),
  animationInDuration: z.number().int().min(0).max(600).default(30),
  animationOut: z.enum([
    "none", "fade-out", "slide-left", "slide-right", "slide-up", "slide-down",
    "zoom-out", "bounce-out",
  ]).default("none"),
  animationOutDuration: z.number().int().min(0).max(600).default(30),
  /** Gráfico de datos opcional (barras, contador, progreso, tarjeta o acento). */
  graphic: dataGraphicSchema.optional(),
  /** Componente Remotion TSX editable en vivo sobre el monitor. */
  remotion: remotionComponentSchema.optional(),
});

export const timelineClipSchema = z.discriminatedUnion("type", [mediaClipSchema, textClipSchema]);

export const trackSchema = z.object({
  id: idSchema,
  kind: z.enum(["video", "audio", "text"]),
  name: z.string().min(1).max(80),
  clips: z.array(timelineClipSchema).max(3000),
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  volume: z.number().min(0).max(2),
});

export const exportSettingsSchema = z.object({
  resolution: z.union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]),
  aspect: aspectSchema,
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
  quality: z.enum(["draft", "standard", "high"]),
  encoder: z.enum(["auto", "cpu", "nvidia"]),
  /** Motor de la capa de gráficos: drawtext nativo o Remotion con springs. */
  engine: z.enum(["ffmpeg", "remotion"]).default("ffmpeg"),
  fileName: z.string().min(1).max(120),
});

export const exportVerificationSchema = z.object({
  durationUs: z.number().int().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  videoCodec: z.string().max(80).optional(),
  audioCodec: z.string().max(80).optional(),
  fps: z.number().min(0).optional(),
  sizeBytes: z.number().int().min(0),
});

export const exportRecordSchema = z.object({
  id: idSchema,
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  progress: z.number().min(0).max(1),
  settings: exportSettingsSchema,
  outputFile: relativeFileSchema.optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  etaSeconds: z.number().min(0).optional(),
  error: z.string().max(4000).optional(),
  verification: exportVerificationSchema.optional(),
  logTail: z.string().max(6000).optional(),
});

export const agentStepSchema = z.object({
  id: idSchema,
  tool: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  reason: z.string().max(600).optional(),
  args: z.record(z.unknown()),
  risk: z.enum(["low", "medium", "high"]),
  status: z.enum(["pending", "running", "done", "failed", "skipped"]),
  result: z.string().max(4000).optional(),
  error: z.string().max(4000).optional(),
  durationMs: z.number().min(0).optional(),
});

export const agentPlanSchema = z.object({
  id: idSchema,
  instruction: z.string().min(1).max(4000),
  summary: z.string().min(1).max(2000),
  source: z.enum(["llm", "local"]),
  steps: z.array(agentStepSchema).min(1).max(40),
  warnings: z.array(z.string().max(600)).max(20),
  createdAt: z.string().datetime(),
  status: z.enum(["proposed", "running", "done", "failed", "cancelled"]),
});

export const agentStepResultSchema = z.object({
  stepId: idSchema,
  tool: z.string().max(64),
  status: z.enum(["done", "failed", "skipped"]),
  summary: z.string().max(4000),
  error: z.string().max(4000).optional(),
  durationMs: z.number().min(0),
});

export const agentInteractiveCardSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
  /** Estilos visuales inline para previsualizar la tarjeta en el chat */
  preview: z
    .object({
      fontFamily: z.string().max(120).optional(),
      fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(900)]).optional(),
      fontSize: z.number().min(8).max(72).optional(),
      color: z.string().max(20).optional(),
      background: z.string().max(20).optional(),
      textTransform: z.enum(["none", "uppercase", "lowercase"]).optional(),
      padding: z.string().max(40).optional(),
      borderRadius: z.string().max(20).optional(),
      boxShadow: z.string().max(200).optional(),
      border: z.string().max(200).optional(),
    })
    .optional(),
  /** Argumentos que se envían a la herramienta al hacer clic */
  args: z.record(z.unknown()).default({}),
  /** Nombre de la herramienta a ejecutar al hacer clic */
  tool: z.string().min(1).max(64),
  /** Si es true, la tarjeta ya fue usada y se muestra como aplicada */
  applied: z.boolean().default(false),
});

export const agentSuggestionChipSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  /** Instrucción que se envía al agente al hacer clic */
  instruction: z.string().min(1).max(500),
  icon: z.string().max(40).optional(),
});

export const agentMessageSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  text: z.string().max(8000),
  at: z.string().datetime(),
  kind: z.enum(["text", "plan", "result", "error", "info", "interactive_cards", "action_feedback", "suggestion_chips"]).default("text"),
  plan: agentPlanSchema.optional(),
  results: z.array(agentStepResultSchema).max(40).optional(),
  /** Para kind="interactive_cards": título, texto y tarjetas clickeables */
  interactiveTitle: z.string().max(200).optional(),
  interactiveText: z.string().max(1000).optional(),
  cards: z.array(agentInteractiveCardSchema).max(24).optional(),
  /** Para kind="action_feedback": confirmación visual de edición aplicada */
  actionLabel: z.string().max(200).optional(),
  actionDetail: z.string().max(500).optional(),
  /** Para kind="suggestion_chips": sugerencias rápidas tras una respuesta */
  suggestions: z.array(agentSuggestionChipSchema).max(8).optional(),
});

export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    name: z.string().min(1).max(160),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    revision: z.number().int().min(0),
    settings: projectSettingsSchema,
    media: z.array(mediaAssetSchema).max(2000),
    tracks: z.array(trackSchema).min(1).max(24),
    exports: z.array(exportRecordSchema).max(100),
    agentMessages: z.array(agentMessageSchema).max(300),
  })
  .superRefine((project, ctx) => {
    const mediaIds = new Set(project.media.map((m) => m.id));
    const trackIds = new Set<string>();
    const clipIds = new Set<string>();
    for (const track of project.tracks) {
      if (trackIds.has(track.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Track duplicada: ${track.id}` });
      }
      trackIds.add(track.id);
      const ranges: Array<{ start: number; end: number; id: string }> = [];
      for (const clip of track.clips) {
        if (clipIds.has(clip.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Clip duplicado: ${clip.id}` });
        }
        clipIds.add(clip.id);
        if (clip.type === "text" && track.kind !== "text") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Clip de texto en pista ${track.kind}` });
        }
        if ((clip.type === "video" || clip.type === "image") && track.kind !== "video") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Clip visual en pista ${track.kind}` });
        }
        if (clip.type === "audio" && track.kind !== "audio") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Clip de audio en pista ${track.kind}` });
        }
        if (clip.type !== "text") {
          if (!mediaIds.has(clip.mediaId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Media inexistente: ${clip.mediaId}` });
          }
          if (clip.sourceOutUs <= clip.sourceInUs) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Recorte inválido en ${clip.id}` });
          }
          if (track.kind !== "text") {
            ranges.push({ start: clip.startFrame, end: clip.startFrame + clip.durationFrames, id: clip.id });
          }
        }
      }
      ranges.sort((a, b) => a.start - b.start);
      for (let i = 1; i < ranges.length; i += 1) {
        const prev = ranges[i - 1];
        const curr = ranges[i];
        if (prev && curr && curr.start < prev.end) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Solapamiento entre ${prev.id} y ${curr.id} en pista ${track.name}`,
          });
        }
      }
    }
  });

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaClip = z.infer<typeof mediaClipSchema>;
export type DataGraphic = z.infer<typeof dataGraphicSchema>;
export type TextClip = z.infer<typeof textClipSchema>;
export type TimelineClip = z.infer<typeof timelineClipSchema>;
export type Track = z.infer<typeof trackSchema>;
export type ExportSettings = z.infer<typeof exportSettingsSchema>;
export type ExportRecord = z.infer<typeof exportRecordSchema>;
export type ExportVerification = z.infer<typeof exportVerificationSchema>;
export type AgentStep = z.infer<typeof agentStepSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type AgentStepResult = z.infer<typeof agentStepResultSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectDocument = Project;
