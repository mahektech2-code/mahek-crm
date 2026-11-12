import type { Recipient } from "./recipient";
import type { Language } from "./language";
import { CLAIM_WORDS } from "./copy";
import { normalizeText } from "./text";
import { fail, ok, type Result } from "@/lib/studio/result";

// Advanced personalization: the details a person may change on ONE poster without changing the CRM record.
//
//   name     the name the poster greets
//   company  the company line
//   message  the person's own greeting, in place of an approved wording (free text, checked below)
//   phone    a contact number typed in by hand, drawn only in a design's contact-number field
//   product  a product name typed in by hand, drawn only in a design whose product field takes a typed value (uploaded templates)
//
// Nothing else is editable: not the design, the layout, the logo or the fixed lines. The edits are checked here and again on the
// server every time they are used, they are applied after the record is read fresh from the CRM, and they are never written back.
// A phone number is personal information: it is kept out of addresses, logs and error messages, and no message here repeats a
// value that was typed. Pure. The text rules follow the Task 7 poster-overrides validator, extended for a free-text message.

export const PERSONALIZATION_FIELDS = ["name", "company", "message", "phone", "product"] as const;
export type PersonalizationField = (typeof PERSONALIZATION_FIELDS)[number];
export type Personalization = Partial<Record<PersonalizationField, string>>;

export const PERSONALIZATION_LABELS: Readonly<Record<PersonalizationField, string>> = { name: "Name", company: "Company", message: "Message", phone: "Contact number", product: "Product name" };
export const PERSONALIZATION_MAX = { name: 60, company: 100, message: 200, product: 60 } as const;
export const PHONE_MIN_DIGITS = 7;
export const PHONE_MAX_DIGITS = 15;

/** The notice every editing screen shows. */
export const POSTER_ONLY_NOTICE = "These changes apply only to this poster. Your CRM record will not be changed.";

const CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/;
const MARKUP = /[<>{}\\`]/;
// Only letters of the scripts the renderer has fonts for, marks, digits, punctuation and spaces. Emoji and symbols would draw as boxes.
const DRAWABLE = /^[\p{Script=Latin}\p{Script=Devanagari}\p{Script=Gujarati}\p{M}\p{N}\p{P}\p{Zs}\u200c\u200d]*$/u;
const PHONE_PLUS = /\+\s*\d/;
const PHONE_RUN = /\d{6,}/;
const LINK = /https?:|www\.|@|\b[\p{L}\p{N}-]+\.(com|in|org|net|co|io|me|app|link|ly|shop|store|biz|info|xyz|online)\b|\bbit\.ly\b/iu;
const MONEY = /[₹$€£]|\b(rs|inr|usd|rupee|rupees)\b\.?|रु\b|रुपये|रुपया|रूपये|રૂપિયા|રૂ\./iu;
const PERCENT = /%|\b(percent|per\s*cent)\b|प्रतिशत|ટકા/iu;
// Payment and promotional claims a free-text greeting must not make. Conservative, like the approved-wording list: it can only
// make the check stricter. The Indic entries have no \b because word boundaries do not work with combining marks.
const PAYMENT = /\b(upi|paytm|gpay|google\s*pay|phonepe|bhim|neft|rtgs|imps|payment|pay\s+now|advance|refund|invoice|loan)\b/i;
const MORE_CLAIMS = /\b(lowest|unbeatable|hurry|deal|deals|bonus|buy\s+now|order\s+now|call\s+now|lottery|prize|winner|iso|fssai|accredited|approved\s+by|authori[sz]ed\s+dealer)\b|छूट|छुट|ऑफ़?र|मुफ़?्?त|गारंटी|सस्ता|सस्ती|डिस्काउंट|સેલ|ઓફર|મફત|ગેરંટી|છૂટ|ડિસ્કાઉન્ટ|સસ્તું/iu;
const INDIC = { devanagari: /[ऀ-ॿ]/u, gujarati: /[઀-૿]/u } as const;

type Kind = "name" | "company" | "message" | "product";

/**
 * Why a piece of text may not go on a poster, or null when it may. The result is a short reason that never repeats the text. A
 * poster carries no link, e-mail address, phone number, price or percentage in these fields, and the text must be plain.
 */
export function textProblem(value: string, kind: Kind): string | null {
  if (CONTROL.test(value)) return "contains a character that is not allowed";
  const text = normalizeText(value);
  if (text.length === 0) return "cannot be empty";
  if (Array.from(text).length > PERSONALIZATION_MAX[kind]) return `is too long (at most ${PERSONALIZATION_MAX[kind]} characters)`;
  if (MARKUP.test(text)) return "contains a character that is not allowed";
  if (!DRAWABLE.test(text)) return "contains a symbol or emoji that the poster cannot draw";
  if (PHONE_PLUS.test(text) || PHONE_RUN.test(text.replace(/[\s().-]/g, ""))) return "cannot contain a phone number (use the contact number field)";
  if (LINK.test(text)) return "cannot contain a link or an email address";
  if (MONEY.test(text) || PERCENT.test(text)) return "cannot contain a price or a percentage";
  if (kind === "message") {
    if (PAYMENT.test(text)) return "cannot ask for payment or mention a payment method";
    if (CLAIM_WORDS.test(text) || MORE_CLAIMS.test(text)) return "cannot contain an offer, discount, guarantee, certification or other claim";
  }
  return null;
}

/** Why a message cannot be drawn in this language: Latin is always drawable, and so is the language's own script, but not another Indic script. */
export function messageScriptProblem(text: string, language: Language): string | null {
  const own = language === "gu" ? "gujarati" : language === "hi" || language === "mr" ? "devanagari" : null;
  for (const script of ["devanagari", "gujarati"] as const) if (script !== own && INDIC[script].test(text)) return "uses a script that this design language cannot draw";
  return null;
}

/** Why a phone number is not accepted, or null. Digits with an optional leading + and the usual separators; never a link, markup or a control character. */
export function phoneProblem(value: string): string | null {
  if (CONTROL.test(value)) return "contains a character that is not allowed";
  const text = normalizeText(value);
  if (text.length === 0) return "cannot be empty";
  if (text.length > 24) return "is too long";
  if (!/^\+?[0-9(][0-9 ()\-.]*$/.test(text)) return "can only contain digits, spaces, + at the start, and ( ) - .";
  const digits = text.replace(/\D/g, "").length;
  if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) return `must have ${PHONE_MIN_DIGITS} to ${PHONE_MAX_DIGITS} digits`;
  return null;
}

export type PersonalizationErrors = Partial<Record<PersonalizationField, string>>;

/** Checks one set of edits. Text is tidied (spaces, Unicode form); every problem is reported by field. Unknown fields are refused. */
export function parsePersonalization(raw: unknown): Result<Personalization> {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_request", "The edits are not valid.");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(PERSONALIZATION_FIELDS as readonly string[]).includes(key)) return fail("invalid_request", "The edits contain a field that cannot be edited.", { fieldErrors: { [key]: "not editable" } });
  }
  const errors: PersonalizationErrors = {};
  const out: Personalization = {};
  for (const field of PERSONALIZATION_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      errors[field] = "is not valid";
      continue;
    }
    // an empty field means "leave as it is": it is not an edit
    if (value.trim() === "") continue;
    const problem = field === "phone" ? phoneProblem(value) : textProblem(value, field);
    if (problem) errors[field] = problem;
    else out[field] = normalizeText(value);
  }
  const first = PERSONALIZATION_FIELDS.find((f) => errors[f] !== undefined);
  if (first) return fail("invalid_request", `${PERSONALIZATION_LABELS[first]} ${errors[first]}.`, { fieldErrors: errors as Record<string, string> });
  return ok(out);
}

export const hasPersonalization = (p: Personalization | null | undefined): boolean => p !== null && p !== undefined && PERSONALIZATION_FIELDS.some((f) => p[f] !== undefined);

/** The recipient a poster is made for: the CRM record with the person's name and company on top. A new object; the record is not changed. */
export function applyPersonalization(record: Recipient, p: Personalization | null | undefined): Recipient {
  return { ...record, contact: p?.name ?? record.contact, company: p?.company ?? record.company };
}

/** What the editing form holds: every field as typed. Empty (or only spaces) means "leave as the record says". */
export type PersonalizationDraft = Partial<Record<PersonalizationField, string>>;

/** The edits a form draft stands for: empty fields dropped, text trimmed. It is only a request; the server checks it again. */
export function cleanDraft(draft: PersonalizationDraft | null | undefined): Personalization {
  const out: Personalization = {};
  for (const f of PERSONALIZATION_FIELDS) {
    const v = draft?.[f]?.trim();
    if (v) out[f] = v;
  }
  return out;
}

/** An opaque id of saved edits. It names nothing personal and is meaningless to anyone but the user who saved them. */
export const DRAFT_ID_PATTERN = /^p[0-9a-f]{32}$/;
export const isDraftId = (v: unknown): v is string => typeof v === "string" && DRAFT_ID_PATTERN.test(v);
