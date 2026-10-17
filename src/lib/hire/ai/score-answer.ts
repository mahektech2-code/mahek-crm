import "server-only";
import { z } from "zod";
import type { HireEvidenceSpan } from "@/db/schema";
import type { Competency, Question } from "../blueprint-types";
import { confidenceWord } from "../engines/scoring";
import { locate } from "./guards";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * RUBRIC SCORING — the central task (spec §5.2).
 *
 * In: the question, its rubric, the competency, the role, and what the
 * candidate said. NOT their name, demographics or earlier scores — showing
 * the model a Level 1 result while it scores Level 2 is anchoring, and each
 * answer is scored on its own evidence.
 *
 * Out: a score with reasoning that cites the rubric, and at least one span of
 * the candidate's words, verbatim, that the orchestrator has checked really
 * is in the answer. A response too short or off topic comes back as
 * `insufficient_response` with no score — a short answer is not a bad one.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "score-answer/v1";

const Schema = z.object({
  insufficient: z.boolean().describe("True when the response is too short, off-topic or inaudible to assess against this rubric. Then score is null."),
  score: z.number().nullable().describe("0 to 10, on the rubric's anchors. Null when insufficient."),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().describe("Two or three sentences, in terms of the rubric criteria — never a general impression."),
  criteria: z.array(z.object({ key: z.string(), met: z.enum(["full", "partial", "no"]) })),
  evidence: z
    .array(
      z.object({
        verbatim: z.string().describe("Copied character for character from the candidate's response."),
        criterionKey: z.string().nullable(),
        tier: z.enum(["full", "partial"]),
      }),
    )
    .describe("At least one span unless insufficient."),
  flags: z.array(z.enum(["insufficient_response", "evasive", "rehearsed", "off_topic", "contradicts_earlier", "exceptional"])),
  probe: z.string().nullable().describe("A follow-up question that would get the missing evidence. Required when insufficient."),
});

export type AiScore = {
  insufficient: boolean;
  /** On the QUESTION's scale (0..maxPoints), not 0–10. */
  score: number | null;
  confidence: number;
  confidenceWord: "High" | "Moderate" | "Low";
  reasoning: string;
  evidence: HireEvidenceSpan[];
  flags: string[];
  probe: string | null;
};

export async function scoreAnswer(args: {
  question: Question;
  competencies: Competency[];
  roleTitle: string;
  response: string;
  sourceLabel: string;
  actorId: string;
  applicationId: string;
  blueprintId: string;
  answerId?: string;
}): Promise<TaskResult<AiScore>> {
  const { question: q, response } = args;
  const comps = args.competencies.filter((c) => q.competencyKeys.includes(c.key));
  const rubric = q.rubric.map((r) => `- [${r.key}] ${r.tier} · ${r.points ?? "?"} pts · ${r.descriptor}${r.indicators.length ? ` (look for: ${r.indicators.join("; ")})` : ""}`).join("\n");

  const system = [
    "You score one interview answer for Mahek Marketing India against a fixed rubric.",
    "Score ONLY what the candidate said, against the rubric criteria given. Never infer personality, emotion, confidence, accent, appearance, age, gender, health, religion, caste or family circumstances.",
    "Every claim you make must be supported by a quote copied exactly from the candidate's response. Do not paraphrase inside a quote, do not fix grammar, do not translate it.",
    "If the response is too short, off-topic or unintelligible to assess, set insufficient=true, score=null, and give a probe question. A short answer is not a low score.",
    "Score on 0–10, where the rubric's points tell you what each tier is worth. Confidence reflects how clearly the evidence maps to the rubric (low when the transcript looks garbled or mixes languages you could not read).",
  ].join(" ");

  const prompt = [
    `Role: ${args.roleTitle}`,
    `Competency: ${comps.map((c) => `${c.name} — ${c.definition}`).join("; ") || "(general)"}`,
    `Question: ${q.text}`,
    q.idealAnswer ? `What a strong answer contains: ${q.idealAnswer}` : "",
    `Rubric:\n${rubric || "- full · 10 pts · answers the question with a specific, checkable example"}`,
    `Candidate's response:\n"""\n${response}\n"""`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await runTask({
    taskType: "rubric_score",
    promptVersion: PROMPT_VERSION,
    tier: "reasoning",
    system,
    prompt,
    schema: Schema,
    entity: { type: "answer", id: args.answerId ?? null, applicationId: args.applicationId, blueprintId: args.blueprintId },
    actorId: args.actorId,
    redactPrompt: true,
    cacheable: true,
    validate: (out) => {
      if (out.insufficient) return out.probe ? null : "An insufficient response needs a probe question.";
      if (out.score == null) return "A score is required unless the response is insufficient.";
      if (!out.evidence.length) return "No evidence span — a score without a quote is not a score.";
      for (const e of out.evidence) if (!locate(response, e.verbatim)) return `The quote “${e.verbatim.slice(0, 80)}” is not in the candidate’s response.`;
      return null;
    },
  });
  if (!res.ok) return res;

  const o = res.output;
  const ten = o.score == null ? null : Math.max(0, Math.min(10, o.score));
  const evidence: HireEvidenceSpan[] = o.evidence.map((e) => {
    const at = locate(response, e.verbatim) ?? { start: 0, end: 0 };
    const crit = q.rubric.find((r) => r.key === e.criterionKey);
    return {
      verbatim: response.slice(at.start, at.end),
      start: at.start,
      end: at.end,
      criterionKey: e.criterionKey,
      criterion: crit?.descriptor ?? "",
      tier: e.tier,
      points: crit?.points ?? null,
      source: args.sourceLabel,
    };
  });
  return {
    ...res,
    output: {
      insufficient: o.insufficient,
      score: ten == null ? null : Math.round((ten / 10) * q.maxPoints * 10) / 10,
      confidence: o.confidence,
      confidenceWord: confidenceWord(o.confidence),
      reasoning: o.reasoning,
      evidence: o.insufficient ? [] : evidence,
      flags: o.insufficient && !o.flags.includes("insufficient_response") ? ["insufficient_response", ...o.flags] : o.flags,
      probe: o.probe,
    },
  };
}
