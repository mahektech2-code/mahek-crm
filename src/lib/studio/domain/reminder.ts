import { z } from "zod";
import { addDays, dayDiff, isValidDateKey } from "./date-key";

// In-app reminders. A reminder exists only while someone has the app open: it is worked out from the calendar, the shared
// birthdays and anniversaries and the person's preferences each time a page is shown. Preferences and read/dismissed marks are
// PERSONAL; the birthdays and anniversaries themselves are shared (shared-reminder.ts). Nothing here runs in the background, sends an email, SMS or WhatsApp
// message, or reaches a closed browser. Pure: today's date is passed in.
//
// No repeated notification: a reminder has ONE stable key per occurrence ("diwali-2026", or "birthday:<recipient>:<date>").
// The key does not contain the lead time, so changing "7 days" to "3 days" does not create a second notification for the
// same occasion, and the same occasion listed twice produces one. Read and dismissed marks are kept against that key.

export const REMINDER_LEAD_OPTIONS = [1, 3, 7] as const;
export type ReminderLead = (typeof REMINDER_LEAD_OPTIONS)[number];

export const reminderPrefsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Remind this many days before (and on the day itself). */
  leadDays: z.union([z.literal(1), z.literal(3), z.literal(7)]),
  /** Festivals: remind only for those that have an approved poster design. */
  onlyWithDesigns: z.boolean(),
  /** Remind about the team's shared birthdays and anniversaries (each has its own lead time, set on the reminder). */
  people: z.boolean(),
});
export type ReminderPrefs = z.infer<typeof reminderPrefsSchema>;

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = { enabled: true, leadDays: 7, onlyWithDesigns: false, people: true };

/** Reads preferences from untrusted input (a stored file, a form); a missing or invalid value falls back to the default, one field at a time. */
export function parseReminderPrefs(input: unknown): ReminderPrefs {
  const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const lead = Number(o.leadDays);
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_REMINDER_PREFS.enabled,
    leadDays: (REMINDER_LEAD_OPTIONS as readonly number[]).includes(lead) ? (lead as ReminderLead) : DEFAULT_REMINDER_PREFS.leadDays,
    onlyWithDesigns: typeof o.onlyWithDesigns === "boolean" ? o.onlyWithDesigns : DEFAULT_REMINDER_PREFS.onlyWithDesigns,
    people: typeof o.people === "boolean" ? o.people : DEFAULT_REMINDER_PREFS.people,
  };
}

/** Marks are kept as key -> the date of the occurrence they were made for, so old ones can be dropped. */
export const reminderMarksSchema = z.record(z.string().min(1).max(200), z.string().refine(isValidDateKey));
export const reminderStateSchema = z.strictObject({ read: reminderMarksSchema, dismissed: reminderMarksSchema });
export type ReminderState = z.infer<typeof reminderStateSchema>;
export const EMPTY_REMINDER_STATE: ReminderState = { read: {}, dismissed: {} };

export type ReminderKind = "festival" | "birthday" | "anniversary";

export type ReminderCandidate = {
  /** Stable for one occurrence; see the note at the top of this file. */
  key: string;
  kind: ReminderKind;
  title: string;
  /** The day it is marked. */
  date: string;
  /** Does an approved poster design exist for it? */
  hasDesign: boolean;
  /** Its own lead time in days (a shared birthday or anniversary has one); a festival uses the person's setting. */
  leadDays?: number;
};

export type Reminder = ReminderCandidate & { daysUntil: number; unread: boolean };

/** The reminders due today: enabled, within the lead time (the day itself included), not past, not dismissed, one per key, soonest first. */
export function dueReminders(candidates: readonly ReminderCandidate[], prefs: ReminderPrefs, state: ReminderState, todayKey: string): Reminder[] {
  if (!prefs.enabled) return [];
  const byKey = new Map<string, Reminder>();
  for (const c of candidates) {
    if (byKey.has(c.key) || c.key in state.dismissed) continue;
    if (!isValidDateKey(c.date)) continue;
    if (c.kind === "festival" && prefs.onlyWithDesigns && !c.hasDesign) continue;
    if (c.kind !== "festival" && !prefs.people) continue;
    const daysUntil = dayDiff(todayKey, c.date);
    if (daysUntil < 0 || daysUntil > (c.leadDays ?? prefs.leadDays)) continue;
    byKey.set(c.key, { ...c, daysUntil, unread: !(c.key in state.read) });
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

export const unreadCount = (reminders: readonly Reminder[]): number => reminders.filter((r) => r.unread).length;

export function markRead(state: ReminderState, items: readonly { key: string; date: string }[]): ReminderState {
  const read = { ...state.read };
  for (const i of items) read[i.key] = i.date;
  return { ...state, read };
}

export function dismiss(state: ReminderState, item: { key: string; date: string }): ReminderState {
  return { read: { ...state.read, [item.key]: item.date }, dismissed: { ...state.dismissed, [item.key]: item.date } };
}

/** Drops marks for occurrences more than `keepDays` in the past, so the stored state does not grow for ever. */
export function pruneState(state: ReminderState, todayKey: string, keepDays = 30): ReminderState {
  const cutoff = addDays(todayKey, -keepDays);
  const keep = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, date]) => date >= cutoff));
  return { read: keep(state.read), dismissed: keep(state.dismissed) };
}
