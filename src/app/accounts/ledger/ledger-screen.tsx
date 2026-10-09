"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/overlays";
import { reverseReceiptAction } from "@/lib/actions/payments";
import { CustomerSearch } from "../customer-search";
import type { AccountServing } from "@/lib/services/distributor-service";
import { downloadCsv, toCsv } from "@/lib/csv";
import { longDate, money, shortDate, signedMoney } from "@/lib/format";
import {
  Banner,
  Empty,
  HeadCell,
  MetricRow,
  Pager,
  Pill,
  ScreenHeader,
  Table,
  plural,
} from "../parts";

/* ---------------------------------------------------------------------------
 * The customer account — a statement.
 *
 * What was billed, what came in, and what is left after each line. The running
 * balance counts CONFIRMED money only, so it agrees with what the customer
 * owes at the bottom; anything still waiting on accounts is reported beside it
 * rather than folded in.
 *
 * Rejected receipts stay on it. A transfer that never landed is a fact about
 * the account, and dropping it leaves the next person wondering why the
 * balance never moved.
 * ------------------------------------------------------------------------- */

type LedgerLink = {
  id: string;
  label: string;
  mode?: string;
  at: string;
  amount: number;
  status: string;
};

type LedgerEntry = {
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

type Ledger = {
  customerId: string;
  customerName: string;
  openingBalance: number;
  entries: LedgerEntry[];
  totals: { billed: number; received: number; outstanding: number; onAccount: number };
  awaiting: { count: number; amount: number };
};

type View = "statement" | "bills";

/** Rejected or reversed: the receipt, and every allocation it made, counts for nothing. */
const deadStatus = (status: string | null | undefined) =>
  status === "rejected" || status === "reversed";

/** The id a row is known by — what a link on another row points at. */
const rowId = (e: LedgerEntry) => (e.kind === "bill" ? e.billId : e.receiptId) ?? null;

export function LedgerScreen({
  canReverse,
  ledger,
  serving,
  from,
  to,
  view,
}: {
  /**
   * Whether this person may take back money that has counted. The same
   * capability as confirming it — accounts hold the bank statement, and
   * taking money off an account is the same kind of decision as putting it on.
   */
  canReverse: boolean;
  ledger: Ledger | null;
  /** How the account is served — see the note on the page that reads it. */
  serving: AccountServing | null;
  from: string;
  to: string;
  /** Statement (date order, running balance) or By bill (each bill and the money against it). */
  view: View;
}) {
  const router = useRouter();
  const { push, run } = useToast();
  /*
   * Which receipt is being reversed. The reason is NOT held here — the confirm
   * dialog owns it and hands it back on confirm.
   */
  const [reversing, setReversing] = React.useState<LedgerEntry | null>(null);
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);
  /*
   * The row the pointer is on, by id. A row is lit when it IS that row or
   * links to it, so pointing at a payment lights the bills it paid and
   * pointing at a bill lights the payments that paid it — the answer to
   * "which bill was this for" without reading a word.
   */
  const [hover, setHover] = React.useState<string | null>(null);
  /** A link clicked: that row stays lit, and the page jumps to it. */
  const [pinned, setPinned] = React.useState<string | null>(null);

  if (!ledger) {
    return (
      <div className="px-6 pt-6 pb-12">
        <div className="max-w-[1400px]">
          <ScreenHeader
            title="Customer account"
            subtitle="Every bill and every payment, and which bills each payment settled."
          />
          <CustomerSearch
            title="Whose account?"
            hint="Customer name, phone, or a bill number as it is printed."
            placeholder="Shree Paints, MMI/26-27/1119…"
            onPick={(hit) => router.push(`/accounts/ledger?customer=${hit.customerId}`)}
          />
        </div>
      </div>
    );
  }

  const navigate = (patch: Partial<{ from: string; to: string; view: View }>) => {
    const params = new URLSearchParams({ customer: ledger.customerId });
    const next = { from, to, view, ...patch };
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    if (next.view !== "statement") params.set("view", next.view);
    setPage(1);
    setPinned(null);
    router.push(`/accounts/ledger?${params}`);
  };

  /*
   * NEWEST FIRST on screen, oldest first underneath. The running balance is
   * cumulative and can only be computed oldest first; what is reversed is the
   * reading order, and each row keeps the balance it was given — so the top
   * row is what the customer owes today. Copied before reversing: `reverse()`
   * mutates, and `ledger.entries` is also what the totals read.
   */
  const ordered = [...ledger.entries].reverse();
  const billsNewestFirst = ordered.filter((e) => e.kind === "bill");
  const looseMoney = ordered.filter(
    (e) => e.kind === "receipt" && (e.onAccount ?? 0) > 0 && !deadStatus(e.status),
  );

  const rows = view === "bills" ? billsNewestFirst : ordered;
  const shown = rows.slice((page - 1) * perPage, page * perPage);
  const lastPage = Math.max(1, Math.ceil(rows.length / perPage));
  const lit = pinned ?? hover;

  /** Jump to the row a link names, on whichever page it is. */
  const goTo = (id: string) => {
    const at = rows.findIndex((e) => rowId(e) === id);
    if (at >= 0) setPage(Math.floor(at / perPage) + 1);
    setPinned((current) => (current === id ? null : id));
  };

  const exportCsv = () => {
    downloadCsv(
      `mahek-account-${ledger.customerName.toLowerCase().replace(/\W+/g, "-")}`,
      toCsv(
        [
          "Date",
          "Type",
          "Reference",
          "Mode / status",
          "Paid against / paid by",
          "Billed (₹)",
          "Received (₹)",
          "Balance (₹)",
        ],
        ordered.map((e) => [
          e.at,
          e.kind === "bill" ? "Bill" : "Payment",
          e.ref,
          e.detail,
          [
            ...(e.links ?? []).map(
              (l) => `${l.label} ₹${Math.round(l.amount / 100)}${deadStatus(l.status) ? " (" + l.status + ")" : ""}`,
            ),
            ...(e.onAccount ? [`On account ₹${Math.round(e.onAccount / 100)}`] : []),
          ].join("; "),
          e.debit ? String(Math.round(e.debit / 100)) : "",
          e.credit ? String(Math.round(e.credit / 100)) : "",
          String(Math.round(e.balance / 100)),
        ]),
      ),
      [from, to],
    );
    push(`Exported ${plural(ledger.entries.length, "row")}`);
  };

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title={ledger.customerName}
          subtitle="Every bill and every payment on this account, and which bills each payment settled. Point at a line to light up what it is linked to."
          actions={
            <>
              <button onClick={() => router.push("/accounts/ledger")} className={BUTTON}>
                Another account
              </button>
              <button onClick={exportCsv} className={BUTTON}>
                Export
              </button>
            </>
          }
        />

        <MetricRow
          metrics={[
            {
              label: "Outstanding",
              value: money(ledger.totals.outstanding),
              sub: "confirmed money only",
              tone: ledger.totals.outstanding > 0 ? "danger" : undefined,
            },
            { label: "Billed", value: money(ledger.totals.billed), sub: from || to ? "in these dates" : "all time" },
            { label: "Received", value: money(ledger.totals.received), sub: "confirmed" },
            {
              label: "On account",
              value: money(ledger.totals.onAccount),
              sub: ledger.totals.onAccount ? "received, not against a bill" : "nothing held",
            },
            {
              label: "Awaiting confirmation",
              value: money(ledger.awaiting.amount),
              sub: ledger.awaiting.count
                ? plural(ledger.awaiting.count, "receipt")
                : "nothing waiting",
              tone: ledger.awaiting.count ? "danger" : undefined,
            },
          ]}
        />

        {/*
          WHY THIS STATEMENT LOOKS THE WAY IT DOES. A third-party customer has
          no bills and never will, and an empty statement with nothing saying
          why reads as data missing. Read-only: converting is a manager's.
        */}
        {serving?.thirdParty ? (
          <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-3.5 text-sm text-body">
            <span className="font-medium text-ink">Third-party customer.</span>{" "}
            We deliver here and do not bill it — the goods are invoiced to{" "}
            {serving.distributors.length
              ? serving.distributors.map((d) => d.name).join(", ")
              : "a distributor nobody has recorded yet"}
            . Bills and receipts on this account are the exceptions, not the rule.
          </div>
        ) : serving && serving.shops > 0 ? (
          <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-3.5 text-sm text-body">
            <span className="font-medium text-ink">Distributor.</span>{" "}
            {plural(serving.shops, "third-party customer")} are delivered to on
            this account&apos;s bills.
          </div>
        ) : null}

        {ledger.awaiting.count ? (
          <div className="mb-4">
            <Banner tone="warn">
              {money(ledger.awaiting.amount)} across{" "}
              {plural(ledger.awaiting.count, "receipt")} has been reported and not yet
              confirmed. It is not in the balance, and it will not be until somebody
              finds it.
            </Banner>
          </div>
        ) : null}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-[6px] border border-line bg-surface p-0.5">
            {(
              [
                ["statement", "Statement", `${ledger.entries.length}`],
                ["bills", "By bill", `${billsNewestFirst.length}`],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => navigate({ view: key })}
                className={cx(
                  "h-8 cursor-pointer rounded-[4px] px-3.5 text-sm font-medium",
                  view === key ? "bg-brand-soft text-brand" : "text-body hover:bg-canvas",
                )}
              >
                {label} <span className="ml-1 text-xs text-muted tabular-nums">{count}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => navigate({ from: e.target.value })}
              className={FIELD}
              aria-label="From"
            />
            <span>to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => navigate({ to: e.target.value })}
              className={FIELD}
              aria-label="To"
            />
            {from || to ? (
              <button
                onClick={() => navigate({ from: "", to: "" })}
                className="cursor-pointer border-none bg-transparent px-1 text-sm font-medium text-brand hover:text-brand-hover"
              >
                Clear dates
              </button>
            ) : null}
          </div>
        </div>

        {ledger.entries.length === 0 ? (
          <Empty
            title="Nothing on this account"
            body={
              from || to
                ? "No bills or payments fall inside these dates."
                : "This customer has never been billed."
            }
          />
        ) : view === "bills" ? (
          <BillWise
            bills={shown}
            looseMoney={page === lastPage ? looseMoney : []}
            total={rows.length}
            page={page}
            perPage={perPage}
            onPage={setPage}
            onPerPage={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={1100}
              head={
                <>
                  <HeadCell width={120}>Date</HeadCell>
                  <HeadCell width={220}>Bill / payment</HeadCell>
                  <HeadCell>Settlement</HeadCell>
                  <HeadCell align="right" width={120}>Billed</HeadCell>
                  <HeadCell align="right" width={120}>Received</HeadCell>
                  <HeadCell align="right" width={130}>Balance</HeadCell>
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
                      on
                        ? "border-l-brand bg-brand-soft"
                        : cx("border-l-transparent", i % 2 === 1 ? "bg-canvas" : "bg-surface"),
                    )}
                  >
                    <td className={cx(TD, "text-body", dead && "text-muted line-through")}>
                      {longDate(e.at)}
                    </td>
                    <td className={TD}>
                      <EntryName entry={e} />
                    </td>
                    <td className={cx(TD, "whitespace-normal")}>
                      {e.kind === "bill" ? (
                        <BillSettlement entry={e} onLink={goTo} />
                      ) : (
                        <ReceiptSettlement
                          entry={e}
                          onLink={goTo}
                          onReverse={
                            canReverse && e.status === "confirmed" && e.receiptId
                              ? () => setReversing(e)
                              : undefined
                          }
                        />
                      )}
                    </td>
                    <td className={cx(TD, "text-right tabular-nums text-body", dead && "line-through")}>
                      {e.debit ? money(e.debit) : <span className="text-muted">—</span>}
                    </td>
                    <td
                      className={cx(
                        TD,
                        "text-right tabular-nums",
                        e.credit && !dead ? "text-success" : "text-muted",
                        dead && "line-through",
                      )}
                    >
                      {e.credit ? money(e.credit) : "—"}
                    </td>
                    <td className={cx(TD, "text-right font-medium tabular-nums text-ink")}>
                      {signedMoney(e.balance)}
                    </td>
                  </tr>
                );
              })}

              {/*
                The opening balance is what was owed BEFORE this range, so it
                belongs under the oldest entry — the bottom of the last page.
              */}
              {from && page === lastPage ? (
                <tr className="border-t border-divider bg-surface">
                  <td colSpan={5} className="px-4 py-2.5 text-sm text-muted">
                    Opening balance
                  </td>
                  <td className="px-4 py-2.5 text-right text-sm tabular-nums text-muted">
                    {money(ledger.openingBalance)}
                  </td>
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
        )}
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
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/** What the line is: a bill by its number, or a payment by its mode and reference. */
function EntryName({ entry: e }: { entry: LedgerEntry }) {
  const dead = deadStatus(e.status);
  if (e.kind === "bill") {
    return (
      <span className="flex items-center gap-2">
        <KindTag kind="bill" />
        <span className={cx("font-medium whitespace-nowrap", dead ? "text-muted line-through" : "text-ink")}>
          {e.ref}
        </span>
      </span>
    );
  }
  // The detail sentence starts with the mode; the reference is the ref
  // unless the receipt has none, in which case the server put the mode there.
  const mode = e.detail.split(" · ")[0];
  const hasReference = e.ref !== "—" && e.ref !== mode;
  return (
    <span className="flex items-start gap-2">
      <KindTag kind="receipt" />
      <span className="min-w-0">
        <span className={cx("block font-medium", dead ? "text-muted line-through" : "text-ink")}>
          {mode}
        </span>
        <span className="block text-xs text-muted">
          {hasReference ? `Ref ${e.ref}` : "No reference"}
        </span>
      </span>
    </span>
  );
}

