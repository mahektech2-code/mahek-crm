/* ---------------------------------------------------------------------------
 * WHICH LEADS A TRASH REPORT IS ABOUT, as the one id an impact report carries.
 *
 * Moving leads to the trash is a batch act — one lead from its record, up to
 * two hundred from the list — and an impact report names ONE record. So the
 * batch is its own record: its ids, each once, in one order, joined. PURE and
 * client-safe, because the modal and the act have to spell the same batch the
 * same way or the fingerprint the person confirmed would never match.
 * ------------------------------------------------------------------------- */

/** The impact kind for moving leads to the trash. */
export const LEAD_TRASH_KIND = "lead-trash";

/** The batch as one id: unique, sorted, comma-joined. */
export function leadTrashKey(ids: string[]): string {
  return [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))].sort().join(",");
}

/** The ids back out of the key. */
export function leadTrashIds(key: string): string[] {
  return leadTrashKey(key.split(",")).split(",").filter(Boolean);
}
