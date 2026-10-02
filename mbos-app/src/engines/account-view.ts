import { buildStatement, countsAsMoney, type StatementBill, type StatementReceipt } from './statement';
import type { BadgeTone } from '../theme/tokens';

/**
 * A CUSTOMER'S WHOLE ACCOUNT, as the Accounts app holds it — on the handset.
 *
 * The office answers `/api/mbos/customer-account` with exactly what the
 * Accounts app's customer account is built from: the statement
 * (`ledgerForCustomer`), every bill (`listBills`), every receipt and where it
 * went, the aging strip, credit notes, the follow-up stage and how the account
 * is served. This file is the SHAPE of that answer and the handful of things a
 * screen does to it — cut a window, filter a list, say a status in words —
 * and nothing in it recomputes a figure the office sent.
 *
 * With no signal the screen still has something true to say: the pull keeps a
 * thirteen-month window of the same bills and receipts on the phone, and
 * `fromPhone` puts those into the same shape, with every part the phone cannot
 * know set to null rather than guessed. `source` says which one is on the
 * screen, and the screen says it out loud.
 *
 * PURE, like every engine here: the arithmetic a salesman reads out to a
 * shopkeeper is exactly the thing that has to be testable without a handset.
 */

export type AccountEntry = {
  at: string;
  kind: 'bill' | 'receipt';
  ref: string;
  detail: string;
  debitPaise: number;
  creditPaise: number;
  status: string | null;
  claimedPaise: number;
  receiptId: string | null;
  /** Running balance after this line. Confirmed money only. */
  balancePaise: number;
};

export type AccountBill = {
  id: string;
  billNo: string;
  billDate: string;
  dueDate: string | null;
  amountPaise: number;
  paidPaise: number;
  balancePaise: number;
  overdueDays: number;
  bucket: string | null;
  status: string;
  disputed: boolean;
  paymentPosition: string;
  claimedPaise: number;
  lines: { product: string; qty: number; amountPaise: number | null }[];
  /** Null on the phone's own copy, which does not know where money went. */
  payments: { receiptId: string; at: string; amountPaise: number; mode: string; status: string }[] | null;
};

export type AccountReceipt = {
  id: string;
  receiptNo: string | null;
  receivedAt: string;
  instrumentDate: string | null;
  amountPaise: number;
  mode: string;
  reference: string | null;
  status: string;
  source: string | null;
  note: string | null;
  sentence: string;
  /** Null on the phone's own copy. */
  allocations: { billNo: string | null; amountPaise: number }[] | null;
  onAccountPaise: number;
  reportedBy: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  holdReason: string | null;
  rejectReason: string | null;
};

export type AccountCreditNote = {
  id: string;
  at: string;
  category: string;
  description: string;
  amountPaise: number | null;
  status: string;
  reference: string | null;
  cnDate: string | null;
  billNo: string | null;
  raisedBy: string | null;
};

export type AccountView = {
  /** Whose answer this is — see the file header. */
  source: 'office' | 'phone';
  /** When the office answered, as ms. The phone's copy carries its last sync. */
  readAtMs: number;
  asOf: string;
  customer: {
    id: string;
    name: string;
    kind: string | null;
    thirdParty: boolean;
    city: string | null;
    phone: string | null;
    gstin: string | null;
    outstandingPaise: number;
    creditLimitPaise: number | null;
    creditDays: number | null;
    creditDaysIsDefault: boolean;
    creditBlocked: boolean;
    creditBlockReason: string | null;
    slowPayer: boolean | null;
    lastOrderDate: string | null;
    salesPersonName: string | null;
    backOfficeName: string | null;
  };
  followUp: {
    stage: number;
    daysOverdue: number;
    totalOverduePaise: number;
    overdueBillCount: number;
    oldestOverdueBillDate: string | null;
    held: boolean;
    heldReason: string | null;
  } | null;
  serving: {
    thirdParty: boolean;
    distributors: { name: string; isPrimary: boolean }[];
    shops: number;
  } | null;
  ledger: {
    /** Null where the phone cannot know it. */
    onAccountPaise: number | null;
    awaitingCount: number;
    awaitingPaise: number;
    /** Oldest first, as the balance was computed. */
    entries: AccountEntry[];
  };
  aging: { totalPaise: number; bills: number; buckets: { label: string; from: number; amountPaise: number }[] } | null;
  unstated: { count: number; amountPaise: number };
  /** Newest first. */
  bills: AccountBill[];
  /** Newest first. */
  receipts: AccountReceipt[];
  /** Null on the phone's copy: credit notes do not travel on the pull. */
  creditNotes: AccountCreditNote[] | null;
};

