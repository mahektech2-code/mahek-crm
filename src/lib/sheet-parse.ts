import type { SheetRowIssue } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * Reading the Order Details tab. PURE — no I/O, no clock, no database.
 *
 * The governing rule is that this never fails and never guesses. Every cell it
 * cannot read becomes a null plus an issue naming the column and quoting what
 * was actually there; the row still imports. A spreadsheet maintained by hand
 * for years has bad cells in it, and losing the other fifty-four columns of a
 * row because one of them holds a typo is a worse outcome than holding the
 * row and saying which cell is wrong.
 *
 * An issue is a note for whoever fixes the sheet. It is not a rejection, and
 * nothing downstream may treat it as one.
 * ------------------------------------------------------------------------- */

/**
 * The sheet's own header text, normalised for whitespace only.
 *
 * Two of these carry a trailing newline in the sheet and two have a double
 * space inside them; readTab() collapses whitespace before the lookup, so the
 * names here are the collapsed form. They are otherwise the sheet's spelling,
 * misspellings and all — this is a foreign key to somebody else's document,
 * not a place to tidy up.
 */
export const COL = {
  orderNumber: "Order Number",
  /** Unique per LINE. The idempotency key: a re-import updates in place. */
  lineKey: "Order ID",
  orderDate: "Order Date",
  billingPartyName: "Billing Party Name",
  description: "Description Of Goods",
  /** Not displayed, but part of what identifies the product. See below. */
  canSize: "Can Size.",
  cans: "Order qty No. Of can",
  litres: "Quantity Dispatch in Liter",
  packType: "Type",
  rate: "Rate",
  paymentStatus: "Payment Status",
  paymentReceivedDate: "Payment Received Date",
  area: "Area",
  gst: "GST",
  amount: "Amount",
  transportName: "Transport Name",
  discount: "Discount",
  finalAmount: "Final Amount",
  dispatchDate: "Dispatch Date",
  tallyBillNo: "Tally Bill No.",
  orderFulfillDays: "Order Fulfill Days",
  creditDays: "Credit Days",
  paymentType: "Payment type",
  segmentCounterType: "Segment Counter type",
  salesMan: "Sales Man",
} as const;

/** The columns shown on screen — the client's list, in their order. */
export const DISPLAY_COLUMNS: readonly string[] = [
  COL.orderNumber,
  COL.orderDate,
  COL.billingPartyName,
  COL.description,
  COL.cans,
  COL.litres,
  COL.packType,
  COL.rate,
  COL.paymentStatus,
  COL.paymentReceivedDate,
  COL.area,
  COL.gst,
  COL.amount,
  COL.transportName,
  COL.discount,
  COL.finalAmount,
  COL.dispatchDate,
  COL.tallyBillNo,
  COL.orderFulfillDays,
  COL.creditDays,
  COL.paymentType,
  COL.segmentCounterType,
  COL.salesMan,
];

/**
 * Which of those repeat across every line of one order, and which belong to
 * the line. The sheet is flat, so an order of seven products is seven rows
 * with the order-level columns copied down.
 *
 * This distinction is not cosmetic: Amount and Final Amount are LINE-level, so
 * an order's value is the sum of its lines. Reading either as the order total
 * shows one line's figure and understates roughly half the orders here.
 */
export const LINE_LEVEL_COLUMNS: readonly string[] = [
  COL.description,
  COL.cans,
  COL.litres,
  COL.packType,
  COL.rate,
  COL.amount,
  COL.discount,
  COL.finalAmount,
  COL.tallyBillNo,
];

export const isLineLevel = (column: string) => LINE_LEVEL_COLUMNS.includes(column);

/* ------------------------------------------------------------- primitives */

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The sheet's dates, in the two forms it actually uses.
 *
 *   `1-Apr-2024`   — a named month, unambiguous
 *   `31/01/2026`   — numeric, and DAY-FIRST
 *
 * The second one is the one to be careful about, because reading it wrongly
 * does not fail: `04/02/2026` is a perfectly good date under either rule and
 * lands two months apart depending on which you pick. Guessing would silently
 * move thousands of orders into the wrong month and every total built on them.
 *
 * So it was not guessed. Across the 19,912 numeric dates in this document,
 * 12,276 have a first component above 12 and NOT ONE has a second component
 * above 12 — impossible unless the first is the day. Day-first is also what
 * India writes, which is the weaker of the two arguments and worth stating
 * second.
 *
 * A value that fits neither shape returns null and is reported. It is never
 * coerced: an unreadable date is a cell somebody should look at, not a date to
 * invent.
 */
