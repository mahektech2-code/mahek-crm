/* ---------------------------------------------------------------------------
 * The Petty Cash module's rules, PURE (spec v1.0, 20 Oct 2026).
 *
 * One real movement of money is ONE transaction with ONE number, posted ONCE.
 * Nothing here stores a balance: a transaction takes its amount off its FROM
 * account and puts it on its TO account, and every figure on every screen is
 * the sum of those legs. That is what makes "posted once" true by
 * construction — there is no second place a payment could be written.
 *
 *   expense         from an account (or from an employee's advance) → nowhere
 *   receipt         from nowhere → into an account
 *   transfer        account → account; never income, never expense
 *   advance         an account → an employee's advance (cash in their hand)
 *   advance_return  the unspent part of an advance → back into an account
 *   advance_topup   an account → the employee, for what they spent beyond it
 *
 * An expense is entered when it is PAID. There is no unpaid state: the
 * Production Head records petty cash as it goes out, and an office expense is
 * entered against the account it left.
 * ------------------------------------------------------------------------- */

export const MONEY_KINDS = ["expense", "receipt", "transfer", "advance", "advance_return", "advance_topup"] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];

export const MONEY_KIND_LABEL: Record<MoneyKind, string> = {
  expense: "Expense",
  receipt: "Receipt",
  transfer: "Transfer",
  advance: "Advance given",
  advance_return: "Advance returned",
  advance_topup: "Advance top-up",
};

