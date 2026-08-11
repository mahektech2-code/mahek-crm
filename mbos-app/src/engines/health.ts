/**
 * How a customer is doing, as one number and as seven sentences.
 *
 * **The breakdown is not optional.** A bare score out of a hundred gets ignored
 * within a fortnight — a salesman shown "62" with nothing behind it either
 * treats it as gospel or, far more often, decides it is made up and stops
 * looking. What he can act on is "they last ordered 34 days into a 20-day
 * cycle", and that sentence has to come out of the same arithmetic that made
 * the number, or the two will drift and the screen will be caught lying.
 *
 * So every component returns its own score, its own weight and its own
 * sentence explaining its contribution, and the total is the weighted mean of
 * exactly those components. There is no path to the number that skips them.
 *
 * Weights are configuration and are **sum-normalised**, so a manager can raise
 * one without having to lower another and without the total quietly leaving
 * 0–100.
 *
 * Every threshold is an argument. Pure — no clock, no store; "today" reaches
 * this file already turned into day counts by the caller.
 */

export type HealthComponentKey =
  | 'recency'
  | 'consistency'
  | 'value_trend'
  | 'payment'
  | 'outstanding'
  | 'coverage'
  | 'complaints';

export type HealthComponent = {
  key: HealthComponentKey;
  label: string;
  /** 0–100. */
  score: number;
  /** The NORMALISED weight, so the breakdown on screen adds up to the total. */
  weight: number;
  /** Why this component scored what it did, in words a salesman would use. */
  sentence: string;
  /**
   * True when there was not enough history to judge and the component fell
   * back to its neutral score. Shown as "not enough history yet" rather than
   * being hidden — an absent component makes the total unexplainable.
   */
  unknown: boolean;
};

export type HealthResult = {
  /** 0–100, integer. */
  score: number;
  components: HealthComponent[];
};

export type HealthWeights = Record<HealthComponentKey, number>;

export type HealthInputs = {
  /* recency vs their own cycle */
  daysSinceLastOrder: number | null;
  /** Their measured buying cycle in days. Null until enough orders exist. */
  cycleDays: number | null;

  /* interval consistency */
  /** Gaps in days between consecutive orders, most recent first or last — order does not matter. */
  orderIntervalDays: number[];

  /* value trend */
  recentValuePaise: number | null;
  priorValuePaise: number | null;

  /* payment behaviour */
  paymentsOnTime: number;
  paymentsLate: number;

  /* outstanding pressure */
  outstandingPaise: number;
  creditLimitPaise: number | null;

  /* visit coverage */
  visitsMade: number;
  visitsExpected: number;

  /* complaints */
  openComplaints: number;
  oldestOpenComplaintDays: number | null;
};

export type HealthThresholds = {
  /**
   * The neutral score a component falls back to when there is no history. Not
   * zero: a brand-new customer is not a bad customer, and scoring him as one
   * puts every new shop at the bottom of a list sorted by health.
   */
  neutralScore: number;
  recency: {
    /** days-since / cycle at or below which recency is perfect. */
    onTimeRatio: number;
    /** …and at or above which it is nothing. */
    lateRatio: number;
  };
  consistency: {
    /** Fewer intervals than this and there is nothing to judge. */
    minIntervals: number;
    /** Coefficient of variation at or below which the pattern is steady. */
    steadyCoefficient: number;
    /** …and at or above which it is noise. */
    erraticCoefficient: number;
  };
  valueTrend: {
    /** Proportional growth scoring full marks, e.g. 0.2 for +20%. */
    growthForFull: number;
    /** Proportional decline scoring nothing, e.g. -0.3 for −30%. */
    declineForZero: number;
  };
  payment: {
    /** Fewer settled bills than this and payment behaviour is unknown. */
    minRecords: number;
  };
  outstanding: {
    /** Utilisation of the credit limit at or below which there is no pressure. */
    comfortableUtilisation: number;
    /** …and at or above which it is severe. */
    severeUtilisation: number;
  };
  complaints: {
    /** Points off per open complaint. */
    perComplaintPenalty: number;
    /** An open complaint this old costs a second full penalty on its own. */
    ageDaysForFullPenalty: number;
  };
};

