/* ---------------------------------------------------------------------------
 * Order follow-up and petty-cash arithmetic (spec §13.1, §13.2.1), PURE.
 * ------------------------------------------------------------------------- */

import { addDaysIso, daysBetween } from "./sales";

export type FollowOrder = { id: string; party: string; product: string; date: string };

export type FollowFigures = {
  lastParty: string | null;
  dayCountParty: number | null;
  lastProduct: string | null;
  dayCountProduct: number | null;
  averageDays: number | null;
  nextOrder: string | null;
};

/**
 * For every order, the party's PREVIOUS order date and the same party and
 * product's previous one — by order date, never by row position (spec §14
 * A-22) — the gaps in days, the party's average gap and the next expected
 * order. Orders on one date are one visit: the previous order is the latest
 * strictly earlier date.
 */
export function followFigures(orders: FollowOrder[]): Map<string, FollowFigures> {
  const byParty = new Map<string, FollowOrder[]>();
  for (const o of orders) byParty.set(o.party, [...(byParty.get(o.party) ?? []), o]);
  const out = new Map<string, FollowFigures>();
  for (const list of byParty.values()) {
    const dates = [...new Set(list.map((o) => o.date))].sort();
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
    const positive = gaps.filter((g) => g > 0);
    const average = positive.length ? Math.round(positive.reduce((a, g) => a + g, 0) / positive.length) : null;
    for (const o of list) {
      const before = dates.filter((d) => d < o.date);
      const lastParty = before.length ? before[before.length - 1] : null;
      const productBefore = [...new Set(list.filter((x) => x.product === o.product && x.date < o.date).map((x) => x.date))].sort();
      const lastProduct = productBefore.length ? productBefore[productBefore.length - 1] : null;
      out.set(o.id, {
        lastParty,
        dayCountParty: lastParty ? daysBetween(lastParty, o.date) : null,
        lastProduct,
        dayCountProduct: lastProduct ? daysBetween(lastProduct, o.date) : null,
        averageDays: average,
        nextOrder: lastParty && average != null ? addDaysIso(o.date, average) : null,
      });
    }
  }
  return out;
}

/** The day to ring: the next expected order plus the party's reminder days. */
export function callingDate(nextOrder: string | null, reminderDays: number | null): string | null {
  return nextOrder ? addDaysIso(nextOrder, reminderDays ?? 0) : null;
}

export type CashLine = { employee: string; godownId: string; mode: string; amountPaise: number };

/**
 * What an employee still holds, per godown and mode: credits given less
 * expenses spent — by the person who SPENT it (spec §14 A-24), on both screens.
 */
export function cashBalances(credits: CashLine[], expenses: CashLine[]): Map<string, number> {
  const k = (l: CashLine) => `${l.employee.trim().toLowerCase()}|${l.godownId}|${l.mode}`;
  const out = new Map<string, number>();
  for (const c of credits) out.set(k(c), (out.get(k(c)) ?? 0) + c.amountPaise);
  for (const e of expenses) out.set(k(e), (out.get(k(e)) ?? 0) - e.amountPaise);
  return out;
}

export const cashKey = (employee: string, godownId: string, mode: string) => `${employee.trim().toLowerCase()}|${godownId}|${mode}`;
