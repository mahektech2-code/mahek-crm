/* ---------------------------------------------------------------------------
 * THE CALLING DESK'S THREE CALLS — and what has to be true before a Suspect may
 * be asked for as a Prospect.
 *
 * A lead that arrives from the website, WhatsApp or a portal is qualified over
 * the phone: nobody visits. The desk gets three calls at it, no more — Call 1,
 * Call 2, Call 3 — and what they are FOR is the five answers a Prospect is
 * asked for. Everything else about the funnel (the ladders, the §28 gates, the
 * sales manager's verification call) already exists and is untouched: this file
 * only decides where a lead stands from the desk's side, and what happens when
 * a call ends.
 *
 * Pure, like every engine here: it takes stored values and the calls already
 * made and performs no I/O, so the rule can be exercised without a database.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS STORED, except one thing the schema had no place for.
 *
 * "Ready for Prospect" is not a stage. It is the answer to "are the five
 * answers on the record", and they are columns on `customers` that the rest of
 * the funnel already reads. A stored "ready" flag would be a second copy of that
 * answer, free to drift the day somebody types a competitor in elsewhere.
 * Likewise "which call is next" is a count of the calls already made.
 *
 * The exception is the REQUEST. Asking for a Prospect is not being one: the
 * lead stays a Suspect until the sales manager verifies it, so "asked, and
 * waiting" cannot be a rung. `customers.prospect_request_state` holds it beside
 * the stage — `awaiting`, `followup` (the manager is holding it) or `returned`
 * (sent back to the desk) — and this file reads it as one more input.
 *
 * NO QUESTION IS ASKED TWICE because what is still owed is whatever is still
 * EMPTY. A question answered on Call 1 is a filled column, so it is not offered
 * on Call 2 — not because a rule hides it, but because there is nothing left to
 * ask.
 * ------------------------------------------------------------------------- */

import type { LeadStage } from "../lead-labels";

/** The key in `calls.outcome_detail` that says "this was one of the three". */
export const CALL_MARK = "qualCall";

/** There is no fourth call. The number is the rule, so it is named once. */
export const MAX_QUALIFICATION_CALLS = 3;

export type DeskFieldKey =
  | "customerType"
  | "decisionMaker"
  | "buyer"
  | "gstin"
  | "monthlyLitres"
  | "potentialPaise"
  | "creditDaysWanted"
  | "requiredProductId"
  | "competitor"
  | "application"
  | "address"
  | "email";

export type DeskFieldKind = "text" | "litres" | "money" | "product" | "choice" | "days";

export type DeskField = {
  key: DeskFieldKey;
  label: string;
  kind: DeskFieldKind;
  /** One of the five that make a lead ready. */
  required: boolean;
  /** The call it is best asked on. A hint about ORDER, never a rule about it. */
  suggestCall: 1 | 2 | 3;
  options?: readonly { value: string; label: string }[];
  hint?: string;
};

/**
 * The twelve Suspect answers, in the order the sales manager's Opportunity card
 * lists them. Five are required. All of them map onto columns that already
 * exist — nothing is invented here.
 */
export const DESK_FIELDS: readonly DeskField[] = [
  {
    key: "customerType",
    label: "Customer type",
    kind: "choice",
    required: false,
    suggestCall: 1,
    options: [
      { value: "dealer", label: "Dealer" },
      { value: "manufacturer", label: "Manufacturer" },
      { value: "distributor", label: "Distributor" },
      { value: "retailer", label: "Retailer" },
    ],
  },
  { key: "decisionMaker", label: "Decision maker", kind: "text", required: true, suggestCall: 2 },
  { key: "buyer", label: "Buyer", kind: "text", required: false, suggestCall: 3 },
  { key: "gstin", label: "GST", kind: "text", required: false, suggestCall: 2 },
  { key: "monthlyLitres", label: "Monthly requirement", kind: "litres", required: true, suggestCall: 1, hint: "Litres a month" },
  { key: "potentialPaise", label: "Expected monthly sales", kind: "money", required: true, suggestCall: 2, hint: "Rupees a month" },
  { key: "creditDaysWanted", label: "Credit days", kind: "days", required: false, suggestCall: 3 },
  { key: "requiredProductId", label: "Product", kind: "product", required: true, suggestCall: 1 },
  { key: "competitor", label: "Competitor", kind: "text", required: true, suggestCall: 1 },
  { key: "application", label: "Application", kind: "text", required: false, suggestCall: 1, hint: "What they will use it on" },
  { key: "address", label: "Address", kind: "text", required: false, suggestCall: 3 },
  { key: "email", label: "Email", kind: "text", required: false, suggestCall: 3 },
] as const;

