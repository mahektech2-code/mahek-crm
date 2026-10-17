import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpFloorChecks } from "@/db/schema";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { judgeCount } from "./engines/stock-check";
import { erpId } from "./server";
import { fgLots, packLots, rmLots, sfgLots, stockUnit } from "./stock";
import { shelfFacts } from "./stock-check";

/* ---------------------------------------------------------------------------
 * STOCK CHECKS FROM THE FLOOR.
 *
 * Anybody, at any time, picks any item at their godown — a raw material, a
 * semi-finished lot's product, a finished good in cans or a packed SKU in
 * boxes — counts it and sends the figure. Nothing about the book reaches the
 * phone before the figure does: the book is read HERE, at the moment of
 * saving, judged with the same rule a formal count uses (`judgeCount`), and
 * stored beside the figure as a snapshot.
 *
 * A check moves no stock. A mismatch waits on ERP → Stock accuracy → Stock
 * checks and on the dashboard until somebody in the office reviews it; on a
 * raw material it can be raised into a formal count, whose red flag, recount
 * and approved adjustment are the only way the book changes.
 * ------------------------------------------------------------------------- */

export type CheckStage = "rm" | "sfg" | "fg" | "pack";
export const CHECK_STAGES: CheckStage[] = ["rm", "sfg", "fg", "pack"];
export const STAGE_LABEL: Record<CheckStage, string> = { rm: "Raw material", sfg: "Semi-finished", fg: "Filled cans", pack: "Packed boxes" };
export type CheckUnit = "Ltr" | "Pcs" | "Cans" | "Boxes";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const today = () => calendarDate(new Date());

export type CheckableItem = {
  stage: CheckStage;
  id: string;
  name: string;
  unit: CheckUnit;
  /** On the book at this godown — used only to list those first. Never the quantity. */
  here: boolean;
  /** The newest check of it here today, if any. */
  checkedToday: { matched: boolean; by: string; at: string } | null;
};

type Agg = { id: string; name: string; unit: CheckUnit; qty: number; godownId: string };

function sumBy<T>(rows: T[], f: (r: T) => Omit<Agg, "qty"> & { qty: number }): Map<string, Agg> {
  const out = new Map<string, Agg>();
  for (const r of rows) {
    const a = f(r);
    const k = `${a.id}|${a.godownId}`;
    const was = out.get(k);
    out.set(k, was ? { ...was, qty: was.qty + a.qty } : a);
  }
  return out;
}

/**
 * Every item the floor may check, per stage, with the ones on the book at
 * `godownId` first. `keep` narrows it — the factory app passes the person's
 * department reach (`lib/factory/stock-reach.ts`); a raw material is judged
 * by its item-master type.
 */
export async function checkableItems(godownId: string, keep?: (stage: CheckStage, materialType: string | null) => boolean): Promise<CheckableItem[]> {
  const [mats, rl, sl, fl, pl, done] = await Promise.all([
    db.execute(sql`select id, name, unit, material_type as "materialType" from erp_raw_materials where active order by name`) as unknown as Promise<{ id: string; name: string; unit: string; materialType: string | null }[]>,
    rmLots(),
    sfgLots(),
    fgLots(),
    packLots(),
    db.execute(sql`
      select distinct on (f.stage, f.item_id) f.stage, f.item_id as "itemId", f.matched, u.name as by, f.counted_at as at
        from erp_floor_checks f join users u on u.id = f.counted_by_id
       where f.godown_id = ${godownId} and (f.counted_at at time zone ${APP_TIMEZONE})::date = ${today()}::date
       order by f.stage, f.item_id, f.counted_at desc`) as unknown as Promise<{ stage: CheckStage; itemId: string; matched: boolean; by: string; at: Date | string }[]>,
  ]);
  const seen = new Map(done.map((d) => [`${d.stage}|${d.itemId}`, { matched: d.matched, by: d.by, at: new Date(d.at).toISOString() }]));
  const here = (m: Map<string, Agg>, id: string) => Math.abs(m.get(`${id}|${godownId}`)?.qty ?? 0) > 0.0005;
  const out: CheckableItem[] = [];
  const push = (stage: CheckStage, items: { id: string; name: string; unit: CheckUnit }[], m: Map<string, Agg>) => {
    const list = items.map((i) => ({ stage, ...i, here: here(m, i.id), checkedToday: seen.get(`${stage}|${i.id}`) ?? null }));
    list.sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
    out.push(...list);
  };
  const distinct = (m: Map<string, Agg>) => [...new Map([...m.values()].map((a) => [a.id, { id: a.id, name: a.name, unit: a.unit }])).values()];

  const rm = sumBy(rl, (l) => ({ id: l.rawMaterialId, name: l.item, unit: stockUnit(l.unit), qty: l.stock, godownId: l.godownId }));
  push("rm", mats.filter((m) => !keep || keep("rm", m.materialType)).map((m) => ({ id: m.id, name: m.name, unit: stockUnit(m.unit) })), rm);
  const sfg = sumBy(sl, (l) => ({ id: l.formulationId, name: l.product, unit: "Ltr", qty: l.stock, godownId: l.godownId }));
  if (!keep || keep("sfg", null)) push("sfg", distinct(sfg), sfg);
  const fg = sumBy(fl, (l) => ({ id: l.finishedGoodId, name: l.product, unit: "Cans", qty: l.stock, godownId: l.godownId }));
  if (!keep || keep("fg", null)) push("fg", distinct(fg), fg);
  const pack = sumBy(pl, (l) => ({ id: l.skuId, name: l.sku, unit: "Boxes", qty: l.stock, godownId: l.godownId }));
  if (!keep || keep("pack", null)) push("pack", distinct(pack), pack);
  return out;
}

