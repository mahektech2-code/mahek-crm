import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  erpCashReceipts,
  erpDrumAdjustments,
  erpDrumEvents,
  erpDrumReturns,
  erpEmptyDrums,
  erpScrapAllocations,
  erpScrapEntries,
  erpScrapSales,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import {
  DRUM_CATEGORY,
  DRUM_STATUS_LABEL,
  OWNERSHIP_LABEL,
  RETURNABLE_NOT_FOR_SALE,
  allocationRefusal,
  drumLabel,
  drumReturnLabel,
  fifoPick,
  nextDrumSeq,
  outstanding,
  ownershipOf,
  receiptLabel,
  saleAmount,
  scrapSaleLabel,
  statusOnEmpty,
  tareVariance,
  weightRefusal,
  type DrumOwnership,
  type DrumStatus,
} from "./engines/drums";
import { erpId, nextNumber } from "./server";

/* ---------------------------------------------------------------------------
 * EMPTY DRUMS, SCRAP SALE, VENDOR RETURNS AND SCRAP RECEIVABLES — the writes
 * and the reads, wired to the database. The rules are `engines/drums.ts`.
 *
 * Two doors call this: the ERP screens (`screens/scrap.ts`) and the factory
 * phone's Empty drum entry (`lib/actions/factory.ts`). Neither decides who may
 * do what on its own say-so — each passes the actor and what it established
 * about them, and the checks that protect stock and money are here.
 *
 * Stock is the drum records themselves: available = Mahek's drums still in the
 * factory, returnable = a supplier's drums waiting to go back. Nothing holds a
 * balance; every figure is a count of records, so it cannot drift.
 * ------------------------------------------------------------------------- */

type Ex = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Actor = { id: string; name: string; app: "erp" | "factory"; level?: "associate" | "manager" | "admin" | null };

const today = () => calendarDate(new Date());
const r3 = (n: number) => Math.round(n * 1000) / 1000;

async function q<T>(ex: Ex, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ex.execute(query)) as unknown as T[];
}

async function audit(actor: Actor, action: string, entityType: string, entityId: string | null, after?: unknown, before?: unknown) {
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: actor.id,
    action,
    entityType,
    entityId,
    actorRole: actor.level ?? null,
    actorApp: actor.app,
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

async function event(ex: Tx, drumId: string, kind: string, from: DrumStatus | null, to: DrumStatus | null, by: string, note?: string | null, detail?: unknown) {
  await ex.insert(erpDrumEvents).values({ id: erpId("dre"), drumId, kind, fromStatus: from, toStatus: to, note: note ?? null, detail: (detail ?? null) as never, byId: by });
}

/** Refuse from inside a transaction, rolling back everything it wrote. */
class Refusal extends Error {
  constructor(public result: Result<unknown>) {
    super("refused");
  }
}
const refuse = (r: Result<unknown>): never => {
  throw new Refusal(r);
};
async function inTx<T>(fn: (tx: Tx) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (e instanceof Refusal) return e.result as Result<T>;
    throw e;
  }
}

/* ============================================================ the lot */

export type DrumLot = {
  purchaseId: string;
  lotNo: string;
  prNumber: number;
  inwardId: string | null;
  supplierId: string;
  supplier: string;
  rawMaterialId: string;
  material: string;
  materialType: string;
  godownId: string;
  godown: string;
  /** Drums the GRN brought in. Null where it recorded none. */
  drums: number | null;
  declaredTareKg: number | null;
  ownership: DrumOwnership | null;
  /** Where the ownership came from, said in words. */
  ownershipFrom: string;
  /** Drums of this lot already registered empty (not cancelled), oldest first. */
  registered: { id: string; drumNo: number; seq: number | null; status: DrumStatus; actualKg: number | null; recordedAt: string; by: string | null }[];
  nextSeq: number | null;
};

/**
 * What a scanned label names. The drum label carries the LOT (`MAH-TOL-12`)
 * and the register prints the purchase id beside it; either finds the lot.
 */
export async function findDrumLot(code: string): Promise<DrumLot | null> {
  const c = code.trim();
  if (!c) return null;
  const [p] = await q<{
    id: string; lotNo: string; pr: number; inwardId: string | null; supplierId: string; supplier: string; sOwn: string | null; iOwn: string | null; pOwn: string | null;
    rmId: string; material: string; mType: string; godownId: string; godown: string; drums: number | null; tare: number | null;
  }>(db, sql`
    select p.id, p.lot_no as "lotNo", p.pr_number as pr, p.inward_id as "inwardId", p.supplier_id as "supplierId", s.name as supplier,
           s.drum_ownership as "sOwn", i.drum_ownership as "iOwn", p.drum_ownership as "pOwn", p.raw_material_id as "rmId", m.name as material, m.material_type as "mType",
           p.godown_id as "godownId", g.name as godown, coalesce(p.drums, i.drums) as drums, i.empty_drum_weight::float8 as tare
      from erp_purchases p
      join erp_suppliers s on s.id = p.supplier_id
      join erp_raw_materials m on m.id = p.raw_material_id
      join erp_godowns g on g.id = p.godown_id
      left join erp_inward i on i.id = p.inward_id
     where upper(p.lot_no) = upper(${c}) or p.id = ${c}
     limit 1`);
  if (!p) return null;
  const regs = await q<{ id: string; drumNo: number; seq: number | null; status: DrumStatus; kg: number | null; at: string; by: string | null }>(db, sql`
    select d.id, d.drum_no as "drumNo", d.seq, d.status, d.actual_kg::float8 as kg, d.recorded_at::text as at, u.name as by
      from erp_empty_drums d left join users u on u.id = d.recorded_by_id
     where d.purchase_id = ${p.id} and d.status <> 'cancelled'
     order by d.recorded_at, d.drum_no`);
  // A lot decided by a person (kept from the first version of this module) wins.
  const ownership = ownershipOf(p.pOwn ?? p.iOwn, p.sOwn);
  const drums = p.drums == null || Number(p.drums) <= 0 ? null : Number(p.drums);
  return {
    purchaseId: p.id,
    lotNo: p.lotNo,
    prNumber: Number(p.pr),
    inwardId: p.inwardId,
    supplierId: p.supplierId,
    supplier: p.supplier,
    rawMaterialId: p.rmId,
    material: p.material,
    materialType: p.mType,
    godownId: p.godownId,
    godown: p.godown,
    drums,
    declaredTareKg: p.tare == null ? null : Number(p.tare),
    ownership,
    ownershipFrom: p.pOwn ? "the lot, decided earlier" : p.iOwn ? "the GRN line" : p.sOwn ? "the supplier's master" : "nowhere — the Production Head decides",
    registered: regs.map((r) => ({ id: r.id, drumNo: Number(r.drumNo), seq: r.seq == null ? null : Number(r.seq), status: r.status, actualKg: r.kg == null ? null : Number(r.kg), recordedAt: r.at, by: r.by })),
    nextSeq: nextDrumSeq(drums, regs.map((r) => Number(r.seq)).filter((n) => Number.isFinite(n))),
  };
}

/** Why a lot cannot take another empty drum, or null. */
export function lotRefusal(lot: DrumLot): string | null {
  if (lot.drums == null && lot.materialType !== "Chemical") return `${lot.lotNo} is ${lot.material}, which did not come in drums. Scan the drum's own label.`;
  if (lot.nextSeq == null) return `All ${lot.drums} drum${lot.drums === 1 ? "" : "s"} of lot ${lot.lotNo} are already recorded empty.`;
  return null;
}

