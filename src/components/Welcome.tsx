import { useEffect, useRef, useState } from "react";
import type { AspectRatio, ResolutionHeight } from "../shared/presets";
import { ASPECT_PRESETS } from "../shared/presets";
import type { ProjectListItem, ServerConfig, CreatorUser } from "../api";
import { api, authRegister, authLogin } from "../api";
import { formatDurationUs, framesToSeconds } from "../shared/time";
import { Brand } from "./Brand";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./Modal";
import { AdminUsersModal } from "./AdminUsersModal";
import { UserProfileModal } from "./UserProfileModal";

interface WelcomeProps {
  config: ServerConfig | null;
  user: CreatorUser | null;
  projects: ProjectListItem[];
  loadingProjects?: boolean;
  onRetry: () => void;
  onAuthSuccess: (user: CreatorUser) => Promise<void> | void;
  onUserUpdated?: (user: CreatorUser) => Promise<void> | void;
  onSignOut: () => Promise<void> | void;
  switchAccountTrigger?: number;
  onCreate: (input: { name: string; aspect: AspectRatio; height: ResolutionHeight; fps: number }) => Promise<void>;
  onCreateDemo: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReveal: (id: string) => Promise<void>;
  onOpenSettings?: () => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

const HEIGHTS: ResolutionHeight[] = [720, 1080, 1440, 2160];
const FPS_OPTIONS = [24, 25, 30, 50, 60];

const SOCIAL_PRESETS: Array<{
  id: string;
  label: string;
  sub: string;
  badge?: string;
  aspect: AspectRatio;
  height: ResolutionHeight;
  fps: number;
}> = [
    { id: "tiktok", label: "Reels / TikTok", sub: "9:16 · 60fps", badge: "Viral", aspect: "9:16", height: 1080, fps: 60 },
    { id: "youtube", label: "YouTube", sub: "16:9 · 30fps", aspect: "16:9", height: 1080, fps: 30 },
    { id: "square", label: "Post Feed", sub: "1:1 · 30fps", aspect: "1:1", height: 1080, fps: 30 },
  ];

function projectMeta(project: ProjectListItem): string {
  const duration = framesToSeconds(project.durationFrames, { num: 30, den: 1 });
  return `${project.mediaCount} recurso${project.mediaCount === 1 ? "" : "s"} · ${formatDurationUs(duration * 1_000_000)} · ${new Date(project.updatedAt).toLocaleDateString("es-ES")}`;
}

function shapeFor(ratio: number, box = 11) {
  let width = box;
  let height = box / ratio;
  if (height > box) {
    height = box;
    width = box * ratio;
  }
  return { width: Math.max(3, Math.round(width)), height: Math.max(3, Math.round(height)) };
}

function ProjectThumb({ project }: { project: ProjectListItem }) {
  const [failed, setFailed] = useState(false);
  if (!project.thumbnailMediaId || failed) {
    return (
      <div className="project-thumb shrink-0 !w-12 !h-8 sm:!w-14 sm:!h-10 rounded-lg border border-[var(--line-strong)] bg-[var(--sage-100)] grid place-items-center text-[var(--sage-700)] overflow-hidden">
        <Icon name="film" size={14} />
      </div>
    );
  }
  return (
    <div className="project-thumb shrink-0 !w-12 !h-8 sm:!w-14 sm:!h-10 rounded-lg border border-[var(--line-strong)] bg-[var(--sage-100)] overflow-hidden">
      <img
        src={api.thumbnailUrl(project.id, project.thumbnailMediaId)}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

const HERO_ROTATING_LINES = [
  "Edita videos virales con IA.",
  "Subtítulos virales en 1 clic.",
  "Cortes y zoom a 60 FPS.",
  "Multiplica tu retención x10.",
];

const CREATOR_AVATARS = [
  { name: "Diego", color: "#22c55e" },
  { name: "Valeria", color: "#0ea5e9" },
  { name: "Carlos", color: "#a855f7" },
  { name: "Lucía", color: "#f59e0b" },
];

const PROMPT_EXAMPLES = [
  "Ponle subtítulos amarillos estilo Hormozi y corta los silencios",
  "Añade un gráfico de retención con físicas suaves a 60 FPS",
  "Haz zoom dinámico en mis acciones y adapta a 9:16 para TikTok",
  "Crea un lower third de cristal con mi nombre y logo",
];

function AgentPromptSimulator() {
  const [promptIdx, setPromptIdx] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPromptIdx((prev) => (prev + 1) % PROMPT_EXAMPLES.length);
    }, 4500);
    return () => window.clearInterval(timer);
  }, []);

  const currentPrompt = PROMPT_EXAMPLES[promptIdx] ?? PROMPT_EXAMPLES[0] ?? "";

  return (
    <div className="mt-3 sm:mt-3.5 flex items-center gap-2 sm:gap-2.5 rounded-xl sm:rounded-2xl border-2 border-[var(--ink)] bg-[var(--white)] px-3 sm:px-3.5 py-2 sm:py-2.5 shadow-[var(--shadow-hard-sm)] max-w-xl">
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-lg sm:rounded-xl bg-[var(--ink)] text-learn-green shadow-sm">
        <Icon name="bot" size={12} />
        <span className="text-[9px] sm:text-[10px] font-mono font-black tracking-wider uppercase">AGENTE</span>
      </div>
      <div className="flex-1 min-w-0">
        <span className="block text-[8.5px] sm:text-[9.5px] font-bold uppercase tracking-wider text-[var(--muted)]">
          Instrucción por chat o voz:
        </span>
        <p className="truncate text-[11.5px] sm:text-[13px] font-bold text-[var(--ink)]">
          &ldquo;{currentPrompt}&rdquo;
        </p>
      </div>
      <div className="hidden sm:flex items-center gap-1 h-4 shrink-0 px-1">
        <span className="w-1 h-3 rounded-full bg-learn-green animate-pulse" />
        <span className="w-1 h-4 rounded-full bg-learn-green animate-pulse" style={{ animationDelay: "150ms" }} />
        <span className="w-1 h-2 rounded-full bg-learn-green animate-pulse" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  );
}

