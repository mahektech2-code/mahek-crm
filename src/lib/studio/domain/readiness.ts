import { resolveFieldValues, type ResolvableField } from "./fields";
import type { Language } from "./language";
import { posterName, type Lead, type User } from "./lead";
import type { Recipient, RecipientKind } from "./recipient";

// "Can this lead use this template?" Pure rules, no I/O. Phase 2 covers the lead-level rules and
// the template `requires` list; Phase 3 adds the per-field rules once templates exist.

/** Data a template can declare it cannot work without. */
export type Requirement = "product";

export type Readiness = { ok: true } | { ok: false; reason: string; missing: Requirement[] };

const REQUIREMENT_REASON: Record<Requirement, string> = {
  product: "Needs a product on this lead",
};
// The same rule worded for a customer. Kept beside the lead wording, which is unchanged.
const REQUIREMENT_REASON_CUSTOMER: Record<Requirement, string> = {
  product: "Needs a product on this customer",
};

const reasonFor = (subject: RecipientKind): Record<Requirement, string> => (subject === "customer" ? REQUIREMENT_REASON_CUSTOMER : REQUIREMENT_REASON);

function has(lead: Recipient, requirement: Requirement): boolean {
  switch (requirement) {
    case "product":
      return lead.product !== null;
  }
}

export function checkRequirements(lead: Recipient, requires: readonly Requirement[], subject: RecipientKind = "lead"): Readiness {
  const missing = requires.filter((r) => !has(lead, r));
  if (missing.length === 0) return { ok: true };
  return { ok: false, reason: missing.map((r) => reasonFor(subject)[r]).join("; "), missing };
}

/** One row of "What the creative can use from this lead". */
export type LeadDataItem = { key: "customer_name" | "company_name" | "product" | "salesperson"; label: string; value: string | null; ready: boolean };

export function leadDataItems(lead: Lead, user: User): LeadDataItem[] {
  const customer = lead.contact ?? lead.company;
  return [
    { key: "customer_name", label: "Customer name", value: customer, ready: true },
    { key: "company_name", label: "Company", value: lead.company, ready: true },
    { key: "product", label: "Product", value: lead.product?.name ?? null, ready: lead.product !== null },
    { key: "salesperson", label: "Your name as contact", value: posterName(user), ready: true },
  ];
}

/** A lead "needs attention" when some design will not be available because of missing data. */
export function leadAttention(lead: Lead): { needsAttention: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (lead.product === null) reasons.push("No product on this lead");
  return { needsAttention: reasons.length > 0, reasons };
}

/** What readiness needs from a template (the template schema satisfies it). */
export type ReadinessTemplate = { requires: readonly Requirement[]; fields: readonly ResolvableField[] };

// Field keys that can only be missing because the recipient has no product.
const PRODUCT_KEYS = new Set(["product_name", "product_line", "product_image"]);

/**
 * Can this lead use this template? Checks the template's `requires` list and every `required`
 * field. Returns a plain-language reason (shown on the disabled design), never a code.
 */
export function checkReadiness(lead: Recipient, user: User, template: ReadinessTemplate, language: Language = "en", subject: RecipientKind = "lead"): Readiness {
  const reasons: string[] = [];
  const req = checkRequirements(lead, template.requires, subject);
  if (!req.ok) reasons.push(req.reason);

  const { missing } = resolveFieldValues({ fields: template.fields, lead, user, language, greeting: "", showOptional: true });
  for (const key of missing) reasons.push(PRODUCT_KEYS.has(key) ? reasonFor(subject).product : `Missing ${key.replaceAll("_", " ")}`);

  const unique = [...new Set(reasons)];
  if (unique.length === 0) return { ok: true };
  return { ok: false, reason: unique.join("; "), missing: req.ok ? [] : req.missing };
}