/* ============================================================ record empty */

export type EmptyDrumInput = {
  code: string;
  kg: number | null;
  source: "scan" | "desk";
  /** Where the drum is standing now. Defaults to the lot's godown. */
  godownId?: string | null;
  /** The phone's idempotency key: a resend answers with the first save. */
  clientKey?: string | null;
  /** The person said this is a different drum of a lot scanned moments ago. */
  confirmDifferent?: boolean;
  /** A weight outside the limits, saved with this approval note. Only an approver may give one. */
  weightException?: string | null;
};

export type EmptyDrumSaved = {
  id: string;
  drumNo: number;
  label: string;
  seq: number | null;
  drums: number | null;
  lotNo: string;
  material: string;
  supplier: string;
  status: DrumStatus;
  statusLabel: string;
  ownership: DrumOwnership | null;
  declaredTareKg: number | null;
  actualKg: number;
  varianceKg: number | null;
  reviewReason: string | null;
  replay?: boolean;
};

/** Why a save stopped, for the phone to draw: `confirm` asks a question, `existing` shows what is there. */
export type EmptyDrumRefusal = { kind: "notFound" | "lot" | "weight" | "confirm" | "permission"; message: string; existing?: DrumLot["registered"] };

export async function recordEmptyDrum(actor: Actor, input: EmptyDrumInput, opts: { mayApproveWeight: boolean }): Promise<Result<EmptyDrumSaved> & { refusal?: EmptyDrumRefusal }> {
  const refusal = (r: EmptyDrumRefusal, field = "kg") => ({ ...fieldErr(r.kind === "weight" ? field : "code", r.message), refusal: r });

  if (input.clientKey) {
    const [prior] = await db.select({ id: erpEmptyDrums.id }).from(erpEmptyDrums).where(eq(erpEmptyDrums.clientKey, input.clientKey));
    if (prior) {
      const view = await drumSaved(prior.id);
      if (view) return ok({ ...view, replay: true }, `${view.label} was already saved`);
    }
  }
  const lot = await findDrumLot(input.code);
  if (!lot) return refusal({ kind: "notFound", message: "This label is not a lot in the purchase register. Ask the Production Head — do not record the drum without its label." });
  const lr = lotRefusal(lot);
  if (lr) return refusal({ kind: "lot", message: lr, existing: lot.registered });

  const c = await getConfig();
  const kg = input.kg == null ? null : r3(input.kg);
  const wr = weightRefusal(kg, { minKg: c["erp.drums.minEmptyKg"], maxKg: c["erp.drums.maxEmptyKg"] });
  const exception = (input.weightException ?? "").trim() || null;
  if (wr) {
    if (kg == null || kg <= 0) return refusal({ kind: "weight", message: wr });
    if (!exception) return refusal({ kind: "weight", message: wr });
    if (!opts.mayApproveWeight) return refusal({ kind: "permission", message: "Only somebody who approves drum corrections can accept a weight outside the limits." });
    if (exception.length < 10) return refusal({ kind: "weight", message: "Say in a sentence why this weight is right (10 characters or more)." }, "weightException");
  }

  const minutes = c["erp.drums.sameLotMinutes"];
  const last = lot.registered[lot.registered.length - 1];
  if (!input.confirmDifferent && minutes > 0 && last && Date.now() - Date.parse(last.recordedAt) < minutes * 60_000) {
    const at = new Date(last.recordedAt).toLocaleTimeString("en-IN", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit" });
    return refusal({
      kind: "confirm",
      message: `Drum ${last.seq ?? "?"} of lot ${lot.lotNo} was recorded empty at ${at}${last.by ? " by " + last.by : ""}. Is this a DIFFERENT drum?`,
      existing: lot.registered,
    });
  }

  const ownership = lot.ownership;
  const reasons: string[] = [];
  if (!ownership) reasons.push("Ownership is not recorded on the GRN or the supplier");
  if (lot.drums == null) reasons.push("The GRN records no drum count, so a second scan of the same drum cannot be told apart");
  const status: DrumStatus = reasons.length ? "review" : statusOnEmpty(ownership);
  const godownId = input.godownId || lot.godownId;

  const saved = await inTx<{ id: string }>(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"erp:drum:" + lot.purchaseId}))`);
    const taken = await q<{ seq: number }>(tx, sql`select seq from erp_empty_drums where purchase_id = ${lot.purchaseId} and status <> 'cancelled' and seq is not null`);
    const seq = nextDrumSeq(lot.drums, taken.map((t) => Number(t.seq)));
    if (seq == null) refuse({ ...fieldErr("code", `All ${lot.drums} drums of lot ${lot.lotNo} are already recorded empty.`), refusal: { kind: "lot", message: `All ${lot.drums} drums of lot ${lot.lotNo} are already recorded empty.`, existing: lot.registered } } as Result<unknown>);
    const id = erpId("drum");
    const drumNo = await nextNumber(tx, "emptyDrum");
    await tx.insert(erpEmptyDrums).values({
      id,
      drumNo,
      purchaseId: lot.purchaseId,
      lotNo: lot.lotNo,
      inwardId: lot.inwardId,
      prNumber: lot.prNumber,
      supplierId: lot.supplierId,
      rawMaterialId: lot.rawMaterialId,
      godownId,
      seq,
      ownership,
      declaredTareKg: lot.declaredTareKg,
      actualKg: kg,
      status,
      source: input.source,
      reviewReason: reasons.length ? reasons.join(". ") : null,
      weightException: wr ? `${exception} (approved by ${actor.name})` : null,
      clientKey: input.clientKey ?? null,
      recordedById: actor.id,
    });
    await event(tx, id, "emptied", null, status, actor.id, wr ? `Weight outside limits accepted: ${exception}` : null, { kg, declaredTareKg: lot.declaredTareKg, source: input.source });
    return ok({ id });
  });
  if (!saved.ok) return saved as Result<EmptyDrumSaved>;
  await audit(actor, "erp.drum.empty", "erp_empty_drum", saved.data.id, { lot: lot.lotNo, kg, status, ownership });
  const view = (await drumSaved(saved.data.id))!;
  return ok(view, `${view.label} saved · ${view.statusLabel}`);
}

async function drumSaved(id: string): Promise<EmptyDrumSaved | null> {
  const [d] = await q<{
    id: string; drumNo: number; seq: number | null; drums: number | null; lotNo: string; material: string; supplier: string; status: DrumStatus;
    own: DrumOwnership | null; tare: number | null; kg: number; review: string | null;
  }>(db, sql`
    select d.id, d.drum_no as "drumNo", d.seq, coalesce(p.drums, i.drums) as drums, d.lot_no as "lotNo", m.name as material, s.name as supplier, d.status,
           d.ownership as own, d.declared_tare_kg::float8 as tare, d.actual_kg::float8 as kg, d.review_reason as review
      from erp_empty_drums d
      left join erp_purchases p on p.id = d.purchase_id
      left join erp_inward i on i.id = d.inward_id
      left join erp_raw_materials m on m.id = d.raw_material_id
      left join erp_suppliers s on s.id = d.supplier_id
     where d.id = ${id}`);
  if (!d) return null;
  const v = tareVariance(d.kg == null ? null : Number(d.kg), d.tare == null ? null : Number(d.tare));
  return {
    id: d.id,
    drumNo: Number(d.drumNo),
    label: drumLabel(Number(d.drumNo)),
    seq: d.seq == null ? null : Number(d.seq),
    drums: d.drums == null ? null : Number(d.drums),
    lotNo: d.lotNo,
    material: d.material,
    supplier: d.supplier,
    status: d.status,
    statusLabel: DRUM_STATUS_LABEL[d.status],
    ownership: d.own,
    declaredTareKg: d.tare == null ? null : Number(d.tare),
    actualKg: Number(d.kg),
    varianceKg: v?.kg ?? null,
    reviewReason: d.review,
  };
}

/* ============================================================ review and corrections */

const LIVE: DrumStatus[] = ["available", "returnable", "review"];

async function lockDrum(tx: Tx, id: string) {
  const [d] = await q<{ id: string; status: DrumStatus; ownership: DrumOwnership | null; kg: number | null; drumNo: number; source: string }>(
    tx,
    sql`select id, status, ownership, actual_kg::float8 as kg, drum_no as "drumNo", source from erp_empty_drums where id = ${id} for update`,
  );
  return d ?? null;
}

/** The Production Head answers whose a drum in review is. Not for a drum already classified — that is an ownership change, which needs approval. */
export async function classifyDrum(actor: Actor, id: string, ownership: DrumOwnership, note: string): Promise<Result> {
  if (note.trim().length < 10) return fieldErr("note", "Say how you know whose drum this is (10 characters or more).");
  const r = await inTx(async (tx) => {
    const d = await lockDrum(tx, id);
    if (!d) return err("That drum is gone.", "not_found");
    if (d.status !== "review") return err(`${drumLabel(d.drumNo)} is ${DRUM_STATUS_LABEL[d.status].toLowerCase()} already. A change of owner is asked for, and approved by somebody else.`, "rule_violation");
    const to = statusOnEmpty(ownership);
    await tx.update(erpEmptyDrums).set({ ownership, status: to, reviewReason: null, updatedAt: new Date() }).where(eq(erpEmptyDrums.id, id));
    await event(tx, id, "classified", d.status, to, actor.id, note.trim(), { ownership });
    return okVoid(`${drumLabel(d.drumNo)} · ${OWNERSHIP_LABEL[ownership]}`);
  });
  if (r.ok) await audit(actor, "erp.drum.classify", "erp_empty_drum", id, { ownership, note });
  return r;
}

/** A wrong weight is corrected with a reason; the original stays in the drum's history. */
export async function correctDrumWeight(actor: Actor, id: string, kg: number, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why the weight changes (10 characters or more).");
  if (!(kg > 0)) return fieldErr("kg", "Enter the weight in kg.");
  const r = await inTx(async (tx) => {
    const d = await lockDrum(tx, id);
    if (!d) return err("That drum is gone.", "not_found");
    if (!LIVE.includes(d.status)) return err(`${drumLabel(d.drumNo)} is ${DRUM_STATUS_LABEL[d.status].toLowerCase()}; its record is closed.`, "rule_violation");
    if (d.source === "opening") return err("An opening-stock drum was never weighed.", "rule_violation");
    await tx.update(erpEmptyDrums).set({ actualKg: r3(kg), updatedAt: new Date() }).where(eq(erpEmptyDrums.id, id));
    await event(tx, id, "weight", d.status, d.status, actor.id, reason.trim(), { from: d.kg, to: r3(kg) });
    return okVoid(`${drumLabel(d.drumNo)} · ${d.kg} kg → ${r3(kg)} kg`);
  });
  if (r.ok) await audit(actor, "erp.drum.weight", "erp_empty_drum", id, { kg, reason });
  return r;
}

/** An entry made in error (the wrong lot scanned, one drum scanned twice) is cancelled, never deleted. */
export async function cancelDrumEntry(actor: Actor, id: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why this entry is wrong (10 characters or more).");
  const r = await inTx(async (tx) => {
    const d = await lockDrum(tx, id);
    if (!d) return err("That drum is gone.", "not_found");
    if (!LIVE.includes(d.status)) return err(`${drumLabel(d.drumNo)} is ${DRUM_STATUS_LABEL[d.status].toLowerCase()}; cancel the sale or return first.`, "rule_violation");
    await tx.update(erpEmptyDrums).set({ status: "cancelled", updatedAt: new Date() }).where(eq(erpEmptyDrums.id, id));
    await event(tx, id, "cancelled", d.status, "cancelled", actor.id, reason.trim());
    return okVoid(`${drumLabel(d.drumNo)} cancelled`);
  });
  if (r.ok) await audit(actor, "erp.drum.cancel", "erp_empty_drum", id, { reason });
  return r;
}

/* ============================================================ adjustments */

export type AdjustmentInput =
  | { kind: "opening" | "write_off"; ownership: DrumOwnership; supplierId: string | null; godownId: string | null; quantity: number; reason: string }
  | { kind: "ownership"; drumId: string; newOwnership: DrumOwnership; reason: string };

export async function requestDrumAdjustment(actor: Actor, a: AdjustmentInput): Promise<Result> {
  if (a.reason.trim().length < 10) return fieldErr("reason", "Say why in a sentence (10 characters or more).");
  const id = erpId("dradj");
  if (a.kind === "ownership") {
    const [d] = await db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.id, a.drumId));
    if (!d) return err("That drum is gone.", "not_found");
    if (!LIVE.includes(d.status as DrumStatus)) return err(`${drumLabel(d.drumNo)} is ${DRUM_STATUS_LABEL[d.status as DrumStatus].toLowerCase()}; its owner can no longer change.`, "rule_violation");
    if (d.ownership === a.newOwnership) return err(`${drumLabel(d.drumNo)} is already ${OWNERSHIP_LABEL[a.newOwnership].toLowerCase()}.`, "rule_violation");
    if (a.newOwnership === "returnable" && !d.supplierId) return err("An opening-stock drum names no supplier to return it to.", "rule_violation");
    const pending = await q<{ n: number }>(db, sql`select count(*)::int as n from erp_drum_adjustments where drum_id = ${a.drumId} and status = 'pending'`);
    if (Number(pending[0]?.n) > 0) return err("A change for this drum is already waiting for approval.", "conflict");
    await db.insert(erpDrumAdjustments).values({ id, kind: "ownership", drumId: a.drumId, newOwnership: a.newOwnership, reason: a.reason.trim(), requestedById: actor.id });
  } else {
    if (!Number.isInteger(a.quantity) || a.quantity <= 0) return fieldErr("quantity", "Enter how many drums, a whole number above 0.");
    if (a.ownership === "returnable" && !a.supplierId) return fieldErr("supplier", "Name the supplier these drums belong to.");
    if (a.kind === "opening" && !a.godownId) return fieldErr("godown", "Name the godown the drums are at.");
    await db.insert(erpDrumAdjustments).values({
      id,
      kind: a.kind,
      ownership: a.ownership,
      supplierId: a.ownership === "returnable" ? a.supplierId : null,
      godownId: a.godownId,
      quantity: a.quantity,
      reason: a.reason.trim(),
      requestedById: actor.id,
    });
  }
  await audit(actor, "erp.drum.adjust.request", "erp_drum_adjustment", id, a);
  return okVoid("Sent for approval");
}

/** Approved or rejected by somebody other than whoever asked — an administrator excepted. */
export async function decideDrumAdjustment(actor: Actor, id: string, approve: boolean, note: string, opts: { administrator: boolean }): Promise<Result> {
  const r = await inTx(async (tx) => {
    const [adj] = await tx.select().from(erpDrumAdjustments).where(eq(erpDrumAdjustments.id, id)).for("update");
    if (!adj) return err("That request is gone.", "not_found");
    if (adj.status !== "pending") return err("This request is already decided.", "conflict");
    if (adj.requestedById === actor.id && !opts.administrator) return err("Somebody other than the person who asked approves this.", "not_permitted");
    if (!approve) {
      if (note.trim().length < 5) return fieldErr("note", "Say why it is rejected.");
      await tx.update(erpDrumAdjustments).set({ status: "rejected", decidedById: actor.id, decidedAt: new Date(), decisionNote: note.trim() }).where(eq(erpDrumAdjustments.id, id));
      return okVoid("Rejected");
    }
    const kind = adj.kind;
    const posted: string[] = [];
    if (kind === "ownership") {
      const d = await lockDrum(tx, adj.drumId!);
      if (!d || !LIVE.includes(d.status)) return err("That drum has been sold, returned or written off since; nothing to change.", "conflict");
      const own = adj.newOwnership as DrumOwnership;
      const to = statusOnEmpty(own);
      await tx.update(erpEmptyDrums).set({ ownership: own, status: to, reviewReason: null, adjustmentId: id, updatedAt: new Date() }).where(eq(erpEmptyDrums.id, d.id));
      await event(tx, d.id, "ownership", d.status, to, actor.id, adj.reason, { from: d.ownership, to: own, approvedBy: actor.name });
      posted.push(d.id);
    } else if (kind === "opening") {
      const own = adj.ownership as DrumOwnership;
      for (let i = 0; i < (adj.quantity ?? 0); i++) {
        const did = erpId("drum");
        const drumNo = await nextNumber(tx, "emptyDrum");
        const st = statusOnEmpty(own);
        await tx.insert(erpEmptyDrums).values({ id: did, drumNo, godownId: adj.godownId!, ownership: own, supplierId: adj.supplierId, status: st, source: "opening", adjustmentId: id, recordedById: adj.requestedById });
        await event(tx, did, "opening", null, st, actor.id, adj.reason, { approvedBy: actor.name });
        posted.push(did);
      }
    } else {
      const own = adj.ownership as DrumOwnership;
      const pool = await q<{ id: string; drumNo: number; recordedAt: string; status: DrumStatus }>(tx, sql`
        select id, drum_no as "drumNo", recorded_at::text as "recordedAt", status from erp_empty_drums
         where status = ${own === "mahek" ? "available" : "returnable"}
           and (${own === "mahek"} or supplier_id = ${adj.supplierId})
           and (${adj.godownId}::text is null or godown_id = ${adj.godownId})
         order by recorded_at, drum_no for update`);
      const pick = fifoPick(pool.map((p) => ({ ...p, drumNo: Number(p.drumNo) })), adj.quantity ?? 0);
      if (!pick.ok) return err(pick.error, "rule_violation");
      for (const d of pick.picked) {
        await tx.update(erpEmptyDrums).set({ status: "adjusted", adjustmentId: id, updatedAt: new Date() }).where(eq(erpEmptyDrums.id, d.id));
        await event(tx, d.id, "write_off", d.status, "adjusted", actor.id, adj.reason, { approvedBy: actor.name });
        posted.push(d.id);
      }
    }
    await tx.update(erpDrumAdjustments).set({ status: "approved", decidedById: actor.id, decidedAt: new Date(), decisionNote: note.trim() || null, posted: { drums: posted } }).where(eq(erpDrumAdjustments.id, id));
    return okVoid(kind === "opening" ? `${posted.length} drum${posted.length === 1 ? "" : "s"} added` : kind === "write_off" ? `${posted.length} drum${posted.length === 1 ? "" : "s"} written off` : "Owner changed");
  });
  if (r.ok) await audit(actor, approve ? "erp.drum.adjust.approve" : "erp.drum.adjust.reject", "erp_drum_adjustment", id, { note });
  return r;
}

/* ============================================================ stock */

export type ScrapStock = { category: string; unit: string; godownId: string | null; available: number };

/** Mahek-owned empty drums available, optionally at one godown. */
export async function availableDrums(ex: Ex = db, godownId?: string | null): Promise<number> {
  const [r] = await q<{ n: number }>(ex, sql`select count(*)::int as n from erp_empty_drums where status = 'available' and (${godownId ?? null}::text is null or godown_id = ${godownId ?? null})`);
  return Number(r?.n ?? 0);
}

/** Non-drum scrap on hand: what was recorded, less what was sold — by category, unit and godown. */
export async function scrapStock(ex: Ex = db): Promise<ScrapStock[]> {
  const rows = await q<{ category: string; unit: string; godownId: string; inQty: number; outQty: number }>(ex, sql`
    with ins as (
      select category, unit, godown_id, sum(quantity)::float8 as q from erp_scrap_entries where status = 'active' group by 1, 2, 3
    ), outs as (
      select category, unit, godown_id, sum(quantity)::float8 as q from erp_scrap_sales where status = 'confirmed' and category <> ${DRUM_CATEGORY} group by 1, 2, 3
    )
    select coalesce(i.category, o.category) as category, coalesce(i.unit, o.unit) as unit, coalesce(i.godown_id, o.godown_id) as "godownId",
           coalesce(i.q, 0) as "inQty", coalesce(o.q, 0) as "outQty"
      from ins i full join outs o on o.category = i.category and o.unit = i.unit and o.godown_id is not distinct from i.godown_id`);
  return rows.map((r) => ({ category: r.category, unit: r.unit, godownId: r.godownId, available: r3(Number(r.inQty) - Number(r.outQty)) }));
}

export async function recordScrapEntry(actor: Actor, e: { date: string; category: string; godownId: string; quantity: number; unit: "Kg" | "Pcs"; note: string | null }): Promise<Result> {
  if (e.category === DRUM_CATEGORY) return fieldErr("category", "Empty drums are recorded one at a time from their label, on Empty drum entry.");
  if (!(e.quantity > 0)) return fieldErr("quantity", "Enter the quantity.");
  const id = erpId("scr");
  await db.insert(erpScrapEntries).values({ id, entryDate: e.date, category: e.category, godownId: e.godownId, quantity: r3(e.quantity), unit: e.unit, note: e.note, createdById: actor.id });
  await audit(actor, "erp.scrap.entry", "erp_scrap_entry", id, e);
  return okVoid(`${e.quantity} ${e.unit} of ${e.category} recorded`);
}

export async function cancelScrapEntry(actor: Actor, id: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why (10 characters or more).");
  const r = await inTx(async (tx) => {
    const [e] = await tx.select().from(erpScrapEntries).where(eq(erpScrapEntries.id, id)).for("update");
    if (!e) return err("That entry is gone.", "not_found");
    if (e.status !== "active") return err("Already cancelled.", "conflict");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"erp:scrap:" + e.category + ":" + e.unit}))`);
    await tx.update(erpScrapEntries).set({ status: "cancelled", cancelReason: reason.trim(), cancelledById: actor.id, cancelledAt: new Date() }).where(eq(erpScrapEntries.id, id));
    const left = (await scrapStock(tx)).find((s) => s.category === e.category && s.unit === e.unit && s.godownId === e.godownId)?.available ?? 0;
    if (left < 0) return err(`Cancelling this would leave ${left} ${e.unit} of ${e.category} — more has been sold than was recorded without it.`, "rule_violation");
    return okVoid("Entry cancelled");
  });
  if (r.ok) await audit(actor, "erp.scrap.entry.cancel", "erp_scrap_entry", id, { reason });
  return r;
}

