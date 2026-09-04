/* ---------------------------------------------------------------------------
 * One column's sort, as the URL and the header both spell it: "column:asc" or
 * "column:desc". PURE — no I/O, no clock — so a screen's own `navigate`
 * function can keep being the one place a URL actually changes, and this
 * stays testable without one.
 *
 * The cycle is two states, not three: click a column and it sorts ascending;
 * click the SAME column again and it flips to descending; click it a third
 * time and it is back to ascending — there is no "unsorted" to cycle through,
 * because a table with 53 rows and no sort applied is not a state anybody
 * asked for.
 * ------------------------------------------------------------------------- */

export type SortDirection = "asc" | "desc";
export type SortValue = { column: string; direction: SortDirection };

export function parseSort(raw: string | undefined | null): SortValue | null {
  if (!raw) return null;
  const [column, direction] = raw.split(":");
  if (!column || (direction !== "asc" && direction !== "desc")) return null;
  return { column, direction };
}

export function formatSort(v: SortValue): string {
  return `${v.column}:${v.direction}`;
}

/** What clicking a column's header does to the CURRENT sort. */
export function nextSort(current: SortValue | null, column: string): SortValue {
  if (current?.column === column) {
    return { column, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column, direction: "asc" };
}
