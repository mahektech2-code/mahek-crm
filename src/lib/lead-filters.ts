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

import { LEAD_PRIORITIES, NO_PRIORITY_LABEL, priorityLabel } from "./lead-priority";

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

/**
 * A lead with no sales type, which is a population and not a gap.
 *
 * Nothing backfills one, deliberately: guessing which of three ladders somebody
 * was on is a decision dressed up as a migration, and the ladder decides which
 * GATES apply — so a wrong guess would not merely mislabel a record, it would
 * block the salesman working it. These leads climb the six rungs this product
 * shipped with and they are still somebody's book, so they have to be askable
 * for. Its own sentinel rather than an empty string because `in (…)` never
 * matches NULL and the clause has to be written the other way round.
 */
export const LEGACY_SALES_TYPE = "__legacy__";

export const SALES_TYPE_BUCKETS = [
  { value: "direct", label: "Direct customer" },
  { value: "third_party", label: "Third-party shop" },
  /* Retired for NEW leads — `offeredSalesTypes()` no longer offers it — and
     still offered HERE, because the leads already on that ladder are still
     climbing it and are exactly what somebody opens this filter to find. */
  { value: "distributor", label: "Distributor appointment" },
  { value: LEGACY_SALES_TYPE, label: "No ladder (raised before the funnel)" },
] as const satisfies readonly FilterOption[];

export const POTENTIAL_BUCKETS = [
  { value: "none", label: "Not estimated" },
  { value: "under50k", label: "Under ₹50,000" },
  { value: "50kto2l", label: "₹50,000 – ₹2,00,000" },
  { value: "over2l", label: "Over ₹2,00,000" },
] as const satisfies readonly FilterOption[];

/**
 * §4.1 — the manager's priority, and the FOURTH option is the one it is for.
 *
 * DERIVED from `LEAD_PRIORITIES` rather than retyped, because those three
 * words carry the argument for why this is not the potential filter above it,
 * and a hand-typed copy here would be a second answer that drifts from it —
 * the same discipline `access-control.ts` applies to the bundles it hands out.
 *
 * "Not set" is appended rather than left out. It is the majority of the book
 * on the day the column ships and it is the answer a manager opens this filter
 * for — "which of my leads has nobody been through" — and it is also what
 * keeps the bucket coverage test honest: every lead has to fall in exactly one
 * bucket, and a null priority falls in none of the three.
 */
export const PRIORITY_BUCKETS = [
  ...LEAD_PRIORITIES.map((value) => ({ value: value as string, label: priorityLabel(value) })),
  { value: "none", label: NO_PRIORITY_LABEL },
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
  priority: PRIORITY_BUCKETS,
  next: NEXT_BUCKETS,
  age: AGE_BUCKETS,
  health: HEALTH_BUCKETS,
} as const;

export type BucketColumn = keyof typeof BUCKET_LISTS;

/**
 * The filters the URL can carry. All optional, and all `,`-separated EXCEPT
 * `search`.
 *
 * Free text is the one filter that is not a set of ticked values, which is why
 * it does not go through `splitFilter`: a comma is a character somebody types
 * into a search box ("MAHADEV TOWERS, LBS MARG"), and splitting on it would
 * turn one search into two that must both match. The seven dropdowns answer
 * "which of these known values"; this one answers "I am looking for a
 * particular shop and I know part of its name" — the question the whole
 * screen exists for and the only one seven dropdowns cannot put.
 */
export type LeadFilters = {
  /** Matched across the name, the shop, the phone, the town and the owner. */
  search?: string;
  owner?: string;
  source?: string;
  stage?: string;
  /**
   * §3.2's three ladders, and the fourth answer that is not one.
   *
   * A rung is NOT a track: `suspect` is the foot of all three, so `stage=suspect`
   * alone answers with direct, third-party and distributor leads at once. The
   * pipeline's own segments each count ONE track, so without this the bar a
   * manager presses opens a list larger than the bar said — a figure nobody can
   * get behind, which is the whole thing that screen exists to avoid.
   *
   * `LEGACY_SALES_TYPE` is the fourth: a lead raised before the funnel existed
   * carries no sales type at all and climbs the six rungs this product shipped
   * with. It is a real population — it must be askable for, and `in (…)` never
   * matches NULL, so it cannot ride on the same clause as the other three.
   */
  salesType?: string;
  /**
   * WHERE THE SHOP IS, as `,`-separated paths — see `lib/lead-places.ts`.
   *
   * It is a path and not a value because "Nagpur" alone is not an answer: the
   * city column is what the sheet typed, and a city is matched AND-ed with its
   * state exactly as `territoryClause` matches an allocated one. That is
   * deliberate rather than convenient — the filter and the territory a salesman
   * was allocated read ONE expression, so the list and his handset can never
   * disagree about which shops a place has.
   *
   * It rides on the same comma-separated parameter every other multi-select
   * here uses, which it can only do because each path is escaped: 355 of the
   * 1,165 city strings on the real book carry a comma. See `encodePlace`.
   */
  place?: string;
  potential?: string;
  /** §4.1 — the manager's own. See `PRIORITY_BUCKETS` and `lead-priority.ts`. */
  priority?: string;
  next?: string;
  age?: string;
  health?: string;
};

/** Is anything actually narrowed? Decides whether "Clear filters" is drawn. */
export function anyFilterSet(f: LeadFilters): boolean {
  const { search, ...ticked } = f;
  /* `splitFilter` would answer 1 for any non-empty string, which happens to be
     right here — but only by accident, and it stops being right the day a
     search is trimmed to nothing. Asked directly, it cannot drift. */
  if (search?.trim()) return true;
  return Object.values(ticked).some((v) => splitFilter(v).length > 0);
}
