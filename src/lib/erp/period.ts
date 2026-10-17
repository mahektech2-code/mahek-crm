/* ---------------------------------------------------------------------------
 * THE WINDOW A REGISTER IS READ THROUGH.
 *
 * A register — every order line, every SFG batch, every purchase — grows by
 * hundreds of rows a month and never shrinks. Read whole, it is every row
 * there has ever been, built into objects to draw twenty-five of them: 22,154
 * order lines took the server past its heap and the whole suite answered 502.
 * So a register is CUT BY DATE IN SQL, the way the bills ledger has always been
 * cut by financial year, and only what falls inside the window is ever built.
 * The search, the chips, the sort and the pager work inside it unchanged.
 *
 * The period travels in the URL as `pd`: a preset key, `c:<from>:<to>` for a
 * range somebody chose, or `all`. Empty means the screen's own default.
 *
 * PURE and client-safe: the picker in the browser and the page on the server
 * read a period with the same function, so the label on the button and the
 * rows under it cannot describe two different windows.
 * ------------------------------------------------------------------------- */

export const PERIODS = [
  { k: "7d", l: "Last 7 days" },
  { k: "30d", l: "Last 30 days" },
  { k: "month", l: "This month" },
  { k: "lastMonth", l: "Last month" },
  { k: "90d", l: "Last 3 months" },
  { k: "fy", l: "This financial year" },
  { k: "lastFy", l: "Last financial year" },
  { k: "all", l: "All time" },
] as const;

export type PeriodPreset = (typeof PERIODS)[number]["k"];

/** A window: both ends inclusive, as `YYYY-MM-DD`. Null ends mean unbounded. */
export type DateWindow = { from: string | null; to: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `iso` plus `days`, on the calendar — no clock, so no zone. */
export function shiftDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function lastOfMonth(y: number, m: number): string {
  return iso(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}

/** The financial year a day falls in, April to March — Mahek's own bill numbers carry it (MMI/26-27/…). */
function fyStart(day: string): number {
  const [y, m] = day.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

/** A custom range as it travels in the URL, or null where it is not one. */
export function customRange(pd: string): DateWindow | null {
  const m = /^c:([\d-]*):([\d-]*)$/.exec(pd);
  if (!m) return null;
  const from = ISO.test(m[1]) ? m[1] : null;
  const to = ISO.test(m[2]) ? m[2] : null;
  if (!from && !to) return null;
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

export function customKey(w: DateWindow): string {
  return `c:${w.from ?? ""}:${w.to ?? ""}`;
}

/** Whether `pd` names a window this module can read: a preset, a custom range, or nothing (the default). */
export function validPeriod(pd: string): boolean {
  return pd === "" || PERIODS.some((p) => p.k === pd) || customRange(pd) !== null;
}

/** The dates a period covers on `today`. `all` is both ends open. */
export function periodWindow(pd: string, today: string): DateWindow {
  const custom = customRange(pd);
  if (custom) return custom;
  const [y, m] = today.split("-").map(Number);
  switch (pd as PeriodPreset) {
    case "7d":
      return { from: shiftDays(today, -6), to: today };
    case "30d":
      return { from: shiftDays(today, -29), to: today };
    case "90d":
      return { from: shiftDays(today, -89), to: today };
    case "month":
      return { from: iso(y, m, 1), to: lastOfMonth(y, m) };
    case "lastMonth": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: iso(py, pm, 1), to: lastOfMonth(py, pm) };
    }
    case "fy": {
      const s = fyStart(today);
      return { from: iso(s, 4, 1), to: iso(s + 1, 3, 31) };
    }
    case "lastFy": {
      const s = fyStart(today) - 1;
      return { from: iso(s, 4, 1), to: iso(s + 1, 3, 31) };
    }
    case "all":
      return { from: null, to: null };
  }
  return { from: null, to: null };
}

const fmt = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return `${dd} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
};

/** What the period button says: the preset's name, or the range written out. */
export function periodLabel(pd: string): string {
  const preset = PERIODS.find((p) => p.k === pd);
  if (preset) return preset.l;
  const c = customRange(pd);
  if (!c) return "All time";
  if (c.from && c.to) return c.from === c.to ? fmt(c.from) : `${fmt(c.from)} – ${fmt(c.to)}`;
  return c.from ? `From ${fmt(c.from)}` : `Up to ${fmt(c.to!)}`;
}