const FIELD_BY_KEY = new Map(DESK_FIELDS.map((f) => [f.key, f]));

export function deskField(key: DeskFieldKey): DeskField {
  return FIELD_BY_KEY.get(key)!;
}

const REQUIRED_KEYS: readonly DeskFieldKey[] = DESK_FIELDS.filter((f) => f.required).map(
  (f) => f.key,
);

/** What is stored right now. Absent and null are the same answer: not asked. */
export type DeskValues = Partial<Record<DeskFieldKey, string | number | null | undefined>>;

/**
 * Whether a stored value is an ANSWER.
 *
 * Zero litres and zero rupees are not answers — they are what an unfilled
 * number looks like once somebody has typed and cleared it. Zero credit days IS
 * an answer: "cash on delivery" is the commonest one there is.
 */
export function isAnswered(key: DeskFieldKey, value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (!Number.isFinite(value)) return false;
  return key === "creditDaysWanted" ? value >= 0 : value > 0;
}

export type RequiredProgress = {
  done: number;
  total: number;
  missing: DeskField[];
  complete: boolean;
};

export function requiredProgress(values: DeskValues): RequiredProgress {
  const missing = DESK_FIELDS.filter((f) => f.required && !isAnswered(f.key, values[f.key]));
  const total = REQUIRED_KEYS.length;
  return { done: total - missing.length, total, missing, complete: missing.length === 0 };
}

/** How many of all twelve are answered — the "n of 12 in all" the progress bar reads. */
export function answeredCount(values: DeskValues): { done: number; total: number } {
  return {
    done: DESK_FIELDS.filter((f) => isAnswered(f.key, values[f.key])).length,
    total: DESK_FIELDS.length,
  };
}

/* ------------------------------------------------------------------ where it stands */

/** Rungs a lead is still being qualified on. `new` and `contacted` are the old spellings. */
const WORKING_STAGES: readonly LeadStage[] = ["new", "suspect", "contacted"];

export function isWorkingStage(stage: LeadStage | null | undefined): boolean {
  return !!stage && WORKING_STAGES.includes(stage);
}

export type RequestState = "awaiting" | "followup" | "returned";

export function isRequestState(v: unknown): v is RequestState {
  return v === "awaiting" || v === "followup" || v === "returned";
}

export type DeskPhase =
  | "call1"
  | "call2"
  | "call3"
  /** The five are in. No further call is wanted — the next act is the request. */
  | "ready"
  /** Three calls made, still incomplete, and nobody has closed it yet. */
  | "exhausted"
  /** Asked for, with the sales manager. Still a Suspect. */
  | "requested"
  /** The manager is holding it. Still a Suspect. */
  | "followup"
  /** The manager sent it back to the desk. Still a Suspect. */
  | "returned"
  | "prospect"
  | "qualification"
  | "sample_trial"
  | "sample_received"
  | "sample_review"
  | "negotiation"
  | "first_order"
  | "delivery"
  | "payment"
  | "second_order"
  | "customer"
  | "parked"
  | "lost"
  /** A rung on a ladder the desk does not draw (the retired distributor one). */
  | "beyond";

