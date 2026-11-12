import { z } from "zod";
import { productSchema, type Product } from "./product";
import type { Recipient } from "./recipient";
import { normalizeText } from "./text";

// An existing customer as the app sees it: a READ-ONLY promotional recipient, never a CRM profile.
// The shape is the allow-list from CUSTOMER_FEATURE_BLUEPRINT.md section 5. There is deliberately no
// owner, orders, prices, credit, notes, tasks, status or activity: none is needed to make a
// creative, and adding any of them would turn this into a customer-management feature.

const text = z.string().transform(normalizeText).pipe(z.string().min(1));
const optionalText = z
  .string()
  .nullish()
  .transform((v) => (v == null ? null : normalizeText(v) || null));

/** Route words that must never be a customer id, because `/customers/<word>` is a real page. */
export const RESERVED_CUSTOMER_IDS: readonly string[] = ["generated"];

// An id appears in URLs and creative ids, so it must be opaque: plain id characters only, and never
// something that looks like a phone number (7 to 15 digits). Names and e-mail addresses cannot pass
// the character rule.
const customerId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, "an opaque id: letters, digits, dash and underscore only")
  .refine((v) => !/^\d{7,15}$/.test(v), "an id must not look like a phone number")
  .refine((v) => !RESERVED_CUSTOMER_IDS.includes(v.toLowerCase()), "this id is reserved");

/**
 * A phone number as typed in a source ("+91 98765-43210", "(022) 2345 6789"): spaces, dashes, dots
 * and brackets are removed; what remains must be 7 to 15 digits with an optional leading "+".
 * Empty means "no phone" (null). Anything else is rejected, so a bad value never reaches a page.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  const stripped = normalizeText(input).replace(/[\s().-]/g, "");
  if (stripped === "") return null;
  if (!/^\+?\d{7,15}$/.test(stripped)) throw new Error("not a phone number");
  return stripped;
}

const phone = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    try {
      return normalizePhone(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "not a phone number (7 to 15 digits, optional leading +)" });
      return z.NEVER;
    }
  });

export const customerSchema = z.strictObject({
  id: customerId,
  company: text.pipe(z.string().max(200)),
  /** Contact person. May be missing; creatives then greet the company. */
  contact: optionalText,
  /** Allowed recipient data for future communication. NEVER printed, searched, linked, stored in history or logged. */
  phone,
  city: text.pipe(z.string().max(100)),
  state: text.pipe(z.string().max(100)),
  /** What the customer buys, in the source order (the first is the default). May be empty. No business limit on the count. */
  products: z.array(productSchema).superRefine((products, ctx) => {
    const seen = new Set<string>();
    for (const p of products) {
      if (seen.has(p.code)) ctx.addIssue({ code: "custom", message: `duplicate product code ${p.code}` });
      seen.add(p.code);
    }
  }),
});
export type Customer = z.infer<typeof customerSchema>;

/** Name to greet: the contact, or the company when there is no contact. */
export function customerGreetingName(c: Pick<Customer, "contact" | "company">): string {
  return c.contact ?? c.company;
}

export type ProductSelection = { ok: true; product: Product | null } | { ok: false };

/**
 * The product a creative features. With no code: the customer's first product, or none. With a
 * code: that product, or a failure when it is not one of THIS customer's products (the id is never
 * trusted).
 */
export function selectProduct(c: Pick<Customer, "products">, productCode: string | undefined): ProductSelection {
  if (productCode === undefined) return { ok: true, product: c.products[0] ?? null };
  const found = c.products.find((p) => p.code === productCode);
  return found ? { ok: true, product: found } : { ok: false };
}

/** The five facts the generation code needs, with the selected product (see domain/recipient.ts). */
export function customerToRecipient(c: Customer, product: Product | null): Recipient {
  return { contact: c.contact, company: c.company, city: c.city, state: c.state, product };
}

/** A phone for display on the detail page: "+91 98765 43210" for an Indian mobile, else as stored. */
export function formatPhone(stored: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(stored);
  return m ? `+91 ${m[1]} ${m[2]}` : stored;
}
