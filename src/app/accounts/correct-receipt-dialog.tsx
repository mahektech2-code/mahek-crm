"use client";

import * as React from "react";
import { PaymentModeFields } from "@/components/crm/payment-mode-fields";
import { VoiceTextarea } from "@/components/ui/dictate";
import { Modal } from "@/components/ui/modal";
import { Button, Field, Input, MoneyInput } from "@/components/ui/primitives";
import { amendReceiptAction, correctReceiptAction } from "@/lib/actions/payments";
import { money, parseRupees, rupeesFromPaise, stamp } from "@/lib/format";
import type { Result } from "@/lib/result";
import type { PaymentDetail } from "./queue-types";

/* ---------------------------------------------------------------------------
 * CORRECT A CLAIM BEFORE IT IS DECIDED — the amount, the date, the mode, the
 * reference, the note.
 *
 * Without it a mistyped figure had to be rejected ("never arrived") and
 * recorded again. Nothing here counts yet: every money path keys on a
 * confirmed receipt, so this changes no balance. A new amount is spread again
 * over the bills the claim already named; the reason is kept with the change.
 * What may be corrected, and by whom, is `correctReceipt` on the server.
 * ------------------------------------------------------------------------- */

/** What the dialog reads of a claim — the Accounts queue detail carries it, and so does the CRM Ledger tab. */
export type CorrectableReceipt = Pick<
  PaymentDetail,
  "receivedAt" | "mode" | "reference" | "instrumentDate" | "note" | "reportedAt" | "correct"
>;

export function CorrectReceiptDialog({
  receiptId,
  detail,
  amount,
  customerName,
  run,
  onClose,
  onDone,
  counted = false,
}: {
  receiptId: string;
  detail: CorrectableReceipt;
  /**
   * The payment has already counted (Accounts' own entries are confirmed as
   * they are saved). Saving then reverses it and records the corrected one
   * in one step — `amendConfirmedReceipt` — so the statement shows both.
   */
  counted?: boolean;
  amount: number;
  customerName: string;
  run: <T extends { ok: boolean; message?: string; error?: string }>(p: Promise<T>) => Promise<T>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amountText, setAmountText] = React.useState(rupeesFromPaise(amount));
  const [receivedAt, setReceivedAt] = React.useState(detail.receivedAt);
  const [mode, setMode] = React.useState(detail.mode);
  const [reference, setReference] = React.useState(detail.reference ?? "");
  const [instrumentDate, setInstrumentDate] = React.useState(detail.instrumentDate ?? "");
  const [note, setNote] = React.useState(detail.note ?? "");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const paise = parseRupees(amountText) ?? 0;
  const changed =
    paise !== amount ||
    receivedAt !== detail.receivedAt ||
    mode !== detail.mode ||
    reference.trim() !== (detail.reference ?? "") ||
    instrumentDate !== (detail.instrumentDate ?? "") ||
    note.trim() !== (detail.note ?? "");
  const blocked = !changed
    ? "Nothing has changed yet."
    : paise <= 0
      ? "Enter the amount that arrived."
      : reason.trim().length < 5
        ? "Say what was wrong — it is kept with the change."
        : undefined;

  async function save() {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const r: Result = await run(
        (counted ? amendReceiptAction : correctReceiptAction)(
          receiptId,
          {
            amount: paise,
            receivedAt,
            mode,
            reference: reference.trim(),
            instrumentDate: instrumentDate.trim(),
            note: note.trim(),
          },
          reason,
        ),
      );
      if (r.ok) {
        onDone();
        return;
      }
      setError(r.error);
      setFieldErrors(Object.fromEntries((r.fieldErrors ?? []).map((f) => [f.field, f.message])));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={`${counted ? "Edit" : "Correct"} ${money(amount)} from ${customerName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={Boolean(blocked) || busy} title={blocked}>
            {busy ? "Saving…" : counted ? "Save the corrected payment" : "Save correction"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-pretty text-muted">
        {counted ? (
          <>
            Recorded {stamp(detail.reportedAt)} and already counted. Saving marks this entry reversed — with your reason — and
            records the corrected payment against the same bills, in one step; the balance is rebuilt and the statement shows both.
          </>
        ) : (
          <>
            Reported {stamp(detail.reportedAt)}. It has not counted yet, so no balance moves. A new amount is spread over the
            same bills it named; anything left over goes on account.
          </>
        )}
      </p>
      {error ? (
        <p role="alert" className="mb-3 rounded-control border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-ink">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Amount (₹)" error={fieldErrors.amount}>
          <MoneyInput value={amountText} onChange={(e) => setAmountText(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Received on" error={fieldErrors.receivedAt}>
          <Input type="date" value={receivedAt} max={detail.correct.today} onChange={(e) => setReceivedAt(e.target.value)} disabled={busy} />
        </Field>
        <PaymentModeFields
          modes={detail.correct.modes}
          datedModes={detail.correct.datedModes}
          today={detail.correct.today}
          mode={mode}
          onMode={setMode}
          reference={reference}
          onReference={setReference}
          instrumentDate={instrumentDate}
          onInstrumentDate={setInstrumentDate}
          error={fieldErrors.instrumentDate}
          referenceError={fieldErrors.reference}
        />
        <div className="sm:col-span-2">
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} maxLength={500} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="What was wrong" required error={fieldErrors.reason}>
            <VoiceTextarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onDictate={setReason}
              placeholder="Typed ₹45,000; the transfer is ₹4,500."
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
