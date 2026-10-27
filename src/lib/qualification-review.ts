/* ---------------------------------------------------------------------------
 * THE UNIFIED QUALIFICATION REVIEW — the rules that do not need a database.
 *
 * The designated approver reads the Suspect answers, the Prospect answers and
 * the Qualification checklist on ONE screen. Nothing here is a new
 * questionnaire: the three question sets are `DESK_FIELDS`, `PROSPECT_CONDITIONS`
 * and `checklistFor(..., "qualification")`, every answer lives where the Calling
 * Desk, the Sales Manager pipeline and the Qualify screen already put it, and
 * whether a question is ANSWERED is the gate's own verdict (`gateTo`), handed in
 * — never a second reading of the same columns.
 *
 * What this file owns is the part those do not: WHICH of those answers the
 * approver may change from the review, and how a change is described for the
 * audit trail. It is pure and client-safe because the screen draws the same list
 * the server action allows — a control offered for a field the action then
 * refuses is a save that loses what somebody typed.
 * ------------------------------------------------------------------------- */

import { DESK_FIELDS, isAnswered, type DeskFieldKey } from "./engines/lead-calling-desk";
import { displayAnswer } from "./calling-desk-labels";
import type { LeadSalesType } from "./lead-labels";
import {
  checklistFor,
  gateTo,
  PROSPECT_CONDITIONS,
  QUALIFICATION_ANSWER_KEYS,
  qualificationComplete,
  type LeadGateInput,
} from "./engines/lead-gates";
import { QUALIFICATION_ONLY_FIELDS } from "./lead-qualification-access";

/** The three question sets, in the order a lead meets them. */
export type ReviewSection = "suspect" | "prospect" | "qualification";

export const SECTION_TITLE: Record<ReviewSection, string> = {
  suspect: "Suspect — Calling Desk answers",
  prospect: "Prospect — Sales Manager verification answers",
  qualification: "Qualification — the Salesman's checklist",
};

/**
 * The columns an approver can change from the review, and ONLY these — each is
 * a key of the existing `saveProspectFields` schema, so the validation that
 * governs the Calling Desk and the Qualify screen governs this too.
 *
 * Deliberately absent: the sales type and the next action (they move the lead
 * rather than answer for it), the GST VERIFICATION (the Sales Manager's own act,
 * made elsewhere), `potentialPaise` (no longer a question anywhere), and
 * `address` / `email` (the Calling Desk's own writes).
 */
export const PROSPECT_EDIT_KEYS = [
  "customerType",
  "monthlyLitres",
  "competitor",
  "requiredProductId",
  "contactPerson",
  "decisionMaker",
  "creditDaysWanted",
  "application",
  "buyer",
  "gstin",
] as const;
export type ProspectEditKey = (typeof PROSPECT_EDIT_KEYS)[number];

/** The answers Qualification keeps in `lead_qualification` (jsonb), exactly as the gate names them. */
export type AnswerKey = (typeof QUALIFICATION_ANSWER_KEYS)[number];

/** The four columns the CRM says only the lead's COLLECTOR writes (`saveProspectFields` refuses the Sales Manager them). */
const QUALIFICATION_ONLY = new Set<string>(QUALIFICATION_ONLY_FIELDS);

/** Is this edit one the CRM keeps for the Salesman who collects? Every jsonb answer is; four columns are. */
export function isCollectorEdit(key: string): boolean {
  return QUALIFICATION_ONLY.has(key) || (QUALIFICATION_ANSWER_KEYS as readonly string[]).includes(key);
}

/** What an approver sends. Every key optional; nothing here is a verdict. */
export type ReviewEdits = {
  fields?: Partial<Record<ProspectEditKey, string | number | null>>;
  answers?: Partial<Record<AnswerKey, string>>;
};

export type SplitEdits = {
  fields: Partial<Record<ProspectEditKey, string | number | null>>;
  answers: Partial<Record<AnswerKey, string>>;
  /** Names the caller sent that this review does not edit. Refused, never dropped. */
  refused: string[];
};

const FIELD_SET = new Set<string>(PROSPECT_EDIT_KEYS);
const ANSWER_SET = new Set<string>(QUALIFICATION_ANSWER_KEYS);

/**
 * Separate what may be written from what may not. A name outside both lists is
 * REPORTED, not silently skipped: a request naming `leadStage` or
 * `leadQualificationReview` is not a typo, and the action refuses the whole
 * request rather than saving the half it recognises.
 */
