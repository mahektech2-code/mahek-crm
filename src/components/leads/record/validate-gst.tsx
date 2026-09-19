"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { validateGstin } from "@/lib/actions/lead-gst";

/**
 * §11.6 — THE BACK OFFICE'S ANSWER ON A GST NUMBER, and the door the action
 * never had.
 *
 * `validateGstin` shipped complete, audited and tested, and nothing anywhere
 * called it. So `customers.gst_verified` stayed false on every lead in the
 * book — and the qualification gate reads that column, which meant no sample
 * could be requested for anybody, with the refusal naming a check no screen in
 * the product offered a way to perform.
 *
 * **WHO MAY IS MIRRORED FROM THE ACTION AND NEVER RE-DECIDED HERE.** The rule
 * has two halves, both of them the action's: whoever holds `lead.gstValidate`
 * or sits in the named back office seat MAY, and the lead's own owner or sales
 * account manager MAY NOT, whatever else they hold — a check somebody performs
 * on their own work is not a check. The page resolves both and hands down the
 * answer with the sentence that goes with it. A screen working it out for
 * itself is the second copy that drifts, and the half that drifts is the half
 * somebody reads.
 *
 * **Refused, it is drawn DISABLED with the reason on the hover** rather than
 * hidden. The salesman who collected the number is exactly who needs to see
 * that it is waiting on somebody else — a control that simply is not there
 * reads as a screen with nothing to say about a lead that has stopped moving.
 *
 * **A REFUSAL DEMANDS A NOTE, here as well as in the action.** He has to go
 * back to the shop and ask, and "GST rejected" with nothing after it sends him
 * to ask the same question the same way. Enforced in the form so the sentence
 * is wanted BEFORE the button rather than after — being refused once the modal
 * has been submitted loses whatever the person had in mind.
 */
export function ValidateGst({
  customerId,
  name,
  gstin,
  verified,
  canValidate,
  blockedReason,
}: {
  customerId: string;
  name: string;
  /** The number itself. Null is a lead nobody has recorded one for yet. */
  gstin: string | null;
  /** What the column says today, for the wording of the buttons. */
  verified: boolean;
  canValidate: boolean;
  /**
   * Why not, in words, where `canValidate` is false — the hover on the disabled
   * control. Null where they may, and never used then.
   */
  blockedReason: string | null;
}) {
  const router = useRouter();
  const toast = useToast();

  /*
   * Which answer the modal is open for. Null is closed, which is one piece of
   * state rather than an `open` beside a `valid` that can disagree with it.
   */
  const [asking, setAsking] = React.useState<null | "pass" | "refuse">(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(which: "pass" | "refuse") {
    setNote("");
    setError(null);
    setAsking(which);
  }

  async function submit() {
    const valid = asking === "pass";
    if (!valid && !note.trim()) {
      setError(
        "Say what is wrong with it. The salesman has to go back and ask, and he cannot ask better without knowing what failed.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await validateGstin({ customerId, valid, note: note.trim() || undefined });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAsking(null);
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  /* Nothing to check. The salesman records the number; this screen only ever
     says whether it holds up, and the action refuses without one — so offering
     the buttons here would be offering a refusal. The panel above says what is
     missing instead. */
  if (!gstin?.trim()) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          tone="default"
          disabled={!canValidate}
          title={canValidate ? "It is a real number and we can invoice them." : (blockedReason ?? undefined)}
          onClick={() => begin("pass")}
        >
          {verified ? "Check it again" : "It checks out"}
        </Button>
        <Button
          size="sm"
          tone="danger"
          disabled={!canValidate}
          title={
            canValidate
              ? "It does not hold up. This blocks the sample until a corrected number is checked."
              : (blockedReason ?? undefined)
          }
          onClick={() => begin("refuse")}
        >
          Refuse it
        </Button>
      </div>

      <Modal
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking === "refuse" ? "Refuse this GST number" : "Validate this GST number"}
        width={520}
      >
        <p className="mb-3 text-[13px] text-body">
          {name} · <span className="font-medium text-ink">{gstin}</span>
        </p>
        <p className="mb-3 text-[13px] text-pretty text-body">
          {asking === "refuse" ? (
            <>
              A refusal blocks the sample — no stock goes to a business we could not confirm we may
              invoice. It is reversible without anybody undoing anything: the gate reads the column
              on every evaluation, so the moment a corrected number is validated the lead carries on
              from the rung it is already on.
            </>
          ) : (
            <>
              This says the number is real and we could invoice this business. It is recorded with
              your name and today&rsquo;s date, and it is what the qualification gate reads before
              anybody may send a sample.
            </>
          )}
        </p>

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            {asking === "refuse" ? "What is wrong with it · required" : "Anything to add (optional)"}
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setAsking(null)}>
            Cancel
          </Button>
          <Button
            tone={asking === "refuse" ? "danger" : "primary"}
            disabled={busy || (asking === "refuse" && !note.trim())}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : asking === "refuse" ? "Refuse it" : "Validate it"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
