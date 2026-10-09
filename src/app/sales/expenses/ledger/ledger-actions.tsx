"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { recordExpensePayout, voidExpensePayout } from "@/lib/actions/sales";
import { Modal } from "@/components/ui/overlays";
import { Button, ReasonModal } from "@/components/console/parts";
import { PAYOUT_MODES, inrExact as inr } from "../labels";

const field =
  "w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand";

/**
 * Record money handed over against a salesman's expense balance.
 *
 * The amount starts at what he is owed, so settling the balance is one press.
 * It is paid against the BALANCE — the ledger works out which expenses it
 * covered, oldest first — so nothing here asks which bill it was for.
 */
export function RecordPayment({
  userId,
  who,
  duePaise,
  today,
  size = "md",
  tone = "primary",
  label = "Record payment",
}: {
  userId: string;
  who: string;
  duePaise: number;
  /** `YYYY-MM-DD`, the server's business date — a client must not read the clock in render. */
  today: string;
  size?: "sm" | "md";
  tone?: "primary" | "default";
  /** The button's words — shorter in a table row. */
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(today);
  const [mode, setMode] = React.useState<string>(PAYOUT_MODES[0]);
  const [reference, setReference] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const typed = Number(amount.replace(/[^0-9.]/g, ""));
  const asPaise = Number.isFinite(typed) ? Math.round(typed * 100) : 0;
  const advance = asPaise > duePaise ? asPaise - duePaise : 0;

  const start = () => {
    setAmount(
      duePaise > 0 ? (duePaise / 100).toFixed(duePaise % 100 ? 2 : 0) : "",
    );
    setPaidOn(today);
    setMode(PAYOUT_MODES[0]);
    setReference("");
    setNote("");
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await recordExpensePayout({
      userId,
      amountPaise: asPaise,
      paidOn,
      mode: mode.trim() || undefined,
      reference: reference.trim() || undefined,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "That did not save.");
      return;
    }
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <Button tone={tone} size={size} onClick={start}>
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Pay ${who}`}
        width={460}
      >
        {open ? (
          <>
            <div className="mb-3 flex justify-between rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              <span className="text-muted">Owed now</span>
              <span className="font-medium text-ink">{inr(duePaise)}</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">
                  Amount paid (₹)
                </span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  autoFocus
                  className={field}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">
                  Paid on
                </span>
                <input
                  type="date"
                  value={paidOn}
                  max={today}
                  onChange={(e) => setPaidOn(e.target.value)}
                  className={field}
                />
              </label>
            </div>
            {advance > 0 ? (
              <p className="mt-1.5 text-[12px] text-warn-ink">
                {inr(advance)} more than he is owed — it is kept as an advance
                against what is still waiting.
              </p>
            ) : null}

            <div className="mt-3">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                How
              </span>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {PAYOUT_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`h-7 cursor-pointer rounded-full border px-3 text-[12px] ${
                      mode === m
                        ? "border-brand bg-brand-soft text-brand"
                        : "border-line bg-surface text-body"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <input
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className={field}
              />
            </div>

            <label className="mt-3 block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                Reference
              </span>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UTR, cheque number or payroll month"
                className={field}
              />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                Note
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className={field}
              />
            </label>

            {error ? (
              <p className="mt-2 text-[13px] text-danger">{error}</p>
            ) : null}
            <p className="mt-3 text-[12px] text-muted">
              He is told on his phone that the money was paid.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={busy || asPaise <= 0 || !paidOn}
                title={asPaise <= 0 ? "Type the amount paid." : undefined}
                onClick={save}
              >
                {busy
                  ? "Saving…"
                  : asPaise > 0
                    ? `Record ${inr(asPaise)}`
                    : "Record"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}

/** Void a payment recorded wrongly. It stays on the statement, struck through. */
export function VoidPayment({
  payoutId,
  what,
}: {
  payoutId: string;
  what: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const r = await voidExpensePayout({ payoutId, reason });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "That did not save.");
      return;
    }
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
        className="cursor-pointer text-[12px] text-danger hover:underline"
      >
        Void
      </button>
      <ReasonModal
        open={open}
        title="Void this payment"
        subject={what}
        subjectDetail="It stays on his statement, struck through, and stops counting."
        fieldLabel="Why is it being voided?"
        reason={reason}
        onReasonChange={setReason}
        confirmLabel="Void payment"
        busy={busy}
        error={error}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
      />
    </>
  );
}
