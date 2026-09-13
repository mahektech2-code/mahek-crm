/**
 * A COMPLAINT'S VOCABULARY, both directions, in one file.
 *
 * The column is an enum — `packaging_damage` — and that string was reaching
 * the screen unchanged, so a telecaller read the database's word for it rather
 * than their own. The categories a person picks FROM are configuration
 * (`complaints.categories`), and several of them fold onto one enum value:
 * "Leakage / Packaging" and the older "Packaging Damage" are both
 * `packaging_damage`. So neither direction can be derived from the other, and
 * both are written out here.
 *
 * THE WAY IN USED TO BE DERIVED, in two places, by SLUGIFYING the label —
 * `c.toLowerCase().replace(/[^a-z0-9]+/g, "_")` on the call panel and on the
 * customer record. That is a third mapping, it agreed with neither of the
 * other two, and it was wrong for almost every label the app shipped with:
 * "Packaging" slugified to `packaging`, which is not a member of the enum, so
 * the zod schema refused it and a complaint raised on a call could not be
 * saved at all. It survived because the failure looked like a validation
 * message rather than like a missing mapping. `categoryValue` is the one way
 * in now, and the slug is only its LAST resort — used when it happens to land
 * on a real enum member, which is how a category a manager adds in the Admin
 * Console can work without a deploy.
 *
 * Pure and client-safe on purpose — the dialog that writes these and the
 * drawer that reads them are both client components, and a label is not a
 * server's business.
 */

/** Every value the `complaint_category` enum can hold, as its own word. */
export const COMPLAINT_CATEGORY_LABEL: Record<string, string> = {
  product_quality: "Product Quality",
  shortage: "Short Quantity",
  packaging_damage: "Leakage / Packaging",
  wrong_product: "Wrong Product",
  dispatch_delay: "Delivery Delay",
  pricing: "Price Issue",
  billing_issue: "Billing Issue",
  delivery: "Transport Issue",
  service: "Sales Service",
  other: "Other",
};

/**
 * The label, or the raw value where the enum has gained a member this map has
 * not. Showing the stored word is poor; showing nothing is worse.
 */
export function categoryLabel(category: string): string {
  return COMPLAINT_CATEGORY_LABEL[category] ?? category;
}

/**
 * WHICH ENUM MEMBER A LABEL MEANS.
 *
 * Keyed on the lower-cased label so "Billing Issue" and "billing issue" are
 * one answer. The ten current categories come first; everything under them is
 * a label this app has shipped or imported at some point, kept because a
 * deployment whose `complaints.categories` somebody has curated may still be
 * offering it, and because the sheet and the handset have their own words for
 * the same things.
 */
const VALUE_BY_LABEL: Record<string, string> = {
  /* --- the categories offered today ----------------------------------- */
  "product quality": "product_quality",
  "short quantity": "shortage",
  "leakage / packaging": "packaging_damage",
  "wrong product": "wrong_product",
  "delivery delay": "dispatch_delay",
  "price issue": "pricing",
  "billing issue": "billing_issue",
  "transport issue": "delivery",
  "sales service": "service",
  other: "other",

  /* --- everything this app has ever offered or been sent -------------- */
  packaging: "packaging_damage",
  "packaging damage": "packaging_damage",
  "damaged goods": "packaging_damage",
  leakage: "packaging_damage",
  staff: "service",
  service: "service",
  product: "product_quality",
  "product complaint": "product_quality",
  "wrong material": "product_quality",
  transport: "delivery",
  transportation: "delivery",
  delivery: "delivery",
  "dispatch delay": "dispatch_delay",
  "late delivery": "dispatch_delay",
  "rate / discount": "pricing",
  "rate dispute": "pricing",
  pricing: "pricing",
  "immediate payment": "billing_issue",
  billing: "billing_issue",
  "sales promotion": "other",
  shortage: "shortage",
};

/**
 * The enum member a picked label writes.
 *
 * Unrecognised labels fall through to the slug where that IS a member of the
 * enum — which is what lets a manager add a category in the Admin Console and
 * have it stored correctly without a deploy — and to `other` where it is not.
 * Never a refusal: a complaint filed under the wrong heading is still a
 * complaint, and one refused at the door is a customer nobody rings back.
 */
export function categoryValue(label: string): string {
  const key = label.trim().toLowerCase();
  const known = VALUE_BY_LABEL[key];
  if (known) return known;
  const slug = key.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return slug in COMPLAINT_CATEGORY_LABEL ? slug : "other";
}

/* --------------------------------------------------------------- priority */

/**
 * HOW BADLY THIS ONE NEEDS ANSWERING, in the words the business uses.
 *
 * Stored in `complaints.severity`, which is the column that already decides
 * the SLA — `complaints.slaHours` is keyed by it — so this is a vocabulary
 * over an existing mechanism rather than a second one beside it. Normal is
 * `medium` and not `low` deliberately: `medium` is what
 * `complaints.defaultSeverity` already ships as, so every complaint raised
 * before this field existed keeps the deadline it was given, and the ordinary
 * case keeps the SLA it has always had.
 *
 * `low` is not offered. It is kept resolvable below because complaints carry
 * it, but nothing in the business distinguishes "less than normal" from
 * normal, and a fourth option nobody can explain is one people pick at random.
 */
export const COMPLAINT_PRIORITIES = [
  { value: "medium", label: "Normal" },
  { value: "high", label: "Urgent" },
  { value: "critical", label: "Critical" },
] as const;

export type ComplaintPriority = (typeof COMPLAINT_PRIORITIES)[number]["value"];

/** The priority a complaint takes when nobody says otherwise. */
export const DEFAULT_COMPLAINT_PRIORITY: ComplaintPriority = "medium";

const PRIORITY_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Normal",
  high: "Urgent",
  critical: "Critical",
};

/** What a stored severity is called on a screen. */
export function priorityLabel(severity: string): string {
  return PRIORITY_LABEL[severity] ?? severity;
}

/**
 * Urgent and Critical are drawn as demanding attention; Normal and Low are
 * not. One definition, because the list, the drawer and the record card all
 * ask it and a badge that disagreed with itself across three screens is how
 * somebody stops reading the badge.
 */
export function isEscalatedPriority(severity: string): boolean {
  return severity === "high" || severity === "critical";
}

/** Where a credit-note request has got to, in words. */
export const CN_STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  under_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  issued: "Issued",
};
