/* ---------------------------------------------------------------------------
 * THE LOCKER'S RULES. Pure and client-safe: no I/O, no clock — today is an
 * argument (an IST date, "YYYY-MM-DD"), so every screen and the nightly
 * reminder pass answer from one function and a test can pin any day.
 *
 * DAYS, NOT DATES, IS WHAT A SCREEN SAYS. Every row reads "12 days" or
 * "6 days overdue" first and the date second, because the number is what
 * somebody acts on. `d` below is always "end date minus today" in whole days.
 * ------------------------------------------------------------------------- */

import { addDays, daysBetween } from "@/lib/format";
import type { TimeModel } from "./catalogue";

export type Stage =
  | "renewal_in_progress"
  | "renewal_filed"
  | "awaiting_document"
  | "superseded"
  | "cancelled"
  | "lost"
  | "suspended"
  | "disputed"
  | "draft";

export type Status = "active" | "expiring" | "renewal_due" | "in_grace" | "expired" | Stage;

export type TypeRules = { model: TimeModel; leadDays: number; graceDays: number; validityMonths: number };

export type AssetLike = {
  endDate: string | null;
  stage: string | null;
  criticality: number;
  noticeDays: number;
  ownerId: string | null;
  backupId: string | null;
  lastCheckedAt: Date | string | null;
  createdAt?: Date | string | null;
};

/** Whole days from today to the end date; null where it never ends. */
export function daysLeft(endDate: string | null, today: string): number | null {
  return endDate ? daysBetween(today, endDate) : null;
}

/**
 * WHAT STATE IT IS IN. A stage somebody set wins — "renewal applied" on a
 * licence past its end date is exactly the case the law protects — and
 * otherwise the dates decide: past the end date it is in grace while the
 * type allows one, then expired; inside the time needed to renew it is due;
 * inside ninety days it is expiring.
 */
export function statusOf(a: Pick<AssetLike, "endDate" | "stage">, t: Pick<TypeRules, "leadDays" | "graceDays">, today: string): Status {
  if (a.stage) return a.stage as Stage;
  const d = daysLeft(a.endDate, today);
  if (d == null) return "active";
  if (d < 0) return -d <= (t.graceDays || 0) ? "in_grace" : "expired";
  if (d <= t.leadDays) return "renewal_due";
  if (d <= 90) return "expiring";
  return "active";
}

/** Replaced and cancelled assets are history: they stay readable and leave every count. */
export function isLive(a: Pick<AssetLike, "stage">): boolean {
  return a.stage !== "superseded" && a.stage !== "cancelled";
}

/**
 * THE DAY SOMEBODY MUST ACT. For a contract that renews itself unless notice
 * is served, that is the last day to give notice — the term's end is too late
 * to do anything about. For everything else it is the end date.
 */
export function actionDays(a: Pick<AssetLike, "endDate" | "noticeDays">, model: TimeModel, today: string): number | null {
  const d = daysLeft(a.endDate, today);
  if (d == null) return null;
  return model === "term_contract" ? d - (a.noticeDays || 0) : d;
}

export function actionDate(a: Pick<AssetLike, "endDate" | "noticeDays">, model: TimeModel): string | null {
  if (!a.endDate) return null;
  return model === "term_contract" ? addDays(a.endDate, -(a.noticeDays || 0)) : a.endDate;
}

/** How often each importance must be checked against the real document. */
export function checkIntervalDays(criticality: number): number {
  return criticality >= 4 ? 90 : criticality === 3 ? 180 : 365;
}

export function daysSinceCheck(a: Pick<AssetLike, "lastCheckedAt" | "createdAt">, today: string): number | null {
  const at = a.lastCheckedAt ?? null;
  if (!at) return null;
  const iso = typeof at === "string" ? at.slice(0, 10) : istDay(at);
  return daysBetween(iso, today);
}

/** Never checked counts as overdue: a record nobody has held against the paper is a guess. */
export function isUnchecked(a: Pick<AssetLike, "lastCheckedAt" | "criticality">, today: string): boolean {
  const since = daysSinceCheck(a, today);
  return since == null || since > checkIntervalDays(a.criticality);
}

/** Owner always; a backup too for high and business-critical; checked inside its interval. */
export function isComplete(a: AssetLike, today: string): boolean {
  return !!a.ownerId && (a.criticality < 3 || !!a.backupId) && !isUnchecked(a, today);
}

/** "12 days", "Today", "6 days overdue", "No expiry". */
export function daysLabel(d: number | null): string {
  if (d == null) return "No expiry";
  if (d === 0) return "Today";
  const n = Math.abs(d).toLocaleString("en-IN");
  if (d > 0) return `${n} ${d === 1 ? "day" : "days"}`;
  return `${n} ${d === -1 ? "day" : "days"} overdue`;
}

