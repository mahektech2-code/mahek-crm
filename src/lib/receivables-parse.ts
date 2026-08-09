/* ---------------------------------------------------------------------------
 * Tally's Receivables report, as text.
 *
 * Bills are imported from the order sheet as PAID, because that sheet records
 * what was billed and never what was received. This report is the other half:
 * it is the list of what is actually still owed, and applying it is what turns
 * a ledger of assumptions into one somebody can chase.
 *
 * The shape is a printed report rather than a data export — customers are
 * headings, not a column — so it is read positionally:
 *
 *     " ", " ", "A TO Z ENTERPRISES", " ", " "        <- a customer heading
 *     "Date","Ref. No.","Pending Amount","Due on",…   <- its column headings
 *     "22 Jan 26","MMI/25-26/3209","5210","23 Jan 26" <- a bill still owed
 *     " "," Total","5210"," "," "                     <- and its total
 *
 * Pure: text in, rows out, no database and no clock. What the numbers MEAN is
 * decided in the service.
 * ------------------------------------------------------------------------- */

export type ReceivableRow = {
  customer: string;
  /** Tally's bill number, which is `bills.billNo` for anything we imported. */
  reference: string;
  /** Still owed, in paise. */
  pendingPaise: number;
  /** ISO, or null where the report leaves it blank. */
  dueDate: string | null;
  billDate: string | null;
};

export type ReceivableCredit = {
  customer: string;
  reference: string;
  /** Negative in the report; kept negative here, because that is what it is. */
  pendingPaise: number;
};

export type ParsedReceivables = {
  /** Bills with money still owed against them. */
  rows: ReceivableRow[];
  /**
   * Money the customer has paid that is against no bill — advances, unapplied
   * receipts, credit notes. Reported and never applied: this file cannot say
   * which bill they belong to, and guessing would mark a real debt settled.
   */
  credits: ReceivableCredit[];
  /** Lines that looked like data and could not be read. */
  problems: string[];
};

const NOT_A_REFERENCE = new Set(["Ref. No.", "Total", ""]);

/** Tally's own name for money in hand that names no bill. */
const ON_ACCOUNT = "On Account";

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "22 Jan 26" → "2026-01-22". Two-digit years; these records start in 2022. */
export function parseTallyDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = m[3].length === 4 ? m[3] : `20${m[3]}`;
  return `${year}-${month}-${m[1].padStart(2, "0")}`;
}

/** "5,210.50" → 521050 paise. Rounded, because paise are integers. */
export function parseAmountPaise(raw: string): number | null {
  const cleaned = raw.replace(/[,\s₹]/g, "");
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** One CSV line into cells. Tally quotes every field and escapes with "". */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function parseReceivables(text: string): ParsedReceivables {
  const rows: ReceivableRow[] = [];
  const credits: ReceivableCredit[] = [];
  const problems: string[] = [];
  let customer = "";

  for (const line of text.split(/\r?\n/)) {
    const c = cells(line);
    if (c.length < 3) continue;

    const [date, reference, amount, due] = c;

    // A heading: the name sits in the third column with nothing beside it.
    if (!date && !reference && amount && amount !== "Pending Amount") {
      customer = amount;
      continue;
    }
    if (NOT_A_REFERENCE.has(reference) || !amount) continue;

    const pendingPaise = parseAmountPaise(amount);
    if (pendingPaise === null) {
      problems.push(`${customer}: could not read "${amount}" against ${reference}`);
      continue;
    }

    // A credit is money in hand with no bill named, whichever way it is
    // written: "On Account", a receipt number, or a negative against a
    // reference. It says nothing about which bill is settled.
    if (reference === ON_ACCOUNT || pendingPaise <= 0) {
      credits.push({ customer, reference, pendingPaise });
      continue;
    }

    rows.push({
      customer,
      reference,
      pendingPaise,
      dueDate: parseTallyDate(due ?? ""),
      billDate: parseTallyDate(date),
    });
  }

  return { rows, credits, problems };
}
