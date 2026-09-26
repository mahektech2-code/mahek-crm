import { z } from "zod";
import { CALL_INTENTS } from "@/lib/call-intel-labels";
import {
  CASUAL_TALK_PURPOSES,
  COMPLAINT_ACTIONS,
  FOLLOW_UP_REASONS,
  FUTURE_OPPORTUNITY,
  NO_ANSWER_REASONS,
  NO_ORDER_REASONS,
  NOT_INTERESTED_REASONS,
} from "@/lib/call-outcomes";
import { CALLER_ROLES, CALL_REASON_CODES, DELIVERY_ISSUES } from "@/lib/call-reasons";

/* ---------------------------------------------------------------------------
 * WHAT THE LANGUAGE MODEL IS ALLOWED TO SAY ABOUT A CALL.
 *
 * Every coded answer is built from the SAME list the call form draws its
 * options from, so the model cannot invent a reason the form would refuse —
 * "why not interested" can only ever come back as one of the ten codes a
 * telecaller could have picked. A label the model made up would be a field
 * the form could not show and the save would reject.
 *
 * DATES ARE CUES, NOT DAYS. The model reports what kind of date was spoken
 * and the words it came from; `engines/call-intel-dates.ts` does the
 * arithmetic. A model computing "15 days from today" is a model guessing what
 * today is.
 *
 * Every field is NULLABLE rather than optional, because structured output in
 * strict mode requires every key to be present — and because "not said" is an
 * answer the rest of the pipeline acts on, by asking.
 * ------------------------------------------------------------------------- */

const codes = <T extends ReadonlyArray<{ code: string }>>(list: T) =>
  list.map((r) => r.code) as [T[number]["code"], ...T[number]["code"][]];

export const COMPLAINT_CATEGORY_CODES = [
  "product_quality",
  "packaging_damage",
  "dispatch_delay",
  "billing_issue",
  "delivery",
  "pricing",
  "service",
  "shortage",
  "wrong_product",
  "other",
] as const;

export const dateCueSchema = z.object({
  phrase: z
    .string()
    .describe("The exact words the date came from, as spoken or written."),
  kind: z.enum([
    "today",
    "tomorrow",
    "day_after_tomorrow",
    "in_days",
    "in_weeks",
    "in_months",
    "weekday",
    "next_week",
    "month_end",
    "next_month",
    "day_of_month",
    "absolute",
    "unclear",
  ]),
  n: z
    .number()
    .nullable()
    .describe("For in_days / in_weeks / in_months: how many."),
  weekday: z
    .number()
    .nullable()
    .describe("For weekday: ISO, Monday 1 … Sunday 7."),
  which: z
    .enum(["this", "next"])
    .nullable()
    .describe('For weekday: "next" only when the word next/agle was said.'),
  day: z.number().nullable().describe("For day_of_month: the day number."),
  month: z
    .number()
    .nullable()
    .describe("For day_of_month: the month 1-12, only if it was named."),
  date: z
    .string()
    .nullable()
    .describe("For absolute only: YYYY-MM-DD, only when a full date was said."),
});

export type DateCueReading = z.infer<typeof dateCueSchema>;

