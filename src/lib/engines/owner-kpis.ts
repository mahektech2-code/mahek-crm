import type { Config } from "../config/registry";
import type { HealthBand } from "./inactivity";
import { HEALTH_BANDS } from "./inactivity";

/* ---------------------------------------------------------------------------
 * E11 — The owner's five.
 *
 * New leads, what became of them, what an order is worth, how often one comes,
 * and whether the customers we have are still buying. Five questions that are
 * not five reports: they are one funnel read at five points, which is why they
 * live in one engine and share one definition of a period.
 *
 * Margin is deliberately absent. The brief excludes it and so does the data —
 * `products.priceSource` is still `unset`, so nothing here could compute a
 * cost without inventing one.
 *
 * Pure. Every figure arrives as a count or a sum; the counting is in
 * `lib/services/owner-dashboard-service.ts`.
 * ------------------------------------------------------------------------- */

export type OwnerConfig = Pick<
  Config,
  | "owner.conversionWindowDays"
  | "owner.frequencyHighOrders"
  | "owner.frequencyMediumOrders"
  | "owner.conversionTargetPercent"
  | "owner.kpiAlertChangePercent"
  | "health.atRiskCycleMultiplier"
  | "health.lostCycleMultiplier"
  | "inactive.cycleMultiplier"
>;

/* ------------------------------------------------------------- comparison */

/**
 * How a figure moved, and in which unit it should be SAID.
 *
 * A rate that goes from 12.5% to 14.8% has not risen 18.4% — it has risen 2.3
 * percentage points, and reporting the first is the most common way a
 * dashboard flatters itself. `kind` is what forces the screen to say which,
 * because the two are indistinguishable once they are printed as numbers.
 */
export type Change = {
  /** Percent for a count or an amount; percentage POINTS for a rate. */
  value: number | null;
  kind: "percent" | "points";
  direction: "up" | "down" | "flat";
};

export function changeInCount(current: number, previous: number): Change {
  // Growth from nothing is not a percentage. One lead last month and forty
  // this month is not "up 3,900%", it is up from nothing, and a screen that
  // prints the first teaches people to ignore the column.
  if (previous === 0) {
    return {
      value: null,
      kind: "percent",
      direction: current > 0 ? "up" : "flat",
    };
  }
  const pct = ((current - previous) / previous) * 100;
  return {
    value: Math.round(pct * 10) / 10,
    kind: "percent",
    direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat",
  };
}

/** For rates. The difference is in POINTS and never in percent. */
export function changeInRate(current: number, previous: number): Change {
  const diff = Math.round((current - previous) * 10) / 10;
  return {
    value: diff,
    kind: "points",
    direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
  };
}

/* ------------------------------------------------------- KPI 1: new leads */

export type LeadOrigin = "crm" | "field";

export type LeadRow = {
  leadId: string;
  origin: LeadOrigin;
  /** The customer this lead is or became, where there is one. */
  customerId: string | null;
  source: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  state: string | null;
  city: string | null;
  customerType: string | null;
  createdOn: string;
  /** Only a field lead has a ladder. Null on a CRM lead, and that is a fact. */
  stage: string | null;
  /** The day of their first order that counted, if one ever came. */
  firstOrderOn: string | null;
};

/**
 * Field leads that reached the qualification rung or beyond.
 *
 * A CRM lead can never be qualified because it has no ladder — it is a party
 * the book knows has not ordered, not a prospect somebody worked. That is why
 * the conversion rate below is measured over ALL leads in the cohort and this
 * figure is reported beside it rather than under it: a denominator that
 * silently drops every lead incapable of being qualified would report a
 * flattering rate and nothing on the screen would say why.
 */
export const QUALIFIED_STAGES = ["qualified", "negotiation", "won"] as const;

export function isQualified(row: LeadRow): boolean {
  return row.stage !== null && (QUALIFIED_STAGES as readonly string[]).includes(row.stage);
}

/* ---------------------------------------------- KPI 2: cohort conversion */

