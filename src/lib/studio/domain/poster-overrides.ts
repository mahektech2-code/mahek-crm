import type { Product } from "./product";
import type { Recipient } from "./recipient";
import type { User } from "./lead";
import { normalizeText } from "./text";
import { fail, ok, type Result } from "@/lib/studio/result";

// Controlled poster editing (Task 7, AD-23): the details a person may change on a poster WITHOUT changing the CRM record.
//
//   name         the recipient's name as the poster greets them
//   company      the company line
//   productCode  a product, chosen from the APPROVED products only (never typed in)
//   salesperson  the "your Mahek contact" line
//   variantId    the greeting, chosen from the APPROVED wording only (never typed in)
//   city, state  the location lines (LOST LEADS only: the Lost Leads poster has always let these four details change)
//
// Which fields apply depends on the kind of recipient (see EDITABLE_FIELDS): a lost lead has no product and no salesperson line to edit.
//
// Nothing else is editable: not the design, the layout, the logo, the fixed lines or the colours. Edits are checked here and again
// on the server every time they are used. They are stored with the batch (they are personal text, so they expire with it), they
// are applied after the record is read fresh from its source, and they are never written back to the source. Pure.

export const OVERRIDE_FIELDS = ["name", "company", "productCode", "salesperson", "variantId", "city", "state"] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];
export type PosterOverrides = Partial<Record<OverrideField, string>>;

/** The kinds of recipient a batch can be for. A lost lead is its own kind: it is never moved into the active leads. */
export type OverrideKind = "lead" | "customer" | "lost";

/** What may be edited, per kind. Anything else in a request is refused by name. */
export const EDITABLE_FIELDS: Readonly<Record<OverrideKind, readonly OverrideField[]>> = {
  lead: ["name", "company", "productCode", "salesperson", "variantId"],
  customer: ["name", "company", "productCode", "salesperson", "variantId"],
  lost: ["name", "company", "city", "state", "variantId"],
};

/** Longest allowed text. The design still fits or shortens what it draws; these only keep an edit sensible. */
export const OVERRIDE_MAX = { name: 60, company: 100, salesperson: 60, city: 100, state: 100 } as const;

const CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/;
const MARKUP = /[<>{}\\]/;
const PHONE_PLUS = /\+\s*\d/;
const PHONE_RUN = /\d{6,}/;
const LINK = /https?:|www\.|@|\.(com|in|org|net)\b/i;
const MONEY = /[₹$€£%]|\b(rs|inr|usd)\b\.?/i;
const PRODUCT_CODE = /^[A-Za-z0-9_-]{1,40}$/;
const VARIANT_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Why a piece of free text may not go on a poster, or null when it may. A poster never carries a phone number, a link or an email
 * address, a price or a percentage, and the text must be plain: no markup, braces, backslashes or control characters.
 */
export function overrideTextProblem(value: string, max: number): string | null {
  if (CONTROL.test(value)) return "contains a character that is not allowed";
  const text = normalizeText(value);
  if (text.length === 0) return "cannot be empty";
  if (Array.from(text).length > max) return `is too long (at most ${max} characters)`;
  if (MARKUP.test(text)) return "contains a character that is not allowed";
  if (PHONE_PLUS.test(text) || PHONE_RUN.test(text.replace(/[\s().-]/g, ""))) return "cannot contain a phone number";
  if (LINK.test(text)) return "cannot contain a link or an email address";
  if (MONEY.test(text)) return "cannot contain a price or a percentage";
  return null;
}

const FIELD_LABEL: Record<OverrideField, string> = { name: "Name", company: "Company", productCode: "Product", salesperson: "Salesperson", variantId: "Greeting", city: "City", state: "State" };

export type OverrideErrors = Partial<Record<OverrideField, string>>;

/**
 * Checks one set of edits for a kind of recipient (a lead by default). Text is tidied (spaces, Unicode form); every problem is reported by
 * field. A field that cannot be edited for this kind, or that does not exist, is refused by name.
 */
