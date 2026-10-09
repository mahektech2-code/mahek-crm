/* ---------------------------------------------------------------------------
 * PRODUCTION PETTY CASH — the rules, PURE.
 *
 * Every figure the module shows is worked out here from records the caller
 * hands in: what an expense still owes, what a fund holds, what a cash box
 * should hold at the end of a day, how late a bill is, who must approve an
 * expense, which statement line a payment is, and what a budget has left.
 * No I/O: the screens, the tests and the alert run all call the same
 * functions, so a number cannot be one thing on a screen and another in a
 * report.
 *
 * Money is PAISE throughout — integers, never floating rupees.
 * ------------------------------------------------------------------------- */

import { addDaysIso, daysBetween } from "./sales";

/* =========================================================== vocabulary */

export const FUND_TYPES = ["BANK", "PHYSICAL_CASH", "CUSTOMER_CASH"] as const;
export type FundType = (typeof FUND_TYPES)[number];

export const FUND_TYPE_LABEL: Record<FundType, string> = {
  BANK: "Bank",
  PHYSICAL_CASH: "Bank cash (physical)",
  CUSTOMER_CASH: "Customer cash",
};

/** The transaction types an expense is recorded as (PRD §6 step 1). */
export const PETTY_TXN_TYPES = [
  "Purchase of material",
  "Transport for purchase material",
  "Transport for dispatch material",
  "Tea, food and drinking water",
  "Staff conveyance",
  "Petrol/diesel",
  "Repairs and maintenance",
  "Testing material",
  "Loading/unloading",
  "Factory consumables",
  "Other approved production expense",
  "Advance to employee/vendor",
  "Other",
] as const;

export const ADVANCE_TYPE = "Advance to employee/vendor";
export const OTHER_TYPE = "Other";

export const APPROVAL_STATUSES = ["draft", "submitted", "under_review", "approved", "rejected", "returned", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned for correction",
  cancelled: "Cancelled",
};

/** Approval statuses that make an expense a real record of spending (not a draft, not withdrawn). */
export const LIVE_APPROVAL: readonly ApprovalStatus[] = ["submitted", "under_review", "approved"];

export type PaymentStatus = "PENDING" | "PARTIALLY_PAID" | "COMPLETED" | "OVERPAID";

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  PENDING: "Pending",
  PARTIALLY_PAID: "Partially paid",
  COMPLETED: "Completed",
  OVERPAID: "Overpaid",
};

/** How money left a fund. A bank pays by UPI, transfer or cheque; a cash box pays cash. */
export const PAYMENT_MODES_BY_FUND: Record<FundType, string[]> = {
  BANK: ["UPI / GPay", "Bank transfer", "Cheque"],
  PHYSICAL_CASH: ["Cash"],
  CUSTOMER_CASH: ["Cash"],
};

export const DOC_STATUS_LABEL: Record<string, string> = {
  attached: "Attached",
  to_follow: "To follow",
  not_available: "Not available",
  exception_approved: "Exception approved",
};

export const EVIDENCE_KINDS = [
  "Vendor invoice",
  "Cash receipt",
  "UPI screenshot / reference",
  "Transport bill",
  "Loading/unloading receipt",
  "Customer receipt acknowledgement",
  "Cash handover acknowledgement",
  "Cash closing evidence",
  "Approval document",
  "Other",
] as const;

/** The kinds of fund movement (PRD §9), and which fund types each may run between. */
export type TransferType = {
  key: string;
  label: string;
  from: FundType[];
  to: FundType[];
  /** The money leaves or reaches a bank, so it should show on a statement. */
  bank: boolean;
};

export const TRANSFER_TYPES: TransferType[] = [
  { key: "withdrawal", label: "Bank cash withdrawal", from: ["BANK"], to: ["PHYSICAL_CASH"], bank: true },
  { key: "handover", label: "Cash handed over to production", from: ["PHYSICAL_CASH"], to: ["PHYSICAL_CASH"], bank: false },
  { key: "return", label: "Cash returned to accounts", from: ["PHYSICAL_CASH", "CUSTOMER_CASH"], to: ["BANK", "PHYSICAL_CASH"], bank: false },
  { key: "customerHandover", label: "Customer cash handed over", from: ["CUSTOMER_CASH"], to: ["PHYSICAL_CASH", "CUSTOMER_CASH"], bank: false },
  { key: "customerDeposit", label: "Customer cash deposited into bank", from: ["CUSTOMER_CASH"], to: ["BANK"], bank: true },
  { key: "between", label: "Transfer between fund accounts", from: ["BANK", "PHYSICAL_CASH", "CUSTOMER_CASH"], to: ["BANK", "PHYSICAL_CASH", "CUSTOMER_CASH"], bank: false },
];

