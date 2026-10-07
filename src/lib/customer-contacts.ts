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
  birthDay?: number | null;
  birthMonth?: number | null;
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

/* ---------------------------------------------------------------- birthdays */

/**
 * A BIRTHDAY IS A DAY AND A MONTH, NEVER A YEAR. Nobody at a counter is asked
 * how old they are, and a year typed to fill a date picker would be a fact
 * nobody stated — so the two are stored as two small numbers, both or neither.
 */
export const BIRTH_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export const BIRTH_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Days a month can hold in ANY year — February has a 29th somebody was born on. */
export function daysInBirthMonth(month: number): number {
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

/** Why a day and month cannot be stored, or null where they can (both blank included). */
export function birthdayProblem(day: number | null | undefined, month: number | null | undefined): string | null {
  const hasDay = day !== null && day !== undefined;
  const hasMonth = month !== null && month !== undefined;
  if (!hasDay && !hasMonth) return null;
  if (!hasDay) return "Pick the day of the birthday as well as the month.";
  if (!hasMonth) return "Pick the month of the birthday as well as the day.";
  if (!Number.isInteger(month) || month < 1 || month > 12) return "That is not a month.";
  if (!Number.isInteger(day) || day < 1 || day > daysInBirthMonth(month)) {
    return `${BIRTH_MONTH_NAMES[month - 1]} has only ${daysInBirthMonth(month)} days.`;
  }
  return null;
}

/** "14 Mar", or null where none is recorded. */
export function birthdayLabel(day: number | null | undefined, month: number | null | undefined): string | null {
  if (!day || !month || birthdayProblem(day, month)) return null;
  return `${day} ${BIRTH_MONTHS[month - 1]}`;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Whole days from `today` (a business date, YYYY-MM-DD) to the next birthday —
 * 0 on the day itself. A 29 February birthday falls on the 28th in a year
 * without one, because that is the day anybody would ring.
 */
export function daysUntilBirthday(
  day: number | null | undefined,
  month: number | null | undefined,
  today: string,
): number | null {
  if (!day || !month || birthdayProblem(day, month)) return null;
  const [y, m, d] = today.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d);
  const on = (year: number) => {
    const dd = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
    return Date.UTC(year, month - 1, dd);
  };
  let next = on(y);
  if (next < start) next = on(y + 1);
  return Math.round((next - start) / 86_400_000);
}

/** "Birthday today", "Birthday tomorrow", "Birthday in 3 days". */
export function birthdayWhen(days: number): string {
  if (days === 0) return "Birthday today";
  if (days === 1) return "Birthday tomorrow";
  return `Birthday in ${days} days`;
}

export type UpcomingBirthday = {
  contactId: string;
  name: string | null;
  role: string;
  label: string;
  days: number;
};

/** The contacts whose birthday is within `withinDays` of today, soonest first. */
export function upcomingBirthdays(
  contacts: ReadonlyArray<Pick<ContactLike, "id" | "name" | "role" | "birthDay" | "birthMonth">>,
  today: string,
  withinDays: number,
): UpcomingBirthday[] {
  const out: UpcomingBirthday[] = [];
  for (const c of contacts) {
    const days = daysUntilBirthday(c.birthDay, c.birthMonth, today);
    if (days === null || days > withinDays) continue;
    out.push({ contactId: c.id, name: c.name, role: c.role, label: birthdayLabel(c.birthDay, c.birthMonth)!, days });
  }
  return out.sort((a, b) => a.days - b.days || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** One line naming who: "Ramesh (Owner) — birthday today". */
export function birthdaySentence(b: UpcomingBirthday): string {
  const who = b.name?.trim() || "A contact";
  const role = b.role && b.role !== "other" ? ` (${contactRoleLabel(b.role, "short")})` : "";
  return `${who}${role} — ${birthdayWhen(b.days).replace("Birthday", "birthday")}`;
}
