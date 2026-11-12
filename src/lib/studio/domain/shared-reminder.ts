import { isValidDateKey, makeDateKey } from "./date-key";
import type { EntryDesigns } from "./festival-calendar";
import { nextOccurrence, occurrenceInYear, parseRecurringDate, type Occurrence } from "./recurring-date";
import type { ReminderCandidate } from "./reminder";
import { normalizeText } from "./text";

// Birthday and anniversary reminders that the whole team shares. A person on the team adds one by hand (the CRM feed has no
// birthday or anniversary field, and nothing here is read from or written to the CRM); every signed-in person sees and can
// change the same records. Pure: no database, no clock (today's date is passed in).
//
// A reminder repeats every year, so it is stored once. Its date is "YYYY-MM-DD" (the year is known) or "--MM-DD" (it is not).

export const PERSON_KINDS = ["birthday", "anniversary"] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];
export const KIND_LABELS: Record<PersonKind, string> = { birthday: "Birthday", anniversary: "Anniversary" };
export const KIND_PLURALS: Record<PersonKind, string> = { birthday: "Birthdays", anniversary: "Anniversaries" };

export const LEAD_DAY_OPTIONS = [1, 3, 7] as const;
export type LeadDays = (typeof LEAD_DAY_OPTIONS)[number];

export const NAME_MAX = 120;
export const COMPANY_MAX = 120;
export const NOTE_MAX = 500;
/** The earliest year accepted for a birth or wedding year. */
export const MIN_YEAR = 1900;

export type CrmKind = "lead" | "customer";
/** What the CRM calls a record id (feed.ts CRM_RECORD_ID): anything else is never stored. */
export const CRM_REF_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The person who did something, as the history keeps it: their id, and the name the app showed for them at the time. */
export type Actor = { id: string; label: string };

export type SharedReminder = {
  id: string;
  kind: PersonKind;
  personName: string;
  company: string | null;
  /** "YYYY-MM-DD" or "--MM-DD". */
  date: string;
  note: string | null;
  /** Shared: how many days ahead everyone is reminded. */
  leadDays: LeadDays;
  crmKind: CrmKind | null;
  crmId: string | null;
  /** Goes up by one on every change; an edit must name the version it started from. */
  version: number;
  createdBy: Actor;
  createdAt: number;
  updatedBy: Actor;
  updatedAt: number;
  deletedAt: number | null;
  deletedBy: Actor | null;
};

export type ReminderInput = {
  kind: PersonKind;
  personName: string;
  company: string | null;
  date: string;
  note: string | null;
  leadDays: LeadDays;
  crmKind: CrmKind | null;
  crmId: string | null;
};

export type FieldName = "kind" | "personName" | "company" | "date" | "note" | "leadDays" | "crm";
export type FieldErrors = Partial<Record<FieldName, string>>;

const BAD_CHARS = /[<>]/;

function text(value: unknown): string {
  return typeof value === "string" ? normalizeText(value) : "";
}

/**
 * Reads the Add / Edit form. `raw` holds the text fields as sent (kind, personName, company, month, day, year, note, leadDays,
 * crmKind, crmId); `todayKey` is today in India, so a birth year in the future is refused. Every problem is reported against its
 * field; nothing is repaired or guessed.
 */
