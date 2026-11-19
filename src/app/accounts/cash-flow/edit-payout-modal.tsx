"use client";

import * as React from "react";
import { Modal } from "@/components/ui/overlays";
import { Button, Field, Input, MoneyInput, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { editPayoutAction } from "@/lib/actions/vendor-payouts";
import { money, parseRupees, rupeesFromPaise } from "@/lib/format";
import type { PayoutSupplier, PayoutView } from "@/lib/services/vendor-payout-service";

/* ---------------------------------------------------------------------------
 * Correcting a manual payable while it is still to pay: who it is to, what it
 * is for, its reference and the amount. Dates are not here — the payment day
 * moves on the calendar, as it always has. A purchase payable never opens
 * this: its vendor and amount are the register's, and the sync writes them.
 * Mount it with a `key` per payout so it starts from what is stored.
 * ------------------------------------------------------------------------- */

const OTHER = "__other__";

export function EditPayoutModal({
  payout,
  suppliers,
  onClose,
  onSaved,
}: {
  payout: PayoutView;
  suppliers: PayoutSupplier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run } = useToast();
  const known = payout.supplierId && suppliers.some((s) => s.id === payout.supplierId);
  const [supplierId, setSupplierId] = React.useState(known ? payout.supplierId! : OTHER);
  const [payee, setPayee] = React.useState(known ? "" : payout.payeeName);
  const [description, setDescription] = React.useState(payout.description ?? "");
  const [amount, setAmount] = React.useState(rupeesFromPaise(payout.amountPaise));
  const [reference, setReference] = React.useState(payout.reference ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const amountPaise = parseRupees(amount);
  const dropsPo = payout.poNumber != null && supplierId !== payout.supplierId;

  async function submit() {
    const local: Record<string, string> = {};
    if (supplierId === OTHER && !payee.trim()) local.payeeName = "Say who is being paid.";
    if (!description.trim()) local.description = "Say what the payment is for.";
    if (!amountPaise) local.amountPaise = "Enter the amount to pay.";
    setErrors(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      const res = await run(
        editPayoutAction(payout.id, {
          supplierId: supplierId === OTHER ? null : supplierId,
          payeeName: supplierId === OTHER ? payee.trim() : null,
          description: description.trim(),
          reference: reference.trim() || null,
          amountPaise: amountPaise ?? 0,
        }),
      );
      if (res.ok) onSaved();
      else if (res.fieldErrors?.length) setErrors(Object.fromEntries(res.fieldErrors.map((f) => [f.field, f.message])));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={`Edit the payable to ${payout.payeeName}`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-muted">
            {amountPaise && amountPaise !== payout.amountPaise ? `${money(payout.amountPaise)} → ${money(amountPaise)}` : null}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Vendor" error={errors.supplierId}>
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={OTHER}>Other payee…</option>
          </Select>
        </Field>
        {supplierId === OTHER ? (
          <Field label="Payee name" error={errors.payeeName}>
            <Input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Shree Ganesh Transport" />
          </Field>
        ) : (
          <div />
        )}
        <Field label="Description" error={errors.description} className="col-span-2">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Amount" error={errors.amountPaise}>
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!errors.amountPaise} />
        </Field>
        <Field label="Invoice / ref. no.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
        </Field>
      </div>
      {dropsPo ? (
        <p className="mt-3 rounded-[4px] bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
          PO {payout.poNumber} is to the old vendor, so it comes off this payable.
        </p>
      ) : null}
    </Modal>
  );
}
