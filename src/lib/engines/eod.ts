import type { BusinessDate } from "../business-date";

/* ---------------------------------------------------------------------------
 * E6 — EOD Aggregator
 *
 * The day's numbers for one user, plus a paste-ready WhatsApp form.
 *
 * The report used to deliberately avoid emoji and dividers — "nothing that
 * WhatsApp renders badly, and no table characters" — because the six-line
 * report it produced didn't need them to stay readable. This one is longer
 * and grouped into sections, so the opposite is now true: the emoji and the
 * "─" dividers are what let a manager scan fifteen lines in a few seconds
 * instead of reading them. Still verified by pasting into real WhatsApp.
 *
 * Pure.
 * ------------------------------------------------------------------------- */

export type EodInput = {
  userName: string;
  date: BusinessDate;

  /** Calls. `missed` is DERIVED from the no-answer connection status. */
  callsAttempted: number;
  callsConnected: number;
  /** Calls the customer placed to us. Never counted as attempted. */
  callsInbound: number;
  callsMissed: number;
  /** targets.dailyCallTarget. 0 means no target is configured. */
  callTarget: number;

  /**
   * Customers called from the calling queue today.
   *
   * Deliberately NOT "x of y" against a freshly computed denominator — see
   * `queueAssigned` below for why that denominator is read from the settled
   * snapshot instead.
   */
  queueWorked: number;
  /** Rows on today's SETTLED queue snapshot for this user — see eod-service.ts. */
  queueAssigned: number;
  /** Of `queueAssigned`, how many carry a high-priority reason (a broken
   *  promise, an overdue debt, a customer a full cycle past due). */
  highPriorityTotal: number;
  highPriorityCalled: number;

  /**
   * Two different questions about the same rows, and they have different
   * answers — see lib/order-status.ts.
   *
   *   `ordersCaptured` — orders the telecaller logged today. Their work, true
   *   the moment the customer said yes.
   *
   *   `ordersCount` — orders accounts have approved. The sale, and the only
   *   one of the two that may carry a value.
   *
   * The report says both, because a day's work reported as nothing because
   * accounts have not got to it yet is a telecaller's record of their own day
   * being wrong.
   */
  ordersCaptured: number;
  ordersCount: number;
  ordersValue: number;
  /** Today's captured order lines, summed via lib/catalogue.ts's own packing math. */
  ordersBoxes: number;
  ordersCans: number;

  /** Outcome = no_order, today. The reasons behind it are `extras.noOrderReasons`. */
  noOrderCount: number;

  followUpsMade: number;
  promisesCount: number;
  promisesValue: number;
  paymentsConfirmed: number;
  /** Today's LIVE collections worklist size — see eod-service.ts for why. */
  paymentCallsAssigned: number;
  paymentWaSent: number;
  paymentWaAssigned: number;
  /** The combined calls+WA rollup: assigned = sent + pending, always. */
  followUpAssigned: number;
  followUpSent: number;
  followUpPending: number;

  remindersClosed: number;
  remindersCreated: number;
  remindersCarriedForward: number;

  complaintsLogged: number;
  /** Orders logged with no call at all — real work, counted separately. */
  ordersWithoutCall: number;
  whatsappSent: number;

  targetAchieved: number;
  targetAmount: number;
};

/**
 * The fields the dashboard's own "today"/"this week" reads need too — a
 * strict subset of `EodInput`. `eodMetricsForRange` in eod-service.ts, which
 * the dashboard calls directly (including once per team member for a team
 * view), returns exactly this and nothing more: the EOD-only fields below
 * cost a settled queue snapshot, a live collections-worklist read and a
 * product-line join, none of which the dashboard has ever needed and none of
 * which even mean anything over a date RANGE — a collections worklist is a
 * "today" concept, not something to sum across a week.
 */
export type DashboardMetrics = Omit<
  EodInput,
  | "userName"
  | "date"
  | "callTarget"
  | "queueAssigned"
  | "highPriorityTotal"
  | "highPriorityCalled"
  | "ordersBoxes"
  | "ordersCans"
  | "noOrderCount"
  | "paymentCallsAssigned"
  | "paymentWaSent"
  | "paymentWaAssigned"
  | "followUpAssigned"
  | "followUpSent"
  | "followUpPending"
>;

/**
 * The two list-shaped, per-telecaller-only sections. Kept off `EodInput` so
 * `TeamRow` — which is `EodInput` minus name and date — stays a flat,
 * summable row; a list of promised customers has no honest team total.
 */
export type EodExtras = {
  noOrderReasons: Array<{ label: string; count: number }>;
  promises: Array<{ customerName: string; date: BusinessDate }>;
};

export type EodReport = {
  date: BusinessDate;
  userName: string;
  lines: Array<{ label: string; value: string }>;
  /** Paste-ready. Verified by pasting into real WhatsApp. */
  whatsappText: string;
};

