/* ---------------------------------------------------------------------------
 * The "ALL OUTSTANDING BILLS" workbook, as cells.
 *
 * This is NOT Tally's Receivables report — that one is a printed report read
 * positionally, it lists only what is owed, and `receivables-parse.ts` reads
 * it. This is a flat, hand-maintained sheet with a row per bill and a heading
 * row, and it speaks about settled bills as well as open ones:
 *
 *   Bill Number | Customer Name | Bill Total Amount | Bill Outstanding Amount
 *               | Status | Date | Reason
 *
 * The column that needs explaining is `Bill Outstanding Amount`, because it is
 * NOT the live balance. It is what was outstanding, and `Status` says what
 * became of it:
 *
 *   Pending  the money is still owed, and the figure is the debt.
 *   Paid     it has since been settled, and the figure is what was settled.
 *            `Reason` says how — a transfer, a credit note, an adjustment —
 *            which is why a `Paid` row carries a figure at all rather than a
 *            zero. Reading it as debt would put Rs 33 lakh of already-settled
 *            money onto the collections worklist.
 *
 * A BLANK status is neither, and it is not guessed at. 72 rows across three
 * customers were left unfilled; a blank cell is nobody stating a position, and
 * inferring "unpaid" from the outstanding figure happening to equal the bill
 * total is exactly the assumption that put the whole order book on the
 * worklist once already. They are returned in `unstated` so the run can report
 * them and write nothing.
 *
 * Pure: cells in, rows out, no database and no clock. What the numbers MEAN to
 * the ledger is decided in the service.
 * ------------------------------------------------------------------------- */

export type OutstandingRow = {
  billNo: string;
  customer: string;
  /** What the bill was raised for, in paise. */
  amountPaise: number;
  /**
   * Still owed after this sheet, in paise. Zero on a `Paid` row — the figure
   * in the outstanding column there describes money that has already gone.
   */
  owedPaise: number;
  /** What the outstanding column actually said, kept for the report. */
  statedPaise: number;
  status: "paid" | "pending";
  /** "CN", "Adjusted", "Transfred", "Pending" — free text, reported not parsed. */
  reason: string;
  /** ISO, or null where the cell is blank or unreadable. */
  date: string | null;
  /** The row's line in the sheet, so a problem can be looked up. */
  line: number;
};

/** A row whose Status cell is empty: reported, never applied. */
export type OutstandingUnstated = {
  billNo: string;
  customer: string;
  amountPaise: number;
  statedPaise: number;
  line: number;
};

export type ParsedOutstanding = {
  rows: OutstandingRow[];
  unstated: OutstandingUnstated[];
  /** Lines that looked like data and could not be read. */
  problems: string[];
};

/** "5,210.50" → 521050 paise. Rounded, because paise are integers. */
export function parseRupeesPaise(raw: string): number | null {
  const cleaned = String(raw ?? "").replace(/[,\s₹]/g, "");
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * The Date column, which arrives in three spellings at once.
 *
 * Excel hands back a serial where the cell was a real date ("46328"), text
 * where somebody typed one ("22/02/2026", "25/2/2026"), and occasionally a
 * fragment that is neither ("21"). Day-first is the convention here, and a
 * value that cannot be read answers null rather than being coerced — this date
 * only ever becomes a receipt's `received_at`, and a wrong one is worse than a
 * missing one that falls back to the day of the run.
 *
 * The serial is Excel's own day count from 1899-12-30, converted in UTC
 * deliberately: it is a date with no time and no zone in it, so naming a local
 * zone would introduce an offset the value never carried.
 */
export function parseSheetDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    const day = Number(d);
    const month = Number(m);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // An Excel serial. Below 10000 it is a fragment rather than a date — 21 is
  // January 1900, which nothing in this book can mean.
  if (/^\d+(\.0+)?$/.test(s)) {
    const serial = Number(s);
    if (serial < 10000 || serial > 80000) return null;
    const at = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    // Read back with `getUTC*` rather than `toISOString().slice(0, 10)`. Same
    // answer, but it NAMES the zone it reads in, which is what §11 greps `src/`
    // for — a day sliced off an ISO string is a bare `::date` in different
    // clothes, and it is wrong on every machine equally, so it never looks like
    // a timezone bug. Here UTC is not a default but the only reading that adds
    // no offset: the serial is a day count carrying no time and no zone at all.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  }

  return null;
}

const HEADING = "bill number";

export function parseOutstanding(cells: string[][]): ParsedOutstanding {
  const rows: OutstandingRow[] = [];
  const unstated: OutstandingUnstated[] = [];
  const problems: string[] = [];

  for (const [i, raw] of cells.entries()) {
    const line = i + 1;
    const c = Array.from({ length: 7 }, (_, k) => String(raw[k] ?? "").trim());
    const [billNo, customer, amount, outstanding, statusCell, dateCell, reason] = c;

    if (!billNo) continue;
    if (billNo.toLowerCase() === HEADING) continue;

    const amountPaise = parseRupeesPaise(amount);
    const statedPaise = parseRupeesPaise(outstanding);
    if (amountPaise === null || statedPaise === null) {
      problems.push(`line ${line}: ${billNo} — could not read "${amount}" / "${outstanding}"`);
      continue;
    }
    if (amountPaise <= 0) {
      problems.push(`line ${line}: ${billNo} — bill total is ${amount}`);
      continue;
    }
    if (statedPaise < 0) {
      problems.push(`line ${line}: ${billNo} — outstanding is negative (${outstanding})`);
      continue;
    }
    if (statedPaise > amountPaise) {
      problems.push(
        `line ${line}: ${billNo} — outstanding ${outstanding} exceeds the bill total ${amount}`,
      );
      continue;
    }

    const status = statusCell.toLowerCase();

    if (!status) {
      unstated.push({ billNo, customer, amountPaise, statedPaise, line });
      continue;
    }
    if (status !== "paid" && status !== "pending") {
      problems.push(`line ${line}: ${billNo} — unknown status "${statusCell}"`);
      continue;
    }

    rows.push({
      billNo,
      customer,
      amountPaise,
      // A `Paid` row owes nothing: its figure is what was settled, not what is
      // left. This single line is the whole reading of the sheet.
      owedPaise: status === "paid" ? 0 : statedPaise,
      statedPaise,
      status,
      reason,
      date: parseSheetDate(dateCell),
      line,
    });
  }

  return { rows, unstated, problems };
}

/**
 * How a bill was closed, as one of this app's own payment modes.
 *
 * `payments.modes` already carries `Credit note` and `Adjustment` precisely
 * because neither is money arriving, and both close a bill exactly the way a
 * transfer does. Recording all three as a bank transfer would put Rs 6 lakh of
 * credit notes into the ledger as cash nobody can find in the statement.
 */
export function modeForReason(reason: string): string {
  const r = reason.trim().toLowerCase();
  if (r === "cn") return "Credit note";
  if (r === "adjusted") return "Adjustment";
  return "Bank transfer";
}
