"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  REASON_CODE_NEEDING_REMARKS,
  stageLabel,
  type CodedOption,
  type LeadStage,
} from "@/lib/lead-labels";
import { advanceLeadStage } from "@/lib/actions/leads";
import type { ActionOwnerCandidate } from "@/lib/services/lead-actions-service";
import { Button } from "@/components/console/parts";

/**
 * PARKING A LEAD — the door On Hold has never had.
 *
 * `advanceLeadStage` has accepted `to: "on_hold"` since the rung existed, and
 * since Mahek's instruction landed it DEMANDS three answers before it will
 * write one: why it stopped, the day it comes back, and what happens when it
 * does. None of that had ever been exercised by a person, because there was no
 * control anywhere in MahekOne that asked for a park — the only two paths to
 * `on_hold` were a handset and a hand-written call to a server action. A rule
 * enforced on a door nobody can open is a rule nobody has tested and nobody
 * obeys; it is also, from a reader's point of view, indistinguishable from a
 * feature that was finished.
 *
 * **IT IS NOT "MARK LOST" WITH A SOFTER WORD, and the modal says so before the
 * button is pressed.** `lost` means nobody rings again; a park is a live
 * prospect stopped by something outside the sale, and somebody is going back.
 *
 * **THE WHY IS A CODE AND A SENTENCE, AND THAT IS A REVERSAL.** This modal
 * shipped asking for free text alone, on the reasoning that the useful thing
 * about a park is not which of six boxes it fits but the words that tell
 * whoever picks it up in March what they are walking back into. The second half
 * of that is still true and the first half was wrong: Mahek asked for a
 * controlled list precisely so the parks can be COUNTED — four of the six are
 * the customer's doing and two are ours to chase, and "how many genuine
 * opportunities are we parking a quarter, and for what" is a question nobody
 * can ask of five hundred characters of prose. So both are asked, and the
 * sentence is optional against five of the codes because the code now carries
 * the WHICH. Against `other` it is mandatory, because `other` answers nothing
 * on its own — refused here AND in the action, which is where it counts.
 *
 * **The list comes from configuration, never from `HOLD_REASONS`.** The server
 * validates what arrives against `leads.holdReasons`, so a picker built from
 * the literal would offer a code the action refuses on any deployment where
 * somebody has reworded the list — and that refusal reads as the app being
 * broken rather than as the list having moved. The same rule `MarkLost`
 * follows one file along.
 *
 * **THE THREE ANSWERS ARE ONE RULE AND THE FORM TREATS THEM AS ONE.** A reason
 * with no date is a lead that sits for six months, because "back after Diwali"
 * is a sentence nobody is watching. A date with nothing scheduled is a lead that
 * comes back to NOBODY — the resume date arrives, the list shows it, and there
 * is no action and no person to hand it to. So all three are refused here as
 * well as on the server, and refused with the sentence rather than by a dead
 * button, because somebody who reached the button by keyboard is owed the
 * reason.
 *
 * **The action's day defaults to the day it comes back.** Two date fields side
 * by side is one of them typed twice, and the honest default is the one that is
 * true nearly always: the thing that happens when a lead comes back happens on
 * the day it comes back. It is DERIVED during render rather than copied into
 * state by an effect — the React Compiler rules here forbid the second, and the
 * first is what makes the field still typeable over where a manager wants a
 * reminder call the week before.
 *
 * It is offered to `lead.work`, the same hat that moves a lead up a rung and
 * the same hat that closes one. Parking is not a promotion and gating it behind
 * a manager buys a queue of leads waiting to be paused by somebody who was not
 * on the call. The action checks the capability again on the server, because a
 * server action is a URL and a disabled button is not a permission.
 */
