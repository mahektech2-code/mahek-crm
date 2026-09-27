import "server-only";
import { and, isNull, eq, or, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpInward, erpPurchases, erpTests } from "@/db/schema";
import type { ErpContext } from "./access";
import { fgReorderRows, rmReorderRows } from "./screens/movement";
import { detailRows, orderLines } from "./screens/sales";

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

/** Open order lines not yet in order details, the Pending Orders list's own rule. */
export async function salesCounts() {
  const lines = await orderLines();
  const detailed = new Set(lines.filter((l) => l.inDetails).map((l) => l.o.orderNo));
  const pending = lines.filter((l) => l.o.status !== "Cancel" && l.sku.name !== "Empty Drum" && !detailed.has(l.o.orderNo));
  const working = lines.filter((l) => (l.o.status === "Ready" || l.o.status === "Under Process") && l.o.entryStatus !== "Done");
  const toAllocate = lines.filter((l) => l.o.status === "Ready" && l.o.entryStatus !== "Done" && l.allocation === "Add More Quantity");
  const pendingParty = lines.filter((l) => l.o.partyStatus === "Pending" && !l.inDetails);
  return { lines, pending, working, toAllocate, pendingParty };
}

/** Detail lines still waiting for dispatch verification. */
export async function unverifiedIds(): Promise<string[]> {
  return (await detailRows()).rows.filter((r) => !r.d.verification || r.d.verification === "Pending").map((r) => r.l.o.id);
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
  if (ctx.screens.has("pendingOrders") || ctx.screens.has("readyOrders"))
    jobs.push(
      salesCounts().then((c) => {
        out.pendingOrders = c.pending.length;
        out.readyOrders = c.toAllocate.length;
      }),
    );
  if (ctx.screens.has("orderDetails")) jobs.push(unverifiedIds().then((x) => void (out.orderDetails = x.length)));
  await Promise.all(jobs);
  return out;
}
