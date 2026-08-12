import { calendarDaysBetween, type CalendarDate } from "../business-date";
import type { Config } from "../config/registry";

/* ---------------------------------------------------------------------------
 * E1 — Buying Cycle
 *
 * A customer's normal order interval. Feeds both the Queue and the Inactive
 * Watch, so a wrong cycle poisons two modules at once. Median by default: one
 * bulk order or one festival gap skews a mean badly.
 *
 * Pure. Takes order dates in, returns a number of days out.
 * ------------------------------------------------------------------------- */

export type BuyingCycle = {
  days: number;
  /** True when history was too thin and the configured default was used. */
  isDefault: boolean;
  /** How many intervals the figure was computed from — 0 for a default. */
  intervalsUsed: number;
  /**
   * How PREDICTABLE the cycle is, 0–100. Null where the cycle is a default,
   * because a guess has no confidence to report.
   *
   * 29, 30, 31, 30, 29 is a customer you can plan around. 15, 45, 22, 60, 30
   * averages to something similar and means nothing — the same number, worth
   * trusting in one case and not the other. The figure exists so a screen can
   * say which, and so ranking can prefer the customers whose date is real.
   *
   * It never changes the DATE. A wobbly cycle is still the best estimate
   * available; hedging the arithmetic on top of it would just make a worse
   * one.
   */
  confidence: number | null;
};

/** The bands a confidence figure is read in. */
export type ConfidenceBand = "high" | "medium" | "low" | "very-low";

export function confidenceBand(confidence: number | null): ConfidenceBand | null {
  if (confidence === null) return null;
  if (confidence >= 80) return "high";
  if (confidence >= 60) return "medium";
  if (confidence >= 40) return "low";
  return "very-low";
}

/**
 * Confidence from the spread of the intervals themselves.
 *
 * The coefficient of variation — standard deviation over the mean — is the
 * right measure because it is RELATIVE: three days of wobble on a 30-day
 * cycle is tight, and on a 5-day cycle is chaos. An absolute spread would
 * call the second one better than the first.
 *
 * `100 × (1 − CV)`, floored at zero. A perfectly regular customer scores 100;
 * one whose gaps vary as much as their average scores 0.
 */
export function cycleConfidence(intervals: number[]): number | null {
  if (intervals.length < 2) return null;
  const avg = mean(intervals);
  if (avg <= 0) return null;
  const variance =
    intervals.reduce((sum, v) => sum + (v - avg) ** 2, 0) / intervals.length;
  const cv = Math.sqrt(variance) / avg;
  return Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));
}

export type BuyingCycleConfig = Pick<
  Config,
  | "buyingCycle.method"
  | "buyingCycle.lookbackOrders"
  | "buyingCycle.minIntervals"
  | "buyingCycle.defaultDays"
  | "buyingCycle.minDays"
  | "buyingCycle.maxDays"
>;

/**
 * @param orderDates ascending, merged from every source. Orders the CRM cannot
 *   see still count — that is why the caller merges before calling.
 */
export function buyingCycle(
  /* CALENDAR dates: an order placed at 2am belongs to that date, and these
   * are differenced against each other rather than against today. */
  orderDates: CalendarDate[],
  config: BuyingCycleConfig,
): BuyingCycle {
  const fallback: BuyingCycle = {
    days: clamp(config["buyingCycle.defaultDays"], config),
    isDefault: true,
    intervalsUsed: 0,
    confidence: null,
  };

  if (orderDates.length < 2) return fallback;

  // Most recent orders only, but keep them in ascending order for the diffs.
  const recent = orderDates.slice(-config["buyingCycle.lookbackOrders"]);

  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = calendarDaysBetween(recent[i - 1], recent[i]);
    // Two orders on the same day are one purchase split across bills, not an
    // interval of zero; counting them would drag every cycle towards nothing.
    if (gap > 0) intervals.push(gap);
  }

  if (intervals.length < config["buyingCycle.minIntervals"]) return fallback;

  const raw =
    config["buyingCycle.method"] === "mean" ? mean(intervals) : median(intervals);

  return {
    days: clamp(Math.round(raw), config),
    isDefault: false,
    intervalsUsed: intervals.length,
    confidence: cycleConfidence(intervals),
  };
}

function clamp(days: number, config: BuyingCycleConfig): number {
  return Math.min(
    Math.max(days, config["buyingCycle.minDays"]),
    config["buyingCycle.maxDays"],
  );
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
