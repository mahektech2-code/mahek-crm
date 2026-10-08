import "server-only";
import { z } from "zod";
import type { HireProfileData } from "@/db/schema";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * CV PARSING (spec §5.9). Document → structured profile, every field with
 * its own confidence. Low-confidence fields are MARKED for review, never
 * silently guessed: the profile tab draws them amber, and a person corrects
 * them — a correction is appended, the extraction is never rewritten.
 * Compensation is per MONTH in INR, and the model is told so, because the
 * commonest error is an annual figure read as a monthly one.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "parse-cv/v1";

const Field = z.object({ value: z.string(), confidence: z.number().min(0).max(1) });

const Schema = z.object({
  currentEmployer: Field,
  currentTitle: Field,
  totalExperience: Field.describe("e.g. '7 years 0 months'"),
  relevantExperience: Field,
  education: Field,
  languages: Field,
  currentCompensation: Field.describe("Per month, INR, e.g. '₹17,500 a month'. Empty value with low confidence when not stated."),
  expectedCompensation: Field,
  noticePeriod: Field,
  employers: z.array(z.object({ name: z.string(), title: z.string(), from: z.string(), to: z.string(), months: z.number().nullable() })),
  skills: z.array(z.string()),
  gaps: z.array(z.object({ period: z.string(), months: z.number() })),
  overallConfidence: z.number().min(0).max(1),
});

const LABELS: [keyof z.infer<typeof Schema>, string][] = [
  ["currentEmployer", "Current employer"],
  ["currentTitle", "Current title"],
  ["totalExperience", "Total experience"],
  ["relevantExperience", "Relevant experience"],
  ["education", "Education"],
  ["languages", "Languages"],
  ["currentCompensation", "Current compensation"],
  ["expectedCompensation", "Expected compensation"],
  ["noticePeriod", "Notice period"],
];

export const PROFILE_FIELDS = LABELS.map(([, l]) => l).concat(["Gaps"]);

export async function parseCv(args: {
  roleTitle: string;
  text?: string;
  file?: { bytes: Uint8Array; mediaType: string };
  actorId: string;
  applicationId: string;
  blueprintId: string;
}): Promise<TaskResult<{ data: HireProfileData; confidence: number }>> {
  const system = [
    "You read one CV for a job at Mahek Marketing India and return its facts in a fixed shape.",
    "Each field carries your confidence; when a fact is not stated, return an empty value with confidence 0 — never guess.",
    "Compensation is per MONTH in Indian rupees; if the CV states an annual figure, convert it and lower the confidence.",
    "Do not record or infer age, gender, marital status, religion, caste, health or family details even if the CV contains them.",
  ].join(" ");
  const instruction = `Role applied for: ${args.roleTitle}. Extract the profile.`;
  const res = await runTask({
    taskType: "cv_parse",
    promptVersion: PROMPT_VERSION,
    tier: args.file ? "vision" : "fast",
    system,
    ...(args.file
      ? { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: instruction }, { type: "file" as const, data: args.file.bytes, mediaType: args.file.mediaType }] }] }
      : { prompt: `${instruction}\n\nCV text:\n"""\n${args.text ?? ""}\n"""`, redactPrompt: true, cacheable: true }),
    schema: Schema,
    entity: { type: "application", id: args.applicationId, applicationId: args.applicationId, blueprintId: args.blueprintId },
    actorId: args.actorId,
  });
  if (!res.ok) return res;
  const o = res.output;
  const fields: HireProfileData["fields"] = {};
  for (const [k, label] of LABELS) {
    const f = o[k] as { value: string; confidence: number };
    fields[label] = { value: f.value || "Not stated", source: "ai", confidence: f.value ? f.confidence : 0 };
  }
  fields.Gaps = { value: o.gaps.length ? o.gaps.map((g) => `${g.period} (${g.months} months)`).join("; ") : "None found", source: "ai", confidence: o.overallConfidence };
  return {
    ...res,
    output: {
      data: {
        fields,
        employers: o.employers,
        education: o.education.value ? [o.education.value] : [],
        skills: o.skills,
        languages: o.languages.value ? o.languages.value.split(/,\s*/) : [],
        gaps: o.gaps,
      },
      confidence: o.overallConfidence,
    },
  };
}
