"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { rebuildDerived } from "@/lib/actions/admin-console";
import { DERIVED_FIGURES, type DerivedFigure } from "@/lib/admin-derived";
import { btnClass } from "../_shell/kit";

const Spin = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
  </svg>
);

/** Runs one derived figure's recompute now, rather than at the nightly pass — the canvas's 32px icon button. */
export function RebuildButton({ which, label }: { which: DerivedFigure; label: string }) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={`Rebuild ${label}`}
      title={busy ? "Rebuilding…" : `Rebuild ${label} now`}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-control border border-line bg-surface text-ink hover:bg-[#f7f9fc] disabled:opacity-50 ${busy ? "animate-spin" : ""}`}
      onClick={async () => {
        setBusy(true);
        const r = await rebuildDerived(which);
        setBusy(false);
        notify(r.ok ? (r.message ?? `${label} rebuilt.`) : r.error, r.ok ? "info" : "error");
        if (r.ok) router.refresh();
      }}
    >
      <Spin />
    </button>
  );
}

/** Every derived figure, one after another — the order the nightly pass uses. */
export function RebuildAllButton() {
  const router = useRouter();
  const notify = useToast().push;
  const [at, setAt] = React.useState<number | null>(null);
  return (
    <button
      type="button"
      disabled={at !== null}
      className={`${btnClass("plain", "sm")} h-8`}
      onClick={async () => {
        for (let i = 0; i < DERIVED_FIGURES.length; i++) {
          setAt(i);
          const r = await rebuildDerived(DERIVED_FIGURES[i].id);
          if (!r.ok) {
            setAt(null);
            notify(`${DERIVED_FIGURES[i].label}: ${r.error}`, "error");
            router.refresh();
            return;
          }
        }
        setAt(null);
        notify("Every derived figure rebuilt.", "info");
        router.refresh();
      }}
    >
      {at === null ? "Rebuild all" : `Rebuilding ${at + 1} of ${DERIVED_FIGURES.length}…`}
    </button>
  );
}

/** Reads every check again. Nothing is written: the checks are counts. */
export function CheckNowButton() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => start(() => router.refresh())} className={`${btnClass("primary")} h-[38px]`}>
      {pending ? "Checking…" : "Check now"}
    </button>
  );
}
