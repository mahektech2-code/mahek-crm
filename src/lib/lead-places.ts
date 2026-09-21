/* ---------------------------------------------------------------------------
 * WHERE A LEAD IS, as something a URL can carry.
 *
 * PURE AND CLIENT-SAFE, like `lead-filters.ts` beside it and for the same
 * reason: the picker is a client component and the clause that turns a pick
 * into SQL lives in a `server-only` service, so the two halves can only share
 * a module that imports neither.
 *
 * A PLACE IS A PATH AND NOT A VALUE, which is the whole of why this file
 * exists. "Nagpur" alone is not an answer — `customers.city` is what the sheet
 * typed, and two states can each hold a town of one name — so a pick carries
 * the branch it was made on. `territoryClause` already reads a place that way
 * (a city is matched AND-ed with its state), and this is the same shape spelled
 * for a query string so that the list and the territory it was allocated under
 * can never disagree about which shops a place has.
 *
 * WHY THE ESCAPING, which looks like ceremony and is not. 355 of the 1,165
 * `city` strings on the real book CARRY A COMMA — whole postal addresses were
 * dropped into that column, "06, MAHADEV TOWERS CO-OP HSG SOC, LTD, LBS MARG,
 * HARINIWAS CIRCLE, Thane, Maharashtra, 400602" offered as a city. Every other
 * multi-select in this product is `,`-separated in the URL, and putting one of
 * those strings into such a list unescaped turns one pick into eight that all
 * have to match, which is a filter that silently answers nothing. Escaped, the
 * value is an ordinary comma-separated parameter and `splitFilter`, "Clear
 * filters" and "Select everything this filter reaches" all go on working with
 * no special case anywhere — which is the point: a tenth filter that needed
 * its own handling in four places is a tenth filter that gets forgotten in one.
 * ------------------------------------------------------------------------- */

/**
 * One pick, narrowest rung last.
 *
 * `city` absent means the whole state and `beat` absent means the whole city —
 * the same reading the territory dialog gives a branch with nothing ticked
 * under it, and the same reading `territoryClause` gives a row with no child
 * beside it. THE NARROWEST RUNG IS THE PICK; the ones above it are the path to
 * it rather than a second, wider answer.
 */
export type PlacePick = { state: string; city?: string; beat?: string };

/** `>` between rungs. `,` stays the separator BETWEEN picks, as everywhere. */
const RUNG = ">";

/*
 * `%` FIRST ON THE WAY IN AND LAST ON THE WAY OUT, or the escaping eats its
 * own output: escaping the comma writes a `%`, and escaping `%` afterwards
 * would turn `%2C` into `%252C`. It is the ordinary rule for any escape
 * scheme and it is the ordinary way one is got wrong.
 */
const ESCAPES: Array<[string, string]> = [
  ["%", "%25"],
  [",", "%2C"],
  [RUNG, "%3E"],
];

function escape(raw: string): string {
  let out = raw;
  for (const [from, to] of ESCAPES) out = out.split(from).join(to);
  return out;
}

function unescape(raw: string): string {
  let out = raw;
  for (const [from, to] of [...ESCAPES].reverse()) out = out.split(to).join(from);
  return out;
}

/** A pick, as the one string that goes in the `place` parameter's list. */
export function encodePlace(pick: PlacePick): string {
  return [pick.state, pick.city, pick.beat]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => escape(part.trim()))
    .join(RUNG);
}

/**
 * The way back, and it never throws.
 *
 * A query string is a thing anybody can write, so a path with nothing in it,
 * or with four rungs, is read as far as it makes sense rather than refused:
 * a screen that will not draw over a typo is worse than one that shows a
 * wider list than somebody meant.
 */
export function decodePlace(raw: string): PlacePick | null {
  const parts = raw
    .split(RUNG)
    .map((p) => unescape(p).trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const [state, city, beat] = parts;
  return { state, ...(city ? { city } : {}), ...(beat ? { beat } : {}) };
}

/** Every pick the parameter carries, in the order it carries them. */
export function decodePlaces(values: string[]): PlacePick[] {
  return values
    .map(decodePlace)
    .filter((p): p is PlacePick => p !== null);
}

/** Two picks are the same place however three people spelled it. */
export function samePlace(a: PlacePick, b: PlacePick): boolean {
  const fold = (p: PlacePick) =>
    [p.state, p.city ?? "", p.beat ?? ""].map((s) => s.trim().toLowerCase()).join(RUNG);
  return fold(a) === fold(b);
}

/**
 * What a chip says: the narrowest rung, with the one above it for context.
 *
 * The state is NOT repeated on a beat — "Sadar in Nagpur" is what somebody
 * would say out loud, and a chip that reads "Sadar in Nagpur in Maharashtra"
 * is a chip nobody finishes on a row of eight.
 */
export function placeLabel(pick: PlacePick): string {
  if (pick.beat) return `${pick.beat} in ${pick.city ?? pick.state}`;
  if (pick.city) return `${pick.city} in ${pick.state}`;
  return pick.state;
}

/** The whole narrowing, said the way somebody would say it. */
export function placeSentence(picks: PlacePick[]): string {
  if (!picks.length) return "everywhere";
  return picks.map((p) => (p.city || p.beat ? placeLabel(p) : `the whole of ${p.state}`)).join("; ");
}
