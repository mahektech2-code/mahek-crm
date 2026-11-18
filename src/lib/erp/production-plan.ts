import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpProductionPlanLines, erpProductionPlanPrints, erpProductionPlans, type PlanSnapshotExpected, type PlanSnapshotLine } from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { erpAudit, erpId, nextNumber } from "./server";
import { fgLots, packLots, sfgLots } from "./stock";
import { categorySpec, changedSince, lineProblems, lineState, orderDemand, sizeName, type LineInput, type LineState, type PlanCategory } from "./engines/production-plan";
import { calendarDate } from "@/lib/business-date";
import { expectedPlan, sourceRef, stockCheckWords, counted, type DemandLine, type ExpectedPlan, type ExpectedSource } from "./engines/expected-plan";
import { mrpCheck } from "./engines/mrp";
import { mrpStockAt } from "./mrp-stock";
import { ACCOUNTS_HOLD_REASONS, PRODUCTION_HOLD_REASONS } from "./engines/order-hub";
import { nowMs } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * UNDER PROCESS — reads and writes of the daily production plan. The rules
 * are in `engines/production-plan.ts`; this file wires them to the database.
 *
 * Stock is READ here, never written: "current available" is the ledgers'
 * own figure at the plan's godown, summed per product.
 * ------------------------------------------------------------------------- */

export type PlanItem = { id: string; category: PlanCategory; name: string; code: string | null; size: string | null };

/** What each category picks from — the lists SFG batches, FG filling and Packing batches already use. */
export async function planCatalogue(): Promise<PlanItem[]> {
  const [sfg, loose, packing] = await Promise.all([
    db.execute(sql`select f.id, f.name from product_formulations f where f.active and not f.is_residual order by f.name`),
    db.execute(sql`
      select fg.id, fg.name, fg.millilitres as ml,
             (select p.external_code from products p where p.finished_good_id = fg.id and p.active and p.cans_per_box = 1 order by p.name limit 1) as code
        from finished_goods fg where fg.active order by fg.name`),
    db.execute(sql`
      select p.id, p.name, p.external_code as code, coalesce(p.millilitres_per_can, fg.millilitres) as ml
        from products p join finished_goods fg on fg.id = p.finished_good_id
        join erp_product_packing pk on pk.product_id = p.id
       where p.active and pk.empty_boxes_required > 0 order by p.name`),
  ]);
  type R = { id: string; name: string; code?: string | null; ml?: number | null };
  return [
    ...(sfg as unknown as R[]).map((r): PlanItem => ({ id: r.id, category: "sfg", name: r.name, code: null, size: null })),
    ...(loose as unknown as R[]).map((r): PlanItem => ({ id: r.id, category: "loose", name: r.name, code: r.code ?? null, size: sizeName(r.ml) })),
    ...(packing as unknown as R[]).map((r): PlanItem => ({ id: r.id, category: "packing", name: r.name, code: r.code ?? null, size: sizeName(r.ml) })),
  ];
}

/** Stock on hand at one godown, per category and product: litres, cans, boxes. */
export async function planAvailability(godownId: string | null): Promise<Record<string, number>> {
  if (!godownId) return {};
  const [s, f, p] = await Promise.all([sfgLots(), fgLots(), packLots()]);
  const out: Record<string, number> = {};
  const add = (k: string, n: number) => (out[k] = (out[k] ?? 0) + n);
  for (const l of s) if (l.godownId === godownId) add(`sfg:${l.formulationId}`, l.stock);
  for (const l of f) if (l.godownId === godownId) add(`loose:${l.finishedGoodId}`, l.stock);
  for (const l of p) if (l.godownId === godownId) add(`packing:${l.skuId}`, l.stock);
  return out;
}

export type PlanSummary = {
  id: string;
  planNo: number;
  planDate: string;
  createdBy: string | null;
  updatedAt: string;
  lines: number;
  prints: number;
  lastPrintedAt: string | null;
  godownId: string | null;
  godown: string | null;
};