export function parseSheetDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const named = value.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    if (month < 0) return null;
    const day = Number(named[1]);
    if (day < 1 || day > 31) return null;
    return iso(Number(named[3]), month + 1, day);
  }

  const numeric = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    // A month above 12 would mean this row is month-first while the rest of
    // the file is day-first. That is not a date to rescue by swapping — it is
    // a contradiction worth surfacing.
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return iso(Number(numeric[3]), month, day);
  }

  return null;
}

/**
 * `13,440.00` → 1344000 paise.
 *
 * Money is whole paise everywhere in MahekOne, so the rounding happens once,
 * here, on the way in. Amount carries two decimals and Final Amount carries
 * none, which means Final has already been rounded in the sheet — rounding it
 * again would be rounding twice, so this rounds the paise value and not the
 * rupee one.
 */
export function parseMoneyPaise(raw: string): number | null {
  const value = raw.trim().replace(/[,\s₹]/g, "");
  if (!value) return null;
  if (!/^-?\d*\.?\d+$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

/**
 * `18` → 1800, `2.5` → 250. Basis points, so a percentage is never a float.
 *
 * Both GST and Discount in this sheet are percentages. Discount especially:
 * blank on most rows and holding values like 5 and 2.5, it reads as a rupee
 * amount to anyone glancing at a column of rupee figures beside it.
 */
export function parsePercentBp(raw: string): number | null {
  const value = raw.trim().replace(/[%\s]/g, "");
  if (!value) return null;
  if (!/^-?\d*\.?\d+$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

/** `12.50` litres → 12500 ml, so volumes stay integers through a pack change. */
export function parseVolumeMl(raw: string): number | null {
  const value = raw.trim().replace(/[,\s]/g, "");
  if (!value) return null;
  if (!/^-?\d*\.?\d+$/.test(value)) return null;
  return Math.round(Number(value) * 1000);
}

export function parseWholeNumber(raw: string): number | null {
  const value = raw.trim().replace(/[,\s]/g, "");
  if (!value) return null;
  if (!/^-?\d+$/.test(value)) return null;
  return Number(value);
}

/* ------------------------------------------------------------------ a row */

export type ParsedOrderRow = {
  lineKey: string;
  orderNumber: string | null;

  orderDate: string | null;
  dispatchDate: string | null;
  paymentReceivedDate: string | null;
  billingPartyName: string | null;
  area: string | null;
  transportName: string | null;
  paymentType: string | null;
  paymentStatus: string | null;
  segmentCounterType: string | null;
  salesMan: string | null;
  creditDays: number | null;
  orderFulfillDays: number | null;
  gstBp: number | null;

  description: string | null;
  packType: string | null;
  cans: number | null;
  volumeMl: number | null;
  ratePaise: number | null;
  amountPaise: number | null;
  finalAmountPaise: number | null;
  discountBp: number | null;
  tallyBillNo: string | null;

  issues: SheetRowIssue[];
};

const text = (cells: Record<string, string>, column: string): string | null => {
  const v = (cells[column] ?? "").trim();
  return v === "" ? null : v;
};

/**
 * Read one sheet row.
 *
 * Blank is not an issue — `Payment Status` is empty on every row of this
 * sheet, and reporting ninety-nine issues for a column nobody fills would bury
 * the four that matter. An issue is raised only when a cell HOLDS something
 * that could not be read, which is the case worth a person's attention.
 */
export function parseOrderRow(cells: Record<string, string>): ParsedOrderRow {
  const issues: SheetRowIssue[] = [];

  const readWith = <T>(
    column: string,
    parse: (raw: string) => T | null,
    expected: string,
  ): T | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const parsed = parse(raw);
    if (parsed === null) {
      issues.push({ column, value: raw, problem: `could not be read as ${expected}` });
    }
    return parsed;
  };

  const row: ParsedOrderRow = {
    lineKey: (cells[COL.lineKey] ?? "").trim(),
    orderNumber: text(cells, COL.orderNumber),

    orderDate: readWith(COL.orderDate, parseSheetDate, "a date"),
    dispatchDate: readWith(COL.dispatchDate, parseSheetDate, "a date"),
    paymentReceivedDate: readWith(COL.paymentReceivedDate, parseSheetDate, "a date"),
    billingPartyName: text(cells, COL.billingPartyName),
    area: text(cells, COL.area),
    transportName: text(cells, COL.transportName),
    paymentType: text(cells, COL.paymentType),
    paymentStatus: text(cells, COL.paymentStatus),
    segmentCounterType: text(cells, COL.segmentCounterType),
    salesMan: text(cells, COL.salesMan),
    creditDays: readWith(COL.creditDays, parseWholeNumber, "a whole number of days"),
    orderFulfillDays: readWith(COL.orderFulfillDays, parseWholeNumber, "a whole number"),
    gstBp: readWith(COL.gst, parsePercentBp, "a percentage"),

    description: text(cells, COL.description),
    packType: text(cells, COL.packType),
    cans: readWith(COL.cans, parseWholeNumber, "a whole number of cans"),
    volumeMl: readWith(COL.litres, parseVolumeMl, "a quantity in litres"),
    ratePaise: readWith(COL.rate, parseMoneyPaise, "an amount"),
    amountPaise: readWith(COL.amount, parseMoneyPaise, "an amount"),
    finalAmountPaise: readWith(COL.finalAmount, parseMoneyPaise, "an amount"),
    discountBp: readWith(COL.discount, parsePercentBp, "a percentage"),
    tallyBillNo: text(cells, COL.tallyBillNo),

    // Filled in below: the cross-column checks need the parsed row to run.
    issues: [],
  };

  if (!row.lineKey) {
    issues.push({
      column: COL.lineKey,
      value: "",
      problem: "no line identifier — the row cannot be matched on a re-import",
    });
  }

  issues.push(...checkArithmetic(row, cells));
  row.issues = issues;
  return row;
}

/**
 * Cells that parsed cleanly but disagree with each other.
 *
 * These are the sheet's own errors rather than ours, and they are worth
 * surfacing precisely because every other row reconciles: a column that is
 * right ninety-eight times and wrong once is trusted, and the wrong one is
 * what ends up on somebody's screen as a fact.
 */
function checkArithmetic(
  row: ParsedOrderRow,
  cells: Record<string, string>,
): SheetRowIssue[] {
  const issues: SheetRowIssue[] = [];
  const rupees = (paise: number) => (paise / 100).toFixed(2);

  // Final Amount should follow from Amount, the discount and the GST.
  if (row.amountPaise !== null && row.finalAmountPaise !== null && row.gstBp !== null) {
    const discounted = row.amountPaise * (1 - (row.discountBp ?? 0) / 10_000);
    const expected = discounted * (1 + row.gstBp / 10_000);
    // A rupee and a half of slack: the sheet rounds Final Amount to whole
    // rupees, so an exact comparison would flag every second row.
    if (Math.abs(expected - row.finalAmountPaise) > 150) {
      issues.push({
        column: COL.finalAmount,
        value: cells[COL.finalAmount] ?? "",
        problem:
          `does not follow from Amount ${rupees(row.amountPaise)}` +
          ` with ${(row.gstBp / 100).toFixed(0)}% GST` +
          (row.discountBp ? ` and ${(row.discountBp / 100).toFixed(1)}% discount` : "") +
          ` — expected about ${rupees(Math.round(expected))}`,
      });
    }
  }

  // What Rate is per depends on Type, and the sheet is entirely consistent
  // about it: a Can is priced per can, a Drum per litre. Reading Rate as one
  // basis for both is wrong by a factor of the pack size — a 200 L drum at
  // ₹50 is ₹10,000, not ₹50 — so the multiplier follows the Type.
  if (row.ratePaise !== null && row.amountPaise !== null) {
    const perLitre = row.packType?.toLowerCase().startsWith("drum") ?? false;
    const units = perLitre
      ? row.volumeMl === null
        ? null
        : row.volumeMl / 1000
      : row.cans;

    if (units !== null) {
      const expected = row.ratePaise * units;
      if (Math.abs(expected - row.amountPaise) > 100) {
        issues.push({
          column: COL.amount,
          value: cells[COL.amount] ?? "",
          problem:
            `Rate ${rupees(row.ratePaise)} x ${units} ` +
            `${perLitre ? "litres" : "cans"} is ${rupees(expected)}, ` +
            `not ${rupees(row.amountPaise)}`,
        });
      }
    }
  }

  // Litres are Cans x Can Size — derived, not independent. Where the sheet
  // disagrees with its own multiplication, the quantity is not trustworthy.
  const canSize = parseVolumeMl(cells[COL.canSize] ?? "");
  if (canSize !== null && row.cans !== null && row.volumeMl !== null) {
    const expected = canSize * row.cans;
    if (Math.abs(expected - row.volumeMl) > 10) {
      issues.push({
        column: COL.litres,
        value: cells[COL.litres] ?? "",
        problem:
          `${row.cans} cans of ${(canSize / 1000).toFixed(2)} L is ` +
          `${(expected / 1000).toFixed(2)} L, not ${(row.volumeMl / 1000).toFixed(2)} L`,
      });
    }
  }

  return issues;
}

/* ------------------------------------------------- the Payment Status tab */

/**
 * The Payment Status tab's headers, as the sheet spells them.
 *
 * Note `Dispatch Date` carries a double space in this tab too, which readTab
 * collapses before the lookup — the same normalisation the order tab needs.
 */
export const PAY_COL = {
  orderNumber: "Order Number",
  billingPartyName: "Billing Party Name",
  dispatchDate: "Dispatch Date",
  tallyBillNo: "Tally Bill No.",
  billAmount: "Bill Amount",
  dueDate: "Due Date",
  paymentStatus: "Payment Status",
  paymentReceivedDate: "Payment Received Date",
  messageDate: "Message Date",
  nextMessageDate: "Next Message Date",
  backOffice: "Back Office",
} as const;

export type ParsedPaymentRow = {
  orderNumber: string;
  billingPartyName: string | null;
  tallyBillNo: string | null;
  dispatchDate: string | null;
  billAmountPaise: number | null;
  dueDate: string | null;
  paymentStatus: string | null;
  paymentReceivedDate: string | null;
  messageDate: string | null;
  nextMessageDate: string | null;
  backOffice: string | null;
  issues: SheetRowIssue[];
};

/**
 * Read one row of the Payment Status tab.
 *
 * `Bill Amount` is written in whole RUPEES here, unlike the order tab's
 * two-decimal figures — so it is multiplied to paise once, on the way in, and
 * never again. Getting that wrong by a factor of a hundred is the kind of
 * error that looks plausible on every screen it reaches.
 */
export function parsePaymentRow(cells: Record<string, string>): ParsedPaymentRow {
  const issues: SheetRowIssue[] = [];

  const readWith = <T>(
    column: string,
    parse: (raw: string) => T | null,
    expected: string,
  ): T | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const parsed = parse(raw);
    if (parsed === null) {
      issues.push({ column, value: raw, problem: `could not be read as ${expected}` });
    }
    return parsed;
  };

  const status = text(cells, PAY_COL.paymentStatus);
  const received = readWith(PAY_COL.paymentReceivedDate, parseSheetDate, "a date");

  const row: ParsedPaymentRow = {
    orderNumber: (cells[PAY_COL.orderNumber] ?? "").trim(),
    billingPartyName: text(cells, PAY_COL.billingPartyName),
    tallyBillNo: text(cells, PAY_COL.tallyBillNo),
    dispatchDate: readWith(PAY_COL.dispatchDate, parseSheetDate, "a date"),
    billAmountPaise: readWith(PAY_COL.billAmount, parseRupeesToPaise, "an amount"),
    dueDate: readWith(PAY_COL.dueDate, parseSheetDate, "a date"),
    paymentStatus: status,
    paymentReceivedDate: received,
    messageDate: readWith(PAY_COL.messageDate, parseSheetDate, "a date"),
    nextMessageDate: readWith(PAY_COL.nextMessageDate, parseSheetDate, "a date"),
    backOffice: text(cells, PAY_COL.backOffice),
    issues: [],
  };

  // Marked received with no date. Worth surfacing rather than silently
  // choosing one: the money arrived, and when it arrived is what every ageing
  // and slow-payer calculation is built on.
  if (status?.toLowerCase() === "received" && !received) {
    issues.push({
      column: PAY_COL.paymentReceivedDate,
      value: "",
      problem: "marked Received with no date — the payment is known, its date is not",
    });
  }

  row.issues = issues;
  return row;
}

/** Whole rupees → paise. This tab writes `85184`, meaning ₹85,184. */
export function parseRupeesToPaise(raw: string): number | null {
  const value = raw.trim().replace(/[,\s₹]/g, "");
  if (!value) return null;
  if (!/^-?\d*\.?\d+$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

/** True when the sheet says the money arrived. */
export const isReceived = (status: string | null) =>
  (status ?? "").trim().toLowerCase() === "received";