/* ============================================================ scrap sale */

export type SaleInput = {
  date: string;
  buyerId: string;
  category: string;
  quantity: number;
  unit: "Pcs" | "Kg";
  ratePaise: number;
  refKind: "invoice" | "challan" | "none";
  externalRef: string | null;
  dueDate: string | null;
  remark: string | null;
  godownId: string | null;
  /** Particular drums to sell (a drum's own "Sell as scrap"). Absent: oldest first. */
  drumIds?: string[];
};

export async function sellScrap(actor: Actor, s: SaleInput): Promise<Result<{ id: string; saleNo: number; drums: string[] }>> {
  const isDrum = s.category === DRUM_CATEGORY;
  if (!(s.quantity > 0)) return fieldErr("quantity", "Enter the quantity sold.");
  if (isDrum && !Number.isInteger(s.quantity)) return fieldErr("quantity", "Drums are sold whole: enter a whole number.");
  if (!(s.ratePaise >= 0)) return fieldErr("rate", "Enter the rate.");
  if (s.refKind !== "none" && !s.externalRef) return fieldErr("externalRef", s.refKind === "invoice" ? "Enter the external invoice number." : "Enter the challan or reference number.");
  if (s.refKind === "none" && s.externalRef) return fieldErr("externalRef", "A sale with no external invoice carries no invoice number — leave it empty.");
  if (s.dueDate && s.dueDate < s.date) return fieldErr("dueDate", "The due date cannot be before the sale.");
  const r = await inTx<{ id: string; saleNo: number; drums: string[] }>(async (tx) => {
    let drums: string[] = [];
    if (isDrum) {
      if (s.drumIds?.length) {
        const rows = await q<{ id: string; drumNo: number; status: DrumStatus; ownership: DrumOwnership | null }>(tx, sql`
          select id, drum_no as "drumNo", status, ownership from erp_empty_drums where id in ${sql`(${sql.join(s.drumIds.map((i) => sql`${i}`), sql`, `)})`} for update`);
        for (const d of rows) {
          if (d.ownership === "returnable" || d.status === "returnable") refuse(err(RETURNABLE_NOT_FOR_SALE, "rule_violation"));
          if (d.status !== "available") refuse(err(`${drumLabel(Number(d.drumNo))} is ${DRUM_STATUS_LABEL[d.status].toLowerCase()} and cannot be sold.`, "rule_violation"));
        }
        if (rows.length !== s.drumIds.length) refuse(err("A drum on this sale no longer exists.", "conflict"));
        if (rows.length !== s.quantity) refuse(fieldErr("quantity", `You picked ${rows.length} drum${rows.length === 1 ? "" : "s"}; the quantity must match.`));
        drums = rows.map((d) => d.id);
      } else {
        const pool = await q<{ id: string; drumNo: number; recordedAt: string }>(tx, sql`
          select id, drum_no as "drumNo", recorded_at::text as "recordedAt" from erp_empty_drums
           where status = 'available' and (${s.godownId}::text is null or godown_id = ${s.godownId})
           order by recorded_at, drum_no for update`);
        const pick = fifoPick(pool.map((p) => ({ ...p, drumNo: Number(p.drumNo) })), s.quantity, "Mahek-owned empty drum");
        if (!pick.ok) refuse(fieldErr("quantity", pick.error));
        drums = (pick as { ok: true; picked: { id: string }[] }).picked.map((d) => d.id);
      }
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"erp:scrap:" + s.category + ":" + s.unit}))`);
      const have = (await scrapStock(tx)).filter((x) => x.category === s.category && x.unit === s.unit && (!s.godownId || x.godownId === s.godownId)).reduce((a, x) => a + x.available, 0);
      if (s.quantity > have + 1e-9) refuse(fieldErr("quantity", `Only ${r3(have)} ${s.unit} of ${s.category} is recorded${s.godownId ? " at this godown" : ""} — you entered ${s.quantity}.`));
    }
    const id = erpId("ssale");
    const saleNo = await nextNumber(tx, "scrapSale");
    await tx.insert(erpScrapSales).values({
      id,
      saleNo,
      saleDate: s.date,
      buyerId: s.buyerId,
      category: s.category,
      godownId: s.godownId,
      quantity: r3(s.quantity),
      unit: isDrum ? "Pcs" : s.unit,
      ratePaise: s.ratePaise,
      amountPaise: saleAmount(s.quantity, s.ratePaise),
      refKind: s.refKind,
      externalRef: s.refKind === "none" ? null : s.externalRef,
      dueDate: s.dueDate,
      remark: s.remark,
      createdById: actor.id,
    });
    if (drums.length) {
      await tx.update(erpEmptyDrums).set({ status: "sold", scrapSaleId: id, updatedAt: new Date() }).where(inArray(erpEmptyDrums.id, drums));
      for (const d of drums) await event(tx, d, "sold", "available", "sold", actor.id, null, { sale: scrapSaleLabel(saleNo), allocation: s.drumIds?.length ? "picked" : "fifo" });
    }
    return ok({ id, saleNo, drums });
  });
  if (r.ok) await audit(actor, "erp.scrap.sale", "erp_scrap_sale", r.data.id, { ...s, drums: r.data.drums.length });
  return r.ok ? ok(r.data, `${scrapSaleLabel(r.data.saleNo)} saved${isDrum ? ` · ${r.data.drums.length} drums allocated oldest first` : ""}`) : r;
}

/** A sale made in error: only while nothing has been matched to it. Its drums go back to stock. */
export async function cancelScrapSale(actor: Actor, id: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why the sale is cancelled (10 characters or more).");
  const r = await inTx(async (tx) => {
    const [s] = await tx.select().from(erpScrapSales).where(eq(erpScrapSales.id, id)).for("update");
    if (!s) return err("That sale is gone.", "not_found");
    if (s.status !== "confirmed") return err("Already cancelled.", "conflict");
    const [m] = await q<{ n: number }>(tx, sql`select count(*)::int as n from erp_scrap_allocations where sale_id = ${id} and voided_at is null`);
    if (Number(m?.n) > 0) return err("Money is matched to this sale. The accountant undoes the match first.", "rule_violation");
    await tx.update(erpScrapSales).set({ status: "cancelled", cancelReason: reason.trim(), cancelledById: actor.id, cancelledAt: new Date() }).where(eq(erpScrapSales.id, id));
    const back = await tx.update(erpEmptyDrums).set({ status: "available", scrapSaleId: null, updatedAt: new Date() }).where(and(eq(erpEmptyDrums.scrapSaleId, id), eq(erpEmptyDrums.status, "sold"))).returning({ id: erpEmptyDrums.id });
    for (const d of back) await event(tx, d.id, "sale_cancelled", "sold", "available", actor.id, reason.trim(), { sale: scrapSaleLabel(s.saleNo) });
    return okVoid(`${scrapSaleLabel(s.saleNo)} cancelled${back.length ? ` · ${back.length} drums back in stock` : ""}`);
  });
  if (r.ok) await audit(actor, "erp.scrap.sale.cancel", "erp_scrap_sale", id, { reason });
  return r;
}

/* ============================================================ vendor returns */

export async function returnDrums(actor: Actor, x: { supplierId: string; date: string; quantity: number; challanRef: string | null; remark: string | null }): Promise<Result<{ id: string; returnNo: number }>> {
  if (!Number.isInteger(x.quantity) || x.quantity <= 0) return fieldErr("quantity", "Enter how many drums, a whole number above 0.");
  const r = await inTx<{ id: string; returnNo: number }>(async (tx) => {
    const pool = await q<{ id: string; drumNo: number; recordedAt: string }>(tx, sql`
      select id, drum_no as "drumNo", recorded_at::text as "recordedAt" from erp_empty_drums
       where status = 'returnable' and supplier_id = ${x.supplierId}
       order by recorded_at, drum_no for update`);
    const pick = fifoPick(pool.map((p) => ({ ...p, drumNo: Number(p.drumNo) })), x.quantity);
    if (!pick.ok) return fieldErr("quantity", x.quantity > pool.length ? `Only ${pool.length} of this supplier's drums ${pool.length === 1 ? "is" : "are"} waiting to be returned — you entered ${x.quantity}.` : pick.error);
    const id = erpId("dret");
    const returnNo = await nextNumber(tx, "drumReturn");
    await tx.insert(erpDrumReturns).values({ id, returnNo, supplierId: x.supplierId, returnDate: x.date, quantity: x.quantity, challanRef: x.challanRef, remark: x.remark, createdById: actor.id });
    const ids = pick.picked.map((d) => d.id);
    await tx.update(erpEmptyDrums).set({ status: "returned", returnId: id, updatedAt: new Date() }).where(inArray(erpEmptyDrums.id, ids));
    for (const d of ids) await event(tx, d, "returned", "returnable", "returned", actor.id, null, { return: drumReturnLabel(returnNo) });
    return ok({ id, returnNo });
  });
  if (r.ok) await audit(actor, "erp.drum.return", "erp_drum_return", r.data.id, x);
  return r.ok ? ok(r.data, `${drumReturnLabel(r.data.returnNo)} saved · ${x.quantity} drums returned`) : r;
}

