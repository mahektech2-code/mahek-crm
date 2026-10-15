import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { erpId } from "@/lib/erp/server";
import { screenModule } from "@/lib/erp/screens";
import { calendarDate } from "@/lib/business-date";
import { fgLots, sfgLots } from "@/lib/erp/stock";
import { getConfig } from "@/lib/config/store";
import { err, okVoid, ok, type Result } from "@/lib/result";
import type { Proc, Team } from "./types";
import { MIX_BATCH_MAX, PROCS } from "./types";
import { emptyBoxShort, FILL_FROM_LOT_MAX, PACK_FROM_LOT_MAX, packBatchPlan } from "./rules";
import { contextFor, emptyBoxesAt, erpCtxFor, factoryAudit, nextTaskId, nowHM, openPackBatches, teamDefaults, worksOn, writeTeam, type FactoryCtx } from "./server";
import { submitJob } from "./post";

/* ---------------------------------------------------------------------------
 * What the Production Head does, and the one thing a worker may raise.
 *
 * Every decision here is a manager's, checked in the function and not by
 * which buttons a screen draws. Every one writes a line of the job's history
 * with the reason given, and none of them edits a posted ERP document except
 * through the ERP's own action for it.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const n = (v: unknown) => Number(v ?? 0) || 0;

const NOT_HEAD = "Only the Production Head can do that.";
/** A supervisor of one department acts on that department's work only. */
const outOfScope = (fc: FactoryCtx, proc: string) => !!fc.scopes && !fc.scopes.includes(proc as Proc);
const notYours = (fc: FactoryCtx) => "You supervise " + (fc.scopes ?? []).join(" and ") + " only. Ask the Production Head.";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function taskAt(fc: FactoryCtx, id: string) {
  const [t] = await q<{ id: string; proc: Proc; status: string; out: Record<string, unknown> | null; item: string | null }>(sql`
    select id, proc, status, out, item from factory_tasks where id = ${id} and godown_id = ${fc.godown.id}`);
  return t ?? null;
}

/* ------------------------------------------------------------ giving work */

export async function assignTask(fc: FactoryCtx, a: { proc: Proc; item: string; qty: number; due: string }): Promise<Result<{ id: string }>> {
  if (!fc.head) return err(NOT_HEAD, "not_permitted");
  if (!PROCS.includes(a.proc) || a.proc === "dispatch") return err("Loading jobs come from the ERP's orders.", "validation");
  if (outOfScope(fc, a.proc)) return err(notYours(fc), "not_permitted");
  if (!HHMM.test(a.due)) return err("Choose when it is due.", "validation");
  const qty = Math.floor(Number(a.qty));
  if (!(qty > 0) || (a.proc === "mixing" ? qty > MIX_BATCH_MAX : qty > 5000)) return err("Enter how many, more than 0.", "validation");

  /* The item has to be something the ERP can make here — the formula is the
     approved batch sheet and is never edited from a phone. */
  if (a.proc === "mixing") {
    const [r] = await q(sql`select 1 from erp_recipes where formulation_id = ${a.item} limit 1`);
    if (!r) return err("This base has no approved batch sheet.", "validation");
  } else if (a.proc === "filling") {
    const [fg] = await q(sql`select 1 from finished_goods where id = ${a.item.split(":")[0]} and active`);
    if (!fg) return err("Pick a product to fill.", "validation");
  } else {
    const [p] = await q(sql`select 1 from products where id = ${a.item} and active`);
    if (!p) return err("Pick a box to pack.", "validation");
  }

  /* A filling sheet names the base tank to fill from: the fullest approved
     lot of the right base here, or none — the worker scans what is there. */
  let sfgLot: string | null = null;
  if (a.proc === "filling") {
    const [fg] = await q<{ fid: string }>(sql`select formulation_id as fid from finished_goods where id = ${a.item.split(":")[0]}`);
    const approved = new Set((await q<{ lot: string }>(sql`select lot_code as lot from erp_sfg_qc where status = 'Approved'`)).map((r) => r.lot));
    const lot = (await sfgLots())
      .filter((l) => l.formulationId === fg?.fid && l.godownId === fc.godown.id && l.stock > 0 && approved.has(l.lotCode))
      .sort((x, y) => y.stock - x.stock)[0];
    sfgLot = lot?.lotCode ?? null;
  }

  const teams = await teamDefaults();
  const id = await insertTask(fc, { proc: a.proc, item: a.item, qty, due: a.due, sfgLot }, teams[a.proc]);
  const procWord = { mixing: "Mixing", filling: "Filling", packing: "Packing" }[a.proc as "mixing"];
  await factoryAudit(fc, "factory.task.assign", id, "Task given to " + procWord + " team");
  return ok({ id }, id + " sent");
}