export function ParkLead({
  customerId,
  name,
  stage,
  day,
  candidates,
  holdReasons,
  defaultOwnerId,
  canWork,
}: {
  customerId: string;
  name: string;
  /** The rung it is standing on — which is the rung it will be parked FROM. */
  stage: LeadStage;
  /** The business's own working date, read on the server. Never `new Date()`. */
  day: string;
  /** Who a next action may be owed by. A picker, never a permission. */
  candidates: ActionOwnerCandidate[];
  /** `leads.holdReasons`, resolved on the server. Never the literal list. */
  holdReasons: CodedOption[];
  /** The lead's own salesman, pre-selected where they are on the list. */
  defaultOwnerId: string | null;
  canWork: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  /*
   * NOTHING IS PRE-SELECTED, the rule every coded picker in this product
   * follows. A default would mean "Put on hold" then "Put it on hold" records a
   * reason nobody chose, and whichever code happens to sit at the top of the
   * list quietly becomes the commonest reason Mahek parks leads — which is the
   * one outcome that makes counting them worse than not counting them.
   */
  const [reasonCode, setReasonCode] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [resumeDate, setResumeDate] = React.useState("");
  const [action, setAction] = React.useState("");
  /** Empty means "follow the resume date". See the note above. */
  const [actionDate, setActionDate] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /*
   * A LEAD THAT IS ALREADY PARKED, LOST OR WON CANNOT BE PARKED.
   *
   * The server would refuse the first on `same_stage` and would cheerfully
   * accept the other three — parking a won lead does not record a pause, it
   * overwrites the record of a sale with one — which is exactly why the control
   * is withheld rather than left to be refused. The same argument `MarkLost`
   * makes one file along, about the same four rungs.
   */
  const parkable = !["on_hold", "lost", "won", "customer", "active_distributor"].includes(stage);

  function begin() {
    setReasonCode("");
    setReason("");
    setResumeDate("");
    setAction("");
    setActionDate("");
    setOwner(candidates.some((c) => c.id === defaultOwnerId) ? (defaultOwnerId ?? "") : "");
    setError(null);
    setOpen(true);
  }

  /* The action's day, as the field shows it and as the save sends it — one
     expression, so the two cannot differ by a keystroke nobody made. */
  const effectiveActionDate = actionDate || resumeDate;

  /* `other` is the one code that demands the sentence. Derived rather than
     held in state, so it cannot be left true by a code somebody changed. */
  const remarksRequired = reasonCode === REASON_CODE_NEEDING_REMARKS;

  const missing = [
    reasonCode ? null : "why it is stopping",
    remarksRequired && !reason.trim() ? "what \u201cOther\u201d actually is" : null,
    resumeDate ? null : "the day it comes back",
    action.trim() ? null : "what happens then",
    owner ? null : "who does it",
  ].filter(Boolean) as string[];

  async function submit() {
    if (missing.length) {
      setError(
        `On hold is a pause, not a quiet death. Still to answer: ${missing.join(", ")}. A lead parked without those comes back to nobody.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await advanceLeadStage({
        customerId,
        to: "on_hold",
        /* The code goes at the TOP level rather than inside `hold`, because it
           is what `applyLeadStageMove` writes onto the transition as well as
           onto the customer row — one value read once, so the park's history
           and the park's current state cannot disagree about why it stopped. */
        reasonCode,
        /* The remarks are sent as the transition's note too. A park ENDS: the
           customer columns are cleared the day the lead comes back, and without
           this the sentence somebody typed would go with them and the history
           would record a park with a code and no words. */
        note: reason.trim() || undefined,
        hold: { reason: reason.trim() || undefined, resumeDate },
        nextAction: {
          action: action.trim(),
          date: effectiveActionDate,
          ownerId: owner,
        },
      });
    } finally {
      /* Cleared whatever happened: an action that rejects rather than returning
         a Result would otherwise leave the button dead until a reload. */
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? `${name} is parked until ${resumeDate}.`);
    router.refresh();
  }

  return (
    <>
      <Button
        size="sm"
        disabled={!canWork || !parkable}
        title={
          !canWork
            ? "Parking a lead is the salesman's and the manager's, the same hat that moves one up a rung."
            : !parkable
              ? stage === "on_hold"
                ? "This lead is already on hold."
                : "A lead that is closed or won has nothing left to pause."
              : undefined
        }
        onClick={begin}
      >
        Put on hold
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Put this lead on hold" width={560}>
        <p className="mb-3 text-[13px] text-body">
          {name} is at {stageLabel(stage)}. On hold is a <strong className="font-semibold">pause</strong>,
          not a close: the lead stays live, it keeps its history, and it comes back onto the parked
          list on the day you name. {stageLabel(stage)} is recorded on the move that parks it, which
          is the rung a reopen brings it back to — the stage column itself is taken by On hold, so
          nothing else remembers where it stopped.
        </p>

        <div className="mb-1 text-[13px] font-medium text-ink">Why is it stopping · required</div>
        <div className="flex flex-col gap-0.5">
          {holdReasons.map((r) => (
            <label
              key={r.code}
              className="flex cursor-pointer items-center gap-2 rounded-[4px] px-1.5 py-1 text-[13px] text-body hover:bg-canvas"
            >
              <input
                type="radio"
                name="hold-reason"
                value={r.code}
                checked={reasonCode === r.code}
                onChange={() => setReasonCode(r.code)}
              />
              {r.label}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted">
          A code rather than a sentence, so &ldquo;how many genuine opportunities did we park for a
          plant shutdown this quarter&rdquo; is a question somebody can ask rather than a grep over
          free text.
        </p>

        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            {remarksRequired ? "What it actually is · required" : "In their own words (optional)"}
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Plant shut for the monsoon rebuild; works manager back in October"
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
          <span className="mt-1 block text-[12px] text-muted">
            {remarksRequired
              ? "“Other” on its own answers nothing — it is the one row in the count that nobody can act on and nobody can fold back into one of the five above. Say what it is."
              : "The code says which; this says what actually happened. It is what somebody picking the lead up on the day it comes back reads, and no list of six says “their buyer is on maternity leave”."}
          </span>
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            The day it comes back · required
          </span>
          <input
            type="date"
            value={resumeDate}
            min={day}
            onChange={(e) => setResumeDate(e.target.value)}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
          <span className="mt-1 block text-[12px] text-muted">
            A date rather than a sentence, because a date is a thing a worklist can be built from.
            Parked leads appear on Next actions → On hold from this day.
          </span>
        </label>

        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 text-[13px] font-medium text-ink">And what happens then</div>
          <p className="mt-0 mb-2 text-[12px] text-pretty text-muted">
            §24 — an active lead may not sit with nothing owed by anybody, and a parked one is still
            active. A date with nothing scheduled against it is a lead that comes back to nobody.
          </p>

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">What is being done</span>
            <input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="Ring the works manager and re-open the trial"
              className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
            />
          </label>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">On which day</span>
              <input
                type="date"
                value={effectiveActionDate}
                onChange={(e) => setActionDate(e.target.value)}
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
              <span className="mt-1 block text-[12px] text-muted">
                Follows the day it comes back unless you change it.
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">By whom</span>
              <select
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="h-[38px] w-full rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
              >
                <option value="">Nobody yet</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy || missing.length > 0} onClick={() => void submit()}>
            {busy ? "Saving…" : "Put it on hold"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
