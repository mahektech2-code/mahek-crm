"use client";

import React from "react";
import { useRouter } from "next/navigation";
import {
  claimLinesForDayAction,
  decideExpenseDay,
  reopenExpenseDay,
} from "@/lib/actions/expenses";
import type { ClaimLine } from "@/lib/services/expense-claims-service";
import { Modal } from "@/components/ui/overlays";
import { Button } from "@/components/console/parts";

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

            <DayClaims dayId={dayId} />

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

/* ---------------------------------------------------------------------------
 * WHAT THE DAY IS MADE OF, and the bills behind it.
 *
 * The dialog was two totals and a box: a manager decided a day's money without
 * one claim or one bill in front of them, though every bill was stored. Read
 * when the dialog opens, because most days in the list are never opened.
 * Photographs are drawn as thumbnails that open full size; anything else — a
 * PDF — is a link. A file swept by retention says so rather than breaking.
 * ------------------------------------------------------------------------- */
function DayClaims({ dayId }: { dayId: string }) {
  const [lines, setLines] = React.useState<ClaimLine[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    void claimLinesForDayAction(dayId).then((r) => {
      if (!live) return;
      if (r.ok) setLines(r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [dayId]);

  if (error) return <p className="mb-3 text-[13px] text-danger">{error}</p>;
  if (!lines) return <p className="mb-3 text-[13px] text-muted">Loading the claims…</p>;
  if (!lines.length) {
    return (
      <p className="mb-3 text-[13px] text-muted">
        No claims on this day — only travel measured by the day&apos;s readings.
      </p>
    );
  }

  return (
    <div className="mb-3 max-h-[320px] overflow-y-auto rounded-[6px] border border-line">
      {lines.map((l, i) => (
        <div key={l.id} className={i ? "border-t border-line px-3 py-2.5" : "px-3 py-2.5"}>
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="font-medium text-ink capitalize">{l.kind.replace(/_/g, " ")}</span>
            <span className="font-medium text-ink">
              ₹{Math.round(l.claimedPaise / 100).toLocaleString("en-IN")}
            </span>
          </div>
          {l.remarks || l.vendorName ? (
            <p className="mt-0.5 text-[12px] text-muted">
              {[l.vendorName, l.billNumber ? `bill ${l.billNumber}` : null, l.remarks]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {l.files.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {l.files.map((f) =>
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
                      className="h-16 w-16 rounded-[4px] border border-line object-cover"
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
          ) : (
            <p className="mt-1 text-[12px] text-warn-ink">No bill attached</p>
          )}
        </div>
      ))}
    </div>
  );
}
