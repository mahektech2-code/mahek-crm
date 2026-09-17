/* ---------------------------------------------------------------------------
 * How both Outstanding screens read their URL.
 *
 * The CRM's and the Accounts app's are one read of "what does this customer
 * owe" with different things around it, and they now take their search, their
 * sort and their page off the address bar. Two readings of `?sort=` would be
 * two screens that disagree about what an unrecognised one means — which is a
 * silent difference, because both would draw a list either way.
 *
 * PURE and client-safe: it validates strings and nothing else.
 * ------------------------------------------------------------------------- */

/**
 * The search box, the sort and the page are in the URL, and Postgres applies
 * them. Anything that is not one of the three sorts is dropped rather than
 * reaching the query.
 */
export type OutstandingSearchParams = {
  q?: string;
  sort?: string;
  overdue?: string;
  page?: string;
  per?: string;
};

export function readOutstandingParams(params: OutstandingSearchParams) {
  const sort =
    params.sort === "oldest" || params.sort === "name" ? params.sort : "owed";
  return {
    query: (params.q ?? "").trim(),
    overdueOnly: params.overdue === "1",
    sort: sort as "owed" | "oldest" | "name",
    page: Math.max(Number(params.page) || 1, 1),
    perPage: Math.min(Math.max(Number(params.per) || 25, 1), 200),
  };
}
