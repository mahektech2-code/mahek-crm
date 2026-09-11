"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { OVERRIDE_REASONS, stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { GateVerdict } from "@/lib/engines/lead-gates";
import { advanceLeadStage } from "@/lib/actions/leads";
import { Button } from "../../parts";

/**
 * Moving a lead up a rung from the office, and passing a shut gate.
 *
 * **Two buttons, not one with a mode.** Moving a lead whose conditions are met
 * and moving one whose conditions are not are different acts with different
 * consequences, and the second is recorded against the manager's name with what
 * they ignored. A single button that quietly became an override the moment the
 * gate was shut would make the two indistinguishable afterwards, which is the
 * one thing §28 asks the override to avoid.
 *
 * **The refusal is repeated, not summarised.** The override dialog prints every
 * missing condition rather than a count, because the person about to pass them
 * is the person who has to be able to say later why each one did not matter.
 *
 * The action checks `lead.work` and `lead.override` again on the server. The
 * disabled state here is a courtesy: a server action is a URL, and a hidden
 * button is not a permission.
 */
export function AdvanceStage({
  customerId,
  to,
  verdict,
  canWork,
  canOverride,
  overrideAllowed,
}: {
  customerId: string;
  /** Null at the top of the ladder — there is nowhere to go. */
  to: LeadStage | null;
  verdict: GateVerdict | undefined;
  canWork: boolean;
  canOverride: boolean;
  /** `leads.allowManagerOverride`. Off means nobody may, however senior. */
  overrideAllowed: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState<"move" | "override" | null>(null);
  const [note, setNote] = React.useState("");
  const [reasonCode, setReasonCode] = React.useState(OVERRIDE_REASONS[0]!.code);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const gateOpen = Boolean(verdict?.open);
  const missing = verdict?.missing ?? [];

  function begin(which: "move" | "override") {
    setOpen(which);
    setNote("");
    setReasonCode(OVERRIDE_REASONS[0]!.code);
    setError(null);
  }

  async function submit() {
    if (!to || !open) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await advanceLeadStage({
        customerId,
        to,
        note: note.trim() || undefined,
        override:
          open === "override" ? { reasonCode, note: note.trim() || undefined } : undefined,
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
    setOpen(null);
    toast.push(
      result.data?.promoted
        ? "Moved — and the account is on the book from here."
        : (result.message ?? `Moved to ${stageLabel(to)}.`),
    );
    router.refresh();
  }

  return (
    <>
      <Button
        tone="primary"
        size="sm"
        disabled={!canWork || !to || !gateOpen}
        title={
          !canWork
            ? "Moving a lead up its ladder is the salesman's and the manager's."
            : !to
              ? "There is no rung above this one."
              : !gateOpen
                ? `Not yet: ${missing.map((m) => m.says).join("; ")}`
                : undefined
        }
        onClick={() => begin("move")}
      >
        {to ? `Move to ${stageLabel(to)}` : "Top of the ladder"}
      </Button>

      <Button
        size="sm"
        disabled={!canOverride || !to || gateOpen}
        title={
          !overrideAllowed
            ? "Overrides are switched off in configuration (leads.allowManagerOverride)."
            : !canOverride
              ? "Passing a shut gate is a manager's alone, and what was missing is recorded against their name."
              : !to
                ? "There is no rung above this one."
                : gateOpen
                  ? "Nothing to override — the gate is open, so move it normally."
                  : undefined
        }
        onClick={() => begin("override")}
      >
        Override the gate
      </Button>

      <Modal
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open === "override" ? "Move it anyway" : `Move to ${to ? stageLabel(to) : ""}`}
        width={520}
      >
        {open === "override" ? (
          <>
            <div className="mb-3 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-3 py-2.5">
              <div className="text-[13px] font-semibold text-ink">
                {missing.length === 1
                  ? "One condition is not met"
                  : `${missing.length} conditions are not met`}
              </div>
              <ul className="mt-1 mb-0 list-none p-0">
                {missing.map((m) => (
                  <li key={m.id} className="text-[12px] text-body">
                    · {m.says}
                  </li>
                ))}
              </ul>
            </div>
            <p className="mb-3 text-[13px] text-body">
              This is allowed and it is recorded. What gets stored is which conditions were
              standing, so &ldquo;who let this through and what were they ignoring&rdquo; stays
              answerable — which is the whole reason an override exists rather than a locked door
              people work around by writing things down after the event.
            </p>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">Why · required</span>
              <select
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
              >
                {OVERRIDE_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <p className="mb-3 text-[13px] text-body">
            Every condition for {to ? stageLabel(to) : "this rung"} is met. The move is written to
            the stage history with your name and the hat that allowed it.
          </p>
        )}

        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            {open === "override" ? "Anything to add" : "Note (optional)"}
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
          <Button tone="quiet" onClick={() => setOpen(null)}>
            Cancel
          </Button>
          <Button
            tone={open === "override" ? "danger" : "primary"}
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : open === "override" ? "Move it anyway" : "Move it"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
