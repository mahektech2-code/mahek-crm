"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  MoneyInput,
  PageHeader,
  SectionLabel,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Modal, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { recordPayment } from "@/lib/actions/crm";
import { toCsv, downloadCsv } from "@/lib/csv";
import {
  ageLabel,
  money,
  shortDate,
  today,
} from "@/lib/format";

type Row = {
  id: string;
  billNo: string;
  customerId: string;
  customerName: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  overdueDays: number;
  bucket: string;
  status: "unpaid" | "partially_paid" | "paid";
  disputed: boolean;
};

const STATUS_LABEL: Record<Row["status"], string> = {
  unpaid: "Unpaid",
  partially_paid: "Partly paid",
  paid: "Paid",
};

/** Buckets are configurable, so colour by position rather than by label. */
const BUCKET_RAMP = ["#6835FB", "#B77B08", "#D97706", "#B3261E", "#7F1D1D"];

type SortKey =
  | "billNo"
  | "billDate"
  | "dueDate"
  | "customerName"
  | "amount"
  | "paid"
  | "balance"
  | "overdueDays";

const COLUMNS: Array<{ key: SortKey; label: string; align?: "right" }> = [
  { key: "billNo", label: "Bill no" },
  { key: "billDate", label: "Date" },
  { key: "dueDate", label: "Due" },
  { key: "customerName", label: "Customer" },
  { key: "amount", label: "Amount", align: "right" },
  { key: "paid", label: "Paid", align: "right" },
  { key: "balance", label: "Balance", align: "right" },
  { key: "overdueDays", label: "Overdue", align: "right" },
];

