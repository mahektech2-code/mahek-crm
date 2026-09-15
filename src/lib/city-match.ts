/**
 * IS THIS SHOP IN THAT CITY — the one place that is decided.
 *
 * The journey planner proposes a city and then offered the WHOLE book to pick
 * the day's stops from, so a day in Gwalior was arranged out of a list
 * containing every shop in Bhopal. Nothing on the screen said the list was
 * unfiltered; it simply looked like the salesman had a lot of shops in
 * Gwalior.
 *
 * It is PURE and it lives here rather than in the screen because `customers.
 * city` is not a clean column. It holds whatever the sheet typed: Gwalior is
 * spelled `GWALIOR` and `Gwalior` on this book, and AGENTS.md records that
 * several hundred of these values are whole postal addresses with the city
 * buried in the middle. A comparison written inline on a screen would be `===`
 * and would quietly match one of the two Gwaliors.
 */

/** Lower case, alphanumerics and single spaces. Nothing else survives. */
export function cityKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does `haystack` contain `needle` as a whole word?
 *
 * Whole word rather than a bare substring, because the haystack is routinely a
 * postal address and a substring match there is how "Pune" finds a shop on
 * "Punewadi Road". Both sides are already normalised to spaced lower case, so
 * padding with spaces is the whole of the word boundary.
 */
function containsWord(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Only what the decision needs. */
export type Placeable = { city: string | null; area?: string | null; beat?: string | null };

/**
 * The city is matched against the city, the area AND the beat.
 *
 * A shop recorded with its beat in the city column and its city in the area
 * column is not a mistake anybody is going to go back and fix on five thousand
 * rows, and refusing to look at the other two would drop it out of the only
 * list that would have found it.
 */
export function matchesCity(row: Placeable, city: string): boolean {
  const want = cityKey(city);
  if (!want) return false;
  return [row.city, row.area, row.beat].some((field) => {
    const key = cityKey(field);
    return key === want || containsWord(key, want);
  });
}

/** A shop nothing can place: no city, no area, no beat worth the name. */
export function hasNoPlace(row: Placeable): boolean {
  return !cityKey(row.city) && !cityKey(row.area) && !cityKey(row.beat);
}

/**
 * The book split three ways for the picker.
 *
 * `unplaceable` is its own bucket rather than being swept into `elsewhere`,
 * because the two are different facts and only one of them is somebody's
 * fault. "This shop is in Bhopal" is a reason not to visit it today; "nobody
 * ever recorded where this shop is" is a gap in the book, and hiding it in a
 * list headed "everywhere else" is how it stays a gap for another year.
 *
 * With NO city proposed there is nothing to be elsewhere OF, so the whole book
 * is `here` — the picker behaves exactly as it did before a city was typed.
 */
export function splitBook<T extends Placeable>(
  book: T[],
  city: string,
): { here: T[]; elsewhere: T[]; unplaceable: T[] } {
  if (!cityKey(city)) return { here: book, elsewhere: [], unplaceable: [] };
  const here: T[] = [];
  const elsewhere: T[] = [];
  const unplaceable: T[] = [];
  for (const row of book) {
    if (matchesCity(row, city)) here.push(row);
    else if (hasNoPlace(row)) unplaceable.push(row);
    else elsewhere.push(row);
  }
  return { here, elsewhere, unplaceable };
}