/** Título principal cinético con efecto de escritura en vivo (Typewriter) */
function KineticHeroHeadline() {
  const introPrefix = "¡Oe, hazlo ";
  const [prefixCount, setPrefixCount] = useState(0);
  const [showClipBadge, setShowClipBadge] = useState(false);
  const [lineIndex, setLineIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fase 1: Escribir "¡Oe, hazlo " y revelar el badge "CLIP!"
  useEffect(() => {
    if (prefixCount < introPrefix.length) {
      const timer = window.setTimeout(() => {
        setPrefixCount((prev) => prev + 1);
      }, 35);
      return () => window.clearTimeout(timer);
    }
    if (!showClipBadge) {
      const timer = window.setTimeout(() => {
        setShowClipBadge(true);
      }, 70);
      return () => window.clearTimeout(timer);
    }
  }, [prefixCount, showClipBadge]);

  // Fase 2: Efecto máquina de escribir continuo en la segunda línea ("Edita videos virales con IA.")
  useEffect(() => {
    if (!showClipBadge) return;

    const currentFullText = HERO_ROTATING_LINES[lineIndex] ?? HERO_ROTATING_LINES[0] ?? "";

    if (!isDeleting && charIndex < currentFullText.length) {
      const timer = window.setTimeout(() => {
        setCharIndex((prev) => prev + 1);
      }, 36);
      return () => window.clearTimeout(timer);
    }

    if (!isDeleting && charIndex === currentFullText.length) {
      const holdDuration = lineIndex === 0 ? 3600 : 2200;
      const timer = window.setTimeout(() => {
        setIsDeleting(true);
      }, holdDuration);
      return () => window.clearTimeout(timer);
    }

    if (isDeleting && charIndex > 0) {
      const timer = window.setTimeout(() => {
        setCharIndex((prev) => prev - 1);
      }, 18);
      return () => window.clearTimeout(timer);
    }

    if (isDeleting && charIndex === 0) {
      setIsDeleting(false);
      setLineIndex((prev) => (prev + 1) % HERO_ROTATING_LINES.length);
    }
  }, [showClipBadge, charIndex, isDeleting, lineIndex]);

  const currentLine = HERO_ROTATING_LINES[lineIndex] ?? HERO_ROTATING_LINES[0] ?? "";
  const typedSecondLine = currentLine.slice(0, charIndex);

  return (
    <h1 className="font-display text-[clamp(32px,8.2vw,76px)] font-extrabold leading-[1.04] tracking-[-0.038em] text-[var(--ink)] break-words select-none">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{introPrefix.slice(0, prefixCount)}</span>
        <span
          className={`inline-flex items-center rounded-xl sm:rounded-2xl border-2 border-[var(--ink)] bg-[var(--ink)] px-2.5 sm:px-[18px] py-0.5 sm:py-1 text-learn-green shadow-[var(--shadow-hard-sm)] transition-all duration-300 ${
            showClipBadge
              ? "opacity-100 scale-100 -rotate-1"
              : "opacity-0 scale-75 translate-y-2 pointer-events-none"
          }`}
        >
          <span>CLIP!</span>
        </span>
      </div>
      <div className="mt-2 sm:mt-2.5 block min-h-[1.22em] text-[clamp(22px,5.2vw,50px)] text-[var(--sage-700)] underline decoration-learn-green decoration-[3.5px] sm:decoration-[5.5px] underline-offset-[4px] sm:underline-offset-[6px] leading-[1.12]">
        <span>{typedSecondLine}</span>
        <span
          aria-hidden="true"
          className="ml-1 inline-block h-[0.76em] w-[3.5px] sm:w-[5px] translate-y-[0.05em] rounded-[3px] bg-learn-green animate-pulse"
        />
      </div>
    </h1>
  );
}

export function Welcome({
  config,
  user,
  projects,
  loadingProjects,
  onRetry,
  onAuthSuccess,
  onUserUpdated,
  onSignOut,
  switchAccountTrigger,
  onCreate,
  onCreateDemo,
  onOpen,
  onDuplicate,
  onDelete,
  onReveal,
  onOpenSettings,
  onToast,
}: WelcomeProps) {
  const [name, setName] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [height, setHeight] = useState<ResolutionHeight>(1080);
  const [fps, setFps] = useState(30);
  const [pending, setPending] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(null);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [handleInput, setHandleInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [adminUsersOpen, setAdminUsersOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const identifierInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const pendingEntryRef = useRef<"demo" | "create" | null>(null);

  const requireAuthModal = (
    entryAction?: "demo" | "create",
    preferredMode: "login" | "register" = "login",
  ) => {
    pendingEntryRef.current = entryAction ?? null;
    setAuthMode(preferredMode);
    setAuthError(null);
    setLoginModalOpen(true);
    window.setTimeout(() => identifierInputRef.current?.focus(), 60);
  };

  const openAuthGate = (mode: "login" | "register") => {
    requireAuthModal(undefined, mode);
  };

  useEffect(() => {
    if (switchAccountTrigger && switchAccountTrigger > 0) {
      pendingEntryRef.current = null;
      setProfileModalOpen(false);
      setAuthMode("login");
      setAuthError(null);
      setLoginModalOpen(true);
    }
  }, [switchAccountTrigger]);

  useEffect(() => {
    if (!user) {
      setProfileModalOpen(false);
      setAdminUsersOpen(false);
    }
  }, [user]);

  const closeAuthModal = () => {
    pendingEntryRef.current = null;
    setLoginModalOpen(false);
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const rawIdentifier = handleInput.trim();
    if (!rawIdentifier) {
      setAuthError("Ingresa tu usuario o correo electrónico.");
      return;
    }
    if (authMode === "register") {
      if (passwordInput.length < 4) {
        setAuthError("La contraseña es obligatoria y debe tener al menos 4 caracteres.");
        return;
      }
    } else if (!passwordInput) {
      setAuthError("Ingresa tu contraseña para iniciar sesión.");
      return;
    }

    setAuthLoading(true);
    try {
      let authenticatedUser: CreatorUser;
      if (authMode === "register") {
        const isEmail = !rawIdentifier.startsWith("@") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawIdentifier);
        let derivedHandle: string;
        let displayName: string;
        let email: string | undefined;

        if (isEmail) {
          email = rawIdentifier.toLowerCase();
          const localPart = rawIdentifier.split("@")[0] ?? "creador";
          const cleaned = localPart.toLowerCase().replace(/[^a-z0-9_-]/g, "");
          derivedHandle = cleaned.length >= 2 ? cleaned.slice(0, 32) : `${cleaned || "user"}_oe`;
          displayName = localPart.trim().slice(0, 48) || derivedHandle;
        } else {
          const clean = rawIdentifier.toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9_-]/g, "");
          derivedHandle = clean;
          displayName = rawIdentifier.replace(/^@+/, "").trim().slice(0, 48) || clean;
        }

        authenticatedUser = (
          await authRegister({
            handle: derivedHandle,
            displayName,
            email,
            password: passwordInput,
          })
        ).user;
      } else {
        authenticatedUser = (
          await authLogin({
            identifier: rawIdentifier,
            password: passwordInput,
          })
        ).user;
      }

      const nextAction = pendingEntryRef.current;
      pendingEntryRef.current = null;
      setLoginModalOpen(false);
      setHandleInput("");
      setPasswordInput("");
      onToast(
        authMode === "register"
          ? `¡Bienvenido a OECLIP, @${authenticatedUser.handle}! Cuenta creada correctamente.`
          : `¡Hola de nuevo, @${authenticatedUser.handle}! Accediste a tus proyectos.`,
        "success",
      );
      await onAuthSuccess(authenticatedUser);

      if (nextAction === "demo") {
        void run("demo", onCreateDemo);
      } else if (nextAction === "create") {
        void run("create", () =>
          onCreate({
            name: name.trim() || "Mi nuevo montaje",
            aspect,
            height,
            fps,
          }),
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al autenticar.";
      setAuthError(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = () => {
    void onSignOut();
  };

  const renderAuthPanel = () => (
    <>
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-3">
        <div className="flex items-center rounded-xl border-2 border-[var(--ink)] bg-[var(--paper)] p-0.5 shadow-[var(--shadow-hard-sm)]">
          <button
            type="button"
            onClick={() => {
              setAuthMode("login");
              setAuthError(null);
            }}
            className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
              authMode === "login"
                ? "bg-[var(--ink)] text-learn-green shadow-sm"
                : "text-[var(--ink-soft)] hover:text-[var(--ink)]"
            }`}
          >
            Iniciar sesión
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthMode("register");
              setAuthError(null);
            }}
            className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
              authMode === "register"
                ? "bg-learn-green text-[#0c150d] shadow-sm"
                : "text-[var(--ink-soft)] hover:text-[var(--ink)]"
            }`}
          >
            Crear cuenta
          </button>
        </div>

        <button
          type="button"
          onClick={closeAuthModal}
          className="grid h-8 w-8 place-items-center rounded-xl border border-[var(--line)] hover:border-[var(--ink)] hover:bg-[var(--sage-100)] text-[var(--muted-strong)]"
          aria-label="Cerrar ventana"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <p className="mt-2.5 text-xs text-[var(--muted)] leading-relaxed">
        {user
          ? "Cambia a otro creador o registra una nueva cuenta independiente."
          : authMode === "login"
            ? "Inicia sesión para entrar al estudio, crear montajes y guardar tus proyectos."
            : "Crea una cuenta nueva con contraseña para empezar a editar en OECLIP."}
      </p>

      {authError && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-700">
          <Icon name="alert" size={14} className="shrink-0 text-red-600 mt-0.5" />
          <span className="flex-1 font-medium">{authError}</span>
        </div>
      )}

      <form onSubmit={handleAuthSubmit} className="mt-3.5 space-y-3">
        {authMode === "login" && (
          <>
            <div>
              <label className="block text-[11px] font-bold text-[var(--ink)] mb-1">
                Usuario o correo electrónico
              </label>
              <input
                ref={identifierInputRef}
                type="text"
                required
                autoComplete="username"
                placeholder="ej. carlos_shorts o carlos@correo.com"
                value={handleInput}
                onChange={(e) => setHandleInput(e.target.value)}
                className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] py-2 px-3 text-base sm:text-sm font-semibold text-[var(--ink)] outline-none focus:border-[var(--ink)]"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[11px] font-bold text-[var(--ink)]">
                  Contraseña
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--ink)]"
                >
                  {showPassword ? "Ocultar" : "Mostrar"}
                </button>
              </div>
              <input
                ref={passwordInputRef}
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                placeholder="Tu contraseña de acceso"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] py-2 px-3 text-base sm:text-sm font-semibold text-[var(--ink)] outline-none focus:border-[var(--ink)]"
              />
            </div>
          </>
        )}

        {authMode === "register" && (
          <>
            <div>
              <label className="block text-[11px] font-bold text-[var(--ink)] mb-1">
                Usuario o correo electrónico
              </label>
              <input
                ref={identifierInputRef}
                type="text"
                required
                autoComplete="username"
                placeholder="ej. diego_reels o diego@correo.com"
                value={handleInput}
                onChange={(e) => setHandleInput(e.target.value)}
                className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] py-2 px-3 text-base sm:text-sm font-semibold text-[var(--ink)] outline-none focus:border-[var(--ink)]"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[11px] font-bold text-[var(--ink)]">
                  Contraseña (mín. 4 caracteres)
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--ink)]"
                >
                  {showPassword ? "Ocultar" : "Mostrar"}
                </button>
              </div>
              <input
                type={showPassword ? "text" : "password"}
                required
                minLength={4}
                autoComplete="new-password"
                placeholder="Crea una contraseña segura"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] py-2 px-3 text-base sm:text-sm font-semibold text-[var(--ink)] outline-none focus:border-[var(--ink)]"
              />
              <p className="mt-0.5 text-[9.5px] text-[var(--muted)]">
                Tus proyectos quedan protegidos y asociados exclusivamente a tu cuenta.
              </p>
            </div>
          </>
        )}

        <div className="pt-2 flex flex-col gap-2">
          <button
            type="submit"
            disabled={authLoading}
            className="btn btn-primary btn-lg w-full justify-center !h-10 text-xs font-bold shadow-[var(--shadow-hard-sm)]"
          >
            {authLoading ? (
              <Icon name="loader" size={14} className="spin" />
            ) : (
              <Icon name="zap" size={14} />
            )}
            {authMode === "register"
              ? "Crear cuenta y entrar al estudio →"
              : "Iniciar sesión y entrar →"}
          </button>

          <div className="flex items-center justify-between pt-1 text-[11px]">
            <button
              type="button"
              onClick={() => {
                setAuthMode(authMode === "login" ? "register" : "login");
                setAuthError(null);
              }}
              className="font-bold text-[var(--sage-700)] hover:underline"
            >
              {authMode === "login"
                ? "¿No tienes cuenta? Regístrate aquí"
                : "¿Ya tienes cuenta? Inicia sesión"}
            </button>
            <button
              type="button"
              onClick={closeAuthModal}
              className="text-[var(--muted)] hover:text-[var(--ink)]"
            >
              Cerrar
            </button>
          </div>
        </div>
      </form>
    </>
  );

  const run = async (key: string, task: () => Promise<void>) => {
    if (pending) return;
    setPending(key);
    try {
      await task();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "La operación falló.", "error");
    } finally {
      setPending(null);
    }
  };

  const create = () => {
    if (!user) {
      requireAuthModal("create");
      return;
    }
    return run("create", () =>
      onCreate({
        name: name.trim() || "Mi nuevo montaje",
        aspect,
        height,
        fps,
      }),
    );
  };

  const demo = () => {
    if (!user) {
      requireAuthModal("demo");
      return;
    }
    return run("demo", onCreateDemo);
  };

  const applySocialPreset = (preset: (typeof SOCIAL_PRESETS)[number]) => {
    setAspect(preset.aspect);
    setHeight(preset.height);
    setFps(preset.fps);
    if (!name.trim()) {
      setName(`Video ${preset.label}`);
    }
    if (!user) {
      requireAuthModal();
    }
  };

  const ffmpeg = config?.capabilities.ffmpegVersion;
  const ai = config?.ai;
  const nvenc = Boolean(config?.capabilities.nvenc);
  const projectCount = projects.length;

  return (
    <div
      className="flex min-h-screen w-full max-w-full flex-col overflow-x-hidden font-sans text-[var(--ink)] selection:bg-learn-green/30 relative"
      style={{
        backgroundColor: "var(--cream)",
        backgroundImage: `
          radial-gradient(ellipse 65% 55% at 20% 36%, rgba(74, 222, 128, 0.09) 0%, rgba(250, 248, 245, 0) 70%),
          radial-gradient(rgba(20, 31, 22, 0.16) 0.85px, transparent 0.85px)
        `,
        backgroundSize: "100% 100%, 24px 24px",
      }}
    >
      {/* Barra superior adaptable */}
      <header className="sticky top-0 z-40 w-full border-b-2 border-[var(--ink)] bg-[var(--white)]/95 backdrop-blur-md">
        <div className="mx-auto flex h-[52px] sm:h-16 w-full max-w-[1320px] items-center justify-between gap-1.5 sm:gap-3 px-2.5 sm:px-6">
          <button className="Brand shrink-0" title="OECLIP · Estudio de edición con IA" aria-label="OECLIP">
            <Brand />
          </button>

          <div className="hidden items-center gap-2 lg:flex">
            <span className="inline-flex items-center gap-2 rounded-full border-2 border-[var(--line-strong)] bg-[var(--paper)] px-3 py-1 text-[11px] font-semibold text-[var(--ink-soft)]">
              <span className={`ai-dot${ai?.configured ? "" : " off"}`} />
              {ai?.configured ? `Agente IA Activo · ${ai.model}` : "Motor IA Listo"}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border-2 border-[var(--line-strong)] bg-[var(--paper)] px-3 py-1 text-[11px] font-semibold text-[var(--ink-soft)]">
              <Icon name="film" size={12} />
              Remotion 60fps + FFmpeg
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-1 sm:gap-1.5 shrink-0">
            {user ? (
              <div className="flex min-w-0 items-center gap-1 sm:gap-1.5">
                <button
                  type="button"
                  data-user-profile-btn
                  className="flex min-w-0 items-center gap-1 sm:gap-1.5 rounded-full border-2 border-[var(--ink)] bg-[var(--white)] hover:bg-[var(--cream)] px-1.5 sm:px-2.5 py-0.5 sm:py-1 text-[11px] sm:text-xs font-bold text-[var(--ink)] shadow-[var(--shadow-hard-sm)] cursor-pointer transition-colors"
                  onClick={() => setProfileModalOpen(true)}
                  title={`Mi cuenta (@${user.handle}) · Ver perfil, editar datos o cambiar de usuario`}
                >
                  <span
                    className="w-4 h-4 rounded-full text-[9px] font-black text-[#0c150d] grid place-items-center shadow-sm shrink-0"
                    style={{ backgroundColor: user.avatarColor || "var(--learn-green)" }}
                  >
                    {((user.displayName || user.name)?.charAt(0) || user.handle.charAt(0) || "C").toUpperCase()}
                  </span>
                  <span className="truncate max-w-[66px] sm:max-w-[120px]">@{user.handle}</span>
                  <span className="hidden sm:block h-1.5 w-1.5 rounded-full bg-learn-green animate-pulse shrink-0" />
                </button>
                {user.role === "admin" && (
                  <button
                    type="button"
                    data-admin-users-btn
                    onClick={() => setAdminUsersOpen(true)}
                    title="Panel de gestión de cuentas (solo administrador)"
                    className="btn btn-secondary btn-sm !h-[30px] sm:!h-8 !px-2 !gap-1 text-[11px] sm:text-xs"
                  >
                    <Icon name="user" size={11} />
                    <span>Cuentas</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openAuthGate("login")}
                  title="Cambiar de creador"
                  className="btn btn-secondary btn-sm !h-[30px] sm:!h-8 px-2 text-xs hidden sm:inline-flex"
                >
                  <Icon name="refresh" size={11} />
                  <span>Cambiar</span>
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  title="Cerrar sesión"
                  className="btn btn-ghost btn-sm !h-[30px] sm:!h-8 !px-1.5 sm:!px-2 text-[11px] sm:text-xs text-[var(--muted-strong)] hover:text-[var(--danger)]"
                >
                  <span>Salir</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1 sm:gap-1.5">
                <button
                  type="button"
                  onClick={() => openAuthGate("login")}
                  className="btn btn-secondary btn-sm !h-[30px] sm:!h-8 px-2 sm:px-3 text-[11px] sm:text-xs"
                  title="Acceder a tu espacio existente"
                >
                  <Icon name="user" size={11} />
                  <span>Iniciar sesión</span>
                </button>
                <button
                  type="button"
                  onClick={() => openAuthGate("register")}
                  className="btn btn-primary btn-sm !h-[30px] sm:!h-8 px-2 sm:px-3 text-[11px] sm:text-xs font-bold shadow-[var(--shadow-hard-sm)]"
                  title="Crear una cuenta nueva para guardar tus proyectos"
                >
                  <Icon name="plus" size={11} />
                  <span className="hidden sm:inline">Crear cuenta</span>
                  <span className="sm:hidden">Registro</span>
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => void demo()}
              disabled={pending !== null}
              className="btn btn-primary btn-sm !h-8 !hidden md:!inline-flex"
            >
              <Icon name="wand" size={13} />
              Demo en 1 clic
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1360px] min-w-0 flex-1 px-3 sm:px-6 py-3 sm:py-5 lg:py-6 overflow-x-hidden">
        <div className="grid grid-cols-1 items-start gap-5 sm:gap-8 lg:grid-cols-[minmax(0,1.12fr)_minmax(360px,450px)] xl:gap-12 w-full max-w-full min-w-0">
          {/* Columna izquierda: Hero Tipográfico Cinético + Acciones */}
          <section className="flex flex-col justify-start w-full max-w-full min-w-0 overflow-hidden pr-0 lg:pr-4 py-0 sm:py-1">
            {/* Título Cinético Grande con Escritura en Vivo */}
            <KineticHeroHeadline />

            <p className="mt-3 sm:mt-3.5 max-w-xl text-[14px] sm:text-[16px] leading-relaxed font-medium text-[var(--ink-soft)] break-words">
              <strong className="text-[var(--ink)]">Como tener a tu compa editor 24/7:</strong> Sube tu video, dile qué buscas en el chat y OECLIP le mete subtítulos brutales, cortes precisos y formato 9:16 al instante para que la rompas en TikTok, Reels y Shorts.
            </p>

            {/* Botones principales de conversión con más presencia y altura */}
            <div className="mt-4 sm:mt-5 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full max-w-xl">
              <div className="relative w-full sm:w-auto">
                <button
                  className="btn btn-primary btn-lg justify-center text-sm sm:text-base px-6 sm:px-7 py-3 sm:py-3.5 shadow-[var(--shadow-hard)] hover:scale-[1.02] active:scale-[0.98] transition-all w-full sm:w-auto !h-12 sm:!h-[52px] font-extrabold group"
                  onClick={() => void demo()}
                  disabled={pending !== null}
                >
                  {pending === "demo" ? (
                    <Icon name="loader" size={16} className="spin" />
                  ) : (
                    <Icon name="zap" size={16} className="text-learn-green group-hover:rotate-12 transition-transform" />
                  )}
                  <span>{pending === "demo" ? "Abriendo estudio..." : "Probar OECLIP al Toque"}</span>
                </button>
                <span className="pointer-events-none absolute -top-2.5 right-3 sm:-right-2 rounded-full border border-[var(--ink)] bg-[#facc15] px-2 py-0.5 text-[8px] sm:text-[8.5px] font-black uppercase text-[#0c150d] shadow-sm">
                  ⚡ En 1 clic
                </span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-lg justify-center text-sm sm:text-base px-5 sm:px-6 py-3 sm:py-3.5 w-full sm:w-auto !h-12 sm:!h-[52px] font-bold shadow-[var(--shadow-hard-sm)] hover:border-[var(--ink)] transition-all"
                onClick={() => {
                  if (!user) {
                    requireAuthModal("create");
                    return;
                  }
                  nameRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                  nameRef.current?.focus();
                }}
                disabled={pending !== null}
              >
                <Icon name="plus" size={15} />
                <span>Crear proyecto nuevo</span>
              </button>
            </div>

            {/* Pila de Creadores + Calificación en vivo */}
            <div className="mt-3 sm:mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px] sm:text-xs font-semibold text-[var(--ink-soft)]">
              <div className="flex -space-x-1.5 sm:-space-x-2 shrink-0">
                {CREATOR_AVATARS.map((c) => (
                  <span
                    key={c.name}
                    title={c.name}
                    style={{ backgroundColor: c.color }}
                    className="w-[22px] h-[22px] sm:w-6 sm:h-6 rounded-full border-2 border-[var(--white)] grid place-items-center text-[8.5px] sm:text-[9px] font-black text-[#0c150d] shadow-sm"
                  >
                    {c.name.charAt(0)}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="inline-flex items-center gap-1 text-[#f59e0b]">
                  <Icon name="star" size={12} className="fill-current text-[#f59e0b]" />
                  <span className="font-bold text-[var(--ink)]">4.9/5</span>
                </span>
                <span className="h-2.5 w-px bg-[var(--line-strong)]" />
                <span className="font-medium">+14,500 clips creados</span>
                <span className="h-2.5 w-px bg-[var(--line-strong)]" />
                <span className="font-medium">Sin marcas de agua</span>
              </div>
            </div>

            {/* Simulador interactivo de instrucción al Agente */}
            <AgentPromptSimulator />

            {/* Píldoras de tecnología del editor */}
            <div className="mt-3 sm:mt-3.5 flex flex-wrap items-center gap-1.5 sm:gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-[var(--white)] px-2.5 sm:px-3 py-0.5 sm:py-1 text-[10px] sm:text-[11px] font-bold text-[var(--ink)] shadow-sm hover:border-[var(--ink)] transition-colors">
                <Icon name="sparkles" size={11} className="text-learn-green" />
                Subtítulos Whisper
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-[var(--white)] px-2.5 sm:px-3 py-0.5 sm:py-1 text-[10px] sm:text-[11px] font-bold text-[var(--ink)] shadow-sm hover:border-[var(--ink)] transition-colors">
                <Icon name="film" size={11} className="text-[var(--sage-700)]" />
                Remotion 60 FPS
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-[var(--white)] px-2.5 sm:px-3 py-0.5 sm:py-1 text-[10px] sm:text-[11px] font-bold text-[var(--ink)] shadow-sm hover:border-[var(--ink)] transition-colors">
                <Icon name="target" size={11} className="text-[var(--sage-700)]" />
                Formato 9:16 Viral
              </span>
            </div>
          </section>

          {/* Columna derecha: Crear Proyecto + Proyectos de la Sesión */}
          <aside className="flex flex-col gap-3.5 sm:gap-4 w-full min-w-0 lg:self-start lg:sticky lg:top-[74px]">
            <section className="w-full min-w-0 overflow-hidden rounded-[20px] sm:rounded-[24px] border-2 border-[var(--ink)] bg-[var(--white)] p-3.5 sm:p-5 shadow-[var(--shadow-hard)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-display text-lg sm:text-xl font-bold tracking-tight text-[var(--ink)]">Nuevo proyecto</h2>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    Elige una plantilla rápida o personaliza tu formato.
                  </p>
                </div>
                <span className="grid h-8 w-8 sm:h-10 sm:w-10 shrink-0 place-items-center rounded-xl border-2 border-[var(--ink)] bg-[var(--sage-100)] text-[var(--sage-800)] shadow-[var(--shadow-hard-sm)]">
                  <Icon name="film" size={15} />
                </span>
              </div>

              {/* Presets rápidos para Redes Sociales */}
              <div className="mt-3 grid grid-cols-3 gap-1.5 sm:gap-2">
                {SOCIAL_PRESETS.map((preset) => {
                  const isSelected = aspect === preset.aspect && fps === preset.fps;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applySocialPreset(preset)}
                      className={`relative flex flex-col items-start rounded-xl border-2 p-1.5 sm:p-2 text-left transition-all min-w-0 ${isSelected
                        ? "border-[var(--ink)] bg-learn-green/20 shadow-[var(--shadow-hard-sm)]"
                        : "border-[var(--line-strong)] bg-[var(--paper)] hover:border-[var(--ink)]"
                        }`}
                    >
                      {preset.badge && (
                        <span className="absolute -top-2 right-1 sm:right-1.5 rounded-full border border-[var(--ink)] bg-[#facc15] px-1.5 py-[1px] text-[7px] sm:text-[7.5px] font-black uppercase text-[#0c150d] shadow-sm">
                          {preset.badge}
                        </span>
                      )}
                      <span className="text-[10px] sm:text-[11.5px] font-extrabold text-[var(--ink)] leading-tight truncate w-full">{preset.label}</span>
                      <span className="mt-0.5 text-[8px] sm:text-[9.5px] font-semibold text-[var(--muted)] truncate w-full">{preset.sub}</span>
                    </button>
                  );
                })}
              </div>

              <form
                className="mt-3 space-y-2.5 sm:space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
              >
                <label className="block">
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">
                    Nombre del montaje
                  </span>
                  <input
                    ref={nameRef}
                    className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] px-3 py-2 text-base sm:text-sm font-semibold text-[var(--ink)] outline-none transition-all placeholder:font-normal placeholder:text-[var(--muted)] focus:border-[var(--ink)] focus:ring-4 focus:ring-learn-green/25"
                    placeholder="Mi video viral"
                    value={name}
                    maxLength={160}
                    onClick={() => {
                      if (!user) requireAuthModal();
                    }}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>

                <div>
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">
                    Relación de aspecto
                  </span>
                  <div className="grid grid-cols-5 gap-1 sm:gap-1.5 w-full min-w-0">
                    {(Object.keys(ASPECT_PRESETS) as AspectRatio[]).map((key) => {
                      const active = aspect === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            setAspect(key);
                            if (!user) requireAuthModal();
                          }}
                          aria-pressed={active}
                          className={`flex flex-col items-center justify-center gap-0.5 sm:gap-1 rounded-xl border-[1.5px] sm:border-2 py-1 sm:py-1.5 px-0 text-[8px] sm:text-[10px] font-bold uppercase tracking-tight transition-all min-w-0 w-full overflow-hidden ${active
                            ? "border-[var(--ink)] bg-learn-green/25 text-[var(--sage-800)] shadow-[var(--shadow-hard-sm)]"
                            : "border-[var(--line-strong)] bg-[var(--paper)] text-[var(--muted)] hover:border-[var(--ink)] hover:text-[var(--ink)]"
                            }`}
                        >
                          <span
                            className="rounded-[2px] border sm:border-2 border-current shrink-0"
                            style={shapeFor(ASPECT_PRESETS[key].ratio, 10)}
                          />
                          <span className="truncate w-full text-center px-0.5">{key}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Resolución y Fotogramas en 2 columnas */}
                <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)] truncate">
                      Resolución
                    </span>
                    <select
                      className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] px-2 sm:px-2.5 py-2 text-base sm:text-sm font-semibold text-[var(--ink)] outline-none transition-colors focus:border-[var(--ink)]"
                      value={height}
                      onChange={(event) => {
                        setHeight(Number(event.target.value) as ResolutionHeight);
                        if (!user) requireAuthModal();
                      }}
                    >
                      {HEIGHTS.map((value) => (
                        <option key={value} value={value}>
                          {value}p {value === 1080 ? "(Full HD)" : value === 2160 ? "(4K)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)] truncate">
                      Fotogramas
                    </span>
                    <select
                      className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] px-2 sm:px-2.5 py-2 text-base sm:text-sm font-semibold text-[var(--ink)] outline-none transition-colors focus:border-[var(--ink)]"
                      value={fps}
                      onChange={(event) => {
                        setFps(Number(event.target.value));
                        if (!user) requireAuthModal();
                      }}
                    >
                      {FPS_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value} fps
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {/* Botones de acción en 2 columnas */}
                <div className="grid grid-cols-2 gap-2 sm:gap-2.5 pt-1">
                  <button
                    type="submit"
                    className="btn btn-primary btn-md justify-center !h-[38px] sm:!h-10 text-xs sm:text-sm font-bold min-w-0 truncate shadow-[var(--shadow-hard-sm)]"
                    disabled={pending !== null}
                  >
                    {pending === "create" ? <Icon name="loader" size={14} className="spin shrink-0" /> : <Icon name="plus" size={14} className="shrink-0" />}
                    <span className="truncate">Crear estudio</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-soft justify-center text-xs font-semibold !h-[38px] sm:!h-10 min-w-0 truncate"
                    onClick={() => void demo()}
                    disabled={pending !== null}
                    title="Abrir con proyecto de demostración"
                  >
                    {pending === "demo" ? <Icon name="loader" size={14} className="spin shrink-0" /> : <Icon name="wand" size={14} className="shrink-0" />}
                    <span className="truncate">Abrir demo</span>
                  </button>
                </div>
              </form>
            </section>

            {/* Proyectos recientes de la sesión */}
            <section className="w-full max-w-full min-w-0 overflow-hidden rounded-[20px] sm:rounded-[24px] border-2 border-[var(--ink)] bg-[var(--white)] p-3.5 sm:p-4 shadow-[var(--shadow-hard)]">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate font-display text-sm sm:text-base font-bold tracking-tight text-[var(--ink)]">
                    {user ? `Espacio de @${user.handle}` : "Tus proyectos"}
                  </h2>
                  {user ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-green-600/30 bg-green-500/10 px-2 py-0.5 text-[9px] font-bold text-green-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      Privado
                    </span>
                  ) : (
                    <span className="tag neutral">{projectCount}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!user && (
                    <button
                      type="button"
                      onClick={() => requireAuthModal(undefined, "register")}
                      className="text-[10px] font-bold text-[var(--sage-700)] hover:underline flex items-center gap-1 mr-1"
                      title="Regístrate para guardar y aislar tus proyectos en tu propia cuenta"
                    >
                      <Icon name="user" size={11} />
                      <span className="hidden sm:inline">Crear mi espacio</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm !h-7 !w-7"
                    onClick={() => (!user ? requireAuthModal() : onRetry())}
                    title="Actualizar lista"
                    aria-label="Actualizar lista de proyectos"
                  >
                    <Icon name="refresh" size={13} className={loadingProjects ? "spin" : undefined} />
                  </button>
                </div>
              </div>

              {loadingProjects && projectCount === 0 ? (
                <div className="flex items-center gap-2 py-4 text-xs text-[var(--muted)]">
                  <Icon name="loader" size={14} className="spin" />
                  Cargando proyectos...
                </div>
              ) : projectCount === 0 ? (
                <div
                  className={`rounded-xl border-2 border-dashed border-[var(--line-strong)] px-3 py-4 text-center ${
                    !user ? "cursor-pointer transition-colors hover:border-[var(--ink)] hover:bg-[var(--sage-50)]" : ""
                  }`}
                  onClick={() => {
                    if (!user) requireAuthModal();
                  }}
                >
                  <Icon name={user ? "folder" : "lock"} size={16} className="mx-auto text-[var(--muted)]" />
                  <p className="mt-1 text-xs font-bold text-[var(--ink-soft)]">
                    {user ? `¡Todo listo, @${user.handle}!` : "Inicia sesión para ver tus proyectos"}
                  </p>
                  <p className="mt-0.5 text-[10.5px] text-[var(--muted)]">
                    {user ? (
                      <>
                        Pulsa en <strong>Probar OECLIP al Toque</strong> o crea tu primer montaje arriba.
                      </>
                    ) : (
                      <>
                        Haz clic aquí o selecciona una opción arriba para <strong>iniciar sesión</strong> o <strong>registrarte</strong>.
                      </>
                    )}
                  </p>
                </div>
              ) : (
                <div className="-mr-1 max-h-[160px] space-y-1 overflow-y-auto pr-1 w-full min-w-0">
                  {projects.slice(0, 8).map((project) => (
                    <div
                      key={project.id}
                      className="group flex cursor-pointer items-center gap-2 rounded-xl border border-transparent p-1 transition-all hover:border-[var(--ink)] hover:bg-[var(--sage-50)] focus:outline-none focus-visible:border-[var(--ink)] w-full min-w-0 overflow-hidden"
                      role="button"
                      tabIndex={0}
                      aria-label={`Abrir ${project.name}`}
                      onClick={() => {
                        if (!pending) void run(project.id, () => onOpen(project.id));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !pending) void run(project.id, () => onOpen(project.id));
                      }}
                    >
                      <ProjectThumb project={project} />
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <span className="block truncate text-[11px] sm:text-[12px] font-semibold text-[var(--ink)]">
                          {project.name}
                        </span>
                        <span className="mt-0.5 block truncate text-[8.5px] sm:text-[10px] text-[var(--muted)]">
                          {projectMeta(project)}
                        </span>
                      </div>
                      {pending === project.id ? (
                        <Icon name="loader" size={14} className="spin shrink-0 text-[var(--muted)]" />
                      ) : (
                        <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          <button
                            type="button"
                            className="grid h-7 w-7 place-items-center rounded-lg border border-[var(--line-strong)] bg-[var(--white)] text-[var(--ink-soft)] transition-all hover:border-[var(--ink)] hover:text-[var(--ink)]"
                            onClick={(event) => {
                              event.stopPropagation();
                              void run(`dup-${project.id}`, () => onDuplicate(project.id));
                            }}
                            title="Duplicar proyecto"
                            aria-label={`Duplicar ${project.name}`}
                          >
                            <Icon name="duplicate" size={11} />
                          </button>
                          <button
                            type="button"
                            className="grid h-7 w-7 place-items-center rounded-lg border border-[var(--line-strong)] bg-[var(--white)] text-[var(--danger)] transition-all hover:border-[var(--danger)]"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteTarget(project);
                            }}
                            title="Eliminar proyecto"
                            aria-label={`Eliminar ${project.name}`}
                          >
                            <Icon name="trash" size={11} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      </main>

      <footer className="mt-auto border-t-2 border-[var(--ink)] bg-[var(--white)]">
          <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-2 px-3 sm:px-6 py-2.5 sm:py-3 text-[10.5px] font-medium text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
            <span className="inline-flex items-center gap-2 font-semibold text-[var(--ink-soft)]">
              <Icon name="sparkles" size={12} className="text-[var(--sage-600)]" />
              OECLIP AI Studio · Edición de video viral asistida por agentes autónomos.
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="tag neutral">{ffmpeg ? `FFmpeg ${ffmpeg.split(" ")[0]}` : "Motor Multimedia Activo"}</span>
              {nvenc && <span className="tag">GPU NVENC</span>}
              <span className="tag neutral">{ai?.configured ? `IA · ${ai.model}` : "Agente Inteligente"}</span>
            </span>
          </div>
        </footer>

        {deleteTarget && (
          <ConfirmDialog
            title="Eliminar proyecto"
            message={`"${deleteTarget.name}" se moverá a la papelera de OECLIP.`}
            confirmLabel="Eliminar proyecto"
            danger
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => {
              const target = deleteTarget;
              setDeleteTarget(null);
              void run(`del-${target.id}`, () => onDelete(target.id));
            }}
          />
        )}

        {/* Modal de Inicio de Sesión / Registro / Cambio de Cuenta */}
        {loginModalOpen && (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-[max(12px,env(safe-area-inset-top))] sm:p-4 backdrop-blur-sm animate-fade-in"
            onClick={closeAuthModal}
          >
            <div
              className="w-full max-w-[420px] max-h-[min(92dvh,720px)] overflow-y-auto rounded-[22px] sm:rounded-[24px] border-2 border-[var(--ink)] bg-[var(--white)] p-4 sm:p-6 shadow-[var(--shadow-hard)]"
              onClick={(e) => e.stopPropagation()}
            >
              {renderAuthPanel()}
            </div>
          </div>
        )}

        {profileModalOpen && user && (
          <UserProfileModal
            user={user}
            aiStatus={config?.ai ?? null}
            onClose={() => setProfileModalOpen(false)}
            onUserUpdated={(updated) => {
              if (onUserUpdated) {
                void onUserUpdated(updated);
              } else {
                void onAuthSuccess(updated);
              }
            }}
            onSwitchAccount={() => {
              setProfileModalOpen(false);
              openAuthGate("login");
            }}
            onLogout={() => {
              setProfileModalOpen(false);
              void onSignOut();
            }}
            onOpenSettings={
              onOpenSettings
                ? () => {
                    setProfileModalOpen(false);
                    onOpenSettings();
                  }
                : undefined
            }
            onOpenAdminAccounts={
              user.role === "admin"
                ? () => {
                    setProfileModalOpen(false);
                    setAdminUsersOpen(true);
                  }
                : undefined
            }
            onToast={onToast}
          />
        )}

        {adminUsersOpen && user?.role === "admin" && (
          <AdminUsersModal
            currentUser={user}
            onClose={() => setAdminUsersOpen(false)}
            onToast={onToast}
          />
        )}
    </div>
  );
}