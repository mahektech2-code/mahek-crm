"use client";

import * as React from "react";
import { CUSTOM_DATES } from "@/components/ui/year-filter";
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
 * where decisions about money are made.
 * ------------------------------------------------------------------------- */

type Statement = {
  ledger: StatementLedger;
  period: string;
  years: { fy: string[]; cy: string[] };
  today: string;
  from: string;
  to: string;
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

  React.useEffect(() => {
    let live = true;
    fetch(`/api/customer-statement?${query}`)
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
  }, [query]);

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
