/* ---------------------------------------------------------------------------
 * A BATCH ACT'S RECORDS, as the one id an impact report carries.
 *
 * A bulk act over a selection (deactivating twelve employees at once) is one
 * decision about a set, and an impact report names ONE record — so the set is
 * its own record: its ids, each once, in one order, joined. PURE and
 * client-safe, because the runner that opens the modal and the act that
 * checks it have to spell the same set the same way, or the fingerprint the
 * person confirmed would never match.
 * ------------------------------------------------------------------------- */

/** The selection as one id: unique, sorted, comma-joined. */
export function impactBatchKey(ids: readonly string[]): string {
  return [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))].sort().join(",");
}

/** The ids back out of the key. */
export function impactBatchIds(key: string): string[] {
  return impactBatchKey(key.split(",")).split(",").filter(Boolean);
}
