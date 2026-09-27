import "server-only";
import type { ErpContext } from "./access";

/* ---------------------------------------------------------------------------
 * The sidebar's badges: work waiting on a screen (untested inward lines,
 * pending LRs, orders from pending customers…). Each phase adds the counts for
 * the screens it builds, and each count is the SAME function the screen's own
 * filter uses, so a badge never disagrees with the list it opens.
 * ------------------------------------------------------------------------- */

export async function erpNavCounts(ctx: ErpContext): Promise<Record<string, number>> {
  void ctx;
  return {};
}
