/* ---------------------------------------------------------------------------
 * WHAT THE QUOTATION MANAGER SAYS ABOUT A RATE, beside the table: the
 * cheapest rate in each column, the other parties' latest rates for the same
 * material, one party's recent quotes, the requirements waiting for a
 * column's raw material, and the figures of a selection. Pure and
 * client-safe, so the table, its side panel and its footer read one answer
 * and the rules are tested without a database.
 *
 * Everything here reads the rows the screen holds — the period and party
 * search the page was opened with — so "cheapest" means cheapest of what is
 * shown, never of rows the person cannot see. A cancelled rate (or a rate on a
 * cancelled row) is one nobody bought at, so it counts for none of it, as it
 * counts for neither figure in `columnStats`.
 * ------------------------------------------------------------------------- */

import { rateNumber, type QuoteStatus } from "./quotes";

export type PanelCell = { value: string; status: QuoteStatus | null };
export type PanelRow = { id: string; date: string; party: string; status: QuoteStatus | null; seq: number; cells: Record<string, PanelCell | undefined> };

/** A rate that counts: a number, on a row and in a cell neither of which is cancelled. */
function counted(r: PanelRow, columnId: string): number | null {
  const c = r.cells[columnId];
  if (!c || r.status === "cancel" || c.status === "cancel") return null;
  return rateNumber(c.value);
}

/** Later first: the newer date, then the row entered last. */
function later(a: PanelRow, b: PanelRow): boolean {
  return a.date > b.date || (a.date === b.date && a.seq > b.seq);
}

/**
 * The cheapest rate of each column over the rows given. A column with a
 * single rate has nothing to be cheapest against, so it has no cheapest —
 * the table would otherwise draw every lone rate green.
 */
export function cheapestByColumn(rows: PanelRow[], columnIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of columnIds) {
    let low: number | null = null;
    let count = 0;
    for (const r of rows) {
      const n = counted(r, id);
      if (n == null) continue;
      count++;
      if (low == null || n < low) low = n;
    }
    if (low != null && count > 1) out.set(id, low);
  }
  return out;
}

/** Whether `n` is the lowest rate the column was quoted at in the month of `day` (YYYY-MM-DD) — ties count. */
export function cheapestInMonth(rows: PanelRow[], columnId: string, n: number, day: string): boolean {
  const month = day.slice(0, 7);
  let low: number | null = null;
  let count = 0;
  for (const r of rows) {
    if (r.date.slice(0, 7) !== month) continue;
    const v = counted(r, columnId);
    if (v == null) continue;
    count++;
    if (low == null || v < low) low = v;
  }
  return count > 1 && low != null && n <= low;
}

export type PartyRate = { rowId: string; party: string; date: string; value: string; rate: number };

const partyKey = (p: string) => p.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Each party's LATEST rate for a column, cheapest first — what the desk
 * compares before it buys. A party's older quotes are not a second entry: the
 * latest is what they would sell at today. A row with no party is left out.
 */
