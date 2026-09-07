"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { decideExpenseDay, reopenExpenseDay } from "@/lib/actions/expenses";
import { Modal } from "@/components/ui/overlays";
import { Button } from "../parts";

/**
 * Deciding one submitted day.
 *
 * The eligible figure is the DEFAULT in the amount box, so the ordinary case
 * is one press and what a manager is doing when they change it is overriding
 * the policy rather than doing its arithmetic. That is requirement 40 the
 * right way round: the system works out what is allowed, and a person decides
 * whether to allow something else.
 *
 * Part-approving demands the figure and refusing demands the reason, both
 * checked on the server too — this dialog is a convenience, not a check.
 */
export function DecideDay({
  dayId,
  who,
  what,
  claimedPaise,
  eligiblePaise,
  locked,
}: {
  dayId: string;
  who: string;
  what: string;
  claimedPaise: number;
  eligiblePaise: number;
  locked: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<null | "decide" | "reopen">(null);
  const [amount, setAmount] = React.useState(String(Math.round(eligiblePaise / 100)));
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const asPaise = Math.round((Number(amount.replace(/[^0-9.]/g, "")) || 0) * 100);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "That did not save.");
      return;
    }
    setOpen(null);
    router.refresh();
  };

  const decide = (decision: "approved" | "partially_approved" | "rejected") =>
    run(() =>
      decideExpenseDay({
        dayId,
        decision,
        approvedAmountPaise: decision === "rejected" ? null : asPaise,
        note: note.trim() || null,
      }),
    );

  return (
    <>
      <div className="flex justify-end gap-1.5">
        <Button
          tone="primary"
          onClick={() => {
            setAmount(String(Math.round(eligiblePaise / 100)));
            setNote("");
            setError(null);
            setOpen("decide");
          }}
        >
          Decide
        </Button>
        {locked ? (
          <Button
            tone="quiet"
            onClick={() => {
              setNote("");
              setError(null);
              setOpen("reopen");
            }}
          >
            Reopen
          </Button>
        ) : null}
      </div>

      <Modal
        open={open === "decide"}
        onClose={() => setOpen(null)}
        title={`${who} — ${what}`}
        width={480}
      >
        {open === "decide" ? (
          <>
            <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted">Claimed</span>
                <span className="font-medium text-ink">₹{Math.round(claimedPaise / 100).toLocaleString("en-IN")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Eligible under the policy</span>
                <span className="font-medium text-ink">₹{Math.round(eligiblePaise / 100).toLocaleString("en-IN")}</span>
              </div>
              {claimedPaise > eligiblePaise ? (
                <div className="mt-1 flex justify-between border-t border-line pt-1">
                  <span className="text-muted">Over policy</span>
                  <span className="font-medium text-warn-ink">
                    ₹{Math.round((claimedPaise - eligiblePaise) / 100).toLocaleString("en-IN")}
                  </span>
                </div>
              ) : null}
            </div>

            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">Allow</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
              <span className="mt-1 block text-[12px] text-muted">
                Rupees. It starts at what the policy allows — changing it is you overriding the
                policy, which is a thing you may do and which is recorded as such.
              </span>
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                Note — required if you refuse
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button
                tone="danger"
                disabled={busy || !note.trim()}
                title={!note.trim() ? "A refusal has to say why — the salesman is told this." : undefined}
                onClick={() => decide("rejected")}
              >
                Refuse
              </Button>
              <Button
                tone="quiet"
                disabled={busy || asPaise >= claimedPaise}
                title={asPaise >= claimedPaise ? "This is the whole claim — use Approve." : undefined}
                onClick={() => decide("partially_approved")}
              >
                Allow part
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => decide("approved")}>
                {busy ? "Saving…" : "Approve"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      <Modal
        open={open === "reopen"}
        onClose={() => setOpen(null)}
        title="Reopen this day"
        width={440}
      >
        {open === "reopen" ? (
          <>
            <p className="mb-3 text-[13px] text-muted">
              The salesman will be able to change it again. What he submitted is not erased — a
              correction is recorded beside the original rather than replacing it, so both stay
              readable.
            </p>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">Why</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                autoFocus
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={busy || !note.trim()}
                onClick={() => run(() => reopenExpenseDay({ dayId, reason: note }))}
              >
                {busy ? "Reopening…" : "Reopen"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}