type Book = { name: string; unit: CheckUnit; book: number; pendingIn: number; tolerancePercent: number; toleranceFloor: number };

/** The book for one item at one godown, read now. Null when the item is not one the ERP knows. */
async function bookFor(stage: CheckStage, itemId: string, godownId: string): Promise<Book | null> {
  if (stage === "rm") {
    const [m] = (await db.execute(sql`select name from erp_raw_materials where id = ${itemId}`)) as unknown as { name: string }[];
    if (!m) return null;
    const f = await shelfFacts(itemId, godownId);
    return { name: f.item || m.name, unit: f.unit, book: f.book, pendingIn: r3(f.pendingIn - f.pendingOut), tolerancePercent: f.tolerancePercent, toleranceFloor: f.toleranceFloor };
  }
  const c = await getConfig();
  const tol = { tolerancePercent: c["erp.stockCheck.tolerancePercent"], toleranceFloor: c["erp.stockCheck.toleranceFloor"] };
  const pick = <T,>(lots: T[], id: (l: T) => string, name: (l: T) => string, g: (l: T) => string, q: (l: T) => number, unit: CheckUnit): Book | null => {
    const all = lots.filter((l) => id(l) === itemId);
    if (!all.length) return null;
    const mine = all.filter((l) => g(l) === godownId);
    return { name: name(all[0]), unit, book: r3(mine.reduce((t, l) => t + q(l), 0)), pendingIn: 0, ...tol };
  };
  if (stage === "sfg") return pick(await sfgLots(), (l) => l.formulationId, (l) => l.product, (l) => l.godownId, (l) => l.stock, "Ltr");
  if (stage === "fg") return pick(await fgLots(), (l) => l.finishedGoodId, (l) => l.product, (l) => l.godownId, (l) => l.stock, "Cans");
  return pick(await packLots(), (l) => l.skuId, (l) => l.sku, (l) => l.godownId, (l) => l.stock, "Boxes");
}

export type FloorCheckResult = {
  id: string;
  stage: CheckStage;
  item: string;
  godown: string;
  unit: CheckUnit;
  counted: number;
  /** Book + what is on the shelf and not in it yet. */
  book: number;
  difference: number;
  tolerance: number;
  matched: boolean;
  reason: string | null;
  replay?: boolean;
};

export type FloorCheckInput = {
  stage: CheckStage;
  itemId: string;
  godownId: string;
  qty: number;
  bin?: string | null;
  reason?: string | null;
  key?: string | null;
  source: "factory" | "erp";
};

async function resultOf(id: string, replay = false): Promise<FloorCheckResult | null> {
  const [r] = (await db.execute(sql`
    select f.id, f.stage, f.item_name as item, g.name as godown, f.unit, f.counted_qty::float8 as counted,
           (f.book_qty + f.pending_in)::float8 as book, f.difference::float8 as difference, f.tolerance::float8 as tolerance, f.matched, f.reason
      from erp_floor_checks f join erp_godowns g on g.id = f.godown_id where f.id = ${id}`)) as unknown as FloorCheckResult[];
  return r ? { ...r, replay } : null;
}

