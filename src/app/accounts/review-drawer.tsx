"use client";

import * as React from "react";
import { Button, Textarea, cx } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import type { useToast } from "@/components/ui/toast";
import { longDate, money, stamp } from "@/lib/format";
import { describeQuantity } from "@/lib/catalogue";
import { approveOrderAction, declineOrderAction } from "@/lib/actions/orders";
import { confirmReceiptAction, rejectReceiptAction } from "@/lib/actions/payments";
import {
  issueCreditNoteAction,
  refuseCreditNoteAction,
} from "@/lib/actions/accounts";
import { Banner } from "./parts";
import {
  QUEUE_COPY,
  SOURCE_WORDS,
  type CreditDetail,
  type OrderDetail,
  type PaymentDetail,
  type QueueDetail,
  type QueueKind,
  type QueueRow,
} from "./queue-types";

/* ---------------------------------------------------------------------------
 * The review drawer.
 *
 * One drawer, three bodies. What they share is the shape of the decision: read
 * the thing, then either accept it or say in words why not. The negative
 * action is always two steps and always demands a reason, because somebody
 * downstream has to repeat that reason to a customer.
 *
 * The detail is fetched when the drawer opens rather than sent with the list —
 * an order can carry hundreds of lines and the queue needs only a count.
 * ------------------------------------------------------------------------- */

type Line = {
  productName: string;
  packSize: string | null;
  subtitle: string | null;
  quantity: number;
  millilitresPerCan: number | null;
  cansPerBox: number;
};

