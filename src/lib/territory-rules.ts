/**
 * WHAT A TERRITORY IS, as rules — PURE, and importable anywhere.
 *
 * It sits beside `territory-sql.ts` rather than inside `territory-service.ts`
 * for the reason that file already gives: the service is `server-only` and
 * pulls in the database, and this is the piece that most needs a test. The
 * whole territory feature was once dead on the real book, and the failure was
 * invisible to types, to the linter and to every unit test. A rule that can
 * only be exercised with a live connection is a rule nobody exercises.
 *
 * A territory NARROWS a book somebody already had. It is not a permission and
 * it must never be read as one: `ASSIGNED_TO_SQL`, `BACK_OFFICE_SQL` and
 * `LEAD_MANAGER_SQL` in `access-control.ts` remain the whole of who may see
 * what, and nothing here can widen them. A salesman allocated Nagpur sees HIS
 * customers and HIS leads in Nagpur — never another salesman's.
 *
 * The distinction is the important thing in this file, because the two look
 * alike from a distance. A reader who mistakes this for the security boundary
 * might delete a real check believing it redundant, and the failure would be
 * silent and in the wrong direction.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  TERRITORY_BEAT_SQL,
  TERRITORY_REGION_SQL,
  qualify,
  stateKeySql,
} from "@/lib/territory-sql";
import { canonicalState, isKnownState, stateKey, stateVariants } from "@/lib/india-states";
import { placeKey } from "@/lib/place-parse";
import { treeNamesFor, type PlaceIndex } from "@/lib/place-tree";
import { splitTownParent, territoryName } from "@/lib/territory-path";

export { splitTownParent, territoryName, townParent } from "@/lib/territory-path";

/**
 * The kinds a territory can be, coarsest first.
 *
 * TWO FAMILIES SHARE THIS LIST. `state`, `city` and `beat` compare what the
 * sheet TYPED on the customer row; `district` and `town` name nodes of the
 * reviewed location tree (`places`) and compare the shop's `resolved_*_id`
 * columns. The dialog now picks state › district › town, because a district
 * is how Mahek actually divides the country and the typed city column is
 * 1,165 spellings of a few hundred places with whole postal addresses among
 * them. `city` and `beat` stay because rows of them exist and must go on
 * meaning exactly what they meant — nothing rewrites somebody's allocation.
 *
 * `town` is the tree's CITY rung under another name, so that a row saying
 * "Kalyan" cannot be confused with a typed `city` row saying the same word
 * and matched against a different column.
 */
export const TERRITORY_KINDS = ["state", "region", "district", "town", "city", "beat"] as const;
export type TerritoryKind = (typeof TERRITORY_KINDS)[number];

/**
 * Which customer expression each kind is matched against.
 *
 * `state` and `region` read the same geography and are two kinds rather than
 * one because they are allocated by different people for different reasons: a
 * `region` row is a MANAGER's oversight patch, read by `managerScope`, and a
 * `state` row is a salesman's own working area, read by `territoryClause`.
 * Folding them into one kind would mean allocating a salesman his state
 * silently widened or narrowed somebody's console — which is exactly what
 * `setWorkingTerritories` refuses to allow by never touching `region` rows.
 */
const COLUMN: Record<Exclude<TerritoryKind, "district" | "town">, string> = {
  state: TERRITORY_REGION_SQL,
  region: TERRITORY_REGION_SQL,
  city: "city",
  /* Both spellings of the third rung — see `TERRITORY_BEAT_SQL`. The picker
     reads the same expression, so a chip and the filter behind it cannot
     disagree about which shops a beat has. */
  beat: TERRITORY_BEAT_SQL,
};

/**
 * WHAT EACH KIND IS PICKED UNDER. A city belongs to a state, a beat to a city,
 * and a state to nothing — it is the top of the tree.
 *
 * This is the one statement of the hierarchy. The dialog reads it to decide
 * what opens what, the action reads it to refuse a city arriving without its
 * state, and the clause below reads it to know which column a `parent` is
 * compared against. Three copies of a shape is how the screen comes to offer
 * something the action then rejects.
 */
