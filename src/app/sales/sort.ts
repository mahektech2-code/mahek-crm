/* ---------------------------------------------------------------------------
 * SORTING A TABLE, IN THE URL.
 *
 * Thirty-six tables in this console and not one of them could be re-ordered.
 * Every list arrives in the order its query chose — which is usually the right
 * FIRST order, and never the only question somebody has about it. "Who has the
 * most shops", "which claim is biggest", "who has been quiet longest" are all
 * one column away and were all unanswerable.
 *
 * It is a LINK and a search param rather than client state, for the reason the
 * filter chips already give: a manager who has sorted to what is worst should
 * be able to send that to somebody. It also means the screens stay server
 * components — the alternative is making every list a client component to hold
 * one string.
 *
 * PURE, so it is tested without a database and without a browser.
 * ------------------------------------------------------------------------- */

export type SortDir = "asc" | "desc";

export type Sort = {
  /** The column key, or null where the query's own order stands. */
  key: string | null;
  dir: SortDir;
};

/**
 * What a row is worth under one column.
 *
 * `null` means "this row has no value here" and is always sorted LAST,
 * whichever direction is asked for — a shop with no pin, a claim with no
 * decision, a handset that has never synced. Floating them to the top on a
 * descending sort would put the rows that answer the question least at the
 * place the eye goes first.
 */
export type SortValue = string | number | null;

export type SortColumns<T> = Record<string, (row: T) => SortValue>;

/**
 * Read a sort off the URL, refusing anything that is not a column.
 *
 * An unknown key answers `null`, which is the query's own order — so a stale
 * link from a screen that has since lost a column degrades to the default
 * rather than to an empty table.
 */
export function readSort<T>(
  params: { sort?: string; dir?: string },
  columns: SortColumns<T>,
): Sort {
  const key = params.sort && params.sort in columns ? params.sort : null;
  return { key, dir: params.dir === "asc" ? "asc" : "desc" };
}

/**
 * The href the header cell points at.
 *
 * Clicking the column already sorted FLIPS it; clicking another starts it
 * descending, because every sortable column here answers a "most/latest" or a
 * "who is worst" question first.
 */
export function sortHref(base: string, current: Sort, key: string, keep = ""): string {
  const dir: SortDir = current.key === key && current.dir === "desc" ? "asc" : "desc";
  const extra = keep ? `${keep}&` : "";
  return `${base}?${extra}sort=${encodeURIComponent(key)}&dir=${dir}`;
}

/**
 * A STABLE sort, and it never mutates what it is given.
 *
 * `Array.prototype.sort` is specified stable, so rows that tie keep the order
 * the query put them in — which is how a table sorted by city still reads
 * newest-first inside each town, rather than in whatever order the planner
 * happened to return.
 */
export function sortRows<T>(rows: T[], sort: Sort, columns: SortColumns<T>): T[] {
  if (!sort.key) return rows;
  const value = columns[sort.key];
  if (!value) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y), "en", { numeric: true }) * sign;
  });
}