/** Plans newest first, or the one for a date. */
export async function listPlans(opts: { date?: string | null; limit?: number } = {}): Promise<PlanSummary[]> {
  const rows = (await db.execute(sql`
    select p.id, p.plan_no as "planNo", p.plan_date::text as "planDate", u.name as "createdBy", p.updated_at as "updatedAt", p.godown_id as "godownId",
           (select count(*)::int from erp_production_plan_lines l where l.plan_id = p.id and l.deleted_at is null) as lines,
           (select count(*)::int from erp_production_plan_prints x where x.plan_id = p.id) as prints,
           (select max(x.printed_at) from erp_production_plan_prints x where x.plan_id = p.id) as "lastPrintedAt",
           g.name as godown
      from erp_production_plans p left join users u on u.id = p.created_by_id left join erp_godowns g on g.id = p.godown_id
     where ${opts.date ? sql`p.plan_date = ${opts.date}` : sql`true`}
     order by p.plan_date desc limit ${opts.limit ?? 60}
  `)) as unknown as (Omit<PlanSummary, "updatedAt" | "lastPrintedAt"> & { updatedAt: Date | string; lastPrintedAt: Date | string | null })[];
  return rows.map((r) => ({ ...r, updatedAt: new Date(r.updatedAt).toISOString(), lastPrintedAt: r.lastPrintedAt ? new Date(r.lastPrintedAt).toISOString() : null }));
}

export type PlanLineView = PlanSnapshotLine & {
  itemId: string | null;
  /** `order` where the line is an Under Process order line, written by the sync and not editable here. */
  source: "manual" | "order";
  state: LineState;
  /** The quantity on the last print, where an edit moved it. */
  was: number | null;
  available: number | null;
  updatedAt: string;
};

export type PlanView = {
  id: string;
  planNo: number;
  planDate: string;
  godownId: string | null;
  godown: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
  prints: { printNo: number; printedAt: string; printedBy: string | null }[];
  lines: PlanLineView[];
  changed: number;
  /** Stock at the plan's godown, keyed `category:itemId` — for a line not yet added. */
  available: Record<string, number>;
};

function snap(l: typeof erpProductionPlanLines.$inferSelect): PlanSnapshotLine {
  return {
    id: l.id,
    category: l.category,
    productName: l.productName,
    productCode: l.productCode,
    size: l.size,
    quantity: l.quantity,
    unit: l.unit,
    remarks: l.remarks,
    /* Only on an order line, so a plan of typed lines snapshots as it always did. */
    ...(l.source === "order" ? { orderRefs: l.orderRefs } : {}),
    /* Only where set, for the same reason. */
    ...(l.forExpected ? { forExpected: true } : {}),
  };
}

export async function planView(id: string): Promise<PlanView | null> {
  const [head] = (await db.execute(sql`
    select p.id, p.plan_no as "planNo", p.plan_date::text as "planDate", p.godown_id as "godownId", g.name as godown,
           c.name as "createdBy", u.name as "updatedBy", p.updated_at as "updatedAt"
      from erp_production_plans p left join erp_godowns g on g.id = p.godown_id
      left join users c on c.id = p.created_by_id left join users u on u.id = p.updated_by_id
     where p.id = ${id}
  `)) as unknown as (Omit<PlanView, "prints" | "lines" | "changed" | "updatedAt"> & { updatedAt: Date | string })[];
  if (!head) return null;
  const [lines, prints, avail] = await Promise.all([
    db.select().from(erpProductionPlanLines).where(eq(erpProductionPlanLines.planId, id)).orderBy(asc(erpProductionPlanLines.sort), asc(erpProductionPlanLines.createdAt)),
    db.execute(sql`
      select x.print_no as "printNo", x.printed_at as "printedAt", u.name as "printedBy", x.lines
        from erp_production_plan_prints x left join users u on u.id = x.printed_by_id
       where x.plan_id = ${id} order by x.print_no`) as unknown as Promise<{ printNo: number; printedAt: Date | string; printedBy: string | null; lines: PlanSnapshotLine[] }[]>,
    planAvailability(head.godownId),
  ]);
  const last = prints.length ? new Map(prints[prints.length - 1].lines.map((l) => [l.id, l])) : null;
  const withDeleted = lines.map((l) => ({ ...snap(l), deleted: l.deletedAt != null }));
  const view: PlanLineView[] = [];
  lines.forEach((l, i) => {
    const state = lineState(withDeleted[i], last);
    if (!state) return;
    const printed = last?.get(l.id);
    view.push({
      ...snap(l),
      itemId: l.itemId,
      source: l.source === "order" ? "order" : "manual",
      state,
      was: state === "edited" && printed && printed.quantity !== l.quantity ? printed.quantity : null,
      available: l.itemId ? (avail[`${l.category}:${l.itemId}`] ?? 0) : null,
      updatedAt: l.updatedAt.toISOString(),
    });
  });
  return {
    ...head,
    updatedAt: new Date(head.updatedAt).toISOString(),
    prints: prints.map((p) => ({ printNo: p.printNo, printedAt: new Date(p.printedAt).toISOString(), printedBy: p.printedBy })),
    lines: view,
    changed: changedSince(withDeleted, last),
    available: avail,
  };
}

