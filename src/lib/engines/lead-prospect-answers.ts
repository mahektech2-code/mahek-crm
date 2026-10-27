/* ---------------------------------------------------------------------------
 * THE SEVEN ANSWERS A SUSPECT MUST HAVE BEFORE IT IS A PROSPECT — and what
 * makes each of them an answer rather than a blank that looks like one.
 *
 * `PROSPECT_CONDITIONS` in `lead-gates.ts` names the same seven and asks only
 * whether each is PRESENT, with a `has()` that calls any finite number an
 * answer — so zero litres, a one-letter competitor and a contact person typed
 * as "-" all passed it. This is the stricter reading, and it is the ONE reading:
 * the dialog draws its field errors from it, the server action refuses on it,
 * and `evaluateLeadStageMove` refuses on it for every other door (the stage
 * button, the verification, the handset), so no route can accept what another
 * would turn away.
 *
 * Pure: no I/O, the business date arrives as an argument, and nothing here
 * imports the database — the browser runs this file.
 *
 * A VALUE ALREADY ON THE RECORD COUNTS, so nobody retypes what they gave on a
 * call; what the record holds only counts while it is VALID. An invalid stored
 * value can be replaced by the one the dialog supplies, and is never silently
 * accepted just because it exists.
 * ------------------------------------------------------------------------- */

export const PROSPECT_CUSTOMER_TYPES = [
  { value: "dealer", label: "Dealer" },
  { value: "manufacturer", label: "Manufacturer" },
  { value: "distributor", label: "Distributor" },
  { value: "retailer", label: "Retailer" },
  { value: "private_limited_user", label: "Private Limited(User)" },
] as const;

export type ProspectAnswerField =
  | "customerType"
  | "monthlyLitres"
  | "competitor"
  | "requiredProductId"
  | "contactPerson"
  | "nextAction"
  | "nextActionDate"
  | "reasonCode";

/** The seven, in the order the gate lists them. `id` is the gate condition's own. */
export const PROSPECT_ANSWERS: readonly { id: string; field: ProspectAnswerField; label: string }[] = [
  { id: "customer_type", field: "customerType", label: "Business type" },
  { id: "monthly_litres", field: "monthlyLitres", label: "Monthly requirement (litres)" },
  { id: "competitor", field: "competitor", label: "Competitor" },
  { id: "required_product", field: "requiredProductId", label: "Product" },
  { id: "contact_person", field: "contactPerson", label: "Contact person" },
  { id: "next_action", field: "nextAction", label: "Next action" },
  { id: "prospect_reason", field: "reasonCode", label: "Reason" },
] as const;

export type ProspectAnswers = {
  customerType: string | null;
  monthlyLitres: number | string | null;
  competitor: string | null;
  requiredProductId: string | null;
  contactPerson: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  reasonCode: string | null;
};

export type ProspectFault = {
  /** The form field, which is also what a server `FieldError` names. */
  field: ProspectAnswerField;
  message: string;
};

export const MAX_LITRES = 10_000_000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Absent, or a string with nothing in it. A NUMBER is never blank: zero is a wrong answer, not a missing one. */
const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function litresOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A real calendar day, spelled YYYY-MM-DD. `2026-02-31` is not one. */
function isRealDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m! - 1 && t.getUTCDate() === d;
}

export type FaultOptions = {
  /** The business date, `YYYY-MM-DD`. Only read when `requireFutureDate` is set. */
  today?: string;
  /** Codes from `leads.prospectReasons`. Absent, any non-blank code passes. */
  reasonCodes?: readonly string[];
  /**
   * A next-action date somebody TYPES must not be in the past. One already on
   * the record may be overdue — that is a lead somebody has not got round to,
   * not an unanswered question — so the caller says which this is.
   */
  requireFutureDate?: boolean;
};

