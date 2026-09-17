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
import { financialYearLabel } from "@/lib/financial-year";
import { BillDetailPanel } from "@/components/bills/bill-detail-panel";
import { recordPayment } from "@/lib/actions/crm";
import {
  ageLabel,
  money,
  shortDate,
  today,
} from "@/lib/format";
import { PaymentModeFields } from "@/components/crm/payment-mode-fields";

/* ---------------------------------------------------------------------------
 * The Sales Bills ledger.
 *
 * ONE PAGE OF A YEAR, cut in Postgres. The filters, the sort and the page are
 * in the URL and the query applies them — this screen used to be handed every
 * bill of the financial year and filter, sort and slice it in the browser,
 * which made page one of seventy-two cost all seventy-two.
 *
 * What did NOT change is the rule that made it that way: the totals row, the
 * aging strip and the export describe the whole filtered year, and only the
 * table is paged. They are separate reads now rather than sums of an array
 * that happened to be lying around.
 * ------------------------------------------------------------------------- */

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

/** Columns that read as dates, which sort newest-first when first clicked. */
const DATE_KEYS: SortKey[] = ["billDate", "dueDate"];

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

type Totals = { billed: number; received: number; open: number; count: number };

export function BillsScreen({
  modes,
  datedModes,
  today: businessDay,
  scopeLabel,
  isManager,
  rows,
  total,
  page,
  perPage,
  sort,
  status,
  bucket,
  buckets,
  overdueBills,
  filteredTotals,
  yearTotals,
  customerFilter,
  financialYear,
  financialYears,
}: {
  /** `payments.modes` — the list is configuration, never a literal on a screen. */
  modes: string[];
  /** `payments.datedModes` — modes whose instrument carries a date of its own. */
  datedModes: string[];
  /** The business date, read on the server: the clock is not read during render. */
  today: string;
  scopeLabel: string;
  isManager: boolean;
  /** ONE PAGE. The figures around it describe far more than this. */
  rows: Row[];
  /** Every bill the filters match, from a count in Postgres. */
  total: number;
  page: number;
  perPage: number;
  sort: { key: SortKey; dir: "asc" | "desc" };
  status: string | null;
  bucket: string | null;
  /** Every band of the year's open bills, in order, drawn whether or not
      anything fell in it — a strip with bands missing reads as a strip that
      lost them. */
  buckets: Array<{ label: string; amount: number }>;
  overdueBills: number;
  /** What the filters match, for the row under the table. */
  filteredTotals: Totals;
  /** The whole year, for the strip above it. */
  yearTotals: Totals;
  customerFilter: { id: string; name: string } | null;
  /** The year on screen, and every year that has bills in it. */
  financialYear: string;
  financialYears: string[];
}) {
  const router = useRouter();
  const { run, push } = useToast();

  const [paying, setPaying] = React.useState<Row | null>(null);
  // One bill open at a time. A ledger with six rows expanded is a ledger you
  // have to scroll to compare two figures in.
  const [openBillId, setOpenBillId] = React.useState<string | null>(null);

  /*
   * EVERY CONTROL ON THIS SCREEN WRITES THE URL, because the server is what
   * answers them now. It is also what makes a filtered ledger a thing somebody
   * can send to a colleague, which it never was while the filters lived in
   * React state.
   */
  function go(next: Record<string, string | number | null>) {
    const params = new URLSearchParams();
    const base: Record<string, string | number | null> = {
      customer: customerFilter?.id ?? null,
      fy: financialYear,
      status,
      bucket,
      sort: sort.key,
      dir: sort.dir,
      page,
      per: perPage,
      ...next,
    };
    for (const [k, v] of Object.entries(base)) {
      if (v !== null && v !== "" && v !== undefined) params.set(k, String(v));
    }
    router.push(`/crm/bills?${params.toString()}`);
  }

  /* Narrowing returns to the first page — filtering down to twelve rows while
     sitting on page seven would otherwise show an empty table. */
  const narrow = (next: Record<string, string | number | null>) =>
    go({ ...next, page: 1 });

  function toggleSort(key: SortKey) {
    const dir =
      sort.key === key
        ? sort.dir === "asc"
          ? "desc"
          : "asc"
        : // A date column opens on the newest, everything else on the lowest.
          // Clicking "Date" and being shown 2024 is not what anybody meant.
          DATE_KEYS.includes(key)
          ? "desc"
          : "asc";
    // Re-sorting reorders the whole year, so page seven now holds different
    // rows entirely. Going back to the first page is the honest answer.
    narrow({ sort: key, dir });
  }

  const pages = Math.max(1, Math.ceil(total / perPage));
  const bucketTotal = buckets.reduce((a, b) => a + b.amount, 0);
  /* The export link carries exactly what the table is showing, which is the
     whole point of the filters being in the URL: one address, and the file and
     the screen cannot describe two different sets of bills. */
  const exportHref = (() => {
    const params = new URLSearchParams({ fy: financialYear });
    if (customerFilter) params.set("customer", customerFilter.id);
    if (status) params.set("status", status);
    if (bucket) params.set("bucket", bucket);
    return `/accounts/bills/export?${params.toString()}`;
  })();

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Sales bills"
        subtitle={`${scopeLabel} · Every bill with its aging bucket and payment status. Open a bill number to see what was ordered.`}
        actions={
          isManager ? (
            /*
             * THE WHOLE FILTERED YEAR, BUILT ON THE SERVER.
             *
             * This assembled the CSV from the array React was paging, which was
             * a whole year only because the whole year was in the browser. With
             * a page in hand that would have written out fifty bills under a
             * filename saying 26-27 — a file somebody opens, reads as the year,
             * and acts on. It is the Accounts app's own export route, not a
             * second one: the columns are the same columns and a second
             * definition of "the bill ledger as a file" is one that drifts.
             */
            <a
              href={exportHref}
              onClick={() => push("Building the file — the whole filtered year, not this page")}
              title="Download as CSV"
              className="inline-flex h-9 cursor-pointer items-center rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas"
            >
              Export
            </a>
          ) : (
            <Button variant="secondary" disabled title="Export is a manager action">
              Export
            </Button>
          )
        }
      />

      <MetricStrip
        metrics={[
          { label: "Bills", value: String(yearTotals.count) },
          {
            label: "Outstanding",
            value: money(yearTotals.open),
            tone: yearTotals.open ? "danger" : "ink",
          },
          {
            label: "Overdue bills",
            value: String(overdueBills),
            tone: overdueBills ? "danger" : "ink",
          },
          {
            // The oldest band names itself — "30+ days" already says "over",
            // and prefixing it gave "Over 30+ days".
            label: buckets.at(-1)?.label ?? "Oldest band",
            value: money(buckets.at(-1)?.amount ?? 0),
            tone: buckets.at(-1)?.amount ? "danger" : "ink",
          },
          { label: "Collected", value: money(yearTotals.received), tone: "success" },
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
          <span className="text-lg font-semibold text-ink">{money(yearTotals.open)}</span>
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
              onClick={() => narrow({ bucket: bucket === b.label ? null : b.label })}
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
          value={status ?? "All"}
          onChange={(e) => narrow({ status: e.target.value === "All" ? null : e.target.value })}
          className="h-8"
          aria-label="Payment status"
        >
          <option value="All">All</option>
          {(Object.keys(STATUS_LABEL) as Array<Row["status"]>).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          value={bucket ?? "All"}
          onChange={(e) => narrow({ bucket: e.target.value === "All" ? null : e.target.value })}
          className="h-8"
          aria-label="Aging bucket"
        >
          <option value="All">All</option>
          {buckets.map((b) => (
            <option key={b.label} value={b.label}>
              {b.label}
            </option>
          ))}
        </Select>
        <Select
          value={financialYear}
          /* A different year starts at its first page — carrying page seven
             across would land on an empty table in a year that has six. */
          onChange={(e) => narrow({ fy: e.target.value })}
          className="h-8"
          aria-label="Financial year"
        >
          {financialYears.map((y) => (
            <option key={y} value={y}>
              {financialYearLabel(y)}
            </option>
          ))}
        </Select>
        {status || bucket ? (
          <button
            onClick={() => narrow({ status: null, bucket: null })}
            className="h-8 cursor-pointer px-2.5 text-sm text-brand"
          >
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {total.toLocaleString("en-IN")} of {yearTotals.count.toLocaleString("en-IN")} bills ·{" "}
          {financialYearLabel(financialYear)}
        </span>
      </Card>

      <Card className="max-h-[calc(100vh-380px)] overflow-auto rounded-t-none">
        {rows.length ? (
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
                    {sort.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </Th>
                ))}
                <Th>Bucket</Th>
                <Th>Status</Th>
                <Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                <Tr className="hover:bg-canvas">
                  <Td className="font-medium text-ink">
                    {/* The bill number opens the order behind it. A ledger row
                        says how much and when; what was actually bought is the
                        question anybody reading it asks next. */}
                    <button
                      onClick={() =>
                        setOpenBillId(openBillId === r.id ? null : r.id)
                      }
                      aria-expanded={openBillId === r.id}
                      // No underline: a bill number is a row that opens, not a
                      // link off the page, and underlining every one of them
                      // reads as a page full of links. The chevron carries the
                      // affordance and the colour answers the hover.
                      className="inline-flex cursor-pointer items-center gap-1.5 text-left font-medium text-ink no-underline transition-colors hover:text-brand hover:no-underline"
                      title={openBillId === r.id ? "Hide the order" : "Show what was ordered"}
                    >
                      <span
                        aria-hidden
                        className={cx(
                          "text-[10px] text-muted transition-transform",
                          openBillId === r.id && "rotate-90",
                        )}
                      >
                        ▶
                      </span>
                      {r.billNo}
                    </button>
                  </Td>
                  <Td>{shortDate(r.billDate)}</Td>
                  <Td className={r.overdueDays > 0 ? "text-danger" : ""}>
                    {shortDate(r.dueDate)}
                  </Td>
                  <Td>
                    <Link
                      href={`/crm/customers/${r.customerId}`}
                      className="no-underline"
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
                {openBillId === r.id ? (
                  <tr>
                    <td colSpan={COLUMNS.length + 3} className="p-0">
                      {/* Keyed on the bill, so opening another row mounts a
                          fresh panel rather than resetting one in an effect. */}
                      <BillDetailPanel
                        key={r.id}
                        billId={r.id}
                        customerHref={(id) => `/crm/customers/${id}`}
                      />
                    </td>
                  </tr>
                ) : null}
                </React.Fragment>
              ))}
              {/* Everything the filters match, not this page — said in the row
                  itself so nobody reads it as a page subtotal. */}
              <tr className="border-t border-line bg-canvas">
                <Td colSpan={4} className="font-semibold text-ink">
                  Total · {filteredTotals.count.toLocaleString("en-IN")} bills
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {money(filteredTotals.billed)}
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {money(filteredTotals.received)}
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {money(filteredTotals.open)}
                </Td>
                <Td colSpan={4} />
              </tr>
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No bills match these filters"
            body={`Clear the status or aging filter, or try another year — this is ${financialYearLabel(financialYear)}.`}
          />
        )}
      </Card>

      {pages > 1 ? (
        <div className="mt-3 flex items-center gap-3">
          <Button variant="secondary" disabled={page === 1} onClick={() => go({ page: page - 1 })}>
            Previous
          </Button>
          {/* The honest sentence. `total` is a count(*) over the filtered year,
              so it stays true now that the browser holds twenty-five rows of
              it — before, both halves came from the same array and it could
              only ever have agreed with itself. */}
          <span className="text-[13px] text-muted">
            Page {page} of {pages} · showing {rows.length} of{" "}
            {total.toLocaleString("en-IN")}
          </span>
          <Button
            variant="secondary"
            disabled={page === pages}
            onClick={() => go({ page: page + 1 })}
          >
            Next
          </Button>
        </div>
      ) : null}

      <BillPaymentModal
        modes={modes}
        datedModes={datedModes}
        today={businessDay}
        bill={paying}
        onClose={() => setPaying(null)}
        onSubmit={async (amount, mode, reference, receivedOn, instrumentDate) => {
          if (!paying) return;
          const result = await run(
            recordPayment({
              billId: paying.id,
              amount,
              mode,
              reference,
              instrumentDate: instrumentDate || undefined,
              receivedOn,
            }),
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
  modes: string[];
  datedModes: string[];
  today: string;
  bill: Row | null;
  onClose: () => void;
  onSubmit: (
    amount: string,
    mode: string,
    reference: string,
    receivedOn: string,
    /** The date on the cheque, where the mode carries one. */
    instrumentDate: string,
  ) => Promise<void>;
};

/** Remounts per bill so the amount always defaults to that bill's balance. */
function BillPaymentModal(props: BillPaymentProps) {
  if (!props.bill) return null;
  return <BillPaymentModalBody key={props.bill.id} {...props} />;
}

function BillPaymentModalBody({ bill, onClose, onSubmit, modes, datedModes, today: businessDay }: BillPaymentProps) {
  const [amount, setAmount] = React.useState(
    String(Math.round((bill?.balance ?? 0) / 100)),
  );
  const [mode, setMode] = React.useState("Bank transfer");
  const [reference, setReference] = React.useState("");
  /** The date written on the cheque — see `payments.datedModes`. */
  const [instrumentDate, setInstrumentDate] = React.useState("");
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
                await onSubmit(amount, mode, reference, receivedOn, instrumentDate);
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
        <PaymentModeFields
          modes={modes}
          datedModes={datedModes}
          today={businessDay}
          mode={mode}
          onMode={setMode}
          reference={reference}
          onReference={setReference}
          instrumentDate={instrumentDate}
          onInstrumentDate={setInstrumentDate}
        />
      </div>
    </Modal>
  );
}