export function latestByParty(rows: PanelRow[], columnId: string): PartyRate[] {
  const best = new Map<string, { row: PanelRow; rate: number }>();
  for (const r of rows) {
    const n = counted(r, columnId);
    if (n == null || !r.party.trim()) continue;
    const k = partyKey(r.party);
    const had = best.get(k);
    if (!had || later(r, had.row)) best.set(k, { row: r, rate: n });
  }
  return [...best.values()]
    .map(({ row, rate }) => ({ rowId: row.id, party: row.party, date: row.date, value: row.cells[columnId]!.value, rate }))
    .sort((a, b) => a.rate - b.rate || (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

/** One party's quotes for a column, oldest first, the last `limit` of them — the side panel's bars. */
export function partyHistory(rows: PanelRow[], columnId: string, party: string, limit = 6): PartyRate[] {
  const k = partyKey(party);
  if (!k) return [];
  const mine = rows.filter((r) => partyKey(r.party) === k && counted(r, columnId) != null).sort((a, b) => (later(a, b) ? 1 : later(b, a) ? -1 : 0));
  return mine.slice(-limit).map((r) => ({ rowId: r.id, party: r.party, date: r.date, value: r.cells[columnId]!.value, rate: counted(r, columnId)! }));
}

/** The requirements waiting for each column — those for the raw material the column is linked to. */
export function waitingByColumn<R extends { materialId: string }>(columns: { id: string; rawMaterialId: string | null }[], reqs: R[]): Map<string, R[]> {
  const byMaterial = new Map<string, R[]>();
  for (const r of reqs) byMaterial.set(r.materialId, [...(byMaterial.get(r.materialId) ?? []), r]);
  const out = new Map<string, R[]>();
  for (const c of columns) {
    const hit = c.rawMaterialId ? byMaterial.get(c.rawMaterialId) : undefined;
    if (hit?.length) out.set(c.id, hit);
  }
  return out;
}

/** What a heading's badge says: the one requirement waiting by number, or how many. */
export function waitingBadge(reqs: { reqNo: number | null }[]): string | null {
  if (!reqs.length) return null;
  if (reqs.length === 1) return reqs[0].reqNo ? `REQ-${reqs[0].reqNo} waiting` : "1 requirement waiting";
  return `${reqs.length} requirements waiting`;
}

export type SelectionFigures = { count: number; min: number | null; avg: number | null };

/** The rates among a selection's values: how many, the lowest and the average. Text and blanks are not rates. */
export function selectionFigures(values: string[]): SelectionFigures {
  let count = 0;
  let sum = 0;
  let min: number | null = null;
  for (const v of values) {
    const n = rateNumber(v);
    if (n == null) continue;
    count++;
    sum += n;
    if (min == null || n < min) min = n;
  }
  return { count, min, avg: count ? Math.round((sum / count) * 100) / 100 : null };
}

export type PackNet = { qty: number; unit: "Kg" | "Litre" };

/**
 * The net quantity in one pack, read off a heading's top line as the desk
 * writes it: "185/180 KGS NET" is 185 kg (the first figure, the larger
 * declared weight), "200 LITER" is 200 litres. Null where the line says
 * neither — never a guess.
 */
export function packNet(pack: string): PackNet | null {
  const m = /(\d+(?:\.\d+)?)(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(kgs?|kilo(?:gram)?s?|l|ltrs?|lit(?:re|er)s?)\b/i.exec(pack);
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return { qty, unit: /^k/i.test(m[2]) ? "Kg" : "Litre" };
}

/**
 * About how many packs a quantity is, where the pack's net is in the same
 * unit as the quantity — rounded up, because a part drum is still a drum.
 */
export function packsFor(qty: number, unit: string, pack: string): number | null {
  const net = packNet(pack);
  if (!net || !(qty > 0) || net.unit.toLowerCase() !== unit.trim().toLowerCase()) return null;
  return Math.ceil(qty / net.qty - 1e-9);
}

export type RowSort = "latest" | "oldest" | "party" | "cheapest";

/**
 * The rows in the order chosen on the toolbar. Latest first is the table's
 * own order (`visibleRows`); the others are a view of the same rows. Cheapest
 * first sorts by one column's rate, rows without a rate in it last, latest
 * first among equals.
 */
export function sortRows<T extends PanelRow>(rows: T[], by: RowSort, columnId?: string | null): T[] {
  const latest = (a: T, b: T) => (later(a, b) ? -1 : later(b, a) ? 1 : 0);
  if (by === "oldest") return [...rows].sort((a, b) => latest(b, a));
  if (by === "party") return [...rows].sort((a, b) => a.party.localeCompare(b.party, undefined, { sensitivity: "base" }) || latest(a, b));
  if (by === "cheapest" && columnId) {
    const rate = (r: T) => rateNumber(r.cells[columnId]?.value ?? "");
    return [...rows].sort((a, b) => {
      const x = rate(a);
      const y = rate(b);
      if (x == null && y == null) return latest(a, b);
      if (x == null) return 1;
      if (y == null) return -1;
      return x - y || latest(a, b);
    });
  }
  return [...rows].sort(latest);
}