/* --------------------------------------------------------------- the phone */

type PhoneCustomer = {
  id: string;
  name: string;
  kind?: string | null;
  thirdParty: number;
  city: string | null;
  phone: string | null;
  gstin: string | null;
  outstandingPaise: number;
  creditLimitPaise: number | null;
  creditDays: number | null;
  creditBlocked: number;
  creditBlockReason: string | null;
  lastOrderDate: string | null;
  distributors: string | null;
  lastSyncedAt: number;
};

type PhoneBill = StatementBill & { lines: string | null };
type PhoneReceipt = StatementReceipt;

/**
 * The account from what this phone holds, in the office's shape.
 *
 * Every part the pull does not carry is null rather than zero — "nothing on
 * account" and "this phone does not know" are different sentences, and the
 * screen has one for each. The statement is `buildStatement`, the engine the
 * customer record's own Account tab already uses, so the two screens on this
 * phone cannot disagree about one shop.
 */
export function fromPhone(
  c: PhoneCustomer,
  bills: PhoneBill[],
  receipts: PhoneReceipt[],
  today: string,
  parseLines: (b: PhoneBill) => AccountBill['lines'],
): AccountView {
  const statement = buildStatement(bills, receipts);
  /* `buildStatement` hands entries back newest first, for reading. The view
     keeps them oldest first, as the office sends them. */
  const entries: AccountEntry[] = [...statement.entries].reverse().map((e) =>
    e.kind === 'bill'
      ? {
          at: e.at,
          kind: 'bill' as const,
          ref: e.bill.billNo ?? '—',
          detail: e.bill.disputed ? 'Bill raised · disputed' : 'Bill raised',
          debitPaise: e.bill.amountPaise ?? 0,
          creditPaise: 0,
          status: e.bill.status,
          claimedPaise: 0,
          receiptId: null,
          balancePaise: e.balancePaise,
        }
      : {
          at: e.at,
          kind: 'receipt' as const,
          ref: e.receipt.reference ?? e.receipt.mode ?? '—',
          detail: phoneSentence(e.receipt),
          debitPaise: 0,
          creditPaise: countsAsMoney(e.receipt.status) ? e.receipt.amountPaise ?? 0 : 0,
          status: e.receipt.status,
          claimedPaise: 0,
          receiptId: e.receipt.id,
          balancePaise: e.balancePaise,
        },
  );

  const distributors = parseDistributors(c.distributors);
  const unstated = bills.filter((b) => b.paymentPosition === 'unstated');

  return {
    source: 'phone',
    readAtMs: c.lastSyncedAt,
    asOf: today,
    customer: {
      id: c.id,
      name: c.name,
      kind: c.kind ?? null,
      thirdParty: !!c.thirdParty,
      city: c.city,
      phone: c.phone,
      gstin: c.gstin,
      outstandingPaise: c.outstandingPaise ?? 0,
      creditLimitPaise: c.creditLimitPaise,
      creditDays: c.creditDays,
      creditDaysIsDefault: c.creditDays == null,
      creditBlocked: !!c.creditBlocked,
      creditBlockReason: c.creditBlockReason,
      slowPayer: null,
      lastOrderDate: c.lastOrderDate,
      salesPersonName: null,
      backOfficeName: null,
    },
    followUp: null,
    serving: c.thirdParty
      ? { thirdParty: true, distributors, shops: 0 }
      : null,
    ledger: {
      onAccountPaise: null,
      awaitingCount: statement.awaitingCount,
      awaitingPaise: statement.awaitingPaise,
      entries,
    },
    aging: null,
    unstated: {
      count: unstated.length,
      amountPaise: unstated.reduce((s, b) => s + (b.amountPaise ?? 0), 0),
    },
    bills: [...bills]
      .sort((a, z) => (z.billDate ?? '').localeCompare(a.billDate ?? ''))
      .map((b) => ({
        id: b.id,
        billNo: b.billNo ?? '—',
        billDate: b.billDate ?? '',
        dueDate: b.dueDate,
        amountPaise: b.amountPaise ?? 0,
        paidPaise: b.paidPaise ?? 0,
        balancePaise: b.balancePaise ?? 0,
        overdueDays: b.overdueDays ?? 0,
        bucket: null,
        status: b.status ?? 'unpaid',
        disputed: !!b.disputed,
        paymentPosition: b.paymentPosition ?? 'stated',
        claimedPaise: 0,
        lines: parseLines(b),
        payments: null,
      })),
    receipts: [...receipts]
      .sort((a, z) => (z.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
      .map((r) => ({
        id: r.id,
        receiptNo: null,
        receivedAt: r.receivedAt ?? '',
        instrumentDate: null,
        amountPaise: r.amountPaise ?? 0,
        mode: r.mode ?? 'Not stated',
        reference: r.reference,
        status: r.status ?? 'reported',
        source: null,
        note: null,
        sentence: phoneSentence(r),
        allocations: null,
        onAccountPaise: 0,
        reportedBy: null,
        confirmedBy: null,
        confirmedAt: null,
        holdReason: null,
        rejectReason: null,
      })),
    creditNotes: null,
  };
}

function parseDistributors(raw: string | null): { name: string; isPrimary: boolean }[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((d) =>
      d && typeof (d as { name?: unknown }).name === 'string'
        ? [{ name: (d as { name: string }).name, isPrimary: !!(d as { isPrimary?: unknown }).isPrimary }]
        : [],
    );
  } catch {
    return [];
  }
}

/** The receipt in words, from the fields the phone holds. */
function phoneSentence(r: PhoneReceipt): string {
  const parts = [!r.mode || r.mode === 'Not stated' ? 'Payment · method not recorded' : r.mode];
  if (r.reference) parts.push(r.reference);
  const word = receiptStatus(r.status).sentence;
  if (word) parts.push(word);
  return parts.join(' · ');
}

/* ------------------------------------------------------------- the window */

export type AccountWindow = {
  /** Newest first — reading order. Each keeps the balance it was given. */
  entries: AccountEntry[];
  openingPaise: number;
  billedPaise: number;
  receivedPaise: number;
};

/**
 * The statement between two dates, cut from entries the office already
 * balanced.
 *
 * The balance on each line is the office's and is NOT recomputed: it ran from
 * the first bill this account ever had, so a line keeps it whatever window it
 * is drawn in. What the window adds is the opening — the balance after the
 * last line BEFORE it, which is what was owed as the window opened — and the
 * two sums inside it. That is exactly `customerLedger`'s own range rule.
 */
export function windowOf(entries: AccountEntry[], range: { from?: string; to?: string }): AccountWindow {
  let opening = 0;
  let billed = 0;
  let received = 0;
  const shown: AccountEntry[] = [];
  for (const e of entries) {
    const dated = e.at !== '';
    if (dated && range.from && e.at < range.from) {
      opening = e.balancePaise;
      continue;
    }
    if (dated && range.to && e.at > range.to) continue;
    billed += e.debitPaise;
    received += e.creditPaise;
    shown.push(e);
  }
  shown.reverse();
  return { entries: shown, openingPaise: opening, billedPaise: billed, receivedPaise: received };
}

/* ------------------------------------------------------------ the filters */

export type BillFilter = 'all' | 'open' | 'overdue' | 'settled' | 'unstated' | 'disputed';

export const BILL_FILTERS: { key: BillFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'settled', label: 'Settled' },
  { key: 'unstated', label: 'Not stated' },
  { key: 'disputed', label: 'Disputed' },
];