export function splitEdits(edits: ReviewEdits | null | undefined): SplitEdits {
  const out: SplitEdits = { fields: {}, answers: {}, refused: [] };
  for (const [k, v] of Object.entries(edits?.fields ?? {})) {
    if (FIELD_SET.has(k)) (out.fields as Record<string, unknown>)[k] = v;
    else out.refused.push(k);
  }
  for (const [k, v] of Object.entries(edits?.answers ?? {})) {
    if (ANSWER_SET.has(k)) (out.answers as Record<string, unknown>)[k] = v;
    else out.refused.push(k);
  }
  for (const k of Object.keys(edits ?? {})) {
    if (k !== "fields" && k !== "answers") out.refused.push(k);
  }
  return out;
}

/* ------------------------------------------------------------------ audit */

/** A GST number is a public register entry and still an identifier; the audit shows THAT it changed, not the whole number. */
export function maskGstin(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (s.length <= 6) return "•".repeat(s.length);
  return `${s.slice(0, 2)}${"•".repeat(s.length - 5)}${s.slice(-3)}`;
}

const AUDIT_TEXT_MAX = 200;

export function auditValue(field: string, v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  if (field === "gstin") return maskGstin(String(v));
  if (typeof v === "string") return v.trim().slice(0, AUDIT_TEXT_MAX);
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v).slice(0, AUDIT_TEXT_MAX);
}

/** Two stored answers are the same answer: blank is blank, numbers are numbers. */
export function sameValue(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) =>
    v === null || v === undefined || v === false || (typeof v === "string" && v.trim() === "");
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

export type FieldChange = {
  field: string;
  label: string;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
};

/** The labels the audit and the history use. Filled in below from the same specs the screen draws. */
export const FIELD_LABEL: Record<string, string> = {};

/**
 * The fields among `names` whose value differs between two snapshots. The
 * snapshots are READ BACK from the lead — before the writers run and after — so
 * the audit says what the database now holds, not what the request asked for.
 */
export function diffAnswers(
  names: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of names) {
    if (sameValue(before[field], after[field])) continue;
    out.push({
      field,
      label: FIELD_LABEL[field] ?? field,
      from: auditValue(field, before[field]),
      to: auditValue(field, after[field]),
    });
  }
  return out;
}

/** The audit action every approver edit is filed under. */
export const REVIEW_EDIT_ACTION = "lead.qualificationReview.edit";

/* ------------------------------------------------------------ the boxes */

export type ReviewKind = "text" | "long" | "litres" | "days" | "choice" | "product" | "yesno" | "date" | "info";

const YESNO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

/** One box on a row. A row has one, or several where a Qualification question is answered in parts. */
export type ReviewField = {
  /** The key it edits — a column of `saveProspectFields` or a jsonb answer key. */
  id: string;
  label?: string;
  hint?: string;
  kind: ReviewKind;
  value: string | number | null;
  display: string;
  /** What `saveProspectFields` / `saveLeadQualification` takes; null = read only here. */
  editKey: ProspectEditKey | AnswerKey | null;
  /** Why it is read only, said in words. */
  readOnlyReason?: string;
  /** This answer is the same stored answer as an earlier box; edit it there. */
  sameAs?: string;
  options?: readonly { value: string; label: string }[];
};

export type ReviewRow = {
  /** `<section>:<id>`. */
  key: string;
  section: ReviewSection;
  /** The question's own id (a desk key or a condition id). */
  id: string;
  label: string;
  hint?: string;
  /** Answered, by the gate's own reading — not by this file's. */
  answered: boolean;
  required: boolean;
  fields: ReviewField[];
};

type Spec = {
  id: ProspectEditKey | AnswerKey;
  kind: ReviewKind;
  label?: string;
  hint?: string;
  options?: readonly { value: string; label: string }[];
};

/**
 * The boxes of each Qualification question — copied word for word from the
 * Qualify screen's own field map (`SHOP_FIELDS`), which is a client component
 * and so cannot be read from here. `qualification-review.test` reads that file
 * as text and fails if a label or key here drifts from it.
 */
