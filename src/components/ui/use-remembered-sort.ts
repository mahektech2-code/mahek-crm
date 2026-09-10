"use client";

import * as React from "react";
import { parseSort, type SortValue } from "@/lib/sort-param";

/* ---------------------------------------------------------------------------
 * Every other filter on these screens lives in the URL alone, and that is
 * right for them — a status or a name typed into a search box is something
 * somebody chose FOR THIS VISIT, worth a shareable link and nothing more. A
 * sort is different: picking "Outstanding, highest first" is a standing
 * preference about how this person reads this table, and asking them to
 * re-pick it every time they open the screen is not what "the state is
 * saved" means to anyone who has ever used a spreadsheet.
 *
 * So the sort is BOTH: it lives in the URL like everything else here (so a
 * link somebody sends carries the sort they were looking at), and it is
 * remembered per browser, per table, so a plain `/crm/customers` with no
 * `?sort=` at all reopens the way this person last left it rather than
 * resetting to the default every time.
 * ------------------------------------------------------------------------- */

const PREFIX = "mahekone.sort.";

/**
 * On mount ONLY, if the URL carries no sort, apply whatever this browser
 * remembers for `table` via `restore`. Mount-only is deliberate: a person
 * clicking back to the default must not be immediately overridden by their
 * own earlier preference re-asserting itself.
 */
export function useRestoreSort(
  table: string,
  current: SortValue | null,
  restore: (v: SortValue) => void,
) {
  React.useEffect(() => {
    if (current) return;
    let remembered: SortValue | null = null;
    try {
      remembered = parseSort(window.localStorage.getItem(PREFIX + table));
    } catch {
      // Private browsing, storage disabled, whatever — no memory to use.
    }
    if (remembered) restore(remembered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Called whenever a person actively picks a sort, so it is what is remembered next. */
export function rememberSort(table: string, v: SortValue) {
  try {
    window.localStorage.setItem(PREFIX + table, `${v.column}:${v.direction}`);
  } catch {
    // A failed write just means it will not be remembered next time.
  }
}
