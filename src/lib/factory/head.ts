import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { erpId } from "@/lib/erp/server";
import { screenModule } from "@/lib/erp/screens";
import { calendarDate } from "@/lib/business-date";
import { sfgLots } from "@/lib/erp/stock";
import { err, okVoid, ok, type Result } from "@/lib/result";
import type { Proc, Team } from "./types";
import { PROCS } from "./types";
import { contextFor, erpCtxFor, factoryAudit, nextTaskId, nowHM, teamDefaults, writeTeam, type FactoryCtx } from "./server";
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
  if (!HHMM.test(a.due)) return err("Choose when it is due.", "validation");
  const qty = Math.floor(Number(a.qty));
  if (!(qty > 0) || (a.proc === "mixing" ? qty > 6 : qty > 5000)) return err("Enter how many, more than 0.", "validation");

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
  const id = await db.transaction(async (tx) => {
    const tid = await nextTaskId(tx);
    await tx.execute(sql`
      insert into factory_tasks (id, proc, godown_id, work_date, due, status, item, batches, target, sfg_lot, created_by_id)
      values (${tid}, ${a.proc}, ${fc.godown.id}, ${calendarDate(new Date())}::date, ${a.due}, 'ready', ${a.item},
              ${a.proc === "mixing" ? qty : null}, ${a.proc === "mixing" ? null : qty}, ${sfgLot}, ${fc.user.id})`);
    await writeTeam(tx, tid, teams[a.proc], fc.user.id);
    return tid;
  });
  const procWord = { mixing: "Mixing", filling: "Filling", packing: "Packing" }[a.proc as "mixing"];
  await factoryAudit(fc, "factory.task.assign", id, "Task given to " + procWord + " team");
  return ok({ id }, id + " sent");
}

/* ------------------------------------------------------------ the team */

export async function changeTeam(fc: FactoryCtx, taskId: string, role: keyof Team, sel: string[]): Promise<Result> {
  if (!fc.head) return err(NOT_HEAD, "not_permitted");
  const t = await taskAt(fc, taskId);
  if (!t) return err("That job is not here.", "not_found");
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
  const [it] = await q<{ id: string; kind: string; taskId: string; title: string; change: Record<string, unknown> | null; status: string; createdById: string | null }>(sql`
    select r.id, r.kind, r.task_id as "taskId", r.title, r.change, r.status, r.created_by_id as "createdById"
      from factory_reviews r join factory_tasks t on t.id = r.task_id
     where r.id = ${id} and t.godown_id = ${fc.godown.id}`);
  if (!it) return err("That item is not here any more.", "not_found");
  if (it.status !== "open") return err("Somebody already decided this.", "conflict");
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