export function transferType(key: string): TransferType | undefined {
  return TRANSFER_TYPES.find((t) => t.key === key);
}

/** Why a transfer of this type cannot run between these two funds, or null. */
export function transferRefusal(type: TransferType, from: FundType, to: FundType, sameFund: boolean): string | null {
  if (sameFund) return "A transfer needs two different fund accounts.";
  if (!type.from.includes(from)) return `${type.label} starts from ${type.from.map((f) => FUND_TYPE_LABEL[f].toLowerCase()).join(" or ")}.`;
  if (!type.to.includes(to)) return `${type.label} ends in ${type.to.map((f) => FUND_TYPE_LABEL[f].toLowerCase()).join(" or ")}.`;
  return null;
}

/* ============================================================== payable */

export type PaymentFact = { amountPaise: number; status: string };
export type AdjustmentFact = { amountPaise: number; status: string };

export type PayableState = {
  /** What was billed. Never changed by a payment. */
  amountPaise: number;
  /** Approved adjustments: a vendor credit, an advance set against it, a correction. */
  adjustedPaise: number;
  /** What is owed in all: amount less approved adjustments. */
  payablePaise: number;
  /** Sum of CONFIRMED payments — a request moves nothing. */
  paidPaise: number;
  /** Requests waiting to be paid. */
  requestedPaise: number;
  outstandingPaise: number;
  status: PaymentStatus;
};

/**
 * `remaining = expense − approved adjustments − Σ confirmed payments` (PRD §7).
 * The status is DERIVED: nobody sets it, and a reversal recalculates it
 * because a reversed payment is simply no longer counted.
 */
export function payableState(amountPaise: number, payments: PaymentFact[], adjustments: AdjustmentFact[] = [], tolerancePaise = 0): PayableState {
  const adjustedPaise = adjustments.filter((a) => a.status === "approved").reduce((s, a) => s + a.amountPaise, 0);
  const payablePaise = amountPaise - adjustedPaise;
  const paidPaise = payments.filter((p) => p.status === "confirmed").reduce((s, p) => s + p.amountPaise, 0);
  const requestedPaise = payments.filter((p) => p.status === "requested").reduce((s, p) => s + p.amountPaise, 0);
  const left = payablePaise - paidPaise;
  const status: PaymentStatus =
    left < -tolerancePaise ? "OVERPAID" : Math.abs(left) <= tolerancePaise && payablePaise > 0 ? "COMPLETED" : payablePaise <= 0 ? "COMPLETED" : paidPaise > 0 ? "PARTIALLY_PAID" : "PENDING";
  return { amountPaise, adjustedPaise, payablePaise, paidPaise, requestedPaise, outstandingPaise: Math.max(0, left), status };
}

/** Why this payment cannot be recorded against what is left, or null. */
export function paymentRefusal(amountPaise: number, state: PayableState, opts: { isAdvance?: boolean } = {}): string | null {
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) return "A payment must be more than zero.";
  const left = state.payablePaise - state.paidPaise - state.requestedPaise;
  if (amountPaise > left) {
    if (left <= 0) return opts.isAdvance ? "This advance is already paid in full." : "Nothing is left to pay on this expense.";
    return `Only ${rupees(left)} is left to pay on this expense${state.requestedPaise ? ` after the ${rupees(state.requestedPaise)} already requested` : ""}.`;
  }
  return null;
}

/* ================================================================ funds */

export type LedgerFact = { fundAccountId: string; direction: "credit" | "debit" | string; amountPaise: number; txnDate: string };

/** A fund's balance: credits less debits, posted entries only (the caller passes nothing else). */
export function balanceOf(entries: Pick<LedgerFact, "direction" | "amountPaise">[]): number {
  return entries.reduce((s, e) => s + (e.direction === "credit" ? e.amountPaise : -e.amountPaise), 0);
}

export function fundBalances(entries: LedgerFact[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.fundAccountId, (out.get(e.fundAccountId) ?? 0) + (e.direction === "credit" ? e.amountPaise : -e.amountPaise));
  return out;
}

