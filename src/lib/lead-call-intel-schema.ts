import { z } from "zod";

/* ---------------------------------------------------------------------------
 * WHAT THE LANGUAGE MODEL IS ALLOWED TO SAY ABOUT A LEAD QUALIFICATION CALL.
 *
 * The call assistant reads a conversation into an OUTCOME; the visit assistant
 * reads one into a shop's ACTIONS. This reads one into the Calling Desk's own
 * twelve answers (`DESK_FIELDS` in `lib/engines/lead-calling-desk.ts`) and
 * nothing else — it does not classify the call, does not pick a direction, and
 * does not decide whether the lead moves. One optional slot per `DeskFieldKey`,
 * each carrying what was said, how sure the model is, and the words it came
 * from — the same confidence/evidence shape the call and visit readings use,
 * so a reader of one can read all three.
 *
 * `requiredProductId` is deliberately NOT in this schema by that name: the
 * model cannot resolve a product id, only report the words the customer used.
 * `product` carries those words; the id is resolved afterwards, server-side,
 * by `lib/engines/call-intel-products.ts` — exactly as the call and visit
 * readers already do.
 * ------------------------------------------------------------------------- */

const slot = z.object({
  value: z.string().describe("Exactly what was said, in English. Null if nothing was said about this."),
  confidence: z.number().describe("0-100: how clearly the words support this reading."),
  evidence: z.string().describe("The words it came from, quoted."),
});

export const leadCallReadingSchema = z.object({
  customerType: slot
    .extend({
      value: z
        .enum(["dealer", "manufacturer", "distributor", "retailer"])
        .nullable()
        .describe("Only these four. Null if not clearly one of them."),
    })
    .nullable(),
  monthlyLitres: slot
    .extend({ value: z.number().nullable().describe("Litres a month. Null if not said.") })
    .nullable(),
  potentialRupees: slot
    .extend({
      value: z
        .number()
        .nullable()
        .describe("Expected monthly sales in whole RUPEES (not paise). 50 hazar = 50000."),
    })
    .nullable(),
  product: slot
    .extend({ value: z.string().nullable().describe("The product AS THE CUSTOMER NAMED IT — never an id.") })
    .nullable(),
  competitor: slot.extend({ value: z.string().nullable() }).nullable(),
  application: slot
    .extend({ value: z.string().nullable().describe("What they will use it on.") })
    .nullable(),
  decisionMaker: slot
    .extend({
      value: z
        .string()
        .nullable()
        .describe("Who DECIDES whether to buy — never the same thing as who places the order or who answers the phone."),
    })
    .nullable(),
  buyer: slot
    .extend({
      value: z
        .string()
        .nullable()
        .describe("Who PLACES the order, only where the words say this is a DIFFERENT person from the decision maker."),
    })
    .nullable(),
  gstin: slot.extend({ value: z.string().nullable() }).nullable(),
  creditDaysWanted: slot
    .extend({
      value: z
        .number()
        .nullable()
        .describe("Days of credit they are asking for. 0 is a real answer — cash on delivery."),
    })
    .nullable(),
  address: slot.extend({ value: z.string().nullable() }).nullable(),
  email: slot.extend({ value: z.string().nullable() }).nullable(),
  unclear: z
    .array(z.string())
    .describe("Anything you could not tell from the words — asked of the telecaller, never guessed."),
});

export type LeadCallReading = z.infer<typeof leadCallReadingSchema>;

/** The twelve desk keys this reading can ever propose a value for. */
export const LEAD_CALL_READING_KEYS = [
  "customerType",
  "monthlyLitres",
  "potentialRupees",
  "product",
  "competitor",
  "application",
  "decisionMaker",
  "buyer",
  "gstin",
  "creditDaysWanted",
  "address",
  "email",
] as const;

/** The keys, in words, for a model that cannot be handed a schema. */
export const LEAD_CALL_SHAPE_HINT = JSON.stringify({
  customerType: { value: "dealer|manufacturer|distributor|retailer|null", confidence: 0, evidence: "" },
  monthlyLitres: { value: null, confidence: 0, evidence: "" },
  potentialRupees: { value: null, confidence: 0, evidence: "" },
  product: { value: null, confidence: 0, evidence: "" },
  competitor: { value: null, confidence: 0, evidence: "" },
  application: { value: null, confidence: 0, evidence: "" },
  decisionMaker: { value: null, confidence: 0, evidence: "" },
  buyer: { value: null, confidence: 0, evidence: "" },
  gstin: { value: null, confidence: 0, evidence: "" },
  creditDaysWanted: { value: null, confidence: 0, evidence: "" },
  address: { value: null, confidence: 0, evidence: "" },
  email: { value: null, confidence: 0, evidence: "" },
  unclear: [],
});
