"use client";

/* ---------------------------------------------------------------------------
 * ASKING FOR A SPECIAL PRICE — what the shop wants to pay, and why.
 *
 * The telecaller types the figure the customer said out loud, which is GST
 * INCLUSIVE: that is what a shopkeeper quotes and what the price list prints,
 * and asking them to do the division mid-call is asking for the wrong number.
 * The ex-GST figure the ledger stores is shown underneath as it is typed, so
 * the person can see what they are actually asking for, and the difference
 * from today's rate is said in percent beside it — a rate that reads fine in
 * rupees and is 22% off is the one somebody needs stopping at.
 *
 * The reason is required here and again in the action. Whoever decides this
 * is not on the call and has nothing else to weigh it on.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Callout,
  Field,
  MoneyInput,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, parseRupees } from "@/lib/format";
import { exFromIncl } from "@/lib/engines/price-math";
import { requestSpecialPrice } from "@/lib/actions/price-lists";
import type { RateRow } from "@/lib/price-list-views";

export function SpecialPriceModal({
  open,
  onClose,
  customerId,
  customerName,
  rates,
  gstBp,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string;
  /** The shop's OWN rates — there is nothing to ask a discount off otherwise. */
  rates: RateRow[];
  gstBp: number;
}) {
  if (!open) return null;
  return (
    <Body
      key={customerId}
      onClose={onClose}
      customerId={customerId}
      customerName={customerName}
      rates={rates}
      gstBp={gstBp}
    />
  );
}

function Body({
  onClose,
  customerId,
  customerName,
  rates,
  gstBp,
}: {
  onClose: () => void;
  customerId: string;
  customerName: string;
  rates: RateRow[];
  gstBp: number;
}) {
  const router = useRouter();
  const { run } = useToast();
  const offered = rates.filter((r) => r.offered);
  const [productId, setProductId] = React.useState(offered[0]?.productId ?? "");
  const [asked, setAsked] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const rate = offered.find((r) => r.productId === productId) ?? null;
  const askedIncl = parseRupees(asked);
  // The list's own GST, handed down by the caller rather than assumed here:
  // the action divides by the same figure, and two divisions by two rates
  // would put the ex-GST number on the screen a few rupees off the one stored.
  const askedEx = askedIncl != null && askedIncl > 0 ? exFromIncl(askedIncl, gstBp) : null;
  const delta =
    askedEx != null && rate && rate.rateExGstPaise > 0
      ? Math.round(((askedEx - rate.rateExGstPaise) / rate.rateExGstPaise) * 1000) / 10
      : null;

  async function save() {
    const next: Record<string, string> = {};
    if (!productId) next.productId = "Choose the product they are asking about.";
    if (askedIncl == null || askedIncl <= 0) {
      next.requestedRateInclGstPaise = "Type the price they are asking for.";
    }
    if (!reason.trim()) {
      next.reason = "Say why they should get a different price. Somebody has to weigh it.";
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      const r = await run(
        requestSpecialPrice({
          customerId,
          productId,
          requestedRateInclGstPaise: askedIncl!,
          reason: reason.trim(),
        }),
      );
      if (r.ok) {
        onClose();
        router.refresh();
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Ask for a special price — ${customerName}`}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !offered.length}
            title={!offered.length ? "There is no list to ask a different price against." : undefined}
            onClick={() => void save()}
          >
            {busy ? "Asking…" : "Ask"}
          </Button>
        </>
      }
    >
      {!offered.length ? (
        <Callout tone="warn">
          <span className="text-[13px] text-body">
            No price list resolves for this shop yet, so there is no rate to ask for a
            difference against. Put them on a list first — then a special price is a
            change to something, rather than a number with nothing behind it.
          </span>
        </Callout>
      ) : (
        <div className="space-y-4">
          <Field label="Product" error={errors.productId ?? null}>
            <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
              {offered.map((r) => (
                <option key={r.productId} value={r.productId}>
                  {r.productName}
                </option>
              ))}
            </Select>
          </Field>

          {rate ? (
            <div className="rounded-[4px] border border-line bg-canvas px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">They pay today</span>
                <span className="tabular-nums text-ink">
                  {money(rate.rateInclGstPaise)} incl GST
                  <span className="text-muted"> · {money(rate.rateExGstPaise)} ex</span>
                </span>
              </div>
            </div>
          ) : null}

          <Field
            label="The price they are asking for"
            hint="GST inclusive, per can — the figure the customer said."
            error={errors.requestedRateInclGstPaise ?? null}
          >
            <MoneyInput
              value={asked}
              invalid={!!errors.requestedRateInclGstPaise}
              onChange={(e) => setAsked(e.target.value)}
              placeholder="0"
            />
          </Field>

          {askedEx != null ? (
            <p className="text-[13px] text-muted">
              That is {money(askedEx)} ex-GST
              {delta == null ? null : (
                <>
                  {" — "}
                  <span className={delta < 0 ? "text-danger" : "text-success"}>
                    {delta > 0 ? "+" : ""}
                    {delta}%
                  </span>{" "}
                  against what they pay now
                </>
              )}
              .
            </p>
          ) : null}

          <Field
            label="Why"
            hint="What they said, and what is at stake. Whoever decides this was not on the call."
            error={errors.reason ?? null}
          >
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              invalid={!!errors.reason}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
