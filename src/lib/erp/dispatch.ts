import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { getConfig } from "@/lib/config/store";
import type { ErpContext } from "./access";
import { erpAudit, erpId } from "./server";
import { allocationTarget, boxQuantity } from "./engines/sales";
import { normaliseCode, packLabel, scanGate, scanVerdict, type ScanLine, type ScanUnit, type ScanVerdict, type UnitStatus } from "./engines/trace";
import { fgLots, lockLot, packLots, type Ex } from "./stock";
import { unitEvent } from "./units";
import { inTx, refuse, type Tx } from "./screens/common";

/* ---------------------------------------------------------------------------
 * THE DISPATCH DESK: an order is chosen, every box going onto the lorry is
 * scanned, and each scan is judged against the order before it counts.
 *
 * Scanning is where a LOT ALLOCATION becomes a BOX: a box of the allocated
 * lot is matched; a box of another lot of the same SKU takes that lot's place
 * (the allocation follows the box, and says so); a line still short of its
 * allocation takes the box's lot. A different product or pack size is refused
 * and can only go on an override somebody else approved, with a reason.
 *
 * "Do Verified" on billing & dispatch refuses a line whose boxes are not all
 * scanned (`scanGateFor`), and turns its scanned boxes into dispatched ones
 * (`markDispatched`). Every scan, refused ones included, is a row.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(ex: Ex, s: ReturnType<typeof sql>) => (await ex.execute(s)) as unknown as T[];

/* ============================================================ readings */

type LineRow = {
  id: string;
  orderNo: number;
  status: string;
  qty: number;
  skuId: string;
  sku: string;
  cpb: number;
  empty: number;
  litres: number | null;
  productId: string | null;
  product: string | null;
  godownId: string;
  godown: string;
  verification: string | null;
  billed: boolean;
};

async function lineRows(ex: Ex, orderNo: number): Promise<LineRow[]> {
  return q<LineRow>(ex, sql`
    select o.id, o.order_no as "orderNo", o.status, o.qty_cans::float8 as qty, p.id as "skuId", p.name as sku, p.cans_per_box as cpb,
           coalesce(pk.empty_boxes_required, 0)::int as empty,
           coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as litres,
           b.id as "productId", b.name as product, o.godown_id as "godownId", g.name as godown,
           d.verification, d.order_id is not null as billed
      from erp_orders o
      join products p on p.id = o.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join product_brands b on b.id = fg.brand_id
      left join erp_product_packing pk on pk.product_id = p.id
      join erp_godowns g on g.id = o.godown_id
      left join erp_order_details d on d.order_id = o.id
     where o.order_no = ${orderNo}
     order by p.name
  `);
}

async function scanLines(ex: Ex, orderNo: number): Promise<ScanLine[]> {
  const rows = await lineRows(ex, orderNo);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [alloc, scanned] = await Promise.all([
    q<{ id: string; order: string; lot: string; qty: number }>(ex, sql`select id, order_id as "order", lot_code as lot, quantity::float8 as qty from erp_batch_codes where order_id in ${ids} order by created_at`),
    q<{ order: string; lot: string; n: number }>(ex, sql`select order_id as "order", lot_code as lot, count(*)::int as n from erp_units where order_id in ${ids} and status in ('scanned', 'dispatched') group by 1, 2`),
  ]);
  const scannedLot = new Map(scanned.map((s) => [`${s.order}|${s.lot}`, Number(s.n)]));
  return rows.map((r) => {
    const boxed = Number(r.empty) > 0;
    const { boxes } = boxQuantity(Number(r.qty), Number(r.cpb), !boxed);
    /* Scans of one lot are spread over that lot's allocation rows in order, so two rows of one lot both read right. */
    const left = new Map<string, number>();
    const a = alloc
      .filter((x) => x.order === r.id)
      .map((x) => {
        const key = `${r.id}|${x.lot}`;
        const have = left.has(key) ? left.get(key)! : (scannedLot.get(key) ?? 0);
        const used = Math.min(have, Number(x.qty));
        left.set(key, have - used);
        return { id: x.id, lotCode: x.lot, qty: Number(x.qty), scanned: used };
      });
    return {
      id: r.id,
      orderNo: Number(r.orderNo),
      skuId: r.skuId,
      skuName: r.sku,
      productId: r.productId,
      productName: r.product ?? r.sku,
      packLabel: packLabel(r.litres),
      godownId: r.godownId,
      godownName: r.godown,
      boxed,
      target: allocationTarget(boxed, boxes, Number(r.qty)),
      scanned: scanned.filter((s) => s.order === r.id).reduce((n, s) => n + Number(s.n), 0),
      alloc: a,
      dispatched: r.verification === "Verified",
      /* Only a Ready line is at the desk; one under process, held or cancelled takes no box. */
      cancelled: r.status !== "Ready",
    };
  });
}

