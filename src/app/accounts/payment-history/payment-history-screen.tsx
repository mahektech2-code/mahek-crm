"use client";

import * as React from "react";
import Link from "next/link";
import { useToast } from "@/components/ui/toast";
import { downloadCsv, toCsv } from "@/lib/csv";
import { money, stamp } from "@/lib/format";
import type { PaymentHistoryRow } from "@/lib/services/receipt-service";
import { Cell, Empty, HeadCell, MetricRow, Pill, Row, ScreenHeader, Table, plural } from "../parts";

/* ---------------------------------------------------------------------------
 * Everything the accounts team recorded or decided on, across every
 * customer — the record a hectic day of collections is checked against.
 *
 * Read-only, deliberately. Confirm/Hold/Reject/Reverse already live on
 * /accounts/payments (the confirm queue) and /accounts/ledger (the customer
 * statement) — this screen's one job is recall, not action, so every row
 * links out to the ledger rather than duplicating that wiring here.
 *
 * The filtering pattern — fetch a capped, windowed set server-side, filter
 * who/range/status/text entirely client-side against a server-supplied
 * `nowMs` — is the CRM's Call History screen's, reused because it is the
 * same shape of question ("what did I/we do, in order") for a different
 * kind of record.
 * ------------------------------------------------------------------------- */

const STATUS_TONE: Record<PaymentHistoryRow["status"], "success" | "warn" | "danger" | "neutral"> = {
  reported: "warn",
  held: "warn",
  confirmed: "success",
  rejected: "danger",
  reversed: "danger",
};

const STATUS_LABEL: Record<PaymentHistoryRow["status"], string> = {
  reported: "Reported",
  held: "Held",
  confirmed: "Confirmed",
  rejected: "Rejected",
  reversed: "Reversed",
};

const RANGES = ["Today", "Last 7 days", "This month", "All"] as const;
type Range = (typeof RANGES)[number];

function decidedByName(r: PaymentHistoryRow): string | null {
  switch (r.status) {
    case "confirmed":
      return r.confirmedByName;
    case "held":
      return r.heldByName;
    case "rejected":
    case "reversed":
      return r.decidedByName;
    case "reported":
      return null;
  }
}

function allocationSummary(r: PaymentHistoryRow): string {
  const billed = r.lines.filter((l) => l.billId);
  const onAccount = r.amount - billed.reduce((n, l) => n + l.amount, 0);
  const parts: string[] = [];
  if (billed.length) parts.push(plural(billed.length, "bill"));
  if (onAccount > 0) parts.push(`${money(onAccount)} on account`);
  return parts.join(" + ") || "—";
}

