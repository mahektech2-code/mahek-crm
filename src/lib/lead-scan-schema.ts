import { z } from "zod";

/* ---------------------------------------------------------------------------
 * The shape a photograph is read into — see `engines/lead-scan.ts` for what
 * happens to it next.
 *
 * Every key is REQUIRED and nullable rather than optional, because OpenAI's
 * structured output wants every property named, and because "the model looked
 * and found none" (null) and "the model was never asked" (absent) are
 * different answers that an optional key would make the same.
 *
 * Phones carry a KIND because the engine refuses to promote a landline to the
 * mobile, and a model can read "Off:" or "Tel:" printed before a number where
 * digits alone cannot.
 * ------------------------------------------------------------------------- */

export const leadScanReadingSchema = z.object({
  businessName: z
    .string()
    .nullable()
    .describe("The shop, firm or business name as printed — the largest name on a board or card. Not a brand they stock."),
  contactPerson: z
    .string()
    .nullable()
    .describe("A person's name, if one is printed (proprietor, owner, partner). Null if only a business name is shown."),
  phones: z
    .array(
      z.object({
        number: z.string().describe("Exactly as printed, digits and any +91 or leading 0."),
        kind: z
          .enum(["mobile", "landline", "unknown"])
          .describe("mobile for M:/Mob/WhatsApp or a 10-digit number starting 6-9; landline for Tel/Off/Ph with an STD code; unknown otherwise."),
      }),
    )
    .describe("Every phone number visible, in the order printed. Empty if none."),
  city: z.string().nullable().describe("The town or city of the shop's address."),
  state: z.string().nullable().describe("The Indian state of the shop's address, if printed."),
  address: z
    .string()
    .nullable()
    .describe("The street address on one line — shop number, building, road, area, landmark. Without the phone numbers or GSTIN."),
  pincode: z.string().nullable().describe("The six-digit PIN code, if printed."),
  gstin: z
    .string()
    .nullable()
    .describe("The 15-character GSTIN, usually after 'GSTIN' or 'GST No'. Copy it character by character; null if not printed."),
  note: z
    .string()
    .nullable()
    .describe("One short sentence only if something needs the salesman's attention — two different businesses in the photos, a number partly cut off. Otherwise null."),
});

export type LeadScanReadingParsed = z.infer<typeof leadScanReadingSchema>;