/** One print, with the print before it — what the A5 sheet is drawn from. */
export async function planPrint(id: string, printNo: number) {
  const rows = (await db.execute(sql`
    select x.print_no as "printNo", x.printed_at as "printedAt", u.name as "printedBy", x.lines, x.expected
      from erp_production_plan_prints x left join users u on u.id = x.printed_by_id
     where x.plan_id = ${id} and x.print_no in (${printNo}, ${printNo - 1}) order by x.print_no`)) as unknown as {
    printNo: number;
    printedAt: Date | string;
    printedBy: string | null;
    lines: PlanSnapshotLine[];
    expected: PlanSnapshotExpected[] | null;
  }[];
  const cur = rows.find((r) => r.printNo === printNo);
  if (!cur) return null;
  const prev = rows.find((r) => r.printNo === printNo - 1) ?? null;
  return { current: { ...cur, printedAt: new Date(cur.printedAt).toISOString() }, previous: prev ? { ...prev, printedAt: new Date(prev.printedAt).toISOString() } : null };
}

/* ------------------------------------------------------------------ writes */

/** Today's business date. A plan dated before it is the record of its day. */
function todayDate(): string {
  return calendarDate(new Date(nowMs()));
}

export function isPastPlan(planDate: string): boolean {
  return planDate < todayDate();
}

const PAST_PLAN = "This plan is for a day that has passed. It is the record of that day and cannot be changed or printed again.";

/** Opens the plan for a date, making it if there is none — one plan per day. */
export async function openPlanFor(ctx: ErpContext, date: string): Promise<Result<{ id: string; created: boolean }>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fieldErr("date", "Pick the plan date.");
  const [have] = await db.select({ id: erpProductionPlans.id }).from(erpProductionPlans).where(eq(erpProductionPlans.planDate, date));
  if (have) return ok({ id: have.id, created: false });
  if (isPastPlan(date)) return fieldErr("date", "That day has passed and has no plan. A plan can be made for today or a later day.");
  const res = await db.transaction(async (tx) => {
    const planNo = await nextNumber(tx, "plan");
    const id = erpId("eplan");
    const inserted = await tx
      .insert(erpProductionPlans)
      .values({ id, planNo, planDate: date, godownId: ctx.workingGodown?.id ?? null, createdById: ctx.user.id, updatedById: ctx.user.id })
      .onConflictDoNothing()
      .returning({ id: erpProductionPlans.id });
    return inserted[0]?.id ? { id, planNo } : null;
  });
  if (!res) {
    /* Somebody made the day's plan a moment earlier: open theirs. */
    const [again] = await db.select({ id: erpProductionPlans.id }).from(erpProductionPlans).where(eq(erpProductionPlans.planDate, date));
    return again ? ok({ id: again.id, created: false }) : err("Could not make the plan. Try again.");
  }
  await erpAudit(ctx, "erp.plan.create", "erp_production_plan", res.id, null, { planNo: res.planNo, date });
  await syncPlanFromOrders(res.id);
  return ok({ id: res.id, created: true }, `PLAN-${res.planNo} made for ${date}`);
}

