"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import {
  offeredSalesTypes,
  salesTypeLabel,
  stageLabel,
  type LeadSalesType,
  type LeadStage,
} from "@/lib/lead-labels";
import { ladderFor, rungOf } from "@/lib/engines/lead-ladder";
import { setLeadSalesType } from "@/lib/actions/leads";

/**
 * §2 — WHICH OF THE THREE WAYS WE ARE SELLING TO THIS ACCOUNT, and the door
 * `setLeadSalesType` never had.
 *
 * The action shipped finished: schema, capability, the retired-ladder refusal,
 * the manager-and-a-reason gate above `prospect`, an audit row with the before
 * state on it. Nothing anywhere imported it. Its own header says the point of
 * leaving the STAGE alone is that "the record has a button and a sentence
 * rather than no button and no explanation" — and there was no button, so a
 * lead captured without a sales type sat on the legacy six-rung ladder for
 * ever. That ladder has no `prospect`, no qualification checklist and no sample
 * rung, which means none of §28's gates applied to it and none of the funnel's
 * work could be done on it: the lead was not stuck, it was outside the system.
 * A function with no caller is legal TypeScript and clean lint, so nothing went
 * red and nobody in the building could do the thing.
 *
 * **ONLY NON-RETIRED LADDERS ARE DRAWN, and the list comes from
 * `offeredSalesTypes()` rather than from a literal.** Mahek retired the
 * distributor ladder for new leads — nobody in the building can give the
 * approval it ends at — so the picker offers Direct and Third-party. The action
 * refuses a retired type itself and says so in words; this is the mirror of
 * that rule and not a second copy of it, because the one place the list lives
 * is `lib/lead-labels.ts` and the line that reverses the decision is in there
 * too. A picker built from three hardcoded chips would go on offering
 * Distributor the day after the retirement, and the refusal would read as the
 * app being broken.
 *
 * **ABOVE `prospect` IT ASKS FOR THE REASON THE ACTION IS ABOUT TO DEMAND.**
 * The condition is computed here with `rungOf` and `ladderFor` — the SAME two
 * engine functions the action runs — so the form cannot ask for a note on a
 * lead the server would have taken without one, nor take one silently where the
 * server is about to refuse. Being refused after typing loses the sentence
 * somebody had in mind, which is the whole reason it is asked first.
 *
 * **Without `lead.override` the control is DRAWN AND DISABLED with the reason
 * on the hover**, this product's rule for a control somebody might reasonably
 * expect to hold. The salesman reading a lead that has climbed three rungs on
 * the wrong ladder is exactly who needs to see that the correction exists and
 * is his manager's — a control that simply is not there reads as a screen with
 * nothing to say about it.
 *
 * **THE STAGE IS LEFT ALONE, and the modal says so before the button rather
 * than after.** `nextStage` answers the FOOT of the new ladder for a lead
 * standing on a rung that is not on it, which is exactly what this state needs;
 * the record therefore keeps a button and gains a sentence. A screen implying
 * the lead had been moved back to Suspect would be describing something that
 * did not happen, on the one screen somebody opens to find out what did.
 *
 * **NOT DRAWN ON A DISTRIBUTOR LEAD.** That path is
 * `migrateProspectiveDistributor` and the control beside this one: it moves the
 * lead off the retired ladder AND answers what happens to the rung it stopped
 * on, which this action deliberately does not. Two doors onto one correction is
 * how two of them come to disagree about the rung.
 */