const STAGE_PHASE: Partial<Record<LeadStage, DeskPhase>> = {
  prospect: "prospect",
  qualification: "qualification",
  qualified: "qualification",
  sample_trial: "sample_trial",
  sample_received: "sample_received",
  sample_review: "sample_review",
  negotiation: "negotiation",
  first_order: "first_order",
  delivery: "delivery",
  payment: "payment",
  second_order: "second_order",
  customer: "customer",
  won: "customer",
};

export function phaseOf(
  stage: LeadStage | null | undefined,
  values: DeskValues,
  callCount: number,
  requestState?: RequestState | null,
): DeskPhase {
  if (stage === "lost") return "lost";
  if (stage === "on_hold") return "parked";
  if (isWorkingStage(stage)) {
    /* A pending request outranks everything below it: while the manager has it,
       the desk has nothing to do and must not be offered a call. */
    if (requestState === "awaiting") return "requested";
    if (requestState === "followup") return "followup";
    if (requestState === "returned") return "returned";
    /* Ready wins over the call count: a lead whose last answer came on Call 3 is
       ready, not exhausted. */
    if (requiredProgress(values).complete) return "ready";
    if (callCount >= MAX_QUALIFICATION_CALLS) return "exhausted";
    return (["call1", "call2", "call3"] as const)[Math.max(0, callCount)];
  }
  return (stage && STAGE_PHASE[stage]) || "beyond";
}

/** The calls the desk is still doing. */
export function isWorking(phase: DeskPhase): boolean {
  return phase === "call1" || phase === "call2" || phase === "call3";
}

/** A request the sales manager has not yet settled. */
export function isPending(phase: DeskPhase): boolean {
  return phase === "requested" || phase === "followup";
}

/** The call a lead is owed, or null where none is. Never above three. */
export function nextCallNumber(phase: DeskPhase): 1 | 2 | 3 | null {
  return phase === "call1" ? 1 : phase === "call2" ? 2 : phase === "call3" ? 3 : null;
}

/** The rung the ladder draws a lead on. Every phase before Prospect is Suspect. */
export type LadderKey =
  | "suspect"
  | "prospect"
  | "qualification"
  | "sample_trial"
  | "sample_received"
  | "sample_review"
  | "negotiation"
  | "first_order"
  | "delivery"
  | "payment"
  | "second_order"
  | "customer";

export function ladderKeyOf(phase: DeskPhase): LadderKey | null {
  switch (phase) {
    case "call1":
    case "call2":
    case "call3":
    case "ready":
    case "exhausted":
    case "requested":
    case "followup":
    case "returned":
      return "suspect";
    case "prospect":
    case "qualification":
    case "sample_trial":
    case "sample_received":
    case "sample_review":
    case "negotiation":
    case "first_order":
    case "delivery":
    case "payment":
    case "second_order":
    case "customer":
      return phase;
    default:
      return null;
  }
}

/**
 * The rung a LOST lead was lost on.
 *
 * A lost lead has no phase of its own to draw — `lost` is not a rung — so the
 * ladder would fall back to "Stage 0" and hide the progress card, which for a
 * Suspect closed after two calls is the record of how far it got. The rung is
 * taken from the stage the lost move left, read through `phaseOf` exactly as if
 * the lead were still there. Where no move is on record (a lead imported already
 * lost) it was a Suspect.
 */
export function ladderKeyOfLost(
  lostFrom: LeadStage | null | undefined,
  values: DeskValues,
  callCount: number,
): LadderKey {
  if (!lostFrom || lostFrom === "lost" || lostFrom === "on_hold") return "suspect";
  return ladderKeyOf(phaseOf(lostFrom, values, callCount, null)) ?? "suspect";
}

/**
 * The ladder the desk DRAWS for a lead.
 *
 * A third-party lead climbs the third-party ladder; everything else — including
 * a lead nobody has yet said how it will be sold — is drawn on the Direct one.
 * `ladderFor(null)` is the six-rung legacy ladder, which has no Prospect,
 * Qualification or Sample rungs and would draw a blank card for a brand-new
 * online lead. Drawing it is not deciding: the sales type is still unset and the
 * Request dialog asks for it.
 */
