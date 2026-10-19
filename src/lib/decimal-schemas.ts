import { z } from "zod";

/*
 * THE QUANTITIES THAT TAKE A FRACTION, and how many places each keeps.
 *
 * These were `.int()`, so "1.5" was refused on every path that reached them
 * — a refusal nobody saw, because the box in front of it had already thrown
 * the point away. Money is not here: it is paise, and paise are whole. Cans,
 * boxes and days are not here either: those really are counted.
 *
 * Each rounds rather than refuses past its places, because the extra digits
 * come from arithmetic on a handset ("12.300000001") far more often than from
 * a person, and refusing a sync item over them would park a real reading in
 * the outbox for ever.
 */

const to = (places: number) => (v: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** An odometer reading or a distance — tenths, which is what a meter shows. */
export const kmSchema = z.number().finite().min(0).transform(to(1));

/** Litres — a consumption, a capacity, a threshold. */
export const litresSchema = z.number().finite().nonnegative().transform(to(2));

/** A percentage, 0 to 100, to two places. */
export const percentSchema = z.number().finite().min(0).max(100).transform(to(2));

/** Rupees typed by a person, before they become paise. */
export const rupeesSchema = z.coerce.number().finite().nonnegative().transform(to(2));
