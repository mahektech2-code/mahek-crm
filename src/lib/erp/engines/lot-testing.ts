/* ---------------------------------------------------------------------------
 * LOT TESTING AS A QUEUE — where each chemical lot routed to testing stands,
 * and how long it has waited. PURE: the clock and the threshold are arguments.
 *
 *   toTest    routed to testing at the gate, no test recorded yet. There is
 *             no `erp_tests` row for these: the lot is the inward line, and
 *             it is listed all the same, because it is the work.
 *   toVerify  a test recorded, waiting for the verifier (`verifyTest`).
 *   verified  passed: the lot went on to the register.
 *   failed    the verifier marked it Not Verified.
 *
 * A stored "Not Verified" is also the default before anybody decides, so a
 * test is FAILED only once somebody decided it (`decidedAt`) — an undecided
 * test is waiting, never rejected.
 * ------------------------------------------------------------------------- */

export type TestBucket = "toTest" | "toVerify" | "verified" | "failed";

export function testBucket(t: { status: string; decidedAt: Date | string | null } | null): TestBucket {
  if (!t) return "toTest";
  if (!t.decidedAt) return "toVerify";
  return t.status === "Verified" ? "verified" : "failed";
}

/** What the Stock column says about a lot in each bucket. */
export const STOCK_WORDS: Record<TestBucket, string> = {
  toTest: "Held until tested",
  toVerify: "Held until tested",
  verified: "Released",
  failed: "Held — failed",
};

const HOUR = 3_600_000;

/** How long, in words: "5 min", "2 hours", "3 days". Under a minute is "just now". */
export function waitingText(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 24 * HOUR) {
    const h = Math.floor(ms / HOUR);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.floor(ms / (24 * HOUR));
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** Whether a lot has waited longer than the threshold (`erp.purchase.testWaitingHours`). */
export function waitedTooLong(ms: number, thresholdHours: number): boolean {
  return thresholdHours > 0 && ms > thresholdHours * HOUR;
}
