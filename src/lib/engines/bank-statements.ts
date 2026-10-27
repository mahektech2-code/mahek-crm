/* ---------------------------------------------------------------------------
 * BANK STATEMENT MANAGEMENT — the rules, pure.
 *
 * A bank's PDF is read by a model into rows (`services/bank-statement-reader`).
 * Everything after that is arithmetic and comparison, and lives here so it is
 * tested without a database or a model:
 *
 *  - THE CHECK. Opening + credits − debits must equal the printed closing, and
 *    every printed running balance must follow from the one before. A row
 *    where it does not is where the reading (or the statement) is wrong.
 *  - ALREADY IN. A statement is uploaded two or three times a day and each
 *    download overlaps the last, so a row the account already holds is
 *    skipped, never imported twice.
 *  - SUGGESTIONS. What could explain a line: a customer receipt somebody
 *    reported, a customer's open bill, a vendor payout, a Petty Cash
 *    transaction, a transfer between our own accounts, a bank charge. Only a
 *    strong one is suggested; the rest are offered beside it. Nothing moves
 *    money without a person.
 *  - FLAGS. Why a line must be looked at by a person: a returned cheque, less
 *    money than was reported, the same UTR twice, a large unexplained credit,
 *    a balance that breaks, a figure the reading was unsure of.
 * ------------------------------------------------------------------------- */


import { signedMoney } from "../format";

/* ------------------------------------------------------------- rows read */

/** One line as read from the PDF, in paise. */
export type ReadRow = {
  lineNo: number;
  page: number | null;
  /** YYYY-MM-DD. */
  date: string;
  narration: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  /** 0–100: how sure the reading was of this line's figures. */
  confidence: number;
};

/** A row after the check: whether the account already holds it, and whether the balance broke on it. */
export type CheckedRow = ReadRow & {
  existing: boolean;
  /** When it was first imported, where it is already in. */
  existingFrom: string | null;
  breakHere: boolean;
  lowConfidence: boolean;
  /** A figure a person changed before import. */
  edited?: boolean;
};

export const toPaise = (rupees: number | null | undefined): number | null =>
  rupees == null || !Number.isFinite(rupees) ? null : Math.round(rupees * 100);

/* --------------------------------------------------------------- the check */

export type BalanceCheck = {
  openingPaise: number | null;
  closingPaise: number | null;
  credits: number;
  creditCount: number;
  debits: number;
  debitCount: number;
  /** Opening + credits − debits. Null without an opening. */
  workedPaise: number | null;
  /** The printed closing agrees with the worked one, and no running balance breaks. */
  ok: boolean;
  /** Line numbers whose printed balance does not follow from the one before. */
  breaks: number[];
};

/**
 * Checks a statement's arithmetic. The opening is the printed one, or worked
 * back from the first line's balance where the statement prints none; the
 * closing is the printed one, or the last line's balance.
 */
export function checkBalances(rows: ReadRow[], openingPaise: number | null, closingPaise: number | null): BalanceCheck {
  let credits = 0;
  let debits = 0;
  let creditCount = 0;
  let debitCount = 0;
  for (const r of rows) {
    if (r.creditPaise > 0) {
      credits += r.creditPaise;
      creditCount++;
    }
    if (r.debitPaise > 0) {
      debits += r.debitPaise;
      debitCount++;
    }
  }
  const first = rows[0];
  const opening = openingPaise ?? (first && first.balancePaise != null ? first.balancePaise - first.creditPaise + first.debitPaise : null);
  const last = [...rows].reverse().find((r) => r.balancePaise != null);
  const closing = closingPaise ?? last?.balancePaise ?? null;
  const breaks: number[] = [];
  let prev = opening;
  for (const r of rows) {
    if (r.balancePaise == null) {
      prev = prev == null ? null : prev + r.creditPaise - r.debitPaise;
      continue;
    }
    if (prev != null && prev + r.creditPaise - r.debitPaise !== r.balancePaise) breaks.push(r.lineNo);
    prev = r.balancePaise;
  }
  const worked = opening == null ? null : opening + credits - debits;
  const ok = breaks.length === 0 && (worked == null || closing == null || worked === closing);
  return { openingPaise: opening, closingPaise: closing, credits, creditCount, debits, debitCount, workedPaise: worked, ok, breaks };
}

