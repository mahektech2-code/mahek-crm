/**
 * THE PEOPLE AT A CUSTOMER — the vocabulary and the rules, PURE and client-safe.
 *
 * The contacts panel runs in the browser and the service that writes the rows
 * is `server-only`, and both have to agree on what a valid number is, which
 * roles exist and which number a message goes to. One file, read by both, the
 * same reason `account-types.ts` and `seat-labels.ts` exist.
 */

/** What a person at the shop looks after. A CODE is stored, never the label. */
export const CONTACT_ROLES = [
  { code: "owner", label: "Owner", short: "Owner" },
  { code: "orders", label: "Orders & purchase", short: "Orders" },
  { code: "accounts", label: "Accounts & payments", short: "Accounts" },
  { code: "delivery", label: "Delivery & dispatch", short: "Delivery" },
  { code: "manager", label: "Manager", short: "Manager" },
  { code: "staff", label: "Counter staff", short: "Staff" },
  { code: "other", label: "Other", short: "Other" },
] as const;

export type ContactRole = (typeof CONTACT_ROLES)[number]["code"];

export const CONTACT_ROLE_CODES = CONTACT_ROLES.map((r) => r.code) as [ContactRole, ...ContactRole[]];

/** A stored code back to words. An unknown code is shown as itself, not hidden. */
export function contactRoleLabel(code: string | null | undefined, form: "label" | "short" = "label"): string {
  const found = CONTACT_ROLES.find((r) => r.code === code);
  if (found) return found[form];
  return code ? code : "Other";
}

/** The three things one contact per customer may be marked as. */
export const CONTACT_DESIGNATIONS = ["primary", "whatsapp", "payment"] as const;
export type ContactDesignation = (typeof CONTACT_DESIGNATIONS)[number];

export const DESIGNATION_LABELS: Record<ContactDesignation, { badge: string; action: string; meaning: string }> = {
  primary: {
    badge: "Primary",
    action: "Make primary",
    meaning: "Who we ring. Shown on every list and used by the call drawer.",
  },
  whatsapp: {
    badge: "WhatsApp",
    action: "Use for WhatsApp",
    meaning: "Where order updates, check-ins and every other WhatsApp message go.",
  },
  payment: {
    badge: "Payment reminders",
    action: "Use for payment reminders",
    meaning: "Where reminders about money go. Unset, they go to the WhatsApp number.",
  },
};

export type ContactLike = {
  id: string;
  name: string | null;
  role: string;
  phone: string;
  email?: string | null;
  note?: string | null;
  isPrimary: boolean;
  forWhatsapp: boolean;
  forPaymentReminders: boolean;
  sortOrder: number;
};

/** The digits of a number, with an Indian country code or trunk zero dropped. */
export function digitsOf(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/** The last ten digits — the key every number here is compared on. */
export function last10(raw: string | null | undefined): string {
  return digitsOf(raw).slice(-10);
}

/**
 * A number as it should be stored, or the reason it cannot be.
 *
 * A mobile is ten digits starting 6–9, with a typed +91, 91 or 0 dropped; a
 * landline keeps its STD code (it is 10–12 digits starting 0, or a 10-digit
 * number that is not a mobile). WhatsApp needs a mobile; a call does not.
 */
export function normalisePhone(
  raw: string | null | undefined,
): { ok: true; phone: string; mobile: boolean } | { ok: false; reason: string } {
  const d = digitsOf(raw);
  if (!d) return { ok: false, reason: "Enter a phone number." };
  let mobile = d;
  if (mobile.length === 12 && mobile.startsWith("91")) mobile = mobile.slice(2);
  else if (mobile.length === 11 && mobile.startsWith("0")) mobile = mobile.slice(1);
  if (/^[6-9]\d{9}$/.test(mobile)) return { ok: true, phone: mobile, mobile: true };
  if (d.length >= 10 && d.length <= 12) return { ok: true, phone: d, mobile: false };
  return { ok: false, reason: "Enter a 10-digit mobile, or a landline with its STD code." };
}

export function isMobile(raw: string | null | undefined): boolean {
  const n = normalisePhone(raw);
  return n.ok && n.mobile;
}

/** A plausible email, or null where none was typed. Never a guess at a fix. */
export function emailProblem(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "That email address does not look complete.";
}

/** Primary first, then the order somebody put them in. */
export function sortContacts<T extends ContactLike>(contacts: readonly T[]): T[] {
  return [...contacts].sort(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) ||
      a.sortOrder - b.sortOrder ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The customer columns the contacts imply — the ONE statement of the mirror.
 *
 * `phone` is NOT NULL on customers, so a list with no primary keeps whatever
 * the column held (`phone: undefined` here means "leave it"); the service
 * refuses to remove the last contact for the same reason. `altPhone` is the
 * first number that is not the primary, because a handset and two screens
 * still read it as "the other number".
 */
export function mirrorsFrom(contacts: readonly ContactLike[]): {
  phone: string | undefined;
  contactPerson: string | null | undefined;
  whatsappPhone: string | null;
  paymentWhatsappPhone: string | null;
  altPhone: string | null;
} {
  const sorted = sortContacts(contacts);
  const primary = sorted.find((c) => c.isPrimary) ?? null;
  const whatsapp = sorted.find((c) => c.forWhatsapp) ?? null;
  const payment = sorted.find((c) => c.forPaymentReminders) ?? null;
  const alt = sorted.find((c) => c !== primary && last10(c.phone) !== last10(primary?.phone)) ?? null;
  return {
    phone: primary ? primary.phone : undefined,
    contactPerson: primary ? primary.name?.trim() || null : undefined,
    whatsappPhone: whatsapp ? whatsapp.phone : null,
    paymentWhatsappPhone: payment ? payment.phone : null,
    altPhone: alt ? alt.phone : null,
  };
}

/** What a message is about, as far as choosing its number goes. */
export type MessagePurpose = "payment" | "general";

/**
 * WHICH NUMBER A PERSONAL WHATSAPP GOES TO. Every send path asks this.
 *
 * A payment reminder goes to the number marked for payment reminders; failing
 * that, and for every other message, to the WhatsApp number; failing that, to
 * the phone — which is exactly what every customer meant before contacts.
 */
export function whatsappNumberFor(
  customer: {
    phone: string;
    whatsappPhone: string | null;
    paymentWhatsappPhone?: string | null;
  },
  purpose: MessagePurpose,
): string {
  if (purpose === "payment" && customer.paymentWhatsappPhone?.trim()) {
    return customer.paymentWhatsappPhone;
  }
  return customer.whatsappPhone?.trim() ? customer.whatsappPhone : customer.phone;
}

/** A number written for reading: 98200 11001. Landlines are left as typed. */
export function phoneForReading(raw: string): string {
  const n = normalisePhone(raw);
  if (n.ok && n.mobile) return `${n.phone.slice(0, 5)} ${n.phone.slice(5)}`;
  return raw;
}