export type Conversion = {
  /** Leads created in the period. The denominator. */
  leads: number;
  /** How many of THOSE placed a first order inside the window. */
  converted: number;
  /** Percent, to one decimal. Null where the cohort is empty. */
  ratePercent: number | null;
  /** Of the cohort, how many ever reached the qualification rung. */
  qualified: number;
  qualifiedConverted: number;
  qualifiedRatePercent: number | null;
  /**
   * Leads still inside their window with no order yet — neither converted nor
   * failed. A cohort read before its window closes is INCOMPLETE, and saying
   * so is the difference between a low rate and an unfinished one.
   */
  stillOpen: number;
  windowDays: number;
  /** False while any lead in the cohort could still convert. */
  windowClosed: boolean;
};

/**
 * Conversion by COHORT, which is the whole point of §8.
 *
 * Dividing this month's first orders by this month's leads asks a lead created
 * on the 29th to have ordered by the 31st, and answers a question nobody
 * asked: it mixes orders from leads generated months ago into a rate labelled
 * with this month's lead count. A cohort follows one month's leads forward and
 * reports what became of them.
 *
 * `asOf` is what makes the answer honest before the window has closed: a lead
 * created eleven days ago with a ninety-day window has not failed to convert,
 * it has not finished yet.
 */
export function conversionFor(
  cohort: LeadRow[],
  asOf: string,
  config: OwnerConfig,
): Conversion {
  const windowDays = config["owner.conversionWindowDays"];
  let converted = 0;
  let qualified = 0;
  let qualifiedConverted = 0;
  let stillOpen = 0;

  for (const lead of cohort) {
    const deadline = addDaysIso(lead.createdOn, windowDays);
    const inWindow = lead.firstOrderOn !== null && lead.firstOrderOn <= deadline;
    const q = isQualified(lead);
    if (q) qualified++;

    if (inWindow) {
      converted++;
      if (q) qualifiedConverted++;
      continue;
    }
    // No order inside the window — but if the window is still open, the lead
    // has not failed, it is unfinished.
    if (lead.firstOrderOn === null && asOf <= deadline) stillOpen++;
  }

  return {
    leads: cohort.length,
    converted,
    ratePercent: cohort.length ? round1((converted / cohort.length) * 100) : null,
    qualified,
    qualifiedConverted,
    qualifiedRatePercent: qualified
      ? round1((qualifiedConverted / qualified) * 100)
      : null,
    stillOpen,
    windowDays,
    windowClosed: stillOpen === 0,
  };
}

/* ------------------------------------------------- KPI 3: average bill size */

export type BillSize = {
  /** What was invoiced, net of credit notes issued in the period. */
  netValuePaise: number;
  grossValuePaise: number;
  creditNotePaise: number;
  transactions: number;
  /** Paise. Null where nothing was sold — never a confident zero. */
  averagePaise: number | null;
};

/**
 * What an average completed transaction is worth.
 *
 * NET of credit notes, because the brief is explicit that returns must not let
 * the dashboard flatter itself. The two halves are both carried: a month whose
 * gross is healthy and whose credit notes are large is a different month to
 * one with a small gross, and a single net figure hides which it was.
 *
 * The denominator is transactions, NOT customers — that is KPI 4's question,
 * and the two get confused constantly. Credit notes reduce the value and never
 * the count: a credit note is not a sale that un-happened, it is money given
 * back on one that did.
 */
export function billSize(
  grossValuePaise: number,
  creditNotePaise: number,
  transactions: number,
): BillSize {
  const net = grossValuePaise - creditNotePaise;
  return {
    netValuePaise: net,
    grossValuePaise,
    creditNotePaise,
    transactions,
    averagePaise: transactions > 0 ? Math.round(net / transactions) : null,
  };
}

/* -------------------------------------------- KPI 4: purchase frequency */

export type Frequency = {
  transactions: number;
  activeCustomers: number;
  /** Transactions per active customer, to one decimal. Null with nobody active. */
  perActiveCustomer: number | null;
  segments: { segment: "high" | "medium" | "low"; label: string; customers: number }[];
};