export const ACCOUNT_KINDS = ["bank", "cash", "petty"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** How money moves. Cash is the one mode a bank never sees. */
export const PAY_MODES = ["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash", "Card"] as const;

export type Review = "none" | "to_review" | "approved" | "sent_back";

export const REVIEW_LABEL: Record<Review, string> = {
  none: "—",
  to_review: "To review",
  approved: "Approved",
  sent_back: "Sent back",
};

export type MoneyTxnLike = {
  id: string;
  kind: MoneyKind;
  amountPaise: number;
  fromAccountId: string | null;
  toAccountId: string | null;
  status: "active" | "cancelled" | string;
  date: string;
  txnNo: number;
};

/** The legs a transaction posts. A cancelled one posts nothing. */
export function legs(t: Pick<MoneyTxnLike, "amountPaise" | "fromAccountId" | "toAccountId" | "status">): { accountId: string; delta: number }[] {
  if (t.status !== "active") return [];
  const out: { accountId: string; delta: number }[] = [];
  if (t.fromAccountId) out.push({ accountId: t.fromAccountId, delta: -t.amountPaise });
  if (t.toAccountId) out.push({ accountId: t.toAccountId, delta: t.amountPaise });
  return out;
}

/** Each account's balance: its opening plus every leg on it. */
export function accountBalances(
  accounts: { id: string; openingPaise: number }[],
  txns: Pick<MoneyTxnLike, "amountPaise" | "fromAccountId" | "toAccountId" | "status">[],
): Map<string, number> {
  const out = new Map(accounts.map((a) => [a.id, a.openingPaise]));
  for (const t of txns) for (const l of legs(t)) out.set(l.accountId, (out.get(l.accountId) ?? 0) + l.delta);
  return out;
}

/** Whether a transaction changes the business's income or expense. A transfer and an advance never do. */
export function isIncomeOrExpense(kind: MoneyKind): "income" | "expense" | null {
  return kind === "receipt" ? "income" : kind === "expense" ? "expense" : null;
}

/* ------------------------------------------------------------------ numbers */

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const yy = (date: string) => date.slice(2, 4);

/** `TXN-26-00423`: the two-digit year it was dated in, and the number, which never repeats across years. */
export function txnLabel(no: number, date: string): string {
  return `TXN-${yy(date)}-${pad(no, 5)}`;
}

/** `ADV-26-0031`. */
export function advanceLabel(no: number, date: string): string {
  return `ADV-${yy(date)}-${pad(no, 4)}`;
}

/** The number in a label someone picked from a list ("TXN-26-00423 · …"), or null. */
export function txnNoOf(label: string | null | undefined): number | null {
  const m = /TXN-\d{2}-(\d+)/.exec(label ?? "");
  return m ? Number(m[1]) : null;
}

export function advanceNoOf(label: string | null | undefined): number | null {
  const m = /ADV-\d{2}-(\d+)/.exec(label ?? "");
  return m ? Number(m[1]) : null;
}

/* ---------------------------------------------------------------- duplicates */

/** An invoice number as people type it: case, spaces and separators do not make two invoices. */
export function invoiceKey(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const nameKey = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The live expense this one looks like a copy of: the same invoice number
 * from the same payee, or the same invoice number for the same amount. Never
 * a refusal on its own — a person says it is a different invoice and it saves.
 */
export function duplicateOf<T extends { id: string; invoiceNo: string | null; payee: string | null; amountPaise: number; status: string; kind: string }>(
  x: { id?: string; invoiceNo: string | null; payee: string | null; amountPaise: number },
  existing: T[],
): T | null {
  const inv = invoiceKey(x.invoiceNo);
  if (!inv) return null;
  return (
    existing.find(
      (e) =>
        e.id !== x.id &&
        e.kind === "expense" &&
        e.status === "active" &&
        invoiceKey(e.invoiceNo) === inv &&
        ((nameKey(e.payee) && nameKey(e.payee) === nameKey(x.payee)) || e.amountPaise === x.amountPaise),
    ) ?? null
  );
}

/* ----------------------------------------------------------------- advances */

export type AdvanceBill = { amountPaise: number; review: Review | string; status: string };

export type AdvancePosition = {
  given: number;
  /** Bills the accountant approved: spent and accounted for. */
  approved: number;
  /** Bills waiting for the accountant. */
  toReview: number;
  /** Bills sent back to be fixed. */
  sentBack: number;
  /** Paid back into an account, or paid out to the employee, at settlement. */
  returned: number;
  toppedUp: number;
  /** What the employee still holds that no bill accounts for. Negative: they spent more than they were given. */
  withThem: number;
  /** What settling now would move: positive comes back to us, negative is paid to them. */
  settleAmount: number;
  /** Why it cannot be settled yet, or null. */
  settleWhy: string | null;
};

export function advancePosition(x: {
  given: number;
  status: string;
  bills: AdvanceBill[];
  returns: { kind: "advance_return" | "advance_topup"; amountPaise: number; status: string }[];
}): AdvancePosition {
  const live = x.bills.filter((b) => b.status === "active");
  const sum = (r: string) => live.filter((b) => b.review === r).reduce((s, b) => s + b.amountPaise, 0);
  const approved = sum("approved");
  const toReview = sum("to_review") + sum("none");
  const sentBack = sum("sent_back");
  const liveReturns = x.returns.filter((r) => r.status === "active");
  const returned = liveReturns.filter((r) => r.kind === "advance_return").reduce((s, r) => s + r.amountPaise, 0);
  const toppedUp = liveReturns.filter((r) => r.kind === "advance_topup").reduce((s, r) => s + r.amountPaise, 0);
  const withThem = x.given - approved - toReview - returned + toppedUp;
  const settleAmount = x.given - approved - returned + toppedUp;
  const settleWhy =
    x.status === "settled"
      ? "Already settled"
      : x.status === "cancelled"
        ? "This advance is cancelled"
        : toReview > 0
          ? "Bills are waiting for review"
          : sentBack > 0
            ? "A bill was sent back — fix it or cancel it first"
            : null;
  return { given: x.given, approved, toReview, sentBack, returned, toppedUp, withThem, settleAmount, settleWhy };
}

/** Whether bills on an advance are late: none in, past the day they were due. */
export function advanceLate(x: { status: string; billsDueOn: string | null; billCount: number }, today: string): boolean {
  return x.status === "open" && !!x.billsDueOn && x.billsDueOn < today && x.billCount === 0;
}

/* ---------------------------------------------------------------- statement */

export type StatementRow<T> = { t: T; inPaise: number; outPaise: number; balance: number };

/**
 * An account's statement: its opening, then every live transaction that
 * touches it, oldest first, with the running balance. Closing = Opening +
 * In − Out, which the screen says back.
 */
export function statement<T extends MoneyTxnLike>(accountId: string, openingPaise: number, txns: T[]): { rows: StatementRow<T>[]; opening: number; inPaise: number; outPaise: number; closing: number } {
  const mine = txns
    .filter((t) => t.status === "active" && (t.fromAccountId === accountId || t.toAccountId === accountId))
    .sort((a, b) => (a.date === b.date ? a.txnNo - b.txnNo : a.date < b.date ? -1 : 1));
  let bal = openingPaise;
  let inP = 0;
  let outP = 0;
  const rows = mine.map((t) => {
    const out = t.fromAccountId === accountId ? t.amountPaise : 0;
    const inn = t.toAccountId === accountId ? t.amountPaise : 0;
    bal += inn - out;
    inP += inn;
    outP += out;
    return { t, inPaise: inn, outPaise: out, balance: bal };
  });
  return { rows, opening: openingPaise, inPaise: inP, outPaise: outP, closing: bal };
}

/* --------------------------------------------------------- where cash went */

/** How much of a cash receipt (or a withdrawal) has been paid onward from, and what is left. */
export function cashUse(source: { amountPaise: number }, uses: { amountPaise: number; status: string }[]): { used: number; left: number } {
  const used = uses.filter((u) => u.status === "active").reduce((s, u) => s + u.amountPaise, 0);
  return { used, left: source.amountPaise - used };
}

/* ------------------------------------------------------------ bank statements */

export type BankLineIn = {
  date: string;
  description: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A date as Indian bank statements print it — 18/10/2026, 18-10-26, 18-Oct-2026, 2026-10-18 — as ISO, or null. */
export function parseBankDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2,4})$/.exec(s);
  if (m) return iso(year(m[3]), +m[2], +m[1]);
  m = /^(\d{1,2})[/.\-\s]([A-Za-z]{3})[A-Za-z]*[/.\-\s,]*(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(year(m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

function iso(y: number, mo: number, d: number): string | null {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${pad(mo, 2)}-${pad(d, 2)}`;
}

/** "1,23,456.78", "₹ 500", "500.00 Dr" → paise; blank → 0; nonsense → null. */
export function parseBankAmount(v: string | undefined): number | null {
  const s = (v ?? "").replace(/[₹,\s]|Rs\.?|INR|Dr|Cr/gi, "").trim();
  if (s === "" || s === "-") return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Math.abs(Number(s)) * 100);
}

/** Splits one line, keeping quoted commas. A block copied out of Excel is tab-separated, and its amounts keep their commas. */
export function csvCells(line: string): string[] {
  const sep = line.includes("\t") ? "\t" : ",";
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === sep && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

type Cols = { date: number; desc: number; ref: number; debit: number; credit: number; amount: number; drcr: number; balance: number };

function findCols(cells: string[]): Cols | null {
  const at = (re: RegExp, not?: RegExp) => cells.findIndex((c) => re.test(c.toLowerCase()) && !(not && not.test(c.toLowerCase())));
  const date = at(/date/, /value/) >= 0 ? at(/date/, /value/) : at(/date/);
  const desc = at(/narration|description|particular|remark|details/);
  const drcr = at(/dr\s*\/\s*cr|cr\s*\/\s*dr|^type$|txn type/);
  const side = (re: RegExp) => cells.findIndex((c, i) => i !== drcr && re.test(c.toLowerCase()));
  const debit = side(/debit|withdraw|\bdr\b|paid out/);
  const credit = side(/credit|deposit|\bcr\b|paid in/);
  const amount = at(/^amount|txn amount|transaction amount/);
  if (date < 0 || desc < 0 || (debit < 0 && credit < 0 && amount < 0)) return null;
  return { date, desc, ref: at(/ref|chq|cheque|utr|instrument/), debit, credit, amount, drcr, balance: at(/balance/) };
}

/**
 * A bank statement as exported (CSV, or a block copied out of Excel): the
 * header row is found wherever it sits under the bank's letterhead, and every
 * row after it with a date and an amount becomes a line. Rows that are not
 * lines — opening balance, totals, blank — are skipped and counted.
 */
export function parseBankStatement(text: string): { lines: BankLineIn[]; skipped: number; problem: string | null } {
  const rows = text.split(/\r?\n/).map(csvCells);
  let head = -1;
  let cols: Cols | null = null;
  for (let i = 0; i < rows.length && i < 60; i++) {
    const c = findCols(rows[i]);
    if (c) {
      head = i;
      cols = c;
      break;
    }
  }
  if (!cols) return { lines: [], skipped: 0, problem: "No header row with a date, a description and a debit / credit (or amount) column was found." };
  const lines: BankLineIn[] = [];
  let skipped = 0;
  for (const r of rows.slice(head + 1)) {
    if (r.every((c) => c === "")) continue;
    const date = parseBankDate(r[cols.date] ?? "");
    let debit = cols.debit >= 0 ? parseBankAmount(r[cols.debit]) : 0;
    let credit = cols.credit >= 0 ? parseBankAmount(r[cols.credit]) : 0;
    if (cols.debit < 0 && cols.credit < 0 && cols.amount >= 0) {
      const amt = parseBankAmount(r[cols.amount]);
      const raw = (r[cols.amount] ?? "").trim();
      const side = cols.drcr >= 0 ? (r[cols.drcr] ?? "").toLowerCase() : raw.startsWith("-") || /dr/i.test(raw) ? "dr" : "cr";
      debit = side.startsWith("d") ? amt : 0;
      credit = side.startsWith("d") ? 0 : amt;
    }
    if (!date || debit == null || credit == null || (debit > 0) === (credit > 0)) {
      skipped++;
      continue;
    }
    const balance = cols.balance >= 0 ? parseBankAmount(r[cols.balance]) : null;
    lines.push({
      date,
      description: (r[cols.desc] ?? "").replace(/\s+/g, " ").trim() || "—",
      reference: cols.ref >= 0 ? r[cols.ref]?.trim() || null : null,
      debitPaise: debit,
      creditPaise: credit,
      balancePaise: balance && balance > 0 ? balance : null,
    });
  }
  return { lines, skipped, problem: lines.length ? null : "The header was found but no row under it had a date and an amount." };
}

/** The same line imported twice is one line: date, amounts, reference and description, normalised. */
export function bankLineKey(l: BankLineIn): string {
  return [l.date, l.debitPaise, l.creditPaise, nameKey(l.reference), nameKey(l.description).slice(0, 80), l.balancePaise ?? ""].join("|");
}

export type MatchCandidate<T> = { t: T; score: "exact" | "amount" | "near"; days: number; left: number };

/**
 * The transactions that could explain a bank line on one account: money out
 * of the account for a debit, into it for a credit, live, not already fully
 * matched. EXACT — the amount agrees and the line names the transaction's
 * reference; AMOUNT — the amount agrees within the window; NEAR — part of the
 * line (a split), within the window. Strongest first, then nearest in date.
 */
export function matchCandidates<T extends MoneyTxnLike & { reference: string | null }>(
  line: { accountId: string; date: string; description: string; reference: string | null; debitPaise: number; creditPaise: number },
  txns: T[],
  matchedOf: (txnId: string) => number,
  windowDays = 7,
): MatchCandidate<T>[] {
  const out = line.debitPaise > 0;
  const amount = out ? line.debitPaise : line.creditPaise;
  const hay = nameKey(`${line.description} ${line.reference ?? ""}`);
  const res: MatchCandidate<T>[] = [];
  for (const t of txns) {
    if (t.status !== "active") continue;
    if (out ? t.fromAccountId !== line.accountId : t.toAccountId !== line.accountId) continue;
    const left = t.amountPaise - matchedOf(t.id);
    if (left <= 0) continue;
    const days = Math.abs(dayDiff(t.date, line.date));
    const ref = nameKey(t.reference);
    if (left === amount && ref.length >= 4 && hay.includes(ref)) res.push({ t, score: "exact", days, left });
    else if (days > windowDays) continue;
    else if (left === amount) res.push({ t, score: "amount", days, left });
    else if (left < amount) res.push({ t, score: "near", days, left });
  }
  const rank = { exact: 0, amount: 1, near: 2 };
  return res.sort((a, b) => rank[a.score] - rank[b.score] || a.days - b.days || a.t.txnNo - b.t.txnNo);
}

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86_400_000);
}

/**
 * Whether a set of transactions may explain a line: every part positive and no
 * more than each transaction still has unmatched, adding up to the line
 * exactly. A split that does not add up is refused, in words.
 */
export function splitRefusal(lineAmount: number, parts: { amountPaise: number; left: number }[]): string | null {
  if (!parts.length) return "Choose at least one transaction.";
  if (parts.some((p) => !(p.amountPaise > 0))) return "Every part must be more than ₹0.";
  if (parts.some((p) => p.amountPaise > p.left)) return "A part is more than that transaction has left to match.";
  const sum = parts.reduce((s, p) => s + p.amountPaise, 0);
  if (sum !== lineAmount) return `The parts add up to ₹${(sum / 100).toLocaleString("en-IN")}, the line is ₹${(lineAmount / 100).toLocaleString("en-IN")}.`;
  return null;
}

/* --------------------------------------------------------------- paid from */

/** The two petty-cash sources that are not an account of their own: they are Cash in Hand, traced to where the cash came from. */
export const FROM_CUSTOMER_CASH = "Cash from a customer";
export const FROM_WITHDRAWAL = "Cash withdrawn from a bank";

/** Whether a review is needed for a new expense: petty cash always, an office expense above the limit. */
export function reviewFor(x: { petty: boolean; advance: boolean; amountPaise: number }, approvalAbovePaise: number): Review {
  if (x.petty || x.advance) return "to_review";
  return approvalAbovePaise > 0 && x.amountPaise > approvalAbovePaise ? "to_review" : "none";
}
