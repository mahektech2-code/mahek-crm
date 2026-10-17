import "server-only";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  hireAiOutputs,
  hireAnswers,
  hireApplications,
  hireAudit,
  hireBlueprints,
  hireDecisions,
  hireMessages,
  hireProfiles,
  hireSessions,
  hireStageExecutions,
  users,
  type HireEvidenceSpan,
  type HireProfileData,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { isScored, stageByKey, STAGE_TYPE_LABEL, type BlueprintDefinition } from "../blueprint-types";
import { competencyRollup } from "../engines/scoring";
import { seesScores, type HireContext } from "../access";
import { getApplication, stageOutcome, type AppBundle } from "./core";

/* ---------------------------------------------------------------------------
 * THE CANDIDATE RECORD, read once per page (design brief §7.2).
 *
 * Everything here is already narrowed: `getApplication` answers null for an
 * application outside this person's scope, and an interviewer — who must not
 * see an earlier stage's score, because it contaminates the interview — is
 * handed a record with every score but the one they are conducting removed
 * HERE, on the server, rather than hidden on a screen.
 * ------------------------------------------------------------------------- */

export type SummaryContent = {
  summary: string;
  recommendation?: { action: string; confidence: string; why: string };
  strengths?: { title: string; quote: string; source: string }[];
  concerns?: { title: string; quote: string; source: string }[];
};

export type ConsistencyContent = {
  skipped?: boolean;
  reason?: string;
  consistencies?: { claim: string; sources: string[]; strength: string }[];
  inconsistencies?: { nature: string; severity: string; a: { text: string; source: string }; b: { text: string; source: string }; probe: string }[];
  unverified?: string[];
  score?: number;
};

export type RecordAnswer = {
  id: string;
  questionKey: string;
  questionText: string;
  mode: string;
  competencyKeys: string[];
  responseText: string | null;
  score: number | null;
  maxPoints: number;
  scoredBy: string | null;
  aiScore: number | null;
  aiReasoning: string | null;
  aiConfidence: number | null;
  aiFlags: string[];
  evidence: HireEvidenceSpan[];
  probe: string | null;
  humanAction: string | null;
  overrideReason: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  superseded: boolean;
};

export type RecordExecution = {
  id: string;
  stageKey: string;
  stageName: string;
  stageType: string;
  status: string;
  outcome: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  conductedBy: string | null;
  earned: number | null;
  maxPoints: number | null;
  normalised: number | null;
  grace: number;
  graceReason: string | null;
  finalScore: number | null;
  passThreshold: number | null;
  gateOverrideReason: string | null;
  aiReviewPending: boolean;
  superseded: boolean;
  answers: RecordAnswer[];
  pendingReview: number;
};

export type JourneyStep = {
  key: string;
  name: string;
  type: string;
  state: "done" | "current" | "future" | "failed";
  score: number | null;
  outcome: string;
  who: string | null;
  when: string | null;
};