/**
 * Banks print newest first or oldest first. The rows are put oldest first —
 * the order a running balance can be checked in — choosing whichever order
 * the balances agree with, and the dates where no balance is printed.
 */
export function inStatementOrder(rows: ReadRow[], openingPaise: number | null): ReadRow[] {
  if (rows.length < 2) return rows.map((r, i) => ({ ...r, lineNo: i + 1 }));
  const fwd = rows.map((r, i) => ({ ...r, lineNo: i + 1 }));
  const rev = [...rows].reverse().map((r, i) => ({ ...r, lineNo: i + 1 }));
  const a = checkBalances(fwd, openingPaise, null).breaks.length;
  const b = checkBalances(rev, openingPaise, null).breaks.length;
  if (a !== b) return a < b ? fwd : rev;
  return rows[0].date <= rows[rows.length - 1].date ? fwd : rev;
}

/* ----------------------------------------------------------- already in */

const alnum = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The key a line is stored under: one line is one line however many PDFs show it. */
export function pdfLineKey(r: Pick<ReadRow, "date" | "debitPaise" | "creditPaise" | "balancePaise" | "reference" | "narration">): string {
  return r.balancePaise != null
    ? ["pdf", r.date, r.debitPaise, r.creditPaise, r.balancePaise].join("|")
    : ["pdf", r.date, r.debitPaise, r.creditPaise, alnum(r.reference), alnum(r.narration).slice(0, 60)].join("|");
}

export type HeldLine = { date: string; debitPaise: number; creditPaise: number; balancePaise: number | null; reference: string | null; description: string; createdAt: string };

/**
 * Whether the account already holds this row. With balances on both, the
 * date, the amount and the balance decide — two readings of the same line
 * may wrap the narration differently, and the balance is the bank's own
 * fingerprint of the line. Without one, the reference and then the words.
 */
export function sameLine(r: Pick<ReadRow, "date" | "debitPaise" | "creditPaise" | "balancePaise" | "reference" | "narration">, h: HeldLine): boolean {
  if (r.date !== h.date || r.debitPaise !== h.debitPaise || r.creditPaise !== h.creditPaise) return false;
  if (r.balancePaise != null && h.balancePaise != null) return r.balancePaise === h.balancePaise;
  const ra = alnum(r.reference);
  if (ra.length >= 4 && ra === alnum(h.reference)) return true;
  return alnum(r.narration).slice(0, 40) === alnum(h.description).slice(0, 40);
}

/** The check run over a reading: which rows are already in, where the balance breaks, which figures are unsure. */
export function checkRows(rows: ReadRow[], held: HeldLine[], breaks: number[], lowConfidence: number): CheckedRow[] {
  const used = new Set<number>();
  return rows.map((r) => {
    const i = held.findIndex((h, k) => !used.has(k) && sameLine(r, h));
    if (i >= 0) used.add(i);
    return {
      ...r,
      existing: i >= 0,
      existingFrom: i >= 0 ? held[i].createdAt : null,
      breakHere: breaks.includes(r.lineNo),
      lowConfidence: r.confidence < lowConfidence,
    };
  });
}

/* ------------------------------------------------------------ the banks */

