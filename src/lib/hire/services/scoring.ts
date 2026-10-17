import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireAnswers, hireStageExecutions, type HireAnswer, type HireEvidenceSpan, type HireStageExecution } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import type { Question, Stage } from "../blueprint-types";
import { isScored, stageByKey } from "../blueprint-types";
import { stageResult, type StageResult } from "../engines/scoring";
import { scopeWhere, type HireContext } from "../access";
import { aiState } from "../ai/orchestrator";
import { getApplication, type AppBundle } from "./core";

/* ---------------------------------------------------------------------------
 * The scoring review's reads (design §7.4).
 *
 * A stage's score is the sum of CONFIRMED answers only — an AI score nobody
 * has accepted counts for nothing, which is what "the score is never
 * committed until a human acts" means on the server. The current answer to a
 * question is the newest row nothing superseded.
 * ------------------------------------------------------------------------- */

export type ConfWord = "High" | "Moderate" | "Low";

export function confWord(c: number | null | undefined, min: number): ConfWord {
  if (c == null || c < min) return "Low";
  return c >= 0.8 ? "High" : "Moderate";
}

export type AnswerView = {
  id: string | null;
  questionKey: string;
  responseText: string | null;
  selected: string[];
  calcInputs: Record<string, number>;
  score: number | null;
  confirmed: boolean;
  scoredBy: string | null;
  humanAction: string | null;
  overrideReason: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  aiScore: number | null;
  aiReasoning: string | null;
  aiConfidence: number | null;
  aiConfidenceWord: ConfWord | null;
  aiFlags: string[];
  insufficient: boolean;
  probe: string | null;
  evidence: HireEvidenceSpan[];
};

export type ScoringView = {
  exec: { id: string; status: string; outcome: string; grace: number; graceReason: string | null; finalScore: number | null; normalised: number | null; completedAt: string | null; aiReviewPending: boolean; superseded: boolean; conductedByName: string | null };
  bundle: { applicationId: string; candidateCode: string; candidateName: string; maskName: boolean; roleTitle: string; version: number; masked: string[]; location: string | null; currentStageKey: string; appStatus: string };
  stage: Stage;
  nextStage: { key: string; name: string } | null;
  questions: Question[];
  answers: Record<string, AnswerView>;
  result: StageResult;
  ai: { on: boolean; reason: string | null };
  minConfidence: number;
  canScore: boolean;
  canGrace: boolean;
  openProposal: boolean;
};

/** The executions an interviewer may score: theirs, or on an application assigned to them. */
function interviewerMayScore(ctx: HireContext, exec: HireStageExecution, b: AppBundle): boolean {
  if (ctx.role !== "interviewer") return true;
  return exec.conductedById === ctx.user.id || b.app.interviewerId === ctx.user.id;
}

export async function currentAnswers(executionId: string): Promise<HireAnswer[]> {
  return db
    .select()
    .from(hireAnswers)
    .where(and(eq(hireAnswers.executionId, executionId), isNull(hireAnswers.supersededById)))
    .orderBy(asc(hireAnswers.createdAt));
}

export async function loadExecution(ctx: HireContext, execId: string): Promise<{ exec: HireStageExecution; b: AppBundle; stage: Stage } | null> {
  const [exec] = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.id, execId)).limit(1);
  if (!exec) return null;
  const b = await getApplication(ctx, exec.applicationId);
  if (!b) return null;
  const stage = stageByKey(b.def, exec.stageKey);
  if (!stage || !isScored(stage)) return null;
  if (!interviewerMayScore(ctx, exec, b)) return null;
  return { exec, b, stage };
}

export function confirmedPoints(stage: Stage, answers: HireAnswer[]): Record<string, number | null> {
  const by: Record<string, number | null> = {};
  for (const q of stage.questions) {
    const a = answers.filter((x) => x.questionKey === q.key).pop();
    by[q.key] = a && a.confirmedAt && a.score != null ? a.score : null;
  }
  return by;
}

