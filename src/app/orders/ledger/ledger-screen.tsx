"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  PageHeader,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { CustomerSearch } from "../customer-search";
import { downloadCsv, toCsv } from "@/lib/csv";
import { money, signedMoney } from "@/lib/format";

type LedgerEntry = {
  at: string;
  kind: "bill" | "receipt";
  ref: string;
  detail: string;
  debit: number;
  credit: number;
  status: string | null;
  balance: number;
};

type Ledger = {
  customerId: string;
  customerName: string;
  openingBalance: number;
  entries: LedgerEntry[];
  totals: { billed: number; received: number; outstanding: number; onAccount: number };
  awaiting: { count: number; amount: number };
};

export function LedgerScreen({
  ledger,
  from,
  to,
}: {
  ledger: Ledger | null;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const { push } = useToast();

  if (!ledger) {
    return (
      <div className="max-w-[1100px] px-6 pt-6 pb-10">
        <PageHeader
          title="Customer account"
          subtitle="Everything billed and everything received, in order, with what was left after each line."
        />
        <CustomerSearch
          title="Whose account?"
          onPick={(hit) => router.push(`/orders/ledger?customer=${hit.customerId}`)}
        />
      </div>
    );
  }

  const navigate = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ customer: ledger.customerId });
    const next = { from, to, ...patch };
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    router.push(`/orders/ledger?${params}`);
  };

  return (
    <div className="max-w-[1280px] px-6 pt-6 pb-10">
      <PageHeader
        title={ledger.customerName}
        subtitle="Everything billed and everything received, in order. The running balance counts confirmed money only, so it agrees with what the customer owes."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => router.push("/orders/ledger")}
            >
              Another account
            </Button>
            <Button
              onClick={() => {
                downloadCsv(
                  `mahek-account-${ledger.customerName.toLowerCase().replace(/\W+/g, "-")}`,
                  toCsv(
                    ["Date", "Type", "Reference", "Detail", "Debit (₹)", "Credit (₹)", "Balance (₹)"],
                    ledger.entries.map((e) => [
                      e.at,
                      e.kind === "bill" ? "Bill" : "Payment",
                      e.ref,
                      e.detail,
                      e.debit ? String(Math.round(e.debit / 100)) : "",
                      e.credit ? String(Math.round(e.credit / 100)) : "",
                      String(Math.round(e.balance / 100)),
                    ]),
                  ),
                  [from, to],
                );
                push(`Exported ${ledger.entries.length} rows`);
              }}
            >
              Export
            </Button>
          </>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Outstanding", value: money(ledger.totals.outstanding) },
          { label: "Billed", value: money(ledger.totals.billed), sub: "in this range" },
          { label: "Received", value: money(ledger.totals.received), sub: "confirmed" },
          {
            label: "On account",
            value: money(ledger.totals.onAccount),
            sub: ledger.totals.onAccount ? "not yet against a bill" : undefined,
          },
          {
            label: "Awaiting confirmation",
            value: money(ledger.awaiting.amount),
            tone: ledger.awaiting.count ? "danger" : undefined,
            sub: ledger.awaiting.count
              ? `${ledger.awaiting.count} receipt${ledger.awaiting.count === 1 ? "" : "s"}`
              : undefined,
          },
        ]}
      />

      <Card className="mt-4">
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <Field label="From">
            <Input
              type="date"
              value={from}
              onChange={(e) => navigate({ from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              onChange={(e) => navigate({ to: e.target.value })}
            />
          </Field>
          {from || to ? (
            <Button variant="ghost" onClick={() => router.push(`/orders/ledger?customer=${ledger.customerId}`)}>
              Clear
            </Button>
          ) : null}
        </div>
      </Card>

      <Card className="mt-4 overflow-hidden">
        {ledger.entries.length ? (
          <table>
            <thead>
              <Tr>
                <Th>Date</Th>
                <Th>Reference</Th>
                <Th>Detail</Th>
                <Th align="right">Billed</Th>
                <Th align="right">Received</Th>
                <Th align="right">Balance</Th>
              </Tr>
            </thead>
            <tbody>
              {from ? (
                <Tr>
                  <Td colSpan={5} className="text-muted">
                    Opening balance
                  </Td>
                  <Td align="right" className="tabular-nums text-muted">
                    {money(ledger.openingBalance)}
                  </Td>
                </Tr>
              ) : null}
              {ledger.entries.map((e, i) => (
                <Tr key={`${e.at}-${e.ref}-${i}`}>
                  <Td>{e.at}</Td>
                  <Td>
                    <span
                      className={cx(
                        "font-medium",
                        e.status === "rejected" ? "text-muted line-through" : "text-ink",
                      )}
                    >
                      {e.ref}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-muted">{e.detail}</span>
                    {e.status === "reported" ? (
                      <Badge tone="warn" className="ml-2">
                        with accounts
                      </Badge>
                    ) : null}
                    {e.status === "rejected" ? (
                      <Badge tone="danger" className="ml-2">
                        never arrived
                      </Badge>
                    ) : null}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {e.debit ? money(e.debit) : "—"}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {e.credit ? money(e.credit) : "—"}
                  </Td>
                  <Td align="right" className="font-medium tabular-nums">
                    {signedMoney(e.balance)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="Nothing on this account"
            body={
              from || to
                ? "No bills or payments fall inside these dates."
                : "This customer has never been billed."
            }
          />
        )}
      </Card>

      {ledger.awaiting.count ? (
        <Card className="mt-4 border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <span className="text-sm text-warn-ink">
            {money(ledger.awaiting.amount)} across {ledger.awaiting.count}{" "}
            receipt{ledger.awaiting.count === 1 ? "" : "s"} has been reported and
            not yet confirmed. It is not in the balance above, and it will not be
            until somebody finds it.
          </span>
        </Card>
      ) : null}
    </div>
  );
}
