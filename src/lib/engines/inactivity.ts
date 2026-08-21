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

export type InactivityConfig = Pick<
  Config,
  "inactive.cycleMultiplier" | "health.atRiskCycleMultiplier" | "health.lostCycleMultiplier"
>;

/* --------------------------------------------------------- the four bands */

/**
 * How far past their own rhythm a customer is, in four words.
 *
 * ONE DEFINITION OF "GONE QUIET", and this is it. The owner dashboard needed
 * bands and this engine already answered the same question with a yes or a no,
 * so the bands are where the answer now lives and `evaluateInactivity` reads
 * them — rather than a second reading of the same customer in a reporting
 * service, which is how the Call Log and a dashboard come to disagree about
 * whether somebody has stopped buying.
 *
 * `dormant` is deliberately NOT its own setting. It IS
 * `inactive.cycleMultiplier`, the one threshold the source document states
 * precisely, and the point at which `customers.status` becomes `inactive`.
 * Giving the dashboard its own dormant number would have been two answers to
 * one question, and the day they drift the Call Log is chasing somebody the
 * owner's screen has written off.
 *
 * Measured in CYCLES, never in days: a customer who buys every fortnight and
 * one who buys twice a year are both a quarter late at 1.25 of their own
 * cycle, and a flat 30/60/90 would call the first one lost and the second one
 * fine.
 */
export type HealthBand = "active" | "at-risk" | "dormant" | "lost";

export const HEALTH_BANDS: HealthBand[] = ["active", "at-risk", "dormant", "lost"];

export const HEALTH_BAND_LABELS: Record<HealthBand, string> = {
  active: "Active",
  "at-risk": "At risk",
  dormant: "Dormant",
  lost: "Lost",
};

/**
 * The multiplier at which each band STARTS. `active` starts at zero.
 *
 * Read as: at or above `at-risk` and below `dormant` is at risk.
 */
export function bandThresholds(config: InactivityConfig) {
  return {
    atRisk: config["health.atRiskCycleMultiplier"],
    dormant: config["inactive.cycleMultiplier"],
    lost: config["health.lostCycleMultiplier"],
  };
}

export function healthBand(
  cyclesElapsed: number,
  config: InactivityConfig,
): HealthBand {
  const t = bandThresholds(config);
  if (cyclesElapsed >= t.lost) return "lost";
  if (cyclesElapsed >= t.dormant) return "dormant";
  if (cyclesElapsed >= t.atRisk) return "at-risk";
  return "active";
}

/**
 * A customer's band from the two facts it needs, with the awkward cases named.
 *
 * A customer who has NEVER ordered is not lost — they have not started, which
 * is a different thing and belongs on a prospect list rather than in a
 * retention figure. `null` says so instead of picking a band.
 */
export function bandFor(
  input: { lastOrderDate: BusinessDate | null; cycleDays: number },
  today: BusinessDate,
  config: InactivityConfig,
): { band: HealthBand; cyclesElapsed: number; daysOverdue: number } | null {
  if (!input.lastOrderDate || input.cycleDays <= 0) return null;
  const daysSince = daysBetween(input.lastOrderDate, today);
  const cyclesElapsed = Math.round((daysSince / input.cycleDays) * 100) / 100;
  return {
    band: healthBand(cyclesElapsed, config),
    cyclesElapsed,
    // Past the day their own cycle said they were due. Negative would mean
    // "not due yet", which is not overdue at all.
    daysOverdue: Math.max(0, daysSince - input.cycleDays),
  };
}

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
  /* The dormant boundary, which is where `inactive` begins. Expressed through
     `bandThresholds` so there is one place the number comes from — see the
     note above `healthBand`. */
  const threshold = Math.round(
    customer.cycleDays * bandThresholds(config).dormant,
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