export function PaymentHistoryScreen({
  rows,
  capped,
  currentUserName,
  nowMs,
}: {
  rows: PaymentHistoryRow[];
  capped: boolean;
  currentUserName: string;
  nowMs: number;
}) {
  const { push } = useToast();
  const [query, setQuery] = React.useState("");
  const [who, setWho] = React.useState(currentUserName);
  const [range, setRange] = React.useState<Range>("Today");
  const [status, setStatus] = React.useState<"All" | PaymentHistoryRow["status"]>("All");

  const people = React.useMemo(() => {
    const names = new Set<string>();
    for (const r of rows) {
      for (const n of [r.reportedByName, r.heldByName, r.confirmedByName, r.decidedByName]) {
        if (n) names.add(n);
      }
    }
    return ["Everyone", ...[...names].sort()];
  }, [rows]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    // nowMs comes from the server render — no clock read during render.
    const cutoff =
      range === "Today"
        ? nowMs - 86_400_000
        : range === "Last 7 days"
          ? nowMs - 7 * 86_400_000
          : range === "This month"
            ? nowMs - 31 * 86_400_000
            : 0;

    return rows.filter((r) => {
      if (cutoff && new Date(r.createdAt).getTime() < cutoff) return false;
      if (status !== "All" && r.status !== status) return false;
      if (
        who !== "Everyone" &&
        r.reportedByName !== who &&
        r.heldByName !== who &&
        r.confirmedByName !== who &&
        r.decidedByName !== who
      ) {
        return false;
      }
      if (!q) return true;
      return (
        r.customerName.toLowerCase().includes(q) ||
        (r.reference ?? "").toLowerCase().includes(q) ||
        (r.note ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, who, range, status, nowMs]);

  const totals = React.useMemo(() => {
    const sum = (pred: (r: PaymentHistoryRow) => boolean) =>
      filtered.filter(pred).reduce((n, r) => n + r.amount, 0);
    const count = (pred: (r: PaymentHistoryRow) => boolean) => filtered.filter(pred).length;
    const awaiting = (r: PaymentHistoryRow) => r.status === "reported" || r.status === "held";
    const declined = (r: PaymentHistoryRow) => r.status === "rejected" || r.status === "reversed";
    return {
      total: { count: filtered.length, amount: filtered.reduce((n, r) => n + r.amount, 0) },
      confirmed: { count: count((r) => r.status === "confirmed"), amount: sum((r) => r.status === "confirmed") },
      awaiting: { count: count(awaiting), amount: sum(awaiting) },
      declined: { count: count(declined) },
    };
  }, [filtered]);

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title="Payment history"
          subtitle="Every payment recorded or decided on, newest first — the record a hectic day of collections is checked against. Read-only: open a row's customer to confirm, hold, reject or reverse."
          actions={
            <button
              onClick={() => {
                downloadCsv(
                  "mahek-payment-history",
                  toCsv(
                    ["When", "Customer", "Amount", "Mode", "Reference", "Allocation", "Status", "Recorded by", "Decided by"],
                    filtered.map((r) => [
                      r.createdAt,
                      r.customerName,
                      String(r.amount / 100),
                      r.mode,
                      r.reference ?? "",
                      allocationSummary(r),
                      STATUS_LABEL[r.status],
                      r.reportedByName ?? "",
                      decidedByName(r) ?? "",
                    ]),
                  ),
                  [who === "Everyone" ? null : who, range, status === "All" ? null : status, query || null],
                );
                push(`Exported ${plural(filtered.length, "row")}`);
              }}
              className="h-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body hover:bg-canvas"
            >
              Export
            </button>
          }
        />

        <MetricRow
          metrics={[
            { label: "In this view", value: plural(totals.total.count, "payment"), sub: money(totals.total.amount) },
            {
              label: "Confirmed",
              value: plural(totals.confirmed.count, "payment"),
              sub: money(totals.confirmed.amount),
              tone: totals.confirmed.count ? "success" : undefined,
            },
            {
              label: "Awaiting",
              value: plural(totals.awaiting.count, "payment"),
              sub: totals.awaiting.count ? money(totals.awaiting.amount) : undefined,
              tone: totals.awaiting.count ? "warn" : undefined,
            },
            {
              label: "Rejected / reversed",
              value: plural(totals.declined.count, "payment"),
              tone: totals.declined.count ? "danger" : undefined,
            },
          ]}
        />

        <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-[6px] border border-line bg-surface px-5 py-3.5">
          <Field label="Search">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Customer, reference or note"
              className="w-56 rounded-[4px] border border-line bg-canvas px-2 py-1 text-[13px]"
            />
          </Field>
          <Field label="Who">
            <select
              value={who}
              onChange={(e) => setWho(e.target.value)}
              className="rounded-[4px] border border-line bg-canvas px-2 py-1 text-[13px]"
            >
              {people.map((p) => (
                <option key={p} value={p}>
                  {p === currentUserName ? `${p} (you)` : p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Range">
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as Range)}
              className="rounded-[4px] border border-line bg-canvas px-2 py-1 text-[13px]"
            >
              {RANGES.map((r) => (
                <option key={r} value={r}>
                  {r === "All" ? "All (last 90 days)" : r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="rounded-[4px] border border-line bg-canvas px-2 py-1 text-[13px]"
            >
              <option value="All">Every status</option>
              {(Object.keys(STATUS_LABEL) as PaymentHistoryRow["status"][]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {capped ? (
          <p className="mb-2 text-[13px] text-muted">
            Showing the newest {plural(rows.length, "payment")} from the last 90 days — narrow the range or ask
            for a wider window if something older is missing.
          </p>
        ) : null}

        {filtered.length === 0 ? (
          <Empty
            title={rows.length === 0 ? "Nothing recorded yet" : "Nothing matches these filters"}
            body={
              rows.length === 0
                ? "Recording a payment writes a row here the moment it happens."
                : "Widen the range, clear the search, or switch Who to Everyone."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={1280}
              head={
                <>
                  <HeadCell width={110}>When</HeadCell>
                  <HeadCell width={200}>Customer</HeadCell>
                  <HeadCell align="right" width={110}>
                    Amount
                  </HeadCell>
                  <HeadCell width={160}>Mode / reference</HeadCell>
                  <HeadCell width={140}>Allocation</HeadCell>
                  <HeadCell width={240}>Status</HeadCell>
                  <HeadCell width={130}>Recorded by</HeadCell>
                  <HeadCell width={130}>Decided by</HeadCell>
                </>
              }
            >
              {filtered.map((r, i) => (
                <Row key={r.receiptId} striped={i % 2 === 1}>
                  <Cell>{stamp(r.createdAt)}</Cell>
                  <Cell truncate={200}>
                    <Link
                      href={`/accounts/ledger?customer=${r.customerId}`}
                      className="no-underline"
                    >
                      {r.customerName}
                    </Link>
                  </Cell>
                  <Cell align="right">{money(r.amount)}</Cell>
                  <Cell truncate={160}>{`${r.mode}${r.reference ? ` · ${r.reference}` : ""}`}</Cell>
                  <Cell truncate={140}>{allocationSummary(r)}</Cell>
                  <Cell truncate={240}>
                    <span title={r.sentence}>
                      <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>
                      <span className="ml-1.5 text-[12px] text-muted">{r.sentence}</span>
                    </span>
                  </Cell>
                  <Cell truncate={130}>{r.reportedByName ?? "—"}</Cell>
                  <Cell truncate={130}>{decidedByName(r) ?? "—"}</Cell>
                </Row>
              ))}
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      {children}
    </label>
  );
}