/** Why a payment out of this fund cannot be made from what it holds, or null. */
export function fundsRefusal(availablePaise: number, amountPaise: number, fundName: string): string | null {
  if (amountPaise <= availablePaise) return null;
  return `${fundName} holds ${rupees(availablePaise)}; ${rupees(amountPaise)} cannot be paid from it.`;
}

export type ClosingFigures = { openingPaise: number; inPaise: number; outPaise: number; expectedPaise: number };

/**
 * `expected = opening + confirmed receipts and transfers in − confirmed
 * payments and transfers out` for one fund on one day (PRD §12). The caller
 * passes POSTED ledger entries only, so an unpaid bill, a payment request and
 * a handover still in transit cannot reach it.
 */
export function closingFigures(entries: Pick<LedgerFact, "direction" | "amountPaise" | "txnDate">[], day: string): ClosingFigures {
  let openingPaise = 0;
  let inPaise = 0;
  let outPaise = 0;
  for (const e of entries) {
    if (e.txnDate < day) openingPaise += e.direction === "credit" ? e.amountPaise : -e.amountPaise;
    else if (e.txnDate === day) {
      if (e.direction === "credit") inPaise += e.amountPaise;
      else outPaise += e.amountPaise;
    }
  }
  return { openingPaise, inPaise, outPaise, expectedPaise: openingPaise + inPaise - outPaise };
}

/** Counted less expected. Negative is a shortage. */
export const varianceOf = (countedPaise: number, expectedPaise: number) => countedPaise - expectedPaise;

/* ============================================================== ageing */

