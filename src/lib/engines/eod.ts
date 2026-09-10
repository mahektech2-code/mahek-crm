import type { BusinessDate } from "../business-date";

/* ---------------------------------------------------------------------------
 * E6 — EOD Aggregator
 *
 * The day's numbers for one user, plus a plain-text form designed to paste
 * straight into WhatsApp. The formatting is a functional requirement, not a
 * nicety — short lines, no tables, no characters that render badly.
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

  /**
   * Customers called from the calling queue today.
   *
   * Deliberately NOT "x of y". The denominator — how many were on today's
   * queue — can only be had by building the queue, which is what the Call Log
   * does and shows. Computing a second, cheaper one here produced "3 of 8"
   * against the Call Log's "3 of 4", and then "3 of 2". A number that cannot
   * be derived the same way twice does not belong on two screens.
   */
  queueWorked: number;

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
  /** Cans converted through each SKU's own packing — see lib/catalogue.ts. */
  ordersBoxes: number;
  ordersLooseCans: number;

  followUpsMade: number;
  promisesCount: number;
  promisesValue: number;
  paymentsConfirmed: number;
  /** Who promised, and when — the WhatsApp message names them. */
  promisedCustomers: Array<{ name: string; date: BusinessDate | null }>;

  remindersClosed: number;
  remindersCreated: number;
  remindersCarriedForward: number;

  complaintsLogged: number;
  /** Orders logged with no call at all — real work, counted separately. */
  ordersWithoutCall: number;
  whatsappSent: number;

  /** Calls with the `no_order` outcome, and why — from the quick notes picked. */
  noOrderCount: number;
  noOrderReasons: Array<{ label: string; count: number }>;

  /**
   * The size of TODAY's calling queue, read from `queue_snapshots` — the same
   * frozen composition the Call Log itself shows, never a second count built
   * here. Zero where the queue was never opened today, which is the honest
   * answer rather than a live rebuild that could disagree with whatever the
   * Call Log freezes if it is opened later the same day.
   */
  queueAssigned: number;
  /** Queued customers carrying a P1/P2 reason (see registry.ts) not yet called. */
  highPriorityPending: number;

  /** The collections seat of the same queue — `paymentOverdue` entries only. */
  paymentAssigned: number;
  paymentCallsMade: number;
  paymentWaSent: number;
  /** Distinct payment-tagged customers reached by EITHER channel today. */
  paymentActioned: number;

  targetAchieved: number;
  targetAmount: number;
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
 * "Mon, 3 Aug, 2026" — the individual WhatsApp message's own date line.
 *
 * The weekday is read off `Date.UTC(y, m, d)`, which is deterministic from
 * the calendar date alone and touches no clock — a `BusinessDate` already
 * names a day, not an instant, so there is no zone to get wrong here.
 */