export async function scoringView(ctx: HireContext, execId: string): Promise<ScoringView | null> {
  const loaded = await loadExecution(ctx, execId);
  if (!loaded) return null;
  const { exec, b, stage } = loaded;
  const [rows, cfg, ai, names, prop] = await Promise.all([
    currentAnswers(exec.id),
    getConfig(),
    aiState(),
    db.execute(sql`select id, name from users where id in (select confirmed_by_id from hire_answers where execution_id = ${exec.id}) or id = ${exec.conductedById ?? ""}`) as unknown as Promise<{ id: string; name: string }[]>,
    db.execute(sql`select 1 from hire_rejection_proposals p where p.application_id = ${b.app.id} and p.stage_key = ${stage.key} and p.status = 'open' limit 1`) as unknown as Promise<unknown[]>,
  ]);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const min = cfg["hire.ai.minConfidence"];
  const answers: Record<string, AnswerView> = {};
  for (const q of stage.questions) {
    const a = rows.filter((x) => x.questionKey === q.key).pop();
    const insufficient = Boolean(a && a.aiScore == null && (a.aiFlags ?? []).includes("insufficient_response"));
    answers[q.key] = {
      id: a?.id ?? null,
      questionKey: q.key,
      responseText: a?.responseText ?? null,
      selected: a?.selected ?? [],
      calcInputs: a?.calcInputs ?? {},
      score: a?.score ?? null,
      confirmed: Boolean(a?.confirmedAt && a.score != null),
      scoredBy: a?.scoredBy ?? null,
      humanAction: a?.humanAction ?? null,
      overrideReason: a?.overrideReason ?? null,
      confirmedByName: a?.confirmedById ? (nameOf.get(a.confirmedById) ?? null) : null,
      confirmedAt: a?.confirmedAt ? new Date(a.confirmedAt).toISOString() : null,
      aiScore: a?.aiScore ?? null,
      aiReasoning: a?.aiReasoning ?? null,
      aiConfidence: a?.aiConfidence ?? null,
      aiConfidenceWord: a?.aiScore != null || insufficient ? confWord(a?.aiConfidence, min) : null,
      aiFlags: a?.aiFlags ?? [],
      insufficient,
      probe: a?.probeSuggestion ?? null,
      evidence: a?.evidence ?? [],
    };
  }
  const result = stageResult(stage, confirmedPoints(stage, rows), exec.grace);
  const i = b.def.stages.findIndex((s) => s.key === stage.key);
  const next = b.def.stages[i + 1];
  return {
    exec: {
      id: exec.id,
      status: exec.status,
      outcome: exec.outcome,
      grace: exec.grace,
      graceReason: exec.graceReason,
      finalScore: exec.finalScore,
      normalised: exec.normalised,
      completedAt: exec.completedAt ? new Date(exec.completedAt).toISOString() : null,
      aiReviewPending: exec.aiReviewPending,
      superseded: Boolean(exec.supersededById),
      conductedByName: exec.conductedById ? (nameOf.get(exec.conductedById) ?? null) : null,
    },
    bundle: {
      applicationId: b.app.id,
      candidateCode: b.candidate.code,
      candidateName: b.candidate.fullName,
      maskName: b.def.fairness.masked.includes("name"),
      roleTitle: b.blueprint.title,
      version: b.blueprint.version,
      masked: b.def.fairness.masked,
      location: b.def.fairness.masked.includes("location") ? null : b.app.location,
      currentStageKey: b.app.stageKey,
      appStatus: b.app.status,
    },
    stage,
    nextStage: next ? { key: next.key, name: next.name } : null,
    questions: stage.questions,
    answers,
    result,
    ai: ai.on ? { on: true, reason: null } : { on: false, reason: ai.reason },
    minConfidence: min,
    canScore: ctx.can("score") && !exec.supersededById,
    canGrace: ctx.can("grace"),
    openProposal: prop.length > 0,
  };
}

/* ------------------------------------------------------------------ queue */

export type ReviewRow = {
  execId: string;
  applicationId: string;
  name: string;
  code: string;
  role: string;
  location: string | null;
  stageName: string;
  pending: number;
  total: number;
  oldest: string;
  hours: number;
};

/** AI scores waiting for a person, one row per stage execution, oldest first. */
export async function reviewQueue(ctx: HireContext): Promise<{ waiting: ReviewRow[]; manual: ReviewRow[] }> {
  const rows = (await db.execute(sql`
    select x.id as exec_id, a.id as app_id, c.full_name, c.code, b.title, a.location, x.stage_key, b.definition,
           count(*) filter (where w.ai_score is not null and w.confirmed_at is null)::int as pending,
           count(*)::int as total,
           min(w.created_at) filter (where w.ai_score is not null and w.confirmed_at is null) as oldest
    from hire_answers w
    join hire_stage_executions x on x.id = w.execution_id
    join hire_applications a on a.id = x.application_id
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and x.superseded_by_id is null and w.superseded_by_id is null
      ${ctx.role === "interviewer" ? sql`and (x.conducted_by_id = ${ctx.user.id} or a.interviewer_id = ${ctx.user.id})` : sql``}
    group by x.id, a.id, c.full_name, c.code, b.title, a.location, x.stage_key, b.definition
    having count(*) filter (where w.ai_score is not null and w.confirmed_at is null) > 0
    order by oldest asc`)) as unknown as Record<string, unknown>[];
  const manual = (await db.execute(sql`
    select x.id as exec_id, a.id as app_id, c.full_name, c.code, b.title, a.location, x.stage_key, b.definition, x.completed_at as oldest
    from hire_stage_executions x
    join hire_applications a on a.id = x.application_id
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and x.superseded_by_id is null and x.ai_review_pending
    order by x.completed_at asc limit 100`)) as unknown as Record<string, unknown>[];
  const now = Date.now();
  const map = (r: Record<string, unknown>): ReviewRow => {
    const def = r.definition as { stages: { key: string; name: string }[] };
    const oldest = r.oldest ? new Date(r.oldest as string) : new Date(now);
    return {
      execId: String(r.exec_id),
      applicationId: String(r.app_id),
      name: String(r.full_name),
      code: String(r.code),
      role: String(r.title),
      location: (r.location as string) ?? null,
      stageName: def.stages.find((s) => s.key === r.stage_key)?.name ?? String(r.stage_key),
      pending: Number(r.pending ?? 0),
      total: Number(r.total ?? 0),
      oldest: oldest.toISOString(),
      hours: Math.max(0, (now - oldest.getTime()) / 3_600_000),
    };
  };
  return { waiting: rows.map(map), manual: manual.map(map) };
}
