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
import { TERRITORY_REGION_SQL, qualify, stateKeySql } from "@/lib/territory-sql";
import { stateVariants } from "@/lib/india-states";

/** The kinds a territory can be, coarsest first. */
export const TERRITORY_KINDS = ["state", "region", "city", "beat"] as const;
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
const COLUMN: Record<TerritoryKind, string> = {
  state: TERRITORY_REGION_SQL,
  region: TERRITORY_REGION_SQL,
  city: "city",
  beat: "beat",
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
export const PARENT_KIND: Record<TerritoryKind, "state" | "city" | null> = {
  state: null,
  region: null,
  city: "state",
  beat: "city",
};

export type Territory = {
  kind: TerritoryKind;
  value: string;
  /**
   * The place this one was picked under — a city's state, a beat's city.
   * Empty or absent means not stated, which is every row written before the
   * hierarchy existed and is read as "this place wherever it is".
   */
  parent?: string;
};

/** Matches every spelling of a state, never the one somebody happened to click. */
function stateMatch(value: string): SQL {
  /* A STATE IS MATCHED ON EVERY SPELLING OF IT. The sheet writes this column
     and holds Gujrat 97 beside Gujarat 31, so comparing the text made each
     spelling its own territory and a chip saying "Gujarat" covered a quarter
     of Gujarat with nothing on the screen saying so. */
  const keys = stateVariants(value);
  if (!keys.length) return sql`false`;
  return sql`${sql.raw(stateKeySql(qualify(TERRITORY_REGION_SQL, "customers")))} in ${sql`(${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )})`}`;
}

/** Plain, trimmed, case-insensitive — how three people spell one city. */
function plainMatch(kind: "city" | "beat", value: string): SQL {
  /* Each column inside the expression is qualified, not just the first. A bare
     column name inside a correlated subquery binds to the INNER table and the
     condition silently becomes false — the rule AGENTS.md records under "in raw
     SQL, qualify every column of the outer table", which shipped once already
     and passes both types and unit tests when it is wrong. */
  const column = sql.raw(qualify(COLUMN[kind], "customers"));
  return sql`lower(trim(coalesce(${column}, ''))) = ${value.trim().toLowerCase()}`;
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
export function territoryClause(territories: Territory[]): SQL {
  if (!territories.length) return sql`false`;

  const parts = territories.map((t) => {
    const own =
      t.kind === "state" || t.kind === "region"
        ? stateMatch(t.value)
        : plainMatch(t.kind, t.value);

    const parentKind = PARENT_KIND[t.kind];
    const parent = t.parent?.trim();
    if (!parentKind || !parent) return own;

    /* The parent is ANDed, so the pair reads as one place. A legacy row has no
       parent and keeps its old meaning, which is why this is a fall-through
       rather than a refusal: a city allocated before the hierarchy existed must
       not silently stop matching. */
    const above =
      parentKind === "state" ? stateMatch(parent) : plainMatch(parentKind, parent);
    return sql`(${above} and ${own})`;
  });

  return sql`(${sql.join(parts, sql` or `)})`;
}