/** Adds a line, or edits one. A line already printed keeps its id, so the next print can say it changed. */
export async function savePlanLine(ctx: ErpContext, planId: string, input: LineInput, lineId?: string): Promise<Result<{ id: string }>> {
  const [plan] = await db.select().from(erpProductionPlans).where(eq(erpProductionPlans.id, planId));
  if (!plan) return err("That plan no longer exists.", "not_found");
  if (isPastPlan(plan.planDate)) return err(PAST_PLAN);
  const items = await planCatalogue();
  const item = items.find((i) => i.id === input.itemId && i.category === input.category) ?? null;
  const problems = lineProblems(input, { itemExists: !!item, size: item?.size ?? null });
  const fields = Object.entries(problems);
  if (fields.length) return err(fields[0][1], "validation", fields.map(([field, message]) => ({ field, message })));
  const spec = categorySpec(input.category)!;
  const values = {
    category: input.category,
    itemId: item!.id,
    productName: item!.name,
    productCode: item!.code,
    size: spec.sizeLabel ? item!.size : null,
    quantity: Number(input.quantity),
    unit: input.unit,
    remarks: (input.remarks ?? "").trim() || null,
    ...(input.forExpected != null ? { forExpected: input.category === "sfg" && input.forExpected } : {}),
    updatedById: ctx.user.id,
    updatedAt: new Date(),
  };
  const id = lineId ?? erpId("eplnl");
  const before = lineId ? (await db.select().from(erpProductionPlanLines).where(and(eq(erpProductionPlanLines.id, lineId), eq(erpProductionPlanLines.planId, planId), isNull(erpProductionPlanLines.deletedAt))))[0] : null;
  if (lineId && !before) return err("That line was deleted. Reopen the plan.", "not_found");
  if (before?.source === "order") return err(FROM_ORDERS);
  await db.transaction(async (tx) => {
    if (before) await tx.update(erpProductionPlanLines).set(values).where(eq(erpProductionPlanLines.id, id));
    else {
      const [{ n }] = (await tx.execute(sql`select coalesce(max(sort), 0)::int + 1 as n from erp_production_plan_lines where plan_id = ${planId}`)) as unknown as { n: number }[];
      await tx.insert(erpProductionPlanLines).values({ id, planId, sort: n, createdById: ctx.user.id, ...values });
    }
    await tx.update(erpProductionPlans).set({ updatedById: ctx.user.id, updatedAt: new Date() }).where(eq(erpProductionPlans.id, planId));
  });
  await erpAudit(ctx, before ? "erp.plan.lineEdit" : "erp.plan.lineAdd", "erp_production_plan_line", id, before ? snap(before) : null, values);
  return ok({ id }, before ? "Line saved" : `Added to PLAN-${plan.planNo}`);
}

export async function deletePlanLine(ctx: ErpContext, lineId: string): Promise<Result<undefined>> {
  const [line] = await db.select().from(erpProductionPlanLines).where(and(eq(erpProductionPlanLines.id, lineId), isNull(erpProductionPlanLines.deletedAt)));
  if (!line) return err("That line is already deleted.", "not_found");
  if (line.source === "order") return err(FROM_ORDERS);
  const [plan] = await db.select({ planDate: erpProductionPlans.planDate }).from(erpProductionPlans).where(eq(erpProductionPlans.id, line.planId));
  if (plan && isPastPlan(plan.planDate)) return err(PAST_PLAN);
  await db.transaction(async (tx) => {
    await tx.update(erpProductionPlanLines).set({ deletedAt: new Date(), deletedById: ctx.user.id }).where(eq(erpProductionPlanLines.id, lineId));
    await tx.update(erpProductionPlans).set({ updatedById: ctx.user.id, updatedAt: new Date() }).where(eq(erpProductionPlans.id, line.planId));
  });
  await erpAudit(ctx, "erp.plan.lineDelete", "erp_production_plan_line", lineId, snap(line), null);
  return okVoid("Line deleted");
}

/**
 * Records a print: the live lines exactly as they stand. Printing again with
 * nothing changed answers with the last print instead of a second copy of it.
 */
