/* ---------------------------------------------------------------------------
 * 2-§P — potential, current, and the gap between them.
 *
 * Pure, like every other engine here: it takes an estimate and some actual
 * revenue and returns the arithmetic. What makes it worth a file rather than a
 * subtraction at three call sites is the honesty rules, which are all about
 * what this must NOT claim.
 * ------------------------------------------------------------------------- */

export type Opportunity = {
  /** Paise a month, as somebody judged it. Null where nobody has. */
  potentialMonthlyPaise: number | null;
  /** Paise a month, measured from orders that actually counted. */
  currentMonthlyPaise: number;
  /**
   * The gap, or null where there is no estimate to subtract from.
   *
   * NEVER negative. A shop buying more than somebody guessed it could is not a
   * negative opportunity — it is an estimate that has been overtaken, and
   * printing "-₹40,000 opportunity" invites somebody to read it as a decline.
   * Zero and `beatingEstimate` say the true thing instead.
   */
  gapMonthlyPaise: number | null;
  /** Buying more than the estimate. Worth saying, and worth re-estimating. */
  beatingEstimate: boolean;
  /**
   * How stale the judgement is, in days. Null where there is no estimate or no
   * date on it. The screens print it: "he thought this in 2024" is most of what
   * a reader needs to know about a figure nothing can verify.
   */
  estimateAgeDays: number | null;
};

export function opportunity(input: {
  potentialMonthlyPaise: number | null;
  /** Revenue that COUNTED, over the window below. Never a catalogue guess. */
  revenuePaise: number;
  /** How many months that revenue spans. Twelve reads a year into a month. */
  months: number;
  estimatedAt: Date | string | null;
  today: Date | string;
}): Opportunity {
  const months = Math.max(1, input.months);
  const current = Math.round(input.revenuePaise / months);
  const potential = input.potentialMonthlyPaise;

  const estimateAgeDays = ageInDays(input.estimatedAt, input.today);

  if (potential == null || potential <= 0) {
    /* No estimate is NOT a gap of zero. Zero would read as "no opportunity
       here", which is a claim; the honest answer is that nobody has said. */
    return {
      potentialMonthlyPaise: null,
      currentMonthlyPaise: current,
      gapMonthlyPaise: null,
      beatingEstimate: false,
      estimateAgeDays,
    };
  }

  const raw = potential - current;
  return {
    potentialMonthlyPaise: potential,
    currentMonthlyPaise: current,
    gapMonthlyPaise: Math.max(0, raw),
    beatingEstimate: raw < 0,
    estimateAgeDays,
  };
}

/**
 * The ANNUAL figure, derived here and never stored.
 *
 * Twelve times the month. A stored second copy is one that can disagree —
 * somebody edits the month, the year stays where it was, and two screens quote
 * two numbers for one shop.
 */
export function annualise(monthlyPaise: number | null): number | null {
  return monthlyPaise == null ? null : monthlyPaise * 12;
}

function ageInDays(from: Date | string | null, to: Date | string): number | null {
  if (!from) return null;
  const a = typeof from === "string" ? Date.parse(from) : from.getTime();
  const b = typeof to === "string" ? Date.parse(to) : to.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
