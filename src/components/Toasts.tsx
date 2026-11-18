import { useRef, useState } from "react";
import { Icon } from "./Icon";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastsProps {
  items: ToastItem[];
  onDismiss: (id: number) => void;
  onPauseChange?: (id: number, paused: boolean) => void;
  placement?: "editor" | "standalone";
}

const TONE: Record<
  ToastKind,
  { card: string; badge: string; icon: "check" | "alert" | "info"; role: "alert" | "status" }
> = {
  success: {
    card: "border-[var(--ink)] bg-[var(--white)] text-[var(--ink)]",
    badge: "bg-[var(--sage-150)] text-[var(--sage-800)] border-[var(--line-strong)]",
    icon: "check",
    role: "status",
  },
  error: {
    card: "border-[#9f2318] bg-[#fff6f5] text-[#5e140e]",
    badge: "bg-[var(--danger-soft)] text-[var(--danger)] border-[#e6b3ad]",
    icon: "alert",
    role: "alert",
  },
  info: {
    card: "border-[var(--ink)] bg-[var(--white)] text-[var(--ink)]",
    badge: "bg-[var(--cream-deep)] text-[var(--muted-strong)] border-[var(--line-strong)]",
    icon: "info",
    role: "status",
  },
};

function ToastCard({
  toast,
  isLatest,
  onDismiss,
  onPauseChange,
}: {
  toast: ToastItem;
  isLatest: boolean;
  onDismiss: (id: number) => void;
  onPauseChange?: (id: number, paused: boolean) => void;
}) {
  const tone = TONE[toast.kind] ?? TONE.info;
  const dragStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    onPauseChange?.(toast.id, true);
    if ((event.target as HTMLElement).closest("button")) return;
    dragStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore environments without pointer capture support.
    }
    setDragOffset({ x: 0, y: 0, active: true });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const rawDy = event.clientY - start.y;
    // Deslizar hacia arriba cierra el aviso arriba; hacia abajo resiste suavemente.
    const dy = rawDy < 0 ? rawDy : rawDy * 0.28;
    setDragOffset({ x: dx, y: dy, active: true });
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    onPauseChange?.(toast.id, false);
    if (!start || start.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore if pointer capture already ended.
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 54 || dy < -28) {
      onDismiss(toast.id);
      return;
    }
    setDragOffset({ x: 0, y: 0, active: false });
  };

  const dismissProgress = Math.min(1, Math.max(Math.abs(dragOffset.x) / 84, Math.max(0, -dragOffset.y) / 48));

  return (
    <div
      role={tone.role}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onMouseEnter={() => onPauseChange?.(toast.id, true)}
      onMouseLeave={() => onPauseChange?.(toast.id, false)}
      style={{
        transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)`,
        opacity: Math.max(0.25, 1 - dismissProgress * 0.75),
        transition: dragOffset.active
          ? "none"
          : "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms ease",
      }}
      className={`pointer-events-auto touch-none select-none w-fit max-w-[min(320px,calc(100vw-24px))] sm:max-w-[min(430px,calc(100vw-36px))] items-center gap-1.5 sm:gap-2 rounded-[20px] sm:rounded-full border-[1.5px] sm:border-2 py-1 pl-1.5 pr-1.5 sm:py-1.5 sm:pl-2 sm:pr-2 text-[11.5px] sm:text-[12.5px] font-semibold leading-tight shadow-[var(--shadow-hard-sm)] animate-[toast-in_200ms_ease_both] ${tone.card} ${
        isLatest ? "inline-flex" : "hidden sm:inline-flex"
      }`}
    >
      <span
        className={`grid h-6 w-6 sm:h-7 sm:w-7 shrink-0 place-items-center rounded-full border ${tone.badge}`}
      >
        <Icon name={tone.icon} size={12} />
      </span>
      <span
        className={`min-w-0 leading-snug break-words ${
          toast.kind === "error" ? "line-clamp-3" : "line-clamp-2"
        }`}
      >
        {toast.message}
      </span>
      <button
        type="button"
        className="grid h-6 w-6 sm:h-7 sm:w-7 shrink-0 place-items-center rounded-full text-[var(--muted-strong)] transition-colors hover:bg-[var(--cream-deep)] hover:text-[var(--ink)] active:scale-95 touch-manipulation"
        aria-label="Cerrar aviso"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

export function Toasts({ items, onDismiss, onPauseChange, placement = "editor" }: ToastsProps) {
  if (items.length === 0) return null;
  const topClass =
    placement === "editor"
      ? "max-[1100px]:top-auto max-[1100px]:bottom-[calc(var(--dock-h)+env(safe-area-inset-bottom,0px)+12px)] min-[1101px]:top-[calc(var(--topbar-h)+12px)]"
      : "top-[calc(env(safe-area-inset-top,0px)+10px)] sm:top-3.5";

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 ${topClass} z-[150] flex flex-col items-center gap-1.5 px-3`}
      aria-live="polite"
    >
      {items.map((toast, index) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          isLatest={index === items.length - 1}
          onDismiss={onDismiss}
          onPauseChange={onPauseChange}
        />
      ))}
    </div>
  );
}
