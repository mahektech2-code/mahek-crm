"use client";

import * as React from "react";

export type LiveAlert = {
  key: string;
  tone: "warn" | "danger";
  title: string;
  body: string;
};

/**
 * EVERY WARNING ABOUT THE TEAM, ON ONE LINE.
 *
 * These were five full-width banners stacked above the map, each a paragraph
 * long — so on a bad morning the map started half-way down the screen and the
 * thing the page is FOR was the part you had to scroll to. The counts are what
 * a manager scans; the paragraph is what he reads once, about the one that
 * worries him. So each warning is a chip carrying its count and title, and the
 * explanation opens beneath it on a click. Nothing is dropped: every sentence
 * the banners said is still here, one click away rather than always on.
 */
export function LiveAlerts({ alerts }: { alerts: LiveAlert[] }) {
  const [open, setOpen] = React.useState<string | null>(null);
  if (!alerts.length) return null;
  const shown = alerts.find((a) => a.key === open) ?? null;

  return (
    <div className="flex-none">
      <div className="flex flex-wrap items-center gap-2">
        {alerts.map((a) => {
          const on = a.key === open;
          return (
            <button
              key={a.key}
              type="button"
              onClick={() => setOpen(on ? null : a.key)}
              aria-expanded={on}
              title={on ? "Hide the explanation" : "What this means and what to do"}
              className={
                "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap " +
                (a.tone === "danger"
                  ? "border-danger bg-danger-soft text-[#B3261E]"
                  : "border-warn bg-warn-soft text-[#8A5A00]") +
                (on ? " ring-2 ring-offset-1 ring-[#B3261E]/20" : " hover:brightness-[0.97]")
              }
            >
              <span
                className={
                  "block size-1.5 flex-none rounded-full " +
                  (a.tone === "danger" ? "bg-[#B3261E]" : "bg-[#C98A00]")
                }
              />
              {a.title}
              <span aria-hidden className="text-[11px] opacity-70">
                {on ? "▴" : "▾"}
              </span>
            </button>
          );
        })}
      </div>
      {shown ? (
        <div
          className={
            "mt-2 rounded-[6px] border-l-[3px] px-4 py-2.5 text-[13px] text-pretty text-body " +
            (shown.tone === "danger" ? "border-danger bg-danger-soft" : "border-warn bg-warn-soft")
          }
        >
          <span className="font-semibold text-ink">{shown.title}. </span>
          {shown.body}
        </div>
      ) : null}
    </div>
  );
}