/**
 * Which bills a chip means.
 *
 * `open` and `overdue` are STATED bills only: an unstated bill carries its
 * full amount as a balance purely because nobody has said anything about it,
 * and counting it as owed is the imported-book mistake — so it has a chip of
 * its own and is on neither of the money ones.
 */
export function billMatches(b: AccountBill, f: BillFilter): boolean {
  const stated = b.paymentPosition !== 'unstated';
  switch (f) {
    case 'open':
      return stated && b.balancePaise > 0;
    case 'overdue':
      return stated && b.balancePaise > 0 && b.overdueDays > 0;
    case 'settled':
      return stated && b.balancePaise <= 0;
    case 'unstated':
      return !stated;
    case 'disputed':
      return b.disputed;
    case 'all':
    default:
      return true;
  }
}

export type ReceiptFilter = 'all' | 'confirmed' | 'waiting' | 'held' | 'rejected' | 'reversed';

export const RECEIPT_FILTERS: { key: ReceiptFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'waiting', label: 'With accounts' },
  { key: 'held', label: 'On hold' },
  { key: 'rejected', label: 'Never arrived' },
  { key: 'reversed', label: 'Reversed' },
];

export function receiptMatches(r: AccountReceipt, f: ReceiptFilter): boolean {
  if (f === 'all') return true;
  if (f === 'waiting') return r.status === 'reported';
  return r.status === f;
}

