"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Button, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { money, stamp } from "@/lib/format";
import { decideOrderChangeAction } from "@/lib/actions/order-changes";
import type { OrderChangeRow } from "@/lib/services/order-change-service";
import type { OrderLine } from "@/db/schema";
import { Empty, Pill, ScreenHeader, plural } from "../parts";

/**
 * CHANGES A SALESMAN ASKED FOR ON AN APPROVED ORDER.
 *
 * Each request is read as the order it would replace: every product, what it
 * was, what it would be, and the difference — because "change the order" is
 * decided on the lines, and a request shown only as a new total hides that a
 * product was swapped for a cheaper one. Declining needs a reason; the
 * salesman has to ring the shop with it.
 */
export function OrderChangesScreen({ rows, canDecide }: { rows: OrderChangeRow[]; canDecide: boolean }) {
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  return (
    <div>
      <ScreenHeader
        title="Order changes"
        subtitle="A salesman edits his own order until you approve it. After that, a change comes here as a request — accept it and the order is rewritten; decline it and say why."
      />
      {pending.length === 0 ? (
        <Empty title="Nothing waiting" body="No salesman has asked to change an approved order." />
      ) : (
        <div className="flex flex-col gap-4">
          {pending.map((r) => (
            <ChangeCard key={r.id} row={r} canDecide={canDecide} />
          ))}
        </div>
      )}

      {decided.length ? (
        <>
          <h2 className="mt-8 mb-3 text-[13px] font-medium tracking-[0.04em] text-muted uppercase">Recently decided</h2>
          <div className="flex flex-col gap-3">
            {decided.map((r) => (
              <ChangeCard key={r.id} row={r} canDecide={false} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

type Diff = { name: string; before: number | null; after: number | null };

function diffLines(before: OrderLine[] | null, after: OrderLine[]): Diff[] {
  const key = (l: OrderLine) => (l as OrderLine & { productId?: string }).productId ?? l.product;
  const map = new Map<string, Diff>();
  for (const l of before ?? []) map.set(key(l), { name: l.product, before: l.quantity, after: null });
  for (const l of after) {
    const d = map.get(key(l));
    if (d) d.after = l.quantity;
    else map.set(key(l), { name: l.product, before: null, after: l.quantity });
  }
  return [...map.values()];
}

function ChangeCard({ row, canDecide }: { row: OrderChangeRow; canDecide: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [declining, setDeclining] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const lines = diffLines(row.previousLineItems, row.lineItems);
  const delta = row.previousTotalPaise == null ? null : row.totalAmountPaise - row.previousTotalPaise;

  const decide = async (decision: "accept" | "decline") => {
    setBusy(true);
    const r = await decideOrderChangeAction(row.id, decision, decision === "decline" ? reason : null);
    setBusy(false);
    if (!r.ok) return toast.push(r.error, "error");
    toast.push(r.message ?? "Saved");
    router.refresh();
  };

  return (
    <div className="rounded-[6px] border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink">
            {row.customerName}
            {row.customerCity ? <span className="font-normal text-muted"> · {row.customerCity}</span> : null}
          </div>
          <div className="mt-0.5 text-[13px] text-muted">
            Order {row.orderNo ?? "—"} · asked by {row.requestedByName} · {stamp(row.createdAt)}
          </div>
        </div>
        {row.status === "pending" ? (
          <Pill tone="warn">Waiting</Pill>
        ) : row.status === "accepted" ? (
          <Pill tone="success">Accepted</Pill>
        ) : (
          <Pill tone="danger">Declined</Pill>
        )}
      </div>

      <div className="px-5 py-4">
        <p className="text-[14px] leading-[20px] text-body">
          <span className="font-medium text-ink">Why: </span>
          {row.note}
        </p>

        <table className="mt-3 w-full text-[13px]">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 font-medium">Product</th>
              <th className="py-1 text-right font-medium">Approved</th>
              <th className="py-1 text-right font-medium">Asked for</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const changed = l.before !== l.after;
              return (
                <tr key={l.name} className="border-t border-line">
                  <td className={"py-1.5 pr-3 " + (changed ? "font-medium text-ink" : "text-body")}>{l.name}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted">
                    {l.before == null ? "—" : plural(l.before, "can")}
                  </td>
                  <td className={"py-1.5 text-right tabular-nums " + (changed ? "font-semibold text-ink" : "text-body")}>
                    {l.after == null ? "removed" : plural(l.after, "can")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-3 text-[13px] text-muted">
          {row.previousTotalPaise != null ? money(row.previousTotalPaise) + " → " : ""}
          <span className="font-semibold text-ink">{money(row.totalAmountPaise)}</span>
          {delta ? (
            <span className={delta > 0 ? " text-warn-ink" : " text-success"}>
              {" "}
              ({delta > 0 ? "+" : "−"}
              {money(Math.abs(delta))})
            </span>
          ) : null}
        </div>

        {row.status !== "pending" ? (
          <p className="mt-3 text-[13px] text-muted">
            {row.status === "accepted" ? "Accepted" : "Declined"} by {row.decidedByName ?? "—"}
            {row.decidedAt ? " · " + stamp(row.decidedAt) : ""}
            {row.decisionNote ? " — " + row.decisionNote : ""}
          </p>
        ) : null}

        {row.status === "pending" && row.orderStatus !== "confirmed" ? (
          <p className="mt-3 text-[13px] text-danger">
            The order is {row.orderStatus.replace("_", " ")} now, so it can no longer be changed — decline this and say so.
          </p>
        ) : null}

        {row.status === "pending" ? (
          declining ? (
            <div className="mt-4">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why it is declined — the salesman tells the shop this"
                rows={2}
              />
              <div className="mt-2 flex gap-2">
                <Button variant="primary" disabled={!canDecide || busy || !reason.trim()} onClick={() => void decide("decline")}>
                  Decline
                </Button>
                <Button onClick={() => setDeclining(false)} disabled={busy}>
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex gap-2">
              <Button
                variant="primary"
                disabled={!canDecide || busy || row.orderStatus !== "confirmed"}
                title={!canDecide ? "Deciding an order change needs order approval rights." : undefined}
                onClick={() => void decide("accept")}
              >
                Accept and update the order
              </Button>
              <Button
                disabled={!canDecide || busy}
                title={!canDecide ? "Deciding an order change needs order approval rights." : undefined}
                onClick={() => setDeclining(true)}
              >
                Decline…
              </Button>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
