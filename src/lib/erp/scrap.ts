import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpEmptyDrums } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import {
  DRUM_STATUS_LABEL,
  OWNERSHIP_LABEL,
  parseDrumCode,
  pickDrumSeq,
  routeDrum,
  tareVariance,
  weightCheck,
  type DrumOwnership,
  type DrumStatus,
} from "./engines/scrap";
import { erpAudit, erpId, nextNumber } from "./server";
import { inTx, refuse } from "./screens/common";

/* ---------------------------------------------------------------------------
 * EMPTY DRUM ENTRY — the scan page's reads and its one write.
 *
 * The person at the scale scans the drum's GRN lot label and types its empty
 * weight; everything else — the GRN, supplier, material, lot, declared tare
 * and ownership — is read from what the GRN already holds, and nothing they
 * cannot see on the label is asked of them.
 * ------------------------------------------------------------------------- */

export const drumNoLabel = (n: number) => `ED-${n}`;
export const saleNoLabel = (n: number) => `SS-${n}`;
export const returnNoLabel = (n: number) => `RD-${n}`;
export const receiptNoLabel = (n: number) => `SR-${n}`;

export type RegisteredDrum = {
  seq: number;
  drumNo: number;
  weightKg: number;
  status: DrumStatus;
  statusLabel: string;
  by: string | null;
  at: string;
};

