import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireBlueprints, hireCandidates, hireStageExecutions } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { REJECTION_LABEL, stageByKey } from "../blueprint-types";
import { findDuplicates, normalisePhone } from "../engines/identity";
import { slaBreached } from "../engines/gating";
import { scopeWhere, seesScores, type HireContext } from "../access";
import { audit, ensureExecution, hid, hoursSince, loadBlueprint } from "./core";

/* ---------------------------------------------------------------------------
 * The pipeline as a list: one row per application with everything the board,
 * the table, the tasks list and the nav counts read — stage, latest score,
 * time in stage, SLA, what is waiting — in ONE query, so a column header's
 * count and the cards under it can never disagree.
 * ------------------------------------------------------------------------- */

export type BoardRow = {
  id: string;
  candidateId: string;
  code: string;
  name: string;
  phone: string;
  location: string | null;
  gender: string | null;
  ageBand: string | null;
  source: string | null;
  blueprintId: string;
  blueprintKey: string;
  blueprintTitle: string;
  version: number;
  family: string;
  stageKey: string;
  stageIndex: number;
  stageName: string;
  stageType: string;
  stageCount: number;
  status: string;
  holdReason: string | null;
  appliedAt: string;
  hoursInStage: number;
  totalHours: number;
  slaHours: number;
  slaBreach: boolean;
  /** The latest confirmed stage score — hidden (null) for an interviewer. */
  latestScore: number | null;
  latestStageName: string | null;
  latestAi: boolean;
  /** Average of confirmed stage scores. */
  overall: number | null;
  /** AI scores waiting for a person. */
  toReview: number;
  currentOutcome: string;
  recruiterId: string | null;
  recruiterName: string | null;
  interviewerId: string | null;
  interviewerName: string | null;
  hiringManagerId: string | null;
  duplicateOpen: boolean;
  proposalOpen: boolean;
  overridden: boolean;
  flags: number;
  scheduledAt: string | null;
};

type Raw = Record<string, unknown>;

