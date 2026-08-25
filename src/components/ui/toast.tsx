"use client";

import * as React from "react";
import { cx } from "./primitives";

type Toast = { id: number; message: string; tone: "info" | "error" };

/** How long a toast sits before it dismisses itself, hover aside. */
const DISMISS_AFTER_MS = 5000;

const ToastContext = React.createContext<{
  push: (message: string, tone?: "info" | "error") => void;
  /** Runs an action and toasts whatever it returns. Returns success. */
  run: <T extends { ok: boolean; message?: string; error?: string }>(
    promise: Promise<T>,
  ) => Promise<T>;
} | null>(null);

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(1);

  // Each toast owns its own dismiss timer now — see `ToastItem` — so pushing
  // one no longer needs to arm anything here.
  const dismiss = React.useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = React.useCallback(
    (message: string, tone: "info" | "error" = "info") => {
      const id = nextId.current++;
      setToasts((t) => [...t, { id, message, tone }]);
    },
    [],
  );

  const run = React.useCallback(
    async <T extends { ok: boolean; message?: string; error?: string }>(
      promise: Promise<T>,
    ) => {
      try {
        const result = await promise;
        if (!result.ok) push(result.error ?? "That did not work.", "error");
        else if (result.message) push(result.message);
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Something went wrong.";
        push(message, "error");
        throw error;
      }
    },
    [push],
  );

  const value = React.useMemo(() => ({ push, run }), [push, run]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} dismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * ITS OWN CLOCK, so hovering one toast never touches the others.
 *
 * The countdown PAUSES on hover rather than resetting — a message
 * three-quarters read and then let go finishes the quarter that was left
 * rather than starting over, which is what made a toast somebody kept
 * glancing back at feel like it was never going to leave.
 */
function ToastItem({
  toast,
  dismiss,
}: {
  toast: Toast;
  dismiss: (id: number) => void;
}) {
  const remaining = React.useRef(DISMISS_AFTER_MS);
  const startedAt = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    startedAt.current = Date.now();
    timer.current = setTimeout(() => dismiss(toast.id), remaining.current);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // Armed once, on mount, and re-armed by hand from the handlers below —
    // not by React re-running this on a prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="status"
      onMouseEnter={() => {
        if (!timer.current) return;
        clearTimeout(timer.current);
        timer.current = null;
        remaining.current -= Date.now() - startedAt.current;
      }}
      onMouseLeave={() => {
        if (remaining.current <= 0) {
          dismiss(toast.id);
          return;
        }
        startedAt.current = Date.now();
        timer.current = setTimeout(() => dismiss(toast.id), remaining.current);
      }}
      className={cx(
        "animate-toast-in pointer-events-auto flex items-center gap-3 rounded-[6px] px-3.5 py-2.5 text-sm font-medium shadow-[0_8px_24px_rgba(22,22,22,0.12)]",
        toast.tone === "error" ? "bg-danger text-white" : "bg-ink text-white",
      )}
    >
      {toast.message}
      <button
        onClick={() => dismiss(toast.id)}
        className="cursor-pointer text-[13px] text-line-strong hover:text-white"
      >
        Dismiss
      </button>
    </div>
  );
}