export function ReviewDrawer({
  kind,
  row,
  canDecide,
  run,
  onClose,
  onDecided,
}: {
  kind: QueueKind;
  row: QueueRow;
  canDecide: boolean;
  run: ReturnType<typeof useToast>["run"];
  onClose: () => void;
  onDecided: () => void;
}) {
  const copy = QUEUE_COPY[kind];
  const [detail, setDetail] = React.useState<QueueDetail | null>(null);
  const [lines, setLines] = React.useState<Line[] | null>(null);
  const [reasoning, setReasoning] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [amountText, setAmountText] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [conflict, setConflict] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/accounts/queue-detail?kind=${kind}&id=${row.id}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { detail: QueueDetail; lines?: Line[] } | null) => {
        if (!d) return;
        setDetail(d.detail);
        setLines(d.lines ?? []);
        if (d.detail.kind === "credits" && d.detail.requestedAmount) {
          // Pre-filled with what was asked for, not with a decision — the
          // figure is still accounts' to change before it is issued.
          setAmountText(String(Math.round(d.detail.requestedAmount / 100)));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [kind, row.id]);

  const amountPaise = Math.round(Number(amountText.replace(/[^0-9]/g, "") || 0) * 100);

  const positiveLabel =
    kind === "orders"
      ? `Approve ${money(row.amount)}`
      : kind === "payments"
        ? `Confirm ${money(row.amount)} received`
        : `Issue ${amountPaise > 0 ? money(amountPaise) : "a credit note"}`;

  const positiveBlocked =
    !canDecide
      ? "Only the accounts team can decide this"
      : kind === "credits" && amountPaise <= 0
        ? "Set what the credit note is worth"
        : busy
          ? "Saving…"
          : undefined;

  async function decidePositive() {
    setBusy(true);
    setConflict(null);
    const result =
      kind === "orders"
        ? await run(approveOrderAction(row.id))
        : kind === "payments"
          ? await run(confirmReceiptAction(row.id))
          : await run(
              issueCreditNoteAction({
                complaintId: row.id,
                amount: amountPaise,
                reference: reference.trim() || undefined,
              }),
            );
    setBusy(false);
    if (result.ok) onDecided();
    // A stale allocation or a row somebody else decided first is not a toast
    // that vanishes — it stays in the drawer, because it changes what to do.
    else setConflict(result.error);
  }

  async function decideNegative() {
    setBusy(true);
    setConflict(null);
    const result =
      kind === "orders"
        ? await run(declineOrderAction(row.id, reason))
        : kind === "payments"
          ? await run(rejectReceiptAction(row.id, reason))
          : await run(refuseCreditNoteAction(row.id, reason));
    setBusy(false);
    if (result.ok) onDecided();
    else setConflict(result.error);
  }

  return (
    <Drawer open onClose={onClose} width={kind === "orders" ? 520 : 560} label="Review">
      <DrawerHeader onClose={onClose}>
        <span className="block text-lg leading-6 font-semibold text-ink">
          {row.customerName}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-muted">{row.byMeta}</span>
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {conflict ? (
          <Banner tone="danger" title="This cannot be decided as it stands">
            {conflict}
          </Banner>
        ) : null}

        {detail === null ? (
          <p className="py-10 text-center text-[13px] text-muted">Loading…</p>
        ) : detail.kind === "orders" ? (
          <OrderBody detail={detail} lines={lines} />
        ) : detail.kind === "payments" ? (
          <PaymentBody detail={detail} amount={row.amount} customerName={row.customerName} />
        ) : (
          <CreditBody
            detail={detail}
            amountText={amountText}
            onAmount={setAmountText}
            reference={reference}
            onReference={setReference}
            canDecide={canDecide}
          />
        )}

        {reasoning ? (
          <div className="mt-5 border-t border-divider pt-4">
            <div className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {copy.reasonLabel}
            </div>
            <Textarea
              autoFocus
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={copy.reasonPlaceholder}
            />
            <p className="mt-1.5 text-[13px] text-pretty text-muted">{copy.reasonHint}</p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-2.5 border-t border-line bg-surface px-5 py-3">
        {reasoning ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setReasoning(false)}>
              Back
            </Button>
            <span className="flex-1" />
            <Button
              variant="danger"
              disabled={busy || !reason.trim()}
              title={
                reason.trim()
                  ? undefined
                  : "Write a reason first — somebody has to repeat it to the customer"
              }
              onClick={decideNegative}
            >
              {copy.reasonButton}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={!canDecide || busy}
              title={canDecide ? undefined : "Only the accounts team can decide this"}
              onClick={() => setReasoning(true)}
            >
              {copy.negative}
            </Button>
            <span className="flex-1" />
            <Button
              variant="primary"
              disabled={Boolean(positiveBlocked)}
              title={positiveBlocked}
              onClick={decidePositive}
            >
              {positiveLabel}
            </Button>
          </>
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------- order */

function OrderBody({ detail, lines }: { detail: OrderDetail; lines: Line[] | null }) {
  // What accounts are actually here to check, first — the line items are what
  // you read after deciding the customer is good for it, not before.
  const risky = detail.outstanding > 0 || detail.overdueBills > 0 || detail.slowPayer;

  return (
    <div>
      <SectionLabel>Can they take it</SectionLabel>
      <div
        className={cx(
          "mt-2 overflow-hidden rounded-[4px] border",
          risky ? "border-warn-line" : "border-line",
        )}
      >
        <div className="grid grid-cols-2 gap-px bg-divider">
          <Figure
            label="Outstanding"
            value={detail.outstanding > 0 ? money(detail.outstanding) : "Nothing owed"}
            tone={detail.outstanding > 0 ? "danger" : undefined}
            risky={risky}
          />
          <Figure
            label="Bills overdue"
            value={detail.overdueBills > 0 ? String(detail.overdueBills) : "None"}
            tone={detail.overdueBills > 0 ? "danger" : undefined}
            risky={risky}
          />
          <Figure
            label="Payment term"
            value={detail.creditDays === null ? "Default" : `${detail.creditDays} days`}
            risky={risky}
          />
          <Figure
            label="Pays on time"
            value={detail.slowPayer ? "Slow payer" : "No concerns"}
            tone={detail.slowPayer ? "warn" : undefined}
            risky={risky}
          />
        </div>
      </div>

      <div className="mt-5 mb-2 flex items-baseline justify-between gap-3">
        <SectionLabel>
          {detail.lineCount} item{detail.lineCount === 1 ? "" : "s"}
        </SectionLabel>
        <span className="text-[13px] text-muted">
          Taken by {detail.takenByName ?? "—"} · {stamp(detail.orderedAt)}
        </span>
      </div>

      {lines === null ? (
        <div className="rounded-[4px] border border-line px-3 py-5 text-center text-sm text-muted">
          Loading the items…
        </div>
      ) : lines.length ? (
        <div className="max-h-[45vh] overflow-y-auto rounded-[4px] border border-line">
          {lines.map((l, i) => (
            <div
              key={`${l.productName}:${i}`}
              className="flex items-start justify-between gap-3 border-b border-canvas px-3 py-2.5 last:border-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink">
                  {l.packSize ? `${l.productName} — ${l.packSize}` : l.productName}
                </span>
                {/* Two SKU names here differ by one word. The formulation is
                    the only thing separating them on a list read mid-decision. */}
                {l.subtitle ? (
                  <span className="mt-px block truncate text-[11px] text-muted">
                    {l.subtitle}
                  </span>
                ) : null}
              </span>
              <span className="flex-none text-[13px] whitespace-nowrap text-body">
                {describeQuantity(l.quantity, {
                  millilitresPerCan: l.millilitresPerCan,
                  cansPerBox: l.cansPerBox,
                })}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-[4px] border border-line px-3 py-5 text-center text-sm text-muted">
          No items recorded against this order.
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- payment */

function PaymentBody({
  detail,
  amount,
  customerName,
}: {
  detail: PaymentDetail;
  amount: number;
  customerName: string;
}) {
  const bills = detail.lines.filter((l) => l.billId);

  return (
    <div>
      <div className="text-[28px] leading-[34px] font-semibold tabular-nums text-ink">
        {money(amount)}
      </div>
      <div className="mt-0.5 text-[13px] text-muted">
        {detail.mode}
        {detail.reference ? ` · ${detail.reference}` : " · no reference given"}
        {` · received ${longDate(detail.receivedAt)}`}
      </div>

      <SectionLabel className="mt-5">Where it came from</SectionLabel>
      <div className="mt-2 text-sm text-ink">
        {SOURCE_WORDS[detail.source] ?? detail.source}
      </div>
      <div className="mt-0.5 text-xs text-muted">Reported {stamp(detail.reportedAt)}</div>
      {detail.note ? (
        <div className="mt-2.5 rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-sm text-pretty text-body">
          {detail.note}
        </div>
      ) : null}

      <SectionLabel className="mt-5">What confirming it would settle</SectionLabel>
      {bills.length ? (
        <div className="mt-2 overflow-hidden rounded-[4px] border border-line">
          {bills.map((l) => (
            <div
              key={l.billId}
              className="flex items-center justify-between border-b border-canvas px-3 py-2.5 text-sm last:border-0"
            >
              <span className="text-ink">{l.billNo}</span>
              <span className="font-medium tabular-nums text-ink">{money(l.amount)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 rounded-[4px] border border-line px-3 py-2.5 text-sm text-muted">
          Nothing named — the whole amount would sit on account.
        </div>
      )}

      {detail.onAccount > 0 ? (
        <div className="mt-2 rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-pretty text-warn-ink">
          {money(detail.onAccount)} would sit on account — received, not yet against a
          bill, and offered against the next one.
        </div>
      ) : null}

      <div className="mt-2 text-[13px] text-muted">
        {customerName} owes {money(detail.outstanding)} in total.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ credit */

function CreditBody({
  detail,
  amountText,
  onAmount,
  reference,
  onReference,
  canDecide,
}: {
  detail: CreditDetail;
  amountText: string;
  onAmount: (v: string) => void;
  reference: string;
  onReference: (v: string) => void;
  canDecide: boolean;
}) {
  return (
    <div>
      <SectionLabel>What it is worth</SectionLabel>
      <div className="mt-2 flex items-center gap-2">
        <span className="flex h-11 flex-1 items-center rounded-[4px] border border-line bg-surface px-3">
          <span className="mr-1 text-muted">₹</span>
          <input
            value={amountText}
            onChange={(e) => onAmount(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={!canDecide}
            placeholder="0"
            aria-label="Credit note amount in rupees"
            className="w-full flex-1 border-none bg-transparent text-[22px] font-semibold tabular-nums outline-none disabled:text-muted"
          />
        </span>
      </div>
      <p className="mt-1.5 text-[13px] text-pretty text-muted">
        {detail.requestedAmount
          ? `The telecaller wrote down ${money(detail.requestedAmount)}. It is a request, not a decision — change it if the goods say otherwise.`
          : "Nobody put a figure on this. The telecaller was asked only whether the customer wanted one."}
      </p>

      <SectionLabel className="mt-5">What the complaint says</SectionLabel>
      <div className="mt-2 text-sm text-pretty text-ink">{detail.description}</div>
      <div className="mt-0.5 text-[13px] text-muted">
        {detail.categoryLabel} · raised {stamp(detail.raisedAt)}
      </div>
      {detail.goodsDescription ? (
        <div className="mt-2.5 rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-sm text-pretty text-body">
          {detail.goodsDescription}
        </div>
      ) : null}

      <SectionLabel className="mt-5">Photographs</SectionLabel>
      {detail.photos.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {detail.photos.map((p) => (
            <a
              key={p.id}
              href={`/api/attachments/${p.id}`}
              target="_blank"
              rel="noreferrer"
              title={p.filename}
              className="block h-18 w-24 overflow-hidden rounded-[4px] border border-line bg-canvas no-underline"
            >
              {/* The endpoint checks the parent's scope, so a photograph
                  somebody may not see and one that does not exist answer the
                  same way. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/attachments/${p.id}`}
                alt={p.filename}
                className="h-full w-full object-cover"
              />
            </a>
          ))}
        </div>
      ) : (
        <div className="mt-2 rounded-[4px] border border-dashed border-line-strong px-3 py-4 text-center text-sm text-muted">
          No photographs were attached to this complaint.
        </div>
      )}

      <SectionLabel className="mt-5">The bill it names</SectionLabel>
      <div
        className={cx(
          "mt-2 rounded-[4px] border px-3 py-2.5 text-sm text-pretty",
          detail.billNo
            ? "border-line bg-surface text-ink"
            : "border-warn-line bg-warn-soft text-warn-ink",
        )}
      >
        {detail.billNo
          ? `${detail.billNo} · ${money(detail.billBalance ?? 0)} open — the credit comes off this bill`
          : "No bill named. Issuing without one puts the money on account, offered against their next bill."}
      </div>

      <SectionLabel className="mt-5">Credit note number</SectionLabel>
      <input
        value={reference}
        onChange={(e) => onReference(e.target.value)}
        disabled={!canDecide}
        placeholder="Optional — record it once the accountant raises one"
        className="mt-2 h-9.5 w-full rounded-[4px] border border-line px-2.5 text-sm focus:border-brand focus:outline-none"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function SectionLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "text-[11px] font-medium tracking-[0.04em] text-muted uppercase",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  risky,
}: {
  label: string;
  value: string;
  tone?: "danger" | "warn";
  risky: boolean;
}) {
  return (
    <div className={cx("px-3 py-2.5", risky ? "bg-warn-soft" : "bg-surface")}>
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span
        className={cx(
          "mt-0.5 block text-sm font-medium",
          tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn-ink" : "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}
