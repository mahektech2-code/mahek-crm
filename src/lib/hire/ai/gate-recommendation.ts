import "server-only";
import { z } from "zod";
import type { BlueprintDefinition } from "../blueprint-types";
import type { CaseFile } from "../services/evidence";
import { confidenceWord } from "../engines/scoring";
import { checkEvidence } from "./guards";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * The decision gate's recommendation (spec §6.4, design §7.5). It SUPPORTS a
 * person's decision and never stands in for one: the gate cannot be passed
 * without a named human, a reason and their agreement or disagreement with
 * this, recorded.
 *
 * In: competency scores, stage outcomes, consistency flags, compensation
 * against the band, and the candidate's own words. Not their name, gender,
 * age or location. Out: advance / hold / reject, a confidence, and a reason
 * that quotes the evidence — every quote checked against what was said.
 * ------------------------------------------------------------------------- */

const Schema = z.object({
  action: z.enum(["advance", "hold", "reject"]),
  confidence: z.number().min(0).max(1),
  why: z.string().describe("Three or four sentences, evidence first, the recommendation last. Name the competencies, not the person."),
  evidence: z.array(z.object({ verbatim: z.string(), source: z.string() })).describe("One to three quotes copied exactly from the candidate statements given."),
});

export type GateRec = { action: "advance" | "hold" | "reject"; confidence: string; why: string; evidence: { verbatim: string; source: string }[] };

export const ACTION_LABEL: Record<GateRec["action"], string> = { advance: "Advance", hold: "Hold", reject: "Reject" };

export async function recommendAtGate(args: {
  def: BlueprintDefinition;
  roleTitle: string;
  nextStageName: string | null;
  cf: CaseFile;
  actorId: string;
  applicationId: string;
  blueprintId: string;
}): Promise<TaskResult<GateRec>> {
  const { def, cf } = args;
  const band = def.offer.grades[0];
  const comp = def.competencies
    .map((c) => `- ${c.name} (weight ${Math.round(c.weight * 100)}%): ${cf.competencies[c.key] ?? "no confirmed evidence"}${cf.competencies[c.key] != null ? "/10" : ""}`)
    .join("\n");
  const stages = cf.stages.map((s) => `- ${s.name}: ${s.final} against a pass mark of ${s.pass} (${s.outcome})${s.grace ? `, grace ${s.grace}` : ""}`).join("\n");
  const flags = cf.consistency.length
    ? cf.consistency.map((f) => `- ${f.nature} (${f.severity}): “${f.a.text}” [${f.a.source}] vs “${f.b.text}” [${f.b.source}]`).join("\n")
    : cf.consistencyChecked
      ? "- none found"
      : "- the consistency check has not been run";
  const said = Object.entries(cf.sources)
    .map(([src, t]) => `[${src}] ${t}`)
    .join("\n");

  const system = [
    "You advise a hiring manager at Mahek Marketing India at a decision gate. A person decides; you recommend.",
    "Recommend only from the competency evidence, the stage results, the consistency flags and the compensation band given.",
    "Never infer personality, emotion, confidence, accent, appearance, age, gender, health, religion, caste or family circumstances.",
    "A consistency flag is something to ask about, never a conclusion that the candidate lied.",
    "Quotes must be copied character for character from the candidate statements provided.",
  ].join(" ");

  const prompt = [
    `Role: ${args.roleTitle}. After the gate: ${args.nextStageName ?? "onboarding"}.`,
    `Stage results:\n${stages || "- none confirmed"}`,
    `Competencies (0–10):\n${comp}`,
    `Consistency:\n${flags}`,
    `Compensation band (${band?.label ?? "—"}): ₹${Math.round((band?.basicMinPaise ?? 0) / 100)}–₹${Math.round((band?.basicMaxPaise ?? 0) / 100)} a month. Expected: ${cf.expectedCompensation ?? "not recorded"}.`,
    `Candidate statements:\n${said || "(none confirmed)"}`,
  ].join("\n\n");

  const res = await runTask({
    taskType: "gate_recommendation",
    promptVersion: "gate-recommendation/v1",
    tier: "reasoning",
    system,
    prompt,
    schema: Schema,
    entity: { type: "application", id: args.applicationId, applicationId: args.applicationId, blueprintId: args.blueprintId },
    actorId: args.actorId,
    redactPrompt: true,
    validate: (o) => checkEvidence(o.evidence.map((e) => ({ verbatim: e.verbatim, source: e.source })), cf.sources),
  });
  if (!res.ok) return res;
  return { ...res, output: { action: res.output.action, confidence: confidenceWord(res.output.confidence), why: res.output.why, evidence: res.output.evidence } };
}