/** The ladder rung that falls on today, if any: what the nightly pass sends. */
export function rungDueToday(offsets: number[], actionIn: number | null): number | null {
  if (actionIn == null) return null;
  /* An offset of -30 means "30 days before the action day", i.e. when actionIn is 30. */
  const hit = offsets.find((o) => -o === actionIn);
  if (hit !== undefined) return hit;
  /* After the last positive rung it repeats daily until somebody acts. */
  const last = Math.max(...offsets);
  return last > 0 && -actionIn > last ? -actionIn : null;
}

/**
 * Who a reminder goes to, by how late it is: the owner first, the backup from
 * the day itself, then the department head, then management — "moves up
 * owner → backup → department head → management".
 */
export function escalationLevel(actionIn: number | null): 0 | 1 | 2 | 3 {
  if (actionIn == null || actionIn > 7) return 0;
  if (actionIn > 0) return 1;
  if (actionIn > -7) return 2;
  return 3;
}

export const RENEWAL_STEPS = [
  "Not started",
  "In progress",
  "Gathering documents",
  "Submitted",
  "Awaiting office",
  "Approved",
  "Document received",
  "Checked",
  "Complete",
] as const;

/** The stage an open renewal at this step puts its asset in. */
export function stageForStep(step: number): Stage {
  if (step >= 6) return "awaiting_document";
  if (step >= 3) return "renewal_filed";
  return "renewal_in_progress";
}

/* ---------------------------------------------------------------- the vault */

export type Tier = "standard" | "sensitive" | "restricted";
export const TIER_WEIGHT: Record<Tier, number> = { restricted: 4, sensitive: 3, standard: 2 };

/**
 * HOW BAD IT IS TO LOSE ONE SIGN-IN ACCOUNT: how many logins hang off it,
 * times the most sensitive of them, multiplied up for each missing defence —
 * no 2-step sign-in ×3, not company controlled ×5, no recovery ×2.
 */
export function identityRisk(i: { mfa: boolean; controlled: boolean; recovery: boolean }, dependants: { tier: Tier }[]): number {
  const n = dependants.length;
  const maxW = dependants.reduce((m, d) => Math.max(m, TIER_WEIGHT[d.tier] ?? 1), 1);
  return Math.round(n * maxW * (i.mfa ? 1 : 3) * (i.controlled ? 1 : 5) * (i.recovery ? 1 : 2));
}

/** Days since a secret last changed, against how often its tier says it should. */
export function rotationDue(lastRotatedAt: Date | string | null, everyDays: number, today: string): { age: number | null; due: boolean; overBy: number } {
  if (!lastRotatedAt) return { age: null, due: true, overBy: 0 };
  const iso = typeof lastRotatedAt === "string" ? lastRotatedAt.slice(0, 10) : istDay(lastRotatedAt);
  const age = daysBetween(iso, today);
  return { age, due: age > everyDays, overBy: Math.max(0, age - everyDays) };
}

/** An instant as its Asia/Kolkata calendar date. */
export function istDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/* ------------------------------------------------------------ words & colour */

export const CRIT: Record<number, { label: string; bg: string; fg: string; edge: string }> = {
  4: { label: "Business critical", bg: "#FBEAEA", fg: "#8E1F1F", edge: "#B3261E" },
  3: { label: "High", bg: "#FDF0E3", fg: "#8A4F05", edge: "#C27008" },
  2: { label: "Medium", bg: "#FBF6E4", fg: "#7A6208", edge: "#B59208" },
  1: { label: "Low", bg: "#F2F4F7", fg: "#5F6572", edge: "#9BA3B2" },
};

export const STATUS: Record<Status, { label: string; bg: string; fg: string; glyph?: string; ring?: string }> = {
  active: { label: "Active", bg: "#E9F5EE", fg: "#1D7A45" },
  expiring: { label: "Expiring soon", bg: "#FDF6E7", fg: "#8A5C05" },
  renewal_due: { label: "Renewal due", bg: "#FDF6E7", fg: "#8A5C05" },
  renewal_in_progress: { label: "Renewal in progress", bg: "#EDF2FC", fg: "#2B5CBF" },
  renewal_filed: { label: "Renewal applied", bg: "#EDF2FC", fg: "#2B5CBF", glyph: "↗ ", ring: "#B9CDF2" },
  awaiting_document: { label: "Awaiting document", bg: "#EDF2FC", fg: "#2B5CBF" },
  in_grace: { label: "In grace period", bg: "#FDF2E7", fg: "#A85D08", glyph: "◔ ", ring: "#E9B985" },
  expired: { label: "Expired", bg: "#FCECEC", fg: "#B3261E", glyph: "✕ " },
  superseded: { label: "Replaced", bg: "#F7F8FA", fg: "#6B7385" },
  cancelled: { label: "Cancelled", bg: "#F7F8FA", fg: "#6B7385" },
  lost: { label: "Original lost", bg: "#FCECEC", fg: "#B3261E" },
  suspended: { label: "Suspended", bg: "#FCECEC", fg: "#B3261E" },
  disputed: { label: "Disputed", bg: "#FDF6E7", fg: "#8A5C05" },
  draft: { label: "Draft", bg: "#F7F8FA", fg: "#6B7385" },
};

