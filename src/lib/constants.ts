/**
 * The SHIPPED DEFAULT complaint categories.
 *
 * This is not what the app reads at runtime — `complaints.categories` in the
 * config registry is, and a manager edits it in the Admin Console without a
 * deploy. This list is the starting value that setting is seeded with, kept
 * here so the literal is written in exactly one place.
 */
export const COMPLAINT_CATEGORIES = [
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
