import type { BusinessDate } from "../business-date";
import type { MbosHealthComponent } from "../config/registry";

/* ---------------------------------------------------------------------------
 * The customer health score — brief §2.3, PROTOCOL.md §8.
 *
 * A cache in exactly the sense `outstanding`, `cycleDays` and `slowPayer` are.
 * It is computed here from facts the caller has already fetched, stored on the
 * customer, and rebuilt rather than hand-edited. PROTOCOL §8 puts it in the
 * server's column deliberately: a handset that could compute it would compute
 * it from a book that is hours old, and two salesmen would then disagree about
 * whether the same shop is at risk.
 *
 * PURE, like every other engine here. The clock is an argument, the
 * configuration is an argument, and there is no I/O — which is what lets the
 * weights be tuned and the effect be seen in a test rather than in production.
 *
 * Every component answers out of 100, and the weights (which must total 100)
 * decide how much each one matters. `components` comes back with the score so
 * a salesman shown 42 can be told which of the five earned it — a number
 * nobody can decompose is a number nobody argues with, and one nobody argues
 * with is one nobody acts on either.
 * ------------------------------------------------------------------------- */

export type HealthFacts = {
  /** Business dates, not timestamps. Null where it has never happened. */
  lastOrderDate: BusinessDate | null;
  lastVisitDate: BusinessDate | null;
  /** The customer's own measured cycle, in days. */
  cycleDays: number;
  /** Paise. Approved orders only — a declined one is not a sale. */
  recentOrderValuePaise: number;
  /** Paise, the window before that one. Zero where there is no history. */
  priorOrderValuePaise: number;
  /** How many bills went past their due date, and how many there were. */
  billsPaidLate: number;
  billsTotal: number;
  /** Paise past due today. */
  overduePaise: number;
  outstandingPaise: number;
  /** Complaints opened in the scoring window, and how many are still open. */
  complaintsOpened: number;
  complaintsOpen: number;
  /** How often this customer is meant to be SEEN, as against called. */
  visitFrequencyDays: number | null;
};

export type HealthResult = {
  score: number;
  components: Record<MbosHealthComponent, number>;
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Whole days from `from` to `on`, both calendar-free ISO day strings. */
function daysSince(on: BusinessDate, from: BusinessDate | null): number | null {
  if (!from) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${on}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * A decay from full marks at "ordered today" to nothing at twice the cycle.
 * Measured against the customer's OWN cycle rather than a fixed number of
 * days, because a 60-day buyer silent for six weeks is behaving normally and a
 * 7-day buyer silent for six weeks has gone.
 */
function orderRecency(facts: HealthFacts, on: BusinessDate): number {
  const days = daysSince(on, facts.lastOrderDate);
  // Never ordered is not the same as "ordered long ago", but it scores the
  // same here: neither is a customer buying from us.
  if (days === null) return 0;
  const window = Math.max(1, facts.cycleDays) * 2;
  return clamp(100 * (1 - days / window));
}

/** Growing, flat or shrinking. 50 is flat, so a steady account is not punished. */
function orderValueTrend(facts: HealthFacts): number {
  const now = facts.recentOrderValuePaise;
  const before = facts.priorOrderValuePaise;
  if (now === 0 && before === 0) return 0;
  if (before === 0) return 100;
  const ratio = now / before;
  // ±50% moves the score the whole way, which is a big enough swing to notice
  // and small enough that one large order does not peg it.
  return clamp(50 + ((ratio - 1) / 0.5) * 50);
}

/** Paying to terms, with what is overdue weighed against what is owed. */
function paymentBehaviour(facts: HealthFacts): number {
  if (facts.billsTotal === 0) return 50; // nothing has been asked of them yet
  const onTime = 1 - facts.billsPaidLate / facts.billsTotal;
  const overdueShare =
    facts.outstandingPaise > 0
      ? Math.min(1, facts.overduePaise / facts.outstandingPaise)
      : 0;
  return clamp(100 * onTime * (1 - 0.6 * overdueShare));
}

/** Seen recently enough, against how often this customer should be seen. */
function visitEngagement(facts: HealthFacts, on: BusinessDate): number {
  const days = daysSince(on, facts.lastVisitDate);
  if (days === null) return 0;
  const target = facts.visitFrequencyDays ?? Math.max(1, facts.cycleDays);
  return clamp(100 * (1 - days / (target * 2)));
}

/** Full marks for none; an open one costs more than a settled one. */
function complaints(facts: HealthFacts): number {
  return clamp(100 - facts.complaintsOpened * 10 - facts.complaintsOpen * 15);
}

export function computeHealth(
  facts: HealthFacts,
  weights: Record<MbosHealthComponent, number>,
  on: BusinessDate,
): HealthResult {
  const components: Record<MbosHealthComponent, number> = {
    orderRecency: orderRecency(facts, on),
    orderValueTrend: orderValueTrend(facts),
    paymentBehaviour: paymentBehaviour(facts),
    visitEngagement: visitEngagement(facts, on),
    complaints: complaints(facts),
  };

  // The weights are validated to total 100 by checkConsistency, but this
  // normalises anyway: a score that silently means "out of 87" because
  // somebody mistyped a weight is worse than one that is simply rescaled.
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 100;
  const weighted = (
    Object.keys(components) as MbosHealthComponent[]
  ).reduce((sum, key) => sum + components[key] * (weights[key] ?? 0), 0);

  return { score: clamp(weighted / total), components };
}
