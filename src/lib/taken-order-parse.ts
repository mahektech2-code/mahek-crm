import type { SheetRowIssue } from "@/db/schema";
import { parseMoneyPaise, parsePercentBp, parseSheetDate, parseWholeNumber } from "./sheet-parse";

/* ---------------------------------------------------------------------------
 * Reading the Taken Order tab. PURE — no I/O, no clock, no database.
 *
 * This is where an order lands FIRST. The team types it here as the customer
 * gives it, hours or days before it becomes a dispatch, a Tally bill or a row
 * on the Order Details tab. That gap is the whole reason this tab is imported:
 * for as long as an order sits in it unfulfilled, the customer has already
 * ordered, and the Call Log must stop asking them to.
 *
 * Two cells decide that, and nothing else on the row does:
 *
 *   Status (column L)        Ready            → it has gone out
 *   Entry status (column R)  Done             → the office has finished with it
 *
 * BOTH must say so to release the customer; EITHER holds them. See
 * `isTakenOrderOpen`, which is the one place that rule is written.
 *
 * Same governing rule as the other sheet parsers: this never fails and never
 * guesses. A cell it cannot read becomes null plus an issue naming the column
 * and quoting what was there, and the row still imports.
 * ------------------------------------------------------------------------- */

/**
 * The tab's own header text, as the sheet spells it.
 *
 * Not the Order Details tab's spellings — this tab writes "Order number" with
 * a small n, "Order Qty No. Of Can" with capitals the other tab does not use,
 * and "Timpstamp", which is a typo in somebody's spreadsheet and therefore the
 * correct value here. These are foreign keys to somebody else's document, not
 * a place to tidy up.
 */
export const TAKEN_COL = {
  orderNumber: "Order number",
  location: "Location",
  orderDate: "Date",
  /** The customer. Confirmed with the client: billing, not delivery. */
  billingPartyName: "Billing Party Name",
  deliveryPartyName: "Delivery Party Name",
  standingInstructions: "Standing Instructions",
  area: "Area",
  transporterName: "Transporter name",
  description: "Description Of Goods",
  cans: "Order Qty No. Of Can",
  boxes: "Box Quantity",
  /** Column L. One half of the release rule. */
  officeStatus: "Status",
  rate: "Rate",
  discount: "Discount",
  tallyBillNo: "Tally Bill No.",
  transportationCost: "Transportation Cost",
  remark: "Remark",
  /** Column R. The other half. */
  entryStatus: "Entry status",
  partyStatus: "Party Status",
  userName: "User Name",
  /** Unique per LINE — ODID-09108D. The key the import is idempotent on. */
  lineKey: "Order ID",
  takenAt: "Timpstamp",
  weight: "Weight",
} as const;

/**
 * Where the two decisive columns sit if their headers are ever renamed.
 *
 * Zero-based, so 11 is column L and 17 is column R — which is how the client
 * identified them, and a spreadsheet's columns move far less often than the
 * words at the top of them. Header text still wins; this is only reached when
 * the expected text is absent, and it is reported when it is used.
 */
const FALLBACK_INDEX: Partial<Record<keyof typeof TAKEN_COL, number>> = {
  officeStatus: 11,
  entryStatus: 17,
};

export type TakenColumns = Record<keyof typeof TAKEN_COL, string | null>;

/**
 * Bind the logical fields to the headers this particular read came back with.
 *
 * A column whose header is missing AND has no positional fallback resolves to
 * null, and every reader below treats that as an empty cell rather than
 * throwing. A tab reorganised overnight degrades to blank fields and issues,
 * which somebody notices — it does not take the sync down.
 */
export function resolveTakenColumns(headers: string[]): TakenColumns {
  const present = new Set(headers);
  const out = {} as TakenColumns;

  for (const [field, header] of Object.entries(TAKEN_COL) as [
    keyof typeof TAKEN_COL,
    string,
  ][]) {
    if (present.has(header)) {
      out[field] = header;
      continue;
    }
    const index = FALLBACK_INDEX[field];
    out[field] = index !== undefined ? headers[index] ?? null : null;
  }

  return out;
}

/** Whitespace- and case-folded, which is how both status cells are compared. */
const fold = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** What column L says when the goods have left. */
export const DISPATCHED_STATUS = "ready";
/** What column R says when the office has finished with the row. */
export const COMPLETED_ENTRY_STATUS = "done";

