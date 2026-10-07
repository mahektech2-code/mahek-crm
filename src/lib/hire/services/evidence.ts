import "server-only";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireAiOutputs, hireAnswers, hireProfiles, hireStageExecutions } from "@/db/schema";
import type { BlueprintDefinition } from "../blueprint-types";
import { isScored, stageByKey } from "../blueprint-types";
import { competencyRollup } from "../engines/scoring";

/* ---------------------------------------------------------------------------
 * The case for one application, read off CONFIRMED answers only: what each
 * stage scored, what each competency rolls up to, and the candidate's own
 * words behind it. An AI score nobody has confirmed is not evidence of
 * anything yet, so it is not here.
 *
 * Read by the decision gate, the comparison and (later) anything else that
 * needs "what did they say about X".
 * ------------------------------------------------------------------------- */

export type EvidenceQuote = {
  text: string;
  /** "Level 3 · Q1" */
  source: string;
  stageKey: string;
  questionKey: string;
  /** The answer's score on its own 0..max scale. */
  score: number;
  max: number;
  tier: string | null;
  criterion: string | null;
};

export type StageScore = { key: string; name: string; final: number | null; pass: number; outcome: string; max: number; earned: number | null; grace: number };

export type CaseFile = {
  stages: StageScore[];
  /** Competency key → 0..10, null where nothing confirmed tests it. */
  competencies: Record<string, number | null>;
  overall: number | null;
  /** Competency key → quotes, strongest first. */
  quotes: Record<string, EvidenceQuote[]>;
  /** Every candidate statement keyed by source label — what quotes are validated against. */
  sources: Record<string, string>;
  consistency: { nature: string; severity: string; a: { text: string; source: string }; b: { text: string; source: string }; probe?: string }[];
  consistencyChecked: boolean;
  expectedCompensation: string | null;
};

export async function caseFile(applicationId: string, def: BlueprintDefinition): Promise<CaseFile> {
  const [execs, answers, cons, profile] = await Promise.all([
    db
      .select()
      .from(hireStageExecutions)
      .where(and(eq(hireStageExecutions.applicationId, applicationId), isNull(hireStageExecutions.supersededById)))
      .orderBy(desc(hireStageExecutions.createdAt)),
    db
      .select({ a: hireAnswers, stageKey: hireStageExecutions.stageKey })
      .from(hireAnswers)
      .innerJoin(hireStageExecutions, eq(hireStageExecutions.id, hireAnswers.executionId))
      .where(
        and(
          eq(hireStageExecutions.applicationId, applicationId),
          isNull(hireStageExecutions.supersededById),
          isNull(hireAnswers.supersededById),
          isNotNull(hireAnswers.confirmedAt),
          isNotNull(hireAnswers.score),
        ),
      ),
    db.select().from(hireAiOutputs).where(and(eq(hireAiOutputs.applicationId, applicationId), eq(hireAiOutputs.kind, "consistency"))).orderBy(desc(hireAiOutputs.createdAt)).limit(1),
    db.select({ data: hireProfiles.data }).from(hireProfiles).where(eq(hireProfiles.applicationId, applicationId)).limit(1),
  ]);

  const latestByStage = new Map<string, (typeof execs)[number]>();
  for (const e of execs) if (!latestByStage.has(e.stageKey)) latestByStage.set(e.stageKey, e);

  const stages: StageScore[] = def.stages.filter(isScored).flatMap((s) => {
    const e = latestByStage.get(s.key);
    if (!e || e.finalScore == null) return [];
    return [{ key: s.key, name: s.name, final: e.finalScore, pass: s.passThreshold, outcome: e.outcome, max: s.maxPoints, earned: e.earned, grace: e.grace }];
  });

  const points: Record<string, number> = {};
  const quotes: Record<string, EvidenceQuote[]> = {};
  const sources: Record<string, string> = {};
  for (const { a, stageKey } of answers) {
    const stage = stageByKey(def, stageKey);
    const q = stage?.questions.find((x) => x.key === a.questionKey);
    if (!stage || !q) continue;
    points[`${stageKey}.${q.key}`] = a.score as number;
    const source = `${stage.name} · ${q.key.toUpperCase()}`;
    if (a.responseText && q.mode === "ai_rubric") sources[source] = a.responseText;
    const spans = a.evidence?.length ? a.evidence : q.mode === "ai_rubric" && a.responseText ? [{ verbatim: a.responseText, tier: null, criterion: null }] : [];
    for (const sp of spans)
      for (const c of q.competencyKeys)
        (quotes[c] ??= []).push({
          text: sp.verbatim,
          source,
          stageKey,
          questionKey: q.key,
          score: a.score as number,
          max: q.maxPoints,
          tier: (sp as { tier: string | null }).tier ?? null,
          criterion: (sp as { criterion: string | null }).criterion || null,
        });
  }
  for (const k of Object.keys(quotes)) quotes[k].sort((x, y) => y.score / y.max - x.score / x.max);

  const roll = competencyRollup(def, points);
  const c = cons[0]?.content as { inconsistencies?: CaseFile["consistency"] } | undefined;
  const fields = (profile[0]?.data?.fields ?? {}) as Record<string, { value: string }>;
  return {
    stages,
    competencies: roll.scores,
    overall: roll.overall,
    quotes,
    sources,
    consistency: Array.isArray(c?.inconsistencies) ? c!.inconsistencies : [],
    consistencyChecked: cons.length > 0,
    expectedCompensation: fields["Expected compensation"]?.value ?? null,
  };
}
