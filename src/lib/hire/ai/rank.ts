import "server-only";
import { z } from "zod";
import type { Competency } from "../blueprint-types";
import { confidenceWord } from "../engines/scoring";
import { locate } from "./guards";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * Candidate ranking (spec §5.7). Candidates go to the model as "Candidate 1",
 * "Candidate 2" — their names are a protected-attribute proxy and do nothing
 * for a comparison of what was said. It ranks on competency evidence only,
 * and where two are too close to separate it says so: a forced ranking of
 * equals is noise dressed as a judgement.
 * ------------------------------------------------------------------------- */

const Schema = z.object({
  synthesis: z.string().describe("Three to five sentences comparing them on the evidence. Say plainly where they are too close to separate."),
  confidence: z.number().min(0).max(1),
  ranking: z.array(z.object({ label: z.string(), rank: z.number().int(), why: z.string() })),
  tooClose: z.array(z.array(z.string())).describe("Groups of labels that cannot meaningfully be separated."),
  differentiators: z.array(z.object({ label: z.string(), competency: z.string(), verbatim: z.string() })).describe("Quotes, copied exactly, that separate them."),
});

export type RankInput = { label: string; scores: Record<string, number | null>; statements: { text: string; source: string; competency: string }[] };
export type Ranking = {
  synthesis: string;
  confidence: string;
  ranking: { label: string; rank: number; why: string }[];
  tooClose: string[][];
  differentiators: { label: string; competency: string; verbatim: string }[];
};

export async function rankShortlist(args: {
  roleTitle: string;
  competencies: Competency[];
  candidates: RankInput[];
  actorId: string;
  blueprintId: string;
}): Promise<TaskResult<Ranking>> {
  const comps = args.competencies.map((c) => `${c.key} = ${c.name} (weight ${Math.round(c.weight * 100)}%)`).join("; ");
  const blocks = args.candidates
    .map((c) =>
      [
        `${c.label}`,
        `Scores (0–10): ${args.competencies.map((k) => `${k.key} ${c.scores[k.key] ?? "—"}`).join(", ")}`,
        `What they said:\n${c.statements.map((s) => `  [${s.competency} · ${s.source}] ${s.text}`).join("\n")}`,
      ].join("\n"),
    )
    .join("\n\n");
  const byLabel = new Map(args.candidates.map((c) => [c.label, c.statements.map((s) => s.text).join("\n")]));
  return runTask({
    taskType: "rank",
    promptVersion: "rank/v1",
    tier: "reasoning",
    system: [
      "You compare shortlisted candidates for one role at Mahek Marketing India, competency by competency, on what they said.",
      "Rank on competency evidence only. Never reference, or use a proxy for, gender, age, location, name, religion, caste, family, appearance or personality.",
      "If candidates are within a point on the competencies that carry most weight and the evidence does not separate them, put them in tooClose and say so in the synthesis rather than forcing an order.",
      "Every differentiator quote must be copied exactly from that candidate's statements.",
    ].join(" "),
    prompt: `Role: ${args.roleTitle}\nCompetencies: ${comps}\n\n${blocks}`,
    schema: Schema,
    entity: { type: "comparison", blueprintId: args.blueprintId },
    actorId: args.actorId,
    redactPrompt: true,
    cacheable: true,
    validate: (o) => {
      for (const d of o.differentiators) {
        const src = byLabel.get(d.label);
        if (!src || !locate(src, d.verbatim)) return `The quote “${d.verbatim.slice(0, 80)}” is not in ${d.label}’s statements.`;
      }
      return null;
    },
  }).then((r) => (r.ok ? { ...r, output: { ...r.output, confidence: confidenceWord(r.output.confidence) } } : r));
}
