"use client";

import * as React from "react";
import Link from "next/link";
import { Badge, SectionLabel, cx } from "@/components/ui/primitives";
import type { BillDetail } from "@/lib/services/bill-detail-service";
import { money, shortDate } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * What is inside one bill, opened under its row.
 *
 * The ledger answers how much and when; this answers what was actually bought,
 * which is the next question anybody reading an order history asks. It loads
 * when the row is opened — the items behind ten thousand bills are not
 * something to send to a browser that will show one.
 * ------------------------------------------------------------------------- */

/** Remounts per bill, so a newly opened row starts from its own fetch. */
export function BillDetailPanel({ billId }: { billId: string }) {
  const [detail, setDetail] = React.useState<BillDetail | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "failed">("loading");

  React.useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/bill-detail?billId=${encodeURIComponent(billId)}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.detail) {
          setDetail(d.detail);
          setState("ready");
        } else {
          setState("failed");
        }
      })
      .catch((e: unknown) => {
        // An aborted fetch is the row being closed, not a failure to report.
        if ((e as { name?: string })?.name !== "AbortError") setState("failed");
      });
    return () => controller.abort();
  }, [billId]);

  if (state === "loading") {
    return <p className="px-5 py-6 text-[13px] text-muted">Loading the order…</p>;
  }
  if (state === "failed" || !detail) {
    return (
      <p className="px-5 py-6 text-[13px] text-muted">
        This order could not be loaded. It may have been removed since the page
        was opened.
      </p>
    );
  }

  return <Detail detail={detail} />;
}

