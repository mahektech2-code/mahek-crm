"use client";

import * as React from "react";
import { Modal } from "@/components/ui/overlays";
import { Button, Field, Input, MoneyInput, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { createPayoutAction } from "@/lib/actions/vendor-payouts";
import { dueDateFor, moveRefusal, plannedPayOn, WEEKDAY_SHORT, weekdayOf } from "@/lib/engines/vendor-payouts";
import { money, parseRupees, shortDate } from "@/lib/format";
import type { PayoutPo, PayoutSupplier } from "@/lib/services/vendor-payout-service";
import { blankInvoice, draftIsEmpty, draftToInput, InvoiceFields, type InvoiceDraft } from "./payout-parts";

/* ---------------------------------------------------------------------------
 * Adding a payout by hand — anything owed that the purchase register does not
 * carry: an advance against a proforma, a transporter, a service bill. The
 * due date follows the supplier's credit days and the payment day follows the
 * due date, until somebody types either; both can always be typed.
 * ------------------------------------------------------------------------- */

const OTHER = "__other__";

export function AddPayoutModal({
  suppliers,
  pos,
  today,
  days,
  defaultCreditDays,
  onClose,
  onCreated,
}: {
  suppliers: PayoutSupplier[];
  pos: PayoutPo[];
  today: string;
  days: Set<number>;
  defaultCreditDays: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { run } = useToast();
  const [supplierId, setSupplierId] = React.useState("");
  const [payee, setPayee] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [billDate, setBillDate] = React.useState(today);
  const [dueInput, setDueInput] = React.useState<string | null>(null);
  const [payOnInput, setPayOnInput] = React.useState<string | null>(null);
  const [poId, setPoId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [invoices, setInvoices] = React.useState<InvoiceDraft[]>([blankInvoice(1)]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
  // Derived until typed: the supplier's credit from the bill date, and the
  // first payment day on or after that.
  const computedDue = dueDateFor(billDate || today, supplier?.creditDays ?? null, defaultCreditDays);
  const due = dueInput ?? computedDue;
  const computedPayOn = plannedPayOn(due, today, days);
  const payOn = payOnInput ?? computedPayOn;
  const payOnWhy = payOnInput ? moveRefusal(payOnInput, today, days, "open") : null;
  const supplierPos = pos.filter((p) => !supplierId || supplierId === OTHER || p.supplierId === supplierId);
  const uploading = invoices.some((d) => d.file?.uploading);

  async function submit() {
    const amountPaise = parseRupees(amount);
    const local: Record<string, string> = {};
    if (!supplierId) local.supplierId = "Pick the supplier, or someone not in the list.";
    if (supplierId === OTHER && !payee.trim()) local.payeeName = "Say who is being paid.";
    if (!description.trim()) local.description = "Say what the payment is for.";
    if (!amountPaise) local.amountPaise = "Enter the amount to pay.";
    if (payOnWhy) local.payOn = payOnWhy;
    setErrors(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    const res = await run(
      createPayoutAction({
        supplierId: supplierId === OTHER ? null : supplierId,
        payeeName: supplierId === OTHER ? payee.trim() : null,
        description: description.trim(),
        reference: reference.trim() || null,
        amountPaise: amountPaise ?? 0,
        billDate: billDate || null,
        dueDate: due,
        payOn: payOnInput,
        poId: poId || null,
        notes: notes.trim() || null,
        invoices: invoices.filter((d) => !draftIsEmpty(d)).map(draftToInput),
      }),
    );
    setBusy(false);
    if (res.ok) onCreated();
    else if (!res.ok && res.fieldErrors?.length) {
      setErrors(Object.fromEntries(res.fieldErrors.map((f) => [f.field, f.message])));
    }
  }

  const invoiceError = Object.entries(errors).find(([k]) => k.startsWith("invoices."));

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title="Add payable"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-muted">
            {parseRupees(amount) ? (
              <>
                {money(parseRupees(amount))} on <b className="text-ink">{WEEKDAY_SHORT[weekdayOf(payOn) - 1]} {shortDate(payOn)}</b>
              </>
            ) : null}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || uploading} onClick={() => void submit()}>
            {uploading ? "Uploading…" : "Add payable"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Vendor" error={errors.supplierId}>
          <Select
            value={supplierId}
            onChange={(e) => {
              setSupplierId(e.target.value);
              setPoId("");
            }}
          >
            <option value="">Pick a supplier…</option>
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
            <Input autoFocus value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Shree Ganesh Transport" />
          </Field>
        ) : (
          <Field label="Purchase order" error={errors.poId}>
            <Select value={poId} onChange={(e) => setPoId(e.target.value)}>
              <option value="">No PO</option>
              {supplierPos.map((p) => (
                <option key={p.id} value={p.id}>
                  PO {p.poNumber} · {shortDate(p.poDate)} · {money(p.valuePaise)} · {p.status}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Description" error={errors.description} className="col-span-2">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Advance against proforma, freight, AMC" />
        </Field>
        <Field label="Amount" error={errors.amountPaise}>
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!errors.amountPaise} />
        </Field>
        <Field label="Invoice / ref. no.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
        </Field>
        <Field label="Invoice date">
          <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        </Field>
        <Field
          label="Due date"
          hint={
            dueInput
              ? undefined
              : `${supplier?.creditDays ?? defaultCreditDays}-day terms`
          }
        >
          <Input type="date" value={due} onChange={(e) => setDueInput(e.target.value || null)} />
        </Field>
        <Field
          label="Payment date"
          error={errors.payOn ?? payOnWhy}
          hint={payOnInput ? undefined : "Next payment run"}
        >
          <Input type="date" value={payOn} min={today} onChange={(e) => setPayOnInput(e.target.value || null)} />
        </Field>
        <Field label="Note">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </Field>
      </div>

      <div className="mt-5 mb-2 flex items-center justify-between">
        <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Invoices</span>
        <Button
          size="sm"
          onClick={() =>
            setInvoices((list) => [...list, blankInvoice(Math.max(0, ...list.map((d) => d.key)) + 1, list.length ? "Tax invoice" : undefined)])
          }
        >
          + Add invoice
        </Button>
      </div>
      {invoiceError ? <p className="mb-2 text-[13px] text-danger">{invoiceError[1]}</p> : null}
      <div className="space-y-2.5">
        {invoices.map((d) => (
          <InvoiceFields
            key={d.key}
            draft={d}
            onChange={(next) => setInvoices((list) => list.map((x) => (x.key === next.key ? next : x)))}
            onRemove={invoices.length > 1 ? () => setInvoices((list) => list.filter((x) => x.key !== d.key)) : undefined}
          />
        ))}
      </div>
    </Modal>
  );
}
