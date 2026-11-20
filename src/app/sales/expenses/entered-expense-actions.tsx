"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { Button, ReasonModal } from "@/components/console/parts";
import { deleteEnteredExpense, editEnteredExpense } from "@/lib/actions/sales";
import { cleanDecimal, parseRupees, rupeesFromPaise } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * EDIT AND DELETE, for an expense the office entered — by the person who
 * entered it, while nobody has decided it. Drawn only on those rows; the
 * actions check the same three things again (`editEnteredExpense`,
 * `deleteEnteredExpense`).
 * ------------------------------------------------------------------------- */

const KINDS = [
  { value: "travel", label: "Bus or train" },
  { value: "local_transport", label: "Local transport" },
  { value: "food", label: "Food" },
  { value: "lodging", label: "Hotel" },
  { value: "other", label: "Other" },
] as const;
type Kind = (typeof KINDS)[number]["value"];

const field =
  "w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand";

export type EnteredLine = {
  id: string;
  who: string;
  day: string;
  kind: string;
  claimedPaise: number;
  vendorName: string | null;
  billNumber: string | null;
  remarks: string | null;
};

export function EnteredExpenseActions({ line, today }: { line: EnteredLine; today: string }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const r = await deleteEnteredExpense(line.id, reason);
      if (!r.ok) return setError(r.error);
      setDeleting(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex gap-1.5">
      <Button size="sm" tone="quiet" title="You entered this — correct it before it is decided" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Button
        size="sm"
        tone="quiet"
        title="You entered this — take it off before it is decided"
        onClick={() => {
          setReason("");
          setError(null);
          setDeleting(true);
        }}
      >
        Delete
      </Button>
      {editing ? <EditForm key={line.id} line={line} today={today} onClose={() => setEditing(false)} /> : null}
      <ReasonModal
        open={deleting}
        title="Delete this expense"
        subject={`${line.who} · ${rupeesFromPaise(line.claimedPaise)} · ${line.day}`}
        subjectDetail="It leaves his expenses and the approvals queue, and he is told why."
        fieldLabel="Why is it being deleted?"
        reason={reason}
        onReasonChange={setReason}
        confirmLabel="Delete the expense"
        busy={busy}
        error={error}
        onClose={() => setDeleting(false)}
        onConfirm={() => void remove()}
      />
    </span>
  );
}

function EditForm({ line, today, onClose }: { line: EnteredLine; today: string; onClose: () => void }) {
  const router = useRouter();
  const known = KINDS.some((k) => k.value === line.kind);
  const [kind, setKind] = React.useState<Kind>(known ? (line.kind as Kind) : "other");
  const [day, setDay] = React.useState(line.day);
  const [amount, setAmount] = React.useState(rupeesFromPaise(line.claimedPaise).replace(/,/g, ""));
  const [vendor, setVendor] = React.useState(line.vendorName ?? "");
  const [billNo, setBillNo] = React.useState(line.billNumber ?? "");
  const [remarks, setRemarks] = React.useState(line.remarks ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const rupees = parseRupees(amount);
  const ready = rupees !== null && rupees > 0 && Boolean(day);

  async function save() {
    if (rupees === null || rupees <= 0) return setError("Type the amount.");
    setBusy(true);
    setError(null);
    try {
      const r = await editEnteredExpense(line.id, {
        day,
        kind,
        amountPaise: Math.round(rupees * 100),
        vendorName: vendor.trim() || undefined,
        billNumber: billNo.trim() || undefined,
        remarks: remarks.trim() || undefined,
      });
      if (!r.ok) return setError(r.error);
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Correct the expense for ${line.who}`} width={480}>
      <div className="flex flex-col gap-3">
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-ink">What</span>
          <select className={field} value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-ink">Day spent</span>
          <input type="date" className={field} value={day} max={today} disabled={busy} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-ink">Amount (₹)</span>
          <input inputMode="decimal" className={field} value={amount} disabled={busy} onChange={(e) => setAmount(cleanDecimal(e.target.value))} />
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-ink">Paid to (optional)</span>
          <input className={field} value={vendor} disabled={busy} onChange={(e) => setVendor(e.target.value)} />
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-ink">Bill number (optional)</span>
          <input className={field} value={billNo} disabled={busy} onChange={(e) => setBillNo(e.target.value)} />
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-ink">Remarks (optional)</span>
          <textarea rows={2} className={field} value={remarks} disabled={busy} onChange={(e) => setRemarks(e.target.value)} />
        </label>
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Keep as it is
        </Button>
        <Button tone="primary" disabled={busy || !ready} title={ready ? undefined : "The day and an amount above ₹0 are needed."} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Modal>
  );
}
