import type { BusinessDate } from "../business-date";
import { daysBetween, daysInMonth, startOfMonth } from "../business-date";
import type { Config } from "../config/registry";

/* ---------------------------------------------------------------------------
 * E5 — Target Resolver
 *
 * Target versus achieved, how an unset target is defaulted, and the split that
 * gives the module its management value: telling a customer problem apart from
 * a coverage problem.
 *
 * Pure.
 * ------------------------------------------------------------------------- */

export type TargetResolution = {
  /** Paise. */
  amount: number;
  /** False when a manager set it explicitly. The interface badges defaults. */
  isDefault: boolean;
  method: "manual" | "trailing-average" | "last-month" | "fixed" | "none";
};

export type TargetConfig = Pick<
  Config,
  | "targets.defaultMethod"
  | "targets.trailingMonths"
  | "targets.defaultUpliftPercent"
  | "targets.proRateNewCustomers"
>;

export type TargetInput = {
  /** A manually set target for this customer and month, in paise. */
  manualAmount: number | null;
  /** Achievement for preceding months, most recent first, in paise. */
  trailingAchievement: number[];
  /** When the customer joined, for pro-rating their first month. */
  customerSince: BusinessDate | null;
  /** The month being resolved, as any date within it. */
  month: BusinessDate;
};

/**
 * Every active customer must end up with a target for the current month —
 * manual or defaulted — so the screen has no blanks.
 */
export function resolveTarget(
  input: TargetInput,
  config: TargetConfig,
): TargetResolution {
  if (input.manualAmount !== null) {
    return { amount: input.manualAmount, isDefault: false, method: "manual" };
  }

  const method = config["targets.defaultMethod"];
  let base = 0;

  if (method === "trailing-average") {
    const months = input.trailingAchievement.slice(
      0,
      config["targets.trailingMonths"],
    );
    base = months.length
      ? Math.round(months.reduce((a, b) => a + b, 0) / months.length)
      : 0;
  } else if (method === "last-month") {
    base = input.trailingAchievement[0] ?? 0;
  }

  let amount = Math.round(
    base * (1 + config["targets.defaultUpliftPercent"] / 100),
  );

  // A customer who joined mid-month should not be judged against a full month.
  if (config["targets.proRateNewCustomers"] && input.customerSince) {
    const monthStart = startOfMonth(input.month);
    if (input.customerSince > monthStart) {
      const total = daysInMonth(input.month);
      const active = total - daysBetween(monthStart, input.customerSince);
      amount = Math.round(amount * (Math.max(0, active) / total));
    }
  }

  return { amount, isDefault: true, method };
}

/* ------------------------------------------------- shortfall classification */

export type ShortfallCustomer = {
  customerId: string;
  name: string;
  target: number;
  achieved: number;
  /** Contacts so far this month. */
  contactsThisMonth: number;
  /** From E1 — drives how many contacts were reasonable to expect. */
  cycleDays: number;
};

export type ClassifiedCustomer = ShortfallCustomer & {
  gap: number;
  achievementPercent: number;
  expectedContacts: number;
  classification: "coverage-gap" | "customer-gap";
};

export type ShortfallAnalysis = {
  /** Under target AND under-contacted — a telecaller problem. */
  coverageGap: ClassifiedCustomer[];
  /** Under target DESPITE being contacted on schedule — a market problem. */
  customerGap: ClassifiedCustomer[];
  coverageGapValue: number;
  customerGapValue: number;
  totalShortfall: number;
};

/**
 * The view a manager opens before a coaching conversation. The two groups need
 * completely different responses, which is why the split exists.
 */
export function classifyShortfall(
  customers: ShortfallCustomer[],
  today: BusinessDate,
): ShortfallAnalysis {
  const monthStart = startOfMonth(today);
  const daysElapsed = Math.max(1, daysBetween(monthStart, today) + 1);

  const coverageGap: ClassifiedCustomer[] = [];
  const customerGap: ClassifiedCustomer[] = [];

  for (const c of customers) {
    const gap = c.target - c.achieved;
    if (gap <= 0) continue; // on or above target

    // How many contacts their own cycle implies over the days elapsed.
    const expectedContacts = Math.max(
      1,
      Math.floor(daysElapsed / Math.max(1, c.cycleDays)),
    );

    const classified: ClassifiedCustomer = {
      ...c,
      gap,
      achievementPercent: c.target ? Math.round((c.achieved / c.target) * 100) : 0,
      expectedContacts,
      classification:
        c.contactsThisMonth < expectedContacts ? "coverage-gap" : "customer-gap",
    };

    if (classified.classification === "coverage-gap") coverageGap.push(classified);
    else customerGap.push(classified);
  }

  const byGap = (a: ClassifiedCustomer, b: ClassifiedCustomer) => b.gap - a.gap;
  coverageGap.sort(byGap);
  customerGap.sort(byGap);

  const sum = (list: ClassifiedCustomer[]) =>
    list.reduce((total, c) => total + c.gap, 0);

  return {
    coverageGap,
    customerGap,
    coverageGapValue: sum(coverageGap),
    customerGapValue: sum(customerGap),
    totalShortfall: sum(coverageGap) + sum(customerGap),
  };
}
