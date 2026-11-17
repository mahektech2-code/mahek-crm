"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { btnClass } from "../_shell/kit";
import { liftPause } from "./actions";

/** Clears a wrong-password pause, after asking. */
export function LiftPauseButton({ account }: { account: string }) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className={btnClass("plain", "sm")}
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("Lift this pause? Their next password attempt is counted afresh.")) return;
        setBusy(true);
        const r = await liftPause(account);
        setBusy(false);
        notify(r.ok ? (r.message ?? "Pause lifted.") : r.error, r.ok ? "info" : "error");
        if (r.ok) router.refresh();
      }}
    >
      Lift pause
    </button>
  );
}
