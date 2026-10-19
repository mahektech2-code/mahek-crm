import "server-only";
import { cache } from "react";
import { APP_TIMEZONE } from "@/lib/business-date";
import { and, isNull, eq, or, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpInward, erpPurchases, erpTests } from "@/db/schema";
import type { ErpContext } from "./access";
import { fgReorderRows, rmReorderRows } from "./screens/movement";
import { detailedOrdersOf, isPendingLine, isWorkingLine, orderLines } from "./screens/sales";

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
  /* Every badge is open work, so open work is all that is read — never the book. */
  const lines = await orderLines({ openWork: true });
  const detailed = detailedOrdersOf(lines);
  const pending = lines.filter((l) => isPendingLine(l, detailed));
  const working = lines.filter(isWorkingLine);
  const toAllocate = lines.filter((l) => l.o.status === "Ready" && l.o.entryStatus !== "Done" && l.allocation === "Add More Quantity");
  const pendingParty = lines.filter((l) => l.o.partyStatus === "Pending" && !l.inDetails);
  return { lines, pending, working, toAllocate, pendingParty };
}

/** Detail lines still waiting for dispatch verification. */
export async function unverifiedIds(): Promise<string[]> {
  /* One indexed read, not the order details screen's whole build: a badge is a number. */
  const rows = (await db.execute(sql`
    select d.order_id as id from erp_order_details d join erp_orders o on o.id = d.order_id
     where d.verification is null or d.verification = 'Pending'
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * The Logistics badge is the work waiting on the desk right now: LRs uploaded
 * and not attached, calls to a transporter owed today, and customer messages
 * to send by hand. Requests awaiting a decision and expenses awaiting
 * verification ride on the same pass.
 */
export async function logisticsCounts() {
  const [lrs, calls, msgs, req, exp] = await Promise.all([
    db.execute(sql`select id from erp_lrs where status = 'unassigned'`) as unknown as Promise<{ id: string }[]>,
    db.execute(sql`
      select id from erp_transports
       where material_stage <> 'Close - Received to Party' and coalesce(lr_no, '') <> ''
         and reminder_date <= (now() at time zone ${APP_TIMEZONE})::date
    `) as unknown as Promise<{ id: string }[]>,
    db.execute(sql`select id from erp_transport_messages where status in ('to_send', 'failed')`) as unknown as Promise<{ id: string }[]>,
    db.execute(sql`select id from complaints where status = 'open' and category = 'product_quality'`) as unknown as Promise<{ id: string }[]>,
    db.execute(sql`select id from erp_expenses where status = 'Pending'`) as unknown as Promise<{ id: string }[]>,
  ]);
  /* One figure per Logistics tab — LRs to attach, calls due on the road,
     messages to send — so each tab's badge is its own work and the sidebar
     badge is their sum. */
  return { pendingLr: lrs.map((r) => r.id), trackLr: calls.map((r) => r.id), lrMessages: msgs.map((r) => r.id), requested: req.map((r) => r.id), pendingExpenses: exp.map((r) => r.id) };
}

/**
 * The work waiting on each list, by module key: the sidebar badge of a screen
 * is the sum over its tabs, and each tab draws its own. Asked once per request
 * — the layout and the page share the answer.
 */
export const erpNavCounts = cache(navCounts);

async function navCounts(ctx: ErpContext): Promise<Record<string, number>> {
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
        if (ctx.screens.has("pendingLr")) {
          out.pendingLr = c.pendingLr.length;
          out.trackLr = c.trackLr.length;
          out.lrMessages = c.lrMessages.length;
        }
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
  /* Inventory accuracy: counts due, red flags still open, and — for whoever approves them — adjustments waiting. */
  if (["countTasks", "stockFlags", "stockAdjustments"].some((k) => ctx.screens.has(k)))
    jobs.push(
      (db.execute(sql`
        select (select count(*) from erp_stock_counts where status = 'open' and due_date <= (now() at time zone ${APP_TIMEZONE})::date)::int as due,
               (select count(*) from erp_stock_counts where recount_of_id is null and status in ('flagged', 'investigating'))::int as flags,
               (select count(*) from erp_stock_adjustments where status = 'pending')::int as adj
      `) as unknown as Promise<{ due: number; flags: number; adj: number }[]>).then((r) => {
        out.countTasks = Number(r[0]?.due ?? 0);
        out.stockFlags = Number(r[0]?.flags ?? 0);
        if (ctx.powers.has("stockControl")) out.stockAdjustments = Number(r[0]?.adj ?? 0);
      }),
    );
  /* Empty drums: drums whose owner nobody has recorded, corrections waiting for an approver, and receipts not yet matched. */
  if (["drumReview", "drumAdjustments", "cashReceipts"].some((k) => ctx.screens.has(k)))
    jobs.push(
      (db.execute(sql`
        select (select count(*) from erp_empty_drums where status = 'review')::int as review,
               (select count(*) from erp_drum_adjustments where status = 'pending')::int as adj,
               (select count(*) from erp_cash_receipts r where r.status = 'active'
                   and r.amount_paise > coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null), 0))::int as unmatched
      `) as unknown as Promise<{ review: number; adj: number; unmatched: number }[]>).then((r) => {
        if (ctx.screens.has("drumReview")) out.drumReview = Number(r[0]?.review ?? 0);
        if (ctx.screens.has("drumAdjustments") && ctx.powers.has("scrapApprove")) out.drumAdjustments = Number(r[0]?.adj ?? 0);
        if (ctx.screens.has("cashReceipts") && ctx.powers.has("scrapAccounts")) out.cashReceipts = Number(r[0]?.unmatched ?? 0);
      }),
    );
  /* Material returns: returns waiting for an approver, outwards prepared and not confirmed, and material waiting in quarantine for QC. */
  if (["vendorReturns", "returnOutwards", "returnQc"].some((k) => ctx.screens.has(k)))
    jobs.push(
      (db.execute(sql`
        select (select count(*) from erp_purchase_returns where status = 'pending')::int as approve,
               (select count(*) from erp_return_outwards where status = 'draft')::int as outward,
               (select count(*) from erp_customer_returns r where r.status = 'open' and r.received_qty is not null and r.received_qty > coalesce((
                  select sum(d.quantity) from erp_return_dispositions d where d.customer_return_id = r.id and d.status = 'active'), 0))::int as qc
      `) as unknown as Promise<{ approve: number; outward: number; qc: number }[]>).then((r) => {
        if (ctx.screens.has("vendorReturns") && (ctx.administrator || ctx.powers.has("returnApprove"))) out.vendorReturns = Number(r[0]?.approve ?? 0);
        if (ctx.screens.has("returnOutwards")) out.returnOutwards = Number(r[0]?.outward ?? 0);
        if (ctx.screens.has("returnQc") && (ctx.administrator || ctx.powers.has("returnQc"))) out.returnQc = Number(r[0]?.qc ?? 0);
      }),
    );
  await Promise.all(jobs);
  return out;
}