function KindTag({ kind }: { kind: "bill" | "receipt" }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 w-[58px] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold tracking-[0.04em] uppercase",
        kind === "bill" ? "bg-divider text-body" : "bg-success-soft text-success",
      )}
    >
      {kind === "bill" ? "Bill" : "Payment"}
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
  const due = Math.max(0, e.debit - paid);
  const links = e.links ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <BillStatus amount={e.debit} paid={paid} unstated={e.unstated} />
        {e.detail.includes("disputed") ? <Pill tone="danger">disputed</Pill> : null}
        {(e.claimed ?? 0) > 0 ? (
          <Pill tone="warn">{money(e.claimed!)} claimed, not yet confirmed</Pill>
        ) : null}
        {paid > 0 && due > 0 ? (
          <span className="text-xs text-muted">
            {money(paid)} paid of {money(e.debit)}
          </span>
        ) : null}
      </div>
      {links.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Paid by</span>
          {links.map((l, i) => (
            <LinkChip
              key={`${l.id}-${i}`}
              onClick={() => onLink(l.id)}
              status={l.status}
              title={`${l.mode ?? "Payment"} received ${longDate(l.at)}${l.label !== l.mode ? ` · ref ${l.label}` : ""}`}
            >
              {shortDate(l.at)} {l.mode ?? l.label} · {money(l.amount)}
            </LinkChip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BillStatus({ amount, paid, unstated }: { amount: number; paid: number; unstated?: boolean }) {
  if (unstated && paid === 0) return <Pill tone="neutral">payment not stated</Pill>;
  if (amount > 0 && paid >= amount) return <Pill tone="success">Paid in full</Pill>;
  if (paid > 0) return <Pill tone="warn">{money(amount - paid)} still due</Pill>;
  return <Pill tone="danger">Unpaid · {money(amount)} due</Pill>;
}

/** Which bills this payment settled, and anything left over. */
function ReceiptSettlement({
  entry: e,
  onLink,
  onReverse,
}: {
  entry: LedgerEntry;
  onLink: (id: string) => void;
  onReverse?: () => void;
}) {
  const links = e.links ?? [];
  const onAccount = e.onAccount ?? 0;
  const status = e.status;
  const reason = status === "rejected" || status === "reversed"
    ? e.detail.split(" · ").slice(1).filter((p) => !p.endsWith("on account")).join(" · ")
    : "";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">
          {links.length || onAccount ? "Against" : "Not against any bill"}
        </span>
        {links.map((l, i) => (
          <LinkChip
            key={`${l.id}-${i}`}
            onClick={() => onLink(l.id)}
            status={status ?? l.status}
            title={`Bill ${l.label}, raised ${longDate(l.at)}`}
          >
            {l.label} · {money(l.amount)}
          </LinkChip>
        ))}
        {onAccount > 0 ? (
          <span
            className="inline-flex h-6 items-center rounded-[4px] border border-dashed border-line-strong px-2 text-xs text-body"
            title="Received and not yet put against a bill"
          >
            On account · {money(onAccount)}
          </span>
        ) : null}
        {onReverse ? (
          <button
            type="button"
            onClick={onReverse}
            className="ml-1 cursor-pointer border-none bg-transparent px-0 text-xs font-medium text-muted underline-offset-2 hover:text-danger hover:underline"
          >
            Reverse…
          </button>
        ) : null}
      </div>
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

function LinkChip({
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
  const pending = status === "reported" || status === "held";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cx(
        "inline-flex h-6 cursor-pointer items-center rounded-[4px] border px-2 text-xs font-medium whitespace-nowrap tabular-nums",
        dead
          ? "border-line text-muted line-through"
          : pending
            ? "border-warn-edge bg-warn-soft text-warn-ink"
            : "border-line bg-surface text-ink hover:border-brand hover:text-brand",
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
function BillWise({
  bills,
  looseMoney,
  total,
  page,
  perPage,
  onPage,
  onPerPage,
}: {
  bills: LedgerEntry[];
  looseMoney: LedgerEntry[];
  total: number;
  page: number;
  perPage: number;
  onPage: (n: number) => void;
  onPerPage: (n: number) => void;
}) {
  if (total === 0) {
    return <Empty title="No bills in these dates" body="Payments on this account are on the Statement tab." />;
  }
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <Table
        minWidth={900}
        head={
          <>
            <HeadCell width={130}>Date</HeadCell>
            <HeadCell>Bill / payment against it</HeadCell>
            <HeadCell align="right" width={130}>Bill amount</HeadCell>
            <HeadCell align="right" width={130}>Paid</HeadCell>
            <HeadCell align="right" width={130}>Due</HeadCell>
            <HeadCell width={190}>Status</HeadCell>
          </>
        }
      >
        {bills.map((b) => {
          const paid = b.paid ?? 0;
          const due = Math.max(0, b.debit - paid);
          const links = b.links ?? [];
          return (
            <React.Fragment key={b.billId ?? b.ref}>
              <tr className="border-t border-line bg-canvas">
                <td className={cx(TD, "font-medium text-body")}>{longDate(b.at)}</td>
                <td className={TD}>
                  <span className="flex items-center gap-2">
                    <KindTag kind="bill" />
                    <span className="font-semibold text-ink">{b.ref}</span>
                    {(b.claimed ?? 0) > 0 ? (
                      <Pill tone="warn">{money(b.claimed!)} claimed</Pill>
                    ) : null}
                  </span>
                </td>
                <td className={cx(TD, "text-right font-medium tabular-nums text-ink")}>{money(b.debit)}</td>
                <td className={cx(TD, "text-right tabular-nums", paid ? "text-success" : "text-muted")}>
                  {paid ? money(paid) : "—"}
                </td>
                <td className={cx(TD, "text-right font-medium tabular-nums", due ? "text-danger" : "text-muted")}>
                  {b.unstated && paid === 0 ? "not stated" : due ? money(due) : "—"}
                </td>
                <td className={TD}>
                  <BillStatus amount={b.debit} paid={paid} unstated={b.unstated} />
                </td>
              </tr>
              {links.length ? (
                links.map((l, i) => {
                  const dead = deadStatus(l.status);
                  const pending = l.status === "reported" || l.status === "held";
                  return (
                    <tr key={`${l.id}-${i}`} className="border-t border-divider bg-surface">
                      <td className={cx(TD, "pl-8 text-muted", dead && "line-through")}>{longDate(l.at)}</td>
                      <td className={TD}>
                        <span className="flex items-center gap-2 pl-4">
                          <span className="text-muted">↳</span>
                          <span className={cx("text-body", dead && "text-muted line-through")}>
                            {l.mode ?? "Payment"}
                            {l.label !== l.mode ? <span className="text-muted"> · ref {l.label}</span> : null}
                          </span>
                        </span>
                      </td>
                      <td className={TD} />
                      <td
                        className={cx(
                          TD,
                          "text-right tabular-nums",
                          dead ? "text-muted line-through" : pending ? "text-warn-ink" : "text-success",
                        )}
                      >
                        {money(l.amount)}
                      </td>
                      <td className={TD} />
                      <td className={TD}>
                        {pending ? (
                          <Pill tone="warn">not yet confirmed</Pill>
                        ) : l.status === "rejected" ? (
                          <Pill tone="danger">never arrived</Pill>
                        ) : l.status === "reversed" ? (
                          <Pill tone="danger">reversed</Pill>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr className="border-t border-divider bg-surface">
                  <td className={TD} />
                  <td colSpan={5} className={cx(TD, "pl-12 text-xs text-muted")}>
                    No payment recorded against this bill
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}

        {looseMoney.length ? (
          <>
            <tr className="border-t border-line bg-canvas">
              <td colSpan={6} className={cx(TD, "font-medium text-ink")}>
                Received and not against any bill
                <span className="ml-2 text-xs font-normal text-muted">
                  on account — it will settle a bill once accounts allocate it
                </span>
              </td>
            </tr>
            {looseMoney.map((r) => (
              <tr key={r.receiptId} className="border-t border-divider bg-surface">
                <td className={cx(TD, "pl-8 text-muted")}>{longDate(r.at)}</td>
                <td className={TD}>
                  <span className="flex items-center gap-2 pl-4">
                    <span className="text-muted">↳</span>
                    <span className="text-body">{r.detail.split(" · ")[0]}</span>
                    {r.ref !== "—" && r.ref !== r.detail.split(" · ")[0] ? (
                      <span className="text-muted">· ref {r.ref}</span>
                    ) : null}
                  </span>
                </td>
                <td className={TD} />
                <td className={cx(TD, "text-right tabular-nums text-success")}>{money(r.onAccount ?? 0)}</td>
                <td className={TD} />
                <td className={TD}>
                  {r.status === "confirmed" ? (
                    <Pill tone="neutral">on account</Pill>
                  ) : (
                    <Pill tone="warn">not yet confirmed</Pill>
                  )}
                </td>
              </tr>
            ))}
          </>
        ) : null}
      </Table>
      <Pager
        total={total}
        page={page}
        perPage={perPage}
        note="Paid counts confirmed money only"
        onPage={onPage}
        onPerPage={onPerPage}
      />
    </div>
  );
}

const TD = "px-4 py-2.5 text-sm align-middle whitespace-nowrap";

const BUTTON =
  "h-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body hover:bg-canvas";

const FIELD =
  "h-9 rounded-[4px] border border-line bg-surface px-2.5 text-sm text-body focus:border-brand focus:outline-none";