export const callReadingSchema = z.object({
  summary: z
    .string()
    .describe(
      "Two short sentences at most, in English: what the customer said and what was agreed.",
    ),
  direction: z
    .enum(["we_called", "they_called", "unclear"])
    .describe("Who rang whom, only if the words say so."),
  reached: z
    .enum(["spoke", "no_answer", "unclear"])
    .describe("Whether anybody at the customer's end was actually spoken to."),
  noAnswerReason: z.enum(codes(NO_ANSWER_REASONS)).nullable(),
  intents: z
    .array(
      z.object({
        intent: z.enum(CALL_INTENTS),
        confidence: z
          .number()
          .describe("0-100: how clearly the words support this."),
        evidence: z.string().describe("The words that show it, quoted."),
      }),
    )
    .describe("Everything that happened on the call. Several are allowed."),
  feedback: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "What the customer said about us, a product or the market, in English.",
          ),
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
  order: z.object({
    commitment: z
      .enum(["confirmed", "tentative", "none"])
      .describe(
        '"confirmed" ONLY if the customer placed the order now. "May order", "will think", "next week maybe" is tentative.',
      ),
    lines: z.array(
      z.object({
        product: z.string().describe("Product as the customer named it."),
        quantity: z.number().nullable(),
        unit: z.enum(["cans", "litres", "boxes", "drums", "kg", "unknown"]),
      }),
    ),
  }),
  complaint: z
    .object({
      category: z.enum(COMPLAINT_CATEGORY_CODES).nullable(),
      description: z
        .string()
        .nullable()
        .describe("The complaint in the customer's words, in English."),
      requiredAction: z.enum(codes(COMPLAINT_ACTIONS)).nullable(),
      creditNoteAsked: z.boolean(),
    })
    .nullable(),
  notInterested: z
    .object({
      reason: z.enum(codes(NOT_INTERESTED_REASONS)).nullable(),
      competitor: z.string().nullable(),
      futureOpportunity: z.enum(codes(FUTURE_OPPORTUNITY)).nullable(),
      when: dateCueSchema.nullable(),
    })
    .nullable(),
  noOrder: z
    .object({
      reason: z.enum(codes(NO_ORDER_REASONS)).nullable(),
      when: dateCueSchema
        .nullable()
        .describe("When they said to call again, if they did."),
    })
    .nullable(),
  opportunity: z
    .object({
      product: z.string().nullable(),
      quantity: z
        .string()
        .nullable()
        .describe("In their words: '20 cans a month' is an answer."),
      valueRupees: z.number().nullable(),
      when: dateCueSchema.nullable().describe("When they might order."),
    })
    .nullable(),
  sample: z
    .object({
      product: z.string().nullable(),
      quantityCans: z.number().nullable(),
      application: z.string().nullable().describe("What they will use it on."),
    })
    .nullable(),
  payment: z
    .object({
      amountRupees: z
        .number()
        .nullable()
        .describe("Whole rupees. 50 hazar = 50000, 1.5 lakh = 150000."),
      when: dateCueSchema.nullable(),
      mode: z.string().nullable(),
    })
    .nullable(),
  followUp: z
    .object({
      reason: z.enum(codes(FOLLOW_UP_REASONS)).nullable(),
      when: dateCueSchema.nullable(),
    })
    .nullable(),
  casual: z
    .object({ purpose: z.enum(codes(CASUAL_TALK_PURPOSES)).nullable() })
    .nullable(),
  /*
   * WHY THEY RANG, and the answers that reason's form demands. Every inbound
   * reason carries required boxes of its own — the product enquired about,
   * what they asked about the money, what went wrong with a delivery — and a
   * reason filled without them is a form that refuses to save. So the model
   * answers them from the words, and says null where the words do not.
   */
  inbound: z
    .object({
      reason: z
        .enum(CALL_REASON_CODES as [string, ...string[]])
        .nullable()
        .describe("Only when THE CUSTOMER called us: the main reason they rang."),
      callerRole: z
        .enum(codes(CALLER_ROLES))
        .nullable()
        .describe("Who at the customer rang, only if the words say: owner, purchase, accounts, store, production, other."),
      callerName: z
        .string()
        .nullable()
        .describe("The caller's name, if it was said."),
      product: z
        .string()
        .nullable()
        .describe("The product they asked or talked about, as named."),
      customerQuery: z
        .string()
        .nullable()
        .describe("What they asked, in one short English sentence."),
      paymentStatus: z
        .string()
        .nullable()
        .describe("What they say the payment position is: 'cheque posted Tuesday'."),
      deliveryIssue: z
        .enum(codes(DELIVERY_ISSUES))
        .nullable()
        .describe("For a delivery / transport call: what is wrong with it."),
      orderRef: z
        .string()
        .nullable()
        .describe("An order or invoice number they quoted, exactly."),
      problem: z
        .string()
        .nullable()
        .describe("For technical support: what is going wrong with the product."),
      application: z
        .string()
        .nullable()
        .describe("What they want the product for, in their words."),
      quantity: z
        .string()
        .nullable()
        .describe("A quantity they mentioned, in their words."),
    })
    .nullable()
    .describe("Null when we called them, or nothing says why they rang."),
  doNotCall: z.object({
    said: z
      .boolean()
      .describe(
        "True only if the customer asked not to be called or contacted again.",
      ),
    quote: z.string().nullable(),
  }),
  unclear: z
    .array(z.string())
    .describe(
      "Anything you could not tell from the words — asked of the telecaller, never guessed.",
    ),
});

export type CallReading = z.infer<typeof callReadingSchema>;
