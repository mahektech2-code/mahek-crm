import type { BusinessDate } from "../business-date";
import { daysBetween } from "../business-date";

/* ---------------------------------------------------------------------------
 * E11 — is this money we have already been told about?
 *
 * Accounts work down a bank statement recording what actually arrived. A
 * telecaller has often already written the same payment down days earlier,
 * from what the customer said on the phone. Recorded twice, the customer's
 * account is credited twice, and the bill that was supposed to be settled by
 * one of them stays open while the other sits on account — which is a mess
 * somebody untangles months later against a customer who is certain they paid
 * once.
 *
 * This decides what to OFFER, and nothing more. It never merges anything, and
 * a strong match is still a suggestion a person accepts: the money is real and
 * the entry accounts are making from the statement is the authoritative one.
 *
 * Pure. Candidates, what is being entered and configuration go in; a ranked
 * list comes out.
 * ------------------------------------------------------------------------- */

export type MatchCandidate = {
  receiptId: string;
  /** Paise. */
  amount: number;
  receivedAt: BusinessDate;
  mode: string;
  reference: string | null;
  /** `reported` or `held`. Nothing confirmed is ever a candidate. */
  status: "reported" | "held";
  reportedByName: string | null;
  reportedOn: BusinessDate;
  note: string | null;
};

export type MatchEntry = {
  amount: number;
  receivedAt: BusinessDate;
  mode: string;
  reference: string | null;
};

export type MatchStrength = "reference" | "exact" | "close";

export type ReceiptMatch = {
  candidate: MatchCandidate;
  strength: MatchStrength;
  /** Paise the candidate differs by. Zero on an exact or reference match. */
  differsBy: number;
  /** Plain language, shown verbatim beside the suggestion. */
  why: string;
};

export type MatchConfig = {
  matchWindowDays: number;
  matchTolerancePercent: number;
};

/**
 * Every candidate worth offering, strongest first.
 *
 * The order is the order a person should read them in: a reference that agrees
 * is near-proof, an amount to the rupee is strong, and an amount that is nearly
 * right is a question rather than an answer.
 */
export function matchReceipts(
  candidates: MatchCandidate[],
  entry: MatchEntry,
  config: MatchConfig,
): ReceiptMatch[] {
  const matches: ReceiptMatch[] = [];
  const entryRef = normaliseReference(entry.reference);

  for (const c of candidates) {
    /*
     * The window is measured from the day the money is said to have ARRIVED,
     * in both directions.
     *
     * Not from when it was written down: a telecaller logs Friday's payment on
     * Monday, and a bank statement is read a week after the transfer. Both
     * describe the same day of arrival, which is the only date the two records
     * genuinely share.
     */
    const apart = Math.abs(daysBetween(c.receivedAt, entry.receivedAt));
    if (apart > config.matchWindowDays) continue;

    const candidateRef = normaliseReference(c.reference);
    const differsBy = Math.abs(c.amount - entry.amount);

    /*
     * A reference that agrees outranks an amount that agrees, even where the
     * amounts differ.
     *
     * A UTR names one transfer and nothing else, so two records carrying it
     * are the same money whatever else disagrees — and where the amounts DO
     * disagree that is exactly what somebody needs to see, because one of the
     * two figures is wrong and it is usually the one taken down a phone.
     */
    if (entryRef && candidateRef && entryRef === candidateRef) {
      matches.push({
        candidate: c,
        strength: "reference",
        differsBy,
        why:
          differsBy === 0
            ? "Same reference, same amount"
            : `Same reference — but ${rupees(c.amount)} was written down, not ${rupees(entry.amount)}`,
      });
      continue;
    }

    if (differsBy === 0) {
      matches.push({
        candidate: c,
        strength: "exact",
        differsBy: 0,
        why: apart === 0 ? "Same amount, same day" : `Same amount, ${dayGap(apart)}`,
      });
      continue;
    }

    // Bank charges, a rounding, a customer who said "fifty thousand" of a
    // transfer that arrived as 50,040. Offered as a question, never as an
    // answer — the figure that counts is the one off the statement.
    const tolerance = Math.round((entry.amount * config.matchTolerancePercent) / 100);
    if (tolerance > 0 && differsBy <= tolerance) {
      matches.push({
        candidate: c,
        strength: "close",
        differsBy,
        why: `${rupees(c.amount)} was written down — ${rupees(differsBy)} apart`,
      });
    }
  }

  return matches.sort(compare);
}

/**
 * Whether a match is strong enough that recording a SECOND receipt should have
 * to be a deliberate act rather than the default.
 *
 * Only the two that are near-proof. A close match is a question, and making
 * somebody dismiss a question before they can do their job turns the whole
 * feature into an obstacle they learn to click through.
 */
export function blocksSilentDuplicate(m: ReceiptMatch): boolean {
  return m.strength === "reference" || m.strength === "exact";
}

/* ------------------------------------------------------------------ helpers */

const STRENGTH_ORDER: Record<MatchStrength, number> = {
  reference: 0,
  exact: 1,
  close: 2,
};

function compare(a: ReceiptMatch, b: ReceiptMatch): number {
  const s = STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength];
  if (s !== 0) return s;

  // A hold before a bare report: somebody in accounts has already looked at it
  // and is mid-way through finding this exact money.
  const aHeld = a.candidate.status === "held" ? 0 : 1;
  const bHeld = b.candidate.status === "held" ? 0 : 1;
  if (aHeld !== bHeld) return aHeld - bHeld;

  if (a.differsBy !== b.differsBy) return a.differsBy - b.differsBy;
  // Oldest first, so the claim that has been waiting longest is answered first.
  return a.candidate.reportedOn.localeCompare(b.candidate.reportedOn);
}

/**
 * A reference as the bank means it, not as somebody typed it.
 *
 * The same UTR arrives as "UTR 1234 5678", "utr-12345678" and "1234-5678"
 * depending on who read it off what. Case, spaces, punctuation and a leading
 * label are all noise; the digits and letters are the fact. Returns null for
 * anything with nothing left, so an empty reference never matches another
 * empty one — two receipts with no reference are not evidence of anything.
 */
export function normaliseReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toUpperCase()
    .trim()
    // Trimmed BEFORE the label is stripped: "  Ref: 12345678 " is how it comes
    // off a statement, and an anchored pattern does not reach past a space.
    .replace(/^(UTR|REF|RRN|TXN|NEFT|IMPS|RTGS|UPI)[\s:.\-#]*/, "")
    .replace(/[^A-Z0-9]/g, "");
  // Too short to name anything. "1" and "OK" have both been typed into that box.
  return cleaned.length >= 4 ? cleaned : null;
}

function dayGap(days: number): string {
  return days === 1 ? "a day apart" : `${days} days apart`;
}

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}
