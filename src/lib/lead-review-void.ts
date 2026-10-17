import { QUALIFICATION_ANSWER_KEYS } from "./engines/lead-gates";

/* ---------------------------------------------------------------------------
 * WHEN A MANAGER'S "VERIFIED" STOPS BEING TRUE.
 *
 * `customers.lead_qualification_review = 'verified'` is a judgement about the
 * answers as they stood on the day it was given. The Telecaller who owns the
 * Qualification goes on working the record after that, and an approval that
 * survived any edit would be an approval of something the manager never saw.
 * So a MATERIAL change made by anybody who is not the reviewer takes the verdict
 * away, and the gate — which reads `verified` and nothing else — asks the
 * manager again.
 *
 * PURE, and shared by every writer: the rule is one function so a ninth writer
 * cannot invent a ninth idea of what "material" means. A source-scanning test
 * (`lead-review-void.test.ts`) fails the build for a file that writes one of
 * the columns below without going through it.
 *
 * WHAT IS MATERIAL is exactly what the Sample/Trial gate reads about the lead —
 * the eight conditions, the four Prospect figures that the freshness check
 * stands behind, the sales type that decides which conditions exist at all, and
 * the distributor link. What is not: the next action, notes, the contact and
 * company details, and re-saving a value that is already there.
 *
 * NOTHING HERE IS DESTRUCTIVE. It returns the columns to null; the verdict that
 * stood is written to the audit log and the timeline by the caller
 * (`recordReviewVoid`), so "who verified it and when" survives the edit.
 * ------------------------------------------------------------------------- */

/** Columns whose change is material. The names are `customers` column properties. */
export const MATERIAL_COLUMNS = [
  "gstin",
  "gstVerified",
  "leadApplication",
  "leadCreditDaysWanted",
  "leadBuyer",
  "leadDecisionMaker",
  "leadQualification",
  "leadMonthlyVolumeLitres",
  "leadEstimatedPotentialPaise",
  "leadRequiredProductId",
  "leadCompetitor",
  "leadSalesType",
] as const;

export type MaterialColumn = (typeof MATERIAL_COLUMNS)[number];

/**
 * The answers inside `lead_qualification` the gate reads. Anything else in that
 * jsonb (an old tick nothing reads any more, a key a retired condition left
 * behind) is not the manager's business and does not void a review when it
 * changes. These are compared by VALUE, not by whether they are filled: moving
 * the price reaction from "accepted" to "objecting" is exactly the change a
 * standing review was not about.
 */
export const MATERIAL_TICKS = QUALIFICATION_ANSWER_KEYS;

/** What the sentence on the timeline calls each one. */
export const MATERIAL_LABELS: Record<MaterialColumn | "distributor", string> = {
  gstin: "GST number",
  gstVerified: "GST verification",
  leadApplication: "application",
  leadCreditDaysWanted: "credit days",
  leadBuyer: "buyer",
  leadDecisionMaker: "decision maker",
  leadQualification: "checklist answers",
  leadMonthlyVolumeLitres: "monthly litres",
  leadEstimatedPotentialPaise: "potential",
  leadRequiredProductId: "required product",
  leadCompetitor: "competitor",
  leadSalesType: "sales type",
  distributor: "distributor",
};

/** The columns a void writes. Spread into the same UPDATE as the material change. */
export type ReviewVoidSet = {
  leadQualificationReview: null;
  leadQualificationReviewNote: null;
  leadQualificationReviewedAt: null;
  leadQualificationReviewedById: null;
};

/** The lead's own state, as much of it as this rule reads. */
export type ReviewVoidLead = {
  leadStage: string | null;
  leadQualificationReview: string | null;
  leadQualification?: Record<string, unknown> | null;
} & { [K in Exclude<MaterialColumn, "leadQualification">]?: unknown };

export type ReviewVoid = {
  set: ReviewVoidSet;
  /** Which material things changed, by their sentence-word. */
  fields: string[];
};

/** The rungs at which a `verified` review is the live gate on Sample/Trial. */
const REVIEWABLE_STAGES: readonly string[] = ["qualification"];

/**
 * Two stored answers are the same answer. Empty text, null and undefined are one
 * state ("nobody said"), numbers compare as numbers, and everything else is
 * compared by its JSON so an identical re-save is recognised for what it is.
 */
export function sameAnswer(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) =>
    v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only the answers the gate reads, so an unrelated key changing is not a change. */
function tickView(q: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of MATERIAL_TICKS) {
    const v = q?.[id];
    out[id] = typeof v === "string" ? v.trim() : v ? "true" : "";
  }
  return out;
}

