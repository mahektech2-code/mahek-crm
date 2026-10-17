import "server-only";
import { z } from "zod";
import type { BlueprintDefinition } from "../blueprint-types";
import { locate } from "./guards";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * THE CANDIDATE SUMMARY (spec §5.9 "committee brief", design §7.2 Overview).
 *
 * Evidence-led: every strength and concern quotes the candidate verbatim, and
 * the orchestrator rejects a quote that is not in their answers. The
 * recommendation is stated LAST and is a recommendation — a named person
 * decides at the gate. No name, no demographics: the model reads the role,
 * the competencies and what was said.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "candidate-summary/v1";

const Schema = z.object({
  summary: z.string().describe("Three to five sentences on the evidence across stages. No name, no pronoun-based assumptions; say 'the candidate'."),
  strengths: z.array(z.object({ title: z.string(), quote: z.string().describe("Copied exactly from one of the sources."), source: z.string().describe("The source label the quote came from, exactly as given.") })).max(4),
  concerns: z.array(z.object({ title: z.string(), quote: z.string(), source: z.string() })).max(4),
  recommendation: z.object({
    action: z.string().describe("e.g. 'Advance to documents & offer', 'Hold for a follow-up call', 'Do not advance'"),
    confidence: z.enum(["High", "Moderate", "Low"]),
    why: z.string(),
  }),
});

export type SummaryOut = z.infer<typeof Schema>;

export async function summariseCandidate(args: {
  roleTitle: string;
  def: BlueprintDefinition;
  stageScores: { stage: string; score: number; pass: number }[];
  sources: { label: string; text: string; question: string }[];
  actorId: string;
  applicationId: string;
  blueprintId: string;
}): Promise<TaskResult<SummaryOut>> {
  const bySource = new Map(args.sources.map((s) => [s.label, s.text]));
  const system = [
    "You write an evidence-led brief on one job candidate for Mahek Marketing India's hiring manager.",
    "Use ONLY the candidate's words given below. Every strength and concern must quote the candidate exactly, character for character, and name the source label it came from.",
    "Never infer personality, emotion, confidence, accent, appearance, age, gender, health, religion, caste or family circumstances. Never use the candidate's name.",
    "Contradictions are things to ask about, not conclusions. The recommendation is advice to a person who decides; state it plainly and last.",
  ].join(" ");
  const prompt = [
    `Role: ${args.roleTitle}`,
    `Competencies: ${args.def.competencies.map((c) => `${c.name} (${Math.round(c.weight * 100)}%) — ${c.definition}`).join("; ")}`,
    `Confirmed stage scores (0–100, pass mark in brackets): ${args.stageScores.map((s) => `${s.stage} ${s.score} (${s.pass})`).join(", ") || "none yet"}`,
    "What the candidate said:",
    ...args.sources.map((s) => `[${s.label}] Q: ${s.question}\nA: """${s.text}"""`),
  ].join("\n\n");
  return runTask({
    taskType: "candidate_summary",
    promptVersion: PROMPT_VERSION,
    tier: "reasoning",
    system,
    prompt,
    schema: Schema,
    entity: { type: "application", id: args.applicationId, applicationId: args.applicationId, blueprintId: args.blueprintId },
    actorId: args.actorId,
    redactPrompt: true,
    validate: (out) => {
      for (const it of [...out.strengths, ...out.concerns]) {
        const src = bySource.get(it.source) ?? args.sources.map((s) => s.text).join("\n");
        if (!locate(src, it.quote)) return `The quote “${it.quote.slice(0, 80)}” is not in the candidate’s words.`;
      }
      return null;
    },
  });
}
