"use client";

/* ---------------------------------------------------------------------------
 * A DISCOUNT THE LIST ITSELF OFFERS — "3% off for advance payment".
 *
 * These are printed under the prices and are part of the sheet rather than
 * something a telecaller gives away: they are conditions everybody gets on
 * meeting them. What a person may knock off a quoted price on their own
 * authority is a different question entirely, asked by `discountAuthority`.
 *
 * The sentence is composed by `discountTermSentence` rather than typed, so the
 * screen, the printed sheet and the handset all say it the same way — and the
 * modal shows it live, because a percentage in basis points and a threshold in
 * litres are two numbers that only mean something once they are a sentence.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Field, Input, MoneyInput, Select } from "@/components/ui/primitives";
import { PRICE_DISCOUNT_KINDS, type PriceDiscountKind } from "@/db/schema";
import type { DiscountTermView } from "@/lib/price-list-views";
import { DISCOUNT_KIND_LABEL, discountTermSentence } from "@/lib/price-list-labels";
import { setDiscountTerm } from "@/lib/actions/price-lists";
import { parseRupees, rupeesFromPaise } from "@/lib/format";

export function DiscountTermModal(props: {
  open: boolean;
  onClose: () => void;
  priceListId: string;
  term: DiscountTermView | null;
}) {
  if (!props.open) return null;
  return <DiscountBody key={props.term?.id ?? "new"} {...props} />;
}

function DiscountBody({
  onClose,
  priceListId,
  term,
}: {
  onClose: () => void;
  priceListId: string;
  term: DiscountTermView | null;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const [kind, setKind] = React.useState<PriceDiscountKind>(term?.kind ?? "advance_payment");
  const [percent, setPercent] = React.useState(term ? String(term.percentBp / 100) : "");
  const [litres, setLitres] = React.useState(term?.thresholdLitres != null ? String(term.thresholdLitres) : "");
  const [amount, setAmount] = React.useState(
    term?.thresholdPaise != null ? rupeesFromPaise(term.thresholdPaise) : "",
  );

  const percentBp = Math.round(Number(percent || "0") * 100);
  const sentence =
    percentBp > 0
      ? discountTermSentence({
          kind,
          percentBp,
          thresholdLitres: litres.trim() ? Number(litres) : null,
          thresholdPaise: amount.trim() ? parseRupees(amount) : null,
        })
      : null;

  async function save() {
    const next: Record<string, string> = {};
    if (!Number.isInteger(percentBp) || percentBp <= 0) next.percentBp = "A discount is a percentage above zero.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      const r = await run(
        setDiscountTerm({
          id: term?.id,
          priceListId,
          kind,
          percentBp,
          thresholdLitres: kind === "quantity" && litres.trim() ? Number(litres) : null,
          thresholdPaise: kind === "quantity" && amount.trim() ? parseRupees(amount) : null,
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
      width={520}
      title={term ? "Edit this discount" : "Add a discount"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save} title={busy ? "Saving…" : undefined}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="For" error={errors.kind ?? null}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as PriceDiscountKind)}>
            {PRICE_DISCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {DISCOUNT_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Percent off" error={errors.percentBp ?? null}>
          <Input value={percent} inputMode="decimal" onChange={(e) => setPercent(e.target.value)} placeholder="3" />
        </Field>

        {kind === "quantity" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From (litres)" error={errors.thresholdLitres ?? null} hint="Either this or an order value.">
              <Input value={litres} inputMode="numeric" onChange={(e) => setLitres(e.target.value)} placeholder="1000" />
            </Field>
            <Field label="Or from (order value)" error={errors.thresholdPaise ?? null}>
              <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
        ) : null}

        {sentence ? (
          <p className="rounded-[4px] bg-canvas px-3 py-2 text-[13px] text-body">
            It will read: {sentence}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
