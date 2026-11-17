"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/primitives";
import { EditToDialog } from "@/components/orders/order-journey";
import type { NextStep } from "@/lib/engines/next-step";
import type { TakenTo } from "@/lib/order-journey";

/* ---------------------------------------------------------------------------
 * "ORDER TAKEN: TO-1042" — what a telecaller sees when a call that took an
 * order is saved and the ERP is the order book. It replaces the next-step
 * dialog for that call and carries its sentence in the grey box, so nothing
 * the next-step dialog said is lost: the TO number, what is on it, that the
 * back office and the Production Head check it next, and when the customer
 * comes back to the Call Log.
 * ------------------------------------------------------------------------- */

export function OrderTakenDialog({
  open,
  taken,
  step,
  customerName,
  defaultNext,
  onNext,
  onStay,
}: {
  open: boolean;
  taken: TakenTo;
  step: NextStep | null;
  customerName: string;
  defaultNext: boolean;
  onNext: (() => void) | null;
  onStay: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const stops = step ? step.kind === "decide" || step.kind === "none" : false;
  return (
    <>
      <Modal open={open && !editing} onClose={onStay} width={560} title={null}>
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-[13px] font-semibold text-success">Call saved · {customerName}</p>
            <h2 className="mt-1 flex items-center gap-2 text-[22px] font-semibold text-ink">
              Order taken: TO-{taken.toNo}
              <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-brand uppercase">New</span>
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-body">
              This is a temporary order number. The back office and the Production Head check it, then it gets its order number.
            </p>
          </div>

          <div className="overflow-hidden rounded-card border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-muted uppercase">
                  <th className="px-3 py-2.5 text-left">Product</th>
                  <th className="px-3 py-2.5 text-right">Cans</th>
                  <th className="px-3 py-2.5 text-right">Litres</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {taken.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2.5 text-ink">{l.product}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink">{l.cans}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink">{l.litres ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-1 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[12px] font-medium text-brand">Order Hub · waiting for checks</span>
              <span className="text-body">Back office ○</span>
              <span className="text-body">Production Head ○</span>
            </div>
            <span className="text-muted">Source: TeleCRM · {taken.takenBy}</span>
          </div>

          {step ? (
            <div className="rounded-card bg-canvas px-4 py-3">
              <p className="text-sm font-semibold text-ink">{step.headline}</p>
              <p className="mt-0.5 text-[13px] text-body">{step.detail}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setEditing(true)}>Edit order</Button>
            <Button
              onClick={() => {
                onStay();
                router.push("/crm/my-orders");
              }}
            >
              Open in my orders
            </Button>
            {onNext ? (
              <Button variant="primary" onClick={onNext} autoFocus={defaultNext && !stops}>
                Next call
              </Button>
            ) : (
              <Button variant="primary" onClick={onStay}>
                Done
              </Button>
            )}
          </div>
          <p className="text-[12px] text-muted">You can edit or cancel this order until both checks are done.</p>
        </div>
      </Modal>
      {editing ? <EditToDialog intakeId={taken.intakeId} onClose={() => setEditing(false)} /> : null}
    </>
  );
}
