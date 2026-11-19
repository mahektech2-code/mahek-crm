"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { btnClass } from "../_shell/kit";
import { liftPause } from "./actions";

/** Clears a wrong-password pause, after asking. */
export function LiftPauseButton({ account }: { account: string }) {
  const router = useRouter();
  const notify = useToast().push;
  const [asking, setAsking] = React.useState(false);
  return (
    <>
      <button type="button" className={btnClass("plain", "sm")} onClick={() => setAsking(true)}>
        Lift pause
      </button>
      <ConfirmDialog
        open={asking}
        title="Lift this pause?"
        body={`${account} can try a password straight away, and the next attempt is counted afresh. Lift it only once you know the attempts were theirs.`}
        confirmLabel="Lift pause"
        cancelLabel="Leave it paused"
        onConfirm={async () => {
          const r = await liftPause(account);
          notify(r.ok ? (r.message ?? "Pause lifted.") : r.error, r.ok ? "info" : "error");
          if (r.ok) router.refresh();
        }}
        onClose={() => setAsking(false)}
      />
    </>
  );
}
