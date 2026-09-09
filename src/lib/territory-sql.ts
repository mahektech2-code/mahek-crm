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
