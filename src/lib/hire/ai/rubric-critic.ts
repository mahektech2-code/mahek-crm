import "server-only";
import { z } from "zod";
import type { BlueprintDefinition } from "../blueprint-types";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * THE RUBRIC CRITIC (spec §6.1, §5.9) — runs BEFORE a person reviews a draft,
 * so the reviewer reads the rubric with its weak spots already named: vague
 * criteria, overlapping tiers, bias-prone wording, undefined outcomes. It
 * reads only the blueprint; there is no candidate in it.
 * ------------------------------------------------------------------------- */

export type CriticFinding = { where: string; kind: string; message: string; suggestion?: string };

const Schema = z.object({
  findings: z.array(
    z.object({
      where: z.string().describe("The question reference exactly as given, e.g. l2.q3"),
      kind: z.enum(["vague", "overlap", "bias", "undefined_outcome", "unmeasurable", "trait_language", "other"]),
      message: z.string().describe("One sentence naming the problem."),
      suggestion: z.string().nullable().describe("A concrete rewording or fix, or null."),
    }),
  ),
});

export async function critiqueRubric(def: BlueprintDefinition, ctx: { title: string; blueprintId: string; actorId: string }): Promise<TaskResult<CriticFinding[]>> {
  const lines: string[] = [];
  for (const s of def.stages)
    for (const q of s.questions) {
      lines.push(`[${s.key}.${q.key}] (${s.name}, ${q.mode}, max ${q.maxPoints}) ${q.text}`);
      for (const r of q.rubric) lines.push(`   criterion ${r.tier} ${r.points ?? "NO POINTS"}: ${r.descriptor}`);
      for (const o of q.options ?? []) lines.push(`   option "${o.label}": ${o.points ?? "NO SCORE"}`);
      if (q.calc?.kind === "bands") lines.push(`   bands: ${q.calc.bands.map((b) => `${b.min ?? "-inf"}..${b.max ?? "inf"}=${b.points}`).join(", ")}; uncovered=${q.calc.uncovered ?? "UNDEFINED"}`);
      if (q.calc?.kind === "formula") lines.push(`   formula: ${q.calc.expression} cap=${q.calc.cap ?? "none"}`);
    }
  if (!lines.length) return { ok: true, output: [], taskId: "", model: "", cached: false };
  const res = await runTask({
    taskType: "rubric_critic",
    promptVersion: "rubric-critic/v1",
    tier: "fast",
    system:
      "You review an interview rubric for a hiring blueprint before a human reads it. Find concrete problems only: criteria too vague to observe, tiers that overlap so two scores fit one answer, wording that invites bias or scores a trait (confidence, personality, appearance, accent, culture fit), and any reachable answer with no defined score. Never comment on a protected attribute except to flag a question that asks about one. Say nothing about a question that is fine. Be brief.",
    prompt: `Role: ${ctx.title}\n\n${lines.join("\n")}`,
    schema: Schema,
    entity: { type: "blueprint", id: ctx.blueprintId, blueprintId: ctx.blueprintId },
    actorId: ctx.actorId,
    cacheable: true,
  });
  if (!res.ok) return res;
  const refs = new Set(def.stages.flatMap((s) => s.questions.map((q) => `${s.key}.${q.key}`)));
  return { ...res, output: res.output.findings.filter((f) => refs.has(f.where)).map((f) => ({ where: f.where, kind: f.kind, message: f.message, suggestion: f.suggestion ?? undefined })) };
}
