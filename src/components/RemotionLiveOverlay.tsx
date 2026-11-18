import React, {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import * as RemotionModule from "remotion";
import type { Project, RemotionComponentSpec, TimelineClip } from "../shared/schema";
import { isLiveRemotionClip, sortTracksByVisualZOrder } from "../shared/timeline";
import type { CaptionCueItem } from "../shared/motionTemplates";

interface LiveVideoConfig {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  id: string;
  defaultProps: Record<string, unknown>;
  props: Record<string, unknown>;
}

interface LiveFrameContextValue {
  frame: number;
  config: LiveVideoConfig;
}

const LiveRemotionContext = createContext<LiveFrameContextValue>({
  frame: 0,
  config: {
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 90,
    id: "MotionComp",
    defaultProps: {},
    props: {},
  },
});

function useLiveCurrentFrame(): number {
  return useContext(LiveRemotionContext).frame;
}

function useLiveVideoConfig(): LiveVideoConfig {
  return useContext(LiveRemotionContext).config;
}

const LiveAbsoluteFill: React.FC<{
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
}> = ({ style, className, children }) => (
  <div
    className={className}
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      boxSizing: "border-box",
      ...style,
    }}
  >
    {children}
  </div>
);

const LiveSequence: React.FC<{
  from?: number;
  durationInFrames?: number;
  layout?: "absolute-fill" | "none";
  style?: CSSProperties;
  name?: string;
  children?: ReactNode;
}> = ({ from = 0, durationInFrames = Infinity, layout = "absolute-fill", style, children }) => {
  const parent = useContext(LiveRemotionContext);
  const localFrame = parent.frame - from;
  if (localFrame < 0 || localFrame >= durationInFrames) return null;

  const nextValue: LiveFrameContextValue = {
    frame: localFrame,
    config: {
      ...parent.config,
      durationInFrames: Number.isFinite(durationInFrames)
        ? durationInFrames
        : Math.max(1, parent.config.durationInFrames - from),
    },
  };

  return (
    <LiveRemotionContext.Provider value={nextValue}>
      {layout === "none" ? (
        children
      ) : (
        <LiveAbsoluteFill style={style}>{children}</LiveAbsoluteFill>
      )}
    </LiveRemotionContext.Provider>
  );
};

const LiveFreeze: React.FC<{ frame: number; children?: ReactNode }> = ({ frame, children }) => {
  const parent = useContext(LiveRemotionContext);
  return (
    <LiveRemotionContext.Provider value={{ ...parent, frame }}>
      {children}
    </LiveRemotionContext.Provider>
  );
};

const LiveLoop: React.FC<{
  durationInFrames: number;
  times?: number;
  layout?: "absolute-fill" | "none";
  style?: CSSProperties;
  children?: ReactNode;
}> = ({ durationInFrames, times = Infinity, layout = "absolute-fill", style, children }) => {
  const parent = useContext(LiveRemotionContext);
  const cycle = Math.max(1, durationInFrames);
  if (parent.frame < 0 || parent.frame >= cycle * times) return null;
  const loopedFrame = parent.frame % cycle;
  return (
    <LiveRemotionContext.Provider
      value={{
        frame: loopedFrame,
        config: { ...parent.config, durationInFrames: cycle },
      }}
    >
      {layout === "none" ? children : <LiveAbsoluteFill style={style}>{children}</LiveAbsoluteFill>}
    </LiveRemotionContext.Provider>
  );
};

const LiveSeriesSequence: React.FC<{
  durationInFrames: number;
  offset?: number;
  layout?: "absolute-fill" | "none";
  style?: CSSProperties;
  children?: ReactNode;
}> = ({ children }) => <>{children}</>;

const LiveSeries: React.FC<{ children?: ReactNode }> & {
  Sequence: typeof LiveSeriesSequence;
} = ({ children }) => {
  let cursor = 0;
  const items = React.Children.toArray(children);
  return (
    <>
      {items.map((child, idx) => {
        if (!React.isValidElement(child)) return null;
        const props = child.props as {
          durationInFrames?: number;
          offset?: number;
          layout?: "absolute-fill" | "none";
          style?: CSSProperties;
          children?: ReactNode;
        };
        const dur = Math.max(1, Number(props.durationInFrames ?? 30));
        const offset = Number(props.offset ?? 0);
        const start = cursor + offset;
        cursor = start + dur;
        return (
          <LiveSequence
            key={idx}
            from={start}
            durationInFrames={dur}
            layout={props.layout}
            style={props.style}
          >
            {props.children}
          </LiveSequence>
        );
      })}
    </>
  );
};
LiveSeries.Sequence = LiveSeriesSequence;