export function SetSalesType({
  customerId,
  name,
  salesType,
  stage,
  canWork,
  canOverride,
}: {
  customerId: string;
  name: string;
  /** What it is today. Null is a lead raised before the funnel existed. */
  salesType: LeadSalesType | null;
  /** The rung it stands on, which is what decides whether a reason is wanted. */
  stage: LeadStage;
  /** `lead.work` — the capability the action asks for on every path. */
  canWork: boolean;
  /** `lead.override`, which is what `holdsOverride` reads above `prospect`. */
  canOverride: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<LeadSalesType | "">("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const offered = offeredSalesTypes();

  /*
   * The action's own condition, run on the action's own engine. A lead with no
   * type yet is never above `prospect` however high its legacy rung reads,
   * because there is nothing underneath it that changing the type could throw
   * away — and `LEGACY_LADDER` carries no `prospect` for an index to be
   * measured against in the first place.
   */
  const ladder = ladderFor(salesType);
  const aboveProspect = salesType != null && rungOf(stage, salesType) > ladder.indexOf("prospect");
  const needsReason = aboveProspect;
  const blocked = aboveProspect && !canOverride;

  const why = !canWork
    ? "Working a lead is not one of the hats you hold."
    : blocked
      ? `${name} is already at ${stageLabel(stage)}. Changing what kind of sale this is throws away the answers underneath it, so it is a manager's to do.`
      : null;

  function begin() {
    setChosen("");
    setReason("");
    setError(null);
    setOpen(true);
  }

  async function submit() {
    if (!chosen) {
      setError("Pick which way we are selling to this account.");
      return;
    }
    if (needsReason && !reason.trim()) {
      setError(
        "Say why the sales type is changing. A lead this far up its ladder has answers against it that will stop being the ones the gates read.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setLeadSalesType(customerId, chosen, reason.trim() || undefined);
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Sales type changed.");
    router.refresh();
  }

  return (
    <>
      <Button
        size="sm"
        tone="quiet"
        disabled={!canWork || blocked}
        title={why ?? "Which of the three ladders this lead climbs."}
        onClick={begin}
      >
        {salesType ? "Change it" : "Set the sales type"}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={salesType ? "Change the sales type" : "Set the sales type"}
        width={560}
      >
        <p className="mb-3 text-[13px] text-body">
          {name} · <span className="font-medium text-ink">{salesTypeLabel(salesType)}</span> today,
          standing at {stageLabel(stage)}.
        </p>
        <p className="mb-3 text-[13px] text-pretty text-body">
          This decides which ladder the lead climbs and which questions the rest of the funnel puts
          to it. <span className="font-medium text-ink">The rung is left exactly where it is</span>{" "}
          — a lead standing on a stage the new ladder does not carry is offered the foot of that
          ladder as its next move, so the record keeps a button and gains a sentence rather than
          being silently sent back to the start.
        </p>

        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 block text-[13px] font-medium text-ink">
            Which way are we selling to them
          </legend>
          <div className="flex flex-col gap-2">
            {offered.map((t) => (
              <label
                key={t.code}
                className="flex cursor-pointer items-start gap-2 rounded-[4px] border border-line px-2.5 py-2"
              >
                <input
                  type="radio"
                  name="lead-sales-type"
                  value={t.code}
                  checked={chosen === t.code}
                  disabled={t.code === salesType}
                  onChange={() => setChosen(t.code)}
                  className="mt-1"
                />
                <span className="block min-w-0">
                  <span className="block text-[13px] font-medium text-ink">
                    {t.label}
                    {t.code === salesType ? " — what it is already" : ""}
                  </span>
                  <span className="block text-[12px] text-pretty text-muted">{t.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {/* The retirement said out loud rather than left as an absence. A
              manager who remembers three chips and counts two needs to read
              why, or the missing one reads as a screen that has lost an
              option. */}
          <p className="mt-2 text-[12px] text-pretty text-muted">
            Distributor is not offered: Mahek does not appoint distributors through MahekOne, so a
            lead moved onto that ladder would stall behind an approval nobody in the building can
            give. The leads already on it are untouched and still advance.
          </p>
        </fieldset>

        {needsReason ? (
          <label className="mt-3 block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Why it is changing · required
            </span>
            <span className="mb-1 block text-[12px] text-pretty text-muted">
              {name} is past Prospect, so there are answers recorded against the ladder it is on
              that will stop being the ones the gates read. Whoever reads this lead in a month has
              only this sentence to tell them why the checklist underneath it went quiet.
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
            />
          </label>
        ) : null}

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || !chosen || (needsReason && !reason.trim())}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Save the sales type"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