async function unitFor(ex: Ex, code: string, lock: boolean): Promise<ScanUnit | null> {
  const rows = await q<Row>(ex, sql`
    select u.id, u.status, u.sku_id as "skuId", p.name as sku, b.id as "productId", coalesce(b.name, p.name) as product,
           coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as litres,
           u.lot_from as "lotFrom", u.lot_code as "lotCode", u.godown_id as "godownId", g.name as godown,
           u.order_id as "orderId", o.order_no as "orderNo"
      from erp_units u
      join products p on p.id = u.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join product_brands b on b.id = fg.brand_id
      join erp_godowns g on g.id = u.godown_id
      left join erp_orders o on o.id = u.order_id
     where u.id = ${code}
     ${lock ? sql`for update of u` : sql``}
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    status: r.status as UnitStatus,
    skuId: String(r.skuId),
    skuName: String(r.sku),
    productId: r.productId == null ? null : String(r.productId),
    productName: String(r.product),
    packLabel: packLabel(r.litres == null ? null : Number(r.litres)),
    lotFrom: r.lotFrom === "pack" ? "pack" : "fg",
    lotCode: String(r.lotCode),
    godownId: String(r.godownId),
    godownName: String(r.godown),
    orderId: r.orderId == null ? null : String(r.orderId),
    orderNo: r.orderNo == null ? null : Number(r.orderNo),
  };
}

/* ============================================================ the board */

export type DispatchBoard = {
  orderNo: number;
  billing: string;
  delivery: string;
  area: string | null;
  transporter: string | null;
  dispatchOn: string | null;
  lines: (ScanLine & { billed: boolean; verification: string | null; gate: string | null; unitsExist: boolean })[];
  units: { id: string; lineId: string; sku: string; lotCode: string; status: string; scannedAt: string | null; by: string | null }[];
  scans: { at: string; code: string; result: string; message: string; by: string | null }[];
  overrides: { id: string; unitId: string; lineId: string; ordered: string; scanned: string; mismatch: string; reason: string; status: string; requestedBy: string | null; requestedById: string | null; at: string; decidedBy: string | null; note: string | null }[];
  requireScan: boolean;
};

export async function dispatchBoard(orderNo: number): Promise<DispatchBoard | null> {
  const lines = await scanLines(db, orderNo);
  if (!lines.length) return null;
  const ids = lines.map((l) => l.id);
  const [head, rows, units, scans, overrides, withUnits, cfg] = await Promise.all([
    q<Row>(db, sql`
      select bc.name as billing, dc.name as delivery, coalesce(dc.area, dc.city) as area, o.transporter, o.dispatch_on::text as "dispatchOn"
        from erp_orders o join customers bc on bc.id = o.billing_customer_id left join customers dc on dc.id = o.delivery_customer_id
       where o.order_no = ${orderNo} limit 1
    `),
    lineRows(db, orderNo),
    q<Row>(db, sql`
      select u.id, u.order_id as "lineId", p.name as sku, u.lot_code as "lotCode", u.status, u.scanned_at as "scannedAt", us.name as by
        from erp_units u join products p on p.id = u.sku_id left join users us on us.id = u.scanned_by_id
       where u.order_id in ${ids} and u.status in ('scanned', 'dispatched') order by u.scanned_at desc
    `),
    q<Row>(db, sql`
      select s.at, s.code, s.result, s.message, u.name as by from erp_dispatch_scans s left join users u on u.id = s.by_id
       where s.order_no = ${orderNo} order by s.at desc limit 40
    `),
    q<Row>(db, sql`
      select x.id, x.unit_id as "unitId", x.order_id as "lineId", po.name as ordered, ps.name as scanned, x.mismatch, x.reason, x.status,
             ru.name as "requestedBy", x.requested_by_id as "requestedById", x.requested_at as at, du.name as "decidedBy", x.decision_note as note
        from erp_dispatch_overrides x
        join products po on po.id = x.ordered_sku_id join products ps on ps.id = x.scanned_sku_id
        left join users ru on ru.id = x.requested_by_id left join users du on du.id = x.decided_by_id
       where x.order_id in ${ids} order by x.requested_at desc
    `),
    lotsWithUnitsFor(db, ids),
    getConfig(),
  ]);
  const requireScan = cfg["erp.dispatch.requireScan"];
  const meta = new Map(rows.map((r) => [r.id, r]));
  const h = head[0] ?? {};
  return {
    orderNo,
    billing: String(h.billing ?? ""),
    delivery: String(h.delivery ?? h.billing ?? ""),
    area: h.area == null ? null : String(h.area),
    transporter: h.transporter == null ? null : String(h.transporter),
    dispatchOn: h.dispatchOn == null ? null : String(h.dispatchOn),
    lines: lines.map((l) => {
      const unitsExist = withUnits.has(l.id);
      return { ...l, billed: !!meta.get(l.id)?.billed, verification: meta.get(l.id)?.verification ?? null, unitsExist, gate: scanGate({ requireScan, lotsHaveUnits: unitsExist, target: l.target, scanned: l.scanned }) };
    }),
    units: units.map((u) => ({ id: String(u.id), lineId: String(u.lineId), sku: String(u.sku), lotCode: String(u.lotCode), status: String(u.status), scannedAt: u.scannedAt == null ? null : new Date(u.scannedAt as string).toISOString(), by: u.by == null ? null : String(u.by) })),
    scans: scans.map((s) => ({ at: new Date(s.at as string).toISOString(), code: String(s.code), result: String(s.result), message: String(s.message), by: s.by == null ? null : String(s.by) })),
    overrides: overrides.map((o) => ({
      id: String(o.id),
      unitId: String(o.unitId),
      lineId: String(o.lineId),
      ordered: String(o.ordered),
      scanned: String(o.scanned),
      mismatch: String(o.mismatch),
      reason: String(o.reason),
      status: String(o.status),
      requestedBy: o.requestedBy == null ? null : String(o.requestedBy),
      requestedById: o.requestedById == null ? null : String(o.requestedById),
      at: new Date(o.at as string).toISOString(),
      decidedBy: o.decidedBy == null ? null : String(o.decidedBy),
      note: o.note == null ? null : String(o.note),
    })),
    requireScan,
  };
}

/** Lines (by id) at least one of whose allocated lots carries units, or which already have units scanned. */
async function lotsWithUnitsFor(ex: Ex, orderIds: string[]): Promise<Set<string>> {
  if (!orderIds.length) return new Set();
  const rows = await q<{ id: string }>(ex, sql`
    select distinct b.order_id as id from erp_batch_codes b
     where b.order_id in ${orderIds}
       and exists (select 1 from erp_units u where u.lot_from = b.lot_from and u.lot_code = b.lot_code and u.status <> 'cancelled')
    union
    select distinct order_id from erp_units where order_id in ${orderIds} and status in ('scanned', 'dispatched')
  `);
  return new Set(rows.map((r) => r.id));
}

/** Orders waiting at the desk: a line Ready or billed and not yet dispatch-verified. */
export async function dispatchQueue(): Promise<{ orderNo: number; delivery: string; dispatchOn: string | null; lines: number; target: number; scanned: number; billed: number; godown: string }[]> {
  const rows = await q<Row>(db, sql`
    with open as (
      select o.id, o.order_no, o.qty_cans, p.cans_per_box as cpb, coalesce(pk.empty_boxes_required, 0) as empty, o.dispatch_on, o.delivery_customer_id, o.billing_customer_id, o.godown_id,
             d.order_id is not null as billed
        from erp_orders o join products p on p.id = o.sku_id left join erp_product_packing pk on pk.product_id = p.id
        left join erp_order_details d on d.order_id = o.id
       where o.status = 'Ready' and coalesce(d.verification, '') <> 'Verified'
    )
    select x.order_no as "orderNo", coalesce(dc.name, bc.name) as delivery, min(x.dispatch_on)::text as "dispatchOn", count(*)::int as lines,
           sum(case when x.empty > 0 and x.cpb > 1 then x.qty_cans::float8 / x.cpb when x.empty > 0 then 0 else x.qty_cans end)::float8 as target,
           (select count(*)::int from erp_units u where u.order_id in (select id from open y where y.order_no = x.order_no) and u.status = 'scanned') as scanned,
           sum(case when x.billed then 1 else 0 end)::int as billed, min(g.name) as godown
      from open x join customers bc on bc.id = x.billing_customer_id left join customers dc on dc.id = x.delivery_customer_id
      join erp_godowns g on g.id = x.godown_id
     group by x.order_no, coalesce(dc.name, bc.name)
     order by min(x.dispatch_on) nulls last, x.order_no
  `);
  return rows.map((r) => ({ orderNo: Number(r.orderNo), delivery: String(r.delivery), dispatchOn: r.dispatchOn == null ? null : String(r.dispatchOn), lines: Number(r.lines), target: Number(r.target), scanned: Number(r.scanned), billed: Number(r.billed), godown: String(r.godown) }));
}

/* ================================================================= scan */

export type ScanAnswer = { verdict: ScanVerdict; code: string };

async function logScan(ctx: ErpContext, code: string, orderNo: number, result: string, message: string, unitId: string | null, orderId: string | null): Promise<void> {
  await db.execute(sql`
    insert into erp_dispatch_scans (id, code, order_no, result, message, unit_id, order_id, by_id)
    values (${erpId("scn")}, ${code}, ${orderNo}, ${result}, ${message}, ${unitId}, ${orderId}, ${ctx.user.id})
  `);
}

/** How many units of a lot at a godown the stock ledger still has free for allocation. */
async function lotFree(tx: Tx, lotFrom: "pack" | "fg", lot: string, godownId: string, skuId: string): Promise<number> {
  if (lotFrom === "pack") return (await packLots(tx)).find((x) => x.batchNo === lot && x.godownId === godownId)?.stock ?? 0;
  return (await fgLots(tx)).find((x) => x.lotCode === lot && x.godownId === godownId && x.skuId === skuId)?.stock ?? (await fgLots(tx)).find((x) => x.lotCode === lot && x.godownId === godownId)?.stock ?? 0;
}

/**
 * SCAN ONE CODE ONTO ONE ORDER. Judged, then — only if it passes — the box is
 * put on the line and the allocation follows it, in one transaction under
 * the unit's row lock and the lots' locks, so two people scanning one box at
 * two desks cannot both count it.
 */
export async function scanOntoOrder(ctx: ErpContext, orderNo: number, raw: string): Promise<Result<ScanAnswer>> {
  const code = normaliseCode(raw);
  if (!code) return fieldErr("code", "Scan or type a box id");
  let answer: ScanAnswer | null = null;
  let logged: { result: string; message: string; unit: string | null; order: string | null } | null = null;
  const res = await inTx(async (tx) => {
    const unit = await unitFor(tx, code, true);
    const lines = await scanLines(tx, orderNo);
    if (!lines.length) return refuse(err(`There is no order ${orderNo}.`, "not_found"));
    const approved = unit
      ? (await q<{ id: string; line: string }>(tx, sql`select id, order_id as line from erp_dispatch_overrides where unit_id = ${unit.id} and order_id in ${lines.map((l) => l.id)} and status = 'Approved' limit 1`))[0]
      : undefined;
    const verdict = scanVerdict(unit, lines, approved ? { lineId: approved.line } : null);
    answer = { verdict, code };
    if (!verdict.ok) {
      logged = { result: verdict.result, message: verdict.message, unit: unit?.id ?? null, order: verdict.mismatch?.lineId ?? null };
      return okVoid(verdict.message);
    }
    const line = lines.find((l) => l.id === verdict.lineId)!;
    const u = unit!;
    await lockLot(tx, u.lotFrom, u.lotCode, u.godownId);
    if (verdict.allocation !== "matched") {
      /* The box's lot takes one more unit of this line: there has to be one free in the ledger. */
      if ((await lotFree(tx, u.lotFrom, u.lotCode, u.godownId, u.skuId)) < 1 - 1e-9) {
        const message = `${u.id} is from ${u.lotCode}, whose stock here is all set aside for other orders. Scan a box of an allocated lot.`;
        answer = { verdict: { ok: false, result: "blocked", message }, code };
        logged = { result: "blocked", message, unit: u.id, order: line.id };
        return okVoid(message);
      }
      if (verdict.swapFromId) {
        const [giver] = await q<{ qty: number; lot: string; from: string; godown: string }>(tx, sql`select quantity::float8 as qty, lot_code as lot, lot_from as "from", godown_id as godown from erp_batch_codes where id = ${verdict.swapFromId} for update`);
        await lockLot(tx, giver.from, giver.lot, giver.godown);
        if (Number(giver.qty) <= 1 + 1e-9) await tx.execute(sql`delete from erp_batch_codes where id = ${verdict.swapFromId}`);
        else await tx.execute(sql`update erp_batch_codes set quantity = quantity - 1 where id = ${verdict.swapFromId}`);
      }
      if (verdict.batchCodeId) await tx.execute(sql`update erp_batch_codes set quantity = quantity + 1 where id = ${verdict.batchCodeId}`);
      else {
        const fg = u.lotFrom === "fg" ? (await q<{ fg: string | null }>(tx, sql`select finished_good_id as fg from erp_units where id = ${u.id}`))[0]?.fg ?? null : null;
        await tx.execute(sql`
          insert into erp_batch_codes (id, order_id, lot_from, lot_code, finished_good_id, godown_id, quantity, created_by_id)
          values (${erpId("bc")}, ${line.id}, ${u.lotFrom}, ${u.lotCode}, ${fg}, ${u.godownId}, 1, ${ctx.user.id})
        `);
      }
    }
    await tx.execute(sql`update erp_units set status = 'scanned', order_id = ${line.id}, scanned_at = now(), scanned_by_id = ${ctx.user.id}, updated_at = now() where id = ${u.id}`);
    await unitEvent(tx, { unitId: u.id, event: "scanned", from: "available", to: "scanned", orderId: line.id, godownId: u.godownId, note: `Order ${orderNo}${verdict.allocation === "swap" ? " · lot swapped in" : verdict.allocation === "allocate" ? " · lot allocated by scan" : ""}`, byId: ctx.user.id });
    if (verdict.substituted && approved) {
      await tx.execute(sql`update erp_dispatch_overrides set status = 'Used', used_at = now() where id = ${approved.id}`);
      await unitEvent(tx, { unitId: u.id, event: "override", from: "scanned", to: "scanned", orderId: line.id, note: `Dispatched against ${line.skuName} on an approved override`, byId: ctx.user.id });
    }
    logged = { result: "ok", message: verdict.message, unit: u.id, order: line.id };
    return okVoid(verdict.message);
  });
  const l = logged as { result: string; message: string; unit: string | null; order: string | null } | null;
  if (l) await logScan(ctx, code, orderNo, l.result, l.message, l.unit, l.order);
  if (!res.ok) return res;
  const a = answer as ScanAnswer | null;
  if (!a) return err("The scan could not be judged.");
  if (a.verdict.ok) await erpAudit(ctx, "erp.dispatch.scan", "erp_unit", a.code, null, { orderNo, allocation: a.verdict.allocation, substituted: a.verdict.substituted });
  return ok(a);
}

/** Taking a scanned box back off the order, before dispatch. Its allocation stays where the scan put it. */
export async function unscanUnit(ctx: ErpContext, unitId: string): Promise<Result<unknown>> {
  return inTx(async (tx) => {
    const u = await unitFor(tx, unitId, true);
    if (!u) return refuse(err("No such box.", "not_found"));
    if (u.status !== "scanned") return refuse(err(u.status === "dispatched" ? "That box has been dispatched." : "That box is not scanned onto an order.", "rule_violation"));
    await tx.execute(sql`update erp_units set status = 'available', order_id = null, scanned_at = null, scanned_by_id = null, updated_at = now() where id = ${u.id}`);
    await unitEvent(tx, { unitId: u.id, event: "unscanned", from: "scanned", to: "available", orderId: u.orderId, godownId: u.godownId, note: `Taken off order ${u.orderNo}`, byId: ctx.user.id });
    await erpAudit(ctx, "erp.dispatch.unscan", "erp_unit", u.id, { orderNo: u.orderNo }, null);
    return okVoid(`${u.id} taken off order ${u.orderNo}`);
  });
}

/* ============================================================ overrides */

/** Asking for a mismatched box to go anyway. Only a mismatch can be asked about; a duplicate or a box on hold cannot. */
export async function requestOverride(ctx: ErpContext, orderNo: number, raw: string, reason: string): Promise<Result<unknown>> {
  const code = normaliseCode(raw);
  if (reason.trim().length < 10) return fieldErr("reason", "Say why, in a sentence: who agreed to the change and what the customer was told");
  const unit = await unitFor(db, code, false);
  const lines = await scanLines(db, orderNo);
  const v = scanVerdict(unit, lines);
  if (v.ok) return err("That box matches the order; scan it.", "rule_violation");
  if (v.result !== "mismatch" || !v.mismatch || !unit) return err(v.message, "rule_violation");
  const line = lines.find((l) => l.id === v.mismatch!.lineId)!;
  const id = erpId("dov");
  try {
    await db.execute(sql`
      insert into erp_dispatch_overrides (id, unit_id, order_id, ordered_sku_id, scanned_sku_id, mismatch, reason, requested_by_id)
      values (${id}, ${unit.id}, ${line.id}, ${line.skuId}, ${unit.skuId}, ${v.mismatch.kind}, ${reason.trim()}, ${ctx.user.id})
    `);
  } catch {
    return err("An override for this box on this order is already waiting or approved.", "conflict");
  }
  await erpAudit(ctx, "erp.dispatch.overrideRequest", "erp_dispatch_override", id, null, { orderNo, unit: unit.id, ordered: line.skuName, scanned: unit.skuName, reason });
  return okVoid("Override requested · a dispatch-override approver has to approve it before the box can be scanned");
}

export async function decideOverride(ctx: ErpContext, id: string, approve: boolean, note: string | null): Promise<Result<unknown>> {
  if (!ctx.powers.has("dispatchOverride")) return err("Only a dispatch-override approver decides an override.", "not_permitted");
  const [o] = await q<{ status: string; by: string | null; unit: string; order: string }>(db, sql`select status, requested_by_id as by, unit_id as unit, order_id as "order" from erp_dispatch_overrides where id = ${id}`);
  if (!o) return err("That override no longer exists.", "not_found");
  if (o.status !== "Pending") return err(`That override is already ${o.status.toLowerCase()}.`, "rule_violation");
  if (o.by === ctx.user.id && !ctx.administrator) return err("Somebody other than whoever asked has to decide an override.", "not_permitted");
  if (!approve && !note?.trim()) return fieldErr("note", "Say why it is declined");
  await db.execute(sql`update erp_dispatch_overrides set status = ${approve ? "Approved" : "Declined"}, decided_by_id = ${ctx.user.id}, decided_at = now(), decision_note = ${note} where id = ${id} and status = 'Pending'`);
  await erpAudit(ctx, approve ? "erp.dispatch.overrideApprove" : "erp.dispatch.overrideDecline", "erp_dispatch_override", id, { status: "Pending" }, { status: approve ? "Approved" : "Declined", note });
  return okVoid(approve ? "Override approved · scan the box again to put it on the order" : "Override declined");
}

/* ======================================================= verify & dispatch */

/** Per line, why it cannot be dispatch-verified for want of scans (or null). */
export async function scanGateFor(ex: Ex, orderIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!orderIds.length) return out;
  const cfg = await getConfig();
  const withUnits = await lotsWithUnitsFor(ex, orderIds);
  const nos = await q<{ no: number }>(ex, sql`select distinct order_no as no from erp_orders where id in ${orderIds}`);
  for (const { no } of nos)
    for (const l of await scanLines(ex, Number(no)))
      if (orderIds.includes(l.id)) out.set(l.id, scanGate({ requireScan: cfg["erp.dispatch.requireScan"], lotsHaveUnits: withUnits.has(l.id), target: l.target, scanned: l.scanned }));
  return out;
}

/** The lorry has gone: every box scanned onto these lines is dispatched, and its history says so. */
export async function markDispatched(tx: Ex, orderIds: string[], byId: string, date: string): Promise<number> {
  if (!orderIds.length) return 0;
  const rows = await q<{ id: string; order: string }>(tx, sql`update erp_units set status = 'dispatched', dispatched_at = now(), updated_at = now() where order_id in ${orderIds} and status = 'scanned' returning id, order_id as "order"`);
  for (const r of rows) await unitEvent(tx, { unitId: r.id, event: "dispatched", from: "scanned", to: "dispatched", orderId: r.order, note: `Dispatch verified for ${date}`, byId });
  return rows.length;
}

/** Units scanned against one batch-code row's line and lot — a release or a smaller quantity may not go below it. */
export async function scannedOnAllocation(orderId: string, lotCode: string): Promise<number> {
  const [r] = await q<{ n: number }>(db, sql`select count(*)::int as n from erp_units where order_id = ${orderId} and lot_code = ${lotCode} and status in ('scanned', 'dispatched')`);
  return Number(r?.n ?? 0);
}