export const QUALIFICATION_FIELDS: Record<string, Spec[]> = {
  gst_verified: [{ id: "gstin", kind: "text", hint: "15 characters, as printed. Changing it clears any validation." }],
  application_understood: [{ id: "application", kind: "long", hint: "What they will use it on." }],
  trial_plan: [
    { id: "trial_product", kind: "text", label: "Product", hint: "What we are sending for the trial" },
    { id: "trial_pack", kind: "text", label: "Pack size", hint: "For example 20 L" },
    { id: "trial_quantity", kind: "text", label: "Sample quantity", hint: "For example 2 cans" },
    { id: "trial_tester", kind: "text", label: "Who will test it" },
    { id: "trial_duration", kind: "text", label: "Expected trial duration", hint: "For example 7 days" },
  ],
  people_identified: [
    { id: "decisionMaker", kind: "text", label: "Who decides" },
    { id: "decision_maker_phone", kind: "text", label: "Their phone (optional)" },
    { id: "buyer", kind: "text", label: "Who places the order", hint: "Leave empty and answer yes below if it is the same person" },
    { id: "buyer_same", kind: "yesno", label: "Is the buyer the same person as the decision maker?" },
    { id: "buyer_phone", kind: "text", label: "Buyer's phone (optional)" },
    { id: "payer", kind: "text", label: "Who pays", hint: "Leave empty and answer yes below if it is the same person" },
    { id: "payer_same", kind: "yesno", label: "Is the payer the same person as the decision maker?" },
    { id: "payer_phone", kind: "text", label: "Payer's phone (optional)" },
  ],
  price_and_credit: [
    { id: "price_range", kind: "text", label: "Price or range discussed" },
    { id: "creditDaysWanted", kind: "days", label: "Credit days requested", hint: "Days, 0 to 365" },
    {
      id: "price_reaction",
      kind: "choice",
      label: "How they took it",
      options: [
        { value: "accepted", label: "Accepted" },
        { value: "negotiating", label: "Negotiating" },
        { value: "objecting", label: "Objecting" },
      ],
    },
  ],
  delivery_workable: [
    { id: "delivery_location", kind: "text", label: "Where we deliver" },
    { id: "delivery_lead_time", kind: "text", label: "Lead time we quoted", hint: "For example 3 days" },
    { id: "delivery_suits", kind: "yesno", label: "Does that timing suit them?" },
  ],
  willing_to_test: [
    { id: "willing_to_test", kind: "yesno", label: "Will they still test it?", hint: "Ask this after price, credit and delivery. Only a yes passes." },
  ],
  next_step_dated: [
    { id: "next_step", kind: "long", label: "What happens if the trial goes well" },
    { id: "next_step_date", kind: "date", label: "By when" },
  ],
};

/** The Calling Desk's own columns, by desk key — the ones the review can edit. */
export const DESK_EDITABLE: Partial<Record<DeskFieldKey, ProspectEditKey>> = {
  customerType: "customerType",
  decisionMaker: "decisionMaker",
  buyer: "buyer",
  gstin: "gstin",
  monthlyLitres: "monthlyLitres",
  creditDaysWanted: "creditDaysWanted",
  requiredProductId: "requiredProductId",
  competitor: "competitor",
  application: "application",
};

for (const f of DESK_FIELDS) {
  const k = DESK_EDITABLE[f.key];
  if (k) FIELD_LABEL[k] = f.label;
}
FIELD_LABEL.contactPerson = "Contact person";
for (const specs of Object.values(QUALIFICATION_FIELDS)) {
  for (const s of specs) if (s.label && !FIELD_LABEL[s.id]) FIELD_LABEL[s.id] = s.label;
}

/* ------------------------------------------------------------ the three lists */

/** Everything the three lists read, already fetched. No I/O below this line. */
export type ReviewSource = {
  salesType: LeadSalesType | null;
  customerType: string | null;
  decisionMaker: string | null;
  buyer: string | null;
  gstin: string | null;
  gstVerified: boolean;
  monthlyLitres: number | null;
  creditDaysWanted: number | null;
  requiredProductId: string | null;
  requiredProductName: string | null;
  competitor: string | null;
  application: string | null;
  contactPerson: string | null;
  address: string | null;
  email: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  /** The reason the lead was made a Prospect, already worded; null = none recorded. */
  prospectReason: string | null;
  /** `lead_qualification` — the jsonb the Qualification answers live in. */
  qualification: Record<string, boolean | string> | null;
  /** The gate's own verdict: ids of the Prospect / Qualification questions still unmet. */
  unmetProspect: ReadonlySet<string>;
  unmetQualification: ReadonlySet<string>;
};

export type ReviewContext = {
  /** The viewer is the lead's designated approver and Qualification is open. */
  editable: boolean;
  /** Where the CRM keeps Qualification answers for the collector, the sentence to say so. */
  collectorOnlyReason: string | null;
};

const NOT_APPROVER = "Only the lead's designated approver can change an answer here.";

function textOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const ANSWER_DISPLAY: Record<string, string> = { yes: "Yes", no: "No" };

