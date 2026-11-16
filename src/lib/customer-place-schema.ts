import { z } from "zod";

/*
 * THE SAVE'S SHAPE FOR A PICKED PLACE, apart from `customer-place.ts`.
 *
 * `customer-place.ts` is read by the Customers list in the browser, and this
 * was the only thing in it that needed Zod — which put the whole validation
 * library (74 KB) on the Customers screen of the CRM and of Accounts for every
 * page load. The forms that validate with it (Add customer, the edit form's
 * save) load Zod with themselves, when they are opened.
 */

const rungSchema = z
  .object({ id: z.string().trim().max(60).nullable().optional(), name: z.string().trim().max(80).nullable().optional() })
  .optional();

export const placePickSchema = z.object({
  state: rungSchema,
  district: rungSchema,
  city: rungSchema,
  area: rungSchema,
});
