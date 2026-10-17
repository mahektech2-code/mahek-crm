/* ---------------------------------------------------------------------------
 * STATE › DISTRICT › CITY › AREA as four filters — PURE and client-safe.
 *
 * Every list of shops in MahekOne narrows by the same four, read off the
 * reviewed location tree (`places`, and the four `resolved_*_id` columns on
 * `customers`) rather than off `customers.city`, which is whatever the sheet
 * typed — 1,165 spellings of a few hundred places. A pick is a PLACE ID, so
 * "Nagpur" means the Nagpur in Maharashtra and never the village of the same
 * name in East Nimar.
 *
 * The four are independent filters and each takes several values, so
 * "Thane district, plus the whole of Goa" is two picks on two rungs. Picking a
 * rung narrows the options offered BELOW it and never the ones above, which
 * is what lets somebody start at an area they know without first finding its
 * state.
 *
 * Kept apart from the `server-only` service that turns these into SQL because
 * the dropdowns are client components; see `place-filter-service.ts`.
 * ------------------------------------------------------------------------- */

import type { PlaceKind } from "@/lib/place-parse";

/** The four, coarsest first — and the URL parameter each one rides on. */
export const PLACE_FILTER_KINDS = ["state", "district", "city", "area"] as const satisfies readonly PlaceKind[];

export const PLACE_FILTER_LABELS: Record<PlaceKind, string> = {
  state: "State",
  district: "District",
  city: "City",
  area: "Area",
};

/** `,`-separated place ids per rung; absent or empty means no narrowing. */
export type PlaceFilterValues = Partial<Record<PlaceKind, string>>;

export type PlaceFilterOption = { value: string; label: string };

/** A shop's place by name, rung by rung. A null rung is one nobody could place. */
export type PlaceNames = {
  state: string | null;
  district: string | null;
  city: string | null;
  area: string | null;
};

export type PlaceFilterOptions = Record<PlaceKind, PlaceFilterOption[]>;

export const NO_PLACE_OPTIONS: PlaceFilterOptions = { state: [], district: [], city: [], area: [] };

/** Read the four out of a search-params bag, the way every page reads its filters. */
export function placeFilterParams(
  one: (key: string) => string | undefined,
): PlaceFilterValues {
  const out: PlaceFilterValues = {};
  for (const kind of PLACE_FILTER_KINDS) {
    const v = one(kind);
    if (v) out[kind] = v;
  }
  return out;
}

/** Is any of the four set? */
export function anyPlacePicked(values: PlaceFilterValues): boolean {
  return PLACE_FILTER_KINDS.some((k) => Boolean(values[k]?.trim()));
}

/**
 * The URL change for a new pick on one rung.
 *
 * Changing a rung CLEARS the rungs below it: a district picked under
 * Maharashtra means nothing once Maharashtra is unpicked, and leaving it in
 * the address would narrow the list by a filter no dropdown is showing.
 */
export function placePickPatch(
  kind: PlaceKind,
  next: string[],
): Partial<Record<PlaceKind, string | undefined>> {
  const patch: Partial<Record<PlaceKind, string | undefined>> = {
    [kind]: next.join(",") || undefined,
  };
  const below = PLACE_FILTER_KINDS.slice(PLACE_FILTER_KINDS.indexOf(kind) + 1);
  for (const k of below) patch[k] = undefined;
  return patch;
}