/** Records one check. A resend under the same key answers with the first save. */
export async function recordFloorCheck(byId: string, input: FloorCheckInput): Promise<{ ok: true; check: FloorCheckResult } | { ok: false; field: "item" | "qty" | "godown"; error: string }> {
  if (!CHECK_STAGES.includes(input.stage)) return { ok: false, field: "item", error: "Pick what kind of stock it is." };
  if (!Number.isFinite(input.qty) || input.qty < 0) return { ok: false, field: "qty", error: "Enter what you counted — zero if there is none." };
  const key = input.key?.trim().slice(0, 80) || null;
  if (key) {
    const [had] = (await db.execute(sql`select id from erp_floor_checks where client_key = ${key}`)) as unknown as { id: string }[];
    if (had) return { ok: true, check: (await resultOf(had.id, true))! };
  }
  const [g] = (await db.execute(sql`select id from erp_godowns where id = ${input.godownId} and not reserved`)) as unknown as { id: string }[];
  if (!g) return { ok: false, field: "godown", error: "That godown is not one stock is checked at." };
  const b = await bookFor(input.stage, input.itemId, input.godownId);
  if (!b) return { ok: false, field: "item", error: "That item is not one the ERP holds stock of." };
  const j = judgeCount({ counted: input.qty, book: b.book, pendingIn: b.pendingIn, pendingOut: 0, tolerancePercent: b.tolerancePercent, toleranceFloor: b.toleranceFloor });
  const id = erpId("fck");
  const matched = j.verdict === "matched";
  const inserted = await db
    .insert(erpFloorChecks)
    .values({
      id,
      stage: input.stage,
      itemId: input.itemId,
      itemName: b.name,
      godownId: input.godownId,
      unit: b.unit,
      countedQty: input.qty,
      bookQty: b.book,
      pendingIn: b.pendingIn,
      difference: j.difference,
      tolerance: j.tolerance,
      matched,
      reason: matched ? null : input.reason?.trim().slice(0, 1000) || null,
      bin: input.bin?.trim().slice(0, 120) || null,
      source: input.source,
      clientKey: key,
      countedById: byId,
    })
    .onConflictDoNothing({ target: erpFloorChecks.clientKey })
    .returning({ id: erpFloorChecks.id });
  if (!inserted.length && key) {
    const [had] = (await db.execute(sql`select id from erp_floor_checks where client_key = ${key}`)) as unknown as { id: string }[];
    return { ok: true, check: (await resultOf(had.id, true))! };
  }
  return { ok: true, check: (await resultOf(id))! };
}

/** The counter says why it differs. Theirs to write, until the office has reviewed it. */
export async function setFloorCheckReason(byId: string, id: string, reason: string): Promise<boolean> {
  const r = (await db.execute(sql`
    update erp_floor_checks set reason = ${reason.trim().slice(0, 1000) || null}
     where id = ${id} and counted_by_id = ${byId} and not matched and reviewed_at is null
     returning id`)) as unknown as { id: string }[];
  return r.length > 0;
}

export type FloorCheckRow = FloorCheckResult & {
  godownId: string;
  itemId: string;
  bin: string | null;
  source: string;
  counter: string;
  countedAt: Date;
  reviewer: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  stockCountId: string | null;
  stockCountNo: number | null;
};

/** Checks for the ERP's list and the factory's recent list. */
export async function floorCheckRows(where = sql`true`, limit = 500): Promise<FloorCheckRow[]> {
  const rows = (await db.execute(sql`
    select f.id, f.stage, f.item_id as "itemId", f.item_name as item, f.godown_id as "godownId", g.name as godown, f.unit,
           f.counted_qty::float8 as counted, (f.book_qty + f.pending_in)::float8 as book, f.difference::float8 as difference,
           f.tolerance::float8 as tolerance, f.matched, f.reason, f.bin, f.source, uc.name as counter, f.counted_at as "countedAt",
           ur.name as reviewer, f.reviewed_at as "reviewedAt", f.review_note as "reviewNote",
           f.stock_count_id as "stockCountId", sc.count_no as "stockCountNo"
      from erp_floor_checks f
      join erp_godowns g on g.id = f.godown_id
      join users uc on uc.id = f.counted_by_id
      left join users ur on ur.id = f.reviewed_by_id
      left join erp_stock_counts sc on sc.id = f.stock_count_id
     where ${where}
     order by f.counted_at desc
     limit ${limit}`)) as unknown as FloorCheckRow[];
  return rows.map((r) => ({ ...r, stockCountNo: r.stockCountNo == null ? null : Number(r.stockCountNo) }));
}

/** Mismatches nobody in the office has looked at yet — the dashboard's red tile. */
export async function openMismatches(): Promise<{ id: string; godown: string }[]> {
  return (await db.execute(sql`
    select f.id, g.name as godown from erp_floor_checks f join erp_godowns g on g.id = f.godown_id
     where not f.matched and f.reviewed_at is null`)) as unknown as { id: string; godown: string }[];
}
