import { z } from "zod";
import type { Lead } from "./lead";

// "Who is this creative for?" A creative is made for a lead or for a customer. The generation code
// (field resolution, readiness, wording placeholders, captions) only ever needs five facts about
// that person, so it works on this small projection and never on a Lead or a Customer directly.
// Lead and Customer stay separate types with separate repositories (see CUSTOMER_FEATURE_BLUEPRINT.md
// section 10); they meet only here. A Lead already satisfies Recipient without conversion.

export const RECIPIENT_KINDS = ["lead", "customer"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];
export const recipientKindSchema = z.enum(RECIPIENT_KINDS);

/** The facts a creative can use about its recipient. `product` is the SELECTED product, if any. */
export type Recipient = Pick<Lead, "contact" | "company" | "city" | "state" | "product">;

/** Which recipient, by kind and id. Requests carry this and never recipient data. */
export const recipientRefSchema = z.object({
  kind: recipientKindSchema,
  id: z.string().min(1).max(100),
});
export type RecipientRef = z.infer<typeof recipientRefSchema>;

export const leadRef = (id: string): RecipientRef => ({ kind: "lead", id });
export const customerRef = (id: string): RecipientRef => ({ kind: "customer", id });

/** Name to greet: the contact, or the company when there is none. */
export function recipientGreetingName(r: Pick<Recipient, "contact" | "company">): string {
  return r.contact ?? r.company;
}