async function insertTask(fc: FactoryCtx, a: { proc: Proc; item: string; qty: number; due: string; sfgLot: string | null }, team: Team): Promise<string> {
  return db.transaction(async (tx) => {
    const tid = await nextTaskId(tx);
    await tx.execute(sql`
      insert into factory_tasks (id, proc, godown_id, work_date, due, status, item, batches, target, sfg_lot, created_by_id)
      values (${tid}, ${a.proc}, ${fc.godown.id}, ${calendarDate(new Date())}::date, ${a.due}, 'ready', ${a.item},
              ${a.proc === "mixing" ? a.qty : null}, ${a.proc === "mixing" ? null : a.qty}, ${a.sfgLot}, ${fc.user.id})`);
    await writeTeam(tx, tid, team, fc.user.id);
    return tid;
  });
}

/**
 * A mixing worker starting a batch himself, with nobody giving it. It is the
 * same task a supervisor would give — same recipe check, same table, same
 * posting through the ERP's SFG form — so nothing downstream can tell the two
 * apart except the history line. He is put in charge of it; the rest of the
 * mixing crew is the standing one, and he changes it on the job as usual.
 */
export async function startMixingBatch(fc: FactoryCtx, a: { item: string; qty: number }): Promise<Result<{ id: string }>> {
  if (!worksOn(fc, "mixing")) return err("Starting a batch is for the mixing team.", "not_permitted");
  const qty = Math.floor(Number(a.qty));
  if (!(qty > 0) || qty > MIX_BATCH_MAX) return err(`Enter how many batches, 1 to ${MIX_BATCH_MAX}.`, "validation");
  const [r] = await q(sql`
    select 1 from erp_recipes r join product_formulations f on f.id = r.formulation_id
     where r.formulation_id = ${a.item} and f.active and r.qty_per_batch > 0 limit 1`);
  if (!r) return err("This base has no approved batch sheet.", "validation");
  const team = meInCharge(fc, (await teamDefaults()).mixing);
  const id = await insertTask(fc, { proc: "mixing", item: a.item, qty, due: nowHM() > "18:00" ? nowHM() : "18:00", sfgLot: null }, team);
  await factoryAudit(fc, "factory.task.start", id, "Mixing batch started by " + fc.user.name);
  return ok({ id }, id + " started");
}

/**
 * A filling worker starting a filling himself, from the SFG lot he just
 * scanned. The same task Give a task makes — same table, same posting through
 * the ERP's fill form — with the scanned lot as its base tank and him in
 * charge. Everything the scan card checked is checked again here, against
 * the ledger rather than the phone's copy of it.
 */
export async function startFillFromLot(fc: FactoryCtx, a: { lot: string; item: string; qty: number }): Promise<Result<{ id: string }>> {
  if (!worksOn(fc, "filling")) return err("Filling is for the filling team. Tell your supervisor.", "not_permitted");
  const qty = Math.floor(Number(a.qty));
  if (!(qty > 0) || qty > FILL_FROM_LOT_MAX) return err(`Enter how many cans, 1 to ${FILL_FROM_LOT_MAX}.`, "validation");
  const all = await sfgLots();
  const lot = all.find((l) => l.lotCode === a.lot && l.godownId === fc.godown.id);
  if (!lot) {
    const elsewhere = all.find((l) => l.lotCode === a.lot);
    return err(elsewhere ? "This lot is at " + elsewhere.godown + ", not " + fc.godown.name + "." : "That lot is not here.", "validation");
  }
  if (!(lot.stock > 0)) return err(a.lot + " is empty. Scan another lot.", "rule_violation");
  const [qc] = await q<{ status: string }>(sql`select status from erp_sfg_qc where lot_code = ${a.lot}`);
  if (qc?.status !== "Approved") return err("The quality team has not approved this lot. Ask them, or scan another lot.", "rule_violation");
  const [fg] = await q<{ fid: string }>(sql`select formulation_id as fid from finished_goods where id = ${a.item.split(":")[0]} and active`);
  if (!fg) return err("Pick a product to fill.", "validation");
  if (fg.fid !== lot.formulationId) return err("That product is not made from this base.", "validation");

  const team = meInCharge(fc, (await teamDefaults()).filling);
  const id = await insertTask(fc, { proc: "filling", item: a.item, qty, due: nowHM() > "18:00" ? nowHM() : "18:00", sfgLot: a.lot }, team);
  await factoryAudit(fc, "factory.task.start", id, "Filling started by " + fc.user.name + " from " + a.lot);
  return ok({ id }, id + " started");
}

