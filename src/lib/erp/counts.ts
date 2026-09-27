import "server-only";
import { and, isNull, eq, or, lte } from "drizzle-orm";
import { db } from "@/db";
import { erpInward, erpPurchases, erpTests } from "@/db/schema";
import type { ErpContext } from "./access";

/* ---------------------------------------------------------------------------
 * The sidebar's badges: work waiting on a screen (untested inward lines,
 * pending LRs, orders from pending customers…). Each phase adds the counts for
 * the screens it builds, and each count is the SAME function the dashboard
 * tile uses to name its rows, so a badge never disagrees with the list it
 * opens.
 * ------------------------------------------------------------------------- */

/** Inward lines nobody has sent to testing or to the register yet. */
export async function inwardAwaitingIds(): Promise<string[]> {
  return (await db.select({ id: erpInward.id }).from(erpInward).where(isNull(erpInward.routed))).map((r) => r.id);
}

/** Tests the verifier has not decided yet. */
export async function testsAwaitingIds(): Promise<string[]> {
  return (await db.select({ id: erpTests.id }).from(erpTests).where(isNull(erpTests.decidedAt))).map((r) => r.id);
}

/** Register rows with no rate — which is why they are not in stock. */
export async function rateMissingIds(): Promise<string[]> {
  return (
    await db
      .select({ id: erpPurchases.id })
      .from(erpPurchases)
      .where(or(isNull(erpPurchases.ratePaise), lte(erpPurchases.ratePaise, 0)))
  ).map((r) => r.id);
}

/** Bills not yet received for a purchase. */
export async function billsAwaitingIds(): Promise<string[]> {
  return (
    await db
      .select({ id: erpPurchases.id })
      .from(erpPurchases)
      .where(and(or(isNull(erpPurchases.billReceived), eq(erpPurchases.billReceived, "Bill Not Received"))))
  ).map((r) => r.id);
}

export async function erpNavCounts(ctx: ErpContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const jobs: Promise<void>[] = [];
  if (ctx.screens.has("inward")) jobs.push(inwardAwaitingIds().then((x) => void (out.inward = x.length)));
  if (ctx.screens.has("testing")) jobs.push(testsAwaitingIds().then((x) => void (out.testing = x.length)));
  if (ctx.screens.has("register") && ctx.powers.has("viewPurchaseMoney"))
    jobs.push(rateMissingIds().then((x) => void (out.register = x.length)));
  await Promise.all(jobs);
  return out;
}
