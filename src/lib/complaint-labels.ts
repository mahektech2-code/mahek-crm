/**
 * What a complaint's stored category is CALLED.
 *
 * The column is an enum — `packaging_damage` — and that string was reaching
 * the screen unchanged, so a telecaller read the database's word for it
 * rather than their own. The categories a person picks FROM are configuration
 * (`complaints.categories`), and several of them fold onto one enum value:
 * "Packaging" and "Packaging Damage" are both `packaging_damage`. So the way
 * back cannot be derived from the configured list, and is written out here.
 *
 * Pure and client-safe on purpose — the drawer that needs it is a client
 * component, and a label is not a server's business.
 */
export const COMPLAINT_CATEGORY_LABEL: Record<string, string> = {
  product_quality: "Product quality",
  packaging_damage: "Packaging damage",
  dispatch_delay: "Dispatch delay",
  billing_issue: "Billing issue",
  delivery: "Delivery",
  pricing: "Pricing",
  service: "Service",
  shortage: "Shortage",
  other: "Other",
};

/**
 * The label, or the raw value where the enum has gained a member this map has
 * not. Showing the stored word is poor; showing nothing is worse.
 */
export function categoryLabel(category: string): string {
  return COMPLAINT_CATEGORY_LABEL[category] ?? category;
}

/** Where a credit-note request has got to, in words. */
export const CN_STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  under_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  issued: "Issued",
};
