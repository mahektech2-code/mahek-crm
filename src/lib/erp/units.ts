import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { calendarDate } from "@/lib/business-date";
import { erpId, nextNumber } from "./server";
import { unitId, type UnitStatus } from "./engines/trace";
import type { Ex } from "./stock";

/* ---------------------------------------------------------------------------
 * The UNIT REGISTER: one row per physical box or labelled loose unit, and the
 * append-only history of each (`erp_unit_events`).
 *
 * Every function here runs inside the caller's transaction and is called by
 * the document that moves the goods — a packing batch completing mints its
 * boxes, a transfer moves them, a write-off loses them — so the register can
 * never drift from the stock ledger it shadows. Nothing in here edits a
 * unit's history: a correction is a further event.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(ex: Ex, s: ReturnType<typeof sql>) => (await ex.execute(s)) as unknown as T[];

export async function unitEvent(
  ex: Ex,
  e: { unitId: string; event: string; from?: UnitStatus | null; to?: UnitStatus | null; orderId?: string | null; godownId?: string | null; note?: string | null; byId?: string | null },
): Promise<void> {
  await ex.execute(sql`
    insert into erp_unit_events (id, unit_id, event, from_status, to_status, order_id, godown_id, note, by_id)
    values (${erpId("uev")}, ${e.unitId}, ${e.event}, ${e.from ?? null}, ${e.to ?? null}, ${e.orderId ?? null}, ${e.godownId ?? null}, ${e.note ?? null}, ${e.byId ?? null})
  `);
}

async function mint(
  ex: Ex,
  u: { kind: "box" | "loose"; skuId: string; lotFrom: "pack" | "fg"; lotCode: string; finishedGoodId: string | null; seq: number; cans: number; godownId: string; byId: string | null; note: string },
): Promise<string> {
  const serial = await nextNumber(ex, "unit");
  const id = unitId(u.kind, calendarDate(new Date()), serial);
  await ex.execute(sql`
    insert into erp_units (id, kind, sku_id, lot_from, lot_code, finished_good_id, seq, cans, godown_id, status, created_by_id)
    values (${id}, ${u.kind}, ${u.skuId}, ${u.lotFrom}, ${u.lotCode}, ${u.finishedGoodId}, ${u.seq}, ${u.cans}, ${u.godownId}, 'available', ${u.byId})
  `);
  await unitEvent(ex, { unitId: id, event: "created", to: "available", godownId: u.godownId, note: u.note, byId: u.byId });
  return id;
}

/**
 * A PACKING BATCH THAT IS COMPLETE HAS ONE BOX ROW PER BOX. Called by the
 * batch's own posting: boxes a previous un-completion cancelled come back
 * under the same ids (their labels may already be on the boxes), and any
 * still missing are minted, numbered 1…boxes in the order they were packed.
 */
export async function ensureBatchBoxes(ex: Ex, p: { batchNo: string; skuId: string; godownId: string; boxes: number; cansPerBox: number; byId: string | null }): Promise<number> {
  const existing = await q<{ id: string; seq: number; status: string }>(ex, sql`select id, seq, status from erp_units where lot_from = 'pack' and lot_code = ${p.batchNo} order by seq`);
  let made = 0;
  for (const u of existing.filter((x) => x.status === "cancelled" && Number(x.seq) <= p.boxes)) {
    await ex.execute(sql`update erp_units set status = 'available', status_note = null, updated_at = now() where id = ${u.id}`);
    await unitEvent(ex, { unitId: u.id, event: "restored", from: "cancelled", to: "available", godownId: p.godownId, note: `Packing batch ${p.batchNo} complete again`, byId: p.byId });
  }
  const have = new Set(existing.map((x) => Number(x.seq)));
  for (let seq = 1; seq <= p.boxes; seq++) {
    if (have.has(seq)) continue;
    await mint(ex, { kind: "box", skuId: p.skuId, lotFrom: "pack", lotCode: p.batchNo, finishedGoodId: null, seq, cans: p.cansPerBox, godownId: p.godownId, byId: p.byId, note: `Packed in batch ${p.batchNo}` });
    made++;
  }
  return made;
}

/** A batch that stops being complete takes its boxes out of stock with it — the ones still in stock, which is all of them, or the edit was refused. */
export async function cancelBatchBoxes(ex: Ex, batchNo: string, byId: string | null): Promise<void> {
  const rows = await q<{ id: string; godown: string }>(ex, sql`update erp_units set status = 'cancelled', status_note = 'Packing batch no longer complete', updated_at = now() where lot_from = 'pack' and lot_code = ${batchNo} and status = 'available' returning id, godown_id as godown`);
  for (const r of rows) await unitEvent(ex, { unitId: r.id, event: "cancel", from: "available", to: "cancelled", godownId: r.godown, note: `Packing batch ${batchNo} no longer complete`, byId });
}

/**
 * LABEL LOOSE UNITS: one id per can or drum of an FG lot that sells loose.
 * Asked for, never automatic — an FG lot's cans may yet be boxed, and a can
 * labelled loose and then packed would be a unit nobody can dispatch.
 */
export async function mintLooseUnits(ex: Ex, p: { lotCode: string; finishedGoodId: string; skuId: string; godownId: string; count: number; byId: string | null }): Promise<string[]> {
  const [{ max }] = await q<{ max: number }>(ex, sql`select coalesce(max(seq), 0)::int as max from erp_units where lot_from = 'fg' and lot_code = ${p.lotCode}`);
  const ids: string[] = [];
  for (let i = 1; i <= p.count; i++)
    ids.push(await mint(ex, { kind: "loose", skuId: p.skuId, lotFrom: "fg", lotCode: p.lotCode, finishedGoodId: p.finishedGoodId, seq: Number(max) + i, cans: 1, godownId: p.godownId, byId: p.byId, note: `Labelled from FG lot ${p.lotCode}` }));
  return ids;
}