export async function cancelDrumReturn(actor: Actor, id: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why (10 characters or more).");
  const r = await inTx(async (tx) => {
    const [x] = await tx.select().from(erpDrumReturns).where(eq(erpDrumReturns.id, id)).for("update");
    if (!x) return err("That return is gone.", "not_found");
    if (x.status !== "confirmed") return err("Already cancelled.", "conflict");
    await tx.update(erpDrumReturns).set({ status: "cancelled", cancelReason: reason.trim(), cancelledById: actor.id, cancelledAt: new Date() }).where(eq(erpDrumReturns.id, id));
    const back = await tx.update(erpEmptyDrums).set({ status: "returnable", returnId: null, updatedAt: new Date() }).where(and(eq(erpEmptyDrums.returnId, id), eq(erpEmptyDrums.status, "returned"))).returning({ id: erpEmptyDrums.id });
    for (const d of back) await event(tx, d.id, "return_cancelled", "returned", "returnable", actor.id, reason.trim(), { return: drumReturnLabel(x.returnNo) });
    return okVoid(`${drumReturnLabel(x.returnNo)} cancelled · ${back.length} drums waiting again`);
  });
  if (r.ok) await audit(actor, "erp.drum.return.cancel", "erp_drum_return", id, { reason });
  return r;
}

