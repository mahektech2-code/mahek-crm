/**
 * Shared across every complaint-entry point so the category list can't drift:
 * the Complaints dashboard's Log Complaint dialog and the Customer record's
 * Quick Complaint dialog both import this rather than keeping their own copy.
 */
export const COMPLAINT_CATEGORIES = [
  "Packaging",
  "Staff",
  "Product",
  "Transport",
  "Rate / Discount",
  "Immediate Payment",
  "Transportation",
  "Product Complaint",
  "Sales Promotion",
] as const;
