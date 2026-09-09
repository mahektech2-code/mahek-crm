/**
 * Where a customer's geography lives, as SQL — PURE, and importable anywhere.
 *
 * It is in its own file rather than in `territory-service.ts` because that file
 * is `server-only` and pulls in the database, and this is the piece that most
 * needs a test: the whole territory feature was dead on the real book, and the
 * failure was invisible to types, to the linter and to every unit test. A rule
 * that can only be exercised with a live connection is a rule nobody exercises.
 * The same reason `lib/modules.ts` and `lib/account-types.ts` are pure.
 *
 * WHY THE FALL-THROUGH. `customers.territory_region` is the column the
 * territory model was written against, and it is empty on every one of the
 * 5,915 rows in production — nothing has ever filled it. `customers.region` is
 * the one the sheet fills, on 5,904 of them, and what it holds IS a state:
 * Maharashtra, Madhya Pradesh, Rajasthan, Kerala, Odisha, Goa.
 *
 * So every territory feature was dead on arrival, in the worse of the two
 * possible directions. The chip list read `territory_region`, came back empty,
 * and no patch could be set from the screen at all — and had anybody inserted a
 * row by hand, the filter matching that same empty column would have returned
 * NO salesmen and blanked that manager's entire console. An allocation that
 * empties a screen is the one failure nobody debugs, because it looks like
 * having no work.
 *
 * `territory_region` still wins wherever somebody fills it, so the column keeps
 * the meaning its schema comment gives it. `region` is what answers until then.
 */
export const TERRITORY_REGION_SQL =
  "coalesce(nullif(trim(territory_region), ''), nullif(trim(region), ''))";

/** Every column name a territory expression can contain. */
const COLUMNS = ["territory_region", "region", "city", "beat"] as const;

/**
 * The same expression, with every column name prefixed by a table.
 *
 * EVERY name, not just the first. `TERRITORY_REGION_SQL` mentions two columns,
 * and a caller that qualified one would leave the other binding to whatever
 * table is innermost — which inside a correlated subquery silently makes the
 * condition false. That is the bug AGENTS.md records under "in raw SQL, qualify
 * every column of the outer table"; it shipped once already, and it passes both
 * the type checker and the unit tests when it is wrong.
 *
 * `territory_region` is replaced before `region` because the second is a
 * substring of the first, and replacing the short one first would produce
 * `territory_c.region`.
 */
export function qualify(expression: string, table: string): string {
  return expression.replace(
    new RegExp(`\\b(${COLUMNS.join("|")})\\b`, "g"),
    `${table}.$1`,
  );
}

/**
 * The same value, folded to a key SQL can compare spellings on.
 *
 * `customers.region` is written from the sheet and holds 24 distinct strings
 * for about 20 places — Gujrat 97 beside Gujarat 31, Chhattisgadh 14 beside
 * Chhattisgarh 19, TAMIL NADU beside Tamilnadu. Comparing the raw text made
 * each spelling its own territory, so a chip saying "Gujarat" covered 31
 * customers and silently withheld 97.
 *
 * Letters only, lower case — the SQL twin of `stateKey` in `india-states.ts`,
 * and it has to stay its twin. The chip list canonicalises in JavaScript and
 * the filter compares in Postgres; if the two folded differently the console
 * would offer a place whose own customers it then failed to match, which is
 * the same class of failure as reading two different columns.
 */
export function stateKeySql(expression: string): string {
  return `regexp_replace(lower(coalesce(${expression}, '')), '[^a-z]', '', 'g')`;
}
