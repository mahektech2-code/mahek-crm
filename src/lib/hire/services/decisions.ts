import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireAiOutputs, hireApplications, hireDecisions, hireRejectionProposals, hireStageExecutions } from "@/db/schema";
import { notifyUsers } from "@/lib/notify";
import { REJECTION_LABEL, stageByKey, type BlueprintDefinition } from "../blueprint-types";
import { scopeWhere, seesScores, type HireContext } from "../access";
import { GATE_POINT } from "../roles";
import { hireTrail, ensureExecution, getApplication, hid, hoursSince, stageOutcome, type AppBundle } from "./core";
import { caseFile, type CaseFile } from "./evidence";
import type { GateRec } from "../ai/gate-recommendation";

/* ---------------------------------------------------------------------------
 * Decisions: who is waiting at a gate, which rejections are proposed and
 * waiting for a name, and the one path by which an application is rejected.
 *
 * NO CANDIDATE IS REJECTED BY THE SYSTEM ALONE (PRD P1, spec §6.2). A floor
 * proposes; a person with the capability confirms, with reasoning, and the
 * reasoning is kept. That is enforced here, not only by the screens.
 * ------------------------------------------------------------------------- */

type Raw = Record<string, unknown>;

export type GateRow = {
  id: string;
  name: string;
  code: string;
  roleTitle: string;
  version: number;
  location: string | null;
  hoursWaiting: number;
  slaHours: number;
  scores: { name: string; final: number }[];
  overall: number | null;
  rec: { action: string; confidence: string; why: string } | null;
  flags: number;
};

export type ProposalRow = {
  id: string;
  applicationId: string;
  name: string;
  code: string;
  roleTitle: string;
  stageName: string;
  score: number | null;
  pass: number | null;
  reasonCode: string;
  reasonLabel: string;
  proposedBy: string;
  proposedAt: string;
  windowEndsAt: string;
  overdue: boolean;
  note: string | null;
};