export async function recordPlanPrint(ctx: ErpContext, planId: string): Promise<Result<{ printNo: number }>> {
  const [plan] = await db.select({ planDate: erpProductionPlans.planDate, godownId: erpProductionPlans.godownId }).from(erpProductionPlans).where(eq(erpProductionPlans.id, planId));
  if (!plan) return err("That plan no longer exists.", "not_found");
  const planRow = plan;
  if (isPastPlan(plan.planDate)) return err(PAST_PLAN);
  /* The sheet carries the orders as they stand at the moment it is printed. */
  await syncPlanFromOrders(planId);
  const lines = await db
    .select()
    .from(erpProductionPlanLines)
    .where(and(eq(erpProductionPlanLines.planId, planId), isNull(erpProductionPlanLines.deletedAt)))
    .orderBy(asc(erpProductionPlanLines.sort), asc(erpProductionPlanLines.createdAt));
  if (!lines.length) return err("Add at least one line before printing.");
  const [last] = await db.select().from(erpProductionPlanPrints).where(eq(erpProductionPlanPrints.planId, planId)).orderBy(desc(erpProductionPlanPrints.printNo)).limit(1);
  const snapshot = lines.map(snap);
  const expected = expectedBox(await planExpected(planRow.godownId));
  if (last && JSON.stringify(last.lines) === JSON.stringify(snapshot) && JSON.stringify(last.expected ?? []) === JSON.stringify(expected)) return ok({ printNo: last.printNo });
  const printNo = (last?.printNo ?? 0) + 1;
  await db.insert(erpProductionPlanPrints).values({ id: erpId("eplnp"), planId, printNo, printedById: ctx.user.id, lines: snapshot, expected });
  await erpAudit(ctx, "erp.plan.print", "erp_production_plan", planId, null, { printNo, lines: snapshot.length });
  return ok({ printNo });
}

/* ---------------------------------------------------------------------------
 * THE ORDERS COME IN BY THEMSELVES. Every order line whose status is "Under
 * Process" (Orders → Production) is one plan line per product, kept in step
 * with the orders whenever the plan is opened, made or printed. A product
 * whose orders all leave Under Process (Ready, held, cancelled) is marked
 * deleted, so a sheet that already carried it lists it as removed. Only a plan
 * for today or later is touched: a past day's plan is the record of that day.
 * The plan's godown narrows the orders to its own, where it names one.
 * ------------------------------------------------------------------------- */

const FROM_ORDERS = "This line comes from the orders under process. Change the order on Orders → Production, and the plan follows.";

/** Exactly what Orders → Production lists as Under Process (`isWorkingLine`), less empty drums, which nobody makes. */
export async function underProcessLines(godownId: string | null): Promise<DemandLine[]> {
  return (await db.execute(sql`
    select o.order_no as "orderNo", p.id as "skuId", p.name as "skuName", p.external_code as "skuCode",
           p.cans_per_box as "cansPerBox", coalesce(p.millilitres_per_can, fg.millilitres) as millilitres,
           fg.id as "finishedGoodId", fg.name as "finishedGoodName", o.qty_cans as "qtyCans", o.remark,
           (select p2.external_code from products p2 where p2.finished_good_id = fg.id and p2.active and p2.cans_per_box = 1 order by p2.name limit 1) as "looseCode",
           fg.formulation_id as "formulationId", f.name as "formulationName", bc.name as party
      from erp_orders o
      join products p on p.id = o.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join product_formulations f on f.id = fg.formulation_id
      left join customers bc on bc.id = o.billing_customer_id
     where o.status = 'Under Process' and o.entry_status <> 'Done' and p.name <> 'Empty Drum'
       -- the two gates isWorkingLine reads (lineCleared): without them the
       -- day's plan carried orders still waiting for Accounts, held there, or
       -- held or uncleared at the MRP check (found 2026-11-17).
       and o.accounts_check = 'Approved' and o.production_check = 'Cleared'
       and ${godownId ? sql`o.godown_id = ${godownId}` : sql`true`}
  `)) as unknown as DemandLine[];
}