export function BillsScreen({
  scopeLabel,
  isManager,
  rows,
  aging,
  customerFilter,
}: {
  scopeLabel: string;
  isManager: boolean;
  rows: Row[];
  aging: { total: number; buckets: Array<{ label: string; amount: number }> };
  customerFilter: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const { run, push } = useToast();

  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "dueDate",
    dir: 1,
  });
  const [status, setStatus] = React.useState("All");
  const [bucket, setBucket] = React.useState("All");
  const [paying, setPaying] = React.useState<Row | null>(null);

  const scoped = customerFilter
    ? rows.filter((r) => r.customerId === customerFilter.id)
    : rows;

  const filtered = React.useMemo(() => {
    let list = scoped;
    if (status !== "All") list = list.filter((r) => r.status === status);
    if (bucket !== "All") list = list.filter((r) => r.bucket === bucket);
    return [...list].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv)) * sort.dir;
    });
  }, [scoped, status, bucket, sort]);

  const outstanding = scoped.reduce((a, r) => a + r.balance, 0);
  // Bucket labels come from configuration via the server; the screen only
  // re-totals them for whatever is currently filtered in.
  const buckets = aging.buckets.map(({ label }) => ({
    label,
    amount: scoped
      .filter((r) => r.balance > 0 && r.bucket === label)
      .reduce((a, r) => a + r.balance, 0),
  }));
  const bucketTotal = buckets.reduce((a, b) => a + b.amount, 0);

  const overdueCount = scoped.filter((r) => r.overdueDays > 0).length;

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  }

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Sales bills"
        subtitle={`${scopeLabel} · Every bill with its aging bucket and payment status. Sortable on any column.`}
        actions={
          <Button
            variant="secondary"
            disabled={!isManager}
            title={isManager ? "Download as CSV" : "Export is a manager action"}
            onClick={() => {
              downloadCsv(
                "mahek-bills",
                toCsv(
                  ["Bill no", "Date", "Due", "Customer", "Amount (₹)", "Paid (₹)", "Balance (₹)", "Overdue days", "Bucket", "Status"],
                  filtered.map((r) => [
                    r.billNo,
                    r.billDate,
                    r.dueDate,
                    r.customerName,
                    Math.round(r.amount / 100),
                    Math.round(r.paid / 100),
                    Math.round(r.balance / 100),
                    r.overdueDays,
                    r.bucket,
                    STATUS_LABEL[r.status],
                  ]),
                ),
                [
                  status === "All" ? null : STATUS_LABEL[status as Row["status"]],
                  bucket === "All" ? null : bucket,
                  customerFilter?.name ?? null,
                ],
              );
              push(`Exported ${filtered.length} rows`);
            }}
          >
            Export
          </Button>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Bills", value: String(scoped.length) },
          { label: "Outstanding", value: money(outstanding), tone: outstanding ? "danger" : "ink" },
          { label: "Overdue bills", value: String(overdueCount), tone: overdueCount ? "danger" : "ink" },
          {
            label: `Over ${buckets.at(-1)?.label ?? "90 days"}`,
            value: money(buckets.at(-1)?.amount ?? 0),
            tone: buckets.at(-1)?.amount ? "danger" : "ink",
          },
          {
            label: "Collected",
            value: money(scoped.reduce((a, r) => a + r.paid, 0)),
            tone: "success",
          },
        ]}
      />

      {customerFilter ? (
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => router.push("/crm/bills")}
            className="inline-flex h-6.5 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-canvas px-2 text-[13px] text-body"
          >
            Customer: {customerFilter.name} <span className="text-muted">×</span>
          </button>
        </div>
      ) : null}

      <Card className="mb-4 px-5 py-4">
        <div className="mb-2.5 flex items-baseline justify-between">
          <SectionLabel>Aging of outstanding balance</SectionLabel>
          <span className="text-lg font-semibold text-ink">{money(outstanding)}</span>
        </div>
        <div className="flex h-2.5 w-full overflow-hidden rounded-[2px] bg-divider">
          {buckets.map((b, i) => (
            <span
              key={b.label}
              title={`${b.label}: ${money(b.amount)}`}
              style={{
                width: bucketTotal ? `${(b.amount / bucketTotal) * 100}%` : "0%",
                background: BUCKET_RAMP[i] ?? BUCKET_RAMP.at(-1),
              }}
            />
          ))}
        </div>
        <div className="mt-2.5 flex gap-6">
          {buckets.map((b, i) => (
            <button
              key={b.label}
              onClick={() => setBucket(bucket === b.label ? "All" : b.label)}
              className={cx(
                "flex cursor-pointer items-center gap-1.5 text-[13px]",
                bucket === b.label ? "font-medium text-ink" : "text-body",
              )}
            >
              <span
                className="block h-2 w-2 rounded-full"
                style={{ background: BUCKET_RAMP[i] ?? BUCKET_RAMP.at(-1) }}
              />
              {b.label}
              <span className="font-medium text-ink">{money(b.amount)}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card className="flex items-center gap-2.5 rounded-b-none border-b-0 px-4 py-2.5">
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8"
        >
          <option value="All">All</option>
          {(Object.keys(STATUS_LABEL) as Array<Row["status"]>).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          className="h-8"
        >
          <option>All</option>
          {buckets.map((b) => (
            <option key={b.label}>{b.label}</option>
          ))}
        </Select>
        {status !== "All" || bucket !== "All" ? (
          <button
            onClick={() => {
              setStatus("All");
              setBucket("All");
            }}
            className="h-8 cursor-pointer px-2.5 text-sm text-brand"
          >
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {filtered.length} of {scoped.length} bills
        </span>
      </Card>

      <Card className="max-h-[calc(100vh-380px)] overflow-auto rounded-t-none">
        {filtered.length ? (
          <table>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <Th
                    key={c.key}
                    align={c.align}
                    onClick={() => toggleSort(c.key)}
                    className="cursor-pointer select-none hover:text-body"
                  >
                    {c.label}
                    {sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </Th>
                ))}
                <Th>Bucket</Th>
                <Th>Status</Th>
                <Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <Tr key={r.id} className="hover:bg-canvas">
                  <Td className="font-medium text-ink">{r.billNo}</Td>
                  <Td>{shortDate(r.billDate)}</Td>
                  <Td className={r.overdueDays > 0 ? "text-danger" : ""}>
                    {shortDate(r.dueDate)}
                  </Td>
                  <Td>
                    <Link
                      href={`/crm/customers/${r.customerId}`}
                      className="no-underline hover:underline"
                    >
                      {r.customerName}
                    </Link>
                  </Td>
                  <Td align="right">{money(r.amount)}</Td>
                  <Td align="right" className={r.paid ? "text-success" : ""}>
                    {money(r.paid)}
                  </Td>
                  <Td
                    align="right"
                    className={r.balance > 0 ? "font-medium text-danger" : "text-muted"}
                  >
                    {money(r.balance)}
                  </Td>
                  <Td align="right" className={r.overdueDays > 60 ? "text-danger" : ""}>
                    {r.overdueDays > 0 ? ageLabel(r.overdueDays) : "-"}
                  </Td>
                  <Td>{r.balance > 0 ? r.bucket : "-"}</Td>
                  <Td>
                    <Badge
                      tone={
                        r.status === "paid"
                          ? "success"
                          : r.status === "partially_paid"
                            ? "warn"
                            : "danger"
                      }
                    >
                      {STATUS_LABEL[r.status]}
                    </Badge>
                    {r.disputed ? (
                      <Badge tone="warn" className="ml-1.5">
                        Disputed
                      </Badge>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <span className="flex justify-end">
                      <RowMenu
                        items={[
                          {
                            label: "Record a payment",
                            onSelect: () => setPaying(r),
                            disabled: r.balance <= 0,
                            title: r.balance <= 0 ? "Already settled" : undefined,
                          },
                          {
                            label: "Open customer record",
                            onSelect: () => router.push(`/crm/customers/${r.customerId}`),
                          },
                          {
                            label: "Send WhatsApp reminder",
                            onSelect: () =>
                              router.push(`/crm/whatsapp?customer=${r.customerId}`),
                          },
                        ]}
                      />
                    </span>
                  </Td>
                </Tr>
              ))}
              <tr className="border-t border-line bg-canvas">
                <Td colSpan={4} className="font-semibold text-ink">
                  Total · {filtered.length} bills
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {money(filtered.reduce((a, r) => a + r.amount, 0))}
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {money(filtered.reduce((a, r) => a + r.paid, 0))}
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {money(filtered.reduce((a, r) => a + r.balance, 0))}
                </Td>
                <Td colSpan={4} />
              </tr>
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No bills match these filters"
            body="Clear the status or aging filter to see the full ledger."
          />
        )}
      </Card>

      <BillPaymentModal
        bill={paying}
        onClose={() => setPaying(null)}
        onSubmit={async (amount, mode, reference, receivedOn) => {
          if (!paying) return;
          const result = await run(
            recordPayment({ billId: paying.id, amount, mode, reference, receivedOn }),
          );
          if (result.ok) {
            setPaying(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

type BillPaymentProps = {
  bill: Row | null;
  onClose: () => void;
  onSubmit: (
    amount: string,
    mode: string,
    reference: string,
    receivedOn: string,
  ) => Promise<void>;
};

/** Remounts per bill so the amount always defaults to that bill's balance. */
function BillPaymentModal(props: BillPaymentProps) {
  if (!props.bill) return null;
  return <BillPaymentModalBody key={props.bill.id} {...props} />;
}

function BillPaymentModalBody({ bill, onClose, onSubmit }: BillPaymentProps) {
  const [amount, setAmount] = React.useState(
    String(Math.round((bill?.balance ?? 0) / 100)),
  );
  const [mode, setMode] = React.useState("Bank transfer");
  const [reference, setReference] = React.useState("");
  const [receivedOn, setReceivedOn] = React.useState(today());
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={Boolean(bill)}
      onClose={onClose}
      title={`Record payment · ${bill?.billNo ?? ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(amount, mode, reference, receivedOn);
              } finally {
                setBusy(false);
              }
            }}
          >
            Record payment
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">
        {bill?.customerName} · {money(bill?.balance ?? 0)} open of{" "}
        {money(bill?.amount ?? 0)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Amount received"
          hint={bill ? `Up to ${money(bill.balance)}` : undefined}
        >
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Received on">
          <Input
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {["Bank transfer", "Cheque", "Cash", "UPI"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label="Reference">
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UTR or cheque number"
          />
        </Field>
      </div>
    </Modal>
  );
}
