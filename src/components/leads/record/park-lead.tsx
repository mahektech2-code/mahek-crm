"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
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
 * button is pressed.** `lost` means nobody rings again, which is why its reason
 * is a CODE — "how many did we lose on credit terms this quarter" is a question
 * somebody asks of a closed book. A park is a live prospect stopped by
 * something outside the sale, and the useful thing about it is not which of
 * eight boxes it fits: it is the sentence that tells whoever picks it up in
 * March what they are walking back into. So the reason here is free text, which
 * is what the action's own schema asks for, and the coded lists are left where
 * they belong.
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
  /** The lead's own salesman, pre-selected where they are on the list. */
  defaultOwnerId: string | null;
  canWork: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
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

  const missing = [
    reason.trim() ? null : "why it is stopping",
    resumeDate ? null : "the day it comes back",
    action.trim() ? null : "what happens then",
    owner ? null : "who does it",
  ].filter(Boolean) as string[];

  async function submit() {
    if (missing.length) {
      setError(
        `On hold is a pause, not a quiet death. Still to answer: ${missing.join(", ")}. A lead parked without all four comes back to nobody.`,
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
        hold: { reason: reason.trim(), resumeDate },
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

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            Why is it stopping · required
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Plant shut for the monsoon rebuild; works manager back in October"
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
          <span className="mt-1 block text-[12px] text-muted">
            In words, not a code: this is what somebody picking the lead up in three months needs to
            know, and no list of eight boxes says &ldquo;their buyer is on maternity leave&rdquo;.
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
