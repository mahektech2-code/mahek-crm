"use client";

import * as React from "react";
import { cx } from "./primitives";

type Toast = { id: number; message: string; tone: "info" | "error" };

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

  const push = React.useCallback(
    (message: string, tone: "info" | "error" = "info") => {
      const id = nextId.current++;
      setToasts((t) => [...t, { id, message, tone }]);
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, 4500);
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
          <div
            key={t.id}
            role="status"
            className={cx(
              "animate-toast-in pointer-events-auto flex items-center gap-3 rounded-[6px] px-3.5 py-2.5 text-sm font-medium shadow-[0_8px_24px_rgba(22,22,22,0.12)]",
              t.tone === "error"
                ? "bg-danger text-white"
                : "bg-ink text-white",
            )}
          >
            {t.message}
            <button
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              className="cursor-pointer text-[13px] text-line-strong hover:text-white"
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
