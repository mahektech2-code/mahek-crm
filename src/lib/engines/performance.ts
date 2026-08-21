import type { BusinessDate } from "../business-date";
import type { Config } from "../config/registry";

/* ---------------------------------------------------------------------------
 * E10 — Salesman performance.
 *
 * What a person is measured on, and how six answers become one number.
 *
 * The whole module exists because "₹10 lakh billed" is not a measure of
 * selling. A price rise makes every rupee figure go up without a single extra
 * can leaving the godown, and a salesman who works only the products that sell
 * themselves bills well and grows nothing. So revenue is one of six questions
 * rather than the question, and volume in litres sits beside it as the half
 * that a price revision cannot move.
 *
 * Pure — configuration and the business date come in as arguments, nothing is
 * read and nothing is written. The wiring is in
 * `lib/services/performance-service.ts`.
 * ------------------------------------------------------------------------- */

/**
 * Basis points: 10000 is 100%.
 *
 * Achievement is not an integer percentage. 103.85% is a real answer to
 * ₹13.5L against ₹13L, and rounding it to 104 before it is weighted moves the
 * final score by more than the rounding saved. Integers all the way through,
 * like money, and divided only on the way to a screen.
 */
export type Bp = number;

export const BP = 10_000;

export const COMPONENT_KEYS = [
  "revenue",
  "volume",
  "mix",
  "newCustomers",
  "collection",
  "activity",
] as const;

export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export type PerformanceConfig = Pick<
  Config,
  | "performance.weightRevenue"
  | "performance.weightVolume"
  | "performance.weightMix"
  | "performance.weightNewCustomers"
  | "performance.weightCollection"
  | "performance.weightActivity"
  | "performance.maxAchievementPercent"
  | "performance.mixScoreAtMinimum"
  | "performance.mixScoreAtTarget"
  | "performance.mixScoreAtStretch"
  | "performance.ratingBands"
  | "performance.volumeDivergencePoints"
  | "performance.paceWarningPercent"
>;

export function weightsFrom(config: PerformanceConfig): Record<ComponentKey, number> {
  return {
    revenue: config["performance.weightRevenue"],
    volume: config["performance.weightVolume"],
    mix: config["performance.weightMix"],
    newCustomers: config["performance.weightNewCustomers"],
    collection: config["performance.weightCollection"],
    activity: config["performance.weightActivity"],
  };
}

/* ------------------------------------------------------------- achievement */

/**
 * Achieved against asked, in basis points.
 *
 * **A target of zero returns null, and null is not zero.** Nobody was asked for
 * anything, so there is no achievement to report — scoring it 0% would punish
 * somebody for a target that was never set, and scoring it 100% would hand out
 * the weight for free. What happens to the weight is `weightedScore`'s
 * business, and what it does is redistribute it.
 */
export function achievementBp(actual: number, target: number): Bp | null {
  if (target <= 0) return null;
  return Math.round((actual / target) * BP);
}

/**
 * What a component contributes, once the ceiling is applied.
 *
 * The cap exists so one extraordinary month on one component cannot carry a
 * score past everything else being wrong: 400% of a small revenue target would
 * otherwise pay 140 points out of a possible 35. It applies to SCORING and
 * never to display — the screens print 385% and score 120%, because hiding the
 * real figure would be the more confusing of the two.
 */
export function cappedBp(achievement: Bp, config: PerformanceConfig): Bp {
  const ceiling = Math.round((config["performance.maxAchievementPercent"] / 100) * BP);
  return Math.min(achievement, ceiling);
}

/* ---------------------------------------------------------------- the mix */

export type MixBand = {
  categoryId: string;
  name: string;
  /** Share of total value, in basis points. */
  minimumBp: Bp;
  targetBp: Bp;
  stretchBp: Bp;
};

export type MixActual = {
  categoryId: string;
  /** Paise sold in this category. */
  valuePaise: number;
  /** Millilitres sold in this category, where the lines could be matched. */
  millilitres: number;
};

