/* ---------------------------------------------------------------------------
 * POSTER FORWARDING HISTORY — the rules, pure.
 *
 * The My posters table lists two kinds of record side by side:
 *   - a MADE POSTER (one row each, however many times it was shared), and
 *   - a RECIPIENT of an uploaded poster in a STARTED forwarding list.
 * Making a poster is not forwarding it. A made poster shows "Not forwarded"
 * until somebody opens WhatsApp from it; "Not Started" belongs only to a
 * recipient who was actually selected in a started list and not yet touched.
 * "Marked Sent" is what a person said — never a delivery.
 * ------------------------------------------------------------------------- */

export const HISTORY_MODES = ["individual", "bulk_run", "bulk_upload"] as const;
export type HistoryMode = (typeof HISTORY_MODES)[number];

export const MODE_LABEL: Record<HistoryMode, { main: string; sub: string | null }> = {
  individual: { main: "Individual", sub: null },
  bulk_run: { main: "Bulk", sub: "Poster run" },
  bulk_upload: { main: "Bulk", sub: "Upload" },
};

/** The four forwarding statuses, plus "Not forwarded", which is NOT a status: no forwarding record exists. */
export const HISTORY_STATUSES = ["pending", "opened", "sent", "skipped", "not_forwarded"] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export const HISTORY_STATUS_LABEL: Record<HistoryStatus, string> = {
  pending: "Not Started",
  opened: "Chat Opened",
  sent: "Marked Sent",
  skipped: "Skipped",
  not_forwarded: "Not forwarded",
};

export const HISTORY_STATUS_HINT: Record<HistoryStatus, string> = {
  pending: "Selected in a forwarding list; nothing done yet.",
  opened: "A WhatsApp chat was opened. Nothing more is known.",
  sent: "The person marked it sent. WhatsApp delivery is not confirmed.",
  skipped: "The person chose not to send it to this recipient.",
  not_forwarded: "The poster was made, but no forwarding was recorded.",
};

/** A made poster: has WhatsApp ever been opened from it? Downloads and phone shares are not forwarding. */
export const posterStatus = (whatsappOpens: number): HistoryStatus => (whatsappOpens > 0 ? "opened" : "not_forwarded");

/** A stored forward-recipient status becomes a history status; anything unknown reads as Not Started, never as sent. */
export function forwardStatus(raw: string): HistoryStatus {
  return raw === "opened" || raw === "sent" || raw === "skipped" ? raw : "pending";
}

export const HISTORY_PAGE = 30;
export const SEARCH_MAX = 80;

export type HistoryFilters = {
  q: string;
  poster: string;
  recipient: string;
  mode: HistoryMode | null;
  status: HistoryStatus | null;
  from: string | null;
  to: string | null;
  user: string | null;
  /** all = every poster, as the page always did; forwarded = only rows with a forwarding record. */
  show: "all" | "forwarded";
  page: number;
};

export type RawParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
const text = (v: string | string[] | undefined) => one(v).replace(/[\u0000-\u001f]/g, " ").trim().replace(/\s+/g, " ").slice(0, SEARCH_MAX);
const day = (v: string | string[] | undefined): string | null => {
  const s = one(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  /* A real calendar day: build it from its parts and read the same parts back (a plain date, no time zone involved). */
  const [y, m, dd] = s.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  return d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === dd ? s : null;
};

/** Every filter arrives from a URL, so every one is checked here: unknown values are dropped, never passed on. */
export function parseFilters(p: RawParams): HistoryFilters {
  const mode = one(p.mode);
  const status = one(p.status);
  const user = one(p.user).trim();
  const page = Number.parseInt(one(p.page), 10);
  return {
    q: text(p.q),
    poster: text(p.poster),
    recipient: text(p.recipient),
    mode: (HISTORY_MODES as readonly string[]).includes(mode) ? (mode as HistoryMode) : null,
    status: (HISTORY_STATUSES as readonly string[]).includes(status) ? (status as HistoryStatus) : null,
    from: day(p.from),
    to: day(p.to),
    user: /^[A-Za-z0-9_-]{1,64}$/.test(user) ? user : null,
    show: one(p.show) === "forwarded" ? "forwarded" : "all",
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

export const KEY_RE = /^[pf]:[A-Za-z0-9_-]{1,64}$/;
export type RowKey = { kind: "poster" | "forward"; id: string };
export function parseKey(raw: string | undefined | null): RowKey | null {
  if (!raw || !KEY_RE.test(raw)) return null;
  return { kind: raw[0] === "p" ? "poster" : "forward", id: raw.slice(2) };
}

/** Whether a filter set can only be answered by rows that have a forwarding record. */
export const needsForwarded = (f: HistoryFilters) => f.show === "forwarded" || (f.status !== null && f.status !== "not_forwarded");

export function activeFilterCount(f: HistoryFilters): number {
  return [f.poster, f.recipient, f.mode, f.status, f.from, f.to, f.user, f.show === "forwarded" ? "x" : ""].filter(Boolean).length;
}
