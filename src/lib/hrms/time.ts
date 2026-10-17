/* ---------------------------------------------------------------------------
 * Days, months and clock times as HRMS stores them: ISO dates, "YYYY-MM"
 * months and "HH:MM" wall-clock times, all in Asia/Kolkata. Durations are
 * minutes.
 *
 * PURE and client-safe. The two functions that read the clock (`todayIST`,
 * `nowHM`) are for server code and event handlers only — never a render.
 * ------------------------------------------------------------------------- */

import { APP_TIMEZONE } from "@/lib/business-date";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Today in Asia/Kolkata, "YYYY-MM-DD". */
export function todayIST(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The wall clock in Asia/Kolkata, "HH:MM". */
export function nowHM(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/** "HH:MM" → minutes since midnight; null for anything else. */
export function tmin(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes since midnight → "HH:MM". */
export function hhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 492 → "8h 12m"; negative durations keep their sign. */
export function hm(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "";
  const neg = min < 0;
  const a = Math.abs(Math.round(min));
  const s = `${Math.floor(a / 60)}h ${String(a % 60).padStart(2, "0")}m`;
  return neg ? `−${s}` : s;
}

/** "2026-09-27" → "2026-09". */
export function monthOf(date: string): string {
  return String(date).slice(0, 7);
}

/** "2026-09" → "Sep 2026". */
export function monLabel(month: string): string {
  const [y, m] = month.split("-");
  const i = Number(m) - 1;
  return i >= 0 && i < 12 ? `${MON[i]} ${y}` : month;
}

/** "2026-09" → "September". */
export function monthName(month: string): string {
  return MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
}

export function daysIn(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The weekday of an ISO date, independent of any machine's zone. */
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetweenISO(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** The month before "YYYY-MM". */
export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Every ISO date in a month. */
export function datesOfMonth(month: string): string[] {
  const n = daysIn(month);
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Every ISO date from `a` to `b` inclusive. */
export function datesBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = a; d <= b; d = addDaysISO(d, 1)) out.push(d);
  return out;
}

/** "2026-09-27" → "27 Sep". */
export function fdShort(date: string | null | undefined): string {
  if (!date) return "";
  const [, m, d] = String(date).split("-");
  return `${Number(d)} ${MON[Number(m) - 1] ?? ""}`;
}

/** Years and months between two dates (joining → today), correctly borrowing. */
export function workingAge(from: string, to: string): string {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  let months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  if (months < 0) months = 0;
  return `${Math.floor(months / 12)} Years ${months % 12} Months`;
}

/** Great-circle distance in metres. */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** 2437 → "2.4 km", 38 → "38 m". */
export function distanceLabel(m: number | null | undefined): string {
  if (m == null) return "";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}
