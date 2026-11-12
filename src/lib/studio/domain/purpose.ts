import type { TemplateCategory } from "./caption";

// Why a creative is made. A customer creative has one of four purposes (CUSTOMER_FEATURE_BLUEPRINT.md
// section 7.1); each is the template `category` of the same name. Pure.

export const PURPOSES = ["festival", "relationship", "promotion", "repeat"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const PURPOSE_LABELS: Record<Purpose, string> = {
  festival: "Festival wishes",
  relationship: "Thank you",
  promotion: "Product promotion",
  repeat: "Repeat business",
};

/** One line saying what the purpose is for, shown under the chips. */
export const PURPOSE_HINTS: Record<Purpose, string> = {
  festival: "A greeting for a festival or occasion.",
  relationship: "Appreciation for the customer's continued association.",
  promotion: "Presents a product the customer buys.",
  repeat: "A polite invitation to order again.",
};

/** The purpose in a URL parameter, or null for "all" (or anything unknown). */
export function parsePurpose(value: string | string[] | undefined): Purpose | null {
  const v = Array.isArray(value) ? value[0] : value;
  return (PURPOSES as readonly string[]).includes(v ?? "") ? (v as Purpose) : null;
}

/** The purpose a design serves. The lead welcome (`greeting`) serves none: it is never for a customer. */
export function purposeOfCategory(category: TemplateCategory): Purpose | null {
  return category === "greeting" ? null : category;
}
