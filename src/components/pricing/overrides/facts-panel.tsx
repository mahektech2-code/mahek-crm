"use client";

/* ---------------------------------------------------------------------------
 * THE FACTS A SPECIAL PRICE IS WEIGHED ON — drawn the same when somebody asks
 * and when somebody decides, so the two read one set of numbers: what the
 * shop buys against what it says it will, how it pays, what the shops around
 * it pay, and what the discount gives away in rupees.
 * ------------------------------------------------------------------------- */

import { money } from "@/lib/format";
import type { RequestAdvice, ShopProductFacts } from "./types";

/** Whole months between two ISO dates, at least one. */
export function monthsBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.max(1, Math.round((b - a) / 86_400_000 / 30.44));
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-muted">{label}</span>
      <span className="text-right text-ink tabular-nums">{children}</span>
    </div>
  );
}

export function FactsPanel({
  facts,
  askedExGstPaise,
  months,
  claimedCans,
}: {
  facts: ShopProductFacts;
  /** The price being weighed, ex-GST — what was asked, or a counter. */
  askedExGstPaise: number | null;
  /** The period the give-away is counted over. */
  months: number;
  /** A volume somebody claimed for the shop, to set beside what it bought. */
  claimedCans?: number | null;
}) {
  const gap = facts.payToday && askedExGstPaise != null ? facts.payToday.ex - askedExGstPaise : null;
  const perMonth = gap != null && facts.avgCansPerMonth != null ? Math.max(0, gap) * facts.avgCansPerMonth : null;
  const cheaperNearby = askedExGstPaise != null ? facts.nearby.ratesEx.filter((r) => r <= askedExGstPaise).length : null;
  const p = facts.payment;
  return (
    <div className="rounded-[4px] border border-line bg-canvas px-4 py-3 text-sm">
      <Line label="Pays today">{facts.payToday ? `${money(facts.payToday.incl)} · ${facts.payToday.listName}` : "no list prices it"}</Line>
      {facts.book && facts.payToday && facts.book.incl !== facts.payToday.incl ? <Line label="Book price">{money(facts.book.incl)}</Line> : null}
      {facts.scheduled ? (
        <Line label="Book after">
          {money(facts.scheduled.incl)} from {facts.scheduled.date}
        </Line>
      ) : null}
      <Line label="Buys">
        {facts.avgCansPerMonth == null ? "nothing in six months" : `${facts.avgCansPerMonth} cans a month (6-month average)`}
        {claimedCans != null && facts.avgCansPerMonth != null && claimedCans > facts.avgCansPerMonth * 1.5 ? (
          <div className="text-[12px] text-warn-ink">claimed {claimedCans} — well above what they buy</div>
        ) : null}
      </Line>
      {facts.billed ? (
        <Line label="Billed, 6 months">
          {facts.billed.lines} lines · lowest {money(facts.billed.minEx)} ex
        </Line>
      ) : null}
      <Line label="Payment">
        <span className={p.overduePaise > 0 || p.slowPayer || p.creditBlocked ? "text-danger" : undefined}>
          {money(p.outstandingPaise)} outstanding
          {p.overduePaise > 0 ? ` · ${money(p.overduePaise)} overdue ${p.daysOverdue} days` : ""}
          {p.slowPayer ? " · slow payer" : ""}
          {p.creditBlocked ? " · supply stopped" : ""}
        </span>
      </Line>
      <Line label={`Others in ${facts.city}`}>
        {facts.nearby.shops === 0
          ? "no other shop priced for it"
          : `${facts.nearby.shops} shops · ${money(facts.nearby.minEx)}–${money(facts.nearby.maxEx)} ex, median ${money(facts.nearby.medianEx)}`}
        {cheaperNearby != null && facts.nearby.shops > 0 ? (
          <div className="text-[12px] text-muted">{cheaperNearby} already pay this or less</div>
        ) : null}
      </Line>
      {facts.liveOverride ? (
        <Line label="Already special">
          {money(facts.liveOverride.rateInclGstPaise)}
          {facts.liveOverride.validTo ? ` until ${facts.liveOverride.validTo}` : ", no end"}
        </Line>
      ) : null}
      <div className="mt-2 border-t border-line pt-2">
        <Line label={`Gives away over ${months} month${months === 1 ? "" : "s"}`}>
          {perMonth == null ? (
            <span className="text-muted">cannot say — {facts.avgCansPerMonth == null ? "no volume" : "no price today"}</span>
          ) : (
            <strong className={perMonth > 0 ? "text-danger" : undefined}>
              {money(perMonth * months)} <span className="font-normal text-muted">({money(perMonth)} a month)</span>
            </strong>
          )}
        </Line>
      </div>
    </div>
  );
}

const VERDICT: Record<string, { word: string; tone: string }> = {
  approve: { word: "Approve", tone: "text-success" },
  counter: { word: "Counter", tone: "text-warn-ink" },
  refuse: { word: "Refuse", tone: "text-danger" },
};

/** Both models side by side. A disagreement is shown, never averaged. */
export function AdvicePanel({ advice }: { advice: RequestAdvice[] }) {
  const verdicts = new Set(advice.filter((a) => a.ok).map((a) => a.verdict));
  return (
    <div>
      {advice.filter((a) => a.ok).length === 2 && verdicts.size > 1 ? (
        <p className="mb-2 text-[13px] text-warn-ink">The two models disagree. Read both reasons; the decision is yours.</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {advice.map((a) => (
          <div key={a.provider} className="rounded-[4px] border border-line px-3 py-2 text-[13px]">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium text-ink">{a.label}</span>
              {a.ok && a.verdict ? <span className={`font-semibold ${VERDICT[a.verdict].tone}`}>{VERDICT[a.verdict].word}</span> : null}
            </div>
            {!a.ok ? (
              <p className="text-muted">{a.reason}</p>
            ) : (
              <>
                {a.priceInclGstPaise != null && a.verdict !== "refuse" ? (
                  <p className="text-body">
                    at {money(a.priceInclGstPaise)} incl GST
                    {a.months ? ` for ${a.months} months` : ""}
                    {a.minCansPerMonth ? `, held to ${a.minCansPerMonth} cans a month` : ""}
                  </p>
                ) : null}
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-body">
                  {a.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                {a.risk ? <p className="mt-1 text-muted">Risk: {a.risk}</p> : null}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
