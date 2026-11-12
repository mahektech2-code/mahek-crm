/* ---------------------------------------------------------------------------
 * THE LIVE BELL, AS RULES — pure and client-safe.
 *
 * The bell used to be filled once, when a layout rendered on the server, and
 * nothing asked again. A notification written at 11:02 reached a telecaller
 * when they next caused a full render, which on a calling queue worked by
 * keyboard can be the end of the morning. Nothing popped, nothing chimed, and
 * from their chair it looked exactly like nobody had told them anything.
 *
 * `NotificationCenter` now asks `/api/notifications` on a cadence and pops
 * what is new. These are the decisions it makes, kept here so they can be
 * tested without a browser:
 *
 *  - what counts as ARRIVED (new since the last answer, unread, never popped);
 *  - what a reload may still pop (fresh, and not already announced anywhere);
 *  - which tone a kind is drawn and chimed in;
 * ------------------------------------------------------------------------- */

export type FeedItem = {
  id: string;
  title: string;
  body: string;
  kind: string;
  href: string | null;
  /** The app its link opens (`notificationAppOf`), or null for a general one. */
  app: string | null;
  read: boolean;
  /** ISO instant. */
  createdAt: string;
  /** ISO instant somebody asked to be reminded at, or null. Only the live feed carries it. */
  remindAt?: string | null;
};

export type FeedAnswer = {
  /** The newest of THIS app's notifications, general ones included. */
  items: FeedItem[];
  /** Unread among them — the badge. */
  unread: number;
  /** The newest across every app, for the bell's "All apps" view. */
  all: FeedItem[];
  /** Unread in every app, null being general. */
  byApp: { app: string | null; unread: number }[];
  /** Unread reminders that have come due, in an app that pops them up. */
  due?: FeedItem[];
  /** The server's clock, so "fresh" is not measured against a laptop's. */
  now: string;
};

export type NotifyTone = "info" | "success" | "warn" | "danger";

/**
 * A kind back to a tone. The column is free text and its writers have spelled
 * the same idea several ways — `warn` and `warning` both exist — so this reads
 * the families rather than one spelling, and anything it does not recognise
 * is ordinary news rather than an alarm.
 */
export function toneOf(kind: string | null | undefined): NotifyTone {
  const k = (kind ?? "").toLowerCase();
  if (k === "danger" || k === "error" || k === "rejected" || k === "declined") return "danger";
  if (k === "warn" || k === "warning" || k === "alert") return "warn";
  if (k === "success" || k === "accepted" || k === "approved" || k === "ok") return "success";
  return "info";
}

/** On a fresh page, how old an unread notification may be and still pop. */
export const FRESH_ON_LOAD_MS = 10 * 60_000;

/**
 * What arrived in this answer, oldest first.
 *
 * `known` is every id this tab has already been told about, or null on the
 * first answer after the page loaded. On that first answer nothing is "new"
 * to the tab, so only what is genuinely recent AND has not been announced in
 * any tab (`announced`, kept in the browser) pops — a reload must not replay
 * the morning, and a notification that landed between two page loads must not
 * be lost either.
 *
 * After that, anything unread this tab has not seen before pops, whether or
 * not another tab chimed for it: the person may be looking at THIS tab.
 */
