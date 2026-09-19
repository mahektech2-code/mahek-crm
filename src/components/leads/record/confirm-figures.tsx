"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { confirmLeadFigures } from "@/lib/actions/lead-figures";

/**
 * §5.3 — "THESE STILL HOLD", said once about four figures already on the record.
 *
 * **It is a button and not a form, and that is the whole design.** The monthly
 * requirement, the potential, the product and the competitor are captured at
 * Suspect → Prospect and deliberately never re-asked — the specification's own
 * first principle, that a fact established by whoever was in the shop is not
 * re-certified later by another role. A form here would be four fields retyped,
 * which is a second copy of the columns the gates read and free to drift from
 * them the moment somebody half-fills it. What is being recorded is a person's
 * word that they read what is there and it is still true; the figures are drawn
 * immediately above this control so that word is not given blind.
 *
 * **Correcting a figure is a different act**, on the qualification screen, and
 * the sentence beside this says so — somebody who finds the requirement has
 * doubled must not feel that confirming is their only option.
 *
 * **Without `lead.work` it is drawn and DISABLED with the reason on the hover**,
 * this product's rule for a control somebody might reasonably expect to hold.
 * The action checks the capability too: a disabled button is a fact about a
 * component rather than about the system.
 */
export function ConfirmFigures({
  customerId,
  canWork,
  stale,
}: {
  customerId: string;
  canWork: boolean;
  /**
   * Whether the gate is refusing on this right now. It changes the WORDS and
   * nothing else — confirming is offered either way, because somebody reviewing
   * a lead a week before the window closes should be able to say so rather than
   * be told to come back when it has broken.
   */
  stale: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      const result = await confirmLeadFigures({ customerId });
      if (!result.ok) {
        toast.push(result.error, "error");
        return;
      }
      toast.push(result.message ?? "Noted.");
      router.refresh();
    } finally {
      /* Cleared whatever happened: an action that rejects rather than returning
         a Result would otherwise leave the button dead until a reload. */
      setBusy(false);
    }
  }

  return (
    <Button
      tone={stale ? "primary" : "default"}
      size="sm"
      disabled={!canWork || busy}
      title={
        canWork
          ? "Records that somebody has read these four and says they still hold. It writes a date and never a second copy of the figures."
          : "Working a lead is the salesman's and the manager's, the same hat that moves one up a rung."
      }
      onClick={() => void save()}
    >
      {busy ? "Saving…" : "Confirm these still hold"}
    </Button>
  );
}
