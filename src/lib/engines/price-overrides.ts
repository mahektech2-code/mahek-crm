/* ---------------------------------------------------------------------------
 * OVERRIDES — one shop, one product, a price, and the days it holds.
 *
 * A special price used to be a rate typed into the shop's agreed-prices list
 * with no end: it lasted until somebody remembered to take it off. An override
 * carries its dates and, optionally, the volume it was agreed against. The
 * agreed-prices list is still what PRICES — it already layers over the shop's
 * book product by product, so every reader (the CRM, the ERP order form, the
 * handset, the variance report) sees an override without knowing it exists —
 * and this engine says what that list should hold on a given day.
 *
 * THE LIST IS NEVER REBUILT FROM OVERRIDES ALONE. A product with no override
 * row at all was typed into the agreed list by hand, or before overrides
 * existed, and is left exactly as it is. Only a product that HAS override rows
 * is decided by them: the live one's price, or — when none is live — off the
 * list, so the product falls back to the book.
 * ------------------------------------------------------------------------- */

export type OverrideState = "scheduled" | "live" | "ended" | "cancelled";

export type OverrideLike = {
  id: string;
  productId: string;
  rateExGstPaise: number;
  rateInclGstPaise: number;
  validFrom: string;
  validTo: string | null;
  cancelledAt: Date | string | null;
  createdAt: Date | string;
};

export function overrideState(o: Pick<OverrideLike, "validFrom" | "validTo" | "cancelledAt">, day: string): OverrideState {
  if (o.cancelledAt) return "cancelled";
  if (o.validFrom > day) return "scheduled";
  if (o.validTo && o.validTo < day) return "ended";
  return "live";
}

export const OVERRIDE_STATE_LABEL: Record<OverrideState, string> = {
  scheduled: "Starts later",
  live: "Live",
  ended: "Ended",
  cancelled: "Cancelled",
};

/**
 * The override in force for one product on a day: of those live, the one that
 * started last (a renewal replaces the old terms), then the newest written.
 */
export function liveOverride<T extends OverrideLike>(overrides: readonly T[], productId: string, day: string): T | null {
  const live = overrides.filter((o) => o.productId === productId && overrideState(o, day) === "live");
  live.sort(
    (a, b) =>
      b.validFrom.localeCompare(a.validFrom) ||
      String(new Date(b.createdAt).toISOString()).localeCompare(String(new Date(a.createdAt).toISOString())) ||
      b.id.localeCompare(a.id),
  );
  return live[0] ?? null;
}

/** A rate row of the agreed list, as far as this engine cares. */
export type AgreedRate = { productId: string; rateExGstPaise: number; rateInclGstPaise: number; minCans: number | null; offered: boolean };

export type AgreedPlan = {
  /** The rows the agreed list should hold on the day. */
  rows: AgreedRate[];
  /** True where that is not what it holds now — a new revision is due. */
  differs: boolean;
  added: string[];
  removed: string[];
  repriced: string[];
};

/**
 * What a shop's agreed list should hold on `day`, from what it holds now and
 * the shop's overrides. Products with no override rows are kept as they are.
 */
export function plannedAgreedRates(current: readonly AgreedRate[], overrides: readonly OverrideLike[], day: string): AgreedPlan {
  const governed = new Set(overrides.map((o) => o.productId));
  const rows: AgreedRate[] = current.filter((r) => !governed.has(r.productId));
  const added: string[] = [];
  const removed: string[] = [];
  const repriced: string[] = [];
  for (const productId of [...governed].sort()) {
    const live = liveOverride(overrides, productId, day);
    const now = current.filter((r) => r.productId === productId);
    const flat = now.find((r) => (r.minCans ?? 0) === 0) ?? null;
    if (live) {
      rows.push({ productId, rateExGstPaise: live.rateExGstPaise, rateInclGstPaise: live.rateInclGstPaise, minCans: null, offered: true });
      if (!flat) added.push(productId);
      else if (flat.rateExGstPaise !== live.rateExGstPaise || flat.rateInclGstPaise !== live.rateInclGstPaise || !flat.offered || now.length > 1)
        repriced.push(productId);
    } else if (now.length) {
      removed.push(productId);
    }
  }
  rows.sort((a, b) => a.productId.localeCompare(b.productId) || (a.minCans ?? 0) - (b.minCans ?? 0));
  return { rows, differs: !!(added.length || removed.length || repriced.length), added, removed, repriced };
}

/** Days from `from` to `to`, both ISO dates, with no clock read. */
export function daysUntil(from: string, to: string): number {
  const [a, b] = [from, to].map((d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))));
  return Math.round((b - a) / 86_400_000);
}

/** Overrides ending within `withinDays` that nobody has been reminded about. */
export function dueForReminder<T extends OverrideLike & { remindedAt: Date | string | null }>(
  overrides: readonly T[],
  day: string,
  withinDays: number,
): T[] {
  return overrides.filter(
    (o) => !o.remindedAt && overrideState(o, day) === "live" && o.validTo != null && daysUntil(day, o.validTo) <= withinDays,
  );
}

/** Why an override cannot be saved as given, or null. */
export function overrideProblem(input: {
  rateExGstPaise: number;
  validFrom: string;
  validTo: string | null;
  minCansPerMonth: number | null;
  today: string;
}): string | null {
  if (!Number.isFinite(input.rateExGstPaise) || input.rateExGstPaise <= 0) return "A special price has to be above zero.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) return "Choose the day it starts.";
  if (input.validTo && !/^\d{4}-\d{2}-\d{2}$/.test(input.validTo)) return "That end date is not a date.";
  if (input.validTo && input.validTo < input.validFrom) return "It cannot end before it starts.";
  if (input.validTo && input.validTo < input.today) return "That end date has already passed.";
  if (input.minCansPerMonth != null && (!Number.isInteger(input.minCansPerMonth) || input.minCansPerMonth <= 0))
    return "The minimum is a whole number of cans a month, or leave it empty.";
  return null;
}
