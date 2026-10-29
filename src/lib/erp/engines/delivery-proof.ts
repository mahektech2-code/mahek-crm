/* ---------------------------------------------------------------------------
 * THE DOCUMENTS DESK, as rules. Pure: no database, no clock.
 *
 * The phone only uploads — up to ten photos of LRs or customer-signed copies,
 * nothing typed — and the laptop team checks each one here: what the AI read,
 * whether it is a second copy of something already on the desk, and which
 * bill it belongs to. Nothing in this file attaches or discards anything; it
 * says what each copy LOOKS like, and a person decides.
 * ------------------------------------------------------------------------- */

import { similarity } from "./match";
import type { ProofKind } from "./logistics";

export type DeskCopy = {
  id: string;
  kind: ProofKind;
  /** unassigned (on the desk) | assigned (attached to bills). Voided copies are never passed in. */
  status: string;
  lrNo: string | null;
  /** What the AI read, kept even where it was not written into `lrNo`. */
  readLrNo: string | null;
  readKind: string | null;
  transporter: string | null;
  lrDate: string | null;
  packages: number | null;
  /** SHA-256 of the photo's bytes. */
  contentHash: string | null;
  billHint: string | null;
  partyHint: string | null;
  uploadedAt: string;
  dupClearedAt: string | null;
};

/**
 * What a copy looks like next to an earlier one:
 *  - duplicate: the same photo, the same LR (transporter and number), or a signed copy of the same bill;
 *  - attached:  the same, but the earlier one is already attached to bills;
 *  - check:     nearly the same — a number one character apart, or the same number with a transporter unread.
 */
export type DupFlag = { kind: "duplicate" | "attached" | "check"; ofId: string; why: string };

