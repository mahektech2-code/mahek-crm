import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { calendarDate } from "@/lib/business-date";
import type { ListQuery } from "./list-query";
import { periodLabel, periodWindow, type DateWindow, type PeriodPreset } from "./period";

/* ---------------------------------------------------------------------------
 * A REGISTER IS READ THROUGH A WINDOW, AND A WINDOW HAS A CEILING.
 *
 * `period.ts` says what a period covers; this is how a screen module turns the
 * one in the URL into SQL, so that a register costs what its window holds and
 * never what its history holds. Three things widen a window rather than
 * narrow it, because each names records somebody asked for by id:
 *
 *  - `open`: the record a link points at (`?open=`). A link from a dashboard,
 *    a notification or another screen must open the record it names even
 *    when it is older than the default window.
 *  - `ids`: a dashboard tile's pre-filter (`?f=`), and "Show the whole order".
 *    With ids the window is the ids alone — they ARE the list asked for.
 *
 * ROW_CAP is the ceiling. A window that holds more rows than one page load may
 * build is not built at all: the module counts first (one `count(*)` on an
 * indexed date) and answers `tooWide`, and the screen asks for a narrower
 * period. That is what makes the server's memory a function of the cap and
 * never of the data — "All time" on a register is allowed for as long as all
 * time is small, and refused, in words, the day it is not.
 * ------------------------------------------------------------------------- */

export const ROW_CAP = 3000;

/** What a register's `load` is told to read. */
export type LoadScope = {
  /** The period as it travels in the URL, resolved to the screen's default when empty. */
  pd: string;
  window: DateWindow;
  ids: string[] | null;
  open: string | null;
};

/** A register's declaration: which date it is cut by, and what it opens on. */
export type ScreenWindow = {
  /** The column the window is on, as the screen calls it ("Order date"). */
  label: string;
  default: PeriodPreset;
};

export function scopeFor(win: ScreenWindow | undefined, query: Pick<ListQuery, "pd" | "ids">, open: string | null, day: string = calendarDate(new Date())): LoadScope {
  const pd = query.pd || win?.default || "all";
  return { pd, window: win ? periodWindow(pd, day) : { from: null, to: null }, ids: query.ids, open };
}

/**
 * What `load(ctx)` with NO scope reads: the whole register, still under the
 * cap. Every request path passes a scope (`scopeFor`), so this is what a test
 * or a one-off tool gets — never a page.
 */
export function unscoped(): LoadScope {
  return { pd: "all", window: { from: null, to: null }, ids: null, open: null };
}

/**
 * The SQL condition a register reads under: inside the window, or one of the
 * records asked for by id. `day` is the row's date expression, `id` its key.
 */
export function windowWhere(day: SQL, id: SQL, s: LoadScope): SQL {
  if (s.ids?.length) return sql`${id} in ${s.ids}`;
  const parts: SQL[] = [];
  if (s.window.from) parts.push(sql`${day} >= ${s.window.from}::date`);
  if (s.window.to) parts.push(sql`${day} <= ${s.window.to}::date`);
  const inside = parts.length ? sql.join(parts, sql` and `) : sql`true`;
  return s.open ? sql`((${inside}) or ${id} = ${s.open})` : sql`(${inside})`;
}

/** Whether `n` rows is more than one load may build. Ids are what somebody asked for, so they are never refused. */
export function tooWide(n: number, s: LoadScope): { n: number; cap: number } | null {
  return !s.ids?.length && n > ROW_CAP ? { n, cap: ROW_CAP } : null;
}

export function windowInfo(win: ScreenWindow, s: LoadScope, wide: { n: number; cap: number } | null) {
  return { pd: s.pd, label: periodLabel(s.pd), dateLabel: win.label, tooWide: wide };
}

/**
 * `windowWhere`'s rule for rows already summed in SQL — a stock screen's lots,
 * one per lot and godown, each with its date and the row id it is drawn under.
 */
export function inWindow(day: string | null, id: string, s: LoadScope): boolean {
  if (s.ids?.length) return s.ids.includes(id);
  if (s.open === id) return true;
  if (!day) return !s.window.from && !s.window.to;
  return (!s.window.from || day >= s.window.from) && (!s.window.to || day <= s.window.to);
}

/**
 * A stock screen's window: the date of each lot's latest movement, opening on
 * all time. A healthy book has a few hundred lots in stock and reads in full;
 * one whose stock has never been drawn down — history imported before its
 * dispatches — holds every lot ever made, and is asked for a narrower period
 * rather than built whole.
 */
export const STOCK_WINDOW: ScreenWindow = { label: "Lot date", default: "all" };
