import "server-only";
import { and, isNull, eq, or, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpInward, erpPurchases, erpTests } from "@/db/schema";
import type { ErpContext } from "./access";
import { fgReorderRows, rmReorderRows } from "./screens/movement";

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

/** Packing lines whose batch does not yet draw exactly its cans — boxes that are not in stock. */
export async function incompletePackIds(): Promise<string[]> {
  const rows = (await db.execute(sql`
    select l.id from erp_pack_lines l
      join products p on p.id = l.sku_id
      join (select batch_no, sum(cans) as used from erp_pack_lines group by batch_no) b on b.batch_no = l.batch_no
     where b.used <> l.boxes * p.cans_per_box
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export async function erpNavCounts(ctx: ErpContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const jobs: Promise<void>[] = [];
  if (ctx.screens.has("inward")) jobs.push(inwardAwaitingIds().then((x) => void (out.inward = x.length)));
  if (ctx.screens.has("testing")) jobs.push(testsAwaitingIds().then((x) => void (out.testing = x.length)));
  if (ctx.screens.has("register") && ctx.powers.has("viewPurchaseMoney"))
    jobs.push(rateMissingIds().then((x) => void (out.register = x.length)));
  if (ctx.screens.has("packBatches")) jobs.push(incompletePackIds().then((x) => void (out.packBatches = x.length)));
  if (ctx.screens.has("reorderRm")) jobs.push(rmReorderRows().then((x) => void (out.reorderRm = x.length)));
  if (ctx.screens.has("reorderFg")) jobs.push(fgReorderRows().then((x) => void (out.reorderFg = x.length)));
  await Promise.all(jobs);
  return out;
}
