"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog, RowMenu } from "@/components/ui/overlays";
import { Pager } from "@/components/ui/pager";
import { ALL_TIME, CUSTOM_DATES, YearFilter } from "@/components/ui/year-filter";
import { reverseReceiptAction } from "@/lib/actions/payments";
import { longDate, money, shortDate, signedMoney } from "@/lib/format";
import { yearLabel } from "@/lib/year-period";

/* ---------------------------------------------------------------------------
 * A customer's statement — ONE component, drawn by two apps.
 *
 * Accounts → Customer account and the CRM customer record's Ledger tab show
 * the same account the same way: the period (financial year by default), the
 * opening balance + billed − received = closing balance sum, and the statement
 * table with which bills each payment settled. Two copies of this would be two
 * answers to "what does this customer owe", and the one that drifts is the one
 * somebody reads out on a call.
 *
 * The data is `ledgerForCustomer` (receipt-service): confirmed money only, so
 * the running balance agrees with what the customer owes. Rejected and
 * reversed receipts stay on it, struck through.
 * ------------------------------------------------------------------------- */

export type LedgerLink = {
  id: string;
  label: string;
  mode?: string;
  at: string;
  amount: number;
  status: string;
  billAmount?: number;
  billDue?: number;
  receiptAmount?: number;
  receiptBills?: number;
};

export type LedgerEntry = {
  at: string;
  kind: "bill" | "receipt";
  ref: string;
  detail: string;
  debit: number;
  credit: number;
  status: string | null;
  /** Bill lines: paise claimed against it and not yet confirmed. Never subtracted. */
  claimed?: number;
  receiptId?: string;
  billId?: string;
  paid?: number;
  unstated?: boolean;
  /** Receipt lines: the bills it settled. Bill lines: the receipts that settled it. */
  links?: LedgerLink[];
  onAccount?: number;
  balance: number;
};

export type StatementLedger = {
  customerId: string;
  customerName: string;
  openingBalance: number;
  closingBalance: number;
  entries: LedgerEntry[];
  totals: { billed: number; received: number; outstanding: number; onAccount: number };
  awaiting: { count: number; amount: number };
};


/** Rejected or reversed: the receipt, and every allocation it made, counts for nothing. */
export const deadStatus = (status: string | null | undefined) =>
  status === "rejected" || status === "reversed";

/** The id a row is known by — what a link on another row points at. */
export const rowId = (e: LedgerEntry) => (e.kind === "bill" ? e.billId : e.receiptId) ?? null;

/** What a period change asks for; the screen turns it into a URL or a fetch. */
export type PeriodPatch = Partial<{ period: string; from: string; to: string }>;

/** The period as words, and the day its closing balance is read on. */
function periodWords(period: string, to: string, today: string) {
  const name =
    period === ALL_TIME ? "All time" : period === CUSTOM_DATES ? "These dates" : yearLabel(period);
  // A period still running closes TODAY, not on a date that has not come.
  const closingOn = !to || to > today ? today : to;
  return { name, closingOn };
}

export function LedgerPeriodBar({
  period,
  years,
  today,
  from,
  to,
  onChange,
}: {
  period: string;
  years: { fy: string[]; cy: string[] };
  today: string;
  from: string;
  to: string;
  onChange: (patch: PeriodPatch) => void;
}) {
  const navigate = onChange;
  /*
   * THE PERIOD, chosen first, because every figure under it answers to it. A
   * financial year by default; a calendar year, all time or typed dates are
   * one choice away.
   */
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
      <YearFilter
        value={period}
        options={years}
        today={today}
        allowAll
        allowCustom
        onChange={(next) =>
          // Custom starts from the dates already on screen, so choosing
          // it narrows what is there rather than emptying the screen.
          next === CUSTOM_DATES
            ? navigate({ period: next, from: from || today, to: to || today })
            : navigate({ period: next })
        }
      />
      {period === CUSTOM_DATES ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => navigate({ from: e.target.value })}
            className={FIELD}
            aria-label="From"
          />
          <span>to</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => navigate({ to: e.target.value })}
            className={FIELD}
            aria-label="To"
          />
        </div>
      ) : null}
    </div>
  );
}