export function formatDateLong(date: BusinessDate): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[m - 1]}, ${y}`;
}

/** "23 Jun 26" — short enough for a promise line beside a customer's name. */
export function formatDateShort(date: BusinessDate): string {
  const [y, m, d] = date.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

/**
 * "3 · ₹1,20,000" where everything taken today has been approved, and
 * "3 taken · 1 approved · ₹40,000" where it has not.
 *
 * The second form only appears when the two numbers actually differ, so a
 * normal day reads as a single figure and the split shows up exactly when it
 * means something — that some of today's work is still sitting with accounts.
 */
function describeOrders(input: Omit<EodInput, "userName" | "date">): string {
  const value = formatMoney(input.ordersValue);
  if (input.ordersCaptured === input.ordersCount) {
    return `${input.ordersCount} · ${value}`;
  }
  return `${input.ordersCaptured} taken · ${input.ordersCount} approved · ${value}`;
}

/**
 * The Orders line's own number — the telecaller's OWN work, same reasoning
 * as `describeOrders`: an order taken this morning and not yet approved must
 * not read as a day with nothing done. Equal in the ordinary case, where it
 * is exactly the count the new format asks for.
 */
function ordersLineValue(input: Omit<EodInput, "userName" | "date">): string {
  if (input.ordersCaptured === input.ordersCount) return String(input.ordersCount);
  return `${input.ordersCaptured} (${input.ordersCount} appr.)`;
}

/** "(Will order later×4, Price issue×1)" — empty where nothing was picked. */
function describeNoOrderReasons(reasons: Array<{ label: string; count: number }>): string {
  if (!reasons.length) return "";
  return ` (${reasons.map((r) => `${r.label}×${r.count}`).join(", ")})`;
}

/** Section breaks in the WhatsApp message. WhatsApp renders `─` as a plain rule. */
const DIVIDER = "─".repeat(24);

/**
 * The table half of a report — every figure but the paste-ready message —
 * pulled out on its own because it is also what a period OTHER than a single
 * day needs. `aggregateEod` calls this for "today"; a screen showing "last 7
 * days" or a custom range calls it directly on `eodMetricsForRange`'s output,
 * which carries the same fields minus `userName` and `date` — a range has
 * neither a single person's name attached here nor one date to print.
 */
export function eodLines(
  input: Omit<EodInput, "userName" | "date">,
): Array<{ label: string; value: string }> {
  const percent = input.targetAmount
    ? Math.round((input.targetAchieved / input.targetAmount) * 100)
    : 0;

  return [
    { label: "Customers called from the queue", value: String(input.queueWorked) },
    { label: "Calls attempted", value: String(input.callsAttempted) },
    { label: "Connected", value: String(input.callsConnected) },
    { label: "Inbound received", value: String(input.callsInbound) },
    { label: "Missed", value: String(input.callsMissed) },
    { label: "Orders", value: describeOrders(input) },
    { label: "Orders received without a call", value: String(input.ordersWithoutCall) },
    { label: "Payment follow-ups", value: String(input.followUpsMade) },
    { label: "Promises obtained", value: `${input.promisesCount} · ${formatMoney(input.promisesValue)}` },
    { label: "Payments confirmed", value: formatMoney(input.paymentsConfirmed) },
    { label: "Reminders closed", value: String(input.remindersClosed) },
    { label: "Reminders created", value: String(input.remindersCreated) },
    { label: "Reminders carried forward", value: String(input.remindersCarriedForward) },
    { label: "Complaints logged", value: String(input.complaintsLogged) },
    { label: "WhatsApp sent", value: String(input.whatsappSent) },
    {
      label: "Monthly target",
      value: `${formatMoney(input.targetAchieved)} of ${formatMoney(input.targetAmount)} (${percent}%)`,
    },
  ];
}

export function aggregateEod(input: EodInput): EodReport {
  const percent = input.targetAmount
    ? Math.round((input.targetAchieved / input.targetAmount) * 100)
    : 0;

  const lines = eodLines(input);

  // Calls PENDING is not a second "assigned" — it is Assigned minus Called,
  // read below from the same `queueAssigned`/`queueWorked` this message
  // already prints, so the two numbers can never disagree with each other.
  const queuePending = Math.max(0, input.queueAssigned - input.queueWorked);
  const calledPercent = input.queueAssigned
    ? Math.round((input.queueWorked / input.queueAssigned) * 100)
    : 0;
  const paymentPending = Math.max(0, input.paymentAssigned - input.paymentActioned);

  const whatsappText = [
    `*📊 EOD — ${input.userName}*`,
    formatDateLong(input.date),
    DIVIDER,
    `📞 Order Calls: *${input.callsAttempted} / ${queuePending}*`,
    `✅ Orders: *${ordersLineValue(input)}*`,
    ...(input.ordersBoxes || input.ordersLooseCans
      ? [`   📦 ${input.ordersBoxes} Box  🥫 ${input.ordersLooseCans} Can`]
      : []),
    `📵 No Answer: ${input.callsMissed}`,
    `🚫 No Order: ${input.noOrderCount}${describeNoOrderReasons(input.noOrderReasons)}`,
    `💰 Payment Calls: *${input.paymentCallsMade} / ${input.paymentAssigned}*`,
    `💬 Payment WA Sent: *${input.paymentWaSent} / ${input.paymentAssigned}*`,
    DIVIDER,
    `📋 Assigned: *${input.queueAssigned}*`,
    `☎️  Called:   *${input.queueWorked}* (${calledPercent}%)`,
    // Only said when there was a queue to clear — an empty queue is not a
    // high-priority queue somebody finished, it is a day nobody opened one.
    ...(input.queueAssigned > 0 && input.highPriorityPending === 0
      ? ["✅ All high priority customers called!"]
      : []),
    DIVIDER,
    `🤝 Pay Promised: *${input.promisedCustomers.length}*`,
    ...input.promisedCustomers.map(
      (p) => `   • ${p.name} → ${p.date ? formatDateShort(p.date) : "no date"}`,
    ),
    DIVIDER,
    `🎯 Month: *${percent}%* (${formatMoney(input.targetAchieved)} / ${formatMoney(input.targetAmount)})`,
    `💸 Payment Follow-up: ${input.paymentAssigned} assigned`,
    `   ✅ Sent: ${input.paymentActioned}  ·  ⏳ Pending: ${paymentPending}`,
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
 */
export function aggregateTeamEod(
  date: BusinessDate,
  rows: TeamRow[],
): TeamRollup {
  // Split from the numbers: `noOrderReasons` and `promisedCustomers` are
  // arrays, and `+=` on an array is JavaScript coercing it to a string, not
  // summing it — the generic loop below is only ever handed the numeric
  // fields, and the two arrays are merged on their own beneath it.
  const numericZero = {
    callsAttempted: 0, callsConnected: 0, callsInbound: 0, callsMissed: 0, ordersWithoutCall: 0,
    queueWorked: 0,
    ordersCaptured: 0, ordersCount: 0, ordersValue: 0, ordersBoxes: 0, ordersLooseCans: 0,
    followUpsMade: 0, promisesCount: 0, promisesValue: 0, paymentsConfirmed: 0,
    remindersClosed: 0, remindersCreated: 0, remindersCarriedForward: 0,
    complaintsLogged: 0, whatsappSent: 0,
    noOrderCount: 0,
    queueAssigned: 0, highPriorityPending: 0,
    paymentAssigned: 0, paymentCallsMade: 0, paymentWaSent: 0, paymentActioned: 0,
    targetAchieved: 0, targetAmount: 0,
  };

  const numericTotals = rows.reduce((acc, r) => {
    for (const key of Object.keys(acc) as Array<keyof typeof acc>) {
      acc[key] += r[key];
    }
    return acc;
  }, { ...numericZero });

  const noOrderReasons: Array<{ label: string; count: number }> = [];
  for (const r of rows) {
    for (const reason of r.noOrderReasons) {
      const existing = noOrderReasons.find((x) => x.label === reason.label);
      if (existing) existing.count += reason.count;
      else noOrderReasons.push({ ...reason });
    }
  }

  const totals: Omit<EodInput, "userName" | "date"> = {
    ...numericTotals,
    noOrderReasons,
    promisedCustomers: rows.flatMap((r) => r.promisedCustomers),
  };

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
