"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { RowMenu } from "@/components/ui/overlays";
import { ReasonImpactDialog } from "@/components/ui/reason-impact-dialog";
import { useToast } from "@/components/ui/toast";
import { declineOrderAction, releaseOrderAction } from "@/lib/actions/orders";
import { money, stamp } from "@/lib/format";
import { EditOrderDialog } from "./edit-order-dialog";

export type HeldRow = { orderId: string; orderNo: number; customerId: string; customerName: string; amount: number; reason: string; note: string | null; heldBy: string | null; heldAt: string };

/**
 * ORDERS ON HOLD WITH ACCOUNTS — the Order Hub's accounts hold. Releasing one
 * puts it back in the queue above, to be approved, held or declined again.
 *
 * A held order is still waiting for Accounts (`pending_approval`), so what
 * Order approvals offers on a waiting order is offered here too: Edit order
 * (its lines, Accounts' own — `EditOrderDialog`), Decline (the reason, then
 * the `accounts-order-decline` impact modal; the decision ends the hold), the
 * order in the ERP's Billing & dispatch for whoever holds the ERP, and the
 * customer's ledger.
 */
export function HeldOrders({
  rows,
  canDecide,
  standalone = false,
  erpOrders = false,
}: {
  rows: HeldRow[];
  canDecide: boolean;
  standalone?: boolean;
  /** Whether the reader holds the ERP, so the order number opens the order there. */
  erpOrders?: boolean;
}) {
  const router = useRouter();
  const { run, push } = useToast();
  const [open, setOpen] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [declining, setDeclining] = React.useState<HeldRow | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!rows.length)
    return standalone ? (
      <section className="mx-auto w-full max-w-(--container-measure) px-6 pt-6 pb-10">
        <div role="heading" aria-level={1} className="mb-2 text-2xl font-semibold text-ink">
          Orders on hold
        </div>
        <p className="text-sm text-muted">Nothing on hold with Accounts. An order you hold from Order approvals lands here.</p>
      </section>
    ) : null;

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
    <section className={`mx-auto w-full max-w-(--container-measure) px-6 pb-10 ${standalone ? "pt-6" : "mt-6"}`} aria-labelledby="held-orders">
      <h2 id="held-orders" className={`mb-1 font-semibold text-ink ${standalone ? "text-2xl" : "text-lg"}`}>
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
                  <td className="border-b border-divider px-4 py-3 font-semibold">
                    {erpOrders ? (
                      <Link href={orderHref(r.orderNo)} className="text-ink hover:text-brand" title="Open the order in the ERP">
                        {r.orderNo}
                      </Link>
                    ) : (
                      r.orderNo
                    )}
                  </td>
                  <td className="border-b border-divider px-4 py-3">
                    <Link href={`/accounts/ledger?customer=${r.customerId}`} className="text-ink hover:text-brand" title="The customer's ledger">
                      {r.customerName}
                    </Link>
                  </td>
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
                    <span className="inline-flex items-center gap-1.5">
                      <Button variant="secondary" size="sm" disabled={!canDecide} title={canDecide ? undefined : "Only the accounts team can release an order"} onClick={() => setOpen(open === r.orderId ? null : r.orderId)}>
                        Release
                      </Button>
                      <RowMenu
                        items={[
                          {
                            label: "Edit order",
                            disabled: !canDecide,
                            title: canDecide ? "Change the products, cans, rates or discounts — it stays on hold" : "Only the accounts team edits an order while approving it",
                            onSelect: () => setEditingId(r.orderId),
                          },
                          {
                            label: "Decline order…",
                            destructive: true,
                            disabled: !canDecide,
                            title: canDecide ? "Refuse it with a reason — whoever took it is told, and the hold ends" : "Only the accounts team can decline an order",
                            onSelect: () => setDeclining(r),
                          },
                          ...(erpOrders ? [{ label: `Open order ${r.orderNo}`, onSelect: () => router.push(orderHref(r.orderNo)) }] : []),
                          { label: "Customer account", onSelect: () => router.push(`/accounts/ledger?customer=${r.customerId}`) },
                        ]}
                      />
                    </span>
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
      {editingId ? (
        <EditOrderDialog
          key={editingId}
          orderId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            router.refresh();
          }}
        />
      ) : null}
      {declining ? (
        <ReasonImpactDialog
          key={declining.orderId}
          kind="accounts-order-decline"
          id={declining.orderId}
          title={`Decline order ${declining.orderNo}`}
          reasonLabel="Why is it declined? Whoever took it is told."
          confirmLabel="Decline"
          onClose={() => setDeclining(null)}
          onConfirm={(reason, confirmation) => declineOrderAction(declining.orderId, reason, confirmation)}
          onDone={(r) => {
            setDeclining(null);
            if (r.message) push(r.message);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/** The order in the ERP's Billing & dispatch, searched by its number. */
function orderHref(orderNo: number): string {
  return `/erp/orders?view=orderDetails&q=${orderNo}`;
}
