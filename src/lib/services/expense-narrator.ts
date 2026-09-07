import "server-only";
import { getConfig } from "@/lib/config/store";
import { write, writingConfigured } from "@/lib/writing-model";
import type { ExceptionRow } from "./expense-service";

/* ---------------------------------------------------------------------------
 * §M71 — "AI alerts", honestly.
 *
 * **A model does not decide anything here, and that is the whole design.**
 * Every finding it is given was produced by `expense-fraud.ts`: deterministic,
 * explainable, the same answer every time it runs, and testable without a
 * network. What the model does is turn a list of them into three sentences an
 * owner reads in ten seconds.
 *
 * Letting a model decide whether spending is suspicious would fail on all four
 * counts at once — it cannot show its working, it cannot be tested, it is not
 * the same twice, and this is somebody's salary. The client asked for AI
 * alerts and this is the version of that which is defensible: the alerts are
 * arithmetic, the sentence is the AI.
 *
 * The findings are already summarised into counts and numbers before the model
 * sees them, so no salesman's name, no customer and no bill reference leaves
 * the building. That is a deliberate narrowing rather than a side effect of
 * how the prompt happened to be written.
 *
 * It never fails a screen. No key, no credit, a timeout — the screen shows the
 * findings themselves, which is what it would show anyway.
 * ------------------------------------------------------------------------- */

const SYSTEM = `You write a short briefing for the owner of a paint and chemicals distributor in India, about his field sales team's expenses.

You are given findings that have ALREADY been decided by deterministic rules. Your job is to turn them into prose. It is NOT to judge, to add findings, to speculate about causes, or to soften anything.

Rules:
- Three sentences at most. This is read in ten seconds.
- Use the numbers you are given and invent none. If a figure is not in the input, it does not go in the output.
- Never accuse anybody. A finding says a claim is unusual, not that somebody is dishonest, and the difference matters because these are real people's expense claims.
- Name what to look at, not what to conclude.
- Plain Indian business English. No bullet points, no headings, no preamble.
- If the findings are unremarkable, say so plainly in one sentence rather than manufacturing concern.`;

export type Narration = {
  text: string | null;
  /** Why there is no narration, where there is none. Shown instead of it. */
  unavailableReason: string | null;
};

/**
 * A paragraph over the month's findings.
 *
 * Returns null text rather than throwing, always. This is a courtesy on top of
 * a screen that is complete without it — the same rule the next-step sentence
 * follows in the CRM, where working it out never fails the save.
 */
export async function narrateExceptions(
  exceptions: readonly ExceptionRow[],
  context: { month: string; totalPaise: number; salesmen: number },
): Promise<Narration> {
  const notable = exceptions.filter((e) => e.severity !== "info");
  if (notable.length === 0) {
    return {
      text: null,
      unavailableReason: "Nothing was flagged this month that needs a decision.",
    };
  }

  if (!(await writingConfigured())) {
    return {
      text: null,
      unavailableReason:
        "No writing model is configured, so the findings below are shown as they are. Set an OpenAI or Sarvam key in the console to have them summarised.",
    };
  }

  /* Counts and numbers only. The model is given the SHAPE of the month, never
     the people in it — a name adds nothing to a summary of how many claims
     were over a limit, and it is the one thing that would leave the building. */
  const byKind = new Map<string, number>();
  for (const e of notable) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);

  const facts = [
    `Month: ${context.month}.`,
    `Field team: ${context.salesmen} salesmen.`,
    `Approved expenses this month: ₹${Math.round(context.totalPaise / 100).toLocaleString("en-IN")}.`,
    `Findings needing a decision: ${notable.length}.`,
    ...[...byKind.entries()].map(([kind, n]) => `- ${kind.replace(/_/g, " ")}: ${n}`),
    "",
    "The findings themselves, without names:",
    ...notable.slice(0, 25).map((e) => `- ${e.message}`),
  ].join("\n");

  const config = await getConfig();
  const outcome = await write({
    system: SYSTEM,
    prompt: facts,
    openaiModel: config["voice.languageModel"],
    timeoutMs: 20_000,
  });

  if (!outcome.ok) {
    return {
      text: null,
      unavailableReason:
        "The summary could not be written just now. The findings below are the same either way — they are worked out here, not by a model.",
    };
  }

  return { text: outcome.text.trim(), unavailableReason: null };
}