export async function decisionQueues(ctx: HireContext): Promise<{ gates: GateRow[]; proposals: ProposalRow[] }> {
  const scores = seesScores(ctx);
  const gates = (await db.execute(sql`
    select a.id, c.full_name, c.code, b.title, b.version, a.location, a.stage_entered_at, a.stage_key, a.ai_recommendation, b.definition,
           (select json_agg(json_build_object('k', x.stage_key, 's', x.final_score) order by x.completed_at)
              from hire_stage_executions x where x.application_id = a.id and x.superseded_by_id is null and x.final_score is not null) as scores,
           coalesce((select case when jsonb_typeof(o.content->'inconsistencies') = 'array' then jsonb_array_length(o.content->'inconsistencies') end
              from hire_ai_outputs o where o.application_id = a.id and o.kind = 'consistency' order by o.created_at desc limit 1), 0) as flags
    from hire_applications a
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and a.status = 'in_progress'
      and exists (select 1 from jsonb_array_elements(b.definition->'stages') s where s->>'key' = a.stage_key and s->>'type' = 'decision_gate')
    order by a.stage_entered_at
  `)) as unknown as Raw[];

  const props = (await db.execute(sql`
    select p.id, p.application_id, c.full_name, c.code, b.title, b.definition, p.stage_key, p.score, p.reason_code, p.note,
           p.proposed_at, p.window_ends_at, coalesce(u.name, 'The stage floor') as proposed_by
    from hire_rejection_proposals p
    join hire_applications a on a.id = p.application_id
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    left join users u on u.id = p.proposed_by_id
    where ${scopeWhere(ctx)} and p.status = 'open'
    order by p.window_ends_at
  `)) as unknown as Raw[];

  const now = Date.now();
  return {
    gates: gates.map((r) => {
      const def = r.definition as BlueprintDefinition;
      const st = stageByKey(def, String(r.stage_key));
      const sc = ((r.scores as { k: string; s: number }[] | null) ?? []).filter((x) => x.s != null);
      return {
        id: String(r.id),
        name: String(r.full_name),
        code: String(r.code),
        roleTitle: String(r.title),
        version: Number(r.version),
        location: (r.location as string) ?? null,
        hoursWaiting: Math.round(hoursSince(r.stage_entered_at as string, now)),
        slaHours: st?.slaHours ?? 24,
        scores: scores ? sc.map((x) => ({ name: stageByKey(def, x.k)?.name ?? x.k, final: Math.round(x.s) })) : [],
        overall: scores && sc.length ? Math.round(sc.reduce((n, x) => n + x.s, 0) / sc.length) : null,
        rec: scores ? ((r.ai_recommendation as GateRow["rec"]) ?? null) : null,
        flags: Number(r.flags ?? 0),
      };
    }),
    proposals: props.map((r) => {
      const def = r.definition as BlueprintDefinition;
      const st = stageByKey(def, String(r.stage_key));
      const ends = new Date(r.window_ends_at as string);
      return {
        id: String(r.id),
        applicationId: String(r.application_id),
        name: String(r.full_name),
        code: String(r.code),
        roleTitle: String(r.title),
        stageName: st?.name ?? String(r.stage_key),
        score: scores && r.score != null ? Number(r.score) : null,
        pass: st?.passThreshold ?? null,
        reasonCode: String(r.reason_code),
        reasonLabel: REJECTION_LABEL[String(r.reason_code)] ?? String(r.reason_code),
        proposedBy: String(r.proposed_by),
        proposedAt: new Date(r.proposed_at as string).toISOString(),
        windowEndsAt: ends.toISOString(),
        overdue: ends.getTime() < now,
        note: (r.note as string) ?? null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ gate */

export type GateDecision = { decision: string; reasoning: string; by: string; role: string; at: string; agreed: boolean | null };

export type GateView = {
  bundle: AppBundle;
  cf: CaseFile;
  atGate: boolean;
  nextStageName: string | null;
  rec: (GateRec & { at: string | null }) | null;
  last: GateDecision | null;
};

export async function gateView(ctx: HireContext, applicationId: string): Promise<GateView | null> {
  const bundle = await getApplication(ctx, applicationId);
  if (!bundle) return null;
  const { def, app } = bundle;
  const i = def.stages.findIndex((s) => s.key === app.stageKey);
  const [cf, recRow, lastRow] = await Promise.all([
    caseFile(applicationId, def),
    db
      .select({ content: hireAiOutputs.content, createdAt: hireAiOutputs.createdAt })
      .from(hireAiOutputs)
      .where(and(eq(hireAiOutputs.applicationId, applicationId), eq(hireAiOutputs.kind, "gate_recommendation")))
      .orderBy(desc(hireAiOutputs.createdAt))
      .limit(1),
    db.execute(sql`
      select d.decision, d.reasoning, d.decided_by_role, d.decided_at, d.agreed_with_ai, u.name
      from hire_decisions d join users u on u.id = d.decided_by_id
      where d.application_id = ${applicationId} and d.decision_point = ${GATE_POINT} and d.superseded_by_id is null
      order by d.decided_at desc limit 1`) as unknown as Promise<Raw[]>,
  ]);
  const stored = recRow[0]?.content as GateRec | undefined;
  const cached = app.aiRecommendation;
  const rec: GateView["rec"] = stored
    ? { ...stored, at: recRow[0].createdAt.toISOString() }
    : cached
      ? { action: (cached.action.toLowerCase().startsWith("adv") ? "advance" : cached.action.toLowerCase().startsWith("rej") ? "reject" : "hold") as GateRec["action"], confidence: cached.confidence, why: cached.why, evidence: [], at: cached.at ?? null }
      : null;
  const l = lastRow[0];
  return {
    bundle,
    cf,
    atGate: bundle.stage?.type === "decision_gate" && app.status === "in_progress",
    nextStageName: def.stages[i + 1]?.name ?? null,
    rec,
    last: l
      ? { decision: String(l.decision), reasoning: String(l.reasoning), by: String(l.name), role: String(l.decided_by_role), at: new Date(l.decided_at as string).toISOString(), agreed: (l.agreed_with_ai as boolean | null) ?? null }
      : null,
  };
}

/** Store a fresh recommendation: the ledger already has the call; this is what the screen reads. */
export async function storeGateRecommendation(ctx: HireContext, applicationId: string, rec: GateRec, taskId: string): Promise<void> {
  await db.insert(hireAiOutputs).values({ id: hid("hao"), kind: "gate_recommendation", applicationId, content: rec, aiTaskId: taskId, createdById: ctx.user.id });
  await db
    .update(hireApplications)
    .set({ aiRecommendation: { action: rec.action === "advance" ? "Advance" : rec.action === "reject" ? "Reject" : "Hold", confidence: rec.confidence, why: rec.why, taskId, at: new Date().toISOString() } })
    .where(eq(hireApplications.id, applicationId));
}

/* -------------------------------------------------------------- rejecting */

/**
 * THE way an application is rejected. Called only from a person's act — a
 * confirmed proposal or a gate decision — and it writes the decision, the
 * status, the reason and closes every open proposal on the application.
 */
export async function rejectApplication(
  ctx: HireContext,
  b: AppBundle,
  r: { reasoning: string; reasonCode: string; stageKey: string; executionId?: string | null; aiRec?: GateRec | null; agreedWithAi?: boolean | null; decisionPoint: string; proposalId?: string | null },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(hireDecisions).values({
      id: hid("hde"),
      applicationId: b.app.id,
      executionId: r.executionId ?? null,
      decisionPoint: r.decisionPoint,
      decidedById: ctx.user.id,
      decidedByRole: ctx.roleLabel,
      decision: "reject",
      reasoning: r.reasoning.trim(),
      reasonCode: r.reasonCode,
      aiRecommendation: r.aiRec ? { action: r.aiRec.action, confidence: r.aiRec.confidence, why: r.aiRec.why } : null,
      agreedWithAi: r.agreedWithAi ?? null,
    });
    await tx
      .update(hireApplications)
      .set({ status: "rejected", rejectionReasonCode: r.reasonCode, rejectionStageKey: r.stageKey, decisionReason: r.reasoning.trim(), closedAt: now, updatedAt: now, updatedById: ctx.user.id })
      .where(eq(hireApplications.id, b.app.id));
    const open = await tx
      .select({ id: hireRejectionProposals.id })
      .from(hireRejectionProposals)
      .where(and(eq(hireRejectionProposals.applicationId, b.app.id), eq(hireRejectionProposals.status, "open")));
    if (open.length)
      await tx
        .update(hireRejectionProposals)
        .set({ status: "confirmed", resolvedById: ctx.user.id, resolvedAt: now, resolution: r.reasoning.trim() })
        .where(inArray(hireRejectionProposals.id, open.map((o) => o.id)));
    await hireTrail(
      ctx,
      {
        applicationId: b.app.id,
        candidateId: b.candidate.id,
        entityType: "application",
        entityId: b.app.id,
        event: "rejected",
        summary: `Rejected at ${stageByKey(b.def, r.stageKey)?.name ?? r.stageKey} · ${REJECTION_LABEL[r.reasonCode] ?? r.reasonCode}${r.proposalId ? " · proposal confirmed" : ""} · “${r.reasoning.trim()}”`,
        before: { status: b.app.status },
        after: { status: "rejected", reasonCode: r.reasonCode },
      },
      tx,
    );
  });
  if (b.app.recruiterId && b.app.recruiterId !== ctx.user.id)
    await notifyUsers([{ userId: b.app.recruiterId, title: `${b.candidate.fullName} — rejection confirmed`, body: `${ctx.user.name} confirmed the rejection: “${r.reasoning.trim()}”`, href: `/hire/c/${b.app.id}` }]).catch(() => undefined);
}

export async function latestGateDecision(applicationId: string) {
  const [d] = await db
    .select()
    .from(hireDecisions)
    .where(and(eq(hireDecisions.applicationId, applicationId), eq(hireDecisions.decisionPoint, GATE_POINT), isNull(hireDecisions.supersededById)))
    .orderBy(desc(hireDecisions.decidedAt))
    .limit(1);
  return d ?? null;
}

/* ---------------------------------------------------------------- compare */

export type CompareOption = { id: string; name: string; code: string; stageName: string; blueprintId: string; blueprintTitle: string; version: number; overall: number | null };

/** In-scope applications with confirmed scores, for the comparison picker. */
export async function compareOptions(ctx: HireContext): Promise<CompareOption[]> {
  const rows = (await db.execute(sql`
    select a.id, c.full_name, c.code, a.stage_key, a.blueprint_id, b.title, b.version, b.definition,
           (select avg(x.final_score) from hire_stage_executions x where x.application_id = a.id and x.superseded_by_id is null and x.final_score is not null) as overall
    from hire_applications a join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and a.status in ('in_progress','on_hold','hired')
      and exists (select 1 from hire_stage_executions x where x.application_id = a.id and x.superseded_by_id is null and x.final_score is not null)
    order by b.title, overall desc nulls last
  `)) as unknown as Raw[];
  return rows.map((r) => {
    const def = r.definition as BlueprintDefinition;
    return {
      id: String(r.id),
      name: String(r.full_name),
      code: String(r.code),
      stageName: stageByKey(def, String(r.stage_key))?.name ?? String(r.stage_key),
      blueprintId: String(r.blueprint_id),
      blueprintTitle: String(r.title),
      version: Number(r.version),
      overall: r.overall == null ? null : Math.round(Number(r.overall)),
    };
  });
}

export type CompareColumn = { id: string; name: string; code: string; meta: string; cf: CaseFile };

export async function compareColumns(ctx: HireContext, ids: string[]): Promise<{ columns: CompareColumn[]; def: BlueprintDefinition | null; blueprintId: string | null; roleTitle: string; mixed: boolean }> {
  const bundles = (await Promise.all(ids.slice(0, 4).map((id) => getApplication(ctx, id)))).filter((b): b is AppBundle => Boolean(b));
  if (!bundles.length) return { columns: [], def: null, blueprintId: null, roleTitle: "", mixed: false };
  const bpId = bundles[0].blueprint.id;
  const same = bundles.filter((b) => b.blueprint.id === bpId);
  const columns = await Promise.all(
    same.map(async (b) => ({
      id: b.app.id,
      name: b.candidate.fullName,
      code: b.candidate.code,
      meta: [b.app.location, b.stage?.name ?? (b.app.status === "hired" ? "Hired" : b.app.stageKey)].filter(Boolean).join(" · "),
      cf: await caseFile(b.app.id, b.def),
    })),
  );
  return { columns, def: bundles[0].def, blueprintId: bpId, roleTitle: `${bundles[0].blueprint.title} v${bundles[0].blueprint.version}`, mixed: same.length < bundles.length };
}

/**
 * Leave a decision gate on a recorded ADVANCE. `moveApplication` cannot do
 * this: the gating engine refuses every move out of a gate (it routes people
 * here instead), so the one act that may open it — a named person's decision,
 * already written — moves the candidate itself, after reading that decision
 * back through `stageOutcome` rather than trusting the caller.
 */
export async function advanceFromGate(ctx: HireContext, applicationId: string): Promise<{ ok: true; next: string } | { ok: false; error: string }> {
  const b = await getApplication(ctx, applicationId);
  if (!b || b.stage?.type !== "decision_gate" || b.app.status !== "in_progress") return { ok: false, error: "They are not waiting at a decision gate." };
  const oc = await stageOutcome(b.app, b.def);
  if (oc.outcome !== "pass") return { ok: false, error: oc.why ?? "There is no recorded decision to advance." };
  const i = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
  const next = b.def.stages[i + 1];
  if (!next) return { ok: false, error: "There is no stage after this gate." };
  const now = new Date();
  await db.transaction(async (tx) => {
    const ex = await ensureExecution(applicationId, b.stage!, ctx.user.id, tx);
    await tx.update(hireStageExecutions).set({ status: "completed", outcome: "pass", completedAt: now, conductedById: ctx.user.id }).where(eq(hireStageExecutions.id, ex.id));
    await tx.update(hireApplications).set({ stageKey: next.key, stageEnteredAt: now, updatedAt: now, updatedById: ctx.user.id }).where(eq(hireApplications.id, applicationId));
    await ensureExecution(applicationId, next, ctx.user.id, tx);
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "application", entityId: applicationId, event: "stage_move", summary: `Moved ${b.stage!.name} → ${next.name} · on the recorded gate decision`, before: { stageKey: b.app.stageKey }, after: { stageKey: next.key } }, tx);
  });
  return { ok: true, next: next.name };
}
