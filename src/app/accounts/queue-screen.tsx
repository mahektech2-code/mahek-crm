"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SlowPayerBadge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { money } from "@/lib/format";
import { AccountsIcon } from "./icons";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pager,
  Pill,
  Row,
  ScreenHeader,
  Table,
  plural,
  staleLabel,
  waitingWords,
  type AccountsMetric,
} from "./parts";
import { QUEUE_COPY, type QueueKind, type QueueRow } from "./queue-types";
import { ReviewDrawer } from "./review-drawer";

/* ---------------------------------------------------------------------------
 * One queue screen, three queues.
 *
 * Oldest first in all three, because the longest wait is the one costing
 * something: an order nobody has approved is a customer wondering, and a
 * payment nobody has confirmed is a customer not being chased for money that
 * may never have arrived.
 *
 * j and k move, Enter opens, a and d decide. Telecallers have had that in the
 * CRM since the beginning; this desk works the same lists all day and had
 * nothing.
 * ------------------------------------------------------------------------- */

export function QueueScreen({
  kind,
  rows,
  canDecide,
  staleHours,
  quietDays,
}: {
  kind: QueueKind;
  rows: QueueRow[];
  canDecide: boolean;
  staleHours: number;
  quietDays: number;
}) {
  const router = useRouter();
  const { run } = useToast();
  const copy = QUEUE_COPY[kind];

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(rows[0]?.id ?? null);
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);

  /*
   * A HELD payment is not a neglected one, and the two must not be counted
   * together.
   *
   * "Waiting more than 24 hours" on a reported payment means the customer's
   * quiet is about to lapse and they will be chased for money nobody has
   * looked for. On a hold it means somebody is part-way through a bank
   * statement, the customer is quiet indefinitely by design, and none of that
   * sentence is true. Holds have their own ageing — `payments.holdStaleDays` —
   * which arrives on the row as `needsAttention`.
   */
  const stale = rows.filter((r) => !r.held && r.waitingHours > staleHours);
  const staleHolds = rows.filter((r) => r.held && r.needsAttention);
  const shown = rows.slice((page - 1) * perPage, page * perPage);
  const open = rows.find((r) => r.id === openId) ?? null;

  // Keyboard. Disabled while the drawer is open for movement keys, because
  // j and k there would move a list the reader cannot see.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing || openId) return;

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const at = shown.findIndex((r) => r.id === selected);
        const next = Math.min(
          shown.length - 1,
          Math.max(0, at < 0 ? 0 : at + (e.key === "j" ? 1 : -1)),
        );
        if (shown[next]) setSelected(shown[next].id);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const id = selected ?? shown[0]?.id;
        if (id) setOpenId(id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shown, selected, openId]);

  const metrics = buildMetrics(kind, rows, stale.length, staleHours);

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader title={copy.title} subtitle={copy.subtitle} />

        <MetricRow metrics={metrics} />

        {!canDecide ? (
          <Banner tone="warn" title="You can see this queue but not decide on it">
            {copy.managerNotice}
          </Banner>
        ) : null}

        {kind === "payments" && stale.length ? (
          <Banner
            tone="danger"
            title={`${plural(stale.length, "payment")} ${stale.length === 1 ? "has" : "have"} been waiting more than ${plural(staleHours, "hour")}`}
          >
            A customer is left alone for {plural(quietDays, "day")} on the strength of a
            reported payment — after that they are chased again, whether or not this was
            ever decided.
          </Banner>
        ) : null}

        {/*
          A separate sentence, because a hold fails the opposite way. Nothing
          lapses and nobody gets chased — the customer simply stays silent for
          as long as the hold sits there, which is why an old one is expensive
          and why this is the only thing that surfaces it.
        */}
        {kind === "payments" && staleHolds.length ? (
          <Banner
            tone="warn"
            title={`${plural(staleHolds.length, "payment")} ${staleHolds.length === 1 ? "has" : "have"} been on hold a long time`}
          >
            A hold does not expire. Those customers are getting no calls and no reminder
            messages, and will not until somebody approves or rejects the payment.
          </Banner>
        ) : null}

        {rows.length === 0 ? (
          <Empty
            icon={<AccountsIcon name="check" size={24} stroke="#1D7A45" />}
            title={copy.emptyTitle}
            body={copy.emptyBody}
          />
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={1160}
              head={
                <>
                  <HeadCell width={320}>{copy.columns[0]}</HeadCell>
                  <HeadCell>{copy.columns[1]}</HeadCell>
                  <HeadCell align={kind === "orders" ? "right" : "left"}>
                    {copy.columns[2]}
                  </HeadCell>
                  <HeadCell>{copy.columns[3]}</HeadCell>
                  <HeadCell align="right">{copy.columns[4]}</HeadCell>
                  <HeadCell>{copy.columns[5]}</HeadCell>
                  <HeadCell width={96} />
                </>
              }
            >
              {shown.map((r, i) => (
                <Row
                  key={r.id}
                  striped={i % 2 === 1}
                  selected={selected === r.id}
                  onClick={() => {
                    setSelected(r.id);
                    setOpenId(r.id);
                  }}
                >
                  <td
                    className="overflow-hidden px-4 py-2.5 align-middle"
                    style={{ width: 320, maxWidth: 320 }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        title={r.customerName}
                        className="truncate text-sm font-medium text-ink"
                      >
                        {r.customerName}
                      </span>
                      {r.slowPayer ? <SlowPayerBadge /> : null}
                      {r.overdueBills ? (
                        <Pill tone="danger">{r.overdueBills} overdue</Pill>
                      ) : null}
                    </span>
                    {/* The contact line, or the complaint. Truncated, so the
                        full text is on the title for anything that overflows. */}
                    <span
                      title={r.byMeta}
                      className="mt-0.5 block truncate text-[13px] text-muted"
                    >
                      {r.byMeta}
                    </span>
                  </td>
                  <Cell truncate={190}>
                    <span className="block truncate text-sm text-body">
                      {r.byName ?? "—"}
                    </span>
                    <span className="mt-px block truncate text-[13px] text-muted">
                      {r.byWhen}
                    </span>
                  </Cell>
                  <Cell
                    align={kind === "orders" ? "right" : "left"}
                    className={
                      r.contextTone === "danger"
                        ? "font-medium text-danger"
                        : r.contextTone === "warn"
                          ? "text-warn-ink"
                          : r.contextTone === "muted"
                            ? "text-muted"
                            : undefined
                    }
                  >
                    {r.context}
                  </Cell>
                  <Cell
                    truncate={190}
                    className={r.needsAttention ? "text-warn-ink" : undefined}
                  >
                    <span className="block truncate">{r.middle}</span>
                    {r.middleSub ? (
                      <span className="mt-px block truncate text-[13px] text-muted">
                        {r.middleSub}
                      </span>
                    ) : null}
                  </Cell>
                  <Cell align="right" className="font-medium text-ink">
                    {money(r.amount)}
                  </Cell>
                  <Cell>
                    {r.waitingHours > staleHours ? (
                      <Pill tone="danger">{waitingWords(r.waitingHours)}</Pill>
                    ) : (
                      <span className="text-sm text-body">
                        {waitingWords(r.waitingHours)}
                      </span>
                    )}
                  </Cell>
                  <Cell align="right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(r.id);
                        setOpenId(r.id);
                      }}
                      className="h-7.5 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-body hover:bg-canvas"
                    >
                      Review
                    </button>
                  </Cell>
                </Row>
              ))}
            </Table>

            <Pager
              total={rows.length}
              page={page}
              perPage={perPage}
              note="Oldest first, because the longest wait is the one costing something"
              onPage={setPage}
              onPerPage={(n) => {
                setPerPage(n);
                setPage(1);
              }}
            />
          </div>
        )}
      </div>

      {open ? (
        <ReviewDrawer
          // A different row remounts with fresh state rather than being reset
          // by an effect — no half-typed reason survives the switch.
          key={open.id}
          kind={kind}
          row={open}
          canDecide={canDecide}
          run={run}
          onClose={() => setOpenId(null)}
          onDecided={() => {
            setOpenId(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function buildMetrics(
  kind: QueueKind,
  rows: QueueRow[],
  stale: number,
  staleHours: number,
): AccountsMetric[] {
  const value = rows.reduce((a, r) => a + r.amount, 0);
  const oldest = rows[0];

  if (kind === "orders") {
    const withDebt = rows.filter((r) => r.contextTone === "danger").length;
    return [
      { label: "Waiting", value: String(rows.length) },
      { label: "Value held", value: money(value), sub: "none of it billed yet" },
      {
        label: "With money owed",
        value: String(withDebt),
        sub: withDebt ? "customer already owes" : undefined,
      },
      {
        label: staleLabel(staleHours),
        value: String(stale),
        sub: stale && oldest ? `longest is ${waitingWords(oldest.waitingHours)}` : undefined,
        tone: stale ? "danger" : undefined,
      },
    ];
  }

  if (kind === "payments") {
    return [
      { label: "Waiting", value: String(rows.length) },
      { label: "Value claimed", value: money(value), sub: "not in the ledger" },
      {
        label: staleLabel(staleHours),
        value: String(stale),
        sub: stale ? "customer is going unchased on this" : undefined,
        tone: stale ? "danger" : undefined,
      },
    ];
  }

  const unnamed = rows.filter((r) => r.needsAttention).length;
  return [
    { label: "Waiting", value: String(rows.length) },
    { label: "Value asked for", value: money(value), sub: "against complaints" },
    {
      label: "Without a bill named",
      value: String(unnamed),
      sub: unnamed ? "issuing one puts the money on account" : undefined,
      tone: unnamed ? "warn" : undefined,
    },
  ];
}
