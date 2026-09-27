import "server-only";

/* ---------------------------------------------------------------------------
 * Stock, read off the inventory ledgers (spec §6).
 *
 * Phase 1 has no ledgers yet, so every total is zero; the purchase register
 * and the inventory log arrive in Phase 2 and this file is where "current
 * stock lot wise" is computed from them — one statement of it for every
 * screen, form and dashboard tile that asks.
 * ------------------------------------------------------------------------- */

/** Current raw-material stock per raw-material id, across every godown. */
export async function rmTotalsByItem(): Promise<Map<string, number>> {
  return new Map();
}