/* ============================================================ receipts and matching */

export const RECEIPT_MODES = ["Cash", "Bank transfer", "UPI", "Cheque"];

export async function recordReceipt(actor: Actor, x: { date: string; mode: string; amountPaise: number; buyerId: string | null; payer: string | null; reference: string | null; note: string | null }): Promise<Result<{ id: string; receiptNo: number }>> {
  if (!RECEIPT_MODES.includes(x.mode)) return fieldErr("mode", "Choose how the money came.");
  if (!(x.amountPaise > 0)) return fieldErr("amount", "Enter the amount received.");
  if (!x.buyerId && !x.payer) return fieldErr("buyer", "Name the scrap buyer, or who the money came from.");
  const r = await inTx<{ id: string; receiptNo: number }>(async (tx) => {
    const id = erpId("rcpt");
    const receiptNo = await nextNumber(tx, "cashReceipt");
    await tx.insert(erpCashReceipts).values({ id, receiptNo, receiptDate: x.date, mode: x.mode, amountPaise: x.amountPaise, buyerId: x.buyerId, payer: x.payer, reference: x.reference, note: x.note, createdById: actor.id });
    return ok({ id, receiptNo });
  });
  if (r.ok) await audit(actor, "erp.receipt.create", "erp_cash_receipt", r.data.id, x);
  return r.ok ? ok(r.data, `${receiptLabel(r.data.receiptNo)} recorded`) : r;
}

