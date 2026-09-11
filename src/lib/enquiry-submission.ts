/* ---------------------------------------------------------------------------
 * Reading a website enquiry's submitted fields.
 *
 * `enquiries.raw_submission` is kept exactly as the source sent it, and
 * different sources spell the same thing differently — a name field is
 * `name`, `full_name`, `fullName`, or split into `first_name`/`last_name`.
 * One place tries every spelling this project is likely to see, so the list
 * and detail screens read a customer's name the same way instead of each
 * guessing at the JSON on its own. Pure and client-safe: both a server
 * component rendering a list and a client component rendering a detail page
 * need this, and neither should touch the database to get it.
 * ------------------------------------------------------------------------- */

export type EnquirySubmissionFields = {
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  message: string | null;
};

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
}

function firstOf(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = str(raw[key]);
    if (value) return value;
  }
  return null;
}

const NAME_KEYS = ["name", "full_name", "fullName", "fullname", "your_name", "customer_name", "customerName"];
const FIRST_NAME_KEYS = ["first_name", "firstName"];
const LAST_NAME_KEYS = ["last_name", "lastName"];
const PHONE_KEYS = ["phone", "mobile", "phone_number", "phoneNumber", "mobile_number", "mobileNumber", "contact", "contact_number", "whatsapp", "whatsapp_number"];
const EMAIL_KEYS = ["email", "email_address", "emailAddress", "e_mail"];
const COMPANY_KEYS = ["company", "company_name", "companyName", "business", "business_name", "organisation", "organization"];
const MESSAGE_KEYS = ["message", "enquiry", "requirement", "details", "comments", "comment", "description", "query"];

/** Best-effort read of the fields a screen actually needs, from whatever shape the source sent. */
export function readSubmissionFields(raw: unknown): EnquirySubmissionFields {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  let name = firstOf(obj, NAME_KEYS);
  if (!name) {
    const first = firstOf(obj, FIRST_NAME_KEYS);
    const last = firstOf(obj, LAST_NAME_KEYS);
    name = [first, last].filter(Boolean).join(" ") || null;
  }

  return {
    name,
    phone: firstOf(obj, PHONE_KEYS),
    email: firstOf(obj, EMAIL_KEYS),
    company: firstOf(obj, COMPANY_KEYS),
    message: firstOf(obj, MESSAGE_KEYS),
  };
}

/** Last 10 digits, the same key `customers.phone` matching already uses elsewhere. */
export function phoneDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? digits : null;
}

/** Every field the submission carried that isn't one of the ones already surfaced above, for the "everything else" panel. */
export function otherSubmissionFields(raw: unknown): Array<[string, string]> {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const known = new Set([
    ...NAME_KEYS, ...FIRST_NAME_KEYS, ...LAST_NAME_KEYS,
    ...PHONE_KEYS, ...EMAIL_KEYS, ...COMPANY_KEYS, ...MESSAGE_KEYS,
  ]);
  return Object.entries(obj)
    .filter(([k, v]) => !known.has(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}
