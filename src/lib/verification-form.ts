/* ---------------------------------------------------------------------------
 * What the verification call's form ASKS today.
 *
 * Pure. The full lists — `VERIFICATION_FINDINGS` and `VERIFICATION_QUESTIONS`
 * in `lead-labels.ts` — are the vocabulary of everything this product has ever
 * recorded, and they are read by the record page, the history, the other doors
 * that write a call and the handset. Taking a question off the form must not
 * take it out of that vocabulary: a stored answer to a question nobody asks any
 * more is still an answer, and it has to keep resolving to words.
 *
 * So the form HIDES and never deletes. The ids below are the stable keys; the
 * numbers drawn beside the rows are only their position among what is shown,
 * and move when this list does.
 *
 * Nothing here is a permission, a stage rule or a server requirement. The
 * action still accepts an answer or a check for any id in the full lists.
 * ------------------------------------------------------------------------- */

/** Findings the form no longer asks about. Their checks stay on the record. */
export const HIDDEN_FINDINGS: ReadonlySet<string> = new Set(["contact_person", "decision_maker"]);

/** Questions the form no longer asks. Their answers stay on the record. */
export const HIDDEN_QUESTIONS: ReadonlySet<string> = new Set([
  /* about our man */
  "visited",
  "explained",
  "impression",
  "understood",
  /* about the opportunity */
  "potential",
  "genuine_interest",
  /* what is stopping them — the whole section */
  "price_issue",
  "quality_issue",
  "service_issue",
  "credit_concern",
  "competitor_concern",
]);

/**
 * Answers a successful verification cannot be recorded without.
 *
 * Only the `verified` result asks. A follow-up is a call that could not confirm
 * the visit and a failed verification is a lead that turned out false, and
 * neither can be made to produce an answer the shop did not give.
 */
export const REQUIRED_WHEN_VERIFIED: readonly string[] = ["current_product"];

export const isActiveFinding = (id: string): boolean => !HIDDEN_FINDINGS.has(id);
export const isActiveQuestion = (id: string): boolean => !HIDDEN_QUESTIONS.has(id);

/** The required questions that are still blank, for the result being recorded. */
export function missingRequiredAnswers(
  outcome: string | null,
  answers: Readonly<Record<string, string | undefined>>,
): string[] {
  if (outcome !== "verified") return [];
  return REQUIRED_WHEN_VERIFIED.filter((id) => !(answers[id] ?? "").trim());
}

/**
 * The Sales Manager desk and its voice assistant name their answers by their own
 * keys (`readyForTrial`, `priceConcern`…). This is the one place each is tied to
 * the question id it is stored under, so "is this answer still asked" is decided
 * by the same list as everywhere else rather than by a second copy.
 */
export const DESK_ANSWER_QUESTION: Readonly<Record<string, string>> = {
  visited: "visited",
  explained: "explained",
  impression: "impression",
  genuineInterest: "genuine_interest",
  priceConcern: "price_issue",
  qualityConcern: "quality_issue",
  creditConcern: "credit_concern",
  serviceConcern: "service_issue",
  competitorConcern: "competitor_concern",
  readyForTrial: "ready_for_trial",
  readyForCommercial: "ready_for_commercial",
  readyForOrder: "ready_for_order",
};

/** Whether a desk/assistant answer key is still asked. An unknown key is not hidden. */
export function isActiveDeskAnswer(key: string): boolean {
  const id = DESK_ANSWER_QUESTION[key];
  return id === undefined || isActiveQuestion(id);
}

/** The refusal the server gives when a successful verification arrives without a required answer. */
export function requiredAnswerRefusal(missing: readonly string[]): string {
  return missing.includes("current_product")
    ? "Say what the shop is using now — a verification cannot be recorded without it."
    : "A required answer is missing.";
}