export function parseReminderInput(raw: Record<string, unknown>, todayKey: string): { ok: true; value: ReminderInput } | { ok: false; fieldErrors: FieldErrors } {
  const errors: FieldErrors = {};

  const kind = raw.kind === "birthday" || raw.kind === "anniversary" ? raw.kind : null;
  if (!kind) errors.kind = "Choose Birthday or Anniversary.";

  const personName = text(raw.personName);
  if (personName === "") errors.personName = "Enter the person's name.";
  else if (Array.from(personName).length > NAME_MAX) errors.personName = `Use ${NAME_MAX} characters or fewer.`;
  else if (BAD_CHARS.test(personName)) errors.personName = "Use letters, numbers and ordinary punctuation only.";

  const companyText = text(raw.company);
  if (Array.from(companyText).length > COMPANY_MAX) errors.company = `Use ${COMPANY_MAX} characters or fewer.`;
  else if (BAD_CHARS.test(companyText)) errors.company = "Use letters, numbers and ordinary punctuation only.";

  const noteText = text(raw.note);
  if (Array.from(noteText).length > NOTE_MAX) errors.note = `Use ${NOTE_MAX} characters or fewer.`;
  else if (BAD_CHARS.test(noteText)) errors.note = "Use letters, numbers and ordinary punctuation only.";

  const lead = Number(typeof raw.leadDays === "string" ? raw.leadDays : NaN);
  if (!(LEAD_DAY_OPTIONS as readonly number[]).includes(lead)) errors.leadDays = "Choose 1, 3 or 7 days.";

  // the date: month and day are required, the year is optional
  const month = typeof raw.month === "string" ? raw.month.trim() : "";
  const day = typeof raw.day === "string" ? raw.day.trim() : "";
  const year = typeof raw.year === "string" ? raw.year.trim() : "";
  let date: string | null = null;
  if (!/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) {
    errors.date = "Choose the month and the day.";
  } else if (year !== "" && !/^\d{4}$/.test(year)) {
    errors.date = "Enter the year as four digits, or leave it blank if it is not known.";
  } else {
    const mm = String(Number(month)).padStart(2, "0");
    const dd = String(Number(day)).padStart(2, "0");
    const candidate = year === "" ? `--${mm}-${dd}` : `${year}-${mm}-${dd}`;
    if (parseRecurringDate(candidate) === null) {
      errors.date = year !== "" && Number(mm) === 2 && Number(dd) === 29 ? `29 February does not exist in ${year}.` : "That date does not exist.";
    } else if (year !== "" && (Number(year) < MIN_YEAR || Number(year) > Number(todayKey.slice(0, 4)))) {
      errors.date = `The year must be between ${MIN_YEAR} and ${todayKey.slice(0, 4)}, or left blank.`;
    } else if (year !== "" && candidate > todayKey) {
      errors.date = "That date is in the future. Leave the year blank if it is not known.";
    } else {
      date = candidate;
    }
  }

  // an optional link to a CRM record; only its kind and id are kept, and the record is never read here
  const crmKindRaw = typeof raw.crmKind === "string" ? raw.crmKind : "";
  const crmIdRaw = text(raw.crmId);
  let crmKind: CrmKind | null = null;
  let crmId: string | null = null;
  if (crmKindRaw === "" && crmIdRaw === "") {
    // not linked
  } else if (crmKindRaw !== "lead" && crmKindRaw !== "customer") {
    errors.crm = "Choose Lead or Customer for the CRM reference, or clear it.";
  } else if (crmIdRaw === "") {
    errors.crm = "Enter the CRM record id, or choose “Not linked”.";
  } else if (!CRM_REF_ID.test(crmIdRaw)) {
    errors.crm = "A CRM record id has only letters, numbers, hyphens and underscores.";
  } else {
    crmKind = crmKindRaw;
    crmId = crmIdRaw;
  }

  if (Object.keys(errors).length > 0 || !kind || date === null) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: { kind, personName, company: companyText === "" ? null : companyText, date, note: noteText === "" ? null : noteText, leadDays: lead as LeadDays, crmKind, crmId },
  };
}

/** The same shape as the form, for filling an Edit form from a stored reminder. */
export function formValuesOf(r: Pick<ReminderInput, "kind" | "personName" | "company" | "date" | "note" | "leadDays" | "crmKind" | "crmId">): Record<string, string> {
  const md = parseRecurringDate(r.date);
  return {
    kind: r.kind,
    personName: r.personName,
    company: r.company ?? "",
    month: md ? String(md.month) : "",
    day: md ? String(md.day) : "",
    year: md?.year != null ? String(md.year) : "",
    note: r.note ?? "",
    leadDays: String(r.leadDays),
    crmKind: r.crmKind ?? "",
    crmId: r.crmId ?? "",
  };
}

// ---- what changed (for the history) ----

export type FieldChange = { field: string; label: string; from: string | null; to: string | null };

const FIELD_LABELS: [keyof ReminderInput, string][] = [
  ["kind", "Type"],
  ["personName", "Name"],
  ["company", "Company"],
  ["date", "Date"],
  ["note", "Note"],
  ["leadDays", "Remind"],
  ["crmKind", "CRM record type"],
  ["crmId", "CRM record id"],
];

const show = (field: keyof ReminderInput, v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (field === "leadDays") return `${v} day${v === 1 ? "" : "s"} before`;
  if (field === "kind") return KIND_LABELS[v as PersonKind] ?? String(v);
  return String(v);
};

/** The fields that differ between two versions of a reminder, in a fixed order. Empty when nothing changed. */
export function diffReminder(before: ReminderInput, after: ReminderInput): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [field, label] of FIELD_LABELS) {
    if (before[field] !== after[field]) out.push({ field, label, from: show(field, before[field]), to: show(field, after[field]) });
  }
  return out;
}

