/* ---------------------------------------------------------------------------
 * THE QUOTATION MANAGER'S RULES — pure and client-safe, because the grid
 * checks a value as it is typed and the server checks it again before it is
 * written, and the two must agree.
 *
 * A sheet is rows (a date and a party) by columns (pack, material, brand — or
 * a text column such as the broker). A cell holds what was typed and, as on
 * the desk's own sheet, a colour that says what became of it.
 * ------------------------------------------------------------------------- */

export const QUOTE_STATUSES = ["ready", "po", "cancel", "pickup"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** The sheet's own legend, word for word. */
export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  ready: "Ready to buy",
  po: "PO made in Tally & PO mailed",
  cancel: "PO / order cancelled",
  pickup: "Material picked up by transporter",
};

export const QUOTE_STATUS_SHORT: Record<QuoteStatus, string> = {
  ready: "Ready to buy",
  po: "PO made",
  cancel: "Cancelled",
  pickup: "Picked up",
};

export type QuoteColumnKind = "rate" | "text";

export const MAX_CELL_CHARS = 200;
export const MAX_HEADER_CHARS = 80;
export const MAX_PARTY_CHARS = 200;
export const MAX_OPS = 5000;

/** The marks a whole row (its date and party) may carry. Ready to buy is a rate's, never a row's. */
export const ROW_STATUSES: readonly QuoteStatus[] = ["po", "cancel", "pickup"];

export const MAX_PO_CHARS = 40;
export const MAX_DRUMS = 100000;

/**
 * THE BUYING RULE. A rate is chosen by a manager — marked Ready to buy, grey
 * — and only then bought by the team: Purchase it records the number of
 * drums and the PO number, and the cell turns yellow. So:
 *
 * - putting a cell into Ready to buy, or taking it out (other than by buying
 *   it), is a manager's;
 * - a cell is bought only from Ready to buy (or re-saved while bought), unless
 *   a manager does it, and never without drums and a PO number;
 * - a bought cell may go back to Ready to buy by anybody — that is undoing a
 *   purchase entered by mistake — but anything else is a manager's.
 *
 * Null where the change is allowed, else the sentence that refuses it.
 */
export function quoteStatusRefusal(
  prev: QuoteStatus | null,
  next: { status: QuoteStatus | null; drums: number | null; poNo: string | null },
  manager: boolean,
): string | null {
  const to = next.status;
  if (to === "po") {
    if (!next.drums || next.drums < 1) return "Say how many drums are being bought.";
    if (next.drums > MAX_DRUMS || !Number.isInteger(next.drums)) return "The number of drums must be a whole number.";
    if (!next.poNo || !next.poNo.trim()) return "Give the PO number.";
    if (prev !== "ready" && prev !== "po" && !manager) return "Only a rate marked Ready to buy can be bought. Ask a manager to mark it.";
    return null;
  }
  if (to === prev) return null;
  if (to === "ready" && prev === "po") return null;
  if (to === "ready" || prev === "ready") return manager ? null : "Only a manager or an administrator marks a rate Ready to buy, or takes the mark off.";
  if (prev === "po") return manager ? null : "Only a manager or an administrator changes a bought rate. To undo a purchase, put it back to Ready to buy.";
  return null;
}

export function isQuoteStatus(v: unknown): v is QuoteStatus {
  return typeof v === "string" && (QUOTE_STATUSES as readonly string[]).includes(v);
}

/** Ids are minted on the screen so a paste can create rows before the server answers. */
export function validQuoteId(prefix: "eqr" | "eqc", id: unknown): id is string {
  return typeof id === "string" && new RegExp(`^${prefix}_[a-z0-9_]{6,40}$`).test(id);
}

export function newQuoteId(prefix: "eqr" | "eqc"): string {
  const r = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  return `${prefix}_${Date.now().toString(36)}${r}`;
}

/**
 * What a rate cell may hold: empty, or a number. Commas, a rupee sign and
 * spaces are what people paste from a sheet, so they are taken out; anything
 * else is refused rather than stored as a rate nobody can compare.
 */
export function cleanRate(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  if (v === "") return { ok: true, value: "" };
  if (!/^-?\d+(\.\d+)?$/.test(v) && !/^-?\.\d+$/.test(v)) return { ok: false, error: `“${raw.trim()}” is not a number.` };
  return { ok: true, value: v.startsWith(".") ? `0${v}` : v.startsWith("-.") ? `-0${v.slice(1)}` : v };
}

export function cleanCell(kind: QuoteColumnKind, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  if (kind === "rate") return cleanRate(raw);
  const v = raw.replace(/\s+/g, " ").trim();
  if (v.length > MAX_CELL_CHARS) return { ok: false, error: `A cell holds at most ${MAX_CELL_CHARS} characters.` };
  return { ok: true, value: v };
}

export function rateNumber(v: string): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A date as somebody types or pastes it: `2026-10-14`, `22-Aug-2026`,
 * `22 Aug 26`, `14/10/2026`. Slashes are read DAY first, as India writes
 * them, unless the first number cannot be a month's day order (`10/14/2026`
 * is October 14, which is how Google Sheets renders a real date). Null where
 * it cannot be read — never a guess dressed as a date.
 */
export function parseQuoteDate(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\s\-/.]+([a-z]{3,9})[\s\-/.,]+(\d{2,4})$/.exec(s);
  if (m) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3));
    if (mon < 0) return null;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return iso(y, mon + 1, +m[1]);
  }
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (b > 12 && a <= 12) return iso(y, a, b);
    return iso(y, b, a);
  }
  return null;
}

/** Tab-separated text, as Excel and Google Sheets copy a block of cells. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const t = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export type QuoteCellLike = { value: string; status: QuoteStatus | null };
export type QuoteRowLike = { id: string; date: string; status: QuoteStatus | null; cells: Record<string, QuoteCellLike | undefined> };

export type QuoteColumnStats = { latest: string | null; latestDate: string | null; lowest: number | null; highest: number | null; count: number };

/**
 * The latest and the lowest rate in a column, over the rows given. A
 * cancelled cell — or a cell on a cancelled row — is a rate nobody bought at,
 * so it counts for neither.
 */
export function columnStats(rows: QuoteRowLike[], columnId: string): QuoteColumnStats {
  let latest: string | null = null;
  let latestDate: string | null = null;
  let lowest: number | null = null;
  let highest: number | null = null;
  let count = 0;
  for (const r of rows) {
    const c = r.cells[columnId];
    if (!c || r.status === "cancel" || c.status === "cancel") continue;
    const n = rateNumber(c.value);
    if (n == null) continue;
    count++;
    if (latestDate == null || r.date >= latestDate) {
      latestDate = r.date;
      latest = c.value;
    }
    if (lowest == null || n < lowest) lowest = n;
    if (highest == null || n > highest) highest = n;
  }
  return { latest, latestDate, lowest, highest, count };
}

/** Rows by date, then in the order they were entered, as the sheet reads. */
export function sortQuoteRows<T extends { date: string; seq: number }>(rows: T[], dir: "asc" | "desc" = "asc"): T[] {
  const k = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => (a.date < b.date ? -k : a.date > b.date ? k : (a.seq - b.seq) * k));
}
