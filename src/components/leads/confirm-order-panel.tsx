"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, parseRupees, shortDate } from "@/lib/format";
import { commitmentSizeLabel } from "@/lib/lead-commitment";
import { confirmFirstOrder } from "@/lib/actions/leads";
import { Button } from "@/components/console/parts";

/**
 * §5.5's SECOND act, and the destination the ladder's loudest instruction
 * never had.
 *
 * `gateAction` tells a sales manager standing on a Negotiation lead with a
 * commitment on file and nothing placed against it to CONFIRM THE ACTUAL
 * ORDER, in danger tone, and sends him to the Commercial tab. The only form
 * there was the one that records the FORECAST — so the instruction landed on
 * the thing it supersedes, and pressing it again rewrote the promise instead
 * of closing it. This is the form it meant.
 *
 * **TWO ACTS, NEVER MERGED.** A commitment is what a customer said they would
 * do; this is what they did. Collapsing them would let one screen record a
 * sale nobody made, and it would destroy the one comparison the pair exists to
 * make — they promised 400 cans on the 12th and placed ₹2,10,000 on the 19th,
 * which is how anybody finds out what a forecast on this book is worth.
 *
 * **WHAT IT DOES AND WHAT IT DOES NOT, said before the button is pressed.**
 * It creates a real order, at `pending_approval`, which is what every other
 * order in MahekOne is created at: the customer has said yes and the business
 * has not. Accounts decide, as they decide every other order, and the RUNG
 * does not move today — §18's gate counts orders that count, and a pending one
 * counts nowhere. A manager who expected the ladder to advance and watched it
 * stand still would press the button again, so the card says it in words and
 * the action's own message says it again on the way out.
 *
 * **A VALUE AND A REFERENCE ARE WHAT MAKE IT AN ORDER.** The forecast beside
 * it accepts a day with no size, because a salesman genuinely may not have
 * been told one. Here the order exists: a confirmation with no value reads as
 * ₹0 on every figure it feeds, and one with no reference is money accounts
 * have to go looking for. Both are demanded here and again in the action,
 * because a server action is a URL and a required field is not a rule.
 */
export function ConfirmOrderPanel({
  customerId,
  expectedOrderDate,
  expectedOrderCans,
  expectedOrderValuePaise,
  pendingOrderCount,
  disabled,
  disabledReason,
}: {
  customerId: string;
  /** The commitment being superseded. All three are drawn, not just the day. */
  expectedOrderDate: string;
  expectedOrderCans: number | null;
  expectedOrderValuePaise: number | null;
  /**
   * Orders already with accounts, where the screen knows. `countingOrderCount`
   * cannot answer this — a pending order counts nowhere — so a card reading
   * only that would offer to take the same order a second time. Where a screen
   * does not know, the action refuses and says which order is already waiting:
   * the guard belongs on the server either way, and this only decides whether
   * somebody is refused before typing or after.
   */
  pendingOrderCount?: number;
  disabled: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState("");
  const [value, setValue] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [cans, setCans] = React.useState(expectedOrderCans ? String(expectedOrderCans) : "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const waiting = (pendingOrderCount ?? 0) > 0;
  const promised = commitmentSizeLabel(
    { expectedOrderDate, expectedOrderCans, expectedOrderValuePaise },
    money,
  );

  async function submit() {
    const paise = parseRupees(value);
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await confirmFirstOrder(customerId, {
        orderedOn: date,
        valuePaise: paise ?? 0,
        reference: reference.trim(),
        cans: parseCans(cans) ?? undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Recorded.");
    router.refresh();
  }

  return (
    <section className="rounded-[6px] border border-danger/40 bg-surface px-5 py-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium tracking-[0.04em] text-danger uppercase">
            Confirm the actual order
          </div>
          <p className="mt-1 max-w-[520px] text-[12px] text-pretty text-muted">
            They promised {promised} on {shortDate(expectedOrderDate)} and nothing has been
            placed against it. This records the order itself — a real value and their
            reference.
          </p>
        </div>
        <Button
          size="sm"
          tone="danger"
          disabled={disabled || waiting}
          title={
            waiting
              ? "An order on this account is already with accounts. It counts towards the rung the day they accept it."
              : disabled
                ? disabledReason
                : undefined
          }
          onClick={() => setOpen(true)}
        >
          Confirm the order
        </Button>
      </div>

      {/*
        WHAT IT DOES NOT DO, on the card rather than in the refusal afterwards.
        The instruction that sends somebody here is drawn in danger tone and
        reads like the end of the ladder; the rung does not move today, and a
        manager who learns that by watching nothing happen presses the button
        again.
      */}
      <p className="mt-2 max-w-[560px] text-[12px] text-pretty text-muted">
        {waiting
          ? "An order is already with accounts. There is nothing to confirm until they have decided — the rung follows the ledger, not this button."
          : "It goes to accounts like every other order, and the rung moves to First order the day they accept it. Nothing here approves anything."}
      </p>

      <Modal open={open} onClose={() => setOpen(false)} title="Confirm the actual order" width={620}>
        {/*
          §9's warning, with the real figures in it. "Supersedes the forecast"
          means nothing on its own; what somebody has to read before pressing
          this is the promise they are closing, in the numbers it was recorded
          in, so a confirmation against the wrong lead is caught here rather
          than by accounts.
        */}
        <div className="rounded-[4px] border border-warn bg-warn-soft px-3 py-2.5">
          <p className="m-0 text-[13px] text-pretty text-warn-ink">
            This supersedes the forecast on file — {promised} expected on{" "}
            {shortDate(expectedOrderDate)}. The forecast is kept as it stands: what was
            promised and what was placed are two different facts, and a record that keeps
            only the second cannot say what a promise on this book is worth.
          </p>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Day they placed it · required
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              Not always today — an order often reaches a desk after the call that
              produced it.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Order value, rupees · required
            </span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              What the order is worth. This is the figure that separates it from the
              forecast, and every screen it feeds reads it.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Their reference · required
            </span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={64}
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              Their confirmation number or PO, or the reference the office gave it.
              Accounts match against this.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Quantity (cans)
            </span>
            <input
              value={cans}
              onChange={(e) => setCans(e.target.value)}
              inputMode="numeric"
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              Carried forward from what they promised. Recorded with the confirmation and
              never priced — nothing in MahekOne can value a can yet.
            </span>
          </label>
        </div>

        {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            tone="danger"
            disabled={busy || !date || !reference.trim() || !parseRupees(value)}
            title={
              !date
                ? "The day they placed it."
                : !parseRupees(value)
                  ? "What the order is worth. A confirmation with no value is a forecast."
                  : !reference.trim()
                    ? "Their confirmation number, or the reference the office gave it."
                    : undefined
            }
            onClick={() => void submit()}
          >
            {busy ? "Recording…" : "Record the order"}
          </Button>
        </div>
      </Modal>
    </section>
  );
}

/**
 * Cans, as a whole number. The same reading `FirstOrderPanel` does, and for
 * the same reason: a can does not come in halves at this end of the funnel,
 * and "2.5" would be stored as two or three by whoever rounded it first.
 */
function parseCans(input: string): number | null {
  const cleaned = input.replace(/[^0-9]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}
