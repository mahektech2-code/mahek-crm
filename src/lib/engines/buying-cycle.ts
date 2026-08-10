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
};

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
