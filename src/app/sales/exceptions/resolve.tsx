"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { resolveException } from "@/lib/actions/expenses";
import { Button, ReasonModal } from "../parts";

/**
 * Answering one exception.
 *
 * Three answers, and they are genuinely three rather than a yes and a no.
 * **Allow** says the spending was right and the rule did not fit this day —
 * which happens, and is the ordinary answer to a market that is further away
 * than the band expected. **Refuse** says it should not have been claimed.
 * **Corrected** says the underlying figure was wrong and has been put right,
 * so the exception describes something that no longer exists.
 *
 * A reason is required on every one of them, not only on the refusal. The
 * question this screen exists to answer is asked again in March — "why was
 * that 240 km day allowed" — and "somebody clicked allow" is not an answer.
 */
export function ResolveException({ id, what }: { id: string; what: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState<null | "accepted" | "rejected" | "corrected">(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const start = (resolution: "accepted" | "rejected" | "corrected") => {
    setReason("");
    setError(null);
    setOpen(resolution);
  };

  const confirm = async () => {
    if (!open) return;
    setBusy(true);
    setError(null);
    const result = await resolveException({ exceptionId: id, resolution: open, note: reason });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(null);
    router.refresh();
  };

  return (
    <>
      <div className="flex justify-end gap-1.5">
        <Button tone="quiet" onClick={() => start("accepted")}>
          Allow
        </Button>
        <Button tone="quiet" onClick={() => start("corrected")}>
          Corrected
        </Button>
        <Button tone="danger" onClick={() => start("rejected")}>
          Refuse
        </Button>
      </div>
      <ReasonModal
        open={open !== null}
        title={
          open === "accepted"
            ? "Allow this"
            : open === "rejected"
              ? "Refuse this"
              : "Mark it corrected"
        }
        subject={what}
        subjectDetail={
          open === "accepted"
            ? "The spending stands and the rule did not fit this day."
            : open === "rejected"
              ? "This should not have been claimed. The salesman is told."
              : "The figure behind it has been put right, so the question no longer applies."
        }
        fieldLabel="Why — this is what somebody reads in March"
        reason={reason}
        onReasonChange={setReason}
        confirmLabel={open === "rejected" ? "Refuse" : "Save"}
        danger={open === "rejected"}
        busy={busy}
        error={error}
        onClose={() => setOpen(null)}
        onConfirm={confirm}
      />
    </>
  );
}