/**
 * The review's rows: every Suspect question, every Prospect question and every
 * Qualification question, each with the answers already saved, in the order the
 * lead met them.
 *
 * ONE STORED ANSWER IS EDITED IN ONE PLACE. The Calling Desk's "Product" and the
 * Prospect's "Which of our products do they need?" are the same column; a box on
 * each would let two edits disagree before either is saved. The later box still
 * shows the answer and says where it is edited.
 *
 * AND NOTHING IS OFFERED THAT THE CRM WOULD REFUSE. The Sales Manager reviews a
 * Qualification, the Salesman collects it: `saveProspectFields` and
 * `saveLeadQualification` both refuse the Sales Manager the GST number,
 * application, credit days, buyer and every Qualification answer. Those boxes
 * are drawn read-only with that sentence — never worked around.
 */
export function buildReviewRows(src: ReviewSource, ctx: ReviewContext): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const editedAt = new Map<string, string>();

  /** Decide one box's editability, once, for every section. */
  const settle = (id: string, label: string): Pick<ReviewField, "editKey" | "readOnlyReason" | "sameAs"> => {
    const earlier = editedAt.get(id);
    if (earlier) return { editKey: null, sameAs: earlier, readOnlyReason: `Same answer as “${earlier}” — change it there.` };
    editedAt.set(id, label);
    if (!ctx.editable) return { editKey: null, readOnlyReason: NOT_APPROVER };
    if (isCollectorEdit(id) && ctx.collectorOnlyReason) {
      return { editKey: null, readOnlyReason: ctx.collectorOnlyReason };
    }
    return { editKey: id as ProspectEditKey | AnswerKey };
  };

  const columnValue = (id: string): string | number | null => {
    switch (id) {
      case "customerType": return src.customerType;
      case "decisionMaker": return src.decisionMaker;
      /* The handset cannot write the `lead_buyer` column, so a buyer a Salesman
         named there lives in `buyer_name`; the gate counts either, so the review
         shows either rather than an empty box beside an answered question. */
      case "buyer": return src.buyer ?? (textOf(src.qualification?.buyer_name) || null);
      case "gstin": return src.gstin;
      case "monthlyLitres": return src.monthlyLitres;
      case "creditDaysWanted": return src.creditDaysWanted;
      case "requiredProductId": return src.requiredProductId;
      case "competitor": return src.competitor;
      case "application": return src.application;
      case "contactPerson": return src.contactPerson;
      case "address": return src.address;
      case "email": return src.email;
      default: return textOf(src.qualification?.[id]) || null;
    }
  };

  const displayOf = (id: string, kind: ReviewKind, value: string | number | null): string => {
    if (value === null || value === "") return "—";
    if (id === "gstin") return displayAnswer("gstin", String(value), null, src.gstVerified);
    if (id === "requiredProductId") return src.requiredProductName ?? "Chosen";
    if (kind === "yesno") return ANSWER_DISPLAY[String(value)] ?? String(value);
    if (id === "monthlyLitres" || id === "creditDaysWanted" || id === "customerType") {
      return displayAnswer(id as DeskFieldKey, value, src.requiredProductName, src.gstVerified);
    }
    if (kind === "choice") {
      const spec = Object.values(QUALIFICATION_FIELDS).flat().find((s) => s.id === id);
      return spec?.options?.find((o) => o.value === value)?.label ?? String(value);
    }
    return String(value);
  };

  /* SUSPECT — the Calling Desk's eleven. */
  for (const f of DESK_FIELDS) {
    const v = columnValue(f.key);
    const wants = DESK_EDITABLE[f.key] ?? null;
    const base: Pick<ReviewField, "editKey" | "readOnlyReason" | "sameAs"> = wants
      ? settle(wants, f.label)
      : { editKey: null, readOnlyReason: "Edited from the Calling Desk, not from the review." };
    rows.push({
      key: `suspect:${f.key}`,
      section: "suspect",
      id: f.key,
      label: f.label,
      hint: f.hint,
      answered: isAnswered(f.key, v),
      required: f.required,
      fields: [
        {
          id: f.key,
          kind: (f.kind === "money" ? "text" : f.kind) as ReviewKind,
          value: v,
          display: displayAnswer(f.key, v, src.requiredProductName, src.gstVerified),
          options: f.options,
          ...base,
        },
      ],
    });
  }

  /* PROSPECT — the seven conditions the Sales Manager verifies. */
  const PROSPECT_FIELD: Record<string, ProspectEditKey> = {
    customer_type: "customerType",
    monthly_litres: "monthlyLitres",
    competitor: "competitor",
    required_product: "requiredProductId",
    contact_person: "contactPerson",
  };
  for (const c of PROSPECT_CONDITIONS) {
    const answered = !src.unmetProspect.has(c.id);
    const head = { key: `prospect:${c.id}`, section: "prospect" as const, id: c.id, label: c.says, answered, required: true };
    if (c.id === "next_action") {
      const text = src.nextAction?.trim();
      rows.push({
        ...head,
        fields: [{
          id: "next_action",
          kind: "info",
          value: text || null,
          display: text ? `${text}${src.nextActionDate ? ` — ${src.nextActionDate}` : ""}` : "—",
          editKey: null,
          readOnlyReason: "Set from the lead's next action, which moves as the lead is worked.",
        }],
      });
      continue;
    }
    if (c.id === "prospect_reason") {
      rows.push({
        ...head,
        fields: [{
          id: "prospect_reason",
          kind: "info",
          value: src.prospectReason,
          display: src.prospectReason ?? "—",
          editKey: null,
          readOnlyReason: "Recorded when the lead became a Prospect; it is history, not an answer to change.",
        }],
      });
      continue;
    }
    const col = PROSPECT_FIELD[c.id];
    const v = columnValue(col);
    const desk = DESK_FIELDS.find((d) => d.key === (col as DeskFieldKey));
    const kind: ReviewKind =
      col === "monthlyLitres" ? "litres" : col === "requiredProductId" ? "product" : col === "customerType" ? "choice" : "text";
    rows.push({
      ...head,
      fields: [{ id: col, kind, value: v, display: displayOf(col, kind, v), options: desk?.options, ...settle(col, c.says) }],
    });
  }

  /* QUALIFICATION — the checklist for this lead's sales type. */
  const conditions = checklistFor(src.salesType, "qualification");
  if (src.salesType === "distributor") {
    for (const c of conditions) {
      const answered = !src.unmetQualification.has(c.id);
      rows.push({
        key: `qualification:${c.id}`,
        section: "qualification",
        id: c.id,
        label: c.says,
        answered,
        required: true,
        fields: [{
          id: c.id,
          kind: "info",
          value: null,
          display: answered ? "On the record" : "—",
          editKey: null,
          readOnlyReason: "A distributor appointment is reviewed against the distributor profile, not here.",
        }],
      });
    }
    return rows;
  }

  for (const c of conditions) {
    const specs = QUALIFICATION_FIELDS[c.id] ?? [];
    rows.push({
      key: `qualification:${c.id}`,
      section: "qualification",
      id: c.id,
      label: c.says,
      answered: !src.unmetQualification.has(c.id),
      required: true,
      fields: specs.map((s) => {
        const v = columnValue(s.id);
        return {
          id: s.id,
          label: s.label,
          hint: s.hint,
          kind: s.kind,
          value: v,
          display: displayOf(s.id, s.kind, v),
          options: s.kind === "yesno" ? YESNO : s.options,
          ...settle(s.id, s.label ?? c.says),
        };
      }),
    });
  }
  return rows;
}

