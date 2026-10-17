import "server-only";
import { z } from "zod";
import { locate } from "./guards";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * THE INTERVIEW COPILOT (spec §5.4). Asked only after the CANDIDATE has
 * finished speaking, never mid-sentence.
 *
 * It suggests the next question from the bank and why, and it may raise a
 * contradiction — but only one whose BOTH sides it can quote: what was just
 * said, and the CV or an earlier answer. A contradiction whose quotes do not
 * resolve in their sources is dropped, not shown; "inconsistency detected"
 * with nothing to read is exactly what the copilot must never say.
 *
 * It never scores, never sees an earlier score, and never comments on how
 * somebody spoke — demeanour, confidence, accent and appearance are not
 * evidence of anything.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "copilot/v1";

const Schema = z.object({
  suggestionKey: z.string().nullable().describe("The key of the bank question to ask next, or null if a follow-up probe is better."),
  suggestion: z.string().nullable().describe("The exact question to ask next, in plain words. Null if nothing useful remains."),
  why: z.string().describe("One sentence: which competency is unprobed or what is missing from the last answer."),
  contradiction: z
    .object({
      said: z.string().describe("Copied exactly from the candidate's most recent words."),
      earlier: z.string().describe("Copied exactly from one EARLIER SOURCE line."),
      earlierSource: z.string().describe("The source label of that line, e.g. CV or Level 2 · Q3."),
      probe: z.string().describe("A neutral question to clear it up — something to ask about, not a conclusion."),
    })
    .nullable(),
});

export type CopilotOut = {
  suggestionKey: string | null;
  suggestion: string | null;
  why: string;
  contradiction: { said: string; earlier: string; earlierSource: string; probe: string } | null;
};

export async function copilotSuggest(args: {
  roleTitle: string;
  transcript: { speaker: string; text: string }[];
  lastCandidate: string;
  unprobed: string[];
  remaining: { key: string; text: string; competency: string }[];
  sources: { text: string; source: string }[];
  minutesLeft: number | null;
  actorId: string;
  applicationId: string;
  blueprintId: string;
  sessionId: string;
}): Promise<TaskResult<CopilotOut>> {
  const system = [
    "You assist a human interviewer for Mahek Marketing India during a live structured interview.",
    "Suggest the single most useful next question, preferring an unasked question from the bank that probes an unprobed competency; a short follow-up probe is fine when the last answer lacked a specific example.",
    "Only raise a contradiction if the candidate's latest words clearly conflict with an EARLIER SOURCE line on a material fact (dates, tenure, numbers, responsibilities). Quote both sides exactly. A month's difference is not a contradiction. Frame it as something to ask about.",
    "Never comment on personality, emotion, confidence, accent, appearance, age, gender, health, religion, caste or family. Never state or imply an outcome.",
  ].join(" ");
  const prompt = [
    `Role: ${args.roleTitle}`,
    `Unprobed competencies: ${args.unprobed.join(", ") || "none"}`,
    args.minutesLeft != null ? `Minutes left: ${args.minutesLeft}` : "",
    `Question bank not yet asked:\n${args.remaining.map((q) => `- [${q.key}] (${q.competency}) ${q.text}`).join("\n") || "- none"}`,
    `EARLIER SOURCES:\n${args.sources.map((s) => `- [${s.source}] ${s.text}`).join("\n") || "- none"}`,
    `Transcript so far:\n${args.transcript.slice(-24).map((t) => `${t.speaker === "candidate" ? "Candidate" : "Interviewer"}: ${t.text}`).join("\n")}`,
    `The candidate's most recent words:\n"""\n${args.lastCandidate}\n"""`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await runTask({
    taskType: "copilot",
    promptVersion: PROMPT_VERSION,
    tier: "fast",
    system,
    prompt,
    schema: Schema,
    entity: { type: "session", id: args.sessionId, applicationId: args.applicationId, blueprintId: args.blueprintId },
    actorId: args.actorId,
    redactPrompt: true,
    timeoutSeconds: 30,
  });
  if (!res.ok) return res;
  const o = res.output;
  let contradiction = o.contradiction;
  if (contradiction) {
    const said = locate(args.lastCandidate, contradiction.said);
    const src = args.sources.find((s) => s.source === contradiction!.earlierSource && locate(s.text, contradiction!.earlier)) ?? args.sources.find((s) => locate(s.text, contradiction!.earlier));
    /* Both sides must be real words from real sources, or nothing is shown. */
    contradiction = said && src ? { ...contradiction, said: args.lastCandidate.slice(said.start, said.end), earlierSource: src.source } : null;
  }
  const known = args.remaining.find((q) => q.key === o.suggestionKey);
  return { ...res, output: { suggestionKey: known ? known.key : null, suggestion: o.suggestion, why: o.why, contradiction } };
}
