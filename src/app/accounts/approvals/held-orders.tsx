"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { releaseOrderAction } from "@/lib/actions/orders";
import { money, stamp } from "@/lib/format";

export type HeldRow = { orderId: string; orderNo: number; customerName: string; amount: number; reason: string; note: string | null; heldBy: string | null; heldAt: string };

/**
 * ORDERS ON HOLD WITH ACCOUNTS — the Order Hub's accounts hold. Releasing one
 * puts it back in the queue above, to be approved, held or declined again.
 */
export function HeldOrders({ rows, canDecide }: { rows: HeldRow[]; canDecide: boolean }) {
  const router = useRouter();
  const { run } = useToast();
  const [open, setOpen] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!rows.length) return null;

  async function release(orderId: string) {
    setBusy(true);
    try {
      const r = await run(releaseOrderAction(orderId, note));
      if (r.ok) {
        setOpen(null);
        setNote("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto mt-6 w-full max-w-(--container-measure) px-6 pb-10" aria-labelledby="held-orders">
      <h2 id="held-orders" className="mb-1 font-display text-[18px] font-semibold text-ink">
        Orders on hold · {rows.length}
      </h2>
      <p className="mb-3 text-[13px] text-muted">Held by Accounts. Releasing one puts it back in the queue to be decided again.</p>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] tracking-[0.04em] text-muted uppercase">
              <th className="border-b border-line px-4 py-2.5 font-medium">Order</th>
              <th className="border-b border-line px-4 py-2.5 font-medium">Party</th>
              <th className="border-b border-line px-4 py-2.5 text-right font-medium">Value</th>
              <th className="border-b border-line px-4 py-2.5 font-medium">Reason · remarks</th>
              <th className="border-b border-line px-4 py-2.5 font-medium">Held by</th>
              <th className="border-b border-line px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.orderId}>
                <tr className="align-middle">
                  <td className="border-b border-divider px-4 py-3 font-semibold">{r.orderNo}</td>
                  <td className="border-b border-divider px-4 py-3">{r.customerName}</td>
                  <td className="border-b border-divider px-4 py-3 text-right tabular-nums">{money(r.amount)}</td>
                  <td className="border-b border-divider px-4 py-3">
                    <div className="font-medium">{r.reason}</div>
                    {r.note ? <div className="text-muted">{r.note}</div> : null}
                  </td>
                  <td className="border-b border-divider px-4 py-3">
                    <div>{r.heldBy ?? "—"}</div>
                    <div className="text-muted">{stamp(new Date(r.heldAt))}</div>
                  </td>
                  <td className="border-b border-divider px-4 py-3 text-right">
                    <Button variant="secondary" size="sm" disabled={!canDecide} title={canDecide ? undefined : "Only the accounts team can release an order"} onClick={() => setOpen(open === r.orderId ? null : r.orderId)}>
                      Release
                    </Button>
                  </td>
                </tr>
                {open === r.orderId ? (
                  <tr>
                    <td colSpan={6} className="border-b border-divider bg-canvas px-4 py-3">
                      <label htmlFor={`release-${r.orderId}`} className="mb-1.5 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                        What changed
                      </label>
                      <div className="flex items-start gap-2">
                        <textarea id={`release-${r.orderId}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-2 text-[13px]" placeholder="Overdue cleared on the 20th." />
                        <Button variant="primary" size="sm" disabled={busy || !note.trim()} onClick={() => release(r.orderId)}>
                          Back to the queue
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