/** A department's standing crew with the person starting the job in charge — whoever was in charge becomes a helper. */
function meInCharge(fc: FactoryCtx, base: Team): Team {
  const me = fc.user.id;
  return {
    owner: me,
    op: base.op === me ? null : base.op,
    helpers: base.helpers.filter((h) => h !== me && h !== base.owner).concat(base.owner && base.owner !== me ? [base.owner] : []),
    ver: base.ver === me ? null : base.ver,
  };
}

/**
 * A packing worker starting a packing himself, from the FG lot (a pallet of
 * filled cans) he just scanned — the ERP's New packing batch, asked on the
 * phone. The same task Give a task makes, posted through the ERP's packing
 * form like any other, with him in charge. The lot is the job's first pallet
 * on the phone; the server holds it to nothing, because a packing draws from
 * every pallet the job scans.
 */
export async function startPackFromLot(fc: FactoryCtx, a: { lot: string; item: string; qty: number }): Promise<Result<{ id: string }>> {
  if (!worksOn(fc, "packing")) return err("Packing is for the packing team. Tell your supervisor.", "not_permitted");
  const qty = Math.floor(Number(a.qty));
  if (!(qty > 0) || qty > PACK_FROM_LOT_MAX) return err(`Enter how many boxes, 1 to ${PACK_FROM_LOT_MAX}.`, "validation");
  const all = await fgLots();
  const lot = all.find((l) => l.lotCode === a.lot && l.godownId === fc.godown.id);
  if (!lot) {
    const elsewhere = all.find((l) => l.lotCode === a.lot);
    return err(elsewhere ? "This lot is at " + elsewhere.godown + ", not " + fc.godown.name + "." : "That lot is not here.", "validation");
  }
  if (!(lot.stock > 0)) return err(a.lot + " is empty. Scan another lot.", "rule_violation");
  const [box] = await q<{ fg: string; ml: number; cpb: number; boxType: string | null; empty: number }>(sql`
    select p.finished_good_id as fg, p.millilitres_per_can::float8 as ml, p.cans_per_box as cpb, pk.box_type as "boxType",
           pk.empty_boxes_required::float8 as empty
      from products p join erp_product_packing pk on pk.product_id = p.id
     where p.id = ${a.item} and p.active and pk.empty_boxes_required > 0`);
  if (!box) return err("Pick a box to pack.", "validation");
  const [fill] = await q<{ size: number }>(sql`select can_size::float8 as size from erp_fg_fills where lot_code = ${a.lot} order by created_at limit 1`);
  if (box.fg !== lot.finishedGoodId || (fill && Math.abs(n(fill.size) * 1000 - n(box.ml)) > 1e-6)) return err("That box is not for this product.", "validation");
  const cpb = n(box.cpb);
  if (lot.stock < cpb) return err(a.lot + " has " + lot.stock + " cans; a box takes " + cpb + ". Scan another pallet.", "rule_violation");

  /* The empty boxes have to be there for every NEW batch this opens — the
     ERP's packing form refuses the first line of a batch otherwise. */
  const batch = Number((await getConfig())["erp.factory.packBatchBoxes"] ?? 50);
  const open = (await openPackBatches(fc.godown.id)).find((b) => b.skuId === a.item);
  const plan = packBatchPlan(qty, batch, open ? { have: Math.floor(open.cans / Math.max(1, open.cpb)), of: open.boxes } : null, n(box.empty) || 1);
  const short = emptyBoxShort(plan.emptyNeed, (await emptyBoxesAt(fc.godown.id))[a.item] ?? null, plan.newBatches, batch, box.boxType ?? "boxes", fc.godown.name);
  if (short) return err(short, "rule_violation");

  const team = meInCharge(fc, (await teamDefaults()).packing);
  const id = await insertTask(fc, { proc: "packing", item: a.item, qty, due: nowHM() > "18:00" ? nowHM() : "18:00", sfgLot: null }, team);
  await factoryAudit(fc, "factory.task.start", id, "Packing started by " + fc.user.name + " from " + a.lot);
  return ok({ id }, id + " started");
}

