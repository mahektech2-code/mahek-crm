"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { applyOnAccountAction } from "@/lib/actions/accounts";
import { money } from "@/lib/format";
import type { OnAccountHolder } from "@/lib/services/on-account-service";
import {
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Row,
  ScreenHeader,
  Table,
  plural,
} from "../parts";

/* ---------------------------------------------------------------------------
 * Money on account.
 *
 * Real, confirmed money that is simply not pointed at anything yet. It was
 * created and consumed silently — `allocate()` makes these lines and nothing
 * listed them — so a customer could carry a credit for months while appearing
 * on the collections worklist for a bill that credit would have settled.
 * ------------------------------------------------------------------------- */

export function OnAccountScreen({
  holders,
  canApply,
}: {
  holders: OnAccountHolder[];
  canApply: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  const total = holders.reduce((a, h) => a + h.amount, 0);

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title="On account"
          subtitle="Money received against no bill. It is real, confirmed money — it is simply not pointed at anything yet."
        />

        <MetricRow
          metrics={[
            { label: "Held on account", value: money(total) },
            { label: "Customers", value: String(holders.length) },
          ]}
        />

        {holders.length === 0 ? (
          <Empty
            title="Nobody is holding a credit"
            body="Every payment received has been pointed at a bill. Money arrives here when a transfer is worth more than the bills it named, or lands before the bill exists."
          />
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={860}
              head={
                <>
                  <HeadCell>Customer</HeadCell>
                  <HeadCell align="right">On account</HeadCell>
                  <HeadCell>Owed</HeadCell>
                  <HeadCell>What to do with it</HeadCell>
                  <HeadCell />
                </>
              }
            >
              {holders.map((h, i) => {
                const can = Boolean(h.oldestOpenBillId) && canApply;
                const why = !canApply
                  ? "Only the accounts team can move money between bills"
                  : h.oldestOpenBillId
                    ? undefined
                    : "Nothing open to apply it to";
                return (
                  <Row key={h.customerId} striped={i % 2 === 1}>
                    <Cell className="font-medium text-ink">
                      <button
                        onClick={() =>
                          router.push(`/accounts/ledger?customer=${h.customerId}`)
                        }
                        className="cursor-pointer border-none bg-transparent p-0 text-sm font-medium text-ink hover:underline"
                      >
                        {h.customerName}
                      </button>
                      <span className="mt-px block text-[13px] font-normal text-muted">
                        across {plural(h.receipts, "receipt")}
                      </span>
                    </Cell>
                    <Cell align="right" className="font-medium text-ink">
                      {money(h.amount)}
                    </Cell>
                    <Cell className={h.outstanding > 0 ? "text-danger" : "text-muted"}>
                      {h.outstanding > 0
                        ? `${money(h.outstanding)} still owed`
                        : "Nothing owed"}
                    </Cell>
                    <Cell className="text-muted">
                      {h.oldestOpenBillId
                        ? `Would settle ${money(Math.min(h.amount, h.oldestOpenBalance))} of ${h.oldestOpenBillNo}, the oldest open bill`
                        : "Offered against their next bill"}
                    </Cell>
                    <Cell align="right">
                      <button
                        disabled={!can || busy === h.customerId}
                        title={why}
                        onClick={async () => {
                          setBusy(h.customerId);
                          const r = await run(applyOnAccountAction(h.customerId));
                          setBusy(null);
                          if (r.ok) router.refresh();
                        }}
                        className={cx(
                          "h-7.5 rounded-[4px] border px-3 text-[13px] font-medium whitespace-nowrap",
                          can
                            ? "cursor-pointer border-line-strong bg-surface text-body hover:bg-canvas"
                            : "cursor-not-allowed border-divider bg-surface text-line-strong",
                        )}
                      >
                        {busy === h.customerId ? "Applying…" : "Apply to a bill"}
                      </button>
                    </Cell>
                  </Row>
                );
              })}
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