/** Upper case, letters and digits only — "lr-77841 " and "LR77841" are one number. */
export function normNo(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const fold = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Levenshtein distance, capped: anything past `cap` reads as `cap + 1`. */
export function editDistance(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The number a copy carries for comparison: what was typed, else what was read. */
export const numberOf = (c: Pick<DeskCopy, "lrNo" | "readLrNo">) => normNo(c.lrNo ?? c.readLrNo);

/**
 * A bill number as it is compared: its LAST run of digits, because a signed
 * copy is stamped "1188", the desk calls it "MMI/26-27/1188", and the year in
 * the middle must never make two bills look alike.
 */
export function billKey(v: string | null | undefined): string {
  const runs = (v ?? "").match(/\d+/g);
  return runs?.length ? String(Number(runs[runs.length - 1])) : "";
}

/**
 * Every copy on the desk that looks like one uploaded EARLIER, and what it
 * looks like. Only copies still on the desk and not cleared by a person are
 * flagged; the earlier one of a pair is never flagged, so discarding the later
 * one always leaves one copy. A cleared copy can still be what a later one is
 * a duplicate of.
 */
export function duplicateFlags(copies: DeskCopy[]): Map<string, DupFlag> {
  const sorted = [...copies].sort((a, b) => (a.uploadedAt === b.uploadedAt ? (a.id < b.id ? -1 : 1) : a.uploadedAt < b.uploadedAt ? -1 : 1));
  const out = new Map<string, DupFlag>();
  sorted.forEach((c, i) => {
    if (c.status !== "unassigned" || c.dupClearedAt) return;
    const earlier = sorted.slice(0, i);
    const verdict = (o: DeskCopy, why: string): DupFlag => ({ kind: o.status === "assigned" ? "attached" : "duplicate", ofId: o.id, why });
    /* 1 — the same bytes: the same photo sent again. */
    const same = c.contentHash ? earlier.find((o) => o.contentHash === c.contentHash) : undefined;
    if (same) return void out.set(c.id, verdict(same, "The same photo was uploaded before"));
    if (c.kind === "lr") {
      const no = numberOf(c);
      if (no.length < 3) return;
      const lrs = earlier.filter((o) => o.kind === "lr");
      /* 2 — the same transporter and the same number. */
      const exact = lrs.find((o) => numberOf(o) === no && fold(o.transporter) && fold(o.transporter) === fold(c.transporter));
      if (exact) return void out.set(c.id, verdict(exact, `Same LR — ${c.transporter ?? ""} ${no}`.trim()));
      /* The same number where one transporter was not read: two companies may each have an LR 1042. */
      const unread = lrs.find((o) => numberOf(o) === no && (!fold(o.transporter) || !fold(c.transporter)));
      if (unread) return void out.set(c.id, { kind: "check", ofId: unread.id, why: "Same number, transporter not read on one" });
      /* 3 — one character apart, same transporter, and nothing else disagreeing. */
      const near = lrs.find(
        (o) =>
          fold(o.transporter) === fold(c.transporter) &&
          numberOf(o).length >= 4 &&
          numberOf(o) !== no &&
          editDistance(numberOf(o), no, 1) <= 1 &&
          (!o.lrDate || !c.lrDate || o.lrDate === c.lrDate) &&
          (o.packages == null || c.packages == null || o.packages === c.packages),
      );
      if (near) return void out.set(c.id, { kind: "check", ofId: near.id, why: `Number ${no} is one character from ${numberOf(near)}` });
      return;
    }
    /* A signed copy: the same bill signed for twice is one delivery. */
    const bill = billKey(c.billHint);
    if (!bill) return;
    const twin = earlier.find((o) => o.kind === "signed_copy" && billKey(o.billHint) === bill && (!o.partyHint || !c.partyHint || similarity(o.partyHint, c.partyHint) >= 0.5));
    if (twin) out.set(c.id, verdict(twin, `Same bill — ${bill}`));
  });
  return out;
}

/** Where the AI thinks a copy was uploaded under the wrong kind: an LR sent as a signed copy, or the other way. */
export function wrongKind(c: Pick<DeskCopy, "kind" | "readKind" | "status">): ProofKind | null {
  if (c.status !== "unassigned") return null;
  if (c.readKind === "lr" && c.kind === "signed_copy") return "lr";
  if (c.readKind === "signed_copy" && c.kind === "lr") return "signed_copy";
  return null;
}

/* ------------------------------------------------ matching a signed copy */

export type SignedCandidate = { id: string; billNo: string | null; party: string; vehicleNo: string | null };

/**
 * Which Mahek Vehicle bills a signed copy most likely closes, best first: the
 * bill number it was stamped with (its last digits), then the party's name.
 * A suggestion; nothing is attached by this.
 */
export function rankForSignedCopy(copy: { billHint: string | null; partyHint: string | null }, cands: SignedCandidate[]): { id: string; score: number; reasons: string[] }[] {
  const bill = billKey(copy.billHint);
  return cands
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];
      if (bill && billKey(c.billNo) === bill) {
        score += 6;
        reasons.push("same bill no.");
      }
      if (copy.partyHint && similarity(copy.partyHint, c.party) >= 0.5) {
        score += 3;
        reasons.push("same party");
      }
      return { id: c.id, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The ONE suggestion sure enough to act on without a person picking it: at
 * least `min`, and clear of the next one. Two equally good bills is a
 * question, never an answer.
 */
export function confidentPick(ranked: { id: string; score: number }[], min: number): string | null {
  const [a, b] = ranked;
  if (!a || a.score < min) return null;
  if (b && b.score >= a.score) return null;
  return a.id;
}

/** How sure a suggestion must be for "Attach all ready": an LR needs the transporter and the destination; a signed copy its bill number. */
export const READY_SCORE = { lr: 7, signed_copy: 6 } as const;

/** What a copy on the desk still needs before it can be attached, in the order a person would see it. */
export function missingFor(c: { kind: ProofKind; lrNo: string | null; transporter: string | null; receivedBy: string | null }): string[] {
  if (c.kind === "lr") return [!c.lrNo ? "LR no." : null, !c.transporter ? "transporter" : null].filter((x): x is string => !!x);
  return [!c.receivedBy ? "received by" : null].filter((x): x is string => !!x);
}

/** Photos in one upload, on the phone and the laptop alike. */
export const UPLOAD_MAX = 10;