export type CandidateRecord = {
  bundle: AppBundle;
  canSeeScores: boolean;
  overall: number | null;
  currentOutcome: { outcome: string; why?: string };
  currentExecId: string | null;
  currentExecStatus: string | null;
  journey: JourneyStep[];
  executions: RecordExecution[];
  rollup: { scores: Record<string, number | null>; overall: number | null };
  evidenceByComp: Record<string, { text: string; source: string; criterion: string; tier: string }[]>;
  summary: { content: SummaryContent; at: string; aiTaskId: string | null } | null;
  consistency: { content: ConsistencyContent; at: string } | null;
  profile: { data: HireProfileData; corrections: { field: string; from: string; to: string; byName: string; at: string }[]; extractedAt: string | null; confidence: number | null; sourceFileId: string | null } | null;
  cvFiles: { id: string; filename: string; uploadedAt: string; sizeBytes: number }[];
  messages: { id: string; direction: string; channel: string; language: string; subject: string | null; body: string; aiDrafted: boolean; status: string; at: string; by: string | null }[];
  audit: { id: string; at: string; actor: string; role: string | null; summary: string; pii: boolean }[];
  decisions: { id: string; point: string; decision: string; reasoning: string; by: string; role: string; at: string; agreedWithAi: boolean | null; superseded: boolean }[];
  history: { id: string; title: string; version: number; status: string; appliedAt: string; rejectionReason: string | null }[];
  people: { recruiter: string | null; interviewer: string | null; hiringManager: string | null };
  languages: string[];
  recruiterName: string | null;
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function candidateRecord(ctx: HireContext, applicationId: string): Promise<CandidateRecord | null> {
  const bundle = await getApplication(ctx, applicationId);
  if (!bundle) return null;
  const { app, candidate, def } = bundle;
  const canSeeScores = seesScores(ctx);

  const execRows = await db
    .select({ x: hireStageExecutions, by: users.name })
    .from(hireStageExecutions)
    .leftJoin(users, eq(users.id, hireStageExecutions.conductedById))
    .where(eq(hireStageExecutions.applicationId, app.id))
    .orderBy(hireStageExecutions.createdAt);
  const execIds = execRows.map((r) => r.x.id);
  const answerRows = execIds.length
    ? await db
        .select({ w: hireAnswers, by: users.name })
        .from(hireAnswers)
        .leftJoin(users, eq(users.id, hireAnswers.confirmedById))
        .where(inArray(hireAnswers.executionId, execIds))
        .orderBy(hireAnswers.createdAt)
    : [];

  const currentStageKey = app.stageKey;
  /* An interviewer sees only the stage they are conducting. */
  const visibleExec = (stageKey: string) => canSeeScores || stageKey === currentStageKey;

  const executions: RecordExecution[] = execRows
    .filter((r) => visibleExec(r.x.stageKey))
    .map(({ x, by }) => {
      const stage = stageByKey(def, x.stageKey);
      const answers = answerRows
        .filter((a) => a.w.executionId === x.id)
        .map(({ w, by: cb }): RecordAnswer => {
          const q = stage?.questions.find((qq) => qq.key === w.questionKey);
          return {
            id: w.id,
            questionKey: w.questionKey,
            questionText: q?.text ?? w.questionKey,
            mode: q?.mode ?? w.scoredBy ?? "manual",
            competencyKeys: q?.competencyKeys ?? [],
            responseText: w.responseText,
            score: w.score,
            maxPoints: w.maxPoints,
            scoredBy: w.scoredBy,
            aiScore: w.aiScore,
            aiReasoning: w.aiReasoning,
            aiConfidence: w.aiConfidence,
            aiFlags: w.aiFlags ?? [],
            evidence: w.evidence ?? [],
            probe: w.probeSuggestion,
            humanAction: w.humanAction,
            overrideReason: w.overrideReason,
            confirmedBy: cb ?? null,
            confirmedAt: iso(w.confirmedAt),
            superseded: Boolean(w.supersededById),
          };
        });
      return {
        id: x.id,
        stageKey: x.stageKey,
        stageName: stage?.name ?? x.stageKey,
        stageType: stage ? STAGE_TYPE_LABEL[stage.type] : "",
        status: x.status,
        outcome: x.outcome,
        scheduledAt: iso(x.scheduledAt),
        startedAt: iso(x.startedAt),
        completedAt: iso(x.completedAt),
        conductedBy: by ?? null,
        earned: x.earned,
        maxPoints: x.maxPoints,
        normalised: x.normalised,
        grace: x.grace,
        graceReason: x.graceReason,
        finalScore: x.finalScore,
        passThreshold: stage && isScored(stage) ? stage.passThreshold : null,
        gateOverrideReason: x.gateOverrideReason,
        aiReviewPending: x.aiReviewPending,
        superseded: Boolean(x.supersededById),
        answers,
        pendingReview: answers.filter((a) => !a.superseded && a.aiScore != null && !a.confirmedAt).length,
      };
    });

  const live = executions.filter((e) => !e.superseded);
  const liveByStage = new Map(live.map((e) => [e.stageKey, e]));
  const scored = live.filter((e) => e.finalScore != null);
  const overall = canSeeScores && scored.length ? Math.round(scored.reduce((n, e) => n + (e.finalScore ?? 0), 0) / scored.length) : null;

  const currentOutcome = await stageOutcome(app, def);
  const curIdx = def.stages.findIndex((s) => s.key === app.stageKey);
  const hired = app.status === "hired";
  const journey: JourneyStep[] = def.stages.map((s, i) => {
    const e = liveByStage.get(s.key);
    let state: JourneyStep["state"] = hired || i < curIdx ? "done" : i === curIdx ? "current" : "future";
    if (i === curIdx && (app.status === "rejected" || e?.outcome === "fail")) state = "failed";
    const show = canSeeScores || s.key === app.stageKey;
    return {
      key: s.key,
      name: s.name,
      type: STAGE_TYPE_LABEL[s.type],
      state,
      score: show && e?.finalScore != null ? Math.round(e.finalScore) : null,
      outcome: i === curIdx && !hired ? currentOutcome.outcome : (e?.outcome ?? (state === "done" ? "pass" : "pending")),
      who: e?.conductedBy ?? null,
      when: e?.completedAt ?? e?.scheduledAt ?? null,
    };
  });

  /* Competency roll-up and the evidence behind it: CONFIRMED answers only. */
  const points: Record<string, number | null> = {};
  const evidenceByComp: CandidateRecord["evidenceByComp"] = {};
  if (canSeeScores) {
    for (const e of live)
      for (const a of e.answers) {
        if (a.superseded || a.score == null) continue;
        points[`${e.stageKey}.${a.questionKey}`] = a.score;
        for (const c of a.competencyKeys)
          for (const sp of a.evidence) (evidenceByComp[c] ??= []).push({ text: sp.verbatim, source: sp.source || `${e.stageName} · ${a.questionKey.toUpperCase()}`, criterion: sp.criterion, tier: sp.tier });
      }
  }
  const rollup = canSeeScores ? competencyRollup(def, points) : { scores: {}, overall: null };

  const [summaryRow] = canSeeScores
    ? await db.select().from(hireAiOutputs).where(and(eq(hireAiOutputs.applicationId, app.id), eq(hireAiOutputs.kind, "summary"))).orderBy(desc(hireAiOutputs.createdAt)).limit(1)
    : [];
  const [consRow] = await db.select().from(hireAiOutputs).where(and(eq(hireAiOutputs.applicationId, app.id), eq(hireAiOutputs.kind, "consistency"))).orderBy(desc(hireAiOutputs.createdAt)).limit(1);
  const [profileRow] = await db.select().from(hireProfiles).where(eq(hireProfiles.applicationId, app.id)).limit(1);
  const cvFiles = (await db.execute(sql`
    select f.id, f.filename, f.uploaded_at, f.size_bytes from hire_files f
    where f.candidate_id = ${candidate.id} and f.purpose = 'cv' and f.removed_at is null order by f.uploaded_at desc`)) as unknown as Record<string, unknown>[];

  const showWider = canSeeScores;
  const messages = showWider
    ? await db
        .select({ m: hireMessages, by: users.name })
        .from(hireMessages)
        .leftJoin(users, eq(users.id, hireMessages.sentById))
        .where(eq(hireMessages.candidateId, candidate.id))
        .orderBy(desc(hireMessages.at))
        .limit(200)
    : [];
  const audit = showWider
    ? await db
        .select()
        .from(hireAudit)
        .where(or(eq(hireAudit.candidateId, candidate.id), eq(hireAudit.applicationId, app.id)))
        .orderBy(desc(hireAudit.at))
        .limit(300)
    : [];
  const decisions = showWider
    ? await db
        .select({ d: hireDecisions, by: users.name })
        .from(hireDecisions)
        .innerJoin(users, eq(users.id, hireDecisions.decidedById))
        .where(eq(hireDecisions.applicationId, app.id))
        .orderBy(desc(hireDecisions.decidedAt))
    : [];
  const history = showWider
    ? await db
        .select({ id: hireApplications.id, title: hireBlueprints.title, version: hireBlueprints.version, status: hireApplications.status, appliedAt: hireApplications.appliedAt, rejectionReason: hireApplications.rejectionReasonCode })
        .from(hireApplications)
        .innerJoin(hireBlueprints, eq(hireBlueprints.id, hireApplications.blueprintId))
        .where(and(eq(hireApplications.candidateId, candidate.id), sql`${hireApplications.id} <> ${app.id}`))
        .orderBy(desc(hireApplications.appliedAt))
    : [];

  const names = (await db.execute(sql`
    select (select name from users where id = ${app.recruiterId ?? ""}) as r,
           (select name from users where id = ${app.interviewerId ?? ""}) as i,
           (select name from users where id = ${app.hiringManagerId ?? ""}) as h`)) as unknown as { r: string | null; i: string | null; h: string | null }[];

  const cfg = await getConfig();
  const cur = liveByStage.get(app.stageKey) ?? null;

  /* Talk ratio etc. live on sessions — only their existence matters here. */
  void hireSessions;

  return {
    bundle,
    canSeeScores,
    overall,
    currentOutcome,
    currentExecId: cur?.id ?? null,
    currentExecStatus: cur?.status ?? null,
    journey,
    executions,
    rollup,
    evidenceByComp,
    summary: summaryRow ? { content: summaryRow.content as SummaryContent, at: iso(summaryRow.createdAt)!, aiTaskId: summaryRow.aiTaskId } : null,
    consistency: consRow ? { content: consRow.content as ConsistencyContent, at: iso(consRow.createdAt)! } : null,
    profile: profileRow
      ? {
          data: profileRow.data,
          corrections: (profileRow.corrections ?? []).map((c) => ({ field: c.field, from: c.from, to: c.to, byName: c.byName, at: c.at })),
          extractedAt: iso(profileRow.extractedAt),
          confidence: profileRow.extractionConfidence,
          sourceFileId: profileRow.sourceFileId,
        }
      : null,
    cvFiles: cvFiles.map((f) => ({ id: String(f.id), filename: String(f.filename), uploadedAt: new Date(f.uploaded_at as string).toISOString(), sizeBytes: Number(f.size_bytes) })),
    messages: messages.map(({ m, by }) => ({ id: m.id, direction: m.direction, channel: m.channel, language: m.language, subject: m.subject, body: m.body, aiDrafted: m.aiDrafted, status: m.status, at: m.at.toISOString(), by: by ?? null })),
    audit: audit.map((a) => ({ id: a.id, at: a.at.toISOString(), actor: a.actorName, role: a.actorRole, summary: a.summary, pii: a.isPiiAccess })),
    decisions: decisions.map(({ d, by }) => ({ id: d.id, point: d.decisionPoint, decision: d.decision, reasoning: d.reasoning, by, role: d.decidedByRole, at: d.decidedAt.toISOString(), agreedWithAi: d.agreedWithAi, superseded: Boolean(d.supersededById) })),
    history: history.map((h) => ({ ...h, appliedAt: h.appliedAt.toISOString() })),
    people: { recruiter: names[0]?.r ?? null, interviewer: names[0]?.i ?? null, hiringManager: names[0]?.h ?? null },
    languages: cfg["hire.languages"].split(",").map((s) => s.trim()).filter(Boolean),
    recruiterName: names[0]?.r ?? null,
  };
}

/** The candidate's own words across every confirmed answer and transcript, keyed by source label — for AI tasks and their evidence check. */
export async function candidateSources(applicationId: string, def: BlueprintDefinition): Promise<{ label: string; text: string; question: string; stage: string; score: number | null; max: number; comps: string[] }[]> {
  const rows = await db
    .select({ w: hireAnswers, stageKey: hireStageExecutions.stageKey })
    .from(hireAnswers)
    .innerJoin(hireStageExecutions, eq(hireStageExecutions.id, hireAnswers.executionId))
    .where(and(eq(hireStageExecutions.applicationId, applicationId), sql`${hireStageExecutions.supersededById} is null`, sql`${hireAnswers.supersededById} is null`));
  const out: { label: string; text: string; question: string; stage: string; score: number | null; max: number; comps: string[] }[] = [];
  for (const r of rows) {
    const st = stageByKey(def, r.stageKey);
    const q = st?.questions.find((x) => x.key === r.w.questionKey);
    if (!r.w.responseText || r.w.responseText.startsWith("Selected:") || r.w.responseText.startsWith("Calculated")) continue;
    out.push({ label: `${st?.name ?? r.stageKey} · ${r.w.questionKey.toUpperCase()}`, text: r.w.responseText, question: q?.text ?? r.w.questionKey, stage: st?.name ?? r.stageKey, score: r.w.score, max: r.w.maxPoints, comps: q?.competencyKeys ?? [] });
  }
  const sess = (await db.execute(sql`
    select x.stage_key, s.segments from hire_sessions s join hire_stage_executions x on x.id = s.execution_id
    where x.application_id = ${applicationId}`)) as unknown as { stage_key: string; segments: { speaker: string; text: string }[] }[];
  for (const s of sess) {
    const said = (s.segments ?? []).filter((g) => g.speaker === "candidate").map((g) => g.text).join(" ");
    if (said.trim()) out.push({ label: `${stageByKey(def, s.stage_key)?.name ?? s.stage_key} · transcript`, text: said, question: "Interview transcript", stage: stageByKey(def, s.stage_key)?.name ?? s.stage_key, score: null, max: 0, comps: [] });
  }
  return out;
}