export const PARENT_KIND: Record<TerritoryKind, "state" | "district" | "city" | null> = {
  state: null,
  region: null,
  district: "state",
  town: "district",
  city: "state",
  beat: "city",
};

export type Territory = {
  kind: TerritoryKind;
  value: string;
  /**
   * The place this one was picked under — a city's state, a beat's city, a
   * district's state. A TOWN's parent names its district AND that district's
   * state ("Thane, Maharashtra", see `townParent`), because there is an
   * Aurangabad district in Maharashtra and another in Bihar, each with an
   * Aurangabad town in it, and the district's own name cannot tell them apart.
   * Empty or absent means not stated, which is every row written before the
   * hierarchy existed and is read as "this place wherever it is".
   */
  parent?: string;
};

/**
 * WHICH NODE A ROW IS, and which node it hangs from — as keys a set can hold.
 *
 * The action stores only the narrowest pick in each branch, and that needs
 * "does any other row hang from this one" asked of a district as well as a
 * state. Comparing bare values, which is what it did, would prune Aurangabad
 * district in Bihar because a town was picked under Aurangabad district in
 * Maharashtra — so a district's key carries its state.
 */
export function territoryNodeKey(t: Territory): string {
  const v = placeKey(t.value);
  switch (t.kind) {
    case "state":
    case "region":
      return `state:${stateKey(canonicalState(t.value))}`;
    case "district":
      return `district:${v}|${stateKey(canonicalState(t.parent))}`;
    case "town": {
      const { district, state } = splitTownParent(t.parent);
      return `town:${v}|${placeKey(district)}|${stateKey(canonicalState(state))}`;
    }
    default:
      return `${t.kind}:${v}`;
  }
}

/** The key of the node a row hangs from, or null for the top of a branch. */
export function territoryParentKey(t: Territory): string | null {
  const parent = t.parent?.trim();
  if (!parent) return null;
  switch (t.kind) {
    case "district":
    case "city":
      return `state:${stateKey(canonicalState(parent))}`;
    case "town": {
      const { district, state } = splitTownParent(parent);
      return `district:${placeKey(district)}|${stateKey(canonicalState(state))}`;
    }
    case "beat":
      return `city:${placeKey(parent)}`;
    default:
      return null;
  }
}

/**
 * THE NARROWEST PICK IN A BRANCH IS THE ALLOCATION, and the wider ones above
 * it are the path to it rather than a second grant: a state with a district
 * picked under it is dropped, a district with towns under it is dropped, and
 * what is stored is the leaves. See `setSalesmanTerritories` for why.
 */
export function territoryLeaves<T extends Territory>(picked: T[]): T[] {
  const hungFrom = new Set(picked.map(territoryParentKey).filter((k): k is string => !!k));
  return picked.filter((t) => !hungFrom.has(territoryNodeKey(t)));
}

/**
 * WHICH TABLE THE COLUMNS BELONG TO, defaulted to the one every caller had.
 *
 * Every territory caller selects `from customers` unaliased, so `customers.city`
 * was hard-coded — and a bare `customers.` prefix is not a name Postgres can
 * resolve inside `from customers c`, which is how the leads list spells it. It
 * is a parameter rather than a second copy of the clause: two readings of
 * "which shops are in Nagpur" is precisely what this file exists to prevent,
 * and the half that drifts would be the one nobody is comparing.
 */
function stateMatch(value: string, table: string): SQL {
  /* A STATE IS MATCHED ON EVERY SPELLING OF IT. The sheet writes this column
     and holds Gujrat 97 beside Gujarat 31, so comparing the text made each
     spelling its own territory and a chip saying "Gujarat" covered a quarter
     of Gujarat with nothing on the screen saying so. */
  const keys = stateVariants(value);
  if (!keys.length) return sql`false`;
  return sql`${sql.raw(stateKeySql(qualify(TERRITORY_REGION_SQL, table)))} in ${sql`(${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )})`}`;
}