const LABELS: Record<HealthComponentKey, string> = {
  recency: 'Order recency',
  consistency: 'Ordering pattern',
  value_trend: 'Value trend',
  payment: 'Payment behaviour',
  outstanding: 'Outstanding pressure',
  coverage: 'Visit coverage',
  complaints: 'Open complaints',
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * A falling score between two points: full marks at `good`, nothing at `bad`,
 * straight line between. Used by five of the seven components, because a step
 * function makes a customer's health jump six points on a day nothing happened.
 */
function slide(value: number, good: number, bad: number): number {
  if (bad === good) return value <= good ? 100 : 0;
  const t = (value - good) / (bad - good);
  return clamp(100 - t * 100, 0, 100);
}

const inrRough = (paise: number): string => '₹' + Math.round(paise / 100).toLocaleString('en-IN');

export function healthScore(
  inputs: HealthInputs,
  weights: HealthWeights,
  thresholds: HealthThresholds,
): HealthResult {
  const neutral = thresholds.neutralScore;
  const raw: Omit<HealthComponent, 'weight'>[] = [
    recency(inputs, thresholds, neutral),
    consistency(inputs, thresholds, neutral),
    valueTrend(inputs, thresholds, neutral),
    payment(inputs, thresholds, neutral),
    outstanding(inputs, thresholds, neutral),
    coverage(inputs, neutral),
    complaints(inputs, thresholds),
  ];

  // Sum-normalisation. Weights that sum to 3 and weights that sum to 1 must
  // produce the same score, or a manager nudging one number rescales the whole
  // book without meaning to.
  const total = raw.reduce((sum, c) => sum + Math.max(0, weights[c.key]), 0);
  const components: HealthComponent[] = raw.map((c) => ({
    ...c,
    weight: total > 0 ? Math.max(0, weights[c.key]) / total : 1 / raw.length,
  }));

  const score = Math.round(
    components.reduce((sum, c) => sum + c.score * c.weight, 0),
  );

  return { score: clamp(score, 0, 100), components };
}

/* ------------------------------------------------------------ components */

function recency(
  i: HealthInputs,
  t: HealthThresholds,
  neutral: number,
): Omit<HealthComponent, 'weight'> {
  const base = { key: 'recency' as const, label: LABELS.recency };
  if (i.daysSinceLastOrder == null) {
    return { ...base, score: neutral, unknown: true, sentence: 'No order on record yet.' };
  }
  // Judged against their OWN cycle, never a company-wide number: 30 days is
  // late for a shop that buys fortnightly and early for one that buys twice a
  // year, and a single threshold calls both of them wrong.
  if (i.cycleDays == null || i.cycleDays <= 0) {
    return {
      ...base,
      score: neutral,
      unknown: true,
      sentence: `Last ordered ${i.daysSinceLastOrder} days ago — not enough orders yet to know their cycle.`,
    };
  }
  const ratio = i.daysSinceLastOrder / i.cycleDays;
  const score = slide(ratio, t.recency.onTimeRatio, t.recency.lateRatio);
  return {
    ...base,
    score,
    unknown: false,
    sentence:
      ratio <= t.recency.onTimeRatio
        ? `Ordered ${i.daysSinceLastOrder} days into a ${i.cycleDays}-day cycle — on time.`
        : `${i.daysSinceLastOrder} days since the last order on a ${i.cycleDays}-day cycle — overdue.`,
  };
}

function consistency(
  i: HealthInputs,
  t: HealthThresholds,
  neutral: number,
): Omit<HealthComponent, 'weight'> {
  const base = { key: 'consistency' as const, label: LABELS.consistency };
  const gaps = i.orderIntervalDays.filter((d) => d > 0);
  if (gaps.length < t.consistency.minIntervals) {
    return {
      ...base,
      score: neutral,
      unknown: true,
      sentence: 'Not enough orders yet to see a pattern.',
    };
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  // Coefficient of variation rather than the raw spread: a week's wobble on a
  // fortnightly cycle is chaos, and on a yearly one it is nothing.
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  const score = slide(cv, t.consistency.steadyCoefficient, t.consistency.erraticCoefficient);
  return {
    ...base,
    score,
    unknown: false,
    sentence:
      cv <= t.consistency.steadyCoefficient
        ? `Orders come in steadily, about every ${Math.round(mean)} days.`
        : `Ordering is irregular — gaps averaging ${Math.round(mean)} days but jumping about.`,
  };
}

function valueTrend(
  i: HealthInputs,
  t: HealthThresholds,
  neutral: number,
): Omit<HealthComponent, 'weight'> {
  const base = { key: 'value_trend' as const, label: LABELS.value_trend };
  if (i.recentValuePaise == null || i.priorValuePaise == null || i.priorValuePaise <= 0) {
    return {
      ...base,
      score: neutral,
      unknown: true,
      sentence: 'Not enough billing history to compare one period against the last.',
    };
  }
  const change = (i.recentValuePaise - i.priorValuePaise) / i.priorValuePaise;
  // Growth is capped rather than rewarded without limit: one large one-off
  // order should not paint a shop healthy for a quarter.
  const score = slide(-change, -t.valueTrend.growthForFull, -t.valueTrend.declineForZero);
  const pct = Math.round(change * 100);
  return {
    ...base,
    score,
    unknown: false,
    sentence:
      change >= 0
        ? `Buying ${pct}% more than the period before — ${inrRough(i.recentValuePaise)} against ${inrRough(i.priorValuePaise)}.`
        : `Buying ${Math.abs(pct)}% less than the period before — ${inrRough(i.recentValuePaise)} against ${inrRough(i.priorValuePaise)}.`,
  };
}

function payment(
  i: HealthInputs,
  t: HealthThresholds,
  neutral: number,
): Omit<HealthComponent, 'weight'> {
  const base = { key: 'payment' as const, label: LABELS.payment };
  const settled = i.paymentsOnTime + i.paymentsLate;
  if (settled < t.payment.minRecords) {
    return {
      ...base,
      score: neutral,
      unknown: true,
      sentence: 'Too few settled bills to judge how they pay.',
    };
  }
  const score = clamp((i.paymentsOnTime / settled) * 100, 0, 100);
  return {
    ...base,
    score,
    unknown: false,
    sentence:
      i.paymentsLate === 0
        ? `All ${settled} bills paid on time.`
        : `${i.paymentsLate} of ${settled} bills paid late.`,
  };
}

function outstanding(
  i: HealthInputs,
  t: HealthThresholds,
  neutral: number,
): Omit<HealthComponent, 'weight'> {
  const base = { key: 'outstanding' as const, label: LABELS.outstanding };
  if (i.creditLimitPaise == null || i.creditLimitPaise <= 0) {
    // Outstanding on its own says nothing. ₹2 lakh owed is comfortable on a
    // ₹10 lakh limit and alarming on a ₹2 lakh one, so with no limit on file
    // there is no pressure to measure and the honest answer is "unknown".
    return {
      ...base,
      score: neutral,
      unknown: true,
      sentence: `${inrRough(i.outstandingPaise)} outstanding, with no credit limit on file to judge it against.`,
    };
  }
  const utilisation = i.outstandingPaise / i.creditLimitPaise;
  const score = slide(
    utilisation,
    t.outstanding.comfortableUtilisation,
    t.outstanding.severeUtilisation,
  );
  return {
    ...base,
    score,
    unknown: false,
    sentence: `${inrRough(i.outstandingPaise)} outstanding — ${Math.round(utilisation * 100)}% of their limit.`,
  };
}

function coverage(i: HealthInputs, neutral: number): Omit<HealthComponent, 'weight'> {
  const base = { key: 'coverage' as const, label: LABELS.coverage };
  if (i.visitsExpected <= 0) {
    return {
      ...base,
      score: neutral,
      unknown: true,
      sentence: 'No visit plan set for this shop.',
    };
  }
  const score = clamp((i.visitsMade / i.visitsExpected) * 100, 0, 100);
  return {
    ...base,
    score,
    unknown: false,
    sentence:
      i.visitsMade >= i.visitsExpected
        ? `Visited ${i.visitsMade} times against a plan of ${i.visitsExpected}.`
        : `Visited ${i.visitsMade} of the ${i.visitsExpected} times planned — this one is being missed.`,
  };
}

function complaints(i: HealthInputs, t: HealthThresholds): Omit<HealthComponent, 'weight'> {
  const base = { key: 'complaints' as const, label: LABELS.complaints };
  if (i.openComplaints <= 0) {
    return { ...base, score: 100, unknown: false, sentence: 'Nothing open against this shop.' };
  }
  // Age counts as much as count. One complaint open for two months does more
  // damage to a relationship than three raised this week, and a score that only
  // counted them would say the opposite.
  const age = i.oldestOpenComplaintDays ?? 0;
  const agePenalty =
    t.complaints.ageDaysForFullPenalty > 0
      ? clamp(age / t.complaints.ageDaysForFullPenalty, 0, 1) * t.complaints.perComplaintPenalty
      : 0;
  const score = clamp(100 - i.openComplaints * t.complaints.perComplaintPenalty - agePenalty, 0, 100);
  return {
    ...base,
    score,
    unknown: false,
    sentence:
      age > 0
        ? `${i.openComplaints} open, the oldest ${age} days old.`
        : `${i.openComplaints} open.`,
  };
}
