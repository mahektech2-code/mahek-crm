"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  MoneyInput,
  PageHeader,
  Select,
  SlowPayerBadge,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { recordPayment, recordPromise } from "@/lib/actions/crm";
import { toCsv, downloadCsv } from "@/lib/csv";
import { addDays, ageLabel, money, shortDate, stamp, today } from "@/lib/format";

import type { WorklistRow } from "@/lib/services/payment-service";

type Row = WorklistRow & {
  openBills: Array<{ id: string; billNo: string; balance: number; dueDate: string }>;
};

/** Stage is the engine's, not the interface's — 1, 2, 3 and nothing else. */
const STAGE_LABEL: Record<number, string> = {
  1: "Stage 1 · nudge",
  2: "Stage 2 · call",
  3: "Stage 3 · escalate",
};
const STAGE_TONE: Record<number, "danger" | "warn" | "brand"> = {
  1: "brand",
  2: "warn",
  3: "danger",
};

type Tab = "all" | "chase" | "promised" | "escalate";

export function PaymentsScreen({
  scopeLabel,
  isManager,
  rows,
  aging,
}: {
  scopeLabel: string;
  isManager: boolean;
  rows: Row[];
  aging: { total: number; buckets: Array<{ label: string; amount: number }> };
}) {
  const router = useRouter();
  const { run, push } = useToast();

  const [tab, setTab] = React.useState<Tab>("all");
  const [query, setQuery] = React.useState("");
  const [slowOnly, setSlowOnly] = React.useState(false);
  const [monthEnd, setMonthEnd] = React.useState(false);
  const [promising, setPromising] = React.useState<Row | null>(null);
  const [paying, setPaying] = React.useState<Row | null>(null);

  const buckets = {
    all: rows,
    chase: rows.filter((r) => !r.held && !r.promisedDate && r.stage < 3),
    promised: rows.filter((r) => Boolean(r.promisedDate)),
    escalate: rows.filter((r) => r.stage === 3 || r.promiseBroken),
  };

  const visible = React.useMemo(() => {
    let list = buckets[tab];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q));
    if (slowOnly) list = list.filter((r) => r.slowPayer);
    return monthEnd
      ? [...list].sort((a, b) => b.totalOverdue - a.totalOverdue)
      : [...list].sort((a, b) => b.daysOverdue - a.daysOverdue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query, slowOnly, monthEnd, rows]);

  const total = visible.reduce((a, r) => a + r.totalOverdue, 0);
  const broken = rows.filter((r) => r.promiseBroken).length;
  const held = rows.filter((r) => r.held).length;

  return (
    <div className="max-w-[1400px] px-6 pt-6 pb-10">
      <PageHeader
        title="Payment follow-up"
        subtitle={`${scopeLabel} · One row per customer. The stage tells you what to do — do that, then log it.`}
        actions={
          <Button
            variant="secondary"
            disabled={!isManager}
            title={isManager ? "Download as CSV" : "Export is a manager action"}
            onClick={() => {
              downloadCsv(
                "mahek-collections",
                toCsv(
                  ["Customer", "Owner", "Stage", "Bills overdue", "Oldest (days)", "Outstanding (₹)", "Next action"],
                  visible.map((r) => [
                    r.name,
                    r.ownerName ?? "",
                    STAGE_LABEL[r.stage] ?? r.stage,
                    r.overdueBillCount,
                    r.daysOverdue,
                    Math.round(r.totalOverdue / 100),
                    r.nextAction,
                  ]),
                ),
                [tab === "all" ? null : tab, slowOnly ? "slow-payers" : null,
                 monthEnd ? "month-end" : null, query || null],
              );
              push(`Exported ${visible.length} rows`);
            }}
          >
            Export
          </Button>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Collectable", value: money(total), tone: "danger" },
          { label: "Customers", value: String(visible.length) },
          {
            label: "Promises broken",
            value: String(broken),
            tone: broken ? "danger" : "ink",
            sub: broken ? "call these today" : undefined,
          },
          {
            label: "Held (disputed)",
            value: String(held),
            tone: held ? "danger" : "ink",
            sub: held ? "not escalating" : undefined,
          },
          {
            label: "Average per customer",
            value: money(visible.length ? Math.round(total / visible.length) : 0),
          },
        ]}
      />

      <Card className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Ageing
        </span>
        {aging.buckets.map((b) => (
          <span key={b.label} className="text-[13px] text-body">
            {b.label}{" "}
            <span className="font-medium text-ink">{money(b.amount)}</span>
          </span>
        ))}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {money(aging.total)} outstanding in all
        </span>
      </Card>

      {monthEnd ? (
        <Callout tone="warn">
          <span className="text-sm font-medium text-warn-ink">
            Month-end push
          </span>
          <span className="text-sm text-body">
            Sorted by collectable value. Total collectable {money(total)} — chase the top
            of this list first.
          </span>
        </Callout>
      ) : null}

      <Card className="flex items-center gap-2.5 rounded-b-none border-b-0 px-4 py-2.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search customers"
          className="h-8 w-[220px]"
        />
        <Checkbox
          label="Slow payers only"
          checked={slowOnly}
          onChange={(e) => setSlowOnly(e.target.checked)}
        />
        <button
          onClick={() => setMonthEnd((m) => !m)}
          className={cx(
            "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
            monthEnd
              ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
              : "border-line bg-surface text-body hover:bg-canvas",
          )}
        >
          Month-end view
        </button>
        {query || slowOnly || monthEnd ? (
          <button
            onClick={() => {
              setQuery("");
              setSlowOnly(false);
              setMonthEnd(false);
            }}
            className="h-8 cursor-pointer px-2.5 text-sm text-brand"
          >
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          Sorted by {monthEnd ? "value" : "age"}
        </span>
      </Card>

      <Card className="overflow-hidden rounded-t-none">
        <Tabs
          value={tab}
          onChange={setTab}
          className="px-5"
          tabs={[
            { key: "all", label: "All", count: buckets.all.length },
            { key: "chase", label: "To chase", count: buckets.chase.length },
            { key: "promised", label: "Promised", count: buckets.promised.length },
            { key: "escalate", label: "Escalate", count: buckets.escalate.length },
          ]}
        />

        {visible.length ? (
          <>
            {visible.map((r) => (
              <div
                key={r.customerId}
                className="flex items-center gap-4 border-b border-divider px-5 py-3.5 last:border-0 hover:bg-canvas"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Link
                      href={`/crm/customers/${r.customerId}`}
                      className="truncate text-sm font-medium text-ink no-underline hover:underline"
                    >
                      {r.name}
                    </Link>
                    <Badge tone={STAGE_TONE[r.stage] ?? "neutral"}>
                      {STAGE_LABEL[r.stage] ?? `Stage ${r.stage}`}
                    </Badge>
                    {r.slowPayer ? <SlowPayerBadge /> : null}
                    {r.held ? <Badge tone="warn">Held</Badge> : null}
                    {r.promiseBroken ? <Badge tone="danger">Promise broken</Badge> : null}
                  </div>
                  <div className="mt-1 text-[13px] text-muted">
                    {r.overdueBillCount} bill{r.overdueBillCount === 1 ? "" : "s"} overdue ·
                    oldest by {ageLabel(r.daysOverdue)} · last contact{" "}
                    {r.lastFollowUpAt ? stamp(r.lastFollowUpAt) : "never"}
                    {r.promisedDate
                      ? ` · promised ${money(r.promisedAmount ?? 0)} by ${shortDate(r.promisedDate)}`
                      : ""}
                    {r.heldReason ? ` · ${r.heldReason}` : ""}
                  </div>
                </div>

                <div className="w-[130px] flex-none text-right">
                  <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    Outstanding
                  </div>
                  <div className="text-sm font-medium text-danger">
                    {money(r.totalOverdue)}
                  </div>
                </div>

                <div className="w-[180px] flex-none">
                  <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    Next action
                  </div>
                  <div className="text-sm font-medium whitespace-nowrap text-ink">
                    {r.nextAction}
                  </div>
                </div>

                <div className="flex flex-none items-center gap-2">
                  <Button
                    size="sm"
                    variant={r.promiseBroken || r.stage === 3 ? "danger" : "primary"}
                    disabled={r.held}
                    title={r.held ? (r.heldReason ?? "Held while the dispute is open") : undefined}
                    onClick={() =>
                      // Stage 1 is WhatsApp-only. The engine rejects a stage-1
                      // call attempt, so the button must not offer one.
                      r.nextChannel === "whatsapp"
                        ? router.push(`/crm/whatsapp?customer=${r.customerId}`)
                        : setPromising(r)
                    }
                  >
                    {r.nextChannel === "whatsapp" ? "Send reminder" : "Record promise"}
                  </Button>
                  <RowMenu
                    items={[
                      {
                        label: "Record a payment",
                        onSelect: () => setPaying(r),
                        disabled: !r.openBills.length,
                        title: r.openBills.length ? undefined : "No open bills",
                      },
                      {
                        label: "Send WhatsApp reminder",
                        onSelect: () => router.push(`/crm/whatsapp?customer=${r.customerId}`),
                      },
                      {
                        label: "See their bills",
                        onSelect: () => router.push(`/crm/bills?customer=${r.customerId}`),
                      },
                      {
                        label: "Open customer record",
                        onSelect: () => router.push(`/crm/customers/${r.customerId}`),
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
            <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
              Showing {visible.length} customers · {money(total)} collectable
            </div>
          </>
        ) : (
          <EmptyState
            title="Nothing to chase in this tab"
            body="Every overdue bill in this filter has either been paid or has a live promise against it."
          />
        )}
      </Card>

      <PromiseModal
        row={promising}
        onClose={() => setPromising(null)}
        onSubmit={async (amount, promisedBy, note) => {
          if (!promising) return;
          const result = await run(
            recordPromise({
              customerId: promising.customerId,
              amount,
              promisedBy,
              note,
            }),
          );
          if (result.ok) {
            setPromising(null);
            router.refresh();
          }
        }}
      />

      <PaymentModal
        row={paying}
        onClose={() => setPaying(null)}
        onSubmit={async (billId, amount, mode, reference, receivedOn) => {
          const result = await run(
            recordPayment({ billId, amount, mode, reference, receivedOn }),
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

type PromiseProps = {
  row: Row | null;
  onClose: () => void;
  onSubmit: (amount: string, promisedBy: string, note: string) => Promise<void>;
};

/** Remounts per customer so the amount defaults to their own balance. */
function PromiseModal(props: PromiseProps) {
  if (!props.row) return null;
  return <PromiseModalBody key={props.row.customerId} {...props} />;
}

function PromiseModalBody({ row, onClose, onSubmit }: PromiseProps) {
  const [amount, setAmount] = React.useState(
    String(Math.round((row?.totalOverdue ?? 0) / 100)),
  );
  const [promisedBy, setPromisedBy] = React.useState(addDays(today(), 7));
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title="Record payment promise"
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
                await onSubmit(amount, promisedBy, note);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save promise
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">
        {row?.name} · {money(row?.totalOverdue ?? 0)} overdue
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount promised">
          <MoneyInput
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="2,00,000"
          />
        </Field>
        <Field label="Promised by">
          <Input
            type="date"
            value={promisedBy}
            onChange={(e) => setPromisedBy(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Note" className="mt-3">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="h-16"
          placeholder="Who promised, and how it will be paid"
        />
      </Field>
      <div className="mt-3 rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
        A reminder will be created for {shortDate(addDays(promisedBy, 1))} so this promise
        is chased if the payment does not arrive.
      </div>
    </Modal>
  );
}

type PaymentProps = {
  row: Row | null;
  onClose: () => void;
  onSubmit: (
    billId: string,
    amount: string,
    mode: string,
    reference: string,
    receivedOn: string,
  ) => Promise<void>;
};

function PaymentModal(props: PaymentProps) {
  if (!props.row) return null;
  return <PaymentModalBody key={props.row.customerId} {...props} />;
}

function PaymentModalBody({ row, onClose, onSubmit }: PaymentProps) {
  const [billId, setBillId] = React.useState(row?.openBills[0]?.id ?? "");
  const [amount, setAmount] = React.useState(
    String(Math.round((row?.openBills[0]?.balance ?? 0) / 100)),
  );
  const [mode, setMode] = React.useState("Bank transfer");
  const [reference, setReference] = React.useState("");
  const [receivedOn, setReceivedOn] = React.useState(today());
  const [busy, setBusy] = React.useState(false);

  const bill = row?.openBills.find((b) => b.id === billId);

  return (
    <Modal
      open={Boolean(row)}
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
                await onSubmit(billId, amount, mode, reference, receivedOn);
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
      <div className="mb-3 text-sm text-muted">{row?.name}</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Against bill" className="col-span-2">
          <Select
            value={billId}
            onChange={(e) => {
              setBillId(e.target.value);
              const next = row?.openBills.find((b) => b.id === e.target.value);
              if (next) setAmount(String(Math.round(next.balance / 100)));
            }}
          >
            {row?.openBills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.billNo} · {money(b.balance)} open · due {shortDate(b.dueDate)}
              </option>
            ))}
          </Select>
        </Field>
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