export function deskLadderSalesType(
  salesType: "direct" | "third_party" | "distributor" | null | undefined,
): "direct" | "third_party" {
  return salesType === "third_party" ? "third_party" : "direct";
}

/* ------------------------------------------------------------------ questions */

export type CallQuestions = {
  /** Worth asking on this call, the five first. */
  askNow: DeskField[];
  /** Still empty, better left to a later call. */
  later: DeskField[];
  /** Already on the record — shown as answered, never asked again. */
  answered: DeskField[];
};

export function questionsForCall(values: DeskValues, callNumber: number): CallQuestions {
  const open = DESK_FIELDS.filter((f) => !isAnswered(f.key, values[f.key]));
  const askNow = open
    .filter(
      (f) =>
        f.suggestCall <= callNumber ||
        /* The last call is the last chance, so every required answer still
           missing is asked on it whatever call it was suggested for. */
        (callNumber >= MAX_QUALIFICATION_CALLS && f.required),
    )
    /* Required first, and stable within each group. Mixed in among optional ones
       the question that gates Ready for Prospect is the one that gets skipped. */
    .sort((a, b) => Number(b.required) - Number(a.required));
  const later = open.filter((f) => !askNow.includes(f));
  const answered = DESK_FIELDS.filter((f) => isAnswered(f.key, values[f.key]));
  return { askNow, later, answered };
}

/* ------------------------------------------------------------------ outcomes */

export type CallOutcome =
  | "spoke_collected"
  | "spoke_callback"
  | "no_answer"
  | "wrong_number"
  | "not_interested";

export const CALL_OUTCOMES: readonly { code: CallOutcome; label: string; hint: string }[] = [
  { code: "spoke_collected", label: "Spoke — information collected", hint: "They answered and we captured answers." },
  { code: "spoke_callback", label: "Spoke — asked to call back", hint: "Reached, but not a good time or only part answered." },
  { code: "no_answer", label: "No answer", hint: "Rang, but nobody spoke to us." },
  { code: "wrong_number", label: "Wrong or invalid number", hint: "Not the business, or the number does not work." },
  { code: "not_interested", label: "Not interested", hint: "They said no." },
] as const;

export const OUTCOME_LABEL: Record<CallOutcome, string> = Object.fromEntries(
  CALL_OUTCOMES.map((o) => [o.code, o.label]),
) as Record<CallOutcome, string>;

export function isCallOutcome(v: unknown): v is CallOutcome {
  return typeof v === "string" && v in OUTCOME_LABEL;
}

export function spoke(outcome: CallOutcome): boolean {
  return outcome === "spoke_collected" || outcome === "spoke_callback";
}

/**
 * The CRM's own outcome for the `calls` row, which has nine values and none of
 * them is these five. The precise answer is kept in `outcome_detail`; this is
 * the coarse one every existing call report already knows how to count.
 */
export function crmOutcomeFor(outcome: CallOutcome): "follow_up" | "no_answer" | "not_interested" {
  if (spoke(outcome)) return "follow_up";
  if (outcome === "not_interested") return "not_interested";
  return "no_answer";
}

/* ------------------------------------------------------------------ after a call */

export type LostCause = "wrong_number" | "not_interested" | "no_response" | "information_missing";

export type CallDisposition =
  | { kind: "ready" }
  | { kind: "lost"; cause: LostCause }
  | { kind: "next"; callNumber: 2 | 3 };

/**
 * What a call that has just been made does to the lead.
 *
 *   - somebody saying no, or a number that is not the business, ends it;
 *   - all five answers in ends the CALLING, whichever call it was — Call 3 is
 *     never forced on a lead that is already ready;
 *   - Call 3 finished and still short ends it as lost, and there is no Call 4;
 *   - otherwise the next call is owed.
 *
 * `merged` is the values AFTER this call's answers were applied, and
 * `priorOutcomes` are the calls before it — the second is only used to say WHY
 * a lead ran out, because "never once answered" and "answered but would not
 * say" are different losses to count later.
 */
