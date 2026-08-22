"use client";

import * as React from "react";

/* ---------------------------------------------------------------------------
 * The modal, on its own.
 *
 * It lived in `overlays.tsx` with everything else until the dictation button
 * needed one: `dictate.tsx` opens a modal, and `overlays.tsx` puts a dictation
 * button in the confirm dialog's reason box, so the two files would import
 * each other. Splitting the piece they both want is the way out of the cycle.
 *
 * `overlays.tsx` re-exports both names, so nothing that already imported them
 * from there had to change.
 * ------------------------------------------------------------------------- */

export function useEscape(onClose: () => void) {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEscape(onClose);
  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(22,22,22,0.35)] p-6"
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width }}
        /*
         * `whitespace-normal` because a dialog inherits from wherever it was
         * MOUNTED, not from where it appears. Opened from a button inside a
         * table cell — which carries `whitespace-nowrap` so a row stays one
         * line — every sentence in the dialog ran off the side and was clipped
         * by the `overflow-hidden` beside it. It reads as prose that will not
         * wrap, which is not a thing anybody thinks to look for in a modal.
         * Normal is the CSS default, so nothing that works today can be
         * relying on the opposite.
         */
        className="max-h-[88vh] overflow-hidden rounded-[6px] bg-surface whitespace-normal shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        <div className="border-b border-divider px-5 py-4 text-lg font-semibold text-ink">
          {title}
        </div>
        <div className="max-h-[62vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2.5 border-t border-divider px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