async function receiptLeft(tx: Ex, receiptId: string): Promise<{ amount: number; matched: number; status: string; buyerId: string | null; receiptNo: number } | null> {
  const [x] = await q<{ amount: number; matched: number; status: string; buyerId: string | null; no: number }>(tx, sql`
    select r.amount_paise::float8 as amount, r.status, r.buyer_id as "buyerId", r.receipt_no as no,
           coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null), 0)::float8 as matched
      from erp_cash_receipts r where r.id = ${receiptId}`);
  return x ? { amount: Number(x.amount), matched: Number(x.matched), status: x.status, buyerId: x.buyerId, receiptNo: Number(x.no) } : null;
}

async function saleOwed(tx: Ex, saleId: string): Promise<{ amount: number; matched: number; status: string; buyerId: string; saleNo: number } | null> {
  const [x] = await q<{ amount: number; matched: number; status: string; buyerId: string; no: number }>(tx, sql`
    select s.amount_paise::float8 as amount, s.status, s.buyer_id as "buyerId", s.sale_no as no,
           coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0)::float8 as matched
      from erp_scrap_sales s where s.id = ${saleId}`);
  return x ? { amount: Number(x.amount), matched: Number(x.matched), status: x.status, buyerId: x.buyerId, saleNo: Number(x.no) } : null;
}

/** The accountant matches part or all of a receipt to one sale. Locked on both, so two matches cannot overspend either. */
export async function allocateReceipt(actor: Actor, receiptId: string, saleId: string, amountPaise: number): Promise<Result> {
  const r = await inTx(async (tx) => {
    await tx.execute(sql`select id from erp_cash_receipts where id = ${receiptId} for update`);
    await tx.execute(sql`select id from erp_scrap_sales where id = ${saleId} for update`);
    const rc = await receiptLeft(tx, receiptId);
    const sl = await saleOwed(tx, saleId);
    if (!rc) return err("That receipt is gone.", "not_found");
    if (!sl) return err("That sale is gone.", "not_found");
    if (rc.status !== "active") return err("This receipt is void.", "rule_violation");
    if (sl.status !== "confirmed") return err("This sale is cancelled.", "rule_violation");
    if (rc.buyerId && rc.buyerId !== sl.buyerId) return err("This receipt is from a different buyer than the sale.", "rule_violation");
    const why = allocationRefusal(amountPaise, rc.amount - rc.matched, outstanding(sl.amount, sl.matched));
    if (why) return fieldErr("amount", why);
    await tx.insert(erpScrapAllocations).values({ id: erpId("salloc"), receiptId, saleId, amountPaise, byId: actor.id });
    return okVoid(`₹${(amountPaise / 100).toLocaleString("en-IN")} of ${receiptLabel(rc.receiptNo)} matched to ${scrapSaleLabel(sl.saleNo)} · ₹${((outstanding(sl.amount, sl.matched) - amountPaise) / 100).toLocaleString("en-IN")} still outstanding`);
  });
  if (r.ok) await audit(actor, "erp.receipt.allocate", "erp_cash_receipt", receiptId, { saleId, amountPaise });
  return r;
}