export type MixCategoryResult = MixBand & {
  valuePaise: number;
  millilitres: number;
  /** This category's actual share of the total, in basis points. */
  actualBp: Bp;
  /** How the share stands against the band. */
  status: "below-minimum" | "below-target" | "on-target" | "stretch";
  /** What this category earned, 0..(mixScoreAtStretch/100), in basis points. */
  scoreBp: Bp;
};

export type MixResult = {
  categories: MixCategoryResult[];
  /** Total value the mix was computed over — the denominator of every share. */
  totalPaise: number;
  /** The mix component's own achievement, in basis points, capped at 100%. */
  achievementBp: Bp | null;
};

/**
 * Where an actual share sits against its band, as a fraction of the points the
 * category is worth.
 *
 * Piecewise linear between four anchors — zero, minimum, target, stretch —
 * because a step function makes 24.9% and 25.0% differ by the whole band, and
 * a salesman one tenth of a point short of the minimum has not done a
 * different job to one who reached it. Where those anchors pay is
 * configuration: §7 of the brief says in as many words that management must be
 * able to decide what minimum, target and stretch are worth.
 */
export function mixCategoryScoreBp(
  actualBp: Bp,
  band: MixBand,
  config: PerformanceConfig,
): Bp {
  const atMin = (config["performance.mixScoreAtMinimum"] / 100) * BP;
  const atTarget = (config["performance.mixScoreAtTarget"] / 100) * BP;
  const atStretch = (config["performance.mixScoreAtStretch"] / 100) * BP;

  const lerp = (v: number, lo: number, hi: number, loOut: number, hiOut: number) =>
    hi <= lo ? hiOut : loOut + ((v - lo) / (hi - lo)) * (hiOut - loOut);

  if (actualBp <= 0) return 0;
  if (actualBp < band.minimumBp) {
    return Math.round(lerp(actualBp, 0, band.minimumBp, 0, atMin));
  }
  if (actualBp < band.targetBp) {
    return Math.round(lerp(actualBp, band.minimumBp, band.targetBp, atMin, atTarget));
  }
  if (actualBp < band.stretchBp) {
    return Math.round(lerp(actualBp, band.targetBp, band.stretchBp, atTarget, atStretch));
  }
  return Math.round(atStretch);
}

function statusFor(actualBp: Bp, band: MixBand): MixCategoryResult["status"] {
  if (actualBp < band.minimumBp) return "below-minimum";
  if (actualBp < band.targetBp) return "below-target";
  if (actualBp < band.stretchBp) return "on-target";
  return "stretch";
}

/**
 * The product mix, scored.
 *
 * The mix is computed on VALUE and not on litres, which is §6 of the brief and
 * is also the only reading the data supports: a category's share of the money
 * is a fact about every order line, and its share of the litres is a fact only
 * about the lines whose product name matched the catalogue. Litres are carried
 * alongside and shown, never scored.
 *
 * **Each category is weighted by what it was ASKED for, not by what arrived.**
 * Weighting by the actual share would let somebody who sold nothing but Other
 * score a perfect mix — Other would be the only category with any weight, and
 * it would be far above its target. The target shares are the question, so
 * they are the weights, and a category that came in at nothing drags the score
 * down by exactly what it was supposed to contribute.
 */
export function scoreMix(
  bands: MixBand[],
  actuals: MixActual[],
  config: PerformanceConfig,
): MixResult {
  const byCategory = new Map(actuals.map((a) => [a.categoryId, a]));
  const totalPaise = actuals.reduce((sum, a) => sum + a.valuePaise, 0);

  const categories: MixCategoryResult[] = bands.map((band) => {
    const actual = byCategory.get(band.categoryId);
    const valuePaise = actual?.valuePaise ?? 0;
    const actualBp = totalPaise > 0 ? Math.round((valuePaise / totalPaise) * BP) : 0;
    return {
      ...band,
      valuePaise,
      millilitres: actual?.millilitres ?? 0,
      actualBp,
      status: statusFor(actualBp, band),
      scoreBp: mixCategoryScoreBp(actualBp, band, config),
    };
  });

  // Nothing sold, or nobody set a mix: there is no share to measure, and a mix
  // score of zero would read as a judgement rather than as an absence.
  const weightTotal = bands.reduce((sum, b) => sum + b.targetBp, 0);
  if (totalPaise <= 0 || weightTotal <= 0) {
    return { categories, totalPaise, achievementBp: null };
  }

  const earned = categories.reduce((sum, c) => sum + c.scoreBp * c.targetBp, 0);
  // Capped at 100%: stretch on one category is credit inside the mix, never a
  // way for the mix component as a whole to pay more than it is worth.
  const achievement = Math.min(BP, Math.round(earned / weightTotal));

  return { categories, totalPaise, achievementBp: achievement };
}

