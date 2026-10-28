/* ---------------------------------------------------------------------------
 * THE IDS THE CRM, ACCOUNTS AND SALES DASHBOARD MODALS ASK ABOUT, spelled the
 * same way on both sides. PURE and client-safe: the screen builds the id it
 * hands the modal, the act builds it again to check the confirmation, and a
 * fingerprint only matches when the two spell one record identically.
 *
 * Most acts name one row and pass its id as it is. Two shapes need help:
 *
 *  - an act named by a PAIR — an order unlinked from an enquiry, a receipt
 *    reversed against the bank line that shows it returned — carries both,
 *    joined by `|`, which no id in MahekOne contains;
 *  - an act over a SELECTION — leads archived from the list — carries the
 *    ids once each, sorted and comma-joined, exactly as the trash does
 *    (`lead-key.ts`), so the order somebody ticked them in cannot change it.
 * ------------------------------------------------------------------------- */

/** Two ids as one. */
export function impactPair(first: string, second: string): string {
  return `${String(first).trim()}|${String(second).trim()}`;
}

/** The two ids back out of `impactPair`. A key with no `|` is all first half. */
export function impactPairOf(key: string): [string, string] {
  const at = key.indexOf("|");
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
}

/* A selection as one id, spelled by the one helper the ERP and HRMS runner
   uses too — three spellings of "these twelve leads" would be three ways for
   a confirmation to stop matching. */
export { impactBatchKey as impactBatch, impactBatchIds } from "../batch-key";