export async function voidAllocation(actor: Actor, allocationId: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why the match is undone (10 characters or more).");
  const done = await db
    .update(erpScrapAllocations)
    .set({ voidedAt: new Date(), voidedById: actor.id, voidReason: reason.trim() })
    .where(and(eq(erpScrapAllocations.id, allocationId), sql`${erpScrapAllocations.voidedAt} is null`))
    .returning({ id: erpScrapAllocations.id, receiptId: erpScrapAllocations.receiptId, saleId: erpScrapAllocations.saleId, amount: erpScrapAllocations.amountPaise });
  if (!done.length) return err("That match is already undone.", "conflict");
  await audit(actor, "erp.receipt.unallocate", "erp_cash_receipt", done[0].receiptId, { ...done[0], reason });
  return okVoid("Match undone · the sale is outstanding again");
}

export async function voidReceipt(actor: Actor, id: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why (10 characters or more).");
  const r = await inTx(async (tx) => {
    const [x] = await tx.select().from(erpCashReceipts).where(eq(erpCashReceipts.id, id)).for("update");
    if (!x) return err("That receipt is gone.", "not_found");
    if (x.status !== "active") return err("Already void.", "conflict");
    const [m] = await q<{ n: number }>(tx, sql`select count(*)::int as n from erp_scrap_allocations where receipt_id = ${id} and voided_at is null`);
    if (Number(m?.n) > 0) return err("This receipt is matched to a sale. Undo the match first.", "rule_violation");
    await tx.update(erpCashReceipts).set({ status: "void", voidReason: reason.trim(), voidedById: actor.id, voidedAt: new Date() }).where(eq(erpCashReceipts.id, id));
    return okVoid(`${receiptLabel(x.receiptNo)} void`);
  });
  if (r.ok) await audit(actor, "erp.receipt.void", "erp_cash_receipt", id, { reason });
  return r;
}

/* ============================================================ reads */

export type SaleRow = {
  id: string;
  saleNo: number;
  date: string;
  buyerId: string;
  buyer: string;
  category: string;
  quantity: number;
  unit: string;
  ratePaise: number;
  amountPaise: number;
  matchedPaise: number;
  outstandingPaise: number;
  refKind: string;
  externalRef: string | null;
  dueDate: string | null;
  remark: string | null;
  status: string;
  godown: string | null;
  by: string | null;
  createdAt: string;
  cancelReason: string | null;
};

export async function saleRows(): Promise<SaleRow[]> {
  const rows = await q<Record<string, unknown>>(db, sql`
    select s.id, s.sale_no as "saleNo", s.sale_date::text as date, s.buyer_id as "buyerId", b.name as buyer, s.category, s.quantity::float8 as quantity, s.unit,
           s.rate_paise::float8 as rate, s.amount_paise::float8 as amount, s.ref_kind as "refKind", s.external_ref as "externalRef", s.due_date::text as "dueDate",
           s.remark, s.status, g.name as godown, u.name as by, s.created_at::text as "createdAt", s.cancel_reason as "cancelReason",
           coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0)::float8 as matched
      from erp_scrap_sales s join erp_scrap_buyers b on b.id = s.buyer_id
      left join erp_godowns g on g.id = s.godown_id left join users u on u.id = s.created_by_id
     order by s.sale_date desc, s.sale_no desc`);
  return rows.map((r) => {
    const amount = Number(r.amount), matched = Number(r.matched);
    return {
      id: String(r.id), saleNo: Number(r.saleNo), date: String(r.date), buyerId: String(r.buyerId), buyer: String(r.buyer), category: String(r.category),
      quantity: Number(r.quantity), unit: String(r.unit), ratePaise: Number(r.rate), amountPaise: amount, matchedPaise: matched,
      outstandingPaise: r.status === "confirmed" ? outstanding(amount, matched) : 0,
      refKind: String(r.refKind), externalRef: (r.externalRef as string) ?? null, dueDate: (r.dueDate as string) ?? null, remark: (r.remark as string) ?? null,
      status: String(r.status), godown: (r.godown as string) ?? null, by: (r.by as string) ?? null, createdAt: String(r.createdAt), cancelReason: (r.cancelReason as string) ?? null,
    };
  });
}

export type AllocationRow = { id: string; receiptId: string; receiptNo: number; saleId: string; saleNo: number; amountPaise: number; at: string; by: string | null; voidedAt: string | null; voidReason: string | null; receiptDate: string; mode: string };

export async function allocationRows(where: { saleId?: string; receiptId?: string } = {}): Promise<AllocationRow[]> {
  const rows = await q<Record<string, unknown>>(db, sql`
    select a.id, a.receipt_id as "receiptId", r.receipt_no as "receiptNo", a.sale_id as "saleId", s.sale_no as "saleNo", a.amount_paise::float8 as amount,
           a.at::text as at, u.name as by, a.voided_at::text as "voidedAt", a.void_reason as "voidReason", r.receipt_date::text as "receiptDate", r.mode
      from erp_scrap_allocations a join erp_cash_receipts r on r.id = a.receipt_id join erp_scrap_sales s on s.id = a.sale_id left join users u on u.id = a.by_id
     where (${where.saleId ?? null}::text is null or a.sale_id = ${where.saleId ?? null})
       and (${where.receiptId ?? null}::text is null or a.receipt_id = ${where.receiptId ?? null})
     order by a.at`);
  return rows.map((r) => ({
    id: String(r.id), receiptId: String(r.receiptId), receiptNo: Number(r.receiptNo), saleId: String(r.saleId), saleNo: Number(r.saleNo), amountPaise: Number(r.amount),
    at: String(r.at), by: (r.by as string) ?? null, voidedAt: (r.voidedAt as string) ?? null, voidReason: (r.voidReason as string) ?? null, receiptDate: String(r.receiptDate), mode: String(r.mode),
  }));
}

export type ReceiptRow = { id: string; receiptNo: number; date: string; mode: string; amountPaise: number; matchedPaise: number; leftPaise: number; buyerId: string | null; buyer: string | null; payer: string | null; reference: string | null; note: string | null; status: string; by: string | null; createdAt: string };

export async function receiptRows(): Promise<ReceiptRow[]> {
  const rows = await q<Record<string, unknown>>(db, sql`
    select r.id, r.receipt_no as "receiptNo", r.receipt_date::text as date, r.mode, r.amount_paise::float8 as amount, r.buyer_id as "buyerId", b.name as buyer,
           r.payer, r.reference, r.note, r.status, u.name as by, r.created_at::text as "createdAt",
           coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null), 0)::float8 as matched
      from erp_cash_receipts r left join erp_scrap_buyers b on b.id = r.buyer_id left join users u on u.id = r.created_by_id
     order by r.receipt_date desc, r.receipt_no desc`);
  return rows.map((r) => ({
    id: String(r.id), receiptNo: Number(r.receiptNo), date: String(r.date), mode: String(r.mode), amountPaise: Number(r.amount), matchedPaise: Number(r.matched),
    leftPaise: r.status === "active" ? Number(r.amount) - Number(r.matched) : 0, buyerId: (r.buyerId as string) ?? null, buyer: (r.buyer as string) ?? null,
    payer: (r.payer as string) ?? null, reference: (r.reference as string) ?? null, note: (r.note as string) ?? null, status: String(r.status), by: (r.by as string) ?? null, createdAt: String(r.createdAt),
  }));
}