export function LedgerBalances({
  ledger,
  period,
  from,
  to,
  today,
}: {
  ledger: StatementLedger;
  period: string;
  from: string;
  to: string;
  today: string;
}) {
  const { name: periodName, closingOn } = periodWords(period, to, today);
  return (
    <>
      {/*
        OPENING AND CLOSING BALANCE, written as the sum it is. What was owed
        when the period opened, plus what was billed in it, less what was
        received in it, is what was owed when it closed — so a reader can
        check the arithmetic on the screen rather than take it on trust.
        Confirmed money only, like the running balance beneath.
      */}
      <section
        aria-label={`${periodName} balances`}
        className="mb-3 grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-x-3 rounded-[6px] border border-line bg-surface px-5 py-4"
      >
        <BalanceFigure
          label="Opening balance"
          value={signedMoney(ledger.openingBalance)}
          sub={from ? `as on ${longDate(from)}` : "before the first entry"}
        />
        <Operator>+</Operator>
        <BalanceFigure
          label="Billed"
          value={money(ledger.totals.billed)}
          sub={`in ${periodName === "These dates" ? "these dates" : periodName}`}
        />
        <Operator>−</Operator>
        <BalanceFigure
          label="Received"
          value={money(ledger.totals.received)}
          sub="confirmed"
        />
        <Operator>=</Operator>
        <BalanceFigure
          label="Closing balance"
          value={signedMoney(ledger.closingBalance)}
          sub={`as on ${longDate(closingOn)}`}
          strong
        />
      </section>

      {/* The account as it stands today, whatever period is chosen. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 px-1 text-[13px] text-muted">
        <span>
          Outstanding today{" "}
          <span
            className={cx(
              "font-medium tabular-nums",
              ledger.totals.outstanding > 0 ? "text-danger" : "text-ink",
            )}
          >
            {money(ledger.totals.outstanding)}
          </span>
        </span>
        <span>
          On account{" "}
          <span className="font-medium text-ink tabular-nums">
            {money(ledger.totals.onAccount)}
          </span>
        </span>
        <span>
          Awaiting confirmation{" "}
          <span
            className={cx(
              "font-medium tabular-nums",
              ledger.awaiting.count ? "text-danger" : "text-ink",
            )}
          >
            {money(ledger.awaiting.amount)}
          </span>
          {ledger.awaiting.count ? ` · ${plural(ledger.awaiting.count, "receipt")}` : ""}
        </span>
      </div>
    </>
  );
}

/**
 * The statement table: newest first, which bills each payment settled, the
 * running balance, and — for whoever may — Reverse in each payment's ⋯ menu.
 * Paging, hover-linking and the reverse dialog live here, so both screens get
 * all of it.
 */
export function StatementTable({
  ledger,
  from,
  canReverse,
  onReversed,
  compact = false,
}: {
  ledger: StatementLedger;
  /** The period's first day; the opening balance row is drawn only with one. */
  from: string;
  /** `payment.confirm` — taking money off is the same decision as putting it on. */
  canReverse: boolean;
  /** Re-read the statement after a reversal. */
  onReversed: () => void;
  /**
   * For a narrow panel (the CRM record's Ledger tab): the date moves under the
   * bill or payment it belongs to instead of taking a column of its own.
   */
  compact?: boolean;
}) {
  const { run } = useToast();
  /* Which receipt is being reversed. The reason is held by the dialog. */
  const [reversing, setReversing] = React.useState<LedgerEntry | null>(null);
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);
  /*
   * The row the pointer is on, by id. A row is lit when it IS that row or
   * links to it, so pointing at a payment lights the bills it paid and
   * pointing at a bill lights the payments that paid it.
   */
  const [hover, setHover] = React.useState<string | null>(null);
  /** A link clicked: that row stays lit, and the page jumps to it. */
  const [pinned, setPinned] = React.useState<string | null>(null);

  /*
   * NEWEST FIRST on screen, oldest first underneath. The running balance can
   * only be computed oldest first; each row keeps the balance it was given,
   * so the top row is what was owed at the end of the period.
   */
  const rows = [...ledger.entries].reverse();
  const shown = rows.slice((page - 1) * perPage, page * perPage);
  const lastPage = Math.max(1, Math.ceil(rows.length / perPage));
  const lit = pinned ?? hover;

  /** Jump to the row a link names, on whichever page it is. */
  const goTo = (id: string) => {
    const at = rows.findIndex((e) => rowId(e) === id);
    if (at >= 0) setPage(Math.floor(at / perPage) + 1);
    setPinned((current) => (current === id ? null : id));
  };

  if (rows.length === 0) {
    return (
      <EmptyBox
        title="Nothing in this period"
        body="No bills or payments fall inside it. Try another year, or All time."
      />
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
        <Table
          minWidth={compact ? 640 : 800}
          head={
            <>
              {compact ? null : <Th width={104}>Date</Th>}
              <Th width={compact ? 168 : 150}>{compact ? "Date · bill / payment" : "Bill / payment"}</Th>
              <Th>Settlement</Th>
              <Th align="right" width={96}>Billed</Th>
              <Th align="right" width={96}>Received</Th>
              <Th align="right" width={104}>Balance</Th>
              {canReverse ? (
                <Th align="right" width={40}>
                  <span className="sr-only">Actions</span>
                </Th>
              ) : null}
            </>
          }
        >
          {shown.map((e, i) => {
            const id = rowId(e);
            const dead = deadStatus(e.status);
            const on =
              lit != null && (id === lit || (e.links ?? []).some((l) => l.id === lit));
            return (
              <tr
                key={`${e.at}-${e.ref}-${i}`}
                onMouseEnter={() => setHover(id)}
                onMouseLeave={() => setHover(null)}
                className={cx(
                  "border-b border-divider border-l-[3px] align-top transition-colors",
                  on ? "border-l-line-strong bg-canvas" : "border-l-transparent bg-surface",
                )}
              >
                {compact ? null : (
                  <td className={cx(TD, "text-body", dead && "text-muted line-through")}>
                    {longDate(e.at)}
                  </td>
                )}
                <td className={cx(TD_WRAP, "break-words")}>
                  <EntryName entry={e} withDate={compact} />
                </td>
                <td className={TD_WRAP}>
                  {e.kind === "bill" ? (
                    <BillSettlement entry={e} onLink={goTo} />
                  ) : (
                    <ReceiptSettlement entry={e} onLink={goTo} />
                  )}
                </td>
                <td className={cx(TD, "text-right tabular-nums text-body", dead && "line-through")}>
                  {e.debit ? money(e.debit) : <span className="text-muted">—</span>}
                </td>
                <td
                  className={cx(
                    TD,
                    "text-right tabular-nums",
                    e.credit && !dead ? "text-body" : "text-muted",
                    dead && "line-through",
                  )}
                >
                  {e.credit ? money(e.credit) : "—"}
                </td>
                <td className={cx(TD, "text-right font-medium tabular-nums text-ink")}>
                  {signedMoney(e.balance)}
                </td>
                {canReverse ? (
                  <td className="w-10 px-1.5 py-2.5 text-right align-middle">
                    {e.kind === "receipt" && e.status === "confirmed" && e.receiptId ? (
                      <RowMenu
                        items={[
                          {
                            label: "Reverse payment",
                            destructive: true,
                            title: "A bounced cheque, a duplicate entry, or money on the wrong customer",
                            onSelect: () => setReversing(e),
                          },
                        ]}
                      />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}

          {/*
            The opening balance is what was owed BEFORE this range, so it
            belongs under the oldest entry — the bottom of the last page.
          */}
          {from && page === lastPage ? (
            <tr className="border-t border-divider bg-surface">
              <td colSpan={compact ? 4 : 5} className="px-3 py-2.5 text-sm text-muted">
                Opening balance
              </td>
              <td className="px-3 py-2.5 text-right text-sm tabular-nums text-muted">
                {money(ledger.openingBalance)}
              </td>
              {canReverse ? <td /> : null}
            </tr>
          ) : null}
        </Table>

        <Pager
          total={rows.length}
          page={page}
          perPage={perPage}
          note="The balance counts confirmed money only, so it agrees with what the customer owes"
          onPage={setPage}
          onPerPage={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      </div>

      {/*
        A reason is required and it goes on the statement, because somebody has
        to ring the customer and say something.
      */}
      <ConfirmDialog
        key={reversing?.receiptId ?? "none"}
        open={Boolean(reversing)}
        title={`Reverse ${reversing ? money(reversing.credit) : ""}?`}
        body={`The receipt keeps its row on this statement and the money goes back onto ${
          reversing?.links?.length
            ? reversing.links.map((l) => l.label).join(", ")
            : "the account"
        }. Use this when a payment counted and then failed — a bounced cheque, a duplicate entry, money applied to the wrong customer. If accounts simply never found it, reject it instead.`}
        confirmLabel="Reverse payment"
        destructive
        needsReason
        onClose={() => setReversing(null)}
        onConfirm={async (why) => {
          if (!reversing?.receiptId) return;
          const result = await run(reverseReceiptAction(reversing.receiptId, why));
          if (result.ok) {
            setReversing(null);
            onReversed();
          }
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function BalanceFigure({
  label,
  value,
  sub,
  strong = false,
}: {
  label: string;
  value: string;
  sub: string;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className={cx("mt-1 tabular-nums text-ink", strong ? "text-[22px] font-semibold" : "text-[20px] font-medium")}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </div>
  );
}

function Operator({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden="true" className="text-lg font-light text-muted">
      {children}
    </span>
  );
}

/** What the line is: a bill by its number, or a payment by its mode and reference. */
function EntryName({ entry: e, withDate = false }: { entry: LedgerEntry; withDate?: boolean }) {
  const dead = deadStatus(e.status);
  // The detail sentence starts with the mode; the reference is the ref
  // unless the receipt has none, in which case the server put the mode there.
  const mode = e.detail.split(" · ")[0];
  const hasReference = e.ref !== "—" && e.ref !== mode;
  return (
    <span className="block min-w-0">
      {withDate ? (
        <span className={cx("block text-xs text-muted", dead && "line-through")}>
          {longDate(e.at)}
        </span>
      ) : null}
      <span className={cx("block font-medium whitespace-nowrap", dead ? "text-muted line-through" : "text-ink")}>
        {e.kind === "bill" ? e.ref : mode}
      </span>
      <span className="block text-xs text-muted">
        {e.kind === "bill" ? "Bill" : `Payment · ${hasReference ? `ref ${e.ref}` : "no reference"}`}
      </span>
    </span>
  );
}

/** Where the bill stands, and which payments got it there. */
function BillSettlement({
  entry: e,
  onLink,
}: {
  entry: LedgerEntry;
  onLink: (id: string) => void;
}) {
  const paid = e.paid ?? 0;
  const links = e.links ?? [];
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <BillStatus amount={e.debit} paid={paid} unstated={e.unstated} />
        {e.detail.includes("disputed") ? <Pill tone="danger">disputed</Pill> : null}
        {(e.claimed ?? 0) > 0 ? (
          <Pill tone="warn">{money(e.claimed!)} claimed, not yet confirmed</Pill>
        ) : null}
      </div>
      {links.length ? (
        <div className="text-xs text-muted">
          Paid by{" "}
          {links.map((l, i) => (
            <React.Fragment key={`${l.id}-${i}`}>
              {i > 0 ? ", " : null}
              <TextLink
                onClick={() => onLink(l.id)}
                status={l.status}
                title={`${l.mode ?? "Payment"} received ${longDate(l.at)}${l.label !== l.mode ? ` · ref ${l.label}` : ""}${(l.receiptBills ?? 1) > 1 && l.receiptAmount ? ` · part of a ${money(l.receiptAmount)} payment split across ${l.receiptBills} bills` : ""}`}
              >
                {shortDate(l.at)} {l.mode ?? l.label} {money(l.amount)}
              </TextLink>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BillStatus({ amount, paid, unstated }: { amount: number; paid: number; unstated?: boolean }) {
  if (unstated && paid === 0) return <span className="text-sm text-muted">Payment not stated</span>;
  if (amount > 0 && paid >= amount) return <span className="text-sm text-body">Paid</span>;
  if (paid > 0) {
    return (
      <span className="text-sm text-body">
        Part paid · <span className="font-medium whitespace-nowrap text-danger">{money(amount - paid)} due</span>
        <span className="text-muted"> of {money(amount)}</span>
      </span>
    );
  }
  return (
    <span className="text-sm text-body">
      Unpaid · <span className="font-medium whitespace-nowrap text-danger">{money(amount)} due</span>
    </span>
  );
}

/** Which bills this payment settled, and anything left over. */
function ReceiptSettlement({
  entry: e,
  onLink,
}: {
  entry: LedgerEntry;
  onLink: (id: string) => void;
}) {
  const links = e.links ?? [];
  const onAccount = e.onAccount ?? 0;
  const status = e.status;
  const reason = status === "rejected" || status === "reversed"
    ? e.detail.split(" · ").slice(1).filter((p) => !p.endsWith("on account")).join(" · ")
    : "";
  const parts = links.length + (onAccount > 0 ? 1 : 0);
  const heading = !parts
    ? "Not against any bill"
    : links.length > 1
      ? `Split across ${links.length} bills`
      : links.length === 1
        ? "Against"
        : "Not against any bill";
  const linkLine = (l: LedgerLink, i: number) => (
    <div key={`${l.id}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <TextLink onClick={() => onLink(l.id)} status={status ?? l.status} title={`Bill ${l.label}, raised ${longDate(l.at)}`}>
        {l.label}
      </TextLink>
      <span className="tabular-nums text-body">{money(l.amount)}</span>
      <AllocationNote link={l} receiptStatus={status} />
    </div>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {links.length > 1 ? (
        <span className="text-xs text-muted">{heading}</span>
      ) : !links.length && !onAccount ? (
        <span className="text-sm text-muted">{heading}</span>
      ) : null}
      {links.map(linkLine)}
      {onAccount > 0 ? (
        <div className="flex items-baseline gap-x-2 text-sm" title="Received and not yet put against a bill">
          <span className="text-body">On account</span>
          <span className="tabular-nums text-body">{money(onAccount)}</span>
        </div>
      ) : null}
      {status !== "confirmed" ? (
        <div className="flex flex-wrap items-center gap-2">
          {status === "reported" ? <Pill tone="warn">reported, waiting for accounts</Pill> : null}
          {status === "held" ? <Pill tone="warn">on hold, being checked</Pill> : null}
          {status === "rejected" ? <Pill tone="danger">never arrived</Pill> : null}
          {status === "reversed" ? <Pill tone="danger">reversed</Pill> : null}
          {reason ? <span className="text-xs text-muted">{reason}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What this payment did to the bill: cleared it, or paid part of it and how
 * much is still due today. Money that has not counted says so instead —
 * calling an unconfirmed payment "part" would be claiming it landed.
 */
function AllocationNote({ link: l, receiptStatus }: { link: LedgerLink; receiptStatus: string | null }) {
  if (receiptStatus !== "confirmed") return null;
  if (l.billAmount == null || l.billDue == null) return null;
  if (l.billDue === 0) return <span className="text-xs text-muted">bill cleared</span>;
  return (
    <span className="text-xs text-muted" title="What is due on the bill today, after every confirmed payment">
      part of {money(l.billAmount)} · {money(l.billDue)} due now
    </span>
  );
}

/** A bill or payment named on another row — plain text that jumps to it. */
function TextLink({
  status,
  title,
  onClick,
  children,
}: {
  status: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const dead = deadStatus(status);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cx(
        "cursor-pointer border-none bg-transparent p-0 text-left font-medium tabular-nums underline decoration-line-strong underline-offset-2 hover:decoration-current",
        dead ? "text-muted line-through" : "text-ink hover:text-brand",
      )}
    >
      {children}
    </button>
  );
}

/**
 * BY BILL: every bill, and directly under it the money that went against it.
 * The statement answers "what is the balance"; this answers "was bill 1626
 * paid, and by what" — read down one block instead of matching two rows.
 */

export const TD_WRAP = "px-3 py-2.5 text-sm align-middle";

/**
 * This screen's header cell: the Accounts `HeadCell` with the same tighter
 * padding as the cells under it, so a seven-column statement fits the
 * narrowest window the app supports without scrolling sideways.
 */
export function Th({
  align = "left",
  width,
  children,
}: {
  align?: "left" | "right";
  width?: number;
  children?: React.ReactNode;
}) {
  return (
    <th
      style={width ? { width, minWidth: width } : undefined}
      className={cx(
        "sticky top-0 z-2 h-8.5 border-b border-line bg-canvas px-3 text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}
export const TD = `${TD_WRAP} whitespace-nowrap`;

const FIELD =
  "h-9 rounded-[4px] border border-line bg-surface px-2.5 text-sm text-body focus:border-brand focus:outline-none";

/** The table frame: scrolls sideways only if a screen is narrower than it. */
function Table({
  minWidth,
  head,
  children,
}: {
  minWidth: number;
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-auto">
      <table style={{ minWidth }} className="w-full border-collapse">
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A small status word. Coloured only for the exceptions. */
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "danger" | "warn" | "success" | "neutral";
  children: React.ReactNode;
}) {
  const skin = {
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn-ink",
    success: "bg-success-soft text-success",
    neutral: "bg-divider text-body",
  }[tone];
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-[9px] px-2 py-[3px] text-[11px] leading-[14px] font-medium tracking-[0.03em] whitespace-nowrap uppercase",
        skin,
      )}
    >
      {children}
    </span>
  );
}

function EmptyBox({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
      <div className="text-lg font-semibold text-ink">{title}</div>
      <p className="mx-auto mt-1.5 max-w-[460px] text-[15px] text-pretty text-muted">{body}</p>
    </div>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}
