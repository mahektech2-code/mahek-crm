"use client";

import { Modal } from "@/components/ui/modal";
import { Badge, Button } from "@/components/ui/primitives";
import type { NextStep } from "@/lib/engines/next-step";

/* ---------------------------------------------------------------------------
 * "Saved — and here is what happens next."
 *
 * Shown once, when a call is logged. It answers the question a telecaller asks
 * the moment they put the phone down and which no screen answered before: when
 * do I speak to this customer again, and why then.
 *
 * Enter is Next customer, so on an ordinary day this costs a keystroke the
 * telecaller was going to press anyway. Where there IS no next call — nobody
 * can reach them, or they are marked do not contact — nothing is focused and
 * the dialog stops rather than waves through. Those are the two cases worth
 * interrupting sixty calls a day for.
 * ------------------------------------------------------------------------- */

const TONE = {
  booked: { tone: "brand" as const, word: "You owe them this call" },
  scheduled: { tone: "neutral" as const, word: "Planned" },
  decide: { tone: "warn" as const, word: "Needs a decision" },
  none: { tone: "muted" as const, word: "Nothing scheduled" },
};

export function NextStepDialog({
  open,
  savedLabel,
  step,
  customerName,
  defaultNext,
  onNext,
  onStay,
}: {
  open: boolean;
  /** What was just logged, in the words the outcome list uses. */
  savedLabel: string;
  /** Null where it could not be worked out — said plainly, never guessed. */
  step: NextStep | null;
  customerName: string;
  /** True where the telecaller pressed "Save & next" and meant it. */
  defaultNext: boolean;
  /** Null on screens with no queue to advance through. */
  onNext: (() => void) | null;
  onStay: () => void;
}) {
  const stops = step ? step.kind === "decide" || step.kind === "none" : false;
  const tone = step ? TONE[step.kind] : null;

  return (
    <Modal
      open={open}
      onClose={onStay}
      width={520}
      title={
        <span className="flex items-center gap-2.5">
          <span className="text-success">✓</span>
          <span>{savedLabel} — saved</span>
        </span>
      }
      footer={
        <>
          {/* Not the customer's first word: "Stay on JOG" for JOG ENTERPRISES
              reads as a different company. */}
          <Button variant="secondary" onClick={onStay}>
            Stay on this customer
          </Button>
          {onNext ? (
            <Button
              variant="primary"
              onClick={onNext}
              // Focused only where the telecaller asked to move on AND the
              // answer is routine. A customer nobody can reach is not a screen
              // to press Enter through.
              autoFocus={defaultNext && !stops}
            >
              Next customer
            </Button>
          ) : null}
        </>
      }
    >
      {step && tone ? (
        <div className="flex flex-col gap-3">
          <div>
            <Badge tone={tone.tone}>{tone.word}</Badge>
          </div>

          <p className="text-lg leading-snug font-semibold text-ink">
            {step.headline}
          </p>

          <p className="text-sm leading-relaxed text-body">{step.detail}</p>

          {/*
           * "Not today" and "on the 20th" are two different facts, and a
           * telecaller asks both. Shown underneath rather than folded into the
           * sentence above, which would make a date read as its own cause.
           */}
          {step.heldToday ? (
            <p className="border-t border-divider pt-3 text-sm text-muted">
              Not on today&rsquo;s list: {step.heldToday.toLowerCase()}.
            </p>
          ) : null}

          {/*
           * A predicted date is labelled as one. A telecaller who reads this
           * out as a commitment has made a promise the rules never made.
           */}
          {step.kind === "scheduled" ? (
            <p className="text-xs text-muted">
              This is when the system will put them back on your list. It moves
              if they order, pay, or ask for a callback before then.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-body">
          The call is saved. We could not work out what happens next with{" "}
          {customerName} just now — check their record, or their calling queue
          in the morning.
        </p>
      )}
    </Modal>
  );
}
