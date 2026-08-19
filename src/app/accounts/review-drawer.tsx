"use client";

import * as React from "react";
import { Button, cx } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import type { useToast } from "@/components/ui/toast";
import { longDate, money, stamp } from "@/lib/format";
import { describeQuantity } from "@/lib/catalogue";
import { approveOrderAction, declineOrderAction } from "@/lib/actions/orders";
import {
  confirmReceiptAction,
  holdReceiptAction,
  rejectReceiptAction,
} from "@/lib/actions/payments";
import { allocate, type AllocatableBill } from "@/lib/engines/allocation";
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

  /*
   * Where the money goes, when accounts change it.
   *
   * Null means "leave it as reported", which is what confirming has always
   * meant and what the great majority of these are. It becomes an object only
   * once somebody touches the allocation, so an untouched review sends nothing
   * and the receipt keeps the lines it came with.
   */
  const [alloc, setAlloc] = React.useState<AllocationChoice | null>(null);
  /** Which of the two negative paths the reason box is collecting for. */
  const [reasonFor, setReasonFor] = React.useState<"reject" | "hold">("reject");

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

  const holding = kind === "payments" && reasonFor === "hold";

  const positiveBlocked =
    !canDecide
      ? "Only the accounts team can decide this"
      : kind === "credits" && amountPaise <= 0
        ? "Set what the credit note is worth"
        : busy
          ? "Saving…"
          : undefined;

  /*
   * `finally` on both of these, because `run` re-throws what the action threw.
   * A flag cleared only on the way past a successful await leaves the decision
   * button disabled and reading "Saving…" until somebody reloads — on the two
   * buttons that approve an order and confirm that money arrived.
   */
  async function decidePositive() {
    setBusy(true);
    setConflict(null);
    try {
      const result =
        kind === "orders"
          ? await run(approveOrderAction(row.id))
          : kind === "payments"
            ? await run(confirmReceiptAction(row.id, alloc ?? undefined))
            : await run(
                issueCreditNoteAction({
                  complaintId: row.id,
                  amount: amountPaise,
                  reference: reference.trim() || undefined,
                }),
              );
      if (result.ok) onDecided();
      // A stale allocation or a row somebody else decided first is not a toast
      // that vanishes — it stays in the drawer, because it changes what to do.
      else setConflict(result.error);
    } finally {
      setBusy(false);
    }
  }

  async function decideNegative() {
    setBusy(true);
    setConflict(null);
    try {
      const result =
        kind === "orders"
          ? await run(declineOrderAction(row.id, reason))
          : kind === "payments"
            ? // Hold and reject collect the same thing — a sentence somebody
              // downstream repeats — so they share the box and differ only in
              // which action spends it.
              reasonFor === "hold"
              ? await run(holdReceiptAction(row.id, reason))
              : await run(rejectReceiptAction(row.id, reason))
            : await run(refuseCreditNoteAction(row.id, reason));
      if (result.ok) onDecided();
      else setConflict(result.error);
    } finally {
      setBusy(false);
    }
  }

  function openReason(what: "reject" | "hold") {
    setReasonFor(what);
    setReason("");
    setReasoning(true);
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
          <PaymentBody
            detail={detail}
            amount={row.amount}
            customerName={row.customerName}
            alloc={alloc}
            onAlloc={setAlloc}
            canDecide={canDecide}
          />
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
              {holding ? "What are you checking" : copy.reasonLabel}
            </div>
            <VoiceTextarea
              autoFocus
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onDictate={setReason}
              placeholder={
                holding
                  ? "Looking for it in the August statement — nothing on the 12th yet."
                  : copy.reasonPlaceholder
              }
            />
            <p className="mt-1.5 text-[13px] text-pretty text-muted">
              {holding
                ? `${row.customerName} comes off the collections list from now until you decide — no calls and no reminder messages. The telecaller sees this sentence and nothing else, so say what you are waiting for.`
                : copy.reasonHint}
            </p>
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
              // Holding is not a refusal — it is a pause, and drawing it in the
              // same red as "this money never arrived" would make the safe
              // option look like the drastic one.
              variant={holding ? "secondary" : "danger"}
              disabled={busy || !reason.trim()}
              title={
                reason.trim()
                  ? undefined
                  : holding
                    ? "Say what you are checking — the telecaller reads this"
                    : "Write a reason first — somebody has to repeat it to the customer"
              }
              onClick={decideNegative}
            >
              {holding ? "Put it on hold" : copy.reasonButton}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={!canDecide || busy}
              title={canDecide ? undefined : "Only the accounts team can decide this"}
              onClick={() => openReason("reject")}
            >
              {copy.negative}
            </Button>

            {/* Only where there is still something to hold. A receipt already
                on hold is here to be decided, and a second Hold on it would be
                a button that does nothing. */}
            {kind === "payments" && detail?.kind === "payments" && detail.status !== "held" ? (
              <Button
                variant="secondary"
                disabled={!canDecide || busy}
                title={
                  canDecide
                    ? "Stop chasing them while you look for the money — no calls and no messages until you decide"
                    : "Only the accounts team can decide this"
                }
                onClick={() => openReason("hold")}
              >
                Hold
              </Button>
            ) : null}

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

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

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
  alloc,
  onAlloc,
  canDecide,
}: {
  detail: PaymentDetail;
  amount: number;
  customerName: string;
  alloc: AllocationChoice | null;
  onAlloc: (a: AllocationChoice | null) => void;
  canDecide: boolean;
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

      {/*
        A cheque that can be banked, first: the money is reachable right now
        and somebody has to go and get it. A post-dated one says so instead and
        is deliberately calm — it is not asking for anything yet, and marking
        it urgently is how people learn to ignore the marking.
      */}
      {detail.instrumentDate ? (
        <div
          className={cx(
            "mt-4 rounded-[4px] border px-3 py-2.5 text-[13px] text-pretty",
            detail.bankableNow
              ? "border-danger-soft bg-danger-soft text-danger"
              : "border-line bg-canvas text-body",
          )}
        >
          {detail.bankableNow ? (
            <>
              <span className="font-medium">
                {detail.mode} dated{" "}
                {detail.bankableDays === 0
                  ? "today"
                  : `${longDate(detail.instrumentDate)} — ${days(detail.bankableDays ?? 0)} ago`}
                .
              </span>{" "}
              It can be banked. Look for it on the statement and confirm it, or put it on
              hold saying what you are waiting for.
            </>
          ) : (
            <>
              <span className="font-medium text-ink">
                {detail.mode} dated {longDate(detail.instrumentDate)}.
              </span>{" "}
              Post-dated — nothing to look for yet, and {customerName} is not being chased
              for it until then.
            </>
          )}
        </div>
      ) : null}

      {/* The hold, first and unmissable. Everything below is context for a
          decision; this is a decision somebody has already part-made, and the
          customer has been getting no calls and no messages ever since. */}
      {detail.status === "held" ? (
        <div
          className={cx(
            "mt-4 rounded-[4px] border px-3 py-2.5",
            detail.holdStale
              ? "border-danger-soft bg-danger-soft"
              : "border-warn-line bg-warn-soft",
          )}
        >
          <div
            className={cx(
              "text-sm font-medium",
              detail.holdStale ? "text-danger" : "text-warn-ink",
            )}
          >
            On hold {detail.heldDays === 0 ? "since today" : `for ${days(detail.heldDays ?? 0)}`}
            {detail.heldByName ? ` · ${detail.heldByName}` : ""}
          </div>
          {detail.holdReason ? (
            <div className="mt-1 text-[13px] text-pretty text-body">{detail.holdReason}</div>
          ) : null}
          <div className="mt-1.5 text-[13px] text-pretty text-muted">
            {customerName} has had no calls and no reminder messages the whole time. A hold
            does not expire — it ends when you approve or reject this.
          </div>
        </div>
      ) : null}

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

      <div className="mt-5 flex items-baseline justify-between gap-3">
        <SectionLabel>What confirming it would settle</SectionLabel>
        {/*
          Offered even where NOTHING is open.

          That case is not a dead end, it is the most stuck one: the bill this
          money was reported against has been settled by something else, so
          confirming as it stands is refused and there is no other bill to
          point at. Re-allocating with no open bills puts the whole amount on
          account, which is the honest answer — the money arrived and there is
          nothing left for it to pay. Hiding the control exactly there would
          leave the only way out invisible.
        */}
        {canDecide ? (
          <button
            type="button"
            onClick={() => onAlloc(alloc ? null : { mode: "auto" })}
            className="cursor-pointer border-none bg-transparent p-0 text-[13px] text-brand hover:underline"
          >
            {alloc ? "Leave it as reported" : "Put it somewhere else"}
          </button>
        ) : null}
      </div>

      {alloc ? (
        <AllocationEditor
          amount={amount}
          openBills={detail.openBills}
          choice={alloc}
          onChoice={onAlloc}
        />
      ) : bills.length ? (
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

      {!alloc && detail.onAccount > 0 ? (
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

/* -------------------------------------------------- where the money goes */

export type AllocationChoice = {
  mode: "auto" | "settle" | "custom";
  selectedBillIds?: string[];
  custom?: Record<string, number>;
};

/**
 * The three instructions, and a live preview run through the SAME pure engine
 * the server runs.
 *
 * Accounts are deciding where money goes, so a preview that disagreed with the
 * save would be worse than no preview at all — which is why `allocate` is pure
 * and why this imports it rather than reimplementing the arithmetic for a
 * screen.
 *
 * `claimed` comes off each bill's balance before anything is offered. Money
 * another undecided receipt has already asked of a bill is not available to
 * this one, and two people writing down one transfer is the ordinary way an
 * account ends up over-credited.
 */
function AllocationEditor({
  amount,
  openBills,
  choice,
  onChoice,
}: {
  amount: number;
  openBills: PaymentDetail["openBills"];
  choice: AllocationChoice;
  onChoice: (a: AllocationChoice) => void;
}) {
  const allocatable: AllocatableBill[] = openBills.map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    amount: b.balance + b.claimed,
    paid: b.claimed,
  }));

  const preview = allocate(allocatable, {
    mode: choice.mode,
    amount,
    selectedBillIds: choice.selectedBillIds ?? [],
    custom: choice.custom ?? {},
    // The preview is allowed to show a remainder on account. Whether it is
    // ACCEPTED is the server's answer, from configuration — showing it here is
    // what makes a refusal understandable when it comes.
    allowOnAccount: true,
  });

  const selected = new Set(choice.selectedBillIds ?? []);

  return (
    <div className="mt-2">
      <div className="flex gap-1.5">
        {(
          [
            ["auto", "Oldest first"],
            ["settle", "Settle these"],
            ["custom", "Split it myself"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onChoice({ ...choice, mode: key })}
            className={cx(
              "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
              choice.mode === key
                ? "border-brand bg-brand-soft font-medium text-brand"
                : "border-line bg-surface text-body hover:border-line-strong",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!openBills.length ? (
        <div className="mt-2 rounded-[4px] border border-line px-3 py-2.5 text-[13px] text-pretty text-muted">
          Nothing is open on this account — every bill has been settled by something else
          since this was reported. The whole amount goes on account, and is offered against
          their next bill.
        </div>
      ) : null}

      <div className="mt-2 overflow-hidden rounded-[4px] border border-line empty:hidden">
        {openBills.map((b) => {
          const line = preview.lines.find((l) => l.billId === b.id);
          return (
            <div
              key={b.id}
              className="flex items-center gap-2.5 border-b border-canvas px-3 py-2.5 text-sm last:border-0"
            >
              {choice.mode === "settle" ? (
                <input
                  type="checkbox"
                  checked={selected.has(b.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(b.id);
                    else next.delete(b.id);
                    onChoice({ ...choice, selectedBillIds: [...next] });
                  }}
                  aria-label={`Settle ${b.billNo}`}
                  className="size-4 flex-none cursor-pointer"
                />
              ) : null}

              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{b.billNo}</span>
                <span className="mt-px block text-[11px] text-muted">
                  {money(b.balance)} open
                  {b.daysOverdue > 0 ? ` · ${days(b.daysOverdue)} overdue` : ""}
                  {/* Named rather than silently subtracted: a bill that looks
                      smaller than the ledger says is a bill somebody queries. */}
                  {b.claimed > 0 ? ` · ${money(b.claimed)} already claimed` : ""}
                </span>
              </span>

              {choice.mode === "custom" ? (
                <span className="flex h-8 w-28 flex-none items-center rounded-[4px] border border-line px-2">
                  <span className="mr-1 text-[13px] text-muted">₹</span>
                  <input
                    inputMode="numeric"
                    value={
                      choice.custom?.[b.id] ? String(Math.round(choice.custom[b.id] / 100)) : ""
                    }
                    onChange={(e) => {
                      const rupeesTyped = Number(e.target.value.replace(/[^0-9]/g, "") || 0);
                      onChoice({
                        ...choice,
                        custom: { ...(choice.custom ?? {}), [b.id]: rupeesTyped * 100 },
                      });
                    }}
                    placeholder="0"
                    aria-label={`Amount against ${b.billNo}`}
                    className="w-full border-none bg-transparent text-right text-sm tabular-nums outline-none"
                  />
                </span>
              ) : (
                <span className="flex-none text-sm font-medium tabular-nums text-ink">
                  {line ? money(line.amount) : "—"}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {preview.onAccount > 0 ? (
        <div className="mt-2 rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-pretty text-warn-ink">
          {money(preview.onAccount)} would sit on account — received, not against a bill,
          and offered against their next one.
        </div>
      ) : null}

      {preview.errors.length ? (
        <div className="mt-2 rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-pretty text-danger">
          {preview.errors[0]}
        </div>
      ) : null}
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
