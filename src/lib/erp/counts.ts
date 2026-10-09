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

/** Bills without an LR, requests awaiting a decision, expenses waiting for a decision. */
export async function logisticsCounts() {
  const [lr, req, exp] = await Promise.all([
    db.execute(sql`select id from erp_transports where lr_no is null or lr_no = ''`) as unknown as Promise<{ id: string }[]>,
    db.execute(sql`select id from complaints where status = 'open'`) as unknown as Promise<{ id: string }[]>,
    db.execute(sql`select id from erp_expenses where not legacy and approval_status in ('submitted', 'under_review')`) as unknown as Promise<{ id: string }[]>,
  ]);
  return { pendingLr: lr.map((r) => r.id), requested: req.map((r) => r.id), pendingExpenses: exp.map((r) => r.id) };
}

export async function erpNavCounts(ctx: ErpContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const jobs: Promise<void>[] = [];
  if (ctx.screens.has("requisitions") || ctx.screens.has("purchaseOrders"))
    jobs.push(
      import("./screens/purchase-flow").then(async ({ purchaseFlowCounts }) => {
        const c = await purchaseFlowCounts(ctx);
        if (ctx.screens.has("requisitions")) out.requisitions = c.requisitions;
        if (ctx.screens.has("purchaseOrders")) out.purchaseOrders = c.purchaseOrders;
      }),
    );
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
  if (["pendingLr", "requests", "expenses"].some((k) => ctx.screens.has(k)))
    jobs.push(
      logisticsCounts().then((c) => {
        if (ctx.screens.has("pendingLr")) out.pendingLr = c.pendingLr.length;
        if (ctx.screens.has("requests")) out.requests = c.requested.length;
        if (ctx.screens.has("expenses")) out.expenses = c.pendingExpenses.length;
      }),
    );
  /* The dispatch desk's badge is overrides somebody is waiting on; Boxes' is boxes on the shelf with no label yet; QC waiting sits on SFG batches beside incomplete packing. */
  if (ctx.screens.has("dispatch") && ctx.powers.has("dispatchOverride"))
    jobs.push((db.execute(sql`select count(*)::int as n from erp_dispatch_overrides where status = 'Pending'`) as unknown as Promise<{ n: number }[]>).then((r) => void (out.dispatch = Number(r[0]?.n ?? 0))));
  if (ctx.screens.has("units"))
    jobs.push((db.execute(sql`select count(*)::int as n from erp_units where status = 'available' and label_printed_at is null`) as unknown as Promise<{ n: number }[]>).then((r) => void (out.units = Number(r[0]?.n ?? 0))));
  if (ctx.screens.has("sfgBatches") && ctx.powers.has("approveSfgQc"))
    jobs.push(
      (db.execute(sql`select count(distinct l.lot_code)::int as n from erp_sfg_lines l left join erp_sfg_qc q on q.lot_code = l.lot_code where coalesce(q.status, 'Pending') = 'Pending'`) as unknown as Promise<{ n: number }[]>).then(
        (r) => void (out.sfgBatches = Number(r[0]?.n ?? 0)),
      ),
    );
  await Promise.all(jobs);
  return out;
}
