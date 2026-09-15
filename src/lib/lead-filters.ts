/* ---------------------------------------------------------------------------
 * What the Leads list can be narrowed by.
 *
 * PURE AND CLIENT-SAFE, like `lead-labels` and `account-types` beside it: the
 * filter bar is a client component and the service that turns these into SQL
 * is `server-only`, so the two halves can only share a module that imports
 * neither. A second copy of a value typed into the screen is the usual way a
 * dropdown comes to offer a filter the server has never heard of — which
 * shows up as a filter that silently returns nothing.
 *
 * FOUR OF THE SEVEN COLUMNS ARE BUCKETS RATHER THAN VALUES. Owner, source and
 * stage are things the rows actually hold, so their options are read off the
 * book — a salesman who joined this morning is in the list because he is in
 * the data, not because somebody remembered to add him. Potential, next
 * follow-up, age and health are NUMBERS AND DATES, and a dropdown of every
 * distinct value of those is a dropdown nobody can use: 400 leads carry 400
 * ages. Those four are named ranges, and the ranges are here.
 *
 * THE RANGES ARE A READING AID, NOT A THRESHOLD. Nothing is decided on them —
 * no lead is chased, escalated, scored or paid differently for falling in one
 * — so they are not `app_settings` material; they exist so a manager can say
 * "show me the ones nobody has promised anything" and get that list. The two
 * numbers on this screen that DO decide something, the health thresholds, are
 * configuration and are passed in rather than written here.
 * ------------------------------------------------------------------------- */

export type FilterOption = { value: string; label: string };

/** `,`-separated in the URL, like every other multi-select in the product. */
export function splitFilter(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * An owner nobody has set. It is a real answer and the one a manager most
 * needs — "nobody is working this lead" is the whole point of the desk count
 * above the table — so it is an option rather than a gap in the list.
 */
export const UNASSIGNED = "__unassigned__";

export const POTENTIAL_BUCKETS = [
  { value: "none", label: "Not estimated" },
  { value: "under50k", label: "Under ₹50,000" },
  { value: "50kto2l", label: "₹50,000 – ₹2,00,000" },
  { value: "over2l", label: "Over ₹2,00,000" },
] as const satisfies readonly FilterOption[];

export const NEXT_BUCKETS = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Within 7 days" },
  { value: "later", label: "Later than 7 days" },
  { value: "none", label: "None promised" },
] as const satisfies readonly FilterOption[];

export const AGE_BUCKETS = [
  { value: "week", label: "Under a week" },
  { value: "month", label: "1 – 4 weeks" },
  { value: "quarter", label: "1 – 3 months" },
  { value: "older", label: "Over 3 months" },
] as const satisfies readonly FilterOption[];

/**
 * The health column says one of three things, and the filter offers all three
 * — see `HealthCell`. The two SCORE bands come from configuration
 * (`mbos.health.atRiskBelow`, `mbos.health.strongAtOrAbove`), so the service
 * reads those rather than any number appearing here.
 *
 * THE RETENTION BANDS ARE DELIBERATELY ABSENT. "Active / at risk / dormant /
 * lost" is `bandFor`'s answer, computed in JavaScript from the customer's own
 * buying cycle precisely so there is ONE copy of that rule — `withHealthBand`
 * carries the note saying a CASE expression in SQL would be a second one.
 * Offering a band filter here would need exactly that second copy, and it
 * would drift the day somebody changes a multiplier on the Settings screen.
 */
export const HEALTH_BUCKETS = [
  { value: "lead", label: "Not a customer yet" },
  { value: "unscored", label: "Converted — not scored" },
  { value: "watch", label: "Score worth watching" },
  { value: "middle", label: "Scored, neither" },
  { value: "strong", label: "Scoring strong" },
] as const satisfies readonly FilterOption[];

/** Every bucket list, for the coverage test that pins each one against SQL. */
export const BUCKET_LISTS = {
  potential: POTENTIAL_BUCKETS,
  next: NEXT_BUCKETS,
  age: AGE_BUCKETS,
  health: HEALTH_BUCKETS,
} as const;

export type BucketColumn = keyof typeof BUCKET_LISTS;

/** The filters the URL can carry, all of them optional and all `,`-separated. */
export type LeadFilters = {
  owner?: string;
  source?: string;
  stage?: string;
  potential?: string;
  next?: string;
  age?: string;
  health?: string;
};

/** Is anything actually narrowed? Decides whether "Clear filters" is drawn. */
export function anyFilterSet(f: LeadFilters): boolean {
  return Object.values(f).some((v) => splitFilter(v).length > 0);
}
