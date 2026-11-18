import { useCallback, useRef, useState } from "react";
import type { ToastItem, ToastKind } from "../components/Toasts";

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  const pushToast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = toastIdRef.current + 1;
    toastIdRef.current = id;
    setToasts((items) => {
      const last = items[items.length - 1];
      // Un mismo aviso repetido se refresca en su sitio en vez de apilarse.
      if (last && last.message === message && last.kind === kind) {
        return [...items.slice(0, -1), { id, message, kind }];
      }
      return [...items.slice(-1), { id, message, kind }];
    });
    window.setTimeout(
      () => setToasts((items) => items.filter((item) => item.id !== id)),
      kind === "error" ? 7200 : 4200,
    );
  }, []);

  return { toasts, pushToast };
}

