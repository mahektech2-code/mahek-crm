/**
 * His customers' targets — which shop is where, and which to work first.
 *
 * PURE, like every engine here: the rows come from `data/customer-targets.ts`
 * and nothing in this file reads the database or the clock. That is what lets
 * the order of a list he reads every morning be pinned by a test rather than
 * by somebody checking a handset.
 *
 * NOTHING HERE DECIDES A TARGET OR WHAT A SHOP ACHIEVED. Both are the office's
 * figures, read by the same query the CRM's Targets screen runs. This only
 * sorts, filters and adds up what arrived — a second implementation of
 * "achieved" on a phone is how the salesman and his manager come to quote one
 * shop two different numbers.
 */

export type CustomerTargetRow = {
  customerId: string;
  name: string;
  city: string | null;
  targetPaise: number;
  achievedPaise: number;
  /** Taken this month and waiting for accounts. Never part of achieved. */
  pendingPaise: number;
  /** Taken on this phone and not yet sent. Also never part of achieved. */
  unsentPaise: number;
  isDefault: boolean;
  carriedForward: boolean;
  lastOrderDate: string | null;
  /**
   * Sales bills the office asked of this shop in the month — null where it
   * asked for none. Optional because a phone that has not pulled since the
   * office started sending it holds rows without one.
   */
  billTarget?: number | null;
  /** Sales bills raised this month, as the office counts them. */
  billsAchieved?: number;
};

export type TargetState = 'met' | 'open' | 'not-started' | 'untargeted';
export type TargetFilter = 'open' | 'not-started' | 'met' | 'all';

export const TARGET_FILTERS: { key: TargetFilter; label: string }[] = [
  { key: 'open', label: 'Still open' },
  { key: 'not-started', label: 'Nothing yet' },
  { key: 'met', label: 'Met' },
  { key: 'all', label: 'All' },
];

/** What is left to reach. Never negative: a shop over target is met, not owed. */
export function gapPaise(r: CustomerTargetRow): number {
  return Math.max(0, r.targetPaise - r.achievedPaise);
}

/** Bills still to raise. Zero where no bill target is set, or it is met. */
export function billGap(r: CustomerTargetRow): number {
  return r.billTarget ? Math.max(0, r.billTarget - (r.billsAchieved ?? 0)) : 0;
}

/**
 * Where one shop stands.
 *
 * A shop with no target is its own answer rather than "met": nothing was asked
 * of it, so it cannot have been met, and calling it met would let a book of
 * untargeted shops read as a perfect month.
 *
 * A target is rupees, a number of bills, or both — and a shop asked for both
 * is met only when both are, the rule the office's Behind/Met tabs follow.
 */
export function stateOf(r: CustomerTargetRow): TargetState {
  const billTarget = r.billTarget ?? 0;
  if (r.targetPaise <= 0 && billTarget <= 0) return 'untargeted';
  if (gapPaise(r) === 0 && billGap(r) === 0) return 'met';
  if (r.achievedPaise <= 0 && (r.billsAchieved ?? 0) <= 0) return 'not-started';
  return 'open';
}

/**
 * "Still open" holds every shop with a gap, bought-nothing ones included —
 * they are the largest gaps there are, and the whole point of the filter.
 * "Nothing yet" is the narrower question: who has not bought at all.
 */
export function matches(r: CustomerTargetRow, filter: TargetFilter): boolean {
  const s = stateOf(r);
  switch (filter) {
    case 'open':
      return s === 'open' || s === 'not-started';
    case 'not-started':
      return s === 'not-started';
    case 'met':
      return s === 'met';
    case 'all':
      return true;
  }
}

/**
 * Biggest gap first — that is where the rest of the month is — then the
 * biggest target, then the name, so two shops with nothing left between them
 * never swap places from one pull to the next.
 */
export function sortForWork(rows: CustomerTargetRow[]): CustomerTargetRow[] {
  return [...rows].sort(
    (a, b) =>
      gapPaise(b) - gapPaise(a) ||
      b.targetPaise - a.targetPaise ||
      billGap(b) - billGap(a) ||
      a.name.localeCompare(b.name),
  );
}

export type TargetSummary = {
  /** Shops carrying a target above zero. */
  targeted: number;
  targetPaise: number;
  /**
   * Over EVERY row, targeted or not — the same sum the office's Targets
   * screen prints beside its total, so the two headlines are one figure.
   */
  achievedPaise: number;
  /** The sum of each shop's own gap — not target minus achieved, which an
      over-target shop would quietly pay down for a short one. */
  openPaise: number;
  /** Waiting for accounts plus not yet sent. */
  waitingPaise: number;
  /** Shops carrying a bill target, and the bills asked of and raised by them. */
  billTargeted: number;
  billTarget: number;
  billsAchieved: number;
  counts: Record<TargetFilter, number>;
};

export function summarise(rows: CustomerTargetRow[]): TargetSummary {
  const counts: Record<TargetFilter, number> = { open: 0, 'not-started': 0, met: 0, all: rows.length };
  let targeted = 0;
  let targetPaise = 0;
  let achievedPaise = 0;
  let openPaise = 0;
  let waitingPaise = 0;
  let billTargeted = 0;
  let billTarget = 0;
  let billsAchieved = 0;
  for (const r of rows) {
    achievedPaise += r.achievedPaise;
    waitingPaise += r.pendingPaise + r.unsentPaise;
    if (r.targetPaise > 0 || (r.billTarget ?? 0) > 0) targeted += 1;
    if (r.targetPaise > 0) {
      targetPaise += r.targetPaise;
      openPaise += gapPaise(r);
    }
    // Summed over the shops ASKED for a count, so "12 of 20 bills" compares
    // like with like — a shop with no bill target adds to neither side.
    if ((r.billTarget ?? 0) > 0) {
      billTargeted += 1;
      billTarget += r.billTarget ?? 0;
      billsAchieved += r.billsAchieved ?? 0;
    }
    for (const f of ['open', 'not-started', 'met'] as const) {
      if (matches(r, f)) counts[f] += 1;
    }
  }
  return {
    targeted,
    targetPaise,
    achievedPaise,
    openPaise,
    waitingPaise,
    billTargeted,
    billTarget,
    billsAchieved,
    counts,
  };
}

/**
 * Whole days between two `YYYY-MM-DD` dates, counted in UTC because they are
 * calendar days with no time in them. Null where either is missing or
 * unreadable — "last ordered —" is honest, "last ordered NaN days ago" is not.
 */
export function daysSince(iso: string | null, today: string): number | null {
  if (!iso) return null;
  const at = (s: string) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return y && m && d ? Date.UTC(y, m - 1, d) : NaN;
  };
  const n = Math.round((at(today) - at(iso)) / 86_400_000);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "Ordered today", "Last order 12 days ago", "No order on record". */
export function lastOrderWords(iso: string | null, today: string): string {
  const n = daysSince(iso, today);
  if (n === null) return 'No order on record';
  if (n === 0) return 'Ordered today';
  if (n === 1) return 'Last order yesterday';
  return `Last order ${n} days ago`;
}
