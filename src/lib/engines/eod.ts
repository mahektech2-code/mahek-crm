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
  callsMissed: number;

  queueServed: number;
  queueWorked: number;

  ordersCount: number;
  ordersValue: number;

  followUpsMade: number;
  promisesCount: number;
  promisesValue: number;
  paymentsConfirmed: number;

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

export function formatDate(date: BusinessDate): string {
  const [y, m, d] = date.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function aggregateEod(input: EodInput): EodReport {
  const percent = input.targetAmount
    ? Math.round((input.targetAchieved / input.targetAmount) * 100)
    : 0;

  const lines = [
    { label: "Queue worked", value: `${input.queueWorked} of ${input.queueServed}` },
    { label: "Calls attempted", value: String(input.callsAttempted) },
    { label: "Connected", value: String(input.callsConnected) },
    { label: "Missed", value: String(input.callsMissed) },
    { label: "Orders", value: `${input.ordersCount} · ${formatMoney(input.ordersValue)}` },
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

  // Short lines, a middot as the only separator, asterisks for the one bold
  // line. Nothing that WhatsApp renders badly, and no table characters.
  const whatsappText = [
    `*EOD — ${input.userName}*`,
    formatDate(input.date),
    "",
    `Calls: ${input.callsAttempted} attempted · ${input.callsConnected} connected · ${input.callsMissed} missed`,
    `Orders: ${input.ordersCount} (${formatMoney(input.ordersValue)})`,
    ...(input.ordersWithoutCall
      ? [`Orders received without a call: ${input.ordersWithoutCall}`]
      : []),
    `Payments: ${input.followUpsMade} followed up · ${formatMoney(input.promisesValue)} promised`,
    `Reminders: ${input.remindersClosed} closed · ${input.remindersCarriedForward} carried forward`,
    `Complaints: ${input.complaintsLogged} logged`,
    `Target: ${formatMoney(input.targetAchieved)} of ${formatMoney(input.targetAmount)} (${percent}%)`,
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
  const zero = (): Omit<EodInput, "userName" | "date"> => ({
    callsAttempted: 0, callsConnected: 0, callsMissed: 0, ordersWithoutCall: 0,
    queueServed: 0, queueWorked: 0,
    ordersCount: 0, ordersValue: 0,
    followUpsMade: 0, promisesCount: 0, promisesValue: 0, paymentsConfirmed: 0,
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
    `*EOD — Team*`,
    formatDate(date),
    "",
    `Calls: ${totals.callsAttempted} attempted · ${totals.callsConnected} connected · ${totals.callsMissed} missed`,
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