const LiveImg: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = (props) => (
  <img {...props} alt={props.alt ?? ""} />
);

const runtimeModuleMap: Record<string, unknown> = {
  react: React,
  remotion: {
    ...RemotionModule,
    useCurrentFrame: useLiveCurrentFrame,
    useVideoConfig: useLiveVideoConfig,
    AbsoluteFill: LiveAbsoluteFill,
    Sequence: LiveSequence,
    Series: LiveSeries,
    Freeze: LiveFreeze,
    Loop: LiveLoop,
    Img: LiveImg,
    staticFile: (p: string) => (p.startsWith("/") ? p : `/${p}`),
    delayRender: () => 1,
    continueRender: () => undefined,
    cancelRender: () => undefined,
    getInputProps: () => ({}),
  },
};

/** Cache en memoria de componentes TSX ya compilados a funciones de React */
const compiledComponentCache = new Map<string, React.ComponentType<any>>();
const pendingCompilationMap = new Map<string, Promise<React.ComponentType<any> | null>>();

function instantiateCommonJsComponent(
  cjsCode: string,
  componentName: string,
): React.ComponentType<any> | null {
  try {
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    const customRequire = (id: string): unknown => {
      if (id in runtimeModuleMap) return runtimeModuleMap[id];
      if (id === "react/jsx-runtime") return React;
      return {};
    };
    const factory = new Function("require", "module", "exports", "React", cjsCode);
    factory(customRequire, moduleObj, exportsObj, React);
    const allExports = (moduleObj.exports ?? exportsObj) as Record<string, unknown>;
    const candidate =
      allExports[componentName] ??
      allExports.default ??
      Object.values(allExports).find((val) => typeof val === "function");
    return typeof candidate === "function" ? (candidate as React.ComponentType<any>) : null;
  } catch (err) {
    console.warn("[RemotionLiveOverlay] Error instanciando componente compilado:", err);
    return null;
  }
}

async function compileRemotionTsx(
  code: string,
  componentName: string,
): Promise<React.ComponentType<any> | null> {
  const cacheKey = `${componentName}::${code}`;
  const cached = compiledComponentCache.get(cacheKey);
  if (cached) return cached;

  const existingPromise = pendingCompilationMap.get(cacheKey);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    try {
      const response = await fetch("/api/motion/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, componentName }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { ok?: boolean; cjs?: string; exportedName?: string };
      if (!data.ok || !data.cjs) return null;
      const Comp = instantiateCommonJsComponent(data.cjs, data.exportedName || componentName);
      if (Comp) {
        compiledComponentCache.set(cacheKey, Comp);
      }
      return Comp;
    } catch {
      return null;
    } finally {
      pendingCompilationMap.delete(cacheKey);
    }
  })();

  pendingCompilationMap.set(cacheKey, promise);
  return promise;
}

/**
 * Fallback instantáneo en React puro para subtítulos cuando el servidor aún está
 * compilando el TSX (0ms de latencia en el primer fotograma).
 */
