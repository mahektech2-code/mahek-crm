"use client";

import * as React from "react";
import { Modal } from "./modal";
import { Button, Field, Textarea } from "./primitives";
import { ImpactDialog } from "./impact-dialog";
import type { ImpactConfirmation } from "@/lib/impact/types";
import type { Ok, Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * A REASONED CANCEL, AS ONE FLOW: the reason first, then what it affects.
 *
 * Declining an order, cancelling a TO or a special price, reversing a payment
 * — each needs a sentence somebody downstream repeats to a customer, AND each
 * reaches further than the row it was pressed on. They used to be a plain
 * reason box that wrote at once, or a ConfirmDialog that then opened an
 * ImpactDialog as a second, separately managed modal. This is one component
 * holding both steps: the reason is kept while the impact list is read, Back
 * returns to it with the words still there, and only the impact modal's typed
 * confirmation sends the act — with the reason and the fingerprint together.
 *
 * Mount it with a `key` per record, like every modal here.
 * ------------------------------------------------------------------------- */

export function ReasonImpactDialog({
  kind,
  id,
  title,
  body,
  reasonLabel = "Reason",
  reasonHint,
  confirmLabel,
  initialReason = "",
  onClose,
  onConfirm,
  onDone,
}: {
  /** The impact source's kind — what the act passes to `confirmImpact`. */
  kind: string;
  id: string;
  title: string;
  /** What happens, said before the reason is asked for. */
  body?: React.ReactNode;
  reasonLabel?: string;
  reasonHint?: string;
  /** The final button's words ("Decline", "Cancel the TO"). */
  confirmLabel: string;
  /** Where the reason was already typed elsewhere (a drawer's own box), the impact step opens first. */
  initialReason?: string;
  onClose: () => void;
  /** The act, with the reason and the confirmation the impact modal built. */
  onConfirm: (reason: string, confirmation: ImpactConfirmation) => Promise<Result<unknown>>;
  /** After the act succeeded and both steps have closed. */
  onDone?: (result: Ok<unknown>) => void;
}) {
  const [reason, setReason] = React.useState(initialReason);
  const [error, setError] = React.useState<string | null>(null);
  /* Which step: the reason box, or the impact modal keyed per opening so it loads afresh. */
  const [impactKey, setImpactKey] = React.useState<number | null>(initialReason.trim() ? 1 : null);
  const done = React.useRef<Ok<unknown> | null>(null);

  function next() {
    if (!reason.trim()) {
      setError("A reason is required — the person who has to explain this reads it.");
      return;
    }
    setImpactKey((k) => (k ?? 0) + 1);
  }

  if (impactKey !== null) {
    return (
      <ImpactDialog
        key={impactKey}
        kind={kind}
        id={id}
        confirmLabel={confirmLabel}
        onClose={() => {
          /* The impact modal closes on success and on Cancel alike: a success
             closes the whole flow, a Cancel goes back to the reason. */
          if (done.current) {
            const r = done.current;
            onClose();
            onDone?.(r);
          } else if (initialReason.trim()) {
            onClose();
          } else {
            setImpactKey(null);
          }
        }}
        onConfirm={async (confirmation) => {
          const r = await onConfirm(reason.trim(), confirmation);
          if (r.ok) done.current = r;
          return r;
        }}
      />
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" onClick={next} disabled={!reason.trim()} title={reason.trim() ? undefined : "Say why first"}>
            Next: what this affects
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {body ? <div className="text-sm text-body">{body}</div> : null}
        <Field label={reasonLabel} hint={reasonHint} required error={error ?? undefined}>
          <Textarea
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}