/** The letter and colour a bank is drawn with — its own brand colour where we know it. */
export function bankMark(name: string | null | undefined): { letters: string; color: string } {
  const n = (name ?? "").toLowerCase();
  if (n.includes("kotak")) return { letters: "K", color: "#e4002b" };
  if (n.includes("icici")) return { letters: "IC", color: "#ae282e" };
  if (n.includes("hdfc")) return { letters: "H", color: "#004c8f" };
  if (n.includes("sbi") || n.includes("state bank")) return { letters: "SB", color: "#2a73b8" };
  if (n.includes("axis")) return { letters: "A", color: "#97144d" };
  if (n.includes("yes")) return { letters: "Y", color: "#0062a8" };
  if (n.includes("bank of baroda") || n.includes("bob")) return { letters: "BB", color: "#f15a22" };
  if (n.includes("idfc")) return { letters: "ID", color: "#9c1d26" };
  if (n.includes("indusind")) return { letters: "IN", color: "#7a2531" };
  if (n.includes("union")) return { letters: "U", color: "#d61f26" };
  if (n.includes("canara")) return { letters: "C", color: "#0091d0" };
  if (n.includes("cash")) return { letters: "C", color: "#1d7a45" };
  const words = (name ?? "?").replace(/bank|ltd|limited/gi, "").trim().split(/\s+/).filter(Boolean);
  return { letters: (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase(), color: "#6835fb" };
}

/* ------------------------------------------------------------- matching */

export type LineIn = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  confidence: number | null;
  breakHere: boolean;
};

export type ReceiptIn = {
  id: string;
  label: string;
  customerId: string;
  customer: string;
  amountPaise: number;
  reference: string | null;
  mode: string;
  /** The date on a cheque, else the day it was received. */
  date: string;
  status: "reported" | "held" | "confirmed";
  holdReason: string | null;
  reportedBy: string | null;
  /** The bills it names, for the sentence. */
  bills: string | null;
};

export type BillIn = { id: string; billNo: string; billDate: string; dueDate: string | null; balancePaise: number };
export type CustomerIn = { id: string; name: string; bills: BillIn[] };
export type PayoutIn = { id: string; label: string; payee: string; amountPaise: number; payOn: string; dueDate: string; billNos: string | null; prNumber: number | null; status: "open" | "on_hold" | "paid"; description: string | null };
export type TxnIn = { id: string; label: string; kind: string; party: string; amountPaise: number; date: string; reference: string | null; out: boolean; accountId: string };
export type AccountIn = { id: string; name: string; bankName: string | null; last4: string | null; kind: string };

export type MatchData = {
  receipts: ReceiptIn[];
  customers: CustomerIn[];
  payouts: PayoutIn[];
  txns: TxnIn[];
  accounts: AccountIn[];
  /** Every other line, for the same reference twice and the other side of a transfer. */
  lines: Pick<LineIn, "id" | "accountId" | "date" | "reference" | "debitPaise" | "creditPaise">[];
};

export type MatchKind = "receipt" | "bill" | "payout" | "txn" | "transfer" | "charges" | "interest";

export type Reason = { t: string; ok: boolean };

export type Candidate = {
  kind: MatchKind;
  /** The receipt, bill, payout or transaction. The other account, for a transfer. Null for charges and interest. */
  id: string | null;
  label: string;
  sub: string;
  amountPaise: number;
  strength: "strong" | "likely";
  reasons: Reason[];
  customerId?: string;
  /** For a transfer: the other account. */
  counterAccountId?: string;
};

export type Settings = { windowDays: number; lowConfidence: number; largeCreditPaise: number };

const STOP = new Set(["ms", "m", "s", "pvt", "ltd", "private", "limited", "the", "and", "co", "llp", "inc", "corp"]);

/** A party's name as it can appear inside a bank narration: letters and digits, no company suffixes. */
export function partyKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join("");
}

/** A reference as it can appear in a narration. */
const refKey = alnum;

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86_400_000);
}

