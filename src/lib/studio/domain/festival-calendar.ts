import { z } from "zod";
import { addDays, dayDiff, isValidDateKey } from "./date-key";

// The festival calendar: dated festivals and national days, kept YEAR BY YEAR. A festival date is never worked out from
// another year's date (most Indian festivals follow the lunar calendar and move every year), so a year that is not in the
// file simply has no entries, and the screens say so. The file is templates/festival-calendar.json.
//
// Every entry names its SOURCE. An entry with `source: null` is UNVERIFIED and is shown as such. Nothing in this app presents
// an unverified date as confirmed.

export const FESTIVAL_CATEGORIES = ["national", "hindu", "muslim", "christian", "sikh", "jain-buddhist", "regional", "other"] as const;
export type FestivalCategory = (typeof FESTIVAL_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<FestivalCategory, string> = {
  national: "National",
  hindu: "Hindu",
  muslim: "Muslim",
  christian: "Christian",
  sikh: "Sikh",
  "jain-buddhist": "Jain and Buddhist",
  regional: "Regional",
  other: "Other",
};

const dateKey = z.string().refine(isValidDateKey, "a real date, YYYY-MM-DD");

export const calendarSourceSchema = z.strictObject({
  title: z.string().min(1),
  reference: z.string().min(1),
  transcribedFrom: z.string().min(1),
  retrievedOn: dateKey,
  /** "official-list-secondary-copy": the dates follow an official order but were copied from a copy of it, not from the order itself. */
  verification: z.enum(["official-list", "official-list-secondary-copy"]),
  caveat: z.string().min(1),
});
export type CalendarSource = z.infer<typeof calendarSourceSchema>;

export const calendarEntrySchema = z.strictObject({
  /** Unique, and ends with the year, e.g. "diwali-2026". */
  id: z.string().regex(/^[a-z][a-z0-9-]*-\d{4}$/),
  label: z.string().min(1),
  date: dateKey,
  category: z.enum(FESTIVAL_CATEGORIES),
  /** The occasion in templates/occasions.json whose designs fit this festival, or null when no design family is tied to it. */
  occasionId: z.string().regex(/^[a-z][a-z0-9-]*$/).nullable(),
  /** A key of `sources`, or null for an UNVERIFIED date. */
  source: z.string().nullable(),
  list: z.enum(["gazetted", "restricted"]).nullable(),
  note: z.string().optional(),
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

export const festivalCalendarSchema = z
  .strictObject({
    _comment: z.string().optional(),
    sources: z.record(z.string(), calendarSourceSchema),
    /** The dates the file speaks for. A date outside it is not in the calendar, not "no festival". */
    coverage: z.strictObject({ from: dateKey, to: dateKey }),
    entries: z.array(calendarEntrySchema),
  })
  .superRefine((cal, ctx) => {
    const ids = new Set<string>();
    cal.entries.forEach((e, i) => {
      if (ids.has(e.id)) ctx.addIssue({ code: "custom", path: ["entries", i, "id"], message: `duplicate entry id "${e.id}"` });
      ids.add(e.id);
      if (!e.id.endsWith(`-${e.date.slice(0, 4)}`)) ctx.addIssue({ code: "custom", path: ["entries", i, "id"], message: `id "${e.id}" does not end with the year of ${e.date}` });
      if (e.source !== null && !(e.source in cal.sources)) ctx.addIssue({ code: "custom", path: ["entries", i, "source"], message: `unknown source "${e.source}"` });
      if (e.date < cal.coverage.from || e.date > cal.coverage.to) ctx.addIssue({ code: "custom", path: ["entries", i, "date"], message: `${e.date} is outside the coverage` });
    });
    if (cal.coverage.from > cal.coverage.to) ctx.addIssue({ code: "custom", path: ["coverage"], message: "coverage ends before it starts" });
  });
export type FestivalCalendar = z.infer<typeof festivalCalendarSchema>;

export const isVerified = (e: CalendarEntry): boolean => e.source !== null;

export type Horizon = "today" | "week" | "month" | "later" | "past";

/** Where a date sits relative to today: today, 1 to 7 days (week), 8 to 30 days (month), further on, or already past. */
export function horizonOf(days: number): Horizon {
  if (days < 0) return "past";
  if (days === 0) return "today";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "later";
}

export type DatedEntry = CalendarEntry & { daysUntil: number; horizon: Horizon };

export function withCountdown(entries: readonly CalendarEntry[], todayKey: string): DatedEntry[] {
  return entries.map((e) => {
    const daysUntil = dayDiff(todayKey, e.date);
    return { ...e, daysUntil, horizon: horizonOf(daysUntil) };
  });
}

export const CALENDAR_VIEWS = ["today", "7", "30", "all"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export type EntryFilter = {
  view?: CalendarView;
  category?: FestivalCategory | undefined;
  /** An inclusive date range; both ends are optional. Applies on top of the view. */
  from?: string | undefined;
  to?: string | undefined;
  /** Keep only occasions that have (true) or lack (false) an approved design. */
  hasDesign?: boolean | undefined;
};

/** Entries from today onward, soonest first, narrowed by the view and the filters. Past entries are never returned. */
export function selectEntries(entries: readonly CalendarEntry[], todayKey: string, filter: EntryFilter = {}, hasDesign: (e: CalendarEntry) => boolean = () => false): DatedEntry[] {
  const view = filter.view ?? "all";
  const maxDays = view === "today" ? 0 : view === "7" ? 7 : view === "30" ? 30 : Infinity;
  return withCountdown(entries, todayKey)
    .filter((e) => e.daysUntil >= 0 && e.daysUntil <= maxDays)
    .filter((e) => !filter.category || e.category === filter.category)
    .filter((e) => !filter.from || e.date >= filter.from)
    .filter((e) => !filter.to || e.date <= filter.to)
    .filter((e) => filter.hasDesign === undefined || hasDesign(e) === filter.hasDesign)
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

/** Parses a filter value from a URL; anything unknown is ignored, never an error. */
export const parseCategory = (v: unknown): FestivalCategory | undefined => (FESTIVAL_CATEGORIES as readonly unknown[]).includes(v) ? (v as FestivalCategory) : undefined;
export const parseView = (v: unknown): CalendarView => ((CALENDAR_VIEWS as readonly unknown[]).includes(v) ? (v as CalendarView) : "30");
export const parseDateParam = (v: unknown): string | undefined => (isValidDateKey(v) ? v : undefined);

export type CoverageStatus =
  | { covered: true }
  | { covered: false; reason: "before" | "after" | "ends-soon"; message: string };

/** Does the calendar speak for the next `lookaheadDays` from today? When it does not, the screens must say "not loaded", not "nothing coming". */
export function coverageStatus(coverage: { from: string; to: string }, todayKey: string, lookaheadDays = 30): CoverageStatus {
  if (todayKey < coverage.from) return { covered: false, reason: "before", message: `The festival calendar starts on ${coverage.from}.` };
  if (todayKey > coverage.to) return { covered: false, reason: "after", message: `The festival calendar ended on ${coverage.to}. The next year's dates have not been added, so nothing can be shown.` };
  if (addDays(todayKey, lookaheadDays) > coverage.to) return { covered: false, reason: "ends-soon", message: `The festival calendar ends on ${coverage.to}. Dates after that have not been added.` };
  return { covered: true };
}

/** "Today", "Tomorrow" or "in 12 days" (a past day reads "N days ago"). */
export function countdownLabel(days: number): string {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export type EntryDesigns = {
  /** Approved designs for this occasion, by who they are offered to (the template-first audience rule). */
  lead: number;
  customer: number;
  /** True when at least one approved design exists for any audience. */
  any: boolean;
  /** The occasion id to carry into the recipient list (/leads?occasion=, /customers?occasion=), or null when there is no design to start from. */
  occasionId: string | null;
};
