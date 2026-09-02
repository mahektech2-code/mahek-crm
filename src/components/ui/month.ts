/* ---------------------------------------------------------------------------
 * Month arithmetic and formatting. PURE, and deliberately not a client module.
 *
 * `month-nav.tsx` is `"use client"` because it draws the picker. These do
 * not draw anything, and every export of a `"use client"` file — including a
 * plain function — becomes a client reference as far as the bundler is
 * concerned. A Server Component that imported `monthName` from there and
 * called it directly (not as JSX) got exactly the runtime 500 `lib/words.ts`'s
 * own comment already describes for `plural()`: a type check does not see it,
 * only a request does. `/crm/performance` called it unconditionally in its
 * subtitle and crashed on every load; `/founder/team` only called it from an
 * empty-state branch demo data happened not to reach, which is why the same
 * bug looked "fixed" there when it had only gone uncrawled.
 * ------------------------------------------------------------------------- */

import { APP_TIMEZONE } from "@/lib/business-date";

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  // Day 15, not day 1 — the middle of the month formatted in APP_TIMEZONE
  // cannot fall into a neighbouring month no matter which zone the process
  // itself is running in.
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: APP_TIMEZONE,
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}