export const inputOf = (r: SharedReminder): ReminderInput => ({ kind: r.kind, personName: r.personName, company: r.company, date: r.date, note: r.note, leadDays: r.leadDays, crmKind: r.crmKind, crmId: r.crmId });

export type HistoryAction = "created" | "edited" | "deleted";
export type HistoryEntry = { seq: number; reminderId: string; action: HistoryAction; actor: Actor; at: number; version: number; changes: FieldChange[] };

// ---- yearly recurrence ----

export type UpcomingPerson = { reminder: SharedReminder; occurrence: Occurrence };

/**
 * Reminders with their next occurrence, soonest first (then by name). A reminder is listed whatever its distance, or only when it
 * is within `withinDays`. One whose stored date cannot be used (a damaged row) is returned in `unusable`, never guessed.
 */
export function upcomingShared(list: readonly SharedReminder[], todayKey: string, options: { kind?: PersonKind | undefined; withinDays?: number } = {}): { items: UpcomingPerson[]; unusable: SharedReminder[] } {
  const items: UpcomingPerson[] = [];
  const unusable: SharedReminder[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (r.deletedAt !== null || seen.has(r.id)) continue;
    seen.add(r.id);
    if (options.kind && r.kind !== options.kind) continue;
    const occurrence = nextOccurrence(r.date, todayKey);
    if (!occurrence) {
      unusable.push(r);
      continue;
    }
    if (options.withinDays !== undefined && occurrence.daysUntil > options.withinDays) continue;
    items.push({ reminder: r, occurrence });
  }
  items.sort((a, b) => a.occurrence.daysUntil - b.occurrence.daysUntil || a.reminder.personName.localeCompare(b.reminder.personName) || a.reminder.id.localeCompare(b.reminder.id));
  return { items, unusable };
}

/** The reminders that fall in one month of one year (a yearly reminder is in every year), for the month calendar. */
export function occurrencesInMonth(list: readonly SharedReminder[], year: number, month: number): { id: string; label: string; date: string }[] {
  const out: { id: string; label: string; date: string }[] = [];
  const prefix = makeDateKey(year, month, 1).slice(0, 7);
  for (const r of list) {
    if (r.deletedAt !== null) continue;
    const o = occurrenceInYear(r.date, year);
    if (o && o.date.startsWith(prefix) && isValidDateKey(o.date)) out.push({ id: r.id, label: r.personName, date: o.date });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

// ---- notifications ----

export const candidateKey = (r: Pick<SharedReminder, "kind" | "id">, occurrenceDate: string): string => `${r.kind}:${r.id}:${occurrenceDate}`;

/** One notification candidate per reminder, for its next occurrence. The key has the date in it, so next year's is new again. */
export function personCandidates(list: readonly SharedReminder[], todayKey: string): ReminderCandidate[] {
  return upcomingShared(list, todayKey).items.map(({ reminder, occurrence }) => ({
    key: candidateKey(reminder, occurrence.date),
    kind: reminder.kind,
    title: `${reminder.personName}'s ${reminder.kind}`,
    date: occurrence.date,
    hasDesign: false,
    leadDays: reminder.leadDays,
  }));
}

// ---- poster ----

export const NO_POSTER_MESSAGE = "No approved poster design available.";

export type PosterAction =
  | { type: "none"; message: string }
  | { type: "needs-recipient"; message: string }
  | { type: "make"; recipientKind: CrmKind; recipientId: string; occasionId: string };

/**
 * Can a poster be made for this reminder? Only when an approved design exists for its occasion (`designs`, worked out from the
 * template registry) AND the reminder is linked to a lead or customer that design is offered to. The link goes into the existing
 * template-first flow, which checks the record's eligibility again (archived, lost, trashed, Do Not Contact warning, and so on);
 * a person typed in by hand has no CRM record, so no poster is offered for them. No design is ever invented or approved here.
 */
export function posterActionFor(r: Pick<SharedReminder, "crmKind" | "crmId">, designs: EntryDesigns): PosterAction {
  if (!designs.any || designs.occasionId === null) return { type: "none", message: NO_POSTER_MESSAGE };
  if (r.crmKind === null || r.crmId === null) return { type: "needs-recipient", message: "Link a lead or customer to make a poster." };
  if ((r.crmKind === "lead" ? designs.lead : designs.customer) === 0) return { type: "none", message: NO_POSTER_MESSAGE };
  return { type: "make", recipientKind: r.crmKind, recipientId: r.crmId, occasionId: designs.occasionId };
}
