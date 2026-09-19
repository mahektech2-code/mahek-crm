"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import { advanceLeadStage } from "@/lib/actions/leads";
import { Button } from "@/components/console/parts";

type Coded = { code: string; label: string };

/**
 * CLOSING A LEAD, FROM WHEREVER IT HAD GOT TO — the PRD's §5.10.
 *
 * The engine has allowed this from every rung since §26 landed: `gateTo`
 * answers `open` for `lost` unconditionally and `evaluateLeadStageMove` demands
 * a code instead of a checklist. What did not exist was a door. The only
 * reason-coded way to close a lead was the Suspect decision — "Not a Prospect"
 * on the qualify queue — so a lead that had reached Negotiation and then went
 * quiet could be closed by nobody, and what people do with a lead they cannot
 * close is leave it on the board for ever. Every dashboard count, every funnel
 * and every "my leads" list then carries work that stopped months ago, which is
 * the one thing §3.5's exclusion of lost leads exists to prevent.
 *
 * **It is offered to any role, which is the PRD's own word.** A loss is not a
 * promotion: nothing about it needs a manager's judgement, and gating it behind
 * one buys a queue of leads waiting to be closed by somebody who was not on the
 * call. `lead.work` is what the action asks for, the same capability moving a
 * lead up a rung asks for, and it is asked there rather than here — a server
 * action is a URL and a hidden button is not a permission.
 *
 * **It is not offered where the answer would be false.** A lead already lost
 * has nothing to lose, and one that reached `customer`, `active_distributor` or
 * `won` has been won — marking those lost would not record a loss, it would
 * overwrite the record of a sale with one. The action would refuse a second
 * loss on `same_stage` anyway; the other three it would cheerfully accept,
 * which is exactly why the control is withheld rather than left to be refused.
 *
 * **The reason list comes from configuration, never from the literal.** The
 * server validates what arrives against `leads.lostReasons`, so a picker built
 * from `LOST_REASONS` would offer a code the action refuses on any deployment
 * where somebody has reworded the list — the refusal reading as the app being
 * broken rather than as the list having moved.
 */
export function MarkLost({
  customerId,
  name,
  stage,
  lostReasons,
  canWork,
}: {
  customerId: string;
  name: string;
  /** The rung it is standing on, for the sentence the modal opens with. */
  stage: LeadStage;
  /** `leads.lostReasons`, resolved on the server. Never the literal list. */
  lostReasons: Coded[];
  canWork: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  /*
   * §9's catalogue says the radio list defaults to Price, which is the head of
   * the configured list rather than a literal "price" — a deployment that has
   * reworded or reordered its reasons would otherwise open this modal with a
   * code selected that its own list no longer carries.
   */
  const firstReason = lostReasons[0]?.code ?? "";
  const [reasonCode, setReasonCode] = React.useState(firstReason);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin() {
    setReasonCode(firstReason);
    setNote("");
    setError(null);
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await advanceLeadStage({
        customerId,
        to: "lost",
        reasonCode,
        note: note.trim() || undefined,
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
    toast.push(result.message ?? `${name} is closed.`);
    router.refresh();
  }

  return (
    <>
      <Button
        tone="danger"
        size="sm"
        disabled={!canWork}
        title={
          canWork
            ? undefined
            : "Closing a lead is the salesman's and the manager's, the same hat that moves one up a rung."
        }
        onClick={begin}
      >
        Mark lost
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Close this lead" width={520}>
        <p className="mb-3 text-[13px] text-body">
          {name} is at {stageLabel(stage)}. Closing it takes the lead off every active count, funnel
          and queue — and takes nothing away: the record and its whole timeline stay exactly as they
          are, with a banner at the top of this page naming who closed it, when and why.
        </p>

        <div className="mb-1 text-[13px] font-medium text-ink">Why · required</div>
        <div className="flex flex-col gap-0.5">
          {lostReasons.map((r) => (
            <label
              key={r.code}
              className="flex cursor-pointer items-center gap-2 rounded-[4px] px-1.5 py-1 text-[13px] text-body hover:bg-canvas"
            >
              <input
                type="radio"
                name="lost-reason"
                value={r.code}
                checked={reasonCode === r.code}
                onChange={() => setReasonCode(r.code)}
              />
              {r.label}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted">
          A code rather than a sentence, so &ldquo;how many did we lose on credit terms this
          quarter&rdquo; is a question somebody can ask rather than a grep over free text.
        </p>

        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            Anything to add (optional)
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
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button tone="danger" disabled={busy || !reasonCode} onClick={() => void submit()}>
            {busy ? "Saving…" : "Mark it lost"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
