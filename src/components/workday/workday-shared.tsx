"use client";

import { cx } from "@/components/ui/primitives";
import type { OpResult } from "./workday-context";

/*
 * THE TWO PIECES OF THE WORKDAY SCREENS THAT THE HEADER CHIP AND THE LAUNCHER
 * ALSO USE, kept out of `workday-overlays.tsx`.
 *
 * The overlays — the lock screen, its five cards and the idle warning — are
 * about 36 KB, and are drawn only while somebody is locked out or idle. They
 * load on demand (`workday-context.tsx`). The chip is in every header, and
 * importing these two from the overlays file put the whole lock screen into
 * every app's first download.
 */

/** The act, with no location (Nov 2026). Punch-in and punch-out used to ask
 *  the browser where it was first: a permission prompt nobody needed, and up
 *  to 20 seconds of a dead-looking button on a desktop waiting for a GPS fix
 *  it does not have — for a reading that was never a gate. Kept as a wrapper
 *  so every caller stays as it is. */
export async function withLocation(run: (fix: { lat: number | null; lng: number | null; accuracy: number | null }) => Promise<OpResult>): Promise<OpResult> {
  return run({ lat: null, lng: null, accuracy: null });
}

export function VerdictPill({ v }: { v: { label: string; tone: string } }) {
  const cls =
    v.tone === "success"
      ? "bg-success-soft text-success"
      : v.tone === "warn"
        ? "bg-warn-soft text-warn-ink"
        : v.tone === "danger"
          ? "bg-danger-soft text-danger"
          : v.tone === "brand"
            ? "bg-brand-soft text-brand-deep"
            : "bg-canvas text-muted";
  return <span className={cx("rounded-full px-3 py-1 text-[12px] font-bold whitespace-nowrap", cls)}>{v.label}</span>;
}