export async function boardRows(ctx: HireContext, opts: { blueprintKey?: string; includeClosed?: boolean } = {}): Promise<BoardRow[]> {
  const rows = (await db.execute(sql`
    select a.id, a.candidate_id, c.code, c.full_name, c.primary_phone, a.location, c.gender, c.age_band, c.source,
           a.blueprint_id, b.key as bp_key, b.title as bp_title, b.version, b.family, b.definition,
           a.stage_key, a.status, a.hold_reason, a.applied_at, a.stage_entered_at,
           a.recruiter_id, ru.name as recruiter_name, a.interviewer_id, iu.name as interviewer_name, a.hiring_manager_id,
           (a.duplicate->>'status') = 'open' as dup_open, a.override is not null as overridden,
           exists (select 1 from hire_rejection_proposals p where p.application_id = a.id and p.status = 'open') as proposal_open,
           (select json_agg(json_build_object('k', x.stage_key, 's', x.final_score, 'o', x.outcome, 'at', x.completed_at,
                    'ai', exists (select 1 from hire_answers w where w.execution_id = x.id and w.scored_by = 'ai' and w.superseded_by_id is null))
                    order by x.completed_at)
              from hire_stage_executions x where x.application_id = a.id and x.superseded_by_id is null and x.final_score is not null) as scores,
           (select count(*)::int from hire_answers w join hire_stage_executions x on x.id = w.execution_id
              where x.application_id = a.id and x.superseded_by_id is null and w.superseded_by_id is null
                and w.ai_score is not null and w.confirmed_at is null) as to_review,
           (select x.outcome from hire_stage_executions x where x.application_id = a.id and x.stage_key = a.stage_key and x.superseded_by_id is null order by x.created_at desc limit 1) as cur_outcome,
           (select min(x.scheduled_at) from hire_stage_executions x where x.application_id = a.id and x.stage_key = a.stage_key and x.superseded_by_id is null and x.status = 'scheduled') as scheduled_at,
           coalesce((select case when jsonb_typeof(o.content->'inconsistencies') = 'array' then jsonb_array_length(o.content->'inconsistencies') end from hire_ai_outputs o where o.application_id = a.id and o.kind = 'consistency' order by o.created_at desc limit 1), 0) as flags
    from hire_applications a
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    left join users ru on ru.id = a.recruiter_id
    left join users iu on iu.id = a.interviewer_id
    where ${scopeWhere(ctx)}
      ${opts.blueprintKey ? sql`and b.key = ${opts.blueprintKey}` : sql``}
      ${opts.includeClosed === false ? sql`and a.status in ('in_progress','on_hold')` : sql``}
    order by a.stage_entered_at
  `)) as unknown as Raw[];

  const now = Date.now();
  const scores = seesScores(ctx);
  return rows.map((r) => {
    const def = r.definition as import("../blueprint-types").BlueprintDefinition;
    const stageKey = String(r.stage_key);
    const idx = def.stages.findIndex((s) => s.key === stageKey);
    const stage = def.stages[idx];
    const hired = r.status === "hired";
    const hrs = hoursSince(r.stage_entered_at as string, now);
    const sc = ((r.scores as { k: string; s: number; o: string; ai: boolean }[] | null) ?? []).filter((x) => x.s != null);
    const last = sc[sc.length - 1];
    return {
      id: String(r.id),
      candidateId: String(r.candidate_id),
      code: String(r.code),
      name: String(r.full_name),
      phone: String(r.primary_phone),
      location: (r.location as string) ?? null,
      gender: (r.gender as string) ?? null,
      ageBand: (r.age_band as string) ?? null,
      source: (r.source as string) ?? null,
      blueprintId: String(r.blueprint_id),
      blueprintKey: String(r.bp_key),
      blueprintTitle: String(r.bp_title),
      version: Number(r.version),
      family: String(r.family),
      stageKey,
      stageIndex: hired ? def.stages.length : idx,
      stageName: hired ? "Hired" : (stage?.name ?? stageKey),
      stageType: hired ? "terminal" : (stage?.type ?? "unknown"),
      stageCount: def.stages.length,
      status: String(r.status),
      holdReason: (r.hold_reason as string) ?? null,
      appliedAt: new Date(r.applied_at as string).toISOString(),
      hoursInStage: Math.round(hrs),
      totalHours: Math.round(hoursSince(r.applied_at as string, now)),
      slaHours: stage?.slaHours ?? 0,
      slaBreach: r.status === "in_progress" && slaBreached(stage, hrs),
      latestScore: scores && last ? Math.round(last.s) : null,
      latestStageName: scores && last ? (stageByKey(def, last.k)?.name ?? last.k) : null,
      latestAi: Boolean(scores && last?.ai),
      overall: scores && sc.length ? Math.round(sc.reduce((n, x) => n + x.s, 0) / sc.length) : null,
      toReview: Number(r.to_review ?? 0),
      currentOutcome: String(r.cur_outcome ?? "pending"),
      recruiterId: (r.recruiter_id as string) ?? null,
      recruiterName: (r.recruiter_name as string) ?? null,
      interviewerId: (r.interviewer_id as string) ?? null,
      interviewerName: (r.interviewer_name as string) ?? null,
      hiringManagerId: (r.hiring_manager_id as string) ?? null,
      duplicateOpen: Boolean(r.dup_open),
      proposalOpen: Boolean(r.proposal_open),
      overridden: Boolean(r.overridden),
      flags: Number(r.flags ?? 0),
      scheduledAt: r.scheduled_at ? new Date(r.scheduled_at as string).toISOString() : null,
    };
  });
}

/* ------------------------------------------------------------ new candidate */

export type NewCandidateInput = {
  fullName: string;
  phone: string;
  email?: string;
  location?: string;
  gender?: string;
  ageBand?: string;
  source?: string;
  sourceDetail?: string;
  referredBy?: string;
  preferredLanguage?: string;
  blueprintId: string;
  recruiterId?: string | null;
  hiringManagerId?: string | null;
  consent: boolean;
  enteredVia?: string;
};

/**
 * A new application. Identity is the phone number — a returning number
 * reuses the candidate and links the earlier application (D10/D14); a near
 * name in the same place is raised as a POSSIBLE duplicate for a person to
 * decide. Nothing merges on its own.
 */