/* ------------------------------------------------------------- the score */

export type ComponentInput = {
  key: ComponentKey;
  actual: number;
  target: number;
  /** Supplied where the component computes its own achievement, as the mix does. */
  achievementBp?: Bp | null;
};

export type ComponentScore = {
  key: ComponentKey;
  actual: number;
  target: number;
  /** As achieved. Uncapped, which is what a screen prints. */
  achievementBp: Bp | null;
  /** What was scored — the ceiling applied. */
  scoredBp: Bp | null;
  /** The configured weight, before redistribution. */
  weight: number;
  /** The weight actually used, after untargeted components gave theirs up. */
  effectiveWeight: number;
  /** Points out of 100, in basis points. */
  pointsBp: Bp;
};

export type ScoreResult = {
  components: ComponentScore[];
  /** Out of 100, in basis points. 9140 is 91.40. */
  totalBp: Bp;
  /**
   * Components that were left out because nothing was asked of them. Named so
   * a screen can say which, rather than showing a score out of 100 that was
   * quietly computed out of 65.
   */
  untargeted: ComponentKey[];
};

/**
 * Six achievements, six weights, one number out of a hundred.
 *
 * **A component nobody set a target for is dropped and its weight is shared
 * out**, in proportion, among the components that do have one. The alternative
 * readings are both worse: scoring it zero marks somebody down for a question
 * never asked, and scoring it full pays them for it. Dropping it means the
 * score always answers "against what was actually asked of this person", which
 * is the only sentence a manager can defend in an appraisal. The names of the
 * dropped components come back with the result so the screen can say so.
 *
 * If NOTHING was targeted there is no score at all, and the result says zero
 * with every component untargeted rather than pretending to a figure.
 */
export function weightedScore(
  inputs: ComponentInput[],
  config: PerformanceConfig,
): ScoreResult {
  const weights = weightsFrom(config);

  const raw = inputs.map((input) => {
    const achievement =
      input.achievementBp !== undefined
        ? input.achievementBp
        : achievementBp(input.actual, input.target);
    return { input, achievement, weight: weights[input.key] ?? 0 };
  });

  const live = raw.filter((r) => r.achievement !== null);
  const liveWeight = live.reduce((sum, r) => sum + r.weight, 0);

  const components: ComponentScore[] = raw.map((r) => {
    const scored = r.achievement === null ? null : cappedBp(r.achievement, config);
    const effectiveWeight =
      r.achievement === null || liveWeight <= 0
        ? 0
        : (r.weight / liveWeight) * 100;
    return {
      key: r.input.key,
      actual: r.input.actual,
      target: r.input.target,
      achievementBp: r.achievement,
      scoredBp: scored,
      weight: r.weight,
      effectiveWeight,
      pointsBp: scored === null ? 0 : Math.round((scored * effectiveWeight) / 100),
    };
  });

  return {
    components,
    totalBp: components.reduce((sum, c) => sum + c.pointsBp, 0),
    untargeted: raw.filter((r) => r.achievement === null).map((r) => r.input.key),
  };
}

/* ------------------------------------------------------------------ rating */

export type RatingBand = { min: number; label: string };

/**
 * The word beside the number.
 *
 * Bands are configuration and are read highest-first, so a band list that does
 * not reach the bottom returns the lowest one rather than nothing — a score
 * with no word against it reads as a screen that failed.
 */