/** Brings the plan's order lines in step with the orders. Answers how many lines moved. */
export async function syncPlanFromOrders(planId: string): Promise<number> {
  const [plan] = await db.select().from(erpProductionPlans).where(eq(erpProductionPlans.id, planId));
  if (!plan || isPastPlan(plan.planDate)) return 0;
  const demand = orderDemand(await underProcessLines(plan.godownId));
  return db.transaction(async (tx) => {
    /* One sync per plan at a time: two tabs opening the plan must not both insert a line. */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp:plan:${planId}`}))`);
    const have = await tx
      .select()
      .from(erpProductionPlanLines)
      .where(and(eq(erpProductionPlanLines.planId, planId), eq(erpProductionPlanLines.source, "order")));
    const byKey = new Map(have.map((l) => [l.sourceKey!, l]));
    const now = new Date();
    let moved = 0;
    let [{ n: sort }] = (await tx.execute(sql`select coalesce(max(sort), 0)::int as n from erp_production_plan_lines where plan_id = ${planId}`)) as unknown as { n: number }[];
    for (const d of demand) {
      const l = byKey.get(d.key);
      byKey.delete(d.key);
      const values = { category: d.category, itemId: d.itemId, productName: d.productName, productCode: d.productCode, size: d.size, quantity: d.quantity, unit: d.unit, orderRefs: d.orderRefs, remarks: d.remarks };
      if (!l) {
        await tx.insert(erpProductionPlanLines).values({ id: erpId("eplnl"), planId, source: "order", sourceKey: d.key, sort: ++sort, ...values });
        moved++;
      } else if (l.deletedAt || l.quantity !== d.quantity || l.unit !== d.unit || l.orderRefs !== d.orderRefs || (l.remarks ?? null) !== d.remarks || l.productName !== d.productName || l.productCode !== d.productCode || l.size !== d.size) {
        await tx.update(erpProductionPlanLines).set({ ...values, deletedAt: null, deletedById: null, updatedAt: now, updatedById: null }).where(eq(erpProductionPlanLines.id, l.id));
        moved++;
      }
    }
    for (const l of byKey.values()) {
      if (l.deletedAt) continue;
      await tx.update(erpProductionPlanLines).set({ deletedAt: now, deletedById: null }).where(eq(erpProductionPlanLines.id, l.id));
      moved++;
    }
    if (moved) await tx.update(erpProductionPlans).set({ updatedAt: now }).where(eq(erpProductionPlans.id, planId));
    return moved;
  });
}

/* ---------------------------------------------------------------------------
 * EXPECTED ORDERS. What is not yet confirmed but will be by the afternoon:
 * orders Accounts approved that wait for the MRP check, and TOs that wait for
 * Accounts (sent back to the taker counts too; a hold is listed, not
 * counted). Read whenever the plan is opened, so an approval moves a TO up a
 * column by itself and a declined or cancelled one drops off. Nothing here
 * writes a plan line: see `engines/expected-plan.ts`.
 * ------------------------------------------------------------------------- */

export type ExpectedEntry = {
  key: string;
  ref: string;
  fromTo: string | null;
  stage: "mrp" | "accounts";
  party: string;
  since: string;
  by: string | null;
  held: boolean;
  holdReason: string | null;
  sentBack: boolean;
  noGodown: boolean;
  goods: string[];
  /** The bases its products are made from, so a short one can be started ahead from its row. */
  baseIds: string[];
  check: { tone: "ok" | "short" | "muted"; lines: { tone: "ok" | "short" | "muted"; text: string }[] };
  counted: boolean;
};

export type PlanExpected = ExpectedPlan & { entries: ExpectedEntry[] };

const holdLabel = (code: string | null) =>
  code ? ([...ACCOUNTS_HOLD_REASONS, ...PRODUCTION_HOLD_REASONS].find((r) => r.code === code)?.label ?? code) : null;

type SourceLine = DemandLine & { lineId: string; boxed: boolean; canMaterialId: string | null; canMaterial: string | null };
type SourceRow = Omit<ExpectedSource, "lines"> & { lines: SourceLine[]; godownId: string | null };

const LINE_COLS = sql`
  p.id as "skuId", p.name as "skuName", p.external_code as "skuCode", coalesce(p.cans_per_box, 1) as "cansPerBox",
  coalesce(p.millilitres_per_can, fg.millilitres) as millilitres, fg.id as "finishedGoodId", fg.name as "finishedGoodName",
  fg.formulation_id as "formulationId", f.name as "formulationName",
  coalesce(pk.box_type, '') <> '' as boxed, pk.can_use_material_id as "canMaterialId", rm.name as "canMaterial"`;
