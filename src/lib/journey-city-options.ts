/* ---------------------------------------------------------------------------
 * THE CITIES THE PROPOSE-DAYS BOX OFFERS — PURE, client-safe, no I/O.
 *
 * Two sources, in this order:
 *
 *   1. WHERE HE WORKS — the `town` rows the "Where they work" dialog writes, and
 *      the legacy `city` rows written before districts existed. Both name a
 *      place a manager has already decided this salesman covers, so they are
 *      what a day is most likely to be proposed in.
 *   2. HIS BOOK — the cities his own customers name, as before.
 *
 * It is a SHORTCUT past typing and nothing more: the box still takes any text,
 * because a manager may propose a town nobody has sold in yet.
 *
 * What it does NOT do, on purpose: no district- or state-derived towns, no
 * aliases, no folding of two distinct names into one. Two spellings are one
 * entry only where `cityKey` already says so (case and punctuation), which is
 * the rule the chips beside it use — and the first spelling wins, so an
 * allocated "Kolhapur" is never displaced by a typed "KOLHAPUR".
 * ------------------------------------------------------------------------- */

import { normaliseCities } from "@/lib/journey-cities";

/** Only what the rule reads, so a test needs no territory service. */
export type AllocatedPlace = { kind: string; value: string };

/** The kinds that name a city. `beat` sits under one and `district`/`state` are above it. */
const CITY_KINDS = new Set(["town", "city"]);

/** The allocated city names, alphabetical, de-duplicated. Empty if none were allocated. */
export function allocatedCities(territories: ReadonlyArray<AllocatedPlace>): string[] {
  return normaliseCities(
    territories
      .filter((t) => CITY_KINDS.has(t.kind))
      .map((t) => t.value)
      .sort((a, b) => a.localeCompare(b)),
  );
}

/**
 * The options: allocated cities first, then his book's. With nothing allocated
 * this is exactly the list the screen built before — his book's cities, sorted.
 */
export function proposeCityOptions(
  territories: ReadonlyArray<AllocatedPlace>,
  bookCities: ReadonlyArray<string | null | undefined>,
  /** Urban local bodies allocated by name in the official geography, in the source's own spelling. */
  officialCities: ReadonlyArray<string> = [],
): string[] {
  const book = [...new Set(bookCities.filter((c): c is string => Boolean(c)))].sort();
  const official = [...officialCities].sort((a, b) => a.localeCompare(b));
  return normaliseCities(allocatedCities(territories), official, book);
}