export const TIER: Record<Tier, { label: string; bg: string; fg: string }> = {
  standard: { label: "Standard", bg: "#F0EFF6", fg: "#3E3660" },
  sensitive: { label: "Sensitive", bg: "#DFDCEC", fg: "#262041" },
  restricted: { label: "Restricted", bg: "#262041", fg: "#FFFFFF" },
};

/** The colour of a day count: red past the end, amber inside 30, ink otherwise. */
export function daysColour(d: number | null, status: Status): string {
  if (d != null && d < 0) return status === "in_grace" ? "#A85D08" : status === "renewal_filed" ? "#2B5CBF" : "#B3261E";
  if (d != null && d <= 30) return "#8A5C05";
  return "#1A1E28";
}

export const MODEL_LABEL: Record<TimeModel, string> = {
  document: "Document · issued and expires",
  subscription: "Subscription · renews on a cycle",
  perpetual: "Lifetime · never ends",
  term_contract: "Contract with notice period · last day to give notice matters",
};

/* ---------------------------------------------------------- reminder schedule */

/** ISO weekday, Monday 1 … Sunday 7, of a YYYY-MM-DD date. */
export function isoDow(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/**
 * The day a reminder scheduled for `date` is actually sent: that day if it is
 * a working day, else the working day before it (spec §7.3 — "a reminder
 * nobody reads on Sunday is not a reminder").
 */
export function sendDayFor(date: string, workingDays: number[]): string {
  if (!workingDays.length) return date;
  let d = date;
  for (let i = 0; i < 7 && !workingDays.includes(isoDow(d)); i++) d = addDays(d, -1);
  return d;
}

/**
 * WHICH RUNGS OF A LADDER ARE SENT TODAY. Each offset is days from the action
 * day (negative before). A rung landing on a non-working day moves to the
 * working day before it, so a Saturday may carry Sunday's rung as well as its
 * own. After the last positive rung the reminder repeats daily until the
 * asset is renewed or archived ("+1 daily until resolved").
 */
export function rungsSentOn(offsets: number[], actionDate: string | null, day: string, workingDays: number[]): number[] {
  if (!actionDate || !offsets.length) return [];
  const out: number[] = [];
  for (const o of offsets) {
    if (sendDayFor(addDays(actionDate, o), workingDays) === day) out.push(o);
  }
  const last = Math.max(...offsets);
  const past = daysBetween(actionDate, day);
  if (last > 0 && past > last && workingDays.includes(isoDow(day)) && !out.includes(past)) out.push(past);
  return out;
}

/** The sentence a reminder rung says — a lead-time rung is "start now", an end-date rung is "this ends". */
export function rungLine(offset: number, model: TimeModel): string {
  const what = model === "term_contract" ? "notice deadline" : model === "subscription" ? "renewal" : "end date";
  if (offset < 0) return `${-offset} ${offset === -1 ? "day" : "days"} to the ${what}`;
  if (offset === 0) return `the ${what} is today`;
  return `${offset} ${offset === 1 ? "day" : "days"} past the ${what}`;
}

/** Add months to an ISO date, clamping to the month's last day. */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export type ValidityUnit = "days" | "months" | "quarters" | "years";

/** Spec §4.4: issued on + valid for N units → the last valid day (the day before the anniversary). */
export function endFromValidity(issuedOn: string, n: number, unit: ValidityUnit): string {
  if (unit === "days") return addDays(issuedOn, n - 1);
  const months = unit === "months" ? n : unit === "quarters" ? n * 3 : n * 12;
  return addDays(addMonthsIso(issuedOn, Math.round(months)), -1);
}

/** The other direction: issued on + end date → the duration, in the largest whole unit that fits exactly, else days. */
export function validityFromDates(issuedOn: string, endDate: string): { n: number; unit: ValidityUnit } {
  for (const unit of ["years", "quarters", "months"] as ValidityUnit[]) {
    for (let n = 1; n <= 240; n++) {
      const e = endFromValidity(issuedOn, n, unit);
      if (e === endDate) return { n, unit };
      if (e > endDate) break;
    }
  }
  return { n: daysBetween(issuedOn, endDate) + 1, unit: "days" };
}
