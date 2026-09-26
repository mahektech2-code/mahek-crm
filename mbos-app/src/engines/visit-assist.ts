/**
 * THE VISIT ASSISTANT'S PROPOSAL, turned into what the visit screen holds.
 *
 * MahekOne reads what the salesman said (`lib/engines/visit-intel-decide.ts`
 * on the server) and answers with a proposal. This file is the handset's half
 * of the one rule that matters: THE ASSISTANT PROPOSES, HE DECIDES. Every
 * function here returns values for a form he then reads — nothing here writes
 * a record, and the visit screen's own Save is still the only thing that does.
 *
 * FILL ONLY WHAT IS EMPTY. An outcome he already tapped, a date he already
 * picked, a cart he already started: the proposal never overwrites any of it.
 * A suggestion that took back what somebody had just chosen is one they learn
 * to stop asking for.
 *
 * The types restate the server's shape, because an Expo package and a Next
 * app cannot import each other. What crosses is JSON; what is typed here is
 * only what this side reads.
 *
 * PURE. No store, no SQLite, no clock.
 */

export type DatedField = {
  date: string | null;
  source: string | null;
  explanation: string | null;
  choices: { date: string; label: string }[];
};

export type ProductMatch =
  | { state: 'matched'; productId: string; name: string }
  | { state: 'ambiguous'; options: { productId: string; name: string }[] }
  | { state: 'none' };

export type SuggestionState = 'ready' | 'confirm' | 'duplicate';

export type VisitOrderLine = {
  said: string;
  product: ProductMatch;
  quantityCans: number | null;
  saidAs: string | null;
};

type Base = { state: SuggestionState; title: string; why: string; questions: string[] };

export type VisitAction =
  | (Base & { kind: 'order'; lines: VisitOrderLine[] })
  | (Base & { kind: 'payment'; amountRupees: number | null; mode: string | null })
  | (Base & { kind: 'promise'; amountRupees: number | null; date: DatedField | null })
  | (Base & {
      kind: 'complaint';
      category: string | null;
      description: string | null;
      priority: 'medium' | 'high';
      duplicateOf: string | null;
    })
  | (Base & {
      kind: 'sample';
      productSaid: string | null;
      product: ProductMatch | null;
      cans: number | null;
      application: string | null;
      reasonCode: string | null;
      duplicateOf: string | null;
    })
  | (Base & { kind: 'opportunity'; product: string | null; date: DatedField | null })
  | (Base & { kind: 'requirement'; what: string | null; monthlyLitres: number | null; cans: number | null })
  | (Base & { kind: 'lead_decision'; decision: 'qualified' | 'lost' | null });

export type VisitAnalysis = {
  summary: string;
  outcome: { key: string; label: string; state: 'ready' | 'confirm'; why: string } | null;
  outcomeChoices: { key: string; label: string; why: string }[];
  comeBack: DatedField | null;
  actions: VisitAction[];
  competitor: string | null;
  feedback: { text: string; tone: 'positive' | 'negative' | 'neutral'; about: string }[];
  questions: string[];
  notes: string[];
  readByModel: boolean;
};

/** The outcome chips this build draws — anything else is not offered. */
export const KNOWN_OUTCOMES = ['visited', 'order', 'payment', 'complaint', 'sample', 'closed_now', 'closed'];

/* ------------------------------------------------------------------ fill */

export type VisitFormState = {
  outcome: string | null;
  nextDate: string;
  /** He chose the date himself — the cycle's suggestion does not count. */
  nextDatePicked: boolean;
};

export type VisitFill = {
  patch: { outcome?: string; nextDate?: string };
  /** What was filled, in words, for the line under the button. */
  filled: string[];
  /** What was left alone because he had already answered it. */
  kept: string[];
};

/**
 * "Fill the visit": the outcome and the day to come back, and only where he
 * has not answered them himself.
 *
 * The outcome is filled only when the assistant was SURE; a question is
 * answered by tapping one of its chips, never by this button. The day is
 * filled only where the words named one — otherwise the screen's own
 * suggestion from the customer's buying cycle stands.
 */
