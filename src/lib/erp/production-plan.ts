import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpProductionPlanLines, erpProductionPlanPrints, erpProductionPlans, type PlanSnapshotLine } from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { erpAudit, erpId, nextNumber } from "./server";
import { fgLots, packLots, sfgLots } from "./stock";
import { categorySpec, changedSince, lineProblems, lineState, sizeName, type LineInput, type LineState, type PlanCategory } from "./engines/production-plan";

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
};

/** Plans newest first, or the one for a date. */
export async function listPlans(opts: { date?: string | null; limit?: number } = {}): Promise<PlanSummary[]> {
  const rows = (await db.execute(sql`
    select p.id, p.plan_no as "planNo", p.plan_date::text as "planDate", u.name as "createdBy", p.updated_at as "updatedAt",
           (select count(*)::int from erp_production_plan_lines l where l.plan_id = p.id and l.deleted_at is null) as lines,
           (select count(*)::int from erp_production_plan_prints x where x.plan_id = p.id) as prints,
           (select max(x.printed_at) from erp_production_plan_prints x where x.plan_id = p.id) as "lastPrintedAt"
      from erp_production_plans p left join users u on u.id = p.created_by_id
     where ${opts.date ? sql`p.plan_date = ${opts.date}` : sql`true`}
     order by p.plan_date desc limit ${opts.limit ?? 60}
  `)) as unknown as (Omit<PlanSummary, "updatedAt" | "lastPrintedAt"> & { updatedAt: Date | string; lastPrintedAt: Date | string | null })[];
  return rows.map((r) => ({ ...r, updatedAt: new Date(r.updatedAt).toISOString(), lastPrintedAt: r.lastPrintedAt ? new Date(r.lastPrintedAt).toISOString() : null }));
}

export type PlanLineView = PlanSnapshotLine & {
  itemId: string | null;
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
  return { id: l.id, category: l.category, productName: l.productName, productCode: l.productCode, size: l.size, quantity: l.quantity, unit: l.unit, remarks: l.remarks };
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
    select x.print_no as "printNo", x.printed_at as "printedAt", u.name as "printedBy", x.lines
      from erp_production_plan_prints x left join users u on u.id = x.printed_by_id
     where x.plan_id = ${id} and x.print_no in (${printNo}, ${printNo - 1}) order by x.print_no`)) as unknown as {
    printNo: number;
    printedAt: Date | string;
    printedBy: string | null;
    lines: PlanSnapshotLine[];
  }[];
  const cur = rows.find((r) => r.printNo === printNo);
  if (!cur) return null;
  const prev = rows.find((r) => r.printNo === printNo - 1) ?? null;
  return { current: { ...cur, printedAt: new Date(cur.printedAt).toISOString() }, previous: prev ? { ...prev, printedAt: new Date(prev.printedAt).toISOString() } : null };
}

/* ------------------------------------------------------------------ writes */

/** Opens the plan for a date, making it if there is none — one plan per day. */
export async function openPlanFor(ctx: ErpContext, date: string): Promise<Result<{ id: string; created: boolean }>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fieldErr("date", "Pick the plan date.");
  const [have] = await db.select({ id: erpProductionPlans.id }).from(erpProductionPlans).where(eq(erpProductionPlans.planDate, date));
  if (have) return ok({ id: have.id, created: false });
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
  return ok({ id: res.id, created: true }, `PLAN-${res.planNo} made for ${date}`);
}

/** Adds a line, or edits one. A line already printed keeps its id, so the next print can say it changed. */
export async function savePlanLine(ctx: ErpContext, planId: string, input: LineInput, lineId?: string): Promise<Result<{ id: string }>> {
  const [plan] = await db.select().from(erpProductionPlans).where(eq(erpProductionPlans.id, planId));
  if (!plan) return err("That plan no longer exists.", "not_found");
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
    updatedById: ctx.user.id,
    updatedAt: new Date(),
  };
  const id = lineId ?? erpId("eplnl");
  const before = lineId ? (await db.select().from(erpProductionPlanLines).where(and(eq(erpProductionPlanLines.id, lineId), eq(erpProductionPlanLines.planId, planId), isNull(erpProductionPlanLines.deletedAt))))[0] : null;
  if (lineId && !before) return err("That line was deleted. Reopen the plan.", "not_found");
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
  const lines = await db
    .select()
    .from(erpProductionPlanLines)
    .where(and(eq(erpProductionPlanLines.planId, planId), isNull(erpProductionPlanLines.deletedAt)))
    .orderBy(asc(erpProductionPlanLines.sort), asc(erpProductionPlanLines.createdAt));
  if (!lines.length) return err("Add at least one line before printing.");
  const [last] = await db.select().from(erpProductionPlanPrints).where(eq(erpProductionPlanPrints.planId, planId)).orderBy(desc(erpProductionPlanPrints.printNo)).limit(1);
  const snapshot = lines.map(snap);
  if (last && JSON.stringify(last.lines) === JSON.stringify(snapshot)) return ok({ printNo: last.printNo });
  const printNo = (last?.printNo ?? 0) + 1;
  await db.insert(erpProductionPlanPrints).values({ id: erpId("eplnp"), planId, printNo, printedById: ctx.user.id, lines: snapshot });
  await erpAudit(ctx, "erp.plan.print", "erp_production_plan", planId, null, { printNo, lines: snapshot.length });
  return ok({ printNo });
}