/**
 * How often a customer buys, and how that is spread.
 *
 * "We made 1,000 transactions" says nothing without the number of customers
 * behind it — a thousand orders from two hundred and fifty customers is a very
 * different business to a thousand from nine hundred. The denominator is
 * customers who ACTUALLY ORDERED in the period, not everybody on the book:
 * dividing by the whole database would make the figure fall every time
 * somebody added a prospect.
 */
export function frequency(
  transactions: number,
  ordersPerCustomer: number[],
  config: OwnerConfig,
): Frequency {
  const high = config["owner.frequencyHighOrders"];
  const medium = config["owner.frequencyMediumOrders"];
  const active = ordersPerCustomer.length;

  const counts = { high: 0, medium: 0, low: 0 };
  for (const n of ordersPerCustomer) {
    if (n >= high) counts.high++;
    else if (n >= medium) counts.medium++;
    else counts.low++;
  }

  return {
    transactions,
    activeCustomers: active,
    perActiveCustomer: active ? round1(transactions / active) : null,
    segments: [
      { segment: "high", label: `High (${high}+ orders)`, customers: counts.high },
      {
        segment: "medium",
        label: `Medium (${medium}–${high - 1})`,
        customers: counts.medium,
      },
      { segment: "low", label: `Low (1–${medium - 1})`, customers: counts.low },
    ],
  };
}

/* ------------------------------------------------------ KPI 5: retention */

export type HealthCounts = Record<HealthBand, number>;

export type Retention = {
  counts: HealthCounts;
  total: number;
  /** Share of the book in each band, to one decimal. */
  share: Record<HealthBand, number>;
  /**
   * Customers with a cycle that could not be measured, or who have never
   * ordered. They are NOT a band — somebody who has not started is not lost —
   * and they are reported rather than folded into `active`, which is where a
   * retention figure quietly goes wrong.
   */
  unbanded: number;
};

export function retention(
  bands: (HealthBand | null)[],
): Retention {
  const counts: HealthCounts = { active: 0, "at-risk": 0, dormant: 0, lost: 0 };
  let unbanded = 0;
  for (const b of bands) {
    if (b === null) unbanded++;
    else counts[b]++;
  }
  const total = HEALTH_BANDS.reduce((s, b) => s + counts[b], 0);
  const share = {} as Record<HealthBand, number>;
  for (const b of HEALTH_BANDS) {
    share[b] = total ? round1((counts[b] / total) * 100) : 0;
  }
  return { counts, total, share, unbanded };
}

/* --------------------------------------------------------- KPI 5: movement */

export type Movement = {
  from: HealthBand;
  to: HealthBand;
  customers: number;
  /** Towards active is recovery; away from it is decay. */
  direction: "recovered" | "declined" | "held";
};

/**
 * Who moved between two readings, and which way.
 *
 * §22, and the reason it matters: a book with 145 at risk in both months looks
 * stable and may be 145 different customers, half of them recovered and half
 * newly slipping. The count alone cannot tell those apart; the movement can,
 * and it is the only figure here that says whether the telecalling team is
 * actually getting anybody back.
 *
 * A customer present in only one of the two readings is not a movement — they
 * were added or they have no measurable cycle — and is left out rather than
 * counted as having come from nowhere.
 */