export type DrumLot = {
  purchaseId: string;
  lot: string;
  item: string;
  supplier: string;
  prNumber: number;
  grnDate: string;
  godown: string;
  drums: number | null;
  declaredTareKg: number | null;
  ownership: DrumOwnership | null;
  ownershipLabel: string;
  registered: RegisteredDrum[];
  /** The drum this scan would register, or why none can be. */
  next: { seq: number } | { refusal: string; existing?: number };
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Reads a scanned or typed code as a GRN lot and the drums of it already emptied. */
export async function lookupDrumLot(raw: string): Promise<Result<DrumLot>> {
  const code = parseDrumCode(raw);
  if (!code) return fieldErr("code", "Scan the drum's lot label, or type its lot number.");
  const [p] = (await db.execute(sql`
    select p.id, p.lot_no as lot, m.name as item, s.name as supplier, p.pr_number as pr, p.purchase_date::text as "grnDate",
           g.name as godown, coalesce(p.drums, i.drums) as drums, i.empty_drum_weight::float8 as tare, p.drum_ownership as ownership
      from erp_purchases p
      join erp_raw_materials m on m.id = p.raw_material_id
      join erp_suppliers s on s.id = p.supplier_id
      join erp_godowns g on g.id = p.godown_id
      left join erp_inward i on i.id = p.inward_id
     where upper(p.lot_no) = upper(${code.lot})
     limit 1
  `)) as unknown as { id: string; lot: string; item: string; supplier: string; pr: number; grnDate: string; godown: string; drums: number | null; tare: number | null; ownership: DrumOwnership | null }[];
  if (!p)
    return err(
      `No GRN lot ${code.lot} was found. Do not record this drum some other way — ask the Production Head to find which lot it came from.`,
      "not_found",
    );
  const registered = (await db.execute(sql`
    select d.seq, d.drum_no as "drumNo", d.weight_kg::float8 as weight, d.status, u.name as by, d.emptied_at as at
      from erp_empty_drums d left join users u on u.id = d.emptied_by_id
     where d.purchase_id = ${p.id}
     order by d.seq
  `)) as unknown as { seq: number; drumNo: number; weight: number; status: DrumStatus; by: string | null; at: Date }[];
  const drums = p.drums == null ? null : Number(p.drums);
  return ok({
    purchaseId: p.id,
    lot: p.lot,
    item: p.item,
    supplier: p.supplier,
    prNumber: Number(p.pr),
    grnDate: p.grnDate,
    godown: p.godown,
    drums,
    declaredTareKg: p.tare == null ? null : Number(p.tare),
    ownership: p.ownership,
    ownershipLabel: p.ownership ? OWNERSHIP_LABEL[p.ownership] : "Not recorded — the Production Head decides",
    registered: registered.map((r) => ({
      seq: Number(r.seq),
      drumNo: Number(r.drumNo),
      weightKg: Number(r.weight),
      status: r.status,
      statusLabel: DRUM_STATUS_LABEL[r.status],
      by: r.by,
      at: new Date(r.at).toISOString(),
    })),
    next: pickDrumSeq(
      drums,
      registered.map((r) => Number(r.seq)),
      code.seq,
    ),
  });
}

export type RecordedDrum = {
  drumNo: number;
  seq: number;
  drums: number;
  lot: string;
  item: string;
  status: DrumStatus;
  statusLabel: string;
  weightKg: number;
  varianceKg: number | null;
};

/**
 * Registers one emptied drum. Re-reads the lot under a row lock, so two people
 * weighing drums of one lot at once take two different numbers, and a second
 * scan of a drum already registered is refused rather than counted twice.
 */
export async function recordEmptyDrum(
  ctx: ErpContext,
  input: { code: string; weightKg: number | null; exceptionNote?: string | null },
): Promise<Result<RecordedDrum>> {
  const code = parseDrumCode(input.code);
  if (!code) return fieldErr("code", "Scan the drum's lot label, or type its lot number.");
  const config = await getConfig();
  const w = weightCheck(input.weightKg, config["erp.scrap.drumWeightMinKg"], config["erp.scrap.drumWeightMaxKg"]);
  const note = (input.exceptionNote ?? "").trim() || null;
  if (!w.ok) {
    if (w.missing) return fieldErr("weight", w.reason);
    if (!ctx.powers.has("scrapControl"))
      return fieldErr("weight", `${w.reason} Weigh it again; if it really is this, the Production Head can let it through.`);
    if (!note || note.length < 8) return fieldErr("note", `${w.reason} Say why it is right (at least a few words) to save it anyway.`);
  }
  const weightKg = r3(input.weightKg!);
  const res = await inTx(async (tx) => {
    const [p] = (await tx.execute(sql`
      select p.id, p.lot_no as lot, p.pr_number as pr, p.supplier_id as "supplierId", p.raw_material_id as "rmId", p.inward_id as "inwardId",
             p.godown_id as "godownId", coalesce(p.drums, i.drums) as drums, i.empty_drum_weight::float8 as tare, p.drum_ownership as ownership,
             m.name as item
        from erp_purchases p
        join erp_raw_materials m on m.id = p.raw_material_id
        left join erp_inward i on i.id = p.inward_id
       where upper(p.lot_no) = upper(${code.lot})
       for update of p
    `)) as unknown as { id: string; lot: string; pr: number; supplierId: string; rmId: string; inwardId: string | null; godownId: string; drums: number | null; tare: number | null; ownership: DrumOwnership | null; item: string }[];
    if (!p) return refuse(err(`No GRN lot ${code.lot} was found. Ask the Production Head to find which lot this drum came from.`, "not_found"));
    const taken = (await tx.execute(sql`select seq from erp_empty_drums where purchase_id = ${p.id}`)) as unknown as { seq: number }[];
    const drums = p.drums == null ? null : Number(p.drums);
    const pick = pickDrumSeq(
      drums,
      taken.map((t) => Number(t.seq)),
      code.seq,
    );
    if ("refusal" in pick) return refuse(err(pick.refusal, "rule_violation"));
    const status = routeDrum(p.ownership);
    const drumNo = await nextNumber(tx, "emptyDrum");
    const tare = p.tare == null ? null : Number(p.tare);
    const id = erpId("erpdrm");
    await tx.insert(erpEmptyDrums).values({
      id,
      drumNo,
      purchaseId: p.id,
      seq: pick.seq,
      lotNo: p.lot,
      prNumber: Number(p.pr),
      supplierId: p.supplierId,
      rawMaterialId: p.rmId,
      inwardId: p.inwardId,
      godownId: ctx.workingGodown?.id ?? p.godownId,
      ownership: p.ownership,
      declaredTareKg: tare,
      weightKg,
      firstWeightKg: weightKg,
      weightNote: w.ok ? null : note,
      status,
      emptiedById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    const saved: RecordedDrum = {
      drumNo,
      seq: pick.seq,
      drums: drums ?? pick.seq,
      lot: p.lot,
      item: p.item,
      status,
      statusLabel: DRUM_STATUS_LABEL[status],
      weightKg,
      varianceKg: tareVariance(weightKg, tare)?.kg ?? null,
    };
    return ok(saved);
  });
  if (!res.ok) return res;
  const done = res.data as RecordedDrum;
  await erpAudit(ctx, "erp.emptyDrum.record", "erp_empty_drum", drumNoLabel(done.drumNo), null, {
    lot: done.lot,
    seq: done.seq,
    weightKg: done.weightKg,
    status: done.status,
    exception: w.ok ? null : note,
  });
  return ok(done, `${drumNoLabel(done.drumNo)} recorded · drum ${done.seq} of ${done.drums} · ${done.statusLabel}`);
}

export type RecentDrum = { drumNo: number; lot: string; seq: number; item: string; weightKg: number; status: DrumStatus; at: string };

/** What this person registered today, newest first — the scale's own memory. */
export async function recentEmptyDrums(userId: string): Promise<RecentDrum[]> {
  const today = calendarDate(new Date());
  const rows = (await db.execute(sql`
    select d.drum_no as "drumNo", d.lot_no as lot, d.seq, m.name as item, d.weight_kg::float8 as weight, d.status, d.emptied_at as at
      from erp_empty_drums d join erp_raw_materials m on m.id = d.raw_material_id
     where d.emptied_by_id = ${userId}
       and d.emptied_at >= (${today}::date)::timestamp at time zone 'Asia/Kolkata'
     order by d.emptied_at desc
     limit 30
  `)) as unknown as { drumNo: number; lot: string; seq: number; item: string; weight: number; status: DrumStatus; at: Date }[];
  return rows.map((r) => ({ drumNo: Number(r.drumNo), lot: r.lot, seq: Number(r.seq), item: r.item, weightKg: Number(r.weight), status: r.status, at: new Date(r.at).toISOString() }));
}

export type ScrapSummary = {
  mahekAvailable: number;
  vendorPending: number;
  review: number;
  soldDrumsThisMonth: number;
  saleValueThisMonth: number;
  outstanding: number;
  overdue: number;
  highVariance: number;
  oldestPendingReturn: { supplier: string; since: string; drums: number } | null;
};

/** The figures the dashboard and the screen's header read. */
export async function scrapSummary(): Promise<ScrapSummary> {
  const config = await getConfig();
  const alert = config["erp.scrap.varianceAlertKg"];
  const today = calendarDate(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;
  const [a] = (await db.execute(sql`
    select (select count(*) from erp_empty_drums where status = 'available')::int as mahek,
           (select count(*) from erp_empty_drums where status = 'returnable')::int as vendor,
           (select count(*) from erp_empty_drums where status = 'review')::int as review,
           (select coalesce(sum(quantity), 0) from erp_scrap_sales where status = 'active' and category = 'drum' and sale_date >= ${monthStart}::date)::float8 as "soldDrums",
           (select coalesce(sum(amount_paise), 0) from erp_scrap_sales where status = 'active' and sale_date >= ${monthStart}::date)::float8 as value,
           (select count(*) from erp_empty_drums where status <> 'cancelled' and declared_tare_kg is not null and ${alert}::numeric > 0
              and abs(weight_kg - declared_tare_kg) >= ${alert}::numeric)::int as "highVariance"
  `)) as unknown as { mahek: number; vendor: number; review: number; soldDrums: number; value: number; highVariance: number }[];
  const owed = (await db.execute(sql`
    select s.amount_paise::float8 - coalesce((select sum(x.amount_paise) from erp_scrap_allocations x where x.sale_id = s.id and x.voided_at is null), 0)::float8 as owed,
           coalesce(s.due_date, s.sale_date)::text as due
      from erp_scrap_sales s where s.status = 'active'
  `)) as unknown as { owed: number; due: string }[];
  const [oldest] = (await db.execute(sql`
    select s.name as supplier, min(d.emptied_at) as since, count(*)::int as drums
      from erp_empty_drums d join erp_suppliers s on s.id = d.supplier_id
     where d.status = 'returnable'
     group by s.name
     order by min(d.emptied_at)
     limit 1
  `)) as unknown as { supplier: string; since: Date; drums: number }[];
  return {
    mahekAvailable: Number(a?.mahek ?? 0),
    vendorPending: Number(a?.vendor ?? 0),
    review: Number(a?.review ?? 0),
    soldDrumsThisMonth: Number(a?.soldDrums ?? 0),
    saleValueThisMonth: Number(a?.value ?? 0),
    outstanding: owed.reduce((n, r) => n + Math.max(0, Number(r.owed)), 0),
    overdue: owed.filter((r) => Number(r.owed) > 0 && r.due < today).reduce((n, r) => n + Number(r.owed), 0),
    highVariance: Number(a?.highVariance ?? 0),
    oldestPendingReturn: oldest ? { supplier: oldest.supplier, since: calendarDate(new Date(oldest.since)), drums: Number(oldest.drums) } : null,
  };
}
