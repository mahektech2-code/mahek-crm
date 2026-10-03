import { z } from "zod";
import { dateCueSchema } from "@/lib/call-intel-schema";

/* ---------------------------------------------------------------------------
 * The shape a SPOKEN description of a shop is read into — see
 * `engines/lead-voice.ts` for what happens to it next.
 *
 * Every key REQUIRED and nullable, for the reason `lead-scan-schema.ts` gives:
 * OpenAI's structured output wants every property named, and "he said
 * nothing about it" (null) must not look like "nobody asked" (absent).
 *
 * The three CHOICE fields — the kind of sale, how he found them, what kind of
 * business — are plain strings here and are checked against the office's own
 * lists in the engine. An enum baked into the schema would be a second copy of
 * `leads.sources`, which is configuration a manager edits; the prompt is
 * handed the live list and the engine refuses anything not on it.
 *
 * The follow-up is a CUE, never a date. A model is good at hearing "parso" and
 * bad at knowing what day it is — `call-intel-dates.ts` does the arithmetic,
 * exactly as it does for the call and the visit assistants.
 * ------------------------------------------------------------------------- */

export const leadVoiceReadingSchema = z.object({
  salesType: z
    .string()
    .nullable()
    .describe("The CODE of the kind of sale, from the list given. Null unless the words make it clear."),
  businessName: z
    .string()
    .nullable()
    .describe("The shop, firm or factory name as he said it, in English letters. Not a brand they stock."),
  contactPerson: z
    .string()
    .nullable()
    .describe("The name of the person he spoke to. Null if no name was said."),
  phones: z
    .array(
      z.object({
        number: z.string().describe("The digits as said — 'nine eight two two' is 9822. Keep every digit he said."),
        kind: z
          .enum(["mobile", "landline", "unknown"])
          .describe("mobile when he said mobile/WhatsApp or it is 10 digits starting 6-9; landline for an office or STD number; unknown otherwise."),
      }),
    )
    .describe("Every phone number he said. Empty if none."),
  gstin: z
    .string()
    .nullable()
    .describe("The 15-character GST number, if he read one out — letters and digits exactly as spelled. Null otherwise."),
  city: z.string().nullable().describe("The town or city the shop is in."),
  state: z.string().nullable().describe("The Indian state, only if he said it."),
  address: z
    .string()
    .nullable()
    .describe("Where the shop is on one line — shop number, building, road, market, landmark. Without the town if that is all there is."),
  source: z
    .string()
    .nullable()
    .describe("The CODE of how he found them, from the list given. Null unless he said how."),
  sourceDetail: z
    .string()
    .nullable()
    .describe("Only when source is 'other': where the lead came from, in a few words."),
  potentialRupeesPerMonth: z
    .number()
    .nullable()
    .describe("What they could buy from us a MONTH, in whole rupees: 40 hazar = 40000, 2 lakh = 200000. Convert a yearly figure to monthly. Null if no money figure was said."),
  followUp: dateCueSchema
    .nullable()
    .describe("When he will go back or call again. Null if he did not say."),
  customerType: z
    .string()
    .nullable()
    .describe("The CODE of what kind of business it is, from the list given. Null unless clear."),
  requirement: z
    .string()
    .nullable()
    .describe("What they want or use, in a few words, in English — 'thinner for a spray booth', 'PU lacquer for furniture'."),
  monthlyLitres: z
    .number()
    .nullable()
    .describe("How many LITRES a month they use or want. Convert drums or cans only when the size was said (one 210 L drum = 210). Null otherwise."),
  decisionMaker: z
    .string()
    .nullable()
    .describe("Who decides on buying, if that is somebody other than the person he spoke to — 'the owner, Mr Patil'."),
  competitor: z
    .string()
    .nullable()
    .describe("Who they buy from now — a brand or a supplier he named."),
  unclear: z
    .array(z.string())
    .describe("One short line for each thing he said that you could not place or were unsure of — a number with a digit missing, two names for one shop. Empty if none."),
});

export type LeadVoiceReadingParsed = z.infer<typeof leadVoiceReadingSchema>;

/** The keys, in words, for Sarvam — which cannot be handed a schema. */
export const LEAD_VOICE_SHAPE_HINT = `{
  "salesType": string|null, "businessName": string|null, "contactPerson": string|null,
  "phones": [{"number": string, "kind": "mobile"|"landline"|"unknown"}],
  "gstin": string|null, "city": string|null, "state": string|null, "address": string|null,
  "source": string|null, "sourceDetail": string|null, "potentialRupeesPerMonth": number|null,
  "followUp": {"phrase": string, "kind": "today"|"tomorrow"|"day_after_tomorrow"|"in_days"|"in_weeks"|"in_months"|"weekday"|"next_week"|"month_end"|"next_month"|"day_of_month"|"absolute"|"unclear", "n": number|null, "weekday": number|null, "which": "this"|"next"|null, "day": number|null, "month": number|null, "date": string|null}|null,
  "customerType": string|null, "requirement": string|null, "monthlyLitres": number|null,
  "decisionMaker": string|null, "competitor": string|null, "unclear": [string]
}`;
