/**
 * A reverse-geocode answer turned into the four rungs of a place — PURE, no I/O.
 *
 * WHY THIS IS NOT STRING CLEANING. `customers.city` holds 1,165 distinct
 * strings for a book of 5,925 shops, 675 of them naming exactly one shop and
 * 355 of them containing a comma because the sheet dropped whole postal
 * addresses into the column ("06, MAHADEV TOWERS CO-OP HSG SOC, LTD, LBS MARG,
 * HARINIWAS CIRCLE, Thane, Maharashtra, 400602" offered as a city). No rule
 * over those strings can produce a hierarchy: the city in that example is the
 * sixth comma-separated field, and in "jabalpur, madhya pradesh, india" it is
 * the first. Stripping at the comma takes 1,165 distinct values to 1,078,
 * which is not a cleanup, it is a rounding error with a person's afternoon
 * spent on it.
 *
 * What DOES produce a hierarchy is the coordinate. 4,930 of those 5,925 shops
 * carry a pin somebody stood on, and a reverse geocode of one answers with the
 * administrative tree the shop is actually in — so the master is READ OFF THE
 * BOOK rather than typed, and a shop's state, district, city and area are
 * four facts about where it is instead of four readings of one free-text box.
 *
 * THE FOUR RUNGS, and why these four:
 *
 *   state    `administrative_area_level_1`  — Maharashtra
 *   district `administrative_area_level_2`  — Nagpur
 *   city     `locality`                     — Nagpur
 *   area     `sublocality`                  — Sitabuldi
 *
 * The district and the city are often the same word and are still two rungs,
 * because in the places where they differ they differ enormously: this book
 * carries Kandivali, Dombivali, Mira Road and Nalasopara as separate "cities"
 * with 37 to 92 shops each, and all four are one district. Collapsing them
 * would merge a salesman's whole working unit into Mumbai and make a day's
 * plan meaningless — the district is what a territory is allocated in and the
 * city is what a day is walked in, and neither can do the other's job.
 *
 * A MISSING RUNG IS NOT AN ERROR. Ola answers with what the administrative
 * tree actually carries at that point, and rural coordinates routinely have no
 * sublocality and sometimes no locality. The rung is left absent rather than
 * filled from the one above it: "the area is Nagpur" invented from the city is
 * a statement nobody made, and an area list full of city names is one nobody
 * can pick a beat from. `neighborhood` is NOT read as a second-choice
 * sublocality for the same reason — it is a finer-grained place, so promoting
 * it would put two different rungs in one column with nothing saying which.
 */

/** What the geocoder returns, narrowed to the part this reads. */
export type AddressComponent = {
  types?: string[];
  long_name?: string;
  short_name?: string;
};

export type ReverseGeocodeResult = {
  formatted_address?: string;
  address_components?: AddressComponent[];
};

/** The four rungs, plus what corroborates them. Any rung may be absent. */
export type ParsedPlace = {
  state: string;
  district: string;
  city: string;
  area: string;
  pincode: string;
  /** What the geocoder said in full, for a person checking a doubtful row. */
  formatted: string;
};

/** The order they nest in, coarsest first. One statement of the shape. */
export const PLACE_KINDS = ["state", "district", "city", "area"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** What each rung is picked under. The top of the tree is picked under nothing. */
export const PLACE_PARENT: Record<PlaceKind, PlaceKind | null> = {
  state: null,
  district: "state",
  city: "district",
  area: "city",
};

/** Which component type answers each rung. */
const COMPONENT: Record<PlaceKind, string> = {
  state: "administrative_area_level_1",
  district: "administrative_area_level_2",
  city: "locality",
  area: "sublocality",
};

/** Trim and collapse the whitespace. Nothing else — the words are kept. */
function tidy(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

function component(result: ReverseGeocodeResult, type: string): string {
  const hit = result.address_components?.find((c) => c.types?.includes(type));
  /* `long_name` before `short_name`: the short one abbreviates and the
     abbreviation is not stable between answers, so two shops in one place
     would produce two nodes. */
  return tidy(hit?.long_name ?? hit?.short_name);
}

/**
 * The four rungs of one answer.
 *
 * A rung whose component is absent comes back empty and is NOT derived from
 * its neighbours — see the note above. The caller stops descending at the
 * first empty rung, because a city with no district above it has nothing to
 * hang from.
 */
export function parsePlace(result: ReverseGeocodeResult | undefined): ParsedPlace {
  const empty = { state: "", district: "", city: "", area: "", pincode: "", formatted: "" };
  if (!result) return empty;

  return {
    state: component(result, COMPONENT.state),
    district: component(result, COMPONENT.district),
    city: component(result, COMPONENT.city),
    area: component(result, COMPONENT.area),
    pincode: component(result, "postal_code"),
    formatted: tidy(result.formatted_address),
  };
}

/**
 * The rungs as a chain, stopping at the first one nothing answered.
 *
 * A TREE CANNOT HAVE A HOLE IN IT. Ola answers rural coordinates with a state
 * and a district and no locality, and a sublocality arriving under that hole
 * would have to hang from the district — which is a rung it is not the child
 * of, and every count above it would then be a count of two different things.
 * So the chain ends where the answer does: that shop is resolved to its
 * district and the two rungs below it stay unresolved, which is the truth and
 * is a thing a screen can say.
 */
export function placeChain(parsed: ParsedPlace): Array<{ kind: PlaceKind; name: string }> {
  const chain: Array<{ kind: PlaceKind; name: string }> = [];
  for (const kind of PLACE_KINDS) {
    const name = parsed[kind];
    if (!name) break;
    chain.push({ kind, name });
  }
  return chain;
}

/**
 * The fold two spellings of one place share — letters and digits, lower case.
 *
 * The SQL twin of `stateKey` in `india-states.ts` one rung up, and it has to
 * stay a twin of itself across the two runtimes for the same reason that one
 * does: the picker groups in JavaScript and the filter compares in Postgres,
 * and a picker offering a place whose own shops it then fails to match is the
 * failure the territory feature already shipped once.
 *
 * Digits are KEPT, unlike `stateKey`, because a place name can legitimately
 * carry one — "Sector 18", "Phase 2" — and folding those together would make
 * every sector of a township one area.
 */
export function placeKey(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
