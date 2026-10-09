"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { decideExpense } from "@/lib/actions/sales";
import type { ExpenseFile } from "@/lib/services/expense-claims-service";
import { Modal } from "@/components/ui/overlays";
import { Button } from "@/components/console/parts";
import { inrExact as inr } from "./labels";

/**
 * Deciding ONE expense a salesman logged.
 *
 * The amount box starts at what he logged, so the ordinary case is one press
 * on Approve. Where the policy allows less, that figure is shown beside it and
 * one tap puts it in the box — being over the policy never stops an expense
 * being recorded, the money was already spent, and paying less is a decision
 * a person makes with the bill in front of them.
 *
 * Paying less demands a figure above ₹0 and below what he logged; refusing
 * demands the reason he will be told. Both are checked on the server too —
 * this dialog is a convenience, not a check.
 */
export function DecideExpense({
  expenseId,
  who,
  what,
  claimedPaise,
  eligiblePaise,
  remarks,
  vendorName,
  billNumber,
  files,
}: {
  expenseId: string;
  who: string;
  what: string;
  claimedPaise: number;
  eligiblePaise: number | null;
  remarks: string | null;
  vendorName: string | null;
  billNumber: string | null;
  files: ExpenseFile[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState(rupees(claimedPaise));
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* Rupees AND paise: ₹12.50 is a real auto fare, and a box that rounded it
     would quietly pay a different figure from the one on the screen. */
  const typed = Number(amount.replace(/[^0-9.]/g, ""));
  const asPaise = Number.isFinite(typed) ? Math.round(typed * 100) : 0;
  const lessThanAsked = asPaise > 0 && asPaise < claimedPaise;
  const policyBelow = eligiblePaise !== null && eligiblePaise > 0 && eligiblePaise < claimedPaise;

  const decide = async (decision: "approved" | "partially_approved" | "rejected") => {
    setBusy(true);
    setError(null);
    const r = await decideExpense({
      expenseId,
      decision,
      note: note.trim() || undefined,
      approvedAmountPaise: decision === "partially_approved" ? asPaise : undefined,
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
      <Button
        tone="primary"
        onClick={() => {
          setAmount(rupees(claimedPaise));
          setNote("");
          setError(null);
          setOpen(true);
        }}
      >
        Review
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={`${who} — ${what}`} width={480}>
        {open ? (
          <>
            <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted">Logged</span>
                <span className="font-medium text-ink">{inr(claimedPaise)}</span>
              </div>
              {eligiblePaise !== null ? (
                <div className="flex justify-between">
                  <span className="text-muted">Policy allows</span>
                  <span className="font-medium text-ink">{inr(eligiblePaise)}</span>
                </div>
              ) : null}
              {policyBelow ? (
                <div className="mt-1 flex justify-between border-t border-line pt-1">
                  <span className="text-muted">Over the policy</span>
                  <span className="font-medium text-warn-ink">{inr(claimedPaise - eligiblePaise!)}</span>
                </div>
              ) : null}
              {remarks || vendorName || billNumber ? (
                <p className="mt-2 border-t border-line pt-2 text-[12px] text-body">
                  {[vendorName, billNumber ? `bill ${billNumber}` : null, remarks].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </div>

            <Bills files={files} />

            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">Amount to pay (₹)</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
              <span className="mt-1 block text-[12px] text-muted">
                Starts at what he logged.
                {policyBelow ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="font-medium text-brand"
                      onClick={() => setAmount(rupees(eligiblePaise!))}
                    >
                      Use the policy amount ({inr(eligiblePaise!)})
                    </button>
                  </>
                ) : null}
              </span>
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                Note for him (needed to refuse or pay less)
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button tone="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                tone="danger"
                disabled={busy || !note.trim()}
                title={!note.trim() ? "Say why — he is told this." : undefined}
                onClick={() => void decide("rejected")}
              >
                Refuse
              </Button>
              <Button
                tone="quiet"
                disabled={busy || !lessThanAsked || !note.trim()}
                title={
                  !lessThanAsked
                    ? "Type an amount above ₹0 and below what he logged, or use Approve."
                    : !note.trim()
                      ? "Say why he is being paid less — he is told this."
                      : undefined
                }
                onClick={() => void decide("partially_approved")}
              >
                Pay {lessThanAsked ? inr(asPaise) : "less"}
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void decide("approved")}>
                {busy ? "Saving…" : `Approve ${inr(claimedPaise)}`}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}

/**
 * The bills behind the expense. Photographs are thumbnails that open full
 * size; anything else — a PDF — is a link. A file swept by retention says so
 * rather than breaking.
 */
function Bills({ files }: { files: ExpenseFile[] }) {
  if (!files.length) {
    return <p className="mb-3 text-[12px] text-warn-ink">No bill attached.</p>;
  }
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {files.map((f) =>
        f.gone ? (
          <span key={f.id} className="rounded-[4px] border border-line px-2 py-1 text-[12px] text-muted">
            File removed
          </span>
        ) : f.contentType.startsWith("image/") ? (
          <a key={f.id} href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element -- a private,
                session-checked file; next/image would proxy it past that check */}
            <img
              src={`/api/attachments/${f.id}`}
              alt={f.filename}
              className="h-20 w-20 rounded-[4px] border border-line object-cover"
            />
          </a>
        ) : (
          <a
            key={f.id}
            href={`/api/attachments/${f.id}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-[4px] border border-line px-2 py-1 text-[12px] text-brand"
          >
            {f.contentType === "application/pdf" ? "PDF" : "File"} · open
          </a>
        ),
      )}
    </div>
  );
}

function rupees(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

