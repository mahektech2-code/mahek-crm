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

/**
 * The plain-text VALUES worth searching, joined into one string — never the
 * JSON's own key names. `enquiries.search_text` is exactly this, computed
 * once at the moment the row is written, so a term that finds an enquiry on
 * the list or detail screen (both of which read `readSubmissionFields` too)
 * is exactly a term that can find it in search.
 *
 * The phone goes in TWICE: once as the visitor typed it, and once as bare
 * digits. A submission is stored exactly as sent, so one visitor's
 * `+91 98200 11001` and another's `9820011001` are the same number spelled
 * two ways — and a telecaller typing the ten digits into a box labelled
 * "Search name, phone, company" would find only the second. Normalising at
 * WRITE time is what keeps the trigram index doing the work; normalising the
 * query alone cannot reach a stored value it does not match.
 */
export function buildEnquirySearchText(raw: unknown): string {
  const fields = readSubmissionFields(raw);
  const digits = phoneDigits(fields.phone);
  return [fields.name, fields.phone, digits === fields.phone ? null : digits, fields.email, fields.company, fields.message]
    .filter((v): v is string => !!v)
    .join(" ");
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

/* ---------------------------------------------------------------------------
 * WHAT A LEAD IS PREFILLED WITH, read off the enquiry the visitor already
 * filled in — so the telecaller completes a form rather than retyping one.
 *
 * Best effort and tolerant, like everything above: the website's field names
 * are its own, and a value that is not there is `null` for the dialog to ask
 * about, never a guess. Nothing here decides anything; it only reads. The
 * shop's name is the company where there is one and the visitor's own name
 * where there is not, and the person is kept as the contact either way.
 * ------------------------------------------------------------------------- */
const CITY_KEYS = ["city", "town", "location", "district", "city_town", "cityTown"];
const ADDRESS_KEYS = ["address", "street", "street_address", "streetAddress", "shop_address", "shopAddress"];
const STATE_KEYS = ["state", "region"];
const PINCODE_KEYS = ["pincode", "pin_code", "pin", "zip", "postal_code", "postalCode"];
const PRODUCT_KEYS = ["product", "product_name", "productName", "products", "interested_in", "interestedIn", "product_interest"];
const QUANTITY_KEYS = ["quantity", "volume", "monthly_requirement", "monthlyRequirement", "requirement_quantity"];

export type LeadPrefill = {
  name: string | null;
  companyName: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  /** The product and quantity they named, where they named one. */
  requirement: string | null;
  /** What they wrote, then everything else the form carried one line each, so nothing they typed is lost. */
  notes: string | null;
};

export function readLeadPrefill(raw: unknown): LeadPrefill {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const f = readSubmissionFields(raw);

  const address = [firstOf(obj, ADDRESS_KEYS), firstOf(obj, STATE_KEYS), firstOf(obj, PINCODE_KEYS)]
    .filter((v): v is string => !!v)
    .join(", ");
  const product = firstOf(obj, PRODUCT_KEYS);
  const quantity = firstOf(obj, QUANTITY_KEYS);
  const requirement = [product, quantity ? `Quantity: ${quantity}` : null]
    .filter((v): v is string => !!v)
    .join(" — ");

  const consumed = new Set([
    ...CITY_KEYS, ...ADDRESS_KEYS, ...STATE_KEYS, ...PINCODE_KEYS, ...PRODUCT_KEYS, ...QUANTITY_KEYS,
  ]);
  const rest = otherSubmissionFields(raw)
    .filter(([k]) => !consumed.has(k))
    .map(([k, v]) => `${k}: ${v}`);
  /* What they wrote comes first — it is what the desk quotes back on the record. */
  const notes = [f.message, ...rest].filter((v): v is string => !!v).join("\n");

  return {
    name: f.company ?? f.name,
    companyName: f.company,
    contactPerson: f.name,
    phone: phoneDigits(f.phone) ?? f.phone,
    email: f.email,
    city: firstOf(obj, CITY_KEYS),
    address: address || null,
    requirement: requirement || null,
    notes: notes || null,
  };
}