export type DrumRow = {
  id: string; drumNo: number; seq: number | null; drums: number | null; lotNo: string | null; prNumber: number | null; supplierId: string | null; supplier: string | null;
  material: string | null; godownId: string; godown: string; ownership: DrumOwnership | null; status: DrumStatus; source: string; declaredTareKg: number | null;
  actualKg: number | null; reviewReason: string | null; weightException: string | null; recordedAt: string;
  /** The business day it was emptied, in APP_TIMEZONE — never a slice of the instant. */
  emptiedOn: string;
  by: string | null;
  saleId: string | null; saleNo: number | null; returnId: string | null; returnNo: number | null;
};

export async function drumRows(): Promise<DrumRow[]> {
  const rows = await q<Record<string, unknown>>(db, sql`
    select d.id, d.drum_no as "drumNo", d.seq, coalesce(p.drums, i.drums) as drums, d.lot_no as "lotNo", d.pr_number as "prNumber", d.supplier_id as "supplierId", s.name as supplier,
           m.name as material, d.godown_id as "godownId", g.name as godown, d.ownership, d.status, d.source, d.declared_tare_kg::float8 as tare, d.actual_kg::float8 as kg,
           d.review_reason as "reviewReason", d.weight_exception as "weightException", d.recorded_at::text as "recordedAt",
           (d.recorded_at at time zone ${APP_TIMEZONE})::date::text as "emptiedOn", u.name as by,
           d.scrap_sale_id as "saleId", ss.sale_no as "saleNo", d.return_id as "returnId", rt.return_no as "returnNo"
      from erp_empty_drums d
      join erp_godowns g on g.id = d.godown_id
      left join erp_purchases p on p.id = d.purchase_id
      left join erp_inward i on i.id = d.inward_id
      left join erp_suppliers s on s.id = d.supplier_id
      left join erp_raw_materials m on m.id = d.raw_material_id
      left join users u on u.id = d.recorded_by_id
      left join erp_scrap_sales ss on ss.id = d.scrap_sale_id
      left join erp_drum_returns rt on rt.id = d.return_id
     order by d.recorded_at desc, d.drum_no desc`);
  return rows.map((r) => ({
    id: String(r.id), drumNo: Number(r.drumNo), seq: r.seq == null ? null : Number(r.seq), drums: r.drums == null ? null : Number(r.drums), lotNo: (r.lotNo as string) ?? null,
    prNumber: r.prNumber == null ? null : Number(r.prNumber), supplierId: (r.supplierId as string) ?? null, supplier: (r.supplier as string) ?? null, material: (r.material as string) ?? null,
    godownId: String(r.godownId), godown: String(r.godown), ownership: (r.ownership as DrumOwnership) ?? null, status: r.status as DrumStatus, source: String(r.source),
    declaredTareKg: r.tare == null ? null : Number(r.tare), actualKg: r.kg == null ? null : Number(r.kg), reviewReason: (r.reviewReason as string) ?? null,
    weightException: (r.weightException as string) ?? null, recordedAt: String(r.recordedAt), emptiedOn: String(r.emptiedOn), by: (r.by as string) ?? null,
    saleId: (r.saleId as string) ?? null, saleNo: r.saleNo == null ? null : Number(r.saleNo), returnId: (r.returnId as string) ?? null, returnNo: r.returnNo == null ? null : Number(r.returnNo),
  }));
}

export type DrumHistoryLine = { at: string; text: string; by: string | null; note: string | null };

/** Every drum's history, read in one query and grouped — a list of hundreds of drums must not ask once per row. */
export async function drumHistories(drumIds: string[]): Promise<Map<string, DrumHistoryLine[]>> {
  const out = new Map<string, DrumHistoryLine[]>();
  if (!drumIds.length) return out;
  const rows = await q<{ drumId: string; at: string; kind: string; note: string | null; by: string | null; detail: Record<string, unknown> | null }>(db, sql`
    select e.drum_id as "drumId", e.at::text as at, e.kind, e.note, u.name as by, e.detail
      from erp_drum_events e left join users u on u.id = e.by_id
     where e.drum_id in ${sql`(${sql.join(drumIds.map((i) => sql`${i}`), sql`, `)})`}
     order by e.at`);
  for (const r of rows) {
    const d = r.detail ?? {};
    const text =
      r.kind === "emptied" ? `Recorded empty at ${d.kg ?? "?"} kg`
      : r.kind === "sold" ? `Sold on ${String(d.sale ?? "")}${d.allocation === "fifo" ? " (allocated oldest first)" : ""}`
      : r.kind === "returned" ? `Returned to the supplier on ${String(d.return ?? "")} (allocated oldest first)`
      : r.kind === "weight" ? `Weight corrected ${d.from ?? "?"} kg → ${d.to ?? "?"} kg`
      : r.kind === "ownership" ? `Owner changed to ${OWNERSHIP_LABEL[d.to as DrumOwnership] ?? "?"}, approved by ${String(d.approvedBy ?? "")}`
      : r.kind === "classified" ? `Classified as ${OWNERSHIP_LABEL[d.ownership as DrumOwnership] ?? "?"}`
      : r.kind === "opening" ? `Added as opening stock, approved by ${String(d.approvedBy ?? "")}`
      : r.kind === "write_off" ? `Written off, approved by ${String(d.approvedBy ?? "")}`
      : r.kind === "sale_cancelled" ? `${String(d.sale ?? "Sale")} cancelled — back in stock`
      : r.kind === "return_cancelled" ? `${String(d.return ?? "Return")} cancelled — waiting to be returned again`
      : r.kind === "cancelled" ? "Entry cancelled"
      : r.kind;
    const list = out.get(r.drumId) ?? [];
    list.push({ at: r.at, text, by: r.by, note: r.note });
    out.set(r.drumId, list);
  }
  return out;
}

export async function drumHistory(drumId: string): Promise<DrumHistoryLine[]> {
  return (await drumHistories([drumId])).get(drumId) ?? [];
}

/** Today's figure for a dashboard tile, the factory phone and the screens. */
export async function drumCounts(): Promise<{ available: number; returnable: number; review: number; outstandingPaise: number; pendingAdjustments: number }> {
  const [r] = await q<{ a: number; r: number; v: number; o: number; p: number }>(db, sql`
    select (select count(*) from erp_empty_drums where status = 'available')::int as a,
           (select count(*) from erp_empty_drums where status = 'returnable')::int as r,
           (select count(*) from erp_empty_drums where status = 'review')::int as v,
           (select coalesce(sum(greatest(s.amount_paise - coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0), 0)), 0)
              from erp_scrap_sales s where s.status = 'confirmed')::float8 as o,
           (select count(*) from erp_drum_adjustments where status = 'pending')::int as p`);
  return { available: Number(r?.a ?? 0), returnable: Number(r?.r ?? 0), review: Number(r?.v ?? 0), outstandingPaise: Number(r?.o ?? 0), pendingAdjustments: Number(r?.p ?? 0) };
}

export { today as drumToday };
