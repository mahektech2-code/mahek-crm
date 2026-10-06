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
 *  - how long a pop-up stays before it tidies itself away.
 * ------------------------------------------------------------------------- */

export type FeedItem = {
  id: string;
  title: string;
  body: string;
  kind: string;
  href: string | null;
  read: boolean;
  /** ISO instant. */
  createdAt: string;
};

export type FeedAnswer = {
  items: FeedItem[];
  unread: number;
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

/** Never more than this many fly in at once; the rest are summarised. */
export const MAX_POPUPS_AT_ONCE = 3;

/**
 * How long a pop-up sits in the corner before tidying itself away. Bad news
 * stays longer, because "your order was declined" is the one a telecaller
 * most needs to have read before the customer rings.
 */
export function dwellMs(tone: NotifyTone): number {
  return tone === "danger" ? 30_000 : tone === "warn" ? 20_000 : 12_000;
}

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

/** The pops to fly, and how many more there were behind them. */
export function splitForDisplay(items: readonly FeedItem[], max = MAX_POPUPS_AT_ONCE) {
  if (items.length <= max) return { show: [...items], more: 0 };
  // The NEWEST are the ones flown; the older ones are counted.
  return { show: items.slice(items.length - max), more: items.length - max };
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
