/* ---------------------------------------------------------------------------
 * The one sentinel for "nothing assigned" in an account-manager filter.
 *
 * Sales, Sales manager and Back office each resolve through a `coalesce` to
 * NULL when nobody holds the seat — and `=`/`in` can never match NULL, so
 * there was no way to ask these dropdowns for the unassigned rows at all,
 * even though the column itself prints "Unassigned" on plenty of them.
 *
 * PURE, so the filter dropdowns (client) and `customerFilterClause` (server)
 * agree on the same string without either importing the other's module —
 * `queries.ts` is `server-only` and cannot be pulled into a client bundle.
 * ------------------------------------------------------------------------- */
export const UNASSIGNED_FILTER_VALUE = "__unassigned__";