export const AGEING_BUCKETS = ["Not yet due", "1–7 days overdue", "8–15 days overdue", "16–30 days overdue", "More than 30 days overdue"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Days past the due date (0 or less is not yet due) and its bucket. No due date reads as due on the bill date. */
export function ageing(dueDate: string | null, today: string): { daysOverdue: number; bucket: AgeingBucket } {
  if (!dueDate) return { daysOverdue: 0, bucket: "Not yet due" };
  const d = daysBetween(dueDate, today);
  const bucket: AgeingBucket = d <= 0 ? "Not yet due" : d <= 7 ? "1–7 days overdue" : d <= 15 ? "8–15 days overdue" : d <= 30 ? "16–30 days overdue" : "More than 30 days overdue";
  return { daysOverdue: Math.max(0, d), bucket };
}

/** A bill's due date: the date typed, else the bill date plus the terms, else none. */
export function dueDateFor(explicit: string | null, billDate: string | null, termsDays: number | null): string | null {
  if (explicit) return explicit;
  if (billDate && termsDays != null && termsDays >= 0) return addDaysIso(billDate, termsDays);
  return null;
}

/* ============================================================= approval */

export type ApprovalLevel = "policy" | "approver" | "owner";

export const APPROVAL_LEVEL_LABEL: Record<ApprovalLevel, string> = {
  policy: "Approved by policy",
  approver: "Accounts manager / approver",
  owner: "Owner / admin",
};

export type RouteInput = {
  amountPaise: number;
  /** The category's rule: standard routes by amount; approver and owner always go there. */
  categoryRule: "standard" | "approver" | "owner" | string;
  /** Approved on submission at or below this, where the category allows (0 switches it off). */
  autoApproveUpToPaise: number;
  /** An approver decides up to this; above it the owner does. */
  approverLimitPaise: number;
  /** The month's budget for this category would be passed by this expense. */
  budgetExceeded: boolean;
  /** warn: flag only; approval: an over-budget expense goes to the owner. */
  budgetRule: "warn" | "approval" | string;
  /** Receipt required and none attached: never approved by policy. */
  missingEvidence: boolean;
};

/** Who must approve this expense, and the rule that said so — stored on the expense and its approval row. */
export function approvalRoute(r: RouteInput): { level: ApprovalLevel; rule: string } {
  if (r.budgetExceeded && r.budgetRule === "approval") return { level: "owner", rule: "Over the month's budget for this category" };
  if (r.categoryRule === "owner") return { level: "owner", rule: "The category always needs the owner" };
  if (r.amountPaise > r.approverLimitPaise) return { level: "owner", rule: `Above the approver's limit of ${rupees(r.approverLimitPaise)}` };
  if (r.categoryRule === "approver") return { level: "approver", rule: "The category always needs an approver" };
  if (r.autoApproveUpToPaise > 0 && r.amountPaise <= r.autoApproveUpToPaise && !r.missingEvidence) {
    return { level: "policy", rule: `At or below the auto-approve limit of ${rupees(r.autoApproveUpToPaise)}` };
  }
  return { level: "approver", rule: `Up to ${rupees(r.approverLimitPaise)}: an approver decides` };
}

/**
 * Why this person may not decide this expense, or null. Maker-checker: nobody
 * approves what they raised, submitted or spent — not even an administrator,
 * because the rule exists for exactly the person with the most power.
 */
export function decisionRefusal(d: {
  level: ApprovalLevel | string | null;
  deciderId: string;
  deciderName: string;
  makerIds: (string | null | undefined)[];
  makerNames: (string | null | undefined)[];
  canApprove: boolean;
  canOwnerApprove: boolean;
}): string | null {
  if (d.makerIds.includes(d.deciderId) || d.makerNames.some((n) => n && n.trim().toLowerCase() === d.deciderName.trim().toLowerCase())) {
    return "Nobody approves an expense they raised, submitted or spent. Another approver must decide it.";
  }
  if (d.level === "owner") return d.canOwnerApprove ? null : "This expense needs the owner's approval.";
  return d.canApprove || d.canOwnerApprove ? null : "Only an approver decides expenses.";
}

/* ======================================================= bank matching */

export type StatementLine = {
  date: string;
  valueDate: string | null;
  narration: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  txnId: string | null;
};

export type MatchCandidate = {
  type: "payment" | "transfer" | "adjustment";
  id: string;
  /** Money out of the bank fund is a debit on the statement. */
  direction: "debit" | "credit";
  amountPaise: number;
  date: string;
  reference: string | null;
  /** Payee or purpose, to compare with the narration. */
  words: string | null;
};

export type MatchVerdict =
  | { kind: "auto"; rule: "reference"; candidates: MatchCandidate[] }
  | { kind: "suggest"; rule: "amount_date" | "narration"; candidates: MatchCandidate[] }
  | { kind: "ambiguous"; rule: "amount_date" | "reference"; candidates: MatchCandidate[] }
  | { kind: "none"; candidates: [] };

const normRef = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Words of more than three letters, for comparing a payee with a narration. */
const words = (s: string | null | undefined) =>
  new Set(
    (s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

/**
 * Which recorded movement a statement line is (PRD §11), in the PRD's order:
 * an exact reference/UTR settles it on its own; an equal amount within the
 * date window is only ever a SUGGESTION, and two of them is ambiguous and
 * goes to a person. A narration that shares a word with the payee breaks a
 * tie between equal amounts; it never settles a line alone.
 */
export function matchLine(line: StatementLine, candidates: MatchCandidate[], windowDays: number): MatchVerdict {
  const direction: "debit" | "credit" = line.debitPaise > 0 ? "debit" : "credit";
  const amount = line.debitPaise || line.creditPaise;
  const same = candidates.filter((c) => c.direction === direction);
  const ref = normRef(line.reference);
  const narr = normRef(line.narration);
  if (ref.length >= 6 || narr.length >= 6) {
    const byRef = same.filter((c) => {
      const r = normRef(c.reference);
      return r.length >= 6 && (r === ref || (narr.includes(r) && r.length >= 8));
    });
    if (byRef.length === 1 && byRef[0].amountPaise === amount) return { kind: "auto", rule: "reference", candidates: byRef };
    if (byRef.length > 1) return { kind: "ambiguous", rule: "reference", candidates: byRef };
  }
  const near = same.filter((c) => c.amountPaise === amount && Math.abs(daysBetween(c.date, line.date)) <= windowDays);
  if (near.length === 1) return { kind: "suggest", rule: "amount_date", candidates: near };
  if (near.length > 1) {
    const lw = words(line.narration);
    const named = near.filter((c) => [...words(c.words)].some((w) => lw.has(w)));
    if (named.length === 1) return { kind: "suggest", rule: "narration", candidates: named };
    return { kind: "ambiguous", rule: "amount_date", candidates: near };
  }
  return { kind: "none", candidates: [] };
}

/** Why these records cannot all be matched to this line, or null. A split may not exceed the line. */
export function splitRefusal(lineAmountPaise: number, alreadyPaise: number, addingPaise: number): string | null {
  if (alreadyPaise + addingPaise > lineAmountPaise) {
    return `The statement line is ${rupees(lineAmountPaise)}; matching ${rupees(alreadyPaise + addingPaise)} to it would be more than it carries.`;
  }
  return null;
}

/* ------------------------------------------------------- statement CSV */

/** One CSV row into cells, honouring quotes. */
export function csvCells(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (q) {
      if (ch === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A statement's date — 05-10-2026, 05/10/2026, 05-Oct-2026, 05 Oct 2026, 2026-10-05 — day first, as Indian banks print it. */
export function statementDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, Number(m[2]), Number(m[1]));
  }
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, MONTHS[m[2].toLowerCase()], Number(m[1]));
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1,23,456.70" → paise; blank or a dash is zero; brackets or a minus is negative. */
export function statementAmount(v: string | undefined): number | null {
  const s = (v ?? "").replace(/[₹,\s]|INR|Rs\.?/gi, "");
  if (s === "" || s === "-" || s === "--") return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = Number(s.replace(/[()-]/g, "").replace(/(Cr|Dr)$/i, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

export type ParsedStatement = { lines: StatementLine[]; skipped: { row: number; reason: string }[] };

/**
 * A bank statement exported as CSV. The header row is FOUND — a statement
 * starts with the account's name and address — as the first row naming a
 * date and either debit/credit columns or an amount with a Dr/Cr column.
 */
export function parseStatement(text: string): ParsedStatement {
  const rows = text.split(/\r?\n/).map(csvCells);
  const has = (cells: string[], re: RegExp) => cells.findIndex((c) => re.test(c.toLowerCase()));
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const c = rows[i];
    if (has(c, /date/) >= 0 && (has(c, /debit|withdraw/) >= 0 || has(c, /^amount|amount\b/) >= 0)) {
      h = i;
      break;
    }
  }
  if (h < 0) return { lines: [], skipped: [{ row: 0, reason: "No header row naming a date and debit/credit (or amount) columns." }] };
  const head = rows[h];
  const col = (re: RegExp, not?: RegExp) => head.findIndex((c) => re.test(c.toLowerCase()) && !(not && not.test(c.toLowerCase())));
  const cDate = col(/(transaction|txn|tran)?\s*date/, /value/);
  const cValue = col(/value\s*date/);
  const cNarr = col(/narration|description|particular|remark|details/);
  const cRef = col(/ref|utr|chq|cheque/);
  const cDebit = col(/debit|withdraw/);
  const cCredit = col(/credit|deposit/, /debit/);
  const cAmount = col(/^amount|amount\b/);
  const cDrCr = col(/dr\s*\/\s*cr|cr\s*\/\s*dr|type/);
  const cBal = col(/balance/);
  const cId = col(/^(sl|sr|s)\.?\s*no|transaction id|txn id/);
  const lines: StatementLine[] = [];
  const skipped: { row: number; reason: string }[] = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => c === "")) continue;
    const date = cDate >= 0 ? statementDate(r[cDate] ?? "") : null;
    if (!date) {
      if ((r[cDate] ?? "").trim()) skipped.push({ row: i + 1, reason: `"${r[cDate]}" is not a date` });
      continue;
    }
    let debit = 0;
    let credit = 0;
    if (cDebit >= 0 || cCredit >= 0) {
      const d = cDebit >= 0 ? statementAmount(r[cDebit]) : 0;
      const c = cCredit >= 0 ? statementAmount(r[cCredit]) : 0;
      if (d == null || c == null) {
        skipped.push({ row: i + 1, reason: "An amount could not be read" });
        continue;
      }
      debit = Math.abs(d);
      credit = Math.abs(c);
    } else {
      const a = statementAmount(r[cAmount]);
      if (a == null) {
        skipped.push({ row: i + 1, reason: "The amount could not be read" });
        continue;
      }
      const t = (cDrCr >= 0 ? r[cDrCr] : r[cAmount] ?? "").toLowerCase();
      if (/dr|debit|withdraw/.test(t) || a < 0) debit = Math.abs(a);
      else credit = Math.abs(a);
    }
    if ((debit > 0) === (credit > 0)) {
      skipped.push({ row: i + 1, reason: debit ? "Both a debit and a credit on one line" : "No amount on this line" });
      continue;
    }
    lines.push({
      date,
      valueDate: cValue >= 0 ? statementDate(r[cValue] ?? "") : null,
      narration: cNarr >= 0 ? (r[cNarr] ?? "") : "",
      reference: cRef >= 0 && r[cRef] ? r[cRef] : null,
      debitPaise: debit,
      creditPaise: credit,
      balancePaise: cBal >= 0 ? statementAmount(r[cBal]) : null,
      txnId: cId >= 0 && r[cId] ? r[cId] : null,
    });
  }
  return { lines, skipped };
}

/**
 * What makes a line the same line when a statement is imported again —
 * including an overlapping one. The balance is in it, so two genuinely
 * different ₹500 debits on one day with one narration are still two lines.
 */
export function lineKey(fundId: string, l: StatementLine): string {
  return [fundId, l.date, l.debitPaise, l.creditPaise, normRef(l.reference), l.balancePaise ?? "", l.narration.trim().toLowerCase().replace(/\s+/g, " "), l.txnId ?? ""].join("|");
}

/* ============================================================== budgets */

export type BudgetFigures = {
  budgetPaise: number;
  incurredPaise: number;
  paidPaise: number;
  unpaidPaise: number;
  committedPaise: number;
  remainingPaise: number;
  /** Incurred so far, run on to the month's end at the same pace. Null for a month not under way. */
  forecastPaise: number | null;
  /** (incurred − budget) ÷ budget, %; null with no budget. */
  variancePct: number | null;
};

/**
 * Budget against actual for one month (PRD §13). Budget control runs on
 * INCURRED expense; paid is shown beside it, never instead of it. Remaining
 * takes commitments off too, because money promised is not money free.
 */
export function budgetFigures(f: { budgetPaise: number; incurredPaise: number; paidPaise: number; committedPaise: number; period: string; today: string }): BudgetFigures {
  const unpaidPaise = Math.max(0, f.incurredPaise - f.paidPaise);
  const remainingPaise = f.budgetPaise - f.incurredPaise - f.committedPaise;
  let forecastPaise: number | null = null;
  if (f.today.slice(0, 7) === f.period) {
    const day = Number(f.today.slice(8, 10));
    const days = daysInMonth(f.period);
    forecastPaise = Math.round((f.incurredPaise / Math.max(1, day)) * days);
  } else if (f.today.slice(0, 7) > f.period) forecastPaise = f.incurredPaise;
  const variancePct = f.budgetPaise > 0 ? Math.round(((f.incurredPaise - f.budgetPaise) / f.budgetPaise) * 1000) / 10 : null;
  return { budgetPaise: f.budgetPaise, incurredPaise: f.incurredPaise, paidPaise: f.paidPaise, unpaidPaise, committedPaise: f.committedPaise, remainingPaise, forecastPaise, variancePct };
}

export function daysInMonth(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/* ============================================================ exceptions */

export type SplitFact = { id: string; payee: string | null; amountPaise: number; date: string };

/**
 * Several expenses to one payee inside a few days, each under the approver's
 * limit and together above it — the shape of a bill split to stay under a
 * limit. FLAGGED for review, never called anything worse (PRD §19).
 */
export function splitsNearLimit(rows: SplitFact[], limitPaise: number, windowDays: number): { payee: string; ids: string[]; totalPaise: number }[] {
  const by = new Map<string, SplitFact[]>();
  for (const r of rows) {
    const p = (r.payee ?? "").trim().toLowerCase();
    if (!p || r.amountPaise > limitPaise) continue;
    by.set(p, [...(by.get(p) ?? []), r]);
  }
  const out: { payee: string; ids: string[]; totalPaise: number }[] = [];
  for (const [, list] of by) {
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted.filter((x) => x.date >= sorted[i].date && daysBetween(sorted[i].date, x.date) <= windowDays);
      const total = group.reduce((s, x) => s + x.amountPaise, 0);
      if (group.length >= 2 && total > limitPaise) {
        out.push({ payee: sorted[i].payee ?? "", ids: group.map((x) => x.id), totalPaise: total });
        break;
      }
    }
  }
  return out;
}

/** Possible duplicates of a new expense: the same bill number from the same payee, or the same payee, amount and day. */
type DupFact = { payee: string | null; billNo: string | null; amountPaise: number; date: string };

export function duplicateOf<T extends DupFact & { id: string }>(n: DupFact, existing: T[]): T[] {
  const p = (n.payee ?? "").trim().toLowerCase();
  const b = (n.billNo ?? "").trim().toLowerCase();
  return existing.filter((e) => {
    const ep = (e.payee ?? "").trim().toLowerCase();
    if (b && (e.billNo ?? "").trim().toLowerCase() === b && ep === p) return true;
    return !!p && ep === p && e.amountPaise === n.amountPaise && e.date === n.date;
  });
}

/* ============================================================== helpers */

export function rupees(p: number): string {
  const r = p / 100;
  return (r < 0 ? "−" : "") + "₹" + Math.abs(r).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
