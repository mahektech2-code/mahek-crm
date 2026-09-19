"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/console/parts";
import { REASON_CODE_NEEDING_REMARKS } from "@/lib/lead-labels";
import { cancelSample } from "@/lib/actions/lead-samples";

type Coded = { code: string; label: string };

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
 * **A REASON IS REQUIRED, and it is now a CODE rather than a sentence.** It
 * shipped as a free box, on the honest reasoning that there was no configured
 * list of cancellation reasons to read and inventing one on a screen would be
 * a vocabulary the stored column knew nothing about. There is one now —
 * `leads.sampleCancelReasons`, Mahek's own eight — and what the eight buy is
 * the thing a box could never give: they separate THREE DIFFERENT PROBLEMS
 * that all read as "trial cancelled". A product we could not source is a
 * SUPPLY problem, a customer who stopped answering is a CUSTOMER problem, and
 * a price objection is a SALES problem — three different people's mornings,
 * and nobody could count which of the three the book was full of.
 *
 * **The list comes from configuration, never from `SAMPLE_CANCEL_REASONS`.**
 * The action validates what arrives against the configured list, so a picker
 * built from the literal would offer a code the server refuses on any
 * deployment where somebody has reworded it — and the refusal would read as
 * the app being broken rather than as the list having moved.
 *
 * **Nothing is pre-selected**, which is how every coded picker in this product
 * behaves and is the whole point of coding them: a default means pressing
 * "Cancel" then "Cancel the sample" records a reason nobody chose, and
 * whichever code sits at the top of the list quietly becomes the commonest
 * problem in the business. That is a wrong answer at scale, invisibly, to the
 * one question these eight exist to answer.
 *
 * **The remarks are offered always and DEMANDED on `other`.** A code meaning
 * "something else" with nothing behind it is the one cancellation nobody can
 * act on, and it is the code people reach for when a list does not fit, so it
 * has to cost a sentence. Everywhere else the words are welcome and optional —
 * the code has already said which problem it is, and demanding prose after an
 * answer somebody has already given is how people learn to type a full stop
 * into the box. Refused here AND in the action, because a required field on a
 * screen is not a rule and a server action is a URL.
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
  reasons,
  canWork,
}: {
  sampleId: string;
  /** What is being called off, in words, so nobody cancels the wrong row. */
  what: string;
  /** `leads.sampleCancelReasons`, resolved on the server. Never the literal. */
  reasons: Coded[];
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
      {/* A `key` and a remount rather than an effect clearing the boxes — the
          React Compiler rules are on, and every modal in this product resets
          this way. */}
      {open ? (
        <CancelForm
          key={sampleId}
          sampleId={sampleId}
          what={what}
          reasons={reasons}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function CancelForm({
  sampleId,
  what,
  reasons,
  onClose,
}: {
  sampleId: string;
  what: string;
  reasons: Coded[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [reasonCode, setReasonCode] = React.useState("");
  const [remarks, setRemarks] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const said = remarks.trim();
  const needsWords = reasonCode === REASON_CODE_NEEDING_REMARKS;
  const answered = Boolean(reasonCode) && (!needsWords || Boolean(said));

  async function save() {
    /* Refused here as well as by the disabled button, and with the sentence
       rather than silently, so somebody who reached the button by keyboard is
       told what is wanted rather than finding nothing happens. */
    if (!reasonCode) {
      setError(
        "Pick why the trial is being called off. Which of the eight it is decides who this lands on — the factory, the salesman, or whoever sets the price.",
      );
      return;
    }
    if (needsWords && !said) {
      setError("“Other” needs a sentence. It is the one answer nobody can act on without one.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await cancelSample(sampleId, { reasonCode, remarks: said || null });
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

      <div className="mb-1 text-[13px] font-medium text-ink">Why · required</div>
      <div className="flex flex-col gap-0.5">
        {reasons.map((r) => (
          <label
            key={r.code}
            className="flex cursor-pointer items-center gap-2 rounded-[4px] px-1.5 py-1 text-[13px] text-body hover:bg-canvas"
          >
            <input
              type="radio"
              name="sample-cancel-reason"
              value={r.code}
              checked={reasonCode === r.code}
              disabled={busy}
              onChange={() => setReasonCode(r.code)}
            />
            {r.label}
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-muted">
        A code rather than a sentence, because &ldquo;we could not source it&rdquo;, &ldquo;they
        stopped answering&rdquo; and &ldquo;the price was the problem&rdquo; are three different
        problems for three different people — and all three read as &ldquo;cancelled&rdquo; until
        somebody can count them.
      </p>

      {/* The box appears with the code that demands it rather than sitting
          there greyed: a field that is optional on seven answers and required
          on the eighth says more by arriving than any label on it could. */}
      <label className="mt-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">
          {needsWords ? "What happened · required" : "Anything to add (optional)"}
        </span>
        <Textarea
          rows={3}
          value={remarks}
          disabled={busy}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="The shop has moved · the 20L was out of stock in Nagpur · they want it after Diwali"
          className="w-full"
        />
        <span className="mt-1 block text-[12px] text-muted">
          {needsWords
            ? "“Other” is the code people reach for when the list does not fit, so it costs a sentence — one with nothing behind it is the row nobody can act on."
            : "The code says which problem it is; this says what actually happened, which no list of eight can."}
        </span>
      </label>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Keep it
        </Button>
        <Button
          tone="danger"
          disabled={busy || !answered}
          title={
            answered
              ? undefined
              : reasonCode
                ? "Say what happened — “Other” is the one answer that needs the words."
                : "Pick why the trial is being called off."
          }
          onClick={() => void save()}
        >
          {busy ? "Cancelling…" : "Cancel the sample"}
        </Button>
      </div>
    </Modal>
  );
}
