import { z } from "zod";
import { isKnownState } from "@/lib/india-states";
import { checkGstin } from "@/lib/engines/lead-scan";

/* ---------------------------------------------------------------------------
 * ADDING A CUSTOMER DIRECTLY, FROM ACCOUNTS — the rules, PURE and client-safe.
 *
 * The form that asks the questions runs in a browser and the action that
 * writes the row is `server-only`, so the one statement of what is required
 * lives here and both read it. A copy typed into the screen would drift, and
 * the half that drifts is the half somebody is reading when the save refuses.
 *
 * What is REQUIRED is exactly what makes the account work everywhere else the
 * moment it is saved, and nothing more:
 *
 *   - the business name, as it appears on the bill — it is also what the party
 *     sheet matches on, so the sheet ADOPTS this row rather than duplicating it;
 *   - a mobile — the number we ring, and the one the WhatsApp templates reach;
 *   - the city and the STATE — a salesman's handset carries only the shops in
 *     the territory allocated to him, and a territory is a state with cities
 *     under it. A shop with no state is on nobody's handset;
 *   - the sales account manager — whose book it is, whose Call Log and
 *     collections list it lands on, and whose target its orders count toward.
 *
 * Everything else is offered and optional, and can be filled in later on the
 * ordinary edit form.
 * ------------------------------------------------------------------------- */

/**
 * A seat held by somebody who signs in (`user`), by somebody on the HRMS
 * master who has no login (`employee` — the id is resolved to a name on the
 * server, never taken from the request), or by nobody.
 */
export const seatSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
  z.object({ kind: z.literal("employee"), employeeId: z.string().min(1) }),
  z.object({ kind: z.literal("none") }),
]);
export type SeatPick = z.infer<typeof seatSchema>;

/** The picker's value — `""`, a user id, or `emp:<employee id>` — as a seat. */
export function seatFromPick(value: string): SeatPick {
  if (!value) return { kind: "none" };
  if (value.startsWith("emp:")) return { kind: "employee", employeeId: value.slice(4) };
  return { kind: "user", userId: value };
}

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

export const newCustomerSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the business name as it appears on the bill.").max(200),
    contactPerson: optionalText(120),
    phone: z
      .string()
      .trim()
      .regex(/^[6-9]\d{9}$/, "Enter a 10-digit mobile number."),
    whatsappPhone: z
      .string()
      .trim()
      .refine((v) => v === "" || /^[6-9]\d{9}$/.test(v), "Enter a 10-digit mobile number, or leave it blank.")
      .optional()
      .default(""),
    email: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "That email address does not look complete.")
      .optional()
      .default(""),
    customerType: z.enum(["dealer", "manufacturer", "distributor", "retailer", ""]).optional().default(""),
    externalCode: optionalText(60),

    address: optionalText(500),
    city: z.string().trim().min(2, "Enter the city.").max(120),
    state: z
      .string()
      .trim()
      .refine((v) => isKnownState(v), "Pick the state — it decides which salesmen's handsets carry this shop."),
    area: optionalText(120),
    route: optionalText(120),

    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => v === "" || checkGstin(v)?.check === "valid", "That GSTIN does not check out — read it again off the certificate.")
      .optional()
      .default(""),
    creditTermDays: z.coerce.number().int().min(0, "Credit terms cannot be negative.").max(180, "Credit terms are at most 180 days.").default(30),
    creditLimitPaise: z.number().int().min(0).max(1_000_000_000_000).nullable().optional().default(null),
    priceTag: optionalText(120),
    freightTerm: z.enum(["paid", "to_pay", ""]).optional().default(""),
    deliveryType: optionalText(60),

    sales: seatSchema,
    backOffice: seatSchema.optional().default({ kind: "none" }),
    salesManager: seatSchema.optional().default({ kind: "none" }),

    /** Set once the person has seen the "same name already on the book" warning. */
    allowSameName: z.boolean().optional().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.sales.kind === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["sales"],
        message: "Pick the sales account manager — whose book this account is in.",
      });
    }
    if (v.whatsappPhone && v.whatsappPhone === v.phone) {
      ctx.addIssue({
        code: "custom",
        path: ["whatsappPhone"],
        message: "Leave it blank — WhatsApp goes to the mobile already.",
      });
    }
  });

export type NewCustomerInput = z.input<typeof newCustomerSchema>;
export type NewCustomer = z.output<typeof newCustomerSchema>;

/** Which tab of the form a field lives on, so a refusal opens the right one. */
export const NEW_CUSTOMER_TAB: Record<string, "details" | "address" | "commercial" | "managers"> = {
  name: "details",
  contactPerson: "details",
  phone: "details",
  whatsappPhone: "details",
  email: "details",
  customerType: "details",
  externalCode: "details",
  allowSameName: "details",
  address: "address",
  city: "address",
  state: "address",
  area: "address",
  route: "address",
  gstin: "commercial",
  creditTermDays: "commercial",
  creditLimitPaise: "commercial",
  priceTag: "commercial",
  freightTerm: "commercial",
  deliveryType: "commercial",
  sales: "managers",
  backOffice: "managers",
  salesManager: "managers",
};