/**
 * How many loose units of a lot at a godown are labelled and still on the
 * shelf, and how many more the lot can carry: what is in the ledger plus what
 * is allocated to an order but not yet scanned (allocation takes ledger
 * stock, and a can still on the shelf is still a can).
 */
export async function looseHeadroom(ex: Ex, p: { lotCode: string; finishedGoodId: string; godownId: string; ledgerStock: number }): Promise<{ labelled: number; room: number; cover: number }> {
  const [r] = await q<{ labelled: number }>(ex, sql`select count(*)::int as labelled from erp_units where lot_from = 'fg' and lot_code = ${p.lotCode} and godown_id = ${p.godownId} and status in ('available', 'hold')`);
  const labelled = Number(r?.labelled ?? 0);
  const cover = Math.max(0, Math.floor(p.ledgerStock + 1e-9)) + (await unscannedAllocated(ex, p));
  return { labelled, room: Math.max(0, cover - labelled), cover };
}

/**
 * Loose units never outnumber the cans that can still be them. Packing draws
 * cans from an FG lot with no idea which can carries which label, so after it
 * the newest labels the lot can no longer cover are cancelled — and said to be.
 */
export async function trimLooseUnits(ex: Ex, p: { lotCode: string; finishedGoodId: string; godownId: string; ledgerStock: number; byId: string | null; why: string }): Promise<number> {
  const h = await looseHeadroom(ex, p);
  const extra = h.labelled - h.cover;
  if (extra <= 0) return 0;
  const rows = await q<{ id: string }>(ex, sql`
    update erp_units set status = 'cancelled', status_note = ${p.why}, updated_at = now()
     where id in (select id from erp_units where lot_from = 'fg' and lot_code = ${p.lotCode} and godown_id = ${p.godownId} and status = 'available' order by seq desc limit ${extra})
     returning id
  `);
  for (const r of rows) await unitEvent(ex, { unitId: r.id, event: "cancel", from: "available", to: "cancelled", godownId: p.godownId, note: p.why, byId: p.byId });
  return rows.length;
}

async function unscannedAllocated(ex: Ex, p: { lotCode: string; finishedGoodId: string; godownId: string }): Promise<number> {
  const [r] = await q<{ n: number }>(ex, sql`
    select greatest(0,
      (select coalesce(sum(b.quantity), 0)::float8 from erp_batch_codes b
         left join erp_order_details d on d.order_id = b.order_id
        where b.lot_from = 'fg' and b.lot_code = ${p.lotCode} and b.godown_id = ${p.godownId} and b.finished_good_id = ${p.finishedGoodId}
          and coalesce(d.verification, '') <> 'Verified')
      - (select count(*) from erp_units where lot_from = 'fg' and lot_code = ${p.lotCode} and godown_id = ${p.godownId} and status = 'scanned'))::float8 as n
  `);
  return Math.floor(Number(r?.n ?? 0));
}

/**
 * A TRANSFER MOVES THE UNITS IT MOVES. A transfer names a lot and a quantity,
 * not boxes, so the lowest-numbered units in stock at the source go — and to
 * Item Lost Record they go as lost rather than as stock somewhere else.
 */
export async function moveUnitsForTransfer(ex: Ex, p: { lotFrom: "pack" | "fg"; lotCode: string; fromGodownId: string; toGodownId: string; qty: number; lost: boolean; transferId: string; byId: string | null }): Promise<number> {
  const n = Math.floor(p.qty + 1e-9);
  if (n <= 0) return 0;
  const rows = await q<{ id: string }>(ex, sql`
    select id from erp_units where lot_from = ${p.lotFrom} and lot_code = ${p.lotCode} and godown_id = ${p.fromGodownId} and status = 'available'
     order by seq limit ${n} for update
  `);
  for (const r of rows) {
    if (p.lost) {
      await ex.execute(sql`update erp_units set status = 'lost', godown_id = ${p.toGodownId}, status_note = ${`Written off by transfer ${p.transferId}`}, updated_at = now() where id = ${r.id}`);
      await unitEvent(ex, { unitId: r.id, event: "lost", from: "available", to: "lost", godownId: p.toGodownId, note: `Transfer ${p.transferId}`, byId: p.byId });
    } else {
      await ex.execute(sql`update erp_units set godown_id = ${p.toGodownId}, updated_at = now() where id = ${r.id}`);
      await unitEvent(ex, { unitId: r.id, event: "transfer", from: "available", to: "available", godownId: p.toGodownId, note: `Transfer ${p.transferId}`, byId: p.byId });
    }
  }
  return rows.length;
}

/** Whether any of these lots carries units — the line they are allocated to is then scanned before it leaves. */
export async function lotsWithUnits(ex: Ex = db): Promise<Set<string>> {
  const rows = await q<{ k: string }>(ex, sql`select distinct lot_from || '|' || lot_code as k from erp_units where status <> 'cancelled'`);
  return new Set(rows.map((r) => r.k));
}

/** Units scanned or dispatched per order line, and per (line, lot). */
export async function scannedByLine(ex: Ex = db): Promise<{ line: Map<string, number>; lot: Map<string, number> }> {
  const rows = await q<{ order: string; lot: string; n: number }>(ex, sql`
    select order_id as "order", lot_code as lot, count(*)::int as n from erp_units where order_id is not null and status in ('scanned', 'dispatched') group by 1, 2
  `);
  const line = new Map<string, number>();
  const lot = new Map<string, number>();
  for (const r of rows) {
    line.set(r.order, (line.get(r.order) ?? 0) + Number(r.n));
    lot.set(`${r.order}|${r.lot}`, Number(r.n));
  }
  return { line, lot };
}