/** Plain, trimmed, case-insensitive — how three people spell one city. */
function plainMatch(kind: "city" | "beat", value: string, table: string): SQL {
  /* Each column inside the expression is qualified, not just the first. A bare
     column name inside a correlated subquery binds to the INNER table and the
     condition silently becomes false — the rule AGENTS.md records under "in raw
     SQL, qualify every column of the outer table", which shipped once already
     and passes both types and unit tests when it is wrong. */
  const column = sql.raw(qualify(COLUMN[kind], table));
  return sql`lower(trim(coalesce(${column}, ''))) = ${value.trim().toLowerCase()}`;
}

/**
 * A DISTRICT OR A TOWN IS A NODE OF THE REVIEWED TREE, matched on the shop's
 * place there and never on what the sheet typed.
 *
 * The node is named rather than stored by id, like every other territory row,
 * so the handset can show it and the audit can read it; the subquery turns the
 * name back into the one node it means — a district under ITS state, a town
 * under its district under its state. It is uncorrelated, so Postgres reads it
 * once however many shops are being narrowed.
 *
 * A shop the tree has placed only as far as its state — the town it typed
 * matched two places or none — is reached by a whole-state pick and by nothing
 * finer. The dialog counts those and says so, rather than guessing a district
 * on its behalf.
 */
function districtMatch(district: string, state: string, table: string): SQL {
  const d = placeKey(district);
  const s = placeKey(canonicalState(state));
  if (!d || !s) return sql`false`;
  return sql`${sql.raw(`${table}.resolved_district_id`)} in (
    select tp_d.id from places tp_d
      join places tp_s on tp_s.id = tp_d.parent_id and tp_s.kind = 'state'
     where tp_d.kind = 'district' and tp_d.key = ${d} and tp_s.key = ${s})`;
}

function townMatch(town: string, parent: string | undefined, table: string): SQL {
  const { district, state } = splitTownParent(parent);
  const c = placeKey(town);
  const d = placeKey(district);
  const s = placeKey(canonicalState(state));
  if (!c || !d || !s) return sql`false`;
  return sql`${sql.raw(`${table}.resolved_city_id`)} in (
    select tp_c.id from places tp_c
      join places tp_d on tp_d.id = tp_c.parent_id and tp_d.kind = 'district'
      join places tp_s on tp_s.id = tp_d.parent_id and tp_s.kind = 'state'
     where tp_c.kind = 'city' and tp_c.key = ${c} and tp_d.key = ${d} and tp_s.key = ${s})`;
}

/**
 * The SQL that narrows a customer list to somebody's territories.
 *
 * NEVER `undefined`. An empty list is a match-nothing clause rather than an
 * absent one, because "nowhere has been allocated" now means "no book" — and
 * the whole risk of that rule is a caller that treats an absent clause as
 * permission, which is the shape this used to have. Returning `false` makes the
 * dangerous case the loud one.
 *
 * A ROW IS MATCHED WITH ITS PARENT, so a city narrows INSIDE its state rather
 * than beside it. Picking Maharashtra and then Pune within it means Pune, not
 * the whole of Maharashtra — `and`, not `or`, down a branch. Across branches it
 * is still `or`: two states is both states.
 */
