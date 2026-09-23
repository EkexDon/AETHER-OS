import { useEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { Portal } from "./Portal";
import { cx } from "./utils";

export type ToastKind = "success" | "error" | "info";

export interface ToastOptions {
  /** Secondary line. */
  description?: ReactNode;
  /** Auto-dismiss after this many ms; `0` keeps it until closed. */
  duration?: number;
  /** Optional inline action (e.g. "Open note"). */
  action?: { label: string; onClick: () => void };
}

export interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
  title: ReactNode;
}

/** Default lifetimes; errors stay longer so they can be read. */
export const TOAST_DURATION: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  error: 7000,
};

/** At most this many toasts are visible; older ones are dropped. */
export const MAX_TOASTS = 4;

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, title: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;

/** Toast queue. Usable without React via {@link toast}. */
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, title, options = {}) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, title, ...options }].slice(-MAX_TOASTS) }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** The toast API returned by {@link useToast} and exported as {@link toast}. */
export interface ToastApi {
  success: (title: ReactNode, options?: ToastOptions) => number;
  error: (title: ReactNode, options?: ToastOptions) => number;
  info: (title: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

/** Imperative toast API for non-React code (commands, libs). */
export const toast: ToastApi = {
  success: (title, options) => useToastStore.getState().push("success", title, options),
  error: (title, options) => useToastStore.getState().push("error", title, options),
  info: (title, options) => useToastStore.getState().push("info", title, options),
  dismiss: (id) => useToastStore.getState().dismiss(id),
};

/** Hook form of the toast API. */
export function useToast(): ToastApi {
  return toast;
}

const ICONS: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 size={16} />,
  error: <AlertCircle size={16} />,
  info: <Info size={16} />,
};

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const duration = item.duration ?? TOAST_DURATION[item.kind];
  const remaining = useRef(duration);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = () => {
    if (duration <= 0 || timer.current !== null) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => dismiss(item.id), remaining.current);
  };
  const pause = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  };

  useEffect(() => {
    start();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
    // The timer is armed once per toast; hover/focus pause and resume it.
  }, []);

  return (
    <div
      className={cx("ui-toast", `ui-toast-${item.kind}`)}
      role={item.kind === "error" ? "alert" : "status"}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <span className="ui-toast-icon" aria-hidden="true">
        {ICONS[item.kind]}
      </span>
      <div className="ui-toast-body">
        <div className="ui-toast-title">{item.title}</div>
        {item.description && <div className="ui-toast-description">{item.description}</div>}
      </div>
      {item.action && (
        <button
          type="button"
          className="ui-toast-action"
          onClick={() => {
            item.action?.onClick();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="ui-toast-close" aria-label="Dismiss notification" onClick={() => dismiss(item.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Renders the toast stack (bottom-right, above the status bar). */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <Portal>
      <div className="ui-toast-viewport" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </div>
    </Portal>
  );
}

/** Mount once near the app root; renders children plus the toast stack. */
export function ToastProvider({ children }: { children?: ReactNode }) {
  return (
    <>
      {children}
      <ToastViewport />
    </>
  );
}