/* ------------------------------------------------------------ the team */

export async function changeTeam(fc: FactoryCtx, taskId: string, role: keyof Team, sel: string[]): Promise<Result> {
  if (!fc.head) return err(NOT_HEAD, "not_permitted");
  const t = await taskAt(fc, taskId);
  if (!t) return err("That job is not here.", "not_found");
  if (outOfScope(fc, t.proc)) return err(notYours(fc), "not_permitted");
  if (t.status === "done") return err("This job is saved in ERP. Ask for a correction instead.", "rule_violation");
  if ((role === "owner" || role === "op") && sel.length !== 1) return err("Choose one person.", "validation");
  const ok2 = sel.length ? await q<{ id: string }>(sql`select id from users where active and id in (${sql.join(sel.map((s) => sql`${s}`), sql`, `)})`) : [];
  if (ok2.length !== sel.length) return err("Somebody chosen cannot be found.", "validation");
  const dbRole = { owner: "owner", op: "operator", helpers: "helper", ver: "verifier" }[role];
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from factory_task_members where task_id = ${taskId} and role = ${dbRole}`);
    for (const u of sel)
      await tx.execute(sql`insert into factory_task_members (task_id, user_id, role, assigned_by_id) values (${taskId}, ${u}, ${dbRole}, ${fc.user.id}) on conflict do nothing`);
  });
  const word = { owner: "in charge", op: "operator", helpers: "helpers", ver: "checked by" }[role];
  await factoryAudit(fc, "factory.team.change", taskId, "Changed team before completion · " + word);
  return okVoid("Team changed · sent to their phones");
}

/* ------------------------------------------------------------ raising things */

export async function reportProblem(fc: FactoryCtx, taskId: string, reason: string, label: string): Promise<Result> {
  const t = await taskAt(fc, taskId);
  if (!t) return err("That job is not here.", "not_found");
  if (!reason.trim()) return err("Choose what is wrong.", "validation");
  await db.execute(sql`
    insert into factory_reviews (id, kind, task_id, title, body, meta, created_by_id)
    values (${erpId("frv")}, 'issue', ${taskId}, 'Problem reported before starting', ${reason + " · " + label}, ${"Today " + nowHM() + " · " + fc.user.name}, ${fc.user.id})`);
  await factoryAudit(fc, "factory.issue", taskId, "Reported a problem · " + reason);
  return okVoid("Sent to the Production Head");
}

/**
 * Asking for a saved job to be corrected. Nothing changes until somebody
 * approves it: the saved record stands, and the request sits beside it in
 * the review queue. A rejected-can count carries the number asked for, so
 * approving it can apply it through the ERP's own adjustment.
 */
export async function requestCorrection(fc: FactoryCtx, taskId: string, reason: string, label: string, rej?: number | null): Promise<Result> {
  if (!fc.head) return err(NOT_HEAD, "not_permitted");
  const t = await taskAt(fc, taskId);
  if (!t) return err("That job is not here.", "not_found");
  if (outOfScope(fc, t.proc)) return err(notYours(fc), "not_permitted");
  if (t.status !== "done") return err("This job is not saved yet — change it on the job instead.", "rule_violation");
  let change: Record<string, unknown> | null = null;
  let body = reason + " · " + label;
  if (rej != null && t.proc === "filling" && t.out) {
    const before = n(t.out.rej);
    const filled = n(t.out.good) + before;
    if (rej < 0 || rej > filled) return err("Rejected cannot be more than filled.", "validation");
    change = { kind: "fgAdjust", lot: t.out.lot, rej, before };
    body = `Rejected cans: ${before} → ${rej}. ` + label;
  }
  await db.execute(sql`
    insert into factory_reviews (id, kind, task_id, title, body, meta, change, created_by_id)
    values (${erpId("frv")}, 'correction', ${taskId}, 'Correction request', ${body}, ${"Today " + nowHM() + " · " + fc.user.name},
            ${change ? JSON.stringify(change) : null}::jsonb, ${fc.user.id})`);
  await factoryAudit(fc, "factory.correction.ask", taskId, "Asked for correction · " + reason);
  return okVoid("Correction sent for approval");
}

/* ------------------------------------------------------------ deciding */

/**
 * Closing a review item with a decision and a reason. `act` is the label of
 * the button pressed; index 0 is always the accepting one. The decision is
 * kept on the row and in the job's history — the item is closed, never
 * deleted.
 */
export async function decideReview(fc: FactoryCtx, id: string, act: string, actIndex: number, reason: string, helpers?: string[]): Promise<Result> {
  if (!fc.head) return err(NOT_HEAD, "not_permitted");
  if (!reason.trim()) return err("Choose a reason. It is saved in the history.", "validation");
  const [it] = await q<{ id: string; kind: string; taskId: string; title: string; change: Record<string, unknown> | null; status: string; createdById: string | null; proc: string }>(sql`
    select r.id, r.kind, r.task_id as "taskId", r.title, r.change, r.status, r.created_by_id as "createdById", t.proc
      from factory_reviews r join factory_tasks t on t.id = r.task_id
     where r.id = ${id} and t.godown_id = ${fc.godown.id}`);
  if (!it) return err("That item is not here any more.", "not_found");
  if (it.status !== "open") return err("Somebody already decided this.", "conflict");
  if (outOfScope(fc, it.proc)) return err(notYours(fc), "not_permitted");
  const approve = actIndex === 0;

  if (it.kind === "correction" && approve && it.change?.kind === "fgAdjust") {
    /* The person who asked does not approve their own change — the same rule
       the ERP's dispatch overrides keep. */
    if (it.createdById === fc.user.id) return err("Somebody else has to approve a correction you asked for.", "not_permitted");
    const [fill] = await q<{ id: string }>(sql`select id from erp_fg_fills where lot_code = ${String(it.change.lot)} limit 1`);
    if (!fill) return err("The filling for this lot cannot be found in the ERP.", "not_found");
    const res = await screenModule("fgFill")!.actions!.adjust(erpCtxFor(fc), fill.id, { adjusted: String(it.change.rej) });
    if (!res.ok) return err(res.error, "rule_violation");
    const rej = n(it.change.rej), before = n(it.change.before);
    await db.execute(sql`
      update factory_tasks set out = jsonb_set(jsonb_set(out, '{rej}', ${String(rej)}::jsonb), '{good}', to_jsonb((out->>'good')::int + ${before - rej}))
       where id = ${it.taskId}`);
  }
  if (it.kind === "unposted") {
    const key = String(it.change?.key ?? "");
    const [row] = await q<{ userId: string; payload: unknown; savedAt: string | null; v: number; build: string | null }>(sql`
      select user_id as "userId", payload, saved_at as "savedAt", schema_version as v, app_build as build
        from factory_submissions where key = ${key}`);
    if (!row) return err("The work sent from the phone cannot be found.", "not_found");
    if (approve) {
      /* Posted as the WORKER who did it — their name is the author of the ERP
         document, and the head's decision is the line in the history. */
      const [worker] = await db.select().from(users).where(eq(users.id, row.userId));
      const wfc = (worker && (await contextFor(worker))) || fc;
      const r = await submitJob(wfc, { key, taskId: it.taskId, d: row.payload as never, savedAt: row.savedAt ?? "", v: row.v, build: row.build ?? undefined }, { repost: true });
      if (r.kind !== "done") return err(r.kind === "failed" ? r.title + ". " + r.fix : "The ERP did not take it yet. Try again in a minute.", "rule_violation");
    } else {
      /* Not posting it: the job goes back to the list, to be done again or reassigned. */
      await db.execute(sql`update factory_submissions set status = 'failed' where key = ${key} and status = 'held'`);
    }
  }
  if (it.kind === "attribution" && approve && helpers?.length) {
    await db.transaction(async (tx) => {
      for (const u of helpers)
        await tx.execute(sql`insert into factory_task_members (task_id, user_id, role, assigned_by_id) values (${it.taskId}, ${u}, 'helper', ${fc.user.id}) on conflict do nothing`);
    });
  }
  await db.execute(sql`
    update factory_reviews set status = 'closed', decision = ${it.kind === "correction" ? (approve ? "approved" : "declined") : act}, reason = ${reason},
           decided_by_id = ${fc.user.id}, decided_at = now()
     where id = ${id}`);
  await factoryAudit(fc, "factory.review.decide", it.taskId, act + " — " + it.title + " · reason: " + reason);
  return okVoid(act + " · saved in history");
}