export function territoryClause(territories: Territory[], table = "customers"): SQL {
  if (!territories.length) return sql`false`;

  const parts = territories.map((t) => {
    /* A tree node already carries its whole path, so there is no parent to
       AND on — the state is part of which district this is. */
    if (t.kind === "district") return districtMatch(t.value, t.parent ?? "", table);
    if (t.kind === "town") return townMatch(t.value, t.parent, table);

    const own =
      t.kind === "state" || t.kind === "region"
        ? stateMatch(t.value, table)
        : plainMatch(t.kind, t.value, table);

    const parentKind = PARENT_KIND[t.kind];
    const parent = t.parent?.trim();
    if (!parentKind || !parent) return own;

    /* The parent is ANDed, so the pair reads as one place. A legacy row has no
       parent and keeps its old meaning, which is why this is a fall-through
       rather than a refusal: a city allocated before the hierarchy existed must
       not silently stop matching. */
    /* Among the typed kinds only a beat hangs from something other than a
       state, and what it hangs from is a typed city. */
    const above =
      parentKind === "state"
        ? stateMatch(parent, table)
        : plainMatch("city", parent, table);
    return sql`(${above} and ${own})`;
  });

  return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * WHERE A NEW LEAD MAY BE RAISED — inside the book its salesman can see, and
 * nowhere else.
 *
 * Mahek's rule is that a salesman raises leads in his own territory. It is
 * stated here as "the lead must land in his book" rather than as a second
 * reading of what a territory is, because those are the same fact and two
 * statements of it drift: a lead accepted outside the book is a lead its own
 * author can never open, which is exactly the failure that surfaced the rule.
 * `matchesTerritory` is `territoryClause` in JavaScript, row for row — the
 * parent ANDed, states compared on every spelling — so what this lets in is
 * what that query then finds.
 *
 * THE STATE IS RESOLVED HERE TOO, because without one nothing lands anywhere.
 * Every allocated city carries its state as a parent, and every handset lead
 * used to arrive with no state at all — so it matched no territory, and no
 * lead raised on a phone ever reached a Customers book, inside the area or
 * not. In order: what the phone said; the parent of the allocated city it
 * names; what the rest of the book says that town is in (`bookState`, read by
 * the caller); and, for somebody allocated exactly one state, that state. A
 * state that cannot be resolved by any of them is not guessed — the lead is
 * refused as outside, and the sentence asks for the area to be picked. A
 * district or town allocation names its state too, so it counts as one.
 *
 * A DISTRICT OR TOWN ALLOCATION NEEDS THE TREE. Those rows are matched on the
 * shop's place in `places`, and a lead has no row yet — so the caller hands in
 * the tree (`index`), the typed town is placed on it by `treeNamesFor`, and
 * that is the same matcher `placeShopsNow` runs on the row once it is written.
 * Without the tree no district or town row can match, which is the safe
 * direction: the lead is refused and says which areas are his.
 *
 * `exempt` with nothing allocated is the manager or admin whose book is not
 * narrowed by territory at all; for them there is nothing to be outside of,
 * and the state is still resolved where it can be so the row carries one.
 */
export type LeadPlace = {
  city?: string | null;
  area?: string | null;
  /** The state the phone named, where its build asks. */
  state?: string | null;
  /** The state the book most often files this city under, if any. */
  bookState?: string | null;
};

/** A place as `matchesTerritory` reads it: what was typed, and where the tree puts it. */
export type MatchPlace = {
  city?: string | null;
  area?: string | null;
  state?: string | null;
  /** The tree's district for this place, where it could be placed. */
  district?: string | null;
  /** The tree's town (its CITY rung), where it could be placed. */
  town?: string | null;
};

export type LeadPlacement =
  | { ok: true; state: string | null }
  | { ok: false; reason: "no_area" | "outside"; areas: string[] };

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() !== "" &&
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

const sameState = (a: string | null | undefined, b: string | null | undefined) =>
  !!a?.trim() && !!b?.trim() && stateVariants(b).includes(stateKey(a));

const samePlace = (a: string | null | undefined, b: string | null | undefined) =>
  placeKey(a) !== "" && placeKey(a) === placeKey(b);

/** One territory row against one place — `territoryClause`'s own test, in JS. */
export function matchesTerritory(t: Territory, place: MatchPlace): boolean {
  if (t.kind === "district") {
    return samePlace(place.district, t.value) && sameState(place.state, t.parent);
  }
  if (t.kind === "town") {
    const { district, state } = splitTownParent(t.parent);
    return (
      samePlace(place.town, t.value) &&
      samePlace(place.district, district) &&
      sameState(place.state, state)
    );
  }
  const own =
    t.kind === "state" || t.kind === "region"
      ? sameState(place.state, t.value)
      : t.kind === "city"
        ? same(place.city, t.value)
        : same(place.area, t.value);
  const parent = t.parent?.trim();
  if (!own || !parent || !PARENT_KIND[t.kind]) return own;
  return PARENT_KIND[t.kind] === "state" ? sameState(place.state, parent) : same(place.city, parent);
}

/**
 * How an allocation reads on a refusal: "Pune (Maharashtra)", "Odisha",
 * "Thane district (Maharashtra)", "Kalyan (Thane, Maharashtra)".
 */
export function territoryLabel(t: Territory): string {
  const parent = t.parent?.trim();
  return parent ? `${territoryName(t)} (${parent})` : territoryName(t);
}

/** The state an allocation row sits in, whatever its kind — or "" where it names none. */
function stateOfTerritory(t: Territory): string {
  if (t.kind === "state" || t.kind === "region") return canonicalState(t.value);
  if (t.kind === "district" || t.kind === "city") return canonicalState(t.parent);
  if (t.kind === "town") return canonicalState(splitTownParent(t.parent).state);
  return "";
}

export function placeNewLead(
  territories: Territory[],
  place: LeadPlace,
  exempt: boolean,
  index?: PlaceIndex,
): LeadPlacement {
  /* Every state an allocation names — a district and a town name theirs too,
     so somebody given three districts of Maharashtra is "in one state". */
  const allocatedStates = new Set(territories.map(stateOfTerritory).filter(Boolean));
  const onlyState = allocatedStates.size === 1 ? [...allocatedStates][0] : null;
  /* The town he typed IS one of his — a typed city row, a tree town or a
     district of the same name — so its state is the one that row names. */
  const named = territories.find(
    (t) =>
      (t.kind === "city" || t.kind === "town" || t.kind === "district") &&
      samePlace(place.city, t.value) &&
      stateOfTerritory(t),
  );
  const namedState = named ? stateOfTerritory(named) : null;

  /* A handset built before districts existed offers a district or town chip
     as though it were a STATE, and sends "Thane" in the state box. Taken at its
     word that would file the lead in a state called Thane and refuse it; a
     state the phone names is believed only when it is one. */
  const phoneState = isKnownState(place.state) ? place.state : null;

  let state =
    [phoneState, namedState, place.bookState, onlyState]
      .map((s) => (s?.trim() ? canonicalState(s) : ""))
      .find(Boolean) || null;

  /* Where the tree puts the place, under that state — and, with no state from
     anywhere else, the one state a town name like "Nagpur" unambiguously means. */
  /* The town the row will be written with — a handset lead falls back from its
     city to its area — because that is what `placeShopsNow` places it by. */
  const onTree = index
    ? treeNamesFor(index, { state, city: place.city?.trim() || place.area?.trim() || null })
    : null;
  if (!state && onTree?.state) state = onTree.state;

  if (!territories.length) {
    return exempt
      ? { ok: true, state }
      : { ok: false, reason: "no_area", areas: [] };
  }

  const resolved: MatchPlace = {
    city: place.city,
    area: place.area,
    state,
    district: onTree?.district ?? null,
    town: onTree?.town ?? null,
  };
  if (territories.some((t) => matchesTerritory(t, resolved))) return { ok: true, state };

  return {
    ok: false,
    reason: "outside",
    areas: [...new Set(territories.map(territoryLabel))].sort((a, b) => a.localeCompare(b)),
  };
}