export function parseOverrides(raw: unknown, kind: OverrideKind = "lead"): Result<PosterOverrides> {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_request", "The edits are not valid.");
  const input = raw as Record<string, unknown>;
  const errors: OverrideErrors = {};
  const out: PosterOverrides = {};
  for (const key of Object.keys(input)) {
    if (!(EDITABLE_FIELDS[kind] as readonly string[]).includes(key)) return fail("invalid_request", "The edits contain a field that cannot be edited.", { fieldErrors: { [key]: "not editable" } });
  }
  for (const field of OVERRIDE_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      errors[field] = "is not valid";
      continue;
    }
    if (field === "productCode") {
      if (!PRODUCT_CODE.test(value)) errors[field] = "is not a product choice";
      else out[field] = value;
    } else if (field === "variantId") {
      if (!VARIANT_ID.test(value) || value.length > 80) errors[field] = "is not a wording choice";
      else out[field] = value;
    } else {
      const problem = overrideTextProblem(value, OVERRIDE_MAX[field]);
      if (problem) errors[field] = problem;
      else out[field] = normalizeText(value);
    }
  }
  const first = OVERRIDE_FIELDS.find((f) => errors[f] !== undefined);
  if (first) return fail("invalid_request", `${FIELD_LABEL[first]} ${errors[first]}.`, { fieldErrors: Object.fromEntries(Object.entries(errors)) as Record<string, string> });
  return ok(out);
}

export const hasOverrides = (o: PosterOverrides | null | undefined): boolean => o !== null && o !== undefined && OVERRIDE_FIELDS.some((f) => o[f] !== undefined);

/** Field by field: an edit for one recipient wins over the edit for everyone. */
export function mergeOverrides(common: PosterOverrides | null | undefined, individual: PosterOverrides | null | undefined): PosterOverrides {
  const out: PosterOverrides = {};
  for (const f of OVERRIDE_FIELDS) {
    const v = individual?.[f] ?? common?.[f];
    if (v !== undefined) out[f] = v;
  }
  return out;
}

export type Personalized = { recipient: Recipient; user: User; variantId: string | undefined };

/**
 * Puts the edits on top of what the source says. The record and the signed-in user passed in are NOT changed (new objects are made),
 * the product must be one of the approved products, and the wording choice is only passed on: the generator checks it against the
 * approved wording of the design. This is the one place edits meet a recipient, so nothing here can reach the CRM.
 */
export function applyOverrides(base: { recipient: Recipient; user: User; variantId: string | undefined }, overrides: PosterOverrides | null | undefined, approvedProducts: readonly Product[]): Result<Personalized> {
  const o = overrides ?? {};
  let recipient: Recipient = { ...base.recipient };
  let user: User = base.user;
  if (o.name !== undefined) recipient = { ...recipient, contact: o.name };
  if (o.company !== undefined) recipient = { ...recipient, company: o.company };
  if (o.productCode !== undefined) {
    const product = approvedProducts.find((p) => p.code === o.productCode);
    if (!product) return fail("invalid_request", "That product is not one of the approved choices.", { fieldErrors: { productCode: "not an approved product" } });
    recipient = { ...recipient, product };
  }
  if (o.salesperson !== undefined) user = { ...user, displayName: o.salesperson };
  return ok({ recipient, user, variantId: o.variantId ?? base.variantId });
}

/** What the editing form holds: every field as typed or chosen. Empty (or only spaces) means "leave as the record says". */
export type OverrideDraft = Partial<Record<OverrideField, string>>;

/** The edits a draft stands for: empty fields dropped, text trimmed. It is only a request; the server checks it again (parseOverrides). */
export function cleanDraft(draft: OverrideDraft | null | undefined): PosterOverrides {
  const out: PosterOverrides = {};
  for (const f of OVERRIDE_FIELDS) {
    const v = draft?.[f]?.trim();
    if (v) out[f] = v;
  }
  return out;
}