export function afterCall(input: {
  callNumber: number;
  outcome: CallOutcome;
  merged: DeskValues;
  priorOutcomes: readonly CallOutcome[];
}): CallDisposition {
  const { callNumber, outcome, merged, priorOutcomes } = input;

  if (outcome === "not_interested") return { kind: "lost", cause: "not_interested" };
  if (outcome === "wrong_number") return { kind: "lost", cause: "wrong_number" };

  if (requiredProgress(merged).complete) return { kind: "ready" };

  if (callNumber >= MAX_QUALIFICATION_CALLS) {
    const everSpoke = spoke(outcome) || priorOutcomes.some(spoke);
    return { kind: "lost", cause: everSpoke ? "information_missing" : "no_response" };
  }
  return { kind: "next", callNumber: (callNumber + 1) as 2 | 3 };
}

/** Words for the loss, written onto the transition so the reason is readable. */
export function lostNote(cause: LostCause): string {
  switch (cause) {
    case "not_interested":
      return "Said they are not interested on a qualification call.";
    case "wrong_number":
      return "The number reached the wrong person or does not work.";
    case "no_response":
      return "No response after three qualification calls.";
    case "information_missing":
      return "Three qualification calls made and the required answers were still not obtained.";
  }
}

/* ------------------------------------------------------------------ lost, in the desk's words */

/**
 * The desk's own six reasons for closing a lead, as it words them.
 *
 * NONE OF THESE IS A NEW CODE. `leads.lostReasons` is configuration and is not
 * this feature's to reword, so each entry is FILED UNDER one that already exists
 * (`filedAs`) and the desk's own sentence is written onto the transition beside
 * it. "No response after 3 attempts" and "Required information not obtained"
 * have no configured twin, so both file under `other` — which is what `other` is
 * for — and the wording is what tells them apart afterwards.
 */
export const DESK_LOST_REASONS: readonly { code: string; label: string; filedAs: string }[] = [
  { code: "no_response_3", label: "No response after 3 attempts", filedAs: "other" },
  { code: "info_not_obtained", label: "Required information not obtained", filedAs: "other" },
  { code: "not_interested", label: "Customer not interested", filedAs: "not_interested" },
  { code: "not_genuine", label: "Requirement not genuine", filedAs: "no_requirement" },
  { code: "wrong_lead", label: "Wrong lead — should not have been raised", filedAs: "wrong_lead" },
  { code: "other", label: "Other", filedAs: "other" },
] as const;

export function deskLostFiledAs(code: string): string | null {
  return DESK_LOST_REASONS.find((r) => r.code === code)?.filedAs ?? null;
}

/**
 * The desk's own label and the detail written beside it, taken back off a lost
 * transition's note (`<label> — <detail>`, which is how the desk writes it).
 *
 * A note that does not open with one of the six labels was not written by the
 * desk, and comes back as detail alone — the label is never guessed at.
 */
export function parseLostNote(note: string | null | undefined): { label: string | null; detail: string | null } {
  const n = (note ?? "").trim();
  if (!n) return { label: null, detail: null };
  for (const r of DESK_LOST_REASONS) {
    if (n === r.label) return { label: r.label, detail: null };
    if (n.startsWith(`${r.label} — `)) return { label: r.label, detail: n.slice(r.label.length + 3).trim() || null };
  }
  return { label: null, detail: n };
}

/** Which reason to pre-select, from how the calls went. */
export function suggestedLostCode(
  outcomes: readonly CallOutcome[],
  thisOutcome?: CallOutcome,
): string {
  if (thisOutcome === "not_interested") return "not_interested";
  if (thisOutcome === "wrong_number") return "wrong_lead";
  const everSpoke = outcomes.some(spoke) || (thisOutcome !== undefined && spoke(thisOutcome));
  return everSpoke ? "info_not_obtained" : "no_response_3";
}