function Detail({ detail }: { detail: BillDetail }) {
  const o = detail.order;
  const t = detail.totals;

  const facts: Array<[string, React.ReactNode]> = [];
  if (o) {
    facts.push(["Order number", o.number ?? "Not numbered"]);
    facts.push(["Order date", o.orderedAt ? shortDate(o.orderedAt) : "—"]);
    if (o.dispatchDate) facts.push(["Dispatched", shortDate(o.dispatchDate)]);
    facts.push([
      "Payment term",
      o.creditDays === null ? "Customer's own term" : days(o.creditDays),
    ]);
    if (o.gstBp !== null) facts.push(["GST", percent(o.gstBp)]);
    if (o.paymentType) facts.push(["Payment type", o.paymentType]);
    if (o.paymentStatus) facts.push(["Sheet payment status", o.paymentStatus]);
    if (o.paymentReceivedDate) {
      facts.push(["Payment received", shortDate(o.paymentReceivedDate)]);
    }
    if (o.transportName) facts.push(["Transport", o.transportName]);
    if (o.area) facts.push(["Area", o.area]);
    // The same person the customer record calls their salesperson, named the
    // same way. This one is the ORDER's own — who sold this, which is not
    // always who the master names today.
    if (o.salesMan) facts.push(["Sales person", o.salesMan]);
    if (o.segmentCounterType) facts.push(["Segment", o.segmentCounterType]);
    if (o.orderFulfillDays !== null) {
      facts.push([
        "Fulfilled in",
        o.orderFulfillDays === 0 ? "Same day" : days(o.orderFulfillDays),
      ]);
    }
  }

  return (
    <div className="border-t border-divider bg-canvas px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>
          {o ? "Order behind this bill" : "This bill was not raised against an order"}
        </SectionLabel>
        <span className="text-[13px] text-muted">
          <Link
            href={`/crm/customers/${detail.customerId}`}
            className="no-underline hover:underline"
          >
            {detail.customerName}
          </Link>
          {" · "}
          Billed {money(detail.amount)} · {money(detail.paid)} received
        </span>
      </div>

      {facts.length ? (
        <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] tracking-wide text-muted uppercase">
                {label}
              </dt>
              <dd className="text-[13px] text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mb-1.5 flex items-baseline justify-between">
        <SectionLabel>
          {detail.lines.length
            ? `${detail.lines.length} item${detail.lines.length === 1 ? "" : "s"}`
            : "Items"}
        </SectionLabel>
        {/* Where the items came from decides how much of the row can be filled
            in, so it is said rather than left to be inferred from blanks. */}
        <span className="text-[11px] text-muted">{SOURCE_NOTE[detail.lineSource]}</span>
      </div>

      {detail.lines.length ? (
        <div className="overflow-x-auto rounded-[4px] border border-line bg-surface">
          <table className="w-full">
            <thead>
              <tr className="border-b border-divider">
                <ItemTh>Item</ItemTh>
                <ItemTh>Pack</ItemTh>
                <ItemTh align="right">Cans</ItemTh>
                <ItemTh align="right">Litres</ItemTh>
                <ItemTh align="right">Rate</ItemTh>
                <ItemTh align="right">Amount</ItemTh>
                <ItemTh align="right">Disc.</ItemTh>
                <ItemTh align="right">Final</ItemTh>
                <ItemTh>Tally bill</ItemTh>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l, i) => (
                <tr key={`${l.description}:${i}`} className="border-b border-divider last:border-0">
                  <ItemTd className="text-ink">
                    {l.description}
                    {l.subtitle ? (
                      <span className="block text-[11px] text-muted">{l.subtitle}</span>
                    ) : null}
                  </ItemTd>
                  <ItemTd>{l.packType ?? "—"}</ItemTd>
                  <ItemTd align="right">{l.cans ?? "—"}</ItemTd>
                  <ItemTd align="right">{l.litres === null ? "—" : trim(l.litres)}</ItemTd>
                  <ItemTd align="right">{l.ratePaise === null ? "—" : money(l.ratePaise)}</ItemTd>
                  <ItemTd align="right">
                    {l.amountPaise === null ? "—" : money(l.amountPaise)}
                  </ItemTd>
                  <ItemTd align="right">
                    {l.discountBp ? percent(l.discountBp) : "—"}
                  </ItemTd>
                  <ItemTd align="right" className="font-medium text-ink">
                    {l.finalAmountPaise === null ? "—" : money(l.finalAmountPaise)}
                  </ItemTd>
                  <ItemTd>{l.tallyBillNo ?? "—"}</ItemTd>
                </tr>
              ))}
              <tr className="border-t border-line bg-canvas">
                <ItemTd colSpan={2} className="font-medium text-ink">
                  Total
                </ItemTd>
                <ItemTd align="right" className="font-medium text-ink">
                  {t.cans ?? "—"}
                </ItemTd>
                <ItemTd align="right" className="font-medium text-ink">
                  {t.litres === null ? "—" : trim(t.litres)}
                </ItemTd>
                <ItemTd />
                <ItemTd align="right" className="font-medium text-ink">
                  {t.amountPaise === null ? "—" : money(t.amountPaise)}
                </ItemTd>
                <ItemTd />
                <ItemTd align="right" className="font-medium text-ink">
                  {t.finalAmountPaise === null ? "—" : money(t.finalAmountPaise)}
                </ItemTd>
                <ItemTd />
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-[4px] border border-line bg-surface px-3 py-4 text-[13px] text-muted">
          {SOURCE_NOTE.none}
        </p>
      )}

      {/* The bill's own figures already say how much was received. This says
          when it arrived and whether anybody has found it in the bank yet —
          reported money is not money the business has seen. */}
      {detail.receipts.length ? (
        <>
          <div className="mt-4 mb-1.5">
            <SectionLabel>Money against this bill</SectionLabel>
          </div>
          <div className="rounded-[4px] border border-line bg-surface">
            {detail.receipts.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 border-b border-divider px-3 py-2 text-[13px] last:border-0"
              >
                <span className="w-24 text-body">{shortDate(r.paidAt)}</span>
                <span className="w-28 font-medium text-ink">{money(r.amount)}</span>
                <span className="flex-1 truncate text-muted">
                  {r.mode}
                  {r.reference ? ` · ${r.reference}` : ""}
                </span>
                <Badge
                  tone={
                    r.status === "confirmed"
                      ? "success"
                      : r.status === "rejected"
                        ? "danger"
                        : "warn"
                  }
                >
                  {RECEIPT_LABEL[r.status]}
                </Badge>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Three sources, three different amounts of detail. An empty column on a
 * call-taken order means the catalogue carries no prices, not that the item
 * was free — so the panel says which record it is reading.
 */
const SOURCE_NOTE: Record<BillDetail["lineSource"], string> = {
  sheet: "From the order sheet",
  order: "From the imported order — the sheet rows behind it are gone",
  call: "Taken on a call · the catalogue carries no prices, so lines have no value",
  none: "Nothing recorded what was on this order",
};

const RECEIPT_LABEL: Record<BillDetail["receipts"][number]["status"], string> = {
  reported: "Reported",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** `1800` → `18%`, `250` → `2.5%`. Basis points, never a float. */
function percent(bp: number): string {
  return `${trim(bp / 100)}%`;
}

/** Two decimals at most, and none where the number is whole. */
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/* The inner table is denser than the ledger it sits inside, so it carries its
   own cells rather than borrowing Th/Td and then fighting their padding. */

function ItemTh({
  children,
  align,
}: {
  children?: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={cx(
        "px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted uppercase",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function ItemTd({
  children,
  align,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  align?: "right";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "px-3 py-1.5 text-[13px] text-body",
        align === "right" ? "text-right tabular-nums" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}
