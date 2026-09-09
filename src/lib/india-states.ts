/**
 * One state, however it was spelled — PURE, no I/O.
 *
 * `customers.region` is written from the sheet by two projections, so it holds
 * whatever whoever typed the row typed. On the real book that is 24 distinct
 * strings for about 20 places:
 *
 *   Gujrat 97 and Gujarat 31          — the misspelling is the MAJORITY
 *   Chhattisgadh 14 and Chhattisgarh 19
 *   Tamilnadu 14 and TAMIL NADU 2     — a space and a case apart
 *   West Bangal 3, HARYANA 1, NEW DELHI 1
 *
 * Left alone that is not a cosmetic problem. The territory picker offers one
 * chip per distinct string, so allocating somebody "Gujarat" gives them 31
 * customers and silently withholds 97 — and nothing on any screen says a
 * second Gujarat exists. An allocation that hides most of a state is the same
 * failure as one that empties a book, only harder to notice, because the
 * screen looks like it worked.
 *
 * NORMALISED ON READ, NOT CLEANED IN THE DATABASE. The sheet is authoritative
 * and re-projected on a schedule, so a corrected row would be overwritten on
 * the next pass — the lesson `customers.sales_person_name` already records,
 * where holding an id while letting the name revert was the worst outcome
 * available. Cleaning the sheet itself is still worth doing and this does not
 * fight it: an alias that no longer matches anything simply stops being used.
 *
 * TWO MECHANISMS, because there are two kinds of difference:
 *
 *   `stateKey` strips everything but letters, so "TAMIL NADU", "Tamilnadu" and
 *   "tamil nadu" are one key without anybody listing them. That handles case
 *   and spacing, which is most of it and needs no maintenance.
 *
 *   `ALIASES` is for a genuine misspelling, which no rule can derive. Each one
 *   is a decision somebody made about a place, so each is written down.
 *
 * A value in NEITHER is kept as it was typed, tidied. It is not guessed at: a
 * state nobody listed is far likelier to be a place this file has not been
 * taught than a typo, and silently folding it into a neighbour would move
 * customers between territories on the strength of a string edit.
 */

/** Letters only, lower case — "TAMIL NADU" and "Tamilnadu" fold together. */
export function stateKey(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * The states and union territories, spelled the way MahekOne shows them.
 *
 * Only what this book actually needs plus the rest of the country, so a chip
 * list never offers somewhere no customer is — the same rule `knownPlaces`
 * follows. Nothing here is a permission and nothing filters by it: it decides
 * how a place is WRITTEN, and which spellings count as the same place.
 */
const CANONICAL = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
  "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
  "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
  "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
  "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir",
  "Ladakh", "Lakshadweep", "Puducherry",
] as const;

/**
 * Spellings a rule cannot derive, each one seen in the book.
 *
 * Keyed by `stateKey`, so only real misspellings need listing — case and
 * spacing are already handled. "Daman and Diu" and "Jammu & Kashmir" are here
 * because the country renamed and merged them, not because anybody typed them
 * wrong; the customers are real and their state has a different name now.
 */
const ALIASES: Record<string, string> = {
  gujrat: "Gujarat",
  chhattisgadh: "Chhattisgarh",
  chattisgarh: "Chhattisgarh",
  westbangal: "West Bengal",
  newdelhi: "Delhi",
  damonanddiu: "Dadra and Nagar Haveli and Daman and Diu",
  damananddiu: "Dadra and Nagar Haveli and Daman and Diu",
  jammukashmir: "Jammu and Kashmir",
  pondicherry: "Puducherry",
  orissa: "Odisha",
  uttaranchal: "Uttarakhand",
};

const BY_KEY = new Map<string, string>();
for (const name of CANONICAL) BY_KEY.set(stateKey(name), name);
for (const [key, name] of Object.entries(ALIASES)) BY_KEY.set(key, name);

/** Trim and collapse the whitespace. Nothing else — the words are kept. */
function tidy(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * The name to SHOW, for a value off the sheet.
 *
 * An unrecognised value comes back tidied rather than dropped or guessed at.
 * A place this file has not been taught is still a place customers are in.
 */
export function canonicalState(raw: string | null | undefined): string {
  const key = stateKey(raw);
  if (!key) return "";
  return BY_KEY.get(key) ?? tidy(raw ?? "");
}

/**
 * Every key that means this place — what a filter has to match against.
 *
 * The canonical name's own key plus every alias pointing at it, so a chip
 * saying "Gujarat" matches the 97 rows spelled "Gujrat" as well as the 31
 * spelled properly. `extra` carries keys found in the BOOK that fold onto the
 * same place through `stateKey` alone, so a filter never needs this file to
 * have anticipated a particular way of spacing a name.
 */
export function stateVariants(
  canonical: string,
  extra: readonly string[] = [],
): string[] {
  const want = canonicalState(canonical);
  const keys = new Set<string>([stateKey(want)]);
  for (const [key, name] of BY_KEY) if (name === want) keys.add(key);
  for (const raw of extra) if (canonicalState(raw) === want) keys.add(stateKey(raw));
  keys.delete("");
  return [...keys].sort();
}