/** The material columns a set of about-to-be-written columns names, and nothing else. */
export function materialOf(changed: Record<string, unknown>): Partial<Record<MaterialColumn, unknown>> {
  const out: Partial<Record<MaterialColumn, unknown>> = {};
  for (const column of MATERIAL_COLUMNS) {
    if (column in changed) out[column] = changed[column];
  }
  return out;
}

/**
 * Which material columns this write actually changes.
 *
 * `changed` is what the writer is about to set — only the keys it is setting.
 * A key absent from it is untouched, and a key present with the value already
 * stored is a no-op, which is the whole of "re-confirming an identical value
 * does not void a review".
 */
export function materialChanges(
  lead: ReviewVoidLead,
  changed: Partial<Record<MaterialColumn, unknown>>,
): MaterialColumn[] {
  const out: MaterialColumn[] = [];
  for (const column of MATERIAL_COLUMNS) {
    if (!(column in changed)) continue;
    if (column === "leadQualification") {
      const before = tickView(lead.leadQualification ?? null);
      const after = tickView(changed.leadQualification as Record<string, unknown> | null);
      if (MATERIAL_TICKS.some((id) => !sameAnswer(before[id], after[id]))) out.push(column);
      continue;
    }
    if (!sameAnswer(lead[column], changed[column])) out.push(column);
  }
  return out;
}

/**
 * The columns that take a manager's review away, or null where nothing does.
 *
 * WHICH REVIEWS: `verified`, and equally a NEGATIVE one (`incomplete` or
 * `clarification`). A negative verdict is a note the Telecaller has to answer,
 * and a material edit is how they answer it: the old verdict was about answers
 * that have now changed, so it no longer stands and the manager is asked again.
 * What does NOT void it is a save that changes nothing — the note stays exactly
 * where the manager left it until the Telecaller actually changes something
 * (or says outright that the note is addressed, `resubmitForReview`).
 *
 * `reviewer` is true where the person writing holds `lead.verify`. A manager's
 * ordinary edit does not void his own judgement — he made it knowingly and the
 * audit log has it — but a change of SALES TYPE always does, because it changes
 * which conditions exist at all and the verdict was about the old set.
 *
 * `extra` carries changes that are not `customers` columns, which today means
 * a distributor link (`"distributor"`).
 */
export function reviewVoidPatch(
  lead: ReviewVoidLead,
  changed: Partial<Record<MaterialColumn, unknown>>,
  opts: { reviewer?: boolean; extra?: readonly "distributor"[] } = {},
): ReviewVoid | null {
  if (!lead.leadQualificationReview) return null;
  if (!lead.leadStage || !REVIEWABLE_STAGES.includes(lead.leadStage)) return null;

  let columns = materialChanges(lead, changed);
  const extra = opts.extra ?? [];
  if (opts.reviewer) {
    /* Two things a reviewer's own edit still voids: a change of sales type (it
       changes which conditions exist) and a change to the GST number or its
       validation — the approval was given on a validated number, and a different
       one is a different approval. */
    columns = columns.filter((c) => c === "leadSalesType" || c === "gstin" || c === "gstVerified");
  }
  const fields: string[] = [
    ...columns.map((c) => MATERIAL_LABELS[c]),
    ...(opts.reviewer ? [] : extra.map((e) => MATERIAL_LABELS[e])),
  ];
  if (!fields.length) return null;

  return {
    set: {
      leadQualificationReview: null,
      leadQualificationReviewNote: null,
      leadQualificationReviewedAt: null,
      leadQualificationReviewedById: null,
    },
    fields,
  };
}

/** The GST verification columns, and what clearing them writes. */
export type GstClear = {
  gstVerified: false;
  gstVerifiedAt: null;
  gstVerifiedById: null;
};

/**
 * A changed number is not the number somebody validated.
 *
 * Returns the columns that take the validation away when the GSTIN really
 * changes (blank and null are the same answer, and an identical re-save is not a
 * change) and there is a validation to take; null otherwise. It is applied
 * wherever the number is written, so a Telecaller cannot validate one number
 * and then type another under the same tick.
 */
export function gstinChangeClear(
  lead: { gstin?: string | null; gstVerified?: boolean | null },
  next: string | null | undefined,
): GstClear | null {
  if (sameAnswer(lead.gstin ?? null, next ?? null)) return null;
  if (!lead.gstVerified) return null;
  return { gstVerified: false, gstVerifiedAt: null, gstVerifiedById: null };
}
