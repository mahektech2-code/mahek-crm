import type { BusinessDate } from "../business-date";
import { daysBetween } from "../business-date";
import type { Config } from "../config/registry";

/* ---------------------------------------------------------------------------
 * E4 — Inactivity Evaluator
 *
 * Who has gone quiet. The threshold is per customer — their own buying cycle
 * times the multiplier — never a global number of days. A 15-day-cycle
 * customer flags at 30; a 90-day-cycle customer at 180.
 *
 * Crossing it marks the customer inactive: `customers.status` is written from
 * this result rather than typed by anybody, and an order writes it back to
 * active. Deactivation stays a human decision and is never touched here.
 *
 * Pure.
 * ------------------------------------------------------------------------- */

export type InactivityInput = {
  status: "active" | "inactive" | "deactivated";
  lastOrderDate: BusinessDate | null;
  /** From E1. */
  cycleDays: number;
  cycleIsDefault: boolean;
  /** Average order value in paise, for the value-at-risk figure. */
  avgOrderValue: number;
};

export type InactivityResult = {
  inactive: boolean;
  daysSinceLastOrder: number | null;
  cycleDays: number;
  cycleIsDefault: boolean;
  /** To one decimal — the interface displays this as "2.4× cycle". */
  cyclesElapsed: number;
  thresholdDays: number;
  /** Six months of business at their normal rate. */
  valueAtRisk: number;
  /** Why they were skipped, when they were. */
  skippedReason: string | null;
};

export type InactivityConfig = Pick<Config, "inactive.cycleMultiplier">;

const NOT_INACTIVE = (
  reason: string | null,
  cycleDays: number,
  cycleIsDefault: boolean,
  thresholdDays: number,
  daysSinceLastOrder: number | null = null,
): InactivityResult => ({
  inactive: false,
  daysSinceLastOrder,
  cycleDays,
  cycleIsDefault,
  cyclesElapsed: 0,
  thresholdDays,
  valueAtRisk: 0,
  skippedReason: reason,
});

export function evaluateInactivity(
  customer: InactivityInput,
  today: BusinessDate,
  config: InactivityConfig,
): InactivityResult {
  const threshold = Math.round(
    customer.cycleDays * config["inactive.cycleMultiplier"],
  );

  // A customer who has never ordered cannot have stopped ordering. Flagging
  // them would fill the watch with new accounts that simply have not started.
  if (!customer.lastOrderDate) {
    return NOT_INACTIVE(
      "No order history",
      customer.cycleDays,
      customer.cycleIsDefault,
      threshold,
    );
  }

  // Only a deactivated customer is out of scope. An *inactive* one must still
  // evaluate as inactive: the status is this engine's own output, written back
  // by recomputeInactivity(), so treating it as a reason to skip would make
  // every flag erase itself on the following night.
  if (customer.status === "deactivated") {
    return NOT_INACTIVE(
      `Customer is ${customer.status}`,
      customer.cycleDays,
      customer.cycleIsDefault,
      threshold,
    );
  }

  const daysSince = daysBetween(customer.lastOrderDate, today);

  if (daysSince < threshold) {
    return NOT_INACTIVE(
      null,
      customer.cycleDays,
      customer.cycleIsDefault,
      threshold,
      daysSince,
    );
  }

  return {
    inactive: true,
    daysSinceLastOrder: daysSince,
    cycleDays: customer.cycleDays,
    cycleIsDefault: customer.cycleIsDefault,
    cyclesElapsed: Math.round((daysSince / customer.cycleDays) * 10) / 10,
    thresholdDays: threshold,
    valueAtRisk: Math.round(
      (customer.avgOrderValue * 180) / Math.max(1, customer.cycleDays),
    ),
    skippedReason: null,
  };
}

/* ------------------------------------------------------- watch record age */

export type WatchAge = {
  ageDays: number;
  /** Past the configured warning age and still without an outcome. */
  needsDecision: boolean;
};

/**
 * The module exists so the business makes a deliberate decision rather than
 * letting customers disappear quietly. The age of a watch record without an
 * outcome is therefore the column that matters, not the flag itself.
 */
export function watchAge(
  flaggedAt: BusinessDate,
  hasOutcome: boolean,
  today: BusinessDate,
  config: Pick<Config, "inactive.decisionAgeWarningDays">,
): WatchAge {
  const ageDays = daysBetween(flaggedAt, today);
  return {
    ageDays,
    needsDecision:
      !hasOutcome && ageDays >= config["inactive.decisionAgeWarningDays"],
  };
}