export function ratingFor(totalBp: Bp, config: PerformanceConfig): string {
  const bands = [...(config["performance.ratingBands"] as RatingBand[])].sort(
    (a, b) => b.min - a.min,
  );
  const score = totalBp / 100;
  for (const band of bands) if (score >= band.min) return band.label;
  return bands[bands.length - 1]?.label ?? "Unrated";
}

/* ---------------------------------------------------------------- forecast */

export type ForecastInput = {
  actual: number;
  target: number;
  workingDaysElapsed: number;
  workingDaysTotal: number;
};

export type Forecast = {
  /** Null before any working day has been completed. */
  projected: number | null;
  projectedAchievementBp: Bp | null;
  /** What is still needed, and null once the target is met. */
  shortfall: number | null;
  /** Per remaining working day. Null when none are left, or nothing is owed. */
  perRemainingDay: number | null;
  workingDaysRemaining: number;
};

/**
 * Where this lands if the rest of the month goes like the part already worked.
 *
 * **Working days, not calendar days.** A month with four Sundays left is not
 * two thirds gone because twenty of thirty dates have passed, and a forecast
 * built on dates tells a salesman on the 20th that he is further behind than
 * he is. The working-day count comes from the caller, which is what keeps
 * holidays and a territory's own week out of a pure function.
 *
 * No days worked means no projection. One day's selling extrapolated over a
 * month is not a forecast, it is a multiplication, and the screen says it is
 * too early instead.
 */
export function forecast(input: ForecastInput): Forecast {
  const remaining = Math.max(0, input.workingDaysTotal - input.workingDaysElapsed);
  if (input.workingDaysElapsed <= 0 || input.workingDaysTotal <= 0) {
    return {
      projected: null,
      projectedAchievementBp: null,
      shortfall: input.target > input.actual ? input.target - input.actual : null,
      perRemainingDay: null,
      workingDaysRemaining: remaining,
    };
  }

  const projected = Math.round(
    (input.actual / input.workingDaysElapsed) * input.workingDaysTotal,
  );
  const shortfall = input.target > input.actual ? input.target - input.actual : null;

  return {
    projected,
    projectedAchievementBp: achievementBp(projected, input.target),
    shortfall,
    perRemainingDay:
      shortfall !== null && remaining > 0 ? Math.ceil(shortfall / remaining) : null,
    workingDaysRemaining: remaining,
  };
}

/* ------------------------------------------------------------------ alerts */

export type AlertKey =
  | "price-not-volume"
  | "behind-pace"
  | "mix-below-minimum"
  | "no-new-customers"
  | "collection-behind"
  | "activity-behind";

export type Alert = {
  key: AlertKey;
  severity: "high" | "medium";
  /** One sentence, ready to render. No screen composes its own. */
  message: string;
};

export type AlertInput = {
  revenueBp: Bp | null;
  volumeBp: Bp | null;
  collectionBp: Bp | null;
  activityBp: Bp | null;
  newCustomerActual: number;
  newCustomerTarget: number;
  mix: MixResult;
  workingDaysElapsed: number;
  workingDaysTotal: number;
};

const pct = (bp: Bp) => `${(bp / 100).toFixed(0)}%`;

/**
 * What a manager needs told rather than left to find.
 *
 * The first of these is the one the module was commissioned for. Revenue at or
 * above target while volume is well below it means the money came from the
 * price list and not from selling more, which is invisible on any screen that
 * reports rupees alone — and it is exactly the month in which somebody would
 * otherwise be congratulated.
 */