/**
 * A cancelled line, which releases on its own.
 *
 * This one is not a variation on "dispatched" and must not be folded into the
 * unknown-holds-by-default rule, because a cancelled row is the one kind that
 * NEVER changes again. It will not become Ready tomorrow, so holding it holds
 * the customer for good — a permanent mute with no event left that could lift
 * it. There are 294 of them on the tab, and the customer behind a cancelled
 * order has not ordered anything: they are exactly who the Call Log should be
 * ringing.
 *
 * Entry status does not enter into it. Whether the office finished typing a
 * row is a question about paperwork; the order is cancelled either way.
 */
export const CANCELLED_STATUS = "cancel";

/**
 * The statuses seen on the tab that mean the order is still coming.
 *
 * Listed to be RECOGNISED, not to decide anything — the decision below holds
 * on anything it does not know, so adding a value here changes only whether a
 * note is raised about it. That is the point: this is the vocabulary we have
 * been shown, and a value outside it is worth somebody's attention even though
 * it is already handled safely.
 */
const KNOWN_OPEN_STATUSES = ["hold from office", "under process", "delay"];

/** Every Status value this parser recognises, folded. */
export const KNOWN_STATUSES = [
  DISPATCHED_STATUS,
  CANCELLED_STATUS,
  ...KNOWN_OPEN_STATUSES,
];

/**
 * Is this line still an order we owe the customer?
 *
 * Open means "they have already ordered" — hold the order-chasing call.
 *
 *   Ready + Done      released. The goods went out and the office is finished.
 *   Cancel            released. There is no order.
 *   anything else     held.
 *
 * The asymmetry in the first line is the client's rule and is deliberate: BOTH
 * cells must say so. `Ready` with `Not Done`, and `Hold From Office` with
 * `Done`, are both still open.
 *
 * The last line is the important one. An unrecognised value — a new status, a
 * typo, a half-typed row — must not read as dispatched. Getting it wrong in
 * this direction costs one call that did not need making, and the customer
 * appears in the queue's held-back strip saying exactly why. Getting it wrong
 * in the other direction rings somebody whose order is sitting in the office,
 * which is the call that makes a telecaller look like they do not know what
 * their own company is doing. `Cancel` is carved out above precisely because
 * it is the case where holding would never end.
 */
export function isTakenOrderOpen(
  officeStatus: string | null,
  entryStatus: string | null,
): boolean {
  const status = fold(officeStatus ?? "");
  if (status === CANCELLED_STATUS) return false;

  const dispatched =
    status === DISPATCHED_STATUS && fold(entryStatus ?? "") === COMPLETED_ENTRY_STATUS;
  return !dispatched;
}

/**
 * `14/08/2024 16:29:55` → an instant.
 *
 * The tab writes a wall clock with no zone, and the office it was typed in is
 * in Asia/Kolkata — so that is the offset applied, spelled literally because a
 * pure function has no configuration to read and India has no daylight saving
 * for it to drift under. Reading it as UTC would file a 4pm order at 9:30pm
 * and move the late ones onto the following day.
 *
 * Date-only values are accepted and land at midnight. Anything else is null.
 */
