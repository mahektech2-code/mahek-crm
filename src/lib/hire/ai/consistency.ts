import "server-only";
import { z } from "zod";
import { locate } from "./guards";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * CONSISTENCY CHECKING (spec §5.5).
 *
 * Claims compared across the CV and every stage. Both sides of a
 * contradiction are quoted verbatim with their source — the orchestrator
 * rejects a quote that does not resolve — and each is framed as something to
 * ASK about, never as a conclusion. Severity reflects materiality: a date off
 * by a month is not a lie.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "consistency/v1";

const Side = z.object({ text: z.string().describe("Copied exactly from the named source."), source: z.string().describe("A source label exactly as given.") });

const Schema = z.object({
  consistencies: z.array(z.object({ claim: z.string(), sources: z.array(z.string()), strength: z.enum(["Strong", "Moderate", "Weak"]) })).max(6),
  inconsistencies: z
    .array(
      z.object({
        nature: z.string().describe("One or two words: Tenure, Target, Compensation, Responsibilities, Dates…"),
        severity: z.enum(["Minor", "Moderate", "Material"]),
        a: Side,
        b: Side,
        probe: z.string().describe("A neutral question that would settle it."),
      }),
    )
    .max(6),
  unverified: z.array(z.string()).max(6).describe("Claims made once that nothing else corroborates."),
  score: z.number().min(0).max(1).describe("Overall consistency, 1 = fully consistent."),
});

export type ConsistencyOut = z.infer<typeof Schema>;

export async function checkConsistency(args: {
  sources: { label: string; text: string }[];
  actorId: string;
  applicationId: string;
  blueprintId: string;
}): Promise<TaskResult<ConsistencyOut>> {
  const bySource = new Map(args.sources.map((s) => [s.label, s.text]));
  const system = [
    "You compare what one job candidate claimed across their CV and their interviews, and list where the claims agree and where they differ.",
    "Quote both sides of every difference exactly, character for character, from the named source. Present each difference as something worth asking about, never as dishonesty.",
    "Severity reflects materiality — a month's difference in a date is Minor. Never flag anything about a protected attribute (age, gender, religion, caste, health, family) or anything derived from one.",
  ].join(" ");
  const prompt = args.sources.map((s) => `[${s.label}]\n"""${s.text}"""`).join("\n\n");
  return runTask({
    taskType: "consistency_check",
    promptVersion: PROMPT_VERSION,
    tier: "reasoning",
    system,
    prompt,
    schema: Schema,
    entity: { type: "application", id: args.applicationId, applicationId: args.applicationId, blueprintId: args.blueprintId },
    actorId: args.actorId,
    redactPrompt: true,
    cacheable: true,
    validate: (out) => {
      for (const i of out.inconsistencies)
        for (const side of [i.a, i.b]) {
          const src = bySource.get(side.source);
          if (!src || !locate(src, side.text)) return `The quote “${side.text.slice(0, 80)}” is not in ${side.source}.`;
        }
      return null;
    },
  });
}
