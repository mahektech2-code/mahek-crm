"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { rebuildDerived } from "@/lib/actions/admin-console";
import type { DerivedFigure } from "@/lib/admin-derived";

/** Runs one derived figure's recompute now, rather than at the nightly pass. */
export function RebuildButton({ which, label }: { which: DerivedFigure; label: string }) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      aria-label={`Rebuild ${label}`}
      title={`Rebuild ${label} now`}
      onClick={async () => {
        setBusy(true);
        const r = await rebuildDerived(which);
        setBusy(false);
        notify(r.ok ? (r.message ?? `${label} rebuilt.`) : r.error, r.ok ? "info" : "error");
        if (r.ok) router.refresh();
      }}
    >
      {busy ? "Rebuilding…" : "Rebuild"}
    </Button>
  );
}