/** Matches a typed bill number, reference, receipt number or amount. */
export function matchesText(haystack: (string | number | null | undefined)[], q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return haystack.some((h) => h != null && String(h).toLowerCase().includes(needle));
}

/* -------------------------------------------------------------- the words */

/**
 * A receipt's status in words, and how to draw it.
 *
 * `rejected` and `reversed` are both money that does not count, and they are
 * NOT the same fact: rejected never arrived, reversed arrived and failed — a
 * cheque that cleared and bounced. A customer who genuinely paid must never be
 * told the money was not seen, so the two keep the Accounts app's own words.
 */
export function receiptStatus(status: string | null | undefined): {
  label: string;
  tone: BadgeTone;
  sentence: string;
  counts: boolean;
} {
  switch (status) {
    case 'confirmed':
      return { label: 'Confirmed', tone: 'success', sentence: '', counts: true };
    case 'reported':
      return { label: 'With accounts', tone: 'amber', sentence: 'waiting for accounts', counts: false };
    case 'held':
      return { label: 'On hold', tone: 'amber', sentence: 'on hold with accounts, being checked', counts: false };
    case 'rejected':
      return { label: 'Never arrived', tone: 'danger', sentence: 'never arrived', counts: false };
    case 'reversed':
      return { label: 'Reversed', tone: 'danger', sentence: 'reversed', counts: false };
    default:
      return { label: status ?? 'Unknown', tone: 'neutral', sentence: '', counts: false };
  }
}

/** A bill's position in one word, said the way Accounts says it. */
export function billStatus(b: Pick<AccountBill, 'paymentPosition' | 'balancePaise' | 'paidPaise' | 'overdueDays'>): {
  label: string;
  tone: BadgeTone;
} {
  if (b.paymentPosition === 'unstated') return { label: 'Not stated', tone: 'neutral' };
  if (b.balancePaise <= 0) return { label: 'Settled', tone: 'success' };
  if (b.overdueDays > 0) return { label: `${b.overdueDays}d overdue`, tone: 'danger' };
  if (b.paidPaise > 0) return { label: 'Part paid', tone: 'amber' };
  return { label: 'Open', tone: 'info' };
}

export function creditNoteStatus(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'issued':
      return { label: 'Issued', tone: 'success' };
    case 'approved':
      return { label: 'Approved', tone: 'teal' };
    case 'rejected':
      return { label: 'Refused', tone: 'danger' };
    case 'under_review':
      return { label: 'Under review', tone: 'amber' };
    case 'requested':
    default:
      return { label: 'Requested', tone: 'amber' };
  }
}

/** How much of the credit limit is used, 0–100+, or null with no limit set. */
export function creditUse(outstandingPaise: number, limitPaise: number | null): number | null {
  if (limitPaise == null || limitPaise <= 0) return null;
  return Math.round((Math.max(0, outstandingPaise) / limitPaise) * 100);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2025-08-24` → `24 Aug 2025`.
 *
 * WITH the year, unlike `pretty`: a statement here runs back years rather than
 * the thirteen months the customer record holds, and "24 Aug" over two
 * Augusts is two rows nobody can tell apart. String arithmetic, never a Date —
 * see `periodRange` for why.
 */
export function longDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = String(iso).slice(0, 10).split('-');
  if (p.length !== 3) return String(iso);
  return `${Number(p[2])} ${MONTHS[Number(p[1]) - 1] ?? ''} ${p[0]}`;
}
