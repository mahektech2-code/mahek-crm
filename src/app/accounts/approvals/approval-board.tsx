"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Progress, Textarea, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { RowMenu, type MenuItem } from "@/components/ui/overlays";
import { CardGrid } from "@/components/ui/card-grid";
import { useToast } from "@/components/ui/toast";
import { approveOrderAction, declineOrderAction, holdOrderAction } from "@/lib/actions/orders";
import { money, moneyShort } from "@/lib/format";
import { ACCOUNTS_HOLD_REASONS, HOLD_CUSTOMER_TEXT } from "@/lib/erp/engines/order-hub";
import type { ApprovalBoardRow } from "@/lib/services/order-approval-service";
import { ReviewDrawer } from "../review-drawer";
import type { QueueRow } from "../queue-types";

/* ---------------------------------------------------------------------------
 * ORDER APPROVALS, drawn as the mockup: figure cards, then each order with its
 * order number and TO, the party and its instructions, this order, what the
 * party owes, the credit limit this order would use, what is overdue, how long
 * it has waited — and Approve, Hold and ⋯ (Edit order, Decline…, Open order,
 * Customer account). Approve, Hold and Decline are the service's own actions.
 * ------------------------------------------------------------------------- */

function waitWords(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} d ${Math.floor(h % 24)} h`;
}

export function ApprovalBoard({
  rows,
  queueRows,
  canDecide,
  staleHours,
  erpOrdersHref,
  title = "Order approvals",
  subtitle = "Orders that reached Accounts without a TO",
}: {
  rows: ApprovalBoardRow[];
  queueRows: QueueRow[];
  canDecide: boolean;
  staleHours: number;
  /** The ERP's Orders list, where a held order's dispatch details are edited — null where this person has no ERP. */
  erpOrdersHref: string | null;
  title?: string;
  subtitle?: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [holding, setHolding] = React.useState<ApprovalBoardRow | null>(null);
  const [declining, setDeclining] = React.useState<ApprovalBoardRow | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const open = queueRows.find((q) => q.id === openId) ?? null;

  const total = rows.reduce((n, r) => n + r.totalAmount, 0);
  const over = rows.filter((r) => r.creditLimit != null && r.outstanding + r.totalAmount > r.creditLimit).length;
  const overdue = rows.filter((r) => r.overdueAmount > 0).length;
  const late = rows.filter((r) => r.pastDeadline).length;

  async function approve(r: ApprovalBoardRow) {
    setBusy(r.orderId);
    try {
      const res = await run(approveOrderAction(r.orderId));
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-(--container-measure) px-6 pt-6 pb-10">
      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div role="heading" aria-level={1} className="text-2xl leading-8 font-semibold tracking-tight text-ink">
          {title}
        </div>
        <span className="text-sm text-body">{subtitle}</span>
      </div>

      <CardGrid min={200} gap="gap-3" className="mb-6">
        {[
          { v: String(rows.length), l: `Waiting for you · ${moneyShort(total)}` },
          { v: String(over), l: "Over credit limit" },
          { v: String(overdue), l: "Bills past their credit days" },
          { v: String(late), l: "Past the accounts deadline", danger: late > 0 },
        ].map((f) => (
          <div key={f.l} className="rounded-card border border-line bg-surface px-4 py-3.5">
            <span className={cx("block text-3xl leading-9 font-semibold tabular-nums", f.danger ? "text-danger" : "text-ink")}>{f.v}</span>
            <span className="mt-1 block text-sm text-body">{f.l}</span>
          </div>
        ))}
      </CardGrid>

      {rows.length ? (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: 150 }} />
              <col />
              <col style={{ width: 100 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 170 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 200 }} />
            </colgroup>
            <thead>
              <tr className="border-b border-line bg-canvas text-left text-xs font-medium tracking-label text-muted uppercase">
                <th className="px-3 py-2.5">Order · taken by</th>
                <th className="px-3 py-2.5">Party · instructions</th>
                <th className="px-3 py-2.5 text-right">This order</th>
                <th className="px-3 py-2.5 text-right">Outstanding</th>
                <th className="px-3 py-2.5">Credit limit used</th>
                <th className="px-3 py-2.5">Overdue</th>
                <th className="px-3 py-2.5">Waiting</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const used = r.outstanding + r.totalAmount;
                const overLimit = r.creditLimit != null && used > r.creditLimit;
                const share = r.creditLimit ? (used / r.creditLimit) * 100 : 0;
                const nearLimit = !overLimit && share >= 90;
                const late = r.pastDeadline || r.waitingHours >= staleHours;
                const items: MenuItem[] = [
                  ...(erpOrdersHref && r.orderNo ? [{ label: "Edit order", onSelect: () => router.push(`${erpOrdersHref}${erpOrdersHref.includes("?") ? "&" : "?"}fl=${encodeURIComponent(`Order ${r.orderNo}`)}`) }] : []),
                  { label: "Decline…", destructive: true, disabled: !canDecide, onSelect: () => setDeclining(r) },
                  { label: r.orderNo ? `Open order ${r.orderNo}` : "Open order", onSelect: () => setOpenId(r.orderId) },
                  { label: "Customer account", onSelect: () => router.push(`/accounts/ledger?customer=${r.customerId}`) },
                ];
                return (
                  <tr key={r.orderId} className={cx("border-b border-divider last:border-0", overLimit ? "bg-danger-soft/40" : undefined)}>
                    <td className="px-3 py-3 align-middle">
                      <button type="button" onClick={() => setOpenId(r.orderId)} className="block cursor-pointer text-left font-semibold text-ink hover:text-brand">
                        {r.orderNo ?? "Order"}
                      </button>
                      <span className="block truncate text-meta text-muted">{[r.toNo ? `TO-${r.toNo}` : null, r.takenByName].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td className="px-3 py-3 align-middle">
                      <Link href={`/accounts/ledger?customer=${r.customerId}`} className="block truncate text-ink hover:text-brand">
                        {r.customerName}
                      </Link>
                      <span className="block truncate text-meta text-muted">{r.instructions ?? "No instructions"}</span>
                    </td>
                    <td className="px-3 py-3 text-right align-middle tabular-nums text-ink">{money(r.totalAmount)}</td>
                    <td className="px-3 py-3 text-right align-middle tabular-nums text-ink">{money(r.outstanding)}</td>
                    <td className="px-3 py-3 align-middle">
                      {r.creditLimit ? (
                        <>
                          <span className={cx("block truncate tabular-nums", overLimit ? "font-medium text-danger" : nearLimit ? "font-medium text-warn-ink" : "text-ink")}>
                            {money(used)} / {money(r.creditLimit)}
                          </span>
                          <Progress className="mt-1.5" value={share} tone={overLimit ? "danger" : share >= 90 ? "warn" : "brand"} />
                        </>
                      ) : (
                        <span className="text-meta text-muted">No limit set</span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-middle">
                      {r.overdueAmount > 0 ? (
                        <span className={cx("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", r.overdueDays > 45 ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink")}>
                          {money(r.overdueAmount)} · {r.overdueDays} days
                        </span>
                      ) : (
                        <span className="text-meta text-muted">Nothing overdue</span>
                      )}
                    </td>
                    <td className={cx("px-3 py-3 align-middle whitespace-nowrap", late ? "font-medium text-danger" : "text-ink")}>{waitWords(r.waitingHours)}</td>
                    <td className="px-3 py-3 align-middle">
                      <span className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="success" disabled={!canDecide || busy === r.orderId} title={canDecide ? undefined : "Only the accounts team approves an order"} onClick={() => approve(r)}>
                          Approve
                        </Button>
                        <Button size="sm" disabled={!canDecide || !r.holdable} title={!r.holdable ? "Only an order made through the Order Hub is held here" : undefined} onClick={() => setHolding(r)}>
                          Hold
                        </Button>
                        <RowMenu items={items} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-card border border-line bg-surface px-5 py-10 text-center text-sm text-muted">Nothing waiting.</div>
      )}
      <p className="mt-3 text-meta text-muted">Approve → MRP check, and the customer gets &ldquo;Order confirmed&rdquo;. Hold → To Hold. ⋯ has Edit order and Decline.</p>

      {open ? (
        <ReviewDrawer
          key={open.id}
          kind="orders"
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
      {holding ? <HoldDialog key={holding.orderId} row={holding} onClose={() => setHolding(null)} /> : null}
      {declining ? <DeclineDialog key={declining.orderId} row={declining} onClose={() => setDeclining(null)} /> : null}
    </div>
  );
}

function HoldDialog({ row, onClose }: { row: ApprovalBoardRow; onClose: () => void }) {
  const router = useRouter();
  const { run } = useToast();
  const [reason, setReason] = React.useState<string>(row.creditLimit != null && row.outstanding + row.totalAmount > row.creditLimit ? "over_credit_limit" : row.overdueAmount > 0 ? "overdue_bills" : "payment_pending");
  const [note, setNote] = React.useState("");
  const [customer, setCustomer] = React.useState(HOLD_CUSTOMER_TEXT[reason] ?? HOLD_CUSTOMER_TEXT.other);
  const [touched, setTouched] = React.useState(false);
  const [again, setAgain] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const pick = (code: string) => {
    setReason(code);
    if (!touched) setCustomer(HOLD_CUSTOMER_TEXT[code] ?? HOLD_CUSTOMER_TEXT.other);
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await run(holdOrderAction(row.orderId, reason, note, { customerText: customer, lookAgainOn: again || null }));
      if (res.ok) {
        onClose();
        router.refresh();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={740}
      title={null}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy || !note.trim()} onClick={save}>
            {busy ? "Holding…" : "Put on hold"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <div role="heading" aria-level={2} className="flex items-center gap-2 text-xl font-semibold text-ink">
            Hold order {row.orderNo}
            <span className="rounded bg-brand-soft px-1.5 py-0.5 text-2xs font-bold text-brand uppercase">New</span>
          </div>
          <p className="mt-1 text-meta text-body">
            {row.customerName}
            {row.toNo ? ` · from TO-${row.toNo}` : ""}
            {row.takenByName ? ` · taken by ${row.takenByName}` : ""}
          </p>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-ink">Department</span>
          <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-warn-ink">Accounts</span>
          <span className="text-body">set from where you are; on release it comes back to Order approvals</span>
        </p>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">Reason</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reason">
            {ACCOUNTS_HOLD_REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                role="radio"
                aria-checked={reason === r.code}
                onClick={() => pick(r.code)}
                className={cx("cursor-pointer rounded-full border px-3 py-1 text-sm", reason === r.code ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-ink hover:bg-canvas")}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Remarks (staff only)" required error={error ?? undefined}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="What the customer sees on the tracking link" hint="Filled in from the reason. Remarks never reach the customer." hintShown>
          <Textarea
            rows={2}
            value={customer}
            onChange={(e) => {
              setTouched(true);
              setCustomer(e.target.value);
            }}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Look at it again on" optional>
            <Input type="date" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink">Who is told</span>
            <p className="text-sm text-body">{row.takenByName ? `${row.takenByName} (took the order)` : "Whoever took the order"}</p>
            <p className="text-sm text-body">{row.salesManager ? `${row.salesManager} (sales manager on the account)` : "Sales manager on the account"}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DeclineDialog({ row, onClose }: { row: ApprovalBoardRow; onClose: () => void }) {
  const router = useRouter();
  const { run } = useToast();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Decline order ${row.orderNo ?? ""}`.trim()}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            variant="danger"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await run(declineOrderAction(row.orderId, reason));
                if (res.ok) {
                  onClose();
                  router.refresh();
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            Decline
          </Button>
        </>
      }
    >
      <Field label="Why is it declined? Whoever took it is told." required>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
