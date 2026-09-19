"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/console/parts";
import { cancelSample } from "@/lib/actions/lead-samples";

/* ---------------------------------------------------------------------------
 * §15 — CALLING A TRIAL OFF, which is the other half of asking for one.
 *
 * `cancelSample` was finished and unreachable for exactly as long as
 * `requestSample` beside it, and the cost of that was quieter and worse. A
 * sample that is never going to be sent does not sit still: it holds a pending
 * row in the approvals queue, it goes on being chased by §16's ladder — day 2,
 * then 4, then 6, and the last interval repeats for ever — and it counts on the
 * desk as stock somebody is waiting on. With no way to cancel it, the only
 * honest exits from a dead request were to approve stock nobody would send or
 * to leave the row there. Both were taken.
 *
 * **A REASON IS REQUIRED, and the form demands it because the action does.**
 * The same rule as a lost lead, an On Hold and a rejected sample, for the same
 * purpose: "the customer moved premises" and "we could not source it" are two
 * different problems with two different fixes, and a request that simply
 * disappears off the desk teaches nobody either of them. `cancelSample`
 * refuses an empty one server-side; drawing the button live and letting the
 * refusal arrive afterwards would lose the sentence somebody had in mind.
 *
 * It is a free sentence rather than a code, unlike why the sample was ASKED
 * for. That is the action's own shape and not a choice made here — there is no
 * configured list of cancellation reasons to read, and inventing one on the
 * screen would be a vocabulary the stored column knows nothing about.
 *
 * **Cancelling is not rejecting.** Refusing a request is a manager's verdict on
 * whether the stock should go, recorded through `decideSample` with the answer
 * reaching the salesman's handset. This is the request being withdrawn — and it
 * rejects any approval still pending underneath, with the cancellation as its
 * note, so the approvals queue empties honestly rather than by somebody
 * clicking through decisions about samples that no longer exist.
 * ------------------------------------------------------------------------- */

export function CancelSample({
  sampleId,
  what,
  canWork,
}: {
  sampleId: string;
  /** What is being called off, in words, so nobody cancels the wrong row. */
  what: string;
  canWork: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        size="sm"
        tone="quiet"
        disabled={!canWork}
        title={
          canWork
            ? "Withdraws the request, rejects any approval still waiting on it, and stops the review chase."
            : "Calling a trial off is the salesman's and the manager's, the same hat that asks for one."
        }
        onClick={() => setOpen(true)}
      >
        Cancel
      </Button>
      {/* A `key` and a remount rather than an effect clearing the box — the
          React Compiler rules are on, and every modal in this product resets
          this way. */}
      {open ? (
        <CancelForm
          key={sampleId}
          sampleId={sampleId}
          what={what}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function CancelForm({
  sampleId,
  what,
  onClose,
}: {
  sampleId: string;
  what: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const said = reason.trim();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await cancelSample(sampleId, said);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      toast.push(result.message ?? "Cancelled.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Call the trial off" width={480}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{what}</div>
        <div className="text-muted">
          Any approval still waiting on this is refused with the reason, and the review chase
          stops. It is not an edit — a cancelled sample stays on the record.
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink">Why · required</span>
        <Textarea
          rows={3}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          placeholder="The shop has moved · we could not source it · they changed their mind"
          className="w-full"
        />
        <span className="mt-1 block text-[12px] text-muted">
          A sample that simply disappears off the desk teaches nobody anything, and the next one
          goes out exactly the same way.
        </span>
      </label>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Keep it
        </Button>
        <Button
          tone="danger"
          disabled={busy || !said}
          title={said ? undefined : "Say why the sample is being cancelled — however short."}
          onClick={() => void save()}
        >
          {busy ? "Cancelling…" : "Cancel the sample"}
        </Button>
      </div>
    </Modal>
  );
}