/* Paise where there are any — a statement line is never rounded. */
const inr = (p: number) => signedMoney(p);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-17" → "17 Oct". */
export function dayName(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

function dateReason(days: number): string {
  if (days === 0) return "Same day";
  const n = Math.abs(days);
  return `${n} day${n === 1 ? "" : "s"} ${days > 0 ? "after" : "before"}`;
}

const CHARGES = /\b(charges?|chgs?|chrg|commission|comm|sms\s*chg|gst on|service\s*charge|annual\s*fee|min\s*bal|amc|debit card fee|imps chg|neft chg)\b/i;
const INTEREST = /\b(int\.?\s*cr|interest|int\s*credit|int\.?\s*pd)\b/i;
const RETURNED = /\b(rtn|return(ed)?|bounce[d]?|dishono[u]?r(ed)?|insuff(icient)?|unpaid|chq\s*ret)\b/i;
const OWN_TRANSFER = /\b(own\s*a\/?c|self|trf to own|own account|sweep|internal transfer)\b/i;

/** The words of a narration with every number kept, for finding a reference or a cheque number in it. */
const hayOf = (l: Pick<LineIn, "description" | "reference">) => alnum(`${l.description} ${l.reference ?? ""}`);

/**
 * Everything that could explain one line, strongest first. A STRONG candidate
 * is one a person would accept on sight: the reference and the amount agree,
 * or the amount and the party's name agree within the window.
 */
export function candidatesFor(line: LineIn, data: MatchData, s: Settings): Candidate[] {
  const out: Candidate[] = [];
  const credit = line.creditPaise > 0;
  const amount = credit ? line.creditPaise : line.debitPaise;
  const hay = hayOf(line);
  const own = data.accounts.find((a) => a.id === line.accountId);

  if (credit) {
    /* Money a telecaller or accounts already wrote down. */
    for (const r of data.receipts) {
      const ref = refKey(r.reference);
      const refEq = ref.length >= 4 && hay.includes(ref);
      const amountEq = r.amountPaise === amount;
      const name = partyKey(r.customer);
      const nameIn = name.length >= 5 && hay.includes(name);
      const days = dayDiff(line.date, r.date);
      const near = Math.abs(days) <= s.windowDays;
      if (!refEq && !(amountEq && near) && !(nameIn && near)) continue;
      const strong = (refEq && amountEq) || (amountEq && nameIn && near);
      const reasons: Reason[] = [];
      if (refEq) reasons.push({ t: /cheque|chq/i.test(r.mode) ? "Cheque no. equal" : "UTR equal", ok: true });
      reasons.push(amountEq ? { t: "Amount equal", ok: true } : { t: `Amount differs (${inr(r.amountPaise)})`, ok: false });
      if (nameIn) reasons.push({ t: "Name in narration", ok: true });
      reasons.push({ t: dateReason(days), ok: near });
      out.push({
        kind: "receipt",
        id: r.id,
        label: `${r.label} · ${r.customer}`,
        sub: [
          r.status === "confirmed" ? "Confirmed, not yet seen in the bank" : `${r.status === "held" ? "Held" : "Reported"}${r.reportedBy ? ` by ${r.reportedBy.split(" ")[0]}` : ""} on ${dayName(r.date)}`,
          r.mode,
          r.reference ? `ref ${r.reference}` : null,
          r.bills ? `against ${r.bills}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        amountPaise: r.amountPaise,
        strength: strong ? "strong" : "likely",
        reasons,
        customerId: r.customerId,
      });
    }

    /* A customer named in the narration, and their open bills. */
    for (const c of data.customers) {
      const name = partyKey(c.name);
      if (name.length < 5 || !hay.includes(name)) continue;
      const exact = c.bills.filter((b) => b.balancePaise === amount);
      const shown = exact.length ? exact : c.bills.slice(0, 1);
      for (const b of shown) {
        const amountEq = b.balancePaise === amount;
        out.push({
          kind: "bill",
          id: b.id,
          label: `Open bill ${b.billNo} · ${c.name}`,
          sub: `Billed ${dayName(b.billDate)}${b.dueDate ? ` · due ${dayName(b.dueDate)}` : ""} · nothing reported`,
          amountPaise: b.balancePaise,
          strength: amountEq && exact.length === 1 ? "strong" : "likely",
          reasons: [{ t: "Name in narration", ok: true }, amountEq ? { t: "Amount equal", ok: true } : { t: `Amount differs (${inr(b.balancePaise)})`, ok: false }],
          customerId: c.id,
        });
      }
    }

    if (INTEREST.test(line.description)) {
      out.push({ kind: "interest", id: null, label: "Interest earned", sub: `Interest credited by ${own?.bankName ?? own?.name ?? "the bank"}`, amountPaise: amount, strength: "strong", reasons: [{ t: "Interest in narration", ok: true }] });
    }
  } else {
    /* What we owe suppliers. */
    for (const p of data.payouts) {
      const amountEq = p.amountPaise === amount;
      const name = partyKey(p.payee);
      const nameIn = name.length >= 5 && hay.includes(name);
      const bills = (p.billNos ?? "").split(/[,\s]+/).map(refKey).filter((b) => b.length >= 3);
      const billIn = bills.find((b) => hay.includes(b));
      const days = dayDiff(line.date, p.payOn);
      const near = Math.abs(days) <= s.windowDays;
      if (!(amountEq && (nameIn || near)) && !(nameIn && near)) continue;
      const strong = amountEq && (nameIn || !!billIn);
      const reasons: Reason[] = [amountEq ? { t: "Amount equal", ok: true } : { t: "Amount differs", ok: false }];
      if (nameIn) reasons.push({ t: "Vendor in narration", ok: true });
      if (billIn) reasons.push({ t: `Bill no. ${(p.billNos ?? "").split(/[,\s]+/).find((b) => refKey(b) === billIn)}`, ok: true });
      reasons.push({ t: days === 0 ? "Planned today" : `Planned ${dayName(p.payOn)}`, ok: near });
      out.push({
        kind: "payout",
        id: p.id,
        label: `Vendor payout ${p.label} · ${p.payee}`,
        sub: [p.billNos ? `bills ${p.billNos}` : p.description, `planned ${dayName(p.payOn)}`, `due ${dayName(p.dueDate)}`, p.status === "on_hold" ? "on hold" : null].filter(Boolean).join(" · "),
        amountPaise: p.amountPaise,
        strength: strong ? "strong" : "likely",
        reasons,
      });
    }

    if (CHARGES.test(line.description) && !RETURNED.test(line.description)) {
      out.push({ kind: "charges", id: null, label: "Bank charges", sub: `Charged by ${own?.bankName ?? own?.name ?? "the bank"}`, amountPaise: amount, strength: "strong", reasons: [{ t: "Charges in narration", ok: true }] });
    }
  }

  /* Petty Cash transactions already entered against this account. */
  for (const t of data.txns) {
    if (t.accountId !== line.accountId || t.out === credit) continue;
    const ref = refKey(t.reference);
    const refEq = ref.length >= 4 && hay.includes(ref);
    const amountEq = t.amountPaise === amount;
    const days = dayDiff(line.date, t.date);
    const near = Math.abs(days) <= s.windowDays;
    if (!amountEq || (!refEq && !near)) continue;
    out.push({
      kind: "txn",
      id: t.id,
      label: `${t.label} · ${t.party}`,
      sub: `Petty Cash ${t.kind} · ${dayName(t.date)}${t.reference ? ` · ref ${t.reference}` : ""}`,
      amountPaise: t.amountPaise,
      strength: refEq || (near && Math.abs(days) <= 2) ? "strong" : "likely",
      reasons: [...(refEq ? [{ t: "Reference equal", ok: true }] : []), { t: "Amount equal", ok: true }, { t: dateReason(days), ok: near }],
    });
  }

  /* Our own money moving between our own accounts. */
  for (const a of data.accounts) {
    if (a.id === line.accountId || a.kind !== "bank") continue;
    const last4 = (a.last4 ?? "").replace(/\D/g, "");
    const named = (last4.length >= 3 && hay.includes(last4)) || (a.bankName ? hay.includes(alnum(a.bankName).slice(0, 5)) : false);
    const other = data.lines.find((o) => o.accountId === a.id && Math.abs(dayDiff(o.date, line.date)) <= 1 && (credit ? o.debitPaise === amount : o.creditPaise === amount));
    if (!other && !(named && OWN_TRANSFER.test(line.description))) continue;
    out.push({
      kind: "transfer",
      id: a.id,
      label: `Transfer ${credit ? "from" : "to"} ${a.name}${a.last4 ? ` ··${a.last4}` : ""}`,
      sub: other ? `The ${a.name} statement shows the other side on ${dayName(other.date)}` : "Our own account named in the narration",
      amountPaise: amount,
      strength: other ? "strong" : named ? "strong" : "likely",
      reasons: [...(other ? [{ t: "Other side found", ok: true }] : []), ...(named ? [{ t: "Own account in narration", ok: true }] : []), { t: "Amount equal", ok: true }],
      counterAccountId: a.id,
    });
  }

  const rank = { strong: 0, likely: 1 };
  const kindRank: Record<MatchKind, number> = { receipt: 0, payout: 0, txn: 1, transfer: 2, bill: 3, charges: 4, interest: 4 };
  return out.sort((a, b) => rank[a.strength] - rank[b.strength] || kindRank[a.kind] - kindRank[b.kind] || b.reasons.filter((r) => r.ok).length - a.reasons.filter((r) => r.ok).length);
}

/** The one candidate worth suggesting: the strongest, and only where nothing else is as strong. */
export function bestSuggestion(c: Candidate[]): Candidate | null {
  const strong = c.filter((x) => x.strength === "strong");
  if (!strong.length) return null;
  if (strong.length > 1 && strong[1].kind === strong[0].kind && strong[1].reasons.filter((r) => r.ok).length === strong[0].reasons.filter((r) => r.ok).length) return null;
  return strong[0];
}

/* ---------------------------------------------------------------- flags */

export const BANK_FLAGS = {
  balance: "Balance breaks here",
  low_conf: "AI unsure of a figure",
  returned: "Cheque returned",
  dup_ref: "Same UTR twice",
  short: "Less than reported",
  held: "Customer is held",
  large: "Large, no match",
} as const;
export type BankFlag = keyof typeof BANK_FLAGS;

export type FlagResult = { flag: BankFlag; note: string; receiptId?: string } | null;

/**
 * Why a person must look at this line before anything is matched, or null.
 * The first that applies wins: a figure that may be wrong comes before
 * anything decided from it.
 */
export function flagFor(line: LineIn, cands: Candidate[], data: MatchData, s: Settings, confirmed: ReceiptIn[]): FlagResult {
  const credit = line.creditPaise > 0;
  const amount = credit ? line.creditPaise : line.debitPaise;
  const hay = hayOf(line);
  if (line.breakHere) return { flag: "balance", note: "The printed balance does not follow from the line before. Check this line against the PDF." };
  if (line.confidence != null && line.confidence < s.lowConfidence) return { flag: "low_conf", note: `Read at ${line.confidence}%. Check the date and the amount against the PDF.` };
  if (!credit && RETURNED.test(line.description)) {
    const nums: string[] = [...(line.description.match(/\d{6}/g) ?? []), ...(line.reference ? [line.reference] : [])];
    const r = confirmed.find((x) => x.reference && nums.some((n) => refKey(n) === refKey(x.reference)));
    return r
      ? { flag: "returned", note: `${r.label} was confirmed on ${dayName(r.date)} for this cheque · ${r.customer}`, receiptId: r.id }
      : { flag: "returned", note: "A cheque came back. Find the receipt it paid and reverse it." };
  }
  const ref = refKey(line.reference);
  if (ref.length >= 6) {
    /* The same side only: our own transfer carries one UTR on the debit of one account and the credit of the other. */
    const twin = data.lines.find((o) => o.id !== line.id && refKey(o.reference) === ref && (credit ? o.creditPaise === amount : o.debitPaise === amount));
    if (twin) {
      const where = data.accounts.find((a) => a.id === twin.accountId);
      return { flag: "dup_ref", note: `Also on ${where && twin.accountId !== line.accountId ? `the ${where.name} line` : "the line"} of ${dayName(twin.date)} · possible double entry` };
    }
  }
  if (credit) {
    const short = data.receipts.find((r) => {
      const k = refKey(r.reference);
      return k.length >= 4 && hay.includes(k) && r.amountPaise > amount;
    });
    if (short) return { flag: "short", note: `${short.label} reported ${inr(short.amountPaise)} · ${inr(short.amountPaise - amount)} short`, receiptId: short.id };
  }
  const best = bestSuggestion(cands);
  if (best?.kind === "receipt" && best.id) {
    const r = data.receipts.find((x) => x.id === best.id);
    if (r?.status === "held") return { flag: "held", note: `${r.label} is on hold${r.holdReason ? ` — “${r.holdReason}”` : ""}`, receiptId: r.id };
  }
  if (credit && amount >= s.largeCreditPaise && !best) return { flag: "large", note: `Over ${inr(s.largeCreditPaise)} with no receipt or bill near it` };
  return null;
}

/* ---------------------------------------------------------------- state */

export type LineState = "matched" | "ignored" | "flagged" | "suggested" | "unmatched";

export function lineState(l: { status: string; matchedPaise: number; amountPaise: number; flag: string | null; suggestion: unknown }): LineState {
  if (l.status === "ignored") return "ignored";
  if (l.matchedPaise >= l.amountPaise && l.amountPaise > 0) return "matched";
  if (l.flag) return "flagged";
  if (l.suggestion) return "suggested";
  return "unmatched";
}

/* -------------------------------------------------------- marking by hand */

/** What a line can be marked as by hand, by side. */
export const MARK_IN = [
  { v: "customer_payment", l: "Customer payment", s: "Against their bills or on account" },
  { v: "transfer", l: "Transfer from our account", s: "Kotak, ICICI, HDFC, SBI, cash" },
  { v: "other_in", l: "Other money in", s: "Interest, refund, scrap sale, loan…" },
] as const;
export const MARK_OUT = [
  { v: "vendor_payment", l: "Vendor payment", s: "Against a payout to a supplier" },
  { v: "expense", l: "Expense", s: "Rent, electricity, freight…" },
  { v: "salary", l: "Salary", s: "Wages and salaries" },
  { v: "tax", l: "GST / TDS", s: "Tax paid to the government" },
  { v: "charges", l: "Bank charges", s: "Fees, GST on charges" },
  { v: "transfer", l: "Transfer to our account", s: "Kotak, ICICI, HDFC, SBI, cash" },
  { v: "other_out", l: "Other money out", s: "Loan repayment, refund…" },
] as const;
export type MarkKind = (typeof MARK_IN)[number]["v"] | (typeof MARK_OUT)[number]["v"];

/** The Petty Cash category a hand-marked debit is entered under. */
export const MARK_CATEGORY: Partial<Record<MarkKind, string>> = { salary: "Salary", tax: "GST / TDS", charges: "Bank charges", other_out: "Other" };

/** The parts of a cheque number or UTR worth showing: what a narration carries after CHQ, UTR, REF. */
export function guessMode(description: string): string {
  const d = description.toUpperCase();
  if (/\bRTGS\b/.test(d)) return "RTGS";
  if (/\bNEFT\b/.test(d)) return "NEFT";
  if (/\bIMPS\b/.test(d)) return "IMPS";
  if (/\bUPI\b/.test(d)) return "UPI";
  if (/\b(CHQ|CHEQUE|CLG)\b/.test(d)) return "Cheque";
  if (/\bCASH\b/.test(d)) return "Cash";
  return "Bank transfer";
}