export function arrivals(
  answer: Pick<FeedAnswer, "items" | "now">,
  known: ReadonlySet<string> | null,
  announced: ReadonlySet<string>,
  freshMs: number = FRESH_ON_LOAD_MS,
): FeedItem[] {
  const now = Date.parse(answer.now);
  const out = answer.items.filter((n) => {
    if (n.read) return false;
    if (known) return !known.has(n.id);
    if (announced.has(n.id)) return false;
    const at = Date.parse(n.createdAt);
    return Number.isFinite(at) && Number.isFinite(now) && now - at <= freshMs;
  });
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The default "Remind me" — what Escape, a click outside and "Remind me about all" use. */
export const REMIND_AFTER_MINUTES = 30;

/**
 * WHAT "REMIND ME" CAN BE ASKED FOR, one choice per notification.
 *
 * A code rather than a number of minutes, so the server reads the choice and
 * works out the instant itself: a client that could post any number of minutes
 * could put a notification to sleep for a year, which is dismissing it without
 * saying so. `tomorrow` is 10:00 the next morning in Asia/Kolkata — the start
 * of the working day, rather than the same wall-clock time tomorrow.
 */
export const SNOOZE_CHOICES = [
  { code: "15m", label: "In 15 minutes", minutes: 15 },
  { code: "30m", label: "In 30 minutes", minutes: 30 },
  { code: "1h", label: "In 1 hour", minutes: 60 },
  { code: "3h", label: "In 3 hours", minutes: 180 },
  { code: "tomorrow", label: "Tomorrow morning", minutes: null },
] as const;

export type SnoozeCode = (typeof SNOOZE_CHOICES)[number]["code"];

export function isSnoozeCode(v: unknown): v is SnoozeCode {
  return SNOOZE_CHOICES.some((c) => c.code === v);
}

/** India keeps no daylight saving, so the offset is a constant. */
const IST_OFFSET_MS = 330 * 60_000;
const TOMORROW_HOUR_IST = 10;

/** The instant a snooze ends. Pure: the caller passes the server's clock. */
export function remindAtFor(code: SnoozeCode, nowMs: number): Date {
  const choice = SNOOZE_CHOICES.find((c) => c.code === code)!;
  if (choice.minutes !== null) return new Date(nowMs + choice.minutes * 60_000);
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, TOMORROW_HOUR_IST);
  return new Date(next - IST_OFFSET_MS);
}

/**
 * THE APPS WHOSE NOTIFICATIONS ARE A POP-UP RATHER THAN THE CORNER: all of them.
 *
 * The ERP went first, because there the corner cards stacked up and slid away
 * unanswered while most of them asked somebody to do something. The same was
 * true everywhere else — a declined order in the CRM, a leave request in HRMS —
 * so every web app now stops the screen and asks for an answer: take action,
 * mark it done, or be reminded. `field` is the handset's and never reaches a
 * browser. The factory phone and the print pages are kept clear by the
 * centre itself, by path, because there a pop-up covers the one button that
 * matters.
 */
export function popsUpIn(app: string | null): boolean {
  return app !== "field";
}

/**
 * Who is waiting to be answered, oldest first: whoever was already waiting, then
 * the reminders that came due, then what just arrived. Anything answered in
 * another tab or on another machine leaves, which the next answer says by being
 * read or by carrying a reminder still to come.
 */
export function nextPopups(current: readonly FeedItem[], answer: Pick<FeedAnswer, "items" | "due" | "now">, fresh: readonly FeedItem[]): FeedItem[] {
  const now = Date.parse(answer.now);
  const latest = new Map<string, FeedItem>();
  for (const n of [...answer.items, ...(answer.due ?? [])]) latest.set(n.id, n);
  const out = new Map<string, FeedItem>();
  for (const n of [...current, ...(answer.due ?? []), ...fresh]) {
    const seen = latest.get(n.id) ?? n;
    if (seen.read || out.has(n.id)) continue;
    if (seen.remindAt && Date.parse(seen.remindAt) > now) continue;
    out.set(n.id, seen);
  }
  return [...out.values()];
}

/** "just now", "4 min ago", "2 h ago" — a pop-up is always about recently. */
export function ago(createdAt: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(createdAt)) / 1000));
  if (!Number.isFinite(s) || s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Keeps the announced list bounded: newest `cap` ids by when they were marked. */
export function pruneAnnounced(map: Record<string, number>, cap = 300): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= cap) return map;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, cap));
}

/** Browser preference keys. Sound is ON unless somebody turned it off. */
export const PREF_SOUND = "mahek.notify.sound";
export const PREF_DESKTOP = "mahek.notify.desktop";
export const ANNOUNCED_KEY = "mahek.notify.announced";

export function soundOn(stored: string | null): boolean {
  return stored !== "off";
}

/** Which card of the pop-up's stack is on screen, kept inside it after an answer. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}
