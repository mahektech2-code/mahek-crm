"use client";

import { useWorkday } from "@/components/workday/workday-context";
import { DayPanel } from "@/components/workday/workday-chip";
import { cx } from "@/components/ui/primitives";
import { hmOf, OFF_DAY_WORDS } from "@/components/workday/format";

/* ---------------------------------------------------------------------------
 * THE DAY CARD on the launcher and on HRMS Home. It used to be a reminder
 * strip with a dismissable dialog; since the workday clock (Nov 2026) the
 * day is punched in, paused and punched out from here, the header's timer
 * and the lock screen — one panel, `DayPanel`, so the three cannot disagree.
 * The day itself comes from the workday clock's provider.
 * ------------------------------------------------------------------------- */

export function LauncherCheckIn() {
  const w = useWorkday();
  if (!w || !w.state.subject) return null;
  const { state } = w;
  if (state.onHandset) {
    return (
      <div className="rounded-[8px] border border-line bg-surface px-5 py-3.5 text-[13px] text-body">
        You punched in on the field app today, so you punch out there too.
      </div>
    );
  }
  const dot =
    state.phase === "working"
      ? "bg-success"
      : state.phase === "break" || state.phase === "auto_break"
        ? "bg-warn"
        : state.phase === "none"
          ? "bg-brand"
          : "bg-faint";
  const title =
    state.phase === "none"
      ? state.offDay
        ? `Today is ${state.holidayName ?? OFF_DAY_WORDS[state.offDay]}`
        : "Not punched in"
      : state.phase === "working"
        ? `Working · ${hmOf(w.workedMs)}`
        : state.phase === "break" || state.phase === "auto_break"
          ? "On a break"
          : `Day done · ${hmOf(w.workedMs)}`;
  return (
    <section aria-label="Your day" className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <div className="flex items-center gap-3 border-b border-divider px-5 py-3">
        <span className={cx("size-2.5 flex-none rounded-full", dot)} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="block truncate text-[13px] text-muted">
            {[state.office, state.official ? `office hours ${state.official}` : null, state.offDay ? "hours you work are extra work" : null].filter(Boolean).join(" · ")}
          </span>
        </span>
      </div>
      <DayPanel />
    </section>
  );
}
