import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

interface ModalProps {
  title: string;
  kicker?: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  closeOnBackdrop?: boolean;
}

export function Modal({ title, kicker, subtitle, wide, children, footer, onClose, closeOnBackdrop = true }: ModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-[rgba(24,33,26,0.42)] p-[max(10px,env(safe-area-inset-top))] px-2.5 pb-[max(12px,env(safe-area-inset-bottom))] sm:p-5 backdrop-blur-[6px] animate-[fade-in_140ms_ease_both]"
      onPointerDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`flex max-h-[min(92dvh,900px)] w-full flex-col overflow-hidden rounded-[20px] sm:rounded-[26px] border-2 border-[var(--ink)] bg-[var(--paper)] shadow-[var(--shadow-hard)] animate-[modal-in_200ms_cubic-bezier(0.2,0.8,0.2,1)_both] ${
          wide ? "max-w-[860px]" : "max-w-[600px]"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start gap-3 border-b border-[var(--line)] px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-5">
          <div className="min-w-0 flex-1">
            {kicker && (
              <span className="mb-1.5 sm:mb-2 inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--ink)] bg-[var(--sage-100)] px-2.5 py-[3px] text-[9px] font-extrabold uppercase tracking-[0.16em] text-[var(--sage-800)] shadow-[2px_2px_0_0_var(--ink)]">
                {kicker}
              </span>
            )}
            <h2 className="font-display text-[18px] sm:text-[21px] font-bold leading-tight tracking-[-0.025em] text-[var(--ink)]">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 sm:mt-1.5 max-w-[68ch] text-[11.5px] sm:text-[12px] font-medium leading-relaxed text-[var(--muted-strong)]">
                {subtitle}
              </p>
            )}
          </div>
          <button
            className="grid h-10 w-10 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-full border-2 border-[var(--ink)] bg-[var(--white)] text-[var(--ink-soft)] shadow-[var(--shadow-hard-sm)] transition-all hover:-translate-y-px hover:bg-[var(--sage-50)] hover:text-[var(--ink)] active:translate-y-0 active:shadow-none"
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar (Esc)"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 sm:gap-4 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 [&>*]:shrink-0">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t-2 border-[var(--line)] bg-[var(--cream)] px-4 py-3 sm:px-6 sm:py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirmar",
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[13px] font-medium leading-relaxed text-[var(--ink-soft)]">{message}</p>
    </Modal>
  );
}