/** The fault for one field, or null where it is a valid answer. */
export function faultFor(
  field: ProspectAnswerField,
  a: ProspectAnswers,
  o: FaultOptions,
): ProspectFault | null {
  const bad = (message: string): ProspectFault => ({ field, message });
  switch (field) {
    case "customerType": {
      const v = str(a.customerType);
      if (!v) return bad("Say what kind of business this is.");
      return PROSPECT_CUSTOMER_TYPES.some((t) => t.value === v) ? null : bad("Pick one of the listed business types.");
    }
    case "monthlyLitres": {
      const n = litresOf(a.monthlyLitres);
      if (isBlank(a.monthlyLitres)) {
        return bad("How many litres a month do they use?");
      }
      if (n === null) return bad("Monthly litres must be a number.");
      if (n <= 0) return bad("Monthly litres must be more than zero.");
      return n > MAX_LITRES ? bad("That is more litres a month than is believable. Check the figure.") : null;
    }
    case "competitor": {
      const v = str(a.competitor);
      if (!v) return bad("Which brand are they using now?");
      if (v.length < 2) return bad("Write the brand's name, not a single letter.");
      return v.length > 200 ? bad("Keep the brand name under 200 characters.") : null;
    }
    case "requiredProductId": {
      return str(a.requiredProductId) ? null : bad("Which of our products do they need?");
    }
    case "contactPerson": {
      const v = str(a.contactPerson);
      if (!v) return bad("Who should we ask for when we call?");
      if (v.length < 2 || !/\p{L}/u.test(v)) return bad("Write the contact person's name.");
      return v.length > 200 ? bad("Keep the name under 200 characters.") : null;
    }
    case "nextAction": {
      const v = str(a.nextAction);
      if (!v) return bad("What happens next?");
      if (v.length < 3) return bad("Say what the next step is, in a few words.");
      return v.length > 300 ? bad("Keep the next step under 300 characters.") : null;
    }
    case "nextActionDate": {
      const v = str(a.nextActionDate);
      if (!v) return bad("When does it happen?");
      if (!isRealDay(v)) return bad("Give the day as a real date.");
      return o.requireFutureDate && o.today && v < o.today ? bad("The next step cannot be in the past. Pick today or a later day.") : null;
    }
    case "reasonCode": {
      const v = str(a.reasonCode);
      if (!v) return bad("Say why this lead is worth following up.");
      return o.reasonCodes && !o.reasonCodes.includes(v) ? bad("Pick one of the listed reasons.") : null;
    }
  }
}

/** Every fault, in the gate's order. Empty means all seven are valid answers. */
export function prospectAnswerFaults(a: ProspectAnswers, o: FaultOptions): ProspectFault[] {
  const order: ProspectAnswerField[] = [
    "customerType",
    "monthlyLitres",
    "competitor",
    "requiredProductId",
    "contactPerson",
    "nextAction",
    "nextActionDate",
    "reasonCode",
  ];
  return order.map((f) => faultFor(f, a, o)).filter((f): f is ProspectFault => f !== null);
}

export type MergedAnswers = {
  merged: ProspectAnswers;
  /** What the dialog supplied that the record did not already hold validly. */
  write: Partial<ProspectAnswers>;
};

const FIELDS: ProspectAnswerField[] = [
  "customerType",
  "monthlyLitres",
  "competitor",
  "requiredProductId",
  "contactPerson",
  "nextAction",
  "nextActionDate",
  "reasonCode",
];

/**
 * Record first, dialog second.
 *
 * A stored value that is VALID wins and is never overwritten (the same rule the
 * conversion already keeps for a business type and a contact: it never replaces
 * what somebody gave). A stored value that is blank or invalid yields to what
 * the dialog supplied. The next step is one answer in two parts, so it is
 * decided as a pair: a half-stored pair does not count and a typed pair replaces
 * it whole. The reason is never on the record — it belongs to this act.
 */
export function mergeProspectAnswers(
  record: Partial<ProspectAnswers>,
  supplied: Partial<ProspectAnswers>,
  o: FaultOptions,
): MergedAnswers {
  const blank: ProspectAnswers = {
    customerType: null,
    monthlyLitres: null,
    competitor: null,
    requiredProductId: null,
    contactPerson: null,
    nextAction: null,
    nextActionDate: null,
    reasonCode: null,
  };
  const rec: ProspectAnswers = { ...blank, ...record, reasonCode: null };
  const sup: ProspectAnswers = { ...blank, ...supplied };
  const merged: ProspectAnswers = { ...rec };
  const write: Partial<ProspectAnswers> = {};

  const recordNextOk =
    faultFor("nextAction", rec, o) === null &&
    faultFor("nextActionDate", rec, { ...o, requireFutureDate: false }) === null;

  for (const f of FIELDS) {
    if (f === "nextAction" || f === "nextActionDate") continue;
    const recordOk = f !== "reasonCode" && faultFor(f, rec, o) === null;
    if (recordOk) continue;
    const given = sup[f];
    if (!isBlank(given)) {
      (merged as Record<string, unknown>)[f] = given;
      (write as Record<string, unknown>)[f] = given;
    }
  }

  if (!recordNextOk) {
    const typedAny = str(sup.nextAction) !== "" || str(sup.nextActionDate) !== "";
    if (typedAny) {
      merged.nextAction = sup.nextAction;
      merged.nextActionDate = sup.nextActionDate;
      write.nextAction = sup.nextAction;
      write.nextActionDate = sup.nextActionDate;
    }
  }
  return { merged, write };
}