const NativeSubtitleFallback: React.FC<{ props: Record<string, unknown> }> = ({ props }) => {
  const frame = useLiveCurrentFrame() + Number(props.offset ?? 0);
  const { width, height } = useLiveVideoConfig();
  const captions = Array.isArray(props.captions) ? (props.captions as CaptionCueItem[]) : [];
  const cue = captions.find((c) => frame >= c.start && frame < c.end);
  if (!cue) return null;

  const unit = Math.min(width, height);
  const isVertical = height > width;
  const scaleMult = typeof props.fontScale === "number" && props.fontScale > 0 ? props.fontScale : 1;
  const fontSize = unit * (isVertical ? 0.052 : 0.056) * scaleMult;
  const accent = typeof props.accentColor === "string" ? props.accentColor : "#F59E0B";
  const baseText = typeof props.textColor === "string" ? props.textColor : "#FFFFFF";
  const bgAlpha = typeof props.bgOpacity === "number" ? props.bgOpacity : 0.56;
  const defaultPosY = isVertical ? 0.74 : 0.88;
  const posY = typeof props.positionY === "number" ? props.positionY : defaultPosY;
  const bottomPad = isVertical ? Math.max(height * 0.22, height * (1 - posY)) : Math.max(height * 0.04, height * (1 - posY));
  const maxSafeWidth = isVertical ? width * 0.82 : width * 0.88;
  const safeMarginRight = isVertical ? width * 0.04 : 0;

  return (
    <LiveAbsoluteFill
      style={{
        backgroundColor: "transparent",
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: bottomPad,
        paddingRight: safeMarginRight,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          maxWidth: maxSafeWidth,
          backgroundColor: `rgba(12, 14, 17, ${bgAlpha})`,
          backdropFilter: bgAlpha > 0.05 ? "blur(8px)" : "none",
          borderRadius: fontSize * 0.36,
          padding: `${fontSize * 0.24}px ${fontSize * 0.48}px`,
          boxShadow: bgAlpha > 0.05 ? "0 8px 28px rgba(0,0,0,0.42)" : "none",
          fontFamily: '"Inter", "Plus Jakarta Sans", system-ui, sans-serif',
          fontSize,
          fontWeight: 700,
          lineHeight: 1.24,
          textAlign: "center",
        }}
      >
        {cue.words.map((word, idx) => {
          const active = frame >= word.start && frame < word.end;
          const cleanToken = word.text.replace(/[.,!?;:¡¿"']/g, "");
          const isKeyword = Boolean(word.highlight) || cleanToken.length >= 6 || /\d/.test(cleanToken);
          return (
            <span
              key={idx}
              style={{
                margin: `0 ${fontSize * 0.09}px`,
                color: active ? (isKeyword ? accent : baseText) : frame >= word.end ? baseText : "rgba(255,255,255,0.46)",
                transform: active ? "scale(1.05)" : "scale(1)",
                display: "inline-block",
                whiteSpace: "nowrap",
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </LiveAbsoluteFill>
  );
};

class ClipErrorBoundary extends Component<
  { fallback?: ReactNode; children: ReactNode; resetKey: string },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidUpdate(prevProps: { resetKey: string }): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[RemotionLiveOverlay] Error en render de componente:", error.message, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}

interface SingleLiveClipRendererProps {
  clip: TimelineClip;
  remotion: RemotionComponentSpec;
  localFrame: number;
  width: number;
  height: number;
  fps: number;
}

const SingleLiveClipRenderer: React.FC<SingleLiveClipRendererProps> = ({
  clip,
  remotion,
  localFrame,
  width,
  height,
  fps,
}) => {
  const cacheKey = `${remotion.componentName}::${remotion.code}`;
  const [CompiledComp, setCompiledComp] = useState<React.ComponentType<any> | null>(
    () => compiledComponentCache.get(cacheKey) ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    const cached = compiledComponentCache.get(cacheKey);
    if (cached) {
      setCompiledComp(() => cached);
      return;
    }
    void compileRemotionTsx(remotion.code, remotion.componentName).then((comp) => {
      if (!cancelled && comp) {
        setCompiledComp(() => comp);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, remotion.code, remotion.componentName]);

  const mergedProps = useMemo(
    () => ({
      ...(remotion.props ?? {}),
      width,
      height,
      fps,
      durationInFrames: clip.durationFrames,
    }),
    [remotion.props, width, height, fps, clip.durationFrames],
  );

  const contextValue = useMemo<LiveFrameContextValue>(
    () => ({
      frame: Math.max(0, Math.floor(localFrame)),
      config: {
        width,
        height,
        fps,
        durationInFrames: clip.durationFrames,
        id: remotion.compositionId || "MotionComp",
        defaultProps: mergedProps,
        props: mergedProps,
      },
    }),
    [localFrame, width, height, fps, clip.durationFrames, remotion.compositionId, mergedProps],
  );

  // Memoizado por referencia de `remotion.props` para NO ejecutar JSON.stringify en cada fotograma
  const errorResetKey = useMemo(
    () => `${cacheKey}::${Object.keys(remotion.props ?? {}).length}`,
    [cacheKey, remotion.props],
  );

  const isSubtitle = Array.isArray(remotion.props?.captions);
  const clipOpacity = clip.opacity ?? 1;

  // Transformaciones del clip (posición X/Y, escala, rotación y keyframes si es MediaClip o TextClip)
  let transformStyle = "";
  let transformOrigin = "center center";
  if (clip.type !== "text") {
    let kfScale = 1;
    let kfX = 0;
    let kfY = 0;
    const keyframes = clip.transform.keyframes;
    if (keyframes && keyframes.length >= 2) {
      const pts = [...keyframes].sort((a, b) => a.frame - b.frame);
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      if (localFrame <= first.frame) {
        kfScale = first.scale;
        kfX = first.x ?? 0;
        kfY = first.y ?? 0;
      } else if (localFrame >= last.frame) {
        kfScale = last.scale;
        kfX = last.x ?? 0;
        kfY = last.y ?? 0;
      } else {
        for (let i = 0; i < pts.length - 1; i += 1) {
          const s = pts[i]!;
          const e = pts[i + 1]!;
          if (localFrame >= s.frame && localFrame <= e.frame) {
            const span = Math.max(1, e.frame - s.frame);
            const t = (localFrame - s.frame) / span;
            const smooth = t * t * (3 - 2 * t);
            kfScale = s.scale + (e.scale - s.scale) * smooth;
            kfX = (s.x ?? 0) + ((e.x ?? 0) - (s.x ?? 0)) * smooth;
            kfY = (s.y ?? 0) + ((e.y ?? 0) - (s.y ?? 0)) * smooth;
            break;
          }
        }
      }
    }
    const tx = clip.transform.x + kfX;
    const ty = clip.transform.y + kfY;
    const sc = clip.transform.scale * kfScale;
    const rot = clip.transform.rotation;
    if (tx !== 0 || ty !== 0 || Math.abs(sc - 1) > 0.002 || rot !== 0) {
      transformStyle = `translate(${tx}%, ${ty}%) scale(${sc.toFixed(4)}) rotate(${rot}deg)`;
    }
  } else if (clip.remotion) {
    const ox = Number(clip.remotion.props?.offsetX ?? 0);
    const hasNativeScale = /fontScale|scaleMult/.test(clip.remotion.code);
    const hasNativePosY = /positionY/.test(clip.remotion.code);
    const rawFontScale = Number(clip.remotion.props?.fontScale ?? 1);
    const fontScale = rawFontScale > 5 ? rawFontScale / 100 : rawFontScale;
    const defaultPosY = height > width ? 0.74 : 0.88;
    const rawPosY = Number(clip.remotion.props?.positionY ?? defaultPosY);
    const posY = rawPosY > 1.5 ? rawPosY / 100 : rawPosY;
    const dyPct = hasNativePosY ? 0 : (posY - defaultPosY) * 100;
    const sc = hasNativeScale ? 1 : fontScale;
    if (ox !== 0 || Math.abs(dyPct) > 0.01 || Math.abs(sc - 1) > 0.005) {
      transformOrigin = `50% ${Math.round(posY * 100)}%`;
      transformStyle = `translate(${ox}%, ${dyPct}%) scale(${sc})`;
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: clipOpacity,
        transform: transformStyle || undefined,
        transformOrigin,
        pointerEvents: "none",
      }}
    >
      <LiveRemotionContext.Provider value={contextValue}>
        <ClipErrorBoundary
          resetKey={errorResetKey}
          fallback={isSubtitle ? <NativeSubtitleFallback props={mergedProps} /> : null}
        >
          {CompiledComp ? (
            <CompiledComp {...mergedProps} />
          ) : isSubtitle ? (
            <NativeSubtitleFallback props={mergedProps} />
          ) : null}
        </ClipErrorBoundary>
      </LiveRemotionContext.Provider>
    </div>
  );
};

export { isLiveRemotionClip };

interface RemotionLiveOverlayProps {
  project: Project;
  frame: number;
  zoomLevel?: number;
}

export const RemotionLiveOverlay: React.FC<RemotionLiveOverlayProps> = ({
  project,
  frame,
  zoomLevel = 1,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = () => setBounds({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  const activeLiveClips = useMemo(() => {
    const list: Array<{ clip: TimelineClip; remotion: RemotionComponentSpec }> = [];
    const orderedTracks = sortTracksByVisualZOrder(project.tracks);
    for (const track of orderedTracks) {
      for (const clip of track.clips) {
        if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
        if (isLiveRemotionClip(clip) && clip.remotion) {
          list.push({ clip, remotion: clip.remotion });
        }
      }
    }
    return list;
  }, [project.tracks, frame]);

  if (activeLiveClips.length === 0) {
    return <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden" />;
  }

  const projW = Math.max(16, project.settings.width);
  const projH = Math.max(16, project.settings.height);
  const fps = Math.max(1, project.settings.fps.num / Math.max(1, project.settings.fps.den));
  const scaleX = bounds.width > 0 ? bounds.width / projW : 1;
  const scaleY = bounds.height > 0 ? bounds.height / projH : 1;
  const scale = Math.min(scaleX, scaleY) * zoomLevel;

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {bounds.width > 0 && bounds.height > 0 && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: projW,
            height: projH,
            transform: `translate(-50%, -50%) scale(${scale})`,
            transformOrigin: "center center",
            pointerEvents: "none",
          }}
        >
          {activeLiveClips.map(({ clip, remotion }) => (
            <SingleLiveClipRenderer
              key={clip.id}
              clip={clip}
              remotion={remotion}
              localFrame={frame - clip.startFrame}
              width={projW}
              height={projH}
              fps={fps}
            />
          ))}
        </div>
      )}
    </div>
  );
};