export async function createApplication(ctx: HireContext | null, input: NewCandidateInput): Promise<Result<{ applicationId: string; candidateId: string; duplicate: boolean }>> {
  const phone = normalisePhone(input.phone);
  if (!phone) return { ok: false, error: "That is not a phone number we can reach.", code: "validation", fieldErrors: [{ field: "phone", message: "Enter a 10-digit mobile number" }] };
  if (input.fullName.trim().length < 2) return { ok: false, error: "A name is required.", code: "validation", fieldErrors: [{ field: "fullName", message: "Required" }] };
  if (!input.consent) return { ok: false, error: "The candidate’s consent — and the notice that AI assists evaluation — must be recorded.", code: "validation", fieldErrors: [{ field: "consent", message: "Required" }] };
  const bp = await loadBlueprint(input.blueprintId);
  if (!bp || bp.status !== "published") return err("Candidates enter only against a published blueprint version.", "validation");
  const first = bp.definition.stages[0];

  const [existing] = await db.select().from(hireCandidates).where(eq(hireCandidates.primaryPhone, phone)).limit(1);
  const now = new Date();
  let candidateId = existing?.id;
  let duplicate: NonNullable<typeof hireApplications.$inferInsert.duplicate> | null = null;
  let reapplicationOf: string | null = null;

  if (existing) {
    const [prior] = (await db.execute(sql`
      select a.id, a.status, a.rejection_reason_code, a.rejection_stage_key, a.closed_at, a.updated_at, b.definition, b.title
      from hire_applications a join hire_blueprints b on b.id = a.blueprint_id
      where a.candidate_id = ${existing.id} order by a.applied_at desc limit 1`)) as unknown as Raw[];
    if (prior) {
      if (prior.status === "in_progress" || prior.status === "on_hold") return err(`${existing.fullName} (${existing.code}) already has an open application for ${prior.title}.`, "duplicate");
      reapplicationOf = String(prior.id);
      const def = prior.definition as import("../blueprint-types").BlueprintDefinition;
      const cool = def.coolingOff.find((c) => c.reasonCode === prior.rejection_reason_code);
      const closed = new Date((prior.closed_at ?? prior.updated_at) as string);
      const ends = cool ? new Date(closed.getTime() + cool.days * 86_400_000) : null;
      duplicate = {
        candidateId: existing.id,
        applicationId: String(prior.id),
        confidence: "High",
        why: existing.fullName.trim().toLowerCase() === input.fullName.trim().toLowerCase() ? "Same phone number and the same name." : `Same phone number; the earlier record is “${existing.fullName}”.`,
        outcome: `${String(prior.status).replace("_", " ")}${prior.rejection_reason_code ? ` · ${REJECTION_LABEL[String(prior.rejection_reason_code)] ?? prior.rejection_reason_code}` : ""}`,
        coolingEnds: ends && ends > now ? ends.toISOString() : undefined,
        status: "open",
      };
    }
  } else {
    const pool = (await db.execute(sql`select id, full_name, primary_phone, alternate_phone, email, location from hire_candidates where location is not distinct from ${input.location ?? null} or email = ${input.email ?? ""}`)) as unknown as Raw[];
    const m = findDuplicates(
      { name: input.fullName, phones: [phone], email: input.email || null, location: input.location || null },
      pool.map((p) => ({ id: String(p.id), name: String(p.full_name), phones: [String(p.primary_phone), String(p.alternate_phone ?? "")], email: (p.email as string) ?? null, location: (p.location as string) ?? null })),
    )[0];
    if (m) duplicate = { candidateId: m.id, confidence: m.confidence, why: m.why, status: "open" };
  }

  const applicationId = hid("hap");
  await db.transaction(async (tx) => {
    if (!candidateId) {
      const [{ n }] = (await tx.execute(sql`select nextval('hire_candidate_code_seq')::int as n`)) as unknown as { n: number }[];
      candidateId = hid("hca");
      await tx.insert(hireCandidates).values({
        id: candidateId,
        code: `C-${n}`,
        primaryPhone: phone,
        email: input.email?.trim() || null,
        fullName: input.fullName.trim(),
        gender: input.gender || null,
        ageBand: input.ageBand || null,
        location: input.location || null,
        preferredLanguage: input.preferredLanguage || "English",
        source: input.source || null,
        sourceDetail: input.sourceDetail || null,
        referredBy: input.referredBy || null,
        consentAt: now,
        aiDisclosedAt: now,
        createdById: ctx?.user.id ?? null,
      });
    } else if (existing && existing.fullName.trim() !== input.fullName.trim()) {
      await tx
        .update(hireCandidates)
        .set({ nameVariants: [...new Set([...(existing.nameVariants ?? []), input.fullName.trim()])], updatedAt: now })
        .where(eq(hireCandidates.id, existing.id));
    }
    await tx.insert(hireApplications).values({
      id: applicationId,
      candidateId: candidateId!,
      blueprintId: bp.id,
      location: input.location || null,
      stageKey: first.key,
      recruiterId: input.recruiterId ?? (ctx?.role === "recruiter" ? ctx.user.id : null),
      hiringManagerId: input.hiringManagerId ?? null,
      enteredVia: input.enteredVia ?? "hr",
      reapplicationOfId: reapplicationOf,
      duplicate: duplicate ?? undefined,
      createdById: ctx?.user.id ?? null,
    });
    await ensureExecution(applicationId, first, ctx?.user.id ?? null, tx);
    await audit(
      ctx,
      {
        applicationId,
        candidateId,
        entityType: "application",
        entityId: applicationId,
        eventType: "created",
        summary: `Application created for ${bp.title} v${bp.version} · consent and AI notice recorded · duplicate check: ${duplicate ? `possible match (${duplicate.confidence}) — ${duplicate.why}` : "no match"}`,
      },
      tx,
    );
  });
  return ok({ applicationId, candidateId: candidateId!, duplicate: Boolean(duplicate) }, duplicate ? "Created — a possible duplicate is waiting for a decision." : "Candidate added.");
}

