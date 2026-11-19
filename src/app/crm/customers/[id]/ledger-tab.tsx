"use client";

import * as React from "react";
import { CorrectReceiptDialog } from "@/app/accounts/correct-receipt-dialog";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { CUSTOM_DATES } from "@/components/ui/year-filter";
import { longDate, money, stamp } from "@/lib/format";
import type { MyReportedReceipt } from "@/lib/services/receipt-service";
import {
  LedgerBalances,
  LedgerPeriodBar,
  StatementTable,
  type PeriodPatch,
  type StatementLedger,
} from "@/components/ledger/customer-statement";

/* ---------------------------------------------------------------------------
 * The customer record's Ledger tab: the Accounts customer account, here.
 *
 * The same shared statement Accounts → Customer account draws — the period
 * (current financial year by default), opening balance + billed − received =
 * closing balance, and the statement table with which bills each payment
 * settled — read from `/api/customer-statement`, which asks the same
 * `customerStatement` the Accounts page does. So a telecaller and the ledger
 * desk quote one customer one balance.
 *
 * Statement only: the By bill view, the export and Reverse stay in Accounts,
 * where decisions about money are made. The one write here is the viewer's
 * own: a payment THEY recorded that Accounts have not looked at yet can be
 * corrected (`correctReceipt`) instead of waiting to be rejected as "never
 * arrived" and recorded again.
 * ------------------------------------------------------------------------- */

type Statement = {
  ledger: StatementLedger;
  period: string;
  years: { fy: string[]; cy: string[] };
  today: string;
  from: string;
  to: string;
  /** The viewer's own claims still waiting for Accounts; null where they record no payments. */
  mine: { receipts: MyReportedReceipt[]; correct: { modes: string[]; datedModes: string[]; today: string } } | null;
};

type Ask = { period: string; from: string; to: string };

function queryFor(customerId: string, ask: Ask | null): string {
  const params = new URLSearchParams({ customer: customerId });
  if (ask) {
    if (ask.period === CUSTOM_DATES) {
      if (ask.from) params.set("from", ask.from);
      if (ask.to) params.set("to", ask.to);
    } else if (ask.period) {
      params.set("year", ask.period);
    }
  }
  return params.toString();
}

export function LedgerTab({ customerId }: { customerId: string }) {
  // Null until somebody picks: the server's default is the current FY.
  const [ask, setAsk] = React.useState<Ask | null>(null);
  const query = queryFor(customerId, ask);
  /* The answer to the last request, and separately the last statement that
     arrived — so a failed period change keeps the previous one on screen. */
  const [result, setResult] = React.useState<{ query: string; error?: string } | null>(null);
  const [good, setGood] = React.useState<Statement | null>(null);
  /* Bumped after a correction, so the same period is read again. */
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    fetch(`/api/customer-statement?${query}`, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (!live) return;
        if (ok) {
          setGood(body as Statement);
          setResult({ query });
        } else {
          setResult({ query, error: body?.error ?? "The statement could not be read." });
        }
      })
      .catch(() => {
        if (live) setResult({ query, error: "Could not reach MahekOne. Check the connection." });
      });
    return () => {
      live = false;
    };
  }, [query, round]);

  // What is on screen stays on screen while the next period loads, so the tab
  // does not flash empty between two years.
  const loading = result?.query !== query;
  const shown = good;

  const onPeriod = (patch: PeriodPatch) => {
    const base: Ask = shown
      ? { period: shown.period, from: shown.from, to: shown.to }
      : { period: "", from: "", to: "" };
    setAsk({ ...base, ...patch });
  };

  if (!shown) {
    return (
      <div className="p-5 text-sm text-muted">
        {result?.error ?? "Reading the statement…"}
      </div>
    );
  }

  return (
    <div className={loading ? "p-5 opacity-60 transition-opacity" : "p-5"} aria-busy={loading}>
      <LedgerPeriodBar
        period={shown.period}
        years={shown.years}
        today={shown.today}
        from={shown.from}
        to={shown.to}
        onChange={onPeriod}
      />
      <LedgerBalances
        ledger={shown.ledger}
        period={shown.period}
        from={shown.from}
        to={shown.to}
        today={shown.today}
      />
      {result?.error ? (
        <p className="mb-3 text-sm text-danger">{result.error}</p>
      ) : null}
      {shown.mine?.receipts.length ? (
        <MyWaitingPayments
          receipts={shown.mine.receipts}
          correct={shown.mine.correct}
          customerName={shown.ledger.customerName}
          onCorrected={() => setRound((n) => n + 1)}
        />
      ) : null}
      <StatementTable
        // A new period is a new statement: start it on its first page.
        key={`${shown.period}|${shown.from}|${shown.to}`}
        ledger={shown.ledger}
        from={shown.from}
        canReverse={false}
        onReversed={() => undefined}
        compact
      />
    </div>
  );
}

/**
 * The payments this person recorded that are still waiting for Accounts, each
 * with Correct. Held ones are not here: once Accounts hold a claim they are
 * the ones looking, and the server refuses the recorder then too.
 */
function MyWaitingPayments({
  receipts,
  correct,
  customerName,
  onCorrected,
}: {
  receipts: MyReportedReceipt[];
  correct: { modes: string[]; datedModes: string[]; today: string };
  customerName: string;
  onCorrected: () => void;
}) {
  const { run } = useToast();
  const [open, setOpen] = React.useState<MyReportedReceipt | null>(null);
  return (
    <section className="mb-4 rounded-[6px] border border-warn-line bg-warn-soft px-4 py-3">
      <h3 className="text-sm font-medium text-warn-ink">
        {receipts.length === 1 ? "A payment you recorded is" : `${receipts.length} payments you recorded are`} waiting for
        accounts
      </h3>
      <p className="mt-0.5 text-[13px] text-body">
        Nothing has counted yet. If a figure, date or reference was typed wrong, correct it here rather than waiting
        for it to be rejected.
      </p>
      <ul className="mt-2 divide-y divide-warn-line">
        {receipts.map((r) => (
          <li key={r.receiptId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="text-sm font-medium text-ink tabular-nums">{money(r.amount)}</span>
            <span className="text-[13px] text-body">
              {r.mode}
              {r.reference ? ` · ${r.reference}` : ""} · received {longDate(r.receivedAt)}
            </span>
            <span className="text-[13px] text-muted">recorded {stamp(r.reportedAt)}</span>
            <Button size="sm" className="ml-auto" onClick={() => setOpen(r)}>
              Correct
            </Button>
          </li>
        ))}
      </ul>
      {open ? (
        <CorrectReceiptDialog
          key={open.receiptId}
          receiptId={open.receiptId}
          detail={{ ...open, correct }}
          amount={open.amount}
          customerName={customerName}
          run={run}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            onCorrected();
          }}
        />
      ) : null}
    </section>
  );
}
