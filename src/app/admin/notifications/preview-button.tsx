"use client";

import * as React from "react";

/** The eye on a template row: the wording, as it is stored, in a small dialog. */
export function PreviewButton({ name, body }: { name: string; body: string }) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  return (
    <>
      <button
        type="button"
        aria-label={`Preview ${name}`}
        title="Preview"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-control border border-line bg-surface text-ink hover:bg-canvas"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6" />
        </svg>
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,27,51,0.4)] p-4" onClick={() => setOpen(false)}>
          <div role="dialog" aria-label={name} className="w-full max-w-[460px] rounded-card border border-line bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 border-b border-divider px-[18px] py-3.5">
              <h2 className="m-0 text-base font-bold text-ink">{name}</h2>
              <span className="flex-1" />
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="cursor-pointer text-muted hover:text-ink">
                ✕
              </button>
            </div>
            <p className="m-0 px-[18px] py-4 text-[13px] leading-[1.55] whitespace-pre-wrap text-body">{body}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