/** Resolve a possible duplicate. "Same person" links them; it never merges records. */
export async function resolveDuplicate(ctx: HireContext, applicationId: string, same: boolean, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return { ok: false, error: "Say briefly why.", code: "validation", fieldErrors: [{ field: "reason", message: "At least 10 characters" }] };
  const [a] = await db.select().from(hireApplications).where(eq(hireApplications.id, applicationId)).limit(1);
  if (!a?.duplicate) return err("There is no duplicate question on this application.", "not_found");
  const cooling = a.duplicate.coolingEnds && new Date(a.duplicate.coolingEnds) > new Date();
  if (same && cooling && !ctx.can("override"))
    return err("This is a reapplication inside the cooling-off period — continuing needs a Hiring Manager, HR Head or Admin, with a reason.", "not_permitted");
  await db
    .update(hireApplications)
    .set({ duplicate: { ...a.duplicate, status: same ? "same" : "different" }, reapplicationOfId: same ? (a.duplicate.applicationId ?? a.reapplicationOfId) : a.reapplicationOfId, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(eq(hireApplications.id, applicationId));
  await audit(ctx, {
    applicationId,
    candidateId: a.candidateId,
    entityType: "application",
    entityId: applicationId,
    eventType: "duplicate_resolved",
    summary: `${same ? "Confirmed the same person — linked to the earlier application" : "Confirmed a different person"}${same && cooling ? " · inside the cooling-off period" : ""} · “${reason.trim()}”`,
  });
  return ok(undefined, same ? "Linked to the earlier application. Their history is visible throughout." : "Marked as a different person.");
}

/** "Screen in" an application: the Application stage is passed by a person. */
export async function screenIn(ctx: HireContext, applicationId: string): Promise<Result> {
  const [a] = await db.select().from(hireApplications).where(eq(hireApplications.id, applicationId)).limit(1);
  if (!a) return err("Not found.", "not_found");
  if (a.duplicate?.status === "open") return err("Decide the possible duplicate first.", "rule_violation");
  const bp = await loadBlueprint(a.blueprintId);
  const stage = bp ? stageByKey(bp.definition, a.stageKey) : null;
  if (!stage || stage.type !== "application") return err("This candidate is past the application stage.", "rule_violation");
  const ex = await ensureExecution(applicationId, stage, ctx.user.id);
  await db.update(hireStageExecutions).set({ status: "completed", outcome: "pass", completedAt: new Date(), conductedById: ctx.user.id }).where(eq(hireStageExecutions.id, ex.id));
  await audit(ctx, { applicationId, candidateId: a.candidateId, entityType: "stage", entityId: ex.id, eventType: "screened_in", summary: "Application reviewed and screened in" });
  return ok(undefined, "Screened in.");
}

/** Assign people to an application. */
export async function assignPeople(ctx: HireContext, applicationId: string, patch: { recruiterId?: string | null; interviewerId?: string | null; hiringManagerId?: string | null }): Promise<Result> {
  await db.update(hireApplications).set({ ...patch, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hireApplications.id, applicationId));
  await audit(ctx, { applicationId, entityType: "application", entityId: applicationId, eventType: "assigned", summary: `Assigned ${Object.keys(patch).join(", ")}`, after: patch });
  return ok(undefined, "Saved.");
}

/** Published blueprints a candidate can enter against. */
export async function publishedBlueprints() {
  return db
    .select({ id: hireBlueprints.id, key: hireBlueprints.key, title: hireBlueprints.title, version: hireBlueprints.version, locations: hireBlueprints.locations, family: hireBlueprints.family })
    .from(hireBlueprints)
    .where(and(eq(hireBlueprints.status, "published"), ne(hireBlueprints.key, "")))
    .orderBy(hireBlueprints.title);
}