/** Indian digit grouping: 1,84,500 — not 184,500. */
export function formatMoney(paise: number): string {
  const rupees = Math.round(paise / 100);
  const s = String(Math.abs(rupees));
  const grouped =
    s.length <= 3
      ? s
      : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
  return `${rupees < 0 ? "−" : ""}₹${grouped}`;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export function formatDate(date: BusinessDate): string {
  const [y, m, d] = date.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * The weekday of an already-resolved calendar date. Built with `Date.UTC` so
 * it never reads a clock or a session timezone — it is naming a day of the
 * week that a Y-M-D string already fixes, not deriving a date from an
 * instant, so none of the app's usual timestamp rules apply here.
 */
function weekdayOf(date: BusinessDate): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "Sat, 20 Jun, 2026" — the header date, weekday-first for a quick scan. */
function formatDateWithWeekday(date: BusinessDate): string {
  const [y, m, d] = date.split("-");
  return `${weekdayOf(date)}, ${Number(d)} ${MONTHS[Number(m) - 1]}, ${y}`;
}

/** "23 Jun 26" — short enough for a promise list without crowding the customer name. */
function formatShortDate(date: BusinessDate): string {
  const [y, m, d] = date.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y.slice(-2)}`;
}

/**
 * "3 · ₹1,20,000" where everything taken today has been approved, and
 * "3 taken · 1 approved · ₹40,000" where it has not.
 *
 * The second form only appears when the two numbers actually differ, so a
 * normal day reads as a single figure and the split shows up exactly when it
 * means something — that some of today's work is still sitting with accounts.
 */
function describeOrders(input: EodInput): string {
  const value = formatMoney(input.ordersValue);
  if (input.ordersCaptured === input.ordersCount) {
    return `${input.ordersCount} · ${value}`;
  }
  return `${input.ordersCaptured} taken · ${input.ordersCount} approved · ${value}`;
}

/**
 * "5 (Will order later×4)" — the total, then the reasons behind it in the
 * order they were tallied. Shared by the table and the message: one shape,
 * so the two cannot describe the same day differently.
 */
function describeNoOrder(count: number, reasons: EodExtras["noOrderReasons"]): string {
  if (!reasons.length) return String(count);
  return `${count} (${reasons.map((r) => `${r.label}×${r.count}`).join(", ")})`;
}

/** "✅ All high priority customers called!" or how many of them are still owed a call. */
function describePriorityLine(total: number, called: number): string | null {
  if (total === 0) return null;
  if (called >= total) return "✅ All high priority customers called!";
  return `⚠️ ${total - called} of ${total} high priority customers still pending`;
}

const DIVIDER = "─".repeat(24);

export function aggregateEod(input: EodInput, extras: EodExtras): EodReport {
  const percent = input.targetAmount
    ? Math.round((input.targetAchieved / input.targetAmount) * 100)
    : 0;
  const queuePercent = input.queueAssigned
    ? Math.round((input.queueWorked / input.queueAssigned) * 100)
    : 0;
  const noOrderText = describeNoOrder(input.noOrderCount, extras.noOrderReasons);
  const priorityLine = describePriorityLine(input.highPriorityTotal, input.highPriorityCalled);

  const lines = [
    { label: "Customers called from the queue", value: String(input.queueWorked) },
    { label: "Calls attempted", value: String(input.callsAttempted) },
    { label: "Connected", value: String(input.callsConnected) },
    { label: "Inbound received", value: String(input.callsInbound) },
    { label: "Missed", value: String(input.callsMissed) },
    { label: "Orders", value: describeOrders(input) },
    { label: "Order quantity", value: `${input.ordersBoxes} box · ${input.ordersCans} can` },
    { label: "No order", value: noOrderText },
    { label: "Orders received without a call", value: String(input.ordersWithoutCall) },
    { label: "Payment follow-ups", value: String(input.followUpsMade) },
    { label: "Promises obtained", value: `${input.promisesCount} · ${formatMoney(input.promisesValue)}` },
    { label: "Payments confirmed", value: formatMoney(input.paymentsConfirmed) },
    { label: "Reminders closed", value: String(input.remindersClosed) },
    { label: "Reminders created", value: String(input.remindersCreated) },
    { label: "Reminders carried forward", value: String(input.remindersCarriedForward) },
    { label: "Complaints logged", value: String(input.complaintsLogged) },
    { label: "WhatsApp sent", value: String(input.whatsappSent) },
    { label: "Payment WhatsApp sent", value: `${input.paymentWaSent} of ${input.paymentWaAssigned}` },
    {
      label: "High priority customers called",
      value: input.highPriorityTotal ? `${input.highPriorityCalled} of ${input.highPriorityTotal}` : "None today",
    },
    {
      label: "Monthly target",
      value: `${formatMoney(input.targetAchieved)} of ${formatMoney(input.targetAmount)} (${percent}%)`,
    },
  ];

  const whatsappText = [
    `*📊 EOD — ${input.userName}*`,
    `📅 ${formatDateWithWeekday(input.date)}`,
    DIVIDER,
    `📞 Order Calls: *${input.callsAttempted} / ${input.callTarget}*   ✅ Orders: *${input.ordersCaptured}*`,
    `   📦 ${input.ordersBoxes} Box  🥫 ${input.ordersCans} Can`,
    `📵 No Answer: ${input.callsMissed}`,
    `🚫 No Order: ${noOrderText}`,
    `💰 Payment Calls: *${input.followUpsMade} / ${input.paymentCallsAssigned}*`,
    `💬 Payment WA Sent: *${input.paymentWaSent} / ${input.paymentWaAssigned}*`,
    DIVIDER,
    `📋 Assigned: *${input.queueAssigned}*`,
    `☎️  Called:   *${input.queueWorked}* (${queuePercent}%)`,
    ...(priorityLine ? [priorityLine, DIVIDER] : []),
    `🤝 Pay Promised: *${input.promisesCount}*`,
    ...extras.promises.map((p) => `   • ${p.customerName} → ${formatShortDate(p.date)}`),
    DIVIDER,
    `🎯 Month: *${percent}%* (${formatMoney(input.targetAchieved)} / ${formatMoney(input.targetAmount)})`,
    `💸 Payment Follow-up: ${input.followUpAssigned} assigned`,
    `   ✅ Sent: ${input.followUpSent}  ·  ⏳ Pending: ${input.followUpPending}`,
  ].join("\n");

  return { date: input.date, userName: input.userName, lines, whatsappText };
}

/* --------------------------------------------------------- pre-flight gate */

export type BlockingReminder = {
  id: string;
  customerName: string;
  note: string;
  dueDate: BusinessDate;
};

export type PreflightResult =
  | { canFinalise: true }
  | { canFinalise: false; blocking: BlockingReminder[]; message: string };

/**
 * A report cannot be finalised while reminders due today are still open. Each
 * must be explicitly closed or carried forward — that is the whole point of
 * the gate, and why it is enforced here rather than in the interface.
 */
export function eodPreflight(
  openRemindersDueToday: BlockingReminder[],
): PreflightResult {
  if (!openRemindersDueToday.length) return { canFinalise: true };
  const n = openRemindersDueToday.length;
  return {
    canFinalise: false,
    blocking: openRemindersDueToday,
    message: `${n} reminder${n === 1 ? "" : "s"} due today ${n === 1 ? "is" : "are"} still open. Close or carry ${n === 1 ? "it" : "them"} forward before finalising.`,
  };
}

/* ------------------------------------------------------------- team roll-up */

export type TeamRow = { userName: string } & Omit<EodInput, "userName" | "date">;

export type TeamRollup = {
  date: BusinessDate;
  rows: Array<TeamRow & { targetPercent: number }>;
  totals: Omit<EodInput, "userName" | "date">;
  whatsappText: string;
};

/**
 * Identical structure and identical metric definitions to the individual
 * report, so figures across the team are directly comparable.
 *
 * The team message itself stays the old six-line shape — the new sections
 * (no-order reasons, the promise list, the high-priority callout) are
 * per-telecaller detail a roll-up has no room for, not something dropped by
 * oversight.
 */
export function aggregateTeamEod(
  date: BusinessDate,
  rows: TeamRow[],
): TeamRollup {
  const zero = (): Omit<EodInput, "userName" | "date"> => ({
    callsAttempted: 0, callsConnected: 0, callsInbound: 0, callsMissed: 0, callTarget: 0, ordersWithoutCall: 0,
    queueWorked: 0, queueAssigned: 0, highPriorityTotal: 0, highPriorityCalled: 0,
    ordersCaptured: 0, ordersCount: 0, ordersValue: 0, ordersBoxes: 0, ordersCans: 0,
    noOrderCount: 0,
    followUpsMade: 0, promisesCount: 0, promisesValue: 0, paymentsConfirmed: 0,
    paymentCallsAssigned: 0, paymentWaSent: 0, paymentWaAssigned: 0,
    followUpAssigned: 0, followUpSent: 0, followUpPending: 0,
    remindersClosed: 0, remindersCreated: 0, remindersCarriedForward: 0,
    complaintsLogged: 0, whatsappSent: 0,
    targetAchieved: 0, targetAmount: 0,
  });

  const totals = rows.reduce((acc, r) => {
    for (const key of Object.keys(acc) as Array<keyof typeof acc>) {
      acc[key] += r[key];
    }
    return acc;
  }, zero());

  const withPercent = rows.map((r) => ({
    ...r,
    targetPercent: r.targetAmount
      ? Math.round((r.targetAchieved / r.targetAmount) * 100)
      : 0,
  }));

  const whatsappText = [
    `*EOD - Team*`,
    formatDate(date),
    "",
    `Calls: ${totals.callsAttempted} attempted · ${totals.callsConnected} connected · ${totals.callsMissed} missed · ${totals.callsInbound} inbound`,
    `Orders: ${totals.ordersCount} (${formatMoney(totals.ordersValue)})`,
    ...(totals.ordersWithoutCall
      ? [`Orders received without a call: ${totals.ordersWithoutCall}`]
      : []),
    `Payments: ${totals.followUpsMade} followed up · ${formatMoney(totals.promisesValue)} promised`,
    "",
    ...withPercent.map(
      (r) =>
        `${r.userName}: ${r.callsConnected}/${r.callsAttempted} · ${r.ordersCount} orders · ${r.targetPercent}%`,
    ),
  ].join("\n");

  return { date, rows: withPercent, totals, whatsappText };
}
