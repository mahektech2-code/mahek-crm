import { z } from "zod";
import { dateCueSchema } from "@/lib/call-intel-schema";
import { VISIT_INTENTS } from "@/lib/visit-intel-labels";

/* ---------------------------------------------------------------------------
 * WHAT THE LANGUAGE MODEL IS ALLOWED TO SAY ABOUT A VISIT.
 *
 * The call assistant's schema asks about a phone call; a visit is a different
 * conversation with different doors out of it. A salesman standing in a shop
 * can COLLECT money, not only hear it promised; he can meet nobody because the
 * owner is out or the shutter is down; and on a lead he is asking what the
 * shop needs, which a telecaller ringing a customer of four years never asks.
 * So the reading is its own shape, and what the two share — date CUES, never
 * dates — is imported rather than restated.
 *
 * Every coded answer is built from the list the handset's own form draws, so
 * the model cannot answer in a word the visit screen has no chip for.
 * ------------------------------------------------------------------------- */

/**
 * THE HANDSET'S TEN COMPLAINT CATEGORIES, as the complaint sheet shows them.
 *
 * A literal on the phone (`mbos-app/src/data/fixtures.ts`) because nothing on
 * the wire carries the list, and a literal here for the same reason: the model
 * answers in exactly the words the sheet's chips carry, so a proposal lands on
 * a chip rather than on a category the sheet cannot draw. A test reads the
 * handset file and fails the day the two lists part.
 */
export const HANDSET_COMPLAINT_CATEGORIES = [
  "Product Quality",
  "Short Quantity",
  "Leakage / Packaging",
  "Wrong Product",
  "Delivery Delay",
  "Price Issue",
  "Billing Issue",
  "Transport Issue",
  "Sales Service",
  "Other",
] as const;

/** The handset's payment-mode chips, by label, for the same reason. */
export const HANDSET_PAY_MODES = [
  "Cash",
  "Cheque",
  "UPI",
  "Bank transfer",
] as const;

export const visitReadingSchema = z.object({
  summary: z
    .string()
    .describe(
      "Two short sentences at most, in English: who was met, what was said and what was agreed.",
    ),
  met: z
    .enum(["decision_maker", "staff", "nobody", "unclear"])
    .describe(
      "Who the salesman actually spoke to. `nobody` when the owner was out or the shop was shut.",
    ),
  shop: z
    .enum(["open", "closed", "unclear"])
    .describe("`closed` only when the shop itself was shut."),
  intents: z
    .array(
      z.object({
        intent: z.enum(VISIT_INTENTS),
        confidence: z
          .number()
          .describe("0-100: how clearly the words support this."),
        evidence: z.string().describe("The words that show it, quoted."),
      }),
    )
    .describe("Everything that happened on the visit. Several are allowed."),
  order: z.object({
    commitment: z
      .enum(["confirmed", "tentative", "none"])
      .describe(
        '"confirmed" ONLY if the customer placed the order on this visit. "Will order next week", "send the rate first" is tentative.',
      ),
    lines: z.array(
      z.object({
        product: z.string().describe("Product as the customer named it."),
        quantity: z.number().nullable(),
        unit: z.enum(["cans", "litres", "boxes", "drums", "kg", "unknown"]),
      }),
    ),
  }),
  payment: z
    .object({
      collectedRupees: z
        .number()
        .nullable()
        .describe(
          "Money HANDED OVER on this visit, whole rupees. 50 hazar = 50000.",
        ),
      mode: z.enum(HANDSET_PAY_MODES).nullable(),
      promisedRupees: z
        .number()
        .nullable()
        .describe("Money promised for later, not paid now."),
      when: dateCueSchema
        .nullable()
        .describe("When the promised money will come."),
    })
    .nullable(),
  complaint: z
    .object({
      category: z.enum(HANDSET_COMPLAINT_CATEGORIES).nullable(),
      description: z
        .string()
        .nullable()
        .describe("The complaint in the customer's words, in English."),
      urgent: z
        .boolean()
        .describe(
          "True only if the words say it is stopping their work or is serious.",
        ),
    })
    .nullable(),
  sample: z
    .object({
      product: z.string().nullable(),
      quantityCans: z.number().nullable(),
      application: z
        .string()
        .nullable()
        .describe("What they will try it on."),
      reasonCode: z
        .string()
        .nullable()
        .describe("One of the listed sample reason codes, or null."),
    })
    .nullable(),
  opportunity: z
    .object({
      product: z.string().nullable(),
      when: dateCueSchema.nullable().describe("When they might order."),
    })
    .nullable(),
  requirement: z
    .object({
      what: z
        .string()
        .nullable()
        .describe("What the shop is looking for, in their words, in English."),
      monthlyLitres: z.number().nullable(),
      cans: z.number().nullable(),
    })
    .nullable()
    .describe("Only for a lead: what they need. Null for an existing customer."),
  leadVerdict: z
    .enum(["prospect", "not_prospect", "unclear"])
    .nullable()
    .describe(
      "Only for a lead: whether the words say this shop is worth pursuing.",
    ),
  competitor: z
    .string()
    .nullable()
    .describe("Whose product they use or compared us to, if named."),
  comeBack: dateCueSchema
    .nullable()
    .describe("When the customer said to come back or call again."),
  feedback: z
    .array(
      z.object({
        text: z.string(),
        tone: z.enum(["positive", "negative", "neutral"]),
        about: z.enum([
          "quality",
          "price",
          "service",
          "delivery",
          "competitor",
          "payment",
          "other",
        ]),
      }),
    )
    .describe("Only things worth a manager knowing. Empty if none."),
  unclear: z
    .array(z.string())
    .describe(
      "Anything you could not tell from the words — asked of the salesman, never guessed.",
    ),
});

export type VisitReading = z.infer<typeof visitReadingSchema>;

/** The keys, for a model that cannot be handed a schema. */
export const VISIT_SHAPE_HINT = JSON.stringify({
  summary: "",
  met: "decision_maker|staff|nobody|unclear",
  shop: "open|closed|unclear",
  intents: [{ intent: "", confidence: 0, evidence: "" }],
  order: {
    commitment: "confirmed|tentative|none",
    lines: [
      { product: "", quantity: null, unit: "cans|litres|boxes|drums|kg|unknown" },
    ],
  },
  payment: null,
  complaint: null,
  sample: null,
  opportunity: null,
  requirement: null,
  leadVerdict: null,
  competitor: null,
  comeBack: null,
  feedback: [],
  unclear: [],
});