const LINE_JOINS = sql`
  left join finished_goods fg on fg.id = p.finished_good_id
  left join product_formulations f on f.id = fg.formulation_id
  left join erp_product_packing pk on pk.product_id = p.id
  left join erp_raw_materials rm on rm.id = pk.can_use_material_id`;

/** The orders and TOs a plan's day is expecting, at its godown (a TO naming none is listed too). */
export async function expectedSources(godownId: string | null): Promise<SourceRow[]> {
  const [orders, tos] = await Promise.all([
    db.execute(sql`
      select o.id as "lineId", o.order_no as "orderNo", o.qty_cans as "qtyCans", o.godown_id as "godownId", bc.name as party, ${LINE_COLS},
             o.accounts_checked_at as since, au.name as by, i.to_no as "toNo", o.production_check as "productionCheck",
             (select h.reason from erp_order_holds h where h.order_no = o.order_no and h.resolved_at is null order by h.raised_at desc limit 1) as "holdReason"
        from erp_orders o
        join products p on p.id = o.sku_id
        ${LINE_JOINS}
        left join customers bc on bc.id = o.billing_customer_id
        left join users au on au.id = o.accounts_checked_by_id
        left join erp_order_intakes i on i.id = o.intake_id
       where o.status <> 'Cancel' and o.source = 'erp' and o.entry_status <> 'Done' and p.name <> 'Empty Drum'
         and o.accounts_check = 'Approved' and o.production_check in ('Pending', 'Hold')
         and ${godownId ? sql`o.godown_id = ${godownId}` : sql`true`}
       order by o.accounts_checked_at nulls last, o.order_no, o.created_at
       limit 3000`) as unknown as Promise<(SourceLine & { since: Date | string | null; by: string | null; toNo: number | null; productionCheck: string; holdReason: string | null; godownId: string | null })[]>,
    db.execute(sql`
      select l.id as "lineId", i.to_no as "toNo", l.qty_cans as "qtyCans", i.godown_id as "godownId", bc.name as party, ${LINE_COLS},
             i.created_at as since, tu.name as by, i.status, i.hold_reason as "holdReason"
        from erp_order_intakes i
        join erp_order_intake_lines l on l.intake_id = i.id
        join products p on p.id = l.sku_id
        ${LINE_JOINS}
        left join customers bc on bc.id = i.billing_customer_id
        left join users tu on tu.id = i.taken_by_id
       where i.status in ('open', 'correction', 'hold') and i.order_no is null and p.name <> 'Empty Drum'
         and ${godownId ? sql`(i.godown_id = ${godownId} or i.godown_id is null)` : sql`true`}
       order by i.created_at, l.position
       limit 3000`) as unknown as Promise<(SourceLine & { since: Date | string; by: string | null; toNo: number; status: string; holdReason: string | null; godownId: string | null })[]>,
  ]);
  const out = new Map<string, SourceRow>();
  const line = (r: SourceLine & { orderNo?: number | null }): SourceLine => ({
    ...r,
    orderNo: Number(r.orderNo ?? 0),
    qtyCans: Number(r.qtyCans),
    cansPerBox: Number(r.cansPerBox) || 1,
    millilitres: r.millilitres == null ? null : Number(r.millilitres),
  });
  for (const r of orders) {
    const key = `o:${r.orderNo}`;
    const s = out.get(key) ?? {
      key,
      stage: "mrp" as const,
      orderNo: Number(r.orderNo),
      toNo: r.toNo == null ? null : Number(r.toNo),
      party: r.party ?? "",
      since: new Date(r.since ?? Date.now()).toISOString(),
      by: r.by,
      held: false,
      holdReason: null,
      sentBack: false,
      noGodown: false,
      lines: [],
      godownId: r.godownId,
    };
    if (r.productionCheck === "Hold" || r.holdReason) {
      s.held = true;
      s.holdReason = holdLabel(r.holdReason) ?? s.holdReason;
    }
    s.lines.push(line(r));
    out.set(key, s);
  }
  for (const r of tos) {
    const key = `t:${r.toNo}`;
    const s = out.get(key) ?? {
      key,
      stage: "accounts" as const,
      orderNo: null,
      toNo: Number(r.toNo),
      party: r.party ?? "",
      since: new Date(r.since).toISOString(),
      by: r.by,
      held: r.status === "hold",
      holdReason: r.status === "hold" ? holdLabel(r.holdReason) : null,
      sentBack: r.status === "correction",
      noGodown: !r.godownId,
      lines: [],
      godownId: r.godownId,
    };
    s.lines.push(line({ ...r, orderNo: 0 }));
    out.set(key, s);
  }
  return [...out.values()];
}