export function fillVisit(current: VisitFormState, analysis: VisitAnalysis): VisitFill {
  const out: VisitFill = { patch: {}, filled: [], kept: [] };
  const o = analysis.outcome;
  if (o && o.state === 'ready' && KNOWN_OUTCOMES.includes(o.key)) {
    if (current.outcome == null) {
      out.patch.outcome = o.key;
      out.filled.push(o.label);
    } else if (current.outcome !== o.key) {
      out.kept.push('the outcome you chose');
    }
  }
  const day = analysis.comeBack?.date ?? null;
  if (day) {
    if (!current.nextDatePicked) {
      if (day !== current.nextDate) {
        out.patch.nextDate = day;
        out.filled.push('the day to come back');
      }
    } else if (day !== current.nextDate) {
      out.kept.push('the day you picked');
    }
  }
  return out;
}

/* ---------------------------------------------------------------- doors */

/**
 * The cart an order proposal puts in front of him: matched lines with a
 * quantity, as the order screen's own `productId → cans` map. Lines already in
 * his cart keep his quantity. Lines that need a product or a quantity picked
 * are left out and counted, so the screen can say how many are still to add.
 */
export function cartFrom(
  action: Extract<VisitAction, { kind: 'order' }>,
  current: Record<string, string>,
  /** A product he picked on the card for an ambiguous or unmatched line. */
  picked: Record<number, string> = {},
): { cart: Record<string, string>; added: number; missing: number } {
  const cart = { ...current };
  let added = 0;
  let missing = 0;
  action.lines.forEach((line, i) => {
    const productId =
      picked[i] ?? (line.product.state === 'matched' ? line.product.productId : null);
    if (!productId || line.quantityCans == null || line.quantityCans <= 0) {
      missing++;
      return;
    }
    if (cart[productId]) return;
    cart[productId] = String(line.quantityCans);
    added++;
  });
  return { cart, added, missing };
}

/** The payment screen's amount and mode, where he has not typed his own. */
export function paymentFill(
  action: Extract<VisitAction, { kind: 'payment' }>,
  current: { payAmt: string; payMode: string | null },
): { payAmt?: string; payMode?: string } {
  const out: { payAmt?: string; payMode?: string } = {};
  if (!current.payAmt.trim() && action.amountRupees != null) out.payAmt = String(action.amountRupees);
  if (!current.payMode && action.mode) out.payMode = action.mode;
  return out;
}

/**
 * The complaint sheet's draft. The visit screen keeps its sheets' answers in
 * one `Record<string, string>`, so this answers in those keys.
 */
export function complaintDraft(
  action: Extract<VisitAction, { kind: 'complaint' }>,
  categories: readonly string[],
): Record<string, string> {
  const d: Record<string, string> = {};
  if (action.category && categories.includes(action.category)) d.cat = action.category;
  if (action.description) d.what = action.description;
  if (action.priority === 'high') d.priority = 'high';
  return d;
}

/** The sample sheet's draft, in the same keys the sheet reads. */
export function sampleDraft(
  action: Extract<VisitAction, { kind: 'sample' }>,
  reasonCodes: readonly string[],
): Record<string, string> {
  const d: Record<string, string> = {};
  if (action.product?.state === 'matched') {
    d.sku = action.product.productId;
    d.skuName = action.product.name;
  }
  if (action.cans != null && action.cans > 0) d.cans = String(Math.round(action.cans));
  if (action.application) d.application = action.application;
  if (action.reasonCode && reasonCodes.includes(action.reasonCode)) d.reasonCode = action.reasonCode;
  return d;
}

/**
 * The requirement visit's three boxes, where they are still empty. Strings,
 * because that is what the boxes hold.
 */
export function requirementFill(
  action: Extract<VisitAction, { kind: 'requirement' }>,
  current: { what: string; litres: string; cans: string },
): { what?: string; litres?: string; cans?: string } {
  const out: { what?: string; litres?: string; cans?: string } = {};
  if (!current.what.trim() && action.what) out.what = action.what;
  if (!current.litres.trim() && action.monthlyLitres != null) out.litres = String(action.monthlyLitres);
  if (!current.cans.trim() && action.cans != null) out.cans = String(action.cans);
  return out;
}

/**
 * How many things are waiting on him, for the one line at the top of the card.
 * A duplicate is not waiting — it is already on record.
 */
export function openQuestions(analysis: VisitAnalysis): number {
  const fromActions = analysis.actions
    .filter((a) => a.state !== 'duplicate')
    .reduce((n, a) => n + a.questions.length, 0);
  return analysis.questions.length + fromActions + (analysis.outcome?.state === 'confirm' ? 1 : 0);
}
