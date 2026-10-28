/* ---------------------------------------------------------------------------
 * What the verification dialog remembers from earlier calls.
 *
 * Pure, read-only, and it rewrites nothing: it only decides WHICH earlier
 * answer to show against a question, and when it was given.
 *
 * It looks back through the calls newest-first and takes the most recent one
 * that actually answered, instead of only the newest call — a question left
 * blank on the latest call used to look unanswered even though it had been
 * answered the week before.
 *
 * ONE QUESTION IS NEVER REMEMBERED. `growth_potential`, the answer to "Could
 * that grow?", is the only column that is not simply the shop's answer to its own
 * question: until the structured checks existed, the "What they could be worth"
 * finding was written into it, so an old value there may be a rupee figure or
 * "Could not verify", and nothing on the row says which. Nothing is
 * reinterpreted and nothing is guessed — that one question simply shows no
 * history here. The record page still shows whatever is stored. Every other
 * answer is shown as stored.
 * ------------------------------------------------------------------------- */

export type HistoryCheck = {
  field: string;
  /** `field_check_verdict`: confirmed, corrected or unverified. */
  verdict: string;
  corrected?: string | null;
  reason?: string | null;
};

export type HistoryCall = {
  calledAt: Date | string;
  answers: Record<string, string>;
  corrections: readonly HistoryCheck[];
};

export type Remembered = { text: string; at: Date | string };

/** The one question whose stored value can be a legacy rupee figure. */
export const NOT_REMEMBERED_QUESTION = "potential";

export function checkWords(c: HistoryCheck): string {
  if (c.verdict === "corrected") return `Corrected to “${c.corrected ?? ""}”`;
  if (c.verdict === "confirmed") return "Confirmed";
  return `Could not verify${c.reason?.trim() ? ` — ${c.reason.trim()}` : ""}`;
}

/** The latest answer to a finding. `lands` is the column that also holds it, if any. */
export function lastFinding(
  calls: readonly HistoryCall[],
  finding: { id: string; lands: string | null },
): Remembered | null {
  for (const call of calls) {
    const check = call.corrections.find((c) => c.field === finding.id);
    if (check) return { text: checkWords(check), at: call.calledAt };
    const column = finding.lands ? call.answers[finding.lands]?.trim() : "";
    if (column) return { text: column, at: call.calledAt };
  }
  return null;
}

/** The latest answer to one of the call's own questions. */
export function lastAnswer(calls: readonly HistoryCall[], questionId: string): Remembered | null {
  if (questionId === NOT_REMEMBERED_QUESTION) return null;
  for (const call of calls) {
    const text = call.answers[questionId]?.trim();
    if (text) return { text, at: call.calledAt };
  }
  return null;
}