/** Everything the plan's three tabs and the printed box say about expected work. */
export async function planExpected(godownId: string | null): Promise<PlanExpected> {
  const [confirmed, sources, stockMap] = await Promise.all([underProcessLines(godownId), expectedSources(godownId), godownId ? mrpStockAt([godownId]) : Promise.resolve(new Map())]);
  const stock = godownId ? stockMap.get(godownId) : undefined;
  const plan = expectedPlan(
    confirmed.map((l) => ({ ...l, qtyCans: Number(l.qtyCans), cansPerBox: Number(l.cansPerBox) || 1, millilitres: l.millilitres == null ? null : Number(l.millilitres) })),
    sources,
    stock ? { looseCans: stock.looseCans, packedBoxes: stock.packedBoxes, baseLitres: stock.baseLitres } : { looseCans: new Map(), packedBoxes: new Map(), baseLitres: new Map() },
  );
  const entries: ExpectedEntry[] = sources
    .sort((x, y) => (x.stage === y.stage ? x.since.localeCompare(y.since) : x.stage === "mrp" ? -1 : 1))
    .map((s) => {
      let check: ExpectedEntry["check"];
      if (s.held) check = { tone: "muted", lines: [{ tone: "muted", text: "Not counted while on hold" }] };
      else if (s.noGodown) check = { tone: "muted", lines: [{ tone: "muted", text: "Pick a godown to check" }] };
      else if (!stock) check = { tone: "muted", lines: [{ tone: "muted", text: "The plan names no godown" }] };
      else {
        const answer = mrpCheck(
          s.lines.map((l) => ({
            lineId: l.lineId,
            sku: l.skuName,
            skuId: l.skuId,
            cans: l.qtyCans,
            litresPerCan: (l.millilitres ?? 0) / 1000,
            boxed: !!l.boxed,
            cansPerBox: l.cansPerBox,
            finishedGoodId: l.finishedGoodId,
            formulationId: l.formulationId ?? null,
            formulation: l.formulationName ?? null,
            canMaterialId: l.canMaterialId,
            canMaterial: l.canMaterial,
          })),
          stock,
        );
        check = stockCheckWords(answer, new Map(s.lines.map((l) => [l.lineId, l.formulationId ?? null])));
      }
      const goods = new Map<string, number>();
      for (const l of s.lines) goods.set(l.skuName, (goods.get(l.skuName) ?? 0) + l.qtyCans);
      return {
        key: s.key,
        ref: sourceRef(s),
        fromTo: s.orderNo != null && s.toNo != null ? `TO-${s.toNo}` : null,
        stage: s.stage,
        party: s.party,
        since: s.since,
        by: s.by,
        held: s.held,
        holdReason: s.holdReason,
        sentBack: s.sentBack,
        noGodown: s.noGodown,
        goods: [...goods].map(([n, c]) => `${n} × ${c}`),
        baseIds: [...new Set(s.lines.map((l) => l.formulationId).filter((x): x is string => !!x))],
        check,
        counted: counted(s),
      };
    });
  return { ...plan, entries };
}

/** The printed "Expected · not approved yet" box: each product still waiting, in boxes where it is whole boxes. */
export function expectedBox(e: ExpectedPlan): PlanSnapshotExpected[] {
  return e.products
    .filter((p) => p.mrp + p.accounts > 0)
    .map((p) => {
      const boxes = p.cansPerBox > 1 && p.mrp % p.cansPerBox === 0 && p.accounts % p.cansPerBox === 0;
      const d = boxes ? p.cansPerBox : 1;
      return { productName: p.name, quantity: (p.mrp + p.accounts) / d, unit: boxes ? "Boxes" : "Cans", mrp: p.mrp / d, accounts: p.accounts / d };
    });
}
