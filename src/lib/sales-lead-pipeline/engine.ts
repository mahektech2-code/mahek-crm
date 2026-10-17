import type { GateAction, Lead } from "./types";

/**
 * The small pure helpers the Sales Manager screens draw with.
 *
 * WHAT THIS FILE NO LONGER DOES: count. The prototype computed its tiles, its
 * manager strip and its funnel by filtering a JavaScript array of every lead,
 * which is the one thing that cannot survive a book of thousands — and it
 * decided what button to draw from the stage NAME. Both moved to the server:
 * the counts come from the same SQL the real Lead Management screens read, and
 * the next step is `Lead.gate`, worked out beside the real gate engine.
 *
 * What is left is presentation: which findings the salesman collected, how a
 * date reads against today, and how far a checklist has got.
 */

const paise = (p?: number) => (p ? "₹" + Math.round(p / 100).toLocaleString("en-IN") : "");

export type FindingField = {
  key: string;
  label: string;
  /**
   * The `VERIFICATION_FINDINGS` id a correction to this field is recorded
   * under, or null where the real call has no such finding (the buyer). A field
   * with no finding is shown on the card and offered no Confirm / Correct row —
   * a correction the action would silently drop is worse than none.
   */
  findingId: string | null;
  get: (l: Lead) => string | null;
};

/** What the salesman collected, in the order the Sales Manager checks it. */
export const SALESMAN_FINDING_FIELDS: FindingField[] = [
  { key: "monthlyLitres", findingId: "monthly_litres", label: "Monthly Requirement", get: (l) => (l.monthlyLitres ? l.monthlyLitres.toLocaleString("en-IN") + " Litres" : null) },
  { key: "potentialPaise", findingId: "potential", label: "Monthly Potential", get: (l) => (l.potentialPaise ? paise(l.potentialPaise) : null) },
  { key: "product", findingId: "required_product", label: "Product", get: (l) => l.product ?? null },
  { key: "competitor", findingId: "competitor", label: "Competitor", get: (l) => l.competitor ?? null },
  { key: "contact", findingId: "contact_person", label: "Contact Person", get: (l) => l.contact ?? null },
  { key: "decisionMaker", findingId: "decision_maker", label: "Decision Maker", get: (l) => l.decisionMaker ?? null },
  { key: "buyer", findingId: null, label: "Buyer", get: (l) => l.buyer ?? null },
];

/** The findings Convert to Prospect confirms — the ones `saveProspectFields` can store. */
export const CONVERSION_FIELD_KEYS = ["monthlyLitres", "potentialPaise", "product", "competitor", "contact", "decisionMaker"];

/** What the salesman wrote about this lead (`customers.lead_notes`) — read-only on these screens. */
export function salesmanNotesFor(l: Lead): string | null {
  return l.salesmanNotes ?? null;
}

export function daysUntil(dateIso: string | undefined, today: Date): number | null {
  if (!dateIso) return null;
  const target = new Date(dateIso + "T00:00:00");
  const diffMs = target.getTime() - new Date(today.toDateString()).getTime();
  return Math.round(diffMs / 86400000);
}

/** How far the salesman's checklist has got, over the conditions the real engine asks of THIS lead. */
export function qualificationStatus(l: Lead) {
  const total = l.qualItems.length;
  const done = l.qualItems.filter((c) => c.done).length;
  const missing = l.qualItems.filter((c) => !c.done);
  return { done, total, allDone: total > 0 && done === total, missing };
}

export type { GateAction };

/** The next step, as the server decided it. Kept as a function so every screen asks the same way. */
export function gateActionFor(l: Lead): GateAction {
  return l.gate;
}