/** Each cause the engine can end a lead on, in the desk's own code. */
export function lostCodeForCause(cause: LostCause): string {
  switch (cause) {
    case "not_interested":
      return "not_interested";
    case "wrong_number":
      return "wrong_lead";
    case "no_response":
      return "no_response_3";
    case "information_missing":
      return "info_not_obtained";
  }
}

/* ------------------------------------------------------------------ next action, as a type */

export type NextActionKind = "call" | "message";

/**
 * Whether a next action is a call or a message — DERIVED, because the schema
 * holds one sentence and a day and an owner and no type.
 *
 * A call is a sentence that opens "Call <n>", which is the only form the desk's
 * own dialogs write. That is a convention with one writer, and it is stated
 * here rather than hidden: a next action typed on some other screen has no
 * "Call n" in front of it and reads as a message. It errs towards the quieter
 * answer, which puts a lead in "Follow-ups due" rather than dropping it.
 */
export function nextActionKindOf(text: string | null | undefined): NextActionKind | null {
  if (!text || !text.trim()) return null;
  return /^\s*call\s*\d/i.test(text) ? "call" : "message";
}

/**
 * The next action's TYPE, as the panel says it.
 *
 * Decided by where the lead STANDS first and by the sentence only where the
 * phase leaves it open — "Call 2" written on a lead that is Ready is not a
 * phone call, it is stale text, and reading the type off the text alone drew
 * "Phone call" against a lead whose next act is asking for the Prospect.
 *
 *   ready / returned        Follow-up            (the desk has to act on it)
 *   requested / followup    Verification review  (it is with the manager)
 *   a working phase         Phone call, or Message (no call used)
 *   anything further on     the sentence decides, defaulting to Follow-up
 */
export function nextActionTypeLabel(
  phase: DeskPhase,
  kind: NextActionKind | null,
): string {
  if (phase === "ready" || phase === "returned") return "Follow-up";
  if (phase === "requested" || phase === "followup") return "Verification review";
  if (isWorking(phase) || phase === "exhausted") {
    return kind === "call" ? "Phone call" : "Message (no call used)";
  }
  return kind === "call" ? "Phone call" : "Follow-up";
}

/* ------------------------------------------------------------------ the desk's lists and tiles */

/**
 * Whether a lead's source is an online one — the desk's own leads, as opposed
 * to somebody a salesman found on foot.
 *
 * Matched on words rather than on the configured source codes, because the
 * column also holds every spelling the old sheets and imports typed
 * ("Website / Online Enquiry", "IndiaMART", "Google Ads") and a code list
 * would silently drop all of them.
 */
export function isOnlineSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return /website|web\b|online|whatsapp|indiamart|justdial|google|facebook|instagram|linkedin|email|portal|enquiry/i.test(
    source,
  );
}

export type DeskView =
  | "queue"
  | "all"
  | "new"
  | "today"
  | "followups"
  | "overdue"
  | "call1"
  | "call2"
  | "call3"
  | "ready"
  | "suspect"
  | "verify"
  | "requested"
  | "followup"
  | "returned"
  | "handed"
  | "prospect"
  | "qualification"
  | "sample_trial"
  | "sample_received"
  | "sample_review"
  | "sample"
  | "negotiation"
  | "orders"
  | "first_order"
  | "delivery"
  | "payment"
  | "second_order"
  | "customer"
  | "lost";

export const DESK_VIEW_LABEL: Record<DeskView, string> = {
  queue: "Today's work queue",
  all: "All leads",
  new: "New online leads",
  today: "Calls due today",
  followups: "Follow-ups due today",
  overdue: "Overdue",
  call1: "Call 1 pending",
  call2: "Call 2 pending",
  call3: "Call 3 pending",
  ready: "Ready for Prospect",
  suspect: "Suspects — calls, requests and returns",
  verify: "Verification queue",
  requested: "Awaiting Manager verification",
  followup: "Manager follow-up required",
  returned: "Returned by the Sales Manager",
  handed: "With the Sales Manager",
  prospect: "Prospects",
  qualification: "Qualification",
  sample_trial: "Sample / Trial",
  sample_received: "Sample Received",
  sample_review: "Sample Review",
  sample: "Sample / Trial and review",
  negotiation: "Negotiation",
  orders: "Orders and customers",
  first_order: "1st Order",
  delivery: "Delivery",
  payment: "Payment",
  second_order: "2nd Order",
  customer: "Customers",
  lost: "Lost",
};