export function parseSheetDateTime(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;

  const [datePart, timePart] = value.split(/\s+/, 2);
  const date = parseSheetDate(datePart ?? "");
  if (!date) return null;

  let time = "00:00:00";
  if (timePart) {
    const m = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const [, h, min, s] = m;
    if (Number(h) > 23 || Number(min) > 59) return null;
    time = `${h.padStart(2, "0")}:${min}:${s ?? "00"}`;
  }

  const parsed = new Date(`${date}T${time}+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `27.5` kg → 27500 g, so a half-kilo does not become a rounding error. */
export function parseWeightGrams(raw: string): number | null {
  const value = raw.trim().replace(/[,\s]|kgs?\.?$/gi, "");
  if (!value) return null;
  if (!/^-?\d*\.?\d+$/.test(value)) return null;
  return Math.round(Number(value) * 1000);
}

export type ParsedTakenOrderRow = {
  lineKey: string;
  orderNumber: string | null;
  location: string | null;
  orderDate: string | null;
  billingPartyName: string | null;
  deliveryPartyName: string | null;
  standingInstructions: string | null;
  area: string | null;
  transporterName: string | null;
  description: string | null;
  cans: number | null;
  boxes: number | null;
  /** Exactly what column L held, unfolded. "Hold From Office", "Ready". */
  officeStatus: string | null;
  entryStatus: string | null;
  /** The rule applied to those two. The only field anything downstream reads. */
  open: boolean;
  ratePaise: number | null;
  discountBp: number | null;
  tallyBillNo: string | null;
  transportationCostPaise: number | null;
  remark: string | null;
  partyStatus: string | null;
  userName: string | null;
  takenAt: Date | null;
  weightGrams: number | null;
  issues: SheetRowIssue[];
};

const text = (cells: Record<string, string>, column: string | null) => {
  if (!column) return null;
  const value = (cells[column] ?? "").trim();
  return value === "" ? null : value;
};

/**
 * Read one row of the Taken Order tab.
 *
 * The tab is flat like the order tab: an order of three products is three
 * rows sharing an Order number, a timestamp and a bill number, each with its
 * own Order ID. So `open` is a property of the LINE, and a customer is held
 * while ANY of their lines is open — an order half dispatched is still an
 * order outstanding.
 */
export function parseTakenOrderRow(
  cells: Record<string, string>,
  columns: TakenColumns,
): ParsedTakenOrderRow {
  const issues: SheetRowIssue[] = [];

  const readWith = <T>(
    column: string | null,
    parse: (raw: string) => T | null,
    expected: string,
  ): T | null => {
    if (!column) return null;
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const parsed = parse(raw);
    if (parsed === null) {
      issues.push({
        column,
        value: raw,
        problem: `could not be read as ${expected}`,
        kind: "unreadable",
      });
    }
    return parsed;
  };

  const officeStatus = text(cells, columns.officeStatus);
  const entryStatus = text(cells, columns.entryStatus);

  // An unrecognised status still holds the customer, which is safe — but it is
  // a value nobody has told us about, and it should reach a person rather than
  // only changing behaviour. Recorded as ambiguous, not unreadable: the cell is
  // perfectly legible, we just do not know what it means.
  const knownStatus =
    officeStatus === null || KNOWN_STATUSES.includes(fold(officeStatus));
  if (!knownStatus) {
    issues.push({
      column: columns.officeStatus ?? TAKEN_COL.officeStatus,
      value: officeStatus,
      problem: "status not recognised — the customer is held rather than released",
      kind: "ambiguous",
    });
  }

  const row: ParsedTakenOrderRow = {
    lineKey: (columns.lineKey ? cells[columns.lineKey] ?? "" : "").trim(),
    orderNumber: text(cells, columns.orderNumber),
    location: text(cells, columns.location),
    orderDate: readWith(columns.orderDate, parseSheetDate, "a date"),
    billingPartyName: text(cells, columns.billingPartyName),
    deliveryPartyName: text(cells, columns.deliveryPartyName),
    standingInstructions: text(cells, columns.standingInstructions),
    area: text(cells, columns.area),
    transporterName: text(cells, columns.transporterName),
    description: text(cells, columns.description),
    cans: readWith(columns.cans, parseWholeNumber, "a whole number of cans"),
    boxes: readWith(columns.boxes, parseWholeNumber, "a whole number of boxes"),
    officeStatus,
    entryStatus,
    open: isTakenOrderOpen(officeStatus, entryStatus),
    // Per CAN, and in rupees with two decimals — the same convention as the
    // order tab's Rate, and not a line total.
    ratePaise: readWith(columns.rate, parseMoneyPaise, "an amount"),
    // A PERCENTAGE. "4.00%" is 400 basis points, not four rupees.
    discountBp: readWith(columns.discount, parsePercentBp, "a percentage"),
    tallyBillNo: text(cells, columns.tallyBillNo),
    transportationCostPaise: readWith(columns.transportationCost, parseMoneyPaise, "an amount"),
    remark: text(cells, columns.remark),
    partyStatus: text(cells, columns.partyStatus),
    userName: text(cells, columns.userName),
    takenAt: readWith(columns.takenAt, parseSheetDateTime, "a date and time"),
    weightGrams: readWith(columns.weight, parseWeightGrams, "a weight"),
    issues: [],
  };

  // A line that holds an order but names no customer cannot hold anybody. It
  // still imports — somebody has to be able to find the row and fix it.
  if (row.open && !row.billingPartyName) {
    issues.push({
      column: columns.billingPartyName ?? TAKEN_COL.billingPartyName,
      value: "",
      problem: "an open order with no billing party — it can hold nobody's calls",
      kind: "contradiction",
    });
  }

  row.issues = issues;
  return row;
}
