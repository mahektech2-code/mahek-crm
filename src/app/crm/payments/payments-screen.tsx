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
  cx,
} from "@/components/ui/primitives";
import { Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import {
  recordPayment,
  recordPromise,
  startStageOneBatch,
} from "@/lib/actions/crm";
import { toCsv, downloadCsv } from "@/lib/csv";
import {
  addDays,
  ageLabel,
  money,
  shortDate,
  signedMoney,
  stamp,
  today,
} from "@/lib/format";

import { PaymentPanel } from "@/components/crm/payment-panel";
import type {
  WorklistRow,
  PaymentFollowUpPlan,
  CollectionsMetrics,
} from "@/lib/services/payment-service";
import type { PayOutcomeDefinition } from "@/lib/services/payment-followup-service";

type Row = WorklistRow & {
  openBills: Array<{ id: string; billNo: string; balance: number; dueDate: string }>;
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

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

type Tab =
  | "calls"
  | "messages"
  | "all"
  | "stage1"
  | "stage2"
  | "stage3"
  | "promised";

export function PaymentsScreen({
  scopeLabel,
  isManager,
  rows,
  aging,
  workingDaysLeft,
  plan,
  outcomes,
  metrics,
  batchCount,
}: {
  scopeLabel: string;
  isManager: boolean;
  rows: Row[];
  aging: { total: number; buckets: Array<{ label: string; amount: number }> };
  workingDaysLeft: number;
  /** Today's cadence, from E7 — who is due a call, a message, or neither. */
  plan: PaymentFollowUpPlan;
  /** Declared server-side, so the form and the action cannot disagree. */
  outcomes: PayOutcomeDefinition[];
  /** Derived from bills, payments and promises — nothing stored. */
  metrics: CollectionsMetrics;
  /** How many stage 1 customers a batch would actually go to today. */
  batchCount: number;
}) {
  const router = useRouter();
  const { run, push } = useToast();

  // Opens on the calling list: it is the one list with work on it today.
  const [tab, setTab] = React.useState<Tab>("calls");
  const [query, setQuery] = React.useState("");
  const [slowOnly, setSlowOnly] = React.useState(false);
  const [monthEnd, setMonthEnd] = React.useState(false);
  const [promising, setPromising] = React.useState<Row | null>(null);
  const [paying, setPaying] = React.useState<Row | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);
  // The whole follow-up happens in the panel — a telecaller working a list of
  // twelve should not lose their place to look at a bill.
  const [openAt, setOpenAt] = React.useState<number | null>(null);

  // Only a real comparison: with no promise judged in the previous window
  // there is no trend, and inventing one would be worse than showing none.
  const keptDelta =
    metrics.promisesKeptPercent === null || metrics.promisesKeptPreviousPercent === null
      ? null
      : metrics.promisesKeptPercent - metrics.promisesKeptPreviousPercent;

  // The engine decides who is due; this only says why, beside the name.
  const callReason = new Map(plan.calls.map((c) => [c.customerId, c.reason]));
  const messageReason = new Map(plan.messages.map((m) => [m.customerId, m.reason]));
  const dueReason = tab === "messages" ? messageReason : callReason;
  const onCadenceTab = tab === "calls" || tab === "messages";
  // Held back from the channel being looked at, not from both at once.
  const heldBack = plan.heldBack.filter((h) =>
    tab === "messages" ? h.channel === "whatsapp" : h.channel === "call",
  );

  const buckets = {
    calls: rows.filter((r) => callReason.has(r.customerId)),
    messages: rows.filter((r) => messageReason.has(r.customerId)),
    all: rows,
    stage1: rows.filter((r) => r.stage === 1),
    stage2: rows.filter((r) => r.stage === 2),
    stage3: rows.filter((r) => r.stage === 3),
    promised: rows.filter((r) => Boolean(r.promisedDate)),
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
  const held = rows.filter((r) => r.held).length;

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Payment follow-up"
        subtitle={`${scopeLabel} · One row per customer. The stage tells you what to do - do that, then log it.`}
        actions={
          <>
          <Button
            variant="secondary"
            disabled={!isManager || batchCount === 0}
            title={
              !isManager
                ? "Bulk sending is a manager action"
                : batchCount === 0
                  ? "Nobody at stage 1 is due a reminder today - the four-day interval runs from the last one actually sent"
                  : `Queue the stage 1 reminder for ${plural(batchCount, "customer")}`
            }
            onClick={async () => {
              const result = await run(startStageOneBatch());
              // A batch is still sent one confirmed message at a time, on the
              // screen built for exactly that.
              if (result.ok) router.push("/crm/whatsapp");
            }}
          >
            Send stage 1 batch{batchCount ? ` · ${batchCount}` : ""}
          </Button>
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
          </>
        }
      />

      <MetricStrip
        metrics={[
          {
            label: "Outstanding",
            value: money(metrics.outstanding),
            tone: "danger",
            sub: plural(metrics.outstandingCustomers, "customer"),
            // Bills raised this week less what came in — the direction the
            // book actually moved, not a figure typed by hand.
            delta:
              metrics.outstandingChange === 0
                ? undefined
                : `${signedMoney(metrics.outstandingChange)} this week`,
            deltaTone: metrics.outstandingChange > 0 ? "danger" : "success",
          },
          {
            label: "Urgent stage",
            value: money(metrics.urgent),
            tone: "danger",
            sub: `${plural(metrics.urgentCustomers, "customer")} over ${metrics.urgentThresholdDays} days`,
          },
          {
            label: "Promised, still open",
            value: money(metrics.promisedOpen),
            sub: `${plural(metrics.promisedCount, "promise")} not yet due`,
          },
          {
            label: "Promises kept",
            value:
              metrics.promisesKeptPercent === null
                ? "-"
                : `${metrics.promisesKeptPercent}%`,
            tone:
              metrics.promisesKeptPercent !== null && metrics.promisesKeptPercent < 60
                ? "danger"
                : "ink",
            sub:
              metrics.promisesKeptPercent === null
                ? "no promise has come due yet"
                : `Last 30 days · ${plural(metrics.promisesJudged, "promise")}`,
            // Only shown when there is a previous window to compare with.
            delta: keptDelta === null ? undefined : `${keptDelta > 0 ? "+" : "−"}${Math.abs(keptDelta)} pts`,
            deltaTone: keptDelta !== null && keptDelta < 0 ? "danger" : "success",
          },
          {
            label: "Collected this month",
            value: money(metrics.collectedThisMonth),
            tone: "success",
            sub: `Against ${money(metrics.dueThisMonth)} due`,
            delta:
              metrics.collectedThisWeek > 0
                ? `+${money(metrics.collectedThisWeek)} this week`
                : undefined,
            deltaTone: "success",
          },
          {
            label: "To call today",
            value: String(buckets.calls.length),
            tone: buckets.calls.length ? "danger" : "ink",
            sub: buckets.calls.length ? "past the quiet window" : "nobody is due",
          },
          {
            label: "To message today",
            value: String(buckets.messages.length),
            sub: buckets.messages.length ? "payment reminders" : undefined,
          },
          {
            label: "Held (disputed)",
            value: String(held),
            tone: held ? "danger" : "ink",
            sub: held ? "not escalating" : undefined,
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
            Month-end push · {workingDaysLeft} working days left
          </span>
          <span className="text-sm text-body">
            Sorted by collectable value. Total collectable {money(total)} - chase the top
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

      {onCadenceTab && heldBack.length ? (
        <Card className="mb-3">
          <button
            onClick={() => setHeldOpen((o) => !o)}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
          >
            <span className="text-sm text-muted">
              {heldBack.length} customer{heldBack.length === 1 ? "" : "s"} held
              back from {tab === "messages" ? "today's messages" : "today's calls"}
            </span>
            <span className="flex-1" />
            <span className="text-[13px] text-muted">
              Nothing disappears silently - open this if somebody is missing
            </span>
          </button>
          {heldOpen ? (
            <div className="border-t border-divider py-1 pr-4 pl-10">
              {heldBack.map((h) => (
                <div
                  key={h.customerId}
                  className="flex items-center gap-3 border-b border-canvas py-1.5 last:border-0"
                >
                  <Link
                    href={`/crm/customers/${h.customerId}`}
                    className="w-[260px] text-sm text-body no-underline"
                  >
                    {h.name}
                  </Link>
                  <span className="text-[13px] text-muted">{h.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="overflow-hidden rounded-t-none">
        <Tabs
          value={tab}
          onChange={setTab}
          className="px-5"
          tabs={[
            { key: "calls", label: "Call today", count: buckets.calls.length },
            {
              key: "messages",
              label: "Message today",
              count: buckets.messages.length,
            },
            { key: "all", label: "All customers", count: buckets.all.length },
            { key: "stage1", label: "Stage 1 · WhatsApp nudge", count: buckets.stage1.length },
            { key: "stage2", label: "Stage 2 · WhatsApp and calls", count: buckets.stage2.length },
            { key: "stage3", label: "Stage 3 · Urgent", count: buckets.stage3.length },
            { key: "promised", label: "Promised", count: buckets.promised.length },
          ]}
        />

        {visible.length ? (
          <>
            {visible.map((r) => (
              <div
                key={r.customerId}
                onClick={() => setOpenAt(visible.indexOf(r))}
                className="flex cursor-pointer items-center gap-4 border-b border-divider px-5 py-3.5 last:border-0 hover:bg-canvas"
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
                    {/* Money reported and not yet found. The balance beside the
                        name has not moved, and without this that reads as
                        nobody having done anything about it. */}
                    {r.reportedAmount ? (
                      <Badge tone="warn">Reported paid · with accounts</Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 text-[13px] text-muted">
                    {r.overdueBillCount} bill{r.overdueBillCount === 1 ? "" : "s"} overdue ·
                    {/* The value is the last PAYMENT follow-up, not the last
                        time anybody spoke to them. Calling it "last contact"
                        told a telecaller they had never spoken to a customer
                        they rang on Tuesday. */}
                    oldest by {ageLabel(r.daysOverdue)} · last chased{" "}
                    {r.lastFollowUpAt ? stamp(r.lastFollowUpAt) : "never"}
                    {r.promisedDate
                      ? ` · promised ${money(r.promisedAmount ?? 0)} by ${shortDate(r.promisedDate)}`
                      : ""}
                    {r.heldReason ? ` · ${r.heldReason}` : ""}
                    {r.reportedAmount
                      ? ` · ${money(r.reportedAmount)} reported paid ${
                          r.reportedOn ? `on ${shortDate(r.reportedOn)}` : ""
                        }, waiting for accounts`
                      : ""}
                  </div>
                  {dueReason.get(r.customerId) &&
                  (tab === "calls" || tab === "messages") ? (
                    <div className="mt-0.5 text-[13px] text-brand">
                      {dueReason.get(r.customerId)}
                    </div>
                  ) : null}
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

                <div
                  className="flex flex-none items-center gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    size="sm"
                    variant={r.promiseBroken || r.stage === 3 ? "danger" : "primary"}
                    disabled={r.held}
                    title={r.held ? (r.heldReason ?? "Held while the dispute is open") : undefined}
                    // Stage 1 is WhatsApp-only, so that stage opens on the
                    // message; everything else opens on the log. Either way the
                    // work happens here rather than on another screen.
                    onClick={() => setOpenAt(visible.indexOf(r))}
                  >
                    {r.nextChannel === "whatsapp" ? "Send reminder" : "Log follow-up"}
                  </Button>
                  <RowMenu
                    items={[
                      {
                        label: "Open follow-up",
                        onSelect: () => setOpenAt(visible.indexOf(r)),
                      },
                      {
                        label: "Record a payment against a bill",
                        onSelect: () => setPaying(r),
                        disabled: !r.openBills.length,
                        title: r.openBills.length ? undefined : "No open bills",
                      },
                      {
                        label: "Record a promise",
                        onSelect: () => setPromising(r),
                        disabled: r.held,
                        title: r.held ? (r.heldReason ?? undefined) : undefined,
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

      <PaymentPanel
        target={
          openAt === null || !visible[openAt]
            ? null
            : {
                customerId: visible[openAt].customerId,
                index: openAt,
                total: visible.length,
              }
        }
        outcomes={outcomes}
        onClose={() => setOpenAt(null)}
        onMove={(delta) =>
          setOpenAt((at) =>
            at === null ? null : Math.min(visible.length - 1, Math.max(0, at + delta)),
          )
        }
        onSaved={() => {
          setOpenAt(null);
          router.refresh();
        }}
        onRefresh={() => router.refresh()}
        onSavedNext={() => {
          // The row just worked usually leaves the list on the next load, so
          // staying put lands on the following customer rather than skipping
          // one. At the end of the list, close.
          setOpenAt((at) =>
            at === null ? null : at >= visible.length - 1 ? null : at + 1,
          );
          router.refresh();
        }}
      />

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
        <VoiceTextarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onDictate={setNote}
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