export function isDeskView(v: unknown): v is DeskView {
  return typeof v === "string" && v in DESK_VIEW_LABEL;
}

export type DeskLeadFacts = {
  phase: DeskPhase;
  callCount: number;
  source: string | null;
  /** The next action's day, where one is set. */
  nextActionDate: string | null;
  nextActionKind: NextActionKind | null;
  /** Whether the desk has ever asked for this one to be a Prospect. */
  requested: boolean;
};

/**
 * The day something is owed, for a lead still being worked.
 *
 * A lead nobody has rung and nobody has scheduled is owed its first call TODAY:
 * an online lead arrives with no next action at all, and treating "nothing
 * scheduled" as "nothing due" would keep every fresh lead off the day's queue
 * until somebody remembered to give it a date.
 */
function dueDay(l: DeskLeadFacts, day: string): string | null {
  if (!isWorking(l.phase)) return null;
  if (l.nextActionDate) return l.nextActionDate;
  return l.phase === "call1" ? day : null;
}

function dueKind(l: DeskLeadFacts): NextActionKind | null {
  return l.nextActionKind ?? (l.phase === "call1" && l.callCount === 0 ? "call" : null);
}

/**
 * Whether a lead belongs in a view.
 *
 * ONE definition shared by the tile's number and the list behind it, so a tile
 * that says 14 opens a list of 14. The counts are taken by running this over
 * the same rows the list draws.
 */
export function inView(l: DeskLeadFacts, view: DeskView, day: string): boolean {
  const due = dueDay(l, day);
  switch (view) {
    case "queue":
      return l.phase === "ready" || l.phase === "returned" || (due !== null && due <= day);
    case "all":
      return true;
    case "new":
      return l.phase === "call1" && l.callCount === 0 && isOnlineSource(l.source);
    case "today":
      return due === day && dueKind(l) === "call";
    case "followups":
      return due === day && dueKind(l) === "message";
    case "overdue":
      return due !== null && due < day;
    case "suspect":
      return (
        isWorking(l.phase) ||
        l.phase === "ready" ||
        l.phase === "exhausted" ||
        l.phase === "requested" ||
        l.phase === "followup" ||
        l.phase === "returned"
      );
    case "verify":
      return l.phase === "requested" || l.phase === "followup";
    case "handed":
      return l.requested && l.phase !== "lost";
    case "sample":
      return (
        l.phase === "sample_trial" || l.phase === "sample_received" || l.phase === "sample_review"
      );
    case "orders":
      return (
        l.phase === "first_order" ||
        l.phase === "delivery" ||
        l.phase === "payment" ||
        l.phase === "second_order" ||
        l.phase === "customer"
      );
    default:
      return l.phase === view;
  }
}

/**
 * The sentence a next action is written as, so the type can be read back off it.
 *
 * `nextActionKindOf` reads a call as "Call <n>" at the front, so the desk's
 * dialogs — the only writers — put it there: a call is always "Call 2 — …", and
 * a message is never allowed to open with one.
 */
export function nextActionText(kind: NextActionKind, callNumber: number, text: string): string {
  const t = text.trim();
  if (kind === "call") {
    return /^\s*call\s*\d/i.test(t) ? t : `Call ${callNumber} — ${t || "the remaining questions"}`;
  }
  const stripped = t.replace(/^\s*call\s*\d+\s*[—–:-]?\s*/i, "");
  return stripped ? stripped : "Send information on WhatsApp, then ring back";
}
