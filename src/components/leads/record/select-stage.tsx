"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/console/parts";
import { useToast } from "@/components/ui/toast";
import { advanceLeadStage, selectLeadStage } from "@/lib/actions/leads";
import { REASON_CODE_NEEDING_REMARKS, stageLabel, type LeadStage } from "@/lib/lead-labels";
import { skippedSentence, type StageSelection } from "@/lib/engines/lead-stage-select";
import { Card } from "./record-chrome";

/**
 * THE SALES MANAGER'S CHOICE OF WHAT HAPPENS NEXT, from Qualification.
 *
 * Drawn only for the lead's designated Qualification reviewer — the same
 * authority the review's verdict asks, checked again by the action (a hidden
 * card is not a permission) and only at Qualification. NOTHING
 * MOVES UNLESS THEY ASK: "Stay in Qualification" is the standing answer, and
 * the button is not live until they pick something else.
 *
 * What is open, what is not and why all arrive from the server, computed by the
 * SAME `stageSelection` the action enforces — this file decides nothing. Where
 * the Qualification is not yet complete and verified the whole choice is shown
 * as unavailable with what is missing, rather than hidden, so nobody wonders
 * where it is. Later stages that need a real order, delivery or payment say so.
 */
export function SelectStage({
  customerId,
  leadName,
  selection,
  reasons,
}: {
  customerId: string;
  leadName: string;
  selection: StageSelection;
  /** `leads.stageSkipReasons`, read on the server. */
  reasons: { code: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pick, setPick] = React.useState<LeadStage | "stay">("stay");
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!selection.applies) return null;

  const open = selection.entryMissing.length === 0;
  const choice = selection.choices.find((c) => c.to === pick);
  const isSkip = Boolean(choice && choice.skips.length > 0);
  const needsNote = reason === REASON_CODE_NEEDING_REMARKS;
  const ready =
    pick !== "stay" &&
    Boolean(choice?.available) &&
    (!isSkip || (Boolean(reason) && (!needsNote || Boolean(note.trim()))));

  async function go() {
    if (!choice || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = isSkip
        ? await selectLeadStage({ customerId, to: choice.to, reasonCode: reason, note: note.trim() || undefined })
        : await advanceLeadStage({ customerId, to: choice.to });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push(r.message ?? `${leadName} moved to ${stageLabel(choice.to)}.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Choose the next stage" label="Choose the next stage">
      <p className="mt-0 mb-3 text-[13px] text-pretty text-muted">
        Once the Qualification is verified you decide where this lead goes. Leaving it here is a choice too — nothing moves
        until you press the button.
      </p>

      {!open ? (
        <div className="rounded-[6px] border border-line bg-canvas px-3 py-2 text-[13px] text-body">
          <b>Not available yet.</b> The Qualification has to be complete and verified first:
          <ul className="mt-1 mb-0 list-disc pl-5">
            {selection.entryMissing.map((c) => (
              <li key={c.id}>{c.says}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <div role="radiogroup" aria-label="Next stage" className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-start gap-2 rounded-[6px] border border-line px-3 py-2 text-[13px]">
              <input
                type="radio"
                name="next-stage"
                checked={pick === "stay"}
                onChange={() => setPick("stay")}
                className="mt-0.5"
              />
              <span>
                <b className="text-ink">Stay in Qualification</b>
                <span className="block text-muted">Decide later. Nothing changes.</span>
              </span>
            </label>
            {selection.choices.map((c) => (
              <label
                key={c.to}
                title={c.available ? undefined : c.reasons.join(" · ")}
                className={`flex items-start gap-2 rounded-[6px] border border-line px-3 py-2 text-[13px] ${
                  c.available ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                }`}
              >
                <input
                  type="radio"
                  name="next-stage"
                  disabled={!c.available}
                  checked={pick === c.to}
                  onChange={() => setPick(c.to)}
                  className="mt-0.5"
                />
                <span>
                  <b className="text-ink">{stageLabel(c.to)}</b>
                  {c.skips.length ? (
                    <span className="block text-muted">Skips {skippedSentence(c.skips)}.</span>
                  ) : (
                    <span className="block text-muted">The ordinary next step.</span>
                  )}
                  {!c.available ? (
                    <span className="block text-warn-ink">Unavailable: {c.reasons.join("; ")}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>

          {isSkip && choice ? (
            <div className="mt-3 flex flex-col gap-2">
              <label className="text-[12px] font-medium text-ink">
                Why is {skippedSentence(choice.skips)} not needed?
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="mt-1 block h-9 w-full rounded-[6px] border border-line bg-surface px-2 text-[13px] text-ink"
                >
                  <option value="">Pick a reason…</option>
                  {reasons.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] font-medium text-ink">
                {needsNote ? "Say what it actually is (required)" : "Note (optional)"}
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="mt-1 block w-full rounded-[6px] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
              </label>
            </div>
          ) : null}

          {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
          <div className="mt-3">
            <Button tone="primary" disabled={!ready || busy} onClick={() => void go()}>
              {busy ? "Moving…" : pick === "stay" ? "Moves nothing — pick a stage" : `Move to ${stageLabel(pick)}`}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