/** The numbers over the top of the screen. */
export function reviewTally(rows: readonly ReviewRow[]) {
  const missingRequired = rows.filter((r) => r.required && !r.answered);
  const missingOptional = rows.filter((r) => !r.required && !r.answered);
  return {
    total: rows.length,
    answered: rows.filter((r) => r.answered).length,
    missingRequired: missingRequired.length,
    missingOptional: missingOptional.length,
  };
}

/* ------------------------------------------------------------------ confirm */

/**
 * What still stands between a Qualification and a Confirm — the SAME test
 * `reviewLeadQualification` applies (`qualificationComplete`, and where it fails
 * the gate's own missing list less the two things the review itself decides),
 * returned in words so the screen and the refusal say one thing.
 */
export function confirmBlockers(gate: LeadGateInput): string[] {
  if (qualificationComplete(gate)) return [];
  const missing = gateTo(gate, "sample_trial").missing.filter(
    (c) => !c.id.startsWith("manager_review") && c.id !== "next_action",
  );
  return missing.length ? missing.map((c) => c.says) : ["The Qualification is not complete."];
}

/** The ids the gate says are unmet at a target rung — what the rows' "answered" is read from. */
export function unmetAt(gate: LeadGateInput, to: "prospect" | "sample_trial"): Set<string> {
  return new Set(gateTo(gate, to).missing.map((c) => c.id));
}