export function alertsFor(input: AlertInput, config: PerformanceConfig): Alert[] {
  const alerts: Alert[] = [];
  const gap = config["performance.volumeDivergencePoints"] * 100;

  if (
    input.revenueBp !== null &&
    input.volumeBp !== null &&
    input.revenueBp >= BP &&
    input.volumeBp <= BP - gap
  ) {
    alerts.push({
      key: "price-not-volume",
      severity: "high",
      message: `Revenue is at ${pct(input.revenueBp)} of target but volume is only ${pct(input.volumeBp)}. The revenue came from price realisation rather than from selling more.`,
    });
  }

  // Behind the pace the month itself has set — measured against elapsed
  // working days, so a slow start in a week with two holidays is not an alert.
  if (input.revenueBp !== null && input.workingDaysTotal > 0) {
    const elapsedBp = Math.round(
      (input.workingDaysElapsed / input.workingDaysTotal) * BP,
    );
    const expected = Math.round(
      (elapsedBp * config["performance.paceWarningPercent"]) / 100,
    );
    if (input.workingDaysElapsed > 0 && input.revenueBp < expected) {
      alerts.push({
        key: "behind-pace",
        severity: "high",
        message: `Revenue is at ${pct(input.revenueBp)} with ${pct(elapsedBp)} of the working month gone.`,
      });
    }
  }

  const below = input.mix.categories.filter((c) => c.status === "below-minimum");
  if (below.length > 0) {
    alerts.push({
      key: "mix-below-minimum",
      severity: "medium",
      message: `${below
        .map((c) => `${c.name} at ${(c.actualBp / 100).toFixed(1)}%`)
        .join(", ")} — below the minimum share.`,
    });
  }

  if (input.newCustomerTarget > 0 && input.newCustomerActual === 0) {
    alerts.push({
      key: "no-new-customers",
      severity: "medium",
      message: `No new customer has placed a first order this month, against a target of ${input.newCustomerTarget}.`,
    });
  }

  if (input.collectionBp !== null && input.collectionBp < BP * 0.8) {
    alerts.push({
      key: "collection-behind",
      severity: "medium",
      message: `Collection is at ${pct(input.collectionBp)} of target.`,
    });
  }

  if (input.activityBp !== null && input.activityBp < BP * 0.8) {
    alerts.push({
      key: "activity-behind",
      severity: "medium",
      message: `Visits and calls are at ${pct(input.activityBp)} of what was asked.`,
    });
  }

  return alerts;
}

/* ------------------------------------------------------- what to do today */

export type FocusLine = {
  key: ComponentKey | "mix-category";
  /** The gap, said in the unit the person works in. */
  message: string;
  /** Paise, litres or a count — for ordering, never for display. */
  weight: number;
};

/**
 * The gaps, worst first, in the words a salesman uses.
 *
 * §36 of the brief: he should not have to understand the formula. He needs to
 * know that he is ₹1.7 lakh short and that PU is the thing that is short, and
 * the arithmetic behind that belongs on this side of the screen.
 */
export function focusLines(
  score: ScoreResult,
  mix: MixResult,
  today: BusinessDate,
): FocusLine[] {
  void today;
  const lines: FocusLine[] = [];

  for (const c of score.components) {
    if (c.achievementBp === null || c.achievementBp >= BP) continue;
    const gap = c.target - c.actual;
    if (gap <= 0) continue;
    if (c.key === "mix") continue; // said per category below, which is actionable
    lines.push({
      key: c.key,
      message: gapSentence(c.key, gap),
      weight: BP - c.achievementBp,
    });
  }

  for (const cat of mix.categories) {
    if (cat.status !== "below-minimum" && cat.status !== "below-target") continue;
    const shareGap = cat.targetBp - cat.actualBp;
    const valueGap = Math.round((shareGap / BP) * mix.totalPaise);
    lines.push({
      key: "mix-category",
      message: `${cat.name} is ${(shareGap / 100).toFixed(1)} points below its target share.`,
      weight: valueGap > 0 ? shareGap : shareGap,
    });
  }

  return lines.sort((a, b) => b.weight - a.weight);
}

function gapSentence(key: ComponentKey, gap: number): string {
  switch (key) {
    case "revenue":
      return `₹${(gap / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })} short of the revenue target.`;
    case "volume":
      return `${Math.round(gap / 1000).toLocaleString("en-IN")} litres short of the volume target.`;
    case "newCustomers":
      return `${gap} more new ${gap === 1 ? "customer" : "customers"} needed this month.`;
    case "collection":
      return `₹${(gap / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })} still to collect.`;
    case "activity":
      return `${gap} more ${gap === 1 ? "visit or call" : "visits or calls"} to make.`;
    default:
      return "";
  }
}
