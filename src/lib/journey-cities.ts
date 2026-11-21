/* ---------------------------------------------------------------------------
 * THE CITIES OF A JOURNEY DAY — PURE, client-safe, no I/O.
 *
 * A day used to be one city. The office can now name several, and this is the one
 * place that says how:
 *
 *   `city`    stays the PRIMARY city — the first one chosen. Every handset in the
 *             field filters its shop list by this single value, so it is never a
 *             joined string ("Pune, Thane" would match no shop at all).
 *   `cities`  the full, ordered list, stored ONLY where more than one city was
 *             named. Null means "just `city`", which is every row that existed
 *             before this and every day with a single city — so nothing is
 *             backfilled and no existing day changes meaning.
 *
 * Order matters (the first is the primary), duplicates do not: two spellings
 * that fold to the same `cityKey` are one city, and the first spelling wins.
 * ------------------------------------------------------------------------- */

import { cityKey } from "@/lib/city-match";

/** Trim and collapse the whitespace, nothing else — the words are kept as typed. */
const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * One ordered, de-duplicated list from whatever was supplied — a primary city, a
 * list, or both. Empty strings are dropped; a spelling that folds to a city
 * already named is dropped; the first spelling of each is kept.
 */
export function normaliseCities(
  ...input: Array<string | ReadonlyArray<string | null | undefined> | null | undefined>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of input) {
    const items = typeof group === "string" ? [group] : (group ?? []);
    for (const item of items) {
      const city = tidy(item ?? "");
      const key = cityKey(city);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(city);
    }
  }
  return out;
}

/**
 * Every city a plan names, primary first. `cities` where it was set, otherwise
 * just `city`. Never empty-string entries.
 */
export function planCityList(plan: {
  city: string | null;
  cities?: ReadonlyArray<string> | null;
}): string[] {
  return plan.cities?.length ? normaliseCities(plan.city, plan.cities) : normaliseCities(plan.city);
}

/** Whether two lists name the same cities in the same order (the first is the primary). */
export function sameCityList(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  const x = normaliseCities(a);
  const y = normaliseCities(b);
  return x.length === y.length && x.every((c, i) => cityKey(c) === cityKey(y[i]));
}

/**
 * What to write on the row for a list of cities: `city` is always the first, and
 * `cities` is stored only where there are several — null otherwise, so a single
 * city is stored exactly as it always was.
 */
export function cityColumns(list: ReadonlyArray<string>): { city: string | null; cities: string[] | null } {
  const cities = normaliseCities(list);
  return { city: cities[0] ?? null, cities: cities.length > 1 ? cities : null };
}

/** A list said as words: "Pune", "Pune and Thane", "Pune, Thane and Nagpur". */
export function citiesInWords(list: ReadonlyArray<string>): string {
  const cities = normaliseCities(list);
  if (cities.length <= 1) return cities[0] ?? "";
  return `${cities.slice(0, -1).join(", ")} and ${cities[cities.length - 1]}`;
}
