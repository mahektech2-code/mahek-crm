import type { WorkingDayConfig } from "@/lib/business-date";
import { datedFrom, type DatedField } from "@/lib/engines/call-intel-decide";
import { checkGstin, gstState, pickNumbers, tidy, type GstinCheck } from "@/lib/engines/lead-scan";
import type { LeadVoiceReadingParsed } from "@/lib/lead-voice-schema";

/* ---------------------------------------------------------------------------
 * WHAT A SALESMAN SAID ABOUT A SHOP, made safe to put in the New lead form.
 *
 * He stands outside the shop and talks — for two minutes if he likes, in
 * Marathi with English product names dropped in — and the model reads that
 * into the form's sixteen answers (`lead-voice-service.ts`). What comes back
 * is a reading, and this is where it is turned into values the form can hold.
 * PURE, like every engine: the rules that decide what reaches a salesman's
 * form are tested here without a model, a phone or a key.
 *
 * The card scan's rules apply unchanged, because they are about the VALUES,
 * not about how they arrived: only a number called a mobile becomes the
 * mobile, a GSTIN is judged by its checksum and repaired only where the format
 * forces it, and "N/A" is null. What speech adds is three more kinds of value
 * a model can get wrong in a way that looks right:
 *
 *   1. A CHOICE OFF A LIST. The kind of sale, how he found them and what kind
 *      of business are codes from lists the office owns. A code not on the
 *      list is dropped and SAID — a form that silently shows nothing selected
 *      reads as the model having heard nothing.
 *
 *   2. A DATE. The model reports the cue ("parso", "next Monday") and
 *      `datedFrom` does the arithmetic against the working week, exactly as
 *      the call and visit assistants do. Where the words could mean two days
 *      both are offered and neither is filled.
 *
 *   3. A NUMBER WITH A UNIT. Rupees a month and litres a month. A figure that
 *      is not a positive whole number, or is past any shop this company has
 *      ever sold to, is a mishearing ("forty" heard as "four lakh") and is
 *      dropped with a line saying what was heard.
 * ------------------------------------------------------------------------- */

/* The ceilings past which a figure is a mishearing rather than a shop. Ten
   crore a month and a million litres a month are both far beyond the largest
   account on the book; they exist to catch an extra zero, not to judge. */
const MAX_POTENTIAL_RUPEES = 100_000_000;
const MAX_LITRES = 1_000_000;

export type LeadVoiceContext = {
  today: string;
  working: WorkingDayConfig;
  /** The codes the form offers — anything else is not an answer. */
  salesTypes: { code: string; label: string }[];
  sources: { code: string; label: string }[];
  customerTypes: { code: string; label: string }[];
  /** The code that asks a second question. */
  otherSource: string;
};

/** What the handset is sent. Every field may be null; none is a guess. */
export type LeadVoiceResult = {
  salesType: string | null;
  businessName: string | null;
  contactPerson: string | null;
  mobile: string | null;
  otherNumbers: string[];
  gstin: string | null;
  gstinCheck: GstinCheck | null;
  city: string | null;
  state: string | null;
  address: string | null;
  source: string | null;
  sourceDetail: string | null;
  potentialRupees: number | null;
  /** A date only where the words named exactly one working day. */
  followUp: DatedField | null;
  customerType: string | null;
  requirement: string | null;
  monthlyLitres: number | null;
  decisionMaker: string | null;
  competitor: string | null;
  /** Things to check — what the model was unsure of, and what was refused. */
  questions: string[];
};

/** A code off one of the office's lists — matched on the code, then the label. */
function pick(
  said: string | null | undefined,
  list: { code: string; label: string }[],
): { code: string | null; refused: string | null } {
  const s = tidy(said, 80);
  if (!s) return { code: null, refused: null };
  const low = s.toLowerCase();
  const hit = list.find((x) => x.code.toLowerCase() === low) ?? list.find((x) => x.label.toLowerCase() === low);
  return hit ? { code: hit.code, refused: null } : { code: null, refused: s };
}

/** A whole, positive figure under its ceiling — or null, and a line why. */
function figure(
  value: number | null | undefined,
  max: number,
  unit: string,
  questions: string[],
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n <= 0) return null;
  if (n > max) {
    questions.push(`Heard ${n.toLocaleString("en-IN")} ${unit}. That looks misheard, so it was left empty.`);
    return null;
  }
  return n;
}

export function cleanVoice(reading: LeadVoiceReadingParsed, ctx: LeadVoiceContext): LeadVoiceResult {
  const questions: string[] = [];
  for (const line of reading.unclear ?? []) {
    const t = tidy(line, 200);
    if (t) questions.push(t);
  }

  const { mobile, otherNumbers } = pickNumbers(reading.phones ?? []);
  if (!mobile && otherNumbers.length) {
    questions.push("No 10-digit mobile was clear. Check the number.");
  }

  const gst = checkGstin(reading.gstin);
  if (gst?.check === "invalid") {
    questions.push("The GST number heard does not check out. Read it off their bill or board.");
  }

  const salesType = pick(reading.salesType, ctx.salesTypes);
  const source = pick(reading.source, ctx.sources);
  const customerType = pick(reading.customerType, ctx.customerTypes);
  if (source.refused) questions.push(`"${source.refused}" is not one of the ways to find a lead. Choose one.`);

  /* "Other" asks a second question, and the form refuses the save without it.
     Carried where the model heard one; otherwise the form asks him. */
  const sourceDetail = source.code === ctx.otherSource ? tidy(reading.sourceDetail, 200) : null;

  const businessName = tidy(reading.businessName, 200);
  const person = tidy(reading.contactPerson, 200);
  const contactPerson = person && businessName && person.toLowerCase() === businessName.toLowerCase() ? null : person;

  /* A follow-up he did not mention stays unasked — the form's own picker is
     right there, and offering four default days would read as a suggestion. */
  const followUp = reading.followUp
    ? datedFrom(reading.followUp, { today: ctx.today, working: ctx.working }, questions, null)
    : null;

  const registeredIn = gst && gst.check !== "invalid" ? gstState(gst.gstin) : null;

  return {
    salesType: salesType.code,
    businessName,
    contactPerson,
    mobile,
    otherNumbers: otherNumbers.slice(0, 6),
    gstin: gst?.gstin ?? null,
    gstinCheck: gst?.check ?? null,
    city: tidy(reading.city, 120),
    state: tidy(reading.state, 80) ?? registeredIn,
    address: tidy(reading.address, 500),
    source: source.code,
    sourceDetail,
    potentialRupees: figure(reading.potentialRupeesPerMonth, MAX_POTENTIAL_RUPEES, "rupees a month", questions),
    followUp,
    customerType: customerType.code,
    requirement: tidy(reading.requirement, 300),
    monthlyLitres: figure(reading.monthlyLitres, MAX_LITRES, "litres a month", questions),
    decisionMaker: tidy(reading.decisionMaker, 200),
    competitor: tidy(reading.competitor, 200),
    questions: [...new Set(questions)].slice(0, 8),
  };
}

/** Whether a reading found anything a form could use. */
export function heardAnything(r: LeadVoiceResult): boolean {
  return Boolean(
    r.salesType ||
      r.businessName ||
      r.contactPerson ||
      r.mobile ||
      r.otherNumbers.length ||
      r.gstin ||
      r.city ||
      r.address ||
      r.source ||
      r.potentialRupees ||
      r.followUp ||
      r.customerType ||
      r.requirement ||
      r.monthlyLitres ||
      r.decisionMaker ||
      r.competitor,
  );
}