export function movement(
  before: Map<string, HealthBand>,
  after: Map<string, HealthBand>,
): Movement[] {
  const rank = (b: HealthBand) => HEALTH_BANDS.indexOf(b);
  const tally = new Map<string, number>();

  for (const [customerId, to] of after) {
    const from = before.get(customerId);
    if (!from) continue;
    const key = `${from}>${to}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  const out: Movement[] = [];
  for (const [key, customers] of tally) {
    const [from, to] = key.split(">") as [HealthBand, HealthBand];
    out.push({
      from,
      to,
      customers,
      direction:
        rank(to) < rank(from) ? "recovered" : rank(to) > rank(from) ? "declined" : "held",
    });
  }
  // Biggest first, and movements before the stayed-put rows: "eleven customers
  // came back" is the sentence somebody is looking for, and it must not be
  // below "six hundred stayed active".
  return out.sort((a, b) => {
    if ((a.direction === "held") !== (b.direction === "held")) {
      return a.direction === "held" ? 1 : -1;
    }
    return b.customers - a.customers;
  });
}

/* ------------------------------------------------------------------ alerts */

export type OwnerAlert = {
  key: string;
  severity: "high" | "medium" | "good";
  message: string;
};

export type AlertInput = {
  conversion: Conversion;
  previousConversion: Conversion | null;
  billSize: BillSize;
  previousBillSize: BillSize | null;
  retention: Retention;
  previousRetention: Retention | null;
  newLeads: number;
  previousNewLeads: number;
};

/**
 * What the owner should be told rather than left to find.
 *
 * Every one of these compares against the period before, except conversion,
 * which has an absolute target — a conversion rate that fell from 4% to 3.6%
 * is a smaller problem than one that has been 4% all year against a target of
 * 15%, and only the second is worth a red line.
 *
 * A movement smaller than `owner.kpiAlertChangePercent` says nothing. Six
 * alerts every month is the same as no alerts.
 */
export function ownerAlerts(input: AlertInput, config: OwnerConfig): OwnerAlert[] {
  const alerts: OwnerAlert[] = [];
  const threshold = config["owner.kpiAlertChangePercent"];
  const target = config["owner.conversionTargetPercent"];

  const rate = input.conversion.ratePercent;
  if (rate !== null && rate < target) {
    alerts.push({
      key: "conversion-below-target",
      severity: "high",
      message: `Lead-to-order conversion is ${rate}% against a target of ${target}%.${
        input.conversion.windowClosed
          ? ""
          : ` ${input.conversion.stillOpen} of these leads are still inside their ${input.conversion.windowDays}-day window, so the figure can only rise.`
      }`,
    });
  } else if (
    rate !== null &&
    input.previousConversion?.ratePercent != null &&
    rate - input.previousConversion.ratePercent >= 1
  ) {
    alerts.push({
      key: "conversion-improving",
      severity: "good",
      message: `Conversion is up ${round1(rate - input.previousConversion.ratePercent)} points on the period before.`,
    });
  }

  if (
    input.previousBillSize?.averagePaise &&
    input.billSize.averagePaise !== null
  ) {
    const change = changeInCount(
      input.billSize.averagePaise,
      input.previousBillSize.averagePaise,
    );
    if (change.value !== null && change.value <= -threshold) {
      alerts.push({
        key: "bill-size-falling",
        severity: "medium",
        message: `Average bill size is down ${Math.abs(change.value)}% on the period before.`,
      });
    }
  }

  if (input.previousRetention) {
    const activeChange = changeInCount(
      input.retention.counts.active,
      input.previousRetention.counts.active,
    );
    if (activeChange.value !== null && activeChange.value <= -threshold) {
      alerts.push({
        key: "active-falling",
        severity: "high",
        message: `Active customers are down ${Math.abs(activeChange.value)}% on the period before.`,
      });
    }

    for (const band of ["at-risk", "dormant"] as const) {
      const change = changeInCount(
        input.retention.counts[band],
        input.previousRetention.counts[band],
      );
      if (change.value !== null && change.value >= threshold) {
        alerts.push({
          key: `${band}-rising`,
          severity: band === "dormant" ? "high" : "medium",
          message: `${band === "dormant" ? "Dormant" : "At-risk"} customers are up ${change.value}% on the period before — ${input.retention.counts[band]} of them now.`,
        });
      }
    }
  }

  const leadChange = changeInCount(input.newLeads, input.previousNewLeads);
  if (leadChange.value !== null && leadChange.value <= -threshold) {
    alerts.push({
      key: "leads-falling",
      severity: "medium",
      message: `New leads are down ${Math.abs(leadChange.value)}% on the period before.`,
    });
  }

  return alerts;
}

/* ----------------------------------------------------------------- helpers */

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Add days to a `YYYY-MM-DD`, in that calendar and no zone at all.
 *
 * A date with no time has no instant to shift, so `new Date(iso)` and back
 * would be `toISOString()` on a value that never had a zone — the exact shape
 * §11's grep test refuses, and wrong by a day west of Greenwich. `Date.UTC`
 * with the parts is arithmetic on a calendar rather than on an instant.
 */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
    at.getUTCDate(),
  ).padStart(2, "0")}`;
}
